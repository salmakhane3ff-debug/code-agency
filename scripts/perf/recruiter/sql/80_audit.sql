-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/80_audit.sql — step 80: recruiter_audit_log (append-only trigger
-- stays enabled; rows are only inserted), shaped like the rows the services write:
--   • AFFILIATE_CREATED per network member — actor RECRUITER, entity affiliate, details
--     { requestId (uuid v4), username, parentId, activationCodeId: null } (recruiterCreateAffiliate);
--   • RECRUIT_REWARD_EARNED / RECRUIT_REWARD_REVERSED per ledger row — actor SYSTEM
--     (syncRecruiterReward details);
--   • RECRUITER_WITHDRAWAL_REQUESTED per recruiter withdrawal — actor RECRUITER, entity withdrawal,
--     details { requestId, amountCents }; RECRUITER_WITHDRAWAL_PAID / _REJECTED for the processed
--     ones — actor ADMIN (adminProcessRecruiterPayout);
--   • per recruiter: RECRUITER_CREATED, RECRUITER_IDENTITY_SUBMITTED / _APPROVED,
--     RECRUITER_BANK_UPDATED; and the two RECRUITER_SETTINGS_CHANGED rows (no recruiter).
-- Inserted in "createdAt" order, so seq follows time like in production.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

INSERT INTO recruiter_audit_log (id, "recruiterId", "actorType", "actorId", action, "entityType", "entityId", details, "createdAt")
SELECT id, recruiter_id, actor_type, actor_id, action, entity_type, entity_id, details, at
FROM (
  -- recruiter accounts
  SELECT p5a_gen.uuid4('p5a:audit:rc:' || r.id) AS id, r.id AS recruiter_id, 'ADMIN' AS actor_type, 'admin-p5a' AS actor_id,
         'RECRUITER_CREATED' AS action, 'recruiter' AS entity_type, r.id AS entity_id,
         jsonb_build_object('username', r.username, 'canViewOrders', true, 'canCreateAffiliates', true) AS details, r.created_at AS at
  FROM p5a_gen.rec r
  UNION ALL
  SELECT p5a_gen.uuid4('p5a:audit:ris:' || r.id), r.id, 'RECRUITER', r.id, 'RECRUITER_IDENTITY_SUBMITTED', 'recruiter_identity', r.id,
         jsonb_build_object('submission', 1, 'from', 'NOT_SUBMITTED', 'to', 'PENDING'), r.created_at + interval '1 day'
  FROM p5a_gen.rec r
  UNION ALL
  SELECT p5a_gen.uuid4('p5a:audit:ria:' || r.id), r.id, 'ADMIN', 'admin-p5a', 'RECRUITER_IDENTITY_APPROVED', 'recruiter_identity', r.id,
         jsonb_build_object('submission', 1, 'from', 'PENDING', 'to', 'APPROVED'), r.created_at + interval '2 days'
  FROM p5a_gen.rec r
  UNION ALL
  SELECT p5a_gen.uuid4('p5a:audit:rb:' || r.id), r.id, 'RECRUITER', r.id, 'RECRUITER_BANK_UPDATED', 'recruiter', r.id,
         NULL::jsonb, r.created_at + interval '2 days 1 hour'
  FROM p5a_gen.rec r
  UNION ALL
  -- settings versions
  SELECT p5a_gen.uuid4('p5a:audit:set:' || s.version), NULL, 'ADMIN', 'admin-p5a', 'RECRUITER_SETTINGS_CHANGED', 'recruiter_settings',
         s.version::text,
         jsonb_build_object('version', s.version, 'enabled', s.enabled, 'rewardAmountCents', s."rewardAmountCents",
                            'minDeliveredSales', s."minDeliveredSales"),
         s."createdAt"
  FROM recruiter_settings_versions s
  UNION ALL
  -- affiliate creations
  SELECT p5a_gen.uuid4('p5a:audit:ac:' || p.id), p.recruiter_id, 'RECRUITER', p.recruiter_id, 'AFFILIATE_CREATED', 'affiliate', p.id,
         jsonb_build_object('requestId', p5a_gen.uuid4('p5a:req:' || p.id), 'username', p.username, 'parentId', p.parent_id,
                            'activationCodeId', NULL),
         p.created_at
  FROM p5a_gen.plan p
  UNION ALL
  -- rewards / reversals
  SELECT p5a_gen.uuid4('p5a:audit:lg:' || l.affiliate_id || ':' || l.cycle || ':' || l.type), l.recruiter_id, 'SYSTEM', 'SYSTEM',
         CASE l.type WHEN 'RECRUIT_REWARD' THEN 'RECRUIT_REWARD_EARNED' ELSE 'RECRUIT_REWARD_REVERSED' END, 'affiliate', l.affiliate_id,
         CASE l.type
           WHEN 'RECRUIT_REWARD' THEN jsonb_build_object('cycle', l.cycle, 'amountCents', l.amount, 'settingsVersion', l.version,
                                     'realDeliveredOrders', s."minDeliveredSales", 'requiredDeliveredOrders', s."minDeliveredSales",
                                     'identityStatus', 'APPROVED')
           ELSE jsonb_build_object('cycle', l.cycle, 'amountCents', l.amount, 'settingsVersion', l.version,
                                   'realDeliveredOrders', s."minDeliveredSales" - 1, 'requiredDeliveredOrders', s."minDeliveredSales",
                                   'reason', 'REAL_DELIVERED_BELOW_THRESHOLD')
         END,
         l.at
  FROM p5a_gen.ledger_plan l
  JOIN recruiter_settings_versions s ON s.version = l.version
  UNION ALL
  -- recruiter withdrawals: request, then the admin decision for the processed ones
  SELECT p5a_gen.uuid4('p5a:audit:wq:' || w.id), w.recruiter_id, 'RECRUITER', w.recruiter_id, 'RECRUITER_WITHDRAWAL_REQUESTED',
         'withdrawal', w.id, jsonb_build_object('requestId', w.request_id, 'amountCents', w.cents), w.at
  FROM p5a_gen.withdrawal_plan w
  UNION ALL
  SELECT p5a_gen.uuid4('p5a:audit:wd:' || w.id), w.recruiter_id, 'ADMIN', 'admin-p5a',
         CASE w.status WHEN 'paid' THEN 'RECRUITER_WITHDRAWAL_PAID' ELSE 'RECRUITER_WITHDRAWAL_REJECTED' END,
         'withdrawal', w.id,
         jsonb_build_object('amountCents', w.cents, 'from', 'pending', 'to', w.status, 'reason', NULL),
         (w.at + interval '1 day' + interval '2 days' * p5a_gen.u01('p5a:wdd:' || w.id))::timestamp(3)
  FROM p5a_gen.withdrawal_plan w
  WHERE w.status IN ('paid', 'rejected')
) x
ORDER BY at, id;
