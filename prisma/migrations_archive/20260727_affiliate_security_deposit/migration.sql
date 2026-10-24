-- Affiliate security deposit ("Dépôt de garantie") — ADDITIVE migration.
-- One new table. No existing table/column/constraint is altered or removed, so
-- all existing affiliate earnings, balances and withdrawals are untouched. The
-- approved-deposit balance is DERIVED (SUM of APPROVED rows) — there is no new
-- column on affiliates and no change to the withdrawable-balance calculation.

CREATE TABLE IF NOT EXISTS "affiliate_security_deposits" (
  "id"                TEXT NOT NULL,
  "affiliateId"       TEXT NOT NULL,
  "amount"            DECIMAL(12,2) NOT NULL,
  "paymentMethod"     TEXT NOT NULL,
  "transferReference" TEXT,
  "proofFile"         TEXT NOT NULL,
  "affiliateNote"     TEXT,
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "rejectionReason"   TEXT,
  "reviewedByAdminId" TEXT,
  "reviewedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "affiliate_security_deposits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "affiliate_security_deposits_affiliateId_idx" ON "affiliate_security_deposits" ("affiliateId");
CREATE INDEX IF NOT EXISTS "affiliate_security_deposits_status_idx" ON "affiliate_security_deposits" ("status");

-- Concurrency guard: at most ONE PENDING request per affiliate, enforced at the
-- database level. A PARTIAL unique index (Postgres) means two simultaneous
-- submissions can never both insert a PENDING row — the second fails with a
-- unique violation (Prisma P2002), which the service maps to "already pending".
-- APPROVED/REJECTED rows are unaffected, so a new request is allowed once the
-- current one is reviewed. (Partial indexes cannot be expressed in the Prisma
-- schema DSL, so this is created via raw SQL and managed by this migration.)
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_security_deposits_one_pending"
  ON "affiliate_security_deposits" ("affiliateId")
  WHERE "status" = 'PENDING';

-- Guarded FK (idempotent — skip if it already exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_security_deposits_affiliateId_fkey'
  ) THEN
    ALTER TABLE "affiliate_security_deposits"
      ADD CONSTRAINT "affiliate_security_deposits_affiliateId_fkey"
      FOREIGN KEY ("affiliateId") REFERENCES "affiliates" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
