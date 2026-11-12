/**
 * scripts/lib/paymentProofFakeDb.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory, Prisma-like fake of exactly what the Payment Proofs feature uses
 * (tests only — never a real database), plus an in-memory receipt storage with
 * the defaultPaymentProofStorage interface and a fake advisory lock.
 *
 * Mirrors the migration (20261104_payment_proofs):
 *   • unique clientRef / fileKey / publicToken; PARTIAL unique fingerprint
 *     (status <> 'CANCELLED') → P2002 with meta.target
 *   • CHECKs: status, amount 1..100000000, name length 2..40, state, confirmations
 *   • payment_proofs_guard trigger: PUBLISHED / CANCELLED rows never change, only
 *     SCHEDULED → PUBLISHED, no DELETE
 *   • payment_proof_events append-only, FK proofId → payment_proofs
 * and 20261114_payment_proof_display_controls:
 *   • visibleHours / visibleUntil CHECK (both or none, PUBLISHED only, 1..8760 h,
 *     visibleUntil = publishedAt + visibleHours)
 *   • action CHECK superset with REMOVE; at most one REMOVE per proof (P2002)
 *   • payment_proofs_no_publish_removed trigger
 *   • relation filter `events: { none | some: where }` on payment proofs
 * plus the `settings` table (findUnique / upsert) used by the display-duration setting, and a read-only
 * `users` table (findMany) for the admin display names of audit entries.
 * updateMany is ONE synchronous evaluate+apply step (like a row lock), and every
 * call yields first (setImmediate) so concurrent callers really interleave.
 * $transaction(fn) rolls back every write of that transaction when fn throws.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID, createHash } from 'node:crypto';
import { validateProofImage } from '../../src/lib/paymentProofStorage.js';
import { sniffKind } from '../../src/lib/depositStorage.js';

const clone = (v) => (v === undefined ? v : structuredClone(v));
const p2002 = (field) => Object.assign(new Error(`Unique constraint failed on ${field}`), { code: 'P2002', meta: { target: [field] } });
const dbErr = (name) => Object.assign(new Error(`violates ${name}`), { code: 'P2010', meta: { constraint: name } });
const tick = () => new Promise((r) => setImmediate(r));

const val = (v) => (v instanceof Date ? v.getTime() : v);
function matchCond(rowVal, cond) {
  if (cond === null) return rowVal === null || rowVal === undefined;
  if (cond instanceof Date || typeof cond !== 'object') return val(rowVal) === val(cond);
  for (const [op, c] of Object.entries(cond)) {
    const r = val(rowVal), x = val(c);
    const has = r !== null && r !== undefined;
    if (op === 'equals' && r !== x) return false;
    if (op === 'not' && (c !== null && typeof c === 'object' && !(c instanceof Date) ? matchCond(rowVal, c) : r === x)) return false;
    if (op === 'in' && !c.map(val).includes(r)) return false;
    if (op === 'notIn' && c.map(val).includes(r)) return false;
    if (op === 'lt' && !(has && r < x)) return false;
    if (op === 'lte' && !(has && r <= x)) return false;
    if (op === 'gt' && !(has && r > x)) return false;
    if (op === 'gte' && !(has && r >= x)) return false;
  }
  return true;
}
// `rel(row, key)` resolves a relation list (payment proof → its events) for `{ none | some: where }` filters.
function matches(row, where = {}, rel = null) {
  for (const [k, cond] of Object.entries(where || {})) {
    if (k === 'OR') { if (!cond.some((w) => matches(row, w, rel))) return false; continue; }
    if (k === 'AND') { if (!cond.every((w) => matches(row, w, rel))) return false; continue; }
    if (k === 'NOT') { if (matches(row, cond, rel)) return false; continue; }
    if (rel && cond && typeof cond === 'object' && !(cond instanceof Date) && ('none' in cond || 'some' in cond)) {
      const list = rel(row, k);
      if ('none' in cond && list.some((x) => matches(x, cond.none))) return false;
      if ('some' in cond && !list.some((x) => matches(x, cond.some))) return false;
      continue;
    }
    if (!matchCond(row[k], cond)) return false;
  }
  return true;
}
function sortRows(rows, orderBy) {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const x = val(a[k]), y = val(b[k]);
      if (x === y) continue;
      const c = x < y ? -1 : 1;
      return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : row);

const STATUSES = ['SCHEDULED', 'PUBLISHED', 'CANCELLED', 'FAILED'];
function checkRow(r) {
  if (!STATUSES.includes(r.status)) throw dbErr('payment_proofs_status_check');
  if (!(Number.isInteger(r.displayAmountCents) && r.displayAmountCents > 0 && r.displayAmountCents <= 100_000_000)) throw dbErr('payment_proofs_amount_check');
  if (typeof r.displayName !== 'string' || r.displayName.length < 2 || r.displayName.length > 40) throw dbErr('payment_proofs_name_check');
  if ((r.status === 'PUBLISHED') !== (r.publishedAt != null)) throw dbErr('payment_proofs_state_check');
  if (r.status === 'CANCELLED' && r.cancelledAt == null) throw dbErr('payment_proofs_state_check');
  if (r.status === 'FAILED' && r.failedAt == null) throw dbErr('payment_proofs_state_check');
  for (const f of ['privacyConfirmedAt', 'authenticityConfirmedAt', 'scheduledAt']) if (!(r[f] instanceof Date)) throw dbErr(`${f}_not_null`);
  for (const f of ['privacyConfirmedBy', 'authenticityConfirmedBy']) if (typeof r[f] !== 'string' || !r[f]) throw dbErr('payment_proofs_confirmations_check');
  // payment_proofs_visibility_check (20261114)
  const vh = r.visibleHours ?? null, vu = r.visibleUntil ?? null;
  if ((vh === null) !== (vu === null)) throw dbErr('payment_proofs_visibility_check');
  if (vh !== null && !(r.status === 'PUBLISHED' && Number.isInteger(vh) && vh >= 1 && vh <= 8760
    && vu instanceof Date && r.publishedAt instanceof Date && vu.getTime() === r.publishedAt.getTime() + vh * 3_600_000)) {
    throw dbErr('payment_proofs_visibility_check');
  }
}
const EVENT_ACTIONS = ['CREATE', 'CONFIRM_PRIVACY', 'CONFIRM_AUTHENTICITY', 'EDIT', 'CANCEL', 'PUBLISH', 'FAIL', 'REMOVE'];

/**
 * @param {{ affiliates?: Array<{id:string,isActive?:boolean}> }} opts
 * db._tables = { paymentProof, paymentProofEvent, affiliates }; db._log = [{ model, op, ... }]
 * db._failNext = { model, op } makes the next matching call throw (inside a transaction → rollback).
 */
