-- ─────────────────────────────────────────────────────────────────────────────
-- 20261030_brand_terms_consent — "Create Your Own Brand": immutable published
-- refund-terms versions and verifiable participant consent.
--
--   • brand_terms_versions   — one immutable row per published terms version
--                              (exact text + SHA-256 of its UTF-8 bytes)
--   • brand_access_consents  — append-only FRESH consents (separate evidence;
--                              the request's original snapshot is never touched)
--   • brand_accesses."termsTextSha256" — fingerprint of the accepted text, NEW
--                              requests only (legacy rows keep NULL: nothing is
--                              backfilled or fabricated)
--
-- Rules enforced here (and mirrored by the services):
--   • a new request's terms snapshot must match an immutable version exactly; its
--     acceptance time is written by the database (clock_timestamp, UTC, ms)
--   • a payment proof can only be inserted, and a request only activated, when
--     the request's ORIGINAL consent verifies — fresh consents never count
--   • a CLOSED request reopens only with verified original consent, or a fresh
--     REOPEN_RENEWAL consent to the latest published version
--   • versions and consents: no UPDATE, no DELETE, no TRUNCATE
--
-- Additive and re-runnable: IF NOT EXISTS, duplicate_object handlers, CREATE OR
-- REPLACE FUNCTION, triggers via CREATE OR REPLACE TRIGGER (PostgreSQL 14+) or
-- drop + create, backfill with ON CONFLICT DO NOTHING. No CONCURRENTLY and no
-- explicit transaction statements. Migrations 20261028 / 20261029 are unchanged;
-- their guard FUNCTIONS are redefined here (their triggers stay attached).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Fail fast: sha256(bytea) needs PostgreSQL 11+; hashes assume UTF-8 ─────
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 110000 THEN
    RAISE EXCEPTION '20261030_brand_terms_consent requires PostgreSQL 11 or later (found %)', current_setting('server_version');
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION '20261030_brand_terms_consent requires a UTF8 database (found %)', current_setting('server_encoding');
  END IF;
END $$;

-- Session-local helper (dropped with the session): replace a trigger without a
-- window where the table is unguarded when PostgreSQL supports it.
CREATE OR REPLACE FUNCTION pg_temp.brand_install_trigger(trigger_name text, table_name text, definition text)
RETURNS void AS $$
BEGIN
  IF current_setting('server_version_num')::int >= 140000 THEN
    EXECUTE format('CREATE OR REPLACE TRIGGER %I %s', trigger_name, definition);
  ELSE
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, table_name);
    EXECUTE format('CREATE TRIGGER %I %s', trigger_name, definition);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ── 1. Tables and column ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "brand_terms_versions" (
  "version"        INTEGER      NOT NULL,
  "text"           TEXT         NOT NULL,
  "textSha256"     TEXT         NOT NULL,
  "publishedAt"    TIMESTAMP(3) NOT NULL,
  "publishedBy"    TEXT,
  "publishAuditId" TEXT,
  "source"         TEXT         NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_terms_versions_pkey" PRIMARY KEY ("version")
);

CREATE TABLE IF NOT EXISTS "brand_access_consents" (
  "id"              TEXT         NOT NULL,
  "accessId"        TEXT         NOT NULL,
  "affiliateId"     TEXT         NOT NULL,
  "context"         TEXT         NOT NULL,
  "termsVersion"    INTEGER      NOT NULL,
  "termsTextSha256" TEXT         NOT NULL,
  "acceptedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "auditId"         TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_access_consents_pkey" PRIMARY KEY ("id")
);

-- Legacy rows keep NULL: no default, never backfilled.
ALTER TABLE "brand_accesses" ADD COLUMN IF NOT EXISTS "termsTextSha256" TEXT;

-- ── 2. Indexes, uniques, foreign key ─────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "brand_terms_versions_publishAuditId_key" ON "brand_terms_versions" ("publishAuditId");
CREATE UNIQUE INDEX IF NOT EXISTS "brand_access_consents_auditId_key"      ON "brand_access_consents" ("auditId");
CREATE INDEX        IF NOT EXISTS "brand_access_consents_accessId_idx"     ON "brand_access_consents" ("accessId");

