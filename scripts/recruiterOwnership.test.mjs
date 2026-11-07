#!/usr/bin/env node
/**
 * scripts/recruiterOwnership.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 7 Stage E: the approved OWNERSHIP rule; Phase 7 Stage F (approved
 * clarification, the pins changed here are marked "Stage F"): the TOPMOST link wins.
 *   owner(X) = the recruiter of the TOPMOST linked affiliate of X's chain (X, its parent, grandparent…
 *   through affiliates.parentId, up to the top) — one owner or none. A nested (legacy) link to another
 *   recruiter inside an owned network never transfers ownership; a parent cycle is owned by the one
 *   recruiter of every link met on it, by nobody (a reported conflict) when there are several.
 *   N(R) = { X : owner(X) = R }, unlimited depth. Reward A is awarded to owner(X) for every X in N(R)
 *   (X's OWN real delivered orders + identity APPROVED); Reward B counts the distinct qualified X in
 *   N(R). The tree, statistics, list and progress show N(R) — never another recruiter's affiliates.
 * In-memory fake database only (scripts/lib/recruiterFakeDb.mjs, phase5 — every tagged statement
 * emulated from its own SQL behind exact drift guards; the 20261112 ownership link guard emulated).
 * Proves:
 *   • the 4-level chain example (A recruits 1 → 2 → 3 → 4): all four in A's network; each one's 10
 *     sales award A one Reward A; 10 qualified spread across depths award A one Reward B
 *   • direct, 2 levels, 10 levels, a 320-deep chain (Reward A and Reward B across it); admin-created
 *     (unlinked) descendants owned by the ancestor's recruiter; Stage F: a nested legacy link to B under
 *     A's network stays A's with its subtree (B sees nothing, earns nothing; legacy B rows stay
 *     reversible), B can never create under A's network, the conflict is reported and never reassigned;
 *     self-parents and parent cycles never loop; an ambiguous cycle (A and B) has no owner and is a
 *     reported conflict; unrelated affiliates
 *   • canViewOrders off → no order count anywhere, zero affiliate_orders statements (tree / stats / list)
 *   • Reward A for an invited member: 9 / 10 / 11, fake, returned, refused, cancelled, re-delivery,
 *     concurrent qualification, duplicate reconciliation
 *   • Reward B: 9 / 10 / 11 distinct, one member with 20 sales counts once, mixed eligible /
 *     ineligible, spread across depths, reversal dropping below, requalification, concurrent syncs,
 *     duplicate reconciliation
 *   • exactly one owner per affiliate (random forests, brute-force oracle), no duplicate ledger row
 *   • the (emulated) DB ledger link guard accepts the owner and rejects a non-owner recruiter; the
 *     (emulated) Stage F link owner guard refuses a link to B for a child of A's member
 *   • hooks and the reconcile (wallet scope = N(R), admin scope = every owned affiliate once)
 * Run: node scripts/recruiterOwnership.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-ownership-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const RS = await import('../src/lib/services/recruiterRewardService.js');
const NS = await import('../src/lib/services/recruiterNetworkService.js');
const AS = await import('../src/lib/services/recruiterAffiliateService.js');
const PS = await import('../src/lib/services/recruiterProgressService.js');
const HK = await import('../src/lib/recruiterRewardHooks.js');
const { recruiterNetworkHandlers } = await import('../src/lib/recruiterNetworkRouteHandlers.js');
const { recruiterAffiliateHandlers } = await import('../src/lib/recruiterAffiliateRouteHandlers.js');
const { recruiterProgressHandlers } = await import('../src/lib/recruiterProgressHandlers.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const big = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));

const T0 = new Date('2026-11-06T10:00:00.000Z');
const noLimit = () => null;
// Reward A: 15 MAD at 10 real delivered; Reward B: 500 MAD per 10 qualified (10 real delivered + APPROVED).
const BOTH_ON = { version: 1, enabled: true, rewardAmountCents: 1500, minDeliveredSales: 10, groupEnabled: true, groupRewardAmountCents: 50000, groupSize: 10, groupMinDeliveredSales: 10 };

let uniq = 0;
function setup({ settings = BOTH_ON, hooks } = {}) {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ phase5: true, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : hooks?.before?.(m, o, a)) } });
  const A = db._seed.recruiter({ username: 'own.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'own.b', name: 'Recruteur B' });
  if (settings) db._seed.settings(settings);
  const nh = recruiterNetworkHandlers({ db, rateLimit: noLimit });
  const ah = recruiterAffiliateHandlers({ db, rateLimit: noLimit, now: () => new Date(T0) });
  const ph = recruiterProgressHandlers({ db, rateLimit: noLimit });
  return { db, A, B, hookBox, nodesH: withRecruiterAuth(nh.nodes), statsH: withRecruiterAuth(nh.stats), listH: withRecruiterAuth(ah.affiliates), progressH: withRecruiterAuth(ph.summary) };
}
/** An affiliate under `parentId`, linked to `rec` when given (null = admin- / app-created child: no link). */
function aff(E, rec, parentId = null, extra = {}) {
  uniq += 1;
  const a = E.db._seed.affiliate({ username: `own${uniq}`, name: `Affilié ${uniq}`, isActive: true, parentId, createdAt: new Date(T0.getTime() + uniq * 1000), ...extra });
  if (rec) E.db._seed.link({ affiliateId: a.id, recruiterId: rec.id, createdAt: a.createdAt });
  return a;
}
const orders = (E, a, n, extra = {}) => Array.from({ length: n }, () => E.db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: false, ...extra }));
const identity = (E, a, status = 'APPROVED') => E.db._seed.identity({ affiliateId: a.id, status });
const ledger = (E, where = {}) => E.db._tables.recruiterRewardLedger.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
const groupRows = (E, rec) => ledger(E, { recruiterId: rec.id }).filter((r) => r.type === 'GROUP_REWARD' || r.type === 'GROUP_REVERSAL');
const activeGroup = (E, rec) => { const g = groupRows(E, rec); const rev = new Set(g.filter((r) => r.type === 'GROUP_REVERSAL').map((r) => r.cycle)); return g.filter((r) => r.type === 'GROUP_REWARD' && !rev.has(r.cycle)).length; };
const sync = (E, a) => RS.syncRecruiterReward(a.id, { db: E.db, now: T0 });
const gsync = (E, rec) => RS.syncRecruiterGroupReward(rec.id, { db: E.db, now: T0 });
const setStatus = (E, o, status) => { E.db._tables.affiliateOrder.find((x) => x.id === o.id).status = status; };
const cookie = (rec) => `recruiter_token=${signToken({ recruiterId: rec.id, username: rec.username, type: 'recruiter' })}`;
const call = async (h, url, rec) => {
  const res = await h(new Request(`http://localhost${url}`, { method: 'GET', headers: { cookie: cookie(rec) } }), {});
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
};
const nodes = (E, rec, q = '') => call(E.nodesH, `/api/recruiter/network/nodes${q}`, rec);
const stats = (E, rec, q = '') => call(E.statsH, `/api/recruiter/network/stats${q}`, rec);
const list = (E, rec, q = '') => call(E.listH, `/api/recruiter/affiliates${q}`, rec);
const progress = (E, rec) => call(E.progressH, '/api/recruiter/progress', rec);
const NF = (r) => r.status === 404 && r.text === '{"code":"NOT_FOUND"}';
const noDupes = (E) => { const k = E.db._tables.recruiterRewardLedger.map((r) => r.idempotencyKey); return new Set(k).size === k.length; };

