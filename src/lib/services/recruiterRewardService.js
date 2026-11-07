/**
 * src/lib/services/recruiterRewardService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 5: recruiter REWARDS (settings + awarding).
 * (db injected, so tests run on an in-memory fake or an isolated local database.)
 *
 *   • Settings: ONLY recruiter_settings_versions (append-only, consecutive versions — DB
 *     trigger). Current = highest version; none → built-in defaults (OFF, 0 MAD, 10 orders).
 *   • Rule (Phase 1, evaluateRecruitQualification): an affiliate linked to a recruiter earns
 *     that recruiter ONE reward when BOTH are true:
 *       1. real delivered orders ≥ the threshold — AffiliateOrder rows with
 *          status === 'delivered' AND isFake === false (actual rows, never the
 *          deliveredOrdersCount column);
 *       2. IdentityVerification.status === 'APPROVED' (set only by the admin approval).
 *     The affiliate's activation flag is NOT a condition and is never read here.
 *   • Awarded IMMEDIATELY when both hold (post-commit hooks after an admin order status change
 *     or an identity approval, plus reconcile passes). Amount and threshold = the CURRENT
 *     settings version, recorded on the row; later settings never change an earned reward.
 *   • Reversal (Phase 6 part 3a, decisions D1/D2): an OPEN reward whose affiliate's CURRENT real
 *     delivered count fell below the threshold of THAT reward's settings version (never the
 *     current settings) gets ONE compensating REVERSAL (−the reward). Cancelled, returned,
 *     refused or any other non-'delivered' status simply no longer counts. The affiliate may
 *     then qualify again: a new cycle.
 *   • Ledger: recruiter_reward_ledger (append-only, MAD integer cents) in CYCLES per affiliate:
 *     cycle n = RECRUIT_REWARD (key recruit:<id>:v<n>) then, maybe, REVERSAL (reverse:<id>:v<n>).
 *     The database enforces one of each per (affiliate, cycle), the alternation, and that a
 *     reversal never exceeds its reward (migration 20261110). Rows before the cycles are cycle 1
 *     with their legacy keys.
 *   • syncRecruiterReward(affiliateId) is the ONE state-based operation (award, reverse or
 *     nothing), run under a per-affiliate advisory lock with the delivered count recomputed
 *     INSIDE the lock: an award racing a cancellation always ends consistent, and duplicate or
 *     concurrent events never write twice. Nothing here touches any affiliate column or any other
 *     money system (commissions, points, balances, payouts).
 *   • Phase 7 Stage E introduced OWNERSHIP; Phase 7 Stage F (approved clarification) fixed its
 *     precedence: the recruiter rewarded for an affiliate X is owner(X) = the recruiter of the TOPMOST
 *     linked affiliate of X's chain (X itself, its parent, its grandparent… through affiliates.parentId,
 *     up to the top) — exactly one owner or none. Once R owns a network, EVERY descendant belongs to R
 *     at any depth: an affiliate invited below it (no link, e.g. created by an admin) and also one with
 *     a nested (legacy) link to another recruiter — that link never transfers ownership, is never
 *     rewritten, and is reported by listRecruiterOwnershipConflicts. A chain without a top (a parent
 *     cycle — corrupt data) is owned by the one recruiter of every link met on it, by nobody (a
 *     conflict) when there are several. N(R) = { X : owner(X) = R }, unlimited depth. Ownership is
 *     stable: a link is only ever created for a brand-new affiliate (a leaf — triggers
 *     recruiter_link_new_affiliate_only and, Stage F, recruiter_link_owner_guard: never a link to
 *     another recruiter inside an owned network), parentId is only written at creation and an affiliate
 *     with children cannot be deleted (Stage F trigger). Both rewards use N(R): Reward A for every X in
 *     N(R) (its OWN real delivered orders), Reward B counts the distinct qualified X in N(R). Every walk
 *     is cycle-safe. The DB link guard (migration 20261112) accepts exactly owner(affiliate) = the row's
 *     recruiter (a REVERSAL also for the holder of the reward, so legacy rows stay reversible).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  DEFAULT_MIN_DELIVERED_SALES, DELIVERED_ORDER_STATUS, IDENTITY_APPROVED_STATUS, MIN_SALES_RANGE, REWARD_TYPES, evaluateRecruitQualification,
  normalizeRecruiterSettings, recruitRewardCycleKey, reversalCycleKey, validateRecruiterSettingsInput,
  // Phase 7 (Reward B — the recruiter group reward)
  groupRewardCycleKey, groupReversalCycleKey, groupRewardsOn, normalizeRecruiterGroupSettings, normalizeRecruiterSettingsWithGroup,
  validateRecruiterGroupSettingsInput,
} from '../recruiterSettings.js';

/** Reason codes of the ledger rows written here (shown to the recruiter / admin as labels). */
export const REWARD_REASONS = Object.freeze({
  EARNED: 'REAL_DELIVERED_AND_CIN_APPROVED',
  REVERSED: 'REAL_DELIVERED_BELOW_THRESHOLD',
});

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const isUnique = (e) => e?.code === 'P2002';

/** The current settings version (normalized), or the built-in defaults when none exists. */
export async function getCurrentRecruiterSettings({ db = prisma } = {}) {
  const row = await db.recruiterSettingsVersion.findFirst({ orderBy: { version: 'desc' } });
  return normalizeRecruiterSettings(row);
}

/** Phase 7: the current settings of BOTH reward types (individual + group fields), or the defaults. */
export async function getCurrentRecruiterSettingsWithGroup({ db = prisma } = {}) {
  const row = await db.recruiterSettingsVersion.findFirst({ orderBy: { version: 'desc' } });
  return normalizeRecruiterSettingsWithGroup(row);
}

/** Every settings version, newest first (admin history) — both reward types (Phase 7). */
export async function listRecruiterSettingsVersions({ db = prisma, take = 100 } = {}) {
  const rows = await db.recruiterSettingsVersion.findMany({ orderBy: { version: 'desc' }, take });
  return rows.map((r) => ({ ...normalizeRecruiterSettingsWithGroup(r), createdBy: r.createdBy, createdAt: r.createdAt }));
}

/**
 * Admin: append the next settings version — Reward A { enabled, rewardAmountMad, minDeliveredSales }
 * and (Phase 7) Reward B { groupEnabled, groupRewardAmountMad, groupSize, groupMinDeliveredSales }.
 * Validated server-side (validateRecruiterSettingsInput + validateRecruiterGroupSettingsInput, field
 * errors merged); audited in the same transaction with the new AND the previous values.
 */
