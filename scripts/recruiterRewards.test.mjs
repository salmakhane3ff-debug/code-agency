#!/usr/bin/env node
/**
 * scripts/recruiterRewards.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 5: recruiter REWARDS (settings, qualification,
 * immediate award, ledger) and WITHDRAWALS through the existing payout workflow
 * (affiliate_payouts rows owned by a recruiter). In-memory fake database only
 * (scripts/lib/recruiterFakeDb.mjs, phase5 mode) — never a real database.
 * Proves:
 *   • qualification = real delivered orders (status 'delivered' AND isFake false) ≥ the
 *     threshold AND identity APPROVED; fake / non-delivered / 'Delivered' never count;
 *     isActive and UGC never matter; disabled / zero-amount settings award nothing
 *   • settings: defaults, validation, consecutive audited versions, future-only effect,
 *     a lowered threshold awards the newly qualifying affiliates on save
 *   • idempotency and concurrency: one RECRUIT_REWARD per affiliate (and cycle) whatever the events
 *   • hooks: REAL orders (any status since Phase 6 part 3a) / APPROVED identities, deferred in a tx,
 *     never throw; the admin routes only gained the hook lines (+ the payouts dispatch)
 *   (Phase 6 part 3a — reversals and cycles — is covered by scripts/recruiterRewardReversal.test.mjs.)
 *   • wallet math in exact MAD cents; withdrawals never exceed available (also concurrently),
 *     bank gate, idempotent replay, disabled recruiter refused
 *   • admin processing: pay / reject pending only, audited, releases funds on reject
 *   • isolation: own wallet only, auth wrappers, every payout query scoped by recruiterId
 *   • the affiliate payout / balance code is unchanged and never sees recruiter rows
 *   • Phase 6 part 5d — bounded reconcile: the candidates statement (binds in source order, drift
 *     guard), candidate selection, equivalence with the pre-5d reconcile (7e111e1) on randomized
 *     datasets, keyset batches (0 / 1 / 999 / 1000 / 1001, batchSize 7, restart / retry), the
 *     platform lease (409 RECONCILE_BUSY, released on error), financial invariants under concurrent
 *     runs, wallet GET without full-scope reads, the admin cursor contract
 * Run: node scripts/recruiterRewards.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-rewards-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const RS = await import('../src/lib/services/recruiterRewardService.js');
const WS = await import('../src/lib/services/recruiterWalletService.js');
const HK = await import('../src/lib/recruiterRewardHooks.js');
const { recruiterWalletHandlers, RECRUITER_WALLET_RATE } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const { recruiterRewardAdminHandlers } = await import('../src/lib/recruiterRewardAdminHandlers.js');
const V = await import('../src/lib/recruiterVisibility.js');
const ASYS = await import('../src/lib/services/affiliateSystemService.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const { rateLimit: realRateLimit } = await import('../src/lib/rateLimit.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const big = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return `git error ${e.status}`; } };
const PHASE4_HEAD = '47d32547b2d2449113e0a9798240d2118075decf';

const T0 = new Date('2026-11-06T10:00:00.000Z');
const now = () => new Date(T0);
const noLimit = () => null;
const errBody = (b) => b && typeof b === 'object' && (eq(keys(b), ['code']) || eq(keys(b), ['code', 'fields'])) && !('message' in b) && !('error' in b);

const recruiterCookie = (r) => `recruiter_token=${signToken({ recruiterId: r.id, username: r.username, type: 'recruiter' })}`;
const adminCookie = () => `auth_token=${signToken({ userId: 'admin-1', email: 'admin@example.test', role: 'ADMIN' })}`;
const req = (url, { method = 'GET', body, cookie, raw, ip } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (ip) headers['x-forwarded-for'] = ip;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
};
const call = async (handler, r) => {
  const res = await handler(r, {});
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, cache: res.headers.get('cache-control') };
};

let uniq = 0;
function setup({ failOnce = {}, settings = { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 } } = {}) {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ phase5: true, failOnce, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  if (settings) db._seed.settings(settings);
  // Phase 6 part 3c: a withdrawal needs the recruiter's KYC APPROVED — both recruiters are verified
  // here (the KYC gate itself is covered by scripts/recruiterIdentity.test.mjs).
  for (const r of [A, B]) db._seed.recruiterIdentity({ recruiterId: r.id, status: 'APPROVED' });
  return { db, A, B, hookBox };
}
/** An affiliate linked to `rec` (seeded: created earlier by the recruiter). */
function aff(db, rec, extra = {}) {
  const a = db._seed.affiliate({ username: `aff${++uniq}`, name: `Affilié ${uniq}`, isActive: false, ...extra });
  if (rec) db._seed.link({ affiliateId: a.id, recruiterId: rec.id });
  return a;
}
function orders(db, a, n, extra = {}) { const out = []; for (let i = 0; i < n; i++) out.push(db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: false, ...extra })); return out; }
const identity = (db, a, status = 'APPROVED') => db._seed.identity({ affiliateId: a.id, status });
const qualified = (db, rec, n = 10, extra = {}) => { const a = aff(db, rec, extra); orders(db, a, n); identity(db, a); return a; };
const ledger = (db, where = {}) => db._tables.recruiterRewardLedger.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
const audits = (db, action) => db._tables.recruiterAuditLog.filter((r) => r.action === action);
const award = (E, a) => RS.awardRecruiterRewardIfQualified(a.id, { db: E.db, now: T0 });
const silence = async (fn) => {
  const orig = console.error; const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { out: await fn(), lines }; } finally { console.error = orig; }
};

// ── 1. qualification ──────────────────────────────────────────────────────────
console.log('\n1. Qualification: real delivered orders ≥ threshold AND identity APPROVED');
{
  const E = setup();
  const a = qualified(E.db, E.A);
  const r = await award(E, a);
  const rows = ledger(E.db, { affiliateId: a.id });
  ok('10 real delivered + APPROVED → AWARDED', r.action === 'AWARDED', JSON.stringify(r));
  const L = rows[0];
  ok('exactly 1 ledger row: recruiter A, RECRUIT_REWARD, 15000 cents, settings v1, reason, SYSTEM actor (no actorId), cycle 1, key recruit:<id>:v1 (Phase 6 part 3a), T0',
    rows.length === 1 && L.recruiterId === E.A.id && L.type === 'RECRUIT_REWARD' && L.amountCents === 15000 && Number.isInteger(L.amountCents)
    && L.settingsVersion === 1 && L.reason === 'REAL_DELIVERED_AND_CIN_APPROVED' && L.actorType === 'SYSTEM' && L.actorId === null
    && L.idempotencyKey === `recruit:${a.id}:v1` && L.cycle === 1 && new Date(L.createdAt).getTime() === T0.getTime(), JSON.stringify(L, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  const au = audits(E.db, 'RECRUIT_REWARD_EARNED');
  ok('exactly 1 RECRUIT_REWARD_EARNED audit (SYSTEM, entity = the affiliate, cycle 1, real delivered 10 / required 10 / APPROVED / v1 / cents)',
    au.length === 1 && au[0].actorType === 'SYSTEM' && au[0].actorId === 'SYSTEM' && au[0].recruiterId === E.A.id && au[0].entityType === 'affiliate' && au[0].entityId === a.id
    && eq(au[0].details, { cycle: 1, amountCents: 15000, settingsVersion: 1, realDeliveredOrders: 10, requiredDeliveredOrders: 10, identityStatus: 'APPROVED' }), JSON.stringify(au[0]?.details));
  ok('the same affiliate again → NO_CHANGE (cycle 1 still open and still met — Phase 6 part 3a state-based sync), still 1 row', eq(await award(E, a), { action: 'NO_CHANGE', cycle: 1 }) && ledger(E.db, { affiliateId: a.id }).length === 1);

  const fake = aff(E.db, E.A); orders(E.db, fake, 9); orders(E.db, fake, 25, { isFake: true }); identity(E.db, fake);
  const rf = await award(E, fake);
  ok('9 real + 25 FAKE delivered → NOT_QUALIFIED (NOT_ENOUGH_SALES), no row', rf.action === 'NOT_QUALIFIED' && eq(rf.unmet, ['NOT_ENOUGH_SALES']) && ledger(E.db, { affiliateId: fake.id }).length === 0, JSON.stringify(rf));

  const mixed = aff(E.db, E.A); orders(E.db, mixed, 9); identity(E.db, mixed);
  for (const st of ['pending', 'confirmed', 'shipped', 'cancelled', 'returned', 'refused', 'Delivered', ' delivered', 'DELIVERED']) orders(E.db, mixed, 3, { status: st });
  const rm = await award(E, mixed);
  ok('9 real delivered + pending / confirmed / shipped / cancelled / returned / refused / "Delivered" / " delivered" / "DELIVERED" → NOT_QUALIFIED', rm.action === 'NOT_QUALIFIED' && eq(rm.unmet, ['NOT_ENOUGH_SALES']), JSON.stringify(rm));
  orders(E.db, mixed, 1);
  ok('…one more REAL delivered order → AWARDED (exactly the threshold)', (await award(E, mixed)).action === 'AWARDED');

  for (const [label, st] of [['PENDING', 'PENDING'], ['REJECTED', 'REJECTED'], ['missing', null], ['lower-case approved', 'approved']]) {
    const x = aff(E.db, E.A); orders(E.db, x, 15); if (st) identity(E.db, x, st);
    const rx = await award(E, x);
    ok(`identity ${label} → NOT_QUALIFIED (CIN_NOT_APPROVED), no row`, rx.action === 'NOT_QUALIFIED' && eq(rx.unmet, ['CIN_NOT_APPROVED']) && ledger(E.db, { affiliateId: x.id }).length === 0, JSON.stringify(rx));
  }
  const both = aff(E.db, E.A); orders(E.db, both, 3); identity(E.db, both, 'PENDING');
  ok('both conditions unmet → unmet lists both', eq((await award(E, both)).unmet, ['NOT_ENOUGH_SALES', 'CIN_NOT_APPROVED']));

  const inactive = qualified(E.db, E.A, 10, { isActive: false });
  const active = qualified(E.db, E.A, 10, { isActive: true });
  ok('an INACTIVE affiliate meeting both conditions qualifies (isActive is not a condition); an active one too',
    (await award(E, inactive)).action === 'AWARDED' && (await award(E, active)).action === 'AWARDED');
  E.db._tables.affiliate.find((x) => x.id === active.id).isActive = false;
  ok('deactivating an affiliate after the award changes nothing (row kept, amount kept)', ledger(E.db, { affiliateId: active.id }).length === 1 && ledger(E.db, { affiliateId: active.id })[0].amountCents === 15000);

  let ugcTouched = false;
  try { void E.db.ugcVideoSubmission; } catch { ugcTouched = true; }
  const u = qualified(E.db, E.A);
  ok('UGC: any UGC model access throws in this fake (isolation), and the award still works → the reward code never reads UGC', ugcTouched && (await award(E, u)).action === 'AWARDED');
  const svcSrc = stripJs(read('src/lib/services/recruiterRewardService.js'));
  ok('the reward service never reads UGC, isActive, deliveredOrdersCount or any money of the affiliate', !/ugc|isActive|deliveredOrdersCount|commission|balance|payout|rewardPoint/i.test(svcSrc));
  ok('the reward service counts actual order rows with status DELIVERED_ORDER_STATUS AND isFake: false',
    /status:\s*DELIVERED_ORDER_STATUS,\s*isFake:\s*false/.test(svcSrc) && /DELIVERED_ORDER_STATUS = 'delivered'/.test(read('src/lib/recruiterSettings.js')));

  const un = E.db._seed.affiliate({ username: 'unlinked1' }); orders(E.db, un, 20); identity(E.db, un);
  ok('an unlinked affiliate → NOT_LINKED (no row)', (await award(E, un)).action === 'NOT_LINKED' && ledger(E.db, { affiliateId: un.id }).length === 0);
  ok('a malformed / unknown id → NOT_LINKED', (await RS.awardRecruiterRewardIfQualified('bad id;', { db: E.db })).action === 'NOT_LINKED' && (await RS.awardRecruiterRewardIfQualified(randomUUID(), { db: E.db })).action === 'NOT_LINKED');

  const Off = setup({ settings: { version: 1, enabled: false, rewardAmountCents: 15000, minDeliveredSales: 10 } });
  const o1 = qualified(Off.db, Off.A);
  const ro = await award(Off, o1);
  ok('rewards disabled → NOT_QUALIFIED (REWARDS_DISABLED), no row', ro.action === 'NOT_QUALIFIED' && eq(ro.unmet, ['REWARDS_DISABLED']) && Off.db._tables.recruiterRewardLedger.length === 0);
  const Zero = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 0, minDeliveredSales: 10 } });
  const z1 = qualified(Zero.db, Zero.A);
  ok('amount 0 (even if enabled) → NO_AMOUNT, no row', eq((await award(Zero, z1)).unmet, ['NO_AMOUNT']) && Zero.db._tables.recruiterRewardLedger.length === 0);
  const None = setup({ settings: null });
  const n1 = qualified(None.db, None.A);
  ok('no settings version → defaults (OFF) → nothing', eq((await award(None, n1)).unmet, ['REWARDS_DISABLED']) && None.db._tables.recruiterRewardLedger.length === 0);
  // Phase 6 part 3a: the automatic reversal lives ONLY in the reward service (syncRecruiterReward, cycle
  // keys); the hooks and the wallet service never write one; nothing ever updates / deletes a ledger row.
  ok('a REVERSAL is written only by the reward service (with the cycle key, never the legacy reversalKey); hooks / wallet never write one; no ledger update / delete anywhere',
    /type: REWARD_TYPES\.REVERSAL, amountCents: -open\.amountCents, cycle: open\.cycle,/.test(svcSrc) && /idempotencyKey: reversalCycleKey\(affiliateId, open\.cycle\)/.test(svcSrc) && !/\breversalKey\b/.test(svcSrc)
    && !/REVERSAL|reversalKey|reversalCycleKey/.test(stripJs(read('src/lib/recruiterRewardHooks.js')))
    && !/reversalKey|reversalCycleKey|recruiterRewardLedger\.create/.test(stripJs(read('src/lib/services/recruiterWalletService.js')))
    && !/recruiterRewardLedger\.(update|updateMany|delete|deleteMany|upsert)/.test(svcSrc + stripJs(read('src/lib/recruiterRewardHooks.js')) + stripJs(read('src/lib/services/recruiterWalletService.js'))));
}

