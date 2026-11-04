#!/usr/bin/env node
/**
 * scripts/recruiterNetwork.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 4: the recruiter's network tree and statistics
 * (GET /api/recruiter/network/stats and /api/recruiter/network/nodes, READ-ONLY).
 * In-memory fake database only (scripts/lib/recruiterFakeDb.mjs, phase4 mode: the recursive
 * network query emulated row for row, order counts via groupBy, identity status only).
 * Proves:
 *   • unlimited depth (3, 10, 20, 200 levels), full breadcrumb at level 150
 *   • several roots, several recruiters: each sees ONLY their own network; anything outside
 *     (another network, unlinked, unknown, malformed id) → the same 404 NOT_FOUND
 *   • unlinked children are never shown or counted; an unlinked parent makes a root
 *   • malformed data (parent cycles) never loops: unplaced, listed by view=unplaced
 *   • large network (6000, > one 5000-id chunk): exact totals, pagination, bounded and
 *     size / depth independent query counts (no N+1)
 *   • real vs fake orders always separate; status buckets; identity and activation counts
 *   • sub-network statistics (levels relative to the chosen affiliate)
 *   • exact output keys, no sensitive field anywhere, error bodies { code } only
 *   • account state, token isolation, rate limit, read-only (no write anywhere)
 *   • the projections resist hostile input
 * Run: node scripts/recruiterNetwork.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-network-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const { recruiterNetworkHandlers, RECRUITER_NETWORK_RATE } = await import('../src/lib/recruiterNetworkRouteHandlers.js');
const S = await import('../src/lib/services/recruiterNetworkService.js');
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
const ORDER_KEYS = ['cancelled', 'confirmed', 'delivered', 'other', 'pending', 'returned', 'shipped', 'total'];
const NODE_KEYS = ['childrenCount', 'descendantsCount', 'id', 'identityStatus', 'level', 'name', 'orders', 'status', 'username'];
const PATH_KEYS = ['id', 'level', 'name', 'username'];
const PAGE_KEYS = ['nextCursor', 'nodes', 'parent', 'path', 'total'];
const STATS_KEYS = ['identity', 'levels', 'orders', 'rootId', 'totals'];
const TOTAL_KEYS = ['active', 'affiliates', 'direct', 'inactive', 'maxLevel', 'unplaced'];
const LEVEL_KEYS = ['active', 'affiliates', 'identity', 'inactive', 'level', 'orders'];
const ID_KEYS = ['APPROVED', 'NONE', 'PENDING', 'REJECTED'];
const zeroOrders = () => ({ delivered: 0, pending: 0, confirmed: 0, shipped: 0, cancelled: 0, returned: 0, other: 0, total: 0 });
// Secrets seeded into the fake rows: none may ever appear in a response.
const SECRETS = ['HASH-SECRET-PWD', '+212699999999', 'CLIENT-SECRET-NAME', '+212688888888', '777.77', 'secret/front.jpg', 'secret/back.jpg', 'REJECT-REASON-SECRET'];

const req = (url, { cookie, bearer, ip } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (ip) headers['x-forwarded-for'] = ip;
  return new Request(`http://localhost${url}`, { method: 'GET', headers });
};
const call = async (handler, r) => {
  const res = await handler(r, {});
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, cache: res.headers.get('cache-control') };
};
const recruiterToken = (id, username = 'x') => signToken({ recruiterId: id, username, type: 'recruiter' });
const cookieOf = (rec) => `recruiter_token=${recruiterToken(rec.id, rec.username)}`;

function setup({ rateLimit = noLimit, hooks } = {}) {
  const db = makeRecruiterFakeDb({ phase4: true, ...(hooks ? { hooks } : {}) });
  const A = db._seed.recruiter({ username: 'net.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'net.b', name: 'Recruteur B' });
  const h = recruiterNetworkHandlers({ db, rateLimit });
  return { db, A, B, stats: withRecruiterAuth(h.stats), nodes: withRecruiterAuth(h.nodes) };
}
let uniq = 0;
/** An affiliate (linked to `rec` when given), with deterministic increasing createdAt. */
const aff = (E, rec, over = {}) => {
  uniq += 1;
  const a = E.db._seed.affiliate({ username: `u${uniq}`, name: `Affilié ${uniq}`, password: 'HASH-SECRET-PWD', createdAt: new Date(T0 + uniq * 1000), ...over });
  if (rec) E.db._seed.link({ affiliateId: a.id, recruiterId: rec.id, createdAt: a.createdAt }); // linked when created
  return a;
};
const chain = (E, rec, n, parentId = null) => {
  const ids = [];
  let p = parentId;
  for (let i = 0; i < n; i++) { const a = aff(E, rec, { parentId: p }); ids.push(a.id); p = a.id; }
  return ids;
};
const stats = (E, rec, rootId) => call(E.stats, req(`/api/recruiter/network/stats${rootId !== undefined ? `?rootId=${encodeURIComponent(rootId)}` : ''}`, { cookie: cookieOf(rec) }));
const nodes = (E, rec, params = {}) => {
  const q = new URLSearchParams(params).toString();
  return call(E.nodes, req(`/api/recruiter/network/nodes${q ? `?${q}` : ''}`, { cookie: cookieOf(rec) }));
};
const qc = (E) => E.db._queryCount();
const measure = async (E, fn) => { const b = qc(E); const r = await fn(); return { r, queries: qc(E) - b }; };
const allResponses = [];
const track = (r) => { allResponses.push(r); return r; };
const errorBodyOk = (b) => b && typeof b === 'object' && eq(keys(b), ['code']);