export async function adminSaveRecruiterSettings(input, { db = prisma, actorId, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  const individual = validateRecruiterSettingsInput(input);
  const group = validateRecruiterGroupSettingsInput(input);
  if (individual.errors || group.errors) throw fail('INVALID_INPUT', { errors: { ...(individual.errors ?? {}), ...(group.errors ?? {}) } });
  const value = { ...individual.value, ...group.value };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        // The SAME advisory lock as the consecutive-version trigger, taken BEFORE reading the
        // last version: concurrent saves are serialised and each one reads the committed max.
        if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recruiter_settings_versions'))`;
        const last = await tx.recruiterSettingsVersion.findFirst({ orderBy: { version: 'desc' } });
        const version = (last?.version ?? 0) + 1;
        const row = await tx.recruiterSettingsVersion.create({ data: { version, ...value, createdBy: actorId, createdAt: now } });
        await tx.recruiterAuditLog.create({
          data: {
            recruiterId: null, actorType: 'ADMIN', actorId, action: 'RECRUITER_SETTINGS_CHANGED', entityType: 'recruiter_settings',
            entityId: String(version),
            // new values of both reward types + the previous version's values (null for the first version)
            details: { version, ...value, previous: last ? normalizeRecruiterSettingsWithGroup(last) : null },
            createdAt: now,
          },
        });
        return normalizeRecruiterSettingsWithGroup(row);
      });
    } catch (e) {
      if (!isUnique(e) || attempt === 2) throw e; // a concurrent admin took this version: retry with the next one
    }
  }
  throw fail('SERVER_ERROR');
}

/** Per-affiliate advisory lock — the SAME key as the ledger cycle-guard trigger. */
async function lockAffiliateReward(tx, affiliateId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'recruit:' + affiliateId}))`;
}

/**
 * Per-RECRUITER money lock (Phase 6 part 3b): taken by a reward REVERSAL just before it writes,
 * and by a withdrawal PAYMENT before its balance re-check — a payment decision and a reversal
 * are strictly serialised. Lock order (deadlock-free): reversal = affiliate lock → this lock;
 * payment = recruiter row (FOR NO KEY UPDATE) → this lock. A payment never takes an affiliate
 * lock, and a reversal only takes FOR KEY SHARE on the recruiter row (FK), which is compatible.
 */
export async function lockRecruiterMoney(tx, recruiterId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'recruiter-money:' + recruiterId}))`;
}

/** Real delivered orders of ONE affiliate, read inside the caller's transaction. */
async function realDeliveredCount(tx, affiliateId) {
  return tx.affiliateOrder.count({ where: { affiliateId, status: DELIVERED_ORDER_STATUS, isFake: false } });
}

/** The cycle state of ONE affiliate: the open reward (or null) and the next cycle number. */
async function cycleState(tx, affiliateId) {
  const rows = await tx.recruiterRewardLedger.findMany({
    where: { affiliateId, type: { in: [REWARD_TYPES.RECRUIT_REWARD, REWARD_TYPES.REVERSAL] } },
    select: { type: true, cycle: true, amountCents: true, recruiterId: true, settingsVersion: true },
  });
  let reward = null;
  let reversedCycle = 0;
  for (const r of rows) {
    if (r.type === REWARD_TYPES.RECRUIT_REWARD && (!reward || r.cycle > reward.cycle)) reward = r;
    if (r.type === REWARD_TYPES.REVERSAL && r.cycle > reversedCycle) reversedCycle = r.cycle;
  }
  const open = reward && reward.cycle > reversedCycle ? reward : null;
  return { open, nextCycle: (reward?.cycle ?? 0) + 1 };
}

/** The delivered-order threshold of a settings version (the one a reward was earned with). */
async function thresholdOfVersion(tx, version) {
  if (!Number.isInteger(version) || version < 1) return normalizeRecruiterSettings(null).minDeliveredSales;
  return normalizeRecruiterSettings(await tx.recruiterSettingsVersion.findUnique({ where: { version } })).minDeliveredSales;
}

/**
 * owner(affiliateId) (Phase 7 Stage F — TOPMOST link wins): the recruiter of the TOPMOST linked affiliate
 * of its chain (the affiliate, its parent, grandparent… up to the top through parentId), or null. A
 * nested link to another recruiter never transfers ownership. ONE recursive statement:
 *   chain  the whole chain upwards (primary-key lookups, each step a LATERAL subquery fenced with
 *          OFFSET 0; UNION keeps each row once, so a parent cycle ends after one lap) with each row's link
 *          (rid) and `top` (its parent row does not exist: parentId NULL, '' or dangling);
 *   info   n = chain length, nr = distinct recruiters linked on it, rid = one of them, top = the chain
 *          reaches a top (false = it ends in a parent cycle — corrupt data);
 *   up     the same walk with a step counter, bounded by n — evaluated ONLY when nr > 1 on a chain
 *          with a top (a legacy conflicting link below the topmost one): the topmost = the highest k.
 * nr = 1 → that recruiter (topmost or not, it is the only one); nr > 1 with a top → the topmost link's
 * recruiter; nr > 1 on a cycle (no top) → null (an ambiguous cycle: a CONFLICT, never assigned —
 * listRecruiterOwnershipConflicts); nr = 0 → null. Cost O(chain length) (+ O(chain length) for a conflict).
 * Read-only; any context (transaction or not). The DB guards use the same rule (migration 20261112,
 * recruiter_affiliate_owner()).
 */
export async function findAffiliateOwner(affiliateId, { db = prisma } = {}) {
  if (typeof affiliateId !== 'string' || !ID_RE.test(affiliateId)) return null;
  const rows = await db.$queryRaw`
    /* recruiter-affiliate-owner */
    WITH RECURSIVE chain AS (
      SELECT a."id", a."parentId", l."recruiterId" AS rid,
             NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
      FROM "affiliates" a
      LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
      WHERE a."id" = ${affiliateId}::text
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
    ),
    info AS (
      SELECT count(*)::int AS n, count(DISTINCT c.rid)::int AS nr, min(c.rid) AS rid, bool_or(c.top) AS top
      FROM chain c
    ),
    up AS (
      SELECT a."id", a."parentId", l."recruiterId" AS rid, 1 AS k
      FROM "affiliates" a
      LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
      WHERE a."id" = ${affiliateId}::text
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
      WHERE u.k < (SELECT i.n FROM info i)
    )
    SELECT CASE WHEN i.nr = 1 THEN i.rid
                WHEN i.nr > 1 AND i.top THEN (SELECT u.rid FROM up u WHERE u.rid IS NOT NULL ORDER BY u.k DESC LIMIT 1)
           END AS "recruiterId"
    FROM info i`;
  const r = Array.isArray(rows) ? rows[0] : null;
  return typeof r?.recruiterId === 'string' ? r.recruiterId : null;
}

/** Phase 7 Stage F: at most this many conflicting link ids per listRecruiterOwnershipConflicts call (counts are always complete). */
export const OWNERSHIP_CONFLICTS_LIMIT = Object.freeze({ DEFAULT: 500, MAX: 5000 });
const CONFLICT_DEPTH_CAP = 1_000_000;