// ── 2. settings ───────────────────────────────────────────────────────────────
console.log('\n2. Settings: defaults, validation, audited consecutive versions, future-only effect');
{
  const E = setup({ settings: null });
  ok('defaults with no version: OFF, 0 MAD, 10 orders, version 0', eq(await RS.getCurrentRecruiterSettings({ db: E.db }), { version: 0, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10 }));
  const save = (input, actorId = 'admin-1') => RS.adminSaveRecruiterSettings(input, { db: E.db, actorId, now: T0 }).then((v) => ({ v }), (e) => ({ e }));
  ok('no admin actor → UNAUTHORIZED', (await save({ enabled: true, rewardAmountMad: '10' }, null)).e?.code === 'UNAUTHORIZED');
  const bad = [
    [{ enabled: true, rewardAmountMad: 'abc' }, { rewardAmountMad: 'INVALID_AMOUNT' }],
    [{ enabled: true, rewardAmountMad: '0' }, { rewardAmountMad: 'AMOUNT_REQUIRED_WHEN_ENABLED' }],
    [{ enabled: true, rewardAmountMad: '10.123' }, { rewardAmountMad: 'INVALID_AMOUNT' }],
    [{ enabled: true, rewardAmountMad: '-5' }, { rewardAmountMad: 'INVALID_AMOUNT' }],
    [{ enabled: true, rewardAmountMad: '10', minDeliveredSales: 0 }, { minDeliveredSales: 'INVALID_COUNT' }],
    [{ enabled: true, rewardAmountMad: '10', minDeliveredSales: 100001 }, { minDeliveredSales: 'INVALID_COUNT' }],
    [{ enabled: true, rewardAmountMad: '10', minDeliveredSales: 2.5 }, { minDeliveredSales: 'INVALID_COUNT' }],
  ];
  const results = [];
  for (const [input, errors] of bad) { const r = await save(input); results.push(r.e?.code === 'INVALID_INPUT' && eq(r.e.errors, errors)); }
  ok('invalid settings → INVALID_INPUT with the exact field errors (amount format / required when enabled / threshold 1–100000)', results.every(Boolean), JSON.stringify(results));
  ok('nothing written by the invalid attempts', E.db._tables.recruiterSettingsVersion.length === 0 && audits(E.db, 'RECRUITER_SETTINGS_CHANGED').length === 0);

  const v1 = await save({ enabled: true, rewardAmountMad: '150.50', minDeliveredSales: 10 });
  // Phase 7: the saved version also carries the 4 group-reward fields (defaults OFF, 0, 10, 10 when not given).
  ok('save → version 1, 150.50 MAD stored as 15050 cents', eq(v1.v, { version: 1, enabled: true, rewardAmountCents: 15050, minDeliveredSales: 10, groupEnabled: false, groupRewardAmountCents: 0, groupSize: 10, groupMinDeliveredSales: 10 }), JSON.stringify(v1));
  const au = audits(E.db, 'RECRUITER_SETTINGS_CHANGED');
  ok('audited: RECRUITER_SETTINGS_CHANGED by the ADMIN (no recruiter), entity = the version, details = the values',
    au.length === 1 && au[0].actorType === 'ADMIN' && au[0].actorId === 'admin-1' && au[0].recruiterId === null && au[0].entityId === '1'
    // Phase 7: the values of both reward types + the previous version's values (null for the first version)
    && eq(au[0].details, { version: 1, enabled: true, rewardAmountCents: 15050, minDeliveredSales: 10, groupEnabled: false, groupRewardAmountCents: 0, groupSize: 10, groupMinDeliveredSales: 10, previous: null }));
  const a1 = qualified(E.db, E.A);
  await award(E, a1);
  const v2 = await save({ enabled: true, rewardAmountMad: '99', minDeliveredSales: 3 });
  ok('next save → version 2 (consecutive)', v2.v?.version === 2 && eq(E.db._tables.recruiterSettingsVersion.map((r) => r.version), [1, 2]));
  const first = ledger(E.db, { affiliateId: a1.id })[0];
  ok('a change affects FUTURE awards only: the earlier reward keeps 15050 cents and version 1', first.amountCents === 15050 && first.settingsVersion === 1);
  const a2 = aff(E.db, E.A); orders(E.db, a2, 3); identity(E.db, a2);
  await award(E, a2);
  const second = ledger(E.db, { affiliateId: a2.id })[0];
  ok('a new award uses the current version: 9900 cents, version 2, threshold 3', second?.amountCents === 9900 && second?.settingsVersion === 2);
  const hist = await RS.listRecruiterSettingsVersions({ db: E.db });
  ok('history newest first with createdBy', eq(hist.map((h) => h.version), [2, 1]) && hist.every((h) => h.createdBy === 'admin-1'));
  let appendOnly = false;
  try { await E.db.recruiterSettingsVersion.update({ where: { version: 1 }, data: { rewardAmountCents: 1 } }); } catch { appendOnly = true; }
  ok('settings versions are append-only (update refused)', appendOnly);

  // lowering the threshold through the admin handler awards the newly qualifying affiliates
  const F = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 5000, minDeliveredSales: 10 } });
  const five = []; for (let i = 0; i < 4; i++) { const x = aff(F.db, i % 2 ? F.B : F.A); orders(F.db, x, 5); identity(F.db, x); five.push(x); }
  const notYet = aff(F.db, F.A); orders(F.db, notYet, 4); identity(F.db, notYet);
  const admin = recruiterRewardAdminHandlers({ db: F.db, now });
  const resp = await call(withAdminAuth(admin.saveSettings), req('/api/admin/recruiter-rewards/settings', { method: 'POST', cookie: adminCookie(), body: { enabled: true, rewardAmountMad: '50', minDeliveredSales: 5 } }));
  ok('lowering the threshold 10 → 5: the save answers 201 with the new version and reconciles (4 newly qualifying, across both recruiters)',
    resp.status === 201 && resp.body.settings.version === 2 && resp.body.reconcile?.awarded === 4, resp.text);
  ok('…each of them has exactly one reward (5000 cents, v2), the 4-order one none', five.every((x) => ledger(F.db, { affiliateId: x.id }).length === 1 && ledger(F.db, { affiliateId: x.id })[0].settingsVersion === 2) && ledger(F.db, { affiliateId: notYet.id }).length === 0);
  const badResp = await call(withAdminAuth(admin.saveSettings), req('/api/admin/recruiter-rewards/settings', { method: 'POST', cookie: adminCookie(), body: { enabled: true, rewardAmountMad: 'x' } }));
  ok('invalid save via the handler → 400 with the field errors and a fixed French text', badResp.status === 400 && badResp.body.code === 'INVALID_INPUT' && badResp.body.errors?.rewardAmountMad === 'INVALID_AMOUNT' && badResp.body.error === 'Données invalides.');
  const nonObj = await call(withAdminAuth(admin.saveSettings), req('/api/admin/recruiter-rewards/settings', { method: 'POST', cookie: adminCookie(), raw: '[1]' }));
  ok('a non-object body → 400 INVALID_INPUT', nonObj.status === 400 && nonObj.body.code === 'INVALID_INPUT');

  // concurrent admin saves: versions stay consecutive (no gap, no duplicate)
  const C = setup({ settings: null });
  const conc = await Promise.all([1, 2, 3].map((i) => RS.adminSaveRecruiterSettings({ enabled: true, rewardAmountMad: String(i), minDeliveredSales: 10 }, { db: C.db, actorId: 'admin-x' }).then(() => 'ok', (e) => e.code)));
  const vs = C.db._tables.recruiterSettingsVersion.map((r) => r.version).sort((x, y) => x - y);
  ok('3 concurrent admin saves ALL succeed with versions exactly 1, 2, 3 (the service takes the trigger\'s advisory lock before reading the last version)',
    conc.every((r) => r === 'ok') && eq(vs, [1, 2, 3]), `results=${conc} versions=${vs}`);
}

