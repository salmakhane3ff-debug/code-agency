-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/40_identity.sql — step 40: affiliate identity verifications
-- (identity_verifications: ~40 % APPROVED, ~15 % PENDING, ~10 % REJECTED, the rest no row =
-- NOT_SUBMITTED). Submitted 2–7 days after the affiliate's creation, decided one day later —
-- always before the affiliate's first reward (≥ 10 days after creation).
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

INSERT INTO identity_verifications (id, "affiliateId", status, "cinFrontFile", "cinBackFile", "rejectionReason",
                                    "submittedAt", "approvedAt", "approvedBy", "createdAt", "updatedAt")
SELECT p5a_gen.uuid4('p5a:idv:' || x.id), x.id, x.identity,
       p5a_gen.uuid4('p5a:cin:front:' || x.id) || '.jpg', p5a_gen.uuid4('p5a:cin:back:' || x.id) || '.jpg',
       CASE WHEN x.identity = 'REJECTED' THEN 'Photo de la CIN illisible' END,
       x.sub_at,
       CASE WHEN x.identity = 'APPROVED' THEN x.sub_at + interval '1 day' END,
       CASE WHEN x.identity = 'APPROVED' THEN 'admin@p5a.local' END,
       x.sub_at,
       CASE WHEN x.identity = 'PENDING' THEN x.sub_at ELSE x.sub_at + interval '1 day' END
FROM (
  SELECT p.id, p.identity,
         (p.created_at + interval '2 days' + interval '5 days' * p5a_gen.u01('p5a:sub:' || p.id))::timestamp(3) AS sub_at
  FROM p5a_gen.plan p WHERE p.identity IS NOT NULL
) x
ORDER BY x.sub_at, x.id;
