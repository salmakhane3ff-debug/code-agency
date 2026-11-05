-- ─────────────────────────────────────────────────────────────────────────────
-- 20261108_affiliate_activation_recovery — Affiliate Recruiter System, Phase 6 part 1
-- (admin activation recovery).
--
-- An affiliate whose activation code was used before them asks for help; an admin reviews
-- the request and, if approved, the affiliate's password is replaced by an unusable one, the
-- active code is invalidated (reason ADMIN_RECOVERY) and a fresh ADMIN code is issued and
-- shown once to that admin. The recruiter never sees it.
--
--   • affiliate_activation_recoveries — one row per request: who asked (message, optional
--     contact phone, request IP), when, who reviewed it, when, the review note, and the code
--     issued on approval (FK, never the code). One PENDING request per affiliate (partial
--     unique); PENDING → APPROVED | REJECTED once; never deleted (trigger).
--   • affiliate_activation_codes_check — the same CHECK as 20261107 plus the invalidation
--     reason 'ADMIN_RECOVERY' (the constraint is replaced; every existing row satisfies it).
--
-- Additive for every existing table: no column, row or other constraint changes. Re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. activation codes: allow the ADMIN_RECOVERY invalidation reason ────────
ALTER TABLE "affiliate_activation_codes" DROP CONSTRAINT IF EXISTS "affiliate_activation_codes_check";
ALTER TABLE "affiliate_activation_codes" ADD CONSTRAINT "affiliate_activation_codes_check"
  CHECK ("selector" ~ '^[A-Za-z0-9_-]{16}$'
     AND "verifierHash" ~ '^[0-9a-f]{64}$'
     AND "passwordFingerprint" ~ '^[0-9a-f]{64}$'
     AND "createdByType" IN ('RECRUITER', 'ADMIN') AND char_length("createdById") > 0
     AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '24 hours'
     AND "failedAttempts" BETWEEN 0 AND 5
     AND NOT ("usedAt" IS NOT NULL AND "invalidatedAt" IS NOT NULL)
     AND (("invalidatedAt" IS NULL) = ("invalidatedReason" IS NULL))
     AND ("invalidatedReason" IS NULL OR "invalidatedReason" IN ('REGENERATED', 'TOO_MANY_ATTEMPTS', 'CREDENTIALS_CHANGED', 'ADMIN_RECOVERY')));

-- ── 2. recovery requests ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "affiliate_activation_recoveries" (
  "id"               TEXT         NOT NULL,
  "affiliateId"      TEXT         NOT NULL,
  "status"           TEXT         NOT NULL DEFAULT 'PENDING',
  "message"          TEXT         NOT NULL,
  "contactPhone"     TEXT,
  "requestIp"        TEXT,
  "requestedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedBy"       TEXT,
  "reviewedAt"       TIMESTAMP(3),
  "reviewNote"       TEXT,
  "activationCodeId" TEXT,
  CONSTRAINT "affiliate_activation_recoveries_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "affiliate_activation_recoveries" ADD CONSTRAINT "affiliate_activation_recoveries_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "affiliate_activation_recoveries" ADD CONSTRAINT "affiliate_activation_recoveries_activationCodeId_fkey"
    FOREIGN KEY ("activationCodeId") REFERENCES "affiliate_activation_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "affiliate_activation_recoveries" ADD CONSTRAINT "affiliate_activation_recoveries_check"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')
       AND char_length(btrim("message")) BETWEEN 1 AND 500
       AND ("contactPhone" IS NULL OR "contactPhone" ~ '^\+?[0-9]{8,15}$')
       AND ("requestIp" IS NULL OR char_length("requestIp") <= 64)
       AND ("reviewNote" IS NULL OR char_length("reviewNote") <= 300)
       AND ("status" <> 'PENDING'  OR ("reviewedBy" IS NULL AND "reviewedAt" IS NULL AND "activationCodeId" IS NULL))
       AND ("status" <> 'APPROVED' OR (char_length(coalesce("reviewedBy", '')) > 0 AND "reviewedAt" IS NOT NULL AND "activationCodeId" IS NOT NULL))
       AND ("status" <> 'REJECTED' OR (char_length(coalesce("reviewedBy", '')) > 0 AND "reviewedAt" IS NOT NULL AND "activationCodeId" IS NULL)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "affiliate_activation_recoveries_status_requestedAt_idx" ON "affiliate_activation_recoveries"("status", "requestedAt");
CREATE INDEX IF NOT EXISTS "affiliate_activation_recoveries_affiliateId_requestedAt_idx" ON "affiliate_activation_recoveries"("affiliateId", "requestedAt");
-- one PENDING request per affiliate (duplicates are absorbed)
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_activation_recoveries_one_pending"
  ON "affiliate_activation_recoveries"("affiliateId") WHERE "status" = 'PENDING';

-- Life-cycle guard: no DELETE / TRUNCATE; an UPDATE may only review a PENDING request once
-- (status → APPROVED | REJECTED with the review columns); the request itself never changes.
CREATE OR REPLACE FUNCTION affiliate_activation_recovery_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'affiliate_activation_recoveries: % refused', TG_OP USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'PENDING' OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."affiliateId" IS DISTINCT FROM OLD."affiliateId"
     OR NEW."message" IS DISTINCT FROM OLD."message" OR NEW."contactPhone" IS DISTINCT FROM OLD."contactPhone"
     OR NEW."requestIp" IS DISTINCT FROM OLD."requestIp" OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt" THEN
    RAISE EXCEPTION 'affiliate_activation_recoveries: only a PENDING request can be reviewed, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "affiliate_activation_recoveries_guard" ON "affiliate_activation_recoveries";
CREATE TRIGGER "affiliate_activation_recoveries_guard" BEFORE UPDATE OR DELETE ON "affiliate_activation_recoveries"
  FOR EACH ROW EXECUTE FUNCTION affiliate_activation_recovery_guard();
DROP TRIGGER IF EXISTS "affiliate_activation_recoveries_no_truncate" ON "affiliate_activation_recoveries";
CREATE TRIGGER "affiliate_activation_recoveries_no_truncate" BEFORE TRUNCATE ON "affiliate_activation_recoveries"
  FOR EACH STATEMENT EXECUTE FUNCTION affiliate_activation_recovery_guard();
