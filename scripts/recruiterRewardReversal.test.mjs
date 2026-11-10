#!/usr/bin/env node
/**
 * scripts/recruiterRewardReversal.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 6 part 3a: the reward REVERSAL engine (versioned cycles,
 * decisions D1 / D2). In-memory fake database only (scripts/lib/recruiterFakeDb.mjs, phase5
 * mode, which models migration 20261110: the cycle column, the cycle-key CHECK, one reward /
 * one reversal per (affiliate, cycle), the cycle guard under the per-affiliate advisory lock) —
 * never a real database.
 * Proves:
 *   • award → reverse → re-award cycles (re-delivery), keys recruit:<id>:v<n> / reverse:<id>:v<n>
 *   • cancelled / returned / refused / delivered→shipped (admin hook and fake-order sync hook)
 *   • the threshold of THE REWARD's settings version: still met → nothing; raised later → no
 *     retroactive reversal; lowered later → documented behaviour
 *   • duplicates and 20 concurrent attempts → exactly one reversal per cycle; an award racing a
 *     cancellation always ends consistent
 *   • amounts per cycle, append-only ledger, database guards, legacy cycle-1 rows
 *   • reconcile reverses even with rewards OFF (and never awards then)
 *   • audit RECRUIT_REWARD_REVERSED, recruiter history / admin ledger display, wallet net
 *   • affiliate rows / commissions / points / balances untouched; affiliateSystemService unchanged
 *   • Phase 6 part 5d: reconcile candidates use the reward's OWN version threshold (legacy / unknown /
 *     out-of-range → 10, like thresholdOfVersion) and always agree with syncRecruiterReward across cycles
 * Run: node scripts/recruiterRewardReversal.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-reversal-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const RS = await import('../src/lib/services/recruiterRewardService.js');
const WS = await import('../src/lib/services/recruiterWalletService.js');
const HK = await import('../src/lib/recruiterRewardHooks.js');
const V = await import('../src/lib/recruiterVisibility.js');
const SET = await import('../src/lib/recruiterSettings.js');

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
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const big = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }); } catch (e) { return `git error ${e.status}`; } };
// The parent of the Phase 6 part 3a / 3b commit: scope checks compare against this fixed commit
// (never against HEAD), so they give the same answer before and after that commit.
const PART3_BASE = '3607da30969b2303e6cac1b2d6b8dd5fcf9949c0';

const T0 = new Date('2026-11-10T10:00:00.000Z');
const V1 = { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 };

let uniq = 0;
function setup({ settings = V1, failOnce = {} } = {}) {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ phase5: true, failOnce, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  if (settings) db._seed.settings(settings);
  return { db, A, B, hookBox };
}
function aff(db, rec, extra = {}) {
  const a = db._seed.affiliate({ username: `rv${++uniq}`, name: `Affilié ${uniq}`, isActive: true, ...extra });
  if (rec) db._seed.link({ affiliateId: a.id, recruiterId: rec.id });
  return a;
}
function orders(db, a, n, extra = {}) { const out = []; for (let i = 0; i < n; i++) out.push(db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: false, commissionAmount: 25, ...extra })); return out; }
const identity = (db, a, status = 'APPROVED') => db._seed.identity({ affiliateId: a.id, status });
const qualified = (db, rec, n = 10) => { const a = aff(db, rec); const os = orders(db, a, n); identity(db, a); return { a, os }; };
const ledger = (db, where = {}) => db._tables.recruiterRewardLedger.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).sort((x, y) => (x.seq < y.seq ? -1 : 1));
const net = (db, affiliateId) => ledger(db, { affiliateId }).reduce((t, r) => t + r.amountCents, 0);
const audits = (db, action, entityId) => db._tables.recruiterAuditLog.filter((r) => r.action === action && (!entityId || r.entityId === entityId));
const sync = (E, a) => RS.syncRecruiterReward(a.id, { db: E.db, now: T0 });
/** The admin PUT /api/admin/affiliate-orders: the committed status write, then the post-commit hook. */
async function adminSetStatus(E, order, status) {
  E.db._tables.affiliateOrder.find((o) => o.id === order.id).status = status;
  return HK.onRecruiterOrderStatusCommitted(order.id, { db: E.db });
}
const deliveredReal = (db, affiliateId) => db._tables.affiliateOrder.filter((o) => o.affiliateId === affiliateId && o.status === 'delivered' && o.isFake === false).length;
/** The ledger of an affiliate is consistent: alternating cycles 1..n, net = the open reward or 0, open ⇔ the count meets its threshold. */
function consistent(db, affiliateId, threshold = 10) {
  const rows = ledger(db, { affiliateId });
  let expectCycle = 1, expectType = 'RECRUIT_REWARD', open = null;
  for (const r of rows) {
    if (r.type !== expectType || r.cycle !== expectCycle) return false;
    if (r.type === 'RECRUIT_REWARD') { open = r; expectType = 'REVERSAL'; } else { if (r.amountCents !== -open.amountCents) return false; open = null; expectType = 'RECRUIT_REWARD'; expectCycle += 1; }
  }
  const met = deliveredReal(db, affiliateId) >= threshold;
  return net(db, affiliateId) === (open ? open.amountCents : 0) && (!open || met);
}

// ── 1. cycles ──────────────────────────────────────────────────────────────────
console.log('\n1. Award → reverse → re-award cycles (re-delivery)');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A);
  ok('10 real delivered + APPROVED → AWARDED cycle 1', eq(await sync(E, a), { action: 'AWARDED', cycle: 1 }));
  const r1 = ledger(E.db, { affiliateId: a.id })[0];
  ok('cycle-1 reward: RECRUIT_REWARD 15000, cycle 1, key recruit:<id>:v1, settings v1, SYSTEM', r1.type === 'RECRUIT_REWARD' && r1.amountCents === 15000 && r1.cycle === 1 && r1.idempotencyKey === `recruit:${a.id}:v1` && r1.settingsVersion === 1 && r1.actorType === 'SYSTEM', big(r1));
  const c1 = await adminSetStatus(E, os[0], 'cancelled');
  ok('admin cancels one order (9 left) → the hook REVERSES cycle 1', eq(c1, { action: 'REVERSED', cycle: 1 }), big(c1));
  const rv1 = ledger(E.db, { affiliateId: a.id, type: 'REVERSAL' })[0];
  ok('reversal row: REVERSAL −15000, cycle 1, key reverse:<id>:v1, same recruiter, SYSTEM (no actorId), the reward\'s settings v1, reason REAL_DELIVERED_BELOW_THRESHOLD, a timestamp',
    rv1 && rv1.amountCents === -15000 && rv1.cycle === 1 && rv1.idempotencyKey === `reverse:${a.id}:v1` && rv1.recruiterId === E.A.id && rv1.actorType === 'SYSTEM' && rv1.actorId === null
    && rv1.settingsVersion === 1 && rv1.reason === 'REAL_DELIVERED_BELOW_THRESHOLD' && rv1.createdAt instanceof Date, big(rv1));
  ok('net of the affiliate after the reversal = 0', net(E.db, a.id) === 0);
  ok('another sync with 9 → NOT_QUALIFIED (cycle closed, no second reversal)', eq(await sync(E, a), { action: 'NOT_QUALIFIED', unmet: ['NOT_ENOUGH_SALES'] }) && ledger(E.db, { affiliateId: a.id }).length === 2);
  ok('re-delivery of the same order → AWARDED cycle 2 (key recruit:<id>:v2)', eq(await adminSetStatus(E, os[0], 'delivered'), { action: 'AWARDED', cycle: 2 })
    && ledger(E.db, { affiliateId: a.id, type: 'RECRUIT_REWARD', cycle: 2 })[0]?.idempotencyKey === `recruit:${a.id}:v2`);
  ok('returned → REVERSED cycle 2 (reverse:<id>:v2)', eq(await adminSetStatus(E, os[1], 'returned'), { action: 'REVERSED', cycle: 2 })
    && ledger(E.db, { affiliateId: a.id, type: 'REVERSAL', cycle: 2 })[0]?.idempotencyKey === `reverse:${a.id}:v2`);
  ok('a NEW delivered order → AWARDED cycle 3', (orders(E.db, a, 1), eq(await sync(E, a), { action: 'AWARDED', cycle: 3 })));
  const all = ledger(E.db, { affiliateId: a.id });
  ok('ledger: 5 rows alternating reward / reversal over cycles 1, 1, 2, 2, 3; net = 15000 (one open reward)',
    eq(all.map((r) => [r.type, r.cycle, r.amountCents]), [['RECRUIT_REWARD', 1, 15000], ['REVERSAL', 1, -15000], ['RECRUIT_REWARD', 2, 15000], ['REVERSAL', 2, -15000], ['RECRUIT_REWARD', 3, 15000]])
    && net(E.db, a.id) === 15000 && consistent(E.db, a.id), big(all.map((r) => [r.type, r.cycle])));
  ok('every key is unique and cycle-specific', eq(all.map((r) => r.idempotencyKey), [`recruit:${a.id}:v1`, `reverse:${a.id}:v1`, `recruit:${a.id}:v2`, `reverse:${a.id}:v2`, `recruit:${a.id}:v3`]));
  ok('one RECRUIT_REWARD_EARNED audit per cycle (3) with its cycle, one RECRUIT_REWARD_REVERSED per reversal (2)',
    eq(audits(E.db, 'RECRUIT_REWARD_EARNED', a.id).map((x) => x.details.cycle), [1, 2, 3]) && eq(audits(E.db, 'RECRUIT_REWARD_REVERSED', a.id).map((x) => x.details.cycle), [1, 2]));
}

