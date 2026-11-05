-- ─────────────────────────────────────────────────────────────────────────────
-- 20261107_affiliate_activation_codes — Affiliate Recruiter System, Phase 6 part 1.
--
-- One-time activation codes: an affiliate created by a recruiter chooses their OWN
-- password with a code the recruiter shares manually. The recruiter never chooses or
-- learns the final password.
--
--   • affiliate_activation_codes  — one row per issued code. Only a SHA-256 hash of the
--     secret part ("verifierHash") is stored, never the code. "selector" is a random,
--     non-secret lookup key. "passwordFingerprint" = SHA-256 of the affiliate's password
--     hash at issue time: a code is stale as soon as the password changed by any other way.
--   • at most ONE active code per affiliate (partial unique index); single use, expiry,
--     failed attempts 0–5 (CHECKs); rows are never deleted and only the life-cycle columns
--     may change, forwards only (trigger).
--
-- Additive only: one new table + FK to "affiliates"(id) ON DELETE RESTRICT. No existing
-- table, column, row, constraint or trigger is changed. Re-runnable (IF NOT EXISTS,
-- duplicate_object handlers, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "affiliate_activation_codes" (
  "id"                  TEXT         NOT NULL,
  "affiliateId"         TEXT         NOT NULL,
  "selector"            TEXT         NOT NULL,
  "verifierHash"        TEXT         NOT NULL,
  "passwordFingerprint" TEXT         NOT NULL,
  "createdByType"       TEXT         NOT NULL,
  "createdById"         TEXT         NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"           TIMESTAMP(3) NOT NULL,
  "failedAttempts"      INTEGER      NOT NULL DEFAULT 0,
  "usedAt"              TIMESTAMP(3),
  "invalidatedAt"       TIMESTAMP(3),
  "invalidatedReason"   TEXT,
  CONSTRAINT "affiliate_activation_codes_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "affiliate_activation_codes" ADD CONSTRAINT "affiliate_activation_codes_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "affiliate_activation_codes" ADD CONSTRAINT "affiliate_activation_codes_check"
    CHECK ("selector" ~ '^[A-Za-z0-9_-]{16}$'
       AND "verifierHash" ~ '^[0-9a-f]{64}$'
       AND "passwordFingerprint" ~ '^[0-9a-f]{64}$'
       AND "createdByType" IN ('RECRUITER', 'ADMIN') AND char_length("createdById") > 0
       AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '24 hours'
       AND "failedAttempts" BETWEEN 0 AND 5
       AND NOT ("usedAt" IS NOT NULL AND "invalidatedAt" IS NOT NULL)
       AND (("invalidatedAt" IS NULL) = ("invalidatedReason" IS NULL))
       AND ("invalidatedReason" IS NULL OR "invalidatedReason" IN ('REGENERATED', 'TOO_MANY_ATTEMPTS', 'CREDENTIALS_CHANGED')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_activation_codes_selector_key" ON "affiliate_activation_codes"("selector");
CREATE INDEX IF NOT EXISTS "affiliate_activation_codes_affiliateId_createdAt_idx" ON "affiliate_activation_codes"("affiliateId", "createdAt");
-- at most one ACTIVE (not used, not invalidated) code per affiliate
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_activation_codes_one_active"
  ON "affiliate_activation_codes"("affiliateId") WHERE "usedAt" IS NULL AND "invalidatedAt" IS NULL;

-- Life-cycle guard: no DELETE / TRUNCATE; on UPDATE only usedAt / invalidatedAt (+ reason)
-- may be set once (NULL → value) and failedAttempts may only grow.
CREATE OR REPLACE FUNCTION affiliate_activation_code_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'affiliate_activation_codes: % refused', TG_OP USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."affiliateId" IS DISTINCT FROM OLD."affiliateId"
     OR NEW."selector" IS DISTINCT FROM OLD."selector" OR NEW."verifierHash" IS DISTINCT FROM OLD."verifierHash"
     OR NEW."passwordFingerprint" IS DISTINCT FROM OLD."passwordFingerprint"
     OR NEW."createdByType" IS DISTINCT FROM OLD."createdByType" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."failedAttempts" < OLD."failedAttempts"
     OR (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt")
     OR (OLD."invalidatedAt" IS NOT NULL AND (NEW."invalidatedAt" IS DISTINCT FROM OLD."invalidatedAt"
                                            OR NEW."invalidatedReason" IS DISTINCT FROM OLD."invalidatedReason")) THEN
    RAISE EXCEPTION 'affiliate_activation_codes: only the life-cycle columns may change, forwards only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "affiliate_activation_codes_guard" ON "affiliate_activation_codes";
CREATE TRIGGER "affiliate_activation_codes_guard" BEFORE UPDATE OR DELETE ON "affiliate_activation_codes"
  FOR EACH ROW EXECUTE FUNCTION affiliate_activation_code_guard();
DROP TRIGGER IF EXISTS "affiliate_activation_codes_no_truncate" ON "affiliate_activation_codes";
CREATE TRIGGER "affiliate_activation_codes_no_truncate" BEFORE TRUNCATE ON "affiliate_activation_codes"
  FOR EACH STATEMENT EXECUTE FUNCTION affiliate_activation_code_guard();
