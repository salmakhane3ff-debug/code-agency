/**
 * scripts/lib/recruiterFakeDb.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * In-memory, Prisma-like fake of exactly what the recruiter code uses (tests only —
 * never a real database).
 *
 *   Phase 2 (default):  `recruiter` and `recruiterAuditLog`. ANY other model access
 *                       throws (proves isolation).
 *   Phase 3 ({ phase3: true }): adds `affiliate` (create / findUnique / findFirst —
 *                       NO update / upsert: any such call throws), `recruiterAffiliateLink`
 *                       and `$queryRaw` (only the recruiter row lock statement).
 *   Phase 4 ({ phase4: true }, implies phase 3): READ-ONLY network reads — `affiliate.findMany`
 *                       (id IN + select), `recruiterAffiliateLink.count`, `affiliateOrder.groupBy`
 *                       (counts only: by ⊆ affiliateId/status/isFake, `_count._all`; no amount
 *                       aggregate, no findMany, no write), `identityVerification.findMany`
 *                       (select ⊆ affiliateId/status — a document field or a write throws), and the
 *                       `/* recruiter-network-tree *\/` recursive query, emulated row for row
 *                       (roots, linked children only, depth < bound). `_queryCount()` = number of
 *                       database calls so far (every model call and every raw query).
 *   Phase 5 ({ phase5: true }, implies phase 4): rewards and withdrawals —
 *                       `recruiterSettingsVersion` (consecutive versions under a lock held until
 *                       commit, like the trigger + advisory lock; the CHECKs), `recruiterRewardLedger`
 *                       (append-only, CHECKs, unique idempotencyKey, ONE RECRUIT_REWARD per affiliate,
 *                       link guard), `affiliatePayout` (exactly-one-owner CHECK, recruiter amount CHECK,
 *                       FKs; every call recorded in `_payoutCalls`), `affiliateOrder.groupBy` with the
 *                       delivered filter + `findUnique`, `identityVerification.findUnique`, the second
 *                       recruiter row-lock statement (bank columns), `recruiter.findMany` where.
 *
 *   Phase 6 part 1 (with phase 3+): `affiliateActivationCode` (CHECKs of the migration, unique
 *                       selector, ONE active code per affiliate → P2002, the life-cycle guard:
 *                       only usedAt / invalidatedAt(+reason) set once and failedAttempts growing;
 *                       no delete), the per-affiliate advisory lock
 *                       `SELECT pg_advisory_xact_lock(hashtext(?))` (held until the transaction
 *                       ends), the recruiter row lock `SELECT "isActive" … FOR NO KEY UPDATE`, and
 *                       the relation filter `affiliate: { activationCodes: { some, none } }`.
 *                       `{ allowPasswordUpdate: true }` additionally allows `affiliate.update`
 *                       with data = { password, tokenVersion: { increment: 1 } } EXACTLY (the
 *                       activation redemption / admin recovery: a password set revokes every
 *                       older session — Phase 6 part 2); every other affiliate update still throws.
 *                       Phase 6 part 2: recruiters carry tokenVersion (default 0); recruiter.update
 *                       and recruiter.updateMany accept { increment } on it.
 *   Phase 6 recovery ({ recovery: true }, implies phase 5): `affiliateActivationRecovery`
 *                       (CHECKs of 20261108, ONE PENDING request per affiliate → P2002, the
 *                       guard: only PENDING → APPROVED | REJECTED once with the review columns;
 *                       no delete), `affiliateActivationCode.findFirst`, the ADMIN_RECOVERY
 *                       reason, `OR` / `AND` / `NOT` inside activation-code filters,
 *                       `recruiterAffiliateLink` select `{ recruiter: { select } }`,
 *                       `recruiterAuditLog.findMany` select / take, and admin reads of
 *                       affiliates (phone / isActive / createdAt).
 *
 * Mirrors the migration's guarantees: unique username / phone (P2002 with meta.target),
 * the recruiters CHECKs (username format, name length, bcrypt-only passwordHash,
 * inactive ⇒ disabledAt + disabledBy), the audit-log CHECKs (actor type, action format),
 * append-only audit rows and links, the foreign keys, and the Phase 1 trigger
 * recruiter_link_new_affiliate_only (a link is accepted only for an INACTIVE affiliate
 * created in the SAME transaction).
 *
 * Transactions (AsyncLocalStorage, so concurrent transactions never mix):
 *   • `$transaction(fn)` is atomic: every write of the transaction is undone on throw.
 *   • rows written by an open transaction are invisible to every other context until
 *     it commits (READ COMMITTED); unique checks see them (PostgreSQL would wait on the
 *     index and then fail).
 *   • `SELECT … FROM "recruiters" WHERE "id" = $1 FOR NO KEY UPDATE` and recruiter.update
 *     take a per-recruiter row lock held until the transaction ends (a waiter re-reads the
 *     committed row) — concurrent creations of one recruiter serialise like PostgreSQL.
 *
 * Fault injection: `failOnce: { 'recruiterAffiliateLink.create': true, … }` (next call
 * throws once), `failAuditCreate` (every audit create throws), `hooks.before(model, op, args)`
 * (async, to interleave concurrent requests).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const clone = (v) => (v === undefined ? v : structuredClone(v));
const p2002 = (field) => Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), { code: 'P2002', meta: { target: [field] } });
const checkErr = (name) => Object.assign(new Error(`violates check constraint "${name}"`), { code: 'P2004', meta: { constraint: name } });
const fkErr = (name) => Object.assign(new Error(`Foreign key constraint failed on the field: \`${name}\``), { code: 'P2003', meta: { field_name: name } });
// What a RAISE … USING ERRCODE = 'check_violation' surfaces as through Prisma (raw DB error).
const triggerErr = (msg) => Object.assign(new Error(msg), { code: 'P2010', meta: { code: '23514', message: msg } });
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

/** Scalar where matcher: equality, { in }, { contains, mode }, { equals }, { not }, OR, AND. */
function matchScalar(v, cond) {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return val(v) === val(cond);
  for (const [op, arg] of Object.entries(cond)) {
    if (op === 'in') { if (!Array.isArray(arg) || !arg.includes(v)) return false; }
    else if (op === 'equals') { if (val(v) !== val(arg)) return false; }
    else if (op === 'not') { if (val(v) === val(arg) || (arg === null && v == null)) return false; }
    else if (op === 'notIn') { if (!Array.isArray(arg) || arg.includes(v)) return false; }
    else if (op === 'contains') {
      if (typeof v !== 'string') return false;
      const insensitive = cond.mode === 'insensitive';
      if (!(insensitive ? v.toLowerCase().includes(String(arg).toLowerCase()) : v.includes(arg))) return false;
    } else if (op === 'mode') { /* modifier of contains */ }
    else throw new Error(`fake where: unsupported operator ${op}`);
  }
  return true;
}

