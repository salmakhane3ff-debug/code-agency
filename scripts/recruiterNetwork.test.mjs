#!/usr/bin/env node
/**
 * scripts/recruiterNetwork.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 4: the recruiter's network tree and statistics
 * (GET /api/recruiter/network/stats and /api/recruiter/network/nodes, READ-ONLY).
 * In-memory fake database only (scripts/lib/recruiterFakeDb.mjs, phase4 mode: every tagged network
 * statement emulated from its own SQL, page order counts via groupBy, identity status only).
 * Phase 6 part 5b: paging, descendant counts and statistics run in SQL (path / page / unplaced /
 * stats statements); section 11 covers their edge cases and section 12 compares them with the
 * former in-memory implementation (fixed commit) on seeded random networks.
 * Proves:
 *   • unlimited depth (3, 10, 20, 200 levels), full breadcrumb at level 150
 *   • several roots, several recruiters: each sees ONLY their own network; anything outside
 *     (another network, unlinked, unknown, malformed id) → the same 404 NOT_FOUND
 *   • unlinked children are never shown or counted; an unlinked parent makes a root
 *   • malformed data (parent cycles) never loops: unplaced, listed by view=unplaced
 *   • large network (6000, > one 5000-id chunk): exact totals, pagination, bounded and
 *     size / depth independent query counts (no N+1)
 *   • real vs fake orders always separate; status buckets; identity and activation counts
 *   • sub-network statistics (Phase 7 Stage B: ABSOLUTE levels — the same level as in the tree)
 * Phase 7 Stage B (documented pin updates, marked "Stage B" below): the network is the recruiter's
 * DOWNLINE D(R) = linked affiliates + ALL their descendants (linked to another recruiter or to none,
 * flagged linkedToMe false); levels are absolute everywhere (sub-network statistics included); nodes
 * and breadcrumbs carry linkedToMe, nodes also progress / rewardState (handler: + settings + ledger
 * reads); the depth cap of the walks is NETWORK_LIMITS.DEPTH_CAP; the roots / children / unplaced /
 * stats / ancestry statements replace page / path. D(R)-specific behaviour (foreign descendants,
 * multiple recruiter ancestors, progress, the affiliate list, the summary) is proven in
 * scripts/recruiterDownlineProgress.test.mjs.
 * Phase 7 Stage E (approved ownership rule, pin updates marked "Stage E"): the network is N(R) — every
 * downward step skips a child linked to ANOTHER recruiter (it belongs to that recruiter with its
 * subtree); admin-created (unlinked) descendants stay in the network (linkedToMe false). Ownership
 * itself is proven in scripts/recruiterOwnership.test.mjs.
 * Phase 7 Stage F (approved clarification, pin updates marked "Stage F"): the TOPMOST link wins — no
 * downward step filters on links any more; a nested (legacy) link to another recruiter inside R's
 * network stays R's (cross data below: B's affiliate under A's a1 is A's, A's affiliate under B's b1 is B's).
 *   • exact output keys, no sensitive field anywhere, error bodies { code } only
 *   • account state, token isolation, rate limit, read-only (no write anywhere)
 *   • the projections resist hostile input
 * Run: node scripts/recruiterNetwork.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-network-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
// Stage B: + linkedToMe / progress / rewardState on nodes, + linkedToMe on breadcrumb entries (additive)
const NODE_KEYS = ['childrenCount', 'descendantsCount', 'id', 'identityStatus', 'level', 'linkedToMe', 'name', 'orders', 'progress', 'rewardState', 'status', 'username'];
const PATH_KEYS = ['id', 'level', 'linkedToMe', 'name', 'username'];
const PAGE_KEYS = ['nextCursor', 'nodes', 'parent', 'parentNode', 'path', 'total'];
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
  // Phase 7 Stage B: phase5 (the node pages read the current settings and the ledger for the progress fields)
  const db = makeRecruiterFakeDb({ phase5: true, ...(hooks ? { hooks } : {}) });
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
// The binds of one raw network statement, read from its own SQL text: every `"recruiterId" = $?`
// placeholder carries `rid` and its depth cap (`depth < $?::int` / `k < $?::int`) is `bound`.
// Stage B: the legacy tree statement keeps bound = members + 1 (ONE cap); the downline walks bind
// NETWORK_LIMITS.DEPTH_CAP (≤ 1 cap: the ancestry walk has none — UNION ends it on a cycle).
const bindsOk = ({ sql, values }, rid, bound) => {
  const seg = sql.replace(/\s+/g, ' ').split('$?');
  if (seg.length - 1 !== values.length) return false;
  const tree = /\/\* recruiter-network-tree \*\//.test(sql);
  let caps = 0, rids = 0;
  for (let i = 0; i < values.length; i++) {
    if (/"recruiterId" = $/.test(seg[i])) { rids += 1; if (values[i] !== rid) return false; }
    if (/\b(depth|k) < $/.test(seg[i]) && seg[i + 1].startsWith('::int')) { caps += 1; if (values[i] !== (tree ? bound : S.NETWORK_LIMITS.DEPTH_CAP)) return false; }
  }
  return (tree ? caps === 1 : caps <= 1) && rids >= 1;
};
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
/** Order reads since `from` (a _log mark): affiliateOrder calls, raw SQL over affiliate_orders, any other model call whose args mention orders. */
const orderReadsOf = (db, calls, from = 0) => {
  const log = db._log;
  const logged = log.slice(from).filter((l) => l.model === 'affiliateOrder' || (l.model === '$queryRaw' && /affiliate_orders/.test(l.sql ?? '')));
  const viaArgs = calls.filter((c) => c.at >= from && c.model !== 'affiliateOrder' && mentionsOrders(c.args));
  const unlogged = calls.filter((c) => c.at >= from && c.model === 'affiliateOrder' && !(log[c.at]?.model === 'affiliateOrder' && log[c.at]?.op === c.op)); // refused before the fake logs it
  return { logged, viaArgs, unlogged, all: [...logged, ...viaArgs, ...unlogged] };
};
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
  // Stage B: nodes = recruiter + count + ancestry + children + orders + identity + settings + ledger (progress) = 8 (was 6);
  // simplified dashboard: + the scope's own card (ONE statement; its orders / identity / progress ride in the page's reads) = 9
  ok(`query count is independent of the depth: stats ${qs4} (4 levels) = ${qs} (200 levels) = 3; nodes ${qn4} = ${qn} = 9`, qs === 3 && qs4 === 3 && qn === 9 && qn4 === 9, `stats ${qs4}/${qs} nodes ${qn4}/${qn}`);
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
  // Stage F (topmost link wins): A's affiliate under B's b1 is B's — A has 3 roots
  ok('Stage F: A sees exactly its 3 roots (its A-linked affiliate under B\'s b1 belongs to B), oldest first',
    rA.status === 200 && eq(rA.body.nodes.map((n) => n.id), [a1.id, a2.id, a3.id]) && rA.body.total === 3 && rA.body.parent === null && eq(rA.body.path, []), rA.text.slice(0, 200));
  const rB = track(await nodes(E, E.B));
  ok('Stage F: B sees its 1 root (its legacy link under A\'s a1 is A\'s), never A\'s', eq(rB.body.nodes.map((n) => n.id), [b1.id]));
  const a1kids = track(await nodes(E, E.A, { parentId: a1.id }));
  // Stage F (was Stage E): the children of a1 are ALL its children — its A-linked child, the nested legacy B link
  // (linkedToMe false: A owns it) and the unlinked admin-created one.
  ok('Stage F: A\'s children of a1 in creation order — its A-linked child, B\'s nested legacy link and the unlinked admin-created child (linkedToMe true / false / false)',
    eq(a1kids.body.nodes.map((n) => [n.id, n.linkedToMe]), [[a11.id, true], [bUnderA.id, false], [unlinkedChild.id, false]]) && rA.body.nodes[0].childrenCount === 3 && rA.body.nodes[0].descendantsCount === 3);
  const sA = track(await stats(E, E.A)); const sB = track(await stats(E, E.B));
  ok('Stage F: A\'s statistics count N(A) (a1, a2, a3, a11, bUnderA, the unlinked child = 6, 3 direct); B\'s N(B) = b1, b11 and A\'s legacy link under b1 (3, 1 direct)',
    sA.body.stats.totals.affiliates === 6 && sA.body.stats.totals.direct === 3 && sB.body.stats.totals.affiliates === 3 && sB.body.stats.totals.direct === 1);
  const allA = JSON.stringify([rA.body, a1kids.body, sA.body]);
  ok('Stage F: no id of B\'s network (b1, b11 and aUnderB under B\'s b1) or of an unrelated affiliate ever appears in A\'s responses; nothing names recruiter B',
    [b1.id, b11.id, aUnderB.id, adminLoose.id, E.B.id, E.B.username].every((id) => !allA.includes(id)));

  const outside = [b1.id, b11.id, aUnderB.id, adminLoose.id, randomUUID(), 'bad id!', 'x'.repeat(101), '../etc', "a'b"];
  const viaNodes = await Promise.all(outside.map((id) => nodes(E, E.A, { parentId: id }).then(track)));
  const viaStats = await Promise.all(outside.map((id) => stats(E, E.A, id).then(track)));
  ok('A: parentId / rootId of B\'s affiliate outside A\'s downline, an unrelated unlinked affiliate, an unknown or malformed id → 404 { code: NOT_FOUND }, byte-identical',
    [...viaNodes, ...viaStats].every((r) => r.status === 404 && r.text === '{"code":"NOT_FOUND"}'), [...viaNodes, ...viaStats].map((r) => `${r.status}:${r.text}`).join(' | '));
  const bTries = await Promise.all([nodes(E, E.B, { parentId: a1.id }), stats(E, E.B, a11.id)].map((p) => p.then(track)));
  ok('B with A\'s affiliates → the same 404', bTries.every((r) => r.status === 404 && r.text === '{"code":"NOT_FOUND"}'));
  ok('an empty parentId / rootId means the whole network (roots / all) — Stage F: 3 roots', (await nodes(E, E.A, { parentId: '' })).body.total === 3 && (await stats(E, E.A, '')).body.stats.totals.affiliates === 6);

  const empty = setup();
  const en = track(await nodes(empty, empty.A)); const es = track(await stats(empty, empty.A));
  ok('an empty network → 200 with no nodes and zero statistics (no levels)',
    en.status === 200 && eq(en.body, { parent: null, parentNode: null, path: [], nodes: [], total: 0, nextCursor: null })
    && es.status === 200 && es.body.stats.totals.affiliates === 0 && eq(es.body.stats.levels, []) && es.body.stats.orders.real.total === 0);
}

