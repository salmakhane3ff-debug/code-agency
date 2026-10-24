-- Product purchase flow — ADDITIVE migration.
-- Adds one column with a default so every existing product keeps the current
-- behaviour (Checkout Page). No existing data is altered or removed.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "purchaseFlow" TEXT NOT NULL DEFAULT 'checkout';
