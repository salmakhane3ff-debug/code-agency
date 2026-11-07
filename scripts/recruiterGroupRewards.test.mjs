#!/usr/bin/env node
/**
 * scripts/recruiterGroupRewards.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 7: Reward B, the recruiter GROUP reward (migration
 * 20261112). In-memory fake database only (scripts/lib/recruiterFakeDb.mjs, phase5 mode, which
 * models 20261112: the 4 settings columns + their CHECK, the GROUP_REWARD / GROUP_REVERSAL types,
 * the group CHECK (sign, no affiliate, version, exact keys), one of each per (recruiter, cycle), the
 * group cycle guard under the per-recruiter group lock, and the `/* recruiter-group-qualified *\/`
 * statement behind an exact drift guard) — never a real database.
 * Proves:
 *   • settings: validation / normalization / defaults of the 4 group fields; admin save + audit
 *     (old / new values of both reward types); per-field errors through the admin handler
 *   • 9 / exactly 10 / 11 qualified affiliates → 0 / 1 / 1 group reward; 20 → 2; one affiliate with
 *     20 sales counts once; mixed ineligible affiliates (KYC not approved, fake orders, cancelled /
 *     returned / refused, unlinked, another recruiter's) never count; linked affiliates at any depth do
 *   • reversal when one drops below (cancellation), also with group rewards OFF; requalification →
 *     a new cycle; the reversal is judged with THE REWARD's settings version
 *   • concurrent syncs / reconciles / hooks → no duplicate; duplicate reconciliation idempotent
 *   • hooks trigger the group sync of the linked recruiter (and never throw)
 *   • wallet: balance includes group rows, negative after reversals; group history rows
 *   • payment vs group reversal ordering (the shared money lock)
 *   • database guards of the fake (CHECKs, cycle guard, uniqueness, append-only)
 *   • Reward A (individual) unchanged next to Reward B
 * Run: node scripts/recruiterGroupRewards.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-group-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const RS = await import('../src/lib/services/recruiterRewardService.js');
const WS = await import('../src/lib/services/recruiterWalletService.js');
const HK = await import('../src/lib/recruiterRewardHooks.js');
const SET = await import('../src/lib/recruiterSettings.js');
const V = await import('../src/lib/recruiterVisibility.js');
const { recruiterRewardAdminHandlers } = await import('../src/lib/recruiterRewardAdminHandlers.js');
const { recruiterWalletHandlers } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const big = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);

const T0 = new Date('2026-11-12T10:00:00.000Z');
const now = () => new Date(T0);
const noLimit = () => null;
const GROUP_ON = { version: 1, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10, groupEnabled: true, groupRewardAmountCents: 50000, groupSize: 10, groupMinDeliveredSales: 10 };

const recruiterCookie = (r) => `recruiter_token=${signToken({ recruiterId: r.id, username: r.username, type: 'recruiter' })}`;
const adminCookie = () => `auth_token=${signToken({ userId: 'admin-1', email: 'admin@example.test', role: 'ADMIN' })}`;
const req = (url, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
};
const call = async (handler, r) => {
  const res = await handler(r, {});
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
};

let uniq = 0;
function setup({ settings = GROUP_ON } = {}) {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ phase5: true, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  if (settings) db._seed.settings(settings);
  for (const r of [A, B]) db._seed.recruiterIdentity({ recruiterId: r.id, status: 'APPROVED' });
  return { db, A, B, hookBox };
}
function aff(db, rec, extra = {}) {
  const a = db._seed.affiliate({ username: `grp${++uniq}`, name: `Affilié ${uniq}`, isActive: true, ...extra });
  if (rec) db._seed.link({ affiliateId: a.id, recruiterId: rec.id });
  return a;
}
function orders(db, a, n, extra = {}) { const out = []; for (let i = 0; i < n; i++) out.push(db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: false, ...extra })); return out; }
const identity = (db, a, status = 'APPROVED') => db._seed.identity({ affiliateId: a.id, status });
/** n affiliates of `rec`, each with `sales` real delivered orders and an APPROVED identity. */
const qualify = (db, rec, n, sales = 10, extra = {}) => Array.from({ length: n }, () => { const a = aff(db, rec, extra); const os = orders(db, a, sales); identity(db, a); return { a, os }; });
const ledger = (db, where = {}) => db._tables.recruiterRewardLedger.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).sort((x, y) => (x.seq < y.seq ? -1 : 1));
const group = (db, rec) => ledger(db, { recruiterId: rec.id }).filter((r) => r.type === 'GROUP_REWARD' || r.type === 'GROUP_REVERSAL');
const activeGroup = (db, rec) => { const g = group(db, rec); const rev = new Set(g.filter((r) => r.type === 'GROUP_REVERSAL').map((r) => r.cycle)); return g.filter((r) => r.type === 'GROUP_REWARD' && !rev.has(r.cycle)); };
const sum = (db, rec) => ledger(db, { recruiterId: rec.id }).reduce((t, r) => t + r.amountCents, 0);
const audits = (db, action) => db._tables.recruiterAuditLog.filter((r) => r.action === action);
const gsync = (E, rec = E.A) => RS.syncRecruiterGroupReward(rec.id, { db: E.db, now: T0 });
const cancel = (E, order, status = 'cancelled') => { E.db._tables.affiliateOrder.find((o) => o.id === order.id).status = status; };
const silence = async (fn) => {
  const orig = console.error; const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { out: await fn(), lines }; } finally { console.error = orig; }
};
const settle = (p, ms = 40) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('blocked'), ms))]);

