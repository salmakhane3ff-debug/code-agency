/**
 * src/lib/services/recruiterNetworkService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 4: the recruiter's network tree and statistics
 * (READ-ONLY; db injected, so tests run on an in-memory fake or an isolated local database).
 * Phase 6 part 5b: the endpoints no longer load the whole network into memory — paging,
 * descendant counts and statistics are computed by PostgreSQL.
 * Phase 7 Stage E introduced the ownership network N(R) = { X : owner(X) = R }, the SAME set the rewards
 * are computed on (recruiterRewardService). Phase 7 Stage F (approved product clarification) changed the
 * precedence: the TOPMOST link wins.
 *
 *   • owner(X) = the recruiter of the TOPMOST linked affiliate of X's chain (X, parent, grandparent…
 *     through affiliates.parentId, up to the top). Once R owns a network, EVERY descendant belongs to R at
 *     any depth: a nested link to another recruiter inside R's network never transfers ownership (a legacy
 *     conflicting link — reported by listRecruiterOwnershipConflicts, never rewritten). Affiliates of other
 *     recruiters are never visible.
 *   • Roots of N(R) = R's linked affiliates that have NO linked ancestor at all and whose chain reaches a top
 *     (the shared `cand / up / rs / roots` CTEs: cand = R's linked affiliates whose parent is not linked to
 *     anyone; up = from each cand's parent upwards, stopping at the first linked affiliate — UNION, so a
 *     cycle ends; root = no linked affiliate met and a top reached, or no parent at all). The normal case
 *     (a recruiter's top affiliates have no parent; its other links sit below a linked parent) walks
 *     nothing: O(links(R)).
 *   • Downward, every step takes EVERY child (no link filter): the placed network = the roots and all their
 *     descendants. A walk down from a root can never enter a parent cycle (a cycle member has no top), so
 *     these walks use UNION ALL with a defensive cap (DEPTH_CAP).
 *   • Corrupt data (a parent cycle — a chain without a top): owner = the one recruiter of every linked
 *     affiliate met on the cycle-safe upward walk, none (a conflict) when there are several. Such members
 *     are never placed in the tree; the statements that need ALL of N(R) (downline, progress / group
 *     qualified, the affiliate list, the wallet reconcile) add them exactly: orph = R's links the placed
 *     walk did not reach, oup = the full upward walk of each (UNION), cseed = those whose walk has no top
 *     and meets no other recruiter, cnet = cseed and their descendants not linked to another recruiter
 *     (UNION). `unplaced` = cseed (R's linked members on such chains).
 *   • Level = depth below the node's root (root = 1) — ONE convention everywhere. A parentId / rootId must
 *     be a PLACED member of N(R) (linked or not), anything else → NOT_FOUND.
 *   • `linkedToMe` (linked to R — "directly recruited") is information only: every member is
 *     reward-eligible.
 *   • Each request runs a fixed number of statements, whatever the size or depth of the network (no
 *     per-node query, no N+1):
 *       recruiter-network-ancestry  walks parentId UP from a parentId / rootId (or ≤ 100 listed
 *                                   affiliates) to the top: placement, level and breadcrumb
 *       recruiter-network-roots     one page of the roots with the total and each node's children /
 *                                   descendants counts (a walk seeded with that page only)
 *       recruiter-network-children  the same for the children of a placed node
 *       recruiter-network-unplaced  one page of R's linked members on a parent cycle owned by R, with the total
 *       recruiter-network-stats     the (sub-)network aggregated by level, activation, identity status
 *                                   (+ the unplaced count); the -orders variant also counts the orders
 *       recruiter-network-downline  |N(R)| and its members linked to R (progress summary)
 *       recruiter-progress-qualified the members of N(R) with ≥ N real delivered orders (progress
 *                                   summary; the same statement text as the group reward's)
 *     plus, for the ≤ PAGE_MAX nodes of a page, one identity query and (orders allowed only) one
 *     order-count query. With includeOrders false, no statement reads affiliate_orders.
 *   • Cost model (N = |N(R)|, L = |linked(R)|, P = page size, h = depth of a node's ancestry):
 *       roots set   one pass over the recruiter's links (index probes) + an upward walk from the parent of
 *                   each link whose parent is unlinked, to the first linked affiliate or the top — O(L) in
 *                   the normal case, never O(L·h) for links below a linked parent.
 *       roots / children page   + a walk seeded with the page only: O(P + members below the page).
 *       whole stats / downline / qualified / list   + one walk down from the roots: O(N) (+ the cyclic
 *                   part: O(orphan links × their chain), nothing in the normal case).
 *       sub-network stats: O(subtree).   ancestry: O(h) primary-key lookups to the top.
 *   • The walks seeded by many rows keep the planner estimates small (unnest(ARRAY(…)) seeds where a
 *     recursive-union estimate would otherwise push a plan over jit_above_cost — Stage E, PG16).
 *   • Every downward step is a LATERAL subquery fenced with OFFSET 0, so PostgreSQL follows
 *     affiliates.parentId through its index node by node instead of joining the whole affiliates
 *     table at every level (Part 5a diagnostic, 10 000-deep chain: 168 s with the per-level join,
 *     0.16 s with index lookups). It needs the index on affiliates("parentId") declared in
 *     prisma/schema.prisma.
 *   • Order: createdAt, then id COLLATE "C" (the byte order the former in-memory sort used);
 *     the cursor stays a plain offset. Unplaced members keep the link order (createdAt,
 *     affiliateId) of the former query.
 *   • Nothing here writes anything. Orders: counts only (status, real / fake), never a customer
 *     name, phone, address, amount or any order field. Identity: the status only, never a document
 *     or a file key. Affiliates: id, parentId, username, name, isActive and createdAt only. Which other
 *     recruiter an affiliate is linked to is never read into a result (the ancestry reads a boolean).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';

// DEPTH_CAP (Phase 7 Stage B): the cap of the walks down from a placed node. Such a walk cannot meet a
// parent cycle (see the header), so the cap is only a defensive bound; it replaces the former
// members + 1 (a downline can be deeper than the recruiter's own link count). Stage F: also the cap of
// the N(R) walk (net) of the downline / qualified / list statements.
export const NETWORK_LIMITS = Object.freeze({ PAGE_DEFAULT: 50, PAGE_MAX: 100, CHUNK: 5000, DEPTH_CAP: 1_000_000 });
export const ORDER_BUCKETS = Object.freeze(['delivered', 'pending', 'confirmed', 'shipped', 'cancelled', 'returned', 'other']);
export const IDENTITY_BUCKETS = Object.freeze(['APPROVED', 'PENDING', 'REJECTED', 'NONE']);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const INT4_MAX = 2147483647; // OFFSET is bound as int4: any larger offset is past the end of every network anyway
const fail = (code) => Object.assign(new Error(code), { code });

/**
 * Existing AffiliateOrder.status (free text, lower case in practice) → reporting bucket.
 * "delivered" is EXACTLY 'delivered' — the same rule as the recruiter reward (a real delivered
 * sale is status === 'delivered' AND isFake === false); any other spelling is `other`, so the
 * network's real delivered count can never exceed the qualifying sales.
 */
