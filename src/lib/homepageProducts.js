/**
 * src/lib/homepageProducts.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The admin-controlled number of products shown by the homepage "Products Grid" section
 * (Homepage Builder → section `products` → `data.productCount`, saved in the existing
 * `homepage_layout` setting). Pure: shared by the builder and the storefront renderer.
 *
 *   • exactly 4, 6, 8 or 10; default 4 (also for the homepage without a saved layout);
 *   • ONLY the new key `productCount` is read. The old `data.limit` key ("Max Products",
 *     written since the builder existed but never read by the storefront) is deliberately
 *     ignored, so saved layouts that still carry e.g. `limit: 8` do not change the homepage.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PRODUCT_COUNT_OPTIONS = Object.freeze([4, 6, 8, 10]);
export const DEFAULT_PRODUCT_COUNT = 4;

/** Any value → one of PRODUCT_COUNT_OPTIONS (numbers or numeric strings), else the default. */
export function normalizeProductCount(value) {
  const n = typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && PRODUCT_COUNT_OPTIONS.includes(n) ? n : DEFAULT_PRODUCT_COUNT;
}

/** The count a homepage `products` section renders (its `data.productCount`; never `data.limit`). */
export const sectionProductCount = (data) => normalizeProductCount(data && typeof data === 'object' ? data.productCount : undefined);