// ── 2. transitions ─────────────────────────────────────────────────────────────
console.log('\n2. Transitions: every status that is not exactly "delivered" stops counting');
{
  for (const st of ['cancelled', 'canceled', 'returned', 'refused', 'shipped', 'pending', 'confirmed', 'Delivered', 'DELIVERED', ' delivered']) {
    const E = setup();
    const { a, os } = qualified(E.db, E.A);
    await sync(E, a);
    const r = await adminSetStatus(E, os[9], st);
    ok(`delivered → "${st}" (admin hook) with exactly the threshold → REVERSED cycle 1, exactly one reversal`, eq(r, { action: 'REVERSED', cycle: 1 }) && ledger(E.db, { affiliateId: a.id, type: 'REVERSAL' }).length === 1 && consistent(E.db, a.id), big(r));
  }
  // fake-order sync hook (src/lib/services/orderService.js → onRecruiterLinkedOrderSynced)
  const E = setup();
  const { a } = qualified(E.db, E.A, 9);
  const storeId = randomUUID();
  const linked = E.db._seed.order({ affiliateId: a.id, orderId: storeId, status: 'delivered', isFake: false });
  const fakeTwin = E.db._seed.order({ affiliateId: a.id, orderId: storeId, status: 'delivered', isFake: true });
  ok('linked-order hook: real row delivered (10) → AWARDED through the sync of its store order', eq(await HK.onRecruiterLinkedOrderSynced(storeId, { db: E.db }), { action: 'SYNCED', affiliates: 1 }) && ledger(E.db, { affiliateId: a.id }).length === 1);
  E.db._tables.affiliateOrder.find((o) => o.id === linked.id).status = 'cancelled';
  ok('linked-order hook: the store order cancelled → the real linked row stops counting → REVERSED (the fake twin never counts)',
    eq(await HK.onRecruiterLinkedOrderSynced(storeId, { db: E.db }), { action: 'SYNCED', affiliates: 1 }) && ledger(E.db, { affiliateId: a.id, type: 'REVERSAL' }).length === 1 && net(E.db, a.id) === 0);
  ok('linked-order hook replayed → no second reversal', (await HK.onRecruiterLinkedOrderSynced(storeId, { db: E.db })).action === 'SYNCED' && ledger(E.db, { affiliateId: a.id, type: 'REVERSAL' }).length === 1);
  const onlyFake = randomUUID();
  E.db._seed.order({ affiliateId: a.id, orderId: onlyFake, status: 'cancelled', isFake: true });
  ok('linked-order hook: a store order with only FAKE affiliate rows → IGNORED (fake rows never count)', eq(await HK.onRecruiterLinkedOrderSynced(onlyFake, { db: E.db }), { action: 'IGNORED', affiliates: 0 }));
  ok('linked-order hook: malformed id → IGNORED', (await HK.onRecruiterLinkedOrderSynced('bad id;', { db: E.db })).action === 'IGNORED' && (await HK.onRecruiterLinkedOrderSynced(42, { db: E.db })).action === 'IGNORED');
  void fakeTwin;
  // two affiliates sharing a store order id (a real row each) are both re-synchronised
  const F = setup();
  const x = qualified(F.db, F.A, 9).a, y = qualified(F.db, F.B, 9).a;
  const shared = randomUUID();
  F.db._seed.order({ affiliateId: x.id, orderId: shared, status: 'delivered' });
  F.db._seed.order({ affiliateId: y.id, orderId: shared, status: 'delivered' });
  F.db._seed.order({ affiliateId: y.id, orderId: shared, status: 'delivered' });
  ok('linked-order hook: every distinct real affiliate of the store order is synced once (2 affiliates, 3 rows)', eq(await HK.onRecruiterLinkedOrderSynced(shared, { db: F.db }), { action: 'SYNCED', affiliates: 2 }) && ledger(F.db, { type: 'RECRUIT_REWARD' }).length === 2);
}

// ── 3. thresholds ─────────────────────────────────────────────────────────────
console.log('\n3. The threshold of the reward\'s settings version (D2)');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A, 12);
  await sync(E, a);
  ok('12 delivered, 2 cancelled (10 left = still the threshold) → NO_CHANGE, no reversal',
    eq(await adminSetStatus(E, os[0], 'cancelled'), { action: 'NO_CHANGE', cycle: 1 }) && eq(await adminSetStatus(E, os[1], 'returned'), { action: 'NO_CHANGE', cycle: 1 }) && ledger(E.db, { type: 'REVERSAL' }).length === 0);
  ok('…a third cancellation (9) → REVERSED', eq(await adminSetStatus(E, os[2], 'refused'), { action: 'REVERSED', cycle: 1 }));

  // raised later: v2 requires 20 — the cycle-1 reward (v1, 10) is NOT reversed retroactively
  const R = setup();
  const { a: ra, os: ros } = qualified(R.db, R.A, 12);
  await sync(R, ra);
  await RS.adminSaveRecruiterSettings({ enabled: true, rewardAmountMad: '300', minDeliveredSales: 20 }, { db: R.db, actorId: 'admin-1', now: T0 });
  ok('threshold raised to 20 later (v2) → sync NO_CHANGE, reconcile reverses nothing (the reward keeps ITS v1 threshold 10)',
    eq(await sync(R, ra), { action: 'NO_CHANGE', cycle: 1 }) && (await RS.reconcileRecruiterRewards({ db: R.db, now: T0 })).reversed === 0 && ledger(R.db, { type: 'REVERSAL' }).length === 0);
  await adminSetStatus(R, ros[0], 'cancelled'); await adminSetStatus(R, ros[1], 'cancelled');
  ok('…12 → 10 still meets v1 → no reversal', ledger(R.db, { type: 'REVERSAL' }).length === 0);
  const rr = await adminSetStatus(R, ros[2], 'cancelled');
  const rrRow = ledger(R.db, { type: 'REVERSAL' })[0];
  const rrAudit = audits(R.db, 'RECRUIT_REWARD_REVERSED')[0];
  ok('…9 < 10 (v1) → REVERSED; the reversal carries settings v1, −15000 (not the v2 amount), required 10 in the audit',
    eq(rr, { action: 'REVERSED', cycle: 1 }) && rrRow.settingsVersion === 1 && rrRow.amountCents === -15000 && rrAudit.details.requiredDeliveredOrders === 10, big([rrRow, rrAudit]));

  // lowered later: v2 requires 5 (amount 99) — documented behaviour: the v1 reward is judged on 10,
  // so 7 delivered reverses it; the next sync then awards cycle 2 under the CURRENT v2 (7 ≥ 5).
  const L = setup();
  const { a: la, os: los } = qualified(L.db, L.A, 10);
  await sync(L, la);
  await RS.adminSaveRecruiterSettings({ enabled: true, rewardAmountMad: '99', minDeliveredSales: 5 }, { db: L.db, actorId: 'admin-1', now: T0 });
  await adminSetStatus(L, los[0], 'cancelled'); await adminSetStatus(L, los[1], 'cancelled');
  const lr = await adminSetStatus(L, los[2], 'cancelled');
  ok('threshold LOWERED to 5 later (v2): the v1 reward is still judged on 10 → 7 delivered (on the 1st drop below 10) REVERSES it (−15000, v1)',
    ledger(L.db, { type: 'REVERSAL', cycle: 1 })[0]?.amountCents === -15000 && ledger(L.db, { type: 'REVERSAL', cycle: 1 })[0]?.settingsVersion === 1, big(lr));
  const lAll = ledger(L.db, { affiliateId: la.id });
  ok('…documented: a later sync awards cycle 2 under the CURRENT v2 (9900, v2) since 7 ≥ 5 — net = the current amount',
    lAll.some((r) => r.type === 'RECRUIT_REWARD' && r.cycle === 2 && r.amountCents === 9900 && r.settingsVersion === 2) && net(L.db, la.id) === 9900 && consistent(L.db, la.id, 5), big(lAll.map((r) => [r.type, r.cycle, r.amountCents])));
}