// ── 1. settings rules ──────────────────────────────────────────────────────────
console.log('\n1. Settings rules (pure): defaults, validation, normalization, keys');
{
  ok('group defaults: OFF, 0 cents, groupSize 10, groupMinDeliveredSales 10 (frozen); REWARD_TYPES has GROUP_REWARD / GROUP_REVERSAL',
    eq(SET.DEFAULT_RECRUITER_GROUP_SETTINGS, { groupEnabled: false, groupRewardAmountCents: 0, groupSize: 10, groupMinDeliveredSales: 10 }) && Object.isFrozen(SET.DEFAULT_RECRUITER_GROUP_SETTINGS)
    && SET.REWARD_TYPES.GROUP_REWARD === 'GROUP_REWARD' && SET.REWARD_TYPES.GROUP_REVERSAL === 'GROUP_REVERSAL' && eq(SET.GROUP_SIZE_RANGE, { min: 1, max: 10000 }));
  ok('individual defaults unchanged (exactly 4 keys)', eq(SET.DEFAULT_RECRUITER_SETTINGS, { version: 0, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10 }));
  ok('keys: group:<recruiterId>:v<n> / group-reverse:<recruiterId>:v<n>', SET.groupRewardCycleKey('r1', 2) === 'group:r1:v2' && SET.groupReversalCycleKey('r1', 3) === 'group-reverse:r1:v3');
  const G = SET.validateRecruiterGroupSettingsInput;
  ok('valid group input → cents (MAD), size, threshold', eq(G({ groupEnabled: true, groupRewardAmountMad: '500,50', groupSize: '12', groupMinDeliveredSales: 7 }).value,
    { groupEnabled: true, groupRewardAmountCents: 50050, groupSize: 12, groupMinDeliveredSales: 7 }));
  ok('omitted group fields → defaults (OFF, 0, 10, 10)', eq(G({}).value, { groupEnabled: false, groupRewardAmountCents: 0, groupSize: 10, groupMinDeliveredSales: 10 }) && eq(G(null).value, G({}).value));
  ok('enabled with 0 / missing amount → AMOUNT_REQUIRED_WHEN_ENABLED; bad amount → INVALID_AMOUNT',
    G({ groupEnabled: true }).errors?.groupRewardAmountMad === 'AMOUNT_REQUIRED_WHEN_ENABLED' && G({ groupEnabled: 'true', groupRewardAmountMad: '0.00' }).errors?.groupRewardAmountMad === 'AMOUNT_REQUIRED_WHEN_ENABLED'
    && ['-1', '1.234', '1000000.01', 'x', {}, true].every((v) => G({ groupRewardAmountMad: v }).errors?.groupRewardAmountMad === 'INVALID_AMOUNT'));
  ok('groupSize 1..10000 (0, 10001, 1.5, "x", -2 → INVALID_GROUP_SIZE); bounds accepted',
    [0, 10001, 1.5, 'x', -2, '', true].every((v) => G({ groupSize: v }).errors?.groupSize === 'INVALID_GROUP_SIZE') && G({ groupSize: 1 }).value?.groupSize === 1 && G({ groupSize: '10000' }).value?.groupSize === 10000);
  ok('groupMinDeliveredSales 1..100000 like minDeliveredSales (0, 100001 → INVALID_COUNT)',
    [0, 100001, 2.5, 'abc'].every((v) => G({ groupMinDeliveredSales: v }).errors?.groupMinDeliveredSales === 'INVALID_COUNT') && G({ groupMinDeliveredSales: 100000 }).value?.groupMinDeliveredSales === 100000);
  ok('several group errors reported together', eq(Object.keys(G({ groupEnabled: true, groupRewardAmountMad: 'x', groupSize: 0, groupMinDeliveredSales: 0 }).errors).sort(), ['groupMinDeliveredSales', 'groupRewardAmountMad', 'groupSize']));
  const N = SET.normalizeRecruiterGroupSettings;
  ok('normalize: null / pre-20261112 row → group defaults; corrupt values fail safe', eq(N(null), SET.DEFAULT_RECRUITER_GROUP_SETTINGS) && eq(N({ version: 3, enabled: true }), { ...SET.DEFAULT_RECRUITER_GROUP_SETTINGS })
    && eq(N({ groupEnabled: 'true', groupRewardAmountCents: -5, groupSize: 0, groupMinDeliveredSales: 1e9 }), SET.DEFAULT_RECRUITER_GROUP_SETTINGS));
  ok('normalizeRecruiterSettingsWithGroup = individual 4 keys + group 4 keys; normalizeRecruiterSettings still 4 keys',
    eq(keys(SET.normalizeRecruiterSettingsWithGroup(GROUP_ON)), ['enabled', 'groupEnabled', 'groupMinDeliveredSales', 'groupRewardAmountCents', 'groupSize', 'minDeliveredSales', 'rewardAmountCents', 'version'])
    && eq(keys(SET.normalizeRecruiterSettings(GROUP_ON)), ['enabled', 'minDeliveredSales', 'rewardAmountCents', 'version']));
  ok('groupRewardsOn only when enabled AND amount > 0', SET.groupRewardsOn(GROUP_ON) && !SET.groupRewardsOn({ ...GROUP_ON, groupEnabled: false }) && !SET.groupRewardsOn({ ...GROUP_ON, groupRewardAmountCents: 0 }) && !SET.groupRewardsOn(null));
}

// ── 2. thresholds ──────────────────────────────────────────────────────────────
console.log('\n2. 9 / exactly 10 / 11 / 20 qualified affiliates; distinct affiliates, never aggregated sales');
{
  for (const [n, want] of [[9, 0], [10, 1], [11, 1], [19, 1], [20, 2], [25, 2], [30, 3]]) {
    const E = setup();
    qualify(E.db, E.A, n);
    const r = await gsync(E);
    ok(`${n} qualified affiliates → ${want} group reward(s) (floor(${n} / 10)), each 50000 cents`, r.awarded === want && activeGroup(E.db, E.A).length === want && sum(E.db, E.A) === want * 50000
      && r.qualified === n && r.groupSize === 10, big(r));
  }
  const E = setup();
  qualify(E.db, E.A, 10);
  const r1 = await gsync(E);
  const row = group(E.db, E.A)[0];
  ok('the group reward row: GROUP_REWARD +50000, cycle 1, key group:<recruiterId>:v1, no affiliate, current settings v1, SYSTEM, reason GROUP_QUALIFIED_AFFILIATES',
    r1.awarded === 1 && eq(r1.awardedCycles, [1]) && row.type === 'GROUP_REWARD' && row.amountCents === 50000 && row.cycle === 1 && row.idempotencyKey === `group:${E.A.id}:v1`
    && row.affiliateId === null && row.settingsVersion === 1 && row.actorType === 'SYSTEM' && row.actorId === null && row.reason === 'GROUP_QUALIFIED_AFFILIATES' && row.recruiterId === E.A.id, big(row));
  const au = audits(E.db, 'RECRUIT_GROUP_REWARD_EARNED');
  ok('audit RECRUIT_GROUP_REWARD_EARNED: SYSTEM, entity = the recruiter, details = cycle, amount, version, qualified count, size, threshold (no PII)',
    au.length === 1 && au[0].recruiterId === E.A.id && au[0].actorType === 'SYSTEM' && au[0].entityType === 'recruiter' && au[0].entityId === E.A.id
    && eq(au[0].details, { cycle: 1, amountCents: 50000, settingsVersion: 1, qualifiedAffiliates: 10, groupSize: 10, groupMinDeliveredSales: 10, activeGroupRewards: 1 }), big(au));
  ok('a second sync changes nothing (idempotent): no new row, no new audit', (await gsync(E)).awarded === 0 && group(E.db, E.A).length === 1 && audits(E.db, 'RECRUIT_GROUP_REWARD_EARNED').length === 1);

  const S = setup();
  qualify(S.db, S.A, 8);
  qualify(S.db, S.A, 1, 20); // one affiliate with 20 sales
  ok('8 affiliates with 10 sales + 1 with 20 sales = 9 distinct qualified → no group reward (sales are never aggregated)', (await gsync(S)).awarded === 0 && group(S.db, S.A).length === 0);
  qualify(S.db, S.A, 1, 10);
  const r = await gsync(S);
  ok('…a 10th distinct qualified affiliate → exactly 1 group reward (the 20-sales affiliate counted once)', r.awarded === 1 && r.qualified === 10 && activeGroup(S.db, S.A).length === 1);
  const X = setup();
  qualify(X.db, X.A, 1, 200);
  ok('ONE affiliate with 200 sales → qualified 1, no group reward', (await gsync(X)).qualified === 1 && group(X.db, X.A).length === 0);
}

