/**
 * src/lib/rewardsI18n.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate-facing Rewards texts in French and Arabic (D8: the tab follows the
 * site language from LanguageContext). Both dictionaries MUST have the same
 * keys — scripts/rewardsAffiliate.test.mjs enforces it, and that every status,
 * ledger type and server error code has a label in both languages.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fr = {
  title: "Récompenses",
  subtitle: "Gagnez des points sur vos commandes livrées et échangez-les contre des cadeaux.",
  disabled: "Le programme de récompenses est momentanément désactivé.",
  available: "Points disponibles",
  held: "En attente",
  held_hint: "Points de commandes récentes, utilisables après la période de rétention.",
  earned: "Total gagné",
  redeemed: "Total utilisé",
  debt: "Dette de points",
  debt_hint: "Une commande a été annulée après utilisation de ses points. Les prochains points gagnés rembourseront d'abord cette dette.",
  tab_gifts: "Cadeaux",
  tab_requests: "Mes demandes",
  tab_history: "Historique des points",
  no_gifts: "Aucun cadeau disponible pour le moment.",
  no_requests: "Vous n'avez encore fait aucune demande.",
  no_history: "Aucun mouvement de points.",
  points: "pts",
  request: "Demander",
  stock_ok: "Disponible",
  stock_low: "Plus que {n}",
  stock_out: "Rupture de stock",
  form_title: "Demander ce cadeau",
  full_name: "Nom complet",
  phone: "Téléphone",
  city: "Ville",
  address: "Adresse complète",
  notes: "Instructions de livraison (optionnel)",
  continue: "Continuer",
  back: "Retour",
  confirm_title: "Confirmer la demande",
  cost: "Coût",
  balance_after: "Solde après la demande",
  deliver_to: "Livraison à",
  confirm: "Confirmer",
  cancel: "Annuler",
  close: "Fermer",
  success: "Demande envoyée ! Référence : {ref}",
  reference: "Référence",
  requested_on: "Demandé le",
  carrier: "Transporteur",
  tracking: "N° de suivi",
  track_link: "Suivre le colis",
  copy: "Copier",
  copied: "Copié",
  rejection_reason: "Motif du refus",
  cancel_reason: "Motif d'annulation",
  cancelled_by_you: "Vous avez annulé cette demande. Vos points ont été remboursés.",
  cancelled_by_team: "Demande annulée par notre équipe. Vos points ont été remboursés.",
  history: "Suivi",
  cancel_request: "Annuler la demande",
  cancel_confirm: "Annuler cette demande ? Vos points seront remboursés.",
  load_more: "Afficher plus",
  error_generic: "Une erreur est survenue. Réessayez.",
  error_network: "Erreur réseau. Vérifiez votre connexion.",
  // Field validation
  err_fullName: "Nom complet invalide (2 à 100 caractères).",
  err_phone: "Numéro de téléphone invalide.",
  err_city: "Ville invalide.",
  err_address: "Adresse trop courte (5 caractères minimum).",
  err_deliveryNotes: "Instructions trop longues (500 caractères maximum).",
  // Server / eligibility codes
  code_REWARDS_DISABLED: "Le programme de récompenses est désactivé.",
  code_AFFILIATE_INACTIVE: "Votre compte est inactif.",
  code_GIFT_UNAVAILABLE: "Ce cadeau n'est plus disponible.",
  code_OUT_OF_STOCK: "Ce cadeau est en rupture de stock.",
  code_MIN_ORDERS_NOT_MET: "Il vous faut au moins {n} commande(s) livrée(s).",
  code_GIFT_LIMIT_REACHED: "Vous avez atteint la limite pour ce cadeau.",
  code_TOO_MANY_OPEN_REQUESTS: "Vous avez déjà des demandes en cours.",
  code_INSUFFICIENT_POINTS: "Points disponibles insuffisants.",
  code_INVALID_TRANSITION: "Cette demande ne peut plus être annulée.",
  code_NOT_FOUND: "Demande introuvable.",
  code_IDEMPOTENCY_CONFLICT: "Demande déjà envoyée.",
  code_INVALID_INPUT: "Informations invalides.",
  code_RATE_LIMITED: "Trop de tentatives. Patientez une minute.",
  // Statuses
  status_PENDING_REVIEW: "En attente de validation",
  status_APPROVED: "Approuvée",
  status_PREPARING: "En préparation",
  status_SHIPPED: "Expédiée",
  status_IN_TRANSIT: "En cours de livraison",
  status_DELIVERED: "Livrée",
  status_REJECTED: "Refusée",
  status_CANCELLED: "Annulée",
  status_RETURNED: "Retournée",
  // Ledger
  ledger_SIGNUP_BONUS: "Bonus de bienvenue",
  ledger_ORDER_DELIVERED: "Commande livrée",
  ledger_ORDER_REVERSAL: "Commande annulée",
  ledger_REDEMPTION_DEBIT: "Demande de cadeau",
  ledger_REDEMPTION_REFUND: "Remboursement",
  ledger_ADMIN_ADJUSTMENT: "Ajustement",
};

const ar = {
  title: "المكافآت",
  subtitle: "اربح نقاطاً عن طلباتك المُسلَّمة واستبدلها بهدايا.",
  disabled: "برنامج المكافآت متوقف مؤقتاً.",
  available: "النقاط المتاحة",
  held: "قيد الانتظار",
  held_hint: "نقاط طلبات حديثة، تصبح قابلة للاستعمال بعد فترة الانتظار.",
  earned: "مجموع المكتسب",
  redeemed: "مجموع المستعمل",
  debt: "دين نقاط",
  debt_hint: "أُلغي طلب بعد استعمال نقاطه. النقاط القادمة ستسدد هذا الدين أولاً.",
  tab_gifts: "الهدايا",
  tab_requests: "طلباتي",
  tab_history: "سجل النقاط",
  no_gifts: "لا توجد هدايا متاحة حالياً.",
  no_requests: "لم تقدم أي طلب بعد.",
  no_history: "لا توجد حركات نقاط.",
  points: "نقطة",
  request: "اطلب",
  stock_ok: "متوفر",
  stock_low: "تبقى {n} فقط",
  stock_out: "نفد المخزون",
  form_title: "طلب هذه الهدية",
  full_name: "الاسم الكامل",
  phone: "الهاتف",
  city: "المدينة",
  address: "العنوان الكامل",
  notes: "تعليمات التوصيل (اختياري)",
  continue: "متابعة",
  back: "رجوع",
  confirm_title: "تأكيد الطلب",
  cost: "التكلفة",
  balance_after: "الرصيد بعد الطلب",
  deliver_to: "التوصيل إلى",
  confirm: "تأكيد",
  cancel: "إلغاء",
  close: "إغلاق",
  success: "تم إرسال الطلب! المرجع: {ref}",
  reference: "المرجع",
  requested_on: "تاريخ الطلب",
  carrier: "شركة التوصيل",
  tracking: "رقم التتبع",
  track_link: "تتبع الطرد",
  copy: "نسخ",
  copied: "تم النسخ",
  rejection_reason: "سبب الرفض",
  cancel_reason: "سبب الإلغاء",
  cancelled_by_you: "لقد ألغيت هذا الطلب. تم استرجاع نقاطك.",
  cancelled_by_team: "ألغى فريقنا هذا الطلب. تم استرجاع نقاطك.",
  history: "المتابعة",
  cancel_request: "إلغاء الطلب",
  cancel_confirm: "إلغاء هذا الطلب؟ ستُسترجع نقاطك.",
  load_more: "عرض المزيد",
  error_generic: "حدث خطأ. حاول مرة أخرى.",
  error_network: "خطأ في الشبكة. تحقق من اتصالك.",
  err_fullName: "الاسم الكامل غير صالح (من 2 إلى 100 حرف).",
  err_phone: "رقم الهاتف غير صالح.",
  err_city: "المدينة غير صالحة.",
  err_address: "العنوان قصير جداً (5 أحرف على الأقل).",
  err_deliveryNotes: "التعليمات طويلة جداً (500 حرف كحد أقصى).",
  code_REWARDS_DISABLED: "برنامج المكافآت متوقف.",
  code_AFFILIATE_INACTIVE: "حسابك غير مفعل.",
  code_GIFT_UNAVAILABLE: "هذه الهدية لم تعد متاحة.",
  code_OUT_OF_STOCK: "نفد مخزون هذه الهدية.",
  code_MIN_ORDERS_NOT_MET: "تحتاج إلى {n} طلب(ات) مُسلَّمة على الأقل.",
  code_GIFT_LIMIT_REACHED: "وصلت إلى الحد الأقصى لهذه الهدية.",
  code_TOO_MANY_OPEN_REQUESTS: "لديك طلبات قيد المعالجة بالفعل.",
  code_INSUFFICIENT_POINTS: "النقاط المتاحة غير كافية.",
  code_INVALID_TRANSITION: "لم يعد بالإمكان إلغاء هذا الطلب.",
  code_NOT_FOUND: "الطلب غير موجود.",
  code_IDEMPOTENCY_CONFLICT: "تم إرسال الطلب مسبقاً.",
  code_INVALID_INPUT: "معلومات غير صالحة.",
  code_RATE_LIMITED: "محاولات كثيرة. انتظر دقيقة.",
  status_PENDING_REVIEW: "في انتظار المراجعة",
  status_APPROVED: "تمت الموافقة",
  status_PREPARING: "قيد التحضير",
  status_SHIPPED: "تم الشحن",
  status_IN_TRANSIT: "في الطريق",
  status_DELIVERED: "تم التسليم",
  status_REJECTED: "مرفوض",
  status_CANCELLED: "ملغى",
  status_RETURNED: "مُرجَع",
  ledger_SIGNUP_BONUS: "مكافأة الترحيب",
  ledger_ORDER_DELIVERED: "طلب مُسلَّم",
  ledger_ORDER_REVERSAL: "طلب ملغى",
  ledger_REDEMPTION_DEBIT: "طلب هدية",
  ledger_REDEMPTION_REFUND: "استرجاع نقاط",
  ledger_ADMIN_ADJUSTMENT: "تعديل",
};

export const REWARDS_TEXT = Object.freeze({ fr: Object.freeze(fr), ar: Object.freeze(ar) });

/** Supported languages; anything else falls back to French. */
export const rewardsLang = (lang) => (lang === 'ar' ? 'ar' : 'fr');
export const rewardsDir = (lang) => (rewardsLang(lang) === 'ar' ? 'rtl' : 'ltr');

/** Translator for one language: t('stock_low', { n: 2 }). Missing key → French → key. */
export function rewardsT(lang) {
  const dict = REWARDS_TEXT[rewardsLang(lang)];
  return (key, vars) => {
    const raw = dict[key] ?? REWARDS_TEXT.fr[key] ?? key;
    return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : raw;
  };
}

/**
 * Affiliate-facing cancellation line, always built from the dictionaries:
 * who cancelled (from the status history) + the admin's own typed reason, if
 * any, after a translated label. Text stored on an affiliate's OWN cancellation
 * is never shown, so no untranslated server text can reach the affiliate.
 * @returns {string|null} null when the request is not cancelled
 */
export function cancellationNote(redemption, lang) {
  if (redemption?.status !== 'CANCELLED') return null;
  const t = rewardsT(lang);
  const entry = (Array.isArray(redemption.history) ? redemption.history : []).find((h) => h.toStatus === 'CANCELLED');
  if (entry?.actorType === 'AFFILIATE') return t('cancelled_by_you');
  const reason = typeof redemption.cancelReason === 'string' ? redemption.cancelReason.trim() : '';
  return reason ? `${t('cancelled_by_team')} ${t('cancel_reason')} : ${reason}` : t('cancelled_by_team');
}
