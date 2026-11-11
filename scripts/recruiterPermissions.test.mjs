#!/usr/bin/env node
/**
 * scripts/recruiterPermissions.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 6 part 4: recruiter permissions
 * (canViewOrders, canCreateAffiliates). In-memory fake database only
 * (scripts/lib/recruiterFakeDb.mjs, recovery mode = phase 5 + recovery; never a real database).
 * Proves:
 *   1. Admin control — PATCH /api/admin/recruiters/[id]/permissions (withAdminAuth): each permission
 *      toggles independently; strict body (≥ 1 field, booleans only, no other field); non-admins refused;
 *      a no-op writes nothing; exactly one RECRUITER_PERMISSION_CHANGED audit row per changed field
 *      ({ permission, from, to }, ADMIN actor, recruiter, timestamp — never a password / token);
 *      concurrent changes to different fields both persist; concurrent changes to the same field are
 *      audited once; no session bump; creation defaults both to true, honours explicit booleans,
 *      refuses anything else.
 *   2. canViewOrders — off → stats / nodes return orders: null (scope, levels, every node) for the
 *      whole network, a rootId, a parentId, cursor/limit pages and view=unplaced, and NO order read runs
 *      (no affiliateOrder call, no raw SQL over affiliate_orders — Phase 6 part 5b); on → identical
 *      counts; a flip applies on the next request of the same session;
 *      the reward history stays; no other recruiter route exposes order counts.
 *   3. canCreateAffiliates — off → creation and activation-code regeneration refused (403 FORBIDDEN at
 *      the API, FORBIDDEN at the service), nothing written; pending list still visible; the admin
 *      recovery path still issues a code; on → both work; referral ancestry / unlimited depth unchanged;
 *      an admin toggle and an in-flight creation / regeneration are serialised by the row lock.
 *   4. Regression / scope — disable still revokes the session; a permission change touches nothing
 *      else; no schema / migration change; src/ changed only in the Part 4 files; affiliate and money
 *      files byte-identical to the Part 4 base commit. Phase 6 part 5d: the reward service may differ only
 *      by its reconcile part, the admin reward handlers / page only by the batch / cursor lines (pinned).
 * Run: node scripts/recruiterPermissions.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-permissions-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const { adminRecruiterHandlers, recruiterHandlers } = await import('../src/lib/recruiterRouteHandlers.js');
const { recruiterNetworkHandlers } = await import('../src/lib/recruiterNetworkRouteHandlers.js');
const { recruiterAffiliateHandlers } = await import('../src/lib/recruiterAffiliateRouteHandlers.js');
const { recruiterActivationHandlers } = await import('../src/lib/recruiterActivationRouteHandlers.js');
const { recruiterWalletHandlers } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const { recruiterIdentityHandlers } = await import('../src/lib/recruiterIdentityRouteHandlers.js');
const { activationRecoveryHandlers } = await import('../src/lib/affiliateActivationRecoveryHandlers.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const RSV = await import('../src/lib/services/recruiterService.js');
const NS = await import('../src/lib/services/recruiterNetworkService.js');
const AFS = await import('../src/lib/services/recruiterAffiliateService.js');
const ACS = await import('../src/lib/services/affiliateActivationService.js');
const RS = await import('../src/lib/services/recruiterRewardService.js');
const V = await import('../src/lib/recruiterVisibility.js');

// Phase 7 Stage B (documented, narrow): the affiliate LIST (listRecruiterNetwork + its JSDoc) gains keyset paging and
// the downline placement / counts; undo exactly that change — the list block taken back from `base`, the network-service
// import, LIST_LIMIT_MAX and LIST_CURSOR_RE removed — before the byte comparison below. The list block must not write.
const undoStageBList = (cur, base) => {
  const a = "/**\n * The recruiter's own network for the parent selector", z = "/**\n * Walk the parent's ancestry";
  const [ba, bz, ca, cz] = [base.indexOf(a), base.indexOf(z), cur.indexOf(a), cur.indexOf(z)];
  if (ba < 0 || bz < ba || ca < 0 || cz < ca || /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(cur.slice(ca, cz))) return '';
  let out = cur.slice(0, ca) + base.slice(ba, bz) + cur.slice(cz);
  out = out.replace("import { getAffiliateCounts, getAffiliatePlacement } from './recruiterNetworkService.js';\n", '').replace(' LIST_LIMIT_MAX: 100,', '');
  const k = out.indexOf('/** Phase 7 Stage B: keyset cursor');
  if (k >= 0) { const e1 = out.indexOf('\n', k); const e2 = out.indexOf('\n', e1 + 1); if (/^export const LIST_CURSOR_RE = /.test(out.slice(e1 + 1, e2))) out = out.slice(0, k) + out.slice(e2 + 1); }
  return out;
};
// Phase 7 Stage E (approved product rule — ownership N(R); documented, narrow): undo exactly the Stage E change of
// the creation service before the byte comparison below — the header's "Parent" bullet, the step-3 comment, the
// creation's networkIds line (the parent just passed the check), networkIdSet (now: the members of N(R) among the
// ids, through the ancestry statement) and the ancestry region (from the "Walk the parent's ancestry" JSDoc to the
// creation JSDoc: parentInNetwork — the nearest-link walk — and assertAncestryInNetwork). Each replaced region is
// checked first: the expected functions only, no write, ONE tagged recruiter-ancestry statement, ONE throw site.
const undoStageE = (cur, base) => {
  const swap = (s, x, y) => (s !== null && s.split(x).length === 2 ? s.replace(x, y) : null);
  let out = swap(cur, ' *   • Parent: none (root) or a member of THIS recruiter\'s network N(R) (Phase 7 Stage E: its\n'
    + ' *     owner — the recruiter of the nearest linked affiliate at or above it — is this recruiter),\n'
    + ' *     checked on the server inside the transaction (never trusted from the client).\n',
  ' *   • Parent: none (root) or an affiliate already linked to THIS recruiter, checked on the\n'
    + ' *     server inside the transaction (never trusted from the client), with its whole\n'
    + ' *     ancestry verified to be acyclic and inside the same network.\n');
  out = swap(out, '      // 3. Parent: none, or a member of THIS recruiter\'s network N(R) (nearest link = this recruiter).',
    '      // 3. Parent: none, or a member of THIS recruiter\'s network (whole ancestry checked).');
  out = swap(out, '        row: plain, networkIds: new Set(plain.parentId ? [plain.parentId] : []), replayed: false, // Stage E: the parent passed step 3',
    '        row: plain, networkIds: await networkIdSet(tx, recruiterId, [plain.parentId]), replayed: false,');
  if (out === null) return '';
  const span = (s, a, z) => { const i = s.indexOf(a); const j = i >= 0 ? s.indexOf(z, i + a.length) : -1; return i >= 0 && j > i && s.indexOf(a, i + 1) < 0 ? [i, j] : null; };
  const fns = (s) => [...s.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1]);
  const writes = (s) => /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/.test(s);
  const cN = span(out, '/** Phase 7 Stage E: the members of N(R) among', '/** Plain identity fields');
  const bN = span(base, '/** The ids of every affiliate linked to this recruiter (their network). */', '/** Plain identity fields');
  if (!cN || !bN) return '';
  const nBlock = out.slice(cN[0], cN[1]);
  if (fns(nBlock).join() !== 'networkIdSet' || writes(nBlock) || !/await parentInNetwork\(db, recruiterId, id\)/.test(nBlock)) return '';
  out = out.slice(0, cN[0]) + base.slice(bN[0], bN[1]) + out.slice(cN[1]);
  const A0 = "/**\n * Walk the parent's ancestry", A1 = '\n/**\n * Recruiter: create an affiliate (inactive)';
  const cA = span(out, A0, A1), bA = span(base, A0, A1);
  if (!cA || !bA) return '';
  const aBlock = out.slice(cA[0], cA[1]);
  if (fns(aBlock).join() !== 'parentInNetwork,assertAncestryInNetwork' || writes(aBlock) || (aBlock.match(/\/\* recruiter-ancestry \*\//g) || []).length !== 1
    || (aBlock.match(/throw /g) || []).length !== 1 || !/throw fail\('PARENT_NOT_IN_NETWORK'\)/.test(aBlock)) return '';
  return out.slice(0, cA[0]) + base.slice(bA[0], bA[1]) + out.slice(cA[1]);
};
// Phase 7 Stage E (approved — ownership; documented, narrow): undo exactly the Stage E change of the reward service's
// sync before the byte comparison — its header bullet, and the region from findAffiliateOwner's JSDoc to the hooks'
// alias (findAffiliateOwner + syncRecruiterReward: the owner replaces the link lookup) taken back from `base`. The
// replaced region is checked first: those two functions only, ONE tagged owner statement, the same locks in the
// same order (affiliate lock before the cycle state, money lock before the reversal), the same cycle keys, 4 creates.
const undoStageERewards = (cur, base) => {
  const h0 = cur.indexOf(' *   • Phase 7 Stage E (product rule — OWNERSHIP):'), h1 = cur.indexOf(' * ─────', h0);
  if (h0 < 0 || h1 < h0) return '';
  let out = cur.slice(0, h0) + cur.slice(h1);
  const A1 = '/**\n * Kept for the existing hooks';
  const c0 = out.indexOf('/**\n * owner(affiliateId) (Phase 7 Stage E)'), c1 = out.indexOf(A1);
  const b0 = base.indexOf('/**\n * The ONE state-based operation for an affiliate'), b1 = base.indexOf(A1);
  if (c0 < 0 || c1 < c0 || b0 < 0 || b1 < b0) return '';
  const r = out.slice(c0, c1);
  const fnsOf = [...r.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1]).join();
  const at = (x) => r.indexOf(x);
  if (fnsOf !== 'findAffiliateOwner,syncRecruiterReward' || (r.match(/\/\* recruiter-affiliate-owner \*\//g) || []).length !== 1
    || !(at('await lockAffiliateReward(tx, affiliateId);') > 0 && at('await lockAffiliateReward(tx, affiliateId);') < at('await cycleState(tx, affiliateId);'))
    || !(at('await lockRecruiterMoney(tx, open.recruiterId);') > 0 && at('await lockRecruiterMoney(tx, open.recruiterId);') < at('type: REWARD_TYPES.REVERSAL'))
    || !/idempotencyKey: reversalCycleKey\(affiliateId, open\.cycle\)/.test(r) || !/idempotencyKey: recruitRewardCycleKey\(affiliateId, nextCycle\)/.test(r)
    || (r.match(/\.create\(/g) || []).length !== 4 || /\$executeRaw|update\(|delete\(/.test(r)) return '';
  return out.slice(0, c0) + base.slice(b0, b1) + out.slice(c1);
};
// Phase 7 Stage F (approved clarification — the TOPMOST link wins; documented, narrow): undo exactly the Stage F text of
// the creation service (header bullet, the network-service import, the step-3 comment, the JSDoc start of the ancestry
// region — whose body undoStageE then takes back from the base after its own checks) so the Stage E / B undos apply.
const undoStageFAffiliates = (cur) => {
  const swaps = [
    [' *   • Parent: none (root) or a member of THIS recruiter\'s network N(R) (Phase 7 Stage F: its\n'
      + ' *     owner — the recruiter of the TOPMOST linked affiliate of its chain — is this recruiter; a\n'
      + ' *     recruiter can never create under another recruiter\'s network, even below a nested legacy link\n'
      + ' *     to itself), checked on the server inside the transaction (never trusted from the client). The\n'
      + ' *     new affiliate is linked to that same recruiter, so creation always extends its ownership.\n',
    ' *   • Parent: none (root) or a member of THIS recruiter\'s network N(R) (Phase 7 Stage E: its\n'
      + ' *     owner — the recruiter of the nearest linked affiliate at or above it — is this recruiter),\n'
      + ' *     checked on the server inside the transaction (never trusted from the client).\n'],
    ["import { NETWORK_LIMITS, getAffiliateCounts, getAffiliatePlacement } from './recruiterNetworkService.js';",
      "import { getAffiliateCounts, getAffiliatePlacement } from './recruiterNetworkService.js';"],
    ['      // 3. Parent: none, or a member of THIS recruiter\'s network N(R) (Stage F: topmost link = this recruiter).',
      '      // 3. Parent: none, or a member of THIS recruiter\'s network N(R) (nearest link = this recruiter).'],
    ["/**\n * Walk the parent's WHOLE ancestry", "/**\n * Walk the parent's ancestry"],
  ];
  let out = cur;
  for (const [x, y] of swaps) { if (out.split(x).length !== 2) return ''; out = out.replace(x, y); }
  return out;
};
// Phase 7 Stage F (documented, narrow): undo exactly the Stage F text of the reward service before the Stage E undo — the
// header bullet's first words and the owner JSDoc's first line (both regions are then taken back from the base by
// undoStageERewards after its own checks), and the new READ-ONLY admin listRecruiterOwnershipConflicts block (checked
// first: that function + its two constants only, ONE tagged conflicts statement, no write).
const undoStageFRewards = (cur) => {
  const swaps = [
    [' *   • Phase 7 Stage E introduced OWNERSHIP; Phase 7 Stage F (approved clarification) fixed its', ' *   • Phase 7 Stage E (product rule — OWNERSHIP):'],
    ['/**\n * owner(affiliateId) (Phase 7 Stage F — TOPMOST link wins)', '/**\n * owner(affiliateId) (Phase 7 Stage E)'],
  ];
  let out = cur;
  for (const [x, y] of swaps) { if (out.split(x).length !== 2) return ''; out = out.replace(x, y); }
  const a = out.indexOf('/** Phase 7 Stage F: at most this many conflicting link ids'), z = out.indexOf('/**\n * The ONE state-based operation for an affiliate');
  if (a < 0 || z < a) return '';
  const block = out.slice(a, z);
  if ([...block.matchAll(/^export (?:const|async function) (\w+)/gm)].map((m) => m[1]).join() !== 'OWNERSHIP_CONFLICTS_LIMIT,listRecruiterOwnershipConflicts'
    || (block.match(/\/\* recruiter-ownership-conflicts \*\//g) || []).length !== 1 || /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/.test(block)) return '';
  return out.slice(0, a) + out.slice(z);
};
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const big = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }); } catch (e) { return `git error ${e.status}`; } };
const tick = () => new Promise((r) => setImmediate(r));
// The parent of Phase 6 part 4 (the Part 3c commit): scope checks compare against this fixed commit
// (never against HEAD), so they give the same answer before and after the Part 4 commit.
const PART4_BASE = 'c9c5a1f3afb7fc6a8d09b2a9c6601d958e0d9420';

const T0 = new Date('2026-11-14T10:00:00.000Z');
const now = () => new Date(T0);
const noLimit = () => null;
const CODE_RE = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
// Phase 7 Stage B: + linkedToMe / progress / rewardState (additive)
const NODE_KEYS = ['childrenCount', 'descendantsCount', 'id', 'identityStatus', 'level', 'linkedToMe', 'name', 'orders', 'progress', 'rewardState', 'status', 'username'];
const STATS_KEYS = ['identity', 'levels', 'orders', 'rootId', 'totals'];
const LEVEL_KEYS = ['active', 'affiliates', 'identity', 'inactive', 'level', 'orders'];

let ipSeq = 0;
const req = (url, { method = 'GET', body, cookie, raw } = {}) => {
  const headers = { 'x-forwarded-for': `10.88.${(ipSeq >> 8) & 255}.${(++ipSeq) & 255}` };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
};
const call = async (handler, r, ctx = {}) => {
  const res = await handler(r, ctx);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, cache: res.headers.get('cache-control') };
};
const params = (id) => ({ params: Promise.resolve({ id }) });
const ADMIN = { userId: 'admin-1', email: 'admin@example.test', role: 'ADMIN' };
const adminCookie = (u = ADMIN) => `auth_token=${signToken(u)}`;
const recruiterToken = (rec) => signToken({ recruiterId: rec.id, username: rec.username, type: 'recruiter' });
const recruiterCookie = (rec) => `recruiter_token=${recruiterToken(rec)}`;

// Every model call made through the returned db, with its FULL arguments (the fake's _log keeps only
// `where`, so a relation select / include / _count would be invisible there). `at` = the fake's _log
// length when the call was made, i.e. the index of the call's own log entry when the fake writes one.
const snapArgs = (a) => { try { return JSON.parse(JSON.stringify(a ?? null, (k, x) => (typeof x === 'bigint' ? String(x) : x))); } catch { return a; } };
const withCallLog = (raw, calls) => {
  const db = new Proxy(raw, {
    get(t, p) {
      const v = t[p];
      if (p === '$transaction') return (fn, ...rest) => t.$transaction(typeof fn === 'function' ? (tx) => fn(tx === t ? db : tx) : fn, ...rest);
      if (typeof p !== 'string' || p.startsWith('_') || p.startsWith('$') || !v || typeof v !== 'object') return v;
      return new Proxy(v, {
        get(m, op) {
          const f = m[op];
          if (typeof f !== 'function') return f;
          return (...args) => { calls.push({ at: t._log.length, model: p, op: String(op), args: snapArgs(args[0]) }); return f.apply(m, args); };
        },
      });
    },
  });
  return db;
};
// A key naming order data: the affiliateOrders / orders relations (select, include, _count, a relation
// filter, an orderBy on them) or an order counter column — never `orderBy` itself nor the recruiter's
// canViewOrders flag.
const orderKey = (k) => /order/i.test(k) && k !== 'orderBy' && k !== 'canViewOrders';
const mentionsOrders = (v) => (Array.isArray(v) ? v.some(mentionsOrders) : !!v && typeof v === 'object' && Object.entries(v).some(([k, x]) => orderKey(k) || mentionsOrders(x)));

/** One fake db (phase 5 + recovery) with recruiters A and B and every handler, route-wrapped. */
function setup() {
  const hookBox = { fn: null };
  const calls = [];
  const db = withCallLog(makeRecruiterFakeDb({ recovery: true, allowPasswordUpdate: true, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } }), calls);
  const A = db._seed.recruiter({ username: 'perm.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'perm.b', name: 'Recruteur B' });
  const ad = adminRecruiterHandlers({ db, now });
  const rh = recruiterHandlers({ db, now, rateLimit: noLimit });
  const nh = recruiterNetworkHandlers({ db, rateLimit: noLimit });
  const ah = recruiterAffiliateHandlers({ db, now, rateLimit: noLimit });
  const ch = recruiterActivationHandlers({ db, now, rateLimit: noLimit });
  const wh = recruiterWalletHandlers({ db, now, rateLimit: noLimit });
  const ih = recruiterIdentityHandlers({ db, now, rateLimit: noLimit });
  const rv = activationRecoveryHandlers({ db, now, rateLimit: noLimit });
  return {
    db, A, B, hookBox, calls,
    admin: { create: withAdminAuth(ad.create), setActive: withAdminAuth(ad.setActive), setPermissions: withAdminAuth(ad.setPermissions), list: withAdminAuth(ad.list) },
    me: withRecruiterAuth(rh.me),
    stats: withRecruiterAuth(nh.stats), nodes: withRecruiterAuth(nh.nodes),
    create: withRecruiterAuth(ah.createAffiliate), list: withRecruiterAuth(ah.affiliates),
    pending: withRecruiterAuth(ch.pending), regenerate: withRecruiterAuth(ch.regenerate),
    wallet: withRecruiterAuth(wh.wallet), identity: withRecruiterAuth(ih.identity),
    recoveryRequest: rv.request, recoveryReview: withAdminAuth(rv.review),
  };
}
const perm = (E, rec, body, { cookie = adminCookie(), raw } = {}) =>
  call(E.admin.setPermissions, req(`/api/admin/recruiters/${rec.id ?? rec}/permissions`, { method: 'PATCH', body, raw, cookie }), params(rec.id ?? rec));
const recRow = (E, rec) => E.db._tables.recruiter.find((r) => r.id === (rec.id ?? rec));
const permAudits = (E, rec) => E.db._tables.recruiterAuditLog.filter((a) => a.action === 'RECRUITER_PERMISSION_CHANGED' && (!rec || a.recruiterId === (rec.id ?? rec)));
// Every read of the orders table: an affiliateOrder model call, a raw statement whose SQL mentions
// affiliate_orders (Phase 6 part 5b: the network statistics count the orders inside their SQL), OR
// any other model call whose FULL args (seen by withCallLog: the fake's _log keeps only `where`)
// mention orders — a relation select / include / _count / filter of affiliateOrders or orders —
// OR an affiliateOrder call the fake refused before logging it. `from` is a mark of E.db._log.
const orderQueries = (E, from = 0) => {
  const log = E.db._log;
  return [
    ...log.slice(from).filter((l) => l.model === 'affiliateOrder' || (l.model === '$queryRaw' && /affiliate_orders/.test(l.sql ?? ''))),
    ...E.calls.filter((c) => c.at >= from && c.model !== 'affiliateOrder' && mentionsOrders(c.args)),
    ...E.calls.filter((c) => c.at >= from && c.model === 'affiliateOrder' && !(log[c.at]?.model === 'affiliateOrder' && log[c.at]?.op === c.op)),
  ];
};
const snapshot = (E) => big({ r: E.db._tables.recruiter, a: E.db._tables.recruiterAuditLog.length });
// Phase 7 Stage B: the delivered-derived progress values (realDelivered, qualifiedIndividual, qualifiedGroup) are null
// with the flag off — stripped with the orders for the "everything else identical" comparisons.
const ORDER_DERIVED = new Set(['orders', 'realDelivered', 'qualifiedIndividual', 'qualifiedGroup']);
const stripOrders = (v) => JSON.parse(JSON.stringify(v, (k, x) => (ORDER_DERIVED.has(k) ? undefined : x)));

let uniq = 0;
const aff = (E, rec, over = {}) => {
  uniq += 1;
  const a = E.db._seed.affiliate({ username: `pm${uniq}`, name: `Affilié ${uniq}`, isActive: true, createdAt: new Date(T0.getTime() + uniq * 1000), ...over });
  if (rec) E.db._seed.link({ affiliateId: a.id, recruiterId: rec.id, createdAt: a.createdAt });
  return a;
};
const createAff = (E, rec, over = {}) => call(E.create, req('/api/recruiter/affiliates', {
  method: 'POST', cookie: recruiterCookie(rec), body: { username: `ncr${++uniq}x`, name: `Nouveau ${uniq}`, requestId: randomUUID(), ...over },
}));
const regen = (E, rec, id) => call(E.regenerate, req(`/api/recruiter/affiliates/${id}/activation-code`, { method: 'POST', cookie: recruiterCookie(rec) }), params(id));
const statsOf = (E, rec, rootId) => call(E.stats, req(`/api/recruiter/network/stats${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ''}`, { cookie: recruiterCookie(rec) }));
const nodesOf = (E, rec, p = {}) => { const q = new URLSearchParams(p).toString(); return call(E.nodes, req(`/api/recruiter/network/nodes${q ? `?${q}` : ''}`, { cookie: recruiterCookie(rec) })); };

// ── 1. Admin permission controls ─────────────────────────────────────────────
console.log('\n1. Admin: PATCH /api/admin/recruiters/[id]/permissions');
{
  const E = setup();
  const A = E.A;
  const tv0 = recRow(E, A).tokenVersion ?? 0;
  const r1 = await perm(E, A, { canViewOrders: false });
  ok('canViewOrders → false: 200 { recruiter, changed:true, changes:[{ canViewOrders true → false }] }, no-store',
    r1.status === 200 && eq(keys(r1.body), ['changed', 'changes', 'recruiter']) && r1.body.changed === true
    && eq(r1.body.changes, [{ permission: 'canViewOrders', from: true, to: false }]) && r1.body.recruiter.canViewOrders === false
    && r1.body.recruiter.canCreateAffiliates === true && /no-store/.test(r1.cache || ''), r1.text);
  ok('… stored: canViewOrders false, canCreateAffiliates untouched (true)', recRow(E, A).canViewOrders === false && recRow(E, A).canCreateAffiliates === true);
  const au1 = permAudits(E, A);
  ok('… exactly ONE audit row RECRUITER_PERMISSION_CHANGED: ADMIN admin-1, recruiter + entity = the recruiter, details exactly { permission, from, to }, createdAt = now',
    au1.length === 1 && au1[0].actorType === 'ADMIN' && au1[0].actorId === 'admin-1' && au1[0].recruiterId === A.id && au1[0].entityType === 'recruiter'
    && au1[0].entityId === A.id && eq(au1[0].details, { permission: 'canViewOrders', from: true, to: false })
    && new Date(au1[0].createdAt).getTime() === T0.getTime(), big(au1));
  const r2 = await perm(E, A, { canCreateAffiliates: false });
  ok('canCreateAffiliates → false independently: canViewOrders stays false, one more audit row',
    r2.status === 200 && recRow(E, A).canCreateAffiliates === false && recRow(E, A).canViewOrders === false && permAudits(E, A).length === 2
    && eq(permAudits(E, A)[1].details, { permission: 'canCreateAffiliates', from: true, to: false }), r2.text);
  const r3 = await perm(E, A, { canViewOrders: true, canCreateAffiliates: true });
  ok('both fields in one call → both changed, exactly TWO audit rows (one per field)',
    r3.status === 200 && r3.body.changes.length === 2 && recRow(E, A).canViewOrders === true && recRow(E, A).canCreateAffiliates === true
    && permAudits(E, A).length === 4 && eq(permAudits(E, A).slice(2).map((a) => a.details.permission).sort(), ['canCreateAffiliates', 'canViewOrders']), r3.text);
  const before = snapshot(E);
  const r4 = await perm(E, A, { canViewOrders: true });
  ok('no-op (already true) → 200 changed:false, changes:[], NO audit row, the row untouched (not even updatedAt)',
    r4.status === 200 && r4.body.changed === false && eq(r4.body.changes, []) && snapshot(E) === before, r4.text);
  const r5 = await perm(E, A, { canViewOrders: true, canCreateAffiliates: false });
  ok('one no-op field + one change → exactly ONE audit row (the changed field only)',
    r5.status === 200 && eq(r5.body.changes, [{ permission: 'canCreateAffiliates', from: true, to: false }]) && permAudits(E, A).length === 5);
  ok('no tokenVersion bump on any permission change (sessions kept, D4)', (recRow(E, A).tokenVersion ?? 0) === tv0);
  const meAfter = await call(E.me, req('/api/recruiter/me', { cookie: recruiterCookie(A) }));
  ok('the recruiter session issued before the changes is still valid; /me shows the new permissions',
    meAfter.status === 200 && eq(meAfter.body.permissions, { canViewOrders: true, canCreateAffiliates: false }), meAfter.text);
  ok('no permission audit row contains a password, a hash or a token', !/password|passwordHash|\$2[aby]\$|token|eyJ/i.test(big(permAudits(E))));
  ok('recruiter B is untouched by every change of A', recRow(E, E.B).canViewOrders === true && recRow(E, E.B).canCreateAffiliates === true && permAudits(E, E.B).length === 0);

  // strict validation
  const bad = [
    ['{}', {}], ['unknown field only', { canSeeOrders: false }], ['string "true"', { canViewOrders: 'true' }], ['number 0', { canCreateAffiliates: 0 }],
    ['null value', { canViewOrders: null }], ['extra field with a valid one', { canViewOrders: false, isActive: false }],
    ['tokenVersion smuggled', { canViewOrders: false, tokenVersion: 0 }],
  ];
  for (const [label, body] of bad) {
    const b = snapshot(E);
    const r = await perm(E, A, body);
    ok(`invalid body (${label}) → 400 INVALID_INPUT, nothing written`, r.status === 400 && r.body.code === 'INVALID_INPUT' && snapshot(E) === b, r.text);
  }
  for (const [label, raw] of [['JSON null', 'null'], ['array', '[{"canViewOrders":false}]'], ['not JSON', 'canViewOrders=false'], ['empty body', '']]) {
    const b = snapshot(E);
    const r = await perm(E, A, undefined, { raw });
    ok(`invalid body (${label}) → 400 INVALID_INPUT, nothing written`, r.status === 400 && r.body.code === 'INVALID_INPUT' && snapshot(E) === b, r.text);
  }
  const nf = await perm(E, randomUUID(), { canViewOrders: false });
  const bad404 = await perm(E, 'bad id !', { canViewOrders: false });
  ok('unknown recruiter → 404 NOT_FOUND; malformed id → 404 NOT_FOUND', nf.status === 404 && nf.body.code === 'NOT_FOUND' && bad404.status === 404 && bad404.body.code === 'NOT_FOUND', nf.text + bad404.text);
  let thrown = null;
  try { await RSV.adminSetRecruiterPermissions(A.id, { canViewOrders: false }, { db: E.db, actorId: '', now: T0 }); } catch (e) { thrown = e?.code; }
  ok('service without an admin actor → UNAUTHORIZED', thrown === 'UNAUTHORIZED');
  ok('validateRecruiterPermissionsInput: exactly the two keys, booleans only, at least one',
    eq(RSV.RECRUITER_PERMISSION_KEYS, ['canViewOrders', 'canCreateAffiliates']) && Object.isFrozen(RSV.RECRUITER_PERMISSION_KEYS)
    && eq(RSV.validateRecruiterPermissionsInput({ canViewOrders: false }), { value: { canViewOrders: false } })
    && !!RSV.validateRecruiterPermissionsInput({}).errors && !!RSV.validateRecruiterPermissionsInput([]).errors && !!RSV.validateRecruiterPermissionsInput(null).errors
    && !!RSV.validateRecruiterPermissionsInput({ canViewOrders: 'false' }).errors && !!RSV.validateRecruiterPermissionsInput({ x: true }).errors);

  // non-admin access
  const who = [
    ['no cookie', undefined],
    ['a recruiter token in auth_token (no role)', `auth_token=${recruiterToken(A)}`],
    ['an affiliate token in auth_token', `auth_token=${signToken({ affiliateId: 'aff-1', username: 'x', type: 'affiliate' })}`],
    ['a non-ADMIN user role', adminCookie({ userId: 'u-1', email: 'u@example.test', role: 'USER' })],
    ['only the recruiter_token cookie', recruiterCookie(A)],
    ['a garbage token', 'auth_token=not-a-jwt'],
  ];
  for (const [label, cookie] of who) {
    const b = snapshot(E);
    const r = await call(E.admin.setPermissions, req(`/api/admin/recruiters/${A.id}/permissions`, { method: 'PATCH', body: { canViewOrders: false }, cookie }), params(A.id));
    ok(`non-admin (${label}) → ${r.status} (401/403), nothing written`, (r.status === 401 || r.status === 403) && snapshot(E) === b, `${r.status} ${r.text}`);
  }
}

console.log('\n1b. Concurrency of admin permission changes (row lock)');
{
  const E = setup();
  const A = E.A;
  const [x, y] = await Promise.all([perm(E, A, { canViewOrders: false }), perm(E, A, { canCreateAffiliates: false })]);
  ok('concurrent changes to DIFFERENT fields: both persist, one audit row each',
    x.status === 200 && y.status === 200 && recRow(E, A).canViewOrders === false && recRow(E, A).canCreateAffiliates === false
    && permAudits(E, A).length === 2 && eq(permAudits(E, A).map((a) => a.details.permission).sort(), ['canCreateAffiliates', 'canViewOrders']), x.text + y.text);
  const same = await Promise.all(Array.from({ length: 6 }, () => perm(E, A, { canViewOrders: true })));
  ok('6 concurrent identical changes to the SAME field: all 200, exactly ONE changed:true, exactly ONE audit row',
    same.every((r) => r.status === 200) && same.filter((r) => r.body.changed === true).length === 1 && permAudits(E, A).length === 3
    && recRow(E, A).canViewOrders === true, big(same.map((r) => r.body.changed)));
  const mixed = await Promise.all([perm(E, A, { canCreateAffiliates: true }), perm(E, A, { canCreateAffiliates: false }), perm(E, A, { canCreateAffiliates: true })]);
  const changedN = mixed.filter((r) => r.body.changed === true).length;
  const last = permAudits(E, A).slice(3).map((a) => a.details);
  ok('concurrent opposite changes to the same field are serialised: every audit row is a real transition (from ≠ to, chained), the final value = the last applied change',
    mixed.every((r) => r.status === 200) && last.length === changedN && last.every((d) => d.from !== d.to)
    && last.every((d, i) => i === 0 ? d.from === false : d.from === last[i - 1].to) && recRow(E, A).canCreateAffiliates === (last.length ? last[last.length - 1].to : false), big(last));
  ok('no tokenVersion bump from concurrent changes', (recRow(E, A).tokenVersion ?? 0) === 0);
}

console.log('\n1c. Creation: optional permissions (default true)');
{
  const E = setup();
  const base = { name: 'Nouveau Recruteur', password: 'S3cure-pass' };
  const c1 = await call(E.admin.create, req('/api/admin/recruiters', { method: 'POST', body: { ...base, username: 'np.one' }, cookie: adminCookie() }));
  const row1 = E.db._tables.recruiter.find((r) => r.username === 'np.one');
  ok('omitted → both permissions true; RECRUITER_CREATED records them', c1.status === 201 && row1.canViewOrders === true && row1.canCreateAffiliates === true
    && eq(E.db._tables.recruiterAuditLog.find((a) => a.recruiterId === row1.id && a.action === 'RECRUITER_CREATED').details, { username: 'np.one', canViewOrders: true, canCreateAffiliates: true }), c1.text);
  const c2 = await call(E.admin.create, req('/api/admin/recruiters', { method: 'POST', body: { ...base, username: 'np.two', canViewOrders: false }, cookie: adminCookie() }));
  const row2 = E.db._tables.recruiter.find((r) => r.username === 'np.two');
  ok('explicit canViewOrders:false honoured, canCreateAffiliates still defaults to true (independent)',
    c2.status === 201 && row2.canViewOrders === false && row2.canCreateAffiliates === true && c2.body.recruiter.canViewOrders === false, c2.text);
  const c3 = await call(E.admin.create, req('/api/admin/recruiters', { method: 'POST', body: { ...base, username: 'np.three', canViewOrders: false, canCreateAffiliates: false }, cookie: adminCookie() }));
  ok('both explicit false honoured', c3.status === 201 && E.db._tables.recruiter.find((r) => r.username === 'np.three').canCreateAffiliates === false);
  for (const [label, extra] of [['string "yes"', { canViewOrders: 'yes' }], ['null', { canCreateAffiliates: null }], ['number 1', { canCreateAffiliates: 1 }]]) {
    const b = snapshot(E);
    const r = await call(E.admin.create, req('/api/admin/recruiters', { method: 'POST', body: { ...base, username: `np.bad${++uniq}`, ...extra }, cookie: adminCookie() }));
    const field = Object.keys(extra)[0];
    ok(`creation with a non-boolean permission (${label}) → 400 INVALID_INPUT, errors.${field} = INVALID_PERMISSION, nothing written`,
      r.status === 400 && r.body.code === 'INVALID_INPUT' && r.body.errors?.[field] === 'INVALID_PERMISSION' && snapshot(E) === b, r.text);
  }
}

// ── 2. canViewOrders ─────────────────────────────────────────────────────────
console.log('\n2. canViewOrders: no order query, orders null; tree / identity / rewards unchanged');
{
  const E = setup();
  const A = E.A;
  // network: 3 roots, a 4-level chain under root 1, children with real / fake orders, 2 unplaced (cycle)
  const r1 = aff(E, A); const r2 = aff(E, A); aff(E, A);
  const c1 = aff(E, A, { parentId: r1.id }); const c2 = aff(E, A, { parentId: c1.id }); const c3 = aff(E, A, { parentId: c2.id });
  const kids = [aff(E, A, { parentId: r2.id }), aff(E, A, { parentId: r2.id }), aff(E, A, { parentId: r2.id })];
  const u1 = aff(E, A); const u2 = aff(E, A);
  E.db._tables.affiliate.find((x) => x.id === u1.id).parentId = u2.id;
  E.db._tables.affiliate.find((x) => x.id === u2.id).parentId = u1.id;
  for (const [a, st, fake] of [[r1, 'delivered', false], [r1, 'cancelled', false], [c1, 'delivered', false], [c3, 'returned', false], [c3, 'delivered', true],
    [kids[0], 'delivered', false], [kids[1], 'pending', false], [kids[2], 'shipped', true], [r2, 'delivered', false], [r2, 'delivered', false]]) {
    E.db._seed.order({ affiliateId: a.id, status: st, isFake: fake });
  }
  E.db._seed.identity({ affiliateId: r1.id, status: 'APPROVED' });
  const views = {
    stats: () => statsOf(E, A), statsRoot: () => statsOf(E, A, r1.id), statsDeep: () => statsOf(E, A, c1.id),
    roots: () => nodesOf(E, A), parent: () => nodesOf(E, A, { parentId: r2.id }), deep: () => nodesOf(E, A, { parentId: c2.id }),
    page1: () => nodesOf(E, A, { parentId: r2.id, limit: '1', cursor: '1' }), page2: () => nodesOf(E, A, { limit: '2', cursor: '2' }),
    unplaced: () => nodesOf(E, A, { view: 'unplaced' }),
  };
  const on = {};
  const onReads = {};
  for (const [k, f] of Object.entries(views)) { const mark = E.db._log.length; on[k] = await f(); onReads[k] = orderQueries(E, mark); }
  ok('flag on (default): every view 200 with order counts (real delivered counted at scope)', Object.values(on).every((r) => r.status === 200)
    && on.stats.body.stats.orders.real.delivered === 5 && on.stats.body.stats.orders.fake.total === 2 && on.unplaced.body.nodes.length === 2, big(on.stats.body.stats?.orders));
  ok('flag on: the order-read counter sees every order read — each stats view ONE raw statement over affiliate_orders, each nodes view ONE affiliateOrder.groupBy (so the "off → 0" checks are not vacuous)',
    Object.entries(onReads).every(([k, q]) => q.length === 1 && (k.startsWith('stats') ? q[0].model === '$queryRaw' : q[0].model === 'affiliateOrder' && q[0].op === 'groupBy')),
    big(Object.fromEntries(Object.entries(onReads).map(([k, q]) => [k, q.map((l) => `${l.model}.${l.op}`)]))));

  const off = await perm(E, A, { canViewOrders: false });
  ok('admin turns canViewOrders off (200)', off.status === 200 && recRow(E, A).canViewOrders === false);
  for (const [k, f] of Object.entries(views)) {
    const mark = E.db._log.length;
    const r = await f();
    const oq = orderQueries(E, mark);
    if (k.startsWith('stats')) {
      const s = r.body.stats;
      ok(`off → ${k}: 200, stats.orders null and every level orders null, keys unchanged, NO order read (no affiliateOrder call, no raw SQL over affiliate_orders)`,
        r.status === 200 && s.orders === null && s.levels.length > 0 && s.levels.every((l) => l.orders === null && eq(keys(l), LEVEL_KEYS))
        && eq(keys(s), STATS_KEYS) && oq.length === 0, `${r.text.slice(0, 200)} q=${oq.length}`);
    } else {
      ok(`off → nodes ${k}: 200, every node orders null, keys unchanged, NO order read (no affiliateOrder call, no raw SQL over affiliate_orders)`,
        r.status === 200 && r.body.nodes.length > 0 && r.body.nodes.every((n) => n.orders === null && eq(keys(n), NODE_KEYS)) && oq.length === 0, `${r.text.slice(0, 200)} q=${oq.length}`);
    }
    ok(`off → ${k}: everything except orders identical to the flag-on response (tree, members, identity, totals, paging)`,
      eq(stripOrders(r.body), stripOrders(on[k].body)), big(stripOrders(r.body)).slice(0, 200));
    ok(`off → ${k}: no zero-filled count anywhere in the body (no orders object, no real / fake / delivered field)`,
      !/"orders":\{/.test(r.text) && !/"real":/.test(r.text) && !/"fake":/.test(r.text) && !/"delivered":/.test(r.text), r.text.slice(0, 200));
  }
  const back = await perm(E, A, { canViewOrders: true });
  ok('admin turns it back on (200)', back.status === 200);
  for (const [k, f] of Object.entries(views)) {
    const r = await f();
    ok(`on again → ${k}: byte-identical to the first flag-on response (counts unchanged)`, r.status === 200 && r.text === on[k].text);
  }

  // the change applies on the NEXT request of the same session (cookie signed once, before every change)
  const cookie = recruiterCookie(A);
  const s1 = await call(E.stats, req('/api/recruiter/network/stats', { cookie }));
  await perm(E, A, { canViewOrders: false });
  const s2 = await call(E.stats, req('/api/recruiter/network/stats', { cookie }));
  await perm(E, A, { canViewOrders: true });
  const s3 = await call(E.stats, req('/api/recruiter/network/stats', { cookie }));
  ok('same session cookie: counts → null on the very next request after the admin change → counts again (no new login)',
    s1.body.stats.orders !== null && s2.status === 200 && s2.body.stats.orders === null && s3.body.stats.orders !== null);

  // service + views directly
  const mark = E.db._log.length;
  const sv = await NS.getNetworkStats(A.id, { db: E.db, includeOrders: false });
  const nv = await NS.getNetworkNodes(A.id, { db: E.db, parentId: r2.id, includeOrders: false });
  ok('service: includeOrders:false → orders null (scope, levels, nodes) and no order read (no affiliateOrder call, no raw SQL over affiliate_orders)',
    sv.orders === null && sv.levels.every((l) => l.orders === null) && nv.nodes.every((n) => n.orders === null) && orderQueries(E, mark).length === 0);
  const svOn = await NS.getNetworkStats(A.id, { db: E.db });
  ok('service: default (includeOrders omitted) still counts', svOn.orders && svOn.orders.real.delivered === 5);
  ok('views: explicit null → null (never zeros); a missing value keeps the documented zero-fill',
    V.toRecruiterNetworkNodeView({ id: 'x', orders: null }).orders === null && V.toRecruiterNetworkStatsView({ orders: null, levels: [{ level: 1, orders: null }] }).orders === null
    && V.toRecruiterNetworkStatsView({ orders: null, levels: [{ level: 1, orders: null }] }).levels[0].orders === null
    && V.toRecruiterNetworkNodeView({ id: 'x' }).orders.real.delivered === 0);
  ok('static: both network handlers pass includeOrders: me.canViewOrders === true (re-read with the account per request)', (() => {
    const h = stripJs(read('src/lib/recruiterNetworkRouteHandlers.js'));
    // Phase 7 Stage B: the nodes handler reads the flag ONCE (const includeOrders = me.canViewOrders === true) and passes it
    // to the page AND to the progress decoration (the page's nodes + the scope's own card, one read); stats keeps the inline form.
    return (h.match(/includeOrders: me\.canViewOrders === true/g) || []).length === 1 && (h.match(/const includeOrders = me\.canViewOrders === true;/g) || []).length === 1
      && (h.match(/\bincludeOrders,\n/g) || []).length === 1 && /withProgress\(me\.id, page\.parentNode \? \[page\.parentNode, \.\.\.page\.nodes\] : page\.nodes, \{ db, includeOrders \}\)/.test(h) && /requireActiveRecruiter\(decoded, \{ db \}\)/.test(h);
  })());
  // The order-read counter is live for reads through a relation: each hostile call below counts as ONE
  // order read (so the "off → 0" checks above would catch an include / select / _count of orders).
  const relIds = { in: [r1.id, r2.id] };
  const hostile = {
    'affiliate.findMany include affiliateOrders': () => E.db.affiliate.findMany({ where: { id: relIds }, select: { id: true }, include: { affiliateOrders: true } }),
    'affiliate.findMany select orders': () => E.db.affiliate.findMany({ where: { id: relIds }, select: { id: true, orders: { select: { status: true } } } }),
    'affiliate.findMany _count affiliateOrders': () => E.db.affiliate.findMany({ where: { id: relIds }, select: { id: true, _count: { select: { affiliateOrders: true } } } }),
    'recruiterAffiliateLink.findMany nested affiliate.affiliateOrders': () => E.db.recruiterAffiliateLink.findMany({ where: { recruiterId: A.id }, select: { affiliate: { select: { affiliateOrders: { select: { status: true } } } } } }),
    'recruiterAffiliateLink.count filtered on orders': () => E.db.recruiterAffiliateLink.count({ where: { recruiterId: A.id, affiliate: { affiliateOrders: { some: { status: 'delivered' } } } } }),
    'affiliateOrder.findMany (refused before the fake logs it)': () => E.db.affiliateOrder.findMany({ where: { affiliateId: r1.id }, select: { status: true } }),
  };
  const counted = [];
  for (const [k, f] of Object.entries(hostile)) { const m = E.db._log.length; await Promise.resolve().then(f).catch(() => null); counted.push([k, orderQueries(E, m).length]); }
  ok(`order-read counter self-check: ${counted.length} hostile reads (include / select / _count / relation filter of orders on affiliate or link, an affiliateOrder op the fake refuses unlogged) each count as exactly ONE order read`,
    counted.every(([, n]) => n === 1), big(counted));
  const bm = E.db._log.length;
  await E.db.recruiter.findUnique({ where: { id: A.id }, select: { id: true, canViewOrders: true } });
  await E.db.recruiterAffiliateLink.findMany({ where: { recruiterId: A.id }, orderBy: { createdAt: 'asc' }, select: { affiliateId: true } });
  ok('… and is precise: reading the canViewOrders flag or using orderBy is not an order read', orderQueries(E, bm).length === 0 && E.calls.filter((c) => c.at >= bm).length === 2);
}

console.log('\n2b. canViewOrders off: reward history stays; no recruiter route exposes order counts');
{
  const E = setup();
  const A = E.A;
  E.db._seed.settings({ version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 2 });
  const q = aff(E, A);
  for (let i = 0; i < 3; i++) E.db._seed.order({ affiliateId: q.id, status: 'delivered', isFake: false });
  E.db._seed.identity({ affiliateId: q.id, status: 'APPROVED' });
  const aw = await RS.syncRecruiterReward(q.id, { db: E.db, now: T0 });
  ok('setup: a real reward earned', aw.action === 'AWARDED', big(aw));
  await perm(E, A, { canViewOrders: false });
  const cookie = recruiterCookie(A);
  const w = await call(E.wallet, req('/api/recruiter/wallet', { cookie }));
  ok('wallet with canViewOrders off → 200, the reward history still lists the reward (D1: it explains money)',
    w.status === 200 && w.body.wallet.rewards.some((r) => r.type === 'RECRUIT_REWARD' && r.amountCents === 15000 && r.affiliate?.id === q.id), w.text.slice(0, 300));
  const pend = await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie }));
  const responses = {
    me: await call(E.me, req('/api/recruiter/me', { cookie })),
    affiliates: await call(E.list, req('/api/recruiter/affiliates', { cookie })),
    pending: pend,
    stats: await call(E.stats, req('/api/recruiter/network/stats', { cookie })),
    nodes: await call(E.nodes, req('/api/recruiter/network/nodes', { cookie })),
    wallet: w,
    identity: await call(E.identity, req('/api/recruiter/identity', { cookie })),
  };
  const leaks = [];
  const walk = (v, path) => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v)) {
      if ('orders' in v && v.orders !== null) leaks.push(`${path}.orders`);
      if ('delivered' in v && 'total' in v) leaks.push(`${path} (status counts)`);
      for (const k of ['realDeliveredOrders', 'deliveredSales', 'deliveredOrdersCount', 'ordersCount']) if (k in v) leaks.push(`${path}.${k}`);
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const [k, r] of Object.entries(responses)) { if (r.status === 200) walk(r.body, k); }
  ok('every recruiter GET route answered 200 with the flag off', Object.values(responses).every((r) => r.status === 200), big(Object.fromEntries(Object.entries(responses).map(([k, r]) => [k, r.status]))));
  ok('no recruiter route response contains an order count (orders null, no status counts, no delivered-count field)', leaks.length === 0, leaks.join(', '));
  ok('/me reports canViewOrders false (the UI hides the order sections)', eq(responses.me.body.permissions, { canViewOrders: false, canCreateAffiliates: true }));
  const recruiterFiles = execFileSync('git', ['ls-files', 'src/app/api/recruiter', 'src/lib'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((f) => f && (f.startsWith('src/app/api/recruiter/') || /\/[^/]*recruiter[^/]*$/i.test(f)));
  const orderReaders = recruiterFiles.filter((f) => /affiliateOrder\b/.test(stripJs(read(f)))).sort();
  ok('the only recruiter-side files that read affiliate orders: the network service (gated), the reward service and its hooks (never returned to a recruiter)',
    eq(orderReaders, ['src/lib/recruiterRewardHooks.js', 'src/lib/services/recruiterNetworkService.js', 'src/lib/services/recruiterRewardService.js']), orderReaders.join(','));
}

// ── 3. canCreateAffiliates ───────────────────────────────────────────────────
console.log('\n3. canCreateAffiliates: creation and regeneration refused (API + service); recovery still works');
{
  const E = setup();
  const A = E.A;
  const c0 = await createAff(E, A);
  ok('flag on: creation → 201 with a one-time code', c0.status === 201 && CODE_RE.test(c0.body.activation?.code ?? ''), c0.text);
  const pendingId = c0.body.affiliate.id;
  const g0 = await regen(E, A, pendingId);
  ok('flag on: regeneration → 201 with a new code', g0.status === 201 && CODE_RE.test(g0.body.activation?.code ?? ''), g0.text);

  await perm(E, A, { canCreateAffiliates: false });
  const counts = () => big([E.db._tables.affiliate.length, E.db._tables.recruiterAffiliateLink.length, E.db._tables.affiliateActivationCode.length, E.db._tables.recruiterAuditLog.length]);
  const b1 = counts();
  const c1 = await createAff(E, A);
  ok('off: creation (API) → 403 { code: FORBIDDEN } exactly, nothing written (no affiliate, link, code or audit)',
    c1.status === 403 && eq(c1.body, { code: 'FORBIDDEN' }) && counts() === b1, c1.text);
  let svc = null;
  try { await AFS.recruiterCreateAffiliate(A.id, { username: `svc${++uniq}x`, name: 'Direct', requestId: randomUUID() }, { db: E.db, now: T0 }); } catch (e) { svc = e?.code; }
  ok('off: creation (direct service call) → FORBIDDEN, nothing written', svc === 'FORBIDDEN' && counts() === b1, svc);
  const g1 = await regen(E, A, pendingId);
  ok('off: regeneration (API) → 403 { code: FORBIDDEN } exactly, no code issued, no audit', g1.status === 403 && eq(g1.body, { code: 'FORBIDDEN' }) && counts() === b1, g1.text);
  let svc2 = null;
  try { await ACS.regenerateActivationCode(A.id, pendingId, { db: E.db, now: T0 }); } catch (e) { svc2 = e?.code; }
  ok('off: regeneration (direct service call) → FORBIDDEN, nothing written', svc2 === 'FORBIDDEN' && counts() === b1, svc2);
  const replay = await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', cookie: recruiterCookie(A), body: { username: 'ncr-replay', name: 'Replay', requestId: randomUUID() } }));
  ok('off: any other creation attempt is refused the same way (no alternate path)', replay.status === 403 && counts() === b1);
  const p = await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: recruiterCookie(A) }));
  ok('off: the pending list stays visible (200, lists the pending affiliate)', p.status === 200 && p.body.pending.some((x) => x.affiliate.id === pendingId), p.text);
  const st = await statsOf(E, A);
  ok('off: the network stays visible (stats 200)', st.status === 200 && st.body.stats.totals.affiliates >= 1);
  const me = await call(E.me, req('/api/recruiter/me', { cookie: recruiterCookie(A) }));
  ok('/me reports canCreateAffiliates false', eq(me.body.permissions, { canViewOrders: true, canCreateAffiliates: false }));
  // admin recovery remains available for a pending affiliate of this recruiter
  const ask = await call(E.recoveryRequest, req('/api/affiliate-activation/recovery', { method: 'POST', body: { identifier: c0.body.affiliate.username, message: 'Je n\'ai jamais reçu mon code d\'activation, merci de m\'aider.' } }));
  const rec = E.db._tables.affiliateActivationRecovery.find((x) => x.affiliateId === pendingId && x.status === 'PENDING');
  ok('recovery request for that pending affiliate → 202 PENDING', ask.status === 202 && !!rec, ask.text);
  const appr = rec ? await call(E.recoveryReview, req(`/api/admin/activation-recovery/${rec.id}`, { method: 'POST', body: { action: 'approve' }, cookie: adminCookie() }), params(rec.id)) : { status: 0 };
  ok('admin recovery approve still issues a code (201, ADMIN-created) while the recruiter may not create',
    appr.status === 201 && CODE_RE.test(appr.body?.activation?.code ?? '') && E.db._tables.affiliateActivationCode.some((c) => c.affiliateId === pendingId && c.createdByType === 'ADMIN'), appr.text);

  await perm(E, A, { canCreateAffiliates: true });
  const c2 = await createAff(E, A);
  const pend2 = c2.body?.affiliate?.id;
  const g2 = pend2 ? await regen(E, A, pend2) : { status: 0 };
  ok('back on: creation 201 and regeneration 201 again', c2.status === 201 && g2.status === 201, c2.text + g2.text);
}