// ── 3. eligibility ─────────────────────────────────────────────────────────────
console.log('\n3. Mixed eligible / ineligible affiliates');
{
  const E = setup();
  qualify(E.db, E.A, 9);
  const noKyc = aff(E.db, E.A); orders(E.db, noKyc, 10);
  const pending = aff(E.db, E.A); orders(E.db, pending, 10); identity(E.db, pending, 'PENDING');
  const rejected = aff(E.db, E.A); orders(E.db, rejected, 10); identity(E.db, rejected, 'REJECTED');
  const lower = aff(E.db, E.A); orders(E.db, lower, 10); identity(E.db, lower, 'approved');
  const fakes = aff(E.db, E.A); orders(E.db, fakes, 9); orders(E.db, fakes, 5, { isFake: true }); identity(E.db, fakes);
  const statuses = aff(E.db, E.A); orders(E.db, statuses, 9);
  for (const st of ['cancelled', 'returned', 'refused', 'shipped', 'pending', 'confirmed', 'Delivered', ' delivered']) orders(E.db, statuses, 1, { status: st });
  identity(E.db, statuses);
  const unlinked = aff(E.db, null); orders(E.db, unlinked, 10); identity(E.db, unlinked);
  qualify(E.db, E.B, 3); // another recruiter's affiliates
  const r = await gsync(E);
  ok('only the 9 qualified count: KYC missing / PENDING / REJECTED / lower-case, fake orders, cancelled / returned / refused / other statuses, unlinked and B\'s affiliates never count',
    r.awarded === 0 && r.qualified === 9 && group(E.db, E.A).length === 0, big(r));
  identity(E.db, noKyc, 'APPROVED');
  const r2 = await gsync(E);
  ok('…the KYC-less affiliate gets APPROVED → 10 → one group reward for A only (B untouched)', r2.awarded === 1 && r2.qualified === 10 && group(E.db, E.B).length === 0, big(r2));
  const rb = await gsync(E, E.B);
  ok('B with 3 qualified → nothing (A\'s affiliates never count for B)', rb.awarded === 0 && rb.qualified === 3);

  // depth: linked affiliates anywhere in the parentId chain count; money only to the LINKED recruiter
  const D = setup();
  let parent = null;
  const chain = [];
  for (let i = 0; i < 10; i++) { const a = aff(D.db, D.A, parent ? { parentId: parent.id } : {}); orders(D.db, a, 10); identity(D.db, a); chain.push(a); parent = a; }
  const child = aff(D.db, D.B, { parentId: chain[9].id }); orders(D.db, child, 10); identity(D.db, child); // a legacy link to B, deeper in A's chain
  const rd = await gsync(D);
  // Stage F (topmost link wins): the nested legacy B link at depth 11 is A's member too → 11 qualified, floor(11 / 10) = 1
  ok('Stage F: 10 linked affiliates at depths 1..10 (parentId chain) + the nested legacy B link at depth 11 all count for A (11) → one group reward for A', rd.awarded === 1 && rd.qualified === 11);
  const rdB = await gsync(D, D.B);
  ok('Stage F: an affiliate placed under A\'s tree but LINKED to B (legacy) counts for A only — B qualified 0, no group reward for B', rdB.qualified === 0 && rdB.awarded === 0 && group(D.db, D.B).length === 0 && activeGroup(D.db, D.A).length === 1);
}

// ── 4. reversal / requalification ─────────────────────────────────────────────
console.log('\n4. Reversal (also with group rewards OFF) and requalification');
{
  const E = setup();
  const q = qualify(E.db, E.A, 10);
  await gsync(E);
  cancel(E, q[0].os[0]);
  const r = await gsync(E);
  const rev = group(E.db, E.A).find((x) => x.type === 'GROUP_REVERSAL');
  ok('one affiliate cancelled below the threshold (9 qualified) → GROUP_REVERSAL −50000 of cycle 1, key group-reverse:<id>:v1, same version, reason GROUP_QUALIFIED_BELOW_THRESHOLD',
    r.reversed === 1 && eq(r.reversedCycles, [1]) && rev && rev.amountCents === -50000 && rev.cycle === 1 && rev.idempotencyKey === `group-reverse:${E.A.id}:v1` && rev.settingsVersion === 1
    && rev.affiliateId === null && rev.reason === 'GROUP_QUALIFIED_BELOW_THRESHOLD' && sum(E.db, E.A) === 0, big({ r, rev }));
  const au = audits(E.db, 'RECRUIT_GROUP_REWARD_REVERSED');
  ok('audit RECRUIT_GROUP_REWARD_REVERSED with cycle, −amount, version, qualified 9, size, threshold',
    au.length === 1 && eq(au[0].details, { cycle: 1, amountCents: -50000, settingsVersion: 1, qualifiedAffiliates: 9, groupSize: 10, groupMinDeliveredSales: 10, activeGroupRewards: 1 }), big(au));
  ok('another sync with 9 → nothing (no second reversal)', eq([(await gsync(E)).reversed, group(E.db, E.A).length], [0, 2]));
  cancel(E, q[0].os[0], 'delivered');
  const r3 = await gsync(E);
  ok('requalification (re-delivery) → a NEW cycle 2 (key group:<id>:v2), never cycle 1 again', r3.awarded === 1 && eq(r3.awardedCycles, [2]) && group(E.db, E.A).at(-1).idempotencyKey === `group:${E.A.id}:v2` && sum(E.db, E.A) === 50000);
  for (const st of ['returned', 'refused']) {
    const F = setup();
    const fq = qualify(F.db, F.A, 10);
    await gsync(F);
    cancel(F, fq[3].os[9], st);
    ok(`"${st}" drops the affiliate below its threshold → the group reward is reversed`, (await gsync(F)).reversed === 1 && sum(F.db, F.A) === 0);
  }
  // KYC revoked: the affiliate is no longer qualified
  const K = setup();
  const kq = qualify(K.db, K.A, 10);
  await gsync(K);
  K.db._tables.identityVerification.find((v) => v.affiliateId === kq[2].a.id).status = 'REJECTED';
  ok('an identity no longer APPROVED → no longer qualified → reversal', (await gsync(K)).reversed === 1);

  // group rewards OFF: reversals still happen, awards never
  const O = setup();
  const oq = qualify(O.db, O.A, 20);
  await gsync(O);
  O.db._seed.settings({ ...GROUP_ON, version: 2, groupEnabled: false, groupRewardAmountCents: 0 });
  cancel(O, oq[0].os[0]);
  const ro = await gsync(O);
  ok('group rewards switched OFF (v2) and 19 qualified: the highest active cycle (2) is reversed, cycle 1 stays, no new award',
    ro.reversed === 1 && eq(ro.reversedCycles, [2]) && ro.awarded === 0 && eq(activeGroup(O.db, O.A).map((x) => x.cycle), [1]) && sum(O.db, O.A) === 50000, big(ro));
  cancel(O, oq[0].os[0], 'delivered');
  ok('…OFF: requalifying to 20 awards nothing', (await gsync(O)).awarded === 0 && activeGroup(O.db, O.A).length === 1);
  const off = setup({ settings: { ...GROUP_ON, groupEnabled: false, groupRewardAmountCents: 0 } });
  qualify(off.db, off.A, 30);
  const offLog = off.db._log.length;
  const roff = await gsync(off);
  ok('OFF and no group reward: nothing awarded and no qualified-count statement at all (early exit)', roff.awarded === 0 && roff.qualified === null
    && !off.db._log.slice(offLog).some((l) => l.model === '$queryRaw'));

  // 20 → 2 rewards; dropping 11 → both reversed in ONE sync (repeat until stable)
  const M = setup();
  const mq = qualify(M.db, M.A, 20);
  await gsync(M);
  for (let i = 0; i < 11; i++) cancel(M, mq[i].os[0]);
  const rm = await gsync(M);
  ok('20 → 2 rewards; 11 drop (9 left) → ONE sync reverses cycle 2 then cycle 1 (highest first), balance 0', rm.reversed === 2 && eq(rm.reversedCycles, [2, 1]) && sum(M.db, M.A) === 0
    && audits(M.db, 'RECRUIT_GROUP_REWARD_REVERSED').length === 2, big(rm));
  for (let i = 0; i < 11; i++) cancel(M, mq[i].os[0], 'delivered');
  const rm2 = await gsync(M);
  ok('…back to 20 → cycles 3 and 4 (new cycles, never 1 / 2 again)', eq(rm2.awardedCycles, [3, 4]) && activeGroup(M.db, M.A).length === 2 && sum(M.db, M.A) === 100000);
}

