#!/usr/bin/env node
/**
 * scripts/recruiterDownlineProgress.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 7 Stage B: the recruiter's network (visibility and progress) —
 * GET /api/recruiter/network/{nodes,stats}, GET /api/recruiter/affiliates (paged list) and
 * GET /api/recruiter/progress (summary). In-memory fake database only
 * (scripts/lib/recruiterFakeDb.mjs, phase5: every tagged statement emulated from its own SQL).
 * Phase 7 Stage E (approved product rule, documented pin updates marked "Stage E"): the network is
 * N(R) = { X : owner(X) = R }, owner(X) = the recruiter of the NEAREST linked affiliate at or above X —
 * no longer the Stage B downline D(R) (which also showed other recruiters' affiliates). Every member is
 * reward-eligible: rewardState on every node, the affiliate list = N(R), the summary counts N(R).
 * Proves:
 *   • N(R) = linked(R) + their descendants not owned by another recruiter: direct, 2 levels,
 *     10 levels, a 350-deep chain of admin-created descendants; levels absolute everywhere
 *   • nested link (Stage E): R2's affiliate below R1's affiliate belongs to R2 with its subtree — R1
 *     neither sees it nor earns from it; the reward goes to R2 only; nothing names R2 in R1's responses
 *   • self-parents and cycles never loop (unplaced = linked members no root reaches)
 *   • unrelated affiliates, another recruiter's root, unknown / malformed ids → NOT_FOUND
 *   • progress per node: own real delivered only (9/10, 10/10, 11/10; fake, cancelled, returned,
 *     refused, 'Delivered' never count), identity APPROVED, group threshold; rewardState (every member)
 *   • canViewOrders off: delivered values null, ZERO statements over affiliate_orders (nodes, list);
 *     canCreateAffiliates has no effect on visibility
 *   • the summary's qualifiedForGroup equals syncRecruiterGroupReward's count; progress toward the
 *     next group; reward counts by type
 *   • the affiliate list: keyset pages (0, 1, 99, 100, 101 affiliates), cursor continuation through
 *     createdAt ties, search + total, the former default page (50, truncated)
 *   • a brute-force oracle of N(R) (owner by definition) agrees with every endpoint on seeded random
 *     forests; every affiliate has at most one owner
 * Phase 7 Stage F (approved clarification, pins marked "Stage F"): the TOPMOST link wins — a nested legacy link to
 * another recruiter stays in the topmost recruiter's network; a member whose chain ends in a parent cycle is unplaced.
 * Run: node scripts/recruiterDownlineProgress.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-downline-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const { recruiterNetworkHandlers } = await import('../src/lib/recruiterNetworkRouteHandlers.js');
const { recruiterAffiliateHandlers } = await import('../src/lib/recruiterAffiliateRouteHandlers.js');
const { recruiterProgressHandlers, RECRUITER_PROGRESS_RATE } = await import('../src/lib/recruiterProgressHandlers.js');
const S = await import('../src/lib/services/recruiterNetworkService.js');
const PS = await import('../src/lib/services/recruiterProgressService.js');
const RS = await import('../src/lib/services/recruiterRewardService.js');
const V = await import('../src/lib/recruiterVisibility.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const { rateLimit: realRateLimit } = await import('../src/lib/rateLimit.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const T0 = Date.parse('2026-11-05T09:00:00.000Z');
const noLimit = () => null;
const NODE_KEYS = ['childrenCount', 'descendantsCount', 'id', 'identityStatus', 'level', 'linkedToMe', 'name', 'orders', 'progress', 'rewardState', 'status', 'username'];
const PROGRESS_KEYS = ['groupThreshold', 'identityApproved', 'individualThreshold', 'qualifiedGroup', 'qualifiedIndividual', 'realDelivered'];
const LIST_ITEM_KEYS = ['createdAt', 'id', 'identityStatus', 'level', 'linkedToMe', 'name', 'parent', 'parentId', 'progress', 'rewardState', 'status', 'username'];
const SUMMARY_KEYS = ['activeGroupRewards', 'currency', 'downlineAffiliates', 'groupEnabled', 'groupSize', 'groupThreshold', 'individualEnabled', 'individualThreshold',
  'linkedAffiliates', 'progressTowardNextGroup', 'qualifiedForGroup', 'rewards'];

const req = (url, { cookie, ip } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (ip) headers['x-forwarded-for'] = ip;
  return new Request(`http://localhost${url}`, { method: 'GET', headers });
};
const call = async (handler, r) => {
  const res = await handler(r, {});
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
};
const cookieOf = (rec) => `recruiter_token=${signToken({ recruiterId: rec.id, username: rec.username, type: 'recruiter' })}`;

function setup({ rateLimit = noLimit } = {}) {
  const db = makeRecruiterFakeDb({ phase5: true });
  const A = db._seed.recruiter({ username: 'dl.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'dl.b', name: 'Recruteur B' });
  const C = db._seed.recruiter({ username: 'dl.c', name: 'Recruteur C' });
  const nh = recruiterNetworkHandlers({ db, rateLimit });
  const ah = recruiterAffiliateHandlers({ db, rateLimit, now: () => new Date(T0) });
  const ph = recruiterProgressHandlers({ db, rateLimit });
  return { db, A, B, C, stats: withRecruiterAuth(nh.stats), nodes: withRecruiterAuth(nh.nodes), list: withRecruiterAuth(ah.affiliates), progress: withRecruiterAuth(ph.summary) };
}
let uniq = 0;
const aff = (E, rec, over = {}) => {
  uniq += 1;
  const a = E.db._seed.affiliate({ username: `d${uniq}`, name: `Affilié ${uniq}`, password: 'HASH-SECRET-PWD', createdAt: new Date(T0 + uniq * 1000), ...over });
  if (rec) E.db._seed.link({ affiliateId: a.id, recruiterId: rec.id, createdAt: a.createdAt });
  return a;
};
const chain = (E, rec, n, parentId = null) => { const ids = []; let p = parentId; for (let i = 0; i < n; i++) { const a = aff(E, rec, { parentId: p }); ids.push(a.id); p = a.id; } return ids; };
const qs = (p) => { const q = new URLSearchParams(p).toString(); return q ? `?${q}` : ''; };
const nodes = (E, rec, p = {}) => call(E.nodes, req(`/api/recruiter/network/nodes${qs(p)}`, { cookie: cookieOf(rec) }));
const stats = (E, rec, rootId) => call(E.stats, req(`/api/recruiter/network/stats${rootId !== undefined ? qs({ rootId }) : ''}`, { cookie: cookieOf(rec) }));
const list = (E, rec, p = {}) => call(E.list, req(`/api/recruiter/affiliates${qs(p)}`, { cookie: cookieOf(rec) }));
const progress = (E, rec) => call(E.progress, req('/api/recruiter/progress', { cookie: cookieOf(rec) }));
const orderStatements = (E, from) => E.db._log.slice(from).filter((l) => l.model === 'affiliateOrder' || (l.model === '$queryRaw' && /affiliate_orders/.test(l.sql ?? '')));
const NF = (r) => r.status === 404 && r.text === '{"code":"NOT_FOUND"}';
const settings = (E, over = {}) => E.db._seed.settings({
  version: 1, enabled: true, rewardAmountCents: 1500, minDeliveredSales: 10, groupEnabled: true, groupRewardAmountCents: 5000, groupSize: 3, groupMinDeliveredSales: 5, ...over,
});
const orders = (E, a, n, status = 'delivered', isFake = false) => { for (let i = 0; i < n; i++) E.db._seed.order({ affiliateId: a.id, status, isFake, total: 777.77, clientName: 'CLIENT-SECRET' }); };

// ── 1. direct, 2 levels, 10 levels ───────────────────────────────────────────
console.log('\n1. Direct affiliate, 2 levels, 10 levels (linked and admin-created descendants)');
{
  const E = setup();
  const a1 = aff(E, E.A);
  const r = await nodes(E, E.A);
  ok('a direct affiliate: one root at level 1, linkedToMe true, exact node keys, progress + rewardState NONE',
    r.status === 200 && r.body.total === 1 && r.body.nodes[0].id === a1.id && r.body.nodes[0].level === 1 && r.body.nodes[0].linkedToMe === true
    && eq(keys(r.body.nodes[0]), NODE_KEYS) && eq(keys(r.body.nodes[0].progress), PROGRESS_KEYS) && eq(r.body.nodes[0].rewardState, { state: 'NONE', cycle: null }), r.text.slice(0, 300));
  const a2 = aff(E, E.A, { parentId: a1.id });
  const k = await nodes(E, E.A, { parentId: a1.id });
  ok('2 levels: the child is listed at level 2 under its parent (linked)', k.status === 200 && eq(k.body.nodes.map((n) => [n.id, n.level, n.linkedToMe]), [[a2.id, 2, true]]) && k.body.parent.level === 1);

  // 10 levels: A's root, then alternate admin-created (unlinked) and A-linked affiliates
  const F = setup();
  const ids = [];
  let p = null;
  for (let i = 0; i < 10; i++) { const a = aff(F, i === 0 || i % 2 === 1 ? F.A : null, { parentId: p }); ids.push(a.id); p = a.id; }
  const st = (await stats(F, F.A)).body.stats;
  ok('10 levels (A-linked and admin-created affiliates alternating): ONE root, 10 levels of 1, maxLevel 10, unplaced 0',
    st.totals.affiliates === 10 && st.totals.direct === 1 && st.totals.maxLevel === 10 && st.totals.unplaced === 0 && eq(st.levels.map((l) => [l.level, l.affiliates]), ids.map((_, i) => [i + 1, 1])), JSON.stringify(st.totals));
  const deep = (await nodes(F, F.A, { parentId: ids[8] })).body;
  ok('… the 10th affiliate under the 9th: level 10, breadcrumb of 9 entries with linkedToMe per entry', deep.nodes[0].id === ids[9] && deep.nodes[0].level === 10
    && eq(deep.path.map((x) => [x.id, x.level, x.linkedToMe]), ids.slice(0, 9).map((id, i) => [id, i + 1, i === 0 || i % 2 === 1])));
  const roots = (await nodes(F, F.A)).body;
  ok('… the A-linked affiliates below the admin-created ones are NOT roots (one root, 9 descendants)', roots.total === 1 && roots.nodes[0].id === ids[0] && roots.nodes[0].descendantsCount === 9);
  const sub = (await stats(F, F.A, ids[4])).body.stats;
  ok('sub-network statistics use ABSOLUTE levels: rootId = level 5 → levels 6…10, direct 1, maxLevel 10', eq(sub.levels.map((l) => l.level), [6, 7, 8, 9, 10]) && sub.totals.direct === 1 && sub.totals.maxLevel === 10 && sub.totals.affiliates === 5);
  const viaUnlinked = await stats(F, F.A, ids[2]);
  ok('a non-linked downline node works as rootId / parentId (200)', viaUnlinked.status === 200 && viaUnlinked.body.stats.levels[0].level === 4 && (await nodes(F, F.A, { parentId: ids[2] })).status === 200);
}

// ── 2. deep chain (≥ 300) ─────────────────────────────────────────────────────
console.log('\n2. A 350-deep chain of admin-created descendants under one linked root');
{
  const E = setup();
  const root = aff(E, E.A);
  const ids = [root.id, ...chain(E, null, 349, root.id)];
  const m0 = E.db._queryCount();
  const st = (await stats(E, E.A)).body.stats;
  const qStats = E.db._queryCount() - m0;
  ok('stats: 350 affiliates, 350 levels, maxLevel 350 — 3 queries (independent of the depth)', st.totals.affiliates === 350 && st.levels.length === 350 && st.totals.maxLevel === 350 && qStats === 3, `${qStats}`);
  const m1 = E.db._queryCount();
  const n = (await nodes(E, E.A, { parentId: ids[299] })).body;
  const qNodes = E.db._queryCount() - m1;
  // Stage E: every member is reward-eligible → the page always reads its ledger rows (rewardState): 8 queries (Stage B: 7);
  // simplified dashboard: + the scope's own card (one statement) = 9
  ok('nodes?parentId = the level-300 node: breadcrumb of 300 (levels 1…300, only the root linked), child at level 301 with 49 descendants — 9 queries (+ the scope\'s own card)',
    n.path.length === 300 && n.path.every((x, i) => x.id === ids[i] && x.level === i + 1 && x.linkedToMe === (i === 0)) && n.nodes[0].id === ids[300] && n.nodes[0].level === 301
    && n.nodes[0].descendantsCount === 49 && n.nodes[0].linkedToMe === false && eq(n.nodes[0].rewardState, { state: 'NONE', cycle: null }) && qNodes === 9
    && n.parentNode.id === ids[299] && n.parentNode.level === 300 && n.parentNode.descendantsCount === 50, `${n.path?.length} ${qNodes}`);
  const s300 = (await stats(E, E.A, ids[299])).body.stats;
  ok('stats?rootId = the level-300 node → levels 301…350', s300.levels[0].level === 301 && s300.levels.length === 50 && s300.totals.maxLevel === 350);
  const sum = (await progress(E, E.A)).body.progress;
  ok('summary: linkedAffiliates 1, downlineAffiliates (= |N(R)|) 350', sum.linkedAffiliates === 1 && sum.downlineAffiliates === 350, JSON.stringify(sum));
}

// ── 3. Stage F: nested legacy link — the TOPMOST link wins ─────────────────────
console.log('\n3. Stage F: a nested legacy link — R2\'s affiliate below R1\'s network stays R1\'s with its subtree; R2 neither sees nor earns');
{
  const E = setup();
  settings(E);
  const a1 = aff(E, E.A);                                   // A's root
  const x = aff(E, null, { parentId: a1.id, username: 'adm.x' }); // admin-created → owned by A
  const b1 = aff(E, E.B, { parentId: x.id, username: 'b.under.a' }); // a legacy link to B below A's network (seeded: no trigger)
  const b2 = aff(E, E.B, { parentId: b1.id });
  const bx = aff(E, null, { parentId: b1.id, username: 'adm.bx' }); // admin-created under b1 → owned by A (topmost)
  orders(E, b1, 10); orders(E, bx, 10);
  E.db._seed.identity({ affiliateId: b1.id, status: 'APPROVED' }); E.db._seed.identity({ affiliateId: bx.id, status: 'APPROVED' });
  const kids = await nodes(E, E.A, { parentId: x.id });
  ok('Stage F: A\'s admin-created child x has the nested legacy B link b1 as its child in A\'s network (linkedToMe false, 2 descendants)',
    kids.status === 200 && kids.body.total === 1 && eq(kids.body.nodes.map((v) => [v.id, v.level, v.linkedToMe, v.descendantsCount]), [[b1.id, 3, false, 2]]));
  const allA = JSON.stringify([kids.body, (await nodes(E, E.A)).body, (await nodes(E, E.A, { parentId: a1.id })).body, (await stats(E, E.A)).body, (await list(E, E.A)).body, (await progress(E, E.A)).body]);
  ok('Stage F: nothing in A\'s responses names recruiter B (id, username, name)', ![E.B.id, E.B.username, E.B.name].some((v) => allA.includes(v)));
  const bk = (await nodes(E, E.A, { parentId: b1.id })).body;
  ok('Stage F: A: b1 as parentId → its children b2 (B\'s legacy link, linkedToMe false) and bx (invited) at level 4; stats?rootId=b2 → 200',
    eq(bk.nodes.map((v) => [v.id, v.level, v.linkedToMe]), [[b2.id, 4, false], [bx.id, 4, false]]) && eq(bk.path.map((p) => p.id), [a1.id, x.id, b1.id])
    && (await stats(E, E.A, b2.id)).status === 200);
  const ax = (await nodes(E, E.A, { parentId: a1.id })).body.nodes;
  ok('A sees its admin-created child x at level 2 (linkedToMe false, rewardState NONE, Stage F: 3 descendants)',
    eq(ax.map((v) => [v.id, v.level, v.linkedToMe, v.descendantsCount]), [[x.id, 2, false, 3]]) && eq(ax[0].rewardState, { state: 'NONE', cycle: null }));
  const rootsRuns = async (rec) => { const m = E.db._log.length; await nodes(E, rec); return E.db._log.slice(m).filter((l) => l.model === '$queryRaw' && /recruiter-network-roots/.test(l.sql)).length; };
  ok('Stage F: ONE roots statement for A and for B (no marking walk any more — roots = links without any linked ancestor)', await rootsRuns(E.A) === 1 && await rootsRuns(E.B) === 1);
  const rb = (await nodes(E, E.B)).body;
  ok('Stage F: B sees nothing — no root (its legacy links b1 / b2 are inside A\'s network)', rb.total === 0 && eq(rb.nodes, []));
  ok('Stage F: B: its legacy links and A\'s affiliates → NOT_FOUND', NF(await nodes(E, E.B, { parentId: b1.id })) && NF(await stats(E, E.B, b2.id)) && NF(await nodes(E, E.B, { parentId: a1.id })) && NF(await stats(E, E.B, x.id)));
  const before = E.db._tables.recruiterRewardLedger.length;
  const sync = await RS.syncRecruiterReward(b1.id, { db: E.db });
  const syncX = await RS.syncRecruiterReward(bx.id, { db: E.db });
  const rows = E.db._tables.recruiterRewardLedger.slice(before);
  ok('Stage F: the individual rewards of b1 (B\'s legacy link) and bx (invited under it) are written for A ONLY (the topmost link), never for B',
    sync.action === 'AWARDED' && syncX.action === 'AWARDED' && rows.length === 2 && rows.every((r) => r.recruiterId === E.A.id) && eq(rows.map((r) => r.affiliateId), [b1.id, bx.id])
    && !E.db._tables.recruiterRewardLedger.some((l) => l.recruiterId === E.B.id), JSON.stringify([sync, syncX]));
  const aView = (await nodes(E, E.A, { parentId: b1.id })).body.nodes.find((v) => v.id === bx.id);
  ok('Stage F: after the rewards: A sees rewardState AWARDED cycle 1 on bx', eq(aView.rewardState, { state: 'AWARDED', cycle: 1 }));
  const [sa, sb] = [(await progress(E, E.A)).body.progress, (await progress(E, E.B)).body.progress];
  ok('Stage F: summaries: A linked 1 / network 5 (a1, x, b1, b2, bx), individual awarded 2 (3000 cents); B linked 0 (its legacy links are A\'s) / network 0, no reward',
    sa.linkedAffiliates === 1 && sa.downlineAffiliates === 5 && sa.rewards.individual.awarded === 2 && sa.rewards.individual.awardedCents === 3000
    && sb.linkedAffiliates === 0 && sb.downlineAffiliates === 0 && sb.rewards.individual.awarded === 0, JSON.stringify([sa, sb]));
  const la = (await list(E, E.A)).body;
  ok('Stage F: A\'s affiliate list = N(A) (newest first: bx, b2, b1, x, a1 — linkedToMe only for a1); B\'s list is empty',
    eq(la.affiliates.map((v) => [v.id, v.linkedToMe]), [[bx.id, false], [b2.id, false], [b1.id, false], [x.id, false], [a1.id, true]]) && la.total === 5
    && (await list(E, E.B)).body.total === 0, JSON.stringify(la).slice(0, 300));
}

// ── 4. cycles / self-parents, unrelated, another recruiter's root ───────────
console.log('\n4. Self-parents and cycles never loop; unrelated affiliates and other roots stay invisible');
{
  const E = setup();
  const set = (a, p) => { E.db._tables.affiliate.find((v) => v.id === a.id).parentId = p; };
  const r = aff(E, E.A);
  const self = aff(E, E.A); set(self, self.id);                       // linked self-parent → unplaced
  const l1 = aff(E, E.A); const l2 = aff(E, E.A, { parentId: l1.id }); set(l1, l2.id); // linked 2-cycle
  const lx = aff(E, null, { parentId: l1.id });                       // non-linked under the linked cycle
  const lUnder = aff(E, E.A, { parentId: lx.id });                    // linked under it → unplaced (a linked ancestor in a cycle)
  const ux = aff(E, null); const uy = aff(E, null, { parentId: ux.id }); set(ux, uy.id); // non-linked 2-cycle
  const cUnder = aff(E, E.A, { parentId: ux.id });                    // linked under a NON-linked cycle → Stage F: owned by A, no top → unplaced
  const mixedL = aff(E, E.A); const mixedX = aff(E, null, { parentId: mixedL.id }); set(mixedL, mixedX.id); // cycle linked ⇄ non-linked
  const mixedChild = aff(E, E.A, { parentId: mixedX.id });            // → unplaced
  const unrelated = aff(E, null);
  const bRoot = aff(E, E.B);
  const roots = (await nodes(E, E.A)).body;
  // Stage F: a root needs a chain that reaches a top — every member whose chain ends in a parent cycle is unplaced (owned by
  // A when every link met is A's), including the linked affiliate under the NON-linked cycle (Stage E placed it as a root)
  ok('Stage F: roots: the normal root only; no cycle member, nothing below a cycle', eq(roots.nodes.map((v) => v.id), [r.id]));
  const un = (await nodes(E, E.A, { view: 'unplaced' })).body;
  ok('Stage F: unplaced = A\'s linked members on a chain without a top: self-parent, the linked 2-cycle, the linked node under it, the linked affiliate under the non-linked cycle, the linked ⇄ non-linked cycle member and its linked child',
    eq(un.nodes.map((v) => v.id).sort(), [self.id, l1.id, l2.id, lUnder.id, cUnder.id, mixedL.id, mixedChild.id].sort()) && un.total === 7 && un.nodes.every((v) => v.level === null && v.linkedToMe === true));
  const st = (await stats(E, E.A)).body.stats;
  ok('Stage F: stats: 1 placed, 7 unplaced (members 8)', st.totals.affiliates === 1 && st.totals.unplaced === 7 && st.totals.direct === 1);
  const probes = [self, l1, l2, lx, lUnder, ux, uy, cUnder, mixedL, mixedX, mixedChild, unrelated, bRoot].map((a) => a.id).concat([randomUUID(), 'bad id!', 'x'.repeat(101)]);
  const res = [];
  for (const id of probes) res.push([id, await nodes(E, E.A, { parentId: id }), await stats(E, E.A, id)]);
  ok(`NOT_FOUND for every node outside the placed downline (cycle members, their descendants, an unrelated affiliate, B's root, unknown / malformed ids): ${probes.length} × 2`,
    res.every(([, a, b]) => NF(a) && NF(b)), res.filter(([, a, b]) => !(NF(a) && NF(b))).map(([id]) => id).join(','));
  const sum = (await progress(E, E.A)).body.progress;
  ok('summary on cyclic data ends: |N(A)| = every member counted once (8 linked + lx and mixedX, invited below A\'s linked cycle members = 10; the unlinked cycle ux ⇄ uy has no owner)', sum.linkedAffiliates === 8 && sum.downlineAffiliates === 10, JSON.stringify(sum));
  const pl = await S.getAffiliatePlacement(E.A.id, [self.id, l1.id, lUnder.id, cUnder.id, r.id, mixedChild.id], { db: E.db });
  ok('Stage F: list placement: unplaced members (cUnder included) level null and parent masked; the placed root level 1', [self, l1, lUnder, mixedChild, cUnder].every((a) => pl.get(a.id).level === null && pl.get(a.id).parent === null)
    && pl.get(r.id).level === 1);
}

// ── 5. progress values ────────────────────────────────────────────────────────
console.log('\n5. Progress: 9/10, 10/10, 11/10, fake / cancelled / returned / refused / "Delivered" never count, identity, group threshold');
{
  const E = setup();
  settings(E, { minDeliveredSales: 10, groupMinDeliveredSales: 5 });
  const root = aff(E, E.A);
  const k9 = aff(E, E.A, { parentId: root.id }); orders(E, k9, 9);
  const k10 = aff(E, E.A, { parentId: root.id }); orders(E, k10, 10);
  const k11 = aff(E, null, { parentId: root.id }); orders(E, k11, 11); // admin-created descendant
  const noise = aff(E, E.A, { parentId: root.id });
  orders(E, noise, 9); orders(E, noise, 5, 'delivered', true); orders(E, noise, 2, 'cancelled'); orders(E, noise, 2, 'returned'); orders(E, noise, 2, 'refused'); orders(E, noise, 3, 'Delivered');
  orders(E, root, 1);
  for (const a of [k9, k10, k11, noise]) E.db._seed.identity({ affiliateId: a.id, status: 'APPROVED' });
  const kids = new Map((await nodes(E, E.A, { parentId: root.id })).body.nodes.map((v) => [v.id, v.progress]));
  const P = (rd, ind, grp) => ({ realDelivered: rd, individualThreshold: 10, groupThreshold: 5, identityApproved: true, qualifiedIndividual: ind, qualifiedGroup: grp });
  ok('9/10 → not qualified individually, qualified for the group (≥ 5)', eq(kids.get(k9.id), P(9, false, true)), JSON.stringify(kids.get(k9.id)));
  ok('10/10 → qualified', eq(kids.get(k10.id), P(10, true, true)));
  ok('11/10 (an admin-created descendant) → qualified', eq(kids.get(k11.id), P(11, true, true)));
  ok('9 real + 5 fake + cancelled / returned / refused + 3 "Delivered" → realDelivered 9 (only exact real delivered count)', eq(kids.get(noise.id), P(9, false, true)));
  const rootNode = (await nodes(E, E.A)).body.nodes[0];
  ok('a node counts its OWN orders only (never summed from descendants): root realDelivered 1; identity none → not qualified',
    rootNode.progress.realDelivered === 1 && rootNode.progress.identityApproved === false && rootNode.progress.qualifiedGroup === false);
  E.db._tables.identityVerification.find((v) => v.affiliateId === k10.id).status = 'REJECTED';
  const k10b = (await nodes(E, E.A, { parentId: root.id })).body.nodes.find((v) => v.id === k10.id).progress;
  ok('identity not APPROVED → 10/10 but not qualified', k10b.realDelivered === 10 && k10b.identityApproved === false && k10b.qualifiedIndividual === false && k10b.qualifiedGroup === false);
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: k9.id, type: 'RECRUIT_REWARD', amountCents: 1500, cycle: 1, idempotencyKey: `recruit:${k9.id}:v1`, settingsVersion: 1 });
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: k9.id, type: 'REVERSAL', amountCents: -1500, cycle: 1, idempotencyKey: `reverse:${k9.id}:v1`, settingsVersion: 1 });
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: k10.id, type: 'RECRUIT_REWARD', amountCents: 1500, cycle: 1, idempotencyKey: `recruit:${k10.id}:v1`, settingsVersion: 1 });
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: k10.id, type: 'REVERSAL', amountCents: -1500, cycle: 1, idempotencyKey: `reverse:${k10.id}:v1`, settingsVersion: 1 });
  E.db._seed.ledger({ recruiterId: E.A.id, affiliateId: k10.id, type: 'RECRUIT_REWARD', amountCents: 1500, cycle: 2, idempotencyKey: `recruit:${k10.id}:v2`, settingsVersion: 1 });
  const st = new Map((await nodes(E, E.A, { parentId: root.id })).body.nodes.map((v) => [v.id, v.rewardState]));
  // Stage E: the admin-created k11 is a member like any other (reward-eligible) → rewardState NONE (Stage B: null)
  ok('rewardState = the latest individual cycle: REVERSED cycle 1, AWARDED cycle 2, NONE; Stage E: the invited (admin-created) member → NONE too',
    eq(st.get(k9.id), { state: 'REVERSED', cycle: 1 }) && eq(st.get(k10.id), { state: 'AWARDED', cycle: 2 }) && eq(st.get(noise.id), { state: 'NONE', cycle: null }) && eq(st.get(k11.id), { state: 'NONE', cycle: null }));
  const sum = (await progress(E, E.A)).body.progress;
  ok('summary reward counts by type: individual awarded 3 (4500) / reversed 2 (3000, positive)', eq(sum.rewards.individual, { awarded: 3, awardedCents: 4500, reversed: 2, reversedCents: 3000 }), JSON.stringify(sum.rewards));
  const lst = (await list(E, E.A)).body.affiliates;
  const lk9 = lst.find((v) => v.id === k9.id);
  ok('the affiliate list carries the same progress / rewardState, level 2 and its parent (in the downline)', eq(lk9.progress, P(9, false, true)) && eq(lk9.rewardState, { state: 'REVERSED', cycle: 1 })
    && lk9.level === 2 && eq(lk9.parent, { id: root.id, username: root.username, name: root.name, linkedToMe: true }) && lk9.parentId === root.id && lk9.identityStatus === 'APPROVED' && lk9.status === 'INACTIVE');
}

// ── 6. canViewOrders off; canCreateAffiliates off ────────────────────────────
console.log('\n6. Permissions: canViewOrders off → delivered values null and ZERO order statements; canCreateAffiliates has no effect');
{
  const E = setup();
  settings(E);
  const NO = E.db._seed.recruiter({ username: 'dl.noorders', name: 'Sans commandes', canViewOrders: false });
  const NC = E.db._seed.recruiter({ username: 'dl.nocreate', name: 'Sans creation', canCreateAffiliates: false });
  for (const rec of [NO, NC]) {
    const r = aff(E, rec); const c = aff(E, null, { parentId: r.id }); const g = aff(E, rec, { parentId: c.id });
    orders(E, r, 12); orders(E, c, 3); orders(E, g, 6);
    E.db._seed.identity({ affiliateId: r.id, status: 'APPROVED' }); E.db._seed.identity({ affiliateId: g.id, status: 'APPROVED' });
    E.db._seed.ledger({ recruiterId: rec.id, affiliateId: r.id, type: 'RECRUIT_REWARD', amountCents: 1500, cycle: 1, idempotencyKey: `recruit:${r.id}:v1`, settingsVersion: 1 });
    rec.ids = [r.id, c.id, g.id];
  }
  const u1 = aff(E, NO); const u2 = aff(E, NO, { parentId: u1.id }); E.db._tables.affiliate.find((v) => v.id === u1.id).parentId = u2.id; // unplaced 2-cycle
  orders(E, u1, 4);
  const views = (rec) => ({ roots: () => nodes(E, rec), children: () => nodes(E, rec, { parentId: rec.ids[0] }), grand: () => nodes(E, rec, { parentId: rec.ids[1] }),
    unplaced: () => nodes(E, rec, { view: 'unplaced' }), list: () => list(E, rec), listPage: () => list(E, rec, { limit: '1' }) });
  for (const [k, f] of Object.entries(views(NO))) {
    const mark = E.db._log.length;
    const r = await f();
    const items = r.body.nodes ?? r.body.affiliates ?? [];
    const os = orderStatements(E, mark);
    ok(`canViewOrders off → ${k}: 200, progress realDelivered / qualifiedIndividual / qualifiedGroup null (thresholds + identity kept), ZERO statements over affiliate_orders`,
      r.status === 200 && items.length > 0 && items.every((v) => (v.progress && v.progress.realDelivered === null && v.progress.qualifiedIndividual === null
        && v.progress.qualifiedGroup === null && v.progress.individualThreshold === 10 && typeof v.progress.identityApproved === 'boolean')) && os.length === 0
      && !/"realDelivered":\d/.test(r.text) && !/"delivered":/.test(r.text), `${r.text.slice(0, 200)} os=${os.length}`);
  }
  const rs = (await nodes(E, NO)).body.nodes[0];
  ok('… rewardState stays visible (ledger only): AWARDED cycle 1', eq(rs.rewardState, { state: 'AWARDED', cycle: 1 }));
  const sumNo = await progress(E, NO);
  ok('the summary stays visible with canViewOrders off: aggregates only (qualifiedForGroup 2), no per-affiliate delivered count',
    sumNo.status === 200 && sumNo.body.progress.qualifiedForGroup === 2 && eq(keys(sumNo.body.progress), SUMMARY_KEYS) && !/delivered/i.test(sumNo.text), sumNo.text);
  const on = Object.fromEntries(await Promise.all(Object.entries(views(NC)).map(async ([k, f]) => [k, await f()])));
  // Stage E: the list = N(R) → + the admin-created member c (3; Stage B: the 2 linked ones)
  ok('canCreateAffiliates off: every view 200 with the delivered values (12 / 6) — visibility unaffected; the list holds N(R) (3)',
    Object.values(on).every((r) => r.status === 200) && on.roots.body.nodes[0].progress.realDelivered === 12 && on.grand.body.nodes[0].progress.realDelivered === 6
    && on.list.body.affiliates.length === 3, JSON.stringify(on.roots.body).slice(0, 200));
  const pure = PS.nodeProgress({ identityStatus: 'APPROVED', orders: { real: { delivered: 12 } } }, { individualThreshold: 10, groupThreshold: 5 }, false);
  ok('service: nodeProgress without orders → delivered values null (only thresholds / identity)', eq(pure, { realDelivered: null, individualThreshold: 10, groupThreshold: 5, identityApproved: true, qualifiedIndividual: null, qualifiedGroup: null }));
  const vNull = V.toRecruiterNetworkNodeView({ id: 'x', linkedToMe: true, progress: { realDelivered: null, individualThreshold: 10, groupThreshold: 5, identityApproved: true, qualifiedIndividual: true, qualifiedGroup: true } });
  ok('projection: without a delivered count, qualified values are forced to null (no alternate field leaks it)', vNull.progress.qualifiedIndividual === null && vNull.progress.qualifiedGroup === null);
}

// ── 7. the summary equals the group reward's count ───────────────────────────
console.log('\n7. Summary: qualifiedForGroup = syncRecruiterGroupReward\'s count; progress toward the next group');
{
  const E = setup();
  settings(E, { groupSize: 3, groupMinDeliveredSales: 5 });
  const mk = (rec, n, approved, parentId = null) => { const a = aff(E, rec, { parentId }); orders(E, a, n); if (approved) E.db._seed.identity({ affiliateId: a.id, status: 'APPROVED' }); orders(E, a, 7, 'delivered', true); return a; };
  const r = mk(E.A, 5, true);
  mk(E.A, 6, true, r.id); mk(E.A, 4, true, r.id); mk(E.A, 9, false, r.id); // 4 (too few) and not approved: never counted
  const s0 = (await progress(E, E.A)).body.progress;
  const g0 = await RS.syncRecruiterGroupReward(E.A.id, { db: E.db, now: new Date(T0) });
  ok(`2 qualified members (fake orders, < 5 and non-APPROVED excluded): summary ${s0.qualifiedForGroup} = sync ${g0.qualified}; no group reward yet; progress "2 / 3"`,
    s0.qualifiedForGroup === 2 && g0.qualified === 2 && g0.awarded === 0 && s0.progressTowardNextGroup === 2 && s0.groupSize === 3 && s0.activeGroupRewards === 0 && s0.groupEnabled === true && s0.individualEnabled === true, JSON.stringify([s0, g0]));
  mk(null, 9, true, r.id); // Stage E: an admin-created (invited) member counts like a linked one
  const g1 = await RS.syncRecruiterGroupReward(E.A.id, { db: E.db, now: new Date(T0) });
  const s1 = (await progress(E, E.A)).body.progress;
  ok(`Stage E: + an invited (non-linked) qualified member → 3 qualified: summary ${s1.qualifiedForGroup} = sync ${g1.qualified}; one group reward (3); progress "0 / 3"`,
    s1.qualifiedForGroup === 3 && g1.qualified === 3 && g1.awarded === 1 && s1.progressTowardNextGroup === 0 && s1.activeGroupRewards === 1, JSON.stringify([s1, g1]));
  mk(E.A, 5, true, r.id); mk(E.A, 8, true, r.id);
  const g2 = await RS.syncRecruiterGroupReward(E.A.id, { db: E.db, now: new Date(T0) });
  const s2 = (await progress(E, E.A)).body.progress;
  ok(`5 qualified → still one group reward (floor(5 / 3)) and "2 / 3" toward the next; summary ${s2.qualifiedForGroup} = sync ${g2.qualified}`,
    g2.awarded === 0 && s2.qualifiedForGroup === 5 && g2.qualified === 5 && s2.activeGroupRewards === 1 && s2.progressTowardNextGroup === 2
    && eq(s2.rewards.group, { awarded: 1, awardedCents: 5000, reversed: 0, reversedCents: 0 }), JSON.stringify([s2, g2]));
  ok('progressTowardNextGroup clamps to [0, groupSize]', V.toRecruiterProgressSummaryView({ groupSize: 3, progressTowardNextGroup: 9 }).progressTowardNextGroup === 3
    && V.toRecruiterProgressSummaryView({ groupSize: 3, progressTowardNextGroup: -2 }).progressTowardNextGroup === 0);
  const empty = (await progress(E, E.C));
  ok('a recruiter without affiliates: zeros, no network statement (only the links count, settings and ledger)', empty.status === 200 && empty.body.progress.linkedAffiliates === 0 && empty.body.progress.downlineAffiliates === 0
    && empty.body.progress.qualifiedForGroup === 0 && empty.body.progress.progressTowardNextGroup === 0);
  const dis = E.db._seed.recruiter({ username: 'dl.off', name: 'Disabled', isActive: false, disabledAt: new Date(), disabledBy: 'admin' });
  ok('a disabled recruiter → 403 RECRUITER_DISABLED; no token → 401', (await progress(E, dis)).text === '{"code":"RECRUITER_DISABLED"}'
    && (await call(E.progress, req('/api/recruiter/progress'))).status === 401);
  const L = setup({ rateLimit: realRateLimit });
  const ip = `10.71.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
  const codes = [];
  for (let i = 0; i < RECRUITER_PROGRESS_RATE.max + 1; i++) codes.push((await call(L.progress, req('/api/recruiter/progress', { cookie: cookieOf(L.A), ip }))).status);
  ok(`rate limited like the network endpoints: ${RECRUITER_PROGRESS_RATE.max} per minute per recruiter, then 429 RATE_LIMITED`, RECRUITER_PROGRESS_RATE.max === 120 && codes.slice(0, 120).every((c) => c === 200) && codes[120] === 429);
  const route = stripJs(read('src/app/api/recruiter/progress/route.js'));
  ok('route: only GET = withRecruiterAuth(h.summary), imports recruiterVisibility', /export const GET = withRecruiterAuth\(h\.summary\);/.test(route) && /from '@\/lib\/recruiterVisibility'/.test(route)
    && [...route.matchAll(/export\s+const\s+([A-Z]+)\b/g)].map((m) => m[1]).join() === 'GET');
  const hostile = V.toRecruiterProgressSummaryView(JSON.parse('{"__proto__":{"x":1},"linkedAffiliates":-1,"groupSize":"3","qualifiedForGroup":2.5,"rewards":{"individual":{"awardedCents":"9"}},"secret":1}'));
  ok('summary projection: exact keys, hostile values → 0 / null', eq(keys(hostile), SUMMARY_KEYS) && hostile.linkedAffiliates === 0 && hostile.groupSize === null && hostile.qualifiedForGroup === 0 && hostile.rewards.individual.awardedCents === 0);
}

// ── 8. the paged affiliate list ───────────────────────────────────────────────
console.log('\n8. Affiliate list: keyset pages (0, 1, 99, 100, 101), cursor continuation, ties, search + total');
{
  for (const n of [0, 1, 99, 100, 101]) {
    const E = setup();
    const ids = []; for (let i = 0; i < n; i++) ids.push(aff(E, E.A, { createdAt: new Date(T0 + Math.floor(i / 3) * 1000) }).id); // createdAt ties by 3
    const expected = E.db._tables.recruiterAffiliateLink.filter((l) => l.recruiterId === E.A.id)
      .sort((x, y) => y.createdAt - x.createdAt || (x.affiliateId < y.affiliateId ? -1 : x.affiliateId > y.affiliateId ? 1 : 0)).map((l) => l.affiliateId);
    const seen = []; const totals = []; let cursor = null; let pages = 0;
    do {
      const r = await list(E, E.A, { limit: '100', ...(cursor ? { cursor } : {}) });
      seen.push(...r.body.affiliates.map((v) => v.id)); totals.push(r.body.total); cursor = r.body.nextCursor; pages += 1;
      if (r.status !== 200) break;
    } while (cursor && pages < 5);
    ok(`${n} affiliates, limit 100: ${pages} page(s), every affiliate once in (createdAt DESC, id) order through createdAt ties, total ${n} on every page, nextCursor null at the end`,
      eq(seen, expected) && totals.every((t) => t === n) && pages === Math.max(1, Math.ceil(n / 100)) && cursor === null, JSON.stringify({ seen: seen.length, pages, totals }));
    const small = []; cursor = null; let guard = 0;
    do { const r = await list(E, E.A, { limit: '7', ...(cursor ? { cursor } : {}) }); small.push(...r.body.affiliates.map((v) => v.id)); cursor = r.body.nextCursor; } while (cursor && ++guard < 40);
    ok(`${n} affiliates, limit 7: the same sequence (no gap, no duplicate across cursor pages)`, eq(small, expected));
    const dflt = await list(E, E.A);
    ok(`${n} affiliates, no paging parameter: the former page — at most 50, truncated = more exist, items keep the 5 former fields`,
      dflt.body.affiliates.length === Math.min(50, n) && dflt.body.truncated === (n > 50) && (n > 50 ? typeof dflt.body.nextCursor === 'string' : dflt.body.nextCursor === null)
      && dflt.body.affiliates.every((v) => eq(keys(v), LIST_ITEM_KEYS)));
  }
  const E = setup();
  const a = aff(E, E.A, { username: 'fatima.one', name: 'Fatima Zahra' }); aff(E, E.A, { username: 'youssef', name: 'Youssef' }); aff(E, E.A, { username: 'fatima.two', name: 'F2', parentId: a.id });
  aff(E, E.B, { username: 'fatima.b' }); aff(E, null, { username: 'fatima.admin', parentId: a.id });
  const q1 = await list(E, E.A, { q: 'FATIMA', limit: '1' });
  const q2 = await list(E, E.A, { q: 'FATIMA', limit: '1', cursor: q1.body.nextCursor });
  const q3 = await list(E, E.A, { q: 'FATIMA', limit: '1', cursor: q2.body.nextCursor });
  // Stage E: the list is N(A) — the admin-created descendant under A's affiliate is A's (Stage B: linked only)
  ok('Stage E: search q (username / name, case-insensitive) with total and cursor continuation over N(A): the invited admin-created descendant and A\'s 2 linked ones, never B\'s',
    q1.body.total === 3 && [q1, q2, q3].every((q) => q.body.affiliates.length === 1) && q3.body.nextCursor === null
    && eq([q1, q2, q3].map((q) => [q.body.affiliates[0].username, q.body.affiliates[0].linkedToMe]), [['fatima.admin', false], ['fatima.two', true], ['fatima.one', true]]), JSON.stringify([q1.body, q2.body]).slice(0, 300));
  const wild = await Promise.all(['%', '_', 'fatima%one', 'fatima_one', '\\'].map((q) => list(E, E.A, { q })));
  ok('search wildcards are literal (%, _ and \\ escaped): "%" / "_" / "fatima%one" / "\\" match nothing, "fatima_one" matches nothing (the name is fatima.one)',
    wild.every((r) => r.status === 200 && r.body.total === 0), wild.map((r) => r.body.total).join(','));
  const bad = await Promise.all([{ cursor: 'abc' }, { cursor: '1.bad id' }, { cursor: '-1.x' }, { limit: 'x' }, { limit: '-1' }, { cursor: `1.${'x'.repeat(101)}` }].map((p) => list(E, E.A, p)));
  ok('a malformed cursor / limit → 400 INVALID_INPUT', bad.every((r) => r.status === 400 && r.text === '{"code":"INVALID_INPUT"}'), bad.map((r) => r.status).join(','));
  const capped = await list(E, E.A, { limit: '500' });
  ok('limit > 100 is capped (all 4 of N(A) here — Stage E: + the invited one), limit 0 → 1', capped.body.affiliates.length === 4 && (await list(E, E.A, { limit: '0' })).body.affiliates.length === 1);
  const svcBad = await Promise.all([{ cursor: 'x' }, { cursor: 5 }].map((o) => import('../src/lib/services/recruiterAffiliateService.js').then((m) => m.listRecruiterNetwork(E.A.id, { db: E.db, ...o })).then(() => 'resolved', (e) => e.code)));
  ok('service: a malformed cursor → INVALID_INPUT', svcBad.every((c) => c === 'INVALID_INPUT'), svcBad.join(','));
  const hostile = V.toRecruiterAffiliateListItemView(JSON.parse('{"__proto__":{"x":1},"id":"a","username":3,"isActive":true,"status":"active","identityStatus":"approved","level":0,"parent":{"id":"p","username":"u","phone":"+2126","linkedToMe":"yes"},"progress":{"realDelivered":-1,"individualThreshold":0,"qualifiedGroup":true},"rewardState":{"state":"PAID","cycle":2},"password":"h"}'), new Set());
  ok('list item projection: exact keys; hostile values → null / NONE / false; no password / phone / isActive passthrough',
    eq(keys(hostile), LIST_ITEM_KEYS) && hostile.username === null && hostile.status === null && hostile.identityStatus === 'NONE' && hostile.level === null
    && eq(hostile.parent, { id: 'p', username: 'u', name: null, linkedToMe: false }) && hostile.progress.realDelivered === null && hostile.progress.qualifiedGroup === null
    && hostile.progress.individualThreshold === null && eq(hostile.rewardState, { state: 'NONE', cycle: null }) && !/password|phone|isActive/.test(JSON.stringify(hostile)));
}

// ── 9. brute-force oracle on seeded random forests ───────────────────────────
console.log('\n9. Stage F: a brute-force oracle of N(R) (owner by definition — topmost link) agrees with every endpoint on seeded random forests (nested links, unlinked descendants, cycles)');
{
  const rand = (s) => () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // Stage F oracle, straight from the definition: walk the parents with a visited set; owner(X) = the recruiter of the
  // TOPMOST linked affiliate when the walk reaches a top; on a parent cycle (a revisit) the one recruiter of every link
  // met, none when several. A member X of N(R) is PLACED when its chain reaches a top; level = 1 + the steps from X up
  // to the topmost link (its root).
  const oracle = (affs, links, rid) => {
    const byId = new Map(affs.map((a) => [a.id, a]));
    const linkOf = new Map(links.map((l) => [l.affiliateId, l.recruiterId]));
    const chainOf = (id) => { const seen = new Set(); const path = []; let cur = id; for (; cur != null && byId.has(cur) && !seen.has(cur); cur = byId.get(cur).parentId ?? null) { seen.add(cur); path.push(cur); } return { path, cycle: cur != null && seen.has(cur) }; };
    const owner = (id) => { const { path, cycle } = chainOf(id); const rids = path.filter((x) => linkOf.has(x)).map((x) => linkOf.get(x)); const set = new Set(rids); if (set.size === 1) return rids[0]; if (set.size > 1 && !cycle) return rids[rids.length - 1]; return null; };
    const own = new Map(affs.map((a) => [a.id, owner(a.id)]));
    const place = new Map();
    for (const a of affs) {
      if (own.get(a.id) !== rid) { place.set(a.id, null); continue; }
      const { path, cycle } = chainOf(a.id);
      if (cycle) { place.set(a.id, null); continue; } // a chain without a top: unplaced
      let top = -1; path.forEach((x, i) => { if (linkOf.has(x)) top = i; });
      place.set(a.id, top + 1);
    }
    const mine = new Set(links.filter((l) => l.recruiterId === rid).map((l) => l.affiliateId));
    const members = new Set(affs.filter((a) => own.get(a.id) === rid).map((a) => a.id));
    // Stage F: R's own links inside N(R) (a legacy link of R inside another recruiter's network is not R's)
    const mineIn = new Set([...mine].filter((id) => members.has(id)));
    return { place, mine, mineIn, members, byId, own };
  };
  let checks = 0; const mism = [];
  for (let seed = 1; seed <= 16; seed++) {
    const rnd = rand(seed * 104729);
    const E = setup();
    const ids = [];
    for (let i = 0, n = 25 + Math.floor(rnd() * 30); i < n; i++) {
      const parentId = ids.length && rnd() < 0.85 ? ids[Math.floor(rnd() * ids.length)] : null;
      const o = rnd();
      const a = aff(E, o < 0.45 ? E.A : o < 0.7 ? E.B : null, { parentId, createdAt: new Date(T0 + Math.floor(rnd() * 5) * 1000), isActive: rnd() < 0.5 });
      ids.push(a.id);
      if (rnd() < 0.4) orders(E, a, 1 + Math.floor(rnd() * 3), rnd() < 0.7 ? 'delivered' : 'pending', rnd() < 0.2);
      if (rnd() < 0.4) E.db._seed.identity({ affiliateId: a.id, status: rnd() < 0.6 ? 'APPROVED' : 'PENDING' });
    }
    for (let k = Math.floor(rnd() * 4); k > 0; k--) { const row = E.db._tables.affiliate[Math.floor(rnd() * ids.length)]; row.parentId = rnd() < 0.3 ? row.id : ids[Math.floor(rnd() * ids.length)]; }
    const sizes = [];
    for (const rec of [E.A, E.B]) {
      const O = oracle(E.db._tables.affiliate, E.db._tables.recruiterAffiliateLink, rec.id);
      const placed = [...O.place].filter(([, l]) => l !== null);
      const byCreated = (x, y) => (O.byId.get(x).createdAt - O.byId.get(y).createdAt) || (x < y ? -1 : x > y ? 1 : 0);
      const roots = placed.filter(([, l]) => l === 1).map(([id]) => id).sort(byCreated);
      const r = (await nodes(E, rec, { limit: '100' })).body;
      checks += 1; if (!eq(r.nodes.map((v) => v.id), roots)) mism.push(`seed ${seed} ${rec.username} roots`);
      const st = (await stats(E, rec)).body.stats;
      const lv = new Map(); for (const [, l] of placed) lv.set(l, (lv.get(l) || 0) + 1);
      const unplacedExp = [...O.mineIn].filter((id) => O.place.get(id) === null).length;
      checks += 1; if (!eq(st.levels.map((l) => [l.level, l.affiliates]), [...lv].sort((x, y) => x[0] - y[0])) || st.totals.unplaced !== unplacedExp) mism.push(`seed ${seed} ${rec.username} stats`);
      const un = (await nodes(E, rec, { view: 'unplaced', limit: '100' })).body;
      checks += 1; if (!eq(un.nodes.map((v) => v.id).sort(), [...O.mineIn].filter((id) => O.place.get(id) === null).sort())) mism.push(`seed ${seed} ${rec.username} unplaced`);
      for (const id of ids) {
        const lev = O.place.get(id);
        const kids = (await nodes(E, rec, { parentId: id, limit: '100' }));
        checks += 1;
        if (lev === null) { if (!NF(kids)) mism.push(`seed ${seed} ${rec.username} ${id} should be NOT_FOUND`); continue; }
        const expKids = E.db._tables.affiliate.filter((a) => a.parentId === id && O.members.has(a.id)).map((a) => a.id).sort(byCreated);
        if (kids.status !== 200 || kids.body.parent.level !== lev || !eq(kids.body.nodes.map((v) => [v.id, v.level, v.linkedToMe]), expKids.map((k) => [k, lev + 1, O.mine.has(k)]))) mism.push(`seed ${seed} ${rec.username} children of ${id}`);
        const sub = (await stats(E, rec, id)).body.stats;
        checks += 1;
        if (sub.levels.length && sub.levels[0].level !== lev + 1) mism.push(`seed ${seed} ${rec.username} sub levels of ${id}`);
      }
      const sum = (await progress(E, rec)).body.progress;
      checks += 1; if (sum.downlineAffiliates !== O.members.size || sum.linkedAffiliates !== O.mineIn.size) mism.push(`seed ${seed} ${rec.username} summary ${sum.downlineAffiliates}/${O.members.size}`);
      const pl = await S.getAffiliatePlacement(rec.id, [...O.members].slice(0, 100), { db: E.db });
      checks += 1; if (![...O.members].slice(0, 100).every((id) => pl.get(id).level === O.place.get(id))) mism.push(`seed ${seed} ${rec.username} list placement`);
      const lst = (await list(E, rec, { limit: '100' })).body;
      checks += 1; if (lst.total !== O.members.size || !eq(lst.affiliates.map((v) => v.id).sort(), [...O.members].sort())) mism.push(`seed ${seed} ${rec.username} list = N(R)`);
      for (const id of ids) {
        const owner = await RS.findAffiliateOwner(id, { db: E.db });
        checks += 1; if ((owner === rec.id) !== O.members.has(id) || owner !== O.own.get(id)) mism.push(`seed ${seed} ${rec.username} owner of ${id}`);
      }
      sizes.push(O.members);
    }
    const unowned = ids.filter((id) => !sizes[0].has(id) && !sizes[1].has(id)).length;
    checks += 1; if ([...sizes[0]].some((id) => sizes[1].has(id)) || sizes[0].size + sizes[1].size + unowned !== ids.length) mism.push(`seed ${seed} one owner per affiliate`);
  }
  ok(`Stage F: oracle = endpoints on 16 random forests (A / B / unlinked mix, nested links, re-parenting cycles, self-parents): ${checks} checks — roots, stats levels + unplaced, unplaced view, every node's children / level / NOT_FOUND, sub-network levels, summary counts, list placement, list = N(R), findAffiliateOwner, at most one owner per affiliate`,
    mism.length === 0 && checks > 1000, mism.slice(0, 5).join(' | '));
}

// ── 10. static ───────────────────────────────────────────────────────────────
console.log('\n10. Static: read-only, no money logic in the progress code');
{
  const ps = stripJs(read('src/lib/services/recruiterProgressService.js'));
  const ph = stripJs(read('src/lib/recruiterProgressHandlers.js'));
  ok('the progress service and handler write nothing (no create / update / upsert / delete / $executeRaw / $transaction)',
    [ps, ph].every((c) => !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$transaction/.test(c)));
  const models = new Set([...ps.matchAll(/\bdb\.(\$?\w+)/g)].map((m) => m[1]));
  ok('the progress service reads only links (count), the ledger (findMany / groupBy), identity (count) — orders only through the network service', eq([...models].sort(), ['identityVerification', 'recruiterAffiliateLink', 'recruiterRewardLedger'])
    && !/affiliateOrder|affiliate_orders|\$queryRaw/.test(ps), [...models].join(','));
  const ns = stripJs(read('src/lib/services/recruiterNetworkService.js'));
  // Stage F: the cycle-capable walks are UNION — ancestry 1; the roots' upward walk `up` in roots / unplaced / stats ×2 /
  // downline / progress-qualified (6); the cyclic part's `oup` in unplaced / stats ×2 / downline / progress-qualified (5)
  // and `cnet` in downline / progress-qualified (2) = 14 (Stage E: 7); the placed walks down from a root are UNION ALL + cap
  ok('Stage F: the network service: every recursive walk is a LATERAL … OFFSET 0 index walk; the cycle-capable walks (ancestry, up, oup, cnet) use UNION', (ns.match(/CROSS JOIN LATERAL \(/g) || []).length >= 14
    && (ns.match(/\n\s*UNION\n/g) || []).length === 14 && !/\$queryRawUnsafe|\$executeRaw/.test(ns));
  const before = JSON.stringify(setup().db._tables);
  ok('sanity: a fresh fake has the expected empty tables', before.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