// ── 1. unlimited depth ──────────────────────────────────────────────────────
console.log('\n1. Unlimited depth (3, 10, 20, 200 levels)');
{
  for (const depth of [4, 11, 21]) {
    const E = setup();
    const ids = chain(E, E.A, depth);
    const s = track(await stats(E, E.A));
    const t = s.body.stats.totals;
    ok(`a ${depth}-level chain: ${depth} affiliates, 1 direct, maxLevel ${depth}, one entry per level`,
      s.status === 200 && t.affiliates === depth && t.direct === 1 && t.maxLevel === depth && t.unplaced === 0
      && eq(s.body.stats.levels.map((l) => [l.level, l.affiliates]), ids.map((_, i) => [i + 1, 1])), s.text.slice(0, 300));
    const last = track(await nodes(E, E.A, { parentId: ids[depth - 2] }));
    ok(`a ${depth}-level chain: the deepest node is listed at level ${depth} under its parent`,
      last.status === 200 && last.body.nodes.length === 1 && last.body.nodes[0].id === ids[depth - 1] && last.body.nodes[0].level === depth
      && last.body.parent.id === ids[depth - 2] && last.body.parent.level === depth - 1, last.text.slice(0, 300));
  }

  const E = setup();
  const ids = chain(E, E.A, 200);
  const { r: s, queries: qs } = await measure(E, () => stats(E, E.A));
  ok('a 200-level chain: all 200 levels reported, levels 1…200 each with exactly 1 affiliate',
    s.status === 200 && s.body.stats.totals.affiliates === 200 && s.body.stats.totals.maxLevel === 200
    && s.body.stats.levels.length === 200 && s.body.stats.levels.every((l, i) => l.level === i + 1 && l.affiliates === 1));
  const { r: n150, queries: qn } = await measure(E, () => nodes(E, E.A, { parentId: ids[149] }));
  ok('nodes?parentId = the level-150 affiliate → breadcrumb = its full ancestry from level 1 (150 entries, in order)',
    n150.status === 200 && n150.body.path.length === 150 && n150.body.path.every((p, i) => p.id === ids[i] && p.level === i + 1 && typeof p.username === 'string')
    && n150.body.path.every((p) => eq(keys(p), PATH_KEYS)), `${n150.body.path?.length}`);
  ok('… its only child is the level-151 affiliate with 49 descendants', n150.body.nodes.length === 1 && n150.body.nodes[0].id === ids[150]
    && n150.body.nodes[0].level === 151 && n150.body.nodes[0].childrenCount === 1 && n150.body.nodes[0].descendantsCount === 49);
  const roots = await nodes(E, E.A);
  ok('the root of the 200-level chain counts 199 descendants', roots.body.nodes.length === 1 && roots.body.nodes[0].descendantsCount === 199 && roots.body.nodes[0].level === 1);
  // No N+1: the same number of queries for 4 and for 200 levels.
  const E4 = setup();
  const ids4 = chain(E4, E4.A, 4);
  const { queries: qs4 } = await measure(E4, () => stats(E4, E4.A));
  const { queries: qn4 } = await measure(E4, () => nodes(E4, E4.A, { parentId: ids4[2] }));
  ok(`query count is independent of the depth: stats ${qs4} (4 levels) = ${qs} (200 levels) = 5; nodes ${qn4} = ${qn} = 6`, qs === 5 && qs4 === 5 && qn === 6 && qn4 === 6, `stats ${qs4}/${qs} nodes ${qn4}/${qn}`);
}

// ── 2. several roots, several recruiters, ownership ──────────────────────────
console.log('\n2. Several roots and recruiters: each sees only their own network');
{
  const E = setup();
  const a1 = aff(E, E.A); const a2 = aff(E, E.A); const a3 = aff(E, E.A);
  const b1 = aff(E, E.B);
  const a11 = aff(E, E.A, { parentId: a1.id });
  const b11 = aff(E, E.B, { parentId: b1.id });
  const bUnderA = aff(E, E.B, { parentId: a1.id }); // B-linked child under A's affiliate (cross data)
  const aUnderB = aff(E, E.A, { parentId: b1.id }); // A-linked child under B's affiliate → a root for A
  const adminLoose = aff(E, null);                  // unlinked (admin-created)
  const unlinkedChild = aff(E, null, { parentId: a1.id, username: 'adm.child' });

  const rA = track(await nodes(E, E.A));
  ok('A sees exactly its 4 roots (3 roots + the A affiliate whose parent is in B\'s network), oldest first',
    rA.status === 200 && eq(rA.body.nodes.map((n) => n.id), [a1.id, a2.id, a3.id, aUnderB.id]) && rA.body.total === 4 && rA.body.parent === null && eq(rA.body.path, []), rA.text.slice(0, 200));
  const rB = track(await nodes(E, E.B));
  ok('B sees its 2 roots (its own root + its affiliate under A\'s affiliate), never A\'s', eq(rB.body.nodes.map((n) => n.id), [b1.id, bUnderA.id]));
  const a1kids = track(await nodes(E, E.A, { parentId: a1.id }));
  ok('A\'s children of a1: only the A-linked child — not B\'s, not the unlinked admin-created child',
    eq(a1kids.body.nodes.map((n) => n.id), [a11.id]) && rA.body.nodes[0].childrenCount === 1 && rA.body.nodes[0].descendantsCount === 1);
  const sA = track(await stats(E, E.A)); const sB = track(await stats(E, E.B));
  ok('A\'s statistics count only A\'s 5 affiliates (4 direct); B\'s only B\'s 3 (2 direct)',
    sA.body.stats.totals.affiliates === 5 && sA.body.stats.totals.direct === 4 && sB.body.stats.totals.affiliates === 3 && sB.body.stats.totals.direct === 2);
  const allA = JSON.stringify([rA.body, a1kids.body, sA.body]);
  ok('no id of B\'s network or of unlinked affiliates ever appears in A\'s responses',
    [b1.id, b11.id, bUnderA.id, adminLoose.id, unlinkedChild.id].every((id) => !allA.includes(id)));

  const outside = [b1.id, b11.id, adminLoose.id, unlinkedChild.id, randomUUID(), 'bad id!', 'x'.repeat(101), '../etc', "a'b"];
  const viaNodes = await Promise.all(outside.map((id) => nodes(E, E.A, { parentId: id }).then(track)));
  const viaStats = await Promise.all(outside.map((id) => stats(E, E.A, id).then(track)));
  ok('A: parentId / rootId of B\'s affiliate, an unlinked affiliate, an unknown or malformed id → 404 { code: NOT_FOUND }, byte-identical',
    [...viaNodes, ...viaStats].every((r) => r.status === 404 && r.text === '{"code":"NOT_FOUND"}'), [...viaNodes, ...viaStats].map((r) => `${r.status}:${r.text}`).join(' | '));
  const bTries = await Promise.all([nodes(E, E.B, { parentId: a1.id }), stats(E, E.B, a11.id)].map((p) => p.then(track)));
  ok('B with A\'s affiliates → the same 404', bTries.every((r) => r.status === 404 && r.text === '{"code":"NOT_FOUND"}'));
  ok('an empty parentId / rootId means the whole network (roots / all)', (await nodes(E, E.A, { parentId: '' })).body.total === 4 && (await stats(E, E.A, '')).body.stats.totals.affiliates === 5);

  const empty = setup();
  const en = track(await nodes(empty, empty.A)); const es = track(await stats(empty, empty.A));
  ok('an empty network → 200 with no nodes and zero statistics (no levels)',
    en.status === 200 && eq(en.body, { parent: null, path: [], nodes: [], total: 0, nextCursor: null })
    && es.status === 200 && es.body.stats.totals.affiliates === 0 && eq(es.body.stats.levels, []) && es.body.stats.orders.real.total === 0);
}

