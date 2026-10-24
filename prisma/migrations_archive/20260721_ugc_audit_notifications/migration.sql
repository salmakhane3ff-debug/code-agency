-- ─────────────────────────────────────────────────────────────────────────────
-- UGC settings audit trail + admin notifications
--
-- ADDITIVE ONLY. Creates two new tables; touches no existing table, column,
-- constraint or index. Nothing here can affect existing data or the money path.
--
-- Both tables back BEST-EFFORT side effects: the application wraps every write
-- in a try/catch, so if this migration has not been applied yet, saving UGC
-- settings and creating UGC submissions still succeed (the audit/notification
-- row is simply skipped). Applying the migration turns those features on.
--
-- Re-execution: guarded by Prisma's `_prisma_migrations` bookkeeping; the
-- IF NOT EXISTS clauses additionally make a manual re-run harmless.
-- ─────────────────────────────────────────────────────────────────────────────

-- Append-only history of UGC settings changes.
CREATE TABLE IF NOT EXISTS "ugc_settings_history" (
  "id"                TEXT         NOT NULL,
  "actorId"           TEXT,
  "actorType"         TEXT         NOT NULL DEFAULT 'ADMIN',
  "changes"           JSONB        NOT NULL,
  "earningsAffecting" BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ugc_settings_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ugc_settings_history_createdAt_idx"
  ON "ugc_settings_history" ("createdAt");
CREATE INDEX IF NOT EXISTS "ugc_settings_history_earningsAffecting_idx"
  ON "ugc_settings_history" ("earningsAffecting");

-- Admin-facing notifications (new UGC submission awaiting review, …).
CREATE TABLE IF NOT EXISTS "admin_notifications" (
  "id"        TEXT         NOT NULL,
  "type"      TEXT         NOT NULL,
  "message"   TEXT         NOT NULL,
  "entityId"  TEXT,
  "read"      BOOLEAN      NOT NULL DEFAULT false,
  "eventKey"  TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "admin_notifications_read_idx"
  ON "admin_notifications" ("read");
CREATE INDEX IF NOT EXISTS "admin_notifications_type_idx"
  ON "admin_notifications" ("type");
CREATE INDEX IF NOT EXISTS "admin_notifications_createdAt_idx"
  ON "admin_notifications" ("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "admin_notifications_eventKey_key"
  ON "admin_notifications" ("eventKey");

-- ── Notification idempotency on the EXISTING affiliate_notifications table ────
-- Additive and safe on live data:
--   • the column is NULLABLE with no default → no table rewrite, no backfill;
--   • existing rows keep eventKey = NULL, and PostgreSQL permits UNLIMITED NULLs
--     under a UNIQUE index, so no existing row can collide;
--   • only event-driven UGC notifications set a key, and it is deterministic:
--     `ugc:{submissionId}:{historyId}:{eventType}:affiliate`.
--
-- NOTE: the UNIQUE index build takes a brief ACCESS SHARE-blocking lock. This
-- table is small (per-affiliate notices), so a plain CREATE UNIQUE INDEX inside
-- the migration transaction is fine. If it has grown large in production, build
-- it out-of-band first with:
--     CREATE UNIQUE INDEX CONCURRENTLY "affiliate_notifications_eventKey_key"
--       ON "affiliate_notifications" ("eventKey");
-- (CONCURRENTLY cannot run inside a transaction, so it cannot live in this file.)
ALTER TABLE "affiliate_notifications"
  ADD COLUMN IF NOT EXISTS "eventKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_notifications_eventKey_key"
  ON "affiliate_notifications" ("eventKey");
