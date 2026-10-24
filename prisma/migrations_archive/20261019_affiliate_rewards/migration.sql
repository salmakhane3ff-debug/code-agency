-- Rewards & Gifts (affiliate points program) — ADDITIVE migration.
-- Seven new tables only. No existing table, column or constraint is altered or
-- removed: the commission balance, payouts, boosters and deposits are untouched
-- (points are a separate currency and are never a balance provider).
--
-- Column definitions mirror `prisma migrate diff` output for the schema; the
-- CHECK constraints and the append-only trigger at the end cannot be expressed
-- in Prisma's DSL. Every statement is idempotent (safe to re-run).

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "reward_gifts" (
  "id"                 TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "description"        TEXT NOT NULL DEFAULT '',
  "images"             JSONB NOT NULL DEFAULT '[]',
  "pointsCost"         INTEGER NOT NULL,
  "stock"              INTEGER NOT NULL DEFAULT 0,
  "lowStockThreshold"  INTEGER,
  "maxPerAffiliate"    INTEGER,
  "minDeliveredOrders" INTEGER,
  "isActive"           BOOLEAN NOT NULL DEFAULT false,
  "archivedAt"         TIMESTAMP(3),
  "sortOrder"          INTEGER NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reward_gifts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reward_points_accounts" (
  "affiliateId" TEXT NOT NULL,
  "balance"     INTEGER NOT NULL DEFAULT 0,
  "version"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reward_points_accounts_pkey" PRIMARY KEY ("affiliateId")
);

