/**
 * src/lib/rewardsHooks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY entry points the existing order/affiliate code uses to reach the
 * rewards engine. Contract for callers:
 *
 *   • call AFTER your write has committed — never from inside a transaction.
 *     A transaction client (it has no $transaction method) is detected and the
 *     sync is deferred to reconcile instead of reading uncommitted state;
 *   • these hooks NEVER throw: a rewards failure is logged and left for
 *     reconcileOrderRewards / reconcileSignupBonuses (POST
 *     /api/admin/rewards/reconcile), so an order status change or an
 *     activation always succeeds on its own.
 *
 * Points are a separate currency: nothing here touches commissions, the MAD
 * wallet or balance providers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { syncOrderRewards, awardSignupBonusOnActivation } from './services/rewardsService.js';

// Prisma's interactive-transaction client denies $transaction (reads as
// undefined). Defensive: an accessor that throws also counts as "inside a tx".
const inTransaction = (db) => {
  if (!db) return false;
  try { return typeof db.$transaction !== 'function'; } catch { return true; }
};

/**
 * After an affiliate order's status was written. State-based: awards a newly
 * delivered eligible order, reverses one that left 'delivered', re-awards a
 * re-delivered one with its original snapshot — idempotent under retries.
 */
export async function onAffiliateOrderStatusCommitted(affiliateOrderId, { db, sync = syncOrderRewards } = {}) {
  if (inTransaction(db)) {
    console.warn('[rewards] order hook called inside a transaction — deferred to reconcile:', affiliateOrderId);
    return { action: 'deferred' };
  }
  try {
    return await sync(affiliateOrderId, db ? { db } : {});
  } catch (e) {
    console.error('[rewards] order points sync failed (reconcile will retry):', affiliateOrderId, e?.message ?? e);
    return { action: 'error' };
  }
}

/**
 * After an affiliate's isActive was written. Only a false → true change is an
 * activation; the bonus itself is first-activation-only and idempotent.
 */
export async function onAffiliateActivationCommitted(affiliateId, { wasActive, isActive, db, award = awardSignupBonusOnActivation } = {}) {
  if (wasActive !== false || isActive !== true) return { awarded: false, reason: 'NOT_AN_ACTIVATION' };
  if (inTransaction(db)) {
    console.warn('[rewards] activation hook called inside a transaction — deferred to reconcile:', affiliateId);
    return { awarded: false, reason: 'DEFERRED' };
  }
  try {
    return await award(affiliateId, db ? { db } : {});
  } catch (e) {
    console.error('[rewards] signup bonus failed (reconcile will retry):', affiliateId, e?.message ?? e);
    return { awarded: false, reason: 'ERROR' };
  }
}