// ── 1. the 4-level chain example ────────────────────────────────────────────────
console.log('\n1. The product example: Recruiter A recruits Affiliate 1 → 2 → 3 → 4');
for (const variant of ['invited (1 linked to A, 2–4 created under it without a link)', 'all four linked to A']) {
  const E = setup();
  const linkAll = variant.startsWith('all');
  const a1 = aff(E, E.A);
  const a2 = aff(E, linkAll ? E.A : null, a1.id);
  const a3 = aff(E, linkAll ? E.A : null, a2.id);
  const a4 = aff(E, linkAll ? E.A : null, a3.id);
  const chainIds = [a1, a2, a3, a4].map((a) => a.id);
  const owners = await Promise.all(chainIds.map((id) => RS.findAffiliateOwner(id, { db: E.db })));
  ok(`[${variant}] owner(1…4) = A for all four`, owners.every((o) => o === E.A.id), big(owners));
  const st = (await stats(E, E.A)).body.stats;
  ok(`[${variant}] A's network: 4 affiliates on levels 1…4 (one per level)`, st.totals.affiliates === 4 && eq(st.levels.map((l) => [l.level, l.affiliates]), [[1, 1], [2, 1], [3, 1], [4, 1]]), big(st.totals));
  for (const a of [a1, a2, a3, a4]) { orders(E, a, 10); identity(E, a); }
  const res = [];
  for (const a of [a1, a2, a3, a4]) res.push((await sync(E, a)).action);
  const rewards = ledger(E, { type: 'RECRUIT_REWARD' });
  ok(`[${variant}] each one's 10 real delivered sales (+ APPROVED identity) award A one Reward A — 4 rewards, all to A, one per affiliate`,
    eq(res, ['AWARDED', 'AWARDED', 'AWARDED', 'AWARDED']) && rewards.length === 4 && rewards.every((r) => r.recruiterId === E.A.id && r.amountCents === 1500)
    && eq(rewards.map((r) => r.affiliateId).sort(), [...chainIds].sort()) && eq(rewards.map((r) => r.idempotencyKey).sort(), chainIds.map((id) => `recruit:${id}:v1`).sort()), big(res));
  // 6 more qualified members spread across depths (under 2, under 4, under 3…) → 10 qualified → ONE Reward B
  const extra = [aff(E, null, a2.id), aff(E, null, a4.id), aff(E, null, a4.id), aff(E, linkAll ? E.A : null, a3.id), aff(E, null, a1.id), aff(E, null, a2.id)];
  for (const a of extra) { orders(E, a, 10); identity(E, a); }
  const g = await gsync(E, E.A);
  ok(`[${variant}] 10 qualified members spread across depths 1…5 → A earns ONE Reward B (500 MAD), qualified = 10`,
    g.awarded === 1 && g.qualified === 10 && groupRows(E, E.A).length === 1 && groupRows(E, E.A)[0].amountCents === 50000 && groupRows(E, E.B).length === 0, big(g));
  const sum = (await progress(E, E.A)).body.progress;
  ok(`[${variant}] the summary agrees: network 10, qualifiedForGroup 10, 1 active group reward, rewards A = 4`,
    sum.downlineAffiliates === 10 && sum.qualifiedForGroup === 10 && sum.activeGroupRewards === 1 && sum.rewards.individual.awarded === 4, big(sum));
  ok(`[${variant}] B earns nothing; no duplicate ledger key`, ledger(E, { recruiterId: E.B.id }).length === 0 && noDupes(E));
}

// ── 2. direct / 2 / 10 / deep; admin-created descendants ─────────────────────────
console.log('\n2. Direct, 2 levels, 10 levels, a 320-deep chain; admin-created descendants belong to the ancestor\'s recruiter');
{
  const E = setup();
  const d = aff(E, E.A);
  ok('direct: owner = A', await RS.findAffiliateOwner(d.id, { db: E.db }) === E.A.id);
  const c = aff(E, null, d.id);
  ok('2 levels (admin-created child): owner = A, shown at level 2 (linkedToMe false)', await RS.findAffiliateOwner(c.id, { db: E.db }) === E.A.id
    && eq((await nodes(E, E.A, `?parentId=${d.id}`)).body.nodes.map((n) => [n.id, n.level, n.linkedToMe]), [[c.id, 2, false]]));
  let p = d.id; const ten = [d.id];
  for (let i = 1; i < 10; i++) { const x = aff(E, i % 3 === 0 ? E.A : null, p); ten.push(x.id); p = x.id; }
  ok('10 levels (mixed linked / admin-created): every one owned by A', (await Promise.all(ten.map((id) => RS.findAffiliateOwner(id, { db: E.db })))).every((o) => o === E.A.id));
  const D = setup();
  const top = aff(D, D.A); let q = top.id; const deep = [top.id];
  for (let i = 1; i < 320; i++) { const x = aff(D, null, q); deep.push(x.id); q = x.id; }
  const m0 = D.db._queryCount();
  const ownerDeep = await RS.findAffiliateOwner(q, { db: D.db });
  ok('a 320-deep chain of admin-created descendants: the deepest one\'s owner = A, ONE statement', ownerDeep === D.A.id && D.db._queryCount() - m0 === 1);
  orders(D, { id: q }, 10); identity(D, { id: q });
  const r = await RS.syncRecruiterReward(q, { db: D.db, now: T0 });
  ok('… its 10 sales award A a Reward A (the DB guard emulation walks 320 levels up and accepts A)', r.action === 'AWARDED' && ledger(D, { affiliateId: q })[0]?.recruiterId === D.A.id, big(r));
  const st = (await stats(D, D.A)).body.stats;
  ok('… stats: 320 affiliates on 320 levels; summary network 320', st.totals.affiliates === 320 && st.totals.maxLevel === 320 && (await progress(D, D.A)).body.progress.downlineAffiliates === 320);
  const rec = await RS.reconcileRecruiterRewards({ db: D.db, recruiterId: D.A.id, now: T0 });
  ok('… the wallet reconcile scans the whole segment (checked 320 = 1 link + 319 below), nothing new', rec.checked === 320 && rec.awarded === 0 && rec.batches === 1, big(rec));
  // Stage F: Reward B over the whole 320-deep chain — 9 more qualified members at depths 10 … 300 + the deepest one
  for (const depth of [10, 50, 100, 150, 200, 250, 280, 299, 300]) { orders(D, { id: deep[depth - 1] }, 10); identity(D, { id: deep[depth - 1] }); }
  const gDeep = await gsync(D, D.A);
  ok('Stage F: 10 qualified members spread over depths 10 … 320 of the chain → A earns ONE Reward B (qualified 10)', gDeep.awarded === 1 && gDeep.qualified === 10 && activeGroup(D, D.A) === 1, big(gDeep));
}

