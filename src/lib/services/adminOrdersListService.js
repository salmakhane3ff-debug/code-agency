/**
 * src/lib/services/adminOrdersListService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side pagination of the Admin Store Orders list (/admin/orders →
 * GET /api/admin/orders). A NEW, separate module: GET /api/order and
 * orderService.js are untouched, so every other consumer still receives the
 * complete order array exactly as before.
 *
 * The filters reproduce, in SQL, what the admin page used to do in the browser
 * over the full array (same results, now one page at a time):
 *   • drafts hidden          !o.paymentDetails?.isDraft  (JS truthiness of the JSON value)
 *   • search                 phone contains q, or lower(name) / lower(id) contains q
 *                            (q already lower-cased — exactly the old client test)
 *   • status                 (status empty → "NEW", else upper-case) = selected status
 *   • source                 isFake (REAL = false, FAKE = true)
 *   • order                  createdAt DESC (or ASC), tie-broken by id in the same
 *                            direction → a deterministic order, so walking the pages
 *                            never repeats nor misses an order.
 * Header counters keep their meaning: `total` = matching orders (the old "displayed"
 * count) and `overall` = every order row (the old "orders.length", drafts included).
 * Statements are static; every value is a bound parameter.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { mapOrder } from '../utils/mappers.js';
import { parseAdminOrdersQuery, orderPageCount, clampOrderPage } from '../adminOrdersQuery.js';

// JS truthiness of paymentDetails.isDraft (true, non-zero number, non-empty string, object / array);
// missing / null / false / 0 / "" → not a draft. A non-object paymentDetails has no isDraft.
const IS_DRAFT = `(CASE jsonb_typeof("paymentDetails"->'isDraft')
        WHEN 'boolean' THEN ("paymentDetails"->>'isDraft')::boolean
        WHEN 'number'  THEN ("paymentDetails"->>'isDraft')::numeric <> 0
        WHEN 'string'  THEN ("paymentDetails"->>'isDraft') <> ''
        WHEN 'object'  THEN true
        WHEN 'array'   THEN true
        ELSE false END)`;

// $1 search (lower-cased, null = off) · $2 status (null = all) · $3 isFake (null = both).
// strpos (not LIKE): the search text is matched literally, "%" and "_" have no special meaning.
const LIST_WHERE = `
   WHERE NOT ${IS_DRAFT}
     AND ($1::text IS NULL
          OR strpos(COALESCE("customerPhone", ''), $1::text) > 0
          OR strpos(lower("customerName"), $1::text) > 0
          OR strpos(lower(id), $1::text) > 0)
     AND ($2::text IS NULL OR upper(COALESCE(NULLIF(status, ''), 'NEW')) = $2::text)
     AND ($3::boolean IS NULL OR "isFake" = $3::boolean)`;

export const ADMIN_ORDERS_COUNT_SQL = `SELECT count(*)::int AS total FROM orders ${LIST_WHERE}`;
export const ADMIN_ORDERS_OVERALL_SQL = `SELECT count(*)::int AS total FROM orders`;
// $4 limit · $5 offset
export const ADMIN_ORDERS_PAGE_SQL = Object.freeze({
  desc: `SELECT id FROM orders ${LIST_WHERE} ORDER BY "createdAt" DESC, id DESC LIMIT $4::int OFFSET $5::int`,
  asc:  `SELECT id FROM orders ${LIST_WHERE} ORDER BY "createdAt" ASC, id ASC LIMIT $4::int OFFSET $5::int`,
});

const sourceFlag = (source) => (source === 'REAL' ? false : source === 'FAKE' ? true : null);

/**
 * One page of the admin store orders.
 * → { items: MappedOrder[] (same shape as GET /api/order items), total, overall, page, pageSize, pages }
 * `page` is the page actually served (a page past the end is clamped to the last one).
 */
export async function listAdminOrdersPage(query, { db = prisma } = {}) {
  const { page: requested, pageSize, q, status, source, sort } = query;
  const params = [q, status, sourceFlag(source)];
  const [countRows, overallRows] = await Promise.all([
    db.$queryRawUnsafe(ADMIN_ORDERS_COUNT_SQL, ...params),
    db.$queryRawUnsafe(ADMIN_ORDERS_OVERALL_SQL),
  ]);
  const total = Number(countRows?.[0]?.total ?? 0);
  const overall = Number(overallRows?.[0]?.total ?? 0);
  const page = clampOrderPage(requested, total, pageSize);
  const pages = orderPageCount(total, pageSize);

  const idRows = total > 0
    ? await db.$queryRawUnsafe(ADMIN_ORDERS_PAGE_SQL[sort === 'asc' ? 'asc' : 'desc'], ...params, pageSize, (page - 1) * pageSize)
    : [];
  const ids = idRows.map((r) => r.id);
  let items = [];
  if (ids.length) {
    // Full rows (+ items) for this page only, then back into the page order.
    const rows = await db.order.findMany({ where: { id: { in: ids } }, include: { items: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    items = ids.map((id) => byId.get(id)).filter(Boolean).map(mapOrder);
  }
  return { items, total, overall, page, pageSize, pages };
}

/** GET /api/admin/orders body (deps injectable for tests). Invalid parameters → 400 INVALID_INPUT. */
export function adminOrdersHandlers(deps = {}) {
  const { db = prisma } = deps;
  const noStore = { 'Cache-Control': 'no-store' };
  return {
    list: async (req) => {
      let query;
      try {
        query = parseAdminOrdersQuery(new URL(req.url).searchParams);
      } catch (e) {
        if (e?.code === 'INVALID_INPUT') return Response.json({ error: e.message, code: e.code, field: e.field }, { status: 400, headers: noStore });
        throw e;
      }
      try {
        return Response.json(await listAdminOrdersPage(query, { db }), { headers: noStore });
      } catch (e) {
        console.error('[admin-orders] list error:', e?.message ?? e);
        return Response.json({ error: 'Failed to fetch orders', code: 'SERVER_ERROR' }, { status: 500, headers: noStore });
      }
    },
  };
}