DO $$ BEGIN
  ALTER TABLE "brand_access_consents" ADD CONSTRAINT "brand_access_consents_accessId_fkey"
    FOREIGN KEY ("accessId") REFERENCES "brand_accesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. CHECK constraints ─────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "brand_terms_versions" ADD CONSTRAINT "brand_terms_versions_values_check" CHECK (
    "version" >= 1
    AND btrim("text") <> ''
    AND "textSha256" = encode(sha256(convert_to("text", 'UTF8')), 'hex')
    AND "source" IN ('PUBLISH', 'BACKFILL_AUDIT', 'BACKFILL_SETTINGS')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_access_consents" ADD CONSTRAINT "brand_access_consents_values_check" CHECK (
    "context" IN ('PENDING_RENEWAL', 'REOPEN_RENEWAL')
    AND "termsVersion" >= 1
    AND "termsTextSha256" ~ '^[0-9a-f]{64}$'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "brand_accesses" ADD CONSTRAINT "brand_accesses_terms_sha256_check" CHECK (
    "termsTextSha256" IS NULL OR "termsTextSha256" ~ '^[0-9a-f]{64}$'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. Functions ─────────────────────────────────────────────────────────────

-- Strict UTC ISO-8601 timestamp ('YYYY-MM-DDTHH:MM:SS[.ffffff]Z') or NULL.
-- Rejects PostgreSQL's permissive inputs ('now', 'epoch', 'tomorrow', …) and
-- impossible dates; any other error is raised, never silently turned into NULL.
CREATE OR REPLACE FUNCTION "brand_iso_ts"(value text) RETURNS timestamptz AS $$
BEGIN
  IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Database time for consent evidence: the actual moment of the INSERT (not the
-- transaction start), in UTC, truncated to milliseconds once so that the JSON
-- snapshot and TIMESTAMP(3) columns hold exactly the same instant.
CREATE OR REPLACE FUNCTION "brand_db_now_ms"() RETURNS timestamp AS $$
  SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC');
$$ LANGUAGE sql VOLATILE;

-- Does this request's ORIGINAL consent verify against an immutable version?
-- Malformed snapshots return false (never an error); nothing is written.
CREATE OR REPLACE FUNCTION "brand_original_consent_ok"(a "brand_accesses") RETURNS boolean AS $$
DECLARE
  s jsonb := a."termsSnapshot";
  v "brand_terms_versions"%ROWTYPE;
BEGIN
  IF s IS NULL OR jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF jsonb_typeof(s -> 'version') IS DISTINCT FROM 'number'
     OR jsonb_typeof(s -> 'text') IS DISTINCT FROM 'string'
     OR jsonb_typeof(s -> 'acceptedAt') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  IF (s ->> 'version') !~ '^[0-9]{1,9}$' OR (s ->> 'version')::int IS DISTINCT FROM a."termsVersion" THEN
    RETURN false;
  END IF;
  SELECT * INTO v FROM "brand_terms_versions" WHERE "version" = a."termsVersion";
  IF NOT FOUND THEN RETURN false; END IF;
  IF (s ->> 'text') IS DISTINCT FROM v."text" THEN RETURN false; END IF;
  IF "brand_iso_ts"(s ->> 'acceptedAt') IS NULL THEN RETURN false; END IF;
  IF a."termsTextSha256" IS NOT NULL AND a."termsTextSha256" IS DISTINCT FROM v."textSha256" THEN RETURN false; END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

-- New request: the database writes the acceptance time, then the snapshot and
-- fingerprint must match an immutable published version exactly.
CREATE OR REPLACE FUNCTION "brand_access_consent_guard"() RETURNS trigger AS $$
DECLARE
  at_ms timestamp := "brand_db_now_ms"();
BEGIN
  IF NEW."termsSnapshot" IS NULL OR jsonb_typeof(NEW."termsSnapshot") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'BRC01',
      MESSAGE = 'brand_accesses: consent does not match an immutable published terms version';
  END IF;
  NEW."termsSnapshot" := jsonb_set(NEW."termsSnapshot", '{acceptedAt}',
    to_jsonb(to_char(at_ms, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
  IF NEW."termsTextSha256" IS NULL OR NOT "brand_original_consent_ok"(NEW) THEN
    RAISE EXCEPTION USING ERRCODE = 'BRC01',
      MESSAGE = 'brand_accesses: consent does not match an immutable published terms version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fresh consent: database time; the request must exist, belong to the affiliate,
-- be PENDING_PAYMENT (PENDING_RENEWAL) or CLOSED (REOPEN_RENEWAL), have an
-- unverifiable original consent, and the consent must match the LATEST version.
CREATE OR REPLACE FUNCTION "brand_access_consents_insert_guard"() RETURNS trigger AS $$
DECLARE
  acc "brand_accesses"%ROWTYPE;
BEGIN
  NEW."acceptedAt" := "brand_db_now_ms"();
  SELECT * INTO acc FROM "brand_accesses" WHERE "id" = NEW."accessId";
  IF NOT FOUND OR acc."affiliateId" IS DISTINCT FROM NEW."affiliateId"
     OR NOT ((acc."status" = 'PENDING_PAYMENT' AND NEW."context" = 'PENDING_RENEWAL')
          OR (acc."status" = 'CLOSED' AND NEW."context" = 'REOPEN_RENEWAL'))
     OR "brand_original_consent_ok"(acc)
     OR NOT EXISTS (
       SELECT 1 FROM "brand_terms_versions" v
        WHERE v."version" = NEW."termsVersion" AND v."textSha256" = NEW."termsTextSha256"
          AND v."version" = (SELECT max("version") FROM "brand_terms_versions")
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'BRC04',
      MESSAGE = 'brand_access_consents: a fresh consent is not allowed for this request or terms version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- brand_accesses: redefinition of the 20261029 guard. Changes: the fingerprint
-- is frozen; PENDING_PAYMENT → ACTIVE also needs verified ORIGINAL consent
-- (fresh consents never count); CLOSED → ACTIVE needs verified original consent
-- or a REOPEN_RENEWAL consent to the latest published version.
CREATE OR REPLACE FUNCTION "brand_access_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'brand_accesses rows cannot be deleted (DELETE rejected)';
  END IF;
  IF NEW."affiliateId" IS DISTINCT FROM OLD."affiliateId"
     OR NEW."brandName" IS DISTINCT FROM OLD."brandName"
     OR NEW."packageId" IS DISTINCT FROM OLD."packageId"
     OR NEW."packageSnapshot" IS DISTINCT FROM OLD."packageSnapshot"
     OR NEW."brandingOptionId" IS DISTINCT FROM OLD."brandingOptionId"
     OR NEW."brandingSnapshot" IS DISTINCT FROM OLD."brandingSnapshot"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."termsVersion" IS DISTINCT FROM OLD."termsVersion"
     OR NEW."termsSnapshot" IS DISTINCT FROM OLD."termsSnapshot"
     OR NEW."termsTextSha256" IS DISTINCT FROM OLD."termsTextSha256"
     OR NEW."selectedProducts" IS DISTINCT FROM OLD."selectedProducts"
     OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId"
     OR NEW."authorizationId" IS DISTINCT FROM OLD."authorizationId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'brand_accesses request snapshot is immutable (UPDATE of snapshot columns rejected)';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING_PAYMENT' AND NEW."status" IN ('ACTIVE', 'REJECTED', 'CANCELLED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'CLOSED')
    OR (OLD."status" = 'CLOSED' AND NEW."status" = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'brand_accesses: transition % → % is not allowed', OLD."status", NEW."status";
  END IF;
  IF OLD."status" = 'PENDING_PAYMENT' AND NEW."status" = 'ACTIVE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "brand_payment_proofs" WHERE "accessId" = NEW."id" AND "status" = 'ACCEPTED'
    ) THEN
      RAISE EXCEPTION 'brand_accesses: activation requires an accepted payment proof';
    END IF;
    IF NOT "brand_original_consent_ok"(NEW) THEN
      RAISE EXCEPTION USING ERRCODE = 'BRC02',
        MESSAGE = 'brand_accesses: activation requires verified original consent';
    END IF;
  END IF;
  IF OLD."status" = 'CLOSED' AND NEW."status" = 'ACTIVE'
     AND NOT "brand_original_consent_ok"(NEW)
     AND NOT EXISTS (
       SELECT 1 FROM "brand_access_consents" c
         JOIN "brand_terms_versions" v ON v."version" = c."termsVersion" AND v."textSha256" = c."termsTextSha256"
        WHERE c."accessId" = NEW."id" AND c."context" = 'REOPEN_RENEWAL'
          AND c."termsVersion" = (SELECT max("version") FROM "brand_terms_versions")
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'BRC03',
      MESSAGE = 'brand_accesses: reopening requires verified original consent or a renewal to the latest terms';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- brand_payment_proofs: redefinition of the 20261029 guard. Changes: the
-- "awaiting payment" refusal carries SQLSTATE BRP01, and a proof can only be
-- inserted when the request's ORIGINAL consent verifies (BRC02).
CREATE OR REPLACE FUNCTION "brand_payment_proofs_guard"() RETURNS trigger AS $$
DECLARE
  acc "brand_accesses"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'brand_payment_proofs rows cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    -- FOR SHARE: a concurrent cancellation / rejection of the request either
    -- waits for this proof (and then withdraws / rejects it) or wins first.
    SELECT * INTO acc FROM "brand_accesses" WHERE "id" = NEW."accessId" AND "status" = 'PENDING_PAYMENT' FOR SHARE;
    IF NEW."status" <> 'SUBMITTED' OR NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'BRP01',
        MESSAGE = 'brand_payment_proofs: a proof is submitted only for a request awaiting payment';
    END IF;
    IF NOT "brand_original_consent_ok"(acc) THEN
      RAISE EXCEPTION USING ERRCODE = 'BRC02',
        MESSAGE = 'brand_payment_proofs: payment requires verified original consent';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'SUBMITTED' OR NEW."status" NOT IN ('ACCEPTED', 'REJECTED', 'WITHDRAWN')
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."accessId" IS DISTINCT FROM OLD."accessId"
     OR NEW."fileKey" IS DISTINCT FROM OLD."fileKey" OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
     OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
     OR NEW."transferReference" IS DISTINCT FROM OLD."transferReference"
     OR NEW."transferReferenceNormalized" IS DISTINCT FROM OLD."transferReferenceNormalized"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'brand_payment_proofs: only one review of a submitted proof is allowed';
  END IF;
  IF NEW."status" = 'ACCEPTED' AND NOT EXISTS (
    SELECT 1 FROM "brand_accesses" WHERE "id" = NEW."accessId" AND "status" = 'PENDING_PAYMENT'
  ) THEN
    RAISE EXCEPTION 'brand_payment_proofs: a proof is accepted only while its request awaits payment';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 5. Triggers ──────────────────────────────────────────────────────────────
-- Evidence tables: no UPDATE, no DELETE, no TRUNCATE (brand_reject_mutation is
-- defined by 20261028).
SELECT pg_temp.brand_install_trigger('brand_terms_versions_append_only', 'brand_terms_versions',
  'BEFORE UPDATE OR DELETE ON "brand_terms_versions" FOR EACH ROW EXECUTE PROCEDURE "brand_reject_mutation"()');
SELECT pg_temp.brand_install_trigger('brand_terms_versions_no_truncate', 'brand_terms_versions',
  'BEFORE TRUNCATE ON "brand_terms_versions" FOR EACH STATEMENT EXECUTE PROCEDURE "brand_reject_mutation"()');
SELECT pg_temp.brand_install_trigger('brand_access_consents_append_only', 'brand_access_consents',
  'BEFORE UPDATE OR DELETE ON "brand_access_consents" FOR EACH ROW EXECUTE PROCEDURE "brand_reject_mutation"()');
SELECT pg_temp.brand_install_trigger('brand_access_consents_no_truncate', 'brand_access_consents',
  'BEFORE TRUNCATE ON "brand_access_consents" FOR EACH STATEMENT EXECUTE PROCEDURE "brand_reject_mutation"()');
SELECT pg_temp.brand_install_trigger('brand_access_consents_insert_guard', 'brand_access_consents',
  'BEFORE INSERT ON "brand_access_consents" FOR EACH ROW EXECUTE PROCEDURE "brand_access_consents_insert_guard"()');
SELECT pg_temp.brand_install_trigger('brand_accesses_consent_guard', 'brand_accesses',
  'BEFORE INSERT ON "brand_accesses" FOR EACH ROW EXECUTE PROCEDURE "brand_access_consent_guard"()');

-- ── 6. Backfill of published versions (strict provenance) ────────────────────
-- Candidates: TERMS_PUBLISHED audit rows with a positive integer version and a
-- non-blank text, and the current settings value brand-refund-terms.published.
--   • audit only, identical texts            → BACKFILL_AUDIT (earliest row)
--   • audit texts differ                     → skipped (conflict)
--   • settings + audit, texts differ         → skipped (conflict)
--   • settings only                          → BACKFILL_SETTINGS only if its
--     version is above every audited version, publishedAt parses strictly and
--     nothing conflicts; otherwise skipped
-- Request rows are never written. Every decision is reported (NOTICE).
DO $$
DECLARE
  g record;
  s jsonb;
  s_ok boolean := false;
  s_version int;
  s_text text;
  s_published timestamptz;
  max_audited int;
  invalid_audit int;
  n int;
BEGIN
  SELECT count(*) INTO invalid_audit FROM "brand_audit_log"
   WHERE "action" = 'TERMS_PUBLISHED' AND NOT (
     jsonb_typeof("after") IS NOT DISTINCT FROM 'object'
     AND jsonb_typeof("after" -> 'version') IS NOT DISTINCT FROM 'number'
     AND ("after" ->> 'version') ~ '^[1-9][0-9]{0,8}$'
     AND jsonb_typeof("after" -> 'text') IS NOT DISTINCT FROM 'string'
     AND btrim("after" ->> 'text') <> '');
  IF invalid_audit > 0 THEN
    RAISE NOTICE 'brand terms backfill: % TERMS_PUBLISHED audit row(s) skipped (invalid version or missing text)', invalid_audit;
  END IF;

  SELECT "data" -> 'published' INTO s FROM "settings" WHERE "id" = 'brand-refund-terms';
  IF s IS NOT NULL AND jsonb_typeof(s) = 'object'
     AND jsonb_typeof(s -> 'version') IS NOT DISTINCT FROM 'number' AND (s ->> 'version') ~ '^[1-9][0-9]{0,8}$'
     AND jsonb_typeof(s -> 'text') IS NOT DISTINCT FROM 'string' AND btrim(s ->> 'text') <> '' THEN
    s_ok := true;
    s_version := (s ->> 'version')::int;
    s_text := s ->> 'text';
    s_published := "brand_iso_ts"(s ->> 'publishedAt');
  ELSIF s IS NOT NULL AND s <> 'null'::jsonb THEN
    RAISE NOTICE 'brand terms backfill: settings published value skipped (invalid version or missing text)';
  END IF;

  FOR g IN
    SELECT ("after" ->> 'version')::int AS version,
           count(DISTINCT "after" ->> 'text') AS texts,
           (array_agg("after" ->> 'text' ORDER BY "createdAt", "id"))[1] AS text,
           (array_agg("createdAt" ORDER BY "createdAt", "id"))[1] AS published_at,
           (array_agg("id" ORDER BY "createdAt", "id"))[1] AS audit_id,
           (array_agg("actorId" ORDER BY "createdAt", "id"))[1] AS actor_id
      FROM "brand_audit_log"
     WHERE "action" = 'TERMS_PUBLISHED'
       AND jsonb_typeof("after") IS NOT DISTINCT FROM 'object'
       AND jsonb_typeof("after" -> 'version') IS NOT DISTINCT FROM 'number'
       AND ("after" ->> 'version') ~ '^[1-9][0-9]{0,8}$'
       AND jsonb_typeof("after" -> 'text') IS NOT DISTINCT FROM 'string'
       AND btrim("after" ->> 'text') <> ''
     GROUP BY 1
     ORDER BY 1
  LOOP
    IF g.texts > 1 THEN
      RAISE NOTICE 'brand terms backfill: version % skipped (conflicting audit texts)', g.version;
    ELSIF s_ok AND s_version = g.version AND s_text IS DISTINCT FROM g.text THEN
      RAISE NOTICE 'brand terms backfill: version % skipped (settings text differs from audit text)', g.version;
    ELSE
      INSERT INTO "brand_terms_versions" ("version", "text", "textSha256", "publishedAt", "publishedBy", "publishAuditId", "source")
      VALUES (g.version, g.text, encode(sha256(convert_to(g.text, 'UTF8')), 'hex'), g.published_at, g.actor_id, g.audit_id, 'BACKFILL_AUDIT')
      ON CONFLICT ("version") DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE NOTICE 'brand terms backfill: version % %', g.version, CASE WHEN n = 1 THEN 'inserted from audit' ELSE 'already present' END;
    END IF;
  END LOOP;

  IF s_ok AND NOT EXISTS (
    SELECT 1 FROM "brand_audit_log"
     WHERE "action" = 'TERMS_PUBLISHED' AND jsonb_typeof("after" -> 'version') IS NOT DISTINCT FROM 'number'
       AND ("after" ->> 'version') = s_version::text
  ) THEN
    SELECT max(("after" ->> 'version')::int) INTO max_audited FROM "brand_audit_log"
     WHERE "action" = 'TERMS_PUBLISHED' AND jsonb_typeof("after" -> 'version') IS NOT DISTINCT FROM 'number'
       AND ("after" ->> 'version') ~ '^[1-9][0-9]{0,8}$';
    IF max_audited IS NOT NULL AND s_version <= max_audited THEN
      RAISE NOTICE 'brand terms backfill: settings version % skipped (not above the highest audited version %)', s_version, max_audited;
    ELSIF s_published IS NULL THEN
      RAISE NOTICE 'brand terms backfill: settings version % skipped (publishedAt missing or not a strict UTC timestamp)', s_version;
    ELSE
      INSERT INTO "brand_terms_versions" ("version", "text", "textSha256", "publishedAt", "publishedBy", "publishAuditId", "source")
      VALUES (s_version, s_text, encode(sha256(convert_to(s_text, 'UTF8')), 'hex'), s_published AT TIME ZONE 'UTC',
              CASE WHEN jsonb_typeof(s -> 'publishedBy') = 'string' THEN s ->> 'publishedBy' END, NULL, 'BACKFILL_SETTINGS')
      ON CONFLICT ("version") DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE NOTICE 'brand terms backfill: settings version % %', s_version, CASE WHEN n = 1 THEN 'inserted (no audit row; flagged BACKFILL_SETTINGS)' ELSE 'already present' END;
    END IF;
  END IF;
END $$;

-- ── 7. Read-only report ──────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT "version", "source" FROM "brand_terms_versions" ORDER BY "version" LOOP
    RAISE NOTICE 'brand terms version %: %', r."version", r."source";
  END LOOP;
  FOR r IN
    SELECT a."status", count(*) AS total,
           count(*) FILTER (WHERE a."termsTextSha256" IS NULL) AS no_fingerprint,
           count(*) FILTER (WHERE "brand_original_consent_ok"(a)) AS verified
      FROM "brand_accesses" a GROUP BY a."status" ORDER BY a."status"
  LOOP
    RAISE NOTICE 'brand requests %: total %, without fingerprint %, original consent verified %', r."status", r.total, r.no_fingerprint, r.verified;
  END LOOP;
END $$;