// ── 3. malformed data ─────────────────────────────────────────────────────────
console.log('\n3. Malformed / cyclic data never loops');
{
  const values = [];
  const E = setup({ hooks: { before: (m, o, a) => { if (m === '$queryRaw') values.push(a.values); } } });
  const r = aff(E, E.A);
  const x = aff(E, E.A); const y = aff(E, E.A, { parentId: x.id });
  E.db._tables.affiliate.find((a) => a.id === x.id).parentId = y.id; // X ⇄ Y (corrupt)
  const z = aff(E, E.A, { parentId: x.id }); // a tail hanging off the cycle
  const self = aff(E, E.A); E.db._tables.affiliate.find((a) => a.id === self.id).parentId = self.id; // self-parent (corrupt)
  const loose = aff(E, null);
  const underLoose = aff(E, E.A, { parentId: loose.id }); // parent unlinked → a root
  const s = track(await stats(E, E.A));
  ok('a parent cycle (X ⇄ Y + a tail Z) and a self-parent: 4 members unplaced, the tree holds the other 2, nothing loops',
    s.status === 200 && s.body.stats.totals.unplaced === 4 && s.body.stats.totals.affiliates === 2 && s.body.stats.totals.direct === 2, s.text.slice(0, 300));
  ok('the depth cap bound passed to the recursive query = members + 1', values.length >= 1 && values.every((v) => v[3] === 7 && v[0] === E.A.id && v[1] === E.A.id && v[2] === E.A.id), JSON.stringify(values));
  const roots = track(await nodes(E, E.A));
  ok('roots: the normal root and the affiliate whose parent is unlinked (level 1); no cycle member',
    eq(roots.body.nodes.map((n) => n.id), [r.id, underLoose.id]) && roots.body.nodes.every((n) => n.level === 1));
  const un = track(await nodes(E, E.A, { view: 'unplaced' }));
  ok('view=unplaced lists exactly the 4 unreachable members (no level / status, no children), oldest first',
    un.status === 200 && eq(un.body.nodes.map((n) => n.id), [x.id, y.id, z.id, self.id]) && un.body.nodes.every((n) => n.level === null && n.status === null && n.childrenCount === 0 && eq(keys(n), NODE_KEYS)) && un.body.total === 4, un.text.slice(0, 300));
  const cyc = await Promise.all([nodes(E, E.A, { parentId: x.id }), stats(E, E.A, y.id), nodes(E, E.A, { parentId: self.id })].map((p) => p.then(track)));
  ok('a cycle member as parentId / rootId → 404 NOT_FOUND (not in the tree)', cyc.every((c) => c.status === 404 && c.text === '{"code":"NOT_FOUND"}'));
  ok('view=unplaced ignores parentId (still the unplaced list)', (await nodes(E, E.A, { view: 'unplaced', parentId: r.id })).body.total === 4);
  // Service-level: loadNetworkTree directly.
  const tree = await S.loadNetworkTree(E.A.id, { db: E.db });
  ok('loadNetworkTree: members 6, nodes 2, unplaced 4, roots in createdAt order', tree.members === 6 && tree.nodes.size === 2 && tree.unplaced === 4 && eq(tree.roots, [r.id, underLoose.id]));
  ok('loadNetworkTree refuses a malformed recruiter id (UNAUTHORIZED) before any query',
    await S.loadNetworkTree('bad id!', { db: E.db }).then(() => false, (e) => e.code === 'UNAUTHORIZED'));
}

