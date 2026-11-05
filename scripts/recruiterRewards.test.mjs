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
  ok('save → version 1, 150.50 MAD stored as 15050 cents', eq(v1.v, { version: 1, enabled: true, rewardAmountCents: 15050, minDeliveredSales: 10 }), JSON.stringify(v1));
  const au = audits(E.db, 'RECRUITER_SETTINGS_CHANGED');
  ok('audited: RECRUITER_SETTINGS_CHANGED by the ADMIN (no recruiter), entity = the version, details = the values',
    au.length === 1 && au[0].actorType === 'ADMIN' && au[0].actorId === 'admin-1' && au[0].recruiterId === null && au[0].entityId === '1'
    && eq(au[0].details, { version: 1, enabled: true, rewardAmountCents: 15050, minDeliveredSales: 10 }));
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
  ok('a reward credited to a recruiter who is not the affiliate\'s → refused by the link guard', guard?.code === 'P2010' && /not linked/.test(guard?.message));

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
  const ro = await RS.reconcileRecruiterRewards({ db: off.db });
  // Phase 6 part 3a: the REVERSAL pass runs even with rewards OFF, so the batched reads still happen
  // (settings, links, ledger, real delivered counts — no identity read, no write).
  ok('rewards OFF → reconcile awards nothing (4 batched reads for the reversal pass, no identity read, no write)',
    eq(ro, { checked: 1, awarded: 0, reversed: 0, unchanged: 0 }) && off.db._queryCount() - before === 4 && off.db._tables.recruiterRewardLedger.length === 0, `${JSON.stringify(ro)} q=${off.db._queryCount() - before}`);

  const queries = async (n, qualify) => {
    const S = setup();
    for (let i = 0; i < n; i++) { const x = aff(S.db, i % 2 ? S.A : S.B); orders(S.db, x, qualify ? 10 : 2); identity(S.db, x); }
    const b0 = S.db._queryCount();
    const r = await RS.reconcileRecruiterRewards({ db: S.db });
    return { q: S.db._queryCount() - b0, r };
  };
  const q10 = await queries(10, false), q300 = await queries(300, false);
  // Phase 6 part 3a: settings, links, ledger, order counts (identity is read only for award candidates).
  ok('no N+1: reconcile over 10 and 300 non-qualifying affiliates issues the same number of queries (4)', q10.q === q300.q && q10.q === 4, `10→${q10.q} 300→${q300.q}`);
  const w20 = await queries(20, true);
  // Phase 6 part 3a: each award is one syncRecruiterReward transaction that re-reads every fact under the
  // per-affiliate lock: link, lock, ledger, count, settings, affiliate, identity + 2 writes (ledger + audit) = 9.
  ok('with awards: exactly base (5, incl. the batched identity read) + 9 statements per awarded affiliate (re-check under the lock + ledger + audit)', w20.r.awarded === 20 && w20.q === 5 + 9 * 20, `q=${w20.q} awarded=${w20.r.awarded}`);
  const q6k = await queries(6000, false);
  ok('6000 affiliates: chunked by 5000 ids (settings, links, 2 ledger chunks, 2 order chunks; no candidate → no identity read)', q6k.q === 6 && q6k.r.checked === 6000, `q=${q6k.q}`);
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
  ok('admin recheck: { action: "reconcile" } → 200 with the counts; anything else → 400', rc.status === 200 && eq(keys(rc.body.reconcile), ['awarded', 'checked', 'reversed', 'unchanged']) && rcBad.status === 400);
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
  ok('the reward service touches only settings / ledger / audit / links / orders (counts) / identity (status) / affiliate (existence) / $transaction',
    [...models].every((m) => ['recruiterSettingsVersion', 'recruiterRewardLedger', 'recruiterAuditLog', 'recruiterAffiliateLink', 'affiliateOrder', 'identityVerification', 'affiliate', '$transaction', '$executeRaw'].includes(m)), [...models].join(','));
  // Phase 6 part 3a adds exactly one: the per-affiliate reward lock (the SAME key as the cycle-guard trigger);
  // the part 3b race fix adds exactly one more: the per-recruiter money lock (shared with the withdrawal payment).
  ok('the ONLY raw SQL of the reward service: the settings advisory lock (same key as the version trigger), the per-affiliate reward lock (same key as the cycle guard) and the per-recruiter money lock, all tagged / bound',
    [...rs.matchAll(/\$(?:executeRaw|queryRaw)(?:Unsafe)?`([^`]*)`/g)].map((m) => m[1]).join('|') === "SELECT pg_advisory_xact_lock(hashtext('recruiter_settings_versions'))|SELECT pg_advisory_xact_lock(hashtext(${'recruit:' + affiliateId}))|SELECT pg_advisory_xact_lock(hashtext(${'recruiter-money:' + recruiterId}))"
    && !/\$(?:executeRaw|queryRaw)Unsafe/.test(rs));
  ok('identity is read with select affiliateId / status only (never a document field)', /identityVerification\.findMany\(\{ where: \{ affiliateId: \{ in: part \} \}, select: \{ affiliateId: true, status: true \} \}\)/.test(rs) && !/cinFront|cinBack/.test(rs));
  const ws = stripJs(read('src/lib/services/recruiterWalletService.js'));
  ok('the wallet service never reads an affiliate balance, commission, point or provider', !/commission|rewardPoint|getAffiliateBalance|getWithdrawableBalance|computeRegisteredBalance|providerRegistry|bonusBalance/.test(ws));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