/**
 * Phase 7 Stage F (admin, READ-ONLY): the legacy CONFLICTING links under the topmost-link rule — never
 * reassigned or modified, only reported (ids and counts, no name / phone / any other column):
 *   NESTED           a link to recruiter B on an affiliate whose chain has a linked ancestor of
 *                    another recruiter above it: owner = the topmost link's recruiter ≠ B (B earns
 *                    nothing from it; B's legacy reward rows stay reversible by B);
 *   AMBIGUOUS_CYCLE  a link on a chain without a top (a parent cycle — corrupt data) meeting links of
 *                    several recruiters: no owner at all.
 * ONE statement, the platform-wide form of the N(R) CTEs: gcand / gup / grs / groots = the links
 * without any linked ancestor on a chain with a top (the roots of every network); gnet = their
 * descendants with the root's recruiter (owner); a link reached with owner ≠ its recruiter is NESTED;
 * gorph = the links no root reaches (only on chains without a top), goup = the full upward walk of each
 * (UNION), gagg per link: AMBIGUOUS_CYCLE when it meets ≥ 2 recruiters. Seeds go through
 * unnest(ARRAY(…)) (small planner estimates — no JIT compilation, PG16). Cost O(affiliates below a link) + O(cyclic
 * links × their chain). The same query (without the binds) is the read-only section 5 of
 * docs/performance/production-index-checklist.sql.
 * → { total, nested, ambiguous, items: [{ affiliateId, kind }] (id order, at most `limit`), truncated }
 */