// ── 4. large network, pagination, query counts ───────────────────────────────
console.log('\n4. Large network (6000 affiliates), pagination, bounded query counts');
{
  const E = setup();
  const roots = [];
  for (let i = 0; i < 150; i++) {
    const r = aff(E, E.A, { isActive: i % 2 === 0 });
    roots.push(r.id);
    for (let j = 0; j < 39; j++) aff(E, E.A, { parentId: r.id, isActive: false });
  }
  const all = E.db._tables.affiliate.map((a) => a.id);
  for (let i = 0; i < all.length; i++) {
    E.db._seed.order({ affiliateId: all[i], status: 'delivered', isFake: false, total: 777.77, clientName: 'CLIENT-SECRET-NAME', clientPhone: '+212688888888' });
    if (i % 3 === 0) E.db._seed.order({ affiliateId: all[i], status: 'delivered', isFake: true });
    if (i % 10 === 0) E.db._seed.identity({ affiliateId: all[i], status: 'APPROVED' });
  }
  const t0 = Date.now();
  const { r: s, queries: qs } = await measure(E, () => stats(E, E.A));
  const ms = Date.now() - t0;
  const st = s.body.stats;
  ok('6000 affiliates: totals exact (6000, 150 direct, 75 active, 5925 inactive, 2 levels)',
    s.status === 200 && st.totals.affiliates === 6000 && st.totals.direct === 150 && st.totals.active === 75 && st.totals.inactive === 5925 && st.totals.maxLevel === 2
    && eq(st.levels.map((l) => [l.level, l.affiliates]), [[1, 150], [2, 5850]]), JSON.stringify(st.totals));
  ok('6000 affiliates: orders real.delivered 6000, fake.delivered 2000 (never in real), identity APPROVED 600 / NONE 5400',
    st.orders.real.delivered === 6000 && st.orders.real.total === 6000 && st.orders.fake.delivered === 2000 && st.orders.fake.total === 2000
    && st.identity.APPROVED === 600 && st.identity.NONE === 5400);
  ok(`stats on 6000 affiliates: exactly 7 queries (recruiter + count + tree + 2×groupBy + 2×identity — chunks of 5000), observed ${qs}, ${ms} ms`, qs === 7, `${qs}`);
  const groupCalls = E.db._log.filter((l) => l.model === 'affiliateOrder').slice(-2);
  ok('the two order chunks hold 5000 + 1000 ids', groupCalls.length === 2 && groupCalls[0].where.affiliateId.in.length === 5000 && groupCalls[1].where.affiliateId.in.length === 1000);

  const { r: p1, queries: qp } = await measure(E, () => nodes(E, E.A));
  ok(`roots page 1: 50 nodes by default, total 150, nextCursor 50; ${qp} queries (bounded: 6)`, p1.status === 200 && p1.body.nodes.length === 50 && p1.body.total === 150 && p1.body.nextCursor === 50 && qp === 6, `${qp}`);
  const seen = [];
  let cursor = 0; let pages = 0;
  while (cursor !== null && pages < 10) {
    const p = track(await nodes(E, E.A, { cursor: String(cursor), limit: '100' }));
    seen.push(...p.body.nodes.map((n) => n.id));
    cursor = p.body.nextCursor; pages += 1;
  }
  ok('limit=100 walks all 150 roots in 2 pages, in order, no duplicate, nextCursor null at the end', pages === 2 && eq(seen, roots));
  const capped = await nodes(E, E.A, { limit: '500' });
  ok('limit > 100 is capped to 100', capped.status === 200 && capped.body.nodes.length === 100 && capped.body.nextCursor === 100);
  const zero = await nodes(E, E.A, { limit: '0' });
  ok('limit=0 is handled (raised to 1 node, nextCursor 1)', zero.status === 200 && zero.body.nodes.length === 1 && zero.body.nextCursor === 1);
  const beyond = await nodes(E, E.A, { cursor: '9999' });
  ok('a cursor past the end → no node, nextCursor null', beyond.status === 200 && beyond.body.nodes.length === 0 && beyond.body.nextCursor === null && beyond.body.total === 150);
  const kids = [];
  cursor = 0;
  while (cursor !== null) { const p = await nodes(E, E.A, { parentId: roots[7], limit: '10', cursor: String(cursor) }); kids.push(...p.body.nodes); cursor = p.body.nextCursor; }
  ok('children of one root paginate (10 per page) to its 39 children, all level 2', kids.length === 39 && new Set(kids.map((k) => k.id)).size === 39 && kids.every((k) => k.level === 2));
  const bad = await Promise.all([{ cursor: 'abc' }, { cursor: '-1' }, { cursor: '1.5' }, { limit: 'x' }, { limit: '-5' }, { limit: '1e3' }, { cursor: '01' }, { view: 'all' }, { view: 'UNPLACED' }].map((p) => nodes(E, E.A, p).then(track)));
  ok('a non-integer / negative cursor or limit, or an unknown view → 400 { code: INVALID_INPUT }', bad.every((r) => r.status === 400 && r.text === '{"code":"INVALID_INPUT"}'), bad.map((r) => r.status).join(','));
  const pageJson = JSON.stringify([p1.body, s.body]);
  ok('no customer name / phone / order amount in any page or statistic', SECRETS.every((x) => !pageJson.includes(x)));
}

