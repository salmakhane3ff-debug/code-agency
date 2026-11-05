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
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { awardRecruiterRewardIfQualified } from './services/recruiterRewardService.js';

const inTransaction = (db) => {
  if (!db) return false;
  try { return typeof db.$transaction !== 'function'; } catch { return true; }
};
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** After an admin changed an affiliate order's status: a REAL order that is now 'delivered'. */
export async function onRecruiterOrderStatusCommitted(affiliateOrderId, { db = prisma, award = awardRecruiterRewardIfQualified } = {}) {
  if (inTransaction(db)) return { action: 'DEFERRED' };
  try {
    if (typeof affiliateOrderId !== 'string' || !ID_RE.test(affiliateOrderId)) return { action: 'IGNORED' };
    const o = await db.affiliateOrder.findUnique({ where: { id: affiliateOrderId }, select: { affiliateId: true, status: true, isFake: true } });
    if (!o || o.status !== 'delivered' || o.isFake !== false) return { action: 'IGNORED' };
    return await award(o.affiliateId, { db });
  } catch (e) {
    console.error('[recruiter-rewards] order hook failed (reconcile will retry):', affiliateOrderId, e?.code ?? 'ERROR');
    return { action: 'ERROR' };
  }
}

/** After an admin approved an identity verification (by its row id). */
export async function onRecruiterIdentityApprovedCommitted(identityVerificationId, { db = prisma, award = awardRecruiterRewardIfQualified } = {}) {
  if (inTransaction(db)) return { action: 'DEFERRED' };
  try {
    if (typeof identityVerificationId !== 'string' || !ID_RE.test(identityVerificationId)) return { action: 'IGNORED' };
    const v = await db.identityVerification.findUnique({ where: { id: identityVerificationId }, select: { affiliateId: true, status: true } });
    if (!v || v.status !== 'APPROVED') return { action: 'IGNORED' };
    return await award(v.affiliateId, { db });
  } catch (e) {
    console.error('[recruiter-rewards] identity hook failed (reconcile will retry):', identityVerificationId, e?.code ?? 'ERROR');
    return { action: 'ERROR' };
  }
}