export function orderBucket(status) {
  if (status === 'delivered') return 'delivered';
  const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (s === 'pending' || s === 'confirmed' || s === 'shipped') return s;
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'returned' || s === 'refused') return 'returned';
  return 'other';
}
/** Existing IdentityVerification.status (no row = NONE). */
export function identityBucket(status) {
  return status === 'APPROVED' || status === 'PENDING' || status === 'REJECTED' ? status : 'NONE';
}

const emptyOrders = () => Object.fromEntries([...ORDER_BUCKETS, 'total'].map((k) => [k, 0]));
const emptyIdentity = () => Object.fromEntries(IDENTITY_BUCKETS.map((k) => [k, 0]));
const chunks = (arr, n = NETWORK_LIMITS.CHUNK) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const given = (v) => v !== null && v !== undefined && v !== '';

/**
 * The whole network of a recruiter, from its roots downwards. ONE recursive query.
 * → { nodes: Map(id → { id, parentId, depth, active, createdAt, children: [] }), roots: [ids], members, unplaced }
 * Since Part 5b the endpoints no longer call it (kept for diagnostics and the tests). It is the
 * former LINKED-ONLY network (Phase 7 Stages B and E left it unchanged): the endpoints show N(R).
 */
export async function loadNetworkTree(recruiterId, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const members = await db.recruiterAffiliateLink.count({ where: { recruiterId } });
  if (!members) return { nodes: new Map(), roots: [], members: 0, unplaced: 0 };
  const bound = members + 1; // a tree of N members is at most N levels deep
  const rows = await db.$queryRaw`
    /* recruiter-network-tree */
    WITH RECURSIVE tree AS (
      SELECT a."id", a."parentId", a."isActive", a."createdAt", 1 AS depth
      FROM "recruiter_affiliate_links" l
      JOIN "affiliates" a ON a."id" = l."affiliateId"
      WHERE l."recruiterId" = ${recruiterId}
        AND (a."parentId" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "recruiter_affiliate_links" pl
          WHERE pl."affiliateId" = a."parentId" AND pl."recruiterId" = ${recruiterId}))
      UNION ALL
      SELECT c."id", c."parentId", c."isActive", c."createdAt", t.depth + 1
      FROM tree t
      JOIN "affiliates" c ON c."parentId" = t."id"
      JOIN "recruiter_affiliate_links" cl ON cl."affiliateId" = c."id" AND cl."recruiterId" = ${recruiterId}
      WHERE t.depth < ${bound}::int
    )
    SELECT "id", "parentId", "isActive", "createdAt", depth::int AS depth FROM tree`;

  const nodes = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (typeof r?.id !== 'string') continue;
    const depth = Number(r.depth);
    const prev = nodes.get(r.id);
    if (prev && prev.depth <= depth) continue; // defensive: keep the shortest path only
    nodes.set(r.id, { id: r.id, parentId: r.parentId ?? null, depth, active: r.isActive === true, createdAt: r.createdAt ? new Date(r.createdAt) : null, children: [] });
  }
  const roots = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : null;
    if (parent && parent.depth === n.depth - 1) parent.children.push(n.id);
    else if (n.depth === 1) roots.push(n.id);
  }
  const byCreated = (a, b) => (nodes.get(a).createdAt?.getTime() ?? 0) - (nodes.get(b).createdAt?.getTime() ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  roots.sort(byCreated);
  for (const n of nodes.values()) n.children.sort(byCreated);
  return { nodes, roots, members, unplaced: Math.max(0, members - nodes.size) };
}

/** Number of members (link rows = linked(R)) of a recruiter's network. */
async function memberCount(db, recruiterId) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  return db.recruiterAffiliateLink.count({ where: { recruiterId } });
}

// ── Phase 7 Stage B → Stage E → Stage F: placement in the network N(R) ──────────────────

/**
 * The ancestry of `ids` (≤ PAGE_MAX ids) upwards: Map(id → { id, parentId, username, name, link })
 * where link = 'mine' (linked to THIS recruiter), 'other' (linked to another recruiter — which one is
 * never read) or null (no link). ONE recursive statement walking parentId UPWARDS (primary-key
 * lookups); `mine` is the tri-state (x.recruiterId = R) of the affiliate's link row (NULL = no link).
 * Phase 7 Stage F: the walk goes to the TOP (the topmost link decides the owner, a nested link of
 * another recruiter no longer stops it); UNION keeps each affiliate once, so a parent cycle ends after
 * one lap. A parentId '' (no parent) ends the walk like NULL. The ids are seeded through
 * unnest(ARRAY(…)) + a fenced primary-key lookup (a fixed small planner estimate: with the bound array's
 * real size the estimate of the walk to the top crossed jit_above_cost — measured on PG16).
 */