// ── 5. orders: real vs fake, status buckets; identity; activation ────────────
console.log('\n5. Orders (real vs fake, buckets), identity and activation counts');
{
  ok('orderBucket: "delivered" ONLY for the exact value \'delivered\' (the reward rule) — Delivered / " delivered" / DELIVERED → other',
    eq(['delivered', 'Delivered', ' delivered', 'delivered ', 'DELIVERED'].map(S.orderBucket), ['delivered', 'other', 'other', 'other', 'other']));
  ok('orderBucket: the other buckets are trimmed and case-insensitive: Pending → pending, " SHIPPED " → shipped, canceled / CANCELLED → cancelled, refused / Refused / Returned → returned; unknown / empty / null / number → other',
    eq(['Pending', ' SHIPPED ', 'confirmed', 'canceled', 'CANCELLED', 'refused', 'Refused', 'Returned', 'lost', '', null, undefined, 42].map(S.orderBucket),
      ['pending', 'shipped', 'confirmed', 'cancelled', 'cancelled', 'returned', 'returned', 'returned', 'other', 'other', 'other', 'other', 'other']));
  ok('identityBucket: APPROVED / PENDING / REJECTED as is; anything else (approved, WEIRD, null) → NONE',
    eq(['APPROVED', 'PENDING', 'REJECTED', 'approved', 'WEIRD', null, undefined].map(S.identityBucket), ['APPROVED', 'PENDING', 'REJECTED', 'NONE', 'NONE', 'NONE', 'NONE']));

  const E = setup();
  const r = aff(E, E.A, { isActive: true });
  const c = aff(E, E.A, { parentId: r.id, isActive: false });
  const g = aff(E, E.A, { parentId: c.id, isActive: true });
  const other = aff(E, E.B);
  const loose = aff(E, null, { parentId: r.id });
  const o = (affiliateId, status, isFake = false) => E.db._seed.order({ affiliateId, status, isFake, total: 777.77, clientName: 'CLIENT-SECRET-NAME', clientPhone: '+212688888888' });
  for (const st of ['delivered', 'delivered', 'delivered', 'Delivered', 'canceled', 'refused', 'returned', 'weird', 'pending', 'confirmed', 'shipped']) o(r.id, st);
  o(r.id, 'delivered', true); o(r.id, 'delivered', true); o(r.id, 'pending', true);
  o(c.id, 'delivered'); o(c.id, 'shipped', true);
  o(g.id, 'cancelled'); o(g.id, 'delivered', true);
  o(other.id, 'delivered'); o(loose.id, 'delivered'); // never counted for A
  E.db._seed.identity({ affiliateId: r.id, status: 'APPROVED', rejectionReason: null });
  E.db._seed.identity({ affiliateId: c.id, status: 'REJECTED', rejectionReason: 'REJECT-REASON-SECRET' });
  E.db._seed.identity({ affiliateId: g.id, status: 'WEIRD' });
  E.db._seed.identity({ affiliateId: other.id, status: 'PENDING' });

  const s = track(await stats(E, E.A));
  const st = s.body.stats;
  // 'Delivered' (admin-typed capital D) is NOT a real delivered sale: it counts as other.
  const realExp = { delivered: 4, pending: 1, confirmed: 1, shipped: 1, cancelled: 2, returned: 2, other: 2, total: 13 };
  const fakeExp = { delivered: 3, pending: 1, confirmed: 0, shipped: 1, cancelled: 0, returned: 0, other: 0, total: 5 };
  ok('network orders: real and fake counted separately per bucket (fake delivered never in real.delivered)',
    eq(st.orders.real, realExp) && eq(st.orders.fake, fakeExp), JSON.stringify(st.orders));
  ok('each total = the sum of its buckets', ['real', 'fake'].every((k) => st.orders[k].total === Object.entries(st.orders[k]).filter(([b]) => b !== 'total').reduce((a, [, v]) => a + v, 0)));
  ok('orders of B\'s affiliate and of an unlinked affiliate are never counted for A', st.orders.real.delivered === 4 && st.orders.real.total === 13);
  ok('an admin-typed \'Delivered\' never counts as a real delivered order (it is in other); fake \'delivered\' never either', st.orders.real.delivered === 4 && st.orders.real.other === 2 && st.orders.fake.delivered === 3);
  ok('identity counts: APPROVED 1, REJECTED 1, unknown value → NONE (1), PENDING 0', eq(st.identity, { APPROVED: 1, PENDING: 0, REJECTED: 1, NONE: 1 }));
  ok('activation: 2 active, 1 inactive', st.totals.active === 2 && st.totals.inactive === 1);
  ok('per level: level 1 (r), level 2 (c), level 3 (g) with their own orders, identity and activation',
    eq(st.levels.map((l) => [l.level, l.affiliates, l.active, l.inactive, l.orders.real.delivered, l.orders.fake.delivered, l.orders.fake.shipped, l.identity.APPROVED, l.identity.REJECTED, l.identity.NONE]),
      [[1, 1, 1, 0, 3, 2, 0, 1, 0, 0], [2, 1, 0, 1, 1, 0, 1, 0, 1, 0], [3, 1, 1, 0, 0, 1, 0, 0, 0, 1]]), JSON.stringify(st.levels.map((l) => l.orders)));

  const roots = track(await nodes(E, E.A));
  const rn = roots.body.nodes[0];
  ok('per affiliate (node): r has its own real / fake counts, ACTIVE, APPROVED, 1 child, 2 descendants',
    rn.id === r.id && eq(rn.orders.real, { delivered: 3, pending: 1, confirmed: 1, shipped: 1, cancelled: 1, returned: 2, other: 2, total: 11 })
    && eq(rn.orders.fake, { ...zeroOrders(), delivered: 2, pending: 1, total: 3 }) && rn.status === 'ACTIVE' && rn.identityStatus === 'APPROVED' && rn.childrenCount === 1 && rn.descendantsCount === 2, JSON.stringify(rn));
  const cn = (await nodes(E, E.A, { parentId: r.id })).body.nodes[0];
  const gn = (await nodes(E, E.A, { parentId: c.id })).body.nodes[0];
  ok('per affiliate: c INACTIVE / REJECTED, g ACTIVE / NONE (unknown identity), each with only its own orders',
    cn.status === 'INACTIVE' && cn.identityStatus === 'REJECTED' && cn.orders.real.delivered === 1 && cn.orders.fake.shipped === 1
    && gn.status === 'ACTIVE' && gn.identityStatus === 'NONE' && gn.orders.real.cancelled === 1 && gn.orders.fake.delivered === 1 && gn.orders.real.delivered === 0);
  const D = setup();
  const d1 = aff(D, D.A);
  for (const st2 of ['Delivered', 'DELIVERED', ' delivered', 'delivered ']) D.db._seed.order({ affiliateId: d1.id, status: st2 });
  D.db._seed.order({ affiliateId: d1.id, status: 'delivered', isFake: true });
  const ds = (await stats(D, D.A)).body.stats;
  const dn = (await nodes(D, D.A)).body.nodes[0];
  ok('4 orders with a non-exact "delivered" spelling + 1 fake delivered → real.delivered 0 (other 4), fake.delivered 1 — in the statistics and on the node',
    ds.orders.real.delivered === 0 && ds.orders.real.other === 4 && ds.orders.fake.delivered === 1 && ds.levels[0].orders.real.delivered === 0
    && dn.orders.real.delivered === 0 && dn.orders.real.other === 4 && dn.orders.fake.delivered === 1);
  const noOrders = aff(E, E.A);
  const nn = (await nodes(E, E.A)).body.nodes.find((n) => n.id === noOrders.id);
  ok('an affiliate with no order and no identity row → all-zero counts, NONE', eq(nn.orders, { real: zeroOrders(), fake: zeroOrders() }) && nn.identityStatus === 'NONE' && nn.status === 'INACTIVE');
  const json = JSON.stringify([s.body, roots.body]);
  ok('no rejection reason, CIN file key, customer name / phone or amount anywhere', SECRETS.every((x) => !json.includes(x)));
}