// ── 4. duplicates and concurrency ─────────────────────────────────────────────
console.log('\n4. Duplicates and concurrency: exactly one reversal per cycle');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A);
  await sync(E, a);
  E.db._tables.affiliateOrder.find((o) => o.id === os[0].id).status = 'cancelled';
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push((await HK.onRecruiterOrderStatusCommitted(os[0].id, { db: E.db })).action);
  ok('the same cancellation event 5 times → 1 REVERSED then NOT_QUALIFIED; exactly 1 reversal row and 1 audit',
    eq(seq, ['REVERSED', 'NOT_QUALIFIED', 'NOT_QUALIFIED', 'NOT_QUALIFIED', 'NOT_QUALIFIED']) && ledger(E.db, { type: 'REVERSAL' }).length === 1 && audits(E.db, 'RECRUIT_REWARD_REVERSED').length === 1, seq.join(','));

  for (const cycle of [1, 2]) {
    const C = setup();
    const { a: ca, os: cos } = qualified(C.db, C.A);
    await sync(C, ca);
    if (cycle === 2) { await adminSetStatus(C, cos[0], 'cancelled'); await adminSetStatus(C, cos[0], 'delivered'); }
    C.db._tables.affiliateOrder.find((o) => o.id === cos[1].id).status = 'returned';
    const res = await Promise.all(Array.from({ length: 20 }, (_v, i) => (
      i % 4 === 0 ? RS.syncRecruiterReward(ca.id, { db: C.db }).then((r) => r.action)
        : i % 4 === 1 ? HK.onRecruiterOrderStatusCommitted(cos[1].id, { db: C.db }).then((r) => r.action)
          : i % 4 === 2 ? RS.awardRecruiterRewardIfQualified(ca.id, { db: C.db }).then((r) => r.action)
            : RS.reconcileRecruiterRewards({ db: C.db }).then((r) => `reconcile:${r.reversed}`)
    )));
    const reversedEvents = res.filter((x) => x === 'REVERSED').length + res.filter((x) => x === 'reconcile:1').length;
    ok(`20 concurrent reversal attempts on cycle ${cycle} (syncs, hooks, awards, reconciles) → exactly ONE reversal row and audit for cycle ${cycle}, exactly one event reports it`,
      ledger(C.db, { type: 'REVERSAL', cycle }).length === 1 && audits(C.db, 'RECRUIT_REWARD_REVERSED').filter((x) => x.details.cycle === cycle).length === 1 && reversedEvents === 1
      && ledger(C.db, { type: 'REVERSAL' }).length === cycle && consistent(C.db, ca.id), res.join(','));
    ok(`…no lock left held, no transaction left open (cycle ${cycle})`, C.db._locks.size === 0 && C.db._openTx.size === 0);
  }

  // the database guard alone (no application lock): 20 concurrent forced reversal inserts of cycle 1
  const G = setup();
  const { a: ga } = qualified(G.db, G.A);
  await sync(G, ga);
  const forced = await Promise.all(Array.from({ length: 20 }, (_v, i) => G.db.$transaction(async (tx) => tx.recruiterRewardLedger.create({
    data: { recruiterId: G.A.id, affiliateId: ga.id, type: 'REVERSAL', amountCents: -15000, cycle: 1, idempotencyKey: i % 2 ? `reverse:${ga.id}:v1` : `reverse:${ga.id}`, actorType: 'SYSTEM' },
  })).then(() => 'ok', (e) => e.code)));
  ok('20 concurrent FORCED reversal inserts (versioned and legacy cycle-1 keys, no application lock) → exactly 1 written (unique key / cycle guard refuse the rest)',
    forced.filter((x) => x === 'ok').length === 1 && ledger(G.db, { type: 'REVERSAL' }).length === 1 && forced.every((x) => ['ok', 'P2002', 'P2010'].includes(x)), forced.join(','));

  // an award racing a cancellation: the cancellation commits at every point of the award transaction
  let allConsistent = true;
  const traces = [];
  for (let k = 0; k < 14; k++) {
    const R = setup();
    const { a: ra, os: ros } = qualified(R.db, R.A);
    // The cancellation's hook is started from THIS (top-level) context — never inside the award's
    // transaction: it awaits a gate that the fake's `before` hook opens at the k-th database call of
    // the award, right after the cancellation write committed (autocommit).
    let n = 0;
    let open = null;
    const gate = new Promise((resolve) => { open = resolve; });
    const cancelTask = (async () => { await gate; return HK.onRecruiterOrderStatusCommitted(ros[0].id, { db: R.db }); })();
    let fired = false;
    const commitCancel = () => { if (fired) return; fired = true; R.db._tables.affiliateOrder.find((o) => o.id === ros[0].id).status = 'cancelled'; open(); };
    R.hookBox.fn = (model) => { if (model !== '$transaction' && ++n === k + 1) commitCancel(); return undefined; };
    const awardRes = await RS.syncRecruiterReward(ra.id, { db: R.db, now: T0 });
    R.hookBox.fn = null;
    commitCancel(); // k beyond the award's calls: the cancellation commits after it
    const cancelRes = await cancelTask;
    const settle = await RS.syncRecruiterReward(ra.id, { db: R.db, now: T0 });
    const good = consistent(R.db, ra.id) && net(R.db, ra.id) === 0 && settle.action === 'NOT_QUALIFIED' && R.db._locks.size === 0;
    traces.push(`${k}:${awardRes.action}/${cancelRes?.action ?? '-'}/${ledger(R.db, { affiliateId: ra.id }).length}`);
    if (!good) allConsistent = false;
  }
  ok('an award racing a cancellation (the cancellation commits before / inside / after the award transaction, 14 interleavings) → always consistent: net 0, no open reward, nothing pending',
    allConsistent, traces.join(' '));
  ok('…both outcomes really happened (award then reversal, and no award at all)', traces.some((t) => /AWARDED\/REVERSED\/2$/.test(t)) && traces.some((t) => /\/0$/.test(t)), traces.join(' '));
}

// ── 5. amounts per cycle ──────────────────────────────────────────────────────
console.log('\n5. Multiple cycles: amounts and keys');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A);
  await sync(E, a);
  await RS.adminSaveRecruiterSettings({ enabled: true, rewardAmountMad: '300', minDeliveredSales: 10 }, { db: E.db, actorId: 'admin-1', now: T0 });
  await adminSetStatus(E, os[0], 'cancelled');
  ok('settings amount changed (300 MAD, v2) between award and reversal → the cycle-1 reversal is −15000 (that cycle\'s reward), v1', ledger(E.db, { type: 'REVERSAL', cycle: 1 })[0]?.amountCents === -15000 && ledger(E.db, { type: 'REVERSAL', cycle: 1 })[0]?.settingsVersion === 1);
  await adminSetStatus(E, os[0], 'delivered');
  ok('cycle 2 is awarded with the CURRENT settings: 30000, v2', ledger(E.db, { type: 'RECRUIT_REWARD', cycle: 2 })[0]?.amountCents === 30000 && ledger(E.db, { type: 'RECRUIT_REWARD', cycle: 2 })[0]?.settingsVersion === 2);
  await RS.adminSaveRecruiterSettings({ enabled: true, rewardAmountMad: '10', minDeliveredSales: 10 }, { db: E.db, actorId: 'admin-1', now: T0 });
  await adminSetStatus(E, os[1], 'returned');
  ok('cycle-2 reversal = −30000 (its reward, not the current 1000), v2', ledger(E.db, { type: 'REVERSAL', cycle: 2 })[0]?.amountCents === -30000 && ledger(E.db, { type: 'REVERSAL', cycle: 2 })[0]?.settingsVersion === 2);
  await adminSetStatus(E, os[1], 'delivered');
  const all = ledger(E.db, { affiliateId: a.id });
  ok('ledger: +15000 v1 / −15000 / +30000 v2 / −30000 / +1000 v3; keys recruit|reverse:<id>:v1..v3; net 1000',
    eq(all.map((r) => [r.amountCents, r.cycle, r.idempotencyKey]), [[15000, 1, `recruit:${a.id}:v1`], [-15000, 1, `reverse:${a.id}:v1`], [30000, 2, `recruit:${a.id}:v2`], [-30000, 2, `reverse:${a.id}:v2`], [1000, 3, `recruit:${a.id}:v3`]])
    && net(E.db, a.id) === 1000, big(all.map((r) => [r.amountCents, r.cycle])));
  ok('each reversal audit records the reversed amount, its settings version and the required count of that version',
    eq(audits(E.db, 'RECRUIT_REWARD_REVERSED').map((x) => [x.details.cycle, x.details.amountCents, x.details.settingsVersion, x.details.requiredDeliveredOrders]), [[1, -15000, 1, 10], [2, -30000, 2, 10]]));
}

