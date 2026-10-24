/**
 * src/lib/services/productService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All product CRUD operations via Prisma.
 * Every method returns a frontend-compatible shape (with `_id` and currency).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma               from '../prisma.js';
import { mapProduct }       from '../utils/mappers.js';
import { getStoreSettings } from './settingsService.js';
import { destroyManyByUrls, diffRemovedUrls } from '../mediaCleanup.js';
import { isMediaUrlReferenced } from '../mediaReferences.js';
import { encodeCursor, decodeCursor, clampLimit, normalizeFilters } from '../productFeed.js';
import { searchParam } from "../productSearch.js";
import { isProductLocked, lockedProductView } from '../productLock.js';

/**
 * Public list row. A LOCKED product (admin lock) keeps only what the storefront
 * grids show — image, name, price, lock flag — plus the collection/date/status
 * fields the grids filter and sort by. Open products are returned unchanged.
 */
function publicListProduct(p, storeSettings) {
  const mapped = mapProduct(p, storeSettings);
  if (!isProductLocked(mapped)) return mapped;
  return {
    ...lockedProductView(mapped),
    collections: mapped.collections,
    createdAt:   mapped.createdAt,
    status:      mapped.status,
    isActive:    mapped.isActive,
  };
}

// ── Known Prisma product columns ──────────────────────────────────────────────
// This explicit whitelist prevents Prisma from throwing "Unknown argument"
// errors when the admin form sends extra keys (profit, etc.).
const PRODUCT_COLUMNS = new Set([
  'title', 'description', 'shortDescription',
  'regularPrice', 'salePrice', 'costPerItem',
  'images', 'variants', 'collections',
  'sku', 'barcode', 'stockQuantity', 'stockStatus',
  'brand', 'supplier', 'tags', 'productLabel',
  'isActive', 'status',
  'rating', 'ratingsCount', 'reviewsCount',
  'limitedTimeDeal',
  'landingPageId',
  // ── Redirect & payment control (new) ──────────────────────────────────────
  'redirectMode', 'redirectUrl',
  'allowCOD', 'allowPrepaid',
  'purchaseFlow',
  // ── Page builder sections ──────────────────────────────────────────────────
  'sections',
  // ── Per-product conversion / scarcity ─────────────────────────────────────
  'conversionEnabled', 'conversionSold', 'conversionStock',
  // ── Bundle & Save offers ───────────────────────────────────────────────────
  'bundles',
  // feedbackCount is intentionally excluded — incremented by the feedback system
]);

// Float columns: nullable (?) → store null on empty; non-nullable → omit on empty
const FLOAT_NULLABLE  = new Set(['regularPrice', 'salePrice', 'costPerItem']);
const FLOAT_REQUIRED  = new Set(['rating']);

// Int columns: nullable (?) → store null on empty; non-nullable → omit on empty
const INT_NULLABLE    = new Set(['stockQuantity', 'conversionSold', 'conversionStock']);
const INT_REQUIRED    = new Set(['ratingsCount', 'reviewsCount']);

// Boolean columns — accept true/false/1/0/"true"/"false" from form inputs
const BOOL_FIELDS     = new Set(['isActive', 'allowCOD', 'allowPrepaid', 'conversionEnabled']);

/**
 * Strip everything that should not be written directly:
 *   - MongoDB/Prisma ID aliases    (_id, id)
 *   - Computed display fields      (currencySymbol, storeCurrency)
 *   - Auto-managed timestamps      (createdAt, updatedAt)
 *   - Feedback-system counter      (feedbackCount)
 *   - Derived/display-only fields  (profit, etc.)
 *   - Any key not in PRODUCT_COLUMNS
 *
 * Also coerces string values from HTML inputs to the correct Prisma types:
 *   Float columns → parseFloat, null when empty / NaN
 *   Int columns   → parseInt,   null when empty / NaN
 *
 * `rating`, `ratingsCount`, `reviewsCount` are KEPT — the admin sets them.
 */
