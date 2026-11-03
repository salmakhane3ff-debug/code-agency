/**
 * src/lib/brandNotifications.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" participant notifications — EXACTLY six event types.
 * Each is written in the same transaction as its state change and audit row,
 * with an idempotency key derived from that audit row
 * (`brand:<type>:<auditId>`, unique in affiliate_notifications), so a retried
 * or concurrent action can never notify twice.
 *
 * Notifications are messages only: no balance provider reads them, and they
 * never touch the wallet, deposits, commissions or Rewards. Cancellation,
 * proof withdrawal, authorization revocation and consumption notify nobody.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const BRAND_NOTIFICATION_TYPES = Object.freeze(['submitted', 'accepted', 'rejected', 'closed', 'reopened', 'authorized']);

const MESSAGES = {
  submitted:  (v) => `Create Your Own Brand : votre preuve de paiement pour « ${v.brandName} » a bien été reçue. Elle sera vérifiée par l'équipe.`,
  accepted:   (v) => `Create Your Own Brand : votre paiement pour « ${v.brandName} » a été validé. Votre accès au simulateur de formation est activé.`,
  rejected:   (v) => `Create Your Own Brand : votre demande « ${v.brandName} » a été refusée.\nRaison :\n${v.reason}`,
  closed:     (v) => `Create Your Own Brand : votre marque « ${v.brandName} » a été clôturée. Son historique reste consultable.\nRaison :\n${v.reason}`,
  reopened:   (v) => `Create Your Own Brand : votre marque « ${v.brandName} » a été réouverte. La simulation reprend à partir de maintenant.`,
  authorized: () => 'Create Your Own Brand : vous êtes autorisé(e) à faire une nouvelle demande de marque.',
};

export const brandEventKey = (type, auditId) => `brand:${type}:${auditId}`;

/** Write one participant notification (inside the caller's transaction). */
export function notifyBrand(tx, { type, affiliateId, auditId, ...vars }) {
  if (!BRAND_NOTIFICATION_TYPES.includes(type)) throw new Error(`unknown brand notification type: ${type}`);
  if (!auditId) throw new Error('brand notifications are keyed by their audit row');
  return tx.affiliateNotification.create({
    data: { affiliateId, message: MESSAGES[type](vars), eventKey: brandEventKey(type, auditId) },
  });
}