// ── 3. Stage F: a nested (legacy) link to B inside A's network stays A's ─────────────────
console.log('\n3. Stage F: a nested legacy link to B under A\'s network stays A\'s with its subtree — B sees nothing and earns nothing; B cannot create there; the conflict is reported, never reassigned');
{
  const E = setup();
  const a1 = aff(E, E.A); const a2 = aff(E, null, a1.id);
  const b1 = aff(E, E.B, a2.id); const b2 = aff(E, null, b1.id); const b3 = aff(E, null, b2.id); // b1: a legacy link to B (seeded: no trigger)
  const a3 = aff(E, E.A, b3.id); const a4 = aff(E, null, a3.id);
  const all = [a1, a2, b1, b2, b3, a3, a4];
  // legacy B reward row on b1 (earned under the former rule — never rewritten)
  orders(E, b1, 10); identity(E, b1);
  E.db._seed.ledger({ recruiterId: E.B.id, affiliateId: b1.id, type: 'RECRUIT_REWARD', amountCents: 1500, cycle: 1, settingsVersion: 1, idempotencyKey: `recruit:${b1.id}:v1`, reason: 'REAL_DELIVERED_AND_CIN_APPROVED' });
  const own = Object.fromEntries(await Promise.all(all.map(async (x) => [x.id, await RS.findAffiliateOwner(x.id, { db: E.db })])));
  ok('Stage F: owners — all seven (a1, a2, the nested B link b1, b2, b3, a3, a4) → A (the topmost link)', all.every((x) => own[x.id] === E.A.id), big(own));
  for (const x of [a1, a2, b2, b3, a3, a4]) { orders(E, x, 10); identity(E, x); }
  const res = [];
  for (const x of all) res.push((await sync(E, x)).action);
  ok('Stage F: Reward A — a1, a2, b2, b3, a3, a4 → A; b1 keeps its legacy B reward (open, NO_CHANGE) and gets no second one; nothing new for B',
    eq(ledger(E, { recruiterId: E.A.id }).map((r) => r.affiliateId).sort(), [a1, a2, b2, b3, a3, a4].map((x) => x.id).sort())
    && ledger(E, { recruiterId: E.B.id }).length === 1 && res[2] === 'NO_CHANGE' && noDupes(E), big(res));
  // the legacy B reward stays reversible by B; the requalification afterwards goes to A
  setStatus(E, E.db._tables.affiliateOrder.find((o) => o.affiliateId === b1.id), 'cancelled');
  const rvB = await sync(E, b1);
  ok('Stage F: b1 drops to 9 → its legacy B reward is REVERSED by B (the guard accepts the reward holder\'s reversal)', rvB.action === 'REVERSED' && ledger(E, { affiliateId: b1.id, type: 'REVERSAL' })[0]?.recruiterId === E.B.id, big(rvB));
  orders(E, b1, 1);
  const rq = await sync(E, b1);
  ok('Stage F: b1 back to 10 → the new cycle 2 goes to A (its owner), never to B', rq.action === 'AWARDED' && rq.cycle === 2 && ledger(E, { affiliateId: b1.id, type: 'RECRUIT_REWARD', cycle: 2 })[0]?.recruiterId === E.A.id, big(rq));
  const allB = JSON.stringify([(await nodes(E, E.B)).body, (await stats(E, E.B)).body, (await list(E, E.B)).body, (await progress(E, E.B)).body]);
  ok('Stage F: B sees nothing — empty roots / stats / list, progress network 0 (its legacy link is not shown), no id of A\'s network',
    (await nodes(E, E.B)).body.total === 0 && (await stats(E, E.B)).body.stats.totals.affiliates === 0 && (await list(E, E.B)).body.total === 0
    && (await progress(E, E.B)).body.progress.downlineAffiliates === 0 && all.every((x) => !allB.includes(x.id)), allB.slice(0, 200));
  ok('Stage F: B with any of them as parentId / rootId → NOT_FOUND (b1 included)', NF(await nodes(E, E.B, `?parentId=${b1.id}`)) && NF(await stats(E, E.B, `?rootId=${b2.id}`)) && NF(await nodes(E, E.B, `?parentId=${a2.id}`)));
  const sa = (await stats(E, E.A)).body.stats;
  ok('Stage F: A\'s tree — ONE root (a1), 7 affiliates on levels 1 … 7; a2\'s child is b1 (linkedToMe false), b3\'s child a3 (linkedToMe true)',
    eq((await nodes(E, E.A)).body.nodes.map((n) => n.id), [a1.id]) && sa.totals.affiliates === 7 && sa.totals.maxLevel === 7
    && eq((await nodes(E, E.A, `?parentId=${a2.id}`)).body.nodes.map((n) => [n.id, n.level, n.linkedToMe]), [[b1.id, 3, false]])
    && eq((await nodes(E, E.A, `?parentId=${b3.id}`)).body.nodes.map((n) => [n.id, n.level, n.linkedToMe]), [[a3.id, 6, true]]), big(sa.totals));
  ok('Stage F: A\'s list shows all 7 (b1 with its parent a2), progress network 7', (await list(E, E.A)).body.total === 7 && (await progress(E, E.A)).body.progress.downlineAffiliates === 7);
  const gA = await gsync(E, E.A); const gB = await gsync(E, E.B);
  ok('Stage F: group counts — A qualified 7 (distinct, across depths 1 … 7), B 0', gA.qualified === 7 && gB.qualified === 0, big([gA, gB]));
  // creation: B can never create under A's network (not even below its own legacy link); A can, and the new affiliate is linked to A
  const mk = (rec, parentId) => AS.recruiterCreateAffiliate(rec.id, { username: `own.new${++uniq}`, name: 'Nouveau', requestId: crypto.randomUUID(), parentId }, { db: E.db, now: T0 })
    .then((r) => r.row.id, (e) => e.code);
  const bTries = [await mk(E.B, a2.id), await mk(E.B, b1.id), await mk(E.B, b3.id), await mk(E.B, a4.id)];
  ok('Stage F: B creating under A\'s members (a2, its own legacy b1, b3, a4) → PARENT_NOT_IN_NETWORK each time, nothing written', bTries.every((c) => c === 'PARENT_NOT_IN_NETWORK'), big(bTries));
  const made = await mk(E.A, b2.id);
  ok('Stage F: A creating under b2 (below the nested B link) → created, linked to A, owner A', typeof made === 'string' && E.db._tables.recruiterAffiliateLink.find((l) => l.affiliateId === made)?.recruiterId === E.A.id
    && await RS.findAffiliateOwner(made, { db: E.db }) === E.A.id, made);
  // the conflict is detected, reported (ids and counts only) and never reassigned
  const linksBefore = JSON.stringify(E.db._tables.recruiterAffiliateLink);
  const conf = await RS.listRecruiterOwnershipConflicts({ db: E.db });
  ok('Stage F: listRecruiterOwnershipConflicts reports b1 as NESTED (total 1, ids and kind only); the links are unchanged',
    eq(conf, { total: 1, nested: 1, ambiguous: 0, items: [{ affiliateId: b1.id, kind: 'NESTED' }], truncated: false }) && JSON.stringify(E.db._tables.recruiterAffiliateLink) === linksBefore, big(conf));
}