export async function listRecruiterOwnershipConflicts({ db = prisma, limit = OWNERSHIP_CONFLICTS_LIMIT.DEFAULT } = {}) {
  const take = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, OWNERSHIP_CONFLICTS_LIMIT.MAX) : OWNERSHIP_CONFLICTS_LIMIT.DEFAULT;
  const cap = CONFLICT_DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-ownership-conflicts */
    WITH RECURSIVE gcand AS (
      SELECT l."affiliateId" AS "id"
      FROM "recruiter_affiliate_links" l
      JOIN "affiliates" a ON a."id" = l."affiliateId"
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = a."parentId")
    ),
    gup AS (
      SELECT s."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM unnest(ARRAY(SELECT c."id" FROM gcand c)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = (SELECT f."parentId" FROM "affiliates" f WHERE f."id" = s."id")
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM gup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    grs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM gup u
      GROUP BY u.seed
    ),
    groots AS (
      SELECT c."id"
      FROM gcand c
      LEFT JOIN grs ON grs.seed = c."id"
      WHERE grs.seed IS NULL OR (NOT grs.linked AND grs.top)
    ),
    gnet AS (
      SELECT s."id", (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = s."id") AS owner, 0 AS depth
      FROM unnest(ARRAY(SELECT r."id" FROM groots r)) AS s("id")
      UNION ALL
      SELECT ch."id", n.owner, n.depth + 1
      FROM gnet n
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
      WHERE n.depth < ${cap}::int
    ),
    gorph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE NOT EXISTS (SELECT 1 FROM gnet n WHERE n."id" = l."affiliateId")
      )) AS s("id")
    ),
    goup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM gorph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM goup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    gagg AS (
      SELECT u.seed, bool_or(u.top) AS top, count(DISTINCT u.rid) AS nr
      FROM goup u
      GROUP BY u.seed
    ),
    conf AS (
      SELECT n."id", 'NESTED'::text AS kind
      FROM gnet n
      JOIN "recruiter_affiliate_links" l ON l."affiliateId" = n."id"
      WHERE l."recruiterId" <> n.owner
      UNION ALL
      SELECT g.seed, 'AMBIGUOUS_CYCLE'::text
      FROM gagg g
      WHERE NOT g.top AND g.nr > 1
    ),
    page AS (
      SELECT c."id", c.kind FROM conf c ORDER BY c."id" LIMIT ${take}::int
    )
    SELECT (SELECT count(*)::int FROM conf) AS total,
           (SELECT count(*)::int FROM conf c WHERE c.kind = 'NESTED') AS nested,
           (SELECT count(*)::int FROM conf c WHERE c.kind = 'AMBIGUOUS_CYCLE') AS ambiguous,
           p."id", p.kind
    FROM (SELECT 1) one
    LEFT JOIN page p ON true
    ORDER BY p."id"`;
  const list = Array.isArray(rows) ? rows : [];
  const head = list[0] ?? {};
  const items = list.filter((r) => typeof r?.id === 'string').map((r) => ({ affiliateId: r.id, kind: r.kind }));
  const total = Number(head.total ?? 0) || 0;
  return { total, nested: Number(head.nested ?? 0) || 0, ambiguous: Number(head.ambiguous ?? 0) || 0, items, truncated: items.length < total };
}

/**
 * The ONE state-based operation for an affiliate: award a new cycle, reverse the open one, or
 * nothing. Runs in its own transaction under the per-affiliate lock; every fact (ledger state,
 * real delivered count, identity, settings) is read INSIDE the lock. Idempotent: replaying any
 * event, or running it concurrently, never writes twice.
 * Phase 7 Stage E → F: the reward goes to owner(affiliate) (findAffiliateOwner, topmost link — stable, so it may be read
 * before the lock). No owner and no individual reward row → NOT_LINKED without any lock (the hooks run
 * for every affiliate of the platform). An OPEN reward is judged whatever the owner (a reversal only
 * depends on the delivered count and the reward's own settings version; it goes to the reward's own
 * recruiter, which the cycle guard requires).
 * → { action: 'AWARDED' | 'REVERSED' | 'NO_CHANGE' | 'NOT_QUALIFIED' | 'NOT_LINKED' (no owner), cycle?, unmet? }
 */
export async function syncRecruiterReward(affiliateId, { db = prisma, now = new Date() } = {}) {
  if (typeof affiliateId !== 'string' || !ID_RE.test(affiliateId)) return { action: 'NOT_LINKED' };
  return db.$transaction(async (tx) => {
    const ownerId = await findAffiliateOwner(affiliateId, { db: tx });
    if (ownerId === null) {
      const any = await tx.recruiterRewardLedger.findFirst({ where: { affiliateId, type: REWARD_TYPES.RECRUIT_REWARD }, select: { id: true } });
      if (!any) return { action: 'NOT_LINKED' };
    }
    await lockAffiliateReward(tx, affiliateId);
    const { open, nextCycle } = await cycleState(tx, affiliateId);
    const deliveredSales = await realDeliveredCount(tx, affiliateId);

    if (open) {
      // D2 — the threshold of THE REWARD's settings version, never the current settings.
      const threshold = await thresholdOfVersion(tx, open.settingsVersion);
      if (deliveredSales >= threshold) return { action: 'NO_CHANGE', cycle: open.cycle };
      await lockRecruiterMoney(tx, open.recruiterId); // serialised with withdrawal payments (part 3b)
      await tx.recruiterRewardLedger.create({
        data: {
          recruiterId: open.recruiterId, affiliateId, type: REWARD_TYPES.REVERSAL, amountCents: -open.amountCents, cycle: open.cycle,
          idempotencyKey: reversalCycleKey(affiliateId, open.cycle), actorType: 'SYSTEM', actorId: null, settingsVersion: open.settingsVersion,
          reason: REWARD_REASONS.REVERSED, createdAt: now,
        },
      });
      await tx.recruiterAuditLog.create({
        data: {
          recruiterId: open.recruiterId, actorType: 'SYSTEM', actorId: 'SYSTEM', action: 'RECRUIT_REWARD_REVERSED', entityType: 'affiliate', entityId: affiliateId,
          details: {
            cycle: open.cycle, amountCents: -open.amountCents, settingsVersion: open.settingsVersion,
            realDeliveredOrders: deliveredSales, requiredDeliveredOrders: threshold, reason: REWARD_REASONS.REVERSED,
          },
          createdAt: now,
        },
      });
      return { action: 'REVERSED', cycle: open.cycle };
    }
    if (ownerId === null) return { action: 'NOT_LINKED' };

    const settings = await getCurrentRecruiterSettings({ db: tx });
    const [affiliate, identity] = await Promise.all([
      tx.affiliate.findUnique({ where: { id: affiliateId }, select: { id: true } }),
      tx.identityVerification.findUnique({ where: { affiliateId }, select: { status: true } }),
    ]);
    const verdict = evaluateRecruitQualification({
      linked: true, affiliateExists: !!affiliate, identityStatus: identity?.status ?? 'NOT_SUBMITTED', deliveredSales,
    }, settings);
    if (!verdict.qualified) return { action: 'NOT_QUALIFIED', unmet: verdict.unmet };
    await tx.recruiterRewardLedger.create({
      data: {
        recruiterId: ownerId, affiliateId, type: REWARD_TYPES.RECRUIT_REWARD, amountCents: settings.rewardAmountCents, cycle: nextCycle,
        idempotencyKey: recruitRewardCycleKey(affiliateId, nextCycle), actorType: 'SYSTEM', actorId: null, settingsVersion: settings.version,
        reason: REWARD_REASONS.EARNED, createdAt: now,
      },
    });
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId: ownerId, actorType: 'SYSTEM', actorId: 'SYSTEM', action: 'RECRUIT_REWARD_EARNED', entityType: 'affiliate', entityId: affiliateId,
        details: {
          cycle: nextCycle, amountCents: settings.rewardAmountCents, settingsVersion: settings.version,
          realDeliveredOrders: deliveredSales, requiredDeliveredOrders: settings.minDeliveredSales, identityStatus: IDENTITY_APPROVED_STATUS,
        },
        createdAt: now,
      },
    });
    return { action: 'AWARDED', cycle: nextCycle };
  });
}

/**
 * Kept for the existing hooks / callers: the same state-based sync (it may also reverse).
 * Concurrent duplicates are serialised by the lock, so a lost race simply sees NO_CHANGE.
 */
export async function awardRecruiterRewardIfQualified(affiliateId, opts = {}) {
  return syncRecruiterReward(affiliateId, opts);
}

/** Phase 6 part 5d: affiliates scanned per reconcile batch (keyset over recruiter_affiliate_links.affiliateId). */
export const RECONCILE_BATCH = 1000;
const RECONCILE_BATCH_MAX = 5000;
// Phase 7 Stage E: a batch = RECONCILE_BATCH links + their segments; defensive cap of a segment walk (it cannot loop — see rewardCandidates).
const SEGMENT_DEPTH_CAP = 1_000_000;
// The scope lease is a separate transaction that only holds the try-lock; the work runs outside it.
const LEASE_TIMEOUT_MS = 10 * 60_000;
const LEASE_MAX_WAIT_MS = 10_000;

/**
 * ONE keyset batch of reconcile CANDIDATES (advisory only — syncRecruiterReward re-checks
 * everything under its locks). Scans at most `size` links after `after` (affiliateId order,
 * the column's own collation) and — Phase 7 Stage E — each link's SEGMENT: the linked affiliate plus
 * its descendants reached through UNLINKED children only (a child with a link of its own starts its
 * own segment). Every affiliate at or below a link lies in exactly ONE segment (the one of its nearest
 * link), so the platform batches scan every owned affiliate once — without materialising any network
 * in the application. Phase 7 Stage F: used for the ADMIN scope only (recruiterId bound NULL — the
 * statement text is unchanged): the segments are a scan, not the ownership (the sync rewards the
 * TOPMOST link's recruiter; an affiliate of an ambiguous cycle has no owner: NOT_LINKED). The wallet
 * scope uses networkRewardCandidates (the roots of N(R)).
 * A segment walk cannot loop: it never re-enters its own (linked) start and cannot reach a parent
 * cycle that does not contain it; it is still capped (SEGMENT_DEPTH_CAP). Returns:
 *   { kind: 'reversal', id } an OPEN reward (latest RECRUIT_REWARD cycle > latest REVERSAL
 *                            cycle) whose real delivered count is below the threshold of THAT
 *                            reward's settings version (same normalisation as thresholdOfVersion)
 *                            — always, even with rewards switched off;
 *   { kind: 'award', id }    no open reward and real delivered count ≥ the current threshold —
 *                            only when awardsOn (identity is checked afterwards, then by the sync);
 *   { kind: 'batch', id: last scanned link affiliateId | null, n: links scanned };
 *   { kind: 'members', n: segment members scanned (links included) }.
 * Delivered orders are counted per affiliate (affiliate_orders affiliateId index) and only for
 * the affiliates that can be candidates. Nothing per affiliate reaches the application.
 * Cost per batch: O(size + members of those segments) index probes.
 */
async function rewardCandidates(db, { recruiterId, after, size, awardsOn, minDeliveredSales }) {
  const rows = await db.$queryRaw`
    /* recruiter-reward-candidates */
    WITH RECURSIVE batch AS (
      SELECT l."affiliateId" AS id
      FROM "recruiter_affiliate_links" l
      WHERE (${recruiterId}::text IS NULL OR l."recruiterId" = ${recruiterId}::text)
        AND (${after}::text IS NULL OR l."affiliateId" > ${after}::text)
      ORDER BY l."affiliateId"
      LIMIT ${size}::int
    ),
    seg AS (
      SELECT s.id, 0 AS depth FROM unnest(ARRAY(SELECT b.id FROM batch b)) AS s(id)
      UNION ALL
      SELECT ch."id", g.depth + 1
      FROM seg g
      CROSS JOIN LATERAL (
        SELECT a."id" FROM "affiliates" a
        WHERE a."parentId" = g.id
          AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id")
        OFFSET 0
      ) ch
      WHERE g.depth < ${SEGMENT_DEPTH_CAP}::int
    ),
    cyc AS (
      SELECT g.id,
             (SELECT max(r."cycle") FROM "recruiter_reward_ledger" r WHERE r."affiliateId" = g.id AND r."type" = ${REWARD_TYPES.RECRUIT_REWARD}) AS rc,
             (SELECT max(r."cycle") FROM "recruiter_reward_ledger" r WHERE r."affiliateId" = g.id AND r."type" = ${REWARD_TYPES.REVERSAL}) AS vc
      FROM seg g
    ),
    st AS (
      SELECT c.id, (c.rc IS NOT NULL AND c.rc > COALESCE(c.vc, 0)) AS open,
             COALESCE((
               SELECT CASE WHEN v."minDeliveredSales" BETWEEN ${MIN_SALES_RANGE.min}::int AND ${MIN_SALES_RANGE.max}::int THEN v."minDeliveredSales" END
               FROM "recruiter_reward_ledger" rw
               JOIN "recruiter_settings_versions" v ON v."version" = rw."settingsVersion"
               WHERE rw."affiliateId" = c.id AND rw."type" = ${REWARD_TYPES.RECRUIT_REWARD} AND rw."cycle" = c.rc AND rw."settingsVersion" >= 1
               LIMIT 1
             ), ${DEFAULT_MIN_DELIVERED_SALES}::int) AS thr
      FROM cyc c
    ),
    cnt AS (
      SELECT s.id, s.open, s.thr,
             CASE WHEN s.open OR ${awardsOn}::boolean THEN (
               SELECT count(*) FROM "affiliate_orders" o
               WHERE o."affiliateId" = s.id AND o."status" = ${DELIVERED_ORDER_STATUS} AND o."isFake" = false
             ) END AS n
      FROM st s
    )
    SELECT 'reversal'::text AS kind, x.id, NULL::int AS n FROM cnt x WHERE x.open AND x.n < x.thr
    UNION ALL
    SELECT 'award'::text, x.id, NULL::int FROM cnt x WHERE ${awardsOn}::boolean AND NOT x.open AND x.n >= ${minDeliveredSales}::int
    UNION ALL
    SELECT 'batch'::text, (SELECT max(b.id) FROM batch b), (SELECT count(*)::int FROM batch)
    UNION ALL
    SELECT 'members'::text, NULL::text, (SELECT count(*)::int FROM seg)
    ORDER BY 1, 2`;
  return candidatesOf(rows);
}

/** Rows of a candidates statement → { links (batch rows scanned), scanned (members), last, reversals, awards }. */
function candidatesOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const batch = list.find((r) => r?.kind === 'batch');
  const members = list.find((r) => r?.kind === 'members');
  const ids = (kind) => list.filter((r) => r?.kind === kind && typeof r.id === 'string').map((r) => r.id);
  return {
    links: Number(batch?.n ?? 0), scanned: Number(members?.n ?? 0), last: typeof batch?.id === 'string' ? batch.id : null,
    reversals: ids('reversal'), awards: ids('award'),
  };
}

/**
 * Phase 7 Stage F: ONE keyset batch of reconcile candidates of the WALLET scope (one recruiter's N(R)) —
 * the same candidate rules and rows as rewardCandidates, over a different scan:
 *   batch  at most `size` ROOTS of N(R) after `after` (id order; the shared roots CTEs of
 *          recruiterNetworkService: R's linked affiliates without any linked ancestor, on a chain with a top);
 *   seg    each batch root and ALL its descendants (every one belongs to R — a nested link changes
 *          nothing; root subtrees are disjoint, so each placed member is scanned once);
 *   cnet   FIRST batch only (after NULL): the members on a parent cycle owned by R (orph / oup / cseed /
 *          cnet — corrupt data; the full placed walk `net` is needed to find them, so it runs once per
 *          reconcile, never per batch);
 *   mem    seg + cnet: the members scanned ('members' row); 'batch' = (last root id, roots scanned).
 * The batches of one reconcile cover N(R) exactly once. Cost per batch: O(links(R) + the batch's subtrees)
 * index probes (+ O(N(R)) once, in the first batch).
 */
async function networkRewardCandidates(db, { recruiterId, after, size, awardsOn, minDeliveredSales }) {
  const cap = SEGMENT_DEPTH_CAP;
  const rows = await db.$queryRaw`
    /* recruiter-reward-network-candidates */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    batch AS (
      SELECT r."id"
      FROM roots r
      WHERE (${after}::text IS NULL OR r."id" > ${after}::text)
      ORDER BY r."id"
      LIMIT ${size}::int
    ),
    net AS (
      SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM roots r WHERE ${after}::text IS NULL)) AS s("id")
      UNION ALL
      SELECT ch."id", n.depth + 1
      FROM net n
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
      WHERE n.depth < ${cap}::int
    ),
    orph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE ${after}::text IS NULL AND l."recruiterId" = ${recruiterId}::text
          AND NOT EXISTS (SELECT 1 FROM net n WHERE n."id" = l."affiliateId")
      )) AS s("id")
    ),
    oup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM orph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM oup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    cseed AS (
      SELECT op."id"
      FROM orph op
      WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
    ),
    cnet AS (
      SELECT s."id" FROM cseed s
      UNION
      SELECT ch."id"
      FROM cnet c
      CROSS JOIN LATERAL (
        SELECT a."id" FROM "affiliates" a
        WHERE a."parentId" = c."id"
          AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" ox WHERE ox."affiliateId" = a."id" AND ox."recruiterId" <> ${recruiterId}::text)
        OFFSET 0
      ) ch
    ),
    seg AS (
      SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT b."id" FROM batch b)) AS s("id")
      UNION ALL
      SELECT ch."id", g.depth + 1
      FROM seg g
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = g."id" OFFSET 0) ch
      WHERE g.depth < ${cap}::int
    ),
    mem AS (
      SELECT g."id" FROM seg g
      UNION ALL
      SELECT c."id" FROM unnest(ARRAY(SELECT cx."id" FROM cnet cx)) AS c("id")
    ),
    cyc AS (
      SELECT g.id,
             (SELECT max(r."cycle") FROM "recruiter_reward_ledger" r WHERE r."affiliateId" = g.id AND r."type" = ${REWARD_TYPES.RECRUIT_REWARD}) AS rc,
             (SELECT max(r."cycle") FROM "recruiter_reward_ledger" r WHERE r."affiliateId" = g.id AND r."type" = ${REWARD_TYPES.REVERSAL}) AS vc
      FROM mem g
    ),
    st AS (
      SELECT c.id, (c.rc IS NOT NULL AND c.rc > COALESCE(c.vc, 0)) AS open,
             COALESCE((
               SELECT CASE WHEN v."minDeliveredSales" BETWEEN ${MIN_SALES_RANGE.min}::int AND ${MIN_SALES_RANGE.max}::int THEN v."minDeliveredSales" END
               FROM "recruiter_reward_ledger" rw
               JOIN "recruiter_settings_versions" v ON v."version" = rw."settingsVersion"
               WHERE rw."affiliateId" = c.id AND rw."type" = ${REWARD_TYPES.RECRUIT_REWARD} AND rw."cycle" = c.rc AND rw."settingsVersion" >= 1
               LIMIT 1
             ), ${DEFAULT_MIN_DELIVERED_SALES}::int) AS thr
      FROM cyc c
    ),
    cnt AS (
      SELECT s.id, s.open, s.thr,
             CASE WHEN s.open OR ${awardsOn}::boolean THEN (
               SELECT count(*) FROM "affiliate_orders" o
               WHERE o."affiliateId" = s.id AND o."status" = ${DELIVERED_ORDER_STATUS} AND o."isFake" = false
             ) END AS n
      FROM st s
    )
    SELECT 'reversal'::text AS kind, x.id, NULL::int AS n FROM cnt x WHERE x.open AND x.n < x.thr
    UNION ALL
    SELECT 'award'::text, x.id, NULL::int FROM cnt x WHERE ${awardsOn}::boolean AND NOT x.open AND x.n >= ${minDeliveredSales}::int
    UNION ALL
    SELECT 'batch'::text, (SELECT max(b."id") FROM batch b), (SELECT count(*)::int FROM batch)
    UNION ALL
    SELECT 'members'::text, NULL::text, (SELECT count(*)::int FROM mem)
    ORDER BY 1, 2`;
  return candidatesOf(rows);
}

/** Identity status of one batch of award candidates — status only, chunked (a batch's segments may hold more than `size` ids). */
async function approvedAmong(db, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += GROUP_QUALIFIED_CHUNK) {
    const rows = await db.identityVerification.findMany({ where: { affiliateId: { in: ids.slice(i, i + GROUP_QUALIFIED_CHUNK) } }, select: { affiliateId: true, status: true } });
    for (const r of rows) if (r.status === IDENTITY_APPROVED_STATUS) out.add(r.affiliateId);
  }
  return out;
}

/**
 * Hold a platform-wide "reconcile running" lease while fn() runs: a separate transaction takes
 * pg_try_advisory_xact_lock (two-key form: its own key space, never equal to the one-key
 * per-affiliate / recruiter-money locks) and waits until fn() settles; it never blocks anyone
 * (try-lock) and is released by the end of that transaction (COMMIT, rollback or timeout) — no
 * session lock can leak. Busy → { busy: true } without running fn().
 */
async function withReconcileLease(db, fn) {
  let release;
  const released = new Promise((r) => { release = r; });
  let settle;
  const acquired = new Promise((r) => { settle = r; });
  const lease = db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('recruiter-reward-reconcile'), 0) AS ok`;
    const ok = Array.isArray(rows) && rows[0]?.ok === true;
    settle(ok);
    if (ok) await released;
  }, { maxWait: LEASE_MAX_WAIT_MS, timeout: LEASE_TIMEOUT_MS });
  lease.catch((e) => settle(e instanceof Error ? e : new Error('RECONCILE_LEASE_FAILED')));
  const ok = await acquired;
  if (ok instanceof Error) throw ok;
  if (ok !== true) { await lease.catch(() => {}); return { busy: true }; }
  try {
    return await fn();
  } finally {
    release();
    // The work is already done (each change committed in its own sync transaction); a lease
    // that ended early (timeout) only means another run could have started meanwhile — harmless.
    await lease.catch((e) => console.error('[recruiter-rewards] reconcile lease ended with', e?.code ?? 'ERROR'));
  }
}

