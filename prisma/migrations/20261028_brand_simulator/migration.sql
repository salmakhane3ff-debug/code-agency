-- "Create Your Own Brand" — paid TRAINING & SIMULATION experience — ADDITIVE migration.
-- Three new tables only. No existing table, column or constraint is altered or
-- removed: orders, affiliate orders, commissions, payouts, deposits, boosters,
-- Rewards and the Fake Orders Engine are untouched, and none of these tables is
-- a wallet balance provider. Simulated activity lives only in brand_sim_hours.
--
-- Column definitions mirror `prisma migrate diff` output for the schema; the
-- partial unique index, CHECK constraints and the append-only trigger at the end
-- cannot be expressed in Prisma's DSL. Every statement is idempotent (safe to re-run).

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "brand_accesses" (
  "id"                 TEXT NOT NULL,
  "affiliateId"        TEXT NOT NULL,
  "brandName"          TEXT NOT NULL,
  "packageId"          TEXT NOT NULL,
  "packageSnapshot"    JSONB NOT NULL,
  "brandingOptionId"   TEXT,
  "brandingSnapshot"   JSONB,
  "amount"             DECIMAL(12,2) NOT NULL,
  "termsVersion"       INTEGER NOT NULL,
  "termsSnapshot"      JSONB NOT NULL,
  "selectedProducts"   JSONB NOT NULL DEFAULT '[]',
  "clientRequestId"    TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  "paymentReference"   TEXT,
  "activatedAt"        TIMESTAMP(3),
  "activatedBy"        TEXT,
  "simulationStartsAt" TIMESTAMP(3),
  "closedAt"           TIMESTAMP(3),
  "closedBy"           TEXT,
  "closeReason"        TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brand_accesses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "brand_sim_hours" (
  "accessId"   TEXT NOT NULL,
  "hourStart"  TIMESTAMP(3) NOT NULL,
  "created"    INTEGER NOT NULL,
  "delivered"  INTEGER NOT NULL,
  "refused"    INTEGER NOT NULL,
  "returned"   INTEGER NOT NULL,
  "noResponse" INTEGER NOT NULL,
  "cancelled"  INTEGER NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_sim_hours_pkey" PRIMARY KEY ("accessId", "hourStart")
);

CREATE TABLE IF NOT EXISTS "brand_audit_log" (
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
  CONSTRAINT "brand_audit_log_pkey" PRIMARY KEY ("id")
);

-- Selected catalogue products (snapshot: id, name, first image). Also added by
-- ALTER for databases that ran an earlier draft of this (never released) migration.
ALTER TABLE "brand_accesses" ADD COLUMN IF NOT EXISTS "selectedProducts" JSONB NOT NULL DEFAULT '[]';

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX        IF NOT EXISTS "brand_accesses_affiliateId_idx"                 ON "brand_accesses" ("affiliateId");
CREATE INDEX        IF NOT EXISTS "brand_accesses_status_idx"                      ON "brand_accesses" ("status");
CREATE INDEX        IF NOT EXISTS "brand_accesses_createdAt_idx"                   ON "brand_accesses" ("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_accesses_affiliateId_clientRequestId_key" ON "brand_accesses" ("affiliateId", "clientRequestId");
CREATE INDEX        IF NOT EXISTS "brand_audit_log_entityType_entityId_idx"        ON "brand_audit_log" ("entityType", "entityId");
CREATE INDEX        IF NOT EXISTS "brand_audit_log_createdAt_idx"                  ON "brand_audit_log" ("createdAt");

-- One open access (awaiting payment or active) per affiliate — makes the rule
-- concurrency-safe at the DB level (two simultaneous requests cannot both insert).
CREATE UNIQUE INDEX IF NOT EXISTS "brand_accesses_one_open_per_affiliate"
  ON "brand_accesses" ("affiliateId") WHERE "status" IN ('PENDING_PAYMENT', 'ACTIVE');

-- ── Foreign keys ─────────────────────────────────────────────────────────────
-- RESTRICT on affiliates: an affiliate with an access record cannot be hard-deleted
-- (deleteAffiliateSafely reports it as history → deactivate instead).
-- CASCADE on brand_sim_hours: simulated data never outlives its access.

DO $$ BEGIN
  ALTER TABLE "brand_accesses" ADD CONSTRAINT "brand_accesses_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_sim_hours" ADD CONSTRAINT "brand_sim_hours_accessId_fkey"
    FOREIGN KEY ("accessId") REFERENCES "brand_accesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CHECK constraints ────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "brand_accesses" ADD CONSTRAINT "brand_accesses_values_check" CHECK (
    "status" IN ('PENDING_PAYMENT', 'ACTIVE', 'REJECTED', 'CANCELLED')
    AND "amount" > 0
    AND "termsVersion" >= 1
    AND char_length("brandName") BETWEEN 2 AND 40
    AND ("status" <> 'ACTIVE' OR ("activatedAt" IS NOT NULL AND "simulationStartsAt" IS NOT NULL AND "paymentReference" IS NOT NULL))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3–4 selected products on every new or changed request. NOT VALID: rows written
-- by an earlier draft (test databases only) are not re-checked when it is added.
DO $$ BEGIN
  ALTER TABLE "brand_accesses" ADD CONSTRAINT "brand_accesses_products_check" CHECK (
    jsonb_typeof("selectedProducts") = 'array' AND jsonb_array_length("selectedProducts") BETWEEN 3 AND 4
  ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The amount to pay is the server-computed total of the package breakdown
-- snapshotted with the request (price + delivery + logistics + VAT).
-- NOT VALID: rows written by an earlier draft (test databases only) are not re-checked.
DO $$ BEGIN
  ALTER TABLE "brand_accesses" ADD CONSTRAINT "brand_accesses_amount_matches_snapshot" CHECK (
    ("packageSnapshot" -> 'breakdown' ->> 'total') IS NOT NULL
    AND "amount" = ("packageSnapshot" -> 'breakdown' ->> 'total')::numeric
  ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_sim_hours" ADD CONSTRAINT "brand_sim_hours_values_check" CHECK (
    "delivered" >= 0 AND "refused" >= 0 AND "returned" >= 0 AND "noResponse" >= 0 AND "cancelled" >= 0
    AND "created" = "delivered" + "refused" + "returned" + "noResponse" + "cancelled"
    AND "hourStart" = date_trunc('hour', "hourStart")
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_audit_log" ADD CONSTRAINT "brand_audit_log_values_check" CHECK (
    "actorType" IN ('SYSTEM', 'ADMIN', 'AFFILIATE')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Append-only guard ────────────────────────────────────────────────────────
-- The audit log is an audit record: any UPDATE or DELETE is rejected.
-- EXECUTE PROCEDURE (not FUNCTION) keeps this valid on every supported Postgres
-- version; TRUNCATE is not affected (dev resets keep working).

CREATE OR REPLACE FUNCTION "brand_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "brand_audit_log_append_only" ON "brand_audit_log";
CREATE TRIGGER "brand_audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "brand_audit_log"
  FOR EACH ROW EXECUTE PROCEDURE "brand_reject_mutation"();

-- ── Immutable request snapshot ───────────────────────────────────────────────
-- What the participant asked for and accepted (package + pricing snapshot,
-- amount, branding, terms, products, brand name, request key) can never change
-- after the request is created; only the lifecycle columns (status, payment
-- reference, activation / closing data) move. A request is a purchase record:
-- it is never deleted either (TRUNCATE is not affected — dev resets keep working).

CREATE OR REPLACE FUNCTION "brand_access_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'brand_accesses rows cannot be deleted (DELETE rejected)';
  END IF;
  IF NEW."affiliateId" IS DISTINCT FROM OLD."affiliateId"
     OR NEW."brandName" IS DISTINCT FROM OLD."brandName"
     OR NEW."packageId" IS DISTINCT FROM OLD."packageId"
     OR NEW."packageSnapshot" IS DISTINCT FROM OLD."packageSnapshot"
     OR NEW."brandingOptionId" IS DISTINCT FROM OLD."brandingOptionId"
     OR NEW."brandingSnapshot" IS DISTINCT FROM OLD."brandingSnapshot"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."termsVersion" IS DISTINCT FROM OLD."termsVersion"
     OR NEW."termsSnapshot" IS DISTINCT FROM OLD."termsSnapshot"
     OR NEW."selectedProducts" IS DISTINCT FROM OLD."selectedProducts"
     OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'brand_accesses request snapshot is immutable (UPDATE of snapshot columns rejected)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "brand_accesses_guard" ON "brand_accesses";
CREATE TRIGGER "brand_accesses_guard"
  BEFORE UPDATE OR DELETE ON "brand_accesses"
  FOR EACH ROW EXECUTE PROCEDURE "brand_access_guard"();