export function makePaymentProofFakeDb({ affiliates = [], settings = [], users = [] } = {}) {
  const T = {
    paymentProof: [], paymentProofEvent: [], affiliates: affiliates.map((a) => ({ isActive: true, ...a })),
    settings: settings.map((x) => ({ updatedAt: new Date(), ...structuredClone(x) })),
    users: users.map((u) => structuredClone(u)), // read-only (admin display names)
  };
  let eventSeq = 0; // BIGSERIAL emulation (never reused, like a PostgreSQL sequence)
  const log = [];
  const state = { failNext: null };

  const enter = async (model, op, extra = {}) => {
    log.push({ model, op, ...extra });
    await tick();
    const f = state.failNext;
    if (f && f.model === model && f.op === op) { state.failNext = null; throw Object.assign(new Error(`injected failure ${model}.${op}`), { code: 'INJECTED' }); }
  };

  function models(undo) {
    const record = (fn) => { if (undo) undo.push(fn); };
    const proofs = () => T.paymentProof;
    const rel = (row, key) => (key === 'events' ? T.paymentProofEvent.filter((e) => e.proofId === row.id) : []);
    const uniqueCheck = (r, selfId) => {
      for (const f of ['clientRef', 'fileKey', 'publicToken']) if (proofs().some((x) => x.id !== selfId && x[f] === r[f])) throw p2002(f);
      if (r.status !== 'CANCELLED' && proofs().some((x) => x.id !== selfId && x.status !== 'CANCELLED' && x.fingerprint === r.fingerprint)) throw p2002('fingerprint');
    };
    return {
      affiliate: {
        async findUnique({ where, select } = {}) {
          await enter('affiliate', 'findUnique', { select: select ? Object.keys(select) : null });
          const a = T.affiliates.find((x) => x.id === where?.id);
          return a ? pick(clone(a), select) : null;
        },
      },
      paymentProof: {
        async findUnique(args = {}) {
          await enter('paymentProof', 'findUnique', { where: Object.keys(args.where || {}) });
          const entries = Object.entries(args.where || {});
          if (entries.length !== 1) throw new Error('findUnique needs exactly one unique field');
          const [k, v] = entries[0];
          const r = proofs().find((x) => x[k] === v);
          return r ? pick(clone(r), args.select) : null;
        },
        async findFirst(args = {}) {
          await enter('paymentProof', 'findFirst');
          const r = sortRows(proofs().filter((x) => matches(x, args.where, rel)), args.orderBy)[0];
          return r ? pick(clone(r), args.select) : null;
        },
        async findMany(args = {}) {
          await enter('paymentProof', 'findMany', { where: args.where });
          let rows = sortRows(proofs().filter((r) => matches(r, args.where, rel)), args.orderBy);
          if (args.skip) rows = rows.slice(args.skip);
          if (args.take !== undefined) rows = rows.slice(0, args.take);
          return rows.map((r) => pick(clone(r), args.select));
        },
        async create(args) {
          await enter('paymentProof', 'create');
          const now = new Date();
          const row = {
            id: randomUUID(), status: 'SCHEDULED', publishedAt: null, cancelledAt: null, failedAt: null, failureReason: null,
            publishAttempts: 0, batchId: null, createdBy: null, updatedBy: null, createdAt: now, updatedAt: now, ...clone(args.data),
          };
          checkRow(row); uniqueCheck(row, null);
          proofs().push(row);
          record(() => { T.paymentProof = T.paymentProof.filter((x) => x.id !== row.id); });
          return pick(clone(row), args.select);
        },
        async updateMany({ where, data }) {
          await enter('paymentProof', 'updateMany', { where });
          // ONE synchronous step: evaluate, guard, check, apply (row-lock semantics)
          const hits = proofs().filter((r) => matches(r, where, rel));
          const next = hits.map((r) => {
            const n = { ...r, updatedAt: new Date() };
            for (const [k, v] of Object.entries(data)) {
              if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) n[k] = (n[k] || 0) + v.increment;
              else n[k] = clone(v);
            }
            // payment_proofs_guard
            if (r.status === 'PUBLISHED' || r.status === 'CANCELLED') throw dbErr('payment_proofs_guard: final row cannot change');
            if (n.status === 'PUBLISHED' && r.status !== 'SCHEDULED') throw dbErr('payment_proofs_guard: only SCHEDULED can be published');
            // payment_proofs_no_publish_removed (20261114)
            if (n.status === 'PUBLISHED' && T.paymentProofEvent.some((e) => e.proofId === r.id && e.action === 'REMOVE')) {
              throw dbErr('payment_proofs_no_publish_removed');
            }
            return n;
          });
          next.forEach((n) => { checkRow(n); uniqueCheck(n, n.id); });
          const before = hits.map((r) => clone(r));
          hits.forEach((r, i) => Object.assign(r, next[i]));
          record(() => { hits.forEach((r, i) => { for (const k of Object.keys(r)) delete r[k]; Object.assign(r, before[i]); }); });
          return { count: hits.length };
        },
        async update() { throw new Error('fake: use updateMany (conditional) for payment proofs'); },
        async delete() { throw dbErr('payment_proofs rows are never deleted'); },
        async deleteMany() { throw dbErr('payment_proofs rows are never deleted'); },
        async count({ where } = {}) { await enter('paymentProof', 'count'); return proofs().filter((r) => matches(r, where, rel)).length; },
        async groupBy({ by, where } = {}) {
          await enter('paymentProof', 'groupBy');
          const m = new Map();
          for (const r of proofs().filter((x) => matches(x, where, rel))) m.set(r[by[0]], (m.get(r[by[0]]) || 0) + 1);
          return [...m].map(([k, n]) => ({ [by[0]]: k, _count: { _all: n } }));
        },
      },
      paymentProofEvent: {
        async create(args) {
          await enter('paymentProofEvent', 'create', { action: args.data?.action });
          const d = args.data;
          if (!EVENT_ACTIONS.includes(d.action)) throw dbErr('payment_proof_events_action_check');
          if (!T.paymentProof.some((p) => p.id === d.proofId)) throw Object.assign(new Error('FK proofId'), { code: 'P2003' });
          if (typeof d.actor !== 'string' || !d.actor) throw dbErr('actor_not_null');
          // payment_proof_events_remove_once_key (partial unique index, 20261114)
          if (d.action === 'REMOVE' && T.paymentProofEvent.some((e) => e.proofId === d.proofId && e.action === 'REMOVE')) throw p2002('proofId');
          const row = { id: randomUUID(), seq: BigInt(++eventSeq), at: new Date(), details: null, ...clone(d) };
          T.paymentProofEvent.push(row);
          record(() => { T.paymentProofEvent = T.paymentProofEvent.filter((x) => x.id !== row.id); });
          return clone(row);
        },
        async findMany(args = {}) {
          await enter('paymentProofEvent', 'findMany');
          return sortRows(T.paymentProofEvent.filter((r) => matches(r, args.where)), args.orderBy).map((r) => clone(r));
        },
        async findFirst(args = {}) {
          await enter('paymentProofEvent', 'findFirst', { where: args.where });
          const r = sortRows(T.paymentProofEvent.filter((x) => matches(x, args.where)), args.orderBy)[0];
          return r ? pick(clone(r), args.select) : null;
        },
        async count({ where } = {}) { await enter('paymentProofEvent', 'count'); return T.paymentProofEvent.filter((r) => matches(r, where)).length; },
        async update() { throw dbErr('payment_proof_events is append-only'); },
        async updateMany() { throw dbErr('payment_proof_events is append-only'); },
        async delete() { throw dbErr('payment_proof_events is append-only'); },
        async deleteMany() { throw dbErr('payment_proof_events is append-only'); },
      },
      // users: READ-ONLY, only what adminNameService asks (findMany by id / email, select).
      user: {
        async findMany(args = {}) {
          await enter('user', 'findMany', { select: args.select ? Object.keys(args.select) : null });
          return T.users.filter((u) => matches(u, args.where)).map((u) => pick(clone(u), args.select));
        },
      },
      setting: {
        async findUnique({ where } = {}) {
          await enter('setting', 'findUnique', { id: where?.id });
          const r = T.settings.find((x) => x.id === where?.id);
          return r ? clone(r) : null;
        },
        async upsert({ where, update, create }) {
          await enter('setting', 'upsert', { id: where?.id });
          const r = T.settings.find((x) => x.id === where?.id);
          if (r) {
            const before = clone(r);
            Object.assign(r, clone(update), { updatedAt: new Date() });
            record(() => { for (const k of Object.keys(r)) delete r[k]; Object.assign(r, before); });
            return clone(r);
          }
          const row = { ...clone(create), updatedAt: new Date() };
          T.settings.push(row);
          record(() => { T.settings = T.settings.filter((x) => x !== row); });
          return clone(row);
        },
      },
    };
  }

  const db = {
    ...models(null),
    _tables: T,
    _log: log,
    failNext(model, op) { state.failNext = { model, op }; },
    async $transaction(fn) {
      if (typeof fn !== 'function') throw new Error('fake: only interactive transactions');
      log.push({ model: '$transaction', op: 'begin' });
      const undo = [];
      const tx = models(undo);
      try {
        return await fn(tx);
      } catch (e) {
        for (const u of undo.reverse()) u();
        log.push({ model: '$transaction', op: 'rollback' });
        throw e;
      }
    },
  };
  return db;
}