// ── 6. sub-network statistics ────────────────────────────────────────────────
console.log('\n6. Sub-network statistics (rootId)');
{
  const E = setup();
  const R1 = aff(E, E.A, { isActive: true });
  const C1 = aff(E, E.A, { parentId: R1.id, isActive: true });
  const C2 = aff(E, E.A, { parentId: R1.id });
  const G1 = aff(E, E.A, { parentId: C1.id });
  const GG1 = aff(E, E.A, { parentId: G1.id, isActive: true });
  const R2 = aff(E, E.A);
  E.db._seed.order({ affiliateId: R1.id, status: 'delivered' });
  E.db._seed.order({ affiliateId: C1.id, status: 'delivered' });
  E.db._seed.order({ affiliateId: GG1.id, status: 'delivered' });
  E.db._seed.order({ affiliateId: GG1.id, status: 'delivered', isFake: true });
  const s1 = track(await stats(E, E.A, C1.id));
  ok('stats?rootId=C1: its 2 descendants (G1, GG1), direct 1, levels relative to C1 (1, 2), the root and its ancestors excluded',
    s1.status === 200 && s1.body.stats.rootId === C1.id && s1.body.stats.totals.affiliates === 2 && s1.body.stats.totals.direct === 1 && s1.body.stats.totals.maxLevel === 2
    && eq(s1.body.stats.levels.map((l) => [l.level, l.affiliates]), [[1, 1], [2, 1]]) && s1.body.stats.orders.real.delivered === 1 && s1.body.stats.orders.fake.delivered === 1
    && s1.body.stats.totals.active === 1 && s1.body.stats.totals.unplaced === 0, s1.text.slice(0, 300));
  const s2 = track(await stats(E, E.A, R1.id));
  ok('stats?rootId=R1: 4 descendants, 2 direct (C1, C2), 3 relative levels; R2 excluded',
    s2.body.stats.totals.affiliates === 4 && s2.body.stats.totals.direct === 2 && eq(s2.body.stats.levels.map((l) => [l.level, l.affiliates]), [[1, 2], [2, 1], [3, 1]]) && s2.body.stats.orders.real.delivered === 2);
  const leaf = track(await stats(E, E.A, C2.id));
  ok('stats of a leaf → zero affiliates, no levels', leaf.status === 200 && leaf.body.stats.totals.affiliates === 0 && eq(leaf.body.stats.levels, []));
  const whole = track(await stats(E, E.A));
  ok('the whole network: 6 affiliates, 2 direct, rootId null', whole.body.stats.rootId === null && whole.body.stats.totals.affiliates === 6 && whole.body.stats.totals.direct === 2 && R2.id);
  const n = track(await nodes(E, E.A, { parentId: G1.id }));
  ok('nodes?parentId=G1: parent G1 (level 3), breadcrumb R1 › C1 › G1, child GG1 (level 4)',
    eq(n.body.parent, { id: G1.id, username: G1.username, name: G1.name, level: 3 }) && eq(n.body.path.map((p) => p.id), [R1.id, C1.id, G1.id]) && n.body.nodes[0].id === GG1.id && n.body.nodes[0].level === 4);
}

// ── 7. exact output keys, no sensitive field ─────────────────────────────────
console.log('\n7. Exact output keys; no sensitive field anywhere');
{
  const E = setup();
  const r = aff(E, E.A, { phone: '+212699999999' });
  const c = aff(E, E.A, { parentId: r.id, phone: '+212600000002' });
  E.db._seed.order({ affiliateId: r.id, status: 'delivered', total: 777.77, clientName: 'CLIENT-SECRET-NAME', clientPhone: '+212688888888' });
  E.db._seed.identity({ affiliateId: c.id, status: 'REJECTED', rejectionReason: 'REJECT-REASON-SECRET' });
  const s = await stats(E, E.A);
  const p = await nodes(E, E.A, { parentId: r.id });
  ok('stats: exact keys at every level (stats, totals, identity, orders.real/fake, levels[])',
    eq(keys(s.body), ['stats']) && eq(keys(s.body.stats), STATS_KEYS) && eq(keys(s.body.stats.totals), TOTAL_KEYS) && eq(keys(s.body.stats.identity), ID_KEYS)
    && eq(keys(s.body.stats.orders), ['fake', 'real']) && eq(keys(s.body.stats.orders.real), ORDER_KEYS) && eq(keys(s.body.stats.orders.fake), ORDER_KEYS)
    && s.body.stats.levels.every((l) => eq(keys(l), LEVEL_KEYS) && eq(keys(l.identity), ID_KEYS) && eq(keys(l.orders.real), ORDER_KEYS) && eq(keys(l.orders.fake), ORDER_KEYS)));
  ok('nodes: exact keys of the page, the parent, the breadcrumb and every node',
    eq(keys(p.body), PAGE_KEYS) && eq(keys(p.body.parent), PATH_KEYS) && p.body.path.every((x) => eq(keys(x), PATH_KEYS))
    && p.body.nodes.every((n) => eq(keys(n), NODE_KEYS) && eq(keys(n.orders), ['fake', 'real']) && eq(keys(n.orders.real), ORDER_KEYS)));
  const json = JSON.stringify([s.body, p.body]);
  ok('no password / phone / clientName / clientPhone / amount / cin* / isFake / isActive / rejectionReason key or value',
    !/"(password|phone|clientName|clientPhone|cinFrontFile|cinBackFile|isFake|isActive|rejectionReason|commissionRate|parentId|createdAt)"/.test(json)
    && SECRETS.every((x) => !json.includes(x)) && !json.includes('+212600000002'), json.slice(0, 400));
  ok('responses carry Cache-Control: no-store', s.cache === 'no-store' && p.cache === 'no-store');
}