// ── 3. idempotency and concurrency ────────────────────────────────────────────
console.log('\n3. Idempotency and concurrency: one reward per affiliate whatever the events');
{
  const E = setup();
  const a = qualified(E.db, E.A);
  const o = E.db._tables.affiliateOrder.find((x) => x.affiliateId === a.id);
  const idv = E.db._tables.identityVerification.find((x) => x.affiliateId === a.id);
  for (let i = 0; i < 3; i++) { await HK.onRecruiterOrderStatusCommitted(o.id, { db: E.db }); await HK.onRecruiterIdentityApprovedCommitted(idv.id, { db: E.db }); await award(E, a); }
  ok('repeated hook calls and awards → exactly 1 row and 1 audit', ledger(E.db, { affiliateId: a.id }).length === 1 && audits(E.db, 'RECRUIT_REWARD_EARNED').length === 1);

  const C = setup();
  const b = qualified(C.db, C.A);
  const bo = C.db._tables.affiliateOrder.find((x) => x.affiliateId === b.id);
  const bi = C.db._tables.identityVerification.find((x) => x.affiliateId === b.id);
  const res = await Promise.all([
    ...Array.from({ length: 10 }, () => RS.awardRecruiterRewardIfQualified(b.id, { db: C.db })),
    HK.onRecruiterOrderStatusCommitted(bo.id, { db: C.db }), HK.onRecruiterIdentityApprovedCommitted(bi.id, { db: C.db }),
    HK.onRecruiterOrderStatusCommitted(bo.id, { db: C.db }), HK.onRecruiterIdentityApprovedCommitted(bi.id, { db: C.db }),
    RS.reconcileRecruiterRewards({ db: C.db }), RS.reconcileRecruiterRewards({ db: C.db, recruiterId: C.A.id }),
  ]);
  const actions = res.map((r) => r.action ?? `reconcile:${r.awarded}`);
  const awardedCount = actions.filter((x) => x === 'AWARDED').length + res.filter((r) => r.awarded).reduce((t, r) => t + r.awarded, 0);
  ok('16 concurrent events (10 awards, 4 hooks, 2 reconciles) → exactly 1 row, 1 audit, exactly 1 event reports the award',
    ledger(C.db, { affiliateId: b.id }).length === 1 && audits(C.db, 'RECRUIT_REWARD_EARNED').length === 1 && awardedCount === 1, actions.join(','));
  ok('…every other event reports NO_CHANGE (or a reconcile with 0 awarded)', actions.filter((x) => x !== 'AWARDED').every((x) => x === 'NO_CHANGE' || /^reconcile:0$/.test(x)), actions.join(','));

  // below the service (Phase 6 part 3a): a forced second cycle-1 reward is refused — the BEFORE INSERT cycle
  // guard fires first (cycle must be 2, and cycle 1 is not reversed) for the same key and for the legacy key
  // the cycle CHECK accepts for cycle 1; a free-form key → the cycle-key CHECK. (The per-cycle unique
  // indexes stay as the last line behind the guard.)
  const force = (data) => C.db.$transaction(async (tx) => tx.recruiterRewardLedger.create({ data: { recruiterId: C.A.id, affiliateId: b.id, type: 'RECRUIT_REWARD', amountCents: 1, actorType: 'SYSTEM', settingsVersion: 1, cycle: 1, ...data } })).then(() => 'written', (e) => e.meta?.constraint ?? e.code);
  const dupSame = await force({ idempotencyKey: `recruit:${b.id}:v1` });
  const dupLegacy = await force({ idempotencyKey: `recruit:${b.id}` });
  const dupFree = await force({ idempotencyKey: 'another-key' });
  ok('one RECRUIT_REWARD per affiliate and cycle is also enforced below the service (same key / legacy key → cycle guard P2010; another key → cycle-key CHECK)',
    dupSame === 'P2010' && dupLegacy === 'P2010' && dupFree === 'recruiter_reward_ledger_cycle_check' && ledger(C.db, { affiliateId: b.id }).length === 1, JSON.stringify([dupSame, dupLegacy, dupFree]));
  let guard = null;
  const other = qualified(C.db, C.A);
  try {
    await C.db.$transaction(async (tx) => tx.recruiterRewardLedger.create({ data: { recruiterId: C.B.id, affiliateId: other.id, type: 'RECRUIT_REWARD', amountCents: 1, idempotencyKey: `recruit:${other.id}:v1`, cycle: 1, actorType: 'SYSTEM', settingsVersion: 1 } }));
  } catch (e) { guard = e; }
  // Stage E: the guard (20261112) checks owner(affiliate) = the row's recruiter — its message names the network.
  ok('a reward credited to a recruiter who is not the affiliate\'s (owner) → refused by the link guard', guard?.code === 'P2010' && /is not in the network of recruiter/.test(guard?.message));

  // an injected failure in the audit insert rolls the reward back; the next event awards it
  const F = setup({ failOnce: { 'recruiterAuditLog.create': true } });
  const f = qualified(F.db, F.A);
  const failed = await RS.awardRecruiterRewardIfQualified(f.id, { db: F.db }).then(() => 'ok', () => 'threw');
  ok('a failure inside the award transaction leaves no ledger row and no audit (atomic)', failed === 'threw' && F.db._tables.recruiterRewardLedger.length === 0 && F.db._tables.recruiterAuditLog.length === 0);
  ok('…and the next event awards it', (await RS.awardRecruiterRewardIfQualified(f.id, { db: F.db })).action === 'AWARDED');

  // reconcile: idempotent, scoped and batched
  const R = setup();
  const q = [qualified(R.db, R.A), qualified(R.db, R.A), qualified(R.db, R.B)];
  const nq = aff(R.db, R.A); orders(R.db, nq, 2); identity(R.db, nq);
  const scoped = await RS.reconcileRecruiterRewards({ db: R.db, recruiterId: R.A.id });
  ok('reconcile scoped to recruiter A awards only A\'s 2 qualifying affiliates', scoped.awarded === 2 && ledger(R.db, { affiliateId: q[2].id }).length === 0, JSON.stringify(scoped));
  const all = await RS.reconcileRecruiterRewards({ db: R.db });
  const again = await RS.reconcileRecruiterRewards({ db: R.db });
  ok('reconcile of everyone then awards B\'s; a second run awards nothing (idempotent)', all.awarded === 1 && again.awarded === 0 && R.db._tables.recruiterRewardLedger.length === 3, JSON.stringify({ all, again }));
  ok('reconcile with a malformed recruiterId → UNAUTHORIZED', await RS.reconcileRecruiterRewards({ db: R.db, recruiterId: 'x y' }).then(() => false, (e) => e.code === 'UNAUTHORIZED'));
  const off = setup({ settings: { version: 1, enabled: false, rewardAmountCents: 100, minDeliveredSales: 1 } });
  qualified(off.db, off.A);
  const before = off.db._queryCount();
  const logAt = off.db._log.length;
  const ro = await RS.reconcileRecruiterRewards({ db: off.db });
  // Phase 6 part 3a: the REVERSAL pass runs even with rewards OFF. Phase 6 part 5d: the reads are the
  // reconcile lease, the settings and ONE candidate statement per keyset batch (reversal candidates
  // always; award candidates only when rewards are on) — no link / ledger / order read in the
  // application, no identity read, no write.
  const offCalls = off.db._log.slice(logAt).filter((l) => l.model !== '$transaction').map((l) => (l.model === '$queryRaw' ? (/pg_try_advisory_xact_lock/.test(l.sql) ? 'lease' : /^\s*\/\* recruiter-reward-candidates \*\//.test(l.sql) ? 'candidates' : l.sql) : `${l.model}.${l.op}`));
  // Phase 7: + ONE constant read at the end of the run — does any group reward exist (group rewards off →
  // the group pass runs only when a group reward could need a reversal; here none → no group pass).
  ok('rewards OFF → reconcile awards nothing (4 statements: the lease, the settings, ONE candidate statement, the Phase 7 "any group reward" probe — no identity read, no write)',
    eq(ro, { checked: 1, awarded: 0, reversed: 0, unchanged: 0, candidates: 0, batches: 1, cursor: null, hasMore: false, busy: false, groupChecked: 0, groupAwarded: 0, groupReversed: 0 }) && off.db._queryCount() - before === 4
    && eq(offCalls, ['lease', 'recruiterSettingsVersion.findFirst', 'candidates', 'recruiterRewardLedger.findFirst']) && off.db._tables.recruiterRewardLedger.length === 0, `${JSON.stringify(ro)} q=${off.db._queryCount() - before} ${offCalls}`);

  const queries = async (n, qualify) => {
    const S = setup();
    for (let i = 0; i < n; i++) { const x = aff(S.db, i % 2 ? S.A : S.B); orders(S.db, x, qualify ? 10 : 2); identity(S.db, x); }
    const b0 = S.db._queryCount();
    const r = await RS.reconcileRecruiterRewards({ db: S.db });
    return { q: S.db._queryCount() - b0, r };
  };
  const q10 = await queries(10, false), q300 = await queries(300, false);
  // Phase 6 part 5d: lease, settings, ONE candidate statement per batch of ≤ 1000 links (identity is
  // read only for award candidates).
  ok('no N+1: reconcile over 10 and 300 non-qualifying affiliates issues the same number of queries (4: lease, settings, one candidate statement, the Phase 7 group probe)', q10.q === q300.q && q10.q === 4 && q10.r.checked === 10 && q300.r.checked === 300 && q300.r.batches === 1, `10→${q10.q} 300→${q300.q}`);
  const w20 = await queries(20, true);
  // Phase 6 part 3a: each award is one syncRecruiterReward transaction that re-reads every fact under the
  // per-affiliate lock: link, lock, ledger, count, settings, affiliate, identity + 2 writes (ledger + audit) = 9.
  // Phase 6 part 5d: base = lease, settings, one candidate statement, ONE identity read of the batch's award candidates.
  ok('with awards: exactly base (5, incl. the batched identity read and the Phase 7 group probe) + 9 statements per awarded affiliate (re-check under the lock + ledger + audit)', w20.r.awarded === 20 && w20.r.candidates === 20 && w20.q === 5 + 9 * 20, `q=${w20.q} awarded=${w20.r.awarded}`);
  const q6k = await queries(6000, false);
  // Phase 6 part 5d: keyset batches of 1000 links — 6 full batches, then a 7th that scans nothing and ends the run.
  ok('6000 affiliates: 7 keyset batches of ≤ 1000 (6 full + 1 empty end) → lease, settings, 7 candidate statements (no candidate → no identity read), the Phase 7 group probe',
    q6k.q === 10 && q6k.r.checked === 6000 && q6k.r.batches === 7 && q6k.r.hasMore === false && q6k.r.cursor === null, `q=${q6k.q} ${JSON.stringify(q6k.r)}`);
}

// ── 4. hooks ──────────────────────────────────────────────────────────────────
console.log('\n4. Hooks: only a REAL delivered order / an APPROVED identity, deferred in a tx, never throw');
{
  const E = setup();
  const a = aff(E.db, E.A); orders(E.db, a, 9); identity(E.db, a);
  const fakeO = E.db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: true });
  const pend = E.db._seed.order({ affiliateId: a.id, status: 'shipped', isFake: false });
  ok('a FAKE delivered order → IGNORED (never counted, no award)', (await HK.onRecruiterOrderStatusCommitted(fakeO.id, { db: E.db })).action === 'IGNORED' && ledger(E.db).length === 0);
  // Phase 6 part 3a: ANY status change of a REAL order re-synchronises (a non-delivered one may reverse).
  ok('a non-delivered real order → re-synchronised: NOT_QUALIFIED (9 real delivered), no row', eq(await HK.onRecruiterOrderStatusCommitted(pend.id, { db: E.db }), { action: 'NOT_QUALIFIED', unmet: ['NOT_ENOUGH_SALES'] }) && ledger(E.db).length === 0);
  ok('an unknown or malformed order id → IGNORED', (await HK.onRecruiterOrderStatusCommitted(randomUUID(), { db: E.db })).action === 'IGNORED' && (await HK.onRecruiterOrderStatusCommitted({ id: 1 }, { db: E.db })).action === 'IGNORED');
  const tenth = E.db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: false });
  ok('the 10th REAL delivered order (admin set it delivered) → the order hook AWARDS immediately', (await HK.onRecruiterOrderStatusCommitted(tenth.id, { db: E.db })).action === 'AWARDED' && ledger(E.db, { affiliateId: a.id }).length === 1);

  const b = aff(E.db, E.A); orders(E.db, b, 12); const bi = identity(E.db, b, 'PENDING');
  ok('identity hook on a PENDING row → IGNORED', (await HK.onRecruiterIdentityApprovedCommitted(bi.id, { db: E.db })).action === 'IGNORED');
  E.db._tables.identityVerification.find((x) => x.id === bi.id).status = 'APPROVED';
  ok('identity hook after the admin approval → AWARDED', (await HK.onRecruiterIdentityApprovedCommitted(bi.id, { db: E.db })).action === 'AWARDED');
  ok('identity hook with an unknown / malformed id → IGNORED', (await HK.onRecruiterIdentityApprovedCommitted(randomUUID(), { db: E.db })).action === 'IGNORED' && (await HK.onRecruiterIdentityApprovedCommitted('', { db: E.db })).action === 'IGNORED');

  const txLike = { affiliateOrder: E.db.affiliateOrder }; // a transaction client has no $transaction
  const throwing = new Proxy({}, { get(_t, p) { if (p === '$transaction') throw new Error('denied'); return undefined; } });
  ok('both hooks return DEFERRED for a transaction client (no $transaction / an accessor that throws)',
    (await HK.onRecruiterOrderStatusCommitted(tenth.id, { db: txLike })).action === 'DEFERRED' && (await HK.onRecruiterIdentityApprovedCommitted(bi.id, { db: throwing })).action === 'DEFERRED');

  const F = setup({ failOnce: { 'affiliateOrder.findUnique': true, 'identityVerification.findUnique': true } });
  const fa = qualified(F.db, F.A);
  const fo = F.db._tables.affiliateOrder.find((x) => x.affiliateId === fa.id);
  const fi = F.db._tables.identityVerification.find((x) => x.affiliateId === fa.id);
  const s1 = await silence(() => HK.onRecruiterOrderStatusCommitted(fo.id, { db: F.db }));
  const s2 = await silence(() => HK.onRecruiterIdentityApprovedCommitted(fi.id, { db: F.db }));
  ok('an injected database failure → the hooks return ERROR (never throw) and log a code only', s1.out.action === 'ERROR' && s2.out.action === 'ERROR' && s1.lines.length === 1 && s2.lines.length === 1 && !/injected/.test(s1.lines.join() + s2.lines.join()), JSON.stringify([s1, s2]));
  const s3 = await silence(() => HK.onRecruiterOrderStatusCommitted(fo.id, { db: F.db, award: async () => { throw new Error('boom'); } }));
  ok('a throwing award → ERROR, not thrown', s3.out.action === 'ERROR');

  // the admin routes: ONLY the hook lines were added, after the committed write
  const routeDiff = (file) => git(['diff', PHASE4_HEAD, '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  // Phase 6 part 3a: the post-write call is unconditional (every status change re-synchronises).
  ok('admin affiliate-orders route: only the hook import, its comment and the UNCONDITIONAL post-write call were added (nothing removed)',
    eq(routeDiff('src/app/api/admin/affiliate-orders/route.js'), [
      "+import { onRecruiterOrderStatusCommitted } from '@/lib/recruiterRewardHooks';",
      "+    // Recruiter reward (post-commit, never throws): re-synchronised after EVERY status change —",
      "+    // a delivery may award a cycle, a cancellation / return may reverse it (Phase 6 part 3a).",
      "+    await onRecruiterOrderStatusCommitted(String(orderId));",
    ]), JSON.stringify(routeDiff('src/app/api/admin/affiliate-orders/route.js')));
  const ord = read('src/app/api/admin/affiliate-orders/route.js');
  ok('…the hook runs AFTER adminUpdateAffiliateOrderStatus resolved (post-commit)', ord.indexOf('await adminUpdateAffiliateOrderStatus(orderId, status)') < ord.indexOf('await onRecruiterOrderStatusCommitted('));
  ok('admin identity route: only the hook import and the approve branch around the unchanged adminApproveIdentity call',
    eq(routeDiff('src/app/api/admin/identity/route.js'), [
      "+import { onRecruiterIdentityApprovedCommitted } from '@/lib/recruiterRewardHooks';",
      '-      return Response.json(await adminApproveIdentity(id, adminId));',
      '+      const approved = await adminApproveIdentity(id, adminId);',
      "+      // Recruiter reward (post-commit, never throws): the affiliate's CIN is now APPROVED.",
      '+      await onRecruiterIdentityApprovedCommitted(String(id));',
      '+      return Response.json(approved);',
    ]), JSON.stringify(routeDiff('src/app/api/admin/identity/route.js')));
  const pay = routeDiff('src/app/api/admin/affiliate-payouts/route.js');
  const removed = pay.filter((l) => l.startsWith('-'));
  ok('admin payouts route: the only removed lines are the 2 header lines, the GET list line and the PUT signature / body parsing (replaced, not deleted)',
    eq(removed, ['- * GET  → all payout requests', '- * PUT  → approve payout (mark as paid)', '-    const payouts = await adminGetAllPayouts();', '-async function putHandler(req) {', '-    const { id, _id } = await req.json();']), JSON.stringify(removed));
  const paySrc = stripJs(read('src/app/api/admin/affiliate-payouts/route.js'));
  ok('…the affiliate path is unchanged: a non-recruiter row still goes to adminApprovePayout(payoutId); GET still uses adminGetAllPayouts; both withAdminAuth',
    /if \(await recruiterPayoutOwner\(String\(payoutId\)\)\) \{\s*return recruiterAdmin\.payoutAction\(/.test(paySrc)
    && /if \(action === 'reject'\) return Response\.json\(\{ error: 'Action non supportée pour ce retrait' \}, \{ status: 400 \}\);\s*const result = await adminApprovePayout\(payoutId\);/.test(paySrc)
    && /adminGetAllPayouts\(\)/.test(paySrc) && /export const GET = withAdminAuth\(getHandler\)/.test(paySrc) && /export const PUT = withAdminAuth\(putHandler\)/.test(paySrc));
  ok('…the recruiter dispatch happens BEFORE any affiliate approval (owner check first), reject only for recruiter rows',
    paySrc.indexOf('recruiterPayoutOwner(') < paySrc.indexOf('adminApprovePayout(payoutId)') && paySrc.indexOf("action === 'reject' ? 'reject' : 'pay'") > 0);
}

// ── 5. wallet math ────────────────────────────────────────────────────────────
console.log('\n5. Wallet math in exact MAD cents');
{
  const E = setup();
  const a1 = aff(E.db, E.A), a2 = aff(E.db, E.A), b1 = aff(E.db, E.B);
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: a1.id, type: 'RECRUIT_REWARD', amountCents: 15055, settingsVersion: 1, idempotencyKey: `recruit:${a1.id}` });
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: a2.id, type: 'RECRUIT_REWARD', amountCents: 10, settingsVersion: 1, idempotencyKey: `recruit:${a2.id}` });
  E.db._seed.ledger({ recruiterId: E.B.id, affiliateId: b1.id, type: 'RECRUIT_REWARD', amountCents: 777700, settingsVersion: 1, idempotencyKey: `recruit:${b1.id}` });
  const p = (amount, status, extra = {}) => E.db._seed.payout({ recruiterId: E.A.id, amount, status, ...extra });
  p(10.10, 'pending'); p(20.20, 'paid'); p(30, 'rejected'); p(5, 'cancelled'); p(2.5, 'processing'); p(1, 'refused'); p(0.1, 'paid'); p(0.2, 'pending');
  E.db._seed.payout({ recruiterId: E.B.id, amount: 9999, status: 'pending' });
  const af = E.db._seed.affiliate({ username: 'payee' });
  E.db._seed.payout({ affiliateId: af.id, amount: 4444, status: 'pending' });
  const w = await WS.getRecruiterWallet(E.A.id, { db: E.db });
  // reserved = 10.10 + 20.20 + 2.50 + 0.10 + 0.20 = 33.10 ; paid = 20.30 ; earned = 150.65
  ok('earned 15065 / reserved 3310 / paid 2030 / pending 1280 / available 11755 cents (rejected / cancelled / refused released; unknown "processing" reserved; B and affiliate rows excluded)',
    eq(w.totals, { earnedCents: 15065, reservedCents: 3310, paidCents: 2030, pendingCents: 1280, availableCents: 11755 }), JSON.stringify(w.totals));
  const X = setup();
  const xa = aff(X.db, X.A);
  X.db._seed.ledger({ recruiterId: X.A.id, affiliateId: xa.id, type: 'RECRUIT_REWARD', amountCents: 100_000_000, settingsVersion: 1, idempotencyKey: `recruit:${xa.id}` });
  for (const amt of [0.1, 0.2, 150.55, 999999.99, 0.29, 1.005 - 0.005]) X.db._seed.payout({ recruiterId: X.A.id, amount: amt, status: 'pending' });
  const xw = await WS.getRecruiterWallet(X.A.id, { db: X.db });
  ok('cents are exact for 0.10, 0.20, 150.55, 999999.99, 0.29 and 1.00 (no float drift)', xw.totals.reservedCents === 10 + 20 + 15055 + 99999999 + 29 + 100 && eq(xw.withdrawals.map((x) => x.amountCents).sort((m, n) => m - n), [10, 20, 29, 100, 15055, 99999999]), JSON.stringify(xw.totals));
  ok('the wallet returns ONLY recruiter A\'s rows (3 ledger rows of A; B\'s and the affiliate\'s withdrawals absent)',
    w.rewards.length === 2 && w.withdrawals.length === 8 && !w.withdrawals.some((x) => x.amountCents === 999900 || x.amountCents === 444400));
  const v = V.toRecruiterWalletView(w);
  ok('wallet view: exact keys (settings, totals, rewards, withdrawals, bank), totals in cents + MAD, statuses PENDING / PAID / REJECTED only',
    eq(keys(v), ['bank', 'rewards', 'settings', 'totals', 'withdrawals']) && eq(keys(v.totals), ['availableCents', 'currency', 'earnedCents', 'paidCents', 'pendingCents'])
    && v.withdrawals.every((x) => ['PENDING', 'PAID', 'REJECTED'].includes(x.status)) && v.withdrawals.filter((x) => x.status === 'REJECTED').length === 3);
  ok('reward history shows which affiliate (id / username / name) and why (reason + threshold of the version used) and the cycle', await (() => {
    const s = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 7 } });
    const q = aff(s.db, s.A); orders(s.db, q, 7); identity(s.db, q);
    return award(s, q).then(() => WS.getRecruiterWallet(s.A.id, { db: s.db })).then((ww) => {
      const h = V.toRecruiterWalletView(ww).rewards[0];
      return eq(h, { type: 'RECRUIT_REWARD', amountCents: 15000, currency: 'MAD', affiliate: { id: q.id, username: q.username, name: q.name }, reason: 'REAL_DELIVERED_AND_CIN_APPROVED', requiredDeliveredOrders: 7, cycle: 1, createdAt: T0.toISOString() });
    });
  })());
}