// ── 5. settings versions ───────────────────────────────────────────────────────
console.log('\n5. Version history: a reward is judged with ITS OWN settings version');
{
  const E = setup();
  const q = qualify(E.db, E.A, 10);
  await gsync(E); // cycle 1 under v1 (size 10, threshold 10)
  // v2: threshold 20 per affiliate, size 5, amount 300 MAD
  await RS.adminSaveRecruiterSettings({ groupEnabled: true, groupRewardAmountMad: '300', groupSize: 5, groupMinDeliveredSales: 20 }, { db: E.db, actorId: 'admin-1', now: T0 });
  const r = await gsync(E);
  ok('v2 raises the threshold to 20: nobody qualifies under v2, yet the v1 reward is NOT reversed (judged by v1: 10 ≥ 10 × 1)', r.reversed === 0 && r.awarded === 0 && activeGroup(E.db, E.A).length === 1, big(r));
  cancel(E, q[0].os[0]);
  const r2 = await gsync(E);
  const rev = group(E.db, E.A).find((x) => x.type === 'GROUP_REVERSAL');
  ok('one drops below 10 → reversal judged by v1 (9 < 10), −50000 (its own amount), settingsVersion 1', r2.reversed === 1 && rev.amountCents === -50000 && rev.settingsVersion === 1
    && audits(E.db, 'RECRUIT_GROUP_REWARD_REVERSED')[0].details.groupSize === 10 && audits(E.db, 'RECRUIT_GROUP_REWARD_REVERSED')[0].details.groupMinDeliveredSales === 10);
  for (const x of q.slice(1, 6)) orders(E.db, x.a, 10); // q[0] has 9 left — the 5 others reach 20
  const r3 = await gsync(E);
  const nw = group(E.db, E.A).at(-1);
  ok('5 affiliates reach 20 sales → v2 entitles floor(5 / 5) = 1 → cycle 2 at v2: 30000 cents, settingsVersion 2', r3.awarded === 1 && nw.cycle === 2 && nw.amountCents === 30000 && nw.settingsVersion === 2, big(nw));
  // v3 lowers the size: the current version decides new awards, older active rewards keep their version
  const L = setup();
  qualify(L.db, L.A, 10);
  await gsync(L);
  L.db._seed.settings({ ...GROUP_ON, version: 2, groupSize: 4 });
  const rl = await gsync(L);
  ok('v2 lowers groupSize 10 → 4 with 10 qualified: entitlement floor(10 / 4) = 2 → one more reward (cycle 2 at v2); cycle 1 (v1) kept', rl.awarded === 1 && eq(activeGroup(L.db, L.A).map((x) => [x.cycle, x.settingsVersion]), [[1, 1], [2, 2]]), big(rl));
  ok('…stable: another sync changes nothing', (await gsync(L)).awarded === 0 && (await gsync(L)).reversed === 0);
}

// ── 6. concurrency / idempotency ───────────────────────────────────────────────
console.log('\n6. Concurrency and idempotency');
{
  const E = setup();
  const q = qualify(E.db, E.A, 25);
  E.hookBox.fn = () => new Promise((r) => setImmediate(r));
  const res = await Promise.all([
    ...Array.from({ length: 8 }, () => gsync(E)),
    ...Array.from({ length: 3 }, () => RS.reconcileRecruiterRewards({ db: E.db, now: T0 })),
    ...Array.from({ length: 3 }, () => RS.reconcileRecruiterRewards({ db: E.db, now: T0, recruiterId: E.A.id })),
    ...q.slice(0, 4).map((x) => HK.onRecruiterOrderStatusCommitted(x.os[0].id, { db: E.db })),
  ]);
  E.hookBox.fn = null;
  const g = group(E.db, E.A);
  const reported = res.reduce((t, r) => t + (r.awarded !== undefined && r.groupAwarded === undefined ? r.awarded : r.groupAwarded ?? 0), 0);
  ok('8 syncs + 3 full reconciles + 3 scoped reconciles + 4 hooks concurrently (25 qualified): exactly 2 group rewards (cycles 1, 2), unique keys, each reported once',
    g.length === 2 && eq(g.map((x) => x.cycle).sort(), [1, 2]) && new Set(g.map((x) => x.idempotencyKey)).size === 2 && reported === 2 && audits(E.db, 'RECRUIT_GROUP_REWARD_EARNED').length === 2, big({ g: g.length, reported }));
  ok('…no lock left held, no transaction left open', E.db._locks.size === 0 && E.db._openTx.size === 0);
  for (let i = 0; i < 16; i++) cancel(E, q[i].os[0]);
  E.hookBox.fn = () => new Promise((r) => setImmediate(r));
  const res2 = await Promise.all(Array.from({ length: 10 }, () => gsync(E)));
  E.hookBox.fn = null;
  ok('16 drop (9 left) with 10 concurrent syncs: exactly 2 reversals (one per cycle), reported once each, balance 0',
    group(E.db, E.A).filter((x) => x.type === 'GROUP_REVERSAL').length === 2 && res2.reduce((t, r) => t + r.reversed, 0) === 2 && sum(E.db, E.A) === 0);
  const R = setup();
  qualify(R.db, R.A, 10);
  const a1 = await RS.reconcileRecruiterRewards({ db: R.db, now: T0 });
  const a2 = await RS.reconcileRecruiterRewards({ db: R.db, now: T0 });
  ok('full reconcile: the group pass runs when the batches are exhausted (groupChecked = every recruiter, groupAwarded 1); repeating it changes nothing',
    a1.groupAwarded === 1 && a1.groupChecked === 2 && a1.groupReversed === 0 && a2.groupAwarded === 0 && a2.groupReversed === 0 && group(R.db, R.A).length === 1, big({ a1, a2 }));
  // the group pass only in the call that exhausts the batches (admin: one batch per call)
  const P = setup();
  qualify(P.db, P.A, 10);
  const b1 = await RS.reconcileRecruiterRewards({ db: P.db, now: T0, batchSize: 4, maxBatches: 1 });
  const b2 = await RS.reconcileRecruiterRewards({ db: P.db, now: T0, batchSize: 4, maxBatches: 1, after: b1.cursor });
  const b3 = await RS.reconcileRecruiterRewards({ db: P.db, now: T0, batchSize: 4, maxBatches: 1, after: b2.cursor });
  ok('admin batches (size 4, one per call): no group pass while hasMore; the call that ends the scan runs it (groupAwarded 1)',
    b1.hasMore && b1.groupChecked === 0 && b2.hasMore && b2.groupChecked === 0 && !b3.hasMore && b3.groupChecked === 2 && b3.groupAwarded === 1, big([b1, b2, b3]));
  // the group pass pages over every recruiter (keyset over recruiters.id), > one page
  const many = setup();
  const recs = Array.from({ length: 503 }, (_, i) => many.db._seed.recruiter({ username: `bulk.${i}`, name: `Recruteur ${i}` }));
  qualify(many.db, recs[502], 10);
  const rmany = await RS.reconcileRecruiterRewards({ db: many.db, now: T0 });
  ok('group pass over 505 recruiters (2 pages of 500): every recruiter checked once, the qualifying last one awarded', rmany.groupChecked === 505 && rmany.groupAwarded === 1 && group(many.db, recs[502]).length === 1, big(rmany));
  const busyResult = await (async () => {
    const Z = setup();
    let release;
    const gate = new Promise((r) => { release = r; });
    Z.hookBox.fn = async (m, _o, a) => { if (m === '$queryRaw' && /recruiter-reward-candidates/.test(a?.sql ?? '')) await gate; };
    const first = RS.reconcileRecruiterRewards({ db: Z.db, now: T0 });
    await new Promise((r) => setTimeout(r, 20));
    const second = await RS.reconcileRecruiterRewards({ db: Z.db, now: T0 });
    release();
    Z.hookBox.fn = null;
    await first;
    return second;
  })();
  ok('a busy full reconcile reports groupChecked / groupAwarded / groupReversed 0 (additive fields)', busyResult.busy === true && busyResult.groupAwarded === 0 && busyResult.groupReversed === 0 && busyResult.groupChecked === 0, big(busyResult));
}