// ── 8. account state, tokens, rate limit ─────────────────────────────────────
console.log('\n8. Account state, token isolation, rate limit');
{
  const E = setup();
  aff(E, E.A);
  const D = E.db._seed.recruiter({ username: 'net.disabled', name: 'Disabled', isActive: false, disabledAt: new Date(), disabledBy: 'admin' });
  aff(E, D);
  const dis = await Promise.all([stats(E, D), nodes(E, D), nodes(E, D, { view: 'unplaced' })].map((p) => p.then(track)));
  ok('a disabled recruiter → 403 { code: RECRUITER_DISABLED } on both endpoints', dis.every((r) => r.status === 403 && r.text === '{"code":"RECRUITER_DISABLED"}'));
  const ghost = { id: randomUUID(), username: 'ghost' };
  const gh = await Promise.all([stats(E, ghost), nodes(E, ghost)].map((p) => p.then(track)));
  ok('a valid token of a deleted / unknown recruiter → 401 UNAUTHORIZED', gh.every((r) => r.status === 401 && r.text === '{"code":"UNAUTHORIZED"}'));
  const before = qc(E);
  const tokens = [
    null,
    `recruiter_token=${signToken({ userId: 'adm', email: 'a@x', role: 'ADMIN' })}`,
    `recruiter_token=${signToken({ affiliateId: 'af1', username: 'af', type: 'affiliate' })}`,
    `auth_token=${recruiterToken(E.A.id)}`,
    `affiliate_token=${recruiterToken(E.A.id)}`,
    'recruiter_token=garbage',
  ];
  const results = [];
  for (const cookie of tokens) for (const h of [E.stats, E.nodes]) results.push(track(await call(h, req('/api/recruiter/network/nodes', cookie ? { cookie } : {}))));
  results.push(track(await call(E.nodes, req('/api/recruiter/network/nodes', { bearer: recruiterToken(E.A.id) }))));
  ok(`no cookie, an admin / affiliate token as recruiter_token, the recruiter token in another cookie or as Bearer, garbage → 401 (${results.length} cases), no database access`,
    results.every((r) => r.status === 401 && r.text === '{"code":"UNAUTHORIZED"}') && qc(E) === before, results.map((r) => r.status).join(','));

  const keysSeen = [];
  const L = setup({ rateLimit: (r, key) => { keysSeen.push(key); return keysSeen.length > 1 ? new Response('limited by limiter', { status: 429 }) : null; } });
  aff(L, L.A);
  const first = await stats(L, L.A);
  const b4 = qc(L);
  const limited = track(await nodes(L, L.A));
  ok('rate limited → 429 { code: RATE_LIMITED } (own body), keyed by the recruiter id, before any database access',
    first.status === 200 && limited.status === 429 && limited.text === '{"code":"RATE_LIMITED"}' && keysSeen.every((k) => k === `recruiter-network:${L.A.id}`) && qc(L) === b4, limited.text);
  const R = setup({ rateLimit: realRateLimit });
  aff(R, R.A);
  const ip = `10.44.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
  const statuses = [];
  for (let i = 0; i < RECRUITER_NETWORK_RATE.max + 1; i++) statuses.push((await call(R.nodes, req('/api/recruiter/network/nodes', { cookie: cookieOf(R.A), ip }))).status);
  ok(`the real limiter: ${RECRUITER_NETWORK_RATE.max} requests per minute, then 429`, RECRUITER_NETWORK_RATE.max === 120 && RECRUITER_NETWORK_RATE.windowMs === 60_000
    && statuses.slice(0, 120).every((s) => s === 200) && statuses[120] === 429, statuses.slice(-3).join(','));
  const otherRec = await call(R.nodes, req('/api/recruiter/network/nodes', { cookie: cookieOf(R.B), ip }));
  ok('… another recruiter from the same IP is not limited', otherRec.status === 200);

  const boom = setup();
  aff(boom, boom.A);
  boom.db._state.failOnce['$queryRaw.query'] = Object.assign(new Error('relation does not exist — internal detail'), { code: 'P2010' });
  const err = track(await stats(boom, boom.A));
  ok('an internal error → 500 { code: SERVER_ERROR }, no message', err.status === 500 && err.text === '{"code":"SERVER_ERROR"}');
  ok('every error body in this file is { code } only (no message / error text)', allResponses.filter((r) => r.status >= 400).every((r) => errorBodyOk(r.body)),
    allResponses.filter((r) => r.status >= 400 && !errorBodyOk(r.body)).map((r) => r.text).join(' | '));
}

// ── 9. read-only, static checks ──────────────────────────────────────────────
console.log('\n9. Read-only and static checks');
{
  const E = setup();
  const r = aff(E, E.A); aff(E, E.A, { parentId: r.id });
  E.db._seed.order({ affiliateId: r.id, status: 'delivered' }); E.db._seed.identity({ affiliateId: r.id, status: 'APPROVED' });
  const snap = JSON.stringify(E.db._tables, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  const logStart = E.db._log.length;
  await stats(E, E.A); await stats(E, E.A, r.id); await nodes(E, E.A); await nodes(E, E.A, { parentId: r.id }); await nodes(E, E.A, { view: 'unplaced' });
  const ops = E.db._log.slice(logStart).map((l) => `${l.model}.${l.op}`);
  ok('every database call of both endpoints is a read (findUnique / findMany / count / groupBy / the tree query), no transaction',
    ops.every((o) => /^(recruiter\.findUnique|recruiterAffiliateLink\.(count|findMany)|\$queryRaw\.query|affiliate\.findMany|affiliateOrder\.groupBy|identityVerification\.findMany)$/.test(o)), [...new Set(ops)].join(','));
  ok('the tables are byte-identical after all requests', JSON.stringify(E.db._tables, (k, v) => (typeof v === 'bigint' ? String(v) : v)) === snap);
  ok('the fake refuses a document field of the identity table and any order amount aggregate (guards are live)',
    await E.db.identityVerification.findMany({ where: { affiliateId: { in: [r.id] } }, select: { affiliateId: true, cinFrontFile: true } }).then(() => false, () => true)
    && await E.db.affiliateOrder.groupBy({ by: ['affiliateId'], where: { affiliateId: { in: [r.id] } }, _count: { _all: true }, _sum: { total: true } }).then(() => false, () => true)
    && await E.db.identityVerification.update({ where: { id: 'x' }, data: { status: 'APPROVED' } }).then(() => false, () => true));

  const svc = stripJs(read('src/lib/services/recruiterNetworkService.js'));
  const hnd = stripJs(read('src/lib/recruiterNetworkRouteHandlers.js'));
  ok('recruiterNetworkService.js / recruiterNetworkRouteHandlers.js: no create / update / upsert / delete, no $executeRaw, no INSERT / UPDATE / DELETE SQL',
    [svc, hnd].every((c) => !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(c) && !/\$executeRaw/.test(c) && !/\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i.test(c)));
  const models = new Set([...svc.matchAll(/\b(?:db|tx)\.(\$?\w+)/g)].map((m) => m[1]));
  ok('the service reads only recruiterAffiliateLink, $queryRaw, affiliate, affiliateOrder, identityVerification',
    [...models].every((m) => ['recruiterAffiliateLink', '$queryRaw', 'affiliate', 'affiliateOrder', 'identityVerification'].includes(m)), [...models].join(','));
  ok('identity reads select only affiliateId + status; orders only grouped counts (no _sum / total / client field in the service)',
    /identityVerification\.findMany\(\{ where: \{ affiliateId: \{ in: part \} \}, select: \{ affiliateId: true, status: true \} \}\)/.test(svc) && !/cinFront|cinBack|rejectionReason|_sum|_avg|clientName|clientPhone|total: true|commissionAmount/.test(svc));
  ok('the handlers access no model directly (only via the services) and re-check the account (requireActiveRecruiter)',
    !/\b(?:db|tx|prisma)\s*\.\s*(?!js['"])[a-zA-Z$]+\s*\./.test(hnd.replace(/import[^;]+;/g, '')) && /requireActiveRecruiter\(decoded, \{ db \}\)/.test(hnd));
  for (const kind of ['stats', 'nodes']) {
    const route = stripJs(read(`src/app/api/recruiter/network/${kind}/route.js`));
    const exported = [...route.matchAll(/export\s+(?:const|async\s+function|function)\s+([A-Z]+)\b/g)].map((m) => m[1]);
    ok(`/api/recruiter/network/${kind}: only GET, wrapped in withRecruiterAuth, imports recruiterVisibility`,
      eq(exported, ['GET']) && !/export\s*\{/.test(route) && new RegExp(`export const GET = withRecruiterAuth\\(h\\.${kind}\\)`).test(route) && /from '@\/lib\/recruiterVisibility'/.test(route));
  }
  ok('the network SQL is parameterised (no string concatenation into the query) and bounded (depth < members + 1)',
    /\$queryRaw`/.test(svc) && !/\$queryRawUnsafe/.test(svc) && /WHERE t\.depth < \$\{bound\}::int/.test(svc) && /const bound = members \+ 1/.test(svc));
}

