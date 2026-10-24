-- Fake Orders Engine — ADDITIVE migration (no DROP / rename / destructive change).
-- Adds internal fake-order flags to orders + affiliate_orders, and the per-affiliate
-- configuration table. Every column is nullable or has a default, so existing rows
-- and all production code paths are unchanged (isFake=false, orderSource='REAL').

-- ── orders: internal fake flags ───────────────────────────────────────────────
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "isFake"      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "orderSource" TEXT    NOT NULL DEFAULT 'REAL';
CREATE INDEX IF NOT EXISTS "orders_isFake_idx" ON "orders" ("isFake");

-- ── affiliate_orders: mirror flag for affiliate-side analytics filtering ──────
ALTER TABLE "affiliate_orders" ADD COLUMN IF NOT EXISTS "isFake" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "affiliate_orders_isFake_idx" ON "affiliate_orders" ("isFake");

-- ── fake_order_configs: per-affiliate engine configuration ────────────────────
CREATE TABLE IF NOT EXISTS "fake_order_configs" (
  "id"               TEXT NOT NULL,
  "affiliateId"      TEXT NOT NULL,
  "enabled"          BOOLEAN NOT NULL DEFAULT false,
  "ordersPerMinute"  INTEGER,
  "ordersPerHour"    INTEGER,
  "ordersPerDay"     INTEGER,
  "minDelaySec"      INTEGER NOT NULL DEFAULT 60,
  "maxDelaySec"      INTEGER NOT NULL DEFAULT 600,
  "workingHourStart" INTEGER NOT NULL DEFAULT 9,
  "workingHourEnd"   INTEGER NOT NULL DEFAULT 22,
  "workingDays"      TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  "productMode"      TEXT NOT NULL DEFAULT 'all',
  "productIds"       JSONB NOT NULL DEFAULT '[]',
  "lastOrderAt"      TIMESTAMP(3),
  "nextOrderAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fake_order_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fake_order_configs_affiliateId_key" ON "fake_order_configs" ("affiliateId");
CREATE INDEX IF NOT EXISTS "fake_order_configs_enabled_idx" ON "fake_order_configs" ("enabled");

-- Guarded FK (skip if it already exists — additive & idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fake_order_configs_affiliateId_fkey'
  ) THEN
    ALTER TABLE "fake_order_configs"
      ADD CONSTRAINT "fake_order_configs_affiliateId_fkey"
      FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
