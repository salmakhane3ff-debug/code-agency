-- ─────────────────────────────────────────────────────────────────────────────
-- 20261106_recruiter_rewards_withdrawals — Affiliate Recruiter System, Phase 5.
--
-- Recruiter withdrawals REUSE the existing withdrawal table affiliate_payouts (one payout
-- system; the same admin list and processing flow). Recruiter money is accounted ONLY
-- against recruiter_reward_ledger: affiliate balances read affiliate_payouts filtered by
-- "affiliateId", so recruiter rows (affiliateId NULL) never enter an affiliate balance.
--
--   • affiliate_payouts."affiliateId"  NOT NULL → nullable (existing rows keep their value)
--   • affiliate_payouts."recruiterId"  new, nullable, FK recruiters (ON DELETE RESTRICT)
--   • affiliate_payouts_owner_check    EXACTLY ONE owner per row (all existing rows pass:
--                                      affiliateId set, recruiterId NULL)
--   • affiliate_payouts_recruiter_amount_check  a recruiter row has a positive amount
--                                      of whole cents, at most 1,000,000.00 MAD
--   • recruiters."bankName" / "rib" / "accountName"  new, nullable (same fields as affiliates)
--
-- No existing row, value, index or trigger is changed or removed; nothing is backfilled.
-- Re-runnable: IF [NOT] EXISTS and duplicate_object handlers. The CHECKs are added NOT VALID
-- then validated (short lock on a large table).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. recruiters: bank details ─────────────────────────────────────────────
ALTER TABLE "recruiters" ADD COLUMN IF NOT EXISTS "bankName"    TEXT;
ALTER TABLE "recruiters" ADD COLUMN IF NOT EXISTS "rib"         TEXT;
ALTER TABLE "recruiters" ADD COLUMN IF NOT EXISTS "accountName" TEXT;

-- ── 2. affiliate_payouts: a recruiter can own a withdrawal ─────────────────
ALTER TABLE "affiliate_payouts" ADD COLUMN IF NOT EXISTS "recruiterId" TEXT;
ALTER TABLE "affiliate_payouts" ALTER COLUMN "affiliateId" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_recruiterId_fkey"
    FOREIGN KEY ("recruiterId") REFERENCES "recruiters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_owner_check"
    CHECK (("affiliateId" IS NULL) <> ("recruiterId" IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "affiliate_payouts" VALIDATE CONSTRAINT "affiliate_payouts_owner_check";

DO $$ BEGIN
  ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_recruiter_amount_check"
    CHECK ("recruiterId" IS NULL OR (
      "amount" >= 0.01 AND "amount" <= 1000000
      AND abs("amount" * 100 - round(("amount" * 100)::numeric)::double precision) < 0.000001)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "affiliate_payouts" VALIDATE CONSTRAINT "affiliate_payouts_recruiter_amount_check";

CREATE INDEX IF NOT EXISTS "affiliate_payouts_recruiterId_idx" ON "affiliate_payouts"("recruiterId");