/**
 * Reconcile recruiter rewards with the current state, in bounded keyset batches (Phase 6 part 5d).
 *   • Candidates per batch come from ONE SQL statement (rewardCandidates): reversals ALWAYS
 *     (even with rewards switched off, against each reward's own settings version), awards only
 *     when rewards are on with an amount (identity APPROVED filtered next).
 *   • Each candidate goes through syncRecruiterReward — the authoritative check under the
 *     per-affiliate lock (then the recruiter-money lock for a reversal), its own transaction.
 *     Candidates are advisory: a stale one simply ends NO_CHANGE / NOT_QUALIFIED.
 *   • Phase 7 Stage E: a batch = `batchSize` links + their segments (rewardCandidates): `checked`
 *     counts the affiliates scanned (links and their unlinked descendants), the cursor stays the last
 *     link's affiliateId (same format) and hasMore = the batch was full of links. Phase 7 Stage F: the
 *     wallet scope (recruiterId) batches the ROOTS of N(R) instead (networkRewardCandidates): `checked`
 *     = the members of N(R) scanned (each once), the cursor = the last root id, hasMore = the batch was
 *     full of roots.
 *   • recruiterId (wallet): that recruiter's network N(R), every batch. recruiterId null (admin):
 *     the whole platform under a try-lock lease (concurrent full runs → { busy: true }), from
 *     `after`, at most `maxBatches` batches per call (the admin routes pass 1).
 * Repeating a call, or resuming from any cursor, is safe: syncs are idempotent.
 *   • Phase 7 (Reward B): recruiterId given → that recruiter's group reward is synchronised after
 *     its batches; admin full scope → when the link batches are exhausted in this call (hasMore
 *     false), a group pass over EVERY recruiter (keyset over recruiters.id, bounded batches) under
 *     the same lease. Either is skipped when group rewards are off and no group reward exists in
 *     its scope (then nothing could be awarded or reversed).
 * → { checked, awarded, reversed, unchanged, candidates, batches, cursor, hasMore, busy,
 *     groupChecked, groupAwarded, groupReversed }
 */
