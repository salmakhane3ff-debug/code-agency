/**
 * src/lib/services/recruiterNetworkService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 4: the recruiter's network tree and statistics
 * (READ-ONLY; db injected, so tests run on an in-memory fake or an isolated local database).
 *
 *   • Network = the affiliates linked to THIS recruiter (recruiter_affiliate_links). The
 *     hierarchy is the existing affiliates.parentId, unlimited depth. A parent outside the
 *     network (or none) makes the affiliate a network root (level 1).
 *   • ONE recursive PostgreSQL query per request walks the whole network downwards from its
 *     roots (index on affiliates.parentId + the links primary key), then everything else is
 *     batched (chunks of CHUNK ids): no per-node query (no N+1).
 *   • Malformed data is safe: every affiliate has ONE parentId, so a walk that starts at the
 *     roots can never enter a cycle; the depth is also capped by the network size. Members
 *     that no root reaches (a parent cycle) are counted as `unplaced`, never shown in the tree.
 *   • Nothing here writes anything. Orders: counts only (status, real / fake), never a
 *     customer name, phone, address, amount or any order field. Identity: the status only,
 *     never a document or a file key.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';

export const NETWORK_LIMITS = Object.freeze({ PAGE_DEFAULT: 50, PAGE_MAX: 100, CHUNK: 5000 });
export const ORDER_BUCKETS = Object.freeze(['delivered', 'pending', 'confirmed', 'shipped', 'cancelled', 'returned', 'other']);
export const IDENTITY_BUCKETS = Object.freeze(['APPROVED', 'PENDING', 'REJECTED', 'NONE']);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
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

/**
 * The whole network of a recruiter, from its roots downwards. ONE recursive query.
 * → { nodes: Map(id → { id, parentId, depth, active, createdAt, children: [] }), roots: [ids], members, unplaced }
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

/** Every id of the subtree under `rootId` (excluding it), with the level relative to it (1 = direct). */
function subtreeLevels(tree, rootId) {
  const out = new Map();
  let frontier = [...tree.nodes.get(rootId).children];
  let level = 1;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (out.has(id) || id === rootId) continue;
      out.set(id, level);
      next.push(...tree.nodes.get(id).children);
    }
    frontier = next;
    level += 1;
  }
  return out;
}

