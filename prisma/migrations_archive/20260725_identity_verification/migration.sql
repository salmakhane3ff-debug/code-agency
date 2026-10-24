-- Affiliate identity verification (CIN) — ADDITIVE migration.
-- Adds one new table. No existing table/column/constraint is altered or deleted,
-- so all existing affiliate data is untouched. Absence of a row = NOT_SUBMITTED.

CREATE TABLE IF NOT EXISTS "identity_verifications" (
  "id"              TEXT NOT NULL,
  "affiliateId"     TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "cinFrontFile"    TEXT,
  "cinBackFile"     TEXT,
  "rejectionReason" TEXT,
  "submittedAt"     TIMESTAMP(3),
  "approvedAt"      TIMESTAMP(3),
  "approvedBy"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "identity_verifications_affiliateId_key" ON "identity_verifications" ("affiliateId");
CREATE INDEX IF NOT EXISTS "identity_verifications_status_idx" ON "identity_verifications" ("status");

-- Guarded FK (idempotent — skip if it already exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'identity_verifications_affiliateId_fkey'
  ) THEN
    ALTER TABLE "identity_verifications"
      ADD CONSTRAINT "identity_verifications_affiliateId_fkey"
      FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
