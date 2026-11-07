-- ─────────────────────────────────────────────────────────────────────────────
-- 20261112_recruiter_group_rewards — Phase 7 (Reward B: the recruiter GROUP reward).
--
-- Reward A (one reward per qualified affiliate, cycles per affiliate — 20261110) is unchanged.
-- Reward B: a recruiter earns the group amount each time `groupSize` DISTINCT affiliates of that
-- recruiter's network (the affiliates it OWNS — see Phase 7 Stage E below) are each qualified (real
-- delivered orders ≥ groupMinDeliveredSales AND identity APPROVED — computed by the application).
-- Group CYCLES are per recruiter:
--   cycle n = one GROUP_REWARD (key group:<recruiterId>:v<n>) and, if the recruiter later holds
--   more active group rewards than its qualified affiliates allow (judged with THAT reward's own
--   settings version), one compensating GROUP_REVERSAL (key group-reverse:<recruiterId>:v<n>,
--   amount = −the reward). Several group cycles can be active at once (floor(qualified / size)).
--
--   • recruiter_settings_versions: + "groupEnabled" (false), "groupRewardAmountCents" (0),
--     "groupSize" (10), "groupMinDeliveredSales" (10) — NOT NULL with constant defaults: a
--     metadata-only ADD COLUMN; every existing (append-only) row reads the defaults, nothing is
--     updated. CHECK recruiter_settings_versions_group_check: amount 0..100000000 cents, enabled ⇒
--     amount > 0, groupSize 1..10000, groupMinDeliveredSales 1..100000 (= minDeliveredSales range).
--   • recruiter_reward_ledger:
--       – type CHECK replaced (same name) to also allow GROUP_REWARD / GROUP_REVERSAL;
--       – recruiter_reward_ledger_group_check: GROUP_REWARD > 0, GROUP_REVERSAL < 0, both with
--         affiliateId NULL, settingsVersion NOT NULL and the exact cycle key;
--       – one GROUP_REWARD and one GROUP_REVERSAL per (recruiterId, cycle) (partial unique indexes);
--       – recruiter_group_cycle_guard (BEFORE INSERT, under pg_advisory_xact_lock(hashtext(
--         'recruiter-group:' || recruiterId)) — the same key as the application lock):
--           GROUP_REWARD cycle n:   n = (highest group reward cycle of the recruiter) + 1;
--           GROUP_REVERSAL cycle n: the GROUP_REWARD of the same recruiter and cycle exists, is not
--                                   reversed yet, −amount ≤ its amount, same settingsVersion.
--     The existing guards keep working unchanged: append-only (UPDATE / DELETE / TRUNCATE refused),
--     the per-affiliate cycle guard returns early for any other type, and the link guard skips a
--     NULL affiliateId; the amount / cycle CHECKs only constrain their own types.
--
--
-- Phase 7 Stage E (approved product rule — OWNERSHIP; added to THIS not-yet-deployed migration, which
-- has only ever been applied to disposable clones, instead of a new migration file; its precedence was
-- changed by Stage F below — the TOPMOST link wins, the text of this paragraph is kept as history):
--   owner(X) = the recruiter of the NEAREST affiliate at or above X (X, its parent, grandparent…
--   through affiliates."parentId") that has a recruiter_affiliate_links row — exactly one owner or
--   none. Rewards (A and B) are computed for every affiliate the recruiter OWNS, linked to it or
--   invited below one of its affiliates (unlimited depth); a descendant linked to another recruiter
--   belongs to that recruiter with its subtree. [Superseded by Stage F.]
--   • recruiter_reward_link_guard (20261105 — required a DIRECT link) is replaced (CREATE OR REPLACE,
--     same trigger recruiter_reward_ledger_link_guard): a ledger row with an affiliate is accepted
--     when owner(affiliate) = NEW."recruiterId", found by ONE upward recursive walk (primary-key
--     lookups; UNION, so a parent cycle without a link ends after one lap — bounded by the number of
--     affiliates on the chain, it never loops). A REVERSAL is also accepted when the same recruiter
--     holds a RECRUIT_REWARD of that affiliate (the cycle guard then requires exactly the open cycle
--     of that recruiter): an earned reward can always be compensated, even if the chain above the
--     affiliate later changed (an unlinked intermediate affiliate hard-deleted — parentId SET NULL).
--     Every row the former guard accepted (a direct link) is accepted (the nearest link of a linked
--     affiliate is its own). Rows without an affiliate (group rows) are untouched, as before.
--   • No other trigger / CHECK assumes a direct link: recruiter_link_new_affiliate_only only governs
--     link creation (unchanged: links are only created for brand-new affiliates), the cycle guards
--     compare a reversal with its own reward, the CHECKs never read links.
--
-- Phase 7 Stage F (approved product clarification — the TOPMOST link wins; added to THIS still
-- not-yet-deployed migration, like Stage E):
--   owner(X) = the recruiter of the TOPMOST linked affiliate of X's chain (X, its parent, grandparent…
--   through affiliates."parentId", up to the top). Once a recruiter owns a network, EVERY descendant
--   belongs to it at any depth; a nested link to another recruiter never transfers ownership (such a
--   legacy link is a CONFLICT: reported read-only — docs/performance/production-index-checklist.sql
--   section 5 and recruiterRewardService.listRecruiterOwnershipConflicts — never reassigned or modified).
--   A chain without a top (a parent cycle — corrupt data): owner = the one recruiter of every link met
--   on the cycle-safe walk; several recruiters → no owner (a conflict).
--   • recruiter_affiliate_owner(text) — the rule above, in ONE place for both guards: a cycle-safe UNION
--     walk to the top (primary-key lookups); one recruiter on the chain → it; several on a chain with a
--     top → a second walk bounded by the chain length finds the topmost link; several on a cycle → NULL.
--   • recruiter_reward_link_guard (§4) — now owner(affiliate) by that function; a REVERSAL is still
--     accepted when the same recruiter holds a RECRUIT_REWARD of that affiliate (legacy rows of a
--     recruiter that no longer owns the affiliate stay reversible). A NEW reward for an affiliate of a
--     nested legacy link now goes to the topmost link's recruiter only (the Stage E sentence "every row
--     the former guard accepted is accepted" no longer holds for such links). The trigger only checks
--     inserts: existing rows are never re-checked or rewritten.
--   • recruiter_link_owner_guard (§5, BEFORE INSERT on recruiter_affiliate_links, in addition to
--     recruiter_link_new_affiliate_only): a link is refused when the new affiliate's chain already has
--     an owner other than NEW."recruiterId" — another recruiter can never be assigned inside an owned
--     network (the application refuses earlier: PARENT_NOT_IN_NETWORK).
--   • affiliates_children_delete_guard (§6, BEFORE DELETE on affiliates): an affiliate that still has
--     children (any affiliate with "parentId" = its id) cannot be deleted (check_violation, message
--     AFFILIATE_HAS_CHILDREN) — deleting an intermediate affiliate would detach (ON DELETE SET NULL)
--     and re-own its subtree. The row is locked FOR UPDATE first, so a concurrent child insert (which
--     holds FOR KEY SHARE on the parent until it commits) is either seen or fails on the missing parent.
--     The parentId foreign key itself is NOT altered (no committed migration creates it).
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, duplicate_object handlers, DROP CONSTRAINT IF EXISTS +
-- ADD in one statement, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE. CHECKs are
-- added NOT VALID then validated. No row is inserted, updated or deleted. No explicit transaction.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Settings: the group-reward fields of each version ────────────────────
ALTER TABLE "recruiter_settings_versions" ADD COLUMN IF NOT EXISTS "groupEnabled"           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "recruiter_settings_versions" ADD COLUMN IF NOT EXISTS "groupRewardAmountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "recruiter_settings_versions" ADD COLUMN IF NOT EXISTS "groupSize"              INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "recruiter_settings_versions" ADD COLUMN IF NOT EXISTS "groupMinDeliveredSales" INTEGER NOT NULL DEFAULT 10;

