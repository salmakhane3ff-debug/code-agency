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
 *                       Phase 6 part 5c: plus the creation's `/* recruiter-ancestry *\/` recursive
 *                       statement (one row { n, mine, topParentId }), emulated from its own SQL
 *                       behind the same exact drift guard and bind checks as the network statements;
 *                       it is refused unless it runs inside a transaction that holds this
 *                       recruiter's row lock (see ancestryStatement below).
 *   Phase 4 ({ phase4: true }, implies phase 3): READ-ONLY network reads — `affiliate.findMany`
 *                       (id IN + select), `recruiterAffiliateLink.count`, `affiliateOrder.groupBy`
 *                       (counts only: by ⊆ affiliateId/status/isFake, `_count._all`; no amount
 *                       aggregate, no findMany, no write), `identityVerification.findMany`
 *                       (select ⊆ affiliateId/status — a document field or a write throws), and the
 *                       `/* recruiter-network-tree *\/` recursive query, emulated row for row
 *                       (roots, linked children only, depth < bound). `_queryCount()` = number of
 *                       database calls so far (every model call and every raw query).
 *                       Phase 6 part 5b: the paged network statements `recruiter-network-path`,
 *                       `-page`, `-unplaced`, `-stats` and `-stats-orders`, each emulated from its
 *                       own SQL (never by calling service code) behind an exact drift guard and
 *                       bind checks — see networkStatement below.
 *   Phase 5 ({ phase5: true }, implies phase 4): rewards and withdrawals —
 *                       `recruiterSettingsVersion` (consecutive versions under a lock held until
 *                       commit, like the trigger + advisory lock; the CHECKs), `recruiterRewardLedger`
 *                       (append-only, CHECKs, unique idempotencyKey, ONE RECRUIT_REWARD per affiliate,
 *                       link guard), `affiliatePayout` (exactly-one-owner CHECK, recruiter amount CHECK,
 *                       FKs; every call recorded in `_payoutCalls`), `affiliateOrder.groupBy` with the
 *                       delivered filter + `findUnique`, `identityVerification.findUnique`, the second
 *                       recruiter row-lock statement (bank columns), `recruiter.findMany` where.
 *                       Phase 6 part 3a (migration 20261110): ledger `cycle` (NOT NULL, no default;
 *                       seeds default to 1 like the legacy rows), the cycle-key CHECK (legacy keys for
 *                       cycle 1 only), ONE RECRUIT_REWARD and ONE REVERSAL per (affiliate, cycle)
 *                       → P2002, the cycle guard (reward = next cycle after a closed one; reversal =
 *                       the open cycle, same recruiter, ≤ the reward) under the per-affiliate advisory
 *                       lock 'recruit:<id>' held until the transaction ends, `affiliateOrder.count`
 *                       (affiliateId + status + isFake only), `affiliateOrder.findMany` (where { orderId,
 *                       isFake: false }, select { affiliateId } only) and `recruiterSettingsVersion.findUnique`.
 *                       Phase 6 part 3c (migration 20261111): `recruiterIdentityVerification` — the
 *                       recruiter KYC row (unique recruiterId → P2002, FK, the state CHECK: status /
 *                       review columns / reason 1–500 / <uuid>.jpg keys, front ≠ back), the guard
 *                       (insert PENDING submission 1 only; PENDING → APPROVED | REJECTED and APPROVED →
 *                       REJECTED with the same submission and files; REJECTED → PENDING as submission + 1
 *                       with two new files; immutables; no delete). A row updated by an open transaction
 *                       is row-locked until it ends (a concurrent conditional update waits, then
 *                       re-evaluates the committed row) and other contexts read its committed version.
 *                       `seed.recruiterIdentity(data)` seeds one (bypasses the guard, e.g. APPROVED).
 *                       Phase 6 part 5d: the bounded reconcile — the `/* recruiter-reward-candidates *\/`
 *                       keyset statement (reversal / award candidates + one 'batch' row), emulated from
 *                       its own SQL behind an exact drift guard and per-placeholder bind checks (roles in
 *                       source order: `_rewardCandidatesRoles`), and the reconcile lease
 *                       `SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`
 *                       (→ [{ ok }]; never waits; held by the calling transaction until it ends — commit,
 *                       rollback or throw; a concurrent transaction gets ok = false). The lease transaction
 *                       may stay open while other transactions (the syncs) run: each $transaction started
 *                       outside a transaction context is its own connection here, as in PostgreSQL.
 *                       Phase 7 (migration 20261112, Reward B — the group reward): the 4 settings columns
 *                       (NOT NULL, DB defaults OFF / 0 / 10 / 10) + recruiter_settings_versions_group_check;
 *                       ledger types GROUP_REWARD / GROUP_REVERSAL, recruiter_reward_ledger_group_check
 *                       (sign, no affiliate, a settings version, exact keys group:<rid>:v<n> /
 *                       group-reverse:<rid>:v<n>), ONE of each per (recruiter, cycle) → P2002, the group
 *                       cycle guard (reward = max group cycle + 1; reversal = an unreversed reward of the
 *                       same recruiter, cycle and version, ≤ it) under the per-recruiter lock
 *                       'recruiter-group:<id>' held until the transaction ends; the
 *                       `/* recruiter-group-qualified *\/` statement (exact drift guard + bind checks:
 *                       `_groupQualifiedRoles`); `identityVerification.count` (where exactly
 *                       { affiliateId: { in: ≤ 5000 ids }, status: 'APPROVED' }); `recruiter.findMany`
 *                       `take` and the `gt` operator (keyset paging over recruiters.id).
 *                       Phase 7 Stage E (approved ownership rule; 20261112 replaces the link guard):
 *                       owner(X) = the recruiter of the NEAREST linked affiliate at or above X. The
 *                       ledger link guard accepts a row with an affiliate only for owner(affiliate) (a
 *                       REVERSAL also for the recruiter holding that affiliate's RECRUIT_REWARD); the
 *                       statements `recruiter-affiliate-owner` (upward UNION walk), `recruiter-affiliate-
 *                       list` (N(R) list, ILIKE search, keyset) and the updated `recruiter-ancestry`
 *                       (nearest link, cap), `recruiter-reward-candidates` (+ link segments),
 *                       `recruiter-group-qualified` / `recruiter-progress-qualified` (N(R) walk) and every
 *                       network statement (downward steps never enter a child linked to another
 *                       recruiter) are emulated from their SQL behind the same exact drift guards.
 *                       Phase 7 Stage F (approved clarification — the TOPMOST link wins): owner(X) = the
 *                       recruiter of the TOPMOST linked affiliate of X's chain (a parent cycle: the one
 *                       recruiter of every link met, none when several). The shared N(R) CTEs (F_ROOTS /
 *                       F_NET / F_CYC / F_CNET / F_MEM: roots = R's links without any linked ancestor on a
 *                       chain with a top, EVERY descendant, plus the members on a cycle owned by R) behind
 *                       every network / list / group / progress statement, `recruiter-affiliate-owner`
 *                       (two-phase walk), `recruiter-ancestry` (topmost link), the wallet scope's
 *                       `recruiter-reward-network-candidates` (roots keyset) and the admin
 *                       `recruiter-ownership-conflicts` — each behind an exact drift guard with
 *                       [role, text before, text after] bind checks. Phase 5: the ledger link guard uses
 *                       the topmost owner and the link owner guard (recruiter_link_owner_guard) refuses a
 *                       link to another recruiter inside an owned network. `_seed.link` bypasses every
 *                       trigger (legacy / conflicting data).
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
 *   Phase 6 part 4 (every mode): the admin permission row lock
 *                       `SELECT "canViewOrders", "canCreateAffiliates" FROM "recruiters" WHERE "id" = $1 FOR NO KEY UPDATE`
 *                       (same per-recruiter row lock as the creation / regeneration lock, held until the
 *                       transaction ends; the waiter re-reads the committed row). In Phase 2 mode `$queryRaw`
 *                       accepts ONLY this statement (any other raw statement still throws — isolation).
 *                       The recruiter permission columns are NOT NULL booleans (a non-boolean → CHECK error).
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
  // NOT NULL BOOLEAN columns (migration 20261105): a permission is always true or false.
  if (typeof r.canViewOrders !== 'boolean' || typeof r.canCreateAffiliates !== 'boolean') throw checkErr('recruiters_permission_not_null');
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
    // Phase 7: keyset paging (code-unit order, the same order sortRows uses)
    else if (op === 'gt') { if (v == null || arg == null || !(val(v) > val(arg))) return false; }
    // Phase 7 Stage B: the affiliate list's keyset (link createdAt < the cursor's)
    else if (op === 'lt') { if (v == null || arg == null || !(val(v) < val(arg))) return false; }
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
    affiliateActivationRecovery: [], recruiterIdentityVerification: [],
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
    async findMany({ where, orderBy, select, take } = {}) {
      await before('recruiter', 'findMany', { where });
      const list = sortRows(rows('recruiter').filter((r) => Object.entries(where || {}).every(([k, v]) => matchScalar(r[k], v))), orderBy);
      return (Number.isInteger(take) ? list.slice(0, take) : list).map((r) => pick(r, select));
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
    // Phase 7 Stage B: the affiliate list's keyset condition (OR of two where objects)
    if (k === 'OR') return Array.isArray(v) && v.some((w) => linkMatch(l, w));
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((w) => linkMatch(l, w));
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
      // Phase 7 Stage F (migration 20261112, phase 5): trigger recruiter_link_owner_guard (BEFORE INSERT, after
      // recruiter_affiliate_links_new_only by name) — the new affiliate's chain must not be owned by another recruiter.
      if (phase5 && a) {
        const owner = ownerOf(l.affiliateId);
        if (owner !== null && owner !== l.recruiterId) throw triggerErr(`affiliate ${l.affiliateId} is inside the network of another recruiter: it cannot be linked to recruiter ${l.recruiterId}`);
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
  // Phase 7 (group reward, phase 5 only): count of APPROVED identities among ≤ 5000 affiliate ids —
  // exactly where { affiliateId: { in: [...] }, status: 'APPROVED' }, nothing else (no document field).
  const identityCount = async ({ where, ...rest } = {}) => {
    await before('identityVerification', 'count', { where });
    if (Object.keys(rest).length) throw new Error(`fake identityVerification.count: unsupported args ${Object.keys(rest).join(',')}`);
    const wk = Object.keys(where || {}).sort();
    if (wk.join() !== 'affiliateId,status' || !Array.isArray(where.affiliateId?.in) || Object.keys(where.affiliateId).length !== 1 || where.status !== 'APPROVED') {
      throw new Error(`fake identityVerification.count: unsupported where ${JSON.stringify(where)}`);
    }
    if (where.affiliateId.in.length > 5000) throw new Error('fake identityVerification.count: more than 5000 ids in one statement (chunk them)');
    const wanted = new Set(where.affiliateId.in);
    return rows('identityVerification').filter((r) => wanted.has(r.affiliateId) && r.status === 'APPROVED').length;
  };

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
  const recruiterIdentityVerification = {}; // Phase 6 part 3c (filled in the phase-5 block)
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
        // Phase 7 (20261112): the four group columns are NOT NULL with these DB defaults.
        const r = { createdAt: new Date(), groupEnabled: false, groupRewardAmountCents: 0, groupSize: 10, groupMinDeliveredSales: 10, ...clone(data) };
        const expected = rows('recruiterSettingsVersion').reduce((m, x) => Math.max(m, x.version), 0) + 1;
        if (r.version !== expected) throw triggerErr(`recruiter settings version must be ${expected} (got ${r.version})`);
        if (T.recruiterSettingsVersion.some((x) => x.version === r.version)) throw p2002('version');
        if (!(r.version >= 1 && Number.isInteger(r.rewardAmountCents) && r.rewardAmountCents >= 0 && r.rewardAmountCents <= 100_000_000
          && Number.isInteger(r.minDeliveredSales) && r.minDeliveredSales >= 1 && r.minDeliveredSales <= 100_000
          && (!r.enabled || r.rewardAmountCents > 0) && typeof r.createdBy === 'string' && r.createdBy.length > 0 && typeof r.enabled === 'boolean')) {
          throw checkErr('recruiter_settings_versions_check');
        }
        if (!(typeof r.groupEnabled === 'boolean' && Number.isInteger(r.groupRewardAmountCents) && r.groupRewardAmountCents >= 0 && r.groupRewardAmountCents <= 100_000_000
          && (!r.groupEnabled || r.groupRewardAmountCents > 0) && Number.isInteger(r.groupSize) && r.groupSize >= 1 && r.groupSize <= 10_000
          && Number.isInteger(r.groupMinDeliveredSales) && r.groupMinDeliveredSales >= 1 && r.groupMinDeliveredSales <= 100_000)) {
          throw checkErr('recruiter_settings_versions_group_check');
        }
        T.recruiterSettingsVersion.push(r);
        markWritten(r);
        undoPush(() => { T.recruiterSettingsVersion.splice(T.recruiterSettingsVersion.indexOf(r), 1); });
        return clone(r);
      },
    });
    // Phase 6 part 3a: the threshold of the settings version a reward was earned with.
    recruiterSettingsVersion.findUnique = async ({ where, select } = {}) => {
      await before('recruiterSettingsVersion', 'findUnique', { where });
      const k = Object.keys(where || {});
      if (k.length !== 1 || k[0] !== 'version') throw new Error(`fake recruiterSettingsVersion.findUnique: unsupported where ${JSON.stringify(where)}`);
      return pick(rows('recruiterSettingsVersion').find((r) => r.version === where.version), select);
    };
    for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
      recruiterSettingsVersion[op] = async () => { throw triggerErr('recruiter_settings_versions is append-only'); };
    }

    // recruiter_reward_ledger: append-only, CHECKs, idempotency key, one recruit reward per
    // affiliate (partial unique index), link guard trigger, FKs.
    Object.assign(recruiterRewardLedger, {
      async create({ data }) {
        await before('recruiterRewardLedger', 'create', { data });
        const r = { id: randomUUID(), seq: BigInt(++seq), affiliateId: null, reason: null, actorId: null, settingsVersion: null, createdAt: new Date(), ...clone(data) };
        if (!['RECRUIT_REWARD', 'REVERSAL', 'ADMIN_ADJUSTMENT', 'GROUP_REWARD', 'GROUP_REVERSAL'].includes(r.type)) throw checkErr('recruiter_reward_ledger_type_check');
        if (!(['SYSTEM', 'ADMIN'].includes(r.actorType) && (r.actorType === 'SYSTEM' || r.actorId != null))) throw checkErr('recruiter_reward_ledger_actor_check');
        const a = r.amountCents;
        if (!(Number.isInteger(a) && a !== 0 && Math.abs(a) <= 100_000_000
          && (r.type !== 'RECRUIT_REWARD' || (a > 0 && r.affiliateId != null && r.settingsVersion != null))
          && (r.type !== 'REVERSAL' || (a < 0 && r.affiliateId != null))
          && (r.type !== 'ADMIN_ADJUSTMENT' || (r.actorType === 'ADMIN' && String(r.reason ?? '').trim().length > 0)))) throw checkErr('recruiter_reward_ledger_amount_check');
        // 20261110: "cycle" INTEGER NOT NULL (no default) + recruiter_reward_ledger_cycle_check.
        if (r.cycle === undefined || r.cycle === null) throw Object.assign(new Error('cycle NOT NULL'), { code: 'P2011', meta: { constraint: 'cycle' } });
        if (!(Number.isInteger(r.cycle) && r.cycle >= 1
          && (!['RECRUIT_REWARD', 'REVERSAL'].includes(r.type) || r.affiliateId != null)
          && (r.type !== 'RECRUIT_REWARD' || r.idempotencyKey === `recruit:${r.affiliateId}:v${r.cycle}` || (r.cycle === 1 && r.idempotencyKey === `recruit:${r.affiliateId}`))
          && (r.type !== 'REVERSAL' || r.idempotencyKey === `reverse:${r.affiliateId}:v${r.cycle}` || (r.cycle === 1 && r.idempotencyKey === `reverse:${r.affiliateId}`)))) {
          throw checkErr('recruiter_reward_ledger_cycle_check');
        }
        // 20261112: recruiter_reward_ledger_group_check (sign, no affiliate, a settings version, exact per-recruiter key).
        if (!((r.type !== 'GROUP_REWARD' || (a > 0 && r.affiliateId == null && r.settingsVersion != null && r.idempotencyKey === `group:${r.recruiterId}:v${r.cycle}`))
          && (r.type !== 'GROUP_REVERSAL' || (a < 0 && r.affiliateId == null && r.settingsVersion != null && r.idempotencyKey === `group-reverse:${r.recruiterId}:v${r.cycle}`)))) {
          throw checkErr('recruiter_reward_ledger_group_check');
        }
        // BEFORE INSERT triggers: the cycle guard (20261110 — under the per-affiliate advisory lock,
        // the SAME key as the application lock, held until the transaction ends) and the link guard.
        if (['RECRUIT_REWARD', 'REVERSAL'].includes(r.type)) {
          await lockRecruiterRow(`__advisory__:recruit:${r.affiliateId}`);
          const mine = rows('recruiterRewardLedger').filter((x) => x.affiliateId === r.affiliateId);
          const maxReward = mine.filter((x) => x.type === 'RECRUIT_REWARD').reduce((m, x) => Math.max(m, x.cycle), 0);
          if (r.type === 'RECRUIT_REWARD') {
            if (r.cycle !== maxReward + 1) throw triggerErr(`recruit reward of affiliate ${r.affiliateId} must be cycle ${maxReward + 1} (got ${r.cycle})`);
            if (maxReward > 0 && !mine.some((x) => x.type === 'REVERSAL' && x.cycle === maxReward)) throw triggerErr(`cycle ${maxReward} of affiliate ${r.affiliateId} is still open (not reversed)`);
          } else {
            const reward = mine.find((x) => x.type === 'RECRUIT_REWARD' && x.cycle === r.cycle);
            if (!reward || r.cycle !== maxReward || reward.recruiterId !== r.recruiterId || -r.amountCents > reward.amountCents) {
              throw triggerErr('a reversal needs the open reward of the same cycle and recruiter and cannot exceed it');
            }
          }
        }
        // 20261112: recruiter_group_cycle_guard (under the per-recruiter group lock 'recruiter-group:<id>',
        // the SAME key as the application lock, held until the transaction ends).
        if (['GROUP_REWARD', 'GROUP_REVERSAL'].includes(r.type)) {
          await lockRecruiterRow(`__advisory__:recruiter-group:${r.recruiterId}`);
          const mine = rows('recruiterRewardLedger').filter((x) => x.recruiterId === r.recruiterId);
          if (r.type === 'GROUP_REWARD') {
            const maxReward = mine.filter((x) => x.type === 'GROUP_REWARD').reduce((m, x) => Math.max(m, x.cycle), 0);
            if (r.cycle !== maxReward + 1) throw triggerErr(`group reward of recruiter ${r.recruiterId} must be cycle ${maxReward + 1} (got ${r.cycle})`);
          } else {
            const reward = mine.find((x) => x.type === 'GROUP_REWARD' && x.cycle === r.cycle);
            const reversed = mine.some((x) => x.type === 'GROUP_REVERSAL' && x.cycle === r.cycle);
            if (!reward || reversed || -r.amountCents > reward.amountCents || r.settingsVersion !== reward.settingsVersion) {
              throw triggerErr('a group reversal needs the unreversed group reward of the same recruiter, cycle and settings version and cannot exceed it');
            }
          }
        }
        // 20261112 (Phase 7 Stage E → F) recruiter_reward_link_guard: a row with an affiliate needs
        // owner(affiliate) = its recruiter (Stage F: the TOPMOST linked affiliate of its chain —
        // recruiter_affiliate_owner(), the same rule as recruiter-affiliate-owner); a REVERSAL is also accepted
        // when the same recruiter holds a RECRUIT_REWARD of that affiliate (the cycle guard above pins the exact
        // open cycle) — legacy rows stay reversible.
        if (r.affiliateId != null
          && !(r.type === 'REVERSAL' && rows('recruiterRewardLedger').some((x) => x.affiliateId === r.affiliateId && x.recruiterId === r.recruiterId && x.type === 'RECRUIT_REWARD'))
          && ownerOf(r.affiliateId) !== r.recruiterId) {
          throw triggerErr(`affiliate ${r.affiliateId} is not in the network of recruiter ${r.recruiterId} (owner = the recruiter of the topmost linked affiliate of its chain)`);
        }
        if (T.recruiterRewardLedger.some((x) => x.idempotencyKey === r.idempotencyKey)) throw p2002('idempotencyKey');
        // one RECRUIT_REWARD / one REVERSAL per (affiliate, cycle) — partial unique indexes (20261110)
        if (['RECRUIT_REWARD', 'REVERSAL'].includes(r.type) && T.recruiterRewardLedger.some((x) => x.type === r.type && x.affiliateId === r.affiliateId && x.cycle === r.cycle)) throw p2002('affiliateId,cycle');
        // one GROUP_REWARD / one GROUP_REVERSAL per (recruiter, cycle) — partial unique indexes (20261112)
        if (['GROUP_REWARD', 'GROUP_REVERSAL'].includes(r.type) && T.recruiterRewardLedger.some((x) => x.type === r.type && x.recruiterId === r.recruiterId && x.cycle === r.cycle)) throw p2002('recruiterId,cycle');
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

    // ── Phase 6 part 3c: recruiter_identity_verifications (recruiter KYC) ──────────
    const KYC_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
    const kycShadow = new WeakMap(); // row → { tx, prev } while an open transaction has updated it
    const kycRead = (row) => {
      const sh = kycShadow.get(row);
      return sh && openTx.has(sh.tx) && sh.tx !== ctx()?.id ? sh.prev : row;
    };
    const kycRows = () => rows('recruiterIdentityVerification').map(kycRead);
    const kycCheck = (r) => {
      const len = (v) => (typeof v === 'string' ? v.length : 0);
      const ok = Number.isInteger(r.submission) && r.submission >= 1
        && KYC_KEY_RE.test(String(r.cinFrontFile ?? '')) && KYC_KEY_RE.test(String(r.cinBackFile ?? '')) && r.cinFrontFile !== r.cinBackFile
        && ((r.status === 'PENDING' && r.rejectionReason == null && r.reviewedBy == null && r.reviewedAt == null && r.approvedAt == null)
          || (r.status === 'APPROVED' && r.rejectionReason == null && len(r.reviewedBy) >= 1 && len(r.reviewedBy) <= 200 && r.reviewedAt != null && r.approvedAt != null)
          || (r.status === 'REJECTED' && String(r.rejectionReason ?? '').trim().length >= 1 && String(r.rejectionReason ?? '').trim().length <= 500
            && len(r.reviewedBy) >= 1 && len(r.reviewedBy) <= 200 && r.reviewedAt != null && r.approvedAt == null));
      if (!ok) throw checkErr('recruiter_identity_verifications_state_check');
      for (const k of ['recruiterId', 'status', 'submission', 'cinFrontFile', 'cinBackFile', 'submittedAt']) {
        if (r[k] == null) throw Object.assign(new Error(`${k} NOT NULL`), { code: 'P2011' });
      }
    };
    const kycGuard = (old, next) => {
      if (next.id !== old.id || next.recruiterId !== old.recruiterId || val(next.createdAt) !== val(old.createdAt)) {
        throw triggerErr('recruiter identity id / recruiterId / createdAt are immutable');
      }
      if ((old.status === 'PENDING' && ['APPROVED', 'REJECTED'].includes(next.status)) || (old.status === 'APPROVED' && next.status === 'REJECTED')) {
        if (next.submission !== old.submission || next.cinFrontFile !== old.cinFrontFile || next.cinBackFile !== old.cinBackFile || val(next.submittedAt) !== val(old.submittedAt)) {
          throw triggerErr('a recruiter identity decision cannot change the submission or its files');
        }
        return;
      }
      if (old.status === 'REJECTED' && next.status === 'PENDING') {
        if (next.submission !== old.submission + 1 || [old.cinFrontFile, old.cinBackFile].includes(next.cinFrontFile) || [old.cinFrontFile, old.cinBackFile].includes(next.cinBackFile)) {
          throw triggerErr('a recruiter identity resubmission needs the next submission number and two new files');
        }
        return;
      }
      throw triggerErr(`recruiter identity transition ${old.status} → ${next.status} refused`);
    };
    const kycWhere = (where) => {
      const k = Object.keys(where || {});
      if (k.length !== 1 || !['id', 'recruiterId'].includes(k[0]) || typeof where[k[0]] !== 'string') throw new Error(`fake recruiterIdentityVerification.findUnique: unsupported where ${JSON.stringify(where)}`);
      return k[0];
    };
    const kycProject = (row, select) => {
      if (!row) return null;
      if (!select) return clone(row);
      const out = {};
      for (const [k, v] of Object.entries(select)) {
        if (!v) continue;
        if (k === 'recruiter') {
          const rec = T.recruiter.find((x) => x.id === row.recruiterId);
          out.recruiter = rec ? pick(rec, v.select) : null;
        } else out[k] = clone(row[k]);
      }
      return out;
    };
    Object.assign(recruiterIdentityVerification, {
      async findUnique({ where, select } = {}) {
        await before('recruiterIdentityVerification', 'findUnique', { where });
        const k = kycWhere(where);
        return kycProject(kycRows().find((r) => r[k] === where[k]), select);
      },
      async findMany({ where, orderBy, take, select } = {}) {
        await before('recruiterIdentityVerification', 'findMany', { where });
        return takeRows(sortRows(kycRows().filter((r) => genericMatch(r, where)), orderBy), take).map((r) => kycProject(r, select));
      },
      async create({ data }) {
        await before('recruiterIdentityVerification', 'create', { data });
        const now = new Date();
        const r = { id: randomUUID(), rejectionReason: null, reviewedBy: null, reviewedAt: null, approvedAt: null, createdAt: now, updatedAt: now, ...clone(data) };
        if (r.status !== 'PENDING' || r.submission !== 1) throw triggerErr('a recruiter identity starts as PENDING, submission 1');
        kycCheck(r);
        if (!T.recruiter.some((x) => x.id === r.recruiterId)) throw fkErr('recruiterId');
        if (T.recruiterIdentityVerification.some((x) => x.recruiterId === r.recruiterId)) throw p2002('recruiterId');
        T.recruiterIdentityVerification.push(r);
        markWritten(r);
        undoPush(() => { T.recruiterIdentityVerification.splice(T.recruiterIdentityVerification.indexOf(r), 1); });
        return clone(r);
      },
      async updateMany({ where = {}, data } = {}) {
        await before('recruiterIdentityVerification', 'updateMany', { where, data });
        const wk = Object.keys(where);
        if (!wk.includes('id') && !wk.includes('recruiterId')) throw new Error('fake recruiterIdentityVerification.updateMany: where needs id or recruiterId');
        // Row lock on the target (PostgreSQL: the UPDATE waits for a concurrent writer, then
        // re-evaluates the WHERE against the committed row).
        const target = rows('recruiterIdentityVerification').find((r) => (where.id ? r.id === where.id : r.recruiterId === where.recruiterId));
        if (target) await lockRecruiterRow(`__kyc__:${target.id}`);
        const targets = rows('recruiterIdentityVerification').filter((r) => genericMatch(kycRead(r), where));
        for (const row of targets) {
          const old = clone(row);
          const next = { ...row, ...clone(data), updatedAt: new Date() };
          kycGuard(old, next);
          kycCheck(next);
          Object.assign(row, next);
          const c = ctx();
          if (c && !kycShadow.has(row)) kycShadow.set(row, { tx: c.id, prev: old });
          else if (c && kycShadow.get(row).tx !== c.id) kycShadow.set(row, { tx: c.id, prev: old });
          undoPush(() => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, old); kycShadow.delete(row); });
        }
        return { count: targets.length };
      },
    });
    for (const op of ['update', 'upsert', 'delete', 'deleteMany', 'createMany']) {
      recruiterIdentityVerification[op] = async () => {
        if (op === 'delete' || op === 'deleteMany') throw triggerErr('recruiter_identity_verifications rows cannot be deleted');
        throw new Error(`fake db: recruiterIdentityVerification.${op} is not used by the recruiter KYC`);
      };
    }

    // Reads used by the reward hooks / service (status only — never a document field).
    affiliateOrder.findUnique = async ({ where, select } = {}) => {
      await before('affiliateOrder', 'findUnique', { where });
      const k = Object.keys(where || {});
      if (k.length !== 1 || k[0] !== 'id') throw new Error(`fake affiliateOrder.findUnique: unsupported where ${JSON.stringify(where)}`);
      if (!select || !Object.keys(select).every((x) => ['affiliateId', 'status', 'isFake', 'id'].includes(x))) throw new Error(`fake affiliateOrder.findUnique: select must be a subset of id/affiliateId/status/isFake (got ${JSON.stringify(select)})`);
      return pick(rows('affiliateOrder').find((o) => o.id === where.id), select);
    };
    identityVerification.count = identityCount; // Phase 7: the group reward's APPROVED count
    identityVerification.findUnique = async ({ where, select } = {}) => {
      await before('identityVerification', 'findUnique', { where });
      const k = Object.keys(where || {});
      if (k.length !== 1 || !['id', 'affiliateId'].includes(k[0])) throw new Error(`fake identityVerification.findUnique: unsupported where ${JSON.stringify(where)}`);
      if (!select || !Object.keys(select).every((x) => ['affiliateId', 'status'].includes(x))) throw new Error(`fake identityVerification.findUnique: select must be a subset of affiliateId/status (got ${JSON.stringify(select)}) — no document / file key`);
      return pick(rows('identityVerification').find((r) => r[k[0]] === where[k[0]]), select);
    };
    // Phase 6 part 3a: the real delivered count of ONE affiliate, read inside the reward lock —
    // exactly { affiliateId, status, isFake } (scalars); every other affiliateOrder op still throws.
    affiliateOrder.count = async (args = {}) => {
      await before('affiliateOrder', 'count', { where: args.where });
      const { where, ...rest } = args;
      if (Object.keys(rest).length) throw new Error(`fake affiliateOrder.count: only where is allowed (got ${Object.keys(rest).join(',')})`);
      const wk = Object.keys(where || {}).sort().join();
      if (wk !== 'affiliateId,isFake,status' || typeof where.affiliateId !== 'string' || typeof where.status !== 'string' || typeof where.isFake !== 'boolean') {
        throw new Error(`fake affiliateOrder.count: unsupported where ${JSON.stringify(where)}`);
      }
      return rows('affiliateOrder').filter((o) => o.affiliateId === where.affiliateId && o.status === where.status && o.isFake === where.isFake).length;
    };
    // Phase 6 part 3a: the fake-order sync hook lists the REAL rows linked to a store order —
    // exactly where { orderId, isFake: false } and select { affiliateId } (no other field / filter).
    affiliateOrder.findMany = async (args = {}) => {
      await before('affiliateOrder', 'findMany', { where: args.where });
      const { where, select, ...rest } = args;
      if (Object.keys(rest).length) throw new Error(`fake affiliateOrder.findMany: only where / select are allowed (got ${Object.keys(rest).join(',')})`);
      if (Object.keys(where || {}).sort().join() !== 'isFake,orderId' || typeof where.orderId !== 'string' || where.isFake !== false) throw new Error(`fake affiliateOrder.findMany: unsupported where ${JSON.stringify(where)}`);
      if (!select || Object.keys(select).join() !== 'affiliateId' || select.affiliateId !== true) throw new Error(`fake affiliateOrder.findMany: select must be exactly { affiliateId: true } (got ${JSON.stringify(select)})`);
      return rows('affiliateOrder').filter((o) => o.orderId === where.orderId && o.isFake === false).map((o) => pick(o, select));
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

  // ── Phase 6 part 5b → Phase 7 Stage F: the paged network statements of N(R) ──
  // Each tagged statement of recruiterNetworkService.js is emulated from its SQL, CTE by CTE
  // (every WITH RECURSIVE by working table; UNION ALL without de-duplication, capped by the
  // depth cap exactly like the SQL; UNION with de-duplication against every earlier row) — never
  // by calling service code:
  //   • drift guard: the normalized statement (whitespace collapsed, ${…} → $?) must be exactly
  //     its fragments, in order — any change → "the <tag> query changed … update the emulation";
  //   • binds: one value per placeholder; each placeholder must sit in the SQL context of the role
  //     the emulation reads it as (Stage F statements: [role, the text right before it, the text right
  //     after it]), so a re-ordered statement can never be misread; every recruiterId placeholder
  //     carries the same recruiter id, every scope placeholder (parentId / rootId) the same value;
  //     ::int binds are integers; ::text[] binds are arrays of text; LIMIT / OFFSET are never
  //     negative (PostgreSQL refuses them);
  //   • rows: the columns of the final SELECT, with the JS types Prisma returns for them
  //     (::int → number, boolean, text → string, NULL → null).
  // Phase 7 Stage F (TOPMOST link wins — recruiterNetworkService header) — the shared CTEs:
  //   cand  $r's link rows whose affiliate exists (unnest + a primary-key lookup) and whose parentId is
  //         not the affiliateId of ANY link row (NULL / '' / a dangling id never match);
  //   up    per cand (seed), from the affiliate whose id = its parentId upwards: { seed, id, parentId,
  //         linked (a link row exists), top (no affiliate row has id = its parentId) }; the next step only
  //         from a row that is NOT linked; UNION (each row once);
  //   rs    per seed: bool_or(linked), bool_or(top);  roots = cand rows without rs, or NOT linked AND top;
  //   net   the roots at depth 0, then EVERY child (a.parentId = id) while depth < $cap (UNION ALL);
  //   orph  $r's link rows (affiliateId) that are not in the placed walk (net, or t for the statistics);
  //   oup   per orph id (seed): its own affiliate row, then upwards — { seed, id, parentId, rid (its link's
  //         recruiterId or NULL), top }; UNION;  cseed = orph ids with no oup row that has top, or a rid that
  //         is another recruiter's (NULL <> $r is not true);
  //   cnet  cseed, then the children NOT linked to another recruiter (UNION);  mem = net ids + cnet ids.
  // No downward step of the placed walks filters on links any more (Stage E's NET_NOT_OTHER is gone).
  // the owner rule's chain row (recruiter-affiliate-owner and the creation's recruiter-ancestry): the affiliate, its link, top
  const OWNER_ROW_A = (on) => `SELECT a."id", a."parentId", l."recruiterId" AS rid, NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top FROM "affiliates" a LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id" WHERE a."id" = ${on}`;
  const F_UP_ROW = (on) => `SELECT a."id", a."parentId", EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked, NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top FROM "affiliates" a WHERE a."id" = ${on} OFFSET 0`;
  // F_ROOTS(true): the full columns (roots page, statistics); F_ROOTS(): id / parentId only (every other statement —
  // the reward service never reads an affiliate's isActive, the walks never need the names).
  const F_ROOTS_OF = (full) => [
    `WITH RECURSIVE cand AS ( SELECT sa."id", sa."parentId"${full ? ', sa."username", sa."name", sa."isActive", sa."createdAt"' : ''} FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = $?::text)) AS s("id")`,
    `CROSS JOIN LATERAL ( SELECT f."id", f."parentId"${full ? ', f."username", f."name", f."isActive", f."createdAt"' : ''} FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0 ) sa`,
    'WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId") ),',
    `up AS ( SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top FROM cand c CROSS JOIN LATERAL ( ${F_UP_ROW('c."parentId"')} ) p`,
    `UNION SELECT u.seed, p."id", p."parentId", p.linked, p.top FROM up u CROSS JOIN LATERAL ( ${F_UP_ROW('u."parentId"')} ) p WHERE NOT u.linked ),`,
    'rs AS ( SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top FROM up u GROUP BY u.seed ),',
    `roots AS ( SELECT c."id"${full ? ', c."username", c."name", c."isActive", c."createdAt"' : ''} FROM cand c LEFT JOIN rs ON rs.seed = c."id" WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top) ),`,
  ];
  const F_ROOTS = F_ROOTS_OF(false);
  const F_ROOTS_FULL = F_ROOTS_OF(true);
  const F_ROOTS_ROLES = [['rid', 'l."recruiterId" = ', '::text)) AS s("id")']];
  const F_NET = (gate) => [
    `net AS ( SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM roots r${gate ? ' WHERE $?::text IS NULL' : ''})) AS s("id")`,
    'UNION ALL SELECT ch."id", n.depth + 1 FROM net n CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch WHERE n.depth < $?::int ),',
  ];
  const F_NET_ROLES = (gate) => [...(gate ? [[gate, 'FROM roots r WHERE ', '::text IS NULL)) AS s("id")']] : []), ['cap', 'n.depth < ', '::int ),']];
  const F_OUP_ROW = (on) => `SELECT a."id", a."parentId", (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid, NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top FROM "affiliates" a WHERE a."id" = ${on} OFFSET 0`;
  const F_CYC = ({ gate = null, placed = 'net n WHERE n."id"', last = false } = {}) => [
    `orph AS ( SELECT s."id" FROM unnest(ARRAY( SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE ${gate ? '$?::text IS NULL AND ' : ''}l."recruiterId" = $?::text AND NOT EXISTS (SELECT 1 FROM ${placed} = l."affiliateId") )) AS s("id") ),`,
    `oup AS ( SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top FROM orph op CROSS JOIN LATERAL ( ${F_OUP_ROW('op."id"')} ) p`,
    `UNION SELECT u.seed, p."id", p."parentId", p.rid, p.top FROM oup u CROSS JOIN LATERAL ( ${F_OUP_ROW('u."parentId"')} ) p ),`,
    `cseed AS ( SELECT op."id" FROM orph op WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> $?::text)) )${last ? '' : ','}`,
  ];
  const F_CYC_ROLES = (gate = null) => [
    ...(gate ? [[gate, 'WHERE ', '::text IS NULL AND l."recruiterId" = ']] : []),
    ['rid', 'l."recruiterId" = ', '::text AND NOT EXISTS'], ['rid', 'u.rid <> ', '::text)) )'],
  ];
  const F_CNET = 'cnet AS ( SELECT s."id" FROM cseed s UNION SELECT ch."id" FROM cnet c CROSS JOIN LATERAL ( SELECT a."id" FROM "affiliates" a WHERE a."parentId" = c."id" AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" ox WHERE ox."affiliateId" = a."id" AND ox."recruiterId" <> $?::text) OFFSET 0 ) ch ),';
  const F_CNET_ROLES = [['rid', 'ox."recruiterId" <> ', '::text) OFFSET 0']];
  const F_MEM = 'mem AS ( SELECT n."id" FROM net n UNION ALL SELECT c."id" FROM unnest(ARRAY(SELECT cx."id" FROM cnet cx)) AS c("id") )';
  /** The whole N(R) block (roots → mem) and its binds: rid, cap, rid, rid, rid. */
  const F_ALL = [...F_ROOTS, ...F_NET(), ...F_CYC(), F_CNET, F_MEM];
  const F_ALL_ROLES = [...F_ROOTS_ROLES, ...F_NET_ROLES(), ...F_CYC_ROLES(), ...F_CNET_ROLES];
  const F_PAGE_COUNTS = [
    't AS ( SELECT p."id" AS seed, p."id", 0 AS depth FROM page p UNION ALL SELECT t.seed, ch."id", t.depth + 1 FROM t CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = t."id" OFFSET 0) ch WHERE t.depth < $?::int ),',
    'counts AS ( SELECT t.seed, (count(*) FILTER (WHERE t.depth = 1))::int AS children, (count(*) - 1)::int AS descendants FROM t GROUP BY t.seed )',
  ];
  const F_PAGE_END = 'FROM (SELECT 1) one LEFT JOIN page p ON true LEFT JOIN counts n ON n.seed = p."id" ORDER BY p."createdAt", p."id" COLLATE "C"';
  const F_LIMIT_ROLES = [['size', 'LIMIT ', '::int OFFSET '], ['start', 'OFFSET ', '::int )']];
  const F_TCAP = ['cap', 't.depth < ', '::int ),'];
  const F_STATS = [
    ...F_ROOTS_FULL,
    'seed AS ( SELECT r."id", r."isActive" FROM roots r WHERE $?::text IS NULL UNION ALL SELECT a."id", a."isActive" FROM "affiliates" a WHERE a."parentId" = $?::text ),',
    't AS ( SELECT s."id", s."isActive", $?::int + 1 AS depth FROM seed s UNION ALL SELECT ch."id", ch."isActive", t.depth + 1 FROM t CROSS JOIN LATERAL (SELECT a."id", a."isActive" FROM "affiliates" a WHERE a."parentId" = t."id" OFFSET 0) ch WHERE t.depth < $?::int ),',
    ...F_CYC({ gate: 'scope', placed: 't WHERE t."id"', last: true }),
    'SELECT \'u\'::text AS kind, NULL::int AS depth, NULL::boolean AS flag, NULL::text AS status, count(*)::int AS n FROM cseed UNION ALL',
    'SELECT \'m\'::text AS kind, t.depth::int AS depth, t."isActive" AS flag, iv."status" AS status, count(*)::int AS n FROM t LEFT JOIN "identity_verifications" iv ON iv."affiliateId" = t."id" GROUP BY t.depth, t."isActive", iv."status"',
  ];
  const F_STATS_ROLES = [
    ...F_ROOTS_ROLES,
    ['scope', 'FROM roots r WHERE ', '::text IS NULL UNION ALL'], ['scope', 'a."parentId" = ', '::text ), t AS'],
    ['base', 'SELECT s."id", s."isActive", ', '::int + 1 AS depth'], F_TCAP,
    ...F_CYC_ROLES('scope'),
  ];
  const F_ANC_ROW = (alias) => `(SELECT x."recruiterId" = $? FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = ${alias}."id") AS mine`;
  const NET_SQL = {
    'recruiter-network-ancestry': {
      roles: [['ids', 'SELECT unnest(', '::text[]))) AS s("id")'], ['rid', 'SELECT x."recruiterId" = ', ' FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = f."id"'],
        ['rid', 'SELECT x."recruiterId" = ', ' FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id"']],
      fragments: [
        'WITH RECURSIVE up AS ( SELECT sa."id", sa."parentId", sa."username", sa."name", sa.mine FROM unnest(ARRAY(SELECT unnest($?::text[]))) AS s("id")',
        `CROSS JOIN LATERAL ( SELECT f."id", f."parentId", f."username", f."name", ${F_ANC_ROW('f')} FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0 ) sa`,
        'UNION SELECT p."id", p."parentId", p."username", p."name", p.mine FROM up u CROSS JOIN LATERAL (',
        `SELECT a."id", a."parentId", a."username", a."name", ${F_ANC_ROW('a')} FROM "affiliates" a WHERE a."id" = u."parentId" OFFSET 0 ) p )`,
        'SELECT u."id", u."parentId", u."username", u."name", u.mine FROM up u',
      ],
      run: networkAncestry,
    },
    'recruiter-network-roots': {
      roles: [...F_ROOTS_ROLES, ...F_LIMIT_ROLES, F_TCAP],
      fragments: [
        ...F_ROOTS_FULL,
        'page AS ( SELECT r."id", r."username", r."name", r."isActive", r."createdAt" FROM roots r ORDER BY r."createdAt", r."id" COLLATE "C" LIMIT $?::int OFFSET $?::int ),',
        ...F_PAGE_COUNTS,
        'SELECT (SELECT count(*)::int FROM roots) AS total, p."id", p."username", p."name", p."isActive", n.children, n.descendants',
        F_PAGE_END,
      ],
      run: networkRootsPage,
    },
    'recruiter-network-children': {
      roles: [['scope', 'WHERE a."parentId" = ', '::text ), page AS'], ...F_LIMIT_ROLES, F_TCAP, ['rid', 'x."recruiterId" = ', '::text) AS mine']],
      fragments: [
        'WITH RECURSIVE cand AS ( SELECT a."id", a."username", a."name", a."isActive", a."createdAt" FROM "affiliates" a WHERE a."parentId" = $?::text ),',
        'page AS ( SELECT c."id", c."username", c."name", c."isActive", c."createdAt" FROM cand c ORDER BY c."createdAt", c."id" COLLATE "C" LIMIT $?::int OFFSET $?::int ),',
        ...F_PAGE_COUNTS,
        'SELECT (SELECT count(*)::int FROM cand) AS total, p."id", p."username", p."name", p."isActive", EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = p."id" AND x."recruiterId" = $?::text) AS mine, n.children, n.descendants',
        F_PAGE_END,
      ],
      run: networkChildrenPage,
    },
    // Simplified dashboard (affiliate details view): ONE placed node's own card — the page / t / counts walk of
    // the children page seeded with that node only (cap like the SQL); no row when the id does not exist.
    'recruiter-network-node': {
      roles: [['id', 'WHERE a."id" = ', '::text ), t AS'], F_TCAP, ['rid', 'x."recruiterId" = ', '::text) AS mine']],
      fragments: [
        'WITH RECURSIVE page AS ( SELECT a."id", a."username", a."name", a."isActive", a."createdAt" FROM "affiliates" a WHERE a."id" = $?::text ),',
        ...F_PAGE_COUNTS,
        'SELECT p."id", p."username", p."name", p."isActive", EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = p."id" AND x."recruiterId" = $?::text) AS mine, n.children, n.descendants',
        'FROM page p LEFT JOIN counts n ON n.seed = p."id"',
      ],
      run: networkNodeCard,
    },
    'recruiter-network-unplaced': {
      roles: [...F_ROOTS_ROLES, ...F_NET_ROLES(), ...F_CYC_ROLES(), ...F_LIMIT_ROLES],
      fragments: [
        ...F_ROOTS, ...F_NET(), ...F_CYC(),
        'un AS ( SELECT l."affiliateId" AS "id", l."createdAt" AS "linkedAt" FROM "recruiter_affiliate_links" l JOIN cseed s ON s."id" = l."affiliateId" ),',
        'page AS ( SELECT u."id", u."linkedAt" FROM un u ORDER BY u."linkedAt", u."id" LIMIT $?::int OFFSET $?::int )',
        'SELECT (SELECT count(*)::int FROM un) AS total, p."id", a."username", a."name"',
        'FROM (SELECT 1) one LEFT JOIN page p ON true LEFT JOIN "affiliates" a ON a."id" = p."id" ORDER BY p."linkedAt", p."id"',
      ],
      run: networkUnplaced,
    },
    'recruiter-network-stats': {
      roles: F_STATS_ROLES,
      fragments: F_STATS,
      run: (b) => networkStats(b, false),
    },
    'recruiter-network-stats-orders': {
      roles: F_STATS_ROLES,
      fragments: [...F_STATS, 'UNION ALL SELECT \'o\'::text, t.depth::int, o."isFake", o."status", count(*)::int FROM t JOIN "affiliate_orders" o ON o."affiliateId" = t."id" GROUP BY t.depth, o."isFake", o."status"'],
      run: (b) => networkStats(b, true),
    },
    'recruiter-network-downline': {
      roles: [...F_ALL_ROLES, ['rid', 'x."recruiterId" = ', '::text) AS linked']],
      fragments: [...F_ALL, 'SELECT (SELECT count(*)::int FROM mem) AS n,', '(SELECT count(*)::int FROM mem m JOIN "recruiter_affiliate_links" x ON x."affiliateId" = m."id" AND x."recruiterId" = $?::text) AS linked'],
      run: networkDownline,
    },
  };
  // The SQL context each bind role must sit in: pre = statement text before the placeholder,
  // post = text after it (up to the next placeholder).
  const NET_ROLE = {
    rid: (pre) => /"recruiterId" (=|<>) $/.test(pre),
    scope: (pre, post) => /(WHERE |a\."parentId" = )$/.test(pre) && post.startsWith('::text'),
    id: (pre) => /WHERE a\."id" = $/.test(pre),
    ids: (pre, post) => /WHERE a\."id" = ANY \($/.test(pre) && post.startsWith('::text[])'),
    bound: (pre, post) => /\b(t\.depth|u\.k) < $/.test(pre) && post.startsWith('::int'),
    cap: (pre, post) => /\bu\.k < $/.test(pre) && post.startsWith('::int'),
    depthCap: (pre, post) => /\bt\.depth < $/.test(pre) && post.startsWith('::int'),
    base: (pre, post) => /SELECT s\."id", s\."isActive", s\.mine, $/.test(pre) && post.startsWith('::int + 1 AS depth'),
    walk: (pre, post) => /( AND |\()$/.test(pre) && post.startsWith('::boolean'),
    size: (pre, post) => /LIMIT $/.test(pre) && post === '::int OFFSET ',
    start: (pre, post) => /OFFSET $/.test(pre) && post.startsWith('::int'),
  };
  const pgErr = (sqlstate, msg) => Object.assign(new Error(msg), { code: 'P2010', meta: { code: sqlstate, message: msg } });
  function networkStatement(tag, norm, values, spec = NET_SQL[tag]) {
    const { roles, fragments, run } = spec;
    const expected = [`/* ${tag} */`, ...fragments];
    if (norm !== expected.join(' ')) {
      let at = 0;
      const missing = [];
      for (const f of expected) { const i = norm.indexOf(f, at); if (i < 0) missing.push(f); else at = i + f.length; }
      throw new Error(`fake $queryRaw: the ${tag} query changed (missing: ${missing.length ? missing.join(' | ') : 'none, but other text was added'}) — update the emulation`);
    }
    const seg = norm.split('$?');
    if (values.length !== roles.length || seg.length - 1 !== roles.length) throw new Error(`fake $queryRaw: the ${tag} query must bind exactly ${roles.length} values (got ${values.length})`);
    const bind = {};
    roles.forEach((spec, i) => {
      // Phase 7 Stage F: a role is either a NET_ROLE name or [role, the text right before, the text right after]
      const role = Array.isArray(spec) ? spec[0] : spec;
      const fits = Array.isArray(spec) ? seg[i].endsWith(spec[1]) && seg[i + 1].startsWith(spec[2]) : NET_ROLE[role](seg[i], seg[i + 1]);
      if (!fits) throw new Error(`fake $queryRaw: placeholder ${i + 1} of the ${tag} query is not its ${role} — update the emulation`);
      if (role in bind && bind[role] !== values[i]) throw new Error(`fake $queryRaw: every ${role === 'rid' ? 'recruiterId' : role} placeholder of the ${tag} query must carry the same value`);
      bind[role] = values[i];
    });
    if ('rid' in bind && typeof bind.rid !== 'string') throw new Error(`fake $queryRaw: the ${tag} query must bind the recruiter id as text`);
    for (const k of ['scope', 'id']) if (k in bind && bind[k] !== null && typeof bind[k] !== 'string') throw new Error(`fake $queryRaw: the ${tag} query binds a non-text ${k}`);
    if ('walk' in bind && typeof bind.walk !== 'boolean') throw new Error(`fake $queryRaw: the ${tag} query binds a non-boolean walk (::boolean)`);
    if ('ids' in bind && !(Array.isArray(bind.ids) && bind.ids.every((x) => typeof x === 'string'))) throw new Error(`fake $queryRaw: the ${tag} query binds a non-text[] ids`);
    for (const k of ['bound', 'size', 'start', 'cap', 'depthCap', 'base']) if (k in bind && !(Number.isInteger(bind[k]) && Math.abs(bind[k]) <= 2147483647)) throw new Error(`fake $queryRaw: the ${tag} query binds a non-integer ${k} (::int)`);
    if (bind.size < 0) throw pgErr('2201W', 'LIMIT must not be negative');
    if (bind.start < 0) throw pgErr('2201X', 'OFFSET must not be negative');
    return run(bind);
  }

  // ── Phase 6 part 5c → Phase 7 Stage F: the creation's ancestry statement ─────
  // `/* recruiter-ancestry */` (recruiterAffiliateService.parentInNetwork), emulated from its SQL —
  // never by calling service code — behind the networkStatement drift guard / bind checks:
  //   binds [parentId, cap, parentId, rid, rid]: the parent id (text, twice — the same value), cap =
  //   ANCESTRY_MAX + 1 = 10001 (::int) and the creating recruiter's id (text, twice).
  //   chain:  the affiliate whose id = parentId (LEFT JOIN its link row: rid = its recruiterId or NULL;
  //           top = no affiliate row has id = its parentId), then the affiliate whose id = each row's
  //           parentId (NULL / '' never match) — UNION (each row once: a cycle ends after one lap);
  //   capped: the first $cap chain rows (the walk order: parent first, then upwards);
  //   info:   n = count(capped), nr = count(DISTINCT rid), rid = min(rid), top = bool_or(top);
  //   up:     the affiliate whose id = parentId (k = 1), then its parent (k + 1) while k < n — UNION ALL;
  //   result: ONE row { n, mine: nr = 1 → (rid = $rid); nr > 1 AND top → (the rid of the highest-k up row
  //           with a rid) = $rid; else NULL }.
  // It must run on the transaction that holds THIS recruiter's row lock (the creation's FOR NO KEY
  // UPDATE): outside a transaction, or without that lock, the fake refuses it.
  const ANCESTRY_MAX = 10000;
  const ANCESTRY_SQL = {
    roles: [['id', 'WHERE a."id" = ', '::text UNION SELECT'], ['cap', 'LIMIT ', '::int ), info AS'], ['id', 'WHERE a."id" = ', '::text UNION ALL SELECT'],
      ['rid', 'THEN i.rid = ', '::text WHEN'], ['rid', 'SELECT u.rid = ', '::text FROM up u']],
    fragments: [
      `WITH RECURSIVE chain AS ( ${OWNER_ROW_A('$?::text')}`,
      `UNION SELECT p."id", p."parentId", p.rid, p.top FROM chain c CROSS JOIN LATERAL ( ${OWNER_ROW_A('c."parentId"')} OFFSET 0 ) p ),`,
      'capped AS ( SELECT c."id", c.rid, c.top FROM chain c LIMIT $?::int ),',
      'info AS ( SELECT count(*)::int AS n, count(DISTINCT c.rid)::int AS nr, min(c.rid) AS rid, bool_or(c.top) AS top FROM capped c ),',
      'up AS ( SELECT a."id", a."parentId", l."recruiterId" AS rid, 1 AS k FROM "affiliates" a LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id" WHERE a."id" = $?::text',
      'UNION ALL SELECT p."id", p."parentId", p.rid, u.k + 1 FROM up u CROSS JOIN LATERAL ( SELECT a."id", a."parentId", l."recruiterId" AS rid FROM "affiliates" a LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id" WHERE a."id" = u."parentId" OFFSET 0 ) p',
      'WHERE u.k < (SELECT i.n FROM info i) )',
      'SELECT i.n, CASE WHEN i.nr = 1 THEN i.rid = $?::text WHEN i.nr > 1 AND i.top THEN (SELECT u.rid = $?::text FROM up u WHERE u.rid IS NOT NULL ORDER BY u.k DESC LIMIT 1) END AS mine FROM info i',
    ],
    run: recruiterAncestry,
  };
  function ancestryStatement(norm, values) {
    const c = ctx();
    if (!c) throw new Error('fake $queryRaw: the recruiter-ancestry query must run inside the creation transaction');
    // Checked after the drift guard / binds (inside run), so a drifted statement reports the drift.
    return networkStatement('recruiter-ancestry', norm, values, ANCESTRY_SQL);
  }
  function recruiterAncestry({ id, cap, rid }) {
    if (typeof id !== 'string') throw new Error('fake $queryRaw: the recruiter-ancestry query must bind the parent id as text');
    if (cap !== ANCESTRY_MAX + 1) throw new Error(`fake $queryRaw: the recruiter-ancestry cap must be ANCESTRY_MAX + 1 = ${ANCESTRY_MAX + 1} (got ${cap})`);
    if (typeof rid !== 'string') throw new Error('fake $queryRaw: the recruiter-ancestry query must bind the recruiter id as text');
    const c = ctx();
    const l = locks.get(rid);
    if (!l || l.tx !== c.id) throw new Error('fake $queryRaw: the recruiter-ancestry query must run while this transaction holds the recruiter row lock (FOR NO KEY UPDATE first)');
    const M = fModel();
    const row = (a) => ({ id: a.id, parentId: a.parentId ?? null, rid: M.linkOf.get(a.id) ?? null, top: M.topOf(a) });
    const start = M.get(id);
    const capped = recurseDistinct(start ? [row(start)] : [], (u) => { const p = M.get(u.parentId); return p ? [row(p)] : []; }).slice(0, cap);
    const n = capped.length;
    const rids = [...new Set(capped.map((u) => u.rid).filter((r) => r !== null))];
    let mine = null;
    if (rids.length === 1) mine = rids[0] === rid;
    else if (rids.length > 1 && capped.some((u) => u.top)) {
      const up = recurse(start ? [{ ...row(start), k: 1 }] : [], (u) => { if (!(u.k < n)) return []; const p = M.get(u.parentId); return p ? [{ ...row(p), k: u.k + 1 }] : []; });
      let best = null;
      for (const u of up) if (u.rid !== null && (!best || u.k > best.k)) best = u;
      mine = best ? best.rid === rid : null;
    }
    return [{ n, mine }];
  }


  // ── Phase 7 Stage F: the tables as these statements read them (committed rows + this transaction's own) ──
  function fModel() {
    const affs = rows('affiliate');
    const byId = new Map(affs.map((a) => [a.id, a]));
    const links = rows('recruiterAffiliateLink');
    const linkOf = new Map(links.map((l) => [l.affiliateId, l.recruiterId])); // links primary key: at most one each
    const byParent = new Map();
    for (const a of affs) {
      if (a.parentId == null) continue;
      if (!byParent.has(a.parentId)) byParent.set(a.parentId, []);
      byParent.get(a.parentId).push(a);
    }
    return {
      affs, byId, links, linkOf,
      // FROM affiliates a WHERE a.parentId = $x  (= NULL never matches) — every child, linked or not
      children: (x) => (x == null ? [] : byParent.get(x) || []),
      // NOT EXISTS (SELECT 1 FROM affiliates g WHERE g.id = a.parentId): no parent row (NULL, '' or dangling)
      topOf: (a) => a.parentId == null || !byId.has(a.parentId),
      // the affiliate whose id = x (= NULL never matches)
      get: (x) => (x == null ? undefined : byId.get(x)),
    };
  }
  // WITH RECURSIVE: the anchor rows, then each iteration computed from the previous one only.
  function recurse(anchor, step) {
    const out = [];
    for (let work = anchor, n = 0; work.length; work = work.flatMap(step)) {
      for (const r of work) out.push(r);
      if (++n > 1_000_000 || out.length > 2_000_000) throw new Error('fake $queryRaw: runaway recursion');
    }
    return out;
  }
  // UNION recursion: rows de-duplicated (whole row) against every earlier row.
  function recurseDistinct(anchor, step) {
    const seen = new Set();
    const out = [];
    const keep = (list) => list.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); out.push(r); return true; });
    for (let work = keep(anchor), n = 0; work.length; work = keep(work.flatMap(step))) {
      if (++n > 1_000_000) throw new Error('fake $queryRaw: runaway recursion');
    }
    return out;
  }
  const msOf = (d) => (d == null ? Infinity : new Date(d).getTime()); // ORDER BY … ASC: NULLs last
  // COLLATE "C" = byte order = the code-unit order of these ASCII ids (uuid / [A-Za-z0-9_-]).
  const cmpText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const byCreatedThenId = (x, y) => (msOf(x.createdAt) - msOf(y.createdAt)) || cmpText(x.id, y.id);
  // ORDER BY c."linkedAt", c."id" (the column's own collation): code-unit order, like the former
  // findMany orderBy [{ createdAt }, { affiliateId }] of this fake.
  const byLinkedThenId = (x, y) => (msOf(x.linkedAt) - msOf(y.linkedAt)) || cmpText(x.id, y.id);

  // cand / up / rs / roots (F_ROOTS) for the candidate affiliates `cand` (Stage F: $r's linked affiliates —
  // or, for the conflicts statement, every linked affiliate — whose parentId is not a linked affiliate).
  function fRootsAmong(M, cand) {
    const upRow = (seed, a) => ({ seed, id: a.id, parentId: a.parentId ?? null, linked: M.linkOf.has(a.id), top: M.topOf(a) });
    const up = recurseDistinct(cand.flatMap((c) => { const p = M.get(c.parentId); return p ? [upRow(c.id, p)] : []; }),
      (u) => { if (u.linked) return []; const p = M.get(u.parentId); return p ? [upRow(u.seed, p)] : []; });
    const rs = new Map();
    for (const u of up) { const r = rs.get(u.seed) ?? { linked: false, top: false }; r.linked = r.linked || u.linked; r.top = r.top || u.top; rs.set(u.seed, r); }
    return cand.filter((c) => { const r = rs.get(c.id); return !r || (!r.linked && r.top); });
  }
  /** roots of N($r) — cand = $r's link rows whose affiliate exists and whose parentId is not any link row's affiliateId. */
  function fRoots(M, rid) {
    const cand = M.links.filter((l) => l.recruiterId === rid).map((l) => M.byId.get(l.affiliateId)).filter(Boolean)
      .filter((a) => !(a.parentId != null && M.linkOf.has(a.parentId)));
    return fRootsAmong(M, cand);
  }
  // net: the roots at depth 0, then every child while depth < cap (UNION ALL) → [{ id, depth }]
  function fNet(M, roots, cap) {
    return recurse(roots.map((a) => ({ id: a.id, depth: 0 })), (n) => (n.depth < cap ? M.children(n.id).map((a) => ({ id: a.id, depth: n.depth + 1 })) : []));
  }
  // the full upward walk (UNION) of each seed id from its own row: [{ seed, id, parentId, rid, top }]
  function fUpFull(M, seeds) {
    const row = (seed, a) => ({ seed, id: a.id, parentId: a.parentId ?? null, rid: M.linkOf.get(a.id) ?? null, top: M.topOf(a) });
    return recurseDistinct(seeds.flatMap((id) => { const a = M.get(id); return a ? [row(id, a)] : []; }),
      (u) => { const p = M.get(u.parentId); return p ? [row(u.seed, p)] : []; });
  }
  // orph / oup / cseed / cnet of $r, given the placed id set (F_CYC + F_CNET)
  function fCyclic(M, rid, placed) {
    const orph = M.links.filter((l) => l.recruiterId === rid && !placed.has(l.affiliateId)).map((l) => l.affiliateId);
    const oup = fUpFull(M, orph);
    const bad = new Set(oup.filter((u) => u.top || (u.rid !== null && u.rid !== rid)).map((u) => u.seed));
    const cseed = orph.filter((id) => !bad.has(id));
    const other = (id) => M.linkOf.has(id) && M.linkOf.get(id) !== rid;
    const cnet = recurseDistinct(cseed.map((id) => ({ id })), (c) => M.children(c.id).filter((a) => !other(a.id)).map((a) => ({ id: a.id })));
    return { orph, cseed, cnet: cnet.map((c) => c.id) };
  }
  /** mem (F_ALL): the ids of N($r) — the placed walk from the roots, then the members on a parent cycle owned by $r. */
  function fMembers(rid, cap) {
    const M = fModel();
    const net = fNet(M, fRoots(M, rid), cap);
    const { cnet } = fCyclic(M, rid, new Set(net.map((n) => n.id)));
    return { M, ids: [...net.map((n) => n.id), ...cnet] };
  }

  // up: the affiliates whose id is in $ids (unnest + a primary-key lookup), then the parent of every row
  // (a."id" = u."parentId": NULL never matches) — Stage F: to the top, no stop at another recruiter's link;
  // UNION, so a cycle ends after one lap. Columns id, parentId, username, name, mine = (link.recruiterId = $r)
  // of its link row — true / false / NULL (no link). No ORDER BY: any order.
  function networkAncestry({ rid, ids }) {
    const M = fModel();
    const row = (a) => ({ id: a.id, parentId: a.parentId ?? null, username: a.username ?? null, name: a.name ?? null, mine: M.linkOf.has(a.id) ? M.linkOf.get(a.id) === rid : null });
    const anchor = ids.map((id) => M.byId.get(id)).filter(Boolean).map(row);
    return recurseDistinct(anchor, (u) => { const p = M.get(u.parentId); return p ? [row(p)] : []; });
  }

  // page (ORDER BY createdAt, id COLLATE "C", LIMIT / OFFSET); t: a walk seeded with the page only (depth
  // 0, then EVERY child while depth < cap); per seed children = rows at depth 1, descendants = rows - 1.
  // One row per page node with the total repeated — or, for an empty page, ONE row of NULLs that still
  // carries the total ((SELECT 1) one LEFT JOIN page).
  function pageWithCounts(M, all, start, size, cap, extra) {
    const page = [...all].sort(byCreatedThenId).slice(start, start + size);
    const counts = new Map(page.map((p) => [p.id, { rows: 0, children: 0 }]));
    const t = recurse(page.map((p) => ({ seed: p.id, id: p.id, depth: 0 })),
      (r) => (r.depth < cap ? M.children(r.id).map((a) => ({ seed: r.seed, id: a.id, depth: r.depth + 1 })) : []));
    for (const r of t) { const c = counts.get(r.seed); c.rows += 1; if (r.depth === 1) c.children += 1; }
    const total = all.length;
    if (!page.length) return [{ total, id: null, username: null, name: null, isActive: null, ...extra(null), children: null, descendants: null }];
    return page.map((p) => ({
      total, id: p.id, username: p.username ?? null, name: p.name ?? null, isActive: p.isActive ?? null, ...extra(p),
      children: counts.get(p.id).children, descendants: counts.get(p.id).rows - 1,
    }));
  }
  function networkRootsPage({ rid, size, start, cap }) {
    const M = fModel();
    return pageWithCounts(M, fRoots(M, rid), start, size, cap, () => ({}));
  }
  // cand: EVERY child of the scope (a."parentId" = $scope; NULL never matches); mine per page row (a link
  // row to $r — false on the empty-page row).
  function networkChildrenPage({ scope, rid, size, start, cap }) {
    const M = fModel();
    return pageWithCounts(M, M.children(scope), start, size, cap, (p) => ({ mine: !!p && M.linkOf.get(p.id) === rid }));
  }

  // page: the affiliate whose id = $id (none → no row at all: no "(SELECT 1) one" here); t / counts as in the
  // paged statements; mine = a link row to $r.
  function networkNodeCard({ id, rid, cap }) {
    const M = fModel();
    const a = M.byId.get(id);
    if (!a) return [];
    return pageWithCounts(M, [a], 0, 1, cap, (p) => ({ mine: !!p && M.linkOf.get(p.id) === rid })).map(({ total: _total, ...r }) => r);
  }

  // un: the link rows JOIN cseed (by affiliateId), as (affiliateId, link createdAt); page: ORDER BY
  // linkedAt, id, LIMIT / OFFSET; username / name joined from affiliates. Empty page → ONE row of NULLs
  // carrying the total.
  function networkUnplaced({ rid, cap, size, start }) {
    const M = fModel();
    const net = fNet(M, fRoots(M, rid), cap);
    const cs = new Set(fCyclic(M, rid, new Set(net.map((n) => n.id))).cseed);
    const un = M.links.filter((l) => cs.has(l.affiliateId)).map((l) => ({ id: l.affiliateId, linkedAt: l.createdAt }));
    const page = [...un].sort(byLinkedThenId).slice(start, start + size);
    const total = un.length;
    if (!page.length) return [{ total, id: null, username: null, name: null }];
    return page.map((p) => { const a = M.byId.get(p.id); return { total, id: p.id, username: a?.username ?? null, name: a?.name ?? null }; });
  }

  // seed: the roots (scope NULL) UNION ALL EVERY child of the scope; t: the walk down from depth base + 1
  // (every child, depth < cap); orph (scope NULL only) = $r's link rows not in t → oup → cseed. ONE 'u' row:
  // count(cseed) (depth / flag / status NULL). 'm' groups: t LEFT JOIN identity_verifications, GROUP BY
  // (depth, isActive, raw status — NULL without a row), n = rows. 'o' groups (-orders only): t JOIN
  // affiliate_orders, GROUP BY (depth, isFake, raw status), n = orders. Columns of a UNION take the first
  // branch's names: kind, depth, flag, status, n. Without ORDER BY the SQL defines no row order: the
  // emulation returns the 'o' groups first, then the 'm' groups, each deepest level first, then the 'u'
  // row, so nothing may rely on an order.
  function networkStats({ scope, rid, base, cap }, withOrders) {
    const M = fModel();
    const seed = [...(scope === null ? fRoots(M, rid) : []), ...M.children(scope)];
    const t = recurse(seed.map((a) => ({ id: a.id, isActive: a.isActive ?? null, depth: base + 1 })),
      (r) => (r.depth < cap ? M.children(r.id).map((a) => ({ id: a.id, isActive: a.isActive ?? null, depth: r.depth + 1 })) : []));
    const unplaced = scope === null ? fCyclic(M, rid, new Set(t.map((r) => r.id))).cseed.length : 0;
    const byAffiliate = (table) => {
      const m = new Map();
      for (const r of rows(table)) { if (!m.has(r.affiliateId)) m.set(r.affiliateId, []); m.get(r.affiliateId).push(r); }
      return m;
    };
    const add = (groups, kind, depth, flag, status) => {
      const key = JSON.stringify([depth, flag, status]);
      if (!groups.has(key)) groups.set(key, { kind, depth, flag, status, n: 0 });
      groups.get(key).n += 1;
    };
    const identity = byAffiliate('identityVerification');
    const m = new Map();
    for (const r of t) for (const iv of identity.get(r.id) || [null]) add(m, 'm', r.depth, r.isActive, iv ? iv.status ?? null : null);
    const o = new Map();
    if (withOrders) {
      const orders = byAffiliate('affiliateOrder');
      for (const r of t) for (const x of orders.get(r.id) || []) add(o, 'o', r.depth, x.isFake ?? null, x.status ?? null);
    }
    const deepestFirst = (x, y) => y.depth - x.depth;
    const u = { kind: 'u', depth: null, flag: null, status: null, n: unplaced };
    return [...[...o.values()].sort(deepestFirst), ...[...m.values()].sort(deepestFirst), u];
  }

  // mem (F_ALL) → one row { n: count(mem), linked: count of mem ids with a link row to $r }.
  function networkDownline({ rid, cap }) {
    const { M, ids } = fMembers(rid, cap);
    return [{ n: ids.length, linked: ids.filter((id) => M.linkOf.get(id) === rid).length }];
  }

  // ── Phase 6 part 5d → Phase 7 Stage E: the reconcile candidates statement and the reconcile lease ──
  // `/* recruiter-reward-candidates */` (recruiterRewardService.rewardCandidates), emulated from its
  // SQL, CTE by CTE, from the fake tables — never by calling service code — behind the same exact
  // drift guard as the network statements and per-placeholder SQL-context checks:
  //   batch: links WHERE ($rid IS NULL OR recruiterId = $rid) AND ($after IS NULL OR affiliateId > $after)
  //          ORDER BY affiliateId (code-unit order, the same for > and ORDER BY) LIMIT $size;
  //   seg:   (Stage E) the batch ids at depth 0, then, while depth < $cap, the children of each row
  //          that have NO link row at all (UNION ALL: no de-duplication);
  //   cyc:   per seg row, rc = max(cycle) of the affiliate's ledger rows of type $tReward (NULL over
  //          none), vc = the same for $tReversal;
  //   st:    open = (rc IS NOT NULL AND rc > COALESCE(vc, 0)); thr = the minDeliveredSales of the
  //          settings version of the reward row of cycle rc (settingsVersion >= 1, joined to
  //          recruiter_settings_versions) when it lies BETWEEN $smin AND $smax, else (no row, NULL
  //          version, version < 1, unknown version, out of range) COALESCE → $dflt;
  //   cnt:   n = count of affiliate_orders with status = $delivered AND isFake = false, only when
  //          open OR $awardsOn (else NULL);
  //   rows:  ('reversal', id, NULL) WHERE open AND n < thr; ('award', id, NULL) WHERE $awardsOn AND
  //          NOT open AND n >= $minSales; ('batch', max(batch id) | NULL, count(batch));
  //          ('members', NULL, count(seg)); ORDER BY kind, id (NULL last).
  // Binds (in source order — see RC_ROLES): every rid placeholder the same text-or-NULL, both after
  // placeholders the same text-or-NULL, ::int binds integers (LIMIT ≥ 0), both awardsOn placeholders
  // the same boolean, both reward-type placeholders the same text.
  const RC_SQL = [
    '/* recruiter-reward-candidates */',
    'WITH RECURSIVE batch AS ( SELECT l."affiliateId" AS id FROM "recruiter_affiliate_links" l',
    'WHERE ($?::text IS NULL OR l."recruiterId" = $?::text) AND ($?::text IS NULL OR l."affiliateId" > $?::text)',
    'ORDER BY l."affiliateId" LIMIT $?::int ),',
    'seg AS ( SELECT s.id, 0 AS depth FROM unnest(ARRAY(SELECT b.id FROM batch b)) AS s(id) UNION ALL SELECT ch."id", g.depth + 1 FROM seg g CROSS JOIN LATERAL (',
    'SELECT a."id" FROM "affiliates" a WHERE a."parentId" = g.id AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") OFFSET 0',
    ') ch WHERE g.depth < $?::int ),',
    'cyc AS ( SELECT g.id,',
    '(SELECT max(r."cycle") FROM "recruiter_reward_ledger" r WHERE r."affiliateId" = g.id AND r."type" = $?) AS rc,',
    '(SELECT max(r."cycle") FROM "recruiter_reward_ledger" r WHERE r."affiliateId" = g.id AND r."type" = $?) AS vc',
    'FROM seg g ),',
    'st AS ( SELECT c.id, (c.rc IS NOT NULL AND c.rc > COALESCE(c.vc, 0)) AS open,',
    'COALESCE(( SELECT CASE WHEN v."minDeliveredSales" BETWEEN $?::int AND $?::int THEN v."minDeliveredSales" END',
    'FROM "recruiter_reward_ledger" rw JOIN "recruiter_settings_versions" v ON v."version" = rw."settingsVersion"',
    'WHERE rw."affiliateId" = c.id AND rw."type" = $? AND rw."cycle" = c.rc AND rw."settingsVersion" >= 1 LIMIT 1 ), $?::int) AS thr',
    'FROM cyc c ),',
    'cnt AS ( SELECT s.id, s.open, s.thr, CASE WHEN s.open OR $?::boolean THEN (',
    'SELECT count(*) FROM "affiliate_orders" o WHERE o."affiliateId" = s.id AND o."status" = $? AND o."isFake" = false',
    ') END AS n FROM st s )',
    'SELECT \'reversal\'::text AS kind, x.id, NULL::int AS n FROM cnt x WHERE x.open AND x.n < x.thr',
    'UNION ALL SELECT \'award\'::text, x.id, NULL::int FROM cnt x WHERE $?::boolean AND NOT x.open AND x.n >= $?::int',
    'UNION ALL SELECT \'batch\'::text, (SELECT max(b.id) FROM batch b), (SELECT count(*)::int FROM batch)',
    'UNION ALL SELECT \'members\'::text, NULL::text, (SELECT count(*)::int FROM seg)',
    'ORDER BY 1, 2',
  ];
  // [role, the SQL right before the placeholder (suffix), the SQL right after it (prefix)]
  const RC_ROLES = [
    ['rid', 'WHERE (', '::text IS NULL OR l."recruiterId" = '],
    ['rid', 'l."recruiterId" = ', '::text) AND ('],
    ['after', ') AND (', '::text IS NULL OR l."affiliateId" > '],
    ['after', 'l."affiliateId" > ', '::text) ORDER BY'],
    ['size', 'LIMIT ', '::int ), seg AS'],
    ['cap', 'WHERE g.depth < ', '::int ), cyc AS'],
    ['tReward', 'r."type" = ', ') AS rc,'],
    ['tReversal', 'r."type" = ', ') AS vc'],
    ['smin', 'BETWEEN ', '::int AND '],
    ['smax', '::int AND ', '::int THEN'],
    ['tReward', 'rw."type" = ', ' AND rw."cycle" = c.rc'],
    ['dflt', 'LIMIT 1 ), ', '::int) AS thr'],
    ['awardsOn', 'WHEN s.open OR ', '::boolean THEN ('],
    ['delivered', 'o."status" = ', ' AND o."isFake" = false'],
    ['awardsOn', 'WHERE ', '::boolean AND NOT x.open'],
    ['minSales', 'x.n >= ', '::int UNION ALL'],
  ];
  function rewardCandidatesStatement(norm, values) {
    const expected = RC_SQL.join(' ');
    if (norm !== expected) {
      let at = 0;
      const missing = [];
      for (const f of RC_SQL) { const i = norm.indexOf(f, at); if (i < 0) missing.push(f); else at = i + f.length; }
      throw new Error(`fake $queryRaw: the recruiter-reward-candidates query changed (missing: ${missing.length ? missing.join(' | ') : 'none, but other text was added'}) — update the emulation`);
    }
    const seg = norm.split('$?');
    if (values.length !== RC_ROLES.length || seg.length - 1 !== RC_ROLES.length) throw new Error(`fake $queryRaw: the recruiter-reward-candidates query must bind exactly ${RC_ROLES.length} values (got ${values.length})`);
    const bind = {};
    RC_ROLES.forEach(([role, pre, post], i) => {
      if (!seg[i].endsWith(pre) || !seg[i + 1].startsWith(post)) throw new Error(`fake $queryRaw: placeholder ${i + 1} of the recruiter-reward-candidates query is not its ${role} — update the emulation`);
      if (role in bind && bind[role] !== values[i]) throw new Error(`fake $queryRaw: every ${role} placeholder of the recruiter-reward-candidates query must carry the same value`);
      bind[role] = values[i];
    });
    const int = (k) => Number.isInteger(bind[k]) && Math.abs(bind[k]) <= 2147483647;
    for (const k of ['rid', 'after']) if (bind[k] !== null && typeof bind[k] !== 'string') throw new Error(`fake $queryRaw: the recruiter-reward-candidates query binds a non-text ${k} (::text)`);
    for (const k of ['size', 'cap', 'smin', 'smax', 'dflt', 'minSales']) if (!int(k)) throw new Error(`fake $queryRaw: the recruiter-reward-candidates query binds a non-integer ${k} (::int)`);
    if (typeof bind.awardsOn !== 'boolean') throw new Error('fake $queryRaw: the recruiter-reward-candidates query binds a non-boolean awardsOn (::boolean)');
    for (const k of ['tReward', 'tReversal', 'delivered']) if (typeof bind[k] !== 'string') throw new Error(`fake $queryRaw: the recruiter-reward-candidates query binds a non-text ${k}`);
    if (bind.size < 0) throw pgErr('2201W', 'LIMIT must not be negative');
    return rewardCandidates(bind);
  }
  function rewardCandidates({ rid, after, size, cap, tReward, tReversal, smin, smax, dflt, awardsOn, delivered, minSales }) {
    const links = rows('recruiterAffiliateLink');
    const batch = links
      .filter((l) => (rid === null || l.recruiterId === rid) && (after === null || cmpText(l.affiliateId, after) > 0))
      .map((l) => l.affiliateId).sort(cmpText).slice(0, size);
    // seg: depth 0 = the batch; then children (a.parentId = g.id) WITHOUT any link row, while depth < cap (UNION ALL)
    const linked = new Set(links.map((l) => l.affiliateId));
    const affs = rows('affiliate');
    const segRows = recurse(batch.map((id) => ({ id, depth: 0 })),
      (g) => (g.depth < cap ? affs.filter((a) => a.parentId != null && a.parentId === g.id && !linked.has(a.id)).map((a) => ({ id: a.id, depth: g.depth + 1 })) : []));
    return candidateRows(segRows.map((g) => g.id), batch, { tReward, tReversal, smin, smax, dflt, awardsOn, delivered, minSales });
  }
  // cyc / st / cnt and the final rows of both candidates statements, over the scanned member ids (`mem`
  // — Stage E's seg) and the batch ids (links or, Stage F wallet, roots).
  function candidateRows(mem, batch, { tReward, tReversal, smin, smax, dflt, awardsOn, delivered, minSales }) {
    const ledgerRows = rows('recruiterRewardLedger');
    const versions = rows('recruiterSettingsVersion');
    const orders = rows('affiliateOrder');
    const maxCycle = (id, type) => ledgerRows.filter((r) => r.affiliateId === id && r.type === type && r.cycle != null).reduce((m, r) => (m === null || r.cycle > m ? r.cycle : m), null);
    const cnt = mem.map((id) => {
      const rc = maxCycle(id, tReward);
      const vc = maxCycle(id, tReversal);
      const open = rc !== null && rc > (vc ?? 0);
      // the reward row of cycle rc (rc NULL → `= NULL` matches nothing), settingsVersion >= 1, joined to its version
      const rw = rc === null ? undefined : ledgerRows.find((r) => r.affiliateId === id && r.type === tReward && r.cycle === rc && r.settingsVersion != null && r.settingsVersion >= 1
        && versions.some((v) => v.version === r.settingsVersion));
      const v = rw ? versions.find((x) => x.version === rw.settingsVersion) : undefined;
      const sub = v ? (v.minDeliveredSales != null && v.minDeliveredSales >= smin && v.minDeliveredSales <= smax ? v.minDeliveredSales : null) : null;
      const thr = sub ?? dflt;
      const n = open || awardsOn ? orders.filter((o) => o.affiliateId === id && o.status === delivered && o.isFake === false).length : null;
      return { id, open, thr, n };
    });
    const out = [
      ...cnt.filter((x) => x.open && x.n !== null && x.n < x.thr).map((x) => ({ kind: 'reversal', id: x.id, n: null })),
      ...cnt.filter((x) => awardsOn && !x.open && x.n !== null && x.n >= minSales).map((x) => ({ kind: 'award', id: x.id, n: null })),
      { kind: 'batch', id: batch.length ? batch.reduce((m, x) => (cmpText(x, m) > 0 ? x : m)) : null, n: batch.length },
      { kind: 'members', id: null, n: mem.length },
    ];
    return out.sort((x, y) => cmpText(x.kind, y.kind) || (x.id === null ? (y.id === null ? 0 : 1) : y.id === null ? -1 : cmpText(x.id, y.id)));
  }
  // ── Phase 7 Stage F: `/* recruiter-reward-network-candidates */` (recruiterRewardService.networkRewardCandidates,
  // the WALLET scope) — emulated from its SQL behind the same exact drift guard and per-placeholder checks:
  //   F_ROOTS (cand / up / rs / roots of $rid);
  //   batch: roots WHERE ($after IS NULL OR id > $after) ORDER BY id (code-unit order) LIMIT $size;
  //   net:   the roots (only when $after IS NULL — the gate is inside the anchor's ARRAY) then every child
  //          while depth < $cap; orph (gated by $after IS NULL too) / oup / cseed / cnet as F_CYC / F_CNET;
  //   seg:   the batch ids at depth 0, then EVERY child while depth < $cap (UNION ALL);
  //   mem:   seg ids + cnet ids; then cyc / st / cnt and the rows exactly as recruiter-reward-candidates
  //          (candidateRows), with 'batch' = (max batch id, count(batch)) and 'members' = count(mem).
  const RN_SQL = [
    '/* recruiter-reward-network-candidates */',
    ...F_ROOTS,
    'batch AS ( SELECT r."id" FROM roots r WHERE ($?::text IS NULL OR r."id" > $?::text) ORDER BY r."id" LIMIT $?::int ),',
    ...F_NET('after'), ...F_CYC({ gate: 'after' }), F_CNET,
    'seg AS ( SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT b."id" FROM batch b)) AS s("id") UNION ALL SELECT ch."id", g.depth + 1 FROM seg g',
    'CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = g."id" OFFSET 0) ch WHERE g.depth < $?::int ),',
    'mem AS ( SELECT g."id" FROM seg g UNION ALL SELECT c."id" FROM unnest(ARRAY(SELECT cx."id" FROM cnet cx)) AS c("id") ),',
    ...RC_SQL.slice(RC_SQL.indexOf('cyc AS ( SELECT g.id,'), RC_SQL.indexOf('UNION ALL SELECT \'batch\'::text, (SELECT max(b.id) FROM batch b), (SELECT count(*)::int FROM batch)')).map((f) => (f === 'FROM seg g ),' ? 'FROM mem g ),' : f)),
    'UNION ALL SELECT \'batch\'::text, (SELECT max(b."id") FROM batch b), (SELECT count(*)::int FROM batch)',
    'UNION ALL SELECT \'members\'::text, NULL::text, (SELECT count(*)::int FROM mem)',
    'ORDER BY 1, 2',
  ];
  const RN_ROLES = [
    ...F_ROOTS_ROLES,
    ['after', 'WHERE (', '::text IS NULL OR r."id" > '], ['after', 'r."id" > ', '::text) ORDER BY'], ['size', 'LIMIT ', '::int ), net AS'],
    ...F_NET_ROLES('after'), ...F_CYC_ROLES('after'), ...F_CNET_ROLES,
    ['cap', 'WHERE g.depth < ', '::int ), mem AS'],
    ...RC_ROLES.slice(RC_ROLES.findIndex(([r]) => r === 'tReward')),
  ];
  function networkCandidatesStatement(norm, values) {
    const bind = networkStatement('recruiter-reward-network-candidates', norm, values, { roles: RN_ROLES, fragments: RN_SQL.slice(1), run: (b) => b });
    for (const k of ['rid', 'tReward', 'tReversal', 'delivered']) if (typeof bind[k] !== 'string') throw new Error(`fake $queryRaw: the recruiter-reward-network-candidates query binds a non-text ${k}`);
    if (bind.after !== null && typeof bind.after !== 'string') throw new Error('fake $queryRaw: the recruiter-reward-network-candidates query binds a non-text after (::text)');
    for (const k of ['smin', 'smax', 'dflt', 'minSales']) if (!(Number.isInteger(bind[k]) && Math.abs(bind[k]) <= 2147483647)) throw new Error(`fake $queryRaw: the recruiter-reward-network-candidates query binds a non-integer ${k} (::int)`);
    if (typeof bind.awardsOn !== 'boolean') throw new Error('fake $queryRaw: the recruiter-reward-network-candidates query binds a non-boolean awardsOn (::boolean)');
    const { rid, after, size, cap } = bind;
    const M = fModel();
    const roots = fRoots(M, rid);
    const batch = roots.map((a) => a.id).filter((id) => after === null || cmpText(id, after) > 0).sort(cmpText).slice(0, size);
    let cnet = [];
    if (after === null) cnet = fCyclic(M, rid, new Set(fNet(M, roots, cap).map((n) => n.id))).cnet;
    const seg = recurse(batch.map((id) => ({ id, depth: 0 })), (g) => (g.depth < cap ? M.children(g.id).map((a) => ({ id: a.id, depth: g.depth + 1 })) : []));
    return candidateRows([...seg.map((g) => g.id), ...cnet], batch, bind);
  }

  // ── Phase 7 → Stage F: `/* recruiter-group-qualified */` (recruiterRewardService.groupQualifiedIds) ──
  // Emulated from its SQL behind the same exact drift guard + per-placeholder checks:
  //   F_ALL: mem = N(R) (the roots, every descendant, the members on a parent cycle owned by $rid);
  //   rows:  one { id } per mem member whose count of affiliate_orders with affiliateId = it, status =
  //          $delivered and isFake = false — counted up to LIMIT $min — is >= $min (no ORDER BY: any
  //          order; the emulation returns them in reverse discovery order so callers cannot depend on one).
  // Binds: F_ALL's (rid ×4 — the same value — and cap), delivered (text), min (::int, twice — the same value).
  const GQ_SQL = [
    '/* recruiter-group-qualified */',
    ...F_ALL,
    'SELECT m."id" FROM mem m WHERE ( SELECT count(*) FROM ( SELECT 1 FROM "affiliate_orders" o',
    'WHERE o."affiliateId" = m."id" AND o."status" = $? AND o."isFake" = false LIMIT $?::int ) d ) >= $?::int',
  ];
  const GQ_ROLES = [
    ...F_ALL_ROLES,
    ['delivered', 'o."status" = ', ' AND o."isFake" = false'],
    ['min', 'LIMIT ', '::int ) d )'],
    ['min', ') d ) >= ', '::int'],
  ];
  // Phase 7 Stage B: `/* recruiter-progress-qualified */` (recruiterNetworkService.networkIdsWithRealDelivered,
  // the progress summary) — the SAME statement text and emulation as recruiter-group-qualified under
  // its own tag; it is a plain read, so it may also run outside a transaction.
  function groupQualifiedStatement(norm, values, { tag = 'recruiter-group-qualified', inTx = true } = {}) {
    const bind = networkStatement(tag, norm, values, { roles: GQ_ROLES, fragments: GQ_SQL.slice(1), run: (b) => b });
    if (typeof bind.rid !== 'string') throw new Error(`fake $queryRaw: the ${tag} query binds a non-text recruiter id (::text)`);
    if (typeof bind.delivered !== 'string') throw new Error(`fake $queryRaw: the ${tag} query binds a non-text status`);
    if (!(Number.isInteger(bind.min) && Math.abs(bind.min) <= 2147483647)) throw new Error(`fake $queryRaw: the ${tag} query binds a non-integer threshold (::int)`);
    if (bind.min < 0) throw pgErr('2201W', 'LIMIT must not be negative');
    if (inTx && !ctx()) throw new Error('fake $queryRaw: the recruiter-group-qualified query must run inside the group transaction');
    const orders = rows('affiliateOrder');
    return fMembers(bind.rid, bind.cap).ids
      .filter((id) => Math.min(bind.min, orders.filter((o) => o.affiliateId === id && o.status === bind.delivered && o.isFake === false).length) >= bind.min)
      .map((id) => ({ id })).reverse();
  }

  // ── Phase 7 Stage F: `/* recruiter-affiliate-owner */` (recruiterRewardService.findAffiliateOwner) ──
  // chain: the affiliate whose id = $id LEFT JOIN its link row (rid = recruiterId or NULL) with top (no
  //        affiliate row has id = its parentId), then the affiliate whose id = each row's parentId (NULL
  //        never matches) — UNION (each row once: a parent cycle ends after one lap);
  // info:  n = count(chain), nr = count(DISTINCT rid), rid = min(rid), top = bool_or(top);
  // up:    the affiliate whose id = $id (k = 1), then its parent (k + 1) while k < n — UNION ALL; only read
  //        when nr > 1 AND top;
  // row:   ONE row { recruiterId: nr = 1 → min(rid); nr > 1 AND top → the rid of the highest-k up row with a
  //        rid; else NULL }.  Binds: [id, id] (::text, the same value).
  const OWNER_ROW = (on) => `SELECT a."id", a."parentId", l."recruiterId" AS rid, NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top FROM "affiliates" a LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id" WHERE a."id" = ${on}`;
  const OWNER_SQL = [
    '/* recruiter-affiliate-owner */',
    `WITH RECURSIVE chain AS ( ${OWNER_ROW('$?::text')}`,
    `UNION SELECT p."id", p."parentId", p.rid, p.top FROM chain c CROSS JOIN LATERAL ( ${OWNER_ROW('c."parentId"')} OFFSET 0 ) p ),`,
    'info AS ( SELECT count(*)::int AS n, count(DISTINCT c.rid)::int AS nr, min(c.rid) AS rid, bool_or(c.top) AS top FROM chain c ),',
    'up AS ( SELECT a."id", a."parentId", l."recruiterId" AS rid, 1 AS k FROM "affiliates" a LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id" WHERE a."id" = $?::text',
    'UNION ALL SELECT p."id", p."parentId", p.rid, u.k + 1 FROM up u CROSS JOIN LATERAL ( SELECT a."id", a."parentId", l."recruiterId" AS rid FROM "affiliates" a LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id" WHERE a."id" = u."parentId" OFFSET 0 ) p',
    'WHERE u.k < (SELECT i.n FROM info i) )',
    'SELECT CASE WHEN i.nr = 1 THEN i.rid WHEN i.nr > 1 AND i.top THEN (SELECT u.rid FROM up u WHERE u.rid IS NOT NULL ORDER BY u.k DESC LIMIT 1) END AS "recruiterId" FROM info i',
  ];
  const OWNER_ROLES = [['id', 'WHERE a."id" = ', '::text UNION SELECT'], ['id', 'WHERE a."id" = ', '::text UNION ALL SELECT']];
  /** owner(id) exactly as the SQL reads it (also used by the emulated link / ledger guard triggers). */
  function ownerOf(id) {
    const M = fModel();
    const row = (a) => ({ id: a.id, parentId: a.parentId ?? null, rid: M.linkOf.get(a.id) ?? null, top: M.topOf(a) });
    const start = M.get(id);
    const chain = recurseDistinct(start ? [row(start)] : [], (c) => { const p = M.get(c.parentId); return p ? [row(p)] : []; });
    const rids = [...new Set(chain.map((c) => c.rid).filter((r) => r !== null))];
    if (rids.length === 1) return rids[0];
    if (rids.length > 1 && chain.some((c) => c.top)) {
      const n = chain.length;
      const up = recurse(start ? [{ ...row(start), k: 1 }] : [], (u) => { if (!(u.k < n)) return []; const p = M.get(u.parentId); return p ? [{ ...row(p), k: u.k + 1 }] : []; });
      let best = null;
      for (const u of up) if (u.rid !== null && (!best || u.k > best.k)) best = u;
      return best ? best.rid : null;
    }
    return null;
  }
  function ownerStatement(norm, values) {
    const bind = networkStatement('recruiter-affiliate-owner', norm, values, { roles: OWNER_ROLES, fragments: OWNER_SQL.slice(1), run: (b) => b });
    if (typeof bind.id !== 'string') throw new Error('fake $queryRaw: the recruiter-affiliate-owner query binds a non-text affiliate id');
    return [{ recruiterId: ownerOf(bind.id) }];
  }

  // ── Phase 7 Stage F: `/* recruiter-affiliate-list */` (recruiterAffiliateService.listRecruiterNetwork) ──
  //   mem:  N(R) (F_ALL, as recruiter-group-qualified);
  //   hit:  mem JOIN affiliates, with ms = createdAt in epoch milliseconds, WHERE $pattern IS NULL OR
  //         username ILIKE $pattern OR name ILIKE $pattern (ILIKE: case-insensitive, % / _ wildcards,
  //         backslash escapes the next character);
  //   page: hit WHERE ($afterMs IS NULL OR ms < $afterMs OR (ms = $afterMs AND id > $afterId)) ORDER BY
  //         ms DESC, id (code-unit order) LIMIT $take;
  //   rows: total = count(hit) on every row, the page columns + mine (a link row to $rid); an empty page
  //         is ONE row of NULLs carrying the total.
  const LIST_SQL = [
    '/* recruiter-affiliate-list */',
    ...F_ALL.slice(0, -1), `${F_MEM},`,
    'hit AS ( SELECT a."id", a."username", a."name", a."parentId", a."isActive", a."createdAt", (extract(epoch FROM a."createdAt") * 1000)::bigint AS ms',
    'FROM mem m CROSS JOIN LATERAL ( SELECT f."id", f."username", f."name", f."parentId", f."isActive", f."createdAt" FROM "affiliates" f WHERE f."id" = m."id" OFFSET 0 ) a',
    'WHERE ($?::text IS NULL OR a."username" ILIKE $?::text OR a."name" ILIKE $?::text) ),',
    'page AS ( SELECT h."id", h."username", h."name", h."parentId", h."isActive", h."createdAt", h.ms FROM hit h',
    'WHERE ($?::bigint IS NULL OR h.ms < $?::bigint OR (h.ms = $?::bigint AND h."id" > $?::text)) ORDER BY h.ms DESC, h."id" LIMIT $?::int )',
    'SELECT (SELECT count(*)::int FROM hit) AS total, p."id", p."username", p."name", p."parentId", p."isActive", p."createdAt", p.ms,',
    'EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = p."id" AND x."recruiterId" = $?::text) AS mine',
    'FROM (SELECT 1) one LEFT JOIN page p ON true ORDER BY p.ms DESC, p."id"',
  ];
  const LIST_ROLES = [
    ...F_ALL_ROLES,
    ['pattern', 'WHERE (', '::text IS NULL OR a."username" ILIKE '],
    ['pattern', 'a."username" ILIKE ', '::text OR a."name" ILIKE '],
    ['pattern', 'a."name" ILIKE ', '::text) ), page AS'],
    ['afterMs', 'WHERE (', '::bigint IS NULL OR h.ms < '],
    ['afterMs', 'h.ms < ', '::bigint OR (h.ms = '],
    ['afterMs', '(h.ms = ', '::bigint AND h."id" > '],
    ['afterId', 'h."id" > ', '::text)) ORDER BY'],
    ['take', 'LIMIT ', '::int ) SELECT'],
    ['rid', 'x."recruiterId" = ', '::text) AS mine'],
  ];
  const ilike = (value, pattern) => {
    let re = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i];
      if (ch === '\\' && i + 1 < pattern.length) { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; } else if (ch === '%') re += '[\\s\\S]*';
      else if (ch === '_') re += '[\\s\\S]';
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return typeof value === 'string' && new RegExp(`^${re}$`, 'i').test(value);
  };
  function affiliateListStatement(norm, values) {
    const expected = LIST_SQL.join(' ');
    if (norm !== expected) {
      let at = 0;
      const missing = [];
      for (const f of LIST_SQL) { const i = norm.indexOf(f, at); if (i < 0) missing.push(f); else at = i + f.length; }
      throw new Error(`fake $queryRaw: the recruiter-affiliate-list query changed (missing: ${missing.length ? missing.join(' | ') : 'none, but other text was added'}) — update the emulation`);
    }
    const seg = norm.split('$?');
    if (values.length !== LIST_ROLES.length || seg.length - 1 !== LIST_ROLES.length) throw new Error(`fake $queryRaw: the recruiter-affiliate-list query must bind exactly ${LIST_ROLES.length} values (got ${values.length})`);
    const bind = {};
    LIST_ROLES.forEach(([role, pre, post], i) => {
      if (!seg[i].endsWith(pre) || !seg[i + 1].startsWith(post)) throw new Error(`fake $queryRaw: placeholder ${i + 1} of the recruiter-affiliate-list query is not its ${role} — update the emulation`);
      if (role in bind && bind[role] !== values[i]) throw new Error(`fake $queryRaw: every ${role} placeholder of the recruiter-affiliate-list query must carry the same value`);
      bind[role] = values[i];
    });
    if (!(Number.isInteger(bind.cap) && bind.cap >= 0 && bind.cap <= 2147483647)) throw new Error('fake $queryRaw: the recruiter-affiliate-list query binds a non-integer cap (::int)');
    if (typeof bind.rid !== 'string') throw new Error('fake $queryRaw: the recruiter-affiliate-list query binds a non-text recruiter id');
    for (const k of ['pattern', 'afterId']) if (bind[k] !== null && typeof bind[k] !== 'string') throw new Error(`fake $queryRaw: the recruiter-affiliate-list query binds a non-text ${k}`);
    if (bind.afterMs !== null && !Number.isSafeInteger(bind.afterMs)) throw new Error('fake $queryRaw: the recruiter-affiliate-list query binds a non-integer afterMs (::bigint)');
    if (!(Number.isInteger(bind.take) && bind.take >= 0 && bind.take <= 2147483647)) throw new Error('fake $queryRaw: the recruiter-affiliate-list query binds a bad LIMIT (::int)');
    const byId = new Map(rows('affiliate').map((a) => [a.id, a]));
    const links = rows('recruiterAffiliateLink');
    const hit = fMembers(bind.rid, bind.cap).ids.map((id) => byId.get(id)).filter(Boolean)
      .filter((a) => bind.pattern === null || ilike(a.username, bind.pattern) || ilike(a.name, bind.pattern))
      .map((a) => ({ a, ms: new Date(a.createdAt).getTime() }));
    const page = hit
      .filter((h) => bind.afterMs === null || h.ms < bind.afterMs || (h.ms === bind.afterMs && cmpText(h.a.id, bind.afterId) > 0))
      .sort((x, y) => (y.ms - x.ms) || cmpText(x.a.id, y.a.id))
      .slice(0, bind.take);
    const total = hit.length;
    if (!page.length) return [{ total, id: null, username: null, name: null, parentId: null, isActive: null, createdAt: null, ms: null, mine: false }];
    return page.map(({ a, ms }) => ({
      total, id: a.id, username: a.username ?? null, name: a.name ?? null, parentId: a.parentId ?? null, isActive: a.isActive ?? null,
      createdAt: a.createdAt ? new Date(a.createdAt) : null, ms: BigInt(ms), mine: links.some((l) => l.affiliateId === a.id && l.recruiterId === bind.rid),
    }));
  }

  // ── Phase 7 Stage F: `/* recruiter-ownership-conflicts */` (recruiterRewardService.listRecruiterOwnershipConflicts) ──
  // Emulated from its SQL (exact drift guard + per-placeholder checks): gcand = every link row whose affiliate
  // exists and whose parentId is not a linked affiliate; gup / grs / groots = as up / rs / roots (seed parent read
  // by a primary-key lookup); gnet = the roots with owner = their link's recruiterId, then every child while
  // depth < $cap (UNION ALL); gorph = the link rows not in gnet; goup = the full upward walk of each (UNION);
  // gagg per seed = bool_or(top), count(DISTINCT rid); conf = gnet rows whose link row's recruiterId <> owner
  // ('NESTED') + gagg seeds with NOT top AND nr > 1 ('AMBIGUOUS_CYCLE'); page = conf ORDER BY id LIMIT $take;
  // rows: total / nested / ambiguous counts on every row + the page (id, kind); empty page → ONE row of NULLs.
  const CONF_UP_ROW = (on) => `SELECT a."id", a."parentId", EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked, NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top FROM "affiliates" a WHERE a."id" = ${on} OFFSET 0`;
  const CONF_SQL = [
    'WITH RECURSIVE gcand AS ( SELECT l."affiliateId" AS "id" FROM "recruiter_affiliate_links" l JOIN "affiliates" a ON a."id" = l."affiliateId" WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = a."parentId") ),',
    `gup AS ( SELECT s."id" AS seed, p."id", p."parentId", p.linked, p.top FROM unnest(ARRAY(SELECT c."id" FROM gcand c)) AS s("id") CROSS JOIN LATERAL ( ${CONF_UP_ROW('(SELECT f."parentId" FROM "affiliates" f WHERE f."id" = s."id")')} ) p`,
    `UNION SELECT u.seed, p."id", p."parentId", p.linked, p.top FROM gup u CROSS JOIN LATERAL ( ${CONF_UP_ROW('u."parentId"')} ) p WHERE NOT u.linked ),`,
    'grs AS ( SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top FROM gup u GROUP BY u.seed ),',
    'groots AS ( SELECT c."id" FROM gcand c LEFT JOIN grs ON grs.seed = c."id" WHERE grs.seed IS NULL OR (NOT grs.linked AND grs.top) ),',
    'gnet AS ( SELECT s."id", (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = s."id") AS owner, 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM groots r)) AS s("id")',
    'UNION ALL SELECT ch."id", n.owner, n.depth + 1 FROM gnet n CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch WHERE n.depth < $?::int ),',
    'gorph AS ( SELECT s."id" FROM unnest(ARRAY( SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE NOT EXISTS (SELECT 1 FROM gnet n WHERE n."id" = l."affiliateId") )) AS s("id") ),',
    `goup AS ( SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top FROM gorph op CROSS JOIN LATERAL ( ${F_OUP_ROW('op."id"')} ) p`,
    `UNION SELECT u.seed, p."id", p."parentId", p.rid, p.top FROM goup u CROSS JOIN LATERAL ( ${F_OUP_ROW('u."parentId"')} ) p ),`,
    'gagg AS ( SELECT u.seed, bool_or(u.top) AS top, count(DISTINCT u.rid) AS nr FROM goup u GROUP BY u.seed ),',
    'conf AS ( SELECT n."id", \'NESTED\'::text AS kind FROM gnet n JOIN "recruiter_affiliate_links" l ON l."affiliateId" = n."id" WHERE l."recruiterId" <> n.owner',
    'UNION ALL SELECT g.seed, \'AMBIGUOUS_CYCLE\'::text FROM gagg g WHERE NOT g.top AND g.nr > 1 ),',
    'page AS ( SELECT c."id", c.kind FROM conf c ORDER BY c."id" LIMIT $?::int )',
    'SELECT (SELECT count(*)::int FROM conf) AS total, (SELECT count(*)::int FROM conf c WHERE c.kind = \'NESTED\') AS nested, (SELECT count(*)::int FROM conf c WHERE c.kind = \'AMBIGUOUS_CYCLE\') AS ambiguous, p."id", p.kind',
    'FROM (SELECT 1) one LEFT JOIN page p ON true ORDER BY p."id"',
  ];
  const CONF_ROLES = [['cap', 'n.depth < ', '::int ), gorph AS'], ['take', 'LIMIT ', '::int ) SELECT']];
  function conflictsStatement(norm, values) {
    const bind = networkStatement('recruiter-ownership-conflicts', norm, values, { roles: CONF_ROLES, fragments: CONF_SQL, run: (b) => b });
    if (!(Number.isInteger(bind.cap) && Number.isInteger(bind.take) && bind.take >= 0)) throw new Error('fake $queryRaw: the recruiter-ownership-conflicts query binds a bad cap / LIMIT (::int)');
    const M = fModel();
    const gcand = M.links.map((l) => M.byId.get(l.affiliateId)).filter(Boolean).filter((a) => !(a.parentId != null && M.linkOf.has(a.parentId)));
    const groots = fRootsAmong(M, gcand);
    const gnet = recurse(groots.map((a) => ({ id: a.id, owner: M.linkOf.get(a.id) ?? null, depth: 0 })),
      (n) => (n.depth < bind.cap ? M.children(n.id).map((a) => ({ id: a.id, owner: n.owner, depth: n.depth + 1 })) : []));
    const placed = new Set(gnet.map((n) => n.id));
    const goup = fUpFull(M, M.links.filter((l) => !placed.has(l.affiliateId)).map((l) => l.affiliateId));
    const gagg = new Map();
    for (const u of goup) { const g = gagg.get(u.seed) ?? { top: false, rids: new Set() }; g.top = g.top || u.top; if (u.rid !== null) g.rids.add(u.rid); gagg.set(u.seed, g); }
    const conf = [
      ...gnet.filter((n) => M.linkOf.has(n.id) && n.owner !== null && M.linkOf.get(n.id) !== n.owner).map((n) => ({ id: n.id, kind: 'NESTED' })),
      ...[...gagg.entries()].filter(([, g]) => !g.top && g.rids.size > 1).map(([seed]) => ({ id: seed, kind: 'AMBIGUOUS_CYCLE' })),
    ];
    const head = { total: conf.length, nested: conf.filter((c) => c.kind === 'NESTED').length, ambiguous: conf.filter((c) => c.kind === 'AMBIGUOUS_CYCLE').length };
    const page = [...conf].sort((x, y) => cmpText(x.id, y.id)).slice(0, bind.take);
    if (!page.length) return [{ ...head, id: null, kind: null }];
    return page.map((c) => ({ ...head, id: c.id, kind: c.kind }));
  }

  // The reconcile lease: pg_try_advisory_xact_lock (two-key form — its own key space) never waits;
  // held by the calling transaction until it ends (commit, rollback or a throw) like every xact lock
  // of this fake; a second transaction meanwhile gets ok = false; the same transaction again → true.
  const LEASE_KEY = '__advisory2__:recruiter-reward-reconcile:0';
  function reconcileLease() {
    const c = ctx();
    if (!c) throw new Error('fake $queryRaw: pg_try_advisory_xact_lock outside a transaction (the lock would be released at once)');
    const l = locks.get(LEASE_KEY);
    if (l) return [{ ok: l.tx === c.id }];
    locks.set(LEASE_KEY, { tx: c.id, waiters: [] });
    c.locks.push(LEASE_KEY);
    return [{ ok: true }];
  }

  async function $queryRaw(strings, ...values) {
    const sql = Array.isArray(strings) ? strings.join('$?') : String(strings);
    log.push({ model: '$queryRaw', op: 'query', sql });
    if (typeof hooks.before === 'function') await hooks.before('$queryRaw', 'query', { sql, values });
    await tick();
    if (state.failOnce['$queryRaw.query']) { const e = state.failOnce['$queryRaw.query']; delete state.failOnce['$queryRaw.query']; throw e instanceof Error ? e : new Error('$queryRaw failed (injected)'); }
    const norm = sql.replace(/\s+/g, ' ').trim();
    // Phase 6 part 4: the admin permission change locks the recruiter row and re-reads both flags.
    if (/^SELECT "canViewOrders", "canCreateAffiliates" FROM "recruiters" WHERE "id" = \$\? FOR NO KEY UPDATE$/.test(norm)) {
      const id = values[0];
      if (!ctx()) throw new Error('fake $queryRaw: FOR NO KEY UPDATE outside a transaction (the lock would be released at once)');
      await lockRecruiterRow(id);
      const r = rows('recruiter').find((x) => x.id === id); // re-read after the wait (latest committed row)
      return r ? [{ canViewOrders: r.canViewOrders, canCreateAffiliates: r.canCreateAffiliates }] : [];
    }
    if (!phase3) throw new Error('fake db: access to model "$queryRaw" is not allowed in recruiter code (isolation) — Phase 2 mode allows only the permission row lock');
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
    // Phase 6 part 5c: the creation's ancestry check (phase 3+, exact tag).
    if (/^\/\* recruiter-ancestry \*\/ /.test(norm)) return ancestryStatement(norm, values);
    if (phase4 && norm.startsWith('/* recruiter-network-tree */')) return networkTree(norm, values);
    // Phase 6 part 5b: dispatched by the leading tag (exact name — "-stats" ≠ "-stats-orders").
    const netTag = phase4 ? /^\/\* (recruiter-network-[a-z-]+) \*\//.exec(norm)?.[1] : undefined;
    if (netTag && Object.hasOwn(NET_SQL, netTag)) return networkStatement(netTag, norm, values);
    // Phase 6 part 5d: the reconcile lease (no bind) and the candidates statement (exact tag).
    if (phase5 && norm === "SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok") {
      if (values.length !== 0) throw new Error('fake $queryRaw: the reconcile lease binds nothing');
      return reconcileLease();
    }
    if (phase5 && /^\/\* recruiter-reward-candidates \*\/ /.test(norm)) return rewardCandidatesStatement(norm, values);
    if (phase5 && /^\/\* recruiter-reward-network-candidates \*\/ /.test(norm)) return networkCandidatesStatement(norm, values); // Phase 7 Stage F (wallet scope)
    if (phase5 && /^\/\* recruiter-ownership-conflicts \*\/ /.test(norm)) return conflictsStatement(norm, values); // Phase 7 Stage F (admin, read-only)
    // Phase 7 Stage E: the owner walk (exact tag, any context) and the affiliate list (exact tag).
    if (phase3 && /^\/\* recruiter-affiliate-owner \*\/ /.test(norm)) return ownerStatement(norm, values);
    if (phase4 && /^\/\* recruiter-affiliate-list \*\/ /.test(norm)) return affiliateListStatement(norm, values);
    // Phase 7: the group reward's qualified-affiliates statement (exact tag).
    if (phase5 && /^\/\* recruiter-group-qualified \*\/ /.test(norm)) return groupQualifiedStatement(norm, values);
    // Phase 7 Stage B: the progress summary's qualified-affiliates statement (exact tag, any context).
    if (phase4 && /^\/\* recruiter-progress-qualified \*\/ /.test(norm)) return groupQualifiedStatement(norm, values, { tag: 'recruiter-progress-qualified', inTx: false });
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
    // Seeded rows default to cycle 1 (what every pre-20261110 row reads through the column default).
    ledger(data) { const r = { id: randomUUID(), seq: BigInt(++seq), affiliateId: null, reason: null, actorId: null, settingsVersion: null, actorType: 'SYSTEM', cycle: 1, createdAt: new Date(), ...clone(data) }; T.recruiterRewardLedger.push(r); return clone(r); },
    // Phase 6 part 3c: a recruiter KYC row as-is (e.g. APPROVED), bypassing the guard (CHECK still applies).
    recruiterIdentity(data) {
      const now = new Date();
      const r = {
        id: randomUUID(), status: 'APPROVED', submission: 1, cinFrontFile: `${randomUUID()}.jpg`, cinBackFile: `${randomUUID()}.jpg`,
        rejectionReason: null, submittedAt: now, reviewedBy: 'admin-seed', reviewedAt: now, approvedAt: now, createdAt: now, updatedAt: now, ...clone(data),
      };
      if (r.status === 'PENDING') { r.reviewedBy = data?.reviewedBy ?? null; r.reviewedAt = data?.reviewedAt ?? null; r.approvedAt = data?.approvedAt ?? null; }
      if (r.status === 'REJECTED') { r.approvedAt = data?.approvedAt ?? null; r.rejectionReason = data?.rejectionReason ?? 'seeded rejection'; }
      T.recruiterIdentityVerification.push(r);
      return clone(r);
    },
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
    // $queryRaw in every mode: Phase 2 accepts only the Phase 6 part 4 permission row lock (see above).
    recruiter, recruiterAuditLog, $transaction, $queryRaw,
    ...(phase3 ? { affiliate, recruiterAffiliateLink, affiliateActivationCode, $executeRaw } : {}),
    ...(phase4 ? { affiliateOrder, identityVerification } : {}),
    ...(phase5 ? { recruiterSettingsVersion, recruiterRewardLedger, affiliatePayout, recruiterIdentityVerification } : {}),
    ...(recovery ? { affiliateActivationRecovery } : {}),
    _queryCount: () => log.filter((l) => l.model !== '$transaction').length,
    _tables: T, _log: log, _state: state, _seed: seed, _openTx: openTx, _locks: locks, _payoutCalls: payoutCalls,
    // Phase 6 part 5d: the bind roles of the candidates statement, in placeholder order (tests map them to the source).
    _rewardCandidatesRoles: RC_ROLES.map(([role]) => role),
    // Phase 7: the bind roles of the group qualified statement, in placeholder order.
    _groupQualifiedRoles: GQ_ROLES.map(([role]) => role),
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
