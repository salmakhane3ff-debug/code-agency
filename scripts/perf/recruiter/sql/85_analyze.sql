-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/85_analyze.sql — step 85: planner statistics for the freshly loaded
-- tables BEFORE validation, so the validation's recursive network queries get index-based plans
-- (90_finalize.sql runs VACUUM (ANALYZE) on the whole database again at the end).
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

ANALYZE;