// ── 6. append-only and database guards ────────────────────────────────────────
console.log('\n6. Append-only ledger and the database guards (migration 20261110)');
{
  const E = setup();
  const { a } = qualified(E.db, E.A);
  await sync(E, a);
  const snap = big(E.db._tables.recruiterRewardLedger);
  const refused = [];
  for (const [op, args] of [['update', { where: { id: 'x' }, data: { amountCents: 1 } }], ['updateMany', { where: {}, data: { cycle: 2 } }], ['upsert', {}], ['delete', { where: { id: 'x' } }], ['deleteMany', {}], ['createMany', { data: [] }]]) {
    refused.push(await E.db.recruiterRewardLedger[op](args).then(() => 'ok', (e) => e.code));
  }
  ok('update / updateMany / upsert / delete / deleteMany / createMany on the ledger → refused (append-only trigger); rows unchanged',
    refused.every((x) => x === 'P2010') && big(E.db._tables.recruiterRewardLedger) === snap, refused.join(','));
  ok('the reward service never updates / deletes a ledger row, and touches no affiliate column',
    !/recruiterRewardLedger\.(update|updateMany|delete|deleteMany|upsert)|affiliate\.(update|updateMany|upsert)|affiliateOrder\.(update|create)/.test(stripJs(read('src/lib/services/recruiterRewardService.js'))));

  const ins = (data) => E.db.$transaction(async (tx) => tx.recruiterRewardLedger.create({ data: { recruiterId: E.A.id, affiliateId: a.id, actorType: 'SYSTEM', ...data } })).then(() => 'ok', (e) => e.meta?.constraint ?? e.code);
  const R = (cycle, extra = {}) => ({ type: 'REVERSAL', amountCents: -15000, cycle, idempotencyKey: `reverse:${a.id}:v${cycle}`, ...extra });
  const W = (cycle, extra = {}) => ({ type: 'RECRUIT_REWARD', amountCents: 15000, cycle, settingsVersion: 1, idempotencyKey: `recruit:${a.id}:v${cycle}`, ...extra });
  ok('a reward for cycle 2 while cycle 1 is open → cycle guard', (await ins(W(2))) === 'P2010');
  ok('a reversal larger than the reward (−15001) → cycle guard', (await ins(R(1, { amountCents: -15001 }))) === 'P2010');
  ok('a reversal of a cycle with no reward (cycle 2) → cycle guard', (await ins(R(2))) === 'P2010');
  ok('a reversal credited to another recruiter → cycle guard', (await ins(R(1, { recruiterId: E.B.id }))) === 'P2010');
  ok('a key that does not match the cycle (reverse:<id>:v2 for cycle 1) → cycle-key CHECK', (await ins(R(1, { idempotencyKey: `reverse:${a.id}:v2` }))) === 'recruiter_reward_ledger_cycle_check');
  ok('cycle 0 → CHECK; a missing cycle → NOT NULL (no default)', (await ins(R(0, { idempotencyKey: `reverse:${a.id}:v0` }))) === 'recruiter_reward_ledger_cycle_check' && (await E.db.$transaction(async (tx) => tx.recruiterRewardLedger.create({ data: { recruiterId: E.A.id, affiliateId: a.id, actorType: 'SYSTEM', type: 'REVERSAL', amountCents: -1, idempotencyKey: `reverse:${a.id}:v1` } })).then(() => 'ok', (e) => e.code)) === 'P2011');
  ok('the exact reversal of cycle 1 is accepted by the database', (await ins(R(1))) === 'ok');
  // (the cycle guard checks the reward of the latest cycle, not an existing reversal: the per-cycle unique index refuses it)
  ok('a second reversal of cycle 1 with the other accepted (legacy) key → refused by the one-reversal-per-cycle unique index', (await ins(R(1, { idempotencyKey: `reverse:${a.id}` }))) === 'P2002');
  ok('a reward skipping a cycle (3) → cycle guard; the legacy key for cycle 2 → cycle-key CHECK', (await ins(W(3))) === 'P2010' && (await ins(W(2, { idempotencyKey: `recruit:${a.id}` }))) === 'recruiter_reward_ledger_cycle_check');
  ok('the next reward (cycle 2, recruit:<id>:v2) is accepted once cycle 1 is closed', (await ins(W(2))) === 'ok');
  ok('the ledger stays consistent after the forced inserts', consistent(E.db, a.id));
}

// ── 7. legacy cycle-1 rows ─────────────────────────────────────────────────────
console.log('\n7. Rows written before the cycles (cycle 1, legacy keys)');
{
  const E = setup();
  const a = aff(E.db, E.A); orders(E.db, a, 9); identity(E.db, a);
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: 12000, settingsVersion: 1, reason: 'REAL_DELIVERED_AND_CIN_APPROVED', idempotencyKey: `recruit:${a.id}` });
  const r = await sync(E, a);
  const rv = ledger(E.db, { affiliateId: a.id, type: 'REVERSAL' })[0];
  ok('a legacy reward (recruit:<id>, cycle 1, 12000) with 9 delivered → REVERSED with reverse:<id>:v1, −12000', eq(r, { action: 'REVERSED', cycle: 1 }) && rv?.idempotencyKey === `reverse:${a.id}:v1` && rv?.amountCents === -12000, big(rv));
  orders(E.db, a, 1);
  ok('…then 10 delivered → AWARDED cycle 2 (recruit:<id>:v2)', eq(await sync(E, a), { action: 'AWARDED', cycle: 2 }) && ledger(E.db, { affiliateId: a.id, cycle: 2 })[0]?.idempotencyKey === `recruit:${a.id}:v2`);
  const L = setup();
  const b = aff(L.db, L.A); orders(L.db, b, 10); identity(L.db, b);
  L.db._seed.ledger({ recruiterId: L.A.id, affiliateId: b.id, type: 'RECRUIT_REWARD', amountCents: 15000, settingsVersion: 1, idempotencyKey: `recruit:${b.id}` });
  L.db._seed.ledger({ recruiterId: L.A.id, affiliateId: b.id, type: 'REVERSAL', amountCents: -15000, idempotencyKey: `reverse:${b.id}` });
  ok('a legacy CLOSED pair (recruit:<id> + reverse:<id>, cycle 1) → the next award is cycle 2', eq(await sync(L, b), { action: 'AWARDED', cycle: 2 }) && consistent(L.db, b.id));
  const K = setup();
  const c = aff(K.db, K.A); orders(K.db, c, 10); identity(K.db, c);
  K.db._seed.ledger({ recruiterId: K.A.id, affiliateId: c.id, type: 'RECRUIT_REWARD', amountCents: 15000, settingsVersion: 1, idempotencyKey: `recruit:${c.id}` });
  ok('a legacy OPEN reward still met → NO_CHANGE (never a second cycle-1 reward)', eq(await sync(K, c), { action: 'NO_CHANGE', cycle: 1 }) && ledger(K.db, { affiliateId: c.id }).length === 1);
}

// ── 8. reconcile ───────────────────────────────────────────────────────────────
console.log('\n8. Reconcile: reverses even with rewards OFF, never awards then');
{
  const E = setup();
  const g = qualified(E.db, E.A), h = qualified(E.db, E.A), k = qualified(E.db, E.B);
  for (const x of [g, h, k]) await sync(E, x.a);
  const fresh = qualified(E.db, E.A); // qualifies, never awarded
  await RS.adminSaveRecruiterSettings({ enabled: false, rewardAmountMad: '0', minDeliveredSales: 10 }, { db: E.db, actorId: 'admin-1', now: T0 });
  E.db._tables.affiliateOrder.find((o) => o.id === g.os[0].id).status = 'cancelled'; // committed without a hook (e.g. the hook failed)
  E.db._tables.affiliateOrder.find((o) => o.id === k.os[0].id).status = 'returned';
  const r = await RS.reconcileRecruiterRewards({ db: E.db, now: T0 });
  // Phase 7: + groupChecked / groupAwarded / groupReversed (group rewards off and none exists → no group pass;
  // the same for a recruiter-scoped run: groupChecked 0).
  ok('rewards OFF (v2 disabled): reconcile reverses the 2 open rewards now below their v1 threshold, awards nothing (the qualifying never-awarded affiliate gets nothing)',
    eq(r, { checked: 4, awarded: 0, reversed: 2, unchanged: 0, candidates: 2, batches: 1, cursor: null, hasMore: false, busy: false, groupChecked: 0, groupAwarded: 0, groupReversed: 0 }) && ledger(E.db, { affiliateId: g.a.id, type: 'REVERSAL' }).length === 1 && ledger(E.db, { affiliateId: k.a.id, type: 'REVERSAL' }).length === 1
    && ledger(E.db, { affiliateId: h.a.id, type: 'REVERSAL' }).length === 0 && ledger(E.db, { affiliateId: fresh.a.id }).length === 0, big(r));
  ok('…a second reconcile changes nothing (idempotent)', eq(await RS.reconcileRecruiterRewards({ db: E.db, now: T0 }), { checked: 4, awarded: 0, reversed: 0, unchanged: 0, candidates: 0, batches: 1, cursor: null, hasMore: false, busy: false, groupChecked: 0, groupAwarded: 0, groupReversed: 0 }));
  ok('…with rewards OFF, re-delivery does not open a new cycle (sync → NOT_QUALIFIED REWARDS_DISABLED)',
    (E.db._tables.affiliateOrder.find((o) => o.id === g.os[0].id).status = 'delivered', eq(await sync(E, g.a), { action: 'NOT_QUALIFIED', unmet: ['REWARDS_DISABLED'] })));
  const S = setup();
  const sa = qualified(S.db, S.A), sb = qualified(S.db, S.B);
  await sync(S, sa.a); await sync(S, sb.a);
  for (const x of [sa, sb]) S.db._tables.affiliateOrder.find((o) => o.id === x.os[0].id).status = 'cancelled';
  ok('reconcile scoped to recruiter A reverses only A\'s affiliate', eq(await RS.reconcileRecruiterRewards({ db: S.db, recruiterId: S.A.id, now: T0 }), { checked: 1, awarded: 0, reversed: 1, unchanged: 0, candidates: 1, batches: 1, cursor: null, hasMore: false, busy: false, groupChecked: 0, groupAwarded: 0, groupReversed: 0 }) && ledger(S.db, { affiliateId: sb.a.id, type: 'REVERSAL' }).length === 0);
  S.db._tables.affiliateOrder.find((o) => o.id === sa.os[0].id).status = 'delivered';
  const on = await RS.reconcileRecruiterRewards({ db: S.db, now: T0 });
  ok('reconcile with rewards ON: re-awards the re-delivered affiliate of A (new cycle) and reverses B', eq(on, { checked: 2, awarded: 1, reversed: 1, unchanged: 0, candidates: 2, batches: 1, cursor: null, hasMore: false, busy: false, groupChecked: 0, groupAwarded: 0, groupReversed: 0 }), big(on));
  ok('…end state: A has cycle 2 open, B reversed', ledger(S.db, { affiliateId: sa.a.id, cycle: 2, type: 'RECRUIT_REWARD' }).length === 1 && ledger(S.db, { affiliateId: sb.a.id, type: 'REVERSAL' }).length === 1 && consistent(S.db, sa.a.id) && consistent(S.db, sb.a.id));
}