DO $$ BEGIN
  ALTER TABLE "recruiter_settings_versions" ADD CONSTRAINT "recruiter_settings_versions_group_check"
    CHECK ("groupRewardAmountCents" >= 0 AND "groupRewardAmountCents" <= 100000000
       -- group rewards enabled ⇒ an amount
       AND (NOT "groupEnabled" OR "groupRewardAmountCents" > 0)
       AND "groupSize" BETWEEN 1 AND 10000
       AND "groupMinDeliveredSales" BETWEEN 1 AND 100000) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "recruiter_settings_versions" VALIDATE CONSTRAINT "recruiter_settings_versions_group_check";

-- ── 2. Ledger: the two group types ──────────────────────────────────────────
ALTER TABLE "recruiter_reward_ledger"
  DROP CONSTRAINT IF EXISTS "recruiter_reward_ledger_type_check",
  ADD CONSTRAINT "recruiter_reward_ledger_type_check"
    CHECK ("type" IN ('RECRUIT_REWARD', 'REVERSAL', 'ADMIN_ADJUSTMENT', 'GROUP_REWARD', 'GROUP_REVERSAL')) NOT VALID;
ALTER TABLE "recruiter_reward_ledger" VALIDATE CONSTRAINT "recruiter_reward_ledger_type_check";

