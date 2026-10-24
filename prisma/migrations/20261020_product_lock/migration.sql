-- Product lock — ADDITIVE migration.
-- One column with a default of false, so every existing product stays OPEN
-- (current behaviour: anyone can view and buy it). No existing data is altered
-- or removed. On PostgreSQL 11+ adding a column with a constant default is a
-- catalog-only change (no table rewrite); it still takes a brief exclusive lock
-- on "products", so apply it with a lock_timeout at a quiet moment.
-- Idempotent (safe to re-run).

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isLocked" BOOLEAN NOT NULL DEFAULT false;
