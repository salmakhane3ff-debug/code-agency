-- Starter Booster SIMULATION — ADDITIVE migration (no DROP / rename / destructive
-- change). New table only; nothing existing is modified.
--
-- These are DEMO counters for the Booster experience. They never create an
-- AffiliateOrder, never touch commissions/payouts/withdrawable balance, and the
-- booster price deduction (affiliate_booster_purchases) is untouched — a
-- completed simulation never refunds anything.

CREATE TABLE IF NOT EXISTS "booster_simulations" (
  "id"             TEXT NOT NULL,
  "purchaseId"     TEXT NOT NULL,
  "affiliateId"    TEXT NOT NULL,
  "packageId"      TEXT NOT NULL,
  "targetSales"    INTEGER NOT NULL DEFAULT 0,
  "simulatedSales" INTEGER NOT NULL DEFAULT 0,
  "todaySales"     INTEGER NOT NULL DEFAULT 0,
  "dayKey"         TEXT,
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt"         TIMESTAMP(3),
  "lastTickAt"     TIMESTAMP(3),
  "status"         TEXT NOT NULL DEFAULT 'RUNNING',
  "timeline"       JSONB NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "booster_simulations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "booster_simulations_purchaseId_key" ON "booster_simulations" ("purchaseId");
CREATE INDEX IF NOT EXISTS "booster_simulations_affiliateId_idx" ON "booster_simulations" ("affiliateId");
CREATE INDEX IF NOT EXISTS "booster_simulations_status_idx"      ON "booster_simulations" ("status");

DO $$ BEGIN
  ALTER TABLE "booster_simulations"
    ADD CONSTRAINT "booster_simulations_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