async function ancestryRows(db, recruiterId, ids) {
  const rows = await db.$queryRaw`
    /* recruiter-network-ancestry */
    WITH RECURSIVE up AS (
      SELECT sa."id", sa."parentId", sa."username", sa."name", sa.mine
      FROM unnest(ARRAY(SELECT unnest(${ids}::text[]))) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId", f."username", f."name",
               (SELECT x."recruiterId" = ${recruiterId} FROM "recruiter_affiliate_links" x
                WHERE x."affiliateId" = f."id") AS mine
        FROM "affiliates" f
        WHERE f."id" = s."id"
        OFFSET 0
      ) sa
      UNION
      SELECT p."id", p."parentId", p."username", p."name", p.mine
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId", a."username", a."name",
               (SELECT x."recruiterId" = ${recruiterId} FROM "recruiter_affiliate_links" x
                WHERE x."affiliateId" = a."id") AS mine
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    )
    SELECT u."id", u."parentId", u."username", u."name", u.mine FROM up u`;
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (typeof r?.id !== 'string' || map.has(r.id)) continue;
    map.set(r.id, {
      id: r.id, parentId: typeof r.parentId === 'string' && r.parentId !== '' ? r.parentId : null,
      username: r.username ?? null, name: r.name ?? null, link: r.mine === true ? 'mine' : r.mine === false ? 'other' : null,
    });
  }
  return map;
}

const OUT = Object.freeze({ out: true });
const CYCLIC = Object.freeze({ cyclic: true });
// Internal states of a chain read from the top down (never returned).
const NONE = Object.freeze({ none: true }); // no linked affiliate at or above (yet)
const FOREIGN = Object.freeze({ foreign: true }); // the topmost link belongs to another recruiter
const CYC_NONE = Object.freeze({ cycNone: true }); // on / below a parent cycle, no link met yet
const CYC_MINE = Object.freeze({ cycMine: true }); // on / below a parent cycle, only R's links met
const CYC_MIXED = Object.freeze({ cycMixed: true }); // on / below a parent cycle, another recruiter's link met
/**
 * Placement of the affiliates of an ancestry map (memoized, O(map size), never loops) — Phase 7 Stage F
 * (TOPMOST link wins): (id) →
 *   { root, dist } id ∈ N(R) and placed: root = the topmost linked affiliate of its chain (linked to R,
 *                  with a top above it), dist = steps from id up to it (level = dist + 1);
 *   OUT            owner(id) ≠ R (the topmost link is another recruiter's, no link at all, or a parent
 *                  cycle whose links are not all R's — a conflict);
 *   CYCLIC         owner(id) = R but its chain ends in a parent cycle (no top: unplaced);
 *   null           no such affiliate in the map.
 * Read from the top down: below NONE, an affiliate linked to R starts R's placement (root), linked to
 * another recruiter → FOREIGN, unlinked → NONE; below a placed node → placed (+1 step) whatever the
 * affiliate's own link; FOREIGN stays FOREIGN. A parent cycle: its members' state = the links of the
 * whole cycle (none / only R's / another's), then the same rule below it (CYC_*).
 */
function placementOf(rows) {
  const memo = new Map();
  const placed = (p) => p && p.root !== undefined;
  const below = (n, up) => {
    if (placed(up)) return { root: up.root, dist: up.dist + 1 };
    if (up === FOREIGN) return FOREIGN;
    if (up === CYC_MIXED || up === CYC_MINE || up === CYC_NONE) {
      if (n.link === 'other' || up === CYC_MIXED) return CYC_MIXED;
      return n.link === 'mine' || up === CYC_MINE ? CYC_MINE : CYC_NONE;
    }
    return n.link === 'mine' ? { root: n.id, dist: 0 } : n.link === 'other' ? FOREIGN : NONE;
  };
  const state = (start) => {
    if (memo.has(start)) return memo.get(start);
    if (!rows.has(start)) return null;
    const stack = [];
    const index = new Map();
    let up = NONE; // state above the last stacked node (NONE = nothing above: the top)
    for (let cur = start; ;) {
      if (memo.has(cur)) { up = memo.get(cur); break; }
      const n = rows.get(cur);
      if (!n) break; // past the top (no parent, or a parent id with no affiliate)
      if (index.has(cur)) { // a parent cycle: stack[at…] is the cycle
        const cycle = stack.splice(index.get(cur));
        const links = new Set(cycle.map((x) => x.link).filter(Boolean));
        const st = links.has('other') ? CYC_MIXED : links.has('mine') ? CYC_MINE : CYC_NONE;
        for (const x of cycle) memo.set(x.id, st);
        up = st;
        break;
      }
      index.set(cur, stack.length);
      stack.push(n);
      if (n.parentId === null) break;
      cur = n.parentId;
    }
    for (let i = stack.length - 1; i >= 0; i--) { up = below(stack[i], up); memo.set(stack[i].id, up); }
    return memo.get(start);
  };
  return (start) => {
    const st = state(start);
    if (st === null) return null;
    if (placed(st)) return st;
    return st === CYC_MINE ? CYCLIC : OUT;
  };
}
const placedLevel = (p) => (p && p !== OUT && p !== CYCLIC && p.root !== undefined ? p.dist + 1 : null);
const inNetwork = (p) => !!p && p !== OUT; // placed or CYCLIC: owner = R

/**
 * The breadcrumb from the N-root down to `id`: [{ id, username, name, level, linkedToMe }], root
 * first. `id` must be a PLACED member of N(R) (linked or not), otherwise NOT_FOUND.
 */
async function nodePath(db, recruiterId, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const rows = await ancestryRows(db, recruiterId, [id]);
  const level = placedLevel(placementOf(rows)(id));
  if (level === null) throw fail('NOT_FOUND');
  const chain = [];
  for (let cur = id; chain.length < level; cur = rows.get(cur).parentId) chain.push(rows.get(cur));
  return chain.reverse().map((r, i) => ({ id: r.id, username: r.username, name: r.name, level: i + 1, linkedToMe: r.link === 'mine' }));
}