// ── 7. hooks ───────────────────────────────────────────────────────────────────
console.log('\n7. Hooks trigger the group sync of the linked recruiter (post-commit, never throw)');
{
  const E = setup({ settings: { ...GROUP_ON, enabled: true, rewardAmountCents: 15000 } });
  const q = qualify(E.db, E.A, 9);
  const last = aff(E.db, E.A); const lastOrders = orders(E.db, last, 10, { status: 'shipped' }); identity(E.db, last);
  for (const o of lastOrders.slice(0, 9)) cancel(E, o, 'delivered');
  E.db._tables.affiliateOrder.find((o) => o.id === lastOrders[9].id).status = 'delivered';
  const h = await HK.onRecruiterOrderStatusCommitted(lastOrders[9].id, { db: E.db });
  ok('order status hook: the individual result is returned unchanged (AWARDED cycle 1) AND the group reward of the linked recruiter is awarded',
    eq(h, { action: 'AWARDED', cycle: 1 }) && activeGroup(E.db, E.A).length === 1, big(h));
  cancel(E, lastOrders[0]);
  const h2 = await HK.onRecruiterOrderStatusCommitted(lastOrders[0].id, { db: E.db });
  ok('…cancellation through the hook: individual REVERSED and the group reward reversed', eq(h2, { action: 'REVERSED', cycle: 1 }) && activeGroup(E.db, E.A).length === 0 && sum(E.db, E.A) === 0, big(h2));
  // identity hook
  const I = setup();
  qualify(I.db, I.A, 9);
  const pend = aff(I.db, I.A); orders(I.db, pend, 10); const iv = identity(I.db, pend, 'PENDING');
  I.db._tables.identityVerification.find((v) => v.id === iv.id).status = 'APPROVED';
  await HK.onRecruiterIdentityApprovedCommitted(iv.id, { db: I.db });
  ok('identity approved hook → the 10th qualified affiliate → group reward', activeGroup(I.db, I.A).length === 1);
  // linked-order (fake-order sync) hook
  const L = setup();
  const lq = qualify(L.db, L.A, 10);
  await gsync(L);
  const storeId = randomUUID();
  const linked = L.db._seed.order({ affiliateId: lq[0].a.id, orderId: storeId, status: 'delivered', isFake: false });
  void linked;
  for (const o of lq[0].os) cancel(L, o);
  L.db._tables.affiliateOrder.find((o) => o.orderId === storeId).status = 'cancelled';
  await HK.onRecruiterLinkedOrderSynced(storeId, { db: L.db });
  ok('fake-order sync hook → the group reward of the linked recruiter is reversed', activeGroup(L.db, L.A).length === 0 && group(L.db, L.A).some((x) => x.type === 'GROUP_REVERSAL'));
  // never throws; the individual result still returned; a later reconcile repairs
  const F = setup();
  const fq = qualify(F.db, F.A, 10);
  const { out, lines } = await silence(() => HK.onRecruiterOrderStatusCommitted(fq[0].os[0].id, { db: F.db, group: async () => { throw Object.assign(new Error('db down'), { code: 'P1001' }); } }));
  ok('a failing group sync is logged (code only) and never throws; the hook still returns the individual result', out?.action === 'NOT_QUALIFIED' && lines.some((l) => /group sync failed/.test(l) && /P1001/.test(l)) && group(F.db, F.A).length === 0, big({ out, lines }));
  const rec = await RS.reconcileRecruiterRewards({ db: F.db, now: T0, recruiterId: F.A.id });
  ok('…the wallet reconcile (recruiter-scoped) then awards it', rec.groupAwarded === 1 && rec.groupChecked === 1 && activeGroup(F.db, F.A).length === 1);
  const T = setup();
  const txLike = new Proxy(T.db, { get: (t, p) => (p === '$transaction' ? undefined : t[p]) }); // a transaction client has no $transaction
  const txHook = await HK.onRecruiterOrderStatusCommitted(fq[0].os[0].id, { db: txLike });
  ok('with a transaction client the hook defers (no individual nor group sync)', txHook?.action === 'DEFERRED' && group(T.db, T.A).length === 0);
  ok('the unlinked affiliate → the group sync helper answers NOT_LINKED', eq(await RS.syncRecruiterGroupRewardForAffiliate(aff(T.db, null).id, { db: T.db }), { action: 'NOT_LINKED' }));
  void q;
}

