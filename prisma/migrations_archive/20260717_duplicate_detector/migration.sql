-- Duplicate Listings Detector (review-only tool).
--
-- Two parts:
--   1. duplicate_ignores — the groups an admin dismissed.
--   2. expression indexes backing the high-confidence GROUP BY blocking keys.
--
-- No PostgreSQL extensions are required: V1 uses deterministic equality signals
-- only (no pg_trgm / fuzzy matching), so this runs on a stock database.
-- Additive only: no existing data is read, written, moved or dropped.

-- ── 1. Ignored duplicate groups ──────────────────────────────────────────────
CREATE TABLE "duplicate_ignores" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "groupKey"    TEXT         NOT NULL,
    "fingerprint" TEXT         NOT NULL,
    "productIds"  JSONB        NOT NULL DEFAULT '[]',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "duplicate_ignores_pkey" PRIMARY KEY ("id")
);

-- The uniqueness that makes "Ignore" idempotent: an upsert on groupKey can never
-- produce a second record for the same group, even under concurrent clicks.
CREATE UNIQUE INDEX "duplicate_ignores_groupKey_key" ON "duplicate_ignores"("groupKey");

-- ── 2. Blocking-key indexes for the high-confidence signals ──────────────────
-- The detector groups by these expressions; indexing them lets Postgres group
-- from the index instead of scanning + sorting the whole table.

-- Identical title.
CREATE INDEX "products_title_key_idx" ON "products"(lower(btrim("title")));

-- Identical SKU / barcode. PARTIAL on purpose: the admin's "Duplicate" button
-- creates copies with sku = '', so empty values must never form a group — every
-- copied product would otherwise "match" every other copied product.
CREATE INDEX "products_sku_key_idx"
    ON "products"(btrim("sku"))
    WHERE "sku" IS NOT NULL AND btrim("sku") <> '';

CREATE INDEX "products_barcode_key_idx"
    ON "products"(btrim("barcode"))
    WHERE "barcode" IS NOT NULL AND btrim("barcode") <> '';

-- Medium/low signals (normalized title, first-image filename, brand+collections
-- +price) are grouped with a hash aggregate over a single scan — O(n), no
-- pairwise comparison — so they need no index of their own.