// ── 6. withdrawals through the handlers ──────────────────────────────────────
console.log('\n6. Withdrawals: never above available, bank gate, replay, concurrency, disabled recruiter');
{
  const env = ({ earnedCents = 20000, bank = true, rateLimit = noLimit, failOnce = {} } = {}) => {
    const E = setup({ failOnce });
    const a = aff(E.db, E.A);
    if (earnedCents) E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: earnedCents, settingsVersion: 1, idempotencyKey: `recruit:${a.id}` });
    if (bank) Object.assign(E.db._tables.recruiter.find((r) => r.id === E.A.id), { bankName: 'CIH Bank', accountName: 'Recruteur A', rib: '011780000012345678901234' });
    const h = recruiterWalletHandlers({ db: E.db, now, rateLimit });
    E.wallet = withRecruiterAuth(h.wallet); E.bank = withRecruiterAuth(h.bank); E.withdraw = withRecruiterAuth(h.withdraw);
    return E;
  };
  const post = (E, rec, body, extra = {}) => call(E.withdraw, req('/api/recruiter/wallet/withdrawals', { method: 'POST', body, cookie: recruiterCookie(rec), ...extra }));
  const mk = (amountMad, requestId = randomUUID()) => ({ amountMad, requestId });
  const snapshot = (db) => ({ p: db._tables.affiliatePayout.length, a: db._tables.recruiterAuditLog.length });
  const errors = [];
  const track = (r) => { if (r.status >= 400) errors.push(r); return r; };

  const N = env({ bank: false });
  const s0 = snapshot(N.db);
  const nb = track(await post(N, N.A, mk('10')));
  ok('no bank details → 400 INCOMPLETE_BANK_INFO, nothing written', nb.status === 400 && eq(nb.body, { code: 'INCOMPLETE_BANK_INFO' }) && eq(snapshot(N.db), s0), `${nb.status} ${nb.text}`);

  const E = env();
  const s1 = snapshot(E.db);
  const invalids = ['0', '-5', 'abc', '1.234', '100000000.01', '', null, 12.345, '1e3'];
  const inv = [];
  for (const x of invalids) inv.push(track(await post(E, E.A, mk(x))));
  ok('invalid amounts (0 / negative / text / 3 decimals / above 1,000,000 / empty / null / 12.345 / exponent) → 400 INVALID_INPUT fields.amountMad INVALID_AMOUNT',
    inv.every((r) => r.status === 400 && eq(r.body, { code: 'INVALID_INPUT', fields: { amountMad: 'INVALID_AMOUNT' } })), inv.map((r) => r.text).join(' | '));
  const noReq = track(await post(E, E.A, { amountMad: '5' }));
  const badReq = track(await post(E, E.A, { amountMad: '5', requestId: 'abc' }));
  const extraKey = track(await post(E, E.A, { amountMad: '5', requestId: randomUUID(), affiliateId: 'x' }));
  const malformed = track(await call(E.withdraw, req('/api/recruiter/wallet/withdrawals', { method: 'POST', raw: '{bad', cookie: recruiterCookie(E.A) })));
  const arr = track(await call(E.withdraw, req('/api/recruiter/wallet/withdrawals', { method: 'POST', raw: '[]', cookie: recruiterCookie(E.A) })));
  ok('missing / malformed requestId → INVALID_REQUEST_ID; any other key (e.g. affiliateId) → UNKNOWN_FIELD; malformed JSON / array → UNKNOWN_FIELD',
    noReq.body?.fields?.requestId === 'INVALID_REQUEST_ID' && badReq.body?.fields?.requestId === 'INVALID_REQUEST_ID'
    && eq(extraKey.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } }) && malformed.body?.fields?.body === 'UNKNOWN_FIELD' && arr.body?.fields?.body === 'UNKNOWN_FIELD');
  ok('…nothing written by any invalid request', eq(snapshot(E.db), s1));

  const over = track(await post(E, E.A, mk('200.01')));
  ok('200.01 MAD with 200.00 available → 400 INSUFFICIENT_BALANCE, nothing written', over.status === 400 && eq(over.body, { code: 'INSUFFICIENT_BALANCE' }) && eq(snapshot(E.db), s1), `${over.status} ${over.text}`);

  const rid = randomUUID();
  const ok1 = await post(E, E.A, mk('50', rid));
  const row = E.db._tables.affiliatePayout.find((p) => p.id === ok1.body?.withdrawal?.id);
  ok('50 MAD → 201 { withdrawal: { id, amountCents 5000, MAD, PENDING, createdAt }, replayed:false }',
    ok1.status === 201 && eq(keys(ok1.body), ['replayed', 'withdrawal']) && ok1.body.replayed === false && eq(keys(ok1.body.withdrawal), ['amountCents', 'createdAt', 'currency', 'id', 'status'])
    && ok1.body.withdrawal.amountCents === 5000 && ok1.body.withdrawal.status === 'PENDING' && ok1.cache === 'no-store', ok1.text);
  ok('the row is an existing-workflow payout: recruiterId A, affiliateId NULL, amount 50 MAD, status pending',
    row && row.recruiterId === E.A.id && row.affiliateId === null && row.amount === 50 && row.status === 'pending');
  const ra = audits(E.db, 'RECRUITER_WITHDRAWAL_REQUESTED');
  ok('audited RECRUITER_WITHDRAWAL_REQUESTED by the recruiter with requestId and amountCents', ra.length === 1 && ra[0].actorType === 'RECRUITER' && ra[0].actorId === E.A.id && ra[0].entityId === row.id && eq(ra[0].details, { requestId: rid, amountCents: 5000 }));
  const replay = await post(E, E.A, mk('50', rid));
  ok('the same requestId again → 200 replayed:true, the same id, no new row', replay.status === 200 && replay.body.replayed === true && replay.body.withdrawal.id === row.id && E.db._tables.affiliatePayout.length === 1);
  const conflict = track(await post(E, E.A, mk('60', rid)));
  ok('the same requestId with another amount → 409 IDEMPOTENCY_CONFLICT', conflict.status === 409 && eq(conflict.body, { code: 'IDEMPOTENCY_CONFLICT' }));
  const rest = await post(E, E.A, mk('150'));
  const more = track(await post(E, E.A, mk('0.01')));
  ok('the exact remaining 150.00 succeeds; then 0.01 more → INSUFFICIENT_BALANCE', rest.status === 201 && more.status === 400 && more.body.code === 'INSUFFICIENT_BALANCE');

  // concurrency: 10 parallel requests of 15 MAD with 100 MAD available
  const C = env({ earnedCents: 10000 });
  const par = await Promise.all(Array.from({ length: 10 }, () => post(C, C.A, mk('15'))));
  const created = C.db._tables.affiliatePayout.filter((p) => p.recruiterId === C.A.id);
  const total = created.reduce((t, p) => t + Math.round(p.amount * 100), 0);
  ok('10 concurrent 15 MAD requests with 100 MAD available → exactly 6 created (90 MAD), 4 INSUFFICIENT_BALANCE; never above available',
    par.filter((r) => r.status === 201).length === 6 && par.filter((r) => r.body?.code === 'INSUFFICIENT_BALANCE').length === 4 && total === 9000 && total <= 10000, par.map((r) => r.status).join(','));
  const D = env({ earnedCents: 10000 });
  const same = randomUUID();
  const dbl = await Promise.all(Array.from({ length: 10 }, () => post(D, D.A, mk('80', same))));
  ok('10 concurrent submits of the SAME request → 1 created + 9 replays of that id', dbl.filter((r) => r.status === 201).length === 1 && dbl.filter((r) => r.status === 200 && r.body.replayed).length === 9
    && D.db._tables.affiliatePayout.length === 1 && new Set(dbl.map((r) => r.body.withdrawal.id)).size === 1, dbl.map((r) => r.status).join(','));

  // disabled recruiter
  const Z = env();
  Object.assign(Z.db._tables.recruiter.find((r) => r.id === Z.A.id), { isActive: false, disabledAt: new Date(), disabledBy: 'admin' });
  const dis = track(await post(Z, Z.A, mk('10')));
  const disW = track(await call(Z.wallet, req('/api/recruiter/wallet', { cookie: recruiterCookie(Z.A) })));
  ok('a disabled recruiter → 403 RECRUITER_DISABLED for the request and the wallet, nothing written', dis.status === 403 && eq(dis.body, { code: 'RECRUITER_DISABLED' }) && disW.status === 403 && Z.db._tables.affiliatePayout.length === 0);
  const R = env();
  R.hookBox.fn = (m) => { if (m === '$queryRaw') Object.assign(R.db._tables.recruiter.find((r) => r.id === R.A.id), { isActive: false, disabledAt: new Date(), disabledBy: 'admin' }); };
  const race = track(await post(R, R.A, mk('10')));
  ok('disabled between the handler check and the transaction → the in-transaction lock re-check refuses (403), nothing written', race.status === 403 && race.body.code === 'RECRUITER_DISABLED' && R.db._tables.affiliatePayout.length === 0);

  // atomicity of a request
  const At = env({ failOnce: { 'recruiterAuditLog.create': true } });
  const fa = await silence(() => post(At, At.A, mk('10')));
  ok('an injected audit failure → 500 SERVER_ERROR and no payout row (atomic)', fa.out.status === 500 && eq(fa.out.body, { code: 'SERVER_ERROR' }) && At.db._tables.affiliatePayout.length === 0);

  // rate limit (writes: 10 / minute, key includes the recruiter id)
  const keysSeen = [];
  const RL = env({ rateLimit: (r, key, opt) => { keysSeen.push([key, opt]); return realRateLimit(r, key, opt); } });
  const ip = `10.55.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
  const burst = [];
  for (let i = 0; i < 11; i++) burst.push(await post(RL, RL.A, mk('0.01'), { ip }));
  ok('the 11th write in a minute → 429 RATE_LIMITED (10 / minute, keyed by recruiter + IP)', burst.slice(0, 10).every((r) => r.status === 201) && burst[10].status === 429 && eq(burst[10].body, { code: 'RATE_LIMITED' })
    && keysSeen.every(([k, o]) => k === `recruiter-wallet-write:${RL.A.id}` && eq(o, RECRUITER_WALLET_RATE.write)), burst.map((r) => r.status).join(','));

  // wallet GET (reconciles only the caller's network)
  const G = env({ earnedCents: 0 });
  const mine = qualified(G.db, G.A);
  const theirs = qualified(G.db, G.B);
  const wg = await call(G.wallet, req('/api/recruiter/wallet', { cookie: recruiterCookie(G.A) }));
  ok('wallet GET → 200 no-store; awards the due reward of A\'s network immediately (and not B\'s)',
    wg.status === 200 && wg.cache === 'no-store' && wg.body.wallet.totals.earnedCents === 15000 && ledger(G.db, { affiliateId: mine.id }).length === 1 && ledger(G.db, { affiliateId: theirs.id }).length === 0, wg.text.slice(0, 200));
  ok('wallet GET shows the reward amount and the delivered-order threshold (settings view)', eq(wg.body.wallet.settings, { rewardsEnabled: true, rewardAmountCents: 15000, currency: 'MAD', requiredDeliveredOrders: 10 }));
  const wgB = await call(G.wallet, req('/api/recruiter/wallet', { cookie: recruiterCookie(G.B) }));
  ok('B\'s wallet shows only B\'s reward (never A\'s affiliate)', wgB.body.wallet.rewards.length === 1 && wgB.body.wallet.rewards[0].affiliate.id === theirs.id);
  ok('every recruiter error body is { code } or { code, fields } only', errors.every((r) => errBody(r.body)), errors.filter((r) => !errBody(r.body)).map((r) => r.text).join(' | '));
}

// ── 7. bank details ───────────────────────────────────────────────────────────
console.log('\n7. Bank details: same rules as the affiliate ones, strict body, audited');
{
  const E = setup();
  const h = recruiterWalletHandlers({ db: E.db, now, rateLimit: noLimit });
  const put = (body, raw) => call(withRecruiterAuth(h.bank), req('/api/recruiter/wallet/bank', { method: 'PUT', body, raw, cookie: recruiterCookie(E.A) }));
  const good = await put({ bankName: '  CIH   Bank ', rib: '0117 8000 0012 3456 7890 1234', accountName: 'Recruteur  A' });
  const rec = E.db._tables.recruiter.find((r) => r.id === E.A.id);
  ok('valid → 200 { bank: { bankName, rib, accountName, complete:true } }, whitespace normalised, RIB spaces removed',
    good.status === 200 && eq(good.body, { bank: { bankName: 'CIH Bank', rib: '011780000012345678901234', accountName: 'Recruteur A', complete: true } }) && rec.rib === '011780000012345678901234', good.text);
  const au = audits(E.db, 'RECRUITER_BANK_UPDATED');
  ok('audited RECRUITER_BANK_UPDATED by the recruiter (no bank value in the audit)', au.length === 1 && au[0].actorId === E.A.id && au[0].details === null);
  const cases = [
    [{ bankName: '', rib: '0117800000123456', accountName: 'X Y' }, { bankName: 'INVALID_BANK_NAME' }],
    [{ bankName: 'CIH', rib: '012345678', accountName: 'X Y' }, { rib: 'INVALID_RIB' }],
    [{ bankName: 'CIH', rib: '0'.repeat(35), accountName: 'X Y' }, { rib: 'INVALID_RIB' }],
    [{ bankName: 'CIH', rib: '0117-8000-0012-3456', accountName: 'X Y' }, { rib: 'INVALID_RIB' }],
    [{ bankName: 'CIH', rib: '0117800000123456', accountName: '' }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankName: 'CIH', rib: '0117800000123456', accountName: '<script>' }, { accountName: 'INVALID_ACCOUNT_NAME' }],
    [{ bankName: 'B'.repeat(81), rib: '0117800000123456', accountName: 'X Y' }, { bankName: 'INVALID_BANK_NAME' }],
    [{ bankName: 'CIH', rib: '0117800000123456', accountName: 'X Y', isActive: true }, { body: 'UNKNOWN_FIELD' }],
  ];
  const before = { ...rec };
  const res = [];
  for (const [b, f] of cases) { const r = await put(b); res.push(r.status === 400 && eq(r.body, { code: 'INVALID_INPUT', fields: f })); }
  ok('invalid bank details → 400 with the exact field codes; extra key → UNKNOWN_FIELD; nothing changed', res.every(Boolean) && rec.bankName === before.bankName && audits(E.db, 'RECRUITER_BANK_UPDATED').length === 1, JSON.stringify(res));
  ok('the server rule reuses validateBankInfo (the affiliate one): every input it rejects is rejected here too',
    [{ bankName: '', accountName: 'a', rib: '0123456789' }, { bankName: 'b', accountName: '', rib: '0123456789' }, { bankName: 'b', accountName: 'a', rib: '123' }]
      .every((b) => ASYS.validateBankInfo(b).length > 0) && /validateBankInfo\(bank\)/.test(read('src/lib/services/recruiterWalletService.js')) && /import \{ PAYOUT_RELEASING_STATUSES, validateBankInfo \} from '\.\/affiliateSystemService\.js'/.test(read('src/lib/services/recruiterWalletService.js')));
}

// ── 8. admin processing ───────────────────────────────────────────────────────
console.log('\n8. Admin: pay / reject a recruiter withdrawal (pending only, audited), overview, recheck');
{
  const E = setup();
  const a = aff(E.db, E.A);
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: 30000, settingsVersion: 1, idempotencyKey: `recruit:${a.id}` });
  Object.assign(E.db._tables.recruiter.find((r) => r.id === E.A.id), { bankName: 'CIH', accountName: 'A', rib: '0117800000123456' });
  const w1 = await WS.requestRecruiterWithdrawal(E.A.id, { amountMad: '100', requestId: randomUUID() }, { db: E.db });
  const w2 = await WS.requestRecruiterWithdrawal(E.A.id, { amountMad: '50', requestId: randomUUID() }, { db: E.db });
  const tot = async () => (await WS.getRecruiterWallet(E.A.id, { db: E.db })).totals;
  ok('before: available 150 MAD, pending 150 MAD', eq(await tot(), { earnedCents: 30000, reservedCents: 15000, paidCents: 0, pendingCents: 15000, availableCents: 15000 }));
  const admin = recruiterRewardAdminHandlers({ db: E.db, now });
  const paid = await admin.payoutAction(w1.withdrawal.id, 'pay', { userId: 'admin-1', role: 'ADMIN' });
  const pb = JSON.parse(await paid.text());
  ok('pay → 200 status paid; totals: paid 100, pending 50, available unchanged 150', paid.status === 200 && pb.status === 'paid' && eq(await tot(), { earnedCents: 30000, reservedCents: 15000, paidCents: 10000, pendingCents: 5000, availableCents: 15000 }), JSON.stringify(pb));
  const pa = audits(E.db, 'RECRUITER_WITHDRAWAL_PAID');
  ok('audited RECRUITER_WITHDRAWAL_PAID by the ADMIN (amount, pending → paid)', pa.length === 1 && pa[0].actorType === 'ADMIN' && pa[0].actorId === 'admin-1' && pa[0].recruiterId === E.A.id && eq(pa[0].details, { amountCents: 10000, from: 'pending', to: 'paid', reason: null }));
  const twice = await admin.payoutAction(w1.withdrawal.id, 'pay', { userId: 'admin-1' });
  ok('paying twice → 409 INVALID_STATE (fixed French text), nothing changed', twice.status === 409 && eq(JSON.parse(await twice.text()), { code: 'INVALID_STATE', error: 'Ce retrait a déjà été traité.' }) && audits(E.db, 'RECRUITER_WITHDRAWAL_PAID').length === 1);
  const rejPaid = await admin.payoutAction(w1.withdrawal.id, 'reject', { userId: 'admin-1' });
  ok('rejecting a PAID row → 409 INVALID_STATE', rejPaid.status === 409);
  const rej = await admin.payoutAction(w2.withdrawal.id, 'reject', { userId: 'admin-2' }, '  RIB erroné  ');
  ok('reject a pending row → status rejected; the reserved 50 MAD is released (available 200)', rej.status === 200 && JSON.parse(await rej.text()).status === 'rejected' && eq(await tot(), { earnedCents: 30000, reservedCents: 10000, paidCents: 10000, pendingCents: 0, availableCents: 20000 }));
  ok('audited RECRUITER_WITHDRAWAL_REJECTED with the trimmed reason', eq(audits(E.db, 'RECRUITER_WITHDRAWAL_REJECTED')[0]?.details, { amountCents: 5000, from: 'pending', to: 'rejected', reason: 'RIB erroné' }));
  const viewStatuses = V.toRecruiterWalletView(await WS.getRecruiterWallet(E.A.id, { db: E.db })).withdrawals.map((x) => x.status).sort();
  ok('the recruiter sees PAID and REJECTED', eq(viewStatuses, ['PAID', 'REJECTED']));

  const af = E.db._seed.affiliate({ username: 'payee2' });
  const affRow = E.db._seed.payout({ affiliateId: af.id, amount: 70, status: 'pending' });
  const nf = await admin.payoutAction(affRow.id, 'pay', { userId: 'admin-1' });
  ok('an AFFILIATE row is never processed by the recruiter path (404, still pending)', nf.status === 404 && E.db._tables.affiliatePayout.find((p) => p.id === affRow.id).status === 'pending');
  ok('recruiterPayoutOwner: recruiter row → its recruiter; affiliate row / unknown / malformed → null (so the route keeps the affiliate path)',
    (await WS.recruiterPayoutOwner(w1.withdrawal.id, { db: E.db })) === E.A.id && (await WS.recruiterPayoutOwner(affRow.id, { db: E.db })) === null
    && (await WS.recruiterPayoutOwner(randomUUID(), { db: E.db })) === null && (await WS.recruiterPayoutOwner('bad id', { db: E.db })) === null);
  ok('no admin actor → 401; unknown id → 404; unknown action → 400',
    (await admin.payoutAction(w2.withdrawal.id, 'pay', {})).status === 401 && (await admin.payoutAction(randomUUID(), 'pay', { userId: 'a' })).status === 404
    && (await WS.adminProcessRecruiterPayout(w2.withdrawal.id, 'approve', { db: E.db, actorId: 'a' }).then(() => 'x', (e) => e.code)) === 'INVALID_INPUT');
  const w3 = await WS.requestRecruiterWithdrawal(E.A.id, { amountMad: '10', requestId: randomUUID() }, { db: E.db });
  const conc = await Promise.all(Array.from({ length: 5 }, (_v, i) => WS.adminProcessRecruiterPayout(w3.withdrawal.id, i % 2 ? 'reject' : 'pay', { db: E.db, actorId: `admin-${i}` }).then(() => 'ok', (e) => e.code)));
  ok('5 concurrent pay / reject on one row → exactly 1 succeeds, 4 INVALID_STATE (conditional write)', conc.filter((x) => x === 'ok').length === 1 && conc.filter((x) => x === 'INVALID_STATE').length === 4, conc.join(','));

  const list = await WS.adminListRecruiterPayouts({ db: E.db });
  ok('admin list rows: ownerType recruiter, recruiter username / name / bank, amount, status — affiliate rows not included',
    list.length === 3 && list.every((r) => r.ownerType === 'recruiter' && r.recruiterId === E.A.id && r.affiliateId === null && r.recruiterUsername === 'rec.a' && r.rib === '0117800000123456'));
  const ov = await call(withAdminAuth(admin.overview), req('/api/admin/recruiter-rewards', { cookie: adminCookie() }));
  ok('admin overview → settings, history, ledger (recruiter + affiliate usernames), balances per recruiter',
    ov.status === 200 && eq(keys(ov.body), ['balances', 'history', 'ledger', 'settings']) && ov.body.ledger[0].recruiterUsername === 'rec.a' && ov.body.ledger[0].affiliateUsername === a.username
    && eq(ov.body.balances.find((b) => b.recruiterId === E.A.id), { recruiterId: E.A.id, username: 'rec.a', name: 'Recruteur A', earnedCents: 30000, reservedCents: 11000, paidCents: 10000 + (conc.includes('ok') && E.db._tables.affiliatePayout.find((p) => p.id === w3.withdrawal.id).status === 'paid' ? 1000 : 0), pendingCents: E.db._tables.affiliatePayout.find((p) => p.id === w3.withdrawal.id).status === 'paid' ? 0 : 0, availableCents: 19000 })
    || (ov.status === 200 && E.db._tables.affiliatePayout.find((p) => p.id === w3.withdrawal.id).status === 'rejected' && ov.body.balances.find((b) => b.recruiterId === E.A.id).availableCents === 20000), ov.text.slice(0, 300));
  const rc = await call(withAdminAuth(admin.reconcile), req('/api/admin/recruiter-rewards', { method: 'POST', body: { action: 'reconcile' }, cookie: adminCookie() }));
  const rcBad = await call(withAdminAuth(admin.reconcile), req('/api/admin/recruiter-rewards', { method: 'POST', body: { action: 'other' }, cookie: adminCookie() }));
  // Phase 6 part 5d: one bounded batch per request, with its cursor / hasMore.
  ok('admin recheck: { action: "reconcile" } → 200 with the counts of ONE batch (+ candidates, batches, cursor, hasMore, busy); anything else → 400',
    // Phase 7: + groupAwarded / groupChecked / groupReversed (additive)
    rc.status === 200 && eq(keys(rc.body.reconcile), ['awarded', 'batches', 'busy', 'candidates', 'checked', 'cursor', 'groupAwarded', 'groupChecked', 'groupReversed', 'hasMore', 'reversed', 'unchanged'])
    && rc.body.reconcile.batches === 1 && rc.body.reconcile.hasMore === false && rc.body.reconcile.cursor === null && rc.body.reconcile.busy === false && rcBad.status === 400, rc.text);
  ok('admin endpoints refuse a recruiter token (403) and no token (401)',
    (await call(withAdminAuth(admin.overview), req('/x', { cookie: `auth_token=${signToken({ recruiterId: E.A.id, username: 'rec.a', type: 'recruiter' })}` }))).status === 403
    && (await call(withAdminAuth(admin.overview), req('/x'))).status === 401);
}

// ── 9. isolation ──────────────────────────────────────────────────────────────
console.log('\n9. Isolation: own wallet only, auth wrappers, every payout query scoped by recruiterId');
{
  const route = (p) => stripJs(read(p));
  const exp = (src) => [...src.matchAll(/export\s+const\s+([A-Z]+)\s*=\s*([^;\n]+)/g)].map((m) => [m[1], m[2].trim()]);
  ok('recruiter wallet routes: GET / PUT / POST each wrapped in withRecruiterAuth, nothing else exported, each imports recruiterVisibility',
    eq(exp(route('src/app/api/recruiter/wallet/route.js')), [['GET', 'withRecruiterAuth(h.wallet)']]) && eq(exp(route('src/app/api/recruiter/wallet/bank/route.js')), [['PUT', 'withRecruiterAuth(h.bank)']])
    && eq(exp(route('src/app/api/recruiter/wallet/withdrawals/route.js')), [['POST', 'withRecruiterAuth(h.withdraw)']])
    && ['', '/bank', '/withdrawals'].every((s) => /from '@\/lib\/recruiterVisibility'/.test(read(`src/app/api/recruiter/wallet${s}/route.js`))));
  ok('admin reward routes: GET / POST / settings POST each wrapped in withAdminAuth',
    eq(exp(route('src/app/api/admin/recruiter-rewards/route.js')), [['GET', 'withAdminAuth(h.overview)'], ['POST', 'withAdminAuth(h.reconcile)']])
    && eq(exp(route('src/app/api/admin/recruiter-rewards/settings/route.js')), [['POST', 'withAdminAuth(h.saveSettings)']]));
  const E = setup();
  const h = recruiterWalletHandlers({ db: E.db, now, rateLimit: noLimit });
  const toks = [
    ['no cookie', undefined],
    ['admin token as recruiter_token', `recruiter_token=${signToken({ userId: 'u', role: 'ADMIN' })}`],
    ['affiliate token as recruiter_token', `recruiter_token=${signToken({ affiliateId: 'x', type: 'affiliate' })}`],
    ['admin auth_token only', adminCookie()],
    ['recruiter token signed with another secret', 'recruiter_token=eyJhbGciOiJIUzI1NiJ9.eyJyZWNydWl0ZXJJZCI6IngiLCJ0eXBlIjoicmVjcnVpdGVyIn0.AAAA'],
  ];
  const statuses = [];
  for (const [, c] of toks) for (const fn of [h.wallet, h.bank, h.withdraw]) statuses.push((await call(withRecruiterAuth(fn), req('/x', { method: 'POST', cookie: c, body: {} }))).status);
  ok('5 wrong / missing credentials × 3 recruiter money endpoints → 401, with no database access', statuses.every((s) => s === 401) && E.db._queryCount() === 0, statuses.join(','));

  // runtime: every affiliatePayout call made by the recruiter services in this process
  const R = setup();
  const a = aff(R.db, R.A);
  R.db._seed.ledger({ recruiterId: R.A.id, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: 5000, settingsVersion: 1, idempotencyKey: `recruit:${a.id}` });
  Object.assign(R.db._tables.recruiter.find((r) => r.id === R.A.id), { bankName: 'CIH', accountName: 'A', rib: '0117800000123456' });
  const w = await WS.requestRecruiterWithdrawal(R.A.id, { amountMad: '10', requestId: randomUUID() }, { db: R.db });
  await WS.getRecruiterWallet(R.A.id, { db: R.db });
  await WS.getRecruiterWallet(R.B.id, { db: R.db });
  await WS.adminListRecruiterPayouts({ db: R.db });
  await WS.adminRecruiterBalances({ db: R.db });
  await WS.recruiterPayoutOwner(w.withdrawal.id, { db: R.db });
  await WS.adminProcessRecruiterPayout(w.withdrawal.id, 'pay', { db: R.db, actorId: 'admin' });
  const calls = R.db._payoutCalls;
  const scoped = (c) => (c.where && Object.prototype.hasOwnProperty.call(c.where, 'recruiterId')) || (c.op === 'create' && c.data?.recruiterId) || (c.op === 'findUnique' && eq(keys(c.where), ['id']));
  ok(`every affiliatePayout call by the recruiter services (${calls.length}) is scoped by recruiterId (the owner lookup by id only selects recruiterId)`, calls.length >= 8 && calls.every(scoped), JSON.stringify(calls.filter((c) => !scoped(c))));
  ok('…and never writes an affiliateId', calls.every((c) => !(c.data && 'affiliateId' in c.data)));
  const ownerSrc = stripJs(read('src/lib/services/recruiterWalletService.js'));
  ok('the owner lookup by id selects only recruiterId', /affiliatePayout\.findUnique\(\{ where: \{ id \}, select: \{ recruiterId: true \} \}\)/.test(ownerSrc));
}

// ── 10. the affiliate side is unchanged ───────────────────────────────────────
console.log('\n10. Affiliate payouts / balances unchanged and blind to recruiter rows');
{
  // Phase 6 part 2 (documented allowance, docs/recruiter-system.md §8): only the exact pinned Part 2
  // diffs of affiliateSystemService / the affiliate login & me routes; identity and the balance providers are unchanged.
  const { checkUnchangedExceptPart2 } = await import('./lib/phase6Part2Allowance.mjs');
  const p2 = checkUnchangedExceptPart2(PHASE4_HEAD, ['src/lib/services/affiliateSystemService.js', 'src/lib/services/identityService.js', 'src/app/api/affiliate', 'src/lib/balance']);
  ok('identityService and the balance providers are unchanged versus 47d3254; affiliateSystemService and the /api/affiliate routes differ ONLY by the exact pinned Phase 6 part 2 diff (no payout / balance code touched)',
    p2.ok && p2.allowed.every((f) => ['src/lib/services/affiliateSystemService.js', 'src/app/api/affiliate/auth/route.js', 'src/app/api/affiliate/me/route.js'].includes(f)), JSON.stringify(p2));
  const E = setup();
  const x = E.db._seed.affiliate({ username: 'x1' });
  const y = E.db._seed.affiliate({ username: 'y1' });
  E.db._seed.payout({ affiliateId: x.id, amount: 100, status: 'pending' });
  E.db._seed.payout({ affiliateId: x.id, amount: 50, status: 'paid' });
  E.db._seed.payout({ affiliateId: x.id, amount: 30, status: 'rejected' });
  E.db._seed.payout({ recruiterId: E.A.id, amount: 999, status: 'pending' });
  E.db._seed.payout({ recruiterId: E.A.id, amount: 777, status: 'paid' });
  const ded = await ASYS.getPayoutDeductionComponent(x.id, E.db);
  const pend = await ASYS.getPendingPayoutTotal(x.id, E.db);
  const dedY = await ASYS.getPayoutDeductionComponent(y.id, E.db);
  ok('the REAL affiliate functions: deduction −150 and pending 100 for the affiliate; 0 for another; recruiter rows (affiliateId NULL) never included', ded === -150 && Number(pend) === 100 && dedY === 0, `${ded} ${pend} ${dedY}`);
  ok('the recruiter wallet reuses PAYOUT_RELEASING_STATUSES (same reservation rule)', eq([...ASYS.PAYOUT_RELEASING_STATUSES], ['rejected', 'cancelled', 'canceled', 'refused']) && /PAYOUT_RELEASING_STATUSES\.includes\(status\)/.test(read('src/lib/services/recruiterWalletService.js')));
  let owner = null;
  try { await E.db.$transaction(async (tx) => tx.affiliatePayout.create({ data: { affiliateId: x.id, recruiterId: E.A.id, amount: 1 } })); } catch (e) { owner = e.meta?.constraint; }
  let none = null;
  try { await E.db.$transaction(async (tx) => tx.affiliatePayout.create({ data: { amount: 1 } })); } catch (e) { none = e.meta?.constraint; }
  let frac = null;
  try { await E.db.$transaction(async (tx) => tx.affiliatePayout.create({ data: { recruiterId: E.A.id, amount: 1.005 } })); } catch (e) { frac = e.meta?.constraint; }
  ok('the exactly-one-owner CHECK and the recruiter whole-cent amount CHECK are enforced (as in the migration)', owner === 'affiliate_payouts_owner_check' && none === 'affiliate_payouts_owner_check' && frac === 'affiliate_payouts_recruiter_amount_check');
  const mig = read('prisma/migrations/20261106_recruiter_rewards_withdrawals/migration.sql');
  const migCode = mig.replace(/--.*$/gm, '');
  ok('migration: additive only — DROP NOT NULL on affiliateId, ADD recruiterId + FK (RESTRICT), owner CHECK, recruiter amount CHECK, index, 3 nullable bank columns; no DROP COLUMN / TABLE / UPDATE / DELETE',
    /ALTER COLUMN "affiliateId" DROP NOT NULL/.test(migCode) && /ADD COLUMN IF NOT EXISTS "recruiterId" TEXT/.test(migCode)
    && /REFERENCES "recruiters"\("id"\) ON DELETE RESTRICT/.test(migCode) && /CHECK \(\("affiliateId" IS NULL\) <> \("recruiterId" IS NULL\)\)/.test(migCode)
    && /"affiliate_payouts_recruiter_amount_check"/.test(migCode) && /CREATE INDEX IF NOT EXISTS "affiliate_payouts_recruiterId_idx"/.test(migCode)
    && ['bankName', 'rib', 'accountName'].every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS "${c}"\\s+TEXT;`).test(migCode))
    && !/DROP\s+(COLUMN|TABLE)|\bUPDATE\s+"|\bDELETE\s+FROM|TRUNCATE/i.test(migCode));
}

