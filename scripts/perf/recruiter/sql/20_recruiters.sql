-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/20_recruiters.sql — step 20: the four recruiters (active,
-- canViewOrders, canCreateAffiliates, complete bank details), their KYC and the two recruiter
-- settings versions. All triggers stay enabled:
--   • recruiter_identity_verifications_guard: inserted PENDING / submission 1 with two <uuid>.jpg
--     keys, then updated PENDING → APPROVED with reviewer / reviewedAt / approvedAt (same
--     submission and files) — the only path the guard accepts;
--   • recruiter_settings_versions_consecutive: v1 then v2.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

BEGIN;

INSERT INTO recruiters (id, username, name, phone, "passwordHash", "isActive", "canCreateAffiliates", "canViewOrders",
                        "createdBy", "createdAt", "updatedAt", "bankName", rib, "accountName", "tokenVersion")
SELECT r.id, r.username, r.name, r.phone, c.v, true, true, true,
       'admin-p5a', r.created_at, r.created_at + interval '2 days 1 hour', 'CIH Bank', r.rib, r.name, 0
FROM p5a_gen.rec r, p5a_gen.consts c
WHERE c.k = 'recruiter_hash'
ORDER BY r.idx;

INSERT INTO recruiter_identity_verifications (id, "recruiterId", status, submission, "cinFrontFile", "cinBackFile",
                                              "submittedAt", "createdAt", "updatedAt")
SELECT p5a_gen.uuid4('p5a:rkyc:' || r.id), r.id, 'PENDING', 1,
       p5a_gen.uuid4('p5a:rkyc:front:' || r.id) || '.jpg', p5a_gen.uuid4('p5a:rkyc:back:' || r.id) || '.jpg',
       r.created_at + interval '1 day', r.created_at + interval '1 day', r.created_at + interval '1 day'
FROM p5a_gen.rec r ORDER BY r.idx;

UPDATE recruiter_identity_verifications v
SET status = 'APPROVED', "reviewedBy" = 'admin-p5a', "reviewedAt" = r.created_at + interval '2 days',
    "approvedAt" = r.created_at + interval '2 days', "updatedAt" = r.created_at + interval '2 days'
FROM p5a_gen.rec r
WHERE v."recruiterId" = r.id AND v.status = 'PENDING' AND v.submission = 1;

INSERT INTO recruiter_settings_versions (version, enabled, "rewardAmountCents", "minDeliveredSales", "createdBy", "createdAt")
SELECT 1, true, 5000, 3, 'admin-p5a', t FROM p5a_gen.timeline WHERE k = 'settings_v1';
INSERT INTO recruiter_settings_versions (version, enabled, "rewardAmountCents", "minDeliveredSales", "createdBy", "createdAt")
SELECT 2, true, 7000, 5, 'admin-p5a', t FROM p5a_gen.timeline WHERE k = 'settings_v2';

COMMIT;