/**
 * Placement of (≤ PAGE_MAX) affiliates of the recruiter's list in N(R), ONE ancestry statement:
 * Map(id → { level (null = not placed), parentInNetwork (the parent is a member of N(R) — then its
 * id may be shown), parent: { id, username, name, linkedToMe } | null (only when the affiliate is a
 * placed non-root: its parent is then a placed member of N(R)) }).
 */
export async function getAffiliatePlacement(recruiterId, ids, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && ID_RE.test(x)))];
  const out = new Map();
  if (!list.length) return out;
  if (list.length > NETWORK_LIMITS.PAGE_MAX) throw fail('INVALID_INPUT');
  const rows = await ancestryRows(db, recruiterId, list);
  const place = placementOf(rows);
  for (const id of list) {
    const n = rows.get(id);
    if (!n) continue;
    const level = placedLevel(place(id));
    const p = n.parentId ? rows.get(n.parentId) : null;
    out.set(id, {
      level,
      parentInNetwork: !!p && inNetwork(place(p.id)),
      parent: level !== null && level > 1 && p ? { id: p.id, username: p.username, name: p.name, linkedToMe: p.link === 'mine' } : null,
    });
  }
  return out;
}

/** Rows of a page statement → { total, nodes } (`total` is repeated on every row; an empty page is one row without id). */
const pageOf = (rows, toNode) => {
  const list = Array.isArray(rows) ? rows : [];
  return { total: list.length ? Number(list[0]?.total) || 0 : 0, nodes: list.filter((r) => typeof r?.id === 'string').map(toNode) };
};
const pageNode = (r) => ({
  id: r.id, username: r.username ?? null, name: r.name ?? null, active: r.isActive === true,
  children: Number(r.children ?? 0), descendants: Number(r.descendants ?? 0),
});

/**
 * One page of the roots of N(R) (Phase 7 Stage F: R's linked affiliates without any linked ancestor,
 * on a chain with a top — the shared cand / up / rs / roots CTEs, see the header), in creation order —
 * createdAt, then id — with the total and each node's children / descendants counts (ALL its
 * descendants: they all belong to R; ONE walk seeded with the page only).
 * → { total, nodes: [{ id, username, name, active, children, descendants, mine }] }
 */
async function rootsPage(db, recruiterId, size, start) {
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-network-roots */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId", sa."username", sa."name", sa."isActive", sa."createdAt"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId", f."username", f."name", f."isActive", f."createdAt" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id", c."username", c."name", c."isActive", c."createdAt"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    page AS (
      SELECT r."id", r."username", r."name", r."isActive", r."createdAt"
      FROM roots r
      ORDER BY r."createdAt", r."id" COLLATE "C"
      LIMIT ${size}::int OFFSET ${start}::int
    ),
    t AS (
      SELECT p."id" AS seed, p."id", 0 AS depth FROM page p
      UNION ALL
      SELECT t.seed, ch."id", t.depth + 1
      FROM t
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = t."id" OFFSET 0) ch
      WHERE t.depth < ${cap}::int
    ),
    counts AS (
      SELECT t.seed, (count(*) FILTER (WHERE t.depth = 1))::int AS children, (count(*) - 1)::int AS descendants
      FROM t GROUP BY t.seed
    )
    SELECT (SELECT count(*)::int FROM roots) AS total,
           p."id", p."username", p."name", p."isActive", n.children, n.descendants
    FROM (SELECT 1) one
    LEFT JOIN page p ON true
    LEFT JOIN counts n ON n.seed = p."id"
    ORDER BY p."createdAt", p."id" COLLATE "C"`;
  return pageOf(rows, (r) => ({ ...pageNode(r), mine: true }));
}

/**
 * One page of the children of `parentId` (a placed node of N(R), already checked by nodePath): ALL its
 * children (Phase 7 Stage F: every descendant of a placed node belongs to R, whatever its own link), in
 * creation order, with the total, each node's children / descendants counts and whether it is linked to R.
 * → { total, nodes: [{ …, mine }] }
 */
async function childrenPage(db, recruiterId, parentId, size, start) {
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-network-children */
    WITH RECURSIVE cand AS (
      SELECT a."id", a."username", a."name", a."isActive", a."createdAt"
      FROM "affiliates" a
      WHERE a."parentId" = ${parentId}::text
    ),
    page AS (
      SELECT c."id", c."username", c."name", c."isActive", c."createdAt"
      FROM cand c
      ORDER BY c."createdAt", c."id" COLLATE "C"
      LIMIT ${size}::int OFFSET ${start}::int
    ),
    t AS (
      SELECT p."id" AS seed, p."id", 0 AS depth FROM page p
      UNION ALL
      SELECT t.seed, ch."id", t.depth + 1
      FROM t
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = t."id" OFFSET 0) ch
      WHERE t.depth < ${cap}::int
    ),
    counts AS (
      SELECT t.seed, (count(*) FILTER (WHERE t.depth = 1))::int AS children, (count(*) - 1)::int AS descendants
      FROM t GROUP BY t.seed
    )
    SELECT (SELECT count(*)::int FROM cand) AS total,
           p."id", p."username", p."name", p."isActive",
           EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x
                   WHERE x."affiliateId" = p."id" AND x."recruiterId" = ${recruiterId}::text) AS mine,
           n.children, n.descendants
    FROM (SELECT 1) one
    LEFT JOIN page p ON true
    LEFT JOIN counts n ON n.seed = p."id"
    ORDER BY p."createdAt", p."id" COLLATE "C"`;
  return pageOf(rows, (r) => ({ ...pageNode(r), mine: r.mine === true }));
}