function sanitiseInput(body) {
  const result = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!PRODUCT_COLUMNS.has(key)) continue;

    if (FLOAT_NULLABLE.has(key)) {
      // Optional Float — null is valid; Prisma accepts it
      const n = parseFloat(value);
      result[key] = isNaN(n) ? null : n;
    } else if (FLOAT_REQUIRED.has(key)) {
      // Non-nullable Float — omit key on empty so Prisma uses column default
      const n = parseFloat(value);
      if (!isNaN(n)) result[key] = n;
    } else if (INT_NULLABLE.has(key)) {
      // Optional Int — null is valid
      const n = parseInt(value, 10);
      result[key] = isNaN(n) ? null : n;
    } else if (INT_REQUIRED.has(key)) {
      // Non-nullable Int — omit key on empty so Prisma uses column default
      const n = parseInt(value, 10);
      if (!isNaN(n)) result[key] = n;
    } else if (BOOL_FIELDS.has(key)) {
      // Boolean — accept actual booleans AND form strings ("true"/"false"/1/0)
      if (typeof value === 'boolean') {
        result[key] = value;
      } else if (value === 'true' || value === '1' || value === 1) {
        result[key] = true;
      } else if (value === 'false' || value === '0' || value === 0) {
        result[key] = false;
      }
      // undefined/null → omit so Prisma keeps column default
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all products, optionally filtered by status.
 *
 * statusFilter behaviour:
 *   undefined / null → only "Active" products (default, matches old behaviour)
 *   "all"            → every product regardless of status
 *   anything else    → filter by that exact status string
 */
export async function getAllProducts(statusFilter) {
  let where = {};
  if (!statusFilter) {
    where.status = 'Active';
  } else if (statusFilter !== 'all') {
    where.status = statusFilter;
  }

  // PERF: `select` for list view — strips large fields not needed in product cards:
  //   description (~2 KB/product), sections (~5 KB), variants (array), barcode,
  //   costPerItem (private), supplier (private), landingPageId.
  //   For a 100-product catalogue this reduces JSON from ~4.8 MB → ~200 KB.
  //   getProductById() still fetches ALL columns for the detail page.
  const LIST_SELECT = {
    id: true, title: true, shortDescription: true,
    regularPrice: true, salePrice: true,
    images: true, collections: true,
    sku: true, stockStatus: true, stockQuantity: true,
    productLabel: true, tags: true, brand: true,
    rating: true, ratingsCount: true, reviewsCount: true,
    isActive: true, status: true,
    redirectMode: true, redirectUrl: true,
    limitedTimeDeal: true,
    allowCOD: true, allowPrepaid: true,
    conversionEnabled: true, conversionSold: true, conversionStock: true,
    bundles: true,
    isLocked: true,   // grids show a lock icon; locked products cannot be opened or bought
    createdAt: true,
  };

  const [products, storeSettings] = await Promise.all([
    prisma.product.findMany({ where, select: LIST_SELECT, orderBy: { createdAt: 'desc' } }),
    getStoreSettings(),
  ]);

  // Public reads trim LOCKED products to their grid fields; admin reads (`all`, …) stay full.
  const isPublicList = !statusFilter || statusFilter === 'Active';
  return products.map((p) => (isPublicList ? publicListProduct(p, storeSettings) : mapProduct(p, storeSettings)));
}

// ── Products feed: keyset (cursor) pagination ─────────────────────────────────
// Backs the All-Products infinite scroll. getAllProducts() above is untouched —
// /api/products and its ~12 consumers keep their existing unbounded contract.
//
// Raw SQL rather than the Prisma query builder, for three reasons that all apply:
//   1. The collection match must stay CASE-INSENSITIVE over a JSONB array, which
//      Prisma's `where` cannot express (array_contains is case-sensitive).
//   2. Row-value comparison ("createdAt", id) < ($t, $i) is a TRUE keyset: unlike
//      Prisma's `cursor`, it does not break when the cursor row is deleted.
//   3. One statement serves filtered and unfiltered reads — no second code path.
//
// The statement is STATIC — every user value is a bound parameter ($1..$5), so
// there is no SQL injection surface. NULL-guards switch the optional filters off.
//
// `description` is searched but never selected: the search bug fix costs nothing
// in payload (it is ~2 KB/product and product cards never render it).
//
// SEARCH IS TOKEN-BASED, not phrase-based. $2 carries the escaped query tokens
// joined by U+0001 (see lib/productSearch.js); the predicate reads "there is NO
// token that is missing from the concatenated searchable text", i.e. EVERY token
// must appear somewhere, in any order. The previous version bound the whole raw
// query as one `%phrase%` pattern, so "iPhone Apple" could never match
// "Apple iPhone 14" — the words are not contiguous in that order.
//
// One bound scalar (not an array) keeps the statement STATIC: a single prepared
// plan, no driver-specific array encoding, and no user text in the SQL string.
const FEED_COLUMNS = `
    id, title, "shortDescription",
    "regularPrice", "salePrice",
    images, collections,
    sku, "stockStatus", "stockQuantity",
    "productLabel", tags, brand,
    rating, "ratingsCount", "reviewsCount",
    "isActive", status,
    "redirectMode", "redirectUrl",
    "limitedTimeDeal",
    "allowCOD", "allowPrepaid",
    "conversionEnabled", "conversionSold", "conversionStock",
    bundles, "isLocked", "createdAt"`;

// The collection test mirrors the old JS filter exactly:
//   p.collections.some((c) => c.toLowerCase() === collection.toLowerCase())
// including its Array.isArray() guard. That guard matters: jsonb_array_elements_text
// RAISES on a non-array value, which would fail the whole page instead of skipping
// one bad row. CASE (not AND) is what actually guarantees the type check runs first —
// Postgres does not promise AND short-circuits around a sub-select.
const FEED_WHERE = `
   WHERE status = 'Active'
     AND ($1::text IS NULL OR CASE
           WHEN jsonb_typeof("collections") = 'array' THEN EXISTS (
             SELECT 1 FROM jsonb_array_elements_text("collections") AS t(c)
              WHERE lower(t.c) = lower($1::text))
           ELSE false
         END)
     AND ($2::text IS NULL OR NOT EXISTS (
           SELECT 1
             FROM unnest(string_to_array($2::text, E'\\x01')) AS tok
            WHERE concat_ws(' ', title, "shortDescription", description)
                  NOT ILIKE ('%' || tok || '%')))`;

const FEED_SQL = `
  SELECT ${FEED_COLUMNS}
    FROM products
  ${FEED_WHERE}
     AND ($3::timestamp(3) IS NULL
          OR ("createdAt", id) < ($3::timestamp(3), $4::text))
   ORDER BY "createdAt" DESC, id DESC
   LIMIT $5::int`;

const FEED_COUNT_SQL = `SELECT count(*)::int AS total FROM products ${FEED_WHERE}`;

/**
 * One page of the Active product feed, newest first.
 *
 * @param {object}  opts
 * @param {string?} opts.cursor     opaque cursor from the previous page (null → first page)
 * @param {number?} opts.limit      page size (default 16, capped at 48)
 * @param {string?} opts.collection case-insensitive collection ("category") filter
 * @param {string?} opts.q          search over title / shortDescription / description
 * @returns {Promise<{items: object[], nextCursor: string|null, hasMore: boolean, total: number|null}>}
 *
 * `total` is returned ONLY for the first page of a filter set (cursor === null);
 * subsequent pages return null so scrolling never pays for a COUNT.
 */
export async function getProductsPage({ cursor = null, limit, collection = null, q = null } = {}) {
  const size    = clampLimit(limit);
  const filters = normalizeFilters({ collection, q });
  const key     = decodeCursor(cursor); // tampered/stale cursor → first page, never an error

  const collectionParam = filters.collection;
  const searchTokens    = searchParam(filters.q);   // null → search filter off

  const [rows, storeSettings, totalRows] = await Promise.all([
    // take size + 1: the extra row tells us hasMore without a second query.
    prisma.$queryRawUnsafe(
      FEED_SQL,
      collectionParam,
      searchTokens,
      key ? new Date(key.createdAt) : null,
      key ? key.id : null,
      size + 1,
    ),
    getStoreSettings(),
    key
      ? Promise.resolve(null)
      : prisma.$queryRawUnsafe(FEED_COUNT_SQL, collectionParam, searchTokens),
  ]);

  const hasMore = rows.length > size;
  const page    = hasMore ? rows.slice(0, size) : rows;

  return {
    items:      page.map((p) => publicListProduct(p, storeSettings)),
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    hasMore,
    total:      totalRows ? (totalRows[0]?.total ?? null) : null,
  };
}

/**
 * Fetch a set of products by their Prisma UUIDs.
 * Used by the cart page so it only downloads the products it needs instead of
 * fetching the entire catalogue and filtering client-side.
 *
 * WHY: Cart page was fetching ALL products (~4 MB JSON) then filtering 2-3 matches
 *      in the browser. This replaces that with a targeted query returning only the
 *      products in the cart (typically < 10 KB).
 */
export async function getProductsByIds(ids) {
  if (!ids?.length) return [];

  const LIST_SELECT = {
    id: true, title: true, shortDescription: true,
    regularPrice: true, salePrice: true,
    images: true, collections: true,
    sku: true, stockStatus: true, stockQuantity: true,
    productLabel: true, tags: true, brand: true,
    rating: true, ratingsCount: true, reviewsCount: true,
    isActive: true, status: true,
    redirectMode: true, redirectUrl: true,
    limitedTimeDeal: true,
    allowCOD: true, allowPrepaid: true,
    conversionEnabled: true, conversionSold: true, conversionStock: true,
    bundles: true,
    isLocked: true,   // grids show a lock icon; locked products cannot be opened or bought
    createdAt: true,
  };

  const [products, storeSettings] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, select: LIST_SELECT }),
    getStoreSettings(),
  ]);

  return products.map((p) => publicListProduct(p, storeSettings));
}