// ── 3. malformed data ─────────────────────────────────────────────────────────
console.log('\n3. Malformed / cyclic data never loops');
{
  const values = [];
  const E = setup({ hooks: { before: (m, o, a) => { if (m === '$queryRaw') values.push({ sql: a.sql, values: a.values }); } } });
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
  ok('the depth cap passed to the recursive query = DEPTH_CAP (Stage B; the legacy tree statement: members + 1)', values.length >= 1 && values.every((v) => bindsOk(v, E.A.id, 7)), JSON.stringify(values.map((v) => v.values)));
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
  const tagsSeen = [...new Set(values.map((v) => /\/\* ([\w-]+) \*\//.exec(v.sql)?.[1]))].sort();
  ok('… every recursive statement of this section (stats, roots, unplaced, ancestry, tree) binds its cap (DEPTH_CAP; tree: 7) and A at every recruiterId placeholder',
    eq(tagsSeen, ['recruiter-network-ancestry', 'recruiter-network-roots', 'recruiter-network-stats-orders', 'recruiter-network-tree', 'recruiter-network-unplaced'])
    && values.every((v) => bindsOk(v, E.A.id, 7)), JSON.stringify(tagsSeen));
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
  const statsLogAt = E.db._log.length;
  const { r: s, queries: qs } = await measure(E, () => stats(E, E.A));
  const ms = Date.now() - t0;
  const statsLog = E.db._log.slice(statsLogAt);
  const st = s.body.stats;
  ok('6000 affiliates: totals exact (6000, 150 direct, 75 active, 5925 inactive, 2 levels)',
    s.status === 200 && st.totals.affiliates === 6000 && st.totals.direct === 150 && st.totals.active === 75 && st.totals.inactive === 5925 && st.totals.maxLevel === 2
    && eq(st.levels.map((l) => [l.level, l.affiliates]), [[1, 150], [2, 5850]]), JSON.stringify(st.totals));
  ok('6000 affiliates: orders real.delivered 6000, fake.delivered 2000 (never in real), identity APPROVED 600 / NONE 5400',
    st.orders.real.delivered === 6000 && st.orders.real.total === 6000 && st.orders.fake.delivered === 2000 && st.orders.fake.total === 2000
    && st.identity.APPROVED === 600 && st.identity.NONE === 5400);
  ok(`stats on 6000 affiliates: exactly 3 queries (recruiter + count + ONE aggregated statement — no per-node or per-chunk read), observed ${qs}, ${ms} ms`, qs === 3, `${qs}`);
  ok('stats reads the orders inside that ONE statement: zero affiliateOrder model calls, exactly one raw statement mentioning affiliate_orders',
    statsLog.filter((l) => l.model === 'affiliateOrder').length === 0
    && statsLog.filter((l) => l.model === '$queryRaw' && /affiliate_orders/.test(l.sql)).length === 1, statsLog.map((l) => `${l.model}.${l.op}`).join(','));

  const { r: p1, queries: qp } = await measure(E, () => nodes(E, E.A));
  // Stage B: + settings + ledger (progress) = 7 (was 5)
  ok(`roots page 1: 50 nodes by default, total 150, nextCursor 50; ${qp} queries (bounded: 7)`, p1.status === 200 && p1.body.nodes.length === 50 && p1.body.total === 150 && p1.body.nextCursor === 50 && qp === 7, `${qp}`);
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
  const loose = aff(E, null, { parentId: other.id }); // Stage B: unlinked, under B's affiliate → outside A's downline
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
  // Stage B: ABSOLUTE levels (the tree's own levels): C1 is at level 2, so G1 is level 3 and GG1 level 4.
  ok('stats?rootId=C1: its 2 descendants (G1, GG1), direct 1, ABSOLUTE levels (3, 4) and maxLevel 4, the root and its ancestors excluded',
    s1.status === 200 && s1.body.stats.rootId === C1.id && s1.body.stats.totals.affiliates === 2 && s1.body.stats.totals.direct === 1 && s1.body.stats.totals.maxLevel === 4
    && eq(s1.body.stats.levels.map((l) => [l.level, l.affiliates]), [[3, 1], [4, 1]]) && s1.body.stats.orders.real.delivered === 1 && s1.body.stats.orders.fake.delivered === 1
    && s1.body.stats.totals.active === 1 && s1.body.stats.totals.unplaced === 0, s1.text.slice(0, 300));
  const s2 = track(await stats(E, E.A, R1.id));
  ok('stats?rootId=R1: 4 descendants, 2 direct (C1, C2), absolute levels 2…4; R2 excluded',
    s2.body.stats.totals.affiliates === 4 && s2.body.stats.totals.direct === 2 && eq(s2.body.stats.levels.map((l) => [l.level, l.affiliates]), [[2, 2], [3, 1], [4, 1]]) && s2.body.stats.orders.real.delivered === 2);
  const leaf = track(await stats(E, E.A, C2.id));
  ok('stats of a leaf → zero affiliates, no levels', leaf.status === 200 && leaf.body.stats.totals.affiliates === 0 && eq(leaf.body.stats.levels, []));
  const whole = track(await stats(E, E.A));
  ok('the whole network: 6 affiliates, 2 direct, rootId null', whole.body.stats.rootId === null && whole.body.stats.totals.affiliates === 6 && whole.body.stats.totals.direct === 2 && R2.id);
  const n = track(await nodes(E, E.A, { parentId: G1.id }));
  ok('nodes?parentId=G1: parent G1 (level 3), breadcrumb R1 › C1 › G1, child GG1 (level 4)',
    eq(n.body.parent, { id: G1.id, username: G1.username, name: G1.name, level: 3, linkedToMe: true }) && eq(n.body.path.map((p) => p.id), [R1.id, C1.id, G1.id]) && n.body.nodes[0].id === GG1.id && n.body.nodes[0].level === 4);
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
    eq(keys(p.body), PAGE_KEYS) && eq(keys(p.body.parent), PATH_KEYS) && p.body.path.every((x) => eq(keys(x), PATH_KEYS)) && eq(keys(p.body.parentNode), NODE_KEYS)
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
    // Stage B: + the progress reads (current settings, the ledger rows of the page's linked nodes)
    ops.every((o) => /^(recruiter\.findUnique|recruiterAffiliateLink\.(count|findMany)|\$queryRaw\.query|affiliate\.findMany|affiliateOrder\.groupBy|identityVerification\.findMany|recruiterSettingsVersion\.findFirst|recruiterRewardLedger\.findMany)$/.test(o)), [...new Set(ops)].join(','));
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
  // Stage B: the downline walks are capped by DEPTH_CAP (the legacy tree statement keeps members + 1)
  ok('the network SQL is parameterised (no string concatenation into the query) and bounded (every downward walk: depth < DEPTH_CAP; legacy tree: members + 1)',
    /\$queryRaw`/.test(svc) && !/\$queryRawUnsafe/.test(svc) && /WHERE t\.depth < \$\{bound\}::int/.test(svc) && /const bound = members \+ 1/.test(svc)
    // Stage F: 4 page / stats walks (t) + 3 N(R) walks (net: unplaced, downline, progress-qualified); 6 functions bind the cap;
    // simplified dashboard: + the node card walk (t) = 5 t-walks, 7 functions
    && (svc.match(/WHERE t\.depth < \$\{cap\}::int/g) || []).length === 5 && (svc.match(/WHERE n\.depth < \$\{cap\}::int/g) || []).length === 3
    && (svc.match(/const cap = NETWORK_LIMITS\.DEPTH_CAP;/g) || []).length === 7);
}

// ── 10. projections with hostile input ───────────────────────────────────────
console.log('\n10. Projections resist hostile input');
{
  const evil = JSON.parse('{"__proto__":{"polluted":"yes"},"id":5,"username":["x"],"name":{"a":1},"level":0,"status":"active","identityStatus":"approved","childrenCount":-3,"descendantsCount":1.5,'
    + '"orders":{"real":{"delivered":"7","total":-1,"__proto__":{"x":1},"extra":9},"fake":null},"password":"h","isActive":true,"phone":"+2126","constructor":{"prototype":{"x":"y"}}}');
  const n = V.toRecruiterNetworkNodeView(evil);
  ok('node view: exact keys; wrong types → null; level 0 → null; status / identity outside the allowlist → null / NONE; negative / fractional / string counts → 0; no linkedToMe → false, progress / rewardState null',
    eq(keys(n), NODE_KEYS) && n.id === null && n.username === null && n.name === null && n.level === null && n.status === null && n.identityStatus === 'NONE'
    && n.childrenCount === 0 && n.descendantsCount === 0 && eq(n.orders, { real: zeroOrders(), fake: zeroOrders() }) && n.linkedToMe === false && n.progress === null && n.rewardState === null, JSON.stringify(n));
  ok('node view keeps valid values unchanged', eq(V.toRecruiterNetworkNodeView({ id: 'a', username: 'u', name: 'N', level: 7, status: 'INACTIVE', identityStatus: 'REJECTED', childrenCount: 2, descendantsCount: 9,
    orders: { real: { delivered: 3, total: 3 }, fake: { delivered: 1, total: 1 } }, isActive: true, password: 'p' }),
  { id: 'a', username: 'u', name: 'N', level: 7, status: 'INACTIVE', identityStatus: 'REJECTED', childrenCount: 2, descendantsCount: 9,
    orders: { real: { ...zeroOrders(), delivered: 3, total: 3 }, fake: { ...zeroOrders(), delivered: 1, total: 1 } }, linkedToMe: false, progress: null, rewardState: null }));
  ok('node view of null / undefined / a string → a safe empty node', [null, undefined, 'x', 42].every((x) => { const v = V.toRecruiterNetworkNodeView(x); return eq(keys(v), NODE_KEYS) && v.id === null && v.identityStatus === 'NONE'; }));
  const pth = V.toRecruiterNetworkPathView(JSON.parse('{"__proto__":{"polluted":1},"id":"a","username":7,"level":-2,"password":"h"}'));
  ok('path view: exact keys, bad types → null', eq(pth, { id: 'a', username: null, name: null, level: null, linkedToMe: false }));
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

// ── 11. Part 5b: paging, ordering and statistics computed by the SQL statements ──
console.log('\n11. Part 5b: SQL paging, ordering, unplaced view, sub-networks, column allowlist, canViewOrders');
/** The db with every $queryRaw recorded as { tag, strings, values, rows } (rows = what the fake returned). */
const spyRaw = (db, seen) => new Proxy(db, {
  get(t, p) {
    if (p !== '$queryRaw') return t[p];
    return async (strings, ...values) => {
      const rows = await t.$queryRaw(strings, ...values);
      seen.push({ tag: /^\s*\/\* ([\w-]+) \*\//.exec(strings[0])?.[1] ?? null, strings, values, rows });
      return rows;
    };
  },
});
{
  // 11a. The emulated rows: the exact columns (in SQL order) and JS types of each statement.
  const E = setup();
  const r = aff(E, E.A, { isActive: true });
  const c = aff(E, E.A, { parentId: r.id });
  const x = aff(E, E.A); const y = aff(E, E.A, { parentId: x.id });
  E.db._tables.affiliate.find((a) => a.id === x.id).parentId = y.id; // X ⇄ Y → unplaced
  E.db._seed.order({ affiliateId: c.id, status: 'delivered' });
  E.db._seed.order({ affiliateId: c.id, status: 'Delivered', isFake: true });
  E.db._seed.identity({ affiliateId: r.id, status: 'APPROVED' });
  const seen = [];
  const spy = spyRaw(E.db, seen);
  await S.getNetworkStats(E.A.id, { db: spy });
  await S.getNetworkStats(E.A.id, { db: spy, rootId: r.id, includeOrders: false });
  await S.getNetworkNodes(E.A.id, { db: spy, parentId: r.id });
  await S.getNetworkNodes(E.A.id, { db: spy, cursor: 5 });
  await S.getNetworkNodes(E.A.id, { db: spy, view: 'unplaced' });
  await S.getNetworkNodes(E.A.id, { db: spy, view: 'unplaced', cursor: 5 });
  // Stage B: path → ancestry; page → roots (whole network) / children (parentId)
  ok('each request runs its tagged statements: stats-orders | ancestry + stats | ancestry + children + node (first page of a scope) | roots | unplaced | unplaced',
    eq(seen.map((s) => s.tag), ['recruiter-network-stats-orders', 'recruiter-network-ancestry', 'recruiter-network-stats', 'recruiter-network-ancestry',
      'recruiter-network-children', 'recruiter-network-node', 'recruiter-network-roots', 'recruiter-network-unplaced', 'recruiter-network-unplaced']), seen.map((s) => s.tag).join(','));
  const [statsO, pathR, statsSub, , kids, nodeRow, emptyPage, unpl, emptyUnpl] = seen.map((s) => s.rows);
  ok('node card rows { id, username, name, isActive, mine, children, descendants } (no total; the scope itself, linked to R)',
    eq(nodeRow, [{ id: r.id, username: r.username, name: r.name, isActive: E.db._tables.affiliate.find((a) => a.id === r.id).isActive, mine: true, children: 1, descendants: 1 }]), JSON.stringify(nodeRow));
  const bag = (list) => list.map((v) => JSON.stringify(v)).sort();
  // Stage F (was Stage B's 'k' + 'w' rows): ONE 'u' row — the unplaced members (R's links on a parent cycle owned by R:
  // X ⇄ Y = 2; 0 for a sub-network); sub-network levels absolute (c = level 2)
  ok('Stage F: stats rows { kind, depth, flag, status, n } (numbers, booleans, raw status / null): m = level 1 active APPROVED, level 2 inactive without identity (null); o = level 2 real "delivered" + fake "Delivered"; u = 2 unplaced',
    eq(bag(statsO), bag([{ kind: 'm', depth: 1, flag: true, status: 'APPROVED', n: 1 }, { kind: 'm', depth: 2, flag: false, status: null, n: 1 },
      { kind: 'o', depth: 2, flag: false, status: 'delivered', n: 1 }, { kind: 'o', depth: 2, flag: true, status: 'Delivered', n: 1 }, { kind: 'u', depth: null, flag: null, status: null, n: 2 }]))
    && eq(bag(statsSub), bag([{ kind: 'm', depth: 2, flag: false, status: null, n: 1 }, { kind: 'u', depth: null, flag: null, status: null, n: 0 }])), JSON.stringify([statsO, statsSub]));
  ok('ancestry rows { id, parentId, username, name, mine } (mine a boolean); children rows { total, id, username, name, isActive, mine, children, descendants }',
    eq(pathR, [{ id: r.id, parentId: null, username: r.username, name: r.name, mine: true }])
    && eq(kids, [{ total: 1, id: c.id, username: c.username, name: c.name, isActive: false, mine: true, children: 0, descendants: 0 }]), JSON.stringify([pathR, kids]));
  // Stage F: no `walk` column any more (the roots need no marking walk)
  ok('Stage F: an empty page is ONE row of NULLs that still carries the total (roots and unplaced); unplaced rows { total, id, username, name } in link order',
    eq(emptyPage, [{ total: 1, id: null, username: null, name: null, isActive: null, children: null, descendants: null }])
    && eq(emptyUnpl, [{ total: 2, id: null, username: null, name: null }])
    && eq(unpl, [{ total: 2, id: x.id, username: x.username, name: x.name }, { total: 2, id: y.id, username: y.username, name: y.name }]), JSON.stringify([emptyPage, emptyUnpl, unpl]));
  const pageCall = seen[4];
  const at = (re) => pageCall.strings.findIndex((s) => re.test(s.replace(/\s+/g, ' ')));
  const why = (p) => p.then(() => 'resolved', (e) => String(e?.message));
  const negative = [...pageCall.values]; negative[at(/OFFSET $/)] = -1;
  const msgs = [
    await why(E.db.$queryRaw(pageCall.strings.map((s) => s.replace('COLLATE "C"', '')), ...pageCall.values)),
    await why(E.db.$queryRaw(pageCall.strings, ...pageCall.values.slice(0, -1))),
    await why(E.db.$queryRaw(pageCall.strings, ...negative)),
  ];
  // Stage B: two different recruiter ids are checked on the stats statement (Stage F: the children statement binds 5 values —
  // scope, LIMIT, OFFSET, cap, recruiter: no link filter any more)
  const twoRids = await why(E.db.$queryRaw(seen[0].strings, ...seen[0].values.map((v, i) => (i === seen[0].strings.findIndex((x) => /"recruiterId" = $/.test(x.replace(/\s+/g, ' '))) ? E.B.id : v))));
  ok('the fake refuses a changed statement (drift guard), a missing bind, two different recruiter ids and a negative OFFSET',
    /the recruiter-network-children query changed \(missing: .*COLLATE "C"/.test(msgs[0]) && /must bind exactly 5 values/.test(msgs[1])
    && /every recruiterId placeholder/.test(twoRids) && /OFFSET must not be negative/.test(msgs[2]), [...msgs, twoRids].join(' | '));
}
{
  // 11b (i). Cursor / limit edge values on a roots page and on a children page.
  const E = setup();
  const roots = Array.from({ length: 130 }, () => aff(E, E.A).id);
  const kids = Array.from({ length: 105 }, () => aff(E, E.A, { parentId: roots[0] }).id);
  const page = async (p) => (await nodes(E, E.A, p).then(track)).body;
  for (const [label, all, scope] of [['roots', roots, {}], ['children', kids, { parentId: roots[0] }]]) {
    const n = all.length;
    const [atEnd, beyond, last, l0, l101, tail] = [
      await page({ ...scope, cursor: String(n) }), await page({ ...scope, cursor: '9999', limit: '100' }), await page({ ...scope, cursor: String(n - 1) }),
      await page({ ...scope, limit: '0' }), await page({ ...scope, limit: '101' }), await page({ ...scope, limit: '101', cursor: '100' }),
    ];
    ok(`${label} (${n}): cursor = total and cursor 9999 → nodes [], total ${n} kept, nextCursor null`,
      [atEnd, beyond].every((b) => eq(b.nodes, []) && b.total === n && b.nextCursor === null), JSON.stringify([atEnd, beyond]).slice(0, 300));
    ok(`${label}: cursor = total - 1 → exactly the last node, nextCursor null`, last.nodes.length === 1 && last.nodes[0].id === all[n - 1] && last.total === n && last.nextCursor === null);
    ok(`${label}: limit 0 → 1 node, nextCursor 1; limit 101 → 100 nodes (capped), nextCursor 100; limit 101 cursor 100 → the last ${n - 100}, nextCursor null`,
      eq(l0.nodes.map((v) => v.id), all.slice(0, 1)) && l0.nextCursor === 1 && eq(l101.nodes.map((v) => v.id), all.slice(0, 100)) && l101.nextCursor === 100
      && eq(tail.nodes.map((v) => v.id), all.slice(100)) && tail.nextCursor === null && [l0, l101, tail].every((b) => b.total === n));
  }
  const first = (await page({ limit: '1' })).nodes[0];
  const past = await page({ parentId: roots[0], cursor: '500' });
  ok('the root with 105 children counts 105 children / 105 descendants; a children page past the end keeps its parent and breadcrumb',
    first.id === roots[0] && first.childrenCount === 105 && first.descendantsCount === 105
    && past.parent?.id === roots[0] && past.parent.level === 1 && eq(past.path.map((p) => p.id), [roots[0]]) && eq(past.nodes, []) && past.total === 105);
}
{
  // 11c (ii). createdAt ties → id in C (byte / code-unit) order: - 0-9 A-Z _ a-z.
  const E = setup();
  const TIE = new Date(T0 + 50_000_000);
  const C_ROOTS = ['-', '0', '9z', 'A', 'Ab', 'B', 'Z9', '_', 'a', 'a-b', 'a0', 'aB', 'a_b', 'b', 'z-', 'z_'];
  const C_KIDS = ['-k', '1k', 'K-1', 'K1', 'K_1', '_k', 'k-1', 'k1', 'k_1'];
  ok('test data: the tie ids are in code-unit order, which is NOT the locale order (the test can tell them apart)',
    eq([...C_ROOTS].reverse().sort(), C_ROOTS) && eq([...C_KIDS].reverse().sort(), C_KIDS) && !eq([...C_ROOTS].sort((p, q) => p.localeCompare(q, 'en')), C_ROOTS));
  const early = aff(E, E.A, { createdAt: new Date(TIE.getTime() - 1) });
  for (const id of [...C_ROOTS].reverse()) aff(E, E.A, { id, createdAt: TIE }); // inserted in reverse order
  const late = aff(E, E.A, { createdAt: new Date(TIE.getTime() + 1) });
  for (const id of [...C_KIDS].reverse()) aff(E, E.A, { id, parentId: early.id, createdAt: TIE });
  const expected = [early.id, ...C_ROOTS, late.id];
  const all = await nodes(E, E.A, { limit: '100' });
  ok('roots with the same createdAt are ordered by id in C order, between the roots created 1 ms earlier / later',
    eq(all.body.nodes.map((v) => v.id), expected) && all.body.total === expected.length, all.body.nodes?.map((v) => v.id).join(' '));
  const walked = [];
  for (let cur = 0, guard = 0; cur !== null && guard < 20; guard++) { const p = await nodes(E, E.A, { limit: '3', cursor: String(cur) }); walked.push(...p.body.nodes.map((v) => v.id)); cur = p.body.nextCursor; }
  ok('paging the ties 3 by 3 gives the same order: no duplicate, no gap', eq(walked, expected), walked.join(' '));
  const kidsAll = await nodes(E, E.A, { parentId: early.id });
  const kidsSlice = await nodes(E, E.A, { parentId: early.id, limit: '4', cursor: '2' });
  ok('children with the same createdAt: the same C order; a page inside the ties is its exact slice',
    eq(kidsAll.body.nodes.map((v) => v.id), C_KIDS) && eq(kidsSlice.body.nodes.map((v) => v.id), C_KIDS.slice(2, 6)) && kidsSlice.body.nextCursor === 6, kidsAll.body.nodes?.map((v) => v.id).join(' '));
  const tree = await S.loadNetworkTree(E.A.id, { db: E.db });
  ok('… the same order as the former in-memory sort (loadNetworkTree roots and children)', eq(tree.roots, expected) && eq(tree.nodes.get(early.id).children, C_KIDS));
  const odd = await Promise.all(['-', '_', 'K_1'].map((id) => nodes(E, E.A, { parentId: id })));
  ok('ids such as "-", "_" or "K_1" work as parentId (200, their breadcrumb, no child)',
    odd.every((p, i) => p.status === 200 && p.body.parent.id === ['-', '_', 'K_1'][i] && eq(p.body.nodes, []) && p.body.total === 0)
    && odd[2].body.parent.level === 2 && eq(odd[2].body.path.map((v) => v.id), [early.id, 'K_1']));
}
{
  // 11d (iii). The unplaced view: link order (link createdAt, then id), paging.
  const E = setup();
  const root = aff(E, E.A);
  const child = aff(E, E.A, { parentId: root.id });
  const mk = (id, linkMs) => { const a = aff(E, null, { id }); E.db._seed.link({ affiliateId: a.id, recruiterId: E.A.id, createdAt: new Date(T0 + linkMs) }); return a; };
  const P = mk('Pp', 5000); const Q = mk('pq', 3000); const R = mk('P-r', 3000); const Sx = mk('p_s', 1000); const Z = mk('Qz', 3000);
  const parent = (a, id) => { E.db._tables.affiliate.find((v) => v.id === a.id).parentId = id; };
  parent(P, Q.id); parent(Q, P.id); parent(R, R.id); parent(Sx, P.id); parent(Z, Sx.id); // P ⇄ Q, R self, S → P, Z → S
  const expected = ['p_s', 'P-r', 'Qz', 'pq', 'Pp']; // link 1000 | 3000 ×3 (P-r < Qz < pq, code units) | 5000
  ok('test data: the link order differs from the affiliate creation order', !eq(expected, [P, Q, R, Sx, Z].map((a) => a.id)));
  const ids = []; const cursors = []; const totals = [];
  for (let cur = 0, guard = 0; cur !== null && guard < 10; guard++) {
    const p = await nodes(E, E.A, { view: 'unplaced', limit: '1', cursor: String(cur) }).then(track);
    ids.push(...p.body.nodes.map((v) => v.id)); cursors.push(p.body.nextCursor); totals.push(p.body.total); cur = p.body.nextCursor;
  }
  ok('view=unplaced, limit 1: the 5 unplaced members one by one in LINK order (createdAt of the link, then id), nextCursor 1…4 then null, total 5 on every page',
    eq(ids, expected) && eq(cursors, [1, 2, 3, 4, null]) && totals.every((t) => t === 5), JSON.stringify({ ids, cursors, totals }));
  const two = await nodes(E, E.A, { view: 'unplaced', limit: '2', cursor: '3' });
  const end = await nodes(E, E.A, { view: 'unplaced', cursor: '5' });
  const full = await nodes(E, E.A, { view: 'unplaced' });
  ok('limit 2 cursor 3 → the last two, nextCursor null; cursor = total → [], total 5, nextCursor null',
    eq(two.body.nodes.map((v) => v.id), expected.slice(3)) && two.body.nextCursor === null && eq(end.body.nodes, []) && end.body.total === 5 && end.body.nextCursor === null);
  ok('unplaced nodes: their own username / name, level null, status null, no children; the placed members never listed',
    full.body.nodes.every((v, i) => v.id === expected[i] && v.username === [Sx, R, Z, Q, P][i].username && v.name === [Sx, R, Z, Q, P][i].name && v.level === null && v.status === null
      && v.childrenCount === 0 && v.descendantsCount === 0) && !full.text.includes(root.id) && !full.text.includes(child.id));
  const st = (await stats(E, E.A)).body.stats;
  ok('the statistics count the same 5 as unplaced (2 placed affiliates)', st.totals.unplaced === 5 && st.totals.affiliates === 2);
}
{
  // 11e (iv). Sub-network statistics (Stage B: ABSOLUTE levels) and the NOT_FOUND matrix.
  const E = setup();
  const R = aff(E, E.A, { isActive: true });
  const C1 = aff(E, E.A, { parentId: R.id, isActive: true }); aff(E, E.A, { parentId: R.id });
  const G1 = aff(E, E.A, { parentId: C1.id }); const G2 = aff(E, E.A, { parentId: C1.id, isActive: true });
  const GG1 = aff(E, E.A, { parentId: G1.id });
  const Bf = aff(E, E.B);
  const M = aff(E, E.A, { parentId: Bf.id }); const MK = aff(E, E.A, { parentId: M.id }); // Stage F: a nested legacy A link under B's Bf → B's (topmost)
  const U = aff(E, null);
  const X = aff(E, E.A); const Y = aff(E, E.A, { parentId: X.id });
  E.db._tables.affiliate.find((a) => a.id === X.id).parentId = Y.id;                      // X ⇄ Y
  const Z = aff(E, E.A, { parentId: X.id }); const Q = aff(E, E.A, { parentId: Z.id });   // tails of the cycle
  E.db._seed.identity({ affiliateId: G2.id, status: 'APPROVED' });
  E.db._seed.order({ affiliateId: GG1.id, status: 'delivered' }); E.db._seed.order({ affiliateId: G1.id, status: 'delivered', isFake: true });
  const s = (await stats(E, E.A, C1.id)).body.stats;
  ok('stats?rootId=C1 (level 2): absolute levels — level 3 = G1, G2; level 4 = GG1 (maxLevel 4); unplaced 0 although the network has 4',
    s.rootId === C1.id && eq(s.totals, { affiliates: 3, direct: 2, active: 1, inactive: 2, maxLevel: 4, unplaced: 0 })
    && eq(s.levels.map((l) => [l.level, l.affiliates, l.active, l.identity.APPROVED]), [[3, 2, 1, 1], [4, 1, 0, 0]])
    && s.orders.real.delivered === 1 && s.orders.fake.delivered === 1 && s.levels[1].orders.real.delivered === 1 && s.levels[0].orders.fake.delivered === 1, JSON.stringify(s));
  const sG = (await stats(E, E.A, G1.id)).body.stats; const sM = (await stats(E, E.A, M.id)).body.stats; const sLeaf = (await stats(E, E.A, GG1.id)).body.stats;
  const whole = (await stats(E, E.A)).body.stats;
  const sMB = (await stats(E, E.B, M.id)).body.stats;
  ok('Stage F: stats?rootId=G1 → GG1 at level 4; rootId=M is B\'s (for B: MK at level 3); a leaf → zero; A\'s whole network: 6 placed, 4 unplaced, 1 direct',
    eq(sG.levels.map((l) => [l.level, l.affiliates]), [[4, 1]]) && sM === undefined && eq(sMB.levels.map((l) => [l.level, l.affiliates]), [[3, 1]]) && sMB.totals.direct === 1
    && sLeaf.totals.affiliates === 0 && eq(sLeaf.levels, []) && whole.totals.affiliates === 6 && whole.totals.unplaced === 4 && whole.totals.direct === 1);
  const n = (await nodes(E, E.A, { parentId: C1.id })).body;
  ok('nodes?parentId=C1 → breadcrumb R › C1 (levels 1, 2), children G1 (1 child, 1 descendant) and G2 at level 3',
    eq(n.path.map((p) => [p.id, p.level]), [[R.id, 1], [C1.id, 2]]) && eq(n.parent, { id: C1.id, username: C1.username, name: C1.name, level: 2, linkedToMe: true })
    && eq(n.nodes.map((v) => [v.id, v.level, v.childrenCount, v.descendantsCount]), [[G1.id, 3, 1, 1], [G2.id, 3, 0, 0]]));
  const nM = (await nodes(E, E.B, { parentId: M.id })).body;
  ok('Stage F: B\'s nodes?parentId=M (A\'s legacy link under B\'s Bf) → breadcrumb Bf › M (levels 1, 2, M linkedToMe false), child MK at level 3',
    eq(nM.path.map((p) => [p.id, p.level, p.linkedToMe]), [[Bf.id, 1, true], [M.id, 2, false]]) && eq(nM.nodes.map((v) => [v.id, v.level]), [[MK.id, 3]]));
  const outside = [['an unplaced cycle member', X.id], ['the other cycle member', Y.id], ['an unplaced tail', Z.id], ['a member under an unplaced tail', Q.id],
    ['another recruiter\'s affiliate', Bf.id], ['Stage F: A\'s legacy link under B\'s affiliate (B\'s)', M.id], ['… and its child', MK.id], ['a non-member', U.id], ['an unknown id', randomUUID()], ['a malformed id', 'bad id!'], ['a too long id', 'x'.repeat(101)]];
  const res = [];
  for (const [label, id] of outside) res.push([label, await stats(E, E.A, id).then(track), await nodes(E, E.A, { parentId: id }).then(track)]);
  const bad = res.filter(([, a, b]) => !(a.text === '{"code":"NOT_FOUND"}' && a.status === 404 && b.text === '{"code":"NOT_FOUND"}' && b.status === 404));
  ok(`stats?rootId and nodes?parentId → 404 NOT_FOUND for ${outside.map(([l]) => l).join(', ')}`, bad.length === 0, bad.map(([l, a, b]) => `${l}: ${a.status}/${b.status}`).join(' | '));
  const viaB = await Promise.all([stats(E, E.B, C1.id), nodes(E, E.B, { parentId: R.id }), stats(E, E.B, GG1.id)].map((p) => p.then(track)));
  ok('recruiter B with A\'s affiliates outside B\'s downline → 404 NOT_FOUND', viaB.every((v) => v.status === 404 && v.text === '{"code":"NOT_FOUND"}'));
  // Stage F (was Stage E — nearest link): M is linked to A but sits under B's Bf — the topmost link (Bf) wins: M and
  // its subtree belong to B; B's whole network is Bf, M, MK.
  const bAll = await stats(E, E.B).then(track);
  ok('Stage F: … B\'s statistics count Bf, M and MK (3 placed, 1 direct)', bAll.body.stats.totals.affiliates === 3 && bAll.body.stats.totals.direct === 1, JSON.stringify(bAll.body?.stats?.totals));
  const svc = await Promise.all([S.getNetworkStats(E.A.id, { db: E.db, rootId: 42 }), S.getNetworkNodes(E.A.id, { db: E.db, parentId: ['x'] }), S.getNetworkStats(E.A.id, { db: E.db, rootId: { id: R.id } })]
    .map((p) => p.then(() => 'resolved', (e) => e.code)));
  ok('service: a non-string rootId / parentId → NOT_FOUND', svc.every((v) => v === 'NOT_FOUND'), svc.join(','));
}
{
  // 11f (v). Static: the raw SQL can read only the allowlisted columns of the four tables.
  const COLS = {
    affiliates: ['id', 'parentId', 'username', 'name', 'isActive', 'createdAt'],
    recruiter_affiliate_links: ['affiliateId', 'recruiterId', 'createdAt'],
    identity_verifications: ['affiliateId', 'status'],
    affiliate_orders: ['affiliateId', 'status', 'isFake'],
  };
  const ANY = new Set([...Object.values(COLS).flat(), 'linkedAt']); // a CTE column / output alias
  // Unquoted words allowed: SQL keywords, functions / types, CTE names, aliases, the CTEs' computed columns.
  const WORDS = new Set(['WITH', 'RECURSIVE', 'AS', 'SELECT', 'FROM', 'JOIN', 'LEFT', 'CROSS', 'LATERAL', 'ON', 'WHERE', 'AND', 'OR', 'NOT', 'IS', 'NULL', 'EXISTS',
    'UNION', 'ALL', 'ORDER', 'BY', 'DESC', 'LIMIT', 'OFFSET', 'GROUP', 'FILTER', 'COLLATE', 'true', 'count', 'int', 'text',
    'tree', 'up', 'cand', 'page', 'counts', 'seed', 't', 'one', 'a', 'l', 'pl', 'cl', 'c', 'x', 'p', 'u', 'ch', 'n', 's', 'iv', 'o', 'depth', 'k', 'children', 'descendants',
    // Stage B: the downline CTEs / aliases (mark, roots, un, d, ml, m, cx, r), the computed `mine`, NULL::boolean, = ANY ($ids::text[]), isFake = false
    'mark', 'roots', 'un', 'd', 'ml', 'm', 'cx', 'r', 'mine', 'boolean', 'ANY', 'false', 'walk',
    // Stage E: the "not linked to another recruiter" filter's alias (ox), the N(R) walk of the progress statement (net) and
    // its seed unnest(ARRAY(<the recruiter's links>)) (a small row estimate for the recursion — no JIT-sized plan)
    'ox', 'net', 'unnest', 'ARRAY',
    // Stage F: the shared N(R) CTEs (rs, orph, oup, cseed, cnet, mem), their computed columns (linked, top, rid),
    // bool_or, the fenced-lookup aliases (sa, f, g, op, cx) — still no column outside the allowlist
    'rs', 'orph', 'oup', 'cseed', 'cnet', 'mem', 'linked', 'top', 'rid', 'bool_or', 'sa', 'f', 'g', 'op']);
  const violations = (sql) => {
    const out = [];
    const body = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\$\{[^}]*\}/g, ' $ ').replace(/'[^']*'/g, ' ');
    const alias = new Map(); // table alias → table
    const DECL = /\b(?:FROM|JOIN)\s+"([^"]+)"\s+(?:AS\s+)?(\w+)/gi; // `"table" a` and `"table" AS a`
    for (const m of body.matchAll(DECL)) {
      if (!(m[1] in COLS)) out.push(`table "${m[1]}"`);
      if (/^(ON|WHERE|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|NATURAL|USING|GROUP|ORDER|LIMIT|OFFSET|UNION)$/i.test(m[2])) continue; // no alias
      if (alias.has(m[2]) && alias.get(m[2]) !== m[1]) out.push(`alias ${m[2]} names two tables`);
      alias.set(m[2], m[1]);
    }
    // A table alias used as a value (`a`, `row_to_json(a)`, `(a).x`, `a.*`) is a whole row: every
    // column of the table. Only `alias."column"` (checked below) may follow a table alias.
    const rest = body.replace(DECL, ' ').replace(/"[^"]*"/g, ' "" ');
    for (const [name, table] of alias) {
      for (const m of rest.matchAll(new RegExp(`\\b${name}\\b(?!\\s*\\.\\s*"")`, 'g'))) out.push(`whole-row reference ${m[0]} of ${table} (${rest.slice(m.index, m.index + 12).replace(/\s+/g, ' ').trim()})`);
    }
    for (const m of body.matchAll(/(?:\b(\w+)\.)?"([^"]*)"/g)) {
      const before = body.slice(0, m.index);
      if (/COLLATE\s*$/.test(before)) { if (m[2] !== 'C') out.push(`COLLATE "${m[2]}"`); continue; }
      if (/\b(?:FROM|JOIN)\s*$/i.test(before)) continue; // a table name, checked above
      if (m[1] && alias.has(m[1])) { if (!(COLS[alias.get(m[1])] ?? []).includes(m[2])) out.push(`${m[1]}."${m[2]}" of ${alias.get(m[1])}`); } else if (!ANY.has(m[2])) out.push(`"${m[2]}"`);
    }
    if (body.replace(/count\(\*\)/g, '').includes('*')) out.push('a * projection');
    for (const m of body.matchAll(/\b(\w+)\.(\w+)\b/g)) if (alias.has(m[1]) || !WORDS.has(m[2])) out.push(`${m[0]} (unquoted)`);
    const bare = body.replace(/"[^"]*"/g, ' ').replace(/\b\w+\.\w+\b/g, ' ').replace(/\bAS\s+\w+/g, ' ');
    for (const m of bare.matchAll(/\b[A-Za-z_]\w*\b/g)) if (!WORDS.has(m[0])) out.push(`unquoted ${m[0]}`);
    return out;
  };
  const raws = [...read('src/lib/services/recruiterNetworkService.js').matchAll(/\$queryRaw`([\s\S]*?)`/g)].map((m) => m[1]);
  ok('the service holds exactly the 10 tagged raw statements (tree, ancestry, roots, children, node card, unplaced, stats-orders, stats, downline, progress-qualified — Stage B + the details view)',
    eq(raws.map((s) => /\/\* ([\w-]+) \*\//.exec(s)?.[1]), ['recruiter-network-tree', 'recruiter-network-ancestry', 'recruiter-network-roots', 'recruiter-network-children', 'recruiter-network-node', 'recruiter-network-unplaced',
      'recruiter-network-stats-orders', 'recruiter-network-stats', 'recruiter-network-downline', 'recruiter-progress-qualified']), raws.map((s) => /\/\* ([\w-]+) \*\//.exec(s)?.[1]).join(','));
  const found = raws.flatMap((s) => violations(s).map((v) => `${/\/\* ([\w-]+) \*\//.exec(s)?.[1]}: ${v}`));
  ok('every double-quoted identifier of the raw SQL is an allowlisted table / column (affiliates: id, parentId, username, name, isActive, createdAt; links: affiliateId, recruiterId, createdAt; identity: affiliateId, status; orders: affiliateId, status, isFake; alias "linkedAt") — and no *, no unquoted column, no other table',
    found.length === 0, found.join(' | '));
  const hostile = ['SELECT a."phone" FROM "affiliates" a', 'SELECT o.total FROM "affiliate_orders" o', 'SELECT a.* FROM "affiliates" a', 'SELECT * FROM "affiliates" a',
    'SELECT r."id" FROM "recruiters" r', 'SELECT password FROM "affiliates" a', 'SELECT iv."cinFrontFile" FROM "identity_verifications" iv',
    'SELECT x."createdAt" FROM "identity_verifications" x', 'SELECT a."id" FROM affiliates a', 'SELECT "total" FROM "affiliate_orders" o', 'SELECT o."clientName" FROM "affiliate_orders" o'];
  ok('… the check is live: each of 11 hostile statements (another column, quoted or not, *, another table) is flagged', hostile.every((h) => violations(h).length > 0),
    hostile.filter((h) => !violations(h).length).join(' | '));
  // Whole-row references of a table alias (no column named: every column of the row reaches the result).
  const wholeRow = ['SELECT a FROM "affiliates" a', 'SELECT row_to_json(a) FROM "affiliates" a', 'SELECT to_jsonb(o) FROM "affiliate_orders" o',
    'SELECT a.* FROM "affiliates" a', 'SELECT (a).password FROM "affiliates" a', 'SELECT count(a) FROM "affiliates" a',
    'SELECT t."id" FROM (SELECT a FROM "affiliates" a) t', 'SELECT l."affiliateId", iv FROM "recruiter_affiliate_links" l JOIN "identity_verifications" iv ON iv."affiliateId" = l."affiliateId"',
    'SELECT x FROM "affiliates" AS x', 'SELECT a."id" FROM "affiliates" a WHERE a IS NOT NULL'];
  const wr = wholeRow.map((h) => [h, violations(h)]);
  ok(`… whole-row references are flagged as such: ${wholeRow.length} statements using a table alias as a value (a, row_to_json(a), a.*, (a).col, count(a), a sub-select, an AS alias)`,
    wr.every(([, v]) => v.some((x) => /^whole-row reference \w+ of (affiliates|affiliate_orders|identity_verifications)/.test(x))), wr.filter(([, v]) => !v.some((x) => /^whole-row/.test(x))).map(([h, v]) => `${h} → ${v.join(';')}`).join(' | '));
  // Tables aliased with AS: the table and its alias are checked like `"table" a`.
  const asAlias = [['SELECT x."status" FROM "affiliates" AS x', /^x\."status" of affiliates$/], ['SELECT x."isFake" FROM "affiliates" as x', /^x\."isFake" of affiliates$/],
    ['SELECT r."id" FROM "recruiters" AS r', /^table "recruiters"$/], ['SELECT a."id" FROM "affiliates" a JOIN "recruiters" AS r ON r."id" = a."id"', /^table "recruiters"$/],
    ['SELECT a2."createdAt" FROM "identity_verifications" AS a2', /^a2\."createdAt" of identity_verifications$/],
    ['SELECT o."status" FROM "affiliates" AS o', /^o\."status" of affiliates$/], ['SELECT a."id" FROM "affiliates" a JOIN "affiliate_orders" AS a ON true', /^alias a names two tables$/]];
  const av = asAlias.map(([h, re]) => [h, violations(h), re]);
  ok(`… tables aliased with AS (upper or lower case) are checked like "table" a: ${asAlias.length} statements (a column outside the alias's table, another table, an alias reused) flagged with the exact reason`,
    av.every(([, v, re]) => v.some((x) => re.test(x))), av.filter(([, v, re]) => !v.some((x) => re.test(x))).map(([h, v]) => `${h} → ${v.join(';')}`).join(' | '));
  ok('… and a clean statement with an AS alias passes (no false positive)', violations('SELECT x."id", x."parentId" FROM "affiliates" AS x JOIN "recruiter_affiliate_links" AS l ON l."affiliateId" = x."id"').length === 0,
    violations('SELECT x."id", x."parentId" FROM "affiliates" AS x JOIN "recruiter_affiliate_links" AS l ON l."affiliateId" = x."id"').join(';'));
}
{
  // 11g (vi). canViewOrders off → no statement reads affiliate_orders (model call, raw SQL, or a
  // relation select / include / _count / filter of orders on another model — seen through withCallLog).
  const E0 = setup();
  const calls = [];
  const cdb = withCallLog(E0.db, calls);
  const ch = recruiterNetworkHandlers({ db: cdb, rateLimit: noLimit });
  const E = { ...E0, db: cdb, stats: withRecruiterAuth(ch.stats), nodes: withRecruiterAuth(ch.nodes) };
  const NO = E.db._seed.recruiter({ username: 'net.noorders', name: 'Sans commandes', canViewOrders: false });
  const r = aff(E, NO, { isActive: true }); const c = aff(E, NO, { parentId: r.id }); aff(E, NO, { parentId: c.id });
  const u1 = aff(E, NO); const u2 = aff(E, NO, { parentId: u1.id });
  E.db._tables.affiliate.find((a) => a.id === u1.id).parentId = u2.id; // u1 ⇄ u2 → unplaced
  for (const a of [r, c, u1]) { E.db._seed.order({ affiliateId: a.id, status: 'delivered' }); E.db._seed.order({ affiliateId: a.id, status: 'pending', isFake: true }); }
  E.db._seed.identity({ affiliateId: c.id, status: 'APPROVED' });
  const reads = (log) => ({ model: log.filter((l) => l.model === 'affiliateOrder').length, raw: log.filter((l) => l.model === '$queryRaw' && /affiliate_orders/.test(l.sql)).length, raws: log.filter((l) => l.model === '$queryRaw').length });
  // rel = model calls (other than affiliateOrder) whose args mention orders + affiliateOrder calls the fake refused before logging.
  const during = async (f) => {
    const mark = E.db._log.length; const cmark = calls.length; const out = await f();
    const o = orderReadsOf(E.db, calls.slice(cmark), mark);
    return { out, ...reads(E.db._log.slice(mark)), rel: o.viaArgs.length + o.unlogged.length, calls: calls.length - cmark, tags: E.db._log.slice(mark).filter((l) => l.model === '$queryRaw').map((l) => /\/\* ([\w-]+) \*\//.exec(l.sql)?.[1]) };
  };
  const views = { 'stats (whole)': () => stats(E, NO), 'stats (rootId)': () => stats(E, NO, r.id), roots: () => nodes(E, NO), children: () => nodes(E, NO, { parentId: r.id }), unplaced: () => nodes(E, NO, { view: 'unplaced' }) };
  for (const [k, f] of Object.entries(views)) {
    const d = await during(f);
    const ordersNull = k.startsWith('stats') ? d.out.body.stats.orders === null && d.out.body.stats.levels.every((l) => l.orders === null) : d.out.body.nodes.length > 0 && d.out.body.nodes.every((v) => v.orders === null);
    ok(`canViewOrders off → ${k}: 200, orders null, ZERO affiliateOrder calls, ZERO model call whose args mention orders (of ${d.calls}), and ZERO of its ${d.raws} raw statement(s) mention affiliate_orders`,
      d.out.status === 200 && ordersNull && d.model === 0 && d.raw === 0 && d.rel === 0 && d.calls >= 1 && d.raws >= 1 && !d.tags.includes('recruiter-network-stats-orders'), JSON.stringify({ ...d, out: d.out.text.slice(0, 120) }));
  }
  const svc = (includeOrders) => ({
    'stats (whole)': () => S.getNetworkStats(NO.id, { db: E.db, includeOrders }), 'stats (rootId)': () => S.getNetworkStats(NO.id, { db: E.db, rootId: r.id, includeOrders }),
    roots: () => S.getNetworkNodes(NO.id, { db: E.db, includeOrders }), children: () => S.getNetworkNodes(NO.id, { db: E.db, parentId: r.id, includeOrders }),
    unplaced: () => S.getNetworkNodes(NO.id, { db: E.db, view: 'unplaced', includeOrders }),
  });
  const off = []; const on = [];
  for (const [k, f] of Object.entries(svc(false))) off.push([k, await during(f)]);
  for (const [k, f] of Object.entries(svc(true))) on.push([k, await during(f)]);
  ok('service includeOrders:false (stats whole + subtree, roots, children, unplaced): zero affiliateOrder calls, zero raw statements mentioning affiliate_orders, zero model calls whose args mention orders, the stats statement without orders',
    off.every(([, d]) => d.model === 0 && d.raw === 0 && d.rel === 0 && d.calls >= 1) && off.filter(([k]) => k.startsWith('stats')).every(([, d]) => d.tags.includes('recruiter-network-stats')), JSON.stringify(off.map(([k, d]) => [k, d.model, d.raw, d.rel, d.tags])));
  ok('service includeOrders:true: stats (whole and subtree) → exactly ONE raw statement mentioning affiliate_orders (stats-orders) and no affiliateOrder call; every node page → one affiliateOrder.groupBy and no raw order SQL',
    on.filter(([k]) => k.startsWith('stats')).every(([, d]) => d.raw === 1 && d.model === 0 && d.rel === 0 && d.tags.includes('recruiter-network-stats-orders'))
    && on.filter(([k]) => !k.startsWith('stats')).every(([, d]) => d.raw === 0 && d.model === 1 && d.rel === 0), JSON.stringify(on.map(([k, d]) => [k, d.model, d.raw, d.tags])));
  ok('… and the counts are there when allowed: whole network real delivered 2 / fake pending 2 (the unplaced member\'s orders excluded), root r real delivered 1',
    on[0][1].out.orders.real.delivered === 2 && on[0][1].out.orders.fake.pending === 2 && on[2][1].out.nodes[0].orders.real.delivered === 1);
  // The detector is live: an order read through a relation of another model (or an affiliateOrder op the
  // fake refuses before logging) counts as an order read; orderBy and canViewOrders do not.
  const ids = { in: [r.id, c.id] };
  const hostileReads = {
    'affiliate.findMany include affiliateOrders': () => E.db.affiliate.findMany({ where: { id: ids }, select: { id: true }, include: { affiliateOrders: true } }),
    'affiliate.findMany select orders': () => E.db.affiliate.findMany({ where: { id: ids }, select: { id: true, orders: { select: { status: true } } } }),
    'affiliate.findMany _count of affiliateOrders': () => E.db.affiliate.findMany({ where: { id: ids }, select: { id: true, _count: { select: { affiliateOrders: true } } } }),
    'recruiterAffiliateLink.findMany nested affiliate.affiliateOrders': () => E.db.recruiterAffiliateLink.findMany({ where: { recruiterId: NO.id }, select: { affiliate: { select: { affiliateOrders: { where: { isFake: false }, select: { status: true } } } } } }),
    'recruiterAffiliateLink.count filtered on orders': () => E.db.recruiterAffiliateLink.count({ where: { recruiterId: NO.id, affiliate: { affiliateOrders: { some: { status: 'delivered' } } } } }),
    'affiliateOrder.findMany (refused unlogged)': () => E.db.affiliateOrder.findMany({ where: { affiliateId: r.id }, select: { status: true } }),
  };
  const caught = [];
  for (const [k, f] of Object.entries(hostileReads)) {
    const d = await during(() => Promise.resolve().then(f).catch(() => null));
    caught.push([k, d.model + d.raw + d.rel]);
  }
  ok(`… the order-read detector is live: ${caught.length} hostile reads (include / select / _count / a relation filter of orders on affiliate or link, an affiliateOrder op refused before logging) each count as exactly ONE order read`,
    caught.every(([, n]) => n === 1), JSON.stringify(caught));
  const benign = await during(async () => {
    await E.db.recruiter.findUnique({ where: { id: NO.id }, select: { id: true, canViewOrders: true } });
    await E.db.recruiterAffiliateLink.findMany({ where: { recruiterId: NO.id }, orderBy: { createdAt: 'asc' }, select: { affiliateId: true } });
  });
  ok('… and is precise: reading the canViewOrders flag or an orderBy is not an order read', benign.model + benign.raw + benign.rel === 0 && benign.calls === 2, JSON.stringify({ ...benign, out: null }));
}

{
  // 11h (vii). Early returns and defensive branches: a recruiter with ZERO members, a malformed
  // recruiter id, a cursor beyond the int4 OFFSET range.
  const E = setup();
  const b1 = aff(E, E.B); const b2 = aff(E, E.B, { parentId: b1.id }); // B has a network, A has none
  const loose = aff(E, null);
  E.db._seed.order({ affiliateId: b1.id, status: 'delivered' });
  const probes = [['B\'s root', b1.id], ['B\'s child', b2.id], ['an unlinked affiliate', loose.id], ['an unknown id', randomUUID()], ['a malformed id', 'bad id!']];
  const http = [];
  for (const [label, id] of probes) http.push([label, await stats(E, E.A, id).then(track), await nodes(E, E.A, { parentId: id }).then(track)]);
  ok(`zero members: stats?rootId and nodes?parentId → 404 NOT_FOUND for ${probes.map(([l]) => l).join(', ')}`,
    http.every(([, s, n]) => s.status === 404 && s.text === '{"code":"NOT_FOUND"}' && n.status === 404 && n.text === '{"code":"NOT_FOUND"}'), http.map(([l, s, n]) => `${l}: ${s.status}/${n.status}`).join(' | '));
  const svcNF = [];
  for (const includeOrders of [true, false]) {
    for (const [, id] of probes) {
      const mark = E.db._log.length;
      const a = await S.getNetworkStats(E.A.id, { db: E.db, rootId: id, includeOrders }).then(() => 'resolved', (e) => e.code);
      const b = await S.getNetworkNodes(E.A.id, { db: E.db, parentId: id, includeOrders }).then(() => 'resolved', (e) => e.code);
      svcNF.push({ a, b, ops: E.db._log.slice(mark).map((l) => `${l.model}.${l.op}`) });
    }
  }
  ok('zero members, service (orders on and off): rootId / parentId → NOT_FOUND after the member count only (no path / page / stats statement)',
    svcNF.every((v) => v.a === 'NOT_FOUND' && v.b === 'NOT_FOUND' && eq(v.ops, ['recruiterAffiliateLink.count', 'recruiterAffiliateLink.count'])), JSON.stringify(svcNF.slice(0, 2)));
  const EMPTY_PAGE = { parent: null, parentNode: null, path: [], nodes: [], total: 0, nextCursor: null };
  const zeroTotals = { affiliates: 0, direct: 0, active: 0, inactive: 0, maxLevel: 0, unplaced: 0 };
  const results = [];
  for (const includeOrders of [true, false]) {
    const mark = E.db._log.length;
    const st = await S.getNetworkStats(E.A.id, { db: E.db, includeOrders });
    const st2 = await S.getNetworkStats(E.A.id, { db: E.db, rootId: '', includeOrders });
    const pages = await Promise.all([{}, { view: 'unplaced' }, { cursor: 5, limit: 3 }, { view: 'unplaced', parentId: b1.id }, { parentId: '' }]
      .map((p) => S.getNetworkNodes(E.A.id, { db: E.db, includeOrders, ...p })));
    results.push({ includeOrders, st, st2, pages, ops: [...new Set(E.db._log.slice(mark).map((l) => `${l.model}.${l.op}`))] });
  }
  ok('zero members: stats without rootId (or rootId "") → zero totals, zero identity, no level; orders zero-filled when allowed, null when includeOrders false',
    results.every(({ includeOrders, st, st2 }) => [st, st2].every((v) => v.rootId === null && eq(v.totals, zeroTotals) && eq(v.identity, { APPROVED: 0, PENDING: 0, REJECTED: 0, NONE: 0 }) && eq(v.levels, [])
      && (includeOrders ? eq(v.orders, { real: zeroOrders(), fake: zeroOrders() }) : v.orders === null))), JSON.stringify(results.map((x) => x.st)));
  ok('zero members: nodes roots / unplaced / a cursor page / unplaced with a parentId / parentId "" → { parent null, path [], nodes [], total 0, nextCursor null } (orders on and off)',
    results.every(({ pages }) => pages.every((p) => eq(p, EMPTY_PAGE))), JSON.stringify(results.map((x) => x.pages)));
  ok('zero members: those requests run only the member count (no raw statement, no order / identity / affiliate read)', results.every(({ ops }) => eq(ops, ['recruiterAffiliateLink.count'])), JSON.stringify(results.map((x) => x.ops)));
  const viaHttp = await Promise.all([stats(E, E.A), nodes(E, E.A), nodes(E, E.A, { view: 'unplaced' })].map((p) => p.then(track)));
  ok('zero members over HTTP: stats 200 with zero totals, nodes / unplaced 200 with the empty page',
    viaHttp[0].status === 200 && eq(viaHttp[0].body.stats.totals, zeroTotals) && eq(viaHttp[0].body.stats.levels, []) && viaHttp.slice(1).every((r) => r.status === 200 && eq(r.body, EMPTY_PAGE)));

  // A malformed recruiter id → UNAUTHORIZED before any query (stats and nodes, any option).
  const badIds = ['bad id!', '', 'x'.repeat(101), "a'b", '../x', 42, null, undefined, { id: E.A.id }, [E.A.id]];
  const bad = [];
  for (const id of badIds) {
    const mark = E.db._log.length;
    const out = await Promise.all([
      S.getNetworkStats(id, { db: E.db }), S.getNetworkStats(id, { db: E.db, rootId: b1.id, includeOrders: false }),
      S.getNetworkNodes(id, { db: E.db }), S.getNetworkNodes(id, { db: E.db, parentId: b1.id }), S.getNetworkNodes(id, { db: E.db, view: 'unplaced', includeOrders: false }),
    ].map((p) => p.then(() => 'resolved', (e) => e.code)));
    bad.push({ id: String(id).slice(0, 20), out, queries: E.db._log.length - mark });
  }
  ok(`a malformed recruiter id (${badIds.length} kinds: spaces, empty, 101 chars, quote, path, number, null, undefined, object, array) → getNetworkStats / getNetworkNodes reject UNAUTHORIZED with ZERO database calls`,
    bad.every((v) => v.out.every((c) => c === 'UNAUTHORIZED') && v.queries === 0), JSON.stringify(bad.filter((v) => !(v.out.every((c) => c === 'UNAUTHORIZED') && v.queries === 0))));

  // A cursor beyond int4: OFFSET is clamped to 2147483647 (bound as ::int), the page is empty, total kept.
  const F = setup();
  const roots = Array.from({ length: 3 }, () => aff(F, F.A).id);
  aff(F, F.A, { parentId: roots[0] });
  const x = aff(F, F.A); const y = aff(F, F.A, { parentId: x.id }); F.db._tables.affiliate.find((a) => a.id === x.id).parentId = y.id; // unplaced 2
  const INT4_MAX = 2147483647;
  const seen = [];
  const spy = spyRaw(F.db, seen);
  const big = [];
  for (const cursor of [2 ** 31, 1e12, Number.MAX_SAFE_INTEGER, INT4_MAX]) {
    for (const [label, opts, total] of [['roots', {}, 3], ['children', { parentId: roots[0] }, 1], ['unplaced', { view: 'unplaced' }, 2]]) {
      const at = seen.length;
      const out = await S.getNetworkNodes(F.A.id, { db: spy, cursor, ...opts }).then((v) => v, (e) => ({ error: e?.message }));
      const pageCall = seen.slice(at).find((s) => ['recruiter-network-roots', 'recruiter-network-children', 'recruiter-network-unplaced'].includes(s.tag)); // Stage B tags
      const i = pageCall ? pageCall.strings.findIndex((s) => /OFFSET $/.test(s.replace(/\s+/g, ' '))) : -1;
      big.push({ cursor, label, out, total, offset: i >= 0 ? pageCall.values[i] : undefined, nextOffsetCast: i >= 0 ? pageCall.strings[i + 1].startsWith('::int') : false });
    }
  }
  ok('a direct service call with cursor 2**31, 1e12, MAX_SAFE_INTEGER or 2147483647 → nodes [], total kept (roots 3 / children 1 / unplaced 2), nextCursor null — no error',
    big.every((v) => !v.out.error && eq(v.out.nodes, []) && v.out.total === v.total && v.out.nextCursor === null), JSON.stringify(big.filter((v) => !(eq(v.out.nodes, []) && v.out.total === v.total && v.out.nextCursor === null))));
  ok('… the OFFSET bound to the ::int placeholder is ≤ 2147483647 (exactly 2147483647: clamped, never 2**31 or 1e12)',
    big.every((v) => v.nextOffsetCast && Number.isInteger(v.offset) && v.offset === INT4_MAX), JSON.stringify(big.map((v) => [v.cursor, v.label, v.offset])));
}

// ── 12. the former in-memory implementation versus the SQL one ───────────────
console.log('\n12. Part 5b equivalence: the former in-memory implementation and the SQL statements agree on the same data');
// Stage B: the datasets are built so that every recruiter's downline D(R) equals its linked network (a
// child of a linked affiliate is linked to the SAME recruiter; re-parenting keeps that), the only case
// where the former linked-only implementation is the reference. The new results are compared after
// removing the additive linkedToMe fields and converting a sub-network's ABSOLUTE levels back to the
// former relative ones (level − (its first level − 1)). D(R) ≠ linked(R) is checked against a brute-force
// oracle in scripts/recruiterDownlineProgress.test.mjs.
{
  const BASE = '7e111e10df7c2413820f34a52fe200aebdefa72e'; // the last commit before Part 5b (whole tree loaded in memory)
  /** The service as of `base` → { mod } or { why } (a clear reason; this check never skips: it fails). */
  const loadOld = async (base) => {
    const errText = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
    try {
      execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return { why: `commit ${base} is not in this clone (a shallow or partial clone? fetch the history, e.g. git fetch --unshallow) — git: ${errText(e)}` };
    }
    let src;
    try {
      src = execFileSync('git', ['show', `${base}:src/lib/services/recruiterNetworkService.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return { why: `git show ${base.slice(0, 7)}:src/lib/services/recruiterNetworkService.js failed — git: ${errText(e)}` };
    }
    const code = src.replace(/^import prisma from '\.\.\/prisma\.js';$/m, 'const prisma = null;');
    if (code === src) return { why: `the file at ${base.slice(0, 7)} has no "import prisma from '../prisma.js';" line to stub` };
    try {
      const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
      if (typeof mod.getNetworkNodes !== 'function' || typeof mod.getNetworkStats !== 'function') return { why: `the file at ${base.slice(0, 7)} does not export getNetworkNodes / getNetworkStats` };
      return { mod };
    } catch (e) {
      return { why: `importing the file at ${base.slice(0, 7)} failed: ${errText(e)}` };
    }
  };
  const missing = await loadOld('0123456789abcdef0123456789abcdef01234567');
  ok('the loader reports a missing commit with a clear message (no cryptic error, no skip)', !missing.mod && /^commit 0123456789abcdef0123456789abcdef01234567 is not in this clone \(a shallow or partial clone\?/.test(missing.why ?? ''), missing.why);
  const loaded = await loadOld(BASE);
  const OLD = loaded.mod ?? null;
  if (!OLD) console.log(`  ERROR the Part 5b equivalence check cannot run: ${loaded.why}`);
  ok(`the former implementation loads from commit ${BASE.slice(0, 7)} (git show)`, typeof OLD?.getNetworkNodes === 'function' && typeof OLD?.getNetworkStats === 'function', loaded.why ?? '');
  if (OLD) {
    const rand = (s) => () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const STATUSES = ['delivered', 'Delivered', ' delivered', 'pending', 'confirmed', 'shipped', 'cancelled', 'canceled', 'returned', 'refused', 'lost', ''];
    const run = async (f) => { try { return { ok: await f() }; } catch (e) { return { err: e?.code ?? String(e?.message) }; } };
    let checked = 0; let withUnplaced = 0; let notFound = 0; let emptyPages = 0;
    // Stage B: drop the additive linkedToMe fields; a sub-network's absolute levels → the former relative ones.
    const normNew = (r) => {
      if (!r.ok) return r;
      const v = JSON.parse(JSON.stringify(r.ok));
      // simplified dashboard: the scope's own card is new (the old service has none) — checked for consistency with
      // the page it rides on (children = the page total; a complete first page sums to its descendants), then dropped
      if ('parentNode' in v) {
        const pn = v.parentNode;
        if (pn !== null && !(pn.childrenCount === v.total && v.parent && pn.id === v.parent.id && pn.level === v.parent.level
          && (v.nextCursor !== null || pn.descendantsCount === v.nodes.reduce((n, x) => n + 1 + x.descendantsCount, 0)))) cardIssues.push(JSON.stringify({ pn, total: v.total }).slice(0, 200));
        delete v.parentNode;
      }
      if (Array.isArray(v.nodes)) { for (const x of [...v.nodes, ...v.path, ...(v.parent ? [v.parent] : [])]) delete x.linkedToMe; }
      if (Array.isArray(v.levels) && v.rootId !== null && v.levels.length) {
        const shift = Math.min(...v.levels.map((l) => l.level)) - 1;
        for (const l of v.levels) l.level -= shift;
        v.totals.maxLevel -= shift;
      }
      return { ok: v };
    };
    const mismatches = [];
    const cardIssues = [];
    const DATASETS = 24;
    for (let seed = 1; seed <= DATASETS; seed++) {
      const rnd = rand(seed * 7919);
      const pick = (list) => list[Math.floor(rnd() * list.length)];
      const deep = seed % 2 === 0; // even datasets: long chains
      const E = setup();
      const ids = [];
      const used = new Set();
      const ownerOf = new Map(); // affiliate id → recruiter id it is linked to (Stage B)
      for (let i = 0, n = 15 + Math.floor(rnd() * 25); i < n; i++) {
        let id; do { id = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick([...'aAbB0_-zZ9'])).join(''); } while (used.has(id));
        used.add(id);
        const parentId = ids.length && rnd() < 0.85 ? (deep && rnd() < 0.7 ? ids[ids.length - 1] : pick(ids)) : null;
        E.db._seed.affiliate({ id, username: `eq${seed}.${i}`, name: `N ${i}`, isActive: rnd() < 0.5, parentId, createdAt: new Date(T0 + Math.floor(rnd() * 4) * 1000) });
        ids.push(id);
        const owner = rnd();
        const forced = parentId ? ownerOf.get(parentId) ?? null : null; // Stage B: D(R) == linked(R)
        const rec = forced ?? (owner < 0.85 ? (owner < 0.6 ? E.A.id : E.B.id) : null);
        const linkAt = new Date(T0 + Math.floor(rnd() * 4) * 1000);
        if (rec) { E.db._seed.link({ affiliateId: id, recruiterId: rec, createdAt: linkAt }); ownerOf.set(id, rec); }
        for (let k = Math.floor(rnd() * 3); k > 0; k--) E.db._seed.order({ affiliateId: id, status: pick(STATUSES), isFake: rnd() < 0.3 });
        if (rnd() < 0.5) E.db._seed.identity({ affiliateId: id, status: pick(['APPROVED', 'PENDING', 'REJECTED', 'WEIRD', 'approved']) });
      }
      for (let k = Math.floor(rnd() * 4); k > 0; k--) { // malformed data: re-parenting → cycles, self-parents, an orphan parent id
        const target = pick(ids);
        const row = E.db._tables.affiliate.find((a) => a.id === target);
        const next = rnd() < 0.25 ? row.id : rnd() < 0.15 ? `ghost-${seed}` : pick(ids);
        // Stage B: never under an affiliate linked to another recruiter, nor a non-linked one under a linked one
        if (next === row.id || !ownerOf.has(next) || ownerOf.get(next) === (ownerOf.get(row.id) ?? null)) row.parentId = next;
      }
      const probes = [...ids, '', 'bad id!', randomUUID(), 'x'.repeat(101)];
      const pages = [{}, { limit: 1 }, { cursor: 1, limit: 2 }, { cursor: 3, limit: 3 }, { cursor: 2 }, { cursor: 1000 }, { limit: 0 }, { limit: 101 }];
      for (const rec of [E.A, E.B]) {
        for (const includeOrders of [true, false]) {
          const same = async (label, f) => {
            const before = await run(() => f(OLD));
            const after = normNew(await run(() => f(S)));
            checked += 1;
            if (before.err === 'NOT_FOUND') notFound += 1;
            if (Array.isArray(before.ok?.nodes) && !before.ok.nodes.length) emptyPages += 1;
            if (!eq(before, after)) mismatches.push(`dataset ${seed} ${rec.username} orders=${includeOrders} ${label}: old ${JSON.stringify(before).slice(0, 300)} / new ${JSON.stringify(after).slice(0, 300)}`);
            return before;
          };
          const whole = await same('stats', (I) => I.getNetworkStats(rec.id, { db: E.db, includeOrders }));
          if (whole.ok?.totals.unplaced > 0) withUnplaced += 1;
          for (const id of probes) await same(`stats rootId=${id}`, (I) => I.getNetworkStats(rec.id, { db: E.db, rootId: id, includeOrders }));
          for (const p of pages) {
            await same(`roots ${JSON.stringify(p)}`, (I) => I.getNetworkNodes(rec.id, { db: E.db, includeOrders, ...p }));
            await same(`unplaced ${JSON.stringify(p)}`, (I) => I.getNetworkNodes(rec.id, { db: E.db, includeOrders, view: 'unplaced', ...p }));
          }
          for (const id of probes) {
            await same(`parentId=${id}`, (I) => I.getNetworkNodes(rec.id, { db: E.db, includeOrders, parentId: id }));
            await same(`parentId=${id} cursor 1 limit 1`, (I) => I.getNetworkNodes(rec.id, { db: E.db, includeOrders, parentId: id, cursor: 1, limit: 1 }));
          }
        }
      }
    }
    ok(`old = new on ${DATASETS} seeded random networks with D(R) == linked(R) (cycles, self-parents, orphan / unlinked parents, createdAt and link ties, mixed-case ids, odd statuses): `
      + `${checked} results identical (${withUnplaced} whole networks with unplaced members, ${notFound} NOT_FOUND, ${emptyPages} empty pages) — stats (whole, every rootId), roots / children / unplaced pages, orders on and off`,
    mismatches.length === 0 && checked > 5000 && withUnplaced > 0 && notFound > 0 && emptyPages > 0, mismatches.slice(0, 3).join('\n'));
  ok('details view: on every random network, every scoped first page carries the scope\'s own card — children = the page total, a complete page sums (1 + descendants) to its descendants',
    cardIssues.length === 0, cardIssues.slice(0, 3).join('\n'));
  }
}

// ── 12. Simplified dashboard: the details view's own card (parentNode) ─────────
console.log('\n12. parentNode: the selected affiliate\'s own card — ALL-level downline, own orders, first page only');
{
  const E = setup();
  // X with 3 children; child c1 has a 4-level chain below it and a second branch; c2 has 2 children → downline 3 + 5 + 2 = 10
  const X = aff(E, E.A);
  const [c1, c2, c3] = [aff(E, E.A, { parentId: X.id }), aff(E, E.A, { parentId: X.id }), aff(E, E.A, { parentId: X.id })];
  const deep = chain(E, E.A, 4, c1.id); // ids
  aff(E, E.A, { parentId: c1.id });
  aff(E, E.A, { parentId: c2.id }); aff(E, E.A, { parentId: c2.id });
  E.db._seed.order({ affiliateId: X.id, status: 'delivered' }); E.db._seed.order({ affiliateId: X.id, status: 'pending' });
  E.db._seed.order({ affiliateId: X.id, status: 'delivered', isFake: true });
  E.db._seed.order({ affiliateId: c1.id, status: 'delivered' }); E.db._seed.order({ affiliateId: deep[3], status: 'delivered' });
  E.db._seed.identity({ affiliateId: X.id, status: 'APPROVED' });
  const r = await nodes(E, E.A, { parentId: X.id });
  const pn = r.body.parentNode;
  const st = (await stats(E, E.A, X.id)).body.stats;
  ok('parentNode = X itself: level 1, 3 direct children (= the page total = stats direct), 10 descendants over ALL levels (= stats totals.affiliates)',
    r.status === 200 && pn.id === X.id && pn.level === 1 && pn.childrenCount === 3 && r.body.total === 3 && st.totals.direct === 3
    && pn.descendantsCount === 10 && st.totals.affiliates === 10, JSON.stringify({ pn, total: r.body.total, st: st.totals }));
  ok('parentNode orders are X\'s OWN orders only (2 real: 1 delivered + 1 pending; 1 test order apart) — never its downline\'s',
    pn.orders.real.total === 2 && pn.orders.real.delivered === 1 && pn.orders.fake.total === 1 && st.orders.real.delivered === 2, JSON.stringify(pn.orders));
  ok('parentNode carries status, identity status, linkedToMe, progress and reward state like every node', pn.status === 'ACTIVE' || pn.status === 'INACTIVE'
    && pn.identityStatus === 'APPROVED' && pn.linkedToMe === true && typeof pn.progress === 'object' && typeof pn.rewardState === 'object');
  ok('each affiliate counted once: the children cards sum to the downline (Σ (1 + descendants) = 10)',
    r.body.nodes.reduce((n, c) => n + 1 + c.descendantsCount, 0) === 10 && eq(r.body.nodes.map((c) => c.id).sort(), [c1.id, c2.id, c3.id].sort()));
  const deeper = await nodes(E, E.A, { parentId: deep[1] });
  ok('a deeper node: its level, its own (chain) downline', deeper.body.parentNode.level === 4 && deeper.body.parentNode.childrenCount === 1 && deeper.body.parentNode.descendantsCount === 2);
  ok('no parentNode on the roots page, on a later page (cursor > 0) or on the unplaced view',
    (await nodes(E, E.A)).body.parentNode === null && (await nodes(E, E.A, { parentId: X.id, cursor: 2 })).body.parentNode === null
    && (await nodes(E, E.A, { view: 'unplaced' })).body.parentNode === null);
  const other = await nodes(E, E.B, { parentId: X.id });
  ok('another recruiter asking for X → 404 NOT_FOUND (no card leaks)', other.status === 404 && other.text === '{"code":"NOT_FOUND"}');
  const NO = E.db._seed.recruiter({ username: 'net.nocard', name: 'Sans commandes', canViewOrders: false });
  const Y = aff(E, NO); aff(E, NO, { parentId: Y.id });
  E.db._seed.order({ affiliateId: Y.id, status: 'delivered' });
  const ny = await nodes(E, NO, { parentId: Y.id });
  ok('canViewOrders off → parentNode.orders null (never zero-filled), counts still there', ny.status === 200 && ny.body.parentNode.orders === null && ny.body.parentNode.childrenCount === 1, JSON.stringify(ny.body.parentNode));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
