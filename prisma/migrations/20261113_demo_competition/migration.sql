-- ─────────────────────────────────────────────────────────────────────────────
-- 20261113_demo_competition — Demo Competition (Top Members / Top Brands). SIMULATION ONLY.
--
-- ADDITIVE / FORWARD-ONLY / RE-RUNNABLE: creates 7 new demo_comp_* tables and nothing else. No
-- existing table, column, constraint or row is touched (the old demo_* tables of the previous demo
-- generator are left exactly as they are). Nothing here references orders, affiliates, payouts,
-- wallets, deposits, boosters, UGC, rewards, recruiters or the Create Your Own Brand tables.
--
--   • demo_comp_members / demo_comp_brands — the 21 demo members and 20 demo brands (current
--     settings; a brand is owned by one member, FK RESTRICT so a member owning brands cannot go).
--   • demo_comp_member_versions / demo_comp_brand_versions — APPEND-ONLY settings history. A day
--     plan reads the version in force at the Casablanca day start (min / max), an event the
--     version in force at its scheduled time (price / allocation): history is never recomputed.
--   • demo_comp_daily_plans — one IMMUTABLE plan per (stream, profile, Casablanca day): the day's
--     target, deterministic, within the snapshotted min / max.
--   • demo_comp_events — IMMUTABLE demo sale events (1..3 orders each) with price / allocation /
--     earnings snapshots and a UNIQUE idempotency key (duplicates are impossible).
--   • demo_comp_engine — one row: engine switch (OFF by default), when it was last switched ON / OFF
--     (nothing is generated for the time it was OFF), last run, default price and allocations for
--     new profiles (member and brand allocations are separate streams: each 1..10000 bps, no
--     combined cap).
--
-- Profiles are ARCHIVED (archivedAt, always disabled), not deleted: their history stays.
--
-- Money: integer centimes. Allocation: basis points (1..10000 = 0.01 %..100 %).
-- Guards: CHECK constraints (ranges, stream / owner consistency, the earnings formula) and
-- triggers that refuse UPDATE on versions / plans / events and allow DELETE only through the
-- cascade of their (deleted) profile.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_members" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "photoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "minDailyOrders" INTEGER NOT NULL DEFAULT 5,
    "maxDailyOrders" INTEGER NOT NULL DEFAULT 30,
    "priceCents" INTEGER NOT NULL DEFAULT 30000,
    "allocationBps" INTEGER NOT NULL DEFAULT 3000,
    "networkAffiliates" INTEGER NOT NULL DEFAULT 0,
    "networkMinDailyOrders" INTEGER NOT NULL DEFAULT 0,
    "networkMaxDailyOrders" INTEGER NOT NULL DEFAULT 0,
    "networkPriceCents" INTEGER,
    "networkAllocationBps" INTEGER,
    "personalGeneratedThrough" TIMESTAMP(3),
    "networkGeneratedThrough" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_comp_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_member_versions" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "minDailyOrders" INTEGER NOT NULL,
    "maxDailyOrders" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "allocationBps" INTEGER NOT NULL,
    "networkAffiliates" INTEGER NOT NULL,
    "networkMinDailyOrders" INTEGER NOT NULL,
    "networkMaxDailyOrders" INTEGER NOT NULL,
    "networkPriceCents" INTEGER,
    "networkAllocationBps" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_comp_member_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "ownerId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "minDailyOrders" INTEGER NOT NULL DEFAULT 5,
    "maxDailyOrders" INTEGER NOT NULL DEFAULT 30,
    "priceCents" INTEGER NOT NULL DEFAULT 30000,
    "allocationBps" INTEGER NOT NULL DEFAULT 7000,
    "generatedThrough" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_comp_brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_brand_versions" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "minDailyOrders" INTEGER NOT NULL,
    "maxDailyOrders" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "allocationBps" INTEGER NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_comp_brand_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_daily_plans" (
    "id" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "memberId" TEXT,
    "brandId" TEXT,
    "dayKey" TEXT NOT NULL,
    "dayStart" TIMESTAMP(3) NOT NULL,
    "dayEnd" TIMESTAMP(3) NOT NULL,
    "targetOrders" INTEGER NOT NULL,
    "minOrders" INTEGER NOT NULL,
    "maxOrders" INTEGER NOT NULL,
    "versionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_comp_daily_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "memberId" TEXT,
    "brandId" TEXT,
    "planId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "allocationBps" INTEGER NOT NULL,
    "earningsCents" INTEGER NOT NULL,
    "versionId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "demo_comp_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_engine" (
    "id" TEXT NOT NULL DEFAULT 'engine',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultPriceCents" INTEGER NOT NULL DEFAULT 30000,
    "defaultMemberBps" INTEGER NOT NULL DEFAULT 3000,
    "defaultBrandBps" INTEGER NOT NULL DEFAULT 7000,
    "initializedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunEvents" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_comp_engine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_members_active_idx" ON "demo_comp_members"("active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_member_versions_memberId_effectiveFrom_idx" ON "demo_comp_member_versions"("memberId", "effectiveFrom");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_brands_ownerId_idx" ON "demo_comp_brands"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_brands_active_idx" ON "demo_comp_brands"("active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_brand_versions_brandId_effectiveFrom_idx" ON "demo_comp_brand_versions"("brandId", "effectiveFrom");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_daily_plans_memberId_idx" ON "demo_comp_daily_plans"("memberId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_daily_plans_brandId_idx" ON "demo_comp_daily_plans"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "demo_comp_daily_plans_stream_profileKey_dayKey_key" ON "demo_comp_daily_plans"("stream", "profileKey", "dayKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "demo_comp_events_idempotencyKey_key" ON "demo_comp_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_events_memberId_eventType_scheduledAt_idx" ON "demo_comp_events"("memberId", "eventType", "scheduledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_events_brandId_scheduledAt_idx" ON "demo_comp_events"("brandId", "scheduledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_events_scheduledAt_idx" ON "demo_comp_events"("scheduledAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_member_versions" ADD CONSTRAINT "demo_comp_member_versions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "demo_comp_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_brands" ADD CONSTRAINT "demo_comp_brands_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "demo_comp_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_brand_versions" ADD CONSTRAINT "demo_comp_brand_versions_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "demo_comp_brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_daily_plans" ADD CONSTRAINT "demo_comp_daily_plans_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "demo_comp_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_daily_plans" ADD CONSTRAINT "demo_comp_daily_plans_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "demo_comp_brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_events" ADD CONSTRAINT "demo_comp_events_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "demo_comp_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_events" ADD CONSTRAINT "demo_comp_events_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "demo_comp_brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_events" ADD CONSTRAINT "demo_comp_events_planId_fkey" FOREIGN KEY ("planId") REFERENCES "demo_comp_daily_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Constraints ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "demo_comp_members" ADD CONSTRAINT "demo_comp_members_settings_check" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 80
    AND "minDailyOrders" BETWEEN 0 AND 1000 AND "maxDailyOrders" BETWEEN "minDailyOrders" AND 1000
    AND "priceCents" BETWEEN 1 AND 10000000 AND "allocationBps" BETWEEN 1 AND 10000
    AND "networkAffiliates" BETWEEN 0 AND 100000
    AND "networkMinDailyOrders" BETWEEN 0 AND 1000 AND "networkMaxDailyOrders" BETWEEN "networkMinDailyOrders" AND 1000
    AND (("networkPriceCents" IS NULL AND "networkAllocationBps" IS NULL)
      OR ("networkPriceCents" BETWEEN 1 AND 10000000 AND "networkAllocationBps" BETWEEN 1 AND 10000)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_member_versions" ADD CONSTRAINT "demo_comp_member_versions_settings_check" CHECK (
    "minDailyOrders" BETWEEN 0 AND 1000 AND "maxDailyOrders" BETWEEN "minDailyOrders" AND 1000
    AND "priceCents" BETWEEN 1 AND 10000000 AND "allocationBps" BETWEEN 1 AND 10000
    AND "networkAffiliates" BETWEEN 0 AND 100000
    AND "networkMinDailyOrders" BETWEEN 0 AND 1000 AND "networkMaxDailyOrders" BETWEEN "networkMinDailyOrders" AND 1000
    AND (("networkPriceCents" IS NULL AND "networkAllocationBps" IS NULL)
      OR ("networkPriceCents" BETWEEN 1 AND 10000000 AND "networkAllocationBps" BETWEEN 1 AND 10000)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_brands" ADD CONSTRAINT "demo_comp_brands_settings_check" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 80
    AND "minDailyOrders" BETWEEN 0 AND 1000 AND "maxDailyOrders" BETWEEN "minDailyOrders" AND 1000
    AND "priceCents" BETWEEN 1 AND 10000000 AND "allocationBps" BETWEEN 1 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_brand_versions" ADD CONSTRAINT "demo_comp_brand_versions_settings_check" CHECK (
    "minDailyOrders" BETWEEN 0 AND 1000 AND "maxDailyOrders" BETWEEN "minDailyOrders" AND 1000
    AND "priceCents" BETWEEN 1 AND 10000000 AND "allocationBps" BETWEEN 1 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_daily_plans" ADD CONSTRAINT "demo_comp_daily_plans_check" CHECK (
    "dayKey" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "dayEnd" > "dayStart"
    AND "minOrders" >= 0 AND "maxOrders" >= "minOrders" AND "targetOrders" BETWEEN "minOrders" AND "maxOrders"
    AND (("stream" = 'BRAND' AND "brandId" IS NOT NULL AND "memberId" IS NULL AND "profileKey" = "brandId")
      OR ("stream" IN ('PERSONAL', 'NETWORK') AND "memberId" IS NOT NULL AND "brandId" IS NULL AND "profileKey" = "memberId")));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_events" ADD CONSTRAINT "demo_comp_events_check" CHECK (
    "quantity" BETWEEN 1 AND 3 AND "seq" >= 0 AND char_length("idempotencyKey") > 0
    AND "priceCents" BETWEEN 1 AND 10000000 AND "allocationBps" BETWEEN 1 AND 10000
    AND "earningsCents" = ROUND(("quantity"::numeric * "priceCents" * "allocationBps") / 10000)
    AND (("eventType" = 'BRAND_SALE' AND "brandId" IS NOT NULL AND "memberId" IS NULL)
      OR ("eventType" IN ('PERSONAL_SALE', 'NETWORK_SALE') AND "memberId" IS NOT NULL AND "brandId" IS NULL)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_engine" ADD CONSTRAINT "demo_comp_engine_check" CHECK (
    "id" = 'engine' AND "defaultPriceCents" BETWEEN 1 AND 10000000
    AND "defaultMemberBps" BETWEEN 1 AND 10000 AND "defaultBrandBps" BETWEEN 1 AND 10000
    AND "lastRunEvents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An archived profile is always disabled (it never generates and is never ranked publicly).
DO $$ BEGIN
  ALTER TABLE "demo_comp_members" ADD CONSTRAINT "demo_comp_members_archive_check" CHECK ("archivedAt" IS NULL OR "active" = false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_brands" ADD CONSTRAINT "demo_comp_brands_archive_check" CHECK ("archivedAt" IS NULL OR "active" = false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Guards: history is permanent ─────────────────────────────────────────────
-- Versions, plans and events refuse UPDATE; DELETE only through the cascade of their deleted
-- profile (the profile row is already gone when the cascaded delete reaches them). TRUNCATE is not
-- covered (an operator action, never issued by the application).

CREATE OR REPLACE FUNCTION "demo_comp_history_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'demo_comp_member_versions' THEN
      IF NOT EXISTS (SELECT 1 FROM "demo_comp_members" WHERE "id" = OLD."memberId") THEN RETURN OLD; END IF;
    ELSIF TG_TABLE_NAME = 'demo_comp_brand_versions' THEN
      IF NOT EXISTS (SELECT 1 FROM "demo_comp_brands" WHERE "id" = OLD."brandId") THEN RETURN OLD; END IF;
    ELSE
      IF (OLD."memberId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "demo_comp_members" WHERE "id" = OLD."memberId"))
        OR (OLD."brandId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "demo_comp_brands" WHERE "id" = OLD."brandId")) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION '% is permanent demo history (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "demo_comp_member_versions_permanent" ON "demo_comp_member_versions";
CREATE TRIGGER "demo_comp_member_versions_permanent"
  BEFORE UPDATE OR DELETE ON "demo_comp_member_versions"
  FOR EACH ROW EXECUTE PROCEDURE "demo_comp_history_guard"();

DROP TRIGGER IF EXISTS "demo_comp_brand_versions_permanent" ON "demo_comp_brand_versions";
CREATE TRIGGER "demo_comp_brand_versions_permanent"
  BEFORE UPDATE OR DELETE ON "demo_comp_brand_versions"
  FOR EACH ROW EXECUTE PROCEDURE "demo_comp_history_guard"();

DROP TRIGGER IF EXISTS "demo_comp_daily_plans_permanent" ON "demo_comp_daily_plans";
CREATE TRIGGER "demo_comp_daily_plans_permanent"
  BEFORE UPDATE OR DELETE ON "demo_comp_daily_plans"
  FOR EACH ROW EXECUTE PROCEDURE "demo_comp_history_guard"();

DROP TRIGGER IF EXISTS "demo_comp_events_permanent" ON "demo_comp_events";
CREATE TRIGGER "demo_comp_events_permanent"
  BEFORE UPDATE OR DELETE ON "demo_comp_events"
  FOR EACH ROW EXECUTE PROCEDURE "demo_comp_history_guard"();

-- The engine row (OFF until an admin switches it on).
INSERT INTO "demo_comp_engine" ("id", "enabled", "updatedAt") VALUES ('engine', false, CURRENT_TIMESTAMP)
  ON CONFLICT ("id") DO NOTHING;