/**
 * The own card of ONE placed node of N(R) (already checked by nodePath): its activation flag, its children /
 * descendants counts (ALL levels — the same walk and the same counting rule as childrenPage: a tree walk down
 * `parentId`, each affiliate once, capped only by the defensive DEPTH_CAP) and whether it is linked to R.
 * Read only, ONE statement. → { id, username, name, active, children, descendants, mine } | null
 */
async function nodeCard(db, recruiterId, id) {
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-network-node */
    WITH RECURSIVE page AS (
      SELECT a."id", a."username", a."name", a."isActive", a."createdAt"
      FROM "affiliates" a
      WHERE a."id" = ${id}::text
    ),
    t AS (
      SELECT p."id" AS seed, p."id", 0 AS depth FROM page p
      UNION ALL
      SELECT t.seed, ch."id", t.depth + 1
      FROM t
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = t."id" OFFSET 0) ch
      WHERE t.depth < ${cap}::int
    ),
    counts AS (
      SELECT t.seed, (count(*) FILTER (WHERE t.depth = 1))::int AS children, (count(*) - 1)::int AS descendants
      FROM t GROUP BY t.seed
    )
    SELECT p."id", p."username", p."name", p."isActive",
           EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x
                   WHERE x."affiliateId" = p."id" AND x."recruiterId" = ${recruiterId}::text) AS mine,
           n.children, n.descendants
    FROM page p
    LEFT JOIN counts n ON n.seed = p."id"`;
  const r = (Array.isArray(rows) ? rows : []).find((x) => typeof x?.id === 'string');
  return r ? { ...pageNode(r), mine: r.mine === true } : null;
}

/**
 * One page of the UNPLACED members (Phase 7 Stage F: R's linked affiliates on a parent cycle whose
 * links are all R's — owned by R, never placed: cseed of the header), in link order (createdAt, then
 * affiliateId), with the total. → { total, nodes: [{ id, username, name }] }
 */
async function unplacedPage(db, recruiterId, size, start) {
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-network-unplaced */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    net AS (
      SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM roots r)) AS s("id")
      UNION ALL
      SELECT ch."id", n.depth + 1
      FROM net n
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
      WHERE n.depth < ${cap}::int
    ),
    orph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE l."recruiterId" = ${recruiterId}::text
          AND NOT EXISTS (SELECT 1 FROM net n WHERE n."id" = l."affiliateId")
      )) AS s("id")
    ),
    oup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM orph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM oup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    cseed AS (
      SELECT op."id"
      FROM orph op
      WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
    ),
    un AS (
      SELECT l."affiliateId" AS "id", l."createdAt" AS "linkedAt"
      FROM "recruiter_affiliate_links" l
      JOIN cseed s ON s."id" = l."affiliateId"
    ),
    page AS (
      SELECT u."id", u."linkedAt"
      FROM un u
      ORDER BY u."linkedAt", u."id"
      LIMIT ${size}::int OFFSET ${start}::int
    )
    SELECT (SELECT count(*)::int FROM un) AS total, p."id", a."username", a."name"
    FROM (SELECT 1) one
    LEFT JOIN page p ON true
    LEFT JOIN "affiliates" a ON a."id" = p."id"
    ORDER BY p."linkedAt", p."id"`;
  return pageOf(rows, (r) => ({ id: r.id, username: r.username ?? null, name: r.name ?? null }));
}

/**
 * N(R) from its roots (rootId null) or the sub-network under `rootId` (a placed node at level
 * `base`, already checked by nodePath: its children at level base + 1) aggregated in ONE walk (every
 * descendant — Phase 7 Stage F). Levels are ABSOLUTE (depth below the root). Rows:
 *   { kind: 'u', depth: null, flag: null, status: null, n: unplaced members (whole network only; cseed) }
 *   { kind: 'm', depth, flag: isActive, status: identity status or null, n: members }
 *   { kind: 'o', depth, flag: isFake, status: order status, n: orders }   ← withOrders only
 * Raw statuses are bucketed by the caller (orderBucket / identityBucket, unchanged rules).
 * Without orders the statement does not mention affiliate_orders at all.
 */
