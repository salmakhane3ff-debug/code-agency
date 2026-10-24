-- Demo chat journeys (Phase 3C-1) — ADDITIVE migration.
-- Ten new tables only. No existing table, column, constraint or row is altered
-- or removed. The only links to existing tables are foreign keys FROM the new
-- tables TO "demo_affiliates"(id) and "affiliates"(id); nothing references the
-- new tables from existing ones. No data is inserted: no journey, message,
-- assignment or asset is created, and every assignment defaults to
-- enabled = false. The chat stays off behind DEMO_CHAT_ENABLED plus the
-- protected database setting regardless of this migration.
--
-- Column definitions, indexes and foreign keys mirror `prisma migrate diff`
-- output for the schema. The CHECK constraints and the append-only audit
-- trigger at the end cannot be expressed in Prisma's DSL. Every statement is
-- idempotent (safe to re-run).
--
-- Time conventions:
--   * demo_chat_journey_steps.time   "HH:MM" wall-clock in Africa/Casablanca.
--   * demo_chat_assignments.anchorDate  Casablanca calendar date of day 1.
--   * demo_chat_messages.scheduledAt   absolute instant (TIMESTAMP(3), UTC).
--   * demo_sim_day_coverage.day      UTC bucket day — the same convention as
--     demo_earnings_history.date (rows stored at 00:00 UTC). Not Casablanca.
--
-- Rollback (manual, only before any row is written; NOT run by this file):
--   DROP TABLE "demo_chat_messages", "demo_chat_viewer_states",
--     "demo_chat_assignments", "demo_chat_version_assets",
--     "demo_chat_journey_steps", "demo_chat_journey_versions",
--     "demo_chat_assets", "demo_chat_journeys", "demo_chat_audit_log",
--     "demo_sim_day_coverage";
--   DROP FUNCTION "demo_chat_reject_mutation"();
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261023_demo_chat_journeys';

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "demo_chat_journeys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_chat_journeys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_chat_journey_steps" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "time" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "assetId" TEXT,
    "earningsPeriod" TEXT,
    "metric" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_chat_journey_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_chat_journey_versions" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "stepsHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT,

    CONSTRAINT "demo_chat_journey_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_chat_assets" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "formatDetected" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_chat_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_chat_version_assets" (
    "versionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,

    CONSTRAINT "demo_chat_version_assets_pkey" PRIMARY KEY ("versionId","assetId")
);

