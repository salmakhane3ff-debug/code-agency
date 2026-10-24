/**
 * src/lib/productLock.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Product lock — pure helpers shared by the server and the storefront UI.
 *
 *   Open (default)  → the product behaves exactly as before.
 *   Locked          → still listed in the storefront grids with its image, name
 *                     and price plus a lock icon, but NOBODY (customer or
 *                     affiliate) can open its page or buy it.
 *
 * Enforced server-side in: GET /api/products/[id] (403 unless admin), the
 * product page (/products/[id] renders the locked view), and createOrder
 * (PRODUCT_LOCKED → 422). The UI only mirrors it. No imports — client-safe.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PRODUCT_LOCKED = 'PRODUCT_LOCKED';

export const isProductLocked = (product) => product?.isLocked === true;

/** Coded error thrown when a locked product is opened through the API or ordered. */
export function productLockedError(id) {
  return Object.assign(new Error(`Product is locked: ${id}`), { code: PRODUCT_LOCKED });
}

/**
 * What a locked product may still show: image, name and price — nothing that
 * would let it be read in full or bought (no description, variants, sections,
 * bundles, redirect or payment settings).
 */
export function lockedProductView(p) {
  if (!p) return null;
  const images = Array.isArray(p.images) ? p.images.slice(0, 1) : [];
  return {
    _id:            p._id ?? p.id,
    id:             p.id ?? p._id,
    title:          p.title,
    images,
    regularPrice:   p.regularPrice ?? null,
    salePrice:      p.salePrice ?? null,
    currencySymbol: p.currencySymbol,
    storeCurrency:  p.storeCurrency,
    isLocked:       true,
  };
}
