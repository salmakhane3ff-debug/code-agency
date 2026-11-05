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
 *      whole network, a rootId, a parentId, cursor/limit pages and view=unplaced, and NO affiliateOrder
 *      query runs; on → identical counts; a flip applies on the next request of the same session;
 *      the reward history stays; no other recruiter route exposes order counts.
 *   3. canCreateAffiliates — off → creation and activation-code regeneration refused (403 FORBIDDEN at
 *      the API, FORBIDDEN at the service), nothing written; pending list still visible; the admin
 *      recovery path still issues a code; on → both work; referral ancestry / unlimited depth unchanged;
 *      an admin toggle and an in-flight creation / regeneration are serialised by the row lock.
 *   4. Regression / scope — disable still revokes the session; a permission change touches nothing
 *      else; no schema / migration change; src/ changed only in the Part 4 files; affiliate and money
 *      files byte-identical to the Part 4 base commit.
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
const NODE_KEYS = ['childrenCount', 'descendantsCount', 'id', 'identityStatus', 'level', 'name', 'orders', 'status', 'username'];
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

/** One fake db (phase 5 + recovery) with recruiters A and B and every handler, route-wrapped. */
function setup() {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ recovery: true, allowPasswordUpdate: true, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
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
    db, A, B, hookBox,
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
const orderQueries = (E, from = 0) => E.db._log.slice(from).filter((l) => l.model === 'affiliateOrder');
const snapshot = (E) => big({ r: E.db._tables.recruiter, a: E.db._tables.recruiterAuditLog.length });
const stripOrders = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'orders' ? undefined : x)));

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
  for (const [k, f] of Object.entries(views)) on[k] = await f();
  ok('flag on (default): every view 200 with order counts (real delivered counted at scope)', Object.values(on).every((r) => r.status === 200)
    && on.stats.body.stats.orders.real.delivered === 5 && on.stats.body.stats.orders.fake.total === 2 && on.unplaced.body.nodes.length === 2, big(on.stats.body.stats?.orders));

  const off = await perm(E, A, { canViewOrders: false });
  ok('admin turns canViewOrders off (200)', off.status === 200 && recRow(E, A).canViewOrders === false);
  for (const [k, f] of Object.entries(views)) {
    const mark = E.db._log.length;
    const r = await f();
    const oq = orderQueries(E, mark);
    if (k.startsWith('stats')) {
      const s = r.body.stats;
      ok(`off → ${k}: 200, stats.orders null and every level orders null, keys unchanged, NO affiliateOrder query`,
        r.status === 200 && s.orders === null && s.levels.length > 0 && s.levels.every((l) => l.orders === null && eq(keys(l), LEVEL_KEYS))
        && eq(keys(s), STATS_KEYS) && oq.length === 0, `${r.text.slice(0, 200)} q=${oq.length}`);
    } else {
      ok(`off → nodes ${k}: 200, every node orders null, keys unchanged, NO affiliateOrder query`,
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
  ok('service: includeOrders:false → orders null (scope, levels, nodes) and no affiliateOrder call',
    sv.orders === null && sv.levels.every((l) => l.orders === null) && nv.nodes.every((n) => n.orders === null) && orderQueries(E, mark).length === 0);
  const svOn = await NS.getNetworkStats(A.id, { db: E.db });
  ok('service: default (includeOrders omitted) still counts', svOn.orders && svOn.orders.real.delivered === 5);
  ok('views: explicit null → null (never zeros); a missing value keeps the documented zero-fill',
    V.toRecruiterNetworkNodeView({ id: 'x', orders: null }).orders === null && V.toRecruiterNetworkStatsView({ orders: null, levels: [{ level: 1, orders: null }] }).orders === null
    && V.toRecruiterNetworkStatsView({ orders: null, levels: [{ level: 1, orders: null }] }).levels[0].orders === null
    && V.toRecruiterNetworkNodeView({ id: 'x' }).orders.real.delivered === 0);
  ok('static: both network handlers pass includeOrders: me.canViewOrders === true (re-read with the account per request)', (() => {
    const h = stripJs(read('src/lib/recruiterNetworkRouteHandlers.js'));
    return (h.match(/includeOrders: me\.canViewOrders === true/g) || []).length === 2 && /requireActiveRecruiter\(decoded, \{ db \}\)/.test(h);
  })());
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
  ok('no schema or migration change in Part 4 (the permission columns already exist)', prismaChanged.length === 0 && prismaNew.length === 0, big({ prismaChanged, prismaNew }));
  const changed = git(['diff', '--name-only', PART4_BASE, '--', 'src']).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n').filter(Boolean);
  const allSrc = [...new Set([...changed, ...untracked])].sort();
  ok('src/ changed versus the Part 4 base ONLY in the exact Part 4 files', eq(allSrc, [
    'src/app/admin/recruiters/page.jsx', 'src/app/api/admin/recruiters/[id]/permissions/route.js',
    'src/app/recruiter/affiliates/activation/page.jsx', 'src/app/recruiter/affiliates/new/page.jsx',
    'src/app/recruiter/network/networkUi.jsx', 'src/app/recruiter/network/page.jsx', 'src/app/recruiter/network/stats/page.jsx', 'src/app/recruiter/page.jsx',
    'src/lib/recruiterNetworkRouteHandlers.js', 'src/lib/recruiterProfileView.js', 'src/lib/recruiterRouteHandlers.js', 'src/lib/recruiterVisibility.js',
    'src/lib/services/affiliateActivationService.js', 'src/lib/services/recruiterNetworkService.js', 'src/lib/services/recruiterService.js',
  ].sort()), big(allSrc));
  const untouched = [
    'src/lib/services/affiliateSystemService.js', 'src/lib/services/identityService.js', 'src/lib/identityStorage.js', 'src/lib/services/orderService.js',
    'src/lib/services/recruiterRewardService.js', 'src/lib/recruiterRewardHooks.js', 'src/lib/services/recruiterWalletService.js', 'src/lib/services/recruiterIdentityService.js',
    'src/lib/services/recruiterAffiliateService.js', 'src/lib/services/affiliateActivationRecoveryService.js', 'src/lib/middleware/withAdminAuth.js', 'src/lib/middleware/withRecruiterAuth.js',
    'src/app/api/affiliate/payout/route.js', 'src/app/api/admin/affiliate-payouts/route.js', 'src/app/api/admin/recruiters/[id]/route.js', 'src/app/api/admin/recruiters/route.js',
  ];
  const diffs = untouched.filter((f) => git(['show', `${PART4_BASE}:${f}`]) !== read(f));
  ok('affiliate, KYC, order, reward, wallet, creation-service, recovery, auth and existing admin-route files are byte-identical to the Part 4 base', diffs.length === 0, diffs.join(','));
  const dirs = git(['diff', '--name-only', PART4_BASE, '--', 'src/app/api/affiliate', 'src/app/api/admin/identity', 'src/app/api/recruiter', 'src/lib/middleware']).split('\n').filter(Boolean);
  ok('no file changed under the affiliate API, the admin identity API, the recruiter API or the middleware', dirs.length === 0, dirs.join(','));
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
