-- Starter Booster purchases — ADDITIVE migration (no DROP / rename / destructive
-- change). New table only; no existing table is modified. Purchases paid with
-- the affiliate balance are deducted by a derived balance provider (no stored
-- wallet field anywhere).

CREATE TABLE IF NOT EXISTS "affiliate_booster_purchases" (
  "id"            TEXT NOT NULL,
  "affiliateId"   TEXT NOT NULL,
  "packageId"     TEXT NOT NULL,
  "packageName"   TEXT NOT NULL,
  "price"         DOUBLE PRECISION NOT NULL,
  "paymentMethod" TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt"   TIMESTAMP(3),

  CONSTRAINT "affiliate_booster_purchases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "affiliate_booster_purchases_affiliateId_idx" ON "affiliate_booster_purchases" ("affiliateId");
CREATE INDEX IF NOT EXISTS "affiliate_booster_purchases_status_idx"      ON "affiliate_booster_purchases" ("status");

DO $$ BEGIN
  ALTER TABLE "affiliate_booster_purchases"
    ADD CONSTRAINT "affiliate_booster_purchases_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
