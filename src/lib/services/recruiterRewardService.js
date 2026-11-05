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
 *   • Awarded IMMEDIATELY when both hold (post-commit hooks after an admin delivery or an
 *     identity approval, plus reconcile passes). Amount and threshold = the CURRENT settings
 *     version, recorded on the row; later settings never change an earned reward.
 *   • Ledger: recruiter_reward_ledger (append-only, MAD integer cents). One RECRUIT_REWARD per
 *     affiliate: idempotency key recruit:<affiliateId> + partial unique index. Concurrent
 *     events race on that index: exactly one row, the other sees ALREADY_AWARDED.
 *   • Nothing here ever reverses or revokes a reward (a reversal needs an explicit admin
 *     action, out of scope), nor touches any affiliate column or other money system.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  DELIVERED_ORDER_STATUS, IDENTITY_APPROVED_STATUS, REWARD_TYPES, evaluateRecruitQualification,
  normalizeRecruiterSettings, recruitRewardKey, validateRecruiterSettingsInput,
} from '../recruiterSettings.js';

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

/** Insert the reward + its audit row (one transaction). → 'AWARDED' | 'ALREADY_AWARDED'. */
async function insertReward(db, { recruiterId, affiliateId, settings, deliveredSales, now }) {
  try {
    await db.$transaction(async (tx) => {
      await tx.recruiterRewardLedger.create({
        data: {
          recruiterId, affiliateId, type: REWARD_TYPES.RECRUIT_REWARD, amountCents: settings.rewardAmountCents,
          idempotencyKey: recruitRewardKey(affiliateId), actorType: 'SYSTEM', actorId: null, settingsVersion: settings.version,
          reason: 'REAL_DELIVERED_AND_CIN_APPROVED', createdAt: now,
        },
      });
      await tx.recruiterAuditLog.create({
        data: {
          recruiterId, actorType: 'SYSTEM', actorId: 'SYSTEM', action: 'RECRUIT_REWARD_EARNED', entityType: 'affiliate', entityId: affiliateId,
          details: {
            amountCents: settings.rewardAmountCents, settingsVersion: settings.version,
            realDeliveredOrders: deliveredSales, requiredDeliveredOrders: settings.minDeliveredSales, identityStatus: IDENTITY_APPROVED_STATUS,
          },
          createdAt: now,
        },
      });
    });
    return 'AWARDED';
  } catch (e) {
    if (isUnique(e)) return 'ALREADY_AWARDED'; // a concurrent event awarded it first
    throw e;
  }
}

/**
 * Award the recruiter reward for ONE affiliate if it qualifies now (idempotent).
 * → { action: 'AWARDED' | 'ALREADY_AWARDED' | 'NOT_QUALIFIED' | 'NOT_LINKED', unmet? }
 */
export async function awardRecruiterRewardIfQualified(affiliateId, { db = prisma, now = new Date() } = {}) {
  if (typeof affiliateId !== 'string' || !ID_RE.test(affiliateId)) return { action: 'NOT_LINKED' };
  const link = await db.recruiterAffiliateLink.findUnique({ where: { affiliateId }, select: { recruiterId: true } });
  if (!link) return { action: 'NOT_LINKED' };
  const existing = await db.recruiterRewardLedger.findFirst({ where: { affiliateId, type: REWARD_TYPES.RECRUIT_REWARD }, select: { id: true } });
  if (existing) return { action: 'ALREADY_AWARDED' };
  const settings = await getCurrentRecruiterSettings({ db });
  const [affiliate, counts, identity] = await Promise.all([
    db.affiliate.findUnique({ where: { id: affiliateId }, select: { id: true } }),
    realDeliveredCounts(db, [affiliateId]),
    identityStatuses(db, [affiliateId]),
  ]);
  const deliveredSales = counts.get(affiliateId) ?? 0;
  const verdict = evaluateRecruitQualification({
    linked: true, affiliateExists: !!affiliate, identityStatus: identity.get(affiliateId) ?? 'NOT_SUBMITTED', deliveredSales,
  }, settings);
  if (!verdict.qualified) return { action: 'NOT_QUALIFIED', unmet: verdict.unmet };
  return { action: await insertReward(db, { recruiterId: link.recruiterId, affiliateId, settings, deliveredSales, now }) };
}

/**
 * Award every reward that is due now — for one recruiter's network, or for all recruiters.
 * Batched (no per-affiliate count queries); each award is its own small transaction.
 * → { checked, awarded, alreadyAwarded }
 */
export async function reconcileRecruiterRewards({ db = prisma, recruiterId = null, now = new Date() } = {}) {
  const settings = await getCurrentRecruiterSettings({ db });
  if (!settings.enabled || !(settings.rewardAmountCents > 0)) return { checked: 0, awarded: 0, alreadyAwarded: 0 };
  if (recruiterId !== null && (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId))) throw fail('UNAUTHORIZED');
  const links = await db.recruiterAffiliateLink.findMany({ where: recruiterId ? { recruiterId } : {}, select: { affiliateId: true, recruiterId: true } });
  if (!links.length) return { checked: 0, awarded: 0, alreadyAwarded: 0 };
  const done = new Set();
  for (const part of chunks(links.map((l) => l.affiliateId))) {
    const rows = await db.recruiterRewardLedger.findMany({ where: { affiliateId: { in: part }, type: REWARD_TYPES.RECRUIT_REWARD }, select: { affiliateId: true } });
    for (const r of rows) done.add(r.affiliateId);
  }
  const candidates = links.filter((l) => !done.has(l.affiliateId));
  const ids = candidates.map((l) => l.affiliateId);
  const [counts, identity] = await Promise.all([realDeliveredCounts(db, ids), identityStatuses(db, ids)]);
  let awarded = 0;
  let alreadyAwarded = 0;
  for (const l of candidates) {
    const deliveredSales = counts.get(l.affiliateId) ?? 0;
    // Cheap pre-filter on the batched facts; the row itself exists (FK of the link).
    const verdict = evaluateRecruitQualification({ linked: true, affiliateExists: true, identityStatus: identity.get(l.affiliateId) ?? 'NOT_SUBMITTED', deliveredSales }, settings);
    if (!verdict.qualified) continue;
    const r = await insertReward(db, { recruiterId: l.recruiterId, affiliateId: l.affiliateId, settings, deliveredSales, now });
    if (r === 'AWARDED') awarded += 1; else alreadyAwarded += 1;
  }
  return { checked: candidates.length, awarded, alreadyAwarded };
}
