-- Demo chat audit log — TRUNCATE guard (Phase 3C-1 follow-up) — ADDITIVE migration.
-- The row-level "demo_chat_audit_log_append_only" trigger (20261023) rejects
-- UPDATE and DELETE, but row-level triggers never fire for TRUNCATE, which
-- empties the table without visiting rows. This adds a separate STATEMENT-level
-- BEFORE TRUNCATE trigger so a TRUNCATE of the table is rejected as well.
--
-- Nothing existing is altered: no table, column, constraint, function or the
-- existing row-level trigger. It reuses "demo_chat_reject_mutation"() from
-- 20261023 unchanged (it reports TG_OP, i.e. 'TRUNCATE'); if that function is
-- missing this migration fails instead of silently skipping the guard.
--
-- Limits (by design of PostgreSQL triggers, not fixable here):
--   * The table owner or a superuser can still DROP/DISABLE the trigger,
--     DROP the table, or bypass triggers (session_replication_role = replica).
--   * DROP SCHEMA / `prisma migrate reset` / `db push --force-reset` remove the
--     table entirely; they are not TRUNCATE.
-- Idempotent (safe to re-run).
--
-- Rollback (manual; NOT run by this file):
--   DROP TRIGGER IF EXISTS "demo_chat_audit_log_no_truncate" ON "demo_chat_audit_log";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024_demo_chat_audit_truncate_guard';

DROP TRIGGER IF EXISTS "demo_chat_audit_log_no_truncate" ON "demo_chat_audit_log";
CREATE TRIGGER "demo_chat_audit_log_no_truncate"
  BEFORE TRUNCATE ON "demo_chat_audit_log"
  FOR EACH STATEMENT EXECUTE PROCEDURE "demo_chat_reject_mutation"();
