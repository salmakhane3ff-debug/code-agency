-- "Create Your Own Brand" — lifecycle, payment proofs, authorizations and
-- PERMANENT deterministic simulation history. ADDITIVE, FORWARD-ONLY, re-runnable.
--
-- Nothing outside the brand_* tables is altered. Payment proofs are NOT
-- affiliate_security_deposits rows and are not a wallet balance provider.
--
-- Column/table/index definitions mirror `prisma migrate diff` output for the
-- schema. Partial unique indexes, CHECK constraints, guards and triggers cannot
-- be expressed in Prisma's DSL and are created here.
--
-- Before applying to an EXISTING database: the CHECK constraints below are
-- validated against existing rows (the statement fails, changing nothing, if a
-- row violates them); existing brand_sim_hours rows are never modified.

-- ── Columns on brand_accesses ────────────────────────────────────────────────

ALTER TABLE "brand_accesses" ADD COLUMN IF NOT EXISTS "authorizationId"  TEXT;
ALTER TABLE "brand_accesses" ADD COLUMN IF NOT EXISTS "generatedThrough" TIMESTAMP(3);
ALTER TABLE "brand_accesses" ADD COLUMN IF NOT EXISTS "lastReopenedAt"   TIMESTAMP(3);

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "brand_sim_settings_versions" (
  "id"            TEXT NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "enabled"       BOOLEAN NOT NULL,
  "proven"        BOOLEAN NOT NULL,
  "settings"      JSONB NOT NULL,
  "source"        TEXT NOT NULL,
  "auditId"       TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_sim_settings_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "brand_access_periods" (
  "id"           TEXT NOT NULL,
  "accessId"     TEXT NOT NULL,
  "startedAt"    TIMESTAMP(3) NOT NULL,
  "endedAt"      TIMESTAMP(3),
  "startReason"  TEXT NOT NULL,
  "startAuditId" TEXT,
  "endAuditId"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_access_periods_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "brand_payment_proofs" (
  "id"                          TEXT NOT NULL,
  "accessId"                    TEXT NOT NULL,
  "fileKey"                     TEXT NOT NULL,
  "fingerprint"                 TEXT NOT NULL,
  "paymentMethod"               TEXT NOT NULL,
  "transferReference"           TEXT,
  "transferReferenceNormalized" TEXT,
  "status"                      TEXT NOT NULL DEFAULT 'SUBMITTED',
  "reviewedBy"                  TEXT,
  "reviewedAt"                  TIMESTAMP(3),
  "rejectionReason"             TEXT,
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brand_payment_proofs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "brand_request_authorizations" (
  "id"                 TEXT NOT NULL,
  "affiliateId"        TEXT NOT NULL,
  "grantedBy"          TEXT NOT NULL,
  "reason"             TEXT NOT NULL,
  "grantAuditId"       TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"          TIMESTAMP(3),
  "revokedBy"          TEXT,
  "revokeReason"       TEXT,
  "revokeAuditId"      TEXT,
  "consumedAt"         TIMESTAMP(3),
  "consumedByAccessId" TEXT,
  CONSTRAINT "brand_request_authorizations_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "brand_sim_settings_versions_auditId_key"              ON "brand_sim_settings_versions" ("auditId");
CREATE INDEX        IF NOT EXISTS "brand_sim_settings_versions_effectiveFrom_idx"        ON "brand_sim_settings_versions" ("effectiveFrom");
CREATE INDEX        IF NOT EXISTS "brand_access_periods_accessId_startedAt_idx"          ON "brand_access_periods" ("accessId", "startedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_payment_proofs_accessId_key"                    ON "brand_payment_proofs" ("accessId");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_payment_proofs_fingerprint_key"                 ON "brand_payment_proofs" ("fingerprint");
CREATE INDEX        IF NOT EXISTS "brand_payment_proofs_status_idx"                      ON "brand_payment_proofs" ("status");
CREATE INDEX        IF NOT EXISTS "brand_payment_proofs_transferReferenceNormalized_idx" ON "brand_payment_proofs" ("transferReferenceNormalized");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_request_authorizations_consumedByAccessId_key"  ON "brand_request_authorizations" ("consumedByAccessId");
CREATE INDEX        IF NOT EXISTS "brand_request_authorizations_affiliateId_idx"         ON "brand_request_authorizations" ("affiliateId");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_accesses_authorizationId_key"                   ON "brand_accesses" ("authorizationId");

-- One open (unfinished) period per access, one UNUSED authorization per affiliate.
CREATE UNIQUE INDEX IF NOT EXISTS "brand_access_periods_one_open"
  ON "brand_access_periods" ("accessId") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "brand_request_authorizations_one_unused"
  ON "brand_request_authorizations" ("affiliateId") WHERE "revokedAt" IS NULL AND "consumedAt" IS NULL;

-- ── Foreign keys (all RESTRICT: nothing here is ever deleted) ────────────────

DO $$ BEGIN
  ALTER TABLE "brand_accesses" ADD CONSTRAINT "brand_accesses_authorizationId_fkey"
    FOREIGN KEY ("authorizationId") REFERENCES "brand_request_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "brand_access_periods" ADD CONSTRAINT "brand_access_periods_accessId_fkey"
    FOREIGN KEY ("accessId") REFERENCES "brand_accesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "brand_payment_proofs" ADD CONSTRAINT "brand_payment_proofs_accessId_fkey"
    FOREIGN KEY ("accessId") REFERENCES "brand_accesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "brand_request_authorizations" ADD CONSTRAINT "brand_request_authorizations_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CHECK constraints ────────────────────────────────────────────────────────

-- Status set now includes CLOSED (same conditions otherwise). Replaced atomically.
ALTER TABLE "brand_accesses"
  DROP CONSTRAINT IF EXISTS "brand_accesses_values_check",
  ADD CONSTRAINT "brand_accesses_values_check" CHECK (
    "status" IN ('PENDING_PAYMENT', 'ACTIVE', 'REJECTED', 'CANCELLED', 'CLOSED')
    AND "amount" > 0
    AND "termsVersion" >= 1
    AND char_length("brandName") BETWEEN 2 AND 40
    AND ("status" <> 'ACTIVE' OR ("activatedAt" IS NOT NULL AND "simulationStartsAt" IS NOT NULL AND "paymentReference" IS NOT NULL))
  );

-- CLOSED carries its closure (when, which admin, why); ACTIVE carries none.
DO $$ BEGIN
  ALTER TABLE "brand_accesses" ADD CONSTRAINT "brand_accesses_closure_check" CHECK (
    ("status" <> 'CLOSED' OR ("closedAt" IS NOT NULL AND "closedBy" IS NOT NULL AND "closeReason" IS NOT NULL AND btrim("closeReason") <> ''))
    AND ("status" <> 'ACTIVE' OR ("closedAt" IS NULL AND "closedBy" IS NULL AND "closeReason" IS NULL))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_access_periods" ADD CONSTRAINT "brand_access_periods_values_check" CHECK (
    "startReason" IN ('ACTIVATION', 'REOPEN') AND ("endedAt" IS NULL OR "endedAt" >= "startedAt")
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_payment_proofs" ADD CONSTRAINT "brand_payment_proofs_values_check" CHECK (
    "status" IN ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN')
    AND "fingerprint" ~ '^[0-9a-f]{64}$'
    AND btrim("paymentMethod") <> ''
    AND ("status" <> 'SUBMITTED' OR ("reviewedBy" IS NULL AND "reviewedAt" IS NULL AND "rejectionReason" IS NULL))
    AND ("status" <> 'ACCEPTED' OR ("reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL))
    AND ("status" <> 'REJECTED' OR ("reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "rejectionReason" IS NOT NULL AND btrim("rejectionReason") <> ''))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_request_authorizations" ADD CONSTRAINT "brand_request_authorizations_values_check" CHECK (
    btrim("reason") <> '' AND btrim("grantedBy") <> ''
    AND NOT ("revokedAt" IS NOT NULL AND "consumedAt" IS NOT NULL)
    AND ("revokedAt" IS NULL OR ("revokedBy" IS NOT NULL AND "revokeReason" IS NOT NULL AND btrim("revokeReason") <> ''))
    AND (("consumedAt" IS NULL) = ("consumedByAccessId" IS NULL))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_sim_settings_versions" ADD CONSTRAINT "brand_sim_settings_versions_values_check" CHECK (
    "source" IN ('CONFIG_UPDATE', 'RECONSTRUCTED', 'INITIAL_STATE', 'CURRENT_AT_RECONSTRUCTION')
    AND jsonb_typeof("settings") = 'object'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Guards ───────────────────────────────────────────────────────────────────

-- Simulation history is permanent: no UPDATE; DELETE only through the cascade of
-- a deleted access (itself blocked by brand_accesses_guard). TRUNCATE unaffected.
CREATE OR REPLACE FUNCTION "brand_sim_hours_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "brand_accesses" WHERE "id" = OLD."accessId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'brand_sim_hours is permanent history (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "brand_sim_hours_permanent" ON "brand_sim_hours";
CREATE TRIGGER "brand_sim_hours_permanent"
  BEFORE UPDATE OR DELETE ON "brand_sim_hours"
  FOR EACH ROW EXECUTE PROCEDURE "brand_sim_hours_guard"();

-- Settings versions are append-only (brand_reject_mutation from 20261028).
DROP TRIGGER IF EXISTS "brand_sim_settings_versions_append_only" ON "brand_sim_settings_versions";
CREATE TRIGGER "brand_sim_settings_versions_append_only"
  BEFORE UPDATE OR DELETE ON "brand_sim_settings_versions"
  FOR EACH ROW EXECUTE PROCEDURE "brand_reject_mutation"();

-- Periods: never deleted; the only change is closing an open period, once.
CREATE OR REPLACE FUNCTION "brand_access_periods_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'brand_access_periods rows cannot be deleted'; END IF;
  IF OLD."endedAt" IS NOT NULL OR NEW."endedAt" IS NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accessId" IS DISTINCT FROM OLD."accessId"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" OR NEW."startReason" IS DISTINCT FROM OLD."startReason"
     OR NEW."startAuditId" IS DISTINCT FROM OLD."startAuditId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."endAuditId" IS NOT NULL AND NEW."endAuditId" IS DISTINCT FROM OLD."endAuditId") THEN
    RAISE EXCEPTION 'brand_access_periods: only an open period can be closed, once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "brand_access_periods_guard" ON "brand_access_periods";
CREATE TRIGGER "brand_access_periods_guard"
  BEFORE UPDATE OR DELETE ON "brand_access_periods"
  FOR EACH ROW EXECUTE PROCEDURE "brand_access_periods_guard"();

-- Payment proofs: only for a request awaiting payment; kept forever; one review
-- (SUBMITTED → ACCEPTED | REJECTED | WITHDRAWN) and nothing else ever changes.
CREATE OR REPLACE FUNCTION "brand_payment_proofs_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'brand_payment_proofs rows cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    -- FOR SHARE: a concurrent cancellation / rejection of the request either
    -- waits for this proof (and then withdraws / rejects it) or wins first.
    PERFORM 1 FROM "brand_accesses" WHERE "id" = NEW."accessId" AND "status" = 'PENDING_PAYMENT' FOR SHARE;
    IF NEW."status" <> 'SUBMITTED' OR NOT FOUND THEN
      RAISE EXCEPTION 'brand_payment_proofs: a proof is submitted only for a request awaiting payment';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'SUBMITTED' OR NEW."status" NOT IN ('ACCEPTED', 'REJECTED', 'WITHDRAWN')
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accessId" IS DISTINCT FROM OLD."accessId"
     OR NEW."fileKey" IS DISTINCT FROM OLD."fileKey" OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
     OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
     OR NEW."transferReference" IS DISTINCT FROM OLD."transferReference"
     OR NEW."transferReferenceNormalized" IS DISTINCT FROM OLD."transferReferenceNormalized"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'brand_payment_proofs: only one review of a submitted proof is allowed';
  END IF;
  IF NEW."status" = 'ACCEPTED' AND NOT EXISTS (
    SELECT 1 FROM "brand_accesses" WHERE "id" = NEW."accessId" AND "status" = 'PENDING_PAYMENT'
  ) THEN
    RAISE EXCEPTION 'brand_payment_proofs: a proof is accepted only while its request awaits payment';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "brand_payment_proofs_guard" ON "brand_payment_proofs";
CREATE TRIGGER "brand_payment_proofs_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "brand_payment_proofs"
  FOR EACH ROW EXECUTE PROCEDURE "brand_payment_proofs_guard"();

-- Authorizations: never deleted; an UNUSED one is either revoked or consumed,
-- once; a consumption must point at a request of the same affiliate that
-- references this authorization.
CREATE OR REPLACE FUNCTION "brand_request_authorizations_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'brand_request_authorizations rows cannot be deleted'; END IF;
  IF OLD."revokedAt" IS NOT NULL OR OLD."consumedAt" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."affiliateId" IS DISTINCT FROM OLD."affiliateId"
     OR NEW."grantedBy" IS DISTINCT FROM OLD."grantedBy" OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."grantAuditId" IS DISTINCT FROM OLD."grantAuditId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'brand_request_authorizations: only an unused authorization can be revoked or consumed, once';
  END IF;
  IF NEW."consumedAt" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "brand_accesses" a
    WHERE a."id" = NEW."consumedByAccessId" AND a."affiliateId" = NEW."affiliateId" AND a."authorizationId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'brand_request_authorizations: consumed by a request that does not reference it';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "brand_request_authorizations_guard" ON "brand_request_authorizations";
CREATE TRIGGER "brand_request_authorizations_guard"
  BEFORE UPDATE OR DELETE ON "brand_request_authorizations"
  FOR EACH ROW EXECUTE PROCEDURE "brand_request_authorizations_guard"();

-- brand_accesses: snapshot columns (now including authorizationId) frozen,
-- no DELETE, and only the approved status transitions:
--   PENDING_PAYMENT → ACTIVE (with an ACCEPTED proof) | REJECTED | CANCELLED
--   ACTIVE → CLOSED,  CLOSED → ACTIVE
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
     OR NEW."authorizationId" IS DISTINCT FROM OLD."authorizationId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'brand_accesses request snapshot is immutable (UPDATE of snapshot columns rejected)';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING_PAYMENT' AND NEW."status" IN ('ACTIVE', 'REJECTED', 'CANCELLED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'CLOSED')
    OR (OLD."status" = 'CLOSED' AND NEW."status" = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'brand_accesses: transition % → % is not allowed', OLD."status", NEW."status";
  END IF;
  IF OLD."status" = 'PENDING_PAYMENT' AND NEW."status" = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM "brand_payment_proofs" WHERE "accessId" = NEW."id" AND "status" = 'ACCEPTED'
  ) THEN
    RAISE EXCEPTION 'brand_accesses: activation requires an accepted payment proof';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- New request after a CLOSED access: needs an UNUSED authorization of the same
-- affiliate (locked), and the authorization must be consumed by this request
-- before the transaction commits (deferred check).
CREATE OR REPLACE FUNCTION "brand_access_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."authorizationId" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "brand_accesses" WHERE "affiliateId" = NEW."affiliateId" AND "status" = 'CLOSED'
  ) THEN
    PERFORM 1 FROM "brand_request_authorizations"
      WHERE "id" = NEW."authorizationId" AND "affiliateId" = NEW."affiliateId"
        AND "revokedAt" IS NULL AND "consumedAt" IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'brand_accesses: a new request after a closed access needs an unused admin authorization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "brand_accesses_insert_guard" ON "brand_accesses";
CREATE TRIGGER "brand_accesses_insert_guard"
  BEFORE INSERT ON "brand_accesses"
  FOR EACH ROW EXECUTE PROCEDURE "brand_access_insert_guard"();

CREATE OR REPLACE FUNCTION "brand_access_authorization_consumed"() RETURNS trigger AS $$
BEGIN
  IF NEW."authorizationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "brand_request_authorizations" WHERE "id" = NEW."authorizationId" AND "consumedByAccessId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'brand_accesses: authorization % was not consumed by this request', NEW."authorizationId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "brand_accesses_authorization_consumed" ON "brand_accesses";
CREATE CONSTRAINT TRIGGER "brand_accesses_authorization_consumed"
  AFTER INSERT ON "brand_accesses" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE PROCEDURE "brand_access_authorization_consumed"();

-- ── Backfill (verified data only) ────────────────────────────────────────────
-- Every ACTIVE access gets its first period from its recorded activation time and
-- its ACCESS_ACTIVATED audit row. Nothing is inferred for any other status.
INSERT INTO "brand_access_periods" ("id", "accessId", "startedAt", "startReason", "startAuditId")
SELECT gen_random_uuid()::text, a."id", a."activatedAt", 'ACTIVATION',
       (SELECT l."id" FROM "brand_audit_log" l
         WHERE l."action" = 'ACCESS_ACTIVATED' AND l."entityId" = a."id" ORDER BY l."createdAt" LIMIT 1)
FROM "brand_accesses" a
WHERE a."status" = 'ACTIVE' AND a."activatedAt" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "brand_access_periods" p WHERE p."accessId" = a."id");