CREATE TABLE IF NOT EXISTS "reward_points_ledger" (
  "id"             TEXT NOT NULL,
  "affiliateId"    TEXT NOT NULL,
  "delta"          INTEGER NOT NULL,
  "type"           TEXT NOT NULL,
  "sourceType"     TEXT NOT NULL,
  "sourceId"       TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "reason"         TEXT,
  "actorType"      TEXT NOT NULL DEFAULT 'SYSTEM',
  "actorId"        TEXT,
  "balanceAfter"   INTEGER NOT NULL,
  "metadata"       JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reward_points_ledger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reward_order_awards" (
  "id"               TEXT NOT NULL,
  "affiliateOrderId" TEXT NOT NULL,
  "orderId"          TEXT,
  "affiliateId"      TEXT NOT NULL,
  "points"           INTEGER NOT NULL DEFAULT 0,
  "state"            TEXT NOT NULL,
  "exclusionReason"  TEXT,
  "version"          INTEGER NOT NULL DEFAULT 1,
  "availableAt"      TIMESTAMP(3),
  "awardedAt"        TIMESTAMP(3),
  "reversedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reward_order_awards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reward_redemptions" (
  "id"               TEXT NOT NULL,
  "reference"        TEXT NOT NULL,
  "affiliateId"      TEXT NOT NULL,
  "giftId"           TEXT NOT NULL,
  "giftSnapshot"     JSONB NOT NULL,
  "pointsCost"       INTEGER NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  "fullName"         TEXT NOT NULL,
  "phone"            TEXT NOT NULL,
  "city"             TEXT NOT NULL,
  "address"          TEXT NOT NULL,
  "deliveryNotes"    TEXT,
  "carrierId"        TEXT,
  "carrierName"      TEXT,
  "trackingNumber"   TEXT,
  "trackingUrl"      TEXT,
  "internalNotes"    TEXT,
  "rejectionReason"  TEXT,
  "cancelReason"     TEXT,
  "clientRequestId"  TEXT NOT NULL,
  "pointsRefundedAt" TIMESTAMP(3),
  "restockedAt"      TIMESTAMP(3),
  "approvedAt"       TIMESTAMP(3),
  "preparingAt"      TIMESTAMP(3),
  "shippedAt"        TIMESTAMP(3),
  "deliveredAt"      TIMESTAMP(3),
  "closedAt"         TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reward_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reward_redemption_history" (
  "id"           TEXT NOT NULL,
  "redemptionId" TEXT NOT NULL,
  "fromStatus"   TEXT,
  "toStatus"     TEXT NOT NULL,
  "actorType"    TEXT NOT NULL,
  "actorId"      TEXT,
  "note"         TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reward_redemption_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reward_audit_log" (
  "id"         TEXT NOT NULL,
  "action"     TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId"   TEXT,
  "actorType"  TEXT NOT NULL DEFAULT 'ADMIN',
  "actorId"    TEXT,
  "before"     JSONB,
  "after"      JSONB,
  "reason"     TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reward_audit_log_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "reward_gifts_isActive_idx"  ON "reward_gifts" ("isActive");
CREATE INDEX IF NOT EXISTS "reward_gifts_sortOrder_idx" ON "reward_gifts" ("sortOrder");

-- Idempotency anchor: every ledger write carries a deterministic key, so a
-- retried/duplicated operation can never insert a second row.
CREATE UNIQUE INDEX IF NOT EXISTS "reward_points_ledger_idempotencyKey_key"         ON "reward_points_ledger" ("idempotencyKey");
CREATE INDEX        IF NOT EXISTS "reward_points_ledger_affiliateId_createdAt_idx"  ON "reward_points_ledger" ("affiliateId", "createdAt");
CREATE INDEX        IF NOT EXISTS "reward_points_ledger_type_idx"                   ON "reward_points_ledger" ("type");
CREATE INDEX        IF NOT EXISTS "reward_points_ledger_sourceType_sourceId_idx"    ON "reward_points_ledger" ("sourceType", "sourceId");

-- One award row per affiliate order AND per real store order (several
-- affiliate_orders rows may point at the same orders.id — it pays out once).
-- Postgres allows many NULL orderId values under the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "reward_order_awards_affiliateOrderId_key"  ON "reward_order_awards" ("affiliateOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "reward_order_awards_orderId_key"           ON "reward_order_awards" ("orderId");
CREATE INDEX        IF NOT EXISTS "reward_order_awards_affiliateId_state_idx" ON "reward_order_awards" ("affiliateId", "state");

CREATE UNIQUE INDEX IF NOT EXISTS "reward_redemptions_reference_key"                   ON "reward_redemptions" ("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "reward_redemptions_affiliateId_clientRequestId_key" ON "reward_redemptions" ("affiliateId", "clientRequestId");
CREATE INDEX        IF NOT EXISTS "reward_redemptions_affiliateId_createdAt_idx"       ON "reward_redemptions" ("affiliateId", "createdAt");
CREATE INDEX        IF NOT EXISTS "reward_redemptions_status_idx"                      ON "reward_redemptions" ("status");
CREATE INDEX        IF NOT EXISTS "reward_redemptions_giftId_idx"                      ON "reward_redemptions" ("giftId");

CREATE INDEX IF NOT EXISTS "reward_redemption_history_redemptionId_createdAt_idx" ON "reward_redemption_history" ("redemptionId", "createdAt");

CREATE INDEX IF NOT EXISTS "reward_audit_log_entityType_entityId_idx" ON "reward_audit_log" ("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "reward_audit_log_createdAt_idx"           ON "reward_audit_log" ("createdAt");

-- ── Foreign keys (RESTRICT: points history is never silently deleted) ─────────
-- reward_order_awards.orderId deliberately has NO foreign key: store orders can
-- be hard-deleted by an admin, and that must keep working.

DO $$ BEGIN
  ALTER TABLE "reward_points_accounts" ADD CONSTRAINT "reward_points_accounts_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_points_ledger" ADD CONSTRAINT "reward_points_ledger_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_order_awards" ADD CONSTRAINT "reward_order_awards_affiliateOrderId_fkey"
    FOREIGN KEY ("affiliateOrderId") REFERENCES "affiliate_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_order_awards" ADD CONSTRAINT "reward_order_awards_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_giftId_fkey"
    FOREIGN KEY ("giftId") REFERENCES "reward_gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_redemption_history" ADD CONSTRAINT "reward_redemption_history_redemptionId_fkey"
    FOREIGN KEY ("redemptionId") REFERENCES "reward_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CHECK constraints (database-level backstop for the service rules) ────────

DO $$ BEGIN
  ALTER TABLE "reward_gifts" ADD CONSTRAINT "reward_gifts_values_check" CHECK (
    "stock" >= 0
    AND "pointsCost" > 0
    AND ("lowStockThreshold"  IS NULL OR "lowStockThreshold"  >= 0)
    AND ("maxPerAffiliate"    IS NULL OR "maxPerAffiliate"    >= 1)
    AND ("minDeliveredOrders" IS NULL OR "minDeliveredOrders" >= 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_points_ledger" ADD CONSTRAINT "reward_points_ledger_values_check" CHECK (
    "delta" <> 0
    AND "type" IN ('SIGNUP_BONUS', 'ORDER_DELIVERED', 'ORDER_REVERSAL',
                   'REDEMPTION_DEBIT', 'REDEMPTION_REFUND', 'ADMIN_ADJUSTMENT')
    AND "actorType" IN ('SYSTEM', 'ADMIN', 'AFFILIATE')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_order_awards" ADD CONSTRAINT "reward_order_awards_values_check" CHECK (
    "points" >= 0
    AND "version" >= 1
    AND "state" IN ('AWARDED', 'REVERSED', 'EXCLUDED')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_values_check" CHECK (
    "pointsCost" > 0
    AND "status" IN ('PENDING_REVIEW', 'APPROVED', 'PREPARING', 'SHIPPED', 'IN_TRANSIT',
                     'DELIVERED', 'REJECTED', 'CANCELLED', 'RETURNED')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reward_redemption_history" ADD CONSTRAINT "reward_redemption_history_values_check" CHECK (
    "toStatus" IN ('PENDING_REVIEW', 'APPROVED', 'PREPARING', 'SHIPPED', 'IN_TRANSIT',
                   'DELIVERED', 'REJECTED', 'CANCELLED', 'RETURNED')
    AND "actorType" IN ('SYSTEM', 'ADMIN', 'AFFILIATE')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Append-only guard ────────────────────────────────────────────────────────
-- The points ledger and redemption history are audit records: any UPDATE or
-- DELETE is rejected. Corrections are made by appending a new ledger row
-- (e.g. ADMIN_ADJUSTMENT), never by editing history.
-- EXECUTE PROCEDURE (not FUNCTION) keeps this valid on every supported
-- Postgres version; TRUNCATE is not affected (dev resets keep working).

CREATE OR REPLACE FUNCTION "reward_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "reward_points_ledger_append_only" ON "reward_points_ledger";
CREATE TRIGGER "reward_points_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "reward_points_ledger"
  FOR EACH ROW EXECUTE PROCEDURE "reward_reject_mutation"();

DROP TRIGGER IF EXISTS "reward_redemption_history_append_only" ON "reward_redemption_history";
CREATE TRIGGER "reward_redemption_history_append_only"
  BEFORE UPDATE OR DELETE ON "reward_redemption_history"
  FOR EACH ROW EXECUTE PROCEDURE "reward_reject_mutation"();
