-- ─────────────────────────────────────────────────────────────────────────────
-- 20261111_recruiter_identity_verifications — Phase 6 part 3c (recruiter KYC).
--
-- A recruiter's identity verification (CIN front + back), SEPARATE from the affiliate table
-- identity_verifications (which is not touched). One row per recruiter; no row = NOT_SUBMITTED.
--
--   • status PENDING | APPROVED | REJECTED, with the review columns tied to the status (CHECK).
--   • "submission" = 1, 2, … (one per upload): an admin decision names the submission AND the
--     status it saw, so an outdated decision can never overwrite a newer submission.
--   • cinFrontFile / cinBackFile = opaque private storage keys (<uuid>.jpg) — never sent to a
--     recruiter, never written into an audit row.
--   • recruiter_identity_guard (BEFORE INSERT / UPDATE / DELETE, + no TRUNCATE): the row can
--     never be deleted; id / recruiterId / createdAt never change; the only transitions are
--       (insert)            → PENDING, submission 1
--       PENDING  → APPROVED  (same submission, same files)
--       PENDING  → REJECTED  (same submission, same files)
--       APPROVED → REJECTED  (revocation; same submission, same files)
--       REJECTED → PENDING   (a NEW upload: submission + 1, two new files)
--     A REJECTED submission can therefore never be approved without a new upload.
--   • The history (submissions and admin decisions) lives in the append-only recruiter_audit_log.
--
-- No existing table changes. FK ON DELETE RESTRICT (recruiters are never deleted). Re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "recruiter_identity_verifications" (
    "id"              TEXT         NOT NULL,
    "recruiterId"     TEXT         NOT NULL,
    "status"          TEXT         NOT NULL,
    "submission"      INTEGER      NOT NULL,
    "cinFrontFile"    TEXT         NOT NULL,
    "cinBackFile"     TEXT         NOT NULL,
    "rejectionReason" TEXT,
    "submittedAt"     TIMESTAMP(3) NOT NULL,
    "reviewedBy"      TEXT,
    "reviewedAt"      TIMESTAMP(3),
    "approvedAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "recruiter_identity_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_identity_verifications_recruiterId_key"
  ON "recruiter_identity_verifications"("recruiterId");
CREATE INDEX IF NOT EXISTS "recruiter_identity_verifications_status_submittedAt_idx"
  ON "recruiter_identity_verifications"("status", "submittedAt");

DO $$ BEGIN
  ALTER TABLE "recruiter_identity_verifications" ADD CONSTRAINT "recruiter_identity_verifications_recruiterId_fkey"
    FOREIGN KEY ("recruiterId") REFERENCES "recruiters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "recruiter_identity_verifications" ADD CONSTRAINT "recruiter_identity_verifications_state_check"
    CHECK ("submission" >= 1
       AND "cinFrontFile" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
       AND "cinBackFile"  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
       AND "cinFrontFile" <> "cinBackFile"
       AND (
            ("status" = 'PENDING'  AND "rejectionReason" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL AND "approvedAt" IS NULL)
         OR ("status" = 'APPROVED' AND "rejectionReason" IS NULL AND char_length(coalesce("reviewedBy", '')) BETWEEN 1 AND 200
                                   AND "reviewedAt" IS NOT NULL AND "approvedAt" IS NOT NULL)
         OR ("status" = 'REJECTED' AND char_length(btrim(coalesce("rejectionReason", ''))) BETWEEN 1 AND 500
                                   AND char_length(coalesce("reviewedBy", '')) BETWEEN 1 AND 200
                                   AND "reviewedAt" IS NOT NULL AND "approvedAt" IS NULL)
       ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION recruiter_identity_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recruiter_identity_verifications rows cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."submission" <> 1 THEN
      RAISE EXCEPTION 'a recruiter identity starts as PENDING, submission 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."recruiterId" IS DISTINCT FROM OLD."recruiterId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'recruiter identity id / recruiterId / createdAt are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED'))
     OR (OLD."status" = 'APPROVED' AND NEW."status" = 'REJECTED') THEN
    -- a decision: the same submission and the same files
    IF NEW."submission" <> OLD."submission" OR NEW."cinFrontFile" <> OLD."cinFrontFile"
       OR NEW."cinBackFile" <> OLD."cinBackFile" OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
      RAISE EXCEPTION 'a recruiter identity decision cannot change the submission or its files' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'REJECTED' AND NEW."status" = 'PENDING' THEN
    -- a new upload: next submission, two new files
    IF NEW."submission" <> OLD."submission" + 1 OR NEW."cinFrontFile" IN (OLD."cinFrontFile", OLD."cinBackFile")
       OR NEW."cinBackFile" IN (OLD."cinFrontFile", OLD."cinBackFile") THEN
      RAISE EXCEPTION 'a recruiter identity resubmission needs the next submission number and two new files' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recruiter identity transition % → % refused', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_identity_verifications_guard" ON "recruiter_identity_verifications";
CREATE TRIGGER "recruiter_identity_verifications_guard" BEFORE INSERT OR UPDATE OR DELETE ON "recruiter_identity_verifications"
  FOR EACH ROW EXECUTE FUNCTION recruiter_identity_guard();
DROP TRIGGER IF EXISTS "recruiter_identity_verifications_no_truncate" ON "recruiter_identity_verifications";
CREATE TRIGGER "recruiter_identity_verifications_no_truncate" BEFORE TRUNCATE ON "recruiter_identity_verifications"
  FOR EACH STATEMENT EXECUTE FUNCTION recruiter_append_only();
