-- ─────────────────────────────────────────────────────────────────────────────
-- 20261116_demo_comp_ugc_videos — Demo Competition: UGC Videos leaderboard. SIMULATION ONLY.
--
-- ADDITIVE / FORWARD-ONLY / RE-RUNNABLE: creates 5 new demo_comp_ugc_* tables and nothing else.
-- No existing table, column, constraint or row is touched. The only reference outside the new
-- tables is the owner FK demo_comp_ugc_videos."memberId" → demo_comp_members (ON DELETE RESTRICT:
-- a demo member owning videos can never be deleted). Nothing here references the real UGC tables
-- (ugc_*), orders, affiliates, affiliate_orders, payouts, wallets, deposits, boosters, rewards or
-- recruiters, and nothing writes the member / brand demo stats (demo_comp_events / plans).
--
--   • demo_comp_ugc_videos — demo UGC videos (title, video / thumbnail URL in the dedicated
--     demo-competition-ugc media namespace, owner demo member, min / max simulated sales per day,
--     reward per sale ∈ {5, 6, 7} MAD, sort order, archive instead of delete).
--   • demo_comp_ugc_video_versions — APPEND-ONLY settings history (active, min / max, reward): a day
--     plan reads the version in force at the Casablanca day start, an event the version in force at
--     its scheduled time — a settings change never rewrites history.
--   • demo_comp_ugc_daily_plans — one IMMUTABLE plan per (video, Casablanca day), UNIQUE.
--   • demo_comp_ugc_events — IMMUTABLE simulated sale events (1..3 sales each) with a reward snapshot
--     and a UNIQUE idempotency key (the engine inserts with ON CONFLICT DO NOTHING).
--   • demo_comp_ugc_settings — one row: module switch (OFF by default), target video count (20).
--
-- Money: integer centimes (rewardCents = quantity × rewardPerSaleMad × 100, enforced by a CHECK).
-- Guards follow 20261113: CHECK constraints, and triggers that refuse UPDATE / DELETE of versions,
-- plans and events except the DELETE cascaded from their (deleted) video.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_ugc_videos" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "videoUrl" TEXT,
    "thumbnailUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "minDailySales" INTEGER NOT NULL DEFAULT 3,
    "maxDailySales" INTEGER NOT NULL DEFAULT 15,
    "rewardPerSaleMad" INTEGER NOT NULL DEFAULT 5,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "generatedThrough" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_comp_ugc_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_ugc_video_versions" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "minDailySales" INTEGER NOT NULL,
    "maxDailySales" INTEGER NOT NULL,
    "rewardPerSaleMad" INTEGER NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_comp_ugc_video_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_ugc_daily_plans" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "dayStart" TIMESTAMP(3) NOT NULL,
    "dayEnd" TIMESTAMP(3) NOT NULL,
    "targetSales" INTEGER NOT NULL,
    "minSales" INTEGER NOT NULL,
    "maxSales" INTEGER NOT NULL,
    "versionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_comp_ugc_daily_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_ugc_events" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "rewardPerSaleMad" INTEGER NOT NULL,
    "rewardCents" INTEGER NOT NULL,
    "versionId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "demo_comp_ugc_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "demo_comp_ugc_settings" (
    "id" TEXT NOT NULL DEFAULT 'ugc',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "targetVideoCount" INTEGER NOT NULL DEFAULT 20,
    "initializedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunEvents" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_comp_ugc_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_ugc_videos_memberId_idx" ON "demo_comp_ugc_videos"("memberId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_ugc_videos_active_idx" ON "demo_comp_ugc_videos"("active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_ugc_video_versions_videoId_effectiveFrom_idx" ON "demo_comp_ugc_video_versions"("videoId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "demo_comp_ugc_daily_plans_videoId_dayKey_key" ON "demo_comp_ugc_daily_plans"("videoId", "dayKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "demo_comp_ugc_events_idempotencyKey_key" ON "demo_comp_ugc_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_ugc_events_videoId_scheduledAt_idx" ON "demo_comp_ugc_events"("videoId", "scheduledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "demo_comp_ugc_events_scheduledAt_idx" ON "demo_comp_ugc_events"("scheduledAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_videos" ADD CONSTRAINT "demo_comp_ugc_videos_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "demo_comp_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_video_versions" ADD CONSTRAINT "demo_comp_ugc_video_versions_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "demo_comp_ugc_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_daily_plans" ADD CONSTRAINT "demo_comp_ugc_daily_plans_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "demo_comp_ugc_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_events" ADD CONSTRAINT "demo_comp_ugc_events_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "demo_comp_ugc_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_events" ADD CONSTRAINT "demo_comp_ugc_events_planId_fkey" FOREIGN KEY ("planId") REFERENCES "demo_comp_ugc_daily_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Constraints ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_videos" ADD CONSTRAINT "demo_comp_ugc_videos_settings_check" CHECK (
    char_length(btrim("title")) BETWEEN 1 AND 120
    AND "minDailySales" BETWEEN 0 AND 1000 AND "maxDailySales" BETWEEN "minDailySales" AND 1000
    AND "rewardPerSaleMad" IN (5, 6, 7) AND "sortOrder" BETWEEN 0 AND 1000000
    AND ("videoUrl" IS NULL OR char_length("videoUrl") BETWEEN 1 AND 2048)
    AND ("thumbnailUrl" IS NULL OR char_length("thumbnailUrl") BETWEEN 1 AND 2048));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An archived video is always disabled (it never generates and is never ranked publicly).
DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_videos" ADD CONSTRAINT "demo_comp_ugc_videos_archive_check" CHECK ("archivedAt" IS NULL OR "active" = false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_video_versions" ADD CONSTRAINT "demo_comp_ugc_video_versions_settings_check" CHECK (
    "minDailySales" BETWEEN 0 AND 1000 AND "maxDailySales" BETWEEN "minDailySales" AND 1000
    AND "rewardPerSaleMad" IN (5, 6, 7));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_daily_plans" ADD CONSTRAINT "demo_comp_ugc_daily_plans_check" CHECK (
    "dayKey" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "dayEnd" > "dayStart"
    AND "minSales" >= 0 AND "maxSales" >= "minSales" AND "maxSales" <= 1000
    AND "targetSales" BETWEEN "minSales" AND "maxSales");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_events" ADD CONSTRAINT "demo_comp_ugc_events_check" CHECK (
    "quantity" BETWEEN 1 AND 3 AND "seq" >= 0 AND char_length("idempotencyKey") > 0
    AND "rewardPerSaleMad" IN (5, 6, 7)
    AND "rewardCents" = "quantity" * "rewardPerSaleMad" * 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_comp_ugc_settings" ADD CONSTRAINT "demo_comp_ugc_settings_check" CHECK (
    "id" = 'ugc' AND "targetVideoCount" BETWEEN 1 AND 100 AND "lastRunEvents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Guards: history is permanent ─────────────────────────────────────────────
-- Versions, plans and events refuse UPDATE; DELETE only through the cascade of their deleted video
-- (the video row is already gone when the cascaded delete reaches them). TRUNCATE is not covered
-- (an operator action, never issued by the application).

CREATE OR REPLACE FUNCTION "demo_comp_ugc_history_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "demo_comp_ugc_videos" WHERE "id" = OLD."videoId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is permanent demo history (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "demo_comp_ugc_video_versions_permanent" ON "demo_comp_ugc_video_versions";
CREATE TRIGGER "demo_comp_ugc_video_versions_permanent"
  BEFORE UPDATE OR DELETE ON "demo_comp_ugc_video_versions"
  FOR EACH ROW EXECUTE PROCEDURE "demo_comp_ugc_history_guard"();

DROP TRIGGER IF EXISTS "demo_comp_ugc_daily_plans_permanent" ON "demo_comp_ugc_daily_plans";
CREATE TRIGGER "demo_comp_ugc_daily_plans_permanent"
  BEFORE UPDATE OR DELETE ON "demo_comp_ugc_daily_plans"
  FOR EACH ROW EXECUTE PROCEDURE "demo_comp_ugc_history_guard"();

DROP TRIGGER IF EXISTS "demo_comp_ugc_events_permanent" ON "demo_comp_ugc_events";
CREATE TRIGGER "demo_comp_ugc_events_permanent"
  BEFORE UPDATE OR DELETE ON "demo_comp_ugc_events"
  FOR EACH ROW EXECUTE PROCEDURE "demo_comp_ugc_history_guard"();

-- The module settings row (OFF until an admin switches it on; target 20 videos).
INSERT INTO "demo_comp_ugc_settings" ("id", "enabled", "targetVideoCount", "updatedAt") VALUES ('ugc', false, 20, CURRENT_TIMESTAMP)
  ON CONFLICT ("id") DO NOTHING;