CREATE TABLE IF NOT EXISTS "demo_chat_assignments" (
    "id" TEXT NOT NULL,
    "demoAffiliateId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "anchorDate" DATE NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_chat_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_chat_messages" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "demoAffiliateId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "loopIndex" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "stepId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "assetId" TEXT,
    "earningsPeriod" TEXT,
    "metric" TEXT,
    "earningsSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_chat_viewer_states" (
    "id" TEXT NOT NULL,
    "demoAffiliateId" TEXT NOT NULL,
    "viewerAffiliateId" TEXT NOT NULL,
    "firstOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_chat_viewer_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_chat_audit_log" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'ADMIN',
    "actorId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_chat_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "demo_sim_day_coverage" (
    "day" DATE NOT NULL,
    "firstTickAt" TIMESTAMP(3) NOT NULL,
    "lastTickAt" TIMESTAMP(3) NOT NULL,
    "tickCount" INTEGER NOT NULL DEFAULT 0,
    "maxGapSec" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_sim_day_coverage_pkey" PRIMARY KEY ("day")
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "demo_chat_journeys_status_idx" ON "demo_chat_journeys"("status");
CREATE INDEX IF NOT EXISTS "demo_chat_journey_steps_assetId_idx" ON "demo_chat_journey_steps"("assetId");
CREATE UNIQUE INDEX IF NOT EXISTS "demo_chat_journey_steps_journeyId_day_time_position_key" ON "demo_chat_journey_steps"("journeyId", "day", "time", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "demo_chat_journey_versions_journeyId_version_key" ON "demo_chat_journey_versions"("journeyId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "demo_chat_assets_sha256_key" ON "demo_chat_assets"("sha256");
CREATE INDEX IF NOT EXISTS "demo_chat_assets_kind_idx" ON "demo_chat_assets"("kind");
CREATE INDEX IF NOT EXISTS "demo_chat_version_assets_assetId_idx" ON "demo_chat_version_assets"("assetId");
CREATE UNIQUE INDEX IF NOT EXISTS "demo_chat_assignments_demoAffiliateId_key" ON "demo_chat_assignments"("demoAffiliateId");
CREATE INDEX IF NOT EXISTS "demo_chat_assignments_versionId_idx" ON "demo_chat_assignments"("versionId");
CREATE INDEX IF NOT EXISTS "demo_chat_assignments_enabled_idx" ON "demo_chat_assignments"("enabled");
CREATE INDEX IF NOT EXISTS "demo_chat_messages_demoAffiliateId_revision_scheduledAt_idx" ON "demo_chat_messages"("demoAffiliateId", "revision", "scheduledAt");
CREATE INDEX IF NOT EXISTS "demo_chat_messages_versionId_idx" ON "demo_chat_messages"("versionId");
CREATE INDEX IF NOT EXISTS "demo_chat_messages_assetId_idx" ON "demo_chat_messages"("assetId");
CREATE UNIQUE INDEX IF NOT EXISTS "demo_chat_messages_assignmentId_revision_loopIndex_stepId_key" ON "demo_chat_messages"("assignmentId", "revision", "loopIndex", "stepId");
CREATE INDEX IF NOT EXISTS "demo_chat_viewer_states_viewerAffiliateId_idx" ON "demo_chat_viewer_states"("viewerAffiliateId");
CREATE UNIQUE INDEX IF NOT EXISTS "demo_chat_viewer_states_demoAffiliateId_viewerAffiliateId_key" ON "demo_chat_viewer_states"("demoAffiliateId", "viewerAffiliateId");
CREATE INDEX IF NOT EXISTS "demo_chat_audit_log_entityType_entityId_idx" ON "demo_chat_audit_log"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "demo_chat_audit_log_createdAt_idx" ON "demo_chat_audit_log"("createdAt");

-- ── Foreign keys ─────────────────────────────────────────────────────────────
-- Only two CASCADE edges: journey → its draft steps, and real affiliate →
-- demo-chat viewer state (so deleteAffiliateSafely is never blocked). Every
-- other edge is RESTRICT: published versions, assignments, messages and assets
-- are history and must be removed explicitly, never as a side effect.

DO $$ BEGIN
  ALTER TABLE "demo_chat_journey_steps" ADD CONSTRAINT "demo_chat_journey_steps_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "demo_chat_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_journey_steps" ADD CONSTRAINT "demo_chat_journey_steps_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "demo_chat_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_journey_versions" ADD CONSTRAINT "demo_chat_journey_versions_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "demo_chat_journeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_version_assets" ADD CONSTRAINT "demo_chat_version_assets_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "demo_chat_journey_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_version_assets" ADD CONSTRAINT "demo_chat_version_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "demo_chat_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_assignments" ADD CONSTRAINT "demo_chat_assignments_demoAffiliateId_fkey" FOREIGN KEY ("demoAffiliateId") REFERENCES "demo_affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_assignments" ADD CONSTRAINT "demo_chat_assignments_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "demo_chat_journey_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_messages" ADD CONSTRAINT "demo_chat_messages_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "demo_chat_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_messages" ADD CONSTRAINT "demo_chat_messages_demoAffiliateId_fkey" FOREIGN KEY ("demoAffiliateId") REFERENCES "demo_affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_messages" ADD CONSTRAINT "demo_chat_messages_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "demo_chat_journey_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_messages" ADD CONSTRAINT "demo_chat_messages_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "demo_chat_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_viewer_states" ADD CONSTRAINT "demo_chat_viewer_states_demoAffiliateId_fkey" FOREIGN KEY ("demoAffiliateId") REFERENCES "demo_affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_viewer_states" ADD CONSTRAINT "demo_chat_viewer_states_viewerAffiliateId_fkey" FOREIGN KEY ("viewerAffiliateId") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CHECK constraints (database-level backstop for the service rules) ────────

DO $$ BEGIN
  ALTER TABLE "demo_chat_journeys" ADD CONSTRAINT "demo_chat_journeys_values_check" CHECK (
    "status" IN ('draft', 'archived')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_journey_steps" ADD CONSTRAINT "demo_chat_journey_steps_values_check" CHECK (
    "day" BETWEEN 1 AND 30
    AND "time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "position" >= 0
    AND "type" IN ('text', 'image', 'audio', 'earnings')
    AND ("metric" IS NULL OR "metric" IN ('commission', 'orders', 'revenue'))
    AND ("earningsPeriod" IS NULL OR "earningsPeriod" IN ('today', 'yesterday', 'week'))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Shape per type: earnings ⇔ period + metric; media ⇔ asset; text/earnings
-- carry non-empty text; a "today" summary is never scheduled before 12:00.
DO $$ BEGIN
  ALTER TABLE "demo_chat_journey_steps" ADD CONSTRAINT "demo_chat_journey_steps_shape_check" CHECK (
    (("type" = 'earnings') = ("earningsPeriod" IS NOT NULL AND "metric" IS NOT NULL))
    AND ("type" = 'earnings' OR ("earningsPeriod" IS NULL AND "metric" IS NULL))
    AND (("type" IN ('image', 'audio')) = ("assetId" IS NOT NULL))
    AND ("type" NOT IN ('text', 'earnings') OR length(btrim(coalesce("text", ''))) > 0)
    AND ("earningsPeriod" IS DISTINCT FROM 'today' OR "time" >= '12:00')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_journey_versions" ADD CONSTRAINT "demo_chat_journey_versions_values_check" CHECK (
    "version" >= 1
    AND jsonb_typeof("steps") = 'array'
    AND length("stepsHash") > 0
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Audio ≤ 180 s and ≤ 5 MiB (5 242 880 bytes); images carry dimensions.
DO $$ BEGIN
  ALTER TABLE "demo_chat_assets" ADD CONSTRAINT "demo_chat_assets_values_check" CHECK (
    "kind" IN ('image', 'audio')
    AND "bytes" > 0
    AND ("kind" <> 'audio' OR ("durationSec" IS NOT NULL AND "durationSec" > 0 AND "durationSec" <= 180 AND "bytes" <= 5242880))
    AND ("kind" <> 'image' OR ("width" IS NOT NULL AND "width" > 0 AND "height" IS NOT NULL AND "height" > 0))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_assignments" ADD CONSTRAINT "demo_chat_assignments_values_check" CHECK (
    "revision" >= 1
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_messages" ADD CONSTRAINT "demo_chat_messages_values_check" CHECK (
    "revision" >= 1
    AND "loopIndex" >= 0
    AND "day" BETWEEN 1 AND 30
    AND "position" >= 0
    AND "type" IN ('text', 'image', 'audio', 'earnings')
    AND ("metric" IS NULL OR "metric" IN ('commission', 'orders', 'revenue'))
    AND ("earningsPeriod" IS NULL OR "earningsPeriod" IN ('today', 'yesterday', 'week'))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_chat_audit_log" ADD CONSTRAINT "demo_chat_audit_log_values_check" CHECK (
    "actorType" IN ('ADMIN', 'SYSTEM')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demo_sim_day_coverage" ADD CONSTRAINT "demo_sim_day_coverage_values_check" CHECK (
    "tickCount" >= 0
    AND "maxGapSec" >= 0
    AND "lastTickAt" >= "firstTickAt"
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Append-only audit log ────────────────────────────────────────────────────
-- Rows can be inserted, never updated or deleted. Any future retention purge
-- needs its own approved migration/procedure (e.g. temporarily dropping this
-- trigger inside one transaction). EXECUTE PROCEDURE (not FUNCTION) keeps this
-- valid on every supported PostgreSQL version, as in the rewards migration.

CREATE OR REPLACE FUNCTION "demo_chat_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "demo_chat_audit_log_append_only" ON "demo_chat_audit_log";
CREATE TRIGGER "demo_chat_audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "demo_chat_audit_log"
  FOR EACH ROW EXECUTE PROCEDURE "demo_chat_reject_mutation"();
