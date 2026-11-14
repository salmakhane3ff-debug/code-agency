-- ─────────────────────────────────────────────────────────────────────────────
-- 20261115_payout_banks — Phase 4: bank logo picker + admin bank management.
--
--   • payout_banks — the admin-managed catalogue of banks an affiliate / recruiter
--     picks for withdrawals: name, public logo URL, active flag, "RIB required" flag,
--     display order. A bank is NEVER deleted by the application (deactivation only).
--   • affiliates."bankId" / recruiters."bankId" — nullable reference to the chosen bank,
--     ON DELETE RESTRICT (a bank somebody chose can never be deleted). The existing
--     "bankName" / "rib" / "accountName" columns are kept and unchanged: bankName keeps a
--     copy of the chosen bank's name, so the existing withdrawal / payout screens and
--     rules keep working. Existing rows keep "bankId" NULL (no backfill: no affiliate or
--     recruiter has saved bank details yet; a NULL bankId simply keeps the original rule).
--
-- Additive and forward-only: one new table, two nullable columns, two foreign keys,
-- indexes, two CHECKs. No existing row is updated or deleted.
-- Re-runnable: IF NOT EXISTS and duplicate_object handlers. No explicit transaction.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Catalogue ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payout_banks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ribRequired" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_banks_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  -- Trimmed name of 1 … 80 characters; display order 0 … 9999.
  ALTER TABLE "payout_banks" ADD CONSTRAINT "payout_banks_name_check"
    CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 80);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "payout_banks" ADD CONSTRAINT "payout_banks_sort_order_check"
    CHECK ("sortOrder" BETWEEN 0 AND 9999);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "payout_banks_isActive_sortOrder_idx" ON "payout_banks"("isActive", "sortOrder");
-- One bank per name, whatever the letter case (race-safe duplicate check).
CREATE UNIQUE INDEX IF NOT EXISTS "payout_banks_name_lower_key" ON "payout_banks"(lower("name"));

-- ── 2. References (nullable; existing rows keep NULL) ───────────────────────
ALTER TABLE "affiliates" ADD COLUMN IF NOT EXISTS "bankId" TEXT;
ALTER TABLE "recruiters" ADD COLUMN IF NOT EXISTS "bankId" TEXT;

CREATE INDEX IF NOT EXISTS "affiliates_bankId_idx" ON "affiliates"("bankId");
CREATE INDEX IF NOT EXISTS "recruiters_bankId_idx" ON "recruiters"("bankId");

DO $$ BEGIN
  ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_bankId_fkey"
    FOREIGN KEY ("bankId") REFERENCES "payout_banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "recruiters" ADD CONSTRAINT "recruiters_bankId_fkey"
    FOREIGN KEY ("bankId") REFERENCES "payout_banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
