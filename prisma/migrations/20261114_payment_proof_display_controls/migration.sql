-- ─────────────────────────────────────────────────────────────────────────────
-- 20261114_payment_proof_display_controls — Payment Proofs: configurable display
-- duration (captured per proof at publication) and admin removal ("Supprimer").
--
--   • payment_proofs."visibleHours" / "visibleUntil" — the display duration in force
--     when the proof was ACTUALLY published, and the resulting end of its display
--     (= publishedAt + visibleHours). Written by the same conditional UPDATE that
--     publishes the proof (SCHEDULED → PUBLISHED, already allowed by the existing
--     payment_proofs_guard trigger); a PUBLISHED row never changes again, so a later
--     change of the global setting can never move an already-published proof.
--     Rows published before this migration keep NULL and the original 72 h rule
--     (publishedAt + 72 h) — they are NOT backfilled (the guard forbids touching
--     PUBLISHED rows, and no backfill is needed).
--   • REMOVE audit action — "Supprimer" in the admin list: the proof is hidden from
--     every affiliate at once, even before it expires, and NOTHING is deleted: the
--     proof row and its whole history stay; the removal itself is an append-only
--     event (who / when / previous state). At most one REMOVE per proof (partial
--     unique index), so a double click or two admins can never remove twice.
--   • payment_proofs_no_publish_removed — a NEW trigger (the existing guard is not
--     modified): a removed proof can never become PUBLISHED, whatever the caller.
--
-- Additive and forward-only: two nullable columns, two CHECKs, one index, one partial
-- unique index, one new trigger + function, and the event action CHECK replaced by a
-- SUPERSET (the old list + 'REMOVE'; every existing row still satisfies it — the new
-- constraint is added before the old one is dropped, so there is never a moment without
-- a check). The existing payment_proofs_guard and payment_proof_events append-only
-- triggers are NOT changed. No row is updated or deleted.
-- Re-runnable: IF NOT EXISTS, duplicate_object handlers, CREATE OR REPLACE FUNCTION,
-- trigger via DROP IF EXISTS + CREATE. No explicit transaction.
-- ORDER: if the re-runnable SQL files are ever re-applied by hand, apply 20261104 BEFORE this one —
-- re-running 20261104 afterwards would re-add its original action CHECK (without REMOVE); re-applying
-- this file then drops it again (and with REMOVE rows present, 20261104's ADD CONSTRAINT itself fails).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE "payment_proofs" ADD COLUMN IF NOT EXISTS "visibleHours" INTEGER;
ALTER TABLE "payment_proofs" ADD COLUMN IF NOT EXISTS "visibleUntil" TIMESTAMP(3);

-- ── 2. Constraints ───────────────────────────────────────────────────────────
DO $$ BEGIN
  -- Both set or both NULL; only on a PUBLISHED proof; 1 h … 8760 h (365 days);
  -- visibleUntil is exactly publishedAt + visibleHours.
  ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_visibility_check"
    CHECK ((("visibleHours" IS NULL) = ("visibleUntil" IS NULL))
       AND ("visibleHours" IS NULL OR (
             "status" = 'PUBLISHED'
         AND "visibleHours" BETWEEN 1 AND 8760
         AND "visibleUntil" = "publishedAt" + make_interval(hours => "visibleHours"))));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "payment_proof_events" ADD CONSTRAINT "payment_proof_events_action_check_v2"
    CHECK ("action" IN ('CREATE', 'CONFIRM_PRIVACY', 'CONFIRM_AUTHENTICITY', 'EDIT', 'CANCEL', 'PUBLISH', 'FAIL', 'REMOVE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The superset above is in place: the original list can go.
ALTER TABLE "payment_proof_events" DROP CONSTRAINT IF EXISTS "payment_proof_events_action_check";

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
-- Affiliate feed: published proofs whose display has not ended yet.
CREATE INDEX IF NOT EXISTS "payment_proofs_status_visibleUntil_idx" ON "payment_proofs"("status", "visibleUntil");
-- At most ONE removal per proof (idempotent "Supprimer", race-safe).
CREATE UNIQUE INDEX IF NOT EXISTS "payment_proof_events_remove_once_key"
  ON "payment_proof_events"("proofId") WHERE "action" = 'REMOVE';

-- ── 4. Guard: a removed proof is never published ───────────────────────────
CREATE OR REPLACE FUNCTION payment_proofs_no_publish_removed() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'PUBLISHED' AND OLD."status" <> 'PUBLISHED' AND EXISTS (
    SELECT 1 FROM "payment_proof_events" e WHERE e."proofId" = NEW."id" AND e."action" = 'REMOVE'
  ) THEN
    RAISE EXCEPTION 'payment proof % was removed and cannot be published', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "payment_proofs_no_publish_removed" ON "payment_proofs";
CREATE TRIGGER "payment_proofs_no_publish_removed" BEFORE UPDATE ON "payment_proofs"
  FOR EACH ROW EXECUTE FUNCTION payment_proofs_no_publish_removed();