// ── 11. static: the hooks and services write nothing else ─────────────────────
console.log('\n11. Static checks');
{
  const hk = stripJs(read('src/lib/recruiterRewardHooks.js'));
  ok('the hooks only READ the order / identity row (status, isFake, affiliateId) — no write, no other model',
    !/\.(create|update|updateMany|upsert|delete|deleteMany)\(/.test(hk) && /select: \{ affiliateId: true, status: true, isFake: true \}/.test(hk) && /select: \{ affiliateId: true, status: true \}/.test(hk) && !/cin|ugc/i.test(hk));
  const rs = stripJs(read('src/lib/services/recruiterRewardService.js'));
  const models = new Set([...rs.matchAll(/\b(?:db|tx)\.(\$?\w+)/g)].map((m) => m[1]));
  // Phase 6 part 5d: + $queryRaw (the reconcile lease and the tagged candidates statement, both pinned below).
  ok('the reward service touches only settings / ledger / audit / links / orders (counts) / identity (status) / affiliate (existence) / $transaction / the two pinned raw reads',
    // Phase 7: + recruiter (ids only — the group pass pages over recruiters.id), pinned below.
    [...models].every((m) => ['recruiterSettingsVersion', 'recruiterRewardLedger', 'recruiterAuditLog', 'recruiterAffiliateLink', 'affiliateOrder', 'identityVerification', 'affiliate', 'recruiter', '$transaction', '$executeRaw', '$queryRaw'].includes(m))
    && (rs.match(/\b(?:db|tx)\.recruiter\./g) || []).length === 1 && /db\.recruiter\.findMany\(\{\s*where: cursor === null \? \{\} : \{ id: \{ gt: cursor \} \}, orderBy: \{ id: 'asc' \}, take: GROUP_PASS_BATCH, select: \{ id: true \},\s*\}\)/.test(rs), [...models].join(','));
  ok('Phase 6 part 5d: reconcile no longer loads the whole scope — no links findMany, no ledger read over many affiliates, no affiliateOrder.groupBy, no id chunking',
    !/recruiterAffiliateLink\.findMany|affiliateOrder\.groupBy|recruiterRewardLedger\.(findMany|groupBy)\(\{\s*where:\s*\{\s*affiliateId:\s*\{\s*in\b|\bCHUNK\b|\bchunks\(/.test(rs)
    // Phase 7: + exactly one more ledger findMany — ONE recruiter's group rows (groupLedgerState, where recruiterId + the 2 group types).
    && (rs.match(/recruiterRewardLedger\.findMany\(/g) || []).length === 2 && /async function cycleState\(tx, affiliateId\)[\s\S]*?tx\.recruiterRewardLedger\.findMany\(\{\s*where: \{ affiliateId, type/.test(rs)
    && /async function groupLedgerState\(tx, recruiterId\)[\s\S]*?tx\.recruiterRewardLedger\.findMany\(\{\s*where: \{ recruiterId, type: \{ in: \[REWARD_TYPES\.GROUP_REWARD, REWARD_TYPES\.GROUP_REVERSAL\] \} \}/.test(rs));
  // Phase 6 part 3a adds exactly one: the per-affiliate reward lock (the SAME key as the cycle-guard trigger);
  // the part 3b race fix adds exactly one more: the per-recruiter money lock (shared with the withdrawal payment).
  // Phase 6 part 5d adds exactly two reads: the reconcile lease (a two-key try-lock, its own key space)
  // and ONE tagged candidates statement whose interpolations are bound values only (no Unsafe, no
  // identifier / SQL fragment interpolated); its exact text is pinned by the fake's drift guard.
  const raws = [...read('src/lib/services/recruiterRewardService.js').matchAll(/\$(?:executeRaw|queryRaw)(?:Unsafe)?`([^`]*)`/g)].map((m) => m[1]);
  const candSql = raws.find((x) => /^\s*\/\* recruiter-reward-candidates \*\//.test(x)) ?? '';
  // Phase 7: + the per-recruiter GROUP lock (same key as the group cycle-guard trigger) and ONE tagged group
  // statement (recruiter-group-qualified) whose interpolations are bound values only; its text is pinned by the fake.
  const groupSql = raws.find((x) => /^\s*\/\* recruiter-group-qualified \*\//.test(x)) ?? '';
  // Phase 7 Stage E: + ONE tagged owner statement (recruiter-affiliate-owner — the nearest link at or above an
  // affiliate) bound to the affiliate id only; the group statement binds the recruiter twice (the N(R) walk's
  // "not linked to another recruiter" filter) and the candidates statement its segment depth cap.
  const ownerSql = raws.find((x) => /^\s*\/\* recruiter-affiliate-owner \*\//.test(x)) ?? '';
  // Phase 7 Stage F: + the wallet scope's tagged network candidates statement (roots of N(R)) and the admin read-only
  // conflicts statement; the group statement binds the shared N(R) CTEs (recruiter ×4 + the walk cap); the owner
  // statement binds the affiliate twice (the chain + the topmost walk).
  const netCandSql = raws.find((x) => /^\s*\/\* recruiter-reward-network-candidates \*\//.test(x)) ?? '';
  const confSql = raws.find((x) => /^\s*\/\* recruiter-ownership-conflicts \*\//.test(x)) ?? '';
  ok('the ONLY raw SQL of the reward service: the settings advisory lock (same key as the version trigger), the per-affiliate reward lock (same key as the cycle guard), the per-recruiter money lock, the reconcile lease, the tagged candidates statement, the Phase 7 group lock and the tagged group statement, (Stage E) the tagged owner statement, (Stage F) the tagged network candidates and conflicts statements — all bound',
    eq(raws.filter((x) => x !== candSql && x !== groupSql && x !== ownerSql && x !== netCandSql && x !== confSql), ["SELECT pg_advisory_xact_lock(hashtext('recruiter_settings_versions'))", "SELECT pg_advisory_xact_lock(hashtext(${'recruit:' + affiliateId}))", "SELECT pg_advisory_xact_lock(hashtext(${'recruiter-money:' + recruiterId}))", "SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok", "SELECT pg_advisory_xact_lock(hashtext(${'recruiter-group:' + recruiterId}))"])
    && raws.length === 10 && groupSql !== '' && [...groupSql.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join() === 'recruiterId,cap,recruiterId,recruiterId,recruiterId,DELIVERED_ORDER_STATUS,minDelivered,minDelivered' && [...candSql.matchAll(/\$\{([^}]*)\}/g)].every((m) => /^(recruiterId|after|size|SEGMENT_DEPTH_CAP|awardsOn|minDeliveredSales|REWARD_TYPES\.(RECRUIT_REWARD|REVERSAL)|MIN_SALES_RANGE\.(min|max)|DEFAULT_MIN_DELIVERED_SALES|DELIVERED_ORDER_STATUS)$/.test(m[1]))
    && netCandSql !== '' && [...netCandSql.matchAll(/\$\{([^}]*)\}/g)].every((m) => /^(recruiterId|after|size|cap|awardsOn|minDeliveredSales|REWARD_TYPES\.(RECRUIT_REWARD|REVERSAL)|MIN_SALES_RANGE\.(min|max)|DEFAULT_MIN_DELIVERED_SALES|DELIVERED_ORDER_STATUS)$/.test(m[1]))
    && confSql !== '' && [...confSql.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join() === 'cap,take'
    && ownerSql !== '' && [...ownerSql.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join() === 'affiliateId,affiliateId'
    && !/\$(?:executeRaw|queryRaw)Unsafe|Prisma\.raw|Prisma\.sql/.test(rs), big(raws));
  // Phase 6 part 5d: only for the (≤ one batch of) award candidates.
  // Stage E: chunked (a batch's segments may hold more ids than links), same projection.
  ok('identity is read with select affiliateId / status only (never a document field), for one batch of award candidates (chunked)', /identityVerification\.findMany\(\{ where: \{ affiliateId: \{ in: ids\.slice\(i, i \+ GROUP_QUALIFIED_CHUNK\) \} \}, select: \{ affiliateId: true, status: true \} \}\)/.test(rs) && !/cinFront|cinBack/.test(rs));
  const ws = stripJs(read('src/lib/services/recruiterWalletService.js'));
  ok('the wallet service never reads an affiliate balance, commission, point or provider', !/commission|rewardPoint|getAffiliateBalance|getWithdrawableBalance|computeRegisteredBalance|providerRegistry|bonusBalance/.test(ws));
}

// ── 12. Phase 6 part 5d: bounded keyset reconcile ─────────────────────────────
console.log('\n12. Phase 6 part 5d: bounded keyset reconcile (candidates, equivalence, batches, lease, wallet, admin)');
{
  const LEASE = '__advisory2__:recruiter-reward-reconcile:0';
  const isCand = (sql) => /^\s*\/\* recruiter-reward-candidates \*\//.test(sql ?? '');
  // Every candidates statement the service runs through the returned db (it calls db.$queryRaw itself;
  // the lease runs on the transaction client, which is the raw fake).
  const spy = (raw) => {
    const seen = [];
    const db = new Proxy(raw, {
      get(t, p) {
        if (p !== '$queryRaw') return t[p];
        return async (strings, ...values) => {
          const rows = await t.$queryRaw(strings, ...values);
          if (isCand(Array.isArray(strings) ? strings.join('') : '')) seen.push({ strings, values, rows });
          return rows;
        };
      },
    });
    return { db, seen };
  };
  // Stage E: a sync no longer starts with a link lookup (the owner is one raw statement): it is detected by its
  // cycle-state read under the lock (ledger findMany WHERE affiliateId = one id — the sync's only such read).
  const synced = (db, from = 0) => db._log.slice(from).filter((l) => l.model === 'recruiterRewardLedger' && l.op === 'findMany' && typeof l.where?.affiliateId === 'string').map((l) => l.where.affiliateId);
  const kinds = (rows) => rows.filter((r) => r.kind !== 'batch' && r.kind !== 'members').map((r) => `${r.kind}:${r.id}`);
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  // An independent copy of a fake database (same rows, committed), e.g. to run two versions side by side.
  const clone = (src) => {
    const db = makeRecruiterFakeDb({ phase5: true });
    for (const k of Object.keys(src._tables)) db._tables[k].push(...structuredClone(src._tables[k]));
    return db;
  };

  // a) the statement: binds in source order, drift guard
  {
    const E = setup();
    const a = qualified(E.db, E.A);
    const S = spy(E.db);
    const r = await RS.reconcileRecruiterRewards({ db: S.db, now: T0 });
    const src = read('src/lib/services/recruiterRewardService.js');
    const fn = src.slice(src.indexOf('async function rewardCandidates('));
    const tpl = /db\.\$queryRaw`([\s\S]*?)`;/.exec(fn)?.[1] ?? '';
    const exprs = [...tpl.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    const SRC = { rid: 'recruiterId', after: 'after', size: 'size', cap: 'SEGMENT_DEPTH_CAP', tReward: 'REWARD_TYPES.RECRUIT_REWARD', tReversal: 'REWARD_TYPES.REVERSAL', smin: 'MIN_SALES_RANGE.min', smax: 'MIN_SALES_RANGE.max', dflt: 'DEFAULT_MIN_DELIVERED_SALES', awardsOn: 'awardsOn', delivered: 'DELIVERED_ORDER_STATUS', minSales: 'minDeliveredSales' };
    // Stage E: + the segment walk's depth cap (16 binds) and ONE 'members' row (segment members scanned)
    ok('the fake reads the candidates binds in the SOURCE placeholder order (16 binds: recruiterId ×2, after ×2, size, the segment depth cap, the types, the threshold range / default, awardsOn ×2, the delivered status, the current threshold)',
      exprs.length === 16 && eq(E.db._rewardCandidatesRoles.map((x) => SRC[x]), exprs), big({ exprs, roles: E.db._rewardCandidatesRoles }));
    ok('one candidates statement, binds = [null, null, null, null, 1000, 1000000, RECRUIT_REWARD, REVERSAL, 1, 100000, RECRUIT_REWARD, 10, true, "delivered", true, 10]; rows = the award + the batch row + the members row',
      S.seen.length === 1 && eq(S.seen[0].values, [null, null, null, null, 1000, 1000000, 'RECRUIT_REWARD', 'REVERSAL', 1, 100000, 'RECRUIT_REWARD', 10, true, 'delivered', true, 10])
      && eq(S.seen[0].rows, [{ kind: 'award', id: a.id, n: null }, { kind: 'batch', id: a.id, n: 1 }, { kind: 'members', id: null, n: 1 }]) && r.awarded === 1, big(S.seen.map((x) => [x.values, x.rows])));
    const { strings, values } = S.seen[0];
    const q = (st, vs) => E.db.$queryRaw(st, ...vs).then(() => 'ran', (e) => e.message);
    const drift = await q(strings.map((s) => s.replace('LIMIT', 'LIMIT 1 +')), values);
    const extra = await q(strings.map((s, i) => (i === strings.length - 1 ? `${s} , 1` : s)), values);
    const fewer = await q(strings, values.slice(0, 15));
    const badSize = await q(strings, values.map((v, i) => (i === 4 ? '1000' : v)));
    const badRid = await q(strings, values.map((v, i) => (i === 0 ? 'x' : v)));
    const badBool = await q(strings, values.map((v, i) => (i === 12 || i === 14 ? 1 : v)));
    const splitBool = await q(strings, values.map((v, i) => (i === 14 ? !v : v)));
    ok('drift guard: a changed / extended statement, a missing bind, a non-integer size, two different recruiterIds or a non-boolean awardsOn → refused with a clear message (two different awardsOn values too)',
      /recruiter-reward-candidates query changed \(missing: ORDER BY l\."affiliateId" LIMIT \$\?::int \), \| /.test(drift) && /query changed \(missing: none, but other text was added\)/.test(extra) && /must bind exactly 16 values/.test(fewer)
      && /non-integer size/.test(badSize) && /every rid placeholder .* must carry the same value/.test(badRid) && /non-boolean awardsOn/.test(badBool) && /every awardsOn placeholder .* must carry the same value/.test(splitBool), big([drift, extra, fewer, badSize, badRid, badBool, splitBool]));
  }

  // b) candidate selection
  {
    const E = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 } });
    const good = qualified(E.db, E.A);
    const pending = aff(E.db, E.A); orders(E.db, pending, 12); identity(E.db, pending, 'PENDING');
    const noId = aff(E.db, E.B); orders(E.db, noId, 12);
    const below = aff(E.db, E.A); orders(E.db, below, 9); identity(E.db, below);
    const fakeOnly = aff(E.db, E.B); orders(E.db, fakeOnly, 9); orders(E.db, fakeOnly, 5, { isFake: true }); orders(E.db, fakeOnly, 5, { status: 'cancelled' }); identity(E.db, fakeOnly);
    const openMet = qualified(E.db, E.B); await award(E, openMet);
    const unlinked = E.db._seed.affiliate({ username: 'unl5d' }); orders(E.db, unlinked, 20); identity(E.db, unlinked);
    const S = spy(E.db);
    const m = E.db._log.length;
    const r = await RS.reconcileRecruiterRewards({ db: S.db, now: T0 });
    const awardsSql = kinds(S.seen[0].rows);
    ok('award candidates in SQL: delivered ≥ the current threshold and no open reward — identity is not read in SQL (the pending / unsubmitted ones appear), below-threshold / fake / cancelled orders, the open reward and unlinked affiliates never',
      eq(awardsSql, [good.id, pending.id, noId.id].sort(cmp).map((id) => `award:${id}`)), big(awardsSql));
    ok('…then the identity filter: ONLY the APPROVED one is synced (one batched identity read; no sync for PENDING / missing identity)',
      eq(synced(E.db, m), [good.id]) && r.awarded === 1 && r.candidates === 1 && r.unchanged === 0 && r.checked === 6
      && E.db._log.slice(m).filter((l) => l.model === 'identityVerification' && l.op === 'findMany').length === 1, big(r));
    const again = spy(E.db);
    const m2 = E.db._log.length;
    const r2 = await RS.reconcileRecruiterRewards({ db: again.db, now: T0 });
    ok('an already-open reward (met) is never a candidate again: second run → only the 2 unapproved ones are award candidates again (one identity read), zero syncs, still 1 row',
      eq(kinds(again.seen[0].rows), [pending.id, noId.id].sort(cmp).map((id) => `award:${id}`)) && synced(E.db, m2).length === 0 && r2.awarded === 0 && r2.candidates === 0 && ledger(E.db, { affiliateId: good.id }).length === 1
      && E.db._log.slice(m2).filter((l) => l.model === 'identityVerification').length === 1, big(r2));
    for (const [label, settings] of [['rewards OFF', { version: 1, enabled: false, rewardAmountCents: 15000, minDeliveredSales: 10 }], ['amount 0', { version: 1, enabled: true, rewardAmountCents: 0, minDeliveredSales: 10 }], ['no settings (defaults OFF)', null]]) {
      const F = setup({ settings });
      qualified(F.db, F.A); qualified(F.db, F.B);
      const FS = spy(F.db);
      const mm = F.db._log.length;
      const rf = await RS.reconcileRecruiterRewards({ db: FS.db, now: T0 });
      ok(`${label}: awardsOn bound false, no award candidate, no identity read, zero syncs, nothing written`,
        FS.seen[0].values[12] === false && FS.seen[0].values[14] === false && kinds(FS.seen[0].rows).length === 0 && synced(F.db, mm).length === 0
        && F.db._log.slice(mm).filter((l) => l.model === 'identityVerification').length === 0 && F.db._tables.recruiterRewardLedger.length === 0 && rf.checked === 2, big(rf));
    }
    // reversal found while rewards are disabled
    const D = setup();
    const d1 = qualified(D.db, D.A); await award(D, d1);
    const d2 = qualified(D.db, D.A); await award(D, D === null ? null : d2);
    D.db._seed.settings({ version: 2, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10 });
    D.db._tables.affiliateOrder.find((o) => o.affiliateId === d1.id).status = 'cancelled';
    const DS = spy(D.db);
    const rd = await RS.reconcileRecruiterRewards({ db: DS.db, now: T0 });
    ok('rewards OFF: the open reward now below its threshold IS a reversal candidate (the met one is not) and is reversed (−15000)',
      eq(kinds(DS.seen[0].rows), [`reversal:${d1.id}`]) && rd.reversed === 1 && rd.candidates === 1 && ledger(D.db, { affiliateId: d1.id, type: 'REVERSAL' })[0]?.amountCents === -15000 && ledger(D.db, { affiliateId: d2.id, type: 'REVERSAL' }).length === 0, big(rd));
  }

  // c) equivalence with the pre-5d reconcile (commit 7e111e1) on randomized datasets
  {
    const OLD_COMMIT = '7e111e10df7c2413820f34a52fe200aebdefa72e';
    let oldSrc;
    try { oldSrc = execFileSync('git', ['show', `${OLD_COMMIT}:src/lib/services/recruiterRewardService.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch {
      throw new Error(`equivalence test: commit ${OLD_COMMIT} (the pre-Part-5d reward service) is missing from this clone — fetch it (git fetch origin ${OLD_COMMIT}) and rerun`);
    }
    const PRISMA_IMPORT = "import prisma from '../prisma.js';";
    const SETTINGS_FROM = "from '../recruiterSettings.js'";
    if (!oldSrc.includes(PRISMA_IMPORT) || !oldSrc.includes(SETTINGS_FROM) || !/export async function reconcileRecruiterRewards\(\{ db = prisma, recruiterId = null, now = new Date\(\) \} = \{\}\)/.test(oldSrc)) {
      throw new Error(`equivalence test: ${OLD_COMMIT}:src/lib/services/recruiterRewardService.js is not the expected pre-Part-5d service`);
    }
    const patched = oldSrc.replace(PRISMA_IMPORT, 'const prisma = null; // stubbed: the test always injects db').replace(SETTINGS_FROM, `from '${new URL('../src/lib/recruiterSettings.js', import.meta.url).href}'`);
    const OLD = await import(`data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`);
    const dataset = async (seed) => {
      let s = seed;
      const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
      const E = setup({ settings: null });
      const C = E.db._seed.recruiter({ username: `rec.c${seed}`, name: 'Recruteur C' });
      const recs = [E.A, E.B, C];
      let version = 0;
      const addVersion = () => {
        version += 1;
        const cents = rnd() < 0.15 ? 0 : (1 + Math.floor(rnd() * 300)) * 100;
        const odd = rnd() < 0.1; // a stored threshold outside 1..100000 (normalised to 10 by both)
        E.db._seed.settings({ version, enabled: cents > 0 && rnd() < 0.85, rewardAmountCents: cents, minDeliveredSales: odd ? 0 : 1 + Math.floor(rnd() * 8) });
      };
      const affs = [];
      const n = 15 + Math.floor(rnd() * 35);
      for (let i = 0; i < n; i++) {
        const a = aff(E.db, rnd() < 0.9 ? pick(recs) : null);
        for (let k = Math.floor(rnd() * 12); k > 0; k--) orders(E.db, a, 1, { status: rnd() < 0.7 ? 'delivered' : pick(['cancelled', 'pending', 'returned']), isFake: rnd() < 0.1 });
        const st = pick(['APPROVED', 'APPROVED', 'APPROVED', 'PENDING', 'REJECTED', null]);
        if (st) identity(E.db, a, st);
        affs.push(a);
      }
      const linkedIds = new Set(E.db._tables.recruiterAffiliateLink.map((l) => l.affiliateId));
      // legacy open rewards (cycle 1, legacy key, settingsVersion NULL or unknown) on a few linked affiliates
      for (const a of affs.filter((x) => linkedIds.has(x.id) && rnd() < 0.12)) {
        const link = E.db._tables.recruiterAffiliateLink.find((l) => l.affiliateId === a.id);
        E.db._seed.ledger({ recruiterId: link.recruiterId, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: 5000, settingsVersion: rnd() < 0.5 ? null : 99, idempotencyKey: `recruit:${a.id}` });
      }
      const mutate = (p) => { for (const o of E.db._tables.affiliateOrder) if (rnd() < p) o.status = o.status === 'delivered' ? pick(['cancelled', 'returned']) : 'delivered'; };
      const rounds = 1 + Math.floor(rnd() * 3);
      for (let v = 0; v < rounds; v++) {
        addVersion();
        for (const a of affs) if (rnd() < 0.6) await RS.syncRecruiterReward(a.id, { db: E.db, now: T0 });
        mutate(0.12);
      }
      if (rnd() < 0.5) addVersion();
      mutate(0.1);
      return E;
    };
    const ledgerSig = (db) => db._tables.recruiterRewardLedger.map((r) => big([r.type, r.cycle, r.amountCents, r.settingsVersion, r.idempotencyKey, r.recruiterId, r.affiliateId, r.reason, r.actorType, r.actorId])).sort();
    const auditSig = (db) => db._tables.recruiterAuditLog.map((r) => big([r.action, r.recruiterId, r.actorType, r.actorId, r.entityType, r.entityId, r.details])).sort();
    const counts = (r) => ({ checked: r.checked, awarded: r.awarded, reversed: r.reversed, unchanged: r.unchanged });
    const bad = [];
    let changes = 0, runs = 0, multiBatch = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const E = await dataset(seed * 7919);
      for (const variant of [{}, { batchSize: 7 }, { recruiterId: E.A.id, batchSize: 3 }, { recruiterId: E.B.id }]) {
        const O = clone(E.db), N = clone(E.db);
        const before = ledgerSig(O).length;
        const ro = await OLD.reconcileRecruiterRewards({ db: O, now: T0, ...(variant.recruiterId ? { recruiterId: variant.recruiterId } : {}) });
        const rn = await RS.reconcileRecruiterRewards({ db: N, now: T0, ...variant });
        runs += 1;
        changes += ledgerSig(O).length - before;
        if (rn.batches > 1) multiBatch += 1;
        if (!eq(ledgerSig(O), ledgerSig(N)) || !eq(auditSig(O), auditSig(N)) || !eq(counts(ro), counts(rn)) || rn.hasMore !== false || rn.cursor !== null || rn.busy !== false) {
          bad.push(`seed ${seed} ${big(variant)}: old ${big(counts(ro))} new ${big(counts(rn))}`);
        }
      }
    }
    ok(`old (7e111e1) vs new reconcile on 30 randomized datasets × 4 scopes / batch sizes (${runs} runs): identical ledger rows (type, cycle, amount, settingsVersion, key, …), identical audit rows, identical counts`,
      bad.length === 0, bad.slice(0, 3).join(' | '));
    ok(`…the comparison is not vacuous: ${changes} ledger rows written across the runs, ${multiBatch} runs spanned several batches`, changes > 50 && multiBatch > 20, `${changes} ${multiBatch}`);
  }

  // d) batches: 0 / 1 / 999 / 1000 / 1001 linked affiliates (default batch 1000) through the admin handler
  {
    const shapes = [];
    let good = true;
    for (const n of [0, 1, 999, 1000, 1001]) {
      const E = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 1000, minDeliveredSales: 1 } });
      const ids = [];
      for (let i = 0; i < n; i++) { const a = aff(E.db, i % 3 ? E.A : E.B); orders(E.db, a, 1); identity(E.db, a); ids.push(a.id); }
      ids.sort(cmp);
      const admin = recruiterRewardAdminHandlers({ db: E.db, now });
      const post = (body) => call(withAdminAuth(admin.reconcile), req('/api/admin/recruiter-rewards', { method: 'POST', body, cookie: adminCookie() }));
      const m = E.db._log.length;
      const seq = [];
      let cursor;
      for (let guard = 0; guard < 10; guard++) {
        const res = await post({ action: 'reconcile', ...(cursor ? { cursor } : {}) });
        if (res.status !== 200) { seq.push(res.status); break; }
        const rc = res.body.reconcile;
        seq.push([rc.checked, rc.awarded, rc.batches, rc.hasMore, rc.cursor === null ? null : rc.cursor === ids[999] ? 'id999' : rc.cursor]);
        if (!rc.hasMore) break;
        cursor = rc.cursor;
      }
      const syn = synced(E.db, m);
      const expected = {
        0: [[0, 0, 1, false, null]], 1: [[1, 1, 1, false, null]], 999: [[999, 999, 1, false, null]],
        1000: [[1000, 1000, 1, true, 'id999'], [0, 0, 1, false, null]], 1001: [[1000, 1000, 1, true, 'id999'], [1, 1, 1, false, null]],
      }[n];
      const once = syn.length === n && new Set(syn).size === n && eq([...syn].sort(cmp), ids);
      const rows = E.db._tables.recruiterRewardLedger;
      shapes.push(`${n}:${big(seq)}`);
      if (!eq(seq, expected) || !once || rows.length !== n || new Set(rows.map((r) => r.idempotencyKey)).size !== n) good = false;
      // the same scope in ONE service call (maxBatches unbounded) → ⌊n/1000⌋ + 1 batches
      if (n === 1001) {
        const F = clone(E.db);
        F._tables.recruiterRewardLedger.length = 0; F._tables.recruiterAuditLog.length = 0;
        const all = await RS.reconcileRecruiterRewards({ db: F, now: T0 });
        if (!(all.batches === 2 && all.checked === 1001 && all.awarded === 1001 && all.hasMore === false && all.cursor === null)) { good = false; shapes.push(`unbounded ${big(all)}`); }
      }
    }
    ok('0 / 1 / 999 / 1000 / 1001 linked affiliates, one batch of ≤ 1000 per admin request: exact checked / batches / hasMore / cursor (the last scanned id, null when done); every affiliate synced exactly once, none skipped or duplicated; one ledger row each',
      good, shapes.join(' | '));
  }

  // e) small batches, deterministic continuation, restart and retry
  {
    const E = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 1000, minDeliveredSales: 1 } });
    const ids = [];
    for (let i = 0; i < 300; i++) { const a = aff(E.db, i % 2 ? E.A : E.B); orders(E.db, a, 1); if (i % 5) identity(E.db, a); ids.push(a.id); }
    ids.sort(cmp);
    const base = clone(E.db);
    const m = E.db._log.length;
    const cursors = [];
    const scanned = [];
    let cursor = null;
    for (let guard = 0; guard < 100; guard++) {
      const r = await RS.reconcileRecruiterRewards({ db: E.db, now: T0, after: cursor, batchSize: 7, maxBatches: 1 });
      scanned.push(r.checked);
      cursors.push(r.cursor);
      if (!r.hasMore) break;
      cursor = r.cursor;
    }
    const syn = synced(E.db, m);
    const approved = ids.filter((id) => E.db._tables.identityVerification.some((v) => v.affiliateId === id && v.status === 'APPROVED'));
    ok('batchSize 7 over 300 affiliates, one batch per call: 43 batches (42 × 7 + 6), each cursor = the 7k-th id, the last null; every approved affiliate synced exactly once (in id order), the 60 without identity never',
      scanned.length === 43 && scanned.slice(0, 42).every((x) => x === 7) && scanned[42] === 6 && cursors.slice(0, 42).every((c, k) => c === ids[7 * k + 6]) && cursors[42] === null
      && eq(syn, approved) && E.db._tables.recruiterRewardLedger.length === 240, big({ n: scanned.length, last: scanned.at(-1), syn: syn.length }));
    // deterministic continuation: the same saved cursor on a fresh copy → the same next cursor / scanned set
    const F = clone(base);
    const k = 17;
    const again = await RS.reconcileRecruiterRewards({ db: F, now: T0, after: cursors[k - 1], batchSize: 7, maxBatches: 1 });
    ok('deterministic continuation: resuming from a saved cursor on an identical copy scans the same 7 ids and returns the same next cursor', again.checked === 7 && again.cursor === cursors[k] && eq(synced(F).sort(cmp), approved.filter((id) => id > cursors[k - 1] && id <= cursors[k])), big(again));
    // retry of the same batch, then of the whole run: nothing new
    const before = E.db._tables.recruiterRewardLedger.length;
    const retry = await RS.reconcileRecruiterRewards({ db: E.db, now: T0, after: cursors[k - 1], batchSize: 7, maxBatches: 1 });
    const whole = await RS.reconcileRecruiterRewards({ db: E.db, now: T0, batchSize: 7 });
    ok('retrying a batch (and re-running everything) writes nothing new: no candidate, zero awards, same ledger',
      retry.awarded === 0 && retry.candidates === 0 && whole.awarded === 0 && whole.batches === 43 && E.db._tables.recruiterRewardLedger.length === before && new Set(E.db._tables.recruiterRewardLedger.map((r) => r.idempotencyKey)).size === before);
    // a failure in the middle of a batch: the run throws, the lease is released, a restart from the saved cursor completes without duplicates
    const R = clone(base);
    let n = 0;
    const failing = new Proxy(R, { get(t, p) { if (p === '$transaction') return (fn, o) => t.$transaction(async (tx) => { if (++n === 25) throw Object.assign(new Error('boom'), { code: 'INJECTED' }); return fn(tx); }, o); return t[p]; } });
    let saved = null, thrown = null;
    for (let guard = 0; guard < 100; guard++) {
      try {
        const r = await RS.reconcileRecruiterRewards({ db: failing, now: T0, after: saved, batchSize: 7, maxBatches: 1 });
        if (!r.hasMore) break;
        saved = r.cursor;
      } catch (e) { if (thrown) throw e; thrown = e; }
    }
    ok('an error inside a batch (sync transaction 25) fails that call; the lease and every lock are released; the restart from the last saved cursor completes; no duplicate row, every approved affiliate rewarded once',
      thrown?.code === 'INJECTED' && R._locks.size === 0 && R._openTx.size === 0 && R._tables.recruiterRewardLedger.length === 240
      && new Set(R._tables.recruiterRewardLedger.map((r) => r.affiliateId)).size === 240, big({ thrown: thrown?.code, rows: R._tables.recruiterRewardLedger.length }));
    // recruiter scope: every batch of that recruiter, no lease
    const W = clone(base);
    const mw = W._log.length;
    const rw = await RS.reconcileRecruiterRewards({ db: W, now: T0, recruiterId: E.A.id, batchSize: 7 });
    const aIds = ids.filter((id) => W._tables.recruiterAffiliateLink.some((l) => l.affiliateId === id && l.recruiterId === E.A.id));
    ok('recruiter scope (wallet): ALL batches of that recruiter in one call (150 links → 22 batches), only their affiliates, no lease statement',
      rw.checked === 150 && rw.batches === 22 && rw.hasMore === false && rw.cursor === null && synced(W, mw).every((id) => aIds.includes(id)) && rw.awarded === aIds.filter((id) => approved.includes(id)).length
      && !W._log.slice(mw).some((l) => l.model === '$queryRaw' && /pg_try_advisory_xact_lock/.test(l.sql)), big(rw));
  }

  // f) the lease: one full run at a time, released on every end; the syncs run beside it
  {
    // the fake's try-lock itself
    const L = setup();
    let gate; const held = new Promise((r) => { gate = r; });
    let tx1Ok = null, tx1Again = null;
    const t1 = L.db.$transaction(async (tx) => { tx1Ok = (await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`)[0].ok; tx1Again = (await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`)[0].ok; await held; });
    while (tx1Ok === null || tx1Again === null) await new Promise((r) => setImmediate(r));
    const t2 = await L.db.$transaction(async (tx) => tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`);
    const outside = await L.db.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`.then(() => 'ran', (e) => e.message);
    gate(); await t1;
    const t3 = await L.db.$transaction(async (tx) => tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`);
    await L.db.$transaction(async (tx) => { await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`; throw new Error('rollback'); }).catch(() => null);
    const t4 = await L.db.$transaction(async (tx) => tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`);
    ok('fake try-lock: [{ ok: true }] for the first transaction (again true in it), [{ ok: false }] for a concurrent one (no wait), refused outside a transaction, released on commit and on rollback',
      tx1Ok === true && tx1Again === true && eq(t2, [{ ok: false }]) && /outside a transaction/.test(outside) && eq(t3, [{ ok: true }]) && eq(t4, [{ ok: true }]) && L.db._locks.size === 0, big({ tx1Ok, t2, outside, t3, t4 }));

    // two concurrent admin requests: one runs, the other → 409 RECONCILE_BUSY (French text); next request not busy
    const E = setup();
    const q = [qualified(E.db, E.A), qualified(E.db, E.B), qualified(E.db, E.A)];
    let release; const paused = new Promise((r) => { release = r; });
    let reached; const atCandidates = new Promise((r) => { reached = r; });
    let first = true;
    const during = [];
    E.hookBox.fn = async (m, op, a) => {
      if (m === '$queryRaw' && isCand(a?.sql) && first) { first = false; reached(); await paused; }
      if (m === 'recruiterRewardLedger' && op === 'create') during.push([E.db._locks.has(LEASE), E.db._openTx.size]);
    };
    const admin = recruiterRewardAdminHandlers({ db: E.db, now });
    const post = (body) => call(withAdminAuth(admin.reconcile), req('/api/admin/recruiter-rewards', { method: 'POST', body, cookie: adminCookie() }));
    const p1 = post({ action: 'reconcile' });
    await atCandidates;
    const p2 = await post({ action: 'reconcile' });
    const scoped = await RS.reconcileRecruiterRewards({ db: E.db, now: T0, recruiterId: E.B.id });
    const svcBusy = await RS.reconcileRecruiterRewards({ db: E.db, now: T0, after: q[0].a?.id ?? q[0].id });
    release();
    const r1 = await p1;
    E.hookBox.fn = null;
    const r3 = await post({ action: 'reconcile' });
    ok('concurrent admin reconcile requests: the second → 409 { code: RECONCILE_BUSY, error: <fixed French text> } without running anything; the first → 200 and awards',
      p2.status === 409 && eq(p2.body, { code: 'RECONCILE_BUSY', error: 'Une vérification des récompenses est déjà en cours. Réessayez dans un instant.' }) && r1.status === 200 && r1.body.reconcile.awarded === 2, big([p2.body, r1.body]));
    ok('…at the service: busy → { checked 0, …, batches 0, cursor = the given cursor, hasMore true, busy true } (the caller retries the same batch)',
      eq(svcBusy, { checked: 0, awarded: 0, reversed: 0, unchanged: 0, candidates: 0, batches: 0, cursor: q[0].id, hasMore: true, busy: true, groupChecked: 0, groupAwarded: 0, groupReversed: 0 }), big(svcBusy));
    ok('…a recruiter-scoped run (wallet) is never blocked by the lease: it ran meanwhile and awarded B\'s affiliate', scoped.busy === false && scoped.awarded === 1);
    ok('…the syncs (the admin run\'s 2 and the scoped run\'s 1) ran in their OWN transactions while the lease transaction stayed open: lease held and exactly 2 open transactions (lease + that sync) at every ledger insert',
      during.length === 3 && during.every(([l, n]) => l === true && n === 2), big(during));
    ok('…lease released after the run: the next request is not busy (200, nothing left to do), no lock / transaction left', r3.status === 200 && r3.body.reconcile.busy === false && r3.body.reconcile.candidates === 0 && E.db._locks.size === 0 && E.db._openTx.size === 0, r3.text);

    // an error thrown inside the batch (the candidates statement itself) → the lease is released
    const X = setup();
    qualified(X.db, X.A);
    X.hookBox.fn = (m, _op, a) => { if (m === '$queryRaw' && isCand(a?.sql)) throw Object.assign(new Error('db down'), { code: 'P1001' }); };
    const xe = await RS.reconcileRecruiterRewards({ db: X.db, now: T0 }).then(() => null, (e) => e.code);
    const leaked = X.db._locks.size + X.db._openTx.size;
    X.hookBox.fn = null;
    const xr = await RS.reconcileRecruiterRewards({ db: X.db, now: T0 });
    const xa = recruiterRewardAdminHandlers({ db: X.db, now });
    X.hookBox.fn = (m, _op, a) => { if (m === '$queryRaw' && isCand(a?.sql)) throw new Error('db down'); };
    const xh = await silence(() => call(withAdminAuth(xa.reconcile), req('/api/admin/recruiter-rewards', { method: 'POST', body: { action: 'reconcile' }, cookie: adminCookie() })));
    X.hookBox.fn = null;
    ok('an error inside the batch: the call fails (handler → 500 SERVER_ERROR), the lease is released (no lock, no open transaction), the next run is NOT busy and does the work',
      xe === 'P1001' && leaked === 0 && xr.busy === false && xr.awarded === 1 && xh.out.status === 500 && xh.out.body.code === 'SERVER_ERROR' && X.db._locks.size === 0, big({ xe, leaked, xr }));
  }

  // g) financial invariants under duplicate / concurrent reconciliation
  {
    const E = setup();
    const qs = []; for (let i = 0; i < 30; i++) qs.push(qualified(E.db, i % 2 ? E.A : E.B));
    const toReverse = []; for (let i = 0; i < 10; i++) { const x = qualified(E.db, i % 2 ? E.A : E.B); await award(E, x); toReverse.push(x); }
    for (const x of toReverse) E.db._tables.affiliateOrder.find((o) => o.affiliateId === x.id && o.status === 'delivered').status = 'returned';
    E.hookBox.fn = () => new Promise((r) => setImmediate(r));
    const res = await Promise.all([
      ...Array.from({ length: 4 }, () => RS.reconcileRecruiterRewards({ db: E.db, now: T0 })),
      ...Array.from({ length: 3 }, () => RS.reconcileRecruiterRewards({ db: E.db, now: T0, recruiterId: E.A.id, batchSize: 4 })),
      ...Array.from({ length: 3 }, () => RS.reconcileRecruiterRewards({ db: E.db, now: T0, recruiterId: E.B.id })),
      ...qs.slice(0, 10).map((x) => award(E, x)),
    ]);
    E.hookBox.fn = null;
    const rows = E.db._tables.recruiterRewardLedger;
    const reported = res.reduce((t, r) => t + (r.awarded ?? (r.action === 'AWARDED' ? 1 : 0)) + (r.reversed ?? (r.action === 'REVERSED' ? 1 : 0)), 0);
    const pairsOk = rows.filter((r) => r.type === 'REVERSAL').every((v) => { const w = rows.find((x) => x.type === 'RECRUIT_REWARD' && x.affiliateId === v.affiliateId && x.cycle === v.cycle); return w && v.amountCents === -w.amountCents && v.recruiterId === w.recruiterId; });
    ok('10 concurrent reconciles (4 full — the lease admits one at a time — 6 recruiter-scoped) + 10 direct syncs: exactly one reward per qualifying affiliate and one reversal per dropped one (30 + 10 + 10 rows), unique keys, each change reported once',
      rows.length === 50 && new Set(rows.map((r) => r.idempotencyKey)).size === 50 && qs.every((x) => ledger(E.db, { affiliateId: x.id }).length === 1)
      && toReverse.every((x) => ledger(E.db, { affiliateId: x.id, type: 'REVERSAL' }).length === 1) && reported === 40 && res.slice(0, 4).filter((r) => r.busy).length >= 1, `rows=${rows.length} reported=${reported} busy=${res.slice(0, 4).filter((r) => r.busy).length}`);
    ok('…every reversal = −its reward (same cycle, same recruiter), never more; audits match the rows (40 earned incl. the seeded 10, 10 reversed)', pairsOk && audits(E.db, 'RECRUIT_REWARD_EARNED').length === 40 && audits(E.db, 'RECRUIT_REWARD_REVERSED').length === 10);
    const ledgerOps = new Set(E.db._log.filter((l) => l.model === 'recruiterRewardLedger').map((l) => l.op));
    const refused = [];
    for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'createMany']) refused.push(await E.db.recruiterRewardLedger[op]({ where: { id: rows[0].id }, data: { amountCents: 1 } }).then(() => 'ran', (e) => /append-only/.test(e.message)));
    // Phase 7: + findFirst (the read-only "any group reward" probe of a full run).
    ok('…no ledger update / delete was ever called (only create / findMany / the read-only findFirst probe), and the fake still refuses update / updateMany / upsert / delete / deleteMany / createMany',
      [...ledgerOps].every((op) => ['create', 'findMany', 'findFirst'].includes(op)) && refused.every((x) => x === true), big([...ledgerOps, refused]));
    ok('…no lock left held, no transaction left open', E.db._locks.size === 0 && E.db._openTx.size === 0);

    // award (candidate) racing a cancellation, at every step of the candidate's sync
    const out = [];
    let allOk = true;
    // steps after the candidates statement: identity list (0), then the sync — link (1), ledger (2), count (3),
    // settings (4), affiliate (5), identity (6), ledger insert (7), audit insert (8)
    for (let k = 0; k <= 8; k++) {
      const C = setup();
      const x = qualified(C.db, C.A);
      let steps = -1, started = false, cancelled = false;
      C.hookBox.fn = (m, op, a) => {
        if (m === '$queryRaw' && isCand(a?.sql)) { started = true; return; }
        if (started && m !== '$queryRaw' && ++steps === k) { C.db._tables.affiliateOrder.find((o) => o.affiliateId === x.id).status = 'cancelled'; cancelled = true; }
      };
      const r = await RS.reconcileRecruiterRewards({ db: C.db, now: T0 });
      C.hookBox.fn = null;
      const r2 = await RS.reconcileRecruiterRewards({ db: C.db, now: T0 });
      const rows2 = ledger(C.db, { affiliateId: x.id });
      const net = rows2.reduce((t, y) => t + y.amountCents, 0);
      const okK = cancelled && net === 0 && (rows2.length === 0 ? r.unchanged === 1 && r2.candidates === 0 : rows2.length === 2 && r.awarded === 1 && r2.reversed === 1);
      if (!okK) allOk = false;
      out.push(`${k}:${rows2.map((y) => y.type[4]).join('')}`);
    }
    ok('an award candidate cancelled at EVERY step of its sync: either the sync sees 9 (no reward) or the reward commits and the next reconcile reverses it — always net 0, never a stale award left open',
      allOk && out.some((s) => s.endsWith(':')) && out.some((s) => s.endsWith(':UR')), out.join(' '));
  }

  // h) wallet GET: no full-scope read — only the candidate statement(s) of the caller's network
  {
    const W = setup();
    for (let i = 0; i < 40; i++) { const x = aff(W.db, i % 2 ? W.A : W.B); orders(W.db, x, 3); identity(W.db, x); }
    const mine = qualified(W.db, W.A); await award(W, mine);
    const theirs = qualified(W.db, W.B); await award(W, theirs);
    Object.assign(W.db._tables.recruiter.find((r) => r.id === W.A.id), { bankName: 'CIH Bank', accountName: 'Recruteur A', rib: '011780000012345678901234' });
    const h = recruiterWalletHandlers({ db: W.db, now, rateLimit: noLimit });
    const wallet = withRecruiterAuth(h.wallet);
    const withdraw = withRecruiterAuth(h.withdraw);
    const binds = [];
    // Stage F: the wallet scope runs the network candidates statement (the roots of N(R)) — never the admin statement
    const isNetCand = (sql) => /^\s*\/\* recruiter-reward-network-candidates \*\//.test(sql ?? '');
    let adminCand = 0;
    W.hookBox.fn = (m, _op, a) => { if (m === '$queryRaw' && isNetCand(a?.sql)) binds.push(a.values); if (m === '$queryRaw' && isCand(a?.sql)) adminCand += 1; };
    const m0 = W.db._log.length;
    const g0 = await call(wallet, req('/api/recruiter/wallet', { cookie: recruiterCookie(W.A) }));
    const log0 = W.db._log.slice(m0);
    const fullScope = (l) => (l.model === 'recruiterAffiliateLink' && l.op === 'findMany') || (l.model === 'affiliateOrder' && l.op === 'groupBy')
      || (l.model === 'recruiterRewardLedger' && l.op === 'findMany' && (l.where?.affiliateId?.in !== undefined || !l.where?.recruiterId && !l.where?.affiliateId))
      || (l.model === 'identityVerification' && l.op === 'findMany' && !eq(l.where, { affiliateId: { in: due } }));
    let due = [];
    ok('Stage F: wallet GET with nothing due: ONE network candidate statement bound to the caller (recruiterId ×4, no cursor), no admin candidate statement, no lease, ZERO sync transactions, no full-scope read (links findMany / ledger over many affiliates / affiliateOrder.groupBy / identity list)',
      g0.status === 200 && binds.length === 1 && binds[0][0] === W.A.id && binds[0][1] === null && binds[0].filter((v) => v === W.A.id).length === 4 && !binds[0].includes(W.B.id) && adminCand === 0
      && log0.filter((l) => l.model === '$transaction').length === 0
      && !log0.some((l) => l.model === '$queryRaw' && /pg_try_advisory_xact_lock/.test(l.sql)) && !log0.some(fullScope) && g0.body.wallet.totals.earnedCents === 15000, big(log0.map((l) => `${l.model}.${l.op}`)));
    const w1 = await call(withdraw, req('/api/recruiter/wallet/withdrawals', { method: 'POST', body: { amountMad: '150', requestId: randomUUID() }, cookie: recruiterCookie(W.A) }));
    // now: one of A's affiliates qualifies, the rewarded one drops below its threshold; B's changes too
    const fresh = aff(W.db, W.A); orders(W.db, fresh, 10); identity(W.db, fresh);
    W.db._tables.affiliateOrder.find((o) => o.affiliateId === mine.id && o.status === 'delivered').status = 'cancelled';
    W.db._tables.affiliateOrder.find((o) => o.affiliateId === theirs.id && o.status === 'delivered').status = 'cancelled';
    binds.length = 0;
    due = [fresh.id]; // the only award candidate of A's network: its identity is the only one read
    const m1 = W.db._log.length;
    const g1 = await call(wallet, req('/api/recruiter/wallet', { cookie: recruiterCookie(W.A) }));
    const log1 = W.db._log.slice(m1);
    ok('wallet GET processes the caller\'s due reward AND reversal candidates (exactly 2 syncs), never B\'s; still no full-scope read (the identity read covers exactly the 1 award candidate)',
      g1.status === 200 && binds.length === 1 && log1.filter((l) => l.model === '$transaction').length === 2 && eq(synced(W.db, m1).sort(cmp), [fresh.id, mine.id].sort(cmp))
      && ledger(W.db, { affiliateId: fresh.id }).length === 1 && ledger(W.db, { affiliateId: mine.id, type: 'REVERSAL' }).length === 1 && ledger(W.db, { affiliateId: theirs.id, type: 'REVERSAL' }).length === 0 && !log1.some(fullScope), big(log1.map((l) => `${l.model}.${l.op}`)));
    ok('…balance is live and net: earned 15000 (+15000 −15000 +15000), 150 MAD pending → available 0; a further 0.01 MAD request → 400 INSUFFICIENT_BALANCE',
      w1.status === 201 && g1.body.wallet.totals.earnedCents === 15000 && g1.body.wallet.totals.availableCents === 0
      && (await call(withdraw, req('/api/recruiter/wallet/withdrawals', { method: 'POST', body: { amountMad: '0.01', requestId: randomUUID() }, cookie: recruiterCookie(W.A) }))).body?.code === 'INSUFFICIENT_BALANCE', big(g1.body.wallet.totals));
    W.hookBox.fn = null;
  }

  // i) admin handler: cursor validation, one batch per request, first batch on save
  {
    const E = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 1000, minDeliveredSales: 1 } });
    for (let i = 0; i < 1003; i++) { const a = aff(E.db, i % 2 ? E.A : E.B); orders(E.db, a, 1); identity(E.db, a); }
    const admin = recruiterRewardAdminHandlers({ db: E.db, now });
    const post = (body, raw) => call(withAdminAuth(admin.reconcile), req('/api/admin/recruiter-rewards', { method: 'POST', body, raw, cookie: adminCookie() }));
    const bad = [];
    for (const cursor of ['bad id;', '', 'x'.repeat(101), 42, true, { a: 1 }, ['x'], 'a b']) bad.push((await post({ action: 'reconcile', cursor })).body?.code);
    const m = E.db._log.length;
    ok('invalid cursor (not 1–100 chars of [A-Za-z0-9_-], not a string) → 400 INVALID_INPUT, nothing read', bad.every((c) => c === 'INVALID_INPUT') && E.db._log.length === m, bad.join(','));
    const s = await call(withAdminAuth(admin.saveSettings), req('/api/admin/recruiter-rewards/settings', { method: 'POST', cookie: adminCookie(), body: { enabled: true, rewardAmountMad: '10', minDeliveredSales: 1 } }));
    const sr = s.body.reconcile;
    ok('saving settings runs ONLY the first batch: 1000 checked / awarded, hasMore true, cursor = the 1000th id',
      s.status === 201 && sr.checked === 1000 && sr.awarded === 1000 && sr.batches === 1 && sr.hasMore === true && typeof sr.cursor === 'string' && E.db._tables.recruiterRewardLedger.length === 1000, big(sr));
    const n1 = await post({ action: 'reconcile', cursor: sr.cursor });
    const nNull = await post({ action: 'reconcile', cursor: null });
    ok('continuing with that cursor → the remaining 3 (hasMore false, cursor null); cursor null restarts from the start (1000 checked, nothing left to award)',
      n1.status === 200 && n1.body.reconcile.checked === 3 && n1.body.reconcile.awarded === 3 && n1.body.reconcile.hasMore === false && n1.body.reconcile.cursor === null
      && nNull.body.reconcile.checked === 1000 && nNull.body.reconcile.awarded === 0 && nNull.body.reconcile.hasMore === true && E.db._tables.recruiterRewardLedger.length === 1003, big([n1.body, nNull.body.reconcile]));
    const unknown = await post({ action: 'reconcile', cursor: 'zzzz' });
    ok('a well-formed cursor past every id → 200, 0 checked, hasMore false (no error, no write)', unknown.status === 200 && unknown.body.reconcile.checked === 0 && unknown.body.reconcile.hasMore === false && unknown.body.reconcile.cursor === null);
    const pageSrc = read('src/app/admin/recruiter-rewards/page.jsx');
    ok('the admin page loops one-batch requests with the cursor while hasMore (and stops on an error or a repeated cursor)',
      /JSON\.stringify\(\{ action: "reconcile", \.\.\.\(cursor \? \{ cursor \} : \{\}\) \}\)/.test(pageSrc) && /if \(!r\.hasMore \|\| !r\.cursor \|\| r\.cursor === cursor\) return total;/.test(pageSrc) && /if \(!res\.ok\) \{ total\.error = errorText\(res, body\); return total; \}/.test(pageSrc));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
