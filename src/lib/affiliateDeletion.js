/**
 * src/lib/affiliateDeletion.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Hard-delete an affiliate only when nothing references it; otherwise refuse
 * with a clear, safe error (HTTP 409) telling the admin to deactivate instead.
 *
 * Points history (ledger, order awards, gift requests) is an audit trail and
 * must never be deleted, so it blocks deletion explicitly. Any other reference
 * (orders, payouts, notifications…) is caught as a foreign-key violation and
 * reported the same way — the raw database error is logged, never returned.
 *
 * An EMPTY points account (balance 0, no ledger rows) carries no history: it is
 * created by the account lock even for no-op syncs, so it is removed together
 * with the affiliate instead of blocking the delete.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const AFFILIATE_HAS_HISTORY = 'AFFILIATE_HAS_HISTORY';
export const AFFILIATE_HAS_HISTORY_MESSAGE =
  "Cet affilié possède un historique (points, commandes ou paiements) et ne peut pas être supprimé. Désactivez-le à la place.";

/** Foreign-key violation, as Prisma reports it with or without a driver adapter. */
export function isForeignKeyViolation(e) {
  return e?.code === 'P2003' || e?.cause?.originalCode === '23503' || e?.meta?.code === '23503';
}

function historyError() {
  return Object.assign(new Error(AFFILIATE_HAS_HISTORY_MESSAGE), { code: AFFILIATE_HAS_HISTORY });
}

/**
 * @returns {Promise<boolean>} true = deleted, false = not found.
 * @throws  {Error & {code: 'AFFILIATE_HAS_HISTORY'}} when history exists.
 */
export async function deleteAffiliateSafely(db, id) {
  try {
    return await db.$transaction(async (tx) => {
      const [ledger, awards, redemptions] = await Promise.all([
        tx.rewardPointsLedger.count({ where: { affiliateId: id } }),
        tx.rewardOrderAward.count({ where: { affiliateId: id } }),
        tx.rewardRedemption.count({ where: { affiliateId: id } }),
      ]);
      if (ledger + awards + redemptions > 0) throw historyError();
      await tx.rewardPointsAccount.deleteMany({ where: { affiliateId: id, balance: 0 } });
      await tx.affiliate.delete({ where: { id } });
      return true;
    });
  } catch (e) {
    if (e?.code === 'P2025') return false;
    if (e?.code === AFFILIATE_HAS_HISTORY) throw e;
    if (isForeignKeyViolation(e)) {
      console.error('[affiliate delete] blocked by references:', e?.message ?? e);
      throw historyError();
    }
    throw e;
  }
}
