-- ─────────────────────────────────────────────────────────────────────────────
-- UGC daily targets (simulation engine redesign)
--
-- ADDITIVE ONLY. Creates ONE new table (ugc_daily_targets). It does NOT touch
-- ugc_earnings or any other existing table/column/constraint/index, so all
-- historical UGC earnings are fully preserved.
--
-- Purpose: store one simulated-sales DAILY TARGET per RUNNING video per business
-- day, plus running progress (generatedToday / completed). Individual simulated
-- sales remain rows in ugc_earnings (generatedSales = 1); no schedule table is
-- created — pacing is derived from generatedToday + the ledger (restart-safe).
--
-- Re-execution: guarded by Prisma's _prisma_migrations bookkeeping; the
-- IF NOT EXISTS clauses additionally make a manual re-run harmless.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ugc_daily_targets" (
  "id"             TEXT         NOT NULL,
  "ugcVideoId"     TEXT         NOT NULL,
  "affiliateId"    TEXT         NOT NULL,
  "generationDate" TIMESTAMP(3) NOT NULL,
  "businessDate"   TEXT         NOT NULL,
  "timezone"       TEXT         NOT NULL,
  "dailyTarget"    INTEGER      NOT NULL,
  "generatedToday" INTEGER      NOT NULL DEFAULT 0,
  "completed"      BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ugc_daily_targets_pkey" PRIMARY KEY ("id")
);

-- One target per (video, business day).
CREATE UNIQUE INDEX IF NOT EXISTS "ugc_daily_targets_ugcVideoId_generationDate_key"
  ON "ugc_daily_targets" ("ugcVideoId", "generationDate");

CREATE INDEX IF NOT EXISTS "ugc_daily_targets_affiliateId_idx"
  ON "ugc_daily_targets" ("affiliateId");
CREATE INDEX IF NOT EXISTS "ugc_daily_targets_generationDate_idx"
  ON "ugc_daily_targets" ("generationDate");
CREATE INDEX IF NOT EXISTS "ugc_daily_targets_completed_idx"
  ON "ugc_daily_targets" ("completed");

-- FK to the submission (RESTRICT — consistent with the no-hard-delete design).
-- Guarded so a manual re-run does not error on an existing constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ugc_daily_targets_ugcVideoId_fkey'
  ) THEN
    ALTER TABLE "ugc_daily_targets"
      ADD CONSTRAINT "ugc_daily_targets_ugcVideoId_fkey"
      FOREIGN KEY ("ugcVideoId") REFERENCES "ugc_video_submissions"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
