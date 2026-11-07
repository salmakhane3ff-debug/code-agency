/**
 * src/lib/recruiterRewardHooks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System, Phase 5 — the ONLY entry points existing admin routes use to
 * reach the recruiter reward service (same contract as src/lib/rewardsHooks.js):
 *
 *   • call AFTER the write has committed — never from inside a transaction (a transaction
 *     client is detected and the check is left to the reconcile passes);
 *   • these hooks NEVER throw: a failure is logged and left for reconcileRecruiterRewards
 *     (recruiter wallet / admin "recheck"), so the admin action always succeeds on its own;
 *   • they only READ the order / identity row (status, isFake, affiliateId) and write
 *     nothing but the recruiter reward ledger + audit (through the service).
 *   • Phase 7 (Reward B): after the individual sync of an affiliate, the GROUP reward of the
 *     affiliate's OWNER (Phase 7 Stage E → F: the recruiter of the TOPMOST linked affiliate of its
 *     chain — linked or invited affiliates alike) is synchronised too (its own transaction; same rules:
 *     post-commit only, never throws — a failure is logged and left to the reconcile passes).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { awardRecruiterRewardIfQualified, syncRecruiterGroupRewardForAffiliate } from './services/recruiterRewardService.js';

const inTransaction = (db) => {
  if (!db) return false;
  try { return typeof db.$transaction !== 'function'; } catch { return true; }
};
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** Phase 7: the group reward of the affiliate's owner (Stage E) — never throws. */
async function syncGroupOf(affiliateId, db, group) {
  try {
    await group(affiliateId, { db });
  } catch (e) {
    console.error('[recruiter-rewards] group sync failed (reconcile will retry):', affiliateId, e?.code ?? 'ERROR');
  }
}

/**
 * After an admin changed an affiliate order's status — ANY status (Phase 6 part 3a): the reward of
 * that order's affiliate is re-synchronised state-based (a new cycle may be awarded, or the open
 * reward reversed when the real delivered count fell below its threshold). Fake orders never count.
 */
export async function onRecruiterOrderStatusCommitted(affiliateOrderId, { db = prisma, award = awardRecruiterRewardIfQualified, group = syncRecruiterGroupRewardForAffiliate } = {}) {
  if (inTransaction(db)) return { action: 'DEFERRED' };
  try {
    if (typeof affiliateOrderId !== 'string' || !ID_RE.test(affiliateOrderId)) return { action: 'IGNORED' };
    const o = await db.affiliateOrder.findUnique({ where: { id: affiliateOrderId }, select: { affiliateId: true, status: true, isFake: true } });
    if (!o || o.isFake !== false) return { action: 'IGNORED' };
    const r = await award(o.affiliateId, { db });
    await syncGroupOf(o.affiliateId, db, group);
    return r;
  } catch (e) {
    console.error('[recruiter-rewards] order hook failed (reconcile will retry):', affiliateOrderId, e?.code ?? 'ERROR');
    return { action: 'ERROR' };
  }
}

/** After an admin approved an identity verification (by its row id). */
export async function onRecruiterIdentityApprovedCommitted(identityVerificationId, { db = prisma, award = awardRecruiterRewardIfQualified, group = syncRecruiterGroupRewardForAffiliate } = {}) {
  if (inTransaction(db)) return { action: 'DEFERRED' };
  try {
    if (typeof identityVerificationId !== 'string' || !ID_RE.test(identityVerificationId)) return { action: 'IGNORED' };
    const v = await db.identityVerification.findUnique({ where: { id: identityVerificationId }, select: { affiliateId: true, status: true } });
    if (!v || v.status !== 'APPROVED') return { action: 'IGNORED' };
    const r = await award(v.affiliateId, { db });
    await syncGroupOf(v.affiliateId, db, group);
    return r;
  } catch (e) {
    console.error('[recruiter-rewards] identity hook failed (reconcile will retry):', identityVerificationId, e?.code ?? 'ERROR');
    return { action: 'ERROR' };
  }
}

/**
 * After the fake-order sync propagated a store order's status (src/lib/services/orderService.js):
 * re-synchronise the reward of every REAL affiliate order linked to that store order id (fake
 * rows never count; this covers a non-fake row sharing the id). Never throws.
 */
export async function onRecruiterLinkedOrderSynced(orderId, { db = prisma, award = awardRecruiterRewardIfQualified, group = syncRecruiterGroupRewardForAffiliate } = {}) {
  if (inTransaction(db)) return { action: 'DEFERRED' };
  try {
    if (typeof orderId !== 'string' || !ID_RE.test(orderId)) return { action: 'IGNORED' };
    const rows = await db.affiliateOrder.findMany({ where: { orderId, isFake: false }, select: { affiliateId: true } });
    const ids = [...new Set(rows.map((r) => r.affiliateId))];
    for (const id of ids) { await award(id, { db }); await syncGroupOf(id, db, group); }
    return { action: ids.length ? 'SYNCED' : 'IGNORED', affiliates: ids.length };
  } catch (e) {
    console.error('[recruiter-rewards] linked-order hook failed (reconcile will retry):', orderId, e?.code ?? 'ERROR');
    return { action: 'ERROR' };
  }
}