// ── 9. audit ───────────────────────────────────────────────────────────────────
console.log('\n9. Audit RECRUIT_REWARD_REVERSED');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A, 11);
  await sync(E, a);
  await adminSetStatus(E, os[0], 'cancelled'); await adminSetStatus(E, os[1], 'refused');
  const au = audits(E.db, 'RECRUIT_REWARD_REVERSED', a.id);
  ok('exactly one RECRUIT_REWARD_REVERSED: SYSTEM, recruiter A, entity = the affiliate, details = { cycle, amountCents, settingsVersion, realDeliveredOrders, requiredDeliveredOrders, reason }',
    au.length === 1 && au[0].actorType === 'SYSTEM' && au[0].actorId === 'SYSTEM' && au[0].recruiterId === E.A.id && au[0].entityType === 'affiliate' && au[0].entityId === a.id
    && eq(au[0].details, { cycle: 1, amountCents: -15000, settingsVersion: 1, realDeliveredOrders: 9, requiredDeliveredOrders: 10, reason: 'REAL_DELIVERED_BELOW_THRESHOLD' }) && au[0].createdAt instanceof Date, big(au));
  ok('the reversal and its audit are atomic: an injected audit failure leaves no reversal; the next event writes both', await (async () => {
    const F = setup();
    const { a: fa, os: fos } = qualified(F.db, F.A);
    await sync(F, fa);
    F.db._tables.affiliateOrder.find((o) => o.id === fos[0].id).status = 'cancelled';
    F.db._state.failOnce['recruiterAuditLog.create'] = true;
    const orig = console.error; console.error = () => {};
    const first = await HK.onRecruiterOrderStatusCommitted(fos[0].id, { db: F.db }).catch(() => 'threw').finally(() => { console.error = orig; });
    const noRow = ledger(F.db, { type: 'REVERSAL' }).length === 0;
    const second = await HK.onRecruiterOrderStatusCommitted(fos[0].id, { db: F.db });
    return first?.action === 'ERROR' && noRow && second.action === 'REVERSED' && ledger(F.db, { type: 'REVERSAL' }).length === 1 && audits(F.db, 'RECRUIT_REWARD_REVERSED').length === 1;
  })());
  ok('REWARD_REASONS: EARNED = REAL_DELIVERED_AND_CIN_APPROVED, REVERSED = REAL_DELIVERED_BELOW_THRESHOLD (frozen)', eq(RS.REWARD_REASONS, { EARNED: 'REAL_DELIVERED_AND_CIN_APPROVED', REVERSED: 'REAL_DELIVERED_BELOW_THRESHOLD' }) && Object.isFrozen(RS.REWARD_REASONS));
}

// ── 10. display and wallet ─────────────────────────────────────────────────────
console.log('\n10. Recruiter history, admin ledger and wallet');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A);
  await sync(E, a);
  await adminSetStatus(E, os[0], 'cancelled');
  await adminSetStatus(E, os[0], 'delivered');
  const w = await WS.getRecruiterWallet(E.A.id, { db: E.db });
  const view = V.toRecruiterWalletView(w);
  const rev = view.rewards.find((r) => r.type === 'REVERSAL');
  ok('recruiter history: the reversal is a NEGATIVE entry (−15000) with reason REAL_DELIVERED_BELOW_THRESHOLD, the threshold of the reversed reward (10), cycle 1, the affiliate',
    eq({ ...rev, createdAt: typeof rev?.createdAt }, { type: 'REVERSAL', amountCents: -15000, currency: 'MAD', affiliate: { id: a.id, username: a.username, name: a.name }, reason: 'REAL_DELIVERED_BELOW_THRESHOLD', requiredDeliveredOrders: 10, cycle: 1, createdAt: 'string' }), big(rev));
  ok('recruiter history: 3 entries (reward c1, reversal c1, reward c2) with their cycles', eq(view.rewards.map((r) => [r.type, r.cycle]).sort(), [['RECRUIT_REWARD', 1], ['RECRUIT_REWARD', 2], ['REVERSAL', 1]]));
  ok('wallet totals are net of the reversal: earned 15000 (= +15000 −15000 +15000), available 15000', view.totals.earnedCents === 15000 && view.totals.availableCents === 15000, big(view.totals));
  const adm = await WS.adminListRecruiterLedger({ db: E.db });
  const ar = adm.find((r) => r.type === 'REVERSAL');
  ok('admin ledger: the reversal row with −15000, cycle 1, settings v1, reason REAL_DELIVERED_BELOW_THRESHOLD, SYSTEM, recruiter / affiliate usernames',
    ar && ar.amountCents === -15000 && ar.cycle === 1 && ar.settingsVersion === 1 && ar.reason === 'REAL_DELIVERED_BELOW_THRESHOLD' && ar.actorType === 'SYSTEM' && ar.recruiterUsername === 'rec.a' && ar.affiliateUsername === a.username
    && adm.filter((r) => r.type === 'RECRUIT_REWARD').map((r) => r.cycle).sort().join() === '1,2', big(ar));
  const admin = read('src/app/admin/recruiter-rewards/page.jsx');
  const wallet = read('src/app/recruiter/wallet/page.jsx');
  ok('admin page labels REAL_DELIVERED_BELOW_THRESHOLD and shows the cycle; the recruiter wallet page shows the Arabic reversal reason with the threshold and the cycle (> 1)',
    /REAL_DELIVERED_BELOW_THRESHOLD: "Annulation automatique : commandes réelles livrées sous le seuil \(annulation \/ retour\)"/.test(admin) && /cycle \$\{l\.cycle\}/.test(admin)
    && /r\.reason === "REAL_DELIVERED_BELOW_THRESHOLD"/.test(wallet) && /سحب المكافأة: الطلبيات الحقيقية المسلّمة أصبحت أقل من \$\{r\.requiredDeliveredOrders \?\? "—"\}/.test(wallet) && /r\.cycle > 1 \? ` · الدورة \$\{r\.cycle\}`/.test(wallet));
  ok('the recruiter view never carries settingsVersion, recruiterId, actor or the internal reason text', !/settingsVersion|recruiterId|actorType|actorId|"reason":"<|SYSTEM/.test(JSON.stringify(view.rewards)));
}