DO $$ BEGIN
  -- sign rules + exact per-recruiter cycle keys of the group rows (no affiliate: the reward belongs
  -- to the recruiter's group of qualified affiliates, never to one affiliate)
  ALTER TABLE "recruiter_reward_ledger" ADD CONSTRAINT "recruiter_reward_ledger_group_check"
    CHECK (("type" <> 'GROUP_REWARD' OR ("amountCents" > 0 AND "affiliateId" IS NULL AND "settingsVersion" IS NOT NULL
                                         AND "idempotencyKey" = 'group:' || "recruiterId" || ':v' || "cycle"))
       AND ("type" <> 'GROUP_REVERSAL' OR ("amountCents" < 0 AND "affiliateId" IS NULL AND "settingsVersion" IS NOT NULL
                                         AND "idempotencyKey" = 'group-reverse:' || "recruiterId" || ':v' || "cycle"))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "recruiter_reward_ledger" VALIDATE CONSTRAINT "recruiter_reward_ledger_group_check";

-- one group reward / one group reversal per (recruiter, cycle)
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_group_reward_per_cycle"
  ON "recruiter_reward_ledger"("recruiterId", "cycle") WHERE "type" = 'GROUP_REWARD';
CREATE UNIQUE INDEX IF NOT EXISTS "recruiter_reward_ledger_one_group_reversal_per_cycle"
  ON "recruiter_reward_ledger"("recruiterId", "cycle") WHERE "type" = 'GROUP_REVERSAL';

-- ── 3. Group cycle guard ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recruiter_group_cycle_guard() RETURNS trigger AS $$
DECLARE
  max_reward  INTEGER;
  rw_amount   INTEGER;
  rw_version  INTEGER;
  is_reversed BOOLEAN;
BEGIN
  IF NEW."type" NOT IN ('GROUP_REWARD', 'GROUP_REVERSAL') THEN
    RETURN NEW;
  END IF;
  -- the same lock key as the application (src/lib/services/recruiterRewardService.js)
  PERFORM pg_advisory_xact_lock(hashtext('recruiter-group:' || NEW."recruiterId"));
  IF NEW."type" = 'GROUP_REWARD' THEN
    SELECT coalesce(max("cycle"), 0) INTO max_reward FROM "recruiter_reward_ledger"
      WHERE "recruiterId" = NEW."recruiterId" AND "type" = 'GROUP_REWARD';
    IF NEW."cycle" <> max_reward + 1 THEN
      RAISE EXCEPTION 'group reward of recruiter % must be cycle % (got %)', NEW."recruiterId", max_reward + 1, NEW."cycle" USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT "amountCents", "settingsVersion" INTO rw_amount, rw_version FROM "recruiter_reward_ledger"
      WHERE "recruiterId" = NEW."recruiterId" AND "type" = 'GROUP_REWARD' AND "cycle" = NEW."cycle";
    SELECT EXISTS (SELECT 1 FROM "recruiter_reward_ledger"
      WHERE "recruiterId" = NEW."recruiterId" AND "type" = 'GROUP_REVERSAL' AND "cycle" = NEW."cycle") INTO is_reversed;
    IF rw_amount IS NULL OR is_reversed OR -NEW."amountCents" > rw_amount OR NEW."settingsVersion" IS DISTINCT FROM rw_version THEN
      RAISE EXCEPTION 'a group reversal needs the unreversed group reward of the same recruiter, cycle and settings version and cannot exceed it' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_reward_ledger_group_cycle_guard" ON "recruiter_reward_ledger";
CREATE TRIGGER "recruiter_reward_ledger_group_cycle_guard" BEFORE INSERT ON "recruiter_reward_ledger"
  FOR EACH ROW EXECUTE FUNCTION recruiter_group_cycle_guard();

-- ── 4. Ownership (Phase 7 Stage F — topmost link) + the ledger link guard (replaces 20261105's) ──
-- owner(affiliate): the recruiter of the TOPMOST linked affiliate of its chain, NULL when there is no link
-- or the chain is a parent cycle meeting several recruiters (the same rule as the application —
-- src/lib/services/recruiterRewardService.js findAffiliateOwner). STABLE, read-only.
CREATE OR REPLACE FUNCTION recruiter_affiliate_owner(p_affiliate TEXT) RETURNS TEXT AS $$
DECLARE
  n_rows   INTEGER;
  n_rids   INTEGER;
  one_rid  TEXT;
  has_top  BOOLEAN;
  owner_id TEXT;
BEGIN
  -- the whole chain, cycle-safe (UNION keeps each row once): its link (rid) and whether its parent row is missing (top)
  WITH RECURSIVE chain AS (
    SELECT a."id", a."parentId", l."recruiterId" AS rid,
           NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
    FROM "affiliates" a
    LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
    WHERE a."id" = p_affiliate
    UNION
    SELECT p."id", p."parentId", p.rid, p.top
    FROM chain c
    CROSS JOIN LATERAL (
      SELECT a."id", a."parentId", l."recruiterId" AS rid,
             NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
      FROM "affiliates" a
      LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
      WHERE a."id" = c."parentId"
      OFFSET 0
    ) p
  )
  SELECT count(*)::int, count(DISTINCT c.rid)::int, min(c.rid), coalesce(bool_or(c.top), false)
    INTO n_rows, n_rids, one_rid, has_top
  FROM chain c;
  IF n_rids = 0 THEN
    RETURN NULL;          -- no link on the chain
  ELSIF n_rids = 1 THEN
    RETURN one_rid;       -- one recruiter: it owns the chain (topmost or not, cycle or not)
  ELSIF NOT has_top THEN
    RETURN NULL;          -- a parent cycle meeting several recruiters: ambiguous, a conflict
  END IF;
  -- several recruiters on a chain with a top (a legacy nested link): the topmost link, i.e. the highest
  -- step of a walk bounded by the chain length (a simple path, so it cannot loop)
  WITH RECURSIVE up AS (
    SELECT a."id", a."parentId", l."recruiterId" AS rid, 1 AS k
    FROM "affiliates" a
    LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
    WHERE a."id" = p_affiliate
    UNION ALL
    SELECT p."id", p."parentId", p.rid, u.k + 1
    FROM up u
    CROSS JOIN LATERAL (
      SELECT a."id", a."parentId", l."recruiterId" AS rid
      FROM "affiliates" a
      LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
      WHERE a."id" = u."parentId"
      OFFSET 0
    ) p
    WHERE u.k < n_rows
  )
  SELECT u.rid INTO owner_id FROM up u WHERE u.rid IS NOT NULL ORDER BY u.k DESC LIMIT 1;
  RETURN owner_id;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION recruiter_reward_link_guard() RETURNS trigger AS $$
DECLARE
  owner_id TEXT;
BEGIN
  IF NEW."affiliateId" IS NULL THEN
    RETURN NEW;
  END IF;
  -- the compensation of a reward this recruiter holds for this affiliate (the cycle guard pins the
  -- cycle): legacy rows stay reversible even when the affiliate now belongs to another recruiter
  IF NEW."type" = 'REVERSAL' AND EXISTS (
    SELECT 1 FROM "recruiter_reward_ledger" r
    WHERE r."affiliateId" = NEW."affiliateId" AND r."recruiterId" = NEW."recruiterId" AND r."type" = 'RECRUIT_REWARD'
  ) THEN
    RETURN NEW;
  END IF;
  owner_id := recruiter_affiliate_owner(NEW."affiliateId");
  IF owner_id IS DISTINCT FROM NEW."recruiterId" THEN
    RAISE EXCEPTION 'affiliate % is not in the network of recruiter % (owner = the recruiter of the topmost linked affiliate of its chain)',
      NEW."affiliateId", NEW."recruiterId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_reward_ledger_link_guard" ON "recruiter_reward_ledger";
CREATE TRIGGER "recruiter_reward_ledger_link_guard" BEFORE INSERT ON "recruiter_reward_ledger"
  FOR EACH ROW EXECUTE FUNCTION recruiter_reward_link_guard();

-- ── 5. Link owner guard (Phase 7 Stage F): never another recruiter inside an owned network ──────
-- In addition to recruiter_affiliate_links_new_only (20261105). The new affiliate has no link yet, so
-- recruiter_affiliate_owner(it) = the owner of its parent chain.
CREATE OR REPLACE FUNCTION recruiter_link_owner_guard() RETURNS trigger AS $$
DECLARE
  owner_id TEXT;
BEGIN
  owner_id := recruiter_affiliate_owner(NEW."affiliateId");
  IF owner_id IS NOT NULL AND owner_id <> NEW."recruiterId" THEN
    RAISE EXCEPTION 'affiliate % is inside the network of another recruiter: it cannot be linked to recruiter %',
      NEW."affiliateId", NEW."recruiterId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recruiter_affiliate_links_owner_guard" ON "recruiter_affiliate_links";
CREATE TRIGGER "recruiter_affiliate_links_owner_guard" BEFORE INSERT ON "recruiter_affiliate_links"
  FOR EACH ROW EXECUTE FUNCTION recruiter_link_owner_guard();

-- ── 6. No deletion of an affiliate that has children (Phase 7 Stage F) ──────────────────────────
-- The application refuses first (src/lib/affiliateDeletion.js, AFFILIATE_HAS_CHILDREN); this is the
-- database backstop. The "parentId" foreign key is not touched.
CREATE OR REPLACE FUNCTION affiliates_children_delete_guard() RETURNS trigger AS $$
BEGIN
  -- serialise with a concurrent child insert (its foreign-key check holds FOR KEY SHARE on this row)
  PERFORM 1 FROM "affiliates" WHERE "id" = OLD."id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "affiliates" c WHERE c."parentId" = OLD."id") THEN
    RAISE EXCEPTION 'AFFILIATE_HAS_CHILDREN: affiliate % has children and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "affiliates_children_delete_guard" ON "affiliates";
CREATE TRIGGER "affiliates_children_delete_guard" BEFORE DELETE ON "affiliates"
  FOR EACH ROW EXECUTE FUNCTION affiliates_children_delete_guard();