/**
 * Fetch a single product by its Prisma UUID.
 * Returns null if not found.
 */
export async function getProductById(id) {
  const [product, storeSettings] = await Promise.all([
    prisma.product.findUnique({ where: { id } }),
    getStoreSettings(),
  ]);
  if (!product) return null;
  return mapProduct(product, storeSettings);
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Create a new product. Returns the mapped product with `_id`. */
export async function createProduct(body) {
  const data = sanitiseInput(body);
  const product = await prisma.product.create({ data });
  const storeSettings = await getStoreSettings();
  return mapProduct(product, storeSettings);
}

/**
 * Update a product by its Prisma UUID.
 * Returns null if not found.
 */
export async function updateProduct(id, body) {
  const data = sanitiseInput(body);

  // If the images array is being replaced, capture which URLs were removed so
  // their Cloudinary assets can be cleaned up AFTER the DB update succeeds.
  // (Only runs when `images` is actually part of this update — partial updates
  // like an isActive toggle are untouched.)
  let removed = [];
  if (Array.isArray(data.images)) {
    try {
      const existing = await prisma.product.findUnique({ where: { id }, select: { images: true } });
      removed = diffRemovedUrls(existing?.images, data.images);
    } catch { /* non-fatal — cleanup is best-effort */ }
  }

  try {
    const product = await prisma.product.update({ where: { id }, data });

    // DB row now holds the new images[] (removed items already gone). Clean up
    // the removed Cloudinary assets — best-effort, never throws, never blocks.
    // Only assets nothing else references are destroyed. Note the row is already
    // updated, so a URL dropped from `images` but still used in THIS product's
    // `sections` is correctly retained by the guard.
    if (removed.length) {
      try {
        await destroyManyByUrls(removed, { label: `product:${id}`, isReferenced: isMediaUrlReferenced });
      } catch (err) {
        console.error('[media-cleanup] unexpected error during product update:', err?.message ?? err);
      }
    }

    const storeSettings = await getStoreSettings();
    return mapProduct(product, storeSettings);
  } catch (err) {
    if (err.code === 'P2025') return null; // record not found
    throw err;
  }
}

/** Delete a product by its Prisma UUID. Returns true on success, false if not found. */
export async function deleteProduct(id) {
  // Read the images first so we can clean up their Cloudinary assets after the
  // DB row is gone. Reading is non-fatal — if it fails we still delete the row.
  let images = [];
  try {
    const existing = await prisma.product.findUnique({ where: { id }, select: { images: true } });
    images = Array.isArray(existing?.images) ? existing.images : [];
  } catch { /* non-fatal */ }

  try {
    await prisma.product.delete({ where: { id } });
  } catch (err) {
    if (err.code === 'P2025') return false;
    throw err;
  }

  // DB is consistent (row deleted). Now best-effort remote cleanup — a storage
  // failure is logged but NEVER changes the delete result or throws.
  //
  // The guard is what stops this destroying a SHARED asset: the Duplicate button
  // copies image URLs verbatim, and order snapshots embed them, so an image this
  // product listed may still be another product's (or an invoice's) only copy.
  // Anything still referenced — or any URL we cannot check — is retained.
  try {
    await destroyManyByUrls(images, { label: `product:${id}`, isReferenced: isMediaUrlReferenced });
  } catch (err) {
    console.error('[media-cleanup] unexpected error during product delete:', err?.message ?? err);
  }

  return true;
}
