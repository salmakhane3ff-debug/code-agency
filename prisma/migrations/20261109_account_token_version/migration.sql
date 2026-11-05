-- ─────────────────────────────────────────────────────────────────────────────
-- 20261109_account_token_version — Phase 6 part 2 (account & session security).
--
-- A session version per affiliate and per recruiter. Every issued token carries it (claim
-- "tv"); authentication rejects a token whose version differs from the account's. The
-- version is bumped when the account is disabled or re-enabled, when its password is
-- changed, reset by an admin, or set through an activation code — so every older token is
-- revoked, and re-enabling an account never revives a token issued before.
--
--   • affiliates."tokenVersion"  INTEGER NOT NULL DEFAULT 0, CHECK >= 0
--   • recruiters."tokenVersion"  INTEGER NOT NULL DEFAULT 0, CHECK >= 0
--
-- Additive only. With a constant default, PostgreSQL 11+ adds the column without rewriting
-- the table; every existing row reads 0, and a token issued before this change (no "tv")
-- also counts as 0 — nobody is logged out by the deployment itself. No row is updated, no
-- existing column / constraint / index / trigger changes. Re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "affiliates" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "recruiters" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_tokenVersion_check" CHECK ("tokenVersion" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "affiliates" VALIDATE CONSTRAINT "affiliates_tokenVersion_check";

DO $$ BEGIN
  ALTER TABLE "recruiters" ADD CONSTRAINT "recruiters_tokenVersion_check" CHECK ("tokenVersion" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "recruiters" VALIDATE CONSTRAINT "recruiters_tokenVersion_check";