// ── 10. projections with hostile input ───────────────────────────────────────
console.log('\n10. Projections resist hostile input');
{
  const evil = JSON.parse('{"__proto__":{"polluted":"yes"},"id":5,"username":["x"],"name":{"a":1},"level":0,"status":"active","identityStatus":"approved","childrenCount":-3,"descendantsCount":1.5,'
    + '"orders":{"real":{"delivered":"7","total":-1,"__proto__":{"x":1},"extra":9},"fake":null},"password":"h","isActive":true,"phone":"+2126","constructor":{"prototype":{"x":"y"}}}');
  const n = V.toRecruiterNetworkNodeView(evil);
  ok('node view: exact keys; wrong types → null; level 0 → null; status / identity outside the allowlist → null / NONE; negative / fractional / string counts → 0',
    eq(keys(n), NODE_KEYS) && n.id === null && n.username === null && n.name === null && n.level === null && n.status === null && n.identityStatus === 'NONE'
    && n.childrenCount === 0 && n.descendantsCount === 0 && eq(n.orders, { real: zeroOrders(), fake: zeroOrders() }), JSON.stringify(n));
  ok('node view keeps valid values unchanged', eq(V.toRecruiterNetworkNodeView({ id: 'a', username: 'u', name: 'N', level: 7, status: 'INACTIVE', identityStatus: 'REJECTED', childrenCount: 2, descendantsCount: 9,
    orders: { real: { delivered: 3, total: 3 }, fake: { delivered: 1, total: 1 } }, isActive: true, password: 'p' }),
  { id: 'a', username: 'u', name: 'N', level: 7, status: 'INACTIVE', identityStatus: 'REJECTED', childrenCount: 2, descendantsCount: 9,
    orders: { real: { ...zeroOrders(), delivered: 3, total: 3 }, fake: { ...zeroOrders(), delivered: 1, total: 1 } } }));
  ok('node view of null / undefined / a string → a safe empty node', [null, undefined, 'x', 42].every((x) => { const v = V.toRecruiterNetworkNodeView(x); return eq(keys(v), NODE_KEYS) && v.id === null && v.identityStatus === 'NONE'; }));
  const pth = V.toRecruiterNetworkPathView(JSON.parse('{"__proto__":{"polluted":1},"id":"a","username":7,"level":-2,"password":"h"}'));
  ok('path view: exact keys, bad types → null', eq(pth, { id: 'a', username: null, name: null, level: null }));
  const sv = V.toRecruiterNetworkStatsView(JSON.parse('{"__proto__":{"polluted":1},"rootId":5,"totals":{"affiliates":-1,"direct":2.5,"active":"3","inactive":4,"maxLevel":2,"unplaced":1,"secret":1},'
    + '"identity":{"APPROVED":2,"approved":5,"NONE":-1},"orders":{"real":{"delivered":2},"fake":{"delivered":"9"}},"levels":[{"level":1,"affiliates":2,"orders":null,"x":1},{"level":"2"}],"balance":1}'));
  ok('stats view: exact keys, hostile counts → 0, unknown keys dropped, levels sanitised',
    eq(keys(sv), STATS_KEYS) && sv.rootId === null && eq(sv.totals, { affiliates: 0, direct: 0, active: 0, inactive: 4, maxLevel: 2, unplaced: 1 })
    && eq(sv.identity, { APPROVED: 2, PENDING: 0, REJECTED: 0, NONE: 0 }) && sv.orders.real.delivered === 2 && sv.orders.fake.delivered === 0
    && sv.levels.length === 2 && sv.levels.every((l) => eq(keys(l), LEVEL_KEYS)) && sv.levels[1].level === null && sv.levels[0].affiliates === 2, JSON.stringify(sv));
  ok('stats view with non-array levels / null input → empty levels, zero totals',
    eq(V.toRecruiterNetworkStatsView({ levels: 'x' }).levels, []) && V.toRecruiterNetworkStatsView(null).totals.affiliates === 0);
  ok('no global prototype pollution after all projections', !('polluted' in {}) && !('x' in {}));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
