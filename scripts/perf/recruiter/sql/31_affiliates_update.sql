-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/31_affiliates_update.sql — step 31: after linking, the affiliates
-- get their planned state: isActive (~70 %), the deterministic creation time (strictly
-- increasing in creation order, so ORDER BY "createdAt", id is stable) and "updatedAt". No
-- trigger guards affiliates. VACUUM FULL then rewrites the table compactly (the update left one
-- dead version per row) — the templates are compact, freshly loaded tables.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

UPDATE affiliates a
SET "createdAt" = p.created_at,
    "updatedAt" = p.created_at + interval '1 day' * (p5a_gen.h32('p5a:upd:' || p.id) % 30),
    "isActive"  = p.is_active
FROM p5a_gen.plan p
WHERE a.id = p.id;

VACUUM FULL affiliates;
