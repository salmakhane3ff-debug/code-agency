-- ─────────────────────────────────────────────────────────────────────────────
-- Demo avatars + demo UGC stats (Demo Competition system)
--
-- ADDITIVE ONLY. Touches DEMO tables exclusively:
--   • CREATE TABLE demo_avatars               (new)
--   • ALTER demo_affiliates  ADD avatarUrl, gender    (nullable — no rewrite)
--   • ALTER demo_stats       ADD ugc* columns          (defaulted — no rewrite)
-- It does NOT touch any real/production table (affiliates, ugc_earnings,
-- ugc_daily_targets, affiliate_payouts, …) and contains no DROP / rename /
-- destructive statement. All demo data stays isolated from production.
--
-- Re-execution: guarded by _prisma_migrations; IF NOT EXISTS makes manual re-runs
-- harmless.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "demo_avatars" (
  "id"         TEXT         NOT NULL,
  "gender"     TEXT         NOT NULL,
  "url"        TEXT         NOT NULL,
  "storageKey" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "demo_avatars_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "demo_avatars_gender_idx" ON "demo_avatars" ("gender");

ALTER TABLE "demo_affiliates" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "demo_affiliates" ADD COLUMN IF NOT EXISTS "gender"    TEXT;

ALTER TABLE "demo_stats" ADD COLUMN IF NOT EXISTS "ugcTodayEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "demo_stats" ADD COLUMN IF NOT EXISTS "ugcTodaySales"    INTEGER          NOT NULL DEFAULT 0;
ALTER TABLE "demo_stats" ADD COLUMN IF NOT EXISTS "ugcTotalEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "demo_stats" ADD COLUMN IF NOT EXISTS "ugcTotalSales"    INTEGER          NOT NULL DEFAULT 0;