/** Descendant count of every node (one post-order pass, no recursion depth limit). */
function descendantCounts(tree) {
  const counts = new Map();
  const ordered = [...tree.nodes.values()].sort((a, b) => b.depth - a.depth); // deepest first
  for (const n of ordered) {
    let c = 0;
    for (const ch of n.children) c += 1 + (counts.get(ch) ?? 0);
    counts.set(n.id, c);
  }
  return counts;
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

const addOrders = (into, from) => { for (const k of Object.keys(into)) into[k] += from?.[k] ?? 0; };

/**
 * Statistics of the whole network, or of the sub-network under `rootId` (one of the
 * recruiter's own affiliates; anything else → NOT_FOUND). Levels are relative to the scope:
 * level 1 = network roots, or the direct affiliates of `rootId`.
 */
export async function getNetworkStats(recruiterId, { db = prisma, rootId = null } = {}) {
  const tree = await loadNetworkTree(recruiterId, { db });
  let scope; // Map(id → level)
  if (rootId !== null && rootId !== undefined && rootId !== '') {
    if (typeof rootId !== 'string' || !ID_RE.test(rootId) || !tree.nodes.has(rootId)) throw fail('NOT_FOUND');
    scope = subtreeLevels(tree, rootId);
  } else {
    scope = new Map([...tree.nodes.values()].map((n) => [n.id, n.depth]));
  }
  const ids = [...scope.keys()];
  const [orders, identity] = await Promise.all([orderCounts(db, ids), identityStatuses(db, ids)]);

  const totals = { affiliates: ids.length, direct: 0, active: 0, inactive: 0, maxLevel: 0, unplaced: rootId ? 0 : tree.unplaced };
  const idTotals = emptyIdentity();
  const ordTotals = { real: emptyOrders(), fake: emptyOrders() };
  const levels = new Map();
  for (const [id, level] of scope) {
    const n = tree.nodes.get(id);
    if (level === 1) totals.direct += 1;
    totals.maxLevel = Math.max(totals.maxLevel, level);
    if (!levels.has(level)) levels.set(level, { level, affiliates: 0, active: 0, inactive: 0, identity: emptyIdentity(), orders: { real: emptyOrders(), fake: emptyOrders() } });
    const L = levels.get(level);
    L.affiliates += 1;
    if (n.active) { totals.active += 1; L.active += 1; } else { totals.inactive += 1; L.inactive += 1; }
    const idStatus = identity.get(id) ?? 'NONE';
    idTotals[idStatus] += 1; L.identity[idStatus] += 1;
    const o = orders.get(id);
    if (o) { addOrders(ordTotals.real, o.real); addOrders(ordTotals.fake, o.fake); addOrders(L.orders.real, o.real); addOrders(L.orders.fake, o.fake); }
  }
  return {
    rootId: rootId || null,
    totals, identity: idTotals, orders: ordTotals,
    levels: [...levels.values()].sort((a, b) => a.level - b.level),
  };
}

/**
 * One page of the tree: the network roots (parentId empty) or the children of `parentId`
 * (one of the recruiter's own affiliates; anything else → NOT_FOUND), each with its level,
 * activation status, identity status, children / descendant counts and order counts.
 * `view: 'unplaced'` lists the members no root reaches (malformed data).
 */
export async function getNetworkNodes(recruiterId, { db = prisma, parentId = null, view = null, cursor = 0, limit = NETWORK_LIMITS.PAGE_DEFAULT } = {}) {
  const tree = await loadNetworkTree(recruiterId, { db });
  const size = Math.min(Math.max(Number.isInteger(limit) ? limit : NETWORK_LIMITS.PAGE_DEFAULT, 1), NETWORK_LIMITS.PAGE_MAX);
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  let ids;
  let parent = null;
  const path = [];
  if (view === 'unplaced') {
    const links = await db.recruiterAffiliateLink.findMany({ where: { recruiterId }, select: { affiliateId: true }, orderBy: [{ createdAt: 'asc' }, { affiliateId: 'asc' }] });
    ids = links.map((l) => l.affiliateId).filter((id) => !tree.nodes.has(id));
  } else if (parentId !== null && parentId !== undefined && parentId !== '') {
    if (typeof parentId !== 'string' || !ID_RE.test(parentId) || !tree.nodes.has(parentId)) throw fail('NOT_FOUND');
    parent = tree.nodes.get(parentId);
    ids = parent.children;
    for (let n = parent; n; n = n.parentId ? tree.nodes.get(n.parentId) : null) {
      path.unshift(n.id);
      if (n.depth === 1 || path.length > tree.nodes.size) break;
    }
  } else {
    ids = tree.roots;
  }
  const pageIds = ids.slice(start, start + size);
  const lookup = [...new Set([...pageIds, ...path])];
  const [rows, orders, identity] = await Promise.all([
    lookup.length ? db.affiliate.findMany({ where: { id: { in: lookup } }, select: { id: true, username: true, name: true } }) : [],
    orderCounts(db, pageIds),
    identityStatuses(db, pageIds),
  ]);
  const info = new Map(rows.map((r) => [r.id, r]));
  const desc = descendantCounts(tree);
  const nodeOf = (id) => {
    const n = tree.nodes.get(id);
    const r = info.get(id);
    return {
      id, username: r?.username ?? null, name: r?.name ?? null,
      level: n ? n.depth : null,
      status: n ? (n.active ? 'ACTIVE' : 'INACTIVE') : null,
      identityStatus: identity.get(id) ?? 'NONE',
      childrenCount: n ? n.children.length : 0,
      descendantsCount: n ? desc.get(id) ?? 0 : 0,
      orders: orders.get(id) ?? { real: emptyOrders(), fake: emptyOrders() },
    };
  };
  return {
    parent: parent ? { id: parent.id, username: info.get(parent.id)?.username ?? null, name: info.get(parent.id)?.name ?? null, level: parent.depth } : null,
    path: path.map((id) => ({ id, username: info.get(id)?.username ?? null, name: info.get(id)?.name ?? null, level: tree.nodes.get(id)?.depth ?? null })),
    nodes: pageIds.map(nodeOf),
    total: ids.length,
    nextCursor: start + size < ids.length ? start + size : null,
  };
}