// ── 8. wallet ──────────────────────────────────────────────────────────────────
console.log('\n8. Wallet: balance includes group rows, negative after reversals; history rows');
{
  const E = setup({ settings: { ...GROUP_ON, enabled: true, rewardAmountCents: 15000 } });
  Object.assign(E.db._tables.recruiter.find((r) => r.id === E.A.id), { bankName: 'CIH Bank', accountName: 'Recruteur A', rib: '011780000012345678901234' });
  const q = qualify(E.db, E.A, 10);
  const h = recruiterWalletHandlers({ db: E.db, now, rateLimit: noLimit });
  const g1 = await call(withRecruiterAuth(h.wallet), req('/api/recruiter/wallet', { cookie: recruiterCookie(E.A) }));
  const w = g1.body?.wallet;
  ok('wallet GET (scoped reconcile): 10 individual rewards (150 MAD) + 1 group reward (500 MAD) → earned 2000 MAD', g1.status === 200 && w.totals.earnedCents === 10 * 15000 + 50000, big(w?.totals));
  const gr = w.rewards.find((r) => r.type === 'GROUP_REWARD');
  ok('group history row: type, +amount, no affiliate, reason GROUP_QUALIFIED_AFFILIATES, cycle 1, settingsVersion 1, groupSize 10, threshold 10',
    eq(gr, { type: 'GROUP_REWARD', amountCents: 50000, currency: 'MAD', affiliate: null, reason: 'GROUP_QUALIFIED_AFFILIATES', requiredDeliveredOrders: 10, cycle: 1, settingsVersion: 1, groupSize: 10, createdAt: T0.toISOString() }), big(gr));
  const ir = w.rewards.find((r) => r.type === 'RECRUIT_REWARD');
  ok('individual history rows unchanged (no settingsVersion / groupSize keys)', eq(keys(ir), ['affiliate', 'amountCents', 'createdAt', 'currency', 'cycle', 'reason', 'requiredDeliveredOrders', 'type']));
  const wd = await call(withRecruiterAuth(h.withdraw), req('/api/recruiter/wallet/withdrawals', { method: 'POST', body: { amountMad: '2000', requestId: randomUUID() }, cookie: recruiterCookie(E.A) }));
  const paid = await WS.adminProcessRecruiterPayout(wd.body.withdrawal.id, 'pay', { db: E.db, actorId: 'admin-1', now: T0 });
  cancel(E, q[0].os[0]);
  const g2 = await call(withRecruiterAuth(h.wallet), req('/api/recruiter/wallet', { cookie: recruiterCookie(E.A) }));
  const w2 = g2.body.wallet;
  ok('paid 2000 MAD, then one affiliate cancelled: individual + group reversed → available −650 MAD (negative), history has GROUP_REVERSAL −500 MAD',
    paid.status === 'paid' && w2.totals.earnedCents === 9 * 15000 && w2.totals.availableCents === 9 * 15000 - 200000
    && w2.rewards.some((r) => r.type === 'GROUP_REVERSAL' && r.amountCents === -50000 && r.reason === 'GROUP_QUALIFIED_BELOW_THRESHOLD' && r.cycle === 1 && r.groupSize === 10), big(w2.totals));
  const bal = (await WS.adminRecruiterBalances({ db: E.db })).find((b) => b.recruiterId === E.A.id);
  ok('admin balances include the group rows (earned = ledger sum, available negative)', bal.earnedCents === 9 * 15000 && bal.availableCents === 9 * 15000 - 200000);
  const adm = await WS.adminListRecruiterLedger({ db: E.db });
  ok('admin ledger lists the group rows (type, amount, version, cycle, reason, no affiliate)', adm.filter((r) => r.type === 'GROUP_REWARD' || r.type === 'GROUP_REVERSAL').every((r) => r.affiliateId === null && r.settingsVersion === 1 && r.cycle === 1)
    && adm.filter((r) => r.type === 'GROUP_REVERSAL').length === 1);
  const vt = V.toRecruiterRewardTotals([{ type: 'GROUP_REWARD', amountCents: 500 }, { type: 'GROUP_REVERSAL', amountCents: -500 }, { type: 'RECRUIT_REWARD', amountCents: 100 }]);
  ok('toRecruiterRewardTotals counts group rows', vt.earnedCents === 100);
  ok('the group history view never carries recruiterId / actor / idempotency key / internal reason text',
    !/recruiterId|actorType|actorId|idempotencyKey|SYSTEM/.test(JSON.stringify(w2.rewards.filter((r) => r.type.startsWith('GROUP_')))));
}

// ── 9. payment vs group reversal (money lock) ─────────────────────────────────
console.log('\n9. Payment vs group reversal: serialised by the recruiter money lock');
{
  const prep = async () => {
    const E = setup();
    Object.assign(E.db._tables.recruiter.find((r) => r.id === E.A.id), { bankName: 'CIH Bank', accountName: 'Recruteur A', rib: '011780000012345678901234' });
    const q = qualify(E.db, E.A, 10);
    await gsync(E);
    const w = await WS.requestRecruiterWithdrawal(E.A.id, { amountMad: '500', requestId: randomUUID() }, { db: E.db, now: T0 });
    cancel(E, q[0].os[0]);
    return { E, w };
  };
  const pay = (E, id) => WS.adminProcessRecruiterPayout(id, 'pay', { db: E.db, actorId: 'admin-1', now: T0 }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e?.code }));
  const MONEY = (E) => `__advisory__:recruiter-money:${E.A.id}`;
  {
    // group reversal paused right before its insert (holding the money lock) → the pay waits, then is refused
    const { E, w } = await prep();
    let resume; const gate = new Promise((r) => { resume = r; });
    let held = null;
    E.hookBox.fn = async (m, op, a) => { if (m === 'recruiterRewardLedger' && op === 'create' && a?.data?.type === 'GROUP_REVERSAL' && held === null) { held = E.db._locks.has(MONEY(E)); await gate; } };
    const s = gsync(E);
    while (held === null) await new Promise((r) => setImmediate(r));
    E.hookBox.fn = null;
    const p = pay(E, w.withdrawal.id);
    const blocked = await settle(p);
    resume();
    const [sr, pr] = await Promise.all([s, p]);
    ok('group reversal holding the money lock (group lock → money lock) → the pay WAITS, then sees the reversal → INSUFFICIENT_BALANCE, nothing paid',
      held === true && blocked === 'blocked' && sr.reversed === 1 && !pr.ok && pr.code === 'INSUFFICIENT_BALANCE' && E.db._tables.affiliatePayout.find((x) => x.id === w.withdrawal.id).status === 'pending', big({ held, blocked, sr, pr }));
  }
  {
    // the pay holds the money lock (paused before its update) → the group reversal waits, inserts after the pay committed
    const { E, w } = await prep();
    let resume; const gate = new Promise((r) => { resume = r; });
    let held = null;
    E.hookBox.fn = async (m, op) => { if (m === 'affiliatePayout' && op === 'updateMany' && held === null) { held = E.db._locks.has(MONEY(E)); await gate; } };
    const p = pay(E, w.withdrawal.id);
    while (held === null) await new Promise((r) => setImmediate(r));
    let insertedWhilePending = null;
    E.hookBox.fn = (m, op, a) => { if (m === 'recruiterRewardLedger' && op === 'create' && a?.data?.type === 'GROUP_REVERSAL') insertedWhilePending = E.db._tables.affiliatePayout.find((x) => x.id === w.withdrawal.id).status === 'pending'; };
    const s = gsync(E);
    const blocked = await settle(s);
    resume();
    const [pr, sr] = await Promise.all([p, s]);
    E.hookBox.fn = null;
    ok('the pay holding the money lock → the group reversal WAITS and inserts only after the pay committed (paid, then reversed: balance −500 MAD)',
      held === true && blocked === 'blocked' && pr.ok && sr.reversed === 1 && insertedWhilePending === false && sum(E.db, E.A) === 0, big({ held, blocked, pr, sr, insertedWhilePending }));
  }
  const nE = setup();
  qualify(nE.db, nE.A, 10);
  const moneyTaken = [];
  nE.hookBox.fn = () => { moneyTaken.push(nE.db._locks.has(`__advisory__:recruiter-money:${nE.A.id}`)); };
  await gsync(nE);
  nE.hookBox.fn = null;
  ok('an AWARD never takes the money lock (only a reversal does)', moneyTaken.length > 0 && moneyTaken.every((x) => !x));
}

