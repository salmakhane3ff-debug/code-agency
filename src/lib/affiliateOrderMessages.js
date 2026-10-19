/**
 * src/lib/affiliateOrderMessages.js
 * ─────────────────────────────────────────────────────────────────────────────
 * French/Arabic feedback for a refused affiliate order-status change
 * (PUT /api/affiliate/orders). Since the Phase 0 ownership fix the route answers
 * 404 for an order that is not the caller's (or does not exist) and 409 for an
 * order that can no longer change (delivered / cancelled). The dashboard used
 * to ignore those silently; it now shows one of these messages.
 * Pure — scripts/rewardsReviewFixes.test.mjs checks both languages.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const MESSAGES = Object.freeze({
  fr: Object.freeze({
    LOCKED:    'Cette commande ne peut plus être modifiée (déjà livrée ou annulée). La liste a été actualisée.',
    NOT_FOUND: 'Commande introuvable. La liste a été actualisée.',
    INVALID:   'Action non autorisée pour cette commande.',
    SESSION:   'Votre session a expiré. Veuillez vous reconnecter.',
    NETWORK:   'Erreur réseau. Vérifiez votre connexion et réessayez.',
    DEFAULT:   'Une erreur est survenue. Réessayez.',
  }),
  ar: Object.freeze({
    LOCKED:    'لم يعد بالإمكان تعديل هذا الطلب (تم تسليمه أو إلغاؤه). تم تحديث القائمة.',
    NOT_FOUND: 'الطلب غير موجود. تم تحديث القائمة.',
    INVALID:   'إجراء غير مسموح به لهذا الطلب.',
    SESSION:   'انتهت جلستك. يرجى تسجيل الدخول من جديد.',
    NETWORK:   'خطأ في الشبكة. تحقق من اتصالك وحاول مرة أخرى.',
    DEFAULT:   'حدث خطأ. حاول مرة أخرى.',
  }),
});

export const ORDER_MESSAGES = MESSAGES;

/** Which message a response maps to (exported for tests). */
export function orderStatusErrorKind(httpStatus) {
  if (httpStatus === 0) return 'NETWORK';
  if (httpStatus === 409) return 'LOCKED';
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus === 400) return 'INVALID';
  if (httpStatus === 401) return 'SESSION';
  return 'DEFAULT';
}

/** Responses after which the list is stale and should be reloaded. */
export const shouldRefreshOrdersAfter = (httpStatus) => httpStatus === 404 || httpStatus === 409;

/** Message in the site language (Arabic → AR, anything else → FR). */
export function orderStatusErrorMessage(httpStatus, lang) {
  return MESSAGES[lang === 'ar' ? 'ar' : 'fr'][orderStatusErrorKind(httpStatus)];
}

export const orderMessageDir = (lang) => (lang === 'ar' ? 'rtl' : 'ltr');
