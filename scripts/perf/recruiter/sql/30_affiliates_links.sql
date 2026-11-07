-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/30_affiliates_links.sql — step 30: every network member and its
-- recruiter link, inserted per the link trigger rule (recruiter_link_new_affiliate_only stays
-- ENABLED): in ONE transaction (no savepoint), each affiliate is inserted INACTIVE with
-- "createdAt" = the transaction's UTC time (inside the trigger's [now − 2 min, now + 1 min]
-- window), then its link is inserted. Rows go in the planned creation order (the three networks
-- interleaved), so the heap order is the creation order. The link carries its planned
-- (deterministic) creation time; the affiliates get theirs in step 31.
-- The 2-cycle "unplaced" pairs reference each other inside the same INSERT (the parentId foreign
-- key is checked at the end of the statement).
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

BEGIN;

INSERT INTO affiliates (id, username, name, phone, password, "isActive", "parentId", "createdAt", "updatedAt")
SELECT p.id, p.username, p.name, p.phone, c.v, false, p.parent_id,
       (now() AT TIME ZONE 'UTC')::timestamp(3), (now() AT TIME ZONE 'UTC')::timestamp(3)
FROM p5a_gen.plan p, p5a_gen.consts c
WHERE c.k = 'affiliate_hash'
ORDER BY p.created_at, p.id;

INSERT INTO recruiter_affiliate_links ("affiliateId", "recruiterId", "createdBy", "createdAt")
SELECT p.id, p.recruiter_id, p.recruiter_id, p.created_at
FROM p5a_gen.plan p
ORDER BY p.created_at, p.id;

COMMIT;
