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
    else if (op === 'not') { if (val(v) === val(arg)) return false; }
    else if (op === 'contains') {
      if (typeof v !== 'string') return false;
      const insensitive = cond.mode === 'insensitive';
      if (!(insensitive ? v.toLowerCase().includes(String(arg).toLowerCase()) : v.includes(arg))) return false;
    } else if (op === 'mode') { /* modifier of contains */ }
    else throw new Error(`fake where: unsupported operator ${op}`);
  }
  return true;
}

export function makeRecruiterFakeDb({ failAuditCreate = false, phase3 = false, failOnce = {}, hooks = {} } = {}) {
  const T = { recruiter: [], recruiterAuditLog: [], affiliate: [], recruiterAffiliateLink: [] };
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

  const recruiter = {
    async create({ data }) {
      await before('recruiter', 'create', { data });
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
    async findMany({ orderBy, select } = {}) {
      await before('recruiter', 'findMany', {});
      return sortRows(rows('recruiter'), orderBy).map((r) => pick(r, select));
    },
    async update({ where, data }) {
      await before('recruiter', 'update', { where, data });
      if (where?.id) await lockRecruiterRow(where.id);
      const row = rows('recruiter').find((x) => x.id === where?.id);
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      const prev = clone(row);
      const next = { ...row, ...clone(data), updatedAt: new Date() };
      if (next.username !== row.username && T.recruiter.some((x) => x !== row && x.username === next.username)) throw p2002('username');
      if (next.phone != null && next.phone !== row.phone && T.recruiter.some((x) => x !== row && x.phone === next.phone)) throw p2002('phone');
      checkRecruiter(next);
      Object.assign(row, next);
      undoPush(() => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, prev); });
      return clone(row);
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
    async findMany({ where = {}, orderBy } = {}) {
      await before('recruiterAuditLog', 'findMany', {});
      return sortRows(rows('recruiterAuditLog').filter((r) => auditMatch(r, where)), orderBy || [{ seq: 'asc' }]).map(clone);
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
      else out[k] = clone(l[k]);
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
    throw new Error(`fake $queryRaw: unsupported statement ${norm}`);
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
    ...(phase3 ? { affiliate, recruiterAffiliateLink, $queryRaw } : {}),
    _tables: T, _log: log, _state: state, _seed: seed, _openTx: openTx, _locks: locks,
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