export async function reconcileRecruiterRewards({
  db = prisma, recruiterId = null, now = new Date(), after = null, batchSize = RECONCILE_BATCH, maxBatches = Infinity,
} = {}) {
  if (recruiterId !== null && (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId))) throw fail('UNAUTHORIZED');
  if (after !== null && (typeof after !== 'string' || !ID_RE.test(after))) throw fail('INVALID_INPUT');
  const size = Number.isInteger(batchSize) && batchSize >= 1 ? Math.min(batchSize, RECONCILE_BATCH_MAX) : RECONCILE_BATCH;
  const limit = maxBatches === Infinity || (Number.isInteger(maxBatches) && maxBatches >= 1) ? maxBatches : 1;

  const run = async () => {
    const settings = await getCurrentRecruiterSettingsWithGroup({ db });
    const awardsOn = settings.enabled === true && settings.rewardAmountCents > 0;
    const result = {
      checked: 0, awarded: 0, reversed: 0, unchanged: 0, candidates: 0, batches: 0, cursor: after, hasMore: false, busy: false,
      groupChecked: 0, groupAwarded: 0, groupReversed: 0,
    };
    const apply = async (affiliateId) => {
      const r = await syncRecruiterReward(affiliateId, { db, now });
      if (r.action === 'AWARDED') result.awarded += 1; else if (r.action === 'REVERSED') result.reversed += 1; else result.unchanged += 1;
    };
    let cursor = after;
    for (;;) {
      const c = recruiterId === null
        ? await rewardCandidates(db, { recruiterId, after: cursor, size, awardsOn, minDeliveredSales: settings.minDeliveredSales })
        : await networkRewardCandidates(db, { recruiterId, after: cursor, size, awardsOn, minDeliveredSales: settings.minDeliveredSales });
      result.batches += 1;
      result.checked += c.scanned;
      // 1. Reversals — regardless of the current settings.
      for (const id of c.reversals) { result.candidates += 1; await apply(id); }
      // 2. Awards — only when rewards are on; identity APPROVED (status only) before the sync.
      if (awardsOn && c.awards.length) {
        const approved = await approvedAmong(db, c.awards);
        for (const id of c.awards) if (approved.has(id)) { result.candidates += 1; await apply(id); }
      }
      if (c.last !== null) cursor = c.last;
      result.cursor = cursor;
      result.hasMore = c.links === size;
      if (!result.hasMore || result.batches >= limit) break;
    }
    if (!result.hasMore) result.cursor = null;
    // Phase 7: the group reward (Reward B) — after the individual batches.
    // Skipped when group rewards are off and no group reward exists in the scope (nothing to award or reverse).
    if (recruiterId !== null) {
      if (groupRewardsOn(settings) || await anyGroupReward(db, recruiterId)) await groupPass(db, { now, result, recruiterIds: [recruiterId] });
    } else if (!result.hasMore && (groupRewardsOn(settings) || await anyGroupReward(db))) await groupPass(db, { now, result });
    return result;
  };

  if (recruiterId !== null) return run();
  const leased = await withReconcileLease(db, run);
  if (leased?.busy === true) {
    return {
      checked: 0, awarded: 0, reversed: 0, unchanged: 0, candidates: 0, batches: 0, cursor: after, hasMore: true, busy: true,
      groupChecked: 0, groupAwarded: 0, groupReversed: 0,
    };
  }
  return leased;
}