console.log('\n3b. Referral tree rules unchanged (permission on)');
{
  const E = setup();
  const A = E.A;
  let parent = null;
  const ids = [];
  for (let i = 0; i < 25; i++) {
    const r = await createAff(E, A, parent ? { parentId: parent } : {});
    if (r.status !== 201) { ids.push(null); break; }
    parent = r.body.affiliate.id;
    ids.push(parent);
  }
  ok('a 25-level chain created level by level (unlimited depth): every creation 201', ids.length === 25 && ids.every(Boolean));
  const deep = await nodesOf(E, A, { parentId: ids[23] });
  ok('the level-25 affiliate is listed at level 25 under its parent', deep.status === 200 && deep.body.nodes[0]?.id === ids[24] && deep.body.nodes[0]?.level === 25, deep.text.slice(0, 200));
  const foreign = aff(E, E.B);
  const unlinked = aff(E, null);
  const f1 = await createAff(E, A, { parentId: foreign.id });
  const f2 = await createAff(E, A, { parentId: unlinked.id });
  ok('a parent of another recruiter / an unlinked parent → 400 PARENT_NOT_IN_NETWORK', f1.status === 400 && f1.body.code === 'PARENT_NOT_IN_NETWORK' && f2.status === 400 && f2.body.code === 'PARENT_NOT_IN_NETWORK', f1.text + f2.text);
}