// ── 4. cycles, self-parents, unrelated affiliates ─────────────────────────────────
console.log('\n4. Self-parents and cycles without a link have no owner and never loop; unrelated affiliates');
{
  const E = setup();
  const set = (a, p) => { E.db._tables.affiliate.find((x) => x.id === a.id).parentId = p; };
  const self = aff(E, null); set(self, self.id);
  const u1 = aff(E, null); const u2 = aff(E, null, u1.id); set(u1, u2.id);
  const tail = aff(E, null, u2.id);
  const loose = aff(E, null);
  const linkedSelf = aff(E, E.A); set(linkedSelf, linkedSelf.id);
  const l1 = aff(E, E.A); const l2 = aff(E, null, l1.id); set(l1, l2.id); // a cycle THROUGH one of A's links
  for (const x of [self, u1, u2, tail, loose, l1, l2, linkedSelf]) { orders(E, x, 12); identity(E, x); }
  const own = await Promise.all([self, u1, u2, tail, loose, linkedSelf, l1, l2].map((x) => RS.findAffiliateOwner(x.id, { db: E.db })));
  ok('no owner: an unlinked self-parent, an unlinked 2-cycle, a tail below it, an unrelated affiliate; owner A: a linked self-parent and both members of a cycle through A\'s link',
    eq(own, [null, null, null, null, null, E.A.id, E.A.id, E.A.id]), big(own));
  const res = [];
  for (const x of [self, u1, u2, tail, loose]) res.push((await sync(E, x)).action);
  ok('Reward A sync of the unowned ones → NOT_LINKED, nothing written, no lock taken (no RECRUIT row)', res.every((r) => r === 'NOT_LINKED') && ledger(E).length === 0, big(res));
  const g = await gsync(E, E.A);
  ok('group: A\'s qualified = its 3 owned (linked self-parent, l1, l2 — the cycle members are owned, only unplaced in the tree); unowned never counted', g.qualified === 3, big(g));
  const st = (await stats(E, E.A)).body.stats;
  ok('the tree on cyclic data: nothing placed, the 2 linked cycle members unplaced (no loop)', st.totals.affiliates === 0 && st.totals.unplaced === 2, big(st.totals));
  ok('the unowned affiliates are NOT_FOUND for A and B', [self, u1, tail, loose].every(Boolean) && NF(await nodes(E, E.A, `?parentId=${u1.id}`)) && NF(await nodes(E, E.B, `?parentId=${tail.id}`)));
  // Stage F: an AMBIGUOUS cycle (A's m1 ↔ B's m2) and a tail below it → no owner, a reported conflict, never assigned
  const m1 = aff(E, E.A); const m2 = aff(E, E.B, m1.id); set(m1, m2.id); const mt = aff(E, null, m2.id);
  for (const x of [m1, m2, mt]) { orders(E, x, 12); identity(E, x); }
  const ownM = await Promise.all([m1, m2, mt].map((x) => RS.findAffiliateOwner(x.id, { db: E.db })));
  const resM = [];
  for (const x of [m1, m2, mt]) resM.push((await sync(E, x)).action);
  const conf = await RS.listRecruiterOwnershipConflicts({ db: E.db });
  ok('Stage F: an ambiguous cycle (A\'s m1 ↔ B\'s m2) and its tail → no owner (NOT_LINKED, nothing written); both links reported as AMBIGUOUS_CYCLE; A\'s group still 3, B\'s 0',
    eq(ownM, [null, null, null]) && resM.every((r) => r === 'NOT_LINKED') && ledger(E).length === 0
    && eq(conf.items.filter((i) => i.kind === 'AMBIGUOUS_CYCLE').map((i) => i.affiliateId).sort(), [m1.id, m2.id].sort()) && conf.ambiguous === 2 && conf.nested === 0
    && (await gsync(E, E.A)).qualified === 3 && (await gsync(E, E.B)).qualified === 0, big({ ownM, resM, conf }));
  ok('Stage F: …the cycle members stay outside both networks (A unplaced still 2, B nothing)', (await stats(E, E.A)).body.stats.totals.unplaced === 2 && (await stats(E, E.B)).body.stats.totals.unplaced === 0
    && (await progress(E, E.B)).body.progress.downlineAffiliates === 0);
}