async function networkAggregates(db, recruiterId, rootId, base, withOrders) {
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  if (withOrders) {
    return db.$queryRaw`
      /* recruiter-network-stats-orders */
      WITH RECURSIVE cand AS (
        SELECT sa."id", sa."parentId", sa."username", sa."name", sa."isActive", sa."createdAt"
        FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
        CROSS JOIN LATERAL (
          SELECT f."id", f."parentId", f."username", f."name", f."isActive", f."createdAt" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
        ) sa
        WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
      ),
      up AS (
        SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
        FROM cand c
        CROSS JOIN LATERAL (
          SELECT a."id", a."parentId",
                 EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
                 NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
          FROM "affiliates" a
          WHERE a."id" = c."parentId"
          OFFSET 0
        ) p
        UNION
        SELECT u.seed, p."id", p."parentId", p.linked, p.top
        FROM up u
        CROSS JOIN LATERAL (
          SELECT a."id", a."parentId",
                 EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
                 NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
          FROM "affiliates" a
          WHERE a."id" = u."parentId"
          OFFSET 0
        ) p
        WHERE NOT u.linked
      ),
      rs AS (
        SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
        FROM up u
        GROUP BY u.seed
      ),
      roots AS (
        SELECT c."id", c."username", c."name", c."isActive", c."createdAt"
        FROM cand c
        LEFT JOIN rs ON rs.seed = c."id"
        WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
      ),
      seed AS (
        SELECT r."id", r."isActive"
        FROM roots r
        WHERE ${rootId}::text IS NULL
        UNION ALL
        SELECT a."id", a."isActive"
        FROM "affiliates" a
        WHERE a."parentId" = ${rootId}::text
      ),
      t AS (
        SELECT s."id", s."isActive", ${base}::int + 1 AS depth FROM seed s
        UNION ALL
        SELECT ch."id", ch."isActive", t.depth + 1
        FROM t
        CROSS JOIN LATERAL (SELECT a."id", a."isActive" FROM "affiliates" a WHERE a."parentId" = t."id" OFFSET 0) ch
        WHERE t.depth < ${cap}::int
      ),
      orph AS (
        SELECT s."id"
        FROM unnest(ARRAY(
          SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
          WHERE ${rootId}::text IS NULL AND l."recruiterId" = ${recruiterId}::text
            AND NOT EXISTS (SELECT 1 FROM t WHERE t."id" = l."affiliateId")
        )) AS s("id")
      ),
      oup AS (
        SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
        FROM orph op
        CROSS JOIN LATERAL (
          SELECT a."id", a."parentId",
                 (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
                 NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
          FROM "affiliates" a
          WHERE a."id" = op."id"
          OFFSET 0
        ) p
        UNION
        SELECT u.seed, p."id", p."parentId", p.rid, p.top
        FROM oup u
        CROSS JOIN LATERAL (
          SELECT a."id", a."parentId",
                 (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
                 NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
          FROM "affiliates" a
          WHERE a."id" = u."parentId"
          OFFSET 0
        ) p
      ),
      cseed AS (
        SELECT op."id"
        FROM orph op
        WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
      )
      SELECT 'u'::text AS kind, NULL::int AS depth, NULL::boolean AS flag, NULL::text AS status, count(*)::int AS n
      FROM cseed
      UNION ALL
      SELECT 'm'::text AS kind, t.depth::int AS depth, t."isActive" AS flag, iv."status" AS status, count(*)::int AS n
      FROM t
      LEFT JOIN "identity_verifications" iv ON iv."affiliateId" = t."id"
      GROUP BY t.depth, t."isActive", iv."status"
      UNION ALL
      SELECT 'o'::text, t.depth::int, o."isFake", o."status", count(*)::int
      FROM t
      JOIN "affiliate_orders" o ON o."affiliateId" = t."id"
      GROUP BY t.depth, o."isFake", o."status"`;
  }
  return db.$queryRaw`
    /* recruiter-network-stats */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId", sa."username", sa."name", sa."isActive", sa."createdAt"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId", f."username", f."name", f."isActive", f."createdAt" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id", c."username", c."name", c."isActive", c."createdAt"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    seed AS (
      SELECT r."id", r."isActive"
      FROM roots r
      WHERE ${rootId}::text IS NULL
      UNION ALL
      SELECT a."id", a."isActive"
      FROM "affiliates" a
      WHERE a."parentId" = ${rootId}::text
    ),
    t AS (
      SELECT s."id", s."isActive", ${base}::int + 1 AS depth FROM seed s
      UNION ALL
      SELECT ch."id", ch."isActive", t.depth + 1
      FROM t
      CROSS JOIN LATERAL (SELECT a."id", a."isActive" FROM "affiliates" a WHERE a."parentId" = t."id" OFFSET 0) ch
      WHERE t.depth < ${cap}::int
    ),
    orph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE ${rootId}::text IS NULL AND l."recruiterId" = ${recruiterId}::text
          AND NOT EXISTS (SELECT 1 FROM t WHERE t."id" = l."affiliateId")
      )) AS s("id")
    ),
    oup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM orph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM oup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    cseed AS (
      SELECT op."id"
      FROM orph op
      WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
    )
    SELECT 'u'::text AS kind, NULL::int AS depth, NULL::boolean AS flag, NULL::text AS status, count(*)::int AS n
    FROM cseed
    UNION ALL
    SELECT 'm'::text AS kind, t.depth::int AS depth, t."isActive" AS flag, iv."status" AS status, count(*)::int AS n
    FROM t
    LEFT JOIN "identity_verifications" iv ON iv."affiliateId" = t."id"
    GROUP BY t.depth, t."isActive", iv."status"`;
}

/**
 * |N(R)| and its members linked to R (Phase 7 Stage F): every affiliate whose owner is R — the roots and
 * ALL their descendants, plus the members on a parent cycle owned by R (cnet) — each counted once; `linked`
 * = those with a link row to R (a legacy link of R inside ANOTHER recruiter's network is not R's: never
 * counted). ONE recursive statement, O(|N(R)|) index lookups. → { members, linked }
 */