// ── 11. affiliate money untouched ──────────────────────────────────────────────
console.log('\n11. Affiliate commissions, points, balances and payouts untouched');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A);
  E.db._seed.payout({ affiliateId: a.id, amount: 120, status: 'pending' });
  const snapshot = () => big({ affiliate: E.db._tables.affiliate, orders: E.db._tables.affiliateOrder.map(({ status: _status, ...rest }) => rest), identity: E.db._tables.identityVerification, payouts: E.db._tables.affiliatePayout, links: E.db._tables.recruiterAffiliateLink });
  const before = snapshot();
  await sync(E, a);
  await adminSetStatus(E, os[0], 'cancelled');
  await adminSetStatus(E, os[0], 'delivered');
  await adminSetStatus(E, os[1], 'returned');
  await RS.reconcileRecruiterRewards({ db: E.db, now: T0 });
  ok('a full award / reverse / re-award / reverse run changes NO affiliate row, order row (except the admin status writes), identity, link or payout (commission, points, balances, payouts untouched)', snapshot() === before);
  ok('every write of the run went to the recruiter ledger / audit only', E.db._log.filter((l) => ['create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(l.op)).every((l) => ['recruiterRewardLedger', 'recruiterAuditLog'].includes(l.model)));
  let touched = [];
  for (const m of ['affiliateCommission', 'rewardPoint', 'rewardOrderAward', 'affiliateWallet', 'order']) { try { void E.db[m]; } catch { touched.push(m); } }
  ok('the fake refuses every other model (commission / points / rewards / store orders) — the run above never needed one', touched.length === 5);
  const hk = stripJs(read('src/lib/recruiterRewardHooks.js'));
  const rs = stripJs(read('src/lib/services/recruiterRewardService.js'));
  ok('the reward service and hooks never read commission, points, balance or payout code', !/commission|rewardPoint|balance|payout|affiliateSystemService|rewardsService/i.test(rs + hk));
  ok('src/lib/services/affiliateSystemService.js is byte-identical to the part 3 base commit', git(['show', `${PART3_BASE}:src/lib/services/affiliateSystemService.js`]) === read('src/lib/services/affiliateSystemService.js'));
  const changed = git(['diff', '--name-only', PART3_BASE, '--', 'src']).split('\n').filter(Boolean).sort();
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n').filter(Boolean);
  // Exact allowlist: the Part 3a files, plus exactly the two files only Part 3b (withdrawal protection) adds,
  // plus exactly the Part 3c (recruiter KYC) files — 8 new (untracked before the commit, tracked additions
  // after it: both forms are accepted, the exact set is not) and 3 more modified (dashboard link, admin
  // sidebar link, the wallet handlers' 403 status). No commission / points / balance / payout / affiliate-KYC file.
  // Phase 6 part 4 (recruiter permissions, documented exception): plus exactly its 13 paths — 1 new route
  // (admin permissions PATCH) and 12 modified files (admin recruiters page, the recruiter activation / new-affiliate /
  // network / stats pages + networkUi, the network handlers + service, the profile view, the recruiter route
  // handlers + service, the activation service). Still no commission / points / balance / payout / affiliate-KYC file.
  const allSrc = [...new Set([...changed, ...untracked])].sort();
  ok('src/ changed versus the part 3 base commit ONLY in the Part 3a files + the Part 3b files errorLabels.js / recruiterRewardAdminHandlers.js + the exact Part 3c recruiter KYC files + the exact Part 4 permission files (no commission / points / balance / payout / affiliate KYC file)', eq(allSrc, [
    'src/app/admin/recruiter-identity/page.jsx', 'src/app/admin/recruiter-rewards/page.jsx', 'src/app/api/admin/affiliate-orders/route.js',
    'src/app/api/admin/recruiter-identity/[id]/[side]/route.js', 'src/app/api/admin/recruiter-identity/route.js', 'src/app/api/recruiter/identity/route.js',
    'src/app/recruiter/errorLabels.js', 'src/app/recruiter/page.jsx', 'src/app/recruiter/verification/page.jsx', 'src/app/recruiter/wallet/page.jsx',
    'src/components/admin/SideBar.jsx',
    'src/lib/recruiterIdentityAdminHandlers.js', 'src/lib/recruiterIdentityRouteHandlers.js',
    'src/lib/recruiterRewardAdminHandlers.js', 'src/lib/recruiterRewardHooks.js',
    'src/lib/recruiterSettings.js', 'src/lib/recruiterVisibility.js', 'src/lib/recruiterWalletRouteHandlers.js', 'src/lib/services/orderService.js',
    'src/lib/services/recruiterIdentityService.js', 'src/lib/services/recruiterRewardService.js', 'src/lib/services/recruiterWalletService.js',
    // Phase 6 part 4
    'src/app/admin/recruiters/page.jsx', 'src/app/api/admin/recruiters/[id]/permissions/route.js',
    'src/app/recruiter/affiliates/activation/page.jsx', 'src/app/recruiter/affiliates/new/page.jsx',
    'src/app/recruiter/network/networkUi.jsx', 'src/app/recruiter/network/page.jsx', 'src/app/recruiter/network/stats/page.jsx',
    'src/lib/recruiterNetworkRouteHandlers.js', 'src/lib/recruiterProfileView.js', 'src/lib/recruiterRouteHandlers.js',
    'src/lib/services/affiliateActivationService.js', 'src/lib/services/recruiterNetworkService.js', 'src/lib/services/recruiterService.js',
    // Phase 6 part 5c (approved): the affiliate creation's ancestry check (one statement); only
    // assertAncestryInNetwork differs — pinned below and in recruiterPermissions.test.mjs.
    'src/lib/services/recruiterAffiliateService.js',
    // Phase 7 Stage B (approved): downline visibility / progress — the affiliate list handler, the progress
    // summary (handler, service, route); the network service / handlers, visibility and the list above.
    'src/lib/recruiterAffiliateRouteHandlers.js', 'src/lib/recruiterProgressHandlers.js', 'src/lib/services/recruiterProgressService.js',
    'src/app/api/recruiter/progress/route.js',
    // Phase 7 Stage C (approved, UI only): the new affiliates list page, the password page (401-only redirect, double-
    // submit guard), the pure UI helpers and the Landing Page Only Mode allowlist — no commission / points / balance /
    // payout / affiliate KYC file (the dashboard, verification, wallet and errorLabels files are already listed above).
    'src/app/recruiter/affiliates/page.jsx', 'src/app/recruiter/password/page.jsx', 'src/app/recruiter/recruiterUiState.js',
    'src/app/recruiter/wallet/walletUi.js', 'src/lib/landingMode.js',
    // Recruiter dashboard redesign (UI only): the dashboard's layout / navigation, cards and charts components — no
    // commission / points / balance / payout / affiliate KYC file (the dashboard page and its helpers are listed above).
    'src/app/recruiter/_components/DashboardWidgets.jsx',
    'src/app/recruiter/_components/RecruiterShell.jsx',
    // Phase 2 (UI only — one recruiter app): the layout mounts the app shell (RecruiterAppShell) around every authenticated
    // recruiter page with the shared UI kit (ui.jsx); the activation code card is restyled with it. no commission / points / balance / payout / affiliate KYC file.
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
    // Phase 7 Stage F (approved clarification): an affiliate with children cannot be deleted — the deletion helper and the
    // 409 mapping of the admin DELETE route and of the legacy controller (no commission / points / balance / payout file).
    'src/app/api/admin/affiliates/route.js', 'src/lib/affiliateDeletion.js', 'src/lib/controllers/affiliateController.js',
  ].sort()), big({ changed, untracked }));
  ok('recruiterAffiliateService.js (Phase 6 part 5c): versus the part 3 base, every changed line lies inside assertAncestryInNetwork or its // comment, and none mentions commission / points / balance / payout / orders / rewards (Phase 7 Stage B: the affiliate list change undone first — undoStageBList)', (() => {
    const f = 'src/lib/services/recruiterAffiliateService.js';
    const base = git(['show', `${PART3_BASE}:${f}`]);
    const cur = undoStageBList(undoStageE(undoStageFAffiliates(read(f)), base), base); // Stage F, then Stage E, then Stage B undone
    const head = 'async function assertAncestryInNetwork(';
    const tail = '\n/**\n * Recruiter: create an affiliate (inactive)';
    const bi = base.indexOf(head), bt = base.indexOf(tail);
    if (bi < 0 || bt < bi) return false;
    const pre = base.slice(0, bi), post = base.slice(bt);
    if (!cur.startsWith(pre) || !cur.endsWith(post) || cur.length < pre.length + post.length) return false;
    const mid = cur.slice(pre.length, cur.length - post.length);
    return mid.includes(head) && (mid.match(/\bfunction\b/g) || []).length === 1 && !/\bexport\b|\bimport\b/.test(mid)
      && !/commission|rewardPoint|balance|payout|affiliate_orders|affiliateOrder|ledger|reward/i.test(mid);
  })());
  const os2 = git(['diff', PART3_BASE, '--', 'src/lib/services/orderService.js']).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  ok('orderService.js: only the hook import, its comment and the post-sync call were added (nothing removed)', eq(os2, [
    "+import { onRecruiterLinkedOrderSynced } from '../recruiterRewardHooks.js';",
    '+      // Recruiter reward (post-commit, never throws; Phase 6 part 3a): real rows linked to this id.',
    '+      await onRecruiterLinkedOrderSynced(String(id));',
  ]), big(os2));
}

// ── 12. hooks ──────────────────────────────────────────────────────────────────
console.log('\n12. Hooks never throw; deferred inside a transaction');
{
  const E = setup();
  const { a, os } = qualified(E.db, E.A);
  const txLike = { affiliateOrder: E.db.affiliateOrder, identityVerification: E.db.identityVerification };
  ok('all three hooks → DEFERRED for a transaction client (no $transaction)',
    (await HK.onRecruiterOrderStatusCommitted(os[0].id, { db: txLike })).action === 'DEFERRED' && (await HK.onRecruiterIdentityApprovedCommitted('x', { db: txLike })).action === 'DEFERRED'
    && (await HK.onRecruiterLinkedOrderSynced('x', { db: txLike })).action === 'DEFERRED' && ledger(E.db).length === 0);
  const F = setup({ failOnce: { 'affiliateOrder.findMany': true } });
  const errs = []; const orig = console.error; console.error = (...x) => errs.push(x.map(String).join(' '));
  let thrown = false, res = null;
  try { res = await HK.onRecruiterLinkedOrderSynced(randomUUID(), { db: F.db }); } catch { thrown = true; } finally { console.error = orig; }
  ok('linked-order hook: an injected database failure → ERROR (never throws), one log line with a code only', !thrown && res?.action === 'ERROR' && errs.length === 1 && !/injected/.test(errs[0]), big([res, errs]));
  const errs2 = []; console.error = (...x) => errs2.push(x.map(String).join(' '));
  try { res = await HK.onRecruiterOrderStatusCommitted(os[0].id, { db: E.db, award: async () => { throw new Error('boom'); } }); } finally { console.error = orig; }
  ok('order hook: a throwing sync → ERROR, not thrown', res?.action === 'ERROR');
  const fakeO = E.db._seed.order({ affiliateId: a.id, status: 'cancelled', isFake: true });
  ok('order hook: a FAKE order (any status) → IGNORED', (await HK.onRecruiterOrderStatusCommitted(fakeO.id, { db: E.db })).action === 'IGNORED');
  const ord = stripJs(read('src/app/api/admin/affiliate-orders/route.js'));
  ok('admin route: the hook is called UNCONDITIONALLY after the committed status write', /const order = await adminUpdateAffiliateOrderStatus\(orderId, status\);\s*await onRecruiterOrderStatusCommitted\(String\(orderId\)\);\s*return Response\.json\(order\);/.test(ord) && !/status === 'delivered'/.test(ord));
  const osrc = read('src/lib/services/orderService.js');
  const block = osrc.slice(osrc.indexOf('if (isFakeOrder && data.status !== undefined) {'), osrc.indexOf('return mapOrder(order);', osrc.indexOf('if (isFakeOrder && data.status !== undefined) {')));
  ok('orderService: onRecruiterLinkedOrderSynced runs inside the fake-order branch, AFTER the awaited syncLinkedAffiliateOrderStatus (post-commit)',
    /await syncLinkedAffiliateOrderStatus\(id, data\.status\)\.catch\(/.test(block) && block.indexOf('await syncLinkedAffiliateOrderStatus(') < block.indexOf('await onRecruiterLinkedOrderSynced(String(id));') && block.includes('await onRecruiterLinkedOrderSynced(String(id));'));
  const hk = stripJs(read('src/lib/recruiterRewardHooks.js'));
  ok('the linked-order hook reads only { affiliateId } of the REAL rows of that store order (isFake: false) and writes nothing', /affiliateOrder\.findMany\(\{ where: \{ orderId, isFake: false \}, select: \{ affiliateId: true \} \}\)/.test(hk) && !/\.(create|update|upsert|delete)/.test(hk));
}

// ── 13. migration / schema (static) ─────────────────────────────────────────────
console.log('\n13. Migration 20261110 and schema (static)');
{
  const sql = read('prisma/migrations/20261110_recruiter_reward_cycles/migration.sql');
  const code = sql.replace(/--.*$/gm, '');
  ok('cycle: added NOT NULL with the default 1 (metadata only for the existing rows), then the default dropped', /ADD COLUMN IF NOT EXISTS "cycle" INTEGER NOT NULL DEFAULT 1;/.test(code) && /ALTER COLUMN "cycle" DROP DEFAULT;/.test(code));
  ok('no UPDATE / DELETE / TRUNCATE / DROP TABLE / DROP COLUMN (append-only, additive)', !/\bUPDATE\s+"|\bDELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|COLUMN)/i.test(code));
  ok('the cycle-key CHECK (NOT VALID then VALIDATE): versioned keys, legacy keys for cycle 1 only', /"recruiter_reward_ledger_cycle_check"/.test(code) && /'recruit:' \|\| "affiliateId" \|\| ':v' \|\| "cycle"/.test(code) && /'reverse:' \|\| "affiliateId" \|\| ':v' \|\| "cycle"/.test(code)
    && /"cycle" = 1 AND "idempotencyKey" = 'recruit:' \|\| "affiliateId"/.test(code) && /"cycle" = 1 AND "idempotencyKey" = 'reverse:' \|\| "affiliateId"/.test(code) && /NOT VALID/.test(code) && /VALIDATE CONSTRAINT "recruiter_reward_ledger_cycle_check"/.test(code));
  ok('one reward / one reversal per (affiliate, cycle) replaces one per affiliate', /UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_recruit_per_cycle"\s+ON "recruiter_reward_ledger"\("affiliateId", "cycle"\) WHERE "type" = 'RECRUIT_REWARD'/.test(code)
    && /UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_reversal_per_cycle"\s+ON "recruiter_reward_ledger"\("affiliateId", "cycle"\) WHERE "type" = 'REVERSAL'/.test(code)
    && /DROP INDEX IF EXISTS "recruiter_reward_ledger_one_recruit_per_affiliate"/.test(code) && /DROP INDEX IF EXISTS "recruiter_reward_ledger_one_reversal_per_affiliate"/.test(code));
  ok('the cycle guard: BEFORE INSERT, under pg_advisory_xact_lock(hashtext(\'recruit:\' || affiliateId)) — the SAME key as the service lock', /PERFORM pg_advisory_xact_lock\(hashtext\('recruit:' \|\| NEW\."affiliateId"\)\)/.test(code)
    && /CREATE TRIGGER "recruiter_reward_ledger_cycle_guard" BEFORE INSERT ON "recruiter_reward_ledger"/.test(code) && /hashtext\(\$\{'recruit:' \+ affiliateId\}\)/.test(read('src/lib/services/recruiterRewardService.js')));
  ok('the guard checks: reward cycle = max + 1 with the previous cycle reversed; reversal = same-cycle reward, the latest cycle, same recruiter, −amount ≤ reward', /NEW\."cycle" <> max_reward \+ 1/.test(code) && /"type" = 'REVERSAL' AND "cycle" = max_reward/.test(code)
    && /open_amount IS NULL OR NEW\."cycle" <> max_reward OR open_recr <> NEW\."recruiterId" OR -NEW\."amountCents" > open_amount/.test(code) && /ERRCODE = 'check_violation'/.test(code));
  ok('the old reversal guard is dropped and the migration is re-runnable (IF EXISTS / IF NOT EXISTS / duplicate_object / CREATE OR REPLACE)', /DROP TRIGGER IF EXISTS "recruiter_reward_ledger_reversal_guard"/.test(code) && /DROP FUNCTION IF EXISTS recruiter_reward_reversal_guard\(\)/.test(code)
    && /EXCEPTION WHEN duplicate_object THEN NULL/.test(code) && /CREATE OR REPLACE FUNCTION recruiter_reward_cycle_guard\(\)/.test(code) && /DROP TRIGGER IF EXISTS "recruiter_reward_ledger_cycle_guard"/.test(code));
  ok('the migration touches recruiter_reward_ledger only', [...code.matchAll(/\b(?:ALTER TABLE|ON|INTO|FROM)\s+"([a-z_]+)"/g)].every((m) => m[1] === 'recruiter_reward_ledger'));
  const model = read('prisma/schema.prisma').match(/model RecruiterRewardLedger \{[\s\S]*?\n\}/)?.[0] ?? '';
  ok('schema: RecruiterRewardLedger.cycle Int (required, no default)', /\n\s+cycle\s+Int\s*\n/.test(model) && !/cycle\s+Int[^\n]*@default/.test(model));
  ok('settings: recruitRewardCycleKey / reversalCycleKey', SET.recruitRewardCycleKey('x', 4) === 'recruit:x:v4' && SET.reversalCycleKey('x', 4) === 'reverse:x:v4');
}

// ── 14. Phase 6 part 5d: reconcile candidates vs the authoritative sync ──────────
console.log('\n14. Phase 6 part 5d: candidate thresholds (the reward\'s version, legacy → 10) and agreement with syncRecruiterReward');
{
  // Stage F: a recruiter-scoped (wallet) run uses recruiter-reward-network-candidates (the roots of N(R)) — the same rows
  const isCand = (sql) => /^\s*\/\* recruiter-reward-(network-)?candidates \*\//.test(sql ?? '');
  // The candidate rows of each reconcile run (captured from the statement the service runs on db).
  const spy = (raw) => {
    const seen = [];
    const db = new Proxy(raw, {
      get(t, p) {
        if (p !== '$queryRaw') return t[p];
        return async (strings, ...values) => { const rows = await t.$queryRaw(strings, ...values); if (isCand(Array.isArray(strings) ? strings.join('') : '')) seen.push(rows); return rows; };
      },
    });
    return { db, seen };
  };
  const candOf = async (E, a) => {
    const S = spy(E.db);
    await RS.reconcileRecruiterRewards({ db: S.db, now: T0, recruiterId: E.A.id, batchSize: 1000 }).catch(() => null);
    return S.seen.flat().filter((r) => r.kind !== 'batch' && r.id === a.id).map((r) => r.kind);
  };
  // Candidates only, nothing written: a recruiter-scoped run (no lease) through a db that refuses every
  // transaction, so the statement runs and the first sync stops the run before any write.
  const probe = async (E, a) => {
    const S = spy(E.db);
    const noTx = new Proxy(S.db, { get(t, p) { return p === '$transaction' ? () => Promise.reject(new Error('probe: no sync')) : t[p]; } });
    const before = E.db._tables.recruiterRewardLedger.length;
    await RS.reconcileRecruiterRewards({ db: noTx, now: T0, recruiterId: E.A.id }).catch(() => null);
    if (E.db._tables.recruiterRewardLedger.length !== before || S.seen.length !== 1) throw new Error('probe wrote or ran no candidates statement');
    return S.seen.flat().filter((r) => r.kind !== 'batch' && r.id === a.id).map((r) => r.kind);
  };
  /** Alternating cycles 1..n, every reversal = −its reward (same cycle, same recruiter). */
  const alternating = (db, affiliateId) => {
    let cycle = 1, type = 'RECRUIT_REWARD', open = null;
    for (const r of ledger(db, { affiliateId })) {
      if (r.type !== type || r.cycle !== cycle) return false;
      if (r.type === 'RECRUIT_REWARD') { open = r; type = 'REVERSAL'; } else { if (r.amountCents !== -open.amountCents || r.recruiterId !== open.recruiterId) return false; type = 'RECRUIT_REWARD'; cycle += 1; }
    }
    return true;
  };

  // a) the reward's OWN version threshold: v1 = 5, current v2 = 50
  for (const [count, expectReversal] of [[10, false], [5, false], [4, true], [3, true]]) {
    const E = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 5 } });
    const { a, os } = qualified(E.db, E.A, 10);
    await sync(E, a);
    E.db._seed.settings({ version: 2, enabled: true, rewardAmountCents: 20000, minDeliveredSales: 50 });
    for (const o of os.slice(count)) E.db._tables.affiliateOrder.find((x) => x.id === o.id).status = 'cancelled';
    const kinds = await probe(E, a);
    const r = await RS.reconcileRecruiterRewards({ db: E.db, now: T0 });
    const rev = ledger(E.db, { affiliateId: a.id, type: 'REVERSAL' });
    ok(`reward earned under v1 (threshold 5), current v2 threshold 50, ${count} delivered → ${expectReversal ? 'reversal candidate, REVERSED (−15000, v1)' : 'NOT a candidate (never judged on 50), nothing written'}`,
      eq(kinds, expectReversal ? ['reversal'] : []) && r.reversed === (expectReversal ? 1 : 0) && r.candidates === (expectReversal ? 1 : 0) && rev.length === (expectReversal ? 1 : 0)
      && (!expectReversal || (rev[0].amountCents === -15000 && rev[0].settingsVersion === 1)), big({ kinds, r }));
  }

  // b) legacy / NULL / unknown / out-of-range settings version → the default threshold 10 (as thresholdOfVersion)
  const legacyCases = [
    ['legacy cycle-1 reward with settingsVersion NULL', { settingsVersion: null, idempotencyKey: (id) => `recruit:${id}` }, null],
    ['settingsVersion 0', { settingsVersion: 0 }, null],
    ['settingsVersion 99 (no such version row)', { settingsVersion: 99 }, null],
    ['version 2 stored with an out-of-range threshold 0', { settingsVersion: 2 }, { version: 2, enabled: true, rewardAmountCents: 100, minDeliveredSales: 0 }],
    ['version 2 stored with threshold 100001 (above the range)', { settingsVersion: 2 }, { version: 2, enabled: true, rewardAmountCents: 100, minDeliveredSales: 100001 }],
  ];
  for (const [label, row, badVersion] of legacyCases) {
    const res = [];
    for (const count of [10, 9]) {
      const E = setup({ settings: { version: 1, enabled: false, rewardAmountCents: 0, minDeliveredSales: 3 } });
      if (badVersion) E.db._seed.settings(badVersion);
      const a = aff(E.db, E.A); orders(E.db, a, count); identity(E.db, a);
      E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: 5000, settingsVersion: row.settingsVersion, idempotencyKey: (row.idempotencyKey ?? ((id) => `recruit:${id}:v1`))(a.id) });
      const kinds = await probe(E, a);
      const s = await sync(E, a);
      res.push([count, kinds, s.action]);
    }
    ok(`${label} → threshold 10 like thresholdOfVersion: 10 delivered → no candidate and the sync agrees (NO_CHANGE); 9 → reversal candidate and the sync REVERSES`,
      eq(res, [[10, [], 'NO_CHANGE'], [9, ['reversal'], 'REVERSED']]), big(res));
  }

  // c) candidate verdicts agree with syncRecruiterReward across cycles (award → reverse → re-award …), random walk
  let s = 0x5d5d;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const disagreements = [];
  const seenKinds = { award: 0, reversal: 0, none: 0 };
  let maxCycle = 0;
  for (let run = 0; run < 6; run++) {
    const E = setup({ settings: { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 4 } });
    const affs = [];
    for (let i = 0; i < 6; i++) { const a = aff(E.db, E.A); orders(E.db, a, Math.floor(rnd() * 8)); if (rnd() < 0.85) identity(E.db, a); affs.push(a); }
    for (let step = 0; step < 25; step++) {
      // random change: (re)deliver / cancel orders, new orders, sometimes a new settings version or rewards OFF / ON
      for (const o of E.db._tables.affiliateOrder) if (rnd() < 0.12) o.status = o.status === 'delivered' ? 'cancelled' : 'delivered';
      if (rnd() < 0.2) orders(E.db, affs[Math.floor(rnd() * affs.length)], 1 + Math.floor(rnd() * 3));
      if (rnd() < 0.12) {
        const v = E.db._tables.recruiterSettingsVersion.length + 1;
        const on = rnd() < 0.7;
        E.db._seed.settings({ version: v, enabled: on, rewardAmountCents: on ? (1 + Math.floor(rnd() * 200)) * 100 : 0, minDeliveredSales: 1 + Math.floor(rnd() * 8) });
      }
      for (const a of affs) {
        const kinds = await probe(E, a);
        const approved = E.db._tables.identityVerification.some((v) => v.affiliateId === a.id && v.status === 'APPROVED');
        const r = await sync(E, a);
        const expected = kinds.includes('reversal') ? 'REVERSED' : kinds.includes('award') && approved ? 'AWARDED' : null;
        const wrote = ['AWARDED', 'REVERSED'].includes(r.action);
        if ((expected && r.action !== expected) || (!expected && wrote) || kinds.length > 1) disagreements.push(`${run}/${step}: ${kinds} approved=${approved} → ${r.action}`);
        seenKinds[kinds[0] ?? 'none'] += 1;
        maxCycle = Math.max(maxCycle, r.cycle ?? 0);
      }
    }
    if (!affs.every((a) => alternating(E.db, a.id))) disagreements.push(`run ${run}: ledger not alternating / reversal ≠ −reward`);
  }
  ok('random walk (6 networks × 25 steps × 6 affiliates, order changes, new versions, rewards OFF / ON): the candidate verdict ALWAYS matches the authoritative sync (reversal ⇔ REVERSED, approved award ⇔ AWARDED, none ⇔ no write)',
    disagreements.length === 0, disagreements.slice(0, 4).join(' | '));
  ok(`…not vacuous: award, reversal and no-candidate verdicts all occurred and cycles went up to ${maxCycle}`, seenKinds.award > 10 && seenKinds.reversal > 10 && seenKinds.none > 10 && maxCycle >= 3, big({ seenKinds, maxCycle }));

  // d) the same cycles end to end through reconcile only: award → reverse → re-award
  const E = setup();
  const { a, os } = qualified(E.db, E.A);
  const shape = () => ledger(E.db, { affiliateId: a.id }).map((r) => `${r.type === 'REVERSAL' ? 'V' : 'R'}${r.cycle}`).join();
  const steps = [];
  steps.push([await candOf(E, a), shape()]);
  E.db._tables.affiliateOrder.find((o) => o.id === os[0].id).status = 'cancelled';
  steps.push([await candOf(E, a), shape()]);
  steps.push([await candOf(E, a), shape()]);
  E.db._tables.affiliateOrder.find((o) => o.id === os[0].id).status = 'delivered';
  steps.push([await candOf(E, a), shape()]);
  steps.push([await candOf(E, a), shape()]);
  ok('reconcile alone drives the cycles: award (R1) → cancel → reversal (V1) → nothing → re-delivery → award cycle 2 (R2) → nothing; reversal = −reward',
    eq(steps, [[['award'], 'R1'], [['reversal'], 'R1,V1'], [[], 'R1,V1'], [['award'], 'R1,V1,R2'], [[], 'R1,V1,R2']]) && alternating(E.db, a.id) && consistent(E.db, a.id), big(steps));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
