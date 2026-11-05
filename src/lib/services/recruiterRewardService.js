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
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  DELIVERED_ORDER_STATUS, IDENTITY_APPROVED_STATUS, REWARD_TYPES, evaluateRecruitQualification,
  normalizeRecruiterSettings, recruitRewardCycleKey, reversalCycleKey, validateRecruiterSettingsInput,
} from '../recruiterSettings.js';

/** Reason codes of the ledger rows written here (shown to the recruiter / admin as labels). */
export const REWARD_REASONS = Object.freeze({
  EARNED: 'REAL_DELIVERED_AND_CIN_APPROVED',
  REVERSED: 'REAL_DELIVERED_BELOW_THRESHOLD',
});

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CHUNK = 5000;
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const isUnique = (e) => e?.code === 'P2002';
const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };

/** The current settings version (normalized), or the built-in defaults when none exists. */
export async function getCurrentRecruiterSettings({ db = prisma } = {}) {
  const row = await db.recruiterSettingsVersion.findFirst({ orderBy: { version: 'desc' } });
  return normalizeRecruiterSettings(row);
}

/** Every settings version, newest first (admin history). */
export async function listRecruiterSettingsVersions({ db = prisma, take = 100 } = {}) {
  const rows = await db.recruiterSettingsVersion.findMany({ orderBy: { version: 'desc' }, take });
  return rows.map((r) => ({ ...normalizeRecruiterSettings(r), createdBy: r.createdBy, createdAt: r.createdAt }));
}

/**
 * Admin: append the next settings version { enabled, rewardAmountMad, minDeliveredSales }.
 * Validated server-side (Phase 1 validateRecruiterSettingsInput); audited in the same transaction.
 */
export async function adminSaveRecruiterSettings(input, { db = prisma, actorId, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  const { value, errors } = validateRecruiterSettingsInput(input);
  if (errors) throw fail('INVALID_INPUT', { errors });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        // The SAME advisory lock as the consecutive-version trigger, taken BEFORE reading the
        // last version: concurrent saves are serialised and each one reads the committed max.
        if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recruiter_settings_versions'))`;
        const last = await tx.recruiterSettingsVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
        const version = (last?.version ?? 0) + 1;
        const row = await tx.recruiterSettingsVersion.create({ data: { version, ...value, createdBy: actorId, createdAt: now } });
        await tx.recruiterAuditLog.create({
          data: {
            recruiterId: null, actorType: 'ADMIN', actorId, action: 'RECRUITER_SETTINGS_CHANGED', entityType: 'recruiter_settings',
            entityId: String(version), details: { version, ...value }, createdAt: now,
          },
        });
        return normalizeRecruiterSettings(row);
      });
    } catch (e) {
      if (!isUnique(e) || attempt === 2) throw e; // a concurrent admin took this version: retry with the next one
    }
  }
  throw fail('SERVER_ERROR');
}

/** Real delivered orders (status 'delivered' AND isFake false) per affiliate, batched. */
async function realDeliveredCounts(db, ids) {
  const out = new Map();
  for (const part of chunks(ids)) {
    const groups = await db.affiliateOrder.groupBy({
      by: ['affiliateId'], where: { affiliateId: { in: part }, status: DELIVERED_ORDER_STATUS, isFake: false }, _count: { _all: true },
    });
    for (const g of groups) out.set(g.affiliateId, Number(g?._count?._all ?? 0));
  }
  return out;
}

