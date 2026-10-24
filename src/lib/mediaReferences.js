/**
 * src/lib/mediaReferences.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Is this media URL still referenced by anything in the database?"
 *
 * WHY: product deletes/updates destroy the product's R2/Cloudinary objects, but
 * media URLs are SHARED. The admin "Duplicate" button copies `images` verbatim
 * (admin/products/page.jsx: `images: Array.isArray(product.images) ? ... : []`),
 * so a copy points at the exact same objects; order history embeds them too
 * (OrderItem.productSnapshot = { title, images, variants }). Deleting one of a
 * pair therefore blanked the survivor's images and broke old invoices.
 *
 * DESIGN — deliberately over-inclusive, and biased to "keep":
 *   • The URL is matched as a literal SUBSTRING of each field cast to text
 *     (strpos, not LIKE — no wildcard escaping to get wrong). That finds a URL
 *     nested at ANY depth inside JSON without hard-coding each field's shape.
 *   • A false POSITIVE ("shared" when it isn't) → we skip → an orphan object.
 *     Acceptable.
 *   • A false NEGATIVE ("unused" when it isn't) → we delete a live asset →
 *     a broken product. NOT acceptable.
 *   Every ambiguity — including a thrown query — therefore resolves to TRUE.
 *
 * No self-exclusion parameter exists on purpose: callers are DB-first, so by the
 * time this runs the deleted row is gone and the updated row no longer lists the
 * removed URL. Not excluding is the conservative direction anyway — and it is
 * what correctly retains an image that a product still uses in its `sections`
 * after being dropped from its `images`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';

/**
 * Every confirmed place a product media URL can appear.
 *
 * Json columns are cast to text and substring-searched; scalar URL columns are
 * compared with strpos too, so a stored URL that merely contains the target
 * still counts (again: over-inclusive on purpose).
 *
 * Table names are the Prisma @@map values — a typo here would make the query
 * throw, which fails safe (nothing is ever deleted) but silently disables
 * cleanup, so they are verified against schema.prisma.
 */
const REFERENCE_SOURCES = [
  // Live catalogue — the Duplicate button's shared images, and page-builder
  // sections/bundles that can embed the same asset.
  { table: 'products',         columns: ['images', 'sections', 'bundles'] },
  // Order history: snapshots embed the images array verbatim. Blocking on these
  // keeps invoices and past orders rendering.
  { table: 'order_items',      columns: ['productSnapshot'] },
  // Draft orders created for abandoned-cart recovery carry cart snapshots.
  { table: 'orders',           columns: ['paymentDetails'] },
  { table: 'abandoned_carts',  columns: ['items'] },
  // Merchandising surfaces that can reuse a product image.
  { table: 'landing_pages',    columns: ['sections', 'images'] },
  { table: 'homepage_banners', columns: ['images', 'links'] },
  { table: 'landing_templates', columns: ['content'] },
  { table: 'content_items',    columns: ['data'] },
  { table: 'posts',            columns: ['data'] },
  { table: 'settings',         columns: ['data'] },
  { table: 'collections',      columns: ['image', 'banner'] },
  { table: 'invoices',         columns: ['items'] },
  { table: 'feedbacks',        columns: ['images', 'mediaUrl'] },
  { table: 'scheduled_reviews', columns: ['images'] },
  // Rewards: catalog images come from the same media library, and each gift
  // request snapshots its gift's image so history keeps rendering.
  { table: 'reward_gifts',       columns: ['images'] },
  { table: 'reward_redemptions', columns: ['giftSnapshot'] },
];

// One round-trip: OR of an EXISTS per source. Postgres stops at the first true.
const REFERENCE_SQL = `SELECT (${REFERENCE_SOURCES.map(({ table, columns }) => {
  const test = columns.map((c) => `strpos("${table}"."${c}"::text, $1::text) > 0`).join(' OR ');
  return `EXISTS (SELECT 1 FROM "${table}" WHERE ${test})`;
}).join('\n    OR ')}) AS referenced`;

/**
 * @param {string} url  the exact media URL about to be destroyed
 * @returns {Promise<boolean>} true when the URL must be KEPT
 */
export async function isMediaUrlReferenced(url) {
  // An empty URL is never worth deleting; treat as referenced so nothing happens.
  if (!url || typeof url !== 'string') return true;

  try {
    const rows = await prisma.$queryRawUnsafe(REFERENCE_SQL, url);
    // Anything other than an explicit false means "keep it".
    return rows?.[0]?.referenced !== false;
  } catch (err) {
    // Fail-safe: if we cannot prove the asset is unused, we do not touch it.
    console.error(`[media-references] check failed, retaining ${url}:`, err?.message ?? err);
    return true;
  }
}

// Exported for inspection/tests — not part of the runtime contract.
export const __REFERENCE_SQL = REFERENCE_SQL;
export const __REFERENCE_SOURCES = REFERENCE_SOURCES;