console.log('\n3c. Admin toggle racing an in-flight creation / regeneration (row lock)');
{
  // (a) a creation holds the row lock → the admin change waits, then applies
  const E = setup();
  const A = E.A;
  let release; const gate = new Promise((r) => { release = r; });
  let reached; const atInsert = new Promise((r) => { reached = r; });
  let armed = true;
  E.hookBox.fn = async (m, o) => { if (armed && m === 'affiliate' && o === 'create') { armed = false; reached(); await gate; } };
  const creating = createAff(E, A);
  await atInsert;
  let adminDone = false;
  const toggling = perm(E, A, { canCreateAffiliates: false }).then((r) => { adminDone = true; return r; });
  for (let i = 0; i < 30; i++) await tick();
  ok('while a creation holds the recruiter row lock, the admin change WAITS (not applied yet)', !adminDone && recRow(E, A).canCreateAffiliates === true);
  release();
  const [cr, tg] = await Promise.all([creating, toggling]);
  ok('… the in-flight creation completes (201) and the admin change then applies (200, audited once)',
    cr.status === 201 && tg.status === 200 && recRow(E, A).canCreateAffiliates === false && permAudits(E, A).length === 1, cr.text + tg.text);
  const after = await createAff(E, A);
  ok('… the next creation is refused (403 FORBIDDEN)', after.status === 403);

  // (b) the admin change holds the lock → a creation waits, then sees the new value
  const E2 = setup();
  const A2 = E2.A;
  let release2; const gate2 = new Promise((r) => { release2 = r; });
  let reached2; const atUpdate = new Promise((r) => { reached2 = r; });
  let armed2 = true;
  E2.hookBox.fn = async (m, o) => { if (armed2 && m === 'recruiter' && o === 'update') { armed2 = false; reached2(); await gate2; } };
  const toggling2 = perm(E2, A2, { canCreateAffiliates: false });
  await atUpdate;
  const affBefore = E2.db._tables.affiliate.length;
  let createDone = false;
  const creating2 = createAff(E2, A2).then((r) => { createDone = true; return r; });
  for (let i = 0; i < 30; i++) await tick();
  ok('while the admin change holds the row lock, a creation WAITS', !createDone && E2.db._tables.affiliate.length === affBefore);
  release2();
  const [tg2, cr2] = await Promise.all([toggling2, creating2]);
  ok('… after the admin change commits, the waiting creation re-reads the flag → 403 FORBIDDEN, nothing written',
    tg2.status === 200 && cr2.status === 403 && eq(cr2.body, { code: 'FORBIDDEN' }) && E2.db._tables.affiliate.length === affBefore, tg2.text + cr2.text);

  // (c) the same for a regeneration
  const E3 = setup();
  const A3 = E3.A;
  const made = await createAff(E3, A3);
  const pid = made.body.affiliate.id;
  let release3; const gate3 = new Promise((r) => { release3 = r; });
  let reached3; const atUpdate3 = new Promise((r) => { reached3 = r; });
  let armed3 = true;
  E3.hookBox.fn = async (m, o) => { if (armed3 && m === 'recruiter' && o === 'update') { armed3 = false; reached3(); await gate3; } };
  const toggling3 = perm(E3, A3, { canCreateAffiliates: false });
  await atUpdate3;
  const codesBefore = E3.db._tables.affiliateActivationCode.length;
  let regenDone = false;
  const regenerating = regen(E3, A3, pid).then((r) => { regenDone = true; return r; });
  for (let i = 0; i < 30; i++) await tick();
  ok('while the admin change holds the row lock, a regeneration WAITS', !regenDone);
  release3();
  const [tg3, rg3] = await Promise.all([toggling3, regenerating]);
  ok('… then it is refused (403 FORBIDDEN), no new code', tg3.status === 200 && rg3.status === 403 && E3.db._tables.affiliateActivationCode.length === codesBefore, tg3.text + rg3.text);
  ok('no lock left over after the races', E.db._locks.size === 0 && E2.db._locks.size === 0 && E3.db._locks.size === 0);
}

