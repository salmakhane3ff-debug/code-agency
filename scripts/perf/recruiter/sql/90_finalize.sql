-- ─────────────────────────────────────────────────────────────────────────────
-- scripts/perf/recruiter/sql/90_finalize.sql — step 90 (after validation and the manifest):
-- remove the helper schema p5a_gen (the template then holds only the application schema and its
-- data), install pg_stat_statements for the benchmark clones, VACUUM (ANALYZE) the whole database
-- (statistics + visibility map). Run in autocommit mode (VACUUM cannot run in a transaction).
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1

DROP SCHEMA p5a_gen CASCADE;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
VACUUM (ANALYZE);