/** In-memory receipt storage (same interface as defaultPaymentProofStorage). */
export function makeProofMemStorage() {
  const files = new Map();
  const s = {
    files,
    failStore: 0,          // number of next store() calls that throw
    failRemove: false,
    stored: 0,
    removed: [],
    validate: validateProofImage,
    async store(buffer) {
      await tick();
      if (s.failStore > 0) { s.failStore--; throw new Error('disk full'); }
      const kind = sniffKind(buffer);
      if (!['jpeg', 'png', 'webp'].includes(kind)) throw Object.assign(new Error('Image non supportée ou corrompue.'), { code: 'INVALID_FILE' });
      const key = `${randomUUID()}.jpg`;
      files.set(key, Buffer.from(buffer));
      s.stored++;
      return { key, fingerprint: createHash('sha256').update(buffer).digest('hex') };
    },
    async exists(key) { return files.has(key); },
    async read(key) { return files.has(key) ? { buffer: files.get(key), contentType: 'image/jpeg' } : null; },
    async remove(key) { if (s.failRemove) throw new Error('rm failed'); s.removed.push(key); return files.delete(key); },
    lose(key) { files.delete(key); },
  };
  return s;
}

/** Fake advisory lock. Pass the same `shared` object to two locks to make them contend. */
export function makeFakeLock(shared = { held: false }, { failAcquire = false, throwAcquire = false } = {}) {
  const l = {
    shared, acquires: 0, releases: 0, holding: false,
    async acquire() {
      await tick();
      l.acquires++;
      if (throwAcquire) throw new Error('lock connection lost');
      if (failAcquire || shared.held) return false;
      shared.held = true; l.holding = true; return true;
    },
    async release() {
      l.releases++;
      if (l.holding) { shared.held = false; l.holding = false; }
    },
  };
  return l;
}

/** Distinct PNG-signed byte sequences (distinct fingerprints) per tag. */
export const pngBytes = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.from(String(tag))]);