export function makeRecruiterFakeDb({ failAuditCreate = false, phase3: phase3In = false, phase4: phase4In = false, phase5: phase5In = false, recovery = false, allowPasswordUpdate = false, failOnce = {}, hooks = {} } = {}) {
  const phase5 = phase5In || recovery;
  const phase4 = phase4In || phase5;
  const phase3 = phase3In || phase4;
  const T = {
    recruiter: [], recruiterAuditLog: [], affiliate: [], recruiterAffiliateLink: [], affiliateOrder: [], identityVerification: [],
    recruiterSettingsVersion: [], recruiterRewardLedger: [], affiliatePayout: [], affiliateActivationCode: [],
    affiliateActivationRecovery: [],
  };
  const payoutCalls = [];
  let seq = 0;
  let txSeq = 0;
  const log = [];
  const state = { failAuditCreate, failOnce: { ...failOnce } };
  const als = new AsyncLocalStorage();
  const openTx = new Set();          // ids of open (uncommitted) transactions
  const rowTx = new WeakMap();       // row → id of the transaction that wrote it (while open)
  const locks = new Map();           // recruiterId → { tx, waiters: [] }

  const ctx = () => als.getStore() || null;
  const visible = (row) => { const t = rowTx.get(row); return t === undefined || !openTx.has(t) || t === ctx()?.id; };
  const rows = (name) => T[name].filter(visible);
  function undoPush(fn) { const c = ctx(); if (c) c.undo.push(fn); }
  function markWritten(row) { const c = ctx(); if (c) rowTx.set(row, c.id); }
  async function before(model, op, args) {
    log.push({ model, op, ...(args?.where ? { where: clone(args.where) } : {}), ...(model === 'recruiterAuditLog' && op === 'create' ? { action: args?.data?.action } : {}) });
    if (typeof hooks.before === 'function') await hooks.before(model, op, args);
    await tick();
    const key = `${model}.${op}`;
    if (state.failOnce[key]) {
      const e = state.failOnce[key];
      delete state.failOnce[key];
      throw e instanceof Error ? e : new Error(`${key} failed (injected)`);
    }
  }

  // Row lock (FOR NO KEY UPDATE / UPDATE) held until the owning transaction ends.
  async function lockRecruiterRow(id) {
    const c = ctx();
    for (;;) {
      const l = locks.get(id);
      if (!l) break;
      if (c && l.tx === c.id) return;
      await new Promise((resolve) => l.waiters.push(resolve));
    }
    if (!c) return; // autocommit statement: lock acquired and released at once
    locks.set(id, { tx: c.id, waiters: [] });
    c.locks.push(id);
  }
  function releaseLocks(c) {
    for (const id of c.locks) {
      const l = locks.get(id);
      if (l && l.tx === c.id) { locks.delete(id); for (const w of l.waiters) w(); }
    }
    c.locks.length = 0;
  }

  // { field: { increment: n } } → the incremented number (Prisma atomic number operations).
  function applyOps(row, data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) {
        out[k] = (Number.isInteger(row[k]) ? row[k] : 0) + (v.increment ?? 0) - (v.decrement ?? 0);
      } else out[k] = v;
    }
    return out;
  }
  const recruiter = {
    async create({ data }) {
      await before('recruiter', 'create', { data });
      const now = new Date();
      const r = {
        id: randomUUID(), phone: null, isActive: true, canCreateAffiliates: true, canViewOrders: true,
        disabledAt: null, disabledBy: null, disabledReason: null, lastLoginAt: null, tokenVersion: 0,
        createdAt: now, updatedAt: now, ...clone(data),
      };
      if (T.recruiter.some((x) => x.username === r.username)) throw p2002('username');
      if (r.phone != null && T.recruiter.some((x) => x.phone === r.phone)) throw p2002('phone');
      checkRecruiter(r);
      T.recruiter.push(r);
      markWritten(r);
      undoPush(() => { T.recruiter.splice(T.recruiter.indexOf(r), 1); });
      return clone(r);
    },
    async findUnique({ where, select } = {}) {
      await before('recruiter', 'findUnique', { where });
      const keys = Object.keys(where || {});
      if (keys.length !== 1 || !['id', 'username'].includes(keys[0])) throw new Error(`fake recruiter.findUnique: unsupported where ${JSON.stringify(where)}`);
      const row = rows('recruiter').find((x) => x[keys[0]] === where[keys[0]]);
      return pick(row, select);
    },
    async findMany({ where, orderBy, select } = {}) {
      await before('recruiter', 'findMany', { where });
      return sortRows(rows('recruiter').filter((r) => Object.entries(where || {}).every(([k, v]) => matchScalar(r[k], v))), orderBy).map((r) => pick(r, select));
    },
    async update({ where, data }) {
      await before('recruiter', 'update', { where, data });
      if (where?.id) await lockRecruiterRow(where.id);
      const row = rows('recruiter').find((x) => x.id === where?.id);
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      const prev = clone(row);
      const next = { ...row, ...applyOps(row, clone(data)), updatedAt: new Date() };
      if (next.username !== row.username && T.recruiter.some((x) => x !== row && x.username === next.username)) throw p2002('username');
      if (next.phone != null && next.phone !== row.phone && T.recruiter.some((x) => x !== row && x.phone === next.phone)) throw p2002('phone');
      checkRecruiter(next);
      Object.assign(row, next);
      undoPush(() => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, prev); });
      return clone(row);
    },
    // Phase 6 part 2: the conditional password change (where id + passwordHash + isActive).
    async updateMany({ where = {}, data } = {}) {
      await before('recruiter', 'updateMany', { where, data });
      if (where.id) await lockRecruiterRow(where.id);
      const targets = rows('recruiter').filter((r) => Object.entries(where).every(([k, v]) => matchScalar(r[k], v)));
      for (const row of targets) {
        const prev = clone(row);
        const next = { ...row, ...applyOps(row, clone(data)), updatedAt: new Date() };
        checkRecruiter(next);
        Object.assign(row, next);
        undoPush(() => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, prev); });
      }
      return { count: targets.length };
    },
  };

  const auditMatch = (r, where) => Object.entries(where || {}).every(([k, v]) => {
    if (k === 'details' && v && typeof v === 'object' && Array.isArray(v.path)) {
      let cur = r.details;
      for (const p of v.path) cur = cur && typeof cur === 'object' ? cur[p] : undefined;
      return 'equals' in v ? cur === v.equals : true;
    }
    return matchScalar(r[k], v);
  });
  const recruiterAuditLog = {
    async create({ data }) {
      await before('recruiterAuditLog', 'create', { data });
      if (state.failAuditCreate) throw new Error('audit write failed (injected)');
      if (!['RECRUITER', 'ADMIN', 'SYSTEM'].includes(data.actorType) || !(typeof data.actorId === 'string' && data.actorId.length > 0)) throw checkErr('recruiter_audit_log_actor_check');
      if (!ACTION_RE.test(String(data.action))) throw checkErr('recruiter_audit_log_action_check');
      if (data.recruiterId != null && !T.recruiter.some((x) => x.id === data.recruiterId)) throw fkErr('recruiterId');
      const row = { id: randomUUID(), seq: BigInt(++seq), entityType: null, entityId: null, details: null, createdAt: new Date(), ...clone(data) };
      T.recruiterAuditLog.push(row);
      markWritten(row);
      undoPush(() => { T.recruiterAuditLog.splice(T.recruiterAuditLog.indexOf(row), 1); });
      return clone(row);
    },
    async findMany({ where = {}, orderBy, take, select } = {}) {
      await before('recruiterAuditLog', 'findMany', {});
      const list = sortRows(rows('recruiterAuditLog').filter((r) => auditMatch(r, where)), orderBy || [{ seq: 'asc' }]);
      return (Number.isInteger(take) ? list.slice(0, take) : list).map((r) => pick(r, select));
    },
    async findFirst({ where = {}, orderBy, select } = {}) {
      await before('recruiterAuditLog', 'findFirst', { where });
      const found = sortRows(rows('recruiterAuditLog').filter((r) => auditMatch(r, where)), orderBy || [{ seq: 'asc' }])[0];
      return pick(found, select);
    },
  };
  for (const op of ['update', 'updateMany', 'delete', 'deleteMany', 'upsert']) {
    recruiterAuditLog[op] = async () => { throw triggerErr('recruiter_audit_log is append-only'); };
  }

  // ── Phase 3 models ──────────────────────────────────────────────────────────
  const affMatch = (r, where) => Object.entries(where || {}).every(([k, v]) => {
    if (k === 'OR') return Array.isArray(v) && v.some((w) => affMatch(r, w));
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((w) => affMatch(r, w));
    if (k === 'activationCodes') {
      // to-many relation filter { some, none, every } over this affiliate's activation codes
      const mine = rows('affiliateActivationCode').filter((c) => c.affiliateId === r.id);
      for (const [op, w] of Object.entries(v || {})) {
        if (op === 'some') { if (!mine.some((c) => genericMatchAc(c, w))) return false; }
        else if (op === 'none') { if (mine.some((c) => genericMatchAc(c, w))) return false; }
        else if (op === 'every') { if (!mine.every((c) => genericMatchAc(c, w))) return false; }
        else throw new Error(`fake where: unsupported relation operator ${op}`);
      }
      return true;
    }
    return matchScalar(r[k], v);
  });
  const genericMatchAc = (r, where) => Object.entries(where || {}).every(([k, v]) => {
    if (k === 'OR') return Array.isArray(v) && v.some((w) => genericMatchAc(r, w));
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((w) => genericMatchAc(r, w));
    if (k === 'NOT') return !(Array.isArray(v) ? v : [v]).some((w) => genericMatchAc(r, w));
    return matchScalar(r[k], v);
  });
  const affiliate = {
    async create({ data, select }) {
      await before('affiliate', 'create', { data });
      const now = new Date();
      const r = {
        id: randomUUID(), commissionRate: 0.5, isActive: false, totalClicks: 0, totalOrders: 0, totalCommission: 0, userId: null,
        accountName: null, bankName: null, name: '', phone: null, avatarUrl: null, parentId: null, password: '', rib: null,
        referralStatus: 'pending', deliveredOrdersCount: 0, generatedRevenue: 0, teamBonusClaimed: false, bonusBalance: 0,
        goalOrders: null, goalValidReferrals: null, createdAt: now, updatedAt: now, ...clone(data),
      };
      if (T.affiliate.some((x) => x.id === r.id)) throw p2002('id');
      if (T.affiliate.some((x) => x.username === r.username)) throw p2002('username');
      if (r.phone != null && T.affiliate.some((x) => x.phone === r.phone)) throw p2002('phone');
      if (r.parentId != null && !T.affiliate.some((x) => x.id === r.parentId && visible(x))) throw fkErr('parentId');
      T.affiliate.push(r);
      markWritten(r);
      undoPush(() => { T.affiliate.splice(T.affiliate.indexOf(r), 1); });
      return pick(r, select);
    },
    async findUnique({ where, select } = {}) {
      await before('affiliate', 'findUnique', { where });
      const keys = Object.keys(where || {});
      if (keys.length !== 1 || !['id', 'username', 'phone'].includes(keys[0])) throw new Error(`fake affiliate.findUnique: unsupported where ${JSON.stringify(where)}`);
      return pick(rows('affiliate').find((x) => x[keys[0]] === where[keys[0]]), select);
    },
    async findFirst({ where, select, orderBy } = {}) {
      await before('affiliate', 'findFirst', { where });
      return pick(sortRows(rows('affiliate').filter((r) => affMatch(r, where)), orderBy)[0], select);
    },
  };
  for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'createMany', 'findMany', 'count', 'groupBy']) {
    affiliate[op] = async () => { throw new Error(`fake db: affiliate.${op} is not allowed in recruiter code`); };
  }
  if (allowPasswordUpdate) {
    // The activation redemption: the password ONLY (never isActive or anything else).
    affiliate.update = async ({ where, data, select } = {}) => {
      await before('affiliate', 'update', { where, data });
      const k = Object.keys(where || {});
      if (k.length !== 1 || k[0] !== 'id') throw new Error(`fake affiliate.update: unsupported where ${JSON.stringify(where)}`);
      if (!data || Object.keys(data).sort().join() !== 'password,tokenVersion' || typeof data.password !== 'string'
        || JSON.stringify(data.tokenVersion) !== JSON.stringify({ increment: 1 })) {
        throw new Error(`fake affiliate.update: only { password, tokenVersion: { increment: 1 } } may change (got ${JSON.stringify(data || {})})`);
      }
      const r = rows('affiliate').find((x) => x.id === where.id);
      if (!r) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      const prev = clone(r);
      r.password = data.password;
      r.tokenVersion = (Number.isInteger(r.tokenVersion) ? r.tokenVersion : 0) + 1;
      r.updatedAt = new Date();
      undoPush(() => { Object.assign(r, prev); });
      return pick(r, select);
    };
  }
  if (phase4) {
    // Phase 4: names of a page of nodes (id IN …), never a sensitive column.
    const AFF_READ = new Set(recovery ? ['id', 'username', 'name', 'phone', 'isActive', 'createdAt'] : ['id', 'username', 'name']);
    affiliate.findMany = async ({ where, select } = {}) => {
      await before('affiliate', 'findMany', { where });
      const keys = Object.keys(where || {});
      if (keys.length !== 1 || keys[0] !== 'id' || !Array.isArray(where.id?.in)) throw new Error(`fake affiliate.findMany: unsupported where ${JSON.stringify(where)}`);
      if (!select || !Object.keys(select).every((k) => AFF_READ.has(k))) throw new Error(`fake affiliate.findMany: select must be a subset of ${[...AFF_READ].join('/')} (got ${JSON.stringify(select)})`);
      const wanted = new Set(where.id.in);
      return rows('affiliate').filter((r) => wanted.has(r.id)).map((r) => pick(r, select));
    };
  }

  const linkMatch = (l, where) => Object.entries(where || {}).every(([k, v]) => {
    if (k === 'affiliate') {
      const a = T.affiliate.find((x) => x.id === l.affiliateId);
      return !!a && affMatch(a, v);
    }
    return matchScalar(l[k], v);
  });
  const projectLink = (l, select) => {
    if (!select) return clone(l);
    const out = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (k === 'affiliate') out.affiliate = pick(T.affiliate.find((x) => x.id === l.affiliateId), v === true ? undefined : v.select);
      else if (k === 'recruiter') {
        // never the password hash, even with select: true
        const rec = T.recruiter.find((x) => x.id === l.recruiterId);
        if (v === true || !v?.select || Object.keys(v.select).includes('passwordHash')) throw new Error('fake recruiterAffiliateLink: recruiter must be read with an explicit select (no passwordHash)');
        out.recruiter = pick(rec, v.select);
      } else out[k] = clone(l[k]);
    }
    return out;
  };
  const recruiterAffiliateLink = {
    async create({ data }) {
      await before('recruiterAffiliateLink', 'create', { data });
      const l = { createdAt: new Date(), ...clone(data) };
      if (!(typeof l.createdBy === 'string' && l.createdBy.length > 0)) throw checkErr('recruiter_affiliate_links_createdBy_check');
      // Phase 1 trigger recruiter_link_new_affiliate_only (BEFORE INSERT → before the PK / FK checks).
      const a = T.affiliate.find((x) => x.id === l.affiliateId);
      if (a) {
        const c = ctx();
        const inThisTx = !!c && rowTx.get(a) === c.id && openTx.has(c.id);
        const age = Date.now() - new Date(a.createdAt).getTime();
        if (!inThisTx || a.isActive || age > 2 * 60_000 || age < -60_000) {
          throw triggerErr(`affiliate ${l.affiliateId} can only be linked to a recruiter when it is created (inactive) in the same transaction`);
        }
      }
      if (T.recruiterAffiliateLink.some((x) => x.affiliateId === l.affiliateId)) throw p2002('affiliateId');
      if (!a) throw fkErr('affiliateId');
      if (!T.recruiter.some((x) => x.id === l.recruiterId)) throw fkErr('recruiterId');
      T.recruiterAffiliateLink.push(l);
      markWritten(l);
      undoPush(() => { T.recruiterAffiliateLink.splice(T.recruiterAffiliateLink.indexOf(l), 1); });
      return clone(l);
    },
    async findUnique({ where, select } = {}) {
      await before('recruiterAffiliateLink', 'findUnique', { where });
      const keys = Object.keys(where || {});
      if (keys.length !== 1 || keys[0] !== 'affiliateId') throw new Error(`fake recruiterAffiliateLink.findUnique: unsupported where ${JSON.stringify(where)}`);
      const l = rows('recruiterAffiliateLink').find((x) => x.affiliateId === where.affiliateId);
      return l ? projectLink(l, select) : null;
    },
    async findMany({ where, orderBy, take, select } = {}) {
      await before('recruiterAffiliateLink', 'findMany', { where });
      let list = sortRows(rows('recruiterAffiliateLink').filter((l) => linkMatch(l, where)), orderBy);
      if (Number.isInteger(take)) list = list.slice(0, take);
      return list.map((l) => projectLink(l, select));
    },
  };
  for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
    recruiterAffiliateLink[op] = async () => { throw triggerErr('recruiter_affiliate_links is append-only'); };
  }
  if (phase4) {
    recruiterAffiliateLink.count = async ({ where } = {}) => {
      await before('recruiterAffiliateLink', 'count', { where });
      return rows('recruiterAffiliateLink').filter((l) => linkMatch(l, where)).length;
    };
  }

  // ── Phase 4 models (read-only) ──────────────────────────────────────────────
  const ORDER_BY = new Set(['affiliateId', 'status', 'isFake']);
  const affiliateOrder = {
    async groupBy(args = {}) {
      await before('affiliateOrder', 'groupBy', { where: args.where });
      const { by, where, _count, ...rest } = args;
      if (Object.keys(rest).length) throw new Error(`fake affiliateOrder.groupBy: only by / where / _count are allowed (got ${Object.keys(rest).join(',')}) — no amount aggregate`);
      if (!Array.isArray(by) || !by.length || !by.every((k) => ORDER_BY.has(k))) throw new Error(`fake affiliateOrder.groupBy: by must be a subset of affiliateId/status/isFake (got ${JSON.stringify(by)})`);
      if (!_count || Object.keys(_count).join() !== '_all' || _count._all !== true) throw new Error('fake affiliateOrder.groupBy: only _count: { _all: true }');
      const wk = Object.keys(where || {});
      const extraOk = phase5 ? wk.filter((k) => k !== 'affiliateId').every((k) => ['status', 'isFake'].includes(k) && (typeof where[k] === 'string' || typeof where[k] === 'boolean')) : wk.length === 1;
      if (!wk.includes('affiliateId') || !extraOk || !Array.isArray(where.affiliateId?.in)) throw new Error(`fake affiliateOrder.groupBy: unsupported where ${JSON.stringify(where)}`);
      const wanted = new Set(where.affiliateId.in);
      const groups = new Map();
      for (const o of rows('affiliateOrder')) {
        if (!wanted.has(o.affiliateId)) continue;
        if ('status' in (where || {}) && o.status !== where.status) continue;
        if ('isFake' in (where || {}) && o.isFake !== where.isFake) continue;
        const key = JSON.stringify(by.map((k) => o[k]));
        if (!groups.has(key)) groups.set(key, { ...Object.fromEntries(by.map((k) => [k, o[k]])), _count: { _all: 0 } });
        groups.get(key)._count._all += 1;
      }
      return [...groups.values()];
    },
  };
  for (const op of ['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
    affiliateOrder[op] = async () => { throw new Error(`fake db: affiliateOrder.${op} is not allowed in recruiter code (counts via groupBy only)`); };
  }
  const IDV_READ = new Set(['affiliateId', 'status']);
  const identityVerification = {
    async findMany({ where, select, ...rest } = {}) {
      await before('identityVerification', 'findMany', { where });
      if (Object.keys(rest).length) throw new Error(`fake identityVerification.findMany: unsupported args ${Object.keys(rest).join(',')}`);
      if (!select || !Object.keys(select).length || !Object.keys(select).every((k) => IDV_READ.has(k))) {
        throw new Error(`fake identityVerification.findMany: select must be a subset of affiliateId/status (got ${JSON.stringify(select)}) — no document / file key`);
      }
      const wk = Object.keys(where || {});
      if (wk.length !== 1 || wk[0] !== 'affiliateId' || !Array.isArray(where.affiliateId?.in)) throw new Error(`fake identityVerification.findMany: unsupported where ${JSON.stringify(where)}`);
      const wanted = new Set(where.affiliateId.in);
      return rows('identityVerification').filter((r) => wanted.has(r.affiliateId)).map((r) => pick(r, select));
    },
  };
  for (const op of ['findFirst', 'findUnique', 'count', 'groupBy', 'aggregate', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
    identityVerification[op] = async () => { throw new Error(`fake db: identityVerification.${op} is not allowed in recruiter code`); };
  }

  // ── Phase 6 part 1: affiliate_activation_codes ────────────────────────────────
  const HEX64 = /^[0-9a-f]{64}$/;
  const SELECTOR_RE = /^[A-Za-z0-9_-]{16}$/;
  const AC_REASONS = ['REGENERATED', 'TOO_MANY_ATTEMPTS', 'CREDENTIALS_CHANGED', 'ADMIN_RECOVERY'];
  const AC_MUTABLE = new Set(['usedAt', 'invalidatedAt', 'invalidatedReason', 'failedAttempts']);
  const t = (d) => (d == null ? null : new Date(d).getTime());
  function checkActivationCode(c) {
    const ok = SELECTOR_RE.test(String(c.selector)) && HEX64.test(String(c.verifierHash)) && HEX64.test(String(c.passwordFingerprint))
      && ['RECRUITER', 'ADMIN'].includes(c.createdByType) && typeof c.createdById === 'string' && c.createdById.length > 0
      && t(c.expiresAt) > t(c.createdAt) && t(c.expiresAt) <= t(c.createdAt) + 24 * 3600 * 1000
      && Number.isInteger(c.failedAttempts) && c.failedAttempts >= 0 && c.failedAttempts <= 5
      && !(c.usedAt != null && c.invalidatedAt != null)
      && ((c.invalidatedAt == null) === (c.invalidatedReason == null))
      && (c.invalidatedReason == null || AC_REASONS.includes(c.invalidatedReason));
    if (!ok) throw checkErr('affiliate_activation_codes_check');
  }
  const isActiveCode = (c) => c.usedAt == null && c.invalidatedAt == null;
  const affiliateActivationCode = {
    async create({ data, select } = {}) {
      await before('affiliateActivationCode', 'create', { data });
      const now = new Date();
      const c = { id: randomUUID(), createdAt: now, failedAttempts: 0, usedAt: null, invalidatedAt: null, invalidatedReason: null, ...clone(data) };
      checkActivationCode(c);
      if (T.affiliateActivationCode.some((x) => x.selector === c.selector)) throw p2002('selector');
      // partial unique index: one ACTIVE code per affiliate (PostgreSQL would wait on an
      // uncommitted conflicting row; the service holds the advisory lock, so that never happens)
      if (T.affiliateActivationCode.some((x) => x.affiliateId === c.affiliateId && isActiveCode(x))) throw p2002('affiliateId');
      if (!T.affiliate.some((x) => x.id === c.affiliateId && visible(x))) throw fkErr('affiliateId');
      T.affiliateActivationCode.push(c);
      markWritten(c);
      undoPush(() => { T.affiliateActivationCode.splice(T.affiliateActivationCode.indexOf(c), 1); });
      return pick(c, select);
    },
    async findUnique({ where, select } = {}) {
      await before('affiliateActivationCode', 'findUnique', { where });
      const k = Object.keys(where || {});
      if (k.length !== 1 || !['id', 'selector'].includes(k[0])) throw new Error(`fake affiliateActivationCode.findUnique: unsupported where ${JSON.stringify(where)}`);
      return pick(rows('affiliateActivationCode').find((x) => x[k[0]] === where[k[0]]), select);
    },
    async findFirst({ where, orderBy, select } = {}) {
      await before('affiliateActivationCode', 'findFirst', { where });
      return pick(sortRows(rows('affiliateActivationCode').filter((r) => genericMatchAc(r, where)), orderBy)[0], select);
    },
    async findMany({ where, orderBy, take, select } = {}) {
      await before('affiliateActivationCode', 'findMany', { where });
      return takeRowsAc(sortRows(rows('affiliateActivationCode').filter((r) => genericMatchAc(r, where)), orderBy), take).map((r) => pick(r, select));
    },
    async updateMany({ where, data } = {}) {
      await before('affiliateActivationCode', 'updateMany', { where, data });
      const dk = Object.keys(data || {});
      if (!dk.length) throw new Error('fake affiliateActivationCode.updateMany: empty data');
      let count = 0;
      for (const r of rows('affiliateActivationCode').filter((x) => genericMatchAc(x, where))) {
        // the life-cycle guard trigger (BEFORE UPDATE): immutable columns, forwards only
        if (dk.some((k) => !AC_MUTABLE.has(k))) throw triggerErr('affiliate_activation_codes: only the life-cycle columns may change, forwards only');
        const next = { ...r, ...clone(data) };
        if (next.failedAttempts < r.failedAttempts
          || (r.usedAt != null && t(next.usedAt) !== t(r.usedAt))
          || (r.invalidatedAt != null && (t(next.invalidatedAt) !== t(r.invalidatedAt) || next.invalidatedReason !== r.invalidatedReason))) {
          throw triggerErr('affiliate_activation_codes: only the life-cycle columns may change, forwards only');
        }
        checkActivationCode(next);
        if (isActiveCode(next) && !isActiveCode(r) && T.affiliateActivationCode.some((x) => x !== r && x.affiliateId === r.affiliateId && isActiveCode(x))) throw p2002('affiliateId');
        const prev = clone(r);
        Object.assign(r, clone(data));
        undoPush(() => { Object.keys(r).forEach((k) => delete r[k]); Object.assign(r, prev); });
        count += 1;
      }
      return { count };
    },
  };
  const takeRowsAc = (list, take) => (Number.isInteger(take) ? list.slice(0, take) : list);
  for (const op of ['update', 'upsert', 'delete', 'deleteMany', 'createMany']) {
    affiliateActivationCode[op] = async () => { throw triggerErr(`affiliate_activation_codes: ${op.toUpperCase()} refused`); };
  }

  // ── Phase 6 recovery: affiliate_activation_recoveries ─────────────────────────
  const RV_STATUS = ['PENDING', 'APPROVED', 'REJECTED'];
  const RV_REVIEW = new Set(['status', 'reviewedBy', 'reviewedAt', 'reviewNote', 'activationCodeId']);
  function checkRecovery(r) {
    const msg = typeof r.message === 'string' ? r.message.trim() : '';
    const reviewed = typeof r.reviewedBy === 'string' && r.reviewedBy.length > 0 && r.reviewedAt != null;
    const ok = RV_STATUS.includes(r.status)
      && msg.length >= 1 && msg.length <= 500
      && (r.contactPhone == null || /^\+?[0-9]{8,15}$/.test(String(r.contactPhone)))
      && (r.requestIp == null || String(r.requestIp).length <= 64)
      && (r.reviewNote == null || String(r.reviewNote).length <= 300)
      && (r.status !== 'PENDING' || (r.reviewedBy == null && r.reviewedAt == null && r.activationCodeId == null))
      && (r.status !== 'APPROVED' || (reviewed && r.activationCodeId != null))
      && (r.status !== 'REJECTED' || (reviewed && r.activationCodeId == null));
    if (!ok) throw checkErr('affiliate_activation_recoveries_check');
  }
  const affiliateActivationRecovery = {
    async create({ data, select } = {}) {
      await before('affiliateActivationRecovery', 'create', { data });
      const r = {
        id: randomUUID(), status: 'PENDING', contactPhone: null, requestIp: null, requestedAt: new Date(),
        reviewedBy: null, reviewedAt: null, reviewNote: null, activationCodeId: null, ...clone(data),
      };
      checkRecovery(r);
      // partial unique index: one PENDING request per affiliate (committed or not)
      if (r.status === 'PENDING' && T.affiliateActivationRecovery.some((x) => x.affiliateId === r.affiliateId && x.status === 'PENDING')) throw p2002('affiliateId');
      if (!T.affiliate.some((x) => x.id === r.affiliateId && visible(x))) throw fkErr('affiliateId');
      if (r.activationCodeId != null && !T.affiliateActivationCode.some((x) => x.id === r.activationCodeId)) throw fkErr('activationCodeId');
      T.affiliateActivationRecovery.push(r);
      markWritten(r);
      undoPush(() => { T.affiliateActivationRecovery.splice(T.affiliateActivationRecovery.indexOf(r), 1); });
      return pick(r, select);
    },
    async findUnique({ where, select } = {}) {
      await before('affiliateActivationRecovery', 'findUnique', { where });
      const k = Object.keys(where || {});
      if (k.length !== 1 || k[0] !== 'id') throw new Error(`fake affiliateActivationRecovery.findUnique: unsupported where ${JSON.stringify(where)}`);
      return pick(rows('affiliateActivationRecovery').find((x) => x.id === where.id), select);
    },
    async findMany({ where, orderBy, take, select } = {}) {
      await before('affiliateActivationRecovery', 'findMany', { where });
      const list = sortRows(rows('affiliateActivationRecovery').filter((r) => genericMatchAc(r, where)), orderBy);
      return (Number.isInteger(take) ? list.slice(0, take) : list).map((r) => pick(r, select));
    },
    async updateMany({ where, data } = {}) {
      await before('affiliateActivationRecovery', 'updateMany', { where, data });
      const dk = Object.keys(data || {});
      if (!dk.length) throw new Error('fake affiliateActivationRecovery.updateMany: empty data');
      let count = 0;
      for (const r of rows('affiliateActivationRecovery').filter((x) => genericMatchAc(x, where))) {
        // the guard trigger (BEFORE UPDATE): review a PENDING request once, request fields immutable
        const next = { ...r, ...clone(data) };
        if (dk.some((k) => !RV_REVIEW.has(k)) || r.status !== 'PENDING' || !['APPROVED', 'REJECTED'].includes(next.status)) {
          throw triggerErr('affiliate_activation_recoveries: only a PENDING request can be reviewed, once');
        }
        checkRecovery(next);
        if (next.activationCodeId != null && !T.affiliateActivationCode.some((x) => x.id === next.activationCodeId)) throw fkErr('activationCodeId');
        const prev = clone(r);
        Object.assign(r, clone(data));
        undoPush(() => { Object.keys(r).forEach((k) => delete r[k]); Object.assign(r, prev); });
        count += 1;
      }
      return { count };
    },
  };
  for (const op of ['update', 'upsert', 'delete', 'deleteMany', 'createMany']) {
    affiliateActivationRecovery[op] = async () => { throw triggerErr(`affiliate_activation_recoveries: ${op.toUpperCase()} refused`); };
  }

  // ── Phase 5 models (rewards, settings versions, withdrawals) ──────────────────
  const recruiterSettingsVersion = {};
  const recruiterRewardLedger = {};
  const affiliatePayout = {};
  const genericMatch = (r, where) => Object.entries(where || {}).every(([k, v]) => {
    if (k === 'OR') return Array.isArray(v) && v.some((w) => genericMatch(r, w));
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((w) => genericMatch(r, w));
    return matchScalar(r[k], v);
  });
  const takeRows = (list, take) => (Number.isInteger(take) ? list.slice(0, take) : list);
  function sumGroups(list, by, _sum, _count) {
    const groups = new Map();
    for (const r of list) {
      const key = JSON.stringify((by || []).map((k) => r[k]));
      if (!groups.has(key)) {
        const g = Object.fromEntries((by || []).map((k) => [k, r[k]]));
        if (_sum) g._sum = Object.fromEntries(Object.keys(_sum).map((k) => [k, null]));
        if (_count) g._count = { _all: 0 };
        groups.set(key, g);
      }
      const g = groups.get(key);
      if (_sum) for (const k of Object.keys(_sum)) g._sum[k] = (g._sum[k] ?? 0) + Number(r[k] ?? 0);
      if (_count) g._count._all += 1;
    }
    return [...groups.values()];
  }
  if (phase5) {
    // recruiter_settings_versions: consecutive versions (trigger under an advisory lock held
    // until commit — a concurrent insert waits, then fails the check), the CHECKs, append-only.
    Object.assign(recruiterSettingsVersion, {
      async findFirst({ where, orderBy, select } = {}) {
        await before('recruiterSettingsVersion', 'findFirst', { where });
        return pick(sortRows(rows('recruiterSettingsVersion').filter((r) => genericMatch(r, where)), orderBy)[0], select);
      },
      async findMany({ where, orderBy, take, select } = {}) {
        await before('recruiterSettingsVersion', 'findMany', { where });
        return takeRows(sortRows(rows('recruiterSettingsVersion').filter((r) => genericMatch(r, where)), orderBy), take).map((r) => pick(r, select));
      },
      async create({ data }) {
        await before('recruiterSettingsVersion', 'create', { data });
        await lockRecruiterRow('__recruiter_settings_versions__');
        const r = { createdAt: new Date(), ...clone(data) };
        const expected = rows('recruiterSettingsVersion').reduce((m, x) => Math.max(m, x.version), 0) + 1;
        if (r.version !== expected) throw triggerErr(`recruiter settings version must be ${expected} (got ${r.version})`);
        if (T.recruiterSettingsVersion.some((x) => x.version === r.version)) throw p2002('version');
        if (!(r.version >= 1 && Number.isInteger(r.rewardAmountCents) && r.rewardAmountCents >= 0 && r.rewardAmountCents <= 100_000_000
          && Number.isInteger(r.minDeliveredSales) && r.minDeliveredSales >= 1 && r.minDeliveredSales <= 100_000
          && (!r.enabled || r.rewardAmountCents > 0) && typeof r.createdBy === 'string' && r.createdBy.length > 0 && typeof r.enabled === 'boolean')) {
          throw checkErr('recruiter_settings_versions_check');
        }
        T.recruiterSettingsVersion.push(r);
        markWritten(r);
        undoPush(() => { T.recruiterSettingsVersion.splice(T.recruiterSettingsVersion.indexOf(r), 1); });
        return clone(r);
      },
    });
    for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
      recruiterSettingsVersion[op] = async () => { throw triggerErr('recruiter_settings_versions is append-only'); };
    }

    // recruiter_reward_ledger: append-only, CHECKs, idempotency key, one recruit reward per
    // affiliate (partial unique index), link guard trigger, FKs.
    Object.assign(recruiterRewardLedger, {
      async create({ data }) {
        await before('recruiterRewardLedger', 'create', { data });
        const r = { id: randomUUID(), seq: BigInt(++seq), affiliateId: null, reason: null, actorId: null, settingsVersion: null, createdAt: new Date(), ...clone(data) };
        if (!['RECRUIT_REWARD', 'REVERSAL', 'ADMIN_ADJUSTMENT'].includes(r.type)) throw checkErr('recruiter_reward_ledger_type_check');
        if (!(['SYSTEM', 'ADMIN'].includes(r.actorType) && (r.actorType === 'SYSTEM' || r.actorId != null))) throw checkErr('recruiter_reward_ledger_actor_check');
        const a = r.amountCents;
        if (!(Number.isInteger(a) && a !== 0 && Math.abs(a) <= 100_000_000
          && (r.type !== 'RECRUIT_REWARD' || (a > 0 && r.affiliateId != null && r.settingsVersion != null))
          && (r.type !== 'REVERSAL' || (a < 0 && r.affiliateId != null))
          && (r.type !== 'ADMIN_ADJUSTMENT' || (r.actorType === 'ADMIN' && String(r.reason ?? '').trim().length > 0)))) throw checkErr('recruiter_reward_ledger_amount_check');
        // BEFORE INSERT triggers: link guard (and the reversal guard is not used by Phase 5 code).
        if (r.affiliateId != null && !rows('recruiterAffiliateLink').some((l) => l.affiliateId === r.affiliateId && l.recruiterId === r.recruiterId)) {
          throw triggerErr(`affiliate ${r.affiliateId} is not linked to recruiter ${r.recruiterId}`);
        }
        if (T.recruiterRewardLedger.some((x) => x.idempotencyKey === r.idempotencyKey)) throw p2002('idempotencyKey');
        if (r.type === 'RECRUIT_REWARD' && T.recruiterRewardLedger.some((x) => x.type === 'RECRUIT_REWARD' && x.affiliateId === r.affiliateId)) throw p2002('affiliateId');
        if (!T.recruiter.some((x) => x.id === r.recruiterId)) throw fkErr('recruiterId');
        if (r.affiliateId != null && !T.affiliate.some((x) => x.id === r.affiliateId)) throw fkErr('affiliateId');
        T.recruiterRewardLedger.push(r);
        markWritten(r);
        undoPush(() => { T.recruiterRewardLedger.splice(T.recruiterRewardLedger.indexOf(r), 1); });
        return clone(r);
      },
      async findFirst({ where, orderBy, select } = {}) {
        await before('recruiterRewardLedger', 'findFirst', { where });
        return pick(sortRows(rows('recruiterRewardLedger').filter((r) => genericMatch(r, where)), orderBy || [{ seq: 'asc' }])[0], select);
      },
      async findMany({ where, orderBy, take, select } = {}) {
        await before('recruiterRewardLedger', 'findMany', { where });
        return takeRows(sortRows(rows('recruiterRewardLedger').filter((r) => genericMatch(r, where)), orderBy || [{ seq: 'asc' }]), take).map((r) => pick(r, select));
      },
      async aggregate({ where, _sum, ...rest } = {}) {
        await before('recruiterRewardLedger', 'aggregate', { where });
        if (Object.keys(rest).length || !_sum) throw new Error('fake recruiterRewardLedger.aggregate: only where + _sum');
        const list = rows('recruiterRewardLedger').filter((r) => genericMatch(r, where));
        const out = {};
        for (const k of Object.keys(_sum)) out[k] = list.length ? list.reduce((t, r) => t + Number(r[k] ?? 0), 0) : null;
        return { _sum: out };
      },
      async groupBy({ by, where, _sum, _count } = {}) {
        await before('recruiterRewardLedger', 'groupBy', { where });
        return sumGroups(rows('recruiterRewardLedger').filter((r) => genericMatch(r, where)), by, _sum, _count);
      },
    });
    for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'createMany']) {
      recruiterRewardLedger[op] = async () => { throw triggerErr('recruiter_reward_ledger is append-only'); };
    }

    // affiliate_payouts: exactly one owner, the recruiter amount CHECK, FKs. Every call is
    // recorded (model op + where / data) so tests can prove recruiter code scopes by recruiterId.
    const record = (op, args) => payoutCalls.push({ op, where: clone(args?.where ?? null), data: clone(args?.data ?? null) });
    const projectPayout = (p, { select, include } = {}) => {
      const out = pick(p, select);
      if (include?.recruiter) {
        const r = T.recruiter.find((x) => x.id === p.recruiterId);
        out.recruiter = r ? pick(r, include.recruiter === true ? undefined : include.recruiter.select) : null;
      }
      if (include?.affiliate) {
        const a = T.affiliate.find((x) => x.id === p.affiliateId);
        out.affiliate = a ? pick(a, include.affiliate === true ? undefined : include.affiliate.select) : null;
      }
      return out;
    };
    const checkPayout = (p) => {
      if ((p.affiliateId == null) === (p.recruiterId == null)) throw checkErr('affiliate_payouts_owner_check');
      if (p.recruiterId != null) {
        const amt = Number(p.amount);
        if (!(amt >= 0.01 && amt <= 1_000_000 && Math.abs(amt * 100 - Math.round(amt * 100)) < 0.000001)) throw checkErr('affiliate_payouts_recruiter_amount_check');
        if (!T.recruiter.some((x) => x.id === p.recruiterId)) throw fkErr('recruiterId');
      }
      if (p.affiliateId != null && !T.affiliate.some((x) => x.id === p.affiliateId)) throw fkErr('affiliateId');
    };
    Object.assign(affiliatePayout, {
      async create(args = {}) {
        record('create', args);
        await before('affiliatePayout', 'create', { data: args.data });
        const p = { id: randomUUID(), affiliateId: null, recruiterId: null, status: 'pending', createdAt: new Date(), ...clone(args.data) };
        checkPayout(p);
        T.affiliatePayout.push(p);
        markWritten(p);
        undoPush(() => { T.affiliatePayout.splice(T.affiliatePayout.indexOf(p), 1); });
        return projectPayout(p, args);
      },
      async findMany(args = {}) {
        record('findMany', args);
        await before('affiliatePayout', 'findMany', { where: args.where });
        return takeRows(sortRows(rows('affiliatePayout').filter((r) => genericMatch(r, args.where)), args.orderBy), args.take).map((r) => projectPayout(r, args));
      },
      async findFirst(args = {}) {
        record('findFirst', args);
        await before('affiliatePayout', 'findFirst', { where: args.where });
        const r = sortRows(rows('affiliatePayout').filter((x) => genericMatch(x, args.where)), args.orderBy)[0];
        return r ? projectPayout(r, args) : null;
      },
      async findUnique(args = {}) {
        record('findUnique', args);
        await before('affiliatePayout', 'findUnique', { where: args.where });
        const k = Object.keys(args.where || {});
        if (k.length !== 1 || k[0] !== 'id') throw new Error(`fake affiliatePayout.findUnique: unsupported where ${JSON.stringify(args.where)}`);
        const r = rows('affiliatePayout').find((x) => x.id === args.where.id);
        return r ? projectPayout(r, args) : null;
      },
      async updateMany(args = {}) {
        record('updateMany', args);
        await before('affiliatePayout', 'updateMany', { where: args.where });
        const dk = Object.keys(args.data || {});
        if (!dk.length || dk.some((k) => k !== 'status')) throw new Error('fake affiliatePayout.updateMany: only the status can change');
        let count = 0;
        for (const r of rows('affiliatePayout').filter((x) => genericMatch(x, args.where))) {
          const prev = clone(r);
          Object.assign(r, clone(args.data));
          undoPush(() => { Object.assign(r, prev); });
          count += 1;
        }
        return { count };
      },
      async update(args = {}) {
        record('update', args);
        await before('affiliatePayout', 'update', { where: args.where });
        const r = rows('affiliatePayout').find((x) => x.id === args.where?.id);
        if (!r) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        const prev = clone(r);
        Object.assign(r, clone(args.data));
        try { checkPayout(r); } catch (e) { Object.assign(r, prev); throw e; }
        undoPush(() => { Object.assign(r, prev); });
        return projectPayout(r, args);
      },
      async aggregate(args = {}) {
        record('aggregate', args);
        await before('affiliatePayout', 'aggregate', { where: args.where });
        const list = rows('affiliatePayout').filter((r) => genericMatch(r, args.where));
        const out = {};
        for (const k of Object.keys(args._sum || {})) out[k] = list.length ? list.reduce((t, r) => t + Number(r[k] ?? 0), 0) : null;
        return { _sum: out };
      },
    });
    for (const op of ['delete', 'deleteMany', 'upsert', 'createMany']) {
      affiliatePayout[op] = async () => { throw new Error(`fake db: affiliatePayout.${op} is not allowed`); };
    }

    // Reads used by the reward hooks / service (status only — never a document field).
    affiliateOrder.findUnique = async ({ where, select } = {}) => {
      await before('affiliateOrder', 'findUnique', { where });
      const k = Object.keys(where || {});
      if (k.length !== 1 || k[0] !== 'id') throw new Error(`fake affiliateOrder.findUnique: unsupported where ${JSON.stringify(where)}`);
      if (!select || !Object.keys(select).every((x) => ['affiliateId', 'status', 'isFake', 'id'].includes(x))) throw new Error(`fake affiliateOrder.findUnique: select must be a subset of id/affiliateId/status/isFake (got ${JSON.stringify(select)})`);
      return pick(rows('affiliateOrder').find((o) => o.id === where.id), select);
    };
    identityVerification.findUnique = async ({ where, select } = {}) => {
      await before('identityVerification', 'findUnique', { where });
      const k = Object.keys(where || {});
      if (k.length !== 1 || !['id', 'affiliateId'].includes(k[0])) throw new Error(`fake identityVerification.findUnique: unsupported where ${JSON.stringify(where)}`);
      if (!select || !Object.keys(select).every((x) => ['affiliateId', 'status'].includes(x))) throw new Error(`fake identityVerification.findUnique: select must be a subset of affiliateId/status (got ${JSON.stringify(select)}) — no document / file key`);
      return pick(rows('identityVerification').find((r) => r[k[0]] === where[k[0]]), select);
    };
    // existence check of the affiliate (select id only) is already affiliate.findUnique.
  }

  // The recursive network query, emulated exactly like the SQL (a working table per iteration).
  const TREE_FRAGMENTS = [
    'WITH RECURSIVE tree AS (',
    'FROM "recruiter_affiliate_links" l JOIN "affiliates" a ON a."id" = l."affiliateId" WHERE l."recruiterId" = $?',
    'AND (a."parentId" IS NULL OR NOT EXISTS ( SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = a."parentId" AND pl."recruiterId" = $?))',
    'UNION ALL',
    'FROM tree t JOIN "affiliates" c ON c."parentId" = t."id" JOIN "recruiter_affiliate_links" cl ON cl."affiliateId" = c."id" AND cl."recruiterId" = $?',
    'WHERE t.depth < $?::int',
    'SELECT "id", "parentId", "isActive", "createdAt", depth::int AS depth FROM tree',
  ];
  function networkTree(norm, values) {
    for (const f of TREE_FRAGMENTS) if (!norm.includes(f)) throw new Error(`fake $queryRaw: the network query changed (missing: ${f}) — update the emulation`);
    if (values.length !== 4 || values[0] !== values[1] || values[1] !== values[2]) throw new Error('fake $queryRaw: the network query must bind the same recruiterId 3 times, then the bound');
    const [rid, , , bound] = values;
    const links = rows('recruiterAffiliateLink');
    const linked = new Set(links.filter((l) => l.recruiterId === rid).map((l) => l.affiliateId));
    const affs = rows('affiliate');
    const byId = new Map(affs.map((a) => [a.id, a]));
    const childrenOf = new Map();
    for (const a of affs) { if (a.parentId != null) { if (!childrenOf.has(a.parentId)) childrenOf.set(a.parentId, []); childrenOf.get(a.parentId).push(a); } }
    const out = [];
    let work = [];
    for (const id of linked) {
      const a = byId.get(id);
      if (!a) continue;
      if (a.parentId == null || !linked.has(a.parentId)) work.push({ id: a.id, parentId: a.parentId, isActive: a.isActive, createdAt: a.createdAt, depth: 1 });
    }
    let guard = 0;
    while (work.length) {
      out.push(...work);
      if (++guard > 1_000_000) throw new Error('fake $queryRaw: runaway recursion');
      const next = [];
      for (const t of work) {
        if (!(t.depth < bound)) continue;
        for (const c of childrenOf.get(t.id) || []) if (linked.has(c.id)) next.push({ id: c.id, parentId: c.parentId, isActive: c.isActive, createdAt: c.createdAt, depth: t.depth + 1 });
      }
      work = next;
    }
    return out.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt) : null }));
  }

  async function $queryRaw(strings, ...values) {
    const sql = Array.isArray(strings) ? strings.join('$?') : String(strings);
    log.push({ model: '$queryRaw', op: 'query', sql });
    if (typeof hooks.before === 'function') await hooks.before('$queryRaw', 'query', { sql, values });
    await tick();
    if (state.failOnce['$queryRaw.query']) { const e = state.failOnce['$queryRaw.query']; delete state.failOnce['$queryRaw.query']; throw e instanceof Error ? e : new Error('$queryRaw failed (injected)'); }
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = \$\? FOR NO KEY UPDATE$/.test(norm)) {
      const id = values[0];
      if (!ctx()) throw new Error('fake $queryRaw: FOR NO KEY UPDATE outside a transaction (the lock would be released at once)');
      await lockRecruiterRow(id);
      const r = rows('recruiter').find((x) => x.id === id); // re-read after the wait (latest committed row)
      return r ? [{ isActive: r.isActive, canCreateAffiliates: r.canCreateAffiliates }] : [];
    }
    if (/^SELECT "isActive" FROM "recruiters" WHERE "id" = \$\? FOR NO KEY UPDATE$/.test(norm)) {
      const id = values[0];
      if (!ctx()) throw new Error('fake $queryRaw: FOR NO KEY UPDATE outside a transaction (the lock would be released at once)');
      await lockRecruiterRow(id);
      const r = rows('recruiter').find((x) => x.id === id);
      return r ? [{ isActive: r.isActive }] : [];
    }
    if (phase5 && /^SELECT "isActive", "bankName", "rib", "accountName" FROM "recruiters" WHERE "id" = \$\? FOR NO KEY UPDATE$/.test(norm)) {
      const id = values[0];
      if (!ctx()) throw new Error('fake $queryRaw: FOR NO KEY UPDATE outside a transaction (the lock would be released at once)');
      await lockRecruiterRow(id);
      const r = rows('recruiter').find((x) => x.id === id);
      return r ? [{ isActive: r.isActive, bankName: r.bankName ?? null, rib: r.rib ?? null, accountName: r.accountName ?? null }] : [];
    }
    if (phase4 && norm.startsWith('/* recruiter-network-tree */')) return networkTree(norm, values);
    throw new Error(`fake $queryRaw: unsupported statement ${norm}`);
  }

  // Phase 5: the settings advisory lock (the SAME key as the consecutive-version trigger),
  // emulated with the same lock the fake trigger uses, held until the transaction ends.
  async function $executeRaw(strings, ...values) {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
    const norm = sql.replace(/\s+/g, ' ').trim();
    log.push({ model: '$executeRaw', op: 'execute', sql });
    if (norm === 'SELECT pg_advisory_xact_lock(hashtext(?))' && values.length === 1 && typeof values[0] === 'string') {
      if (!ctx()) throw new Error('fake $executeRaw: advisory xact lock outside a transaction');
      await lockRecruiterRow(`__advisory__:${values[0]}`);
      return 1;
    }
    if (phase5 && norm === "SELECT pg_advisory_xact_lock(hashtext('recruiter_settings_versions'))" && values.length === 0) {
      if (!ctx()) throw new Error('fake $executeRaw: advisory xact lock outside a transaction');
      await lockRecruiterRow('__recruiter_settings_versions__');
      return 1;
    }
    throw new Error(`fake $executeRaw: unsupported statement ${norm}`);
  }

  async function $transaction(fn) {
    log.push({ model: '$transaction', op: 'begin' });
    if (typeof fn !== 'function') throw new Error('fake $transaction: only the interactive form is supported');
    const outer = ctx();
    // Nested call: same database transaction, its own undo scope (like a savepoint).
    const c = outer
      ? { id: outer.id, undo: [], locks: outer.locks, nested: true }
      : { id: ++txSeq, undo: [], locks: [], nested: false };
    if (!c.nested) openTx.add(c.id);
    try {
      const out = await als.run(c, () => fn(db));
      if (c.nested) outer.undo.push(...c.undo);
      else { openTx.delete(c.id); releaseLocks(c); }
      return out;
    } catch (e) {
      for (const f of c.undo.reverse()) f();
      if (!c.nested) { openTx.delete(c.id); releaseLocks(c); }
      throw e;
    }
  }

  // Test-only seeding that bypasses the trigger (e.g. pre-existing, admin-created or corrupt data).
  const seed = {
    affiliate(data) {
      const now = new Date();
      const r = { id: randomUUID(), name: '', phone: null, password: '', isActive: false, parentId: null, commissionRate: 0.5, createdAt: now, updatedAt: now, ...clone(data) };
      T.affiliate.push(r);
      return clone(r);
    },
    link(data) { const l = { createdAt: new Date(), createdBy: data.recruiterId, ...clone(data) }; T.recruiterAffiliateLink.push(l); return clone(l); },
    order(data) { const o = { id: randomUUID(), status: 'pending', isFake: false, total: 0, clientName: null, clientPhone: null, createdAt: new Date(), ...clone(data) }; T.affiliateOrder.push(o); return clone(o); },
    identity(data) { const r = { id: randomUUID(), status: 'PENDING', cinFrontFile: 'secret/front.jpg', cinBackFile: 'secret/back.jpg', ...clone(data) }; T.identityVerification.push(r); return clone(r); },
    settings(data) { const r = { createdBy: 'admin-seed', createdAt: new Date(), ...clone(data) }; T.recruiterSettingsVersion.push(r); return clone(r); },
    activationCode(data) {
      const now = new Date();
      const c = { id: randomUUID(), createdAt: now, expiresAt: new Date(now.getTime() + 24 * 3600 * 1000), failedAttempts: 0, usedAt: null, invalidatedAt: null, invalidatedReason: null, createdByType: 'RECRUITER', ...clone(data) };
      T.affiliateActivationCode.push(c);
      return clone(c);
    },
    payout(data) { const p = { id: randomUUID(), affiliateId: null, recruiterId: null, status: 'pending', createdAt: new Date(), ...clone(data) }; T.affiliatePayout.push(p); return clone(p); },
    recovery(data) {
      const r = { id: randomUUID(), status: 'PENDING', message: 'seeded request', contactPhone: null, requestIp: null, requestedAt: new Date(), reviewedBy: null, reviewedAt: null, reviewNote: null, activationCodeId: null, ...clone(data) };
      T.affiliateActivationRecovery.push(r);
      return clone(r);
    },
    ledger(data) { const r = { id: randomUUID(), seq: BigInt(++seq), affiliateId: null, reason: null, actorId: null, settingsVersion: null, actorType: 'SYSTEM', createdAt: new Date(), ...clone(data) }; T.recruiterRewardLedger.push(r); return clone(r); },
    recruiter(data) {
      const now = new Date();
      const r = {
        id: randomUUID(), phone: null, isActive: true, canCreateAffiliates: true, canViewOrders: true, disabledAt: null, disabledBy: null, disabledReason: null,
        lastLoginAt: null, createdBy: 'admin-seed', passwordHash: '$2a$12$' + 'a'.repeat(53), createdAt: now, updatedAt: now, ...clone(data),
      };
      checkRecruiter(r);
      T.recruiter.push(r);
      return clone(r);
    },
  };

  const base = {
    recruiter, recruiterAuditLog, $transaction,
    ...(phase3 ? { affiliate, recruiterAffiliateLink, $queryRaw, affiliateActivationCode, $executeRaw } : {}),
    ...(phase4 ? { affiliateOrder, identityVerification } : {}),
    ...(phase5 ? { recruiterSettingsVersion, recruiterRewardLedger, affiliatePayout } : {}),
    ...(recovery ? { affiliateActivationRecovery } : {}),
    _queryCount: () => log.filter((l) => l.model !== '$transaction').length,
    _tables: T, _log: log, _state: state, _seed: seed, _openTx: openTx, _locks: locks, _payoutCalls: payoutCalls,
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
