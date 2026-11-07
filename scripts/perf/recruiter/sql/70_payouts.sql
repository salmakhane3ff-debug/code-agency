-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/70_payouts.sql — step 70: affiliate_payouts.
--   • recruiter withdrawals (recruiterId set, affiliateId NULL): p5a_gen.withdrawal_plan —
--     max(20, S/50) per recruiter with earnings, paid 55 % / pending 25 % / rejected 20 %, whole
--     MAD amounts (the recruiter amount CHECK requires whole cents);
--   • affiliate (non-recruiter) payouts: ~5 % of the network members, 1–3 rows each,
--     paid 60 % / pending 25 % / rejected 15 %.
-- Owner CHECK (exactly one of affiliateId / recruiterId) and FKs stay enabled.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

INSERT INTO affiliate_payouts (id, "affiliateId", "recruiterId", amount, status, "createdAt")
SELECT id, affiliate_id, recruiter_id, amount, status, at
FROM (
  SELECT w.id, NULL::text AS affiliate_id, w.recruiter_id, (w.cents / 100.0)::double precision AS amount, w.status, w.at
  FROM p5a_gen.withdrawal_plan w
  UNION ALL
  SELECT p5a_gen.uuid4('p5a:apay:' || p.id || ':' || j), p.id, NULL,
         round((50 + 1950 * p5a_gen.u01('p5a:apamt:' || p.id || ':' || j))::numeric, 2)::double precision,
         CASE WHEN p5a_gen.u01('p5a:apst:' || p.id || ':' || j) < 0.60 THEN 'paid'
              WHEN p5a_gen.u01('p5a:apst:' || p.id || ':' || j) < 0.85 THEN 'pending'
              ELSE 'rejected' END,
         (p.created_at + interval '30 days' + j * interval '20 days')::timestamp(3)
  FROM p5a_gen.plan p
  CROSS JOIN LATERAL generate_series(1, 1 + (p5a_gen.h32('p5a:apn:' || p.id) % 3)::int) j
  WHERE p5a_gen.u01('p5a:apay:' || p.id) < 0.05
) x
ORDER BY at, id;
