-- UGC module — ADDITIVE ONLY.
--
-- Creates one enum and three new tables (submissions, audit history, earnings
-- ledger) with their indexes and foreign keys. It does NOT touch any existing
-- table's columns or data: no DROP, no DELETE, no destructive ALTER, and no
-- change to affiliate_notifications or any affiliate/product column.
--
-- Every foreign key uses ON DELETE RESTRICT: UGC submissions, audit history and
-- earnings can never disappear because an affiliate, product, or submission was
-- removed. Records are preserved over automatic deletion, and the application
-- exposes no deletion flow for any UGC record.
--
-- RE-EXECUTION / IDEMPOTENCY OF THIS MIGRATION:
--   This SQL is deliberately NOT written with IF NOT EXISTS / DO-block guards.
--   Prisma manages re-execution through the `_prisma_migrations` history table,
--   not through idempotent SQL: `prisma migrate deploy` records this folder's
--   checksum after a successful apply and never runs it again, and it refuses to
--   proceed if a previously-applied migration's checksum changed. This matches
--   the project convention (10 of 12 existing migrations use plain, non-guarded
--   DDL). Adding IF NOT EXISTS here would diverge from that model and could mask
--   real drift. Accidental MANUAL re-execution (e.g. running this file by hand)
--   is therefore expected to FAIL LOUDLY on the first CREATE — which is the safe
--   outcome: these are purely additive new objects, so a duplicate-object error
--   surfaces the mistake without any data change. The unique constraints
--   (ugc_video_submissions affiliateId+productId, ugc_earnings idempotencyKey)
--   remain the runtime duplicate guards independent of migration mechanics.

-- ── Enum ──────────────────────────────────────────────────────────────────────
CREATE TYPE "UgcStatus" AS ENUM ('PENDING', 'APPROVED', 'RUNNING', 'PAUSED', 'REJECTED');

-- ── ugc_video_submissions ─────────────────────────────────────────────────────
-- One affiliate + one product = one submission (unique). A rejected submission is
-- replaced in place, never re-created.
CREATE TABLE "ugc_video_submissions" (
    "id"                   TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "affiliateId"          TEXT         NOT NULL,
    "productId"            TEXT         NOT NULL,
    "videoUrl"             TEXT         NOT NULL,
    "storageKey"           TEXT,
    "description"          TEXT,
    "status"               "UgcStatus"  NOT NULL DEFAULT 'PENDING',
    "advertisingConsent"   BOOLEAN      NOT NULL DEFAULT false,
    "advertisingConsentAt" TIMESTAMP(3),
    "submittedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt"           TIMESTAMP(3),
    "rejectedAt"           TIMESTAMP(3),
    "pausedAt"             TIMESTAMP(3),
    "resumedAt"            TIMESTAMP(3),
    "rejectionReason"      TEXT,
    "internalAdminNotes"   TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ugc_video_submissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ugc_video_submissions_affiliateId_productId_key" ON "ugc_video_submissions"("affiliateId", "productId");
CREATE INDEX "ugc_video_submissions_affiliateId_idx" ON "ugc_video_submissions"("affiliateId");
CREATE INDEX "ugc_video_submissions_productId_idx"   ON "ugc_video_submissions"("productId");
CREATE INDEX "ugc_video_submissions_status_idx"      ON "ugc_video_submissions"("status");
CREATE INDEX "ugc_video_submissions_createdAt_idx"   ON "ugc_video_submissions"("createdAt");

-- ── ugc_video_history ─────────────────────────────────────────────────────────
-- Append-only audit trail of every video swap and status transition.
CREATE TABLE "ugc_video_history" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "ugcVideoId"  TEXT         NOT NULL,
    "oldVideoUrl" TEXT,
    "newVideoUrl" TEXT,
    "oldStatus"   "UgcStatus",
    "newStatus"   "UgcStatus",
    "action"      TEXT         NOT NULL,
    "actorId"     TEXT,
    "actorType"   TEXT         NOT NULL,
    "reason"      TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ugc_video_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ugc_video_history_ugcVideoId_idx" ON "ugc_video_history"("ugcVideoId");
CREATE INDEX "ugc_video_history_createdAt_idx"  ON "ugc_video_history"("createdAt");

-- ── ugc_earnings ──────────────────────────────────────────────────────────────
-- Immutable earnings ledger. Monetary columns are NUMERIC(18,2). commissionPerSale
-- is snapshotted at generation time. idempotencyKey ("ugcVideoId:generationPeriod")
-- is UNIQUE — the final duplicate guard behind the engine's advisory lock.
CREATE TABLE "ugc_earnings" (
    "id"                TEXT          NOT NULL DEFAULT gen_random_uuid()::text,
    "affiliateId"       TEXT          NOT NULL,
    "ugcVideoId"        TEXT          NOT NULL,
    "productId"         TEXT          NOT NULL,
    "generatedSales"    INTEGER       NOT NULL,
    "commissionPerSale" DECIMAL(18,2) NOT NULL,
    "amount"            DECIMAL(18,2) NOT NULL,
    "generationDate"    TIMESTAMP(3)  NOT NULL,
    "generationPeriod"  TEXT          NOT NULL,
    "idempotencyKey"    TEXT          NOT NULL,
    "status"            TEXT          NOT NULL DEFAULT 'available',
    "createdAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ugc_earnings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ugc_earnings_idempotencyKey_key" ON "ugc_earnings"("idempotencyKey");
CREATE INDEX "ugc_earnings_affiliateId_idx"      ON "ugc_earnings"("affiliateId");
CREATE INDEX "ugc_earnings_ugcVideoId_idx"       ON "ugc_earnings"("ugcVideoId");
CREATE INDEX "ugc_earnings_generationPeriod_idx" ON "ugc_earnings"("generationPeriod");
CREATE INDEX "ugc_earnings_generationDate_idx"   ON "ugc_earnings"("generationDate");
CREATE INDEX "ugc_earnings_createdAt_idx"        ON "ugc_earnings"("createdAt");

-- ── Foreign keys (on the NEW tables only; all ON DELETE RESTRICT) ─────────────
ALTER TABLE "ugc_video_submissions"
    ADD CONSTRAINT "ugc_video_submissions_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ugc_video_submissions"
    ADD CONSTRAINT "ugc_video_submissions_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ugc_video_history"
    ADD CONSTRAINT "ugc_video_history_ugcVideoId_fkey"
    FOREIGN KEY ("ugcVideoId") REFERENCES "ugc_video_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ugc_earnings"
    ADD CONSTRAINT "ugc_earnings_ugcVideoId_fkey"
    FOREIGN KEY ("ugcVideoId") REFERENCES "ugc_video_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