// ── 5. canViewOrders off ────────────────────────────────────────────────────────
console.log('\n5. canViewOrders off: no count, zero statements over affiliate_orders (tree, stats, list)');
{
  const E = setup();
  const NO = E.db._seed.recruiter({ username: 'own.noorders', name: 'Sans commandes', canViewOrders: false });
  const r = aff(E, NO); const c = aff(E, null, r.id); const g = aff(E, null, c.id);
  for (const x of [r, c, g]) orders(E, x, 11);
  const views = [['roots', () => nodes(E, NO)], ['children', () => nodes(E, NO, `?parentId=${r.id}`)], ['grandchildren', () => nodes(E, NO, `?parentId=${c.id}`)],
    ['stats', () => stats(E, NO)], ['sub stats', () => stats(E, NO, `?rootId=${c.id}`)], ['list', () => list(E, NO)]];
  for (const [k, f] of views) {
    const m = E.db._log.length;
    const out = await f();
    const os = E.db._log.slice(m).filter((l) => l.model === 'affiliateOrder' || (l.model === '$queryRaw' && /affiliate_orders/.test(l.sql ?? '')));
    ok(`canViewOrders off → ${k}: 200, no order count / delivered value, ZERO affiliate_orders statements (invited members included)`,
      out.status === 200 && os.length === 0 && !/"realDelivered":\d|"delivered":\d/.test(out.text), `${os.length} ${out.text.slice(0, 160)}`);
  }
}

// ── 6. Reward A for an invited member ───────────────────────────────────────────
console.log('\n6. Reward A for an invited (admin-created, depth 3) member: 9 / 10 / 11, fake, returned, refused, cancelled, re-delivery, concurrency, reconcile');
{
  const E = setup();
  const top = aff(E, E.A); const mid = aff(E, null, top.id); const x = aff(E, null, mid.id);
  identity(E, x);
  const nine = orders(E, x, 9);
  orders(E, x, 5, { isFake: true }); orders(E, x, 2, { status: 'returned' }); orders(E, x, 2, { status: 'refused' }); orders(E, x, 2, { status: 'cancelled' }); orders(E, x, 2, { status: 'Delivered' });
  ok('9 real delivered (+ fake / returned / refused / cancelled / "Delivered") → NOT_QUALIFIED', (await sync(E, x)).action === 'NOT_QUALIFIED' && ledger(E).length === 0);
  const tenth = orders(E, x, 1)[0];
  const r10 = await sync(E, x);
  ok('the 10th → AWARDED to A (the owner two levels up), key recruit:<id>:v1', r10.action === 'AWARDED' && ledger(E, { affiliateId: x.id })[0]?.recruiterId === E.A.id && ledger(E, { affiliateId: x.id })[0]?.idempotencyKey === `recruit:${x.id}:v1`);
  orders(E, x, 1);
  ok('11 → NO_CHANGE (one reward per cycle)', (await sync(E, x)).action === 'NO_CHANGE' && ledger(E).length === 1);
  setStatus(E, tenth, 'cancelled'); setStatus(E, nine[0], 'returned');
  const rv = await sync(E, x);
  ok('two cancelled / returned → 9 → REVERSED (−1500, same recruiter A, reverse:<id>:v1)', rv.action === 'REVERSED' && ledger(E, { type: 'REVERSAL' })[0]?.amountCents === -1500 && ledger(E, { type: 'REVERSAL' })[0]?.recruiterId === E.A.id);
  setStatus(E, tenth, 'delivered');
  ok('re-delivery → 10 again → cycle 2 AWARDED to A', (await sync(E, x)).cycle === 2 && ledger(E, { affiliateId: x.id, type: 'RECRUIT_REWARD' }).length === 2);
  const C = setup(); const ct = aff(C, C.A); const cx = aff(C, null, ct.id); identity(C, cx); orders(C, cx, 10);
  const conc = await Promise.all(Array.from({ length: 8 }, () => RS.syncRecruiterReward(cx.id, { db: C.db, now: T0 })));
  ok('8 concurrent syncs of a newly qualified invited member → exactly ONE reward (to A), the others NO_CHANGE', conc.filter((r) => r.action === 'AWARDED').length === 1 && ledger(C).length === 1 && ledger(C)[0].recruiterId === C.A.id, big(conc));
  const rec1 = await RS.reconcileRecruiterRewards({ db: C.db, now: T0 });
  const rec2 = await Promise.all([RS.reconcileRecruiterRewards({ db: C.db, recruiterId: C.A.id, now: T0 }), RS.reconcileRecruiterRewards({ db: C.db, recruiterId: C.A.id, now: T0 })]);
  ok('duplicate reconciliations (admin + 2 concurrent wallet scopes) → nothing new, no duplicate key; the invited member is scanned (checked 2)', rec1.awarded === 0 && rec2.every((r) => r.awarded === 0 && r.checked === 2) && ledger(C).length === 1 && noDupes(C), big([rec1, rec2]));
  const R = setup(); const rt = aff(R, R.A); const rx = aff(R, null, rt.id); identity(R, rx); orders(R, rx, 10);
  const viaRec = await RS.reconcileRecruiterRewards({ db: R.db, recruiterId: R.A.id, now: T0 });
  ok('a qualified invited member never synced before is AWARDED by the wallet reconcile (its segment is scanned)', viaRec.awarded === 1 && viaRec.checked === 2 && ledger(R)[0]?.affiliateId === rx.id, big(viaRec));
}