export async function countNetwork(recruiterId, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-network-downline */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    net AS (
      SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM roots r)) AS s("id")
      UNION ALL
      SELECT ch."id", n.depth + 1
      FROM net n
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
      WHERE n.depth < ${cap}::int
    ),
    orph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE l."recruiterId" = ${recruiterId}::text
          AND NOT EXISTS (SELECT 1 FROM net n WHERE n."id" = l."affiliateId")
      )) AS s("id")
    ),
    oup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM orph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM oup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    cseed AS (
      SELECT op."id"
      FROM orph op
      WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
    ),
    cnet AS (
      SELECT s."id" FROM cseed s
      UNION
      SELECT ch."id"
      FROM cnet c
      CROSS JOIN LATERAL (
        SELECT a."id" FROM "affiliates" a
        WHERE a."parentId" = c."id"
          AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" ox WHERE ox."affiliateId" = a."id" AND ox."recruiterId" <> ${recruiterId}::text)
        OFFSET 0
      ) ch
    ),
    mem AS (
      SELECT n."id" FROM net n
      UNION ALL
      SELECT c."id" FROM unnest(ARRAY(SELECT cx."id" FROM cnet cx)) AS c("id")
    )
    SELECT (SELECT count(*)::int FROM mem) AS n,
           (SELECT count(*)::int FROM mem m JOIN "recruiter_affiliate_links" x ON x."affiliateId" = m."id" AND x."recruiterId" = ${recruiterId}::text) AS linked`;
  const r = Array.isArray(rows) ? rows[0] : null;
  return { members: Number(r?.n ?? 0) || 0, linked: Number(r?.linked ?? 0) || 0 };
}

/** |N(R)| — the members of countNetwork (the same statement). */
export async function countDownline(recruiterId, { db = prisma } = {}) {
  return (await countNetwork(recruiterId, { db })).members;
}

/**
 * Ids of the members of N(R) with at least `minDelivered` real delivered orders (status exactly
 * 'delivered' AND isFake false, the member's OWN orders) — the SAME statement text as the group
 * reward's recruiter-group-qualified (recruiterRewardService.groupQualifiedIds) under its own tag;
 * identity APPROVED is counted by the caller. Reads affiliate_orders: only for the progress summary
 * (an aggregate count reaches the recruiter, never a per-affiliate number).
 */
export async function networkIdsWithRealDelivered(recruiterId, minDelivered, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  if (!Number.isInteger(minDelivered) || minDelivered < 1 || minDelivered > INT4_MAX) throw fail('INVALID_INPUT');
  const delivered = 'delivered';
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-progress-qualified */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    net AS (
      SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM roots r)) AS s("id")
      UNION ALL
      SELECT ch."id", n.depth + 1
      FROM net n
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
      WHERE n.depth < ${cap}::int
    ),
    orph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE l."recruiterId" = ${recruiterId}::text
          AND NOT EXISTS (SELECT 1 FROM net n WHERE n."id" = l."affiliateId")
      )) AS s("id")
    ),
    oup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM orph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM oup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    cseed AS (
      SELECT op."id"
      FROM orph op
      WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
    ),
    cnet AS (
      SELECT s."id" FROM cseed s
      UNION
      SELECT ch."id"
      FROM cnet c
      CROSS JOIN LATERAL (
        SELECT a."id" FROM "affiliates" a
        WHERE a."parentId" = c."id"
          AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" ox WHERE ox."affiliateId" = a."id" AND ox."recruiterId" <> ${recruiterId}::text)
        OFFSET 0
      ) ch
    ),
    mem AS (
      SELECT n."id" FROM net n
      UNION ALL
      SELECT c."id" FROM unnest(ARRAY(SELECT cx."id" FROM cnet cx)) AS c("id")
    )
    SELECT m."id"
    FROM mem m
    WHERE (
        SELECT count(*) FROM (
          SELECT 1 FROM "affiliate_orders" o
          WHERE o."affiliateId" = m."id" AND o."status" = ${delivered} AND o."isFake" = false
          LIMIT ${minDelivered}::int
        ) d
      ) >= ${minDelivered}::int`;
  return (Array.isArray(rows) ? rows : []).map((r) => r?.id).filter((id) => typeof id === 'string');
}

/** Order counts per affiliate: Map(id → { real: {...}, fake: {...} }), batched by CHUNK ids. */
async function orderCounts(db, ids) {
  const out = new Map();
  for (const part of chunks(ids)) {
    const groups = await db.affiliateOrder.groupBy({ by: ['affiliateId', 'status', 'isFake'], where: { affiliateId: { in: part } }, _count: { _all: true } });
    for (const g of groups) {
      const n = Number(g?._count?._all ?? 0);
      if (!out.has(g.affiliateId)) out.set(g.affiliateId, { real: emptyOrders(), fake: emptyOrders() });
      const o = out.get(g.affiliateId)[g.isFake === true ? 'fake' : 'real'];
      o[orderBucket(g.status)] += n;
      o.total += n;
    }
  }
  return out;
}

/** Identity status per affiliate (status ONLY — no document field is selected). */
async function identityStatuses(db, ids) {
  const out = new Map();
  for (const part of chunks(ids)) {
    const rows = await db.identityVerification.findMany({ where: { affiliateId: { in: part } }, select: { affiliateId: true, status: true } });
    for (const r of rows) out.set(r.affiliateId, identityBucket(r.status));
  }
  return out;
}


/**
 * Statistics of the whole network N(R), or of the sub-network under `rootId` (a placed node of
 * N(R), linked to R or not; anything else → NOT_FOUND). Levels are ABSOLUTE in both cases (depth
 * below the D-root; Phase 7 Stage B — before, a sub-network's levels started at 1 under rootId):
 * `direct` = the roots (whole) or the direct children of rootId; `maxLevel` = the deepest level.
 * `unplaced` (whole only) = R's linked members on a parent cycle owned by R (Stage F — malformed data).
 * Aggregated by PostgreSQL in one walk (no per-node data reaches the application).
 * `includeOrders: false` (the recruiter's canViewOrders is off, Phase 6 part 4): NO order query
 * is run and every `orders` is null (never zero-filled counts).
 */
export async function getNetworkStats(recruiterId, { db = prisma, rootId = null, includeOrders = true } = {}) {
  const members = await memberCount(db, recruiterId);
  const scoped = given(rootId);
  const withOrders = includeOrders === true;
  const totals = { affiliates: 0, direct: 0, active: 0, inactive: 0, maxLevel: 0, unplaced: 0 };
  const idTotals = emptyIdentity();
  const ordTotals = withOrders ? { real: emptyOrders(), fake: emptyOrders() } : null;
  const levels = new Map();
  if (scoped && !members) throw fail('NOT_FOUND');
  if (members) {
    const path = scoped ? await nodePath(db, recruiterId, rootId) : [];
    const base = scoped ? path[path.length - 1].level : 0;
    // Phase 7 Stage F: ONE statement (the roots need no marking walk any more)
    const rows = await networkAggregates(db, recruiterId, scoped ? rootId : null, base, withOrders);
    const list = Array.isArray(rows) ? rows : [];
    const levelOf = (level) => {
      if (!levels.has(level)) levels.set(level, { level, affiliates: 0, active: 0, inactive: 0, identity: emptyIdentity(), orders: withOrders ? { real: emptyOrders(), fake: emptyOrders() } : null });
      return levels.get(level);
    };
    let unplaced = 0; // Stage F: R's linked members on a parent cycle owned by R (the 'u' row, whole network only)
    for (const r of list) if (r?.kind === 'u') unplaced += Number(r.n) || 0;
    for (const r of list) {
      if (r?.kind !== 'm') continue;
      const level = Number(r.depth);
      const n = Number(r.n);
      const L = levelOf(level);
      L.affiliates += n;
      totals.affiliates += n;
      if (level === base + 1) totals.direct += n;
      totals.maxLevel = Math.max(totals.maxLevel, level);
      if (r.flag === true) { totals.active += n; L.active += n; } else { totals.inactive += n; L.inactive += n; }
      const idStatus = identityBucket(r.status);
      idTotals[idStatus] += n;
      L.identity[idStatus] += n;
    }
    if (withOrders) {
      for (const r of list) {
        if (r?.kind !== 'o') continue;
        const n = Number(r.n);
        const side = r.flag === true ? 'fake' : 'real';
        const bucket = orderBucket(r.status);
        const L = levelOf(Number(r.depth)).orders[side];
        L[bucket] += n;
        L.total += n;
        ordTotals[side][bucket] += n;
        ordTotals[side].total += n;
      }
    }
    if (!scoped) totals.unplaced = unplaced;
  }
  return {
    rootId: rootId || null,
    totals, identity: idTotals, orders: ordTotals,
    levels: [...levels.values()].sort((a, b) => a.level - b.level),
  };
}