/** Identity status per affiliate (status only), batched. No row → NOT_SUBMITTED. */
async function identityStatuses(db, ids) {
  const out = new Map();
  for (const part of chunks(ids)) {
    const rows = await db.identityVerification.findMany({ where: { affiliateId: { in: part } }, select: { affiliateId: true, status: true } });
    for (const r of rows) out.set(r.affiliateId, r.status);
  }
  return out;
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
 * The ONE state-based operation for an affiliate: award a new cycle, reverse the open one, or
 * nothing. Runs in its own transaction under the per-affiliate lock; every fact (ledger state,
 * real delivered count, identity, settings) is read INSIDE the lock. Idempotent: replaying any
 * event, or running it concurrently, never writes twice.
 * → { action: 'AWARDED' | 'REVERSED' | 'NO_CHANGE' | 'NOT_QUALIFIED' | 'NOT_LINKED', cycle?, unmet? }
 */
export async function syncRecruiterReward(affiliateId, { db = prisma, now = new Date() } = {}) {
  if (typeof affiliateId !== 'string' || !ID_RE.test(affiliateId)) return { action: 'NOT_LINKED' };
  return db.$transaction(async (tx) => {
    const link = await tx.recruiterAffiliateLink.findUnique({ where: { affiliateId }, select: { recruiterId: true } });
    if (!link) return { action: 'NOT_LINKED' };
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
        recruiterId: link.recruiterId, affiliateId, type: REWARD_TYPES.RECRUIT_REWARD, amountCents: settings.rewardAmountCents, cycle: nextCycle,
        idempotencyKey: recruitRewardCycleKey(affiliateId, nextCycle), actorType: 'SYSTEM', actorId: null, settingsVersion: settings.version,
        reason: REWARD_REASONS.EARNED, createdAt: now,
      },
    });
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId: link.recruiterId, actorType: 'SYSTEM', actorId: 'SYSTEM', action: 'RECRUIT_REWARD_EARNED', entityType: 'affiliate', entityId: affiliateId,
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

/**
 * Reconcile every recruiter reward with the current state — for one recruiter's network, or all.
 *   1. REVERSAL pass — ALWAYS (even with rewards switched off): open rewards whose affiliate's real
 *      delivered count is below the threshold of the reward's own settings version.
 *   2. AWARD pass — only when rewards are on with an amount: affiliates without an open reward
 *      that qualify now (a new cycle).
 * Batched reads (no per-affiliate counting); each change goes through syncRecruiterReward, which
 * re-checks everything under the lock. → { checked, awarded, reversed, unchanged }
 */
export async function reconcileRecruiterRewards({ db = prisma, recruiterId = null, now = new Date() } = {}) {
  if (recruiterId !== null && (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId))) throw fail('UNAUTHORIZED');
  const settings = await getCurrentRecruiterSettings({ db });
  const links = await db.recruiterAffiliateLink.findMany({ where: recruiterId ? { recruiterId } : {}, select: { affiliateId: true, recruiterId: true } });
  const result = { checked: links.length, awarded: 0, reversed: 0, unchanged: 0 };
  if (!links.length) return result;
  // Cycle state of every linked affiliate (batched).
  const open = new Map(); // affiliateId → open reward { cycle, settingsVersion }
  for (const part of chunks(links.map((l) => l.affiliateId))) {
    const rows = await db.recruiterRewardLedger.findMany({
      where: { affiliateId: { in: part }, type: { in: [REWARD_TYPES.RECRUIT_REWARD, REWARD_TYPES.REVERSAL] } },
      select: { affiliateId: true, type: true, cycle: true, settingsVersion: true },
    });
    const best = new Map();
    for (const r of rows) {
      const b = best.get(r.affiliateId) ?? { reward: null, reversed: 0 };
      if (r.type === REWARD_TYPES.RECRUIT_REWARD && (!b.reward || r.cycle > b.reward.cycle)) b.reward = r;
      if (r.type === REWARD_TYPES.REVERSAL && r.cycle > b.reversed) b.reversed = r.cycle;
      best.set(r.affiliateId, b);
    }
    for (const [id, b] of best) if (b.reward && b.reward.cycle > b.reversed) open.set(id, b.reward);
  }
  const ids = links.map((l) => l.affiliateId);
  const counts = await realDeliveredCounts(db, ids);
  const thresholds = new Map();
  for (const v of new Set([...open.values()].map((o) => o.settingsVersion))) {
    thresholds.set(v, normalizeRecruiterSettings(Number.isInteger(v) && v >= 1 ? await db.recruiterSettingsVersion.findUnique({ where: { version: v } }) : null).minDeliveredSales);
  }
  const apply = async (affiliateId) => {
    const r = await syncRecruiterReward(affiliateId, { db, now });
    if (r.action === 'AWARDED') result.awarded += 1; else if (r.action === 'REVERSED') result.reversed += 1; else result.unchanged += 1;
  };
  // 1. Reversals — regardless of the current settings.
  for (const [affiliateId, reward] of open) {
    if ((counts.get(affiliateId) ?? 0) < thresholds.get(reward.settingsVersion)) await apply(affiliateId);
  }
  // 2. Awards — only when rewards are on.
  if (settings.enabled && settings.rewardAmountCents > 0) {
    const candidates = ids.filter((id) => !open.has(id) && (counts.get(id) ?? 0) >= settings.minDeliveredSales);
    const identity = await identityStatuses(db, candidates);
    for (const affiliateId of candidates) {
      const verdict = evaluateRecruitQualification({ linked: true, affiliateExists: true, identityStatus: identity.get(affiliateId) ?? 'NOT_SUBMITTED', deliveredSales: counts.get(affiliateId) ?? 0 }, settings);
      if (verdict.qualified) await apply(affiliateId);
    }
  }
  return result;
}
