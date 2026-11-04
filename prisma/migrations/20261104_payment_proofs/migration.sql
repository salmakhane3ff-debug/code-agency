-- ─────────────────────────────────────────────────────────────────────────────
-- 20261104_payment_proofs — Payment Proofs: an admin-managed DISPLAY feed shown to
-- all active affiliates in the dashboard slider.
--
--   • payment_proofs        — one row per announced proof: admin-typed display name
--                             and amount, private receipt file key + fingerprint,
--                             opaque public token, schedule / publication status,
--                             mandatory privacy + authenticity confirmations
--   • payment_proof_events  — append-only audit history of every proof
--
-- Completely independent: NO foreign key or reference to affiliates, users,
-- payouts, balances, commissions, rewards, orders or any financial table.
-- Additive only: two new tables, their constraints, indexes and triggers. No
-- existing table, column, row or trigger is changed; nothing is backfilled.
-- Re-runnable: IF NOT EXISTS, duplicate_object handlers, CREATE OR REPLACE
-- FUNCTION, triggers via DROP IF EXISTS + CREATE. No explicit transaction.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payment_proofs" (
  "id"                      TEXT         NOT NULL,
  "displayName"             TEXT         NOT NULL,
  "displayAmountCents"      INTEGER      NOT NULL,
  "fileKey"                 TEXT         NOT NULL,
  "fingerprint"             TEXT         NOT NULL,
  "publicToken"             TEXT         NOT NULL,
  "status"                  TEXT         NOT NULL DEFAULT 'SCHEDULED',
  "scheduledAt"             TIMESTAMP(3) NOT NULL,
  "publishedAt"             TIMESTAMP(3),
  "cancelledAt"             TIMESTAMP(3),
  "failedAt"                TIMESTAMP(3),
  "failureReason"           TEXT,
  "publishAttempts"         INTEGER      NOT NULL DEFAULT 0,
  "batchId"                 TEXT,
  "clientRef"               TEXT         NOT NULL,
  "privacyConfirmedAt"      TIMESTAMP(3) NOT NULL,
  "privacyConfirmedBy"      TEXT         NOT NULL,
  "authenticityConfirmedAt" TIMESTAMP(3) NOT NULL,
  "authenticityConfirmedBy" TEXT         NOT NULL,
  "createdBy"               TEXT,
  "updatedBy"               TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_proofs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_proof_events" (
  "id"      TEXT         NOT NULL,
  "seq"     BIGSERIAL    NOT NULL,   -- insertion order: events of one transaction share "at"
  "proofId" TEXT         NOT NULL,
  "action"  TEXT         NOT NULL,
  "actor"   TEXT         NOT NULL,
  "at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "details" JSONB,
  CONSTRAINT "payment_proof_events_pkey" PRIMARY KEY ("id")
);

-- ── 2. Constraints ───────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_status_check"
    CHECK ("status" IN ('SCHEDULED', 'PUBLISHED', 'CANCELLED', 'FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_amount_check"
    CHECK ("displayAmountCents" > 0 AND "displayAmountCents" <= 100000000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_name_check"
    CHECK (char_length("displayName") BETWEEN 2 AND 40);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- PUBLISHED ⇔ publishedAt set; CANCELLED ⇒ cancelledAt; FAILED ⇒ failedAt.
  ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_state_check"
    CHECK ((("status" = 'PUBLISHED') = ("publishedAt" IS NOT NULL))
       AND ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
       AND ("status" <> 'FAILED' OR "failedAt" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Both admin declarations are mandatory (non-empty actor).
  ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_confirmations_check"
    CHECK (char_length("privacyConfirmedBy") > 0 AND char_length("authenticityConfirmedBy") > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "payment_proof_events" ADD CONSTRAINT "payment_proof_events_action_check"
    CHECK ("action" IN ('CREATE', 'CONFIRM_PRIVACY', 'CONFIRM_AUTHENTICITY', 'EDIT', 'CANCEL', 'PUBLISH', 'FAIL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- The ONLY foreign key: an event belongs to a proof of this feature.
  ALTER TABLE "payment_proof_events" ADD CONSTRAINT "payment_proof_events_proofId_fkey"
    FOREIGN KEY ("proofId") REFERENCES "payment_proofs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "payment_proofs_clientRef_key"   ON "payment_proofs"("clientRef");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_proofs_fileKey_key"     ON "payment_proofs"("fileKey");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_proofs_publicToken_key" ON "payment_proofs"("publicToken");
-- The same receipt bytes can be scheduled only once unless that proof was cancelled.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_proofs_fingerprint_active_key"
  ON "payment_proofs"("fingerprint") WHERE "status" <> 'CANCELLED';
-- Worker scan (due proofs) and the 72 h affiliate feed.
CREATE INDEX IF NOT EXISTS "payment_proofs_status_scheduledAt_idx" ON "payment_proofs"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "payment_proofs_status_publishedAt_idx" ON "payment_proofs"("status", "publishedAt");
CREATE INDEX IF NOT EXISTS "payment_proofs_batchId_idx"            ON "payment_proofs"("batchId");
CREATE INDEX IF NOT EXISTS "payment_proof_events_proofId_at_idx"   ON "payment_proof_events"("proofId", "at");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_proof_events_seq_key"   ON "payment_proof_events"("seq");

-- ── 4. Guards ────────────────────────────────────────────────────────────────
-- PUBLISHED and CANCELLED proofs are final; no proof is ever deleted (history is kept).
CREATE OR REPLACE FUNCTION payment_proofs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_proofs rows are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('PUBLISHED', 'CANCELLED') THEN
    RAISE EXCEPTION 'payment proof % is % and cannot change', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'PUBLISHED' AND OLD."status" <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'only a SCHEDULED proof can be published' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "payment_proofs_guard" ON "payment_proofs";
CREATE TRIGGER "payment_proofs_guard" BEFORE UPDATE OR DELETE ON "payment_proofs"
  FOR EACH ROW EXECUTE FUNCTION payment_proofs_guard();

-- Audit history is append-only.
CREATE OR REPLACE FUNCTION payment_proof_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_proof_events is append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "payment_proof_events_append_only" ON "payment_proof_events";
CREATE TRIGGER "payment_proof_events_append_only" BEFORE UPDATE OR DELETE ON "payment_proof_events"
  FOR EACH ROW EXECUTE FUNCTION payment_proof_events_append_only();
DROP TRIGGER IF EXISTS "payment_proof_events_no_truncate" ON "payment_proof_events";
CREATE TRIGGER "payment_proof_events_no_truncate" BEFORE TRUNCATE ON "payment_proof_events"
  FOR EACH STATEMENT EXECUTE FUNCTION payment_proof_events_append_only();