/**
 * One page of the tree: the roots of N(R) (parentId empty) or the children in N(R) of `parentId` (a
 * placed node of N(R); anything else → NOT_FOUND), each with its level, activation status, identity
 * status, children / descendant counts, order counts and `linkedToMe` (linked to THIS recruiter).
 * `view: 'unplaced'` lists R's linked members on a parent cycle owned by R (malformed data). Paging, ordering
 * and counting run in PostgreSQL; `cursor` is the numeric offset.
 * The first page of a scoped request also carries `parentNode`: the scope's OWN card (same shape as a node —
 * activation, identity status, children / ALL-level descendants, its own order counts); null otherwise.
 * `includeOrders: false` (canViewOrders off, Phase 6 part 4): NO order query; every node's
 * `orders` is null.
 */
export async function getNetworkNodes(recruiterId, { db = prisma, parentId = null, view = null, cursor = 0, limit = NETWORK_LIMITS.PAGE_DEFAULT, includeOrders = true } = {}) {
  const members = await memberCount(db, recruiterId);
  const size = Math.min(Math.max(Number.isInteger(limit) ? limit : NETWORK_LIMITS.PAGE_DEFAULT, 1), NETWORK_LIMITS.PAGE_MAX);
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const unplaced = view === 'unplaced';
  const scoped = !unplaced && given(parentId);
  if (!members) {
    if (scoped) throw fail('NOT_FOUND');
    return { parent: null, parentNode: null, path: [], nodes: [], total: 0, nextCursor: null };
  }
  const path = scoped ? await nodePath(db, recruiterId, parentId) : [];
  const parent = scoped ? path[path.length - 1] : null;
  const offset = Math.min(start, INT4_MAX); // same empty page as before for any larger cursor (not reachable over HTTP: ≤ 7 digits)
  const page = unplaced
    ? await unplacedPage(db, recruiterId, size, offset)
    : scoped ? await childrenPage(db, recruiterId, parentId, size, offset) : await rootsPage(db, recruiterId, size, offset);
  // The scope's OWN card (first page of a scoped request only): the details view of one affiliate.
  const card = scoped && start === 0 ? await nodeCard(db, recruiterId, parentId) : null;
  const pageIds = page.nodes.map((n) => n.id);
  const countIds = card ? [...pageIds, card.id] : pageIds;
  const [orders, identity] = await Promise.all([
    includeOrders === true ? orderCounts(db, countIds) : null,
    identityStatuses(db, countIds),
  ]);
  const level = parent ? parent.level + 1 : 1;
  return {
    parent: parent ? { ...parent } : null,
    parentNode: card ? {
      id: card.id, username: card.username, name: card.name, level: parent.level,
      status: card.active ? 'ACTIVE' : 'INACTIVE',
      identityStatus: identity.get(card.id) ?? 'NONE',
      childrenCount: card.children, descendantsCount: card.descendants,
      orders: orders ? orders.get(card.id) ?? { real: emptyOrders(), fake: emptyOrders() } : null,
      linkedToMe: card.mine === true,
    } : null,
    path: path.map((p) => ({ ...p })),
    nodes: page.nodes.map((n) => ({
      id: n.id, username: n.username, name: n.name,
      level: unplaced ? null : level,
      status: unplaced ? null : (n.active ? 'ACTIVE' : 'INACTIVE'),
      identityStatus: identity.get(n.id) ?? 'NONE',
      childrenCount: unplaced ? 0 : n.children,
      descendantsCount: unplaced ? 0 : n.descendants,
      orders: orders ? orders.get(n.id) ?? { real: emptyOrders(), fake: emptyOrders() } : null,
      linkedToMe: unplaced ? true : n.mine === true,
    })),
    total: page.total,
    nextCursor: start + size < page.total ? start + size : null,
  };
}

/**
 * Identity status and (orders allowed only) order counts of up to PAGE_MAX affiliates — the same two
 * page reads as getNetworkNodes (for the recruiter's affiliate list). → Map(id → { identityStatus, orders | null })
 */
export async function getAffiliateCounts(ids, { db = prisma, includeOrders = true } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string'))];
  if (list.length > NETWORK_LIMITS.PAGE_MAX) throw fail('INVALID_INPUT');
  const out = new Map();
  if (!list.length) return out;
  const [orders, identity] = await Promise.all([includeOrders === true ? orderCounts(db, list) : null, identityStatuses(db, list)]);
  for (const id of list) {
    out.set(id, { identityStatus: identity.get(id) ?? 'NONE', orders: orders ? orders.get(id) ?? { real: emptyOrders(), fake: emptyOrders() } : null });
  }
  return out;
}