// ── Phase 7: Reward B — the recruiter GROUP reward ───────────────────────────
//
// A recruiter earns the group amount each time `groupSize` DISTINCT affiliates of its network N(R)
// (Phase 7 Stage E → F: every affiliate whose owner — topmost link — is the recruiter, linked to it or
// below one of its affiliates at any depth; see the header) are each qualified: real delivered orders ≥
// groupMinDeliveredSales (status 'delivered' AND isFake false — the affiliate's OWN orders) AND
// identity APPROVED. One affiliate counts once, whatever its sales.
//   • Entitlement: Q qualified affiliates (current threshold) → floor(Q / groupSize) active
//     (non-reversed) group rewards. Award: groups on with an amount and active < floor(Q / size) →
//     the next cycle (max group cycle + 1) at the CURRENT version.
//   • Reversal — ALWAYS, even with group rewards off: the highest-cycle active group reward, judged
//     with ITS OWN settings version (its threshold and size): Q_v < active × size_v → a
//     GROUP_REVERSAL of exactly −its amount. Requalifying later = a new cycle.
//   • Steps repeat inside one sync until stable (bounded). Everything runs in ONE transaction under
//     the per-recruiter group lock (the same key as the DB trigger recruiter_group_cycle_guard); a
//     reversal also takes the recruiter money lock before writing (lock order: group → money; never
//     an affiliate lock), so it is serialised with withdrawal payments.
//   • Q is computed in SQL (the members of N(R) — Stage F: one downward walk from the roots of N(R)
//     through EVERY child, plus the members on a parent cycle owned by R — + a per-member bounded count
//     of real delivered orders; nothing per order reaches the application), then identity APPROVED is
//     counted with Prisma in chunks (status only). Cost O(|N(R)|) index probes.

/** Reason codes of the group ledger rows (labels for the recruiter / admin). */
export const GROUP_REWARD_REASONS = Object.freeze({
  EARNED: 'GROUP_QUALIFIED_AFFILIATES',
  REVERSED: 'GROUP_QUALIFIED_BELOW_THRESHOLD',
});
/** Affiliate ids per identity count statement. */
export const GROUP_QUALIFIED_CHUNK = 5000;
const GROUP_SYNC_MAX_STEPS = 1000;
const GROUP_PASS_BATCH = 500;
const GROUP_TX = { maxWait: 10_000, timeout: 60_000 };

