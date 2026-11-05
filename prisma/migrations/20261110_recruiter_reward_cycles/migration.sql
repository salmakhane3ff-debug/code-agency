-- ─────────────────────────────────────────────────────────────────────────────
-- 20261110_recruiter_reward_cycles — Phase 6 part 3a (reward reversal engine).
--
-- Versioned reward / reversal CYCLES per affiliate in recruiter_reward_ledger:
--   cycle n = one RECRUIT_REWARD (key recruit:<affiliateId>:v<n>) and, if the real delivered
--   count later falls below the threshold of that reward's settings version, one compensating
--   REVERSAL (key reverse:<affiliateId>:v<n>, amount = −the reward). After a reversal the
--   affiliate may qualify again: cycle n+1. The ledger stays append-only (no row is ever
--   updated or deleted): the net of an affiliate is always 0 or the amount of its open cycle.
--
--   • "cycle" INTEGER NOT NULL (≥ 1). Every EXISTING row reads 1 through the column default
--     (metadata only — no UPDATE, which the append-only trigger forbids); the default is then
--     dropped so every new row must state its cycle.
--   • Existing cycle-1 rows keep their legacy keys (recruit:<id> / reverse:<id>); the key CHECK
--     accepts that legacy form for cycle 1 only, and the versioned form for every cycle.
--   • One RECRUIT_REWARD and one REVERSAL per (affiliate, cycle) — the two partial unique
--     indexes "one per affiliate" are replaced by "one per affiliate and cycle".
--   • recruiter_reward_cycle_guard (BEFORE INSERT, under a per-affiliate advisory lock — the
--     same key as the application lock) replaces recruiter_reward_reversal_guard:
--       RECRUIT_REWARD cycle n: n = (highest reward cycle) + 1, and the previous cycle (if any)
--                               is closed by its REVERSAL;
--       REVERSAL cycle n:       the reward of cycle n exists, by the SAME recruiter, it is the
--                               latest (open) cycle, and −amount ≤ that reward's amount.
--     The link guard (reward → the affiliate's own recruiter) is unchanged.
--
-- No other table changes. Re-runnable. Locks: recruiter_reward_ledger only, briefly.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "recruiter_reward_ledger" ADD COLUMN IF NOT EXISTS "cycle" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "recruiter_reward_ledger" ALTER COLUMN "cycle" DROP DEFAULT;

DO $$ BEGIN
  ALTER TABLE "recruiter_reward_ledger" ADD CONSTRAINT "recruiter_reward_ledger_cycle_check"
    CHECK ("cycle" >= 1
       AND ("type" NOT IN ('RECRUIT_REWARD', 'REVERSAL') OR "affiliateId" IS NOT NULL)
       AND ("type" <> 'RECRUIT_REWARD' OR "idempotencyKey" = 'recruit:' || "affiliateId" || ':v' || "cycle"
                                       OR ("cycle" = 1 AND "idempotencyKey" = 'recruit:' || "affiliateId"))
       AND ("type" <> 'REVERSAL'       OR "idempotencyKey" = 'reverse:' || "affiliateId" || ':v' || "cycle"
                                       OR ("cycle" = 1 AND "idempotencyKey" = 'reverse:' || "affiliateId"))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "recruiter_reward_ledger" VALIDATE CONSTRAINT "recruiter_reward_ledger_cycle_check";

-- one reward / one reversal per (affiliate, cycle) instead of per affiliate
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_recruit_per_cycle"
  ON "recruiter_reward_ledger"("affiliateId", "cycle") WHERE "type" = 'RECRUIT_REWARD';
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_reversal_per_cycle"
  ON "recruiter_reward_ledger"("affiliateId", "cycle") WHERE "type" = 'REVERSAL';
DROP INDEX IF EXISTS "recruiter_reward_ledger_one_recruit_per_affiliate";
DROP INDEX IF EXISTS "recruiter_reward_ledger_one_reversal_per_affiliate";

CREATE OR REPLACE FUNCTION recruiter_reward_cycle_guard() RETURNS trigger AS $$
DECLARE
  max_reward  INTEGER;
  open_amount INTEGER;
  open_recr   TEXT;
  closed      BOOLEAN;
BEGIN
  IF NEW."type" NOT IN ('RECRUIT_REWARD', 'REVERSAL') THEN
    RETURN NEW;
  END IF;
  -- the same lock key as the application (src/lib/services/recruiterRewardService.js)
  PERFORM pg_advisory_xact_lock(hashtext('recruit:' || NEW."affiliateId"));
  SELECT coalesce(max("cycle"), 0) INTO max_reward FROM "recruiter_reward_ledger"
    WHERE "affiliateId" = NEW."affiliateId" AND "type" = 'RECRUIT_REWARD';
  IF NEW."type" = 'RECRUIT_REWARD' THEN
    IF NEW."cycle" <> max_reward + 1 THEN
      RAISE EXCEPTION 'recruit reward of affiliate % must be cycle % (got %)', NEW."affiliateId", max_reward + 1, NEW."cycle" USING ERRCODE = 'check_violation';
    END IF;
    IF max_reward > 0 THEN
      SELECT EXISTS (SELECT 1 FROM "recruiter_reward_ledger"
        WHERE "affiliateId" = NEW."affiliateId" AND "type" = 'REVERSAL' AND "cycle" = max_reward) INTO closed;
      IF NOT closed THEN
        RAISE EXCEPTION 'cycle % of affiliate % is still open (not reversed)', max_reward, NEW."affiliateId" USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    SELECT "amountCents", "recruiterId" INTO open_amount, open_recr FROM "recruiter_reward_ledger"
      WHERE "affiliateId" = NEW."affiliateId" AND "type" = 'RECRUIT_REWARD' AND "cycle" = NEW."cycle";
    IF open_amount IS NULL OR NEW."cycle" <> max_reward OR open_recr <> NEW."recruiterId" OR -NEW."amountCents" > open_amount THEN
      RAISE EXCEPTION 'a reversal needs the open reward of the same cycle and recruiter and cannot exceed it' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_reward_ledger_reversal_guard" ON "recruiter_reward_ledger";
DROP FUNCTION IF EXISTS recruiter_reward_reversal_guard();
DROP TRIGGER IF EXISTS "recruiter_reward_ledger_cycle_guard" ON "recruiter_reward_ledger";
CREATE TRIGGER "recruiter_reward_ledger_cycle_guard" BEFORE INSERT ON "recruiter_reward_ledger"
  FOR EACH ROW EXECUTE FUNCTION recruiter_reward_cycle_guard();