// ── 4. Regression and scope ──────────────────────────────────────────────────
console.log('\n4. Regression and scope');
{
  const E = setup();
  const A = E.A;
  // Determinism fix (Phase 7 run): the seeded row and the update could fall in the SAME millisecond, so
  // updatedAt sometimes did not change (timing flake). Age the seeded timestamp first — the assertion is unchanged.
  recRow(E, A).updatedAt = new Date(Date.now() - 60_000);
  const beforeRow = { ...recRow(E, A) };
  await perm(E, A, { canViewOrders: false, canCreateAffiliates: false });
  const afterRow = recRow(E, A);
  const changedCols = Object.keys(afterRow).filter((k) => big(afterRow[k]) !== big(beforeRow[k])).sort();
  ok('a permission change writes ONLY the permission columns (+ updatedAt): no isActive, tokenVersion, password or other column',
    eq(changedCols, ['canCreateAffiliates', 'canViewOrders', 'updatedAt']), changedCols.join(','));
  const cookie = recruiterCookie(A);
  const d = await call(E.admin.setActive, req(`/api/admin/recruiters/${A.id}`, { method: 'PATCH', body: { action: 'disable' }, cookie: adminCookie() }), params(A.id));
  const me = await call(E.me, req('/api/recruiter/me', { cookie }));
  ok('disable still revokes the session (tokenVersion bump → 401/403 on the next request)', d.status === 200 && (me.status === 401 || me.status === 403) && (recRow(E, A).tokenVersion ?? 0) === 1, me.text);

  const prismaChanged = git(['diff', '--name-only', PART4_BASE, '--', 'prisma']).split('\n').filter(Boolean);
  const prismaNew = git(['ls-files', '--others', '--exclude-standard', '--', 'prisma']).split('\n').filter(Boolean);
  // Phase 7 (Reward B — the recruiter group reward, approved): exactly schema.prisma (pinned in recruiterSchema /
  // recruiterAffiliates / recruiterWithdrawalProtection) and the one new migration 20261112; Part 4 itself changed none.
  // Committed or not: changed-since-base and untracked files are counted together (same answer before and after commit).
  const prismaAll = [...new Set([...prismaChanged, ...prismaNew])].sort();
  ok('no schema or migration change in Part 4 (the permission columns already exist); since then only the Phase 7 schema fields + migration 20261112',
    eq(prismaAll, ['prisma/migrations/20261112_recruiter_group_rewards/migration.sql', 'prisma/schema.prisma']), big({ prismaChanged, prismaNew }));
  const changed = git(['diff', '--name-only', PART4_BASE, '--', 'src']).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n').filter(Boolean);
  const allSrc = [...new Set([...changed, ...untracked])].sort();
  ok('src/ changed versus the Part 4 base ONLY in the exact Part 4 files', eq(allSrc, [
    'src/app/admin/recruiters/page.jsx', 'src/app/api/admin/recruiters/[id]/permissions/route.js',
    'src/app/recruiter/affiliates/activation/page.jsx', 'src/app/recruiter/affiliates/new/page.jsx',
    'src/app/recruiter/network/networkUi.jsx', 'src/app/recruiter/network/page.jsx', 'src/app/recruiter/network/stats/page.jsx', 'src/app/recruiter/page.jsx',
    'src/lib/recruiterNetworkRouteHandlers.js', 'src/lib/recruiterProfileView.js', 'src/lib/recruiterRouteHandlers.js', 'src/lib/recruiterVisibility.js',
    'src/lib/services/affiliateActivationService.js', 'src/lib/services/recruiterNetworkService.js', 'src/lib/services/recruiterService.js',
    // Phase 6 part 5c (approved): the creation's ancestry check becomes one statement — ONLY
    // assertAncestryInNetwork may differ (pinned just below).
    'src/lib/services/recruiterAffiliateService.js',
    // Phase 6 part 5d (approved): bounded keyset reconcile batches — ONLY the reconcile part of the reward
    // service, the admin reconcile / save handlers and the admin rewards page loop (each pinned below).
    'src/lib/services/recruiterRewardService.js', 'src/lib/recruiterRewardAdminHandlers.js', 'src/app/admin/recruiter-rewards/page.jsx',
    // Phase 7 (Reward B — group reward, approved): the settings rules, the hooks (group sync after the individual one)
    // and the wallet history (group rows) — each pinned below; the reward service / handlers / page / visibility above.
    'src/lib/recruiterSettings.js', 'src/lib/recruiterRewardHooks.js', 'src/lib/services/recruiterWalletService.js',
    // Phase 7 Stage B (approved): downline visibility / progress — the affiliate list handler, the progress summary
    // (handler, service, route); the network service / handlers, visibility and the creation service's list above.
    'src/lib/recruiterAffiliateRouteHandlers.js', 'src/lib/recruiterProgressHandlers.js', 'src/lib/services/recruiterProgressService.js',
    'src/app/api/recruiter/progress/route.js',
    // Phase 7 Stage C (approved, UI only): the recruiter pages (hub summary, the new affiliates list, wallet gross /
    // reversed / group rows, 401-only login redirects, verification error, password guard, rate-limit label), their pure
    // helpers (recruiterUiState.js, wallet/walletUi.js — unit-tested in recruiterDashboardUi.test.mjs) and the Landing
    // Page Only Mode allowlist (/recruiter, /affiliate/activate). No service, route handler, schema or money logic.
    'src/app/recruiter/affiliates/page.jsx', 'src/app/recruiter/errorLabels.js', 'src/app/recruiter/password/page.jsx',
    'src/app/recruiter/recruiterUiState.js', 'src/app/recruiter/verification/page.jsx', 'src/app/recruiter/wallet/page.jsx',
    'src/app/recruiter/wallet/walletUi.js', 'src/lib/landingMode.js',
    // Recruiter dashboard redesign (UI only): the dashboard's layout / navigation, cards and charts components (the
    // dashboard page and its pure helpers are listed above). No service, route handler, schema or money logic.
    'src/app/recruiter/_components/DashboardWidgets.jsx',
    'src/app/recruiter/_components/RecruiterShell.jsx',
    // Phase 2 (UI only — one recruiter app): the layout mounts the app shell (RecruiterAppShell) around every authenticated
    // recruiter page with the shared UI kit (ui.jsx); the activation code card is restyled with it. No service, route handler, schema or money logic.
    'src/app/recruiter/_components/RecruiterAppShell.jsx', 'src/app/recruiter/_components/ui.jsx', 'src/app/recruiter/layout.jsx',
    'src/app/recruiter/affiliates/ActivationCodeCard.jsx',
    // Simplified dashboard (UI only): three sections + "المزيد" — the new profile page (read-only account view of
    // GET /api/recruiter/me); the former dashboard charts component is gone.
    'src/app/recruiter/profile/page.jsx',
    // Task 7 (UI only — market-based Arabic / French localization): the four market-scoped areas (affiliate dashboard +
    // affiliate login / activation, recruiter, /offer and /tsajlim3ana landing pages) follow the existing site-language
    // choice (MA → Arabic RTL, FR → French LTR) through the shared plumbing (marketLocale.js, useMarketLocale.jsx, the
    // root pre-paint script, LanguageContext) and per-area dictionaries; shared components get optional text / direction
    // props with unchanged defaults. Translated texts and direction only — no service, route handler, schema, money logic
    // or API request change (pinned in scripts/marketLocale.test.mjs).
    'src/app/affiliate/activate/page.jsx', 'src/app/affiliate/activate/recovery/page.jsx', 'src/app/affiliate/dashboard/BoosterTab.jsx',
    'src/app/affiliate/dashboard/BrandTab.jsx', 'src/app/affiliate/dashboard/DepositTab.jsx', 'src/app/affiliate/dashboard/UgcTab.jsx',
    'src/app/affiliate/dashboard/page.jsx', 'src/app/affiliate/layout.jsx', 'src/app/affiliate/login/page.jsx',
    'src/app/layout.jsx', 'src/app/offer/[slug]/OfferClient.jsx', 'src/app/recruiter/login/page.jsx',
    'src/app/recruiter/wallet/walletI18n.js', 'src/app/tsajlim3ana/RecruitmentLanding.jsx', 'src/app/tsajlim3ana/page.jsx',
    'src/components/LiveActivity.jsx', 'src/components/Product/InlineCodForm.jsx', 'src/components/Product/StickyCTA.jsx',
    'src/components/affiliate/PaymentProofsSlider.jsx', 'src/components/checkout/BankDetailsCard.jsx', 'src/context/LanguageContext.jsx',
    'src/context/useMarketLocale.jsx', 'src/lib/affiliateDashboardI18n.js', 'src/lib/affiliateTabsI18n.js',
    'src/lib/landingI18n.js', 'src/lib/marketLocale.js', 'src/lib/recruiterI18n.js',
    // Task 7 round 2 (UI only — closing the localization gaps): server-produced text (live activity / live feed, API
    // errors, stored notification messages) localized AT DISPLAY TIME by pure parsers (src/lib/serverText/*) — no API,
    // service or stored data change; the store header / selector changed only on market-scoped routes; the first-paint
    // gate (globals.css); currency display labels درهم / DH. Pinned in marketLocale / liveText / affiliateServerText tests.
    'src/app/affiliate/dashboard/RewardsTab.jsx', 'src/app/affiliate/dashboard/_brand/BrandDashboard.jsx', 'src/app/globals.css',
    'src/components/template/Header.jsx', 'src/components/template/LanguageSwitcher.jsx',
    'src/lib/brandI18n.js', 'src/lib/serverText/affiliateServerText.js', 'src/lib/serverText/liveText.js',
    // Create Your Own Brand visual review (UI only): the simulated-orders chart keeps its last date label inside the
    // chart (text anchor only) — no data, API or service change.
    'src/components/brand/BrandSimStats.jsx',
    // Create Your Own Brand — approved final design: one package choice (the package defines its 3–4 products and
    // quantities; no product-selection step), package details with gallery + zoom, brand name only, review, pending.
    // Admin package management (category, gallery, contents + quantities, specifications), the package model and the
    // request taking the package's contents. No payment, pricing, recruiter, commission or payout file.
    'src/app/admin/brand/AccessesTab.jsx', 'src/app/admin/brand/PackagesTab.jsx', 'src/app/admin/brand/ProductsTab.jsx', 'src/app/admin/brand/ui.jsx',
    'src/app/affiliate/dashboard/_brand/BrandPreview.jsx', 'src/app/affiliate/dashboard/_brand/PackGallery.jsx', 'src/app/affiliate/dashboard/_brand/Stepper.jsx',
    'src/lib/brandProgram.js', 'src/lib/services/brandAccessService.js',
    // Per-brand simulation speed (approved): admin panel + API route, pure rules + admin service, the generator / dashboard
    // honouring each brand's limits, admin handlers, the reserved settings row. SIMULATED orders only — no wallet,
    // commission, payout or reward file.
    'src/app/admin/brand/SpeedPanel.jsx', 'src/app/api/admin/brand/accesses/[id]/simulation-speed/route.js',
    'src/lib/brandSimSpeed.js', 'src/lib/services/brandSimSpeedService.js', 'src/lib/services/brandSimulationService.js',
    'src/lib/brandSimulation.js', 'src/lib/brandRouteHandlers.js', 'src/lib/controllers/settingsController.js',
    // Phase 7 Stage F (approved clarification): an affiliate with children cannot be deleted — the deletion helper and the
    // 409 mapping of the admin DELETE route and of the legacy controller (pinned in recruiterAffiliates.test.mjs).
    'src/app/api/admin/affiliates/route.js', 'src/lib/affiliateDeletion.js', 'src/lib/controllers/affiliateController.js',
  ].sort()), big(allSrc));
  const untouched = [
    'src/lib/services/affiliateSystemService.js', 'src/lib/services/identityService.js', 'src/lib/identityStorage.js', 'src/lib/services/orderService.js',
    'src/lib/services/recruiterIdentityService.js',
    'src/lib/services/affiliateActivationRecoveryService.js', 'src/lib/middleware/withAdminAuth.js', 'src/lib/middleware/withRecruiterAuth.js',
    'src/app/api/affiliate/payout/route.js', 'src/app/api/admin/affiliate-payouts/route.js', 'src/app/api/admin/recruiters/[id]/route.js', 'src/app/api/admin/recruiters/route.js',
  ];
  const diffs = untouched.filter((f) => git(['show', `${PART4_BASE}:${f}`]) !== read(f));
  ok('affiliate, KYC, order, reward, wallet, recovery, auth and existing admin-route files are byte-identical to the Part 4 base', diffs.length === 0, diffs.join(','));
  // Phase 7: the hooks differ ONLY by the group sync after each individual sync (import, 3 doc lines, the syncGroupOf helper,
  // the `group` option of the 3 hooks, the individual result kept and returned unchanged).
  {
    const d = git(['diff', '--unified=0', PART4_BASE, '--', 'src/lib/recruiterRewardHooks.js']).split('\n').filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---) /.test(l));
    const del = d.filter((l) => l[0] === '-').map((l) => l.slice(1).trim()), add = d.filter((l) => l[0] === '+').map((l) => l.slice(1).trim());
    ok('Phase 7 hooks: only the import, the `group` option and the post-individual group sync changed (the individual result is still what each hook returns)',
      eq(del, ["import { awardRecruiterRewardIfQualified } from './services/recruiterRewardService.js';",
        'export async function onRecruiterOrderStatusCommitted(affiliateOrderId, { db = prisma, award = awardRecruiterRewardIfQualified } = {}) {', 'return await award(o.affiliateId, { db });',
        'export async function onRecruiterIdentityApprovedCommitted(identityVerificationId, { db = prisma, award = awardRecruiterRewardIfQualified } = {}) {', 'return await award(v.affiliateId, { db });',
        'export async function onRecruiterLinkedOrderSynced(orderId, { db = prisma, award = awardRecruiterRewardIfQualified } = {}) {', 'for (const id of ids) await award(id, { db });'])
      && add.every((l) => /^(\*|\/\/|\/\*\*)/.test(l) || /group|syncGroupOf|syncRecruiterGroupRewardForAffiliate|^const r = await award\((o|v)\.affiliateId, \{ db \}\);$|^return r;$|^try \{$|^\} catch \(e\) \{$|^\}$|^console\.error\('\[recruiter-rewards\] group sync failed/.test(l)), big({ del, add }));
  }
  // Phase 7: the wallet service is byte-identical to the Part 4 base OUTSIDE getRecruiterWallet, except its settings import.
  ok('Phase 7 wallet service: only getRecruiterWallet (group rows: version, group size, threshold) and the settings import changed', (() => {
    const f = 'src/lib/services/recruiterWalletService.js';
    const IMP_OLD = "import { parseMadToCents, normalizeRecruiterSettings } from '../recruiterSettings.js';";
    const IMP_NEW = "import { parseMadToCents, normalizeRecruiterSettings, normalizeRecruiterGroupSettings, REWARD_TYPES } from '../recruiterSettings.js';";
    const base = git(['show', `${PART4_BASE}:${f}`]).replace(IMP_OLD, IMP_NEW);
    const cur = read(f);
    const a = 'export async function getRecruiterWallet(', z = '\n/** Recruiter: save their bank details';
    const [ba, bz, ca, cz] = [base.indexOf(a), base.indexOf(z), cur.indexOf(a), cur.indexOf(z)];
    return ba > 0 && ca > 0 && bz > ba && cz > ca && base.slice(0, ba) === cur.slice(0, ca) && base.slice(bz) === cur.slice(cz)
      && /GROUP_REWARD/.test(cur.slice(ca, cz)) && !/\.(create|update|updateMany|upsert|delete|deleteMany)\(/.test(cur.slice(ca, cz));
  })());
  // Phase 6 part 5c: the creation service is byte-identical to the Part 4 base EXCEPT the body of
  // assertAncestryInNetwork (+ `//` comment lines above it): same prefix up to the function, same
  // suffix from the recruiterCreateAffiliate JSDoc on, and the replaced region is that one function.
  ok('creation service: byte-identical to the Part 4 base outside assertAncestryInNetwork (Phase 6 part 5c changes only that function and its // comment; Phase 7 Stage B: + the affiliate list, undone first — undoStageBList)', (() => {
    const f = 'src/lib/services/recruiterAffiliateService.js';
    const base = git(['show', `${PART4_BASE}:${f}`]);
    const cur = undoStageBList(undoStageE(undoStageFAffiliates(read(f)), base), base); // Stage F, then Stage E, then Stage B undone
    const head = 'async function assertAncestryInNetwork(';
    const tail = '\n/**\n * Recruiter: create an affiliate (inactive)';
    const bi = base.indexOf(head), bt = base.indexOf(tail);
    if (bi < 0 || bt < bi || base.indexOf(head, bi + 1) >= 0 || base.indexOf(tail, bt + 1) >= 0) return false;
    const pre = base.slice(0, bi), post = base.slice(bt);
    if (!cur.startsWith(pre) || !cur.endsWith(post) || cur.length < pre.length + post.length) return false;
    const mid = cur.slice(pre.length, cur.length - post.length);
    const lines = mid.split('\n');
    const fnAt = lines.findIndex((l) => l.startsWith(head));
    return fnAt >= 0 && lines.slice(0, fnAt).every((l) => /^\/\/( |$)/.test(l)) && lines[fnAt] === 'async function assertAncestryInNetwork(tx, recruiterId, parentId) {'
      && (mid.match(/\bfunction\b/g) || []).length === 1 && !/\bexport\b|\bimport\b/.test(mid) && /\n}\n$/.test(mid);
  })());
  // Phase 6 part 5d: the reward service is byte-identical to the Part 4 base EXCEPT: the settings import gains
  // DEFAULT_MIN_DELIVERED_SALES and MIN_SALES_RANGE; the id chunking (CHUNK / chunks) and the two whole-scope
  // batched readers (realDeliveredCounts, identityStatuses) are removed; and the reconcile tail (from its JSDoc to
  // the end of the file) is replaced by exactly RECONCILE_BATCH + rewardCandidates / approvedAmong /
  // withReconcileLease / reconcileRecruiterRewards. Everything else — settings, locks, cycleState, thresholdOfVersion,
  // syncRecruiterReward, awardRecruiterRewardIfQualified — is unchanged byte for byte.
  ok('reward service: byte-identical to the Part 4 base outside the Phase 6 part 5d reconcile change (sync, locks, settings untouched)', (() => {
    const f = 'src/lib/services/recruiterRewardService.js';
    let b = git(['show', `${PART4_BASE}:${f}`]);
    const cur = undoStageERewards(undoStageFRewards(read(f)), b); // Stage F, then Stage E (ownership) undone first
    const once = (s, x) => s.indexOf(x) >= 0 && s.indexOf(x) === s.lastIndexOf(x);
    const IMP_OLD = '  DELIVERED_ORDER_STATUS, IDENTITY_APPROVED_STATUS, REWARD_TYPES, evaluateRecruitQualification,\n';
    const IMP_NEW = '  DEFAULT_MIN_DELIVERED_SALES, DELIVERED_ORDER_STATUS, IDENTITY_APPROVED_STATUS, MIN_SALES_RANGE, REWARD_TYPES, evaluateRecruitQualification,\n';
    const CHUNK = 'const CHUNK = 5000;\n';
    const CHUNKS = 'const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };\n';
    if (![IMP_OLD, CHUNK, CHUNKS].every((x) => once(b, x))) return false;
    b = b.replace(IMP_OLD, IMP_NEW).replace(CHUNK, '').replace(CHUNKS, '');
    const r0 = b.indexOf("/** Real delivered orders (status 'delivered' AND isFake false) per affiliate, batched. */\n"), r1 = b.indexOf('/** Per-affiliate advisory lock');
    if (r0 < 0 || r1 < r0) return false;
    const removed = b.slice(r0, r1);
    if (!eq([...removed.matchAll(/^async function (\w+)/gm)].map((m) => m[1]), ['realDeliveredCounts', 'identityStatuses'])) return false;
    b = b.slice(0, r0) + b.slice(r1);
    // Phase 7 (Reward B, approved): + 3 import lines of the group rules; the settings history / save region (from the
    // history JSDoc to the per-affiliate lock) is replaced by exactly getCurrentRecruiterSettingsWithGroup /
    // listRecruiterSettingsVersions / adminSaveRecruiterSettings (both reward types, same lock + retry); the group
    // reward section is appended after reconcileRecruiterRewards. Locks, cycleState, thresholdOfVersion,
    // syncRecruiterReward and awardRecruiterRewardIfQualified stay byte-identical.
    const IMP_END = "  normalizeRecruiterSettings, recruitRewardCycleKey, reversalCycleKey, validateRecruiterSettingsInput,\n} from '../recruiterSettings.js';";
    const IMP_P7 = "  normalizeRecruiterSettings, recruitRewardCycleKey, reversalCycleKey, validateRecruiterSettingsInput,\n  // Phase 7 (Reward B — the recruiter group reward)\n"
      + '  groupRewardCycleKey, groupReversalCycleKey, groupRewardsOn, normalizeRecruiterGroupSettings, normalizeRecruiterSettingsWithGroup,\n'
      + "  validateRecruiterGroupSettingsInput,\n} from '../recruiterSettings.js';";
    if (!once(b, IMP_END)) return false;
    b = b.replace(IMP_END, IMP_P7);
    const S0 = '/** Every settings version, newest first (admin history). */', S1 = '/** Per-affiliate advisory lock';
    const C0 = '/** Phase 7: the current settings of BOTH reward types (individual + group fields), or the defaults. */';
    const [bs0, bs1, cs0, cs1] = [b.indexOf(S0), b.indexOf(S1), cur.indexOf(C0), cur.indexOf(S1)];
    if (bs0 < 0 || bs1 < bs0 || cs0 < 0 || cs1 < cs0) return false;
    const region = cur.slice(cs0, cs1);
    if (!eq([...region.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]), ['getCurrentRecruiterSettingsWithGroup', 'listRecruiterSettingsVersions', 'adminSaveRecruiterSettings'])
      || !region.includes("await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recruiter_settings_versions'))`") || !region.includes("action: 'RECRUITER_SETTINGS_CHANGED'")
      || !region.includes('if (!isUnique(e) || attempt === 2) throw e;')) return false;
    b = b.slice(0, bs0) + region + b.slice(bs1);
    const bi = b.indexOf('/**\n * Reconcile every recruiter reward with the current state');
    const ci = cur.indexOf('/** Phase 6 part 5d: affiliates scanned per reconcile batch');
    if (bi < 0 || ci < 0 || b.slice(0, bi) !== cur.slice(0, ci)) return false;
    const bTail = b.slice(bi), cTail = cur.slice(ci);
    return eq([...bTail.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1]), ['reconcileRecruiterRewards'])
      // Stage F: + candidatesOf (the rows of both candidate statements) and networkRewardCandidates (the wallet scope: roots of N(R))
      && eq([...cTail.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1]), ['rewardCandidates', 'candidatesOf', 'networkRewardCandidates', 'approvedAmong', 'withReconcileLease', 'reconcileRecruiterRewards',
        'lockRecruiterGroup', 'groupQualifiedIds', 'groupQualifiedCount', 'groupLedgerState', 'syncRecruiterGroupReward', 'syncRecruiterGroupRewardForAffiliate', 'anyGroupReward', 'groupPass'])
      && eq([...cTail.matchAll(/^export (?:const|async function|function) (\w+)/gm)].map((m) => m[1]), ['RECONCILE_BATCH', 'reconcileRecruiterRewards',
        'GROUP_REWARD_REASONS', 'GROUP_QUALIFIED_CHUNK', 'syncRecruiterGroupReward', 'syncRecruiterGroupRewardForAffiliate'])
      && !/^import /m.test(cTail);
  })());
  // Phase 6 part 5d: the admin handlers and the admin rewards page lose EXACTLY the old single-call reconcile lines;
  // every added line belongs to the batch / cursor / busy change (or is a comment).
  const diffLines = (f) => {
    const d = git(['diff', '--unified=0', PART4_BASE, '--', f]).split('\n').filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---) /.test(l));
    return { del: d.filter((l) => l[0] === '-').map((l) => l.slice(1).trim()), add: d.filter((l) => l[0] === '+').map((l) => l.slice(1).trim()) };
  };
  const hd = diffLines('src/lib/recruiterRewardAdminHandlers.js');
  // Phase 7: + 2 doc lines (overview / saveSettings, now both reward types) and the settings read of the overview
  // (getCurrentRecruiterSettings → getCurrentRecruiterSettingsWithGroup, in the import and the call).
  ok('admin reward handlers: only the reconcile lines changed (removed exactly the 2 doc lines + the 2 full-scope reconcile calls; added only batch / cursor / RECONCILE_BUSY lines) + the Phase 7 settings read of both reward types',
    eq(hd.del, ['*   overview     GET  → current settings + history, ledger rows, balances per recruiter', '*   saveSettings POST { enabled, rewardAmountMad, minDeliveredSales } → next version, then',
      '*                     awards every reward now due (future awards only — history unchanged)', "*   reconcile    POST { action: 'reconcile' } → awards every reward now due",
      'adminSaveRecruiterSettings, getCurrentRecruiterSettings, listRecruiterSettingsVersions, reconcileRecruiterRewards,',
      "try { return await reconcileRecruiterRewards({ db, now: now() }); } catch (e) { console.error('[recruiter-rewards] reconcile failed:', e?.code ?? 'ERROR'); return null; }",
      'getCurrentRecruiterSettings({ db }), listRecruiterSettingsVersions({ db }), adminListRecruiterLedger({ db }), adminRecruiterBalances({ db }),',
      'const result = await reconcileRecruiterRewards({ db, now: now() });'])
    && hd.add.every((l) => /^(\*|\/\/)/.test(l) || /reconcileBatch|RECONCILE_BUSY|cursor/.test(l)
      || l === 'adminSaveRecruiterSettings, getCurrentRecruiterSettingsWithGroup, listRecruiterSettingsVersions, reconcileRecruiterRewards,'
      || l === 'getCurrentRecruiterSettingsWithGroup({ db }), listRecruiterSettingsVersions({ db }), adminListRecruiterLedger({ db }), adminRecruiterBalances({ db }),'), big(hd));
  const pd = diffLines('src/app/admin/recruiter-rewards/page.jsx');
  // Phase 7 (Reward B): + exactly these replaced lines — header comment, type labels, the settings form (now Reward A +
  // Reward B sections), its state / load / save body, the subtitle, the history (both reward types) and the ledger's
  // affiliate cell ("Groupe" for group rows).
  const P7_PAGE_DEL = [
    "* refuses anyone else). Reward settings (append-only versions), recheck, balances per",
    "* recruiter and the reward ledger. Recruiter withdrawals are processed in the existing",
    "const TYPE_LABEL = { RECRUIT_REWARD: \"Récompense\", REVERSAL: \"Annulation\", ADMIN_ADJUSTMENT: \"Ajustement\" };",
    "const [form, setForm] = useState({ enabled: false, rewardAmountMad: \"0.00\", minDeliveredSales: \"10\" });",
    "setForm({ enabled: s.enabled === true, rewardAmountMad: centsToInput(s.rewardAmountCents), minDeliveredSales: String(s.minDeliveredSales ?? 10) });",
    "body: JSON.stringify({ enabled: form.enabled, rewardAmountMad: form.rewardAmountMad.trim(), minDeliveredSales: form.minDeliveredSales.trim() }),",
    "{settings.enabled ? `activées, ${fmtMad(settings.rewardAmountCents)} par affilié, ${settings.minDeliveredSales} commande(s) réelle(s) livrée(s)` : \"désactivées\"}",
    // Phase 7 Stage E (approved ownership rule, documented): the rule text names the recruiter's NETWORK (created + invited
    // below them), no longer only the affiliates it created.
    "<p>Un recruteur reçoit <strong>une récompense par affilié qu&apos;il a créé</strong> dès que cet affilié a <strong>les deux conditions</strong> :</p>",
    "<form onSubmit={save} className=\"grid gap-4 sm:grid-cols-3 items-start\" data-settings-form>",
    "<label className=\"flex items-center gap-2 text-sm font-medium text-gray-700 sm:col-span-3\">",
    "<input type=\"checkbox\" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} className=\"w-4 h-4\" data-field=\"enabled\" />",
    "Récompenses activées",
    "</label>",
    "<div className=\"space-y-1 min-w-0\">",
    "<label htmlFor=\"rr-amount\" className=\"text-xs font-semibold text-gray-600\">Montant par affilié (MAD)</label>",
    "<input id=\"rr-amount\" inputMode=\"decimal\" value={form.rewardAmountMad} onChange={(e) => setForm((f) => ({ ...f, rewardAmountMad: e.target.value }))}",
    "className=\"w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400\" data-field=\"rewardAmountMad\" />",
    "{fieldErrors.rewardAmountMad && <p className=\"text-xs text-red-600\" data-field-error=\"rewardAmountMad\">{FIELD_ERRORS[fieldErrors.rewardAmountMad] ?? \"Valeur invalide.\"}</p>}",
    "</div>",
    "<div className=\"space-y-1 min-w-0\">",
    "<label htmlFor=\"rr-min\" className=\"text-xs font-semibold text-gray-600\">Commandes réelles livrées requises</label>",
    "<input id=\"rr-min\" inputMode=\"numeric\" value={form.minDeliveredSales} onChange={(e) => setForm((f) => ({ ...f, minDeliveredSales: e.target.value }))}",
    "className=\"w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400\" data-field=\"minDeliveredSales\" />",
    "{fieldErrors.minDeliveredSales && <p className=\"text-xs text-red-600\" data-field-error=\"minDeliveredSales\">{FIELD_ERRORS[fieldErrors.minDeliveredSales] ?? \"Valeur invalide.\"}</p>}",
    "</div>",
    "<div className=\"sm:pt-5\">",
    "<p className=\"text-sm text-gray-400\" data-empty=\"history\">Aucune version : récompenses désactivées, 0 MAD, 10 commandes (valeurs par défaut).</p>",
    "{[\"Version\", \"Statut\", \"Montant\", \"Commandes requises\", \"Par\", \"Date\"].map((h) => <th key={h} className=\"text-right text-xs font-semibold text-gray-500 px-3 py-2 whitespace-nowrap\">{h}</th>)}",
    "<td className=\"px-3 py-2 font-mono text-xs\">{l.affiliateUsername ? `@${l.affiliateUsername}` : \"—\"}</td>",
  ];
  const pdOld = pd.del.filter((l) => /reconcile|awarded|reversed|setReconcileMsg|setSaveMsg|const (res|body) = /.test(l));
  ok('admin rewards page: only the save message and the reconcile button changed (they now loop one-batch requests with the cursor) + the exact Phase 7 settings / history / label lines',
    pdOld.length === 8 && eq(pd.del.filter((l) => !pdOld.includes(l)), P7_PAGE_DEL)
    && ['data-field="groupEnabled"', 'data-field="groupRewardAmountMad"', 'data-field="groupSize"', 'data-field="groupMinDeliveredSales"'].every((x) => pd.add.some((l) => l.includes(x)))
    && pd.add.some((l) => l === 'const reconcileBatches = async (startCursor = null, start = null) => {') && pd.add.some((l) => /JSON\.stringify\(\{ action: "reconcile", \.\.\.\(cursor \? \{ cursor \} : \{\}\) \}\)/.test(l))
    && pd.add.some((l) => l === 'if (!r.hasMore || !r.cursor || r.cursor === cursor) return total;'), big(pd));
  // Committed or not (changed-since-base + untracked): the only addition is the approved Phase 7 progress route.
  const guardedDirs = ['src/app/api/affiliate', 'src/app/api/admin/identity', 'src/app/api/recruiter', 'src/lib/middleware'];
  const dirs = [...new Set([
    ...git(['diff', '--name-only', PART4_BASE, '--', ...guardedDirs]).split('\n').filter(Boolean),
    ...git(['ls-files', '--others', '--exclude-standard', '--', ...guardedDirs]).split('\n').filter(Boolean),
  ])].sort();
  ok('no file changed under the affiliate API, the admin identity API, the recruiter API or the middleware (only the new Phase 7 route src/app/api/recruiter/progress/route.js)',
    eq(dirs, ['src/app/api/recruiter/progress/route.js']), dirs.join(','));
  ok('the creation permission check stays in the service under the row lock, before the replay lookup (unchanged order)', (() => {
    const s = stripJs(read('src/lib/services/recruiterAffiliateService.js'));
    const lock = s.indexOf('SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${recruiterId} FOR NO KEY UPDATE');
    const chk = s.indexOf("if (me.canCreateAffiliates !== true) throw fail('FORBIDDEN')");
    const replay = s.indexOf("action: 'AFFILIATE_CREATED'");
    return lock > 0 && chk > lock && replay > chk;
  })());
  ok('regeneration: the permission is read under the same row lock, after isActive and before any code is touched', (() => {
    const s = stripJs(read('src/lib/services/affiliateActivationService.js'));
    const fn = s.slice(s.indexOf('export async function regenerateActivationCode'), s.indexOf('export async function', s.indexOf('export async function regenerateActivationCode') + 10));
    const lock = fn.indexOf('SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${recruiterId} FOR NO KEY UPDATE');
    const active = fn.indexOf("if (me.isActive !== true) throw fail('RECRUITER_DISABLED')");
    const chk = fn.indexOf("if (me.canCreateAffiliates !== true) throw fail('FORBIDDEN')");
    const link = fn.indexOf('recruiterAffiliateLink.findUnique');
    return lock > 0 && active > lock && chk > active && link > chk;
  })());
  ok('admin permission service: row lock, re-read, field-scoped update, one audit per change, no tokenVersion', (() => {
    const s = stripJs(read('src/lib/services/recruiterService.js'));
    const fn = s.slice(s.indexOf('export async function adminSetRecruiterPermissions'), s.indexOf('export async function adminSetRecruiterActive'));
    return /FOR NO KEY UPDATE/.test(fn) && /RECRUITER_PERMISSION_CHANGED/.test(fn) && !/tokenVersion/.test(fn) && /tx\.recruiter\.update\(\{ where: \{ id \}, data \}\)/.test(fn)
      && fn.indexOf('FOR NO KEY UPDATE') < fn.indexOf('tx.recruiter.update');
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
