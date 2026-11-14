/**
 * src/lib/adminOrdersQuery.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure rules of the paginated Admin Store Orders list (/admin/orders ↔
 * GET /api/admin/orders). Shared by the server (validation) and the admin page.
 *
 *   page      integer ≥ 1 (default 1; a page past the end is clamped to the last one)
 *   pageSize  exactly 10 or 100 (default 10)
 *   q         search text — matched like the page always did: phone contains it,
 *             or the lower-cased name / order id contains its lower-cased form
 *   status    ALL | NEW | CONFIRMED | SHIPPED | DELIVERED | CANCELLED — compared with the
 *             order status the way the page displays it (empty → NEW, else upper-case)
 *   source    ALL | REAL | FAKE (isFake)
 *   sort      desc (newest first, default) | asc — tie-break on id in the same direction
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const ORDER_PAGE_SIZES = Object.freeze([10, 100]);
export const DEFAULT_ORDER_PAGE_SIZE = 10;
export const ORDER_STATUSES = Object.freeze(['NEW', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
export const ORDER_SOURCES = Object.freeze(['ALL', 'REAL', 'FAKE']);
export const MAX_ORDER_PAGE = 1_000_000;
export const MAX_ORDER_SEARCH = 200;

const bad = (field) => Object.assign(new Error(`Paramètre invalide : ${field}.`), { code: 'INVALID_INPUT', field });
const INT_RE = /^[1-9][0-9]{0,6}$/;

/**
 * URLSearchParams (or a plain object) → { page, pageSize, q, status, source, sort }.
 * Absent values take their defaults; present but invalid values throw INVALID_INPUT (→ 400).
 */
export function parseAdminOrdersQuery(params) {
  const get = (k) => {
    const v = typeof params?.get === 'function' ? params.get(k) : params?.[k];
    return v === null || v === undefined ? '' : String(v);
  };
  const rawPage = get('page').trim(), rawSize = get('pageSize').trim();
  if (rawPage && !INT_RE.test(rawPage)) throw bad('page');
  const page = rawPage ? Number(rawPage) : 1;
  if (page > MAX_ORDER_PAGE) throw bad('page');
  if (rawSize && !(INT_RE.test(rawSize) && ORDER_PAGE_SIZES.includes(Number(rawSize)))) throw bad('pageSize');
  const pageSize = rawSize ? Number(rawSize) : DEFAULT_ORDER_PAGE_SIZE;

  const rawQ = get('q').trim();
  if (rawQ.length > MAX_ORDER_SEARCH) throw bad('q');
  const q = rawQ ? rawQ.toLowerCase() : null;

  const rawStatus = get('status').trim() || 'ALL';
  if (rawStatus !== 'ALL' && !ORDER_STATUSES.includes(rawStatus)) throw bad('status');
  const rawSource = get('source').trim() || 'ALL';
  if (!ORDER_SOURCES.includes(rawSource)) throw bad('source');
  const rawSort = get('sort').trim() || 'desc';
  if (rawSort !== 'desc' && rawSort !== 'asc') throw bad('sort');

  return { page, pageSize, q, status: rawStatus === 'ALL' ? null : rawStatus, source: rawSource, sort: rawSort };
}

/** Number of pages for `total` matching orders (at least 1, so "page 1 / 1" when empty). */
export const orderPageCount = (total, pageSize) => Math.max(1, Math.ceil(Math.max(0, total) / pageSize));

/** The page actually served: the requested one, clamped to [1, last page]. */
export const clampOrderPage = (page, total, pageSize) => Math.min(Math.max(1, page), orderPageCount(total, pageSize));

/** Query string for GET /api/admin/orders (the admin page; only non-default values). */
export function adminOrdersQueryString({ page = 1, pageSize = DEFAULT_ORDER_PAGE_SIZE, q = '', status = 'ALL', source = 'ALL', sort = 'desc' } = {}) {
  const sp = new URLSearchParams();
  sp.set('page', String(page));
  sp.set('pageSize', String(pageSize));
  if (q && q.trim()) sp.set('q', q.trim());
  if (status && status !== 'ALL') sp.set('status', status);
  if (source && source !== 'ALL') sp.set('source', source);
  if (sort === 'asc') sp.set('sort', 'asc');
  return sp.toString();
}