// ── 7. Reward B over N(R) ─────────────────────────────────────────────────────────
console.log('\n7. Reward B over N(R): 9 / 10 / 11 distinct, 20 sales count once, mixed, depths, reversal, requalification, concurrency, reconcile');
{
  const E = setup({ settings: { ...BOTH_ON, enabled: false, rewardAmountCents: 0 } });
  const root = aff(E, E.A);
  let p = root.id; const members = [];
  for (let i = 0; i < 11; i++) { const x = aff(E, i % 4 === 0 ? E.A : null, i % 2 ? p : root.id); members.push(x); p = x.id; }
  const big20 = members[0]; orders(E, big20, 20); identity(E, big20);
  for (const x of members.slice(1, 8)) { orders(E, x, 10); identity(E, x); }
  // ineligible: KYC pending, fake orders, cancelled, an unrelated affiliate. Stage F: a nested (legacy) link to B below
  // A's root is A's member — qualified, it counts for A (big20 + 7 + bUnder = 9)
  const pend = aff(E, null, root.id); orders(E, pend, 10); identity(E, pend, 'PENDING');
  const fake = aff(E, null, root.id); orders(E, fake, 10, { isFake: true }); identity(E, fake);
  const canc = aff(E, null, root.id); orders(E, canc, 10, { status: 'cancelled' }); identity(E, canc);
  const bUnder = aff(E, E.B, root.id); orders(E, bUnder, 10); identity(E, bUnder);
  const unrelated = aff(E, null); orders(E, unrelated, 10); identity(E, unrelated);
  const g9 = await gsync(E, E.A);
  ok('Stage F: 9 distinct qualified (one with 20 sales counted ONCE, the nested B link counted for A; KYC pending, fake, cancelled and an unrelated one excluded) → no group reward', g9.qualified === 9 && g9.awarded === 0, big(g9));
  const tenth = members[9]; const os10 = orders(E, tenth, 10); identity(E, tenth);
  const g10 = await gsync(E, E.A);
  ok('the 10th (deep in the chain) → exactly ONE Reward B (cycle 1)', g10.qualified === 10 && g10.awarded === 1 && activeGroup(E, E.A) === 1, big(g10));
  orders(E, members[10], 10); identity(E, members[10]);
  const g11 = await gsync(E, E.A);
  ok('11 → still one (floor(11 / 10))', g11.qualified === 11 && g11.awarded === 0 && activeGroup(E, E.A) === 1, big(g11));
  for (let i = 0; i < 2; i++) setStatus(E, os10[i], 'cancelled');
  setStatus(E, E.db._tables.affiliateOrder.find((o) => o.affiliateId === members[10].id), 'returned');
  const gDown = await gsync(E, E.A);
  ok('two members drop below → 9 → the group reward is REVERSED (−50000, cycle 1)', gDown.reversed === 1 && activeGroup(E, E.A) === 0 && groupRows(E, E.A).find((r) => r.type === 'GROUP_REVERSAL')?.amountCents === -50000, big(gDown));
  setStatus(E, os10[0], 'delivered'); setStatus(E, os10[1], 'delivered');
  const conc = await Promise.all(Array.from({ length: 6 }, () => gsync(E, E.A)));
  ok('requalification (10 again) with 6 concurrent syncs → exactly ONE new cycle (2), no duplicate', conc.reduce((t, r) => t + r.awarded, 0) === 1 && activeGroup(E, E.A) === 1
    && eq(groupRows(E, E.A).map((r) => [r.type, r.cycle]), [['GROUP_REWARD', 1], ['GROUP_REVERSAL', 1], ['GROUP_REWARD', 2]]) && noDupes(E), big(conc));
  const reconcile = await Promise.all([RS.reconcileRecruiterRewards({ db: E.db, now: T0 }), RS.reconcileRecruiterRewards({ db: E.db, recruiterId: E.A.id, now: T0 })]);
  ok('duplicate reconciliations → nothing new', reconcile.every((r) => r.groupAwarded === 0 && r.groupReversed === 0) && groupRows(E, E.A).length === 3, big(reconcile));
  ok('Stage F: B never earns from A\'s network — its nested legacy link counts for A only (B qualified 0)', groupRows(E, E.B).length === 0 && (await gsync(E, E.B)).qualified === 0);
  const sum = (await progress(E, E.A)).body.progress;
  ok('summary qualifiedForGroup = the sync\'s count (10)', sum.qualifiedForGroup === 10 && sum.activeGroupRewards === 1, big(sum));
}

// ── 8. hooks ──────────────────────────────────────────────────────────────────────
console.log('\n8. Hooks: an order status change of an invited member awards its owner (A and B) and syncs the owner\'s group');
{
  const E = setup({ settings: { ...BOTH_ON, groupSize: 2 } });
  const t = aff(E, E.A); const x = aff(E, null, t.id); identity(E, x); identity(E, t);
  const os = orders(E, x, 10, { status: 'pending' }); orders(E, t, 10);
  for (const o of os) setStatus(E, o, 'delivered');
  const r = await HK.onRecruiterOrderStatusCommitted(os[9].id, { db: E.db });
  ok('order hook → AWARDED to A (owner of the invited member); the group of A synced (2 qualified → 1 group reward)', r.action === 'AWARDED' && ledger(E, { affiliateId: x.id })[0]?.recruiterId === E.A.id && activeGroup(E, E.A) === 1, big(r));
  const g = await RS.syncRecruiterGroupRewardForAffiliate(x.id, { db: E.db, now: T0 });
  ok('the group helper resolves the OWNER of an invited member (SYNCED for A), NOT_LINKED for an unowned one',
    g.action === 'SYNCED' && g.recruiterId === E.A.id && eq(await RS.syncRecruiterGroupRewardForAffiliate(aff(E, null).id, { db: E.db }), { action: 'NOT_LINKED' }));
}

