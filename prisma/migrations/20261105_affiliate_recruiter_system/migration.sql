-- ─────────────────────────────────────────────────────────────────────────────
-- 20261105_affiliate_recruiter_system — Affiliate Recruiter System, Phase 1 (schema).
--
--   • recruiters                    — recruiter accounts (separate principal: own
--                                      credentials; never a User role, never an Affiliate)
--   • recruiter_affiliate_links     — the recruiter who CREATED an affiliate (one per
--                                      affiliate). Insertable only in the transaction that
--                                      creates that inactive affiliate (no assignment of
--                                      existing affiliates); immutable afterwards
--   • recruiter_reward_ledger       — append-only recruiter rewards in MAD cents only
--                                      (separate from every affiliate balance / commission /
--                                      reward point / payout); one reward per affiliate
--   • recruiter_audit_log           — append-only audit trail
--   • recruiter_settings_versions   — append-only, consecutive settings versions set by the
--                                      admin: reward amount (MAD cents) + the number of real
--                                      delivered orders required (default 10). The reward also
--                                      requires the existing CIN approval (IdentityVerification
--                                      status APPROVED), checked by the application
--
-- Additive only: five new tables with their constraints, indexes and triggers, and
-- foreign keys TO "affiliates"(id) (ON DELETE RESTRICT). No existing table, column,
-- row, constraint or trigger is changed; nothing is backfilled; no default settings
-- row is inserted (the application falls back to built-in defaults: rewards OFF).
-- Re-runnable: IF NOT EXISTS, duplicate_object handlers, CREATE OR REPLACE FUNCTION,
-- triggers via DROP IF EXISTS + CREATE. No explicit transaction.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "recruiters" (
  "id"                  TEXT         NOT NULL,
  "username"            TEXT         NOT NULL,
  "name"                TEXT         NOT NULL,
  "phone"               TEXT,
  "passwordHash"        TEXT         NOT NULL,
  "isActive"            BOOLEAN      NOT NULL DEFAULT true,
  "canCreateAffiliates" BOOLEAN      NOT NULL DEFAULT true,
  "canViewOrders"       BOOLEAN      NOT NULL DEFAULT true,
  "disabledAt"          TIMESTAMP(3),
  "disabledBy"          TEXT,
  "disabledReason"      TEXT,
  "lastLoginAt"         TIMESTAMP(3),
  "createdBy"           TEXT         NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recruiters_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "recruiter_affiliate_links" (
  "affiliateId" TEXT         NOT NULL,
  "recruiterId" TEXT         NOT NULL,
  "createdBy"   TEXT         NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recruiter_affiliate_links_pkey" PRIMARY KEY ("affiliateId")
);

CREATE TABLE IF NOT EXISTS "recruiter_reward_ledger" (
  "id"              TEXT         NOT NULL,
  "seq"             BIGSERIAL    NOT NULL,
  "recruiterId"     TEXT         NOT NULL,
  "affiliateId"     TEXT,
  "type"            TEXT         NOT NULL,
  "amountCents"     INTEGER      NOT NULL,
  "idempotencyKey"  TEXT         NOT NULL,
  "reason"          TEXT,
  "actorType"       TEXT         NOT NULL,
  "actorId"         TEXT,
  "settingsVersion" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recruiter_reward_ledger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "recruiter_audit_log" (
  "id"          TEXT         NOT NULL,
  "seq"         BIGSERIAL    NOT NULL,
  "recruiterId" TEXT,
  "actorType"   TEXT         NOT NULL,
  "actorId"     TEXT         NOT NULL,
  "action"      TEXT         NOT NULL,
  "entityType"  TEXT,
  "entityId"    TEXT,
  "details"     JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recruiter_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "recruiter_settings_versions" (
  "version"           INTEGER      NOT NULL,
  "enabled"           BOOLEAN      NOT NULL,
  "rewardAmountCents" INTEGER      NOT NULL,
  "minDeliveredSales" INTEGER      NOT NULL,
  "createdBy"         TEXT         NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recruiter_settings_versions_pkey" PRIMARY KEY ("version")
);

-- ── 2. Constraints ───────────────────────────────────────────────────────────
-- recruiters
DO $$ BEGIN
  ALTER TABLE "recruiters" ADD CONSTRAINT "recruiters_username_check"
    CHECK ("username" ~ '^[a-z0-9][a-z0-9._-]{2,39}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiters" ADD CONSTRAINT "recruiters_name_check"
    CHECK (char_length(btrim("name")) BETWEEN 2 AND 80);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- bcrypt hashes only (never a plaintext password)
  ALTER TABLE "recruiters" ADD CONSTRAINT "recruiters_password_hash_check"
    CHECK ("passwordHash" ~ '^\$2[aby]\$[0-9]{2}\$.{53}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- an inactive recruiter carries when / by whom it was disabled
  ALTER TABLE "recruiters" ADD CONSTRAINT "recruiters_disabled_check"
    CHECK ("isActive" OR ("disabledAt" IS NOT NULL AND "disabledBy" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recruiter_affiliate_links
DO $$ BEGIN
  ALTER TABLE "recruiter_affiliate_links" ADD CONSTRAINT "recruiter_affiliate_links_createdBy_check"
    CHECK (char_length("createdBy") > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiter_affiliate_links" ADD CONSTRAINT "recruiter_affiliate_links_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiter_affiliate_links" ADD CONSTRAINT "recruiter_affiliate_links_recruiterId_fkey"
    FOREIGN KEY ("recruiterId") REFERENCES "recruiters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recruiter_reward_ledger (MAD cents only)
DO $$ BEGIN
  ALTER TABLE "recruiter_reward_ledger" ADD CONSTRAINT "recruiter_reward_ledger_type_check"
    CHECK ("type" IN ('RECRUIT_REWARD', 'REVERSAL', 'ADMIN_ADJUSTMENT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiter_reward_ledger" ADD CONSTRAINT "recruiter_reward_ledger_actor_check"
    CHECK ("actorType" IN ('SYSTEM', 'ADMIN') AND ("actorType" = 'SYSTEM' OR "actorId" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- sign rules: a recruit reward is positive, a reversal negative, an adjustment non-zero
  -- (and carries a reason); recruit rewards and reversals always name the affiliate.
  ALTER TABLE "recruiter_reward_ledger" ADD CONSTRAINT "recruiter_reward_ledger_amount_check"
    CHECK ("amountCents" <> 0 AND abs("amountCents") <= 100000000
       AND ("type" <> 'RECRUIT_REWARD' OR ("amountCents" > 0 AND "affiliateId" IS NOT NULL AND "settingsVersion" IS NOT NULL))
       AND ("type" <> 'REVERSAL' OR ("amountCents" < 0 AND "affiliateId" IS NOT NULL))
       AND ("type" <> 'ADMIN_ADJUSTMENT' OR ("actorType" = 'ADMIN' AND char_length(btrim(coalesce("reason", ''))) > 0)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiter_reward_ledger" ADD CONSTRAINT "recruiter_reward_ledger_recruiterId_fkey"
    FOREIGN KEY ("recruiterId") REFERENCES "recruiters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiter_reward_ledger" ADD CONSTRAINT "recruiter_reward_ledger_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recruiter_audit_log
DO $$ BEGIN
  ALTER TABLE "recruiter_audit_log" ADD CONSTRAINT "recruiter_audit_log_actor_check"
    CHECK ("actorType" IN ('RECRUITER', 'ADMIN', 'SYSTEM') AND char_length("actorId") > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiter_audit_log" ADD CONSTRAINT "recruiter_audit_log_action_check"
    CHECK ("action" ~ '^[A-Z][A-Z_]{2,59}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recruiter_audit_log" ADD CONSTRAINT "recruiter_audit_log_recruiterId_fkey"
    FOREIGN KEY ("recruiterId") REFERENCES "recruiters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recruiter_settings_versions
DO $$ BEGIN
  ALTER TABLE "recruiter_settings_versions" ADD CONSTRAINT "recruiter_settings_versions_check"
    CHECK ("version" >= 1
       AND "rewardAmountCents" >= 0 AND "rewardAmountCents" <= 100000000
       -- at least one real delivered order is always required (the default is 10)
       AND "minDeliveredSales" BETWEEN 1 AND 100000
       -- rewards enabled ⇒ an amount
       AND (NOT "enabled" OR "rewardAmountCents" > 0)
       AND char_length("createdBy") > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "recruiters_username_key" ON "recruiters"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "recruiters_phone_key"    ON "recruiters"("phone");
CREATE INDEX IF NOT EXISTS "recruiters_isActive_idx"        ON "recruiters"("isActive");
CREATE INDEX IF NOT EXISTS "recruiter_affiliate_links_recruiterId_createdAt_idx" ON "recruiter_affiliate_links"("recruiterId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_seq_key"            ON "recruiter_reward_ledger"("seq");
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_idempotencyKey_key" ON "recruiter_reward_ledger"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "recruiter_reward_ledger_recruiterId_createdAt_idx" ON "recruiter_reward_ledger"("recruiterId", "createdAt");
CREATE INDEX IF NOT EXISTS "recruiter_reward_ledger_affiliateId_idx"           ON "recruiter_reward_ledger"("affiliateId");
-- one recruit reward and at most one reversal per affiliate, whatever the idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_recruit_per_affiliate"
  ON "recruiter_reward_ledger"("affiliateId") WHERE "type" = 'RECRUIT_REWARD';
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_reversal_per_affiliate"
  ON "recruiter_reward_ledger"("affiliateId") WHERE "type" = 'REVERSAL';
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_audit_log_seq_key" ON "recruiter_audit_log"("seq");
CREATE INDEX IF NOT EXISTS "recruiter_audit_log_recruiterId_createdAt_idx" ON "recruiter_audit_log"("recruiterId", "createdAt");
CREATE INDEX IF NOT EXISTS "recruiter_audit_log_entityType_entityId_idx"   ON "recruiter_audit_log"("entityType", "entityId");

-- ── 4. Guards ────────────────────────────────────────────────────────────────
-- Generic append-only guard (links, ledger, audit log, settings versions).
CREATE OR REPLACE FUNCTION recruiter_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_affiliate_links_immutable" ON "recruiter_affiliate_links";
CREATE TRIGGER "recruiter_affiliate_links_immutable" BEFORE UPDATE OR DELETE ON "recruiter_affiliate_links"
  FOR EACH ROW EXECUTE FUNCTION recruiter_append_only();
DROP TRIGGER IF EXISTS "recruiter_affiliate_links_no_truncate" ON "recruiter_affiliate_links";
CREATE TRIGGER "recruiter_affiliate_links_no_truncate" BEFORE TRUNCATE ON "recruiter_affiliate_links"
  FOR EACH STATEMENT EXECUTE FUNCTION recruiter_append_only();

DROP TRIGGER IF EXISTS "recruiter_reward_ledger_append_only" ON "recruiter_reward_ledger";
CREATE TRIGGER "recruiter_reward_ledger_append_only" BEFORE UPDATE OR DELETE ON "recruiter_reward_ledger"
  FOR EACH ROW EXECUTE FUNCTION recruiter_append_only();
DROP TRIGGER IF EXISTS "recruiter_reward_ledger_no_truncate" ON "recruiter_reward_ledger";
CREATE TRIGGER "recruiter_reward_ledger_no_truncate" BEFORE TRUNCATE ON "recruiter_reward_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION recruiter_append_only();

DROP TRIGGER IF EXISTS "recruiter_audit_log_append_only" ON "recruiter_audit_log";
CREATE TRIGGER "recruiter_audit_log_append_only" BEFORE UPDATE OR DELETE ON "recruiter_audit_log"
  FOR EACH ROW EXECUTE FUNCTION recruiter_append_only();
DROP TRIGGER IF EXISTS "recruiter_audit_log_no_truncate" ON "recruiter_audit_log";
CREATE TRIGGER "recruiter_audit_log_no_truncate" BEFORE TRUNCATE ON "recruiter_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION recruiter_append_only();

DROP TRIGGER IF EXISTS "recruiter_settings_versions_append_only" ON "recruiter_settings_versions";
CREATE TRIGGER "recruiter_settings_versions_append_only" BEFORE UPDATE OR DELETE ON "recruiter_settings_versions"
  FOR EACH ROW EXECUTE FUNCTION recruiter_append_only();
DROP TRIGGER IF EXISTS "recruiter_settings_versions_no_truncate" ON "recruiter_settings_versions";
CREATE TRIGGER "recruiter_settings_versions_no_truncate" BEFORE TRUNCATE ON "recruiter_settings_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION recruiter_append_only();

-- No assignment of existing affiliates (defence in depth — the recruiter service creates
-- the affiliate and its link in ONE transaction and has no "link an existing affiliate"
-- path at all). At the database level a link is accepted only when the affiliate row:
--   • was written in the CURRENT transaction (its xmin is the current transaction id),
--   • is still inactive (pending verification), and
--   • was created at most 2 minutes ago — "createdAt" is a UTC wall-clock timestamp
--     (Prisma), so it is compared with now() in UTC, whatever the session TimeZone.
-- Known limits (documented, not reachable through the application): a code path that
-- rewrites an existing affiliate's "createdAt" or touches a < 2-minute-old affiliate in
-- the linking transaction could pass; an affiliate inserted inside a SAVEPOINT carries a
-- sub-transaction xmin and is refused (fail closed). Closing these at the database level
-- would require a trigger on "affiliates", which this feature must not add.
CREATE OR REPLACE FUNCTION recruiter_link_new_affiliate_only() RETURNS trigger AS $$
DECLARE a RECORD;
BEGIN
  SELECT "isActive", "createdAt", (xmin::text = (txid_current() % 4294967296)::text) AS in_this_tx
    INTO a FROM "affiliates" WHERE "id" = NEW."affiliateId";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the unknown affiliate
  END IF;
  IF NOT a.in_this_tx OR a."isActive"
     OR a."createdAt" < ((now() AT TIME ZONE 'UTC') - interval '2 minutes')
     OR a."createdAt" > ((now() AT TIME ZONE 'UTC') + interval '1 minute') THEN
    RAISE EXCEPTION 'affiliate % can only be linked to a recruiter when it is created (inactive) in the same transaction', NEW."affiliateId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_affiliate_links_new_only" ON "recruiter_affiliate_links";
CREATE TRIGGER "recruiter_affiliate_links_new_only" BEFORE INSERT ON "recruiter_affiliate_links"
  FOR EACH ROW EXECUTE FUNCTION recruiter_link_new_affiliate_only();

-- Settings versions must be consecutive (1, 2, 3, …): no gap, no rewriting history.
CREATE OR REPLACE FUNCTION recruiter_settings_next_version() RETURNS trigger AS $$
DECLARE expected INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('recruiter_settings_versions'));
  SELECT coalesce(max("version"), 0) + 1 INTO expected FROM "recruiter_settings_versions";
  IF NEW."version" <> expected THEN
    RAISE EXCEPTION 'recruiter settings version must be % (got %)', expected, NEW."version" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_settings_versions_consecutive" ON "recruiter_settings_versions";
CREATE TRIGGER "recruiter_settings_versions_consecutive" BEFORE INSERT ON "recruiter_settings_versions"
  FOR EACH ROW EXECUTE FUNCTION recruiter_settings_next_version();

-- A reversal needs an earlier recruit reward of the SAME recruiter for that affiliate
-- and cannot exceed it.
CREATE OR REPLACE FUNCTION recruiter_reward_reversal_guard() RETURNS trigger AS $$
DECLARE original INTEGER;
BEGIN
  IF NEW."type" = 'REVERSAL' THEN
    SELECT "amountCents" INTO original FROM "recruiter_reward_ledger"
      WHERE "type" = 'RECRUIT_REWARD' AND "affiliateId" = NEW."affiliateId" AND "recruiterId" = NEW."recruiterId";
    IF original IS NULL OR -NEW."amountCents" > original THEN
      RAISE EXCEPTION 'a reversal needs an earlier recruit reward of the same recruiter and cannot exceed it' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_reward_ledger_reversal_guard" ON "recruiter_reward_ledger";
CREATE TRIGGER "recruiter_reward_ledger_reversal_guard" BEFORE INSERT ON "recruiter_reward_ledger"
  FOR EACH ROW EXECUTE FUNCTION recruiter_reward_reversal_guard();

-- A recruit reward / reversal must belong to the recruiter who created the affiliate.
CREATE OR REPLACE FUNCTION recruiter_reward_link_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."affiliateId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "recruiter_affiliate_links" l WHERE l."affiliateId" = NEW."affiliateId" AND l."recruiterId" = NEW."recruiterId"
  ) THEN
    RAISE EXCEPTION 'affiliate % is not linked to recruiter %', NEW."affiliateId", NEW."recruiterId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_reward_ledger_link_guard" ON "recruiter_reward_ledger";
CREATE TRIGGER "recruiter_reward_ledger_link_guard" BEFORE INSERT ON "recruiter_reward_ledger"
  FOR EACH ROW EXECUTE FUNCTION recruiter_reward_link_guard();
