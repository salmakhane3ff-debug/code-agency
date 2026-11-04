/**
 * scripts/lib/recruiterFakeDb.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory, Prisma-like fake of exactly what the recruiter Phase 2 code uses
 * (tests only — never a real database): `recruiter` and `recruiterAuditLog`.
 *
 * Mirrors the migration's guarantees: unique username / phone (P2002 with
 * meta.target), the recruiters CHECKs (username format, name length, bcrypt-only
 * passwordHash, inactive ⇒ disabledAt + disabledBy), the audit-log CHECKs
 * (actor type, action format) and append-only audit rows. `$transaction` rolls
 * back on throw. ANY other model access throws (proves isolation).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';

const clone = (v) => (v === undefined ? v : structuredClone(v));
const p2002 = (field) => Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), { code: 'P2002', meta: { target: [field] } });
const checkErr = (name) => Object.assign(new Error(`violates check constraint "${name}"`), { code: 'P2004', meta: { constraint: name } });
const tick = () => new Promise((r) => setImmediate(r));

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const BCRYPT_RE = /^\$2[aby]\$[0-9]{2}\$.{53}$/;
const ACTION_RE = /^[A-Z][A-Z_]{2,59}$/;

function checkRecruiter(r) {
  if (!USERNAME_RE.test(r.username)) throw checkErr('recruiters_username_check');
  const n = String(r.name ?? '').trim().length;
  if (n < 2 || n > 80) throw checkErr('recruiters_name_check');
  if (!BCRYPT_RE.test(String(r.passwordHash ?? ''))) throw checkErr('recruiters_password_hash_check');
  if (!r.isActive && (r.disabledAt == null || r.disabledBy == null)) throw checkErr('recruiters_disabled_check');
  if (typeof r.createdBy !== 'string' || !r.createdBy) throw Object.assign(new Error('createdBy NOT NULL'), { code: 'P2011' });
}

function pick(row, select) {
  if (!row) return null;
  if (!select) return clone(row);
  const out = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = clone(row[k]);
  return out;
}

const val = (v) => (v instanceof Date ? v.getTime() : v);
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

export function makeRecruiterFakeDb({ failAuditCreate = false } = {}) {
  const T = { recruiter: [], recruiterAuditLog: [] };
  let seq = 0;
  const log = [];
  const state = { failAuditCreate };

  const recruiter = {
    async create({ data }) {
      log.push({ model: 'recruiter', op: 'create' });
      await tick();
      const now = new Date();
      const r = {
        id: randomUUID(), phone: null, isActive: true, canCreateAffiliates: true, canViewOrders: true,
        disabledAt: null, disabledBy: null, disabledReason: null, lastLoginAt: null,
        createdAt: now, updatedAt: now, ...clone(data),
      };
      if (T.recruiter.some((x) => x.username === r.username)) throw p2002('username');
      if (r.phone != null && T.recruiter.some((x) => x.phone === r.phone)) throw p2002('phone');
      checkRecruiter(r);
      T.recruiter.push(r);
      undoPush(() => { T.recruiter.splice(T.recruiter.indexOf(r), 1); });
      return clone(r);
    },
    async findUnique({ where, select } = {}) {
      log.push({ model: 'recruiter', op: 'findUnique', where: clone(where) });
      await tick();
      const keys = Object.keys(where || {});
      if (keys.length !== 1 || !['id', 'username'].includes(keys[0])) throw new Error(`fake recruiter.findUnique: unsupported where ${JSON.stringify(where)}`);
      const row = T.recruiter.find((x) => x[keys[0]] === where[keys[0]]);
      return pick(row, select);
    },
    async findMany({ orderBy, select } = {}) {
      log.push({ model: 'recruiter', op: 'findMany' });
      await tick();
      return sortRows(T.recruiter, orderBy).map((r) => pick(r, select));
    },
    async update({ where, data }) {
      log.push({ model: 'recruiter', op: 'update', where: clone(where), data: clone(data) });
      await tick();
      const row = T.recruiter.find((x) => x.id === where?.id);
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      const before = clone(row);
      const next = { ...row, ...clone(data), updatedAt: new Date() };
      if (next.username !== row.username && T.recruiter.some((x) => x !== row && x.username === next.username)) throw p2002('username');
      if (next.phone != null && next.phone !== row.phone && T.recruiter.some((x) => x !== row && x.phone === next.phone)) throw p2002('phone');
      checkRecruiter(next);
      Object.assign(row, next);
      undoPush(() => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, before); });
      return clone(row);
    },
  };

  const recruiterAuditLog = {
    async create({ data }) {
      log.push({ model: 'recruiterAuditLog', op: 'create', action: data?.action });
      await tick();
      if (state.failAuditCreate) throw new Error('audit write failed (injected)');
      if (!['RECRUITER', 'ADMIN', 'SYSTEM'].includes(data.actorType) || !(typeof data.actorId === 'string' && data.actorId.length > 0)) throw checkErr('recruiter_audit_log_actor_check');
      if (!ACTION_RE.test(String(data.action))) throw checkErr('recruiter_audit_log_action_check');
      if (data.recruiterId != null && !T.recruiter.some((x) => x.id === data.recruiterId)) {
        throw Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' });
      }
      const row = { id: randomUUID(), seq: BigInt(++seq), entityType: null, entityId: null, details: null, createdAt: new Date(), ...clone(data) };
      T.recruiterAuditLog.push(row);
      undoPush(() => { T.recruiterAuditLog.splice(T.recruiterAuditLog.indexOf(row), 1); });
      return clone(row);
    },
    async findMany({ where = {}, orderBy } = {}) {
      log.push({ model: 'recruiterAuditLog', op: 'findMany' });
      await tick();
      const rows = T.recruiterAuditLog.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      return sortRows(rows, orderBy || [{ seq: 'asc' }]).map(clone);
    },
  };
  for (const op of ['update', 'updateMany', 'delete', 'deleteMany', 'upsert']) {
    recruiterAuditLog[op] = async () => { throw new Error('recruiter_audit_log is append-only'); };
  }

  // Transaction undo stack (rollback on throw). Outside a transaction, writes are final.
  let undo = null;
  function undoPush(fn) { if (undo) undo.push(fn); }

  const base = {
    recruiter, recruiterAuditLog,
    async $transaction(fn) {
      log.push({ model: '$transaction', op: 'begin' });
      if (typeof fn !== 'function') throw new Error('fake $transaction: only the interactive form is supported');
      const outer = undo;
      undo = [];
      try {
        const out = await fn(db);
        const mine = undo;
        undo = outer;
        if (outer) outer.push(...mine);
        return out;
      } catch (e) {
        const mine = undo;
        undo = outer;
        for (const f of mine.reverse()) f();
        throw e;
      }
    },
    _tables: T, _log: log, _state: state,
  };

  const db = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      throw new Error(`fake db: access to model "${String(prop)}" is not allowed in recruiter code (isolation)`);
    },
  });
  return db;
}
