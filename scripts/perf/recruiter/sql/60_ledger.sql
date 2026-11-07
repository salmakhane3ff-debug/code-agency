-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/60_ledger.sql — step 60: recruiter_reward_ledger with every trigger
-- ENABLED (append-only, cycle guard, link guard, CHECKs). Rows are inserted ONE BY ONE in global
-- time order, so each affiliate's events arrive in their real order (reward n → reversal n →
-- reward n+1) and every cycle-guard check runs against the rows already inserted. The cycle
-- guard takes a per-affiliate transaction advisory lock for every row; a COMMIT every :batch rows
-- keeps the number of held locks far below the default lock table (max_locks_per_transaction 64
-- × max_connections 100).
-- Keys per migration 20261110: recruit:<id>:v<n> / reverse:<id>:v<n>; cycle-1 rows written before
-- the cycles migration may carry the legacy keys recruit:<id> / reverse:<id> (plan.legacy_key).
-- Rows mirror syncRecruiterReward: actor SYSTEM (no actorId), the reward's settings version (also
-- on the reversal), reason codes REAL_DELIVERED_AND_CIN_APPROVED / REAL_DELIVERED_BELOW_THRESHOLD.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

CREATE PROCEDURE p5a_gen.load_ledger(batch int)
LANGUAGE plpgsql AS $$
DECLARE
  r   record;
  i   bigint := 0;
  ikey text;
BEGIN
  FOR r IN SELECT * FROM p5a_gen.ledger_plan ORDER BY at, affiliate_id, cycle, type LOOP
    ikey := CASE r.type WHEN 'RECRUIT_REWARD' THEN 'recruit:' ELSE 'reverse:' END || r.affiliate_id
           || CASE WHEN r.legacy_key THEN '' ELSE ':v' || r.cycle END;
    INSERT INTO recruiter_reward_ledger (id, "recruiterId", "affiliateId", type, "amountCents", "idempotencyKey", reason,
                                         "actorType", "actorId", "settingsVersion", cycle, "createdAt")
    VALUES (p5a_gen.uuid4('p5a:ledger:' || ikey), r.recruiter_id, r.affiliate_id, r.type, r.amount, ikey,
            CASE r.type WHEN 'RECRUIT_REWARD' THEN 'REAL_DELIVERED_AND_CIN_APPROVED' ELSE 'REAL_DELIVERED_BELOW_THRESHOLD' END,
            'SYSTEM', NULL, r.version, r.cycle, r.at);
    i := i + 1;
    IF i % batch = 0 THEN
      COMMIT;
    END IF;
  END LOOP;
END;
$$;

CALL p5a_gen.load_ledger(2000);