// ── 9. the (emulated) DB link guard ─────────────────────────────────────────────
console.log('\n9. The 20261112 guards (emulated): the ledger accepts the owner only (Stage F: topmost link); a link to another recruiter inside an owned network is refused');
{
  const E = setup();
  const t = aff(E, E.A); const x = aff(E, null, t.id); const bx = aff(E, E.B, x.id); const loose = aff(E, null);
  const ins = (rec, a, extra = {}) => E.db.$transaction((tx) => tx.recruiterRewardLedger.create({ data: { recruiterId: rec.id, affiliateId: a.id, type: 'RECRUIT_REWARD', amountCents: 100, cycle: 1, idempotencyKey: `recruit:${a.id}:v1`, actorType: 'SYSTEM', settingsVersion: 1, ...extra } })).then(() => 'ok', (e) => (/is not in the network of recruiter/.test(e.message) ? 'GUARD' : e.message));
  ok('a reward for the invited x credited to A (its owner) → accepted', await ins(E.A, x) === 'ok');
  ok('Stage F: … to B → refused by the guard; the nested legacy B link bx credited to B → refused, to A (its owner: the topmost link) → accepted; an unowned affiliate → refused for both',
    await ins(E.B, t) === 'GUARD' && await ins(E.B, bx) === 'GUARD' && await ins(E.A, bx) === 'ok' && await ins(E.A, loose) === 'GUARD' && await ins(E.B, loose) === 'GUARD');
  const rev = (rec, a) => E.db.$transaction((tx) => tx.recruiterRewardLedger.create({ data: { recruiterId: rec.id, affiliateId: a.id, type: 'REVERSAL', amountCents: -100, cycle: 1, idempotencyKey: `reverse:${a.id}:v1`, actorType: 'SYSTEM', settingsVersion: 1 } })).then(() => 'ok', (e) => e.message);
  ok('a reversal of x\'s reward by its holder A → accepted; by B → refused', /cycle and recruiter|not in the network/.test(await rev(E.B, x)) && await rev(E.A, x) === 'ok');
  // Stage F: recruiter_link_owner_guard — a new affiliate (created in the same transaction, inactive) under A's member x
  const link = (rec, parentId) => E.db.$transaction(async (tx) => {
    const id = crypto.randomUUID();
    await tx.affiliate.create({ data: { id, name: 'Nouveau', username: `own.g${++uniq}`, password: 'x', isActive: false, parentId } });
    await tx.recruiterAffiliateLink.create({ data: { affiliateId: id, recruiterId: rec.id, createdBy: rec.id } });
    return id;
  }).then((id) => id, (e) => (/inside the network of another recruiter/.test(e.message) ? 'LINK_GUARD' : e.message));
  const toB = await link(E.B, x.id); const toBUnderLegacy = await link(E.B, bx.id); const toA = await link(E.A, bx.id); const free = await link(E.B, loose.id);
  ok('Stage F: link guard (emulated) — a link to B for a child of A\'s member x → refused, also below the legacy B link bx (the whole transaction rolled back: no affiliate left); to A → accepted; under an unowned affiliate → accepted (no owner)',
    toB === 'LINK_GUARD' && toBUnderLegacy === 'LINK_GUARD' && typeof toA === 'string' && toA.length > 10 && typeof free === 'string' && free.length > 10
    && E.db._tables.affiliate.filter((a) => /^own\.g\d+$/.test(a.username)).length === 2, big({ toB, toBUnderLegacy, toA, free }));
  const mig = read('prisma/migrations/20261112_recruiter_group_rewards/migration.sql');
  const code = mig.replace(/--.*$/gm, '');
  const fnOf = (name) => { const i = code.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`); return i < 0 ? '' : code.slice(i, code.indexOf('$$ LANGUAGE plpgsql', i)); };
  const owner = fnOf('recruiter_affiliate_owner'); const guard = fnOf('recruiter_reward_link_guard'); const lg = fnOf('recruiter_link_owner_guard'); const dg = fnOf('affiliates_children_delete_guard');
  ok('Stage F: migration 20261112 — recruiter_affiliate_owner(): a cycle-safe UNION walk to the top (one recruiter → it; several with a top → a second walk bounded by the chain length, topmost = highest step; several on a cycle → NULL), STABLE',
    /WITH RECURSIVE chain AS/.test(owner) && /\n\s*UNION\n/.test(owner) && /bool_or\(c\.top\)/.test(owner) && /n_rids = 1 THEN\s+RETURN one_rid/.test(owner) && /NOT has_top THEN\s+RETURN NULL/.test(owner)
    && /UNION ALL[\s\S]*WHERE u\.k < n_rows/.test(owner) && /ORDER BY u\.k DESC LIMIT 1/.test(owner) && /\$\$ LANGUAGE plpgsql STABLE;/.test(code));
  ok('Stage F: the ledger link guard uses it (a REVERSAL by the reward holder still accepted), the link owner guard refuses another recruiter inside an owned network, the delete guard refuses an affiliate with children — all re-runnable (CREATE OR REPLACE + DROP TRIGGER IF EXISTS), documented, no row written',
    /owner_id := recruiter_affiliate_owner\(NEW\."affiliateId"\)/.test(guard) && /IS DISTINCT FROM NEW\."recruiterId"/.test(guard) && /NEW\."type" = 'REVERSAL' AND EXISTS/.test(guard)
    && /owner_id := recruiter_affiliate_owner\(NEW\."affiliateId"\)/.test(lg) && /owner_id IS NOT NULL AND owner_id <> NEW\."recruiterId"/.test(lg)
    && /FOR UPDATE/.test(dg) && /c\."parentId" = OLD\."id"/.test(dg) && /AFFILIATE_HAS_CHILDREN/.test(dg) && /USING ERRCODE = 'check_violation'/.test(dg)
    && /DROP TRIGGER IF EXISTS "recruiter_reward_ledger_link_guard"/.test(code) && /DROP TRIGGER IF EXISTS "recruiter_affiliate_links_owner_guard" ON "recruiter_affiliate_links";\s*CREATE TRIGGER "recruiter_affiliate_links_owner_guard" BEFORE INSERT ON "recruiter_affiliate_links"/.test(code)
    && /DROP TRIGGER IF EXISTS "affiliates_children_delete_guard" ON "affiliates";\s*CREATE TRIGGER "affiliates_children_delete_guard" BEFORE DELETE ON "affiliates"/.test(code)
    && /Phase 7 Stage F/.test(mig) && !/ALTER TABLE "affiliates"/.test(code) && !/^\s*(UPDATE|DELETE|INSERT)\b/im.test(code));
}

// ── 10. one owner per affiliate (random forests) + reconcile coverage ─────────────
console.log('\n10. Exactly one owner per affiliate on random forests; the reconcile covers every owned affiliate exactly once');
{
  const rand = (s) => () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let checks = 0; const bad = [];
  for (let seed = 1; seed <= 20; seed++) {
    const rnd = rand(seed * 7907);
    const E = setup({ settings: { ...BOTH_ON, minDeliveredSales: 1, groupMinDeliveredSales: 1 } });
    const C = E.db._seed.recruiter({ username: `own.c${seed}`, name: 'Recruteur C' });
    const recs = [E.A, E.B, C];
    const ids = [];
    for (let i = 0, n = 30 + Math.floor(rnd() * 40); i < n; i++) {
      const o = rnd();
      const a = aff(E, o < 0.35 ? recs[Math.floor(rnd() * 3)] : null, ids.length && rnd() < 0.85 ? ids[Math.floor(rnd() * ids.length)] : null);
      ids.push(a.id); orders(E, a, 1); identity(E, a);
    }
    for (let k = Math.floor(rnd() * 3); k > 0; k--) { const row = E.db._tables.affiliate[Math.floor(rnd() * ids.length)]; row.parentId = rnd() < 0.3 ? row.id : ids[Math.floor(rnd() * ids.length)]; }
    // Stage F oracle: the TOPMOST link of the chain (visited set); a parent cycle → its one recruiter, null when several
    const byId = new Map(E.db._tables.affiliate.map((a) => [a.id, a]));
    const linkOf = new Map(E.db._tables.recruiterAffiliateLink.map((l) => [l.affiliateId, l.recruiterId]));
    const walk = (id) => { const seen = new Set(); const rids = []; let c = id; for (; c != null && byId.has(c) && !seen.has(c); c = byId.get(c).parentId ?? null) { seen.add(c); if (linkOf.has(c)) rids.push(linkOf.get(c)); } return { rids, cycle: c != null && seen.has(c) }; };
    const oracle = (id) => { const { rids, cycle } = walk(id); const set = new Set(rids); if (set.size === 1) return rids[0]; if (set.size > 1 && !cycle) return rids[rids.length - 1]; return null; };
    // Stage F: the conflicts reported = the links whose recruiter is not their oracle owner (never reassigned)
    const conf = await RS.listRecruiterOwnershipConflicts({ db: E.db, limit: 5000 });
    const wantConf = E.db._tables.recruiterAffiliateLink.filter((l) => oracle(l.affiliateId) !== l.recruiterId).map((l) => l.affiliateId).sort();
    checks += 1; if (!eq(conf.items.map((i) => i.affiliateId).sort(), wantConf) || conf.total !== wantConf.length) bad.push(`seed ${seed} conflicts ${conf.total} != ${wantConf.length}`);
    for (const id of ids) { checks += 1; const o = await RS.findAffiliateOwner(id, { db: E.db }); if (o !== oracle(id)) bad.push(`seed ${seed} owner ${id}`); }
    const sizes = await Promise.all(recs.map((r) => NS.countDownline(r.id, { db: E.db })));
    const owned = ids.filter((id) => oracle(id) !== null).length;
    checks += 1; if (sizes.reduce((t, n) => t + n, 0) !== owned) bad.push(`seed ${seed} sum of networks ${sizes} != owned ${owned}`);
    // admin reconcile (batch 3 → many batches): Stage F — it scans every affiliate at or below a link once (owned, or an
    // ambiguous-cycle conflict); every owned affiliate is rewarded once, to its owner; no unowned / conflicting one
    const scanned = ids.filter((id) => walk(id).rids.length > 0).length;
    const r1 = await RS.reconcileRecruiterRewards({ db: E.db, now: T0, batchSize: 3 });
    const rewards = E.db._tables.recruiterRewardLedger.filter((r) => r.type === 'RECRUIT_REWARD');
    checks += 1;
    if (r1.checked !== scanned || rewards.length !== owned || rewards.some((r) => oracle(r.affiliateId) !== r.recruiterId) || !noDupes(E)) bad.push(`seed ${seed} admin reconcile ${big(r1)} rewards ${rewards.length} owned ${owned}`);
    const r2 = await RS.reconcileRecruiterRewards({ db: E.db, now: T0, batchSize: 3 });
    checks += 1; if (r2.awarded !== 0 || E.db._tables.recruiterRewardLedger.filter((r) => r.type === 'RECRUIT_REWARD').length !== owned) bad.push(`seed ${seed} second run`);
    for (const [i, r] of recs.entries()) {
      const w = await RS.reconcileRecruiterRewards({ db: E.db, recruiterId: r.id, now: T0, batchSize: 2 });
      checks += 1; if (w.checked !== sizes[i] || w.awarded !== 0) bad.push(`seed ${seed} wallet ${r.username} checked ${w.checked} != ${sizes[i]}`);
      const g = await RS.syncRecruiterGroupReward(r.id, { db: E.db, now: T0 });
      checks += 1; if (g.qualified !== sizes[i]) bad.push(`seed ${seed} group ${r.username} ${g.qualified} != ${sizes[i]}`);
    }
  }
  ok(`Stage F: 20 random forests (3 recruiters, nested legacy links, unlinked descendants, cycles): ${checks} checks — findAffiliateOwner = the topmost-link oracle, Σ|N(R)| = owned affiliates (one owner each), the admin reconcile rewards each owned affiliate once to its owner (multi-batch), idempotent, the wallet scope = N(R) (multi-batch), the group counts N(R)`,
    bad.length === 0 && checks > 1000, bad.slice(0, 5).join(' | '));
}

// ── 11. static ────────────────────────────────────────────────────────────────────
console.log('\n11. Static: no direct-link reward lookup left; the walks are cycle-safe');
{
  const rs = read('src/lib/services/recruiterRewardService.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the reward service no longer reads recruiter_affiliate_links through Prisma (owner = ONE recursive statement)', !/recruiterAffiliateLink/.test(rs));
  const owner = /\/\* recruiter-affiliate-owner \*\/([\s\S]*?)`/.exec(read('src/lib/services/recruiterRewardService.js'))?.[1] ?? '';
  ok('Stage F: the owner statement walks the whole chain with a cycle-safe UNION (no stop at a link), then — only for several recruiters on a chain with a top — a UNION ALL walk bounded by the chain length: topmost = highest k',
    /WITH RECURSIVE chain AS[\s\S]*?\n\s*UNION\n/.test(owner) && !/WHERE u\.rid IS NULL/.test(owner) && /WHERE u\.k < \(SELECT i\.n FROM info i\)/.test(owner) && /WHEN i\.nr > 1 AND i\.top THEN \(SELECT u\.rid FROM up u WHERE u\.rid IS NOT NULL ORDER BY u\.k DESC LIMIT 1\)/.test(owner));
  const anc = /\/\* recruiter-ancestry \*\/([\s\S]*?)`/.exec(read('src/lib/services/recruiterAffiliateService.js'))?.[1] ?? '';
  ok('Stage F: the creation ancestry applies the owner rule to the parent (cycle-safe UNION walk to the top, no stop at a link; the topmost link for several recruiters) and keeps the ANCESTRY_MAX + 1 walk cap',
    !/u\.rid IS NULL/.test(anc) && /WITH RECURSIVE chain AS[\s\S]*?\n\s*UNION\n/.test(anc) && /FROM chain c LIMIT \$\{cap\}::int/.test(anc) && /ORDER BY u\.k DESC LIMIT 1/.test(anc)
    && AS.RECRUITER_AFFILIATE_LIMITS.ANCESTRY_MAX === 10000);
  ok('progress / network services expose the N(R) helpers', typeof NS.networkIdsWithRealDelivered === 'function' && typeof PS.withProgress === 'function' && typeof RS.findAffiliateOwner === 'function');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