// ── 10. database guards (fake = migration 20261112) ───────────────────────────
console.log('\n10. Database guards: CHECKs, cycle guard, uniqueness, append-only');
{
  const E = setup();
  const base = (o = {}) => ({ recruiterId: E.A.id, affiliateId: null, type: 'GROUP_REWARD', amountCents: 100, cycle: 1, idempotencyKey: `group:${E.A.id}:v1`, actorType: 'SYSTEM', actorId: null, settingsVersion: 1, ...o });
  const tryCreate = (data) => E.db.$transaction((tx) => tx.recruiterRewardLedger.create({ data })).then(() => 'ok', (e) => e.meta?.constraint ?? e.message);
  ok('GROUP_REWARD ≤ 0 / with an affiliate / without settingsVersion / wrong key → recruiter_reward_ledger_group_check',
    (await tryCreate(base({ amountCents: -1 }))) === 'recruiter_reward_ledger_group_check' && (await tryCreate(base({ settingsVersion: null }))) === 'recruiter_reward_ledger_group_check'
    && (await tryCreate(base({ idempotencyKey: `group:${E.A.id}:v2` }))) === 'recruiter_reward_ledger_group_check' && (await tryCreate(base({ idempotencyKey: `group:${E.B.id}:v1` }))) === 'recruiter_reward_ledger_group_check');
  const a = aff(E.db, E.A);
  ok('…a group row naming an affiliate is refused', (await tryCreate(base({ affiliateId: a.id }))) === 'recruiter_reward_ledger_group_check');
  ok('an unknown type is still refused (type CHECK)', (await tryCreate(base({ type: 'GROUP_BONUS' }))) === 'recruiter_reward_ledger_type_check');
  ok('GROUP_REWARD cycle 2 before cycle 1 → the group cycle guard refuses', /must be cycle 1/.test(await tryCreate(base({ cycle: 2, idempotencyKey: `group:${E.A.id}:v2` }))));
  ok('cycle 1 accepted', (await tryCreate(base())) === 'ok');
  ok('a second cycle 1 → refused (guard: must be cycle 2)', /must be cycle 2/.test(await tryCreate(base())));
  const rv = (o = {}) => base({ type: 'GROUP_REVERSAL', amountCents: -100, idempotencyKey: `group-reverse:${E.A.id}:v1`, ...o });
  ok('GROUP_REVERSAL ≥ 0 → group CHECK; exceeding the reward → guard; other settingsVersion → guard; other recruiter / missing cycle → guard',
    (await tryCreate(rv({ amountCents: 5 }))) === 'recruiter_reward_ledger_group_check' && /cannot exceed/.test(await tryCreate(rv({ amountCents: -101 })))
    && /cannot exceed/.test(await tryCreate(rv({ settingsVersion: 2 }))) && /cannot exceed/.test(await tryCreate(rv({ recruiterId: E.B.id, idempotencyKey: `group-reverse:${E.B.id}:v1` })))
    && /cannot exceed/.test(await tryCreate(rv({ cycle: 3, idempotencyKey: `group-reverse:${E.A.id}:v3` }))));
  ok('a valid reversal (−100, same version) accepted; a second reversal of cycle 1 → refused', (await tryCreate(rv())) === 'ok' && /cannot exceed|idempotencyKey/.test(await tryCreate(rv())));
  const refused = [];
  for (const op of ['update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'createMany']) refused.push(await E.db.recruiterRewardLedger[op]({ where: { recruiterId: E.A.id }, data: { amountCents: 1 } }).then(() => 'ran', (e) => /append-only/.test(e.message)));
  ok('the ledger stays append-only (update / delete / … refused)', refused.every((x) => x === true));
  const sv = (data) => E.db.$transaction((tx) => tx.recruiterSettingsVersion.create({ data: { version: 2, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10, createdBy: 'admin-1', ...data } })).then(() => 'ok', (e) => e.meta?.constraint ?? e.message);
  ok('settings group CHECK: enabled without amount, size 0 / 10001, threshold 0 → recruiter_settings_versions_group_check',
    (await sv({ groupEnabled: true, groupRewardAmountCents: 0 })) === 'recruiter_settings_versions_group_check' && (await sv({ groupSize: 0 })) === 'recruiter_settings_versions_group_check'
    && (await sv({ groupSize: 10001 })) === 'recruiter_settings_versions_group_check' && (await sv({ groupMinDeliveredSales: 0 })) === 'recruiter_settings_versions_group_check'
    && (await sv({ groupRewardAmountCents: 100_000_001 })) === 'recruiter_settings_versions_group_check');
  ok('a version without the group fields reads the DB defaults (OFF, 0, 10, 10)', (await sv({})) === 'ok'
    && eq(SET.normalizeRecruiterGroupSettings(E.db._tables.recruiterSettingsVersion.find((v) => v.version === 2)), SET.DEFAULT_RECRUITER_GROUP_SETTINGS)
    && E.db._tables.recruiterSettingsVersion.find((v) => v.version === 2).groupSize === 10);
  // the fake's drift guard: the bind roles of the group statement
  // Stage F: the shared N(R) CTEs bind rid (roots), cap (the placed walk), rid ×2 (the cyclic part), rid (cnet), then delivered, min, min
  ok('Stage F: fake drift guard: the group statement binds rid, cap, rid, rid, rid, delivered, min, min (in that order)', eq(E.db._groupQualifiedRoles, ['rid', 'cap', 'rid', 'rid', 'rid', 'delivered', 'min', 'min']));
  const src = read('src/lib/services/recruiterRewardService.js');
  const tpl = /\$queryRaw`(\s*\/\* recruiter-group-qualified \*\/[^`]*)`/.exec(src)?.[1] ?? '';
  // Stage F (topmost link wins): the statement walks N(R) — the roots (R's links without any linked ancestor, on a chain
  // with a top), EVERY descendant (UNION ALL + cap: no link filter), plus the members on a parent cycle owned by R (cnet:
  // UNION, children linked to another recruiter excluded only there).
  ok('Stage F: the group statement: N(R) of ONE recruiter (roots + every descendant + the cycle members it owns) + a per-member bounded count of real delivered orders; no identity table (identity via Prisma count)',
    /"recruiter_affiliate_links" l/.test(tpl) && /LIMIT \$\{minDelivered\}::int/.test(tpl) && !/identity_verifications/.test(tpl) && /WITH RECURSIVE cand AS/.test(tpl) && /roots AS \(/.test(tpl)
    && /net AS \([\s\S]*?UNION ALL[\s\S]*?a\."parentId" = n\."id" OFFSET 0\) ch\s*WHERE n\.depth < \$\{cap\}::int/.test(tpl) && /cnet AS \([\s\S]*?\n\s*UNION\n/.test(tpl)
    && /ox\."recruiterId" <> \$\{recruiterId\}::text/.test(tpl) && /FROM mem m/.test(tpl)
    && /identityVerification\.count\(\{ where: \{ affiliateId: \{ in: ids\.slice\(i, i \+ GROUP_QUALIFIED_CHUNK\) \}, status: IDENTITY_APPROVED_STATUS \} \}\)/.test(src));
  const mig = read('prisma/migrations/20261112_recruiter_group_rewards/migration.sql');
  const code = mig.replace(/--.*$/gm, '');
  ok('migration 20261112: metadata-only ADD COLUMN IF NOT EXISTS ×4 with defaults, no UPDATE / DELETE / INSERT, CHECKs NOT VALID then VALIDATE, guard trigger + 2 partial unique indexes',
    (code.match(/ADD COLUMN IF NOT EXISTS/g) || []).length === 4 && !/^\s*(UPDATE|DELETE|INSERT)\b/im.test(code) && (code.match(/NOT VALID/g) || []).length === 3 && (code.match(/VALIDATE CONSTRAINT/g) || []).length === 3
    && /pg_advisory_xact_lock\(hashtext\('recruiter-group:' \|\| NEW\."recruiterId"\)\)/.test(code) && (code.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) || []).length === 2
    && /DROP TRIGGER IF EXISTS "recruiter_reward_ledger_group_cycle_guard"/.test(code) && !/BEGIN\s*;|COMMIT\s*;/i.test(code));
}

// ── 11. admin settings (handler) ───────────────────────────────────────────────
console.log('\n11. Admin: settings of both reward types, validation, audit, overview');
{
  const E = setup({ settings: null });
  const admin = recruiterRewardAdminHandlers({ db: E.db, now });
  const save = (body) => call(withAdminAuth(admin.saveSettings), req('/api/admin/recruiter-rewards/settings', { method: 'POST', cookie: adminCookie(), body }));
  const bad = await save({ enabled: true, rewardAmountMad: '0', groupEnabled: true, groupRewardAmountMad: 'abc', groupSize: 0, groupMinDeliveredSales: 100001 });
  ok('invalid → 400 INVALID_INPUT with per-field errors of BOTH reward types; nothing written',
    bad.status === 400 && eq(bad.body.errors, { rewardAmountMad: 'AMOUNT_REQUIRED_WHEN_ENABLED', groupRewardAmountMad: 'INVALID_AMOUNT', groupSize: 'INVALID_GROUP_SIZE', groupMinDeliveredSales: 'INVALID_COUNT' })
    && E.db._tables.recruiterSettingsVersion.length === 0, bad.text);
  const v1 = await save({ enabled: true, rewardAmountMad: '150', minDeliveredSales: 10, groupEnabled: true, groupRewardAmountMad: '500', groupSize: 10, groupMinDeliveredSales: 12 });
  ok('valid → 201 with version 1 of both reward types (MAD → cents)', v1.status === 201 && eq(v1.body.settings, { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10, groupEnabled: true, groupRewardAmountCents: 50000, groupSize: 10, groupMinDeliveredSales: 12 }), v1.text);
  const v2 = await save({ enabled: false, rewardAmountMad: '0', groupEnabled: true, groupRewardAmountMad: '600', groupSize: 8, groupMinDeliveredSales: 12 });
  const au = audits(E.db, 'RECRUITER_SETTINGS_CHANGED');
  ok('audit of v2: new values of both reward types + the previous (v1) values', v2.status === 201 && au.length === 2
    && eq(au[1].details, { version: 2, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10, groupEnabled: true, groupRewardAmountCents: 60000, groupSize: 8, groupMinDeliveredSales: 12,
      previous: { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10, groupEnabled: true, groupRewardAmountCents: 50000, groupSize: 10, groupMinDeliveredSales: 12 } }), big(au[1]?.details));
  const ov = await call(withAdminAuth(admin.overview), req('/api/admin/recruiter-rewards', { cookie: adminCookie() }));
  ok('overview: current settings and history carry both reward types', ov.status === 200 && ov.body.settings.groupSize === 8 && ov.body.settings.groupRewardAmountCents === 60000
    && eq(ov.body.history.map((h) => [h.version, h.groupEnabled, h.groupSize]), [[2, true, 8], [1, true, 10]]) && ov.body.history.every((h) => h.createdBy === 'admin-1'));
  ok('getCurrentRecruiterSettings keeps its 4-key shape (Reward A callers unchanged)', eq(keys(await RS.getCurrentRecruiterSettings({ db: E.db })), ['enabled', 'minDeliveredSales', 'rewardAmountCents', 'version']));
  const page = read('src/app/admin/recruiter-rewards/page.jsx');
  ok('admin page: Reward A / Reward B sections, the 4 group fields with per-field errors, history columns of both, group type labels (French)',
    /Récompense A — par affilié/.test(page) && /Récompense B — groupe d&apos;affiliés qualifiés/.test(page)
    && ['groupEnabled', 'groupRewardAmountMad', 'groupSize', 'groupMinDeliveredSales'].every((f) => page.includes(`data-field="${f}"`))
    && ['groupRewardAmountMad', 'groupSize', 'groupMinDeliveredSales'].every((f) => page.includes(`data-field-error="${f}"`))
    && /INVALID_GROUP_SIZE: "Nombre entier entre 1 et 10 000\."/.test(page) && /"B : taille du groupe"/.test(page) && /GROUP_REWARD: "Récompense de groupe"/.test(page) && /GROUP_REVERSAL: "Annulation de groupe"/.test(page));
}

// ── 12. Reward A unchanged next to Reward B ───────────────────────────────────
console.log('\n12. Reward A (individual) unchanged next to Reward B');
{
  const E = setup({ settings: { ...GROUP_ON, enabled: true, rewardAmountCents: 15000 } });
  const q = qualify(E.db, E.A, 10);
  for (const x of q) await RS.syncRecruiterReward(x.a.id, { db: E.db, now: T0 });
  await gsync(E);
  ok('10 individual rewards (one per affiliate, cycle 1) + 1 group reward', q.every((x) => ledger(E.db, { affiliateId: x.a.id }).length === 1) && activeGroup(E.db, E.A).length === 1 && sum(E.db, E.A) === 150000 + 50000);
  ok('an individual sync of a qualified affiliate after the group reward → NO_CHANGE (group rows never enter the per-affiliate cycle state)', eq(await RS.syncRecruiterReward(q[0].a.id, { db: E.db, now: T0 }), { action: 'NO_CHANGE', cycle: 1 }));
  const r = await RS.reconcileRecruiterRewards({ db: E.db, now: T0 });
  ok('full reconcile: no individual candidate (group rows ignored by the candidates statement), group pass stable', r.candidates === 0 && r.awarded === 0 && r.reversed === 0 && r.groupAwarded === 0 && r.groupReversed === 0, big(r));
  cancel(E, q[0].os[0]);
  const r2 = await RS.reconcileRecruiterRewards({ db: E.db, now: T0 });
  ok('one affiliate drops: reconcile reverses its individual reward (1) AND the group reward (1)', r2.reversed === 1 && r2.groupReversed === 1 && sum(E.db, E.A) === 135000, big(r2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