/** Per-recruiter group lock — the SAME key as the ledger trigger recruiter_group_cycle_guard. */
async function lockRecruiterGroup(tx, recruiterId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'recruiter-group:' + recruiterId}))`;
}

/**
 * Ids of the members of N(R) with at least `minDelivered` real delivered orders — one statement (Phase 7
 * Stage F: the shared N(R) CTEs of recruiterNetworkService — the roots, EVERY descendant, the members on a
 * parent cycle owned by R — each member once); per member, a count of its OWN real delivered orders that
 * stops at the threshold (affiliate_orders affiliateId index).
 */
async function groupQualifiedIds(tx, recruiterId, minDelivered) {
  const cap = SEGMENT_DEPTH_CAP;
  const rows = await tx.$queryRaw`
    /* recruiter-group-qualified */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    net AS (
      SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM roots r)) AS s("id")
      UNION ALL
      SELECT ch."id", n.depth + 1
      FROM net n
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
      WHERE n.depth < ${cap}::int
    ),
    orph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE l."recruiterId" = ${recruiterId}::text
          AND NOT EXISTS (SELECT 1 FROM net n WHERE n."id" = l."affiliateId")
      )) AS s("id")
    ),
    oup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM orph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM oup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    cseed AS (
      SELECT op."id"
      FROM orph op
      WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
    ),
    cnet AS (
      SELECT s."id" FROM cseed s
      UNION
      SELECT ch."id"
      FROM cnet c
      CROSS JOIN LATERAL (
        SELECT a."id" FROM "affiliates" a
        WHERE a."parentId" = c."id"
          AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" ox WHERE ox."affiliateId" = a."id" AND ox."recruiterId" <> ${recruiterId}::text)
        OFFSET 0
      ) ch
    ),
    mem AS (
      SELECT n."id" FROM net n
      UNION ALL
      SELECT c."id" FROM unnest(ARRAY(SELECT cx."id" FROM cnet cx)) AS c("id")
    )
    SELECT m."id"
    FROM mem m
    WHERE (
        SELECT count(*) FROM (
          SELECT 1 FROM "affiliate_orders" o
          WHERE o."affiliateId" = m."id" AND o."status" = ${DELIVERED_ORDER_STATUS} AND o."isFake" = false
          LIMIT ${minDelivered}::int
        ) d
      ) >= ${minDelivered}::int`;
  return (Array.isArray(rows) ? rows : []).map((r) => r?.id).filter((id) => typeof id === 'string');
}

/** Q: how many of those affiliates have an APPROVED identity (status only, chunked). */
async function groupQualifiedCount(tx, recruiterId, minDelivered) {
  const ids = await groupQualifiedIds(tx, recruiterId, minDelivered);
  let n = 0;
  for (let i = 0; i < ids.length; i += GROUP_QUALIFIED_CHUNK) {
    n += await tx.identityVerification.count({ where: { affiliateId: { in: ids.slice(i, i + GROUP_QUALIFIED_CHUNK) }, status: IDENTITY_APPROVED_STATUS } });
  }
  return n;
}

/** The group ledger state of ONE recruiter: active (non-reversed) rewards by cycle and the highest cycle. */
async function groupLedgerState(tx, recruiterId) {
  const rows = await tx.recruiterRewardLedger.findMany({
    where: { recruiterId, type: { in: [REWARD_TYPES.GROUP_REWARD, REWARD_TYPES.GROUP_REVERSAL] } },
    select: { type: true, cycle: true, amountCents: true, settingsVersion: true },
  });
  const reversed = new Set(rows.filter((r) => r.type === REWARD_TYPES.GROUP_REVERSAL).map((r) => r.cycle));
  const rewards = rows.filter((r) => r.type === REWARD_TYPES.GROUP_REWARD);
  return {
    active: rewards.filter((r) => !reversed.has(r.cycle)).sort((a, b) => a.cycle - b.cycle),
    maxCycle: rewards.reduce((m, r) => Math.max(m, r.cycle), 0),
  };
}

/**
 * The ONE state-based group operation of a recruiter (award / reverse until stable, or nothing).
 * Idempotent and safe under concurrency (group lock + DB trigger + unique indexes + keys).
 * → { awarded, reversed, awardedCycles, reversedCycles, active, qualified (current threshold, or
 *     null when not needed), groupSize (current) }
 */
export async function syncRecruiterGroupReward(recruiterId, { db = prisma, now = new Date() } = {}) {
  const out = { awarded: 0, reversed: 0, awardedCycles: [], reversedCycles: [], active: 0, qualified: null, groupSize: null };
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) return out;
  return db.$transaction(async (tx) => {
    await lockRecruiterGroup(tx, recruiterId);
    const state = await groupLedgerState(tx, recruiterId);
    const current = await getCurrentRecruiterSettingsWithGroup({ db: tx });
    out.groupSize = current.groupSize;
    const on = groupRewardsOn(current);
    if (!on && state.active.length === 0) return out; // nothing to award, nothing to reverse
    const qByThreshold = new Map();
    const Q = async (threshold) => {
      if (!qByThreshold.has(threshold)) qByThreshold.set(threshold, await groupQualifiedCount(tx, recruiterId, threshold));
      return qByThreshold.get(threshold);
    };
    const versions = new Map();
    const groupOfVersion = async (version) => {
      if (!versions.has(version)) {
        const row = Number.isInteger(version) && version >= 1 ? await tx.recruiterSettingsVersion.findUnique({ where: { version } }) : null;
        versions.set(version, normalizeRecruiterGroupSettings(row));
      }
      return versions.get(version);
    };
    let moneyLocked = false;
    for (let step = 0; step < GROUP_SYNC_MAX_STEPS; step += 1) {
      // 1. Reversal of the highest active cycle, judged with ITS settings version.
      const top = state.active[state.active.length - 1];
      if (top) {
        const v = await groupOfVersion(top.settingsVersion);
        const qualified = await Q(v.groupMinDeliveredSales);
        if (qualified < state.active.length * v.groupSize) {
          if (!moneyLocked) { await lockRecruiterMoney(tx, recruiterId); moneyLocked = true; } // serialised with payments
          await tx.recruiterRewardLedger.create({
            data: {
              recruiterId, affiliateId: null, type: REWARD_TYPES.GROUP_REVERSAL, amountCents: -top.amountCents, cycle: top.cycle,
              idempotencyKey: groupReversalCycleKey(recruiterId, top.cycle), actorType: 'SYSTEM', actorId: null, settingsVersion: top.settingsVersion,
              reason: GROUP_REWARD_REASONS.REVERSED, createdAt: now,
            },
          });
          await tx.recruiterAuditLog.create({
            data: {
              recruiterId, actorType: 'SYSTEM', actorId: 'SYSTEM', action: 'RECRUIT_GROUP_REWARD_REVERSED', entityType: 'recruiter', entityId: recruiterId,
              details: {
                cycle: top.cycle, amountCents: -top.amountCents, settingsVersion: top.settingsVersion, qualifiedAffiliates: qualified,
                groupSize: v.groupSize, groupMinDeliveredSales: v.groupMinDeliveredSales, activeGroupRewards: state.active.length,
              },
              createdAt: now,
            },
          });
          state.active.pop();
          out.reversed += 1;
          out.reversedCycles.push(top.cycle);
          continue;
        }
      }
      // 2. Award the next cycle at the CURRENT version while the entitlement allows it.
      if (on) {
        const qualified = await Q(current.groupMinDeliveredSales);
        if (state.active.length < Math.floor(qualified / current.groupSize)) {
          const cycle = state.maxCycle + 1;
          await tx.recruiterRewardLedger.create({
            data: {
              recruiterId, affiliateId: null, type: REWARD_TYPES.GROUP_REWARD, amountCents: current.groupRewardAmountCents, cycle,
              idempotencyKey: groupRewardCycleKey(recruiterId, cycle), actorType: 'SYSTEM', actorId: null, settingsVersion: current.version,
              reason: GROUP_REWARD_REASONS.EARNED, createdAt: now,
            },
          });
          await tx.recruiterAuditLog.create({
            data: {
              recruiterId, actorType: 'SYSTEM', actorId: 'SYSTEM', action: 'RECRUIT_GROUP_REWARD_EARNED', entityType: 'recruiter', entityId: recruiterId,
              details: {
                cycle, amountCents: current.groupRewardAmountCents, settingsVersion: current.version, qualifiedAffiliates: qualified,
                groupSize: current.groupSize, groupMinDeliveredSales: current.groupMinDeliveredSales, activeGroupRewards: state.active.length + 1,
              },
              createdAt: now,
            },
          });
          state.active.push({ type: REWARD_TYPES.GROUP_REWARD, cycle, amountCents: current.groupRewardAmountCents, settingsVersion: current.version });
          state.maxCycle = cycle;
          out.awarded += 1;
          out.awardedCycles.push(cycle);
          continue;
        }
      }
      break;
    }
    out.active = state.active.length;
    if (on) out.qualified = await Q(current.groupMinDeliveredSales);
    return out;
  }, GROUP_TX);
}

/** The group reward of the affiliate's OWNER (Phase 7 Stage E → F: findAffiliateOwner, topmost link) — post-commit hooks. No owner → NOT_LINKED. */
export async function syncRecruiterGroupRewardForAffiliate(affiliateId, { db = prisma, now = new Date() } = {}) {
  if (typeof affiliateId !== 'string' || !ID_RE.test(affiliateId)) return { action: 'NOT_LINKED' };
  const ownerId = await findAffiliateOwner(affiliateId, { db });
  if (!ownerId) return { action: 'NOT_LINKED' };
  return { action: 'SYNCED', recruiterId: ownerId, ...(await syncRecruiterGroupReward(ownerId, { db, now })) };
}

/** Does any group reward exist (platform, or one recruiter) — then a reversal may be due even with group rewards off? */
async function anyGroupReward(db, recruiterId = null) {
  const where = recruiterId === null ? { type: REWARD_TYPES.GROUP_REWARD } : { recruiterId, type: REWARD_TYPES.GROUP_REWARD };
  return !!(await db.recruiterRewardLedger.findFirst({ where, select: { id: true } }));
}

/** Group syncs of the given recruiters, or of EVERY recruiter (keyset over recruiters.id, bounded batches). */
async function groupPass(db, { now, result, recruiterIds = null }) {
  const apply = async (id) => {
    const g = await syncRecruiterGroupReward(id, { db, now });
    result.groupChecked += 1;
    result.groupAwarded += g.awarded;
    result.groupReversed += g.reversed;
  };
  if (recruiterIds) { for (const id of recruiterIds) await apply(id); return; }
  let cursor = null;
  for (;;) {
    const page = await db.recruiter.findMany({
      where: cursor === null ? {} : { id: { gt: cursor } }, orderBy: { id: 'asc' }, take: GROUP_PASS_BATCH, select: { id: true },
    });
    for (const r of page) await apply(r.id);
    if (page.length < GROUP_PASS_BATCH) return;
    cursor = page[page.length - 1].id;
  }
}
