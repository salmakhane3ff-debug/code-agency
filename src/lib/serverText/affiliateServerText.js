/**
 * src/lib/serverText/affiliateServerText.js
 * ─────────────────────────────────────────────────────────────────────────────
 * DISPLAY-TIME localization of the text the affiliate APIs send or store, for the
 * affiliate area (/affiliate/*). PURE: no React, no DOM, no I/O, no imports.
 *
 * The servers are NOT changed: every string below is a code-defined template the
 * server already produces (route `{ error: '…' }` literals, coded service errors,
 * the shared rate limiter / auth middleware answers, and the AffiliateNotification
 * `message` builders). The client recognises those exact strings (or anchored
 * regexes for templates with variables) and re-renders them in the market
 * language: 'ar' (MA, Arabic) or 'fr' (FR, French).
 *
 *   • French server text stays EXACTLY as sent for a French visitor (existing
 *     wording kept); English server text (UGC) is translated to French.
 *   • Anything not recognised — admin-written reasons, product titles, client /
 *     brand names, unexpected messages — is returned UNCHANGED. Stored data inside
 *     a template (names, titles, reasons, amounts) is never translated.
 *   • Currency labels follow the site rule (LanguageContext.formatPrice): Arabic
 *     « درهم », French « DH ». Amounts are kept exactly as stored.
 *
 * Proven against the real server code by scripts/affiliateServerText.test.mjs
 * (real builders where importable; pinned literals + source checks otherwise).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Unicode isolates for data embedded in Arabic sentences (names, titles, reasons,
// ratios): they never reorder the surrounding RTL text.
const LRI = '⁦';
const FSI = '⁨';
const PDI = '⁩';
const iso = (v) => `${FSI}${v}${PDI}`;
const ltr = (v) => `${LRI}${v}${PDI}`;

export const SERVER_TEXT_CURRENCY = Object.freeze({ ar: 'درهم', fr: 'DH' });

const langOf = (lang) => (lang === 'ar' ? 'ar' : 'fr');
const same = (s) => s; // French server text: shown to French visitors exactly as sent

// ── 1. Exact server messages → { ar, fr } ─────────────────────────────────────
// fr === the server text itself for French messages; a French translation for English ones.
const fr = (text, ar) => [text, Object.freeze({ ar, fr: same(text) })];
const en = (text, frText, ar) => [text, Object.freeze({ ar, fr: frText })];

export const SERVER_MESSAGES = Object.freeze(Object.fromEntries([
  // Shared: auth middleware (withAffiliateAuth), generic 500s, shared rate limiter.
  fr('Token requis', 'يرجى تسجيل الدخول.'),
  fr('Token invalide', 'جلسة غير صالحة. يرجى تسجيل الدخول من جديد.'),
  fr('Token expiré ou invalide', 'انتهت صلاحية الجلسة أو أنها غير صالحة. يرجى تسجيل الدخول من جديد.'),
  fr('Service indisponible', 'الخدمة غير متاحة حالياً. حاول مرة أخرى لاحقاً.'),
  fr('Erreur serveur', 'خطأ في الخادم'),
  en('Server error', 'Erreur serveur', 'خطأ في الخادم'),
  en('Too many requests. Please try again later.', 'Trop de requêtes. Veuillez réessayer plus tard.', 'طلبات كثيرة جداً. يرجى المحاولة لاحقاً.'),
  fr('Trop de tentatives. Réessayez plus tard.', 'محاولات كثيرة. حاول مرة أخرى لاحقاً.'),
  fr('Requête invalide', 'طلب غير صالح'),

  // POST /api/affiliate/auth (+ loginAffiliate)
  fr('Identifiant et mot de passe requis', 'اسم المستخدم وكلمة المرور مطلوبان'),
  fr('Identifiant ou mot de passe incorrect', 'اسم المستخدم أو كلمة المرور غير صحيحة'),
  fr("Compte inactif. Contactez l'administrateur.", 'الحساب غير مفعّل. تواصل مع الإدارة.'),

  // GET/PUT /api/affiliate/me (profile, password)
  fr('Affilié introuvable', 'المسوّق غير موجود'),
  fr('Mot de passe actuel requis', 'كلمة المرور الحالية مطلوبة'),
  fr('Mot de passe actuel incorrect', 'كلمة المرور الحالية غير صحيحة'),

  // POST /api/affiliate/avatar
  fr('Aucun fichier fourni', 'لم يتم إرسال أي ملف'),
  fr('Seules les images sont acceptées', 'الصور فقط مقبولة'),
  fr('Image trop lourde (max 2 Mo)', 'الصورة كبيرة جداً (الحد الأقصى 2 ميغابايت)'),

  // POST /api/affiliate/identity (+ identityService / identityStorage)
  fr('Les deux faces de la CIN sont requises.', 'وجها البطاقة الوطنية مطلوبان.'),
  fr('Chaque image doit faire au maximum 5 Mo.', 'يجب ألا يتجاوز حجم كل صورة 5 ميغابايت.'),
  fr('Fichier invalide (type JPG/PNG/WEBP, max 5 Mo).', 'ملف غير صالح (JPG أو PNG أو WEBP، 5 ميغابايت كحد أقصى).'),
  fr('Fichier image invalide', 'ملف الصورة غير صالح'),
  fr('Votre identité est déjà vérifiée.', 'تم التحقق من هويتك مسبقاً.'),
  fr('Une vérification est déjà en cours.', 'هناك طلب تحقق قيد المراجعة بالفعل.'),

  // POST /api/affiliate/payout (+ requestPayout)
  fr('Montant invalide', 'مبلغ غير صالح'),
  fr('Veuillez ajouter vos coordonnées bancaires avant de demander un retrait.', 'يرجى إضافة معلوماتك البنكية قبل طلب السحب.'),
  fr('Votre identité doit être vérifiée avant de pouvoir effectuer un retrait.', 'يجب التحقق من هويتك قبل أن تتمكن من السحب.'),
  fr('Montant supérieur aux gains disponibles', 'المبلغ أكبر من الأرباح المتاحة'),

  // POST /api/affiliate/claim-bonus (+ claimTeamBonus)
  fr('Bonus déjà réclamé', 'تمت المطالبة بالمكافأة مسبقاً'),

  // POST /api/affiliate/boosters (+ boosterService)
  fr('Méthode de paiement invalide', 'طريقة دفع غير صالحة'),
  fr('Les boosters sont désactivés pour le moment', 'الباقات متوقفة حالياً'),
  fr('Pack introuvable ou inactif', 'الباقة غير موجودة أو غير نشطة'),
  fr('Vous avez déjà ce pack (actif ou en attente)', 'لديك هذه الباقة بالفعل (نشطة أو قيد الانتظار)'),
  fr('Solde insuffisant', 'رصيد غير كافٍ'),

  // POST /api/affiliate/deposits (+ depositService)
  fr('La preuve du virement est requise.', 'إثبات التحويل مطلوب.'),
  fr('Fichier trop volumineux (max 8 Mo).', 'الملف كبير جداً (الحد الأقصى 8 ميغابايت).'),
  fr('Vous avez déjà une demande en attente de validation.', 'لديك بالفعل طلب في انتظار التحقق.'),
  fr('La recharge de solde est désactivée pour le moment.', 'شحن الرصيد متوقف حالياً.'), // admin switch "Recharge de solde des Affiliés" OFF
  fr('Montant invalide.', 'مبلغ غير صالح.'),
  fr('Méthode de paiement requise.', 'طريقة الدفع مطلوبة.'),
  fr('Fichier invalide (JPG/PNG/WEBP/PDF, max 8 Mo).', 'ملف غير صالح (JPG أو PNG أو WEBP أو PDF، 8 ميغابايت كحد أقصى).'),

  // /api/affiliate/ugc** (ugcService, ugcUpload, ugcRouteHandlers, video validation) — English → fr / ar
  en('affiliate identity required', "Identité de l'affilié requise. Reconnectez-vous.", 'هوية المسوّق مطلوبة. يرجى تسجيل الدخول من جديد.'),
  en('UGC uploads are currently disabled', "L'envoi de vidéos UGC est désactivé pour le moment.", 'رفع فيديوهات UGC متوقف حالياً.'),
  en('productId required', 'Choisissez un produit.', 'يرجى اختيار منتج.'),
  en('advertising consent is required', 'Le consentement à l’usage publicitaire est requis.', 'الموافقة على الاستخدام الإعلاني مطلوبة.'),
  en('product not found', 'Produit introuvable.', 'المنتج غير موجود.'),
  en('product is not active', "Ce produit n'est pas actif.", 'هذا المنتج غير نشط.'),
  en('a submission already exists for this product — replace it instead', 'Une vidéo existe déjà pour ce produit : remplacez-la.', 'يوجد فيديو لهذا المنتج بالفعل: استبدله بدلاً من ذلك.'),
  en('a submission already exists for this product', 'Une vidéo existe déjà pour ce produit.', 'يوجد فيديو لهذا المنتج بالفعل.'),
  en('invalid video', 'Vidéo invalide.', 'فيديو غير صالح.'),
  en('submission not found', 'Vidéo introuvable.', 'الفيديو غير موجود.'),
  en('not your submission', 'Cette vidéo ne vous appartient pas.', 'هذا الفيديو لا يخصك.'),
  en('submission changed concurrently', 'La vidéo a été modifiée entre-temps. Réessayez.', 'تم تعديل الفيديو في الأثناء. أعد المحاولة.'),
  en('submission status changed concurrently', 'Le statut de la vidéo a changé entre-temps. Réessayez.', 'تغيّرت حالة الفيديو في الأثناء. أعد المحاولة.'),
  en('unknown action', 'Action inconnue.', 'إجراء غير معروف.'),
  en('a video file is required', 'Un fichier vidéo est requis.', 'ملف الفيديو مطلوب.'),
  en('the uploaded file is not a video', "Le fichier envoyé n'est pas une vidéo.", 'الملف المرسل ليس فيديو.'),
  en('the video file is empty', 'Le fichier vidéo est vide.', 'ملف الفيديو فارغ.'),
  // video validation reasons (ugcVideoValidation: extractMp4Metadata + checkVideoPolicy)
  en('empty file', 'Fichier vide.', 'ملف فارغ.'),
  en('unrecognized container — not a valid video file', "Format non reconnu : ce n'est pas une vidéo valide.", 'صيغة غير معروفة: هذا ليس ملف فيديو صالحاً.'),
  en('only MP4/MOV videos can be parsed by the JS validator', 'Seules les vidéos MP4/MOV sont acceptées.', 'تُقبل فيديوهات MP4/MOV فقط.'),
  en('corrupted or truncated video structure', 'Vidéo corrompue ou incomplète.', 'الفيديو تالف أو غير مكتمل.'),
  en('missing ftyp header', 'En-tête vidéo manquant (ftyp).', 'ترويسة الفيديو مفقودة (ftyp).'),
  en('corrupted video structure', 'Structure vidéo corrompue.', 'بنية الفيديو تالفة.'),
  en('missing moov — incomplete video (e.g. still uploading)', 'Vidéo incomplète (données moov manquantes).', 'الفيديو غير مكتمل (بيانات moov مفقودة).'),
  en('corrupted movie header', 'En-tête vidéo corrompu.', 'ترويسة الفيديو تالفة.'),
  en('missing movie header (mvhd)', 'En-tête vidéo manquant (mvhd).', 'ترويسة الفيديو مفقودة (mvhd).'),
  en('could not determine video duration', 'Impossible de déterminer la durée de la vidéo.', 'تعذّر تحديد مدة الفيديو.'),
  en('corrupted sample description', 'Description des pistes vidéo corrompue.', 'وصف مسارات الفيديو تالف.'),
  en('file exceeds maximum size', 'Le fichier dépasse la taille maximale.', 'الملف يتجاوز الحجم الأقصى.'),
  en('unknown container', 'Format vidéo inconnu.', 'صيغة فيديو غير معروفة.'),
  en('no readable video codec', 'Aucun codec vidéo lisible.', 'لا يوجد ترميز فيديو قابل للقراءة.'),
]));

// ── 2. Server templates with variables (anchored) ─────────────────────────────
// Each: { id, re, ar(m), fr(m) } — `m` is the RegExp match; variables are data, kept as is.
export const SERVER_TEMPLATES = Object.freeze([
  {
    // PUT /api/affiliate/me: `Le mot de passe doit contenir entre ${PASSWORD_MIN} et ${PASSWORD_MAX} caractères`
    id: 'password_length',
    re: /^Le mot de passe doit contenir entre (\d+) et (\d+) caractères$/,
    ar: (m) => `يجب أن تحتوي كلمة المرور على ما بين ${m[1]} و${m[2]} حرفاً`,
    fr: (m) => m[0],
  },
  {
    // claimTeamBonus: `Objectif non atteint : ${validReferrals} / ${required} parrainages valides`
    id: 'goal_not_met',
    re: /^Objectif non atteint : (\d+) \/ (\d+) parrainages valides$/,
    ar: (m) => `لم يتم بلوغ الهدف: ${ltr(`${m[1]} / ${m[2]}`)} إحالات صالحة`,
    fr: (m) => m[0],
  },
  {
    // ugcService.replaceSubmission: `cannot replace a submission in status ${sub.status}`
    id: 'ugc_not_replaceable',
    re: /^cannot replace a submission in status (\S+)$/,
    ar: (m) => `لا يمكن استبدال فيديو في الحالة ${iso(m[1])}.`,
    fr: (m) => `Impossible de remplacer une vidéo au statut ${m[1]}.`,
  },
  {
    // ugcService.transitionStatus: `${actorType} may not set status ${toStatus}`
    id: 'ugc_illegal_transition',
    re: /^(\S+) may not set status (\S+)$/,
    ar: (m) => `تغيير الحالة إلى ${iso(m[2])} غير مسموح به.`,
    fr: (m) => `Passage au statut ${m[2]} non autorisé.`,
  },
  {
    // ugcUpload: `upload exceeds the ${maxBytes}-byte limit` / `the video exceeds the ${maxBytes}-byte limit`
    id: 'ugc_too_large',
    re: /^(?:upload|the video) exceeds the (\d+)-byte limit$/,
    ar: (m) => `الفيديو يتجاوز الحجم الأقصى (${m[1]} بايت).`,
    fr: (m) => `La vidéo dépasse la taille maximale (${m[1]} octets).`,
  },
  {
    // checkVideoPolicy: `unsupported container: ${meta.container}`
    id: 'video_container',
    re: /^unsupported container: ([\s\S]+)$/,
    ar: (m) => `صيغة الفيديو غير مدعومة: ${iso(m[1])}`,
    fr: (m) => `Format vidéo non pris en charge : ${m[1]}`,
  },
  {
    // checkVideoPolicy: `video too short: ${dur.toFixed(1)}s (min ${minSeconds}s)`
    id: 'video_too_short',
    re: /^video too short: ([\d.]+)s \(min ([\d.]+)s\)$/,
    ar: (m) => `الفيديو قصير جداً: ${m[1]} ث (الحد الأدنى ${m[2]} ث)`,
    fr: (m) => `Vidéo trop courte : ${m[1]} s (minimum ${m[2]} s)`,
  },
  {
    // checkVideoPolicy: `video too long: ${dur.toFixed(1)}s (max ${maxSeconds}s)`
    id: 'video_too_long',
    re: /^video too long: ([\d.]+)s \(max ([\d.]+)s\)$/,
    ar: (m) => `الفيديو طويل جداً: ${m[1]} ث (الحد الأقصى ${m[2]} ث)`,
    fr: (m) => `Vidéo trop longue : ${m[1]} s (maximum ${m[2]} s)`,
  },
  {
    // checkVideoPolicy: `unsupported video codec: ${codecs.join(', ')}`
    id: 'video_codec',
    re: /^unsupported video codec: ([\s\S]+)$/,
    ar: (m) => `ترميز الفيديو غير مدعوم: ${iso(m[1])}`,
    fr: (m) => `Codec vidéo non pris en charge : ${m[1]}`,
  },
]);

// ── 3. Unambiguous error CODES → { ar, fr } (used when the message is not recognised) ──
// Codes whose meaning depends on the route (INVALID_INPUT, NOT_FOUND, INSUFFICIENT_BALANCE,
// PACKAGE_NOT_FOUND, INVALID_AMOUNT, NOT_PENDING…) are deliberately absent: their MESSAGE decides.
// Brand / Rewards codes are translated by their own dictionaries (brandI18n / rewardsI18n code_*).
const code = (c, frText, ar) => [c, Object.freeze({ ar, fr: frText })];
export const SERVER_CODES = Object.freeze(Object.fromEntries([
  code('SERVER_ERROR', 'Erreur serveur', 'خطأ في الخادم'),
  code('RATE_LIMITED', 'Trop de tentatives. Réessayez plus tard.', 'محاولات كثيرة. حاول مرة أخرى لاحقاً.'),
  code('INVALID_CREDENTIALS', 'Identifiant ou mot de passe incorrect', 'اسم المستخدم أو كلمة المرور غير صحيحة'),
  code('INCOMPLETE_BANK_INFO', 'Veuillez ajouter vos coordonnées bancaires avant de demander un retrait.', 'يرجى إضافة معلوماتك البنكية قبل طلب السحب.'),
  code('IDENTITY_NOT_VERIFIED', 'Votre identité doit être vérifiée avant de pouvoir effectuer un retrait.', 'يجب التحقق من هويتك قبل أن تتمكن من السحب.'),
  code('ALREADY_CLAIMED', 'Bonus déjà réclamé', 'تمت المطالبة بالمكافأة مسبقاً'),
  code('GOAL_NOT_MET', 'Objectif non atteint.', 'لم يتم بلوغ الهدف.'),
  code('INVALID_METHOD', 'Méthode de paiement invalide', 'طريقة دفع غير صالحة'),
  code('BOOSTERS_DISABLED', 'Les boosters sont désactivés pour le moment', 'الباقات متوقفة حالياً'),
  code('ALREADY_OWNED', 'Vous avez déjà ce pack (actif ou en attente)', 'لديك هذه الباقة بالفعل (نشطة أو قيد الانتظار)'),
  code('DEPOSIT_PENDING_EXISTS', 'Vous avez déjà une demande en attente de validation.', 'لديك بالفعل طلب في انتظار التحقق.'),
  code('DEPOSIT_INVALID_AMOUNT', 'Montant invalide.', 'مبلغ غير صالح.'),
  code('DEPOSIT_NO_METHOD', 'Méthode de paiement requise.', 'طريقة الدفع مطلوبة.'),
  code('DEPOSIT_NO_PROOF', 'La preuve du virement est requise.', 'إثبات التحويل مطلوب.'),
  code('DEPOSIT_INVALID_FILE', 'Fichier invalide (JPG/PNG/WEBP/PDF, max 8 Mo).', 'ملف غير صالح (JPG أو PNG أو WEBP أو PDF، 8 ميغابايت كحد أقصى).'),
  code('DEPOSIT_DISABLED', 'La recharge de solde est désactivée pour le moment.', 'شحن الرصيد متوقف حالياً.'),
  code('CIN_BOTH_REQUIRED', 'Les deux faces de la CIN sont requises.', 'وجها البطاقة الوطنية مطلوبان.'),
  code('CIN_INVALID_FILE', 'Fichier invalide (type JPG/PNG/WEBP, max 5 Mo).', 'ملف غير صالح (JPG أو PNG أو WEBP، 5 ميغابايت كحد أقصى).'),
  code('CIN_INVALID_IMAGE', 'Fichier image invalide', 'ملف الصورة غير صالح'),
  code('IDENTITY_ALREADY_APPROVED', 'Votre identité est déjà vérifiée.', 'تم التحقق من هويتك مسبقاً.'),
  code('IDENTITY_ALREADY_PENDING', 'Une vérification est déjà en cours.', 'هناك طلب تحقق قيد المراجعة بالفعل.'),
  code('UGC_UNAUTHENTICATED', "Identité de l'affilié requise. Reconnectez-vous.", 'هوية المسوّق مطلوبة. يرجى تسجيل الدخول من جديد.'),
  code('UGC_FORBIDDEN', 'Cette vidéo ne vous appartient pas.', 'هذا الفيديو لا يخصك.'),
  code('UGC_DISABLED', "L'envoi de vidéos UGC est désactivé pour le moment.", 'رفع فيديوهات UGC متوقف حالياً.'),
  code('UGC_NOT_FOUND', 'Vidéo introuvable.', 'الفيديو غير موجود.'),
  code('UGC_PRODUCT_NOT_FOUND', 'Produit introuvable.', 'المنتج غير موجود.'),
  code('UGC_BAD_INPUT', 'Requête invalide.', 'طلب غير صالح.'),
  code('UGC_CONSENT_REQUIRED', 'Le consentement à l’usage publicitaire est requis.', 'الموافقة على الاستخدام الإعلاني مطلوبة.'),
  code('UGC_INVALID_VIDEO', 'Vidéo invalide.', 'فيديو غير صالح.'),
  code('UGC_PRODUCT_INACTIVE', "Ce produit n'est pas actif.", 'هذا المنتج غير نشط.'),
  code('UGC_ALREADY_SUBMITTED', 'Une vidéo existe déjà pour ce produit.', 'يوجد فيديو لهذا المنتج بالفعل.'),
  code('UGC_NOT_REPLACEABLE', 'Cette vidéo ne peut pas être remplacée dans son statut actuel.', 'لا يمكن استبدال هذا الفيديو في حالته الحالية.'),
  code('UGC_ILLEGAL_TRANSITION', 'Changement de statut non autorisé.', 'تغيير الحالة غير مسموح به.'),
  code('UGC_REPLACE_CONFLICT', 'La vidéo a été modifiée entre-temps. Réessayez.', 'تم تعديل الفيديو في الأثناء. أعد المحاولة.'),
  code('UGC_TRANSITION_CONFLICT', 'Le statut de la vidéo a changé entre-temps. Réessayez.', 'تغيّرت حالة الفيديو في الأثناء. أعد المحاولة.'),
  code('UGC_UPLOAD_TOO_LARGE', 'La vidéo dépasse la taille maximale.', 'الفيديو يتجاوز الحجم الأقصى.'),
  code('UGC_ERROR', 'Erreur serveur', 'خطأ في الخادم'),
]));

const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;

function messageOf(text, L) {
  if (typeof text !== 'string' || !text) return null;
  const key = Object.prototype.hasOwnProperty.call(SERVER_MESSAGES, text) ? text
    : Object.prototype.hasOwnProperty.call(SERVER_MESSAGES, text.trim()) ? text.trim() : null;
  if (key !== null) return SERVER_MESSAGES[key][L];
  for (const tpl of SERVER_TEMPLATES) {
    const m = tpl.re.exec(text);
    if (m) return tpl[L](m);
  }
  return null;
}
function codeOf(c, L) {
  if (typeof c !== 'string' || !CODE_RE.test(c)) return null;
  return Object.prototype.hasOwnProperty.call(SERVER_CODES, c) ? SERVER_CODES[c][L] : null;
}

/**
 * The market-language text of a RECOGNISED server error, else null.
 * @param {string | {error?: string, text?: string, code?: string}} input  server message, code, or a body / message object
 * @param {'ar'|'fr'} lang
 */
export function knownServerError(input, lang) {
  const L = langOf(lang);
  if (input && typeof input === 'object') {
    const text = typeof input.error === 'string' ? input.error : input.text;
    return messageOf(text, L) ?? codeOf(input.code, L);
  }
  return messageOf(input, L) ?? codeOf(input, L);
}

/**
 * Server error / notice text in the market language. Unknown text is returned
 * UNCHANGED (for an object: its `error` / `text`, else its `code`, else '').
 */
export function localizeServerError(input, lang) {
  const known = knownServerError(input, lang);
  if (known !== null) return known;
  if (input && typeof input === 'object') {
    const text = typeof input.error === 'string' ? input.error : input.text;
    return typeof text === 'string' && text ? text : (typeof input.code === 'string' ? input.code : '');
  }
  return input == null ? '' : String(input);
}

// ── 4. AffiliateNotification.message templates ────────────────────────────────
// Sources (exact server builders):
//   affiliateSystemService.recordAffiliateOrder        `Nouvelle commande: ${total} MAD - Client: ${clientName || 'Inconnu'}${isSuspicious ? ' ⚠' : ''}`
//   affiliateSystemService.syncLinkedAffiliateOrderStatus `Commande ${label}: ${total} MAD - Client: ${clientName || 'Inconnu'}`
//   depositService.adminApproveDeposit                 `Votre dépôt de solde de ${amount} MAD a été approuvé et ajouté à votre solde disponible.`
//   depositService.adminRejectDeposit                  `Votre dépôt de solde a été refusé.\nRaison :\n${reason}`
//   ugcNotifications.affiliateMessage                  5 events, optional ` (${productTitle})`
//   brandNotifications MESSAGES                        6 types
const AMOUNT = '(-?\\d+|NaN|-?Infinity)';
const UNKNOWN_CLIENT = Object.freeze({ ar: 'غير معروف', fr: 'Inconnu' });
const clientOf = (name, L) => (name === 'Inconnu' ? UNKNOWN_CLIENT[L] : name);
const ORDER_STATUS_AR = Object.freeze({
  'confirmée': 'تم تأكيد الطلب',
  'expédiée': 'تم شحن الطلب',
  'livrée': 'تم توصيل الطلب',
  'annulée': 'تم إلغاء الطلب',
  'en attente': 'الطلب قيد الانتظار',
});
export const ORDER_NOTIFICATION_LABELS = Object.freeze(Object.keys(ORDER_STATUS_AR));

const BRAND_FR = 'Create Your Own Brand';
const BRAND_AR = 'أنشئ علامتك التجارية';

const UGC_BASE = Object.freeze([
  ['🎬 Votre vidéo a bien été reçue et sera examinée par notre équipe.', '🎬 تم استلام الفيديو الخاص بك وسيراجعه فريقنا.'],
  ['✅ Votre vidéo a été approuvée.', '✅ تمت الموافقة على الفيديو الخاص بك.'],
  ['▶️ Votre vidéo est maintenant en diffusion et peut générer des gains.', '▶️ الفيديو الخاص بك قيد النشر الآن ويمكنه تحقيق أرباح.'],
  ['⏸️ Votre vidéo a été mise en pause : elle ne génère plus de gains.', '⏸️ تم إيقاف الفيديو الخاص بك مؤقتاً: لم يعد يحقق أرباحاً.'],
]);
const productSuffix = (title, L) => (title === undefined ? '' : ` (${L === 'ar' ? iso(title) : title})`);

export const NOTIFICATION_TEMPLATES = Object.freeze([
  {
    id: 'order_new',
    re: new RegExp(`^Nouvelle commande: ${AMOUNT} MAD - Client: ([\\s\\S]*?)( ⚠)?$`),
    ar: (m) => `طلب جديد: ${m[1]} ${SERVER_TEXT_CURRENCY.ar} - العميل: ${iso(clientOf(m[2], 'ar'))}${m[3] || ''}`,
    fr: (m) => `Nouvelle commande: ${m[1]} ${SERVER_TEXT_CURRENCY.fr} - Client: ${m[2]}${m[3] || ''}`,
  },
  {
    id: 'order_status',
    re: new RegExp(`^Commande ([^:\\n]+): ${AMOUNT} MAD - Client: ([\\s\\S]*)$`),
    ar: (m) => `${ORDER_STATUS_AR[m[1]] ?? `الطلب ${iso(m[1])}`}: ${m[2]} ${SERVER_TEXT_CURRENCY.ar} - العميل: ${iso(clientOf(m[3], 'ar'))}`,
    fr: (m) => `Commande ${m[1]}: ${m[2]} ${SERVER_TEXT_CURRENCY.fr} - Client: ${m[3]}`,
  },
  {
    id: 'deposit_approved',
    re: new RegExp(`^Votre dépôt de solde de ${AMOUNT} MAD a été approuvé et ajouté à votre solde disponible\\.$`),
    ar: (m) => `تمت الموافقة على شحن رصيدك بمبلغ ${m[1]} ${SERVER_TEXT_CURRENCY.ar} وأُضيف إلى رصيدك المتاح.`,
    fr: (m) => `Votre dépôt de solde de ${m[1]} ${SERVER_TEXT_CURRENCY.fr} a été approuvé et ajouté à votre solde disponible.`,
  },
  {
    id: 'deposit_rejected',
    re: /^Votre dépôt de solde a été refusé\.\nRaison :\n([\s\S]*)$/,
    ar: (m) => `تم رفض طلب شحن الرصيد.\nالسبب:\n${iso(m[1])}`,
    fr: (m) => m[0],
  },
  {
    id: 'ugc_status',
    // received / approved / running / paused (+ optional product title)
    match: (msg) => {
      for (const [base, ar] of UGC_BASE) {
        if (!msg.startsWith(base)) continue;
        const rest = msg.slice(base.length);
        if (rest === '') return { base, ar, title: undefined };
        const t = /^ \(([\s\S]*)\)$/.exec(rest);
        if (t) return { base, ar, title: t[1] };
      }
      return null;
    },
    ar: (m) => `${m.ar}${productSuffix(m.title, 'ar')}`,
    fr: (m) => `${m.base}${productSuffix(m.title, 'fr')}`,
  },
  {
    id: 'ugc_rejected',
    re: /^❌ Votre vidéo a été refusée\.(?: Motif : ([\s\S]*?))? Vous pouvez la remplacer\.(?: \(([\s\S]*)\))?$/,
    ar: (m) => `❌ تم رفض الفيديو الخاص بك.${m[1] !== undefined ? ` السبب: ${iso(m[1])}` : ''} يمكنك استبداله.${productSuffix(m[2], 'ar')}`,
    fr: (m) => m[0],
  },
  {
    id: 'brand_submitted',
    re: new RegExp(`^${BRAND_FR} : votre preuve de paiement pour « ([\\s\\S]*) » a bien été reçue\\. Elle sera vérifiée par l'équipe\\.$`),
    ar: (m) => `${BRAND_AR}: تم استلام إثبات الدفع الخاص بـ « ${iso(m[1])} ». سيتحقق منه الفريق.`,
    fr: (m) => m[0],
  },
  {
    id: 'brand_accepted',
    re: new RegExp(`^${BRAND_FR} : votre paiement pour « ([\\s\\S]*) » a été validé\\. Votre accès au simulateur de formation est activé\\.$`),
    ar: (m) => `${BRAND_AR}: تم تأكيد دفعتك الخاصة بـ « ${iso(m[1])} ». تم تفعيل وصولك إلى محاكي التدريب.`,
    fr: (m) => m[0],
  },
  {
    id: 'brand_rejected',
    re: new RegExp(`^${BRAND_FR} : votre demande « ([\\s\\S]*?) » a été refusée\\.\\nRaison :\\n([\\s\\S]*)$`),
    ar: (m) => `${BRAND_AR}: تم رفض طلبك « ${iso(m[1])} ».\nالسبب:\n${iso(m[2])}`,
    fr: (m) => m[0],
  },
  {
    id: 'brand_closed',
    re: new RegExp(`^${BRAND_FR} : votre marque « ([\\s\\S]*?) » a été clôturée\\. Son historique reste consultable\\.\\nRaison :\\n([\\s\\S]*)$`),
    ar: (m) => `${BRAND_AR}: تم إغلاق علامتك التجارية « ${iso(m[1])} ». يبقى سجلها متاحاً للاطلاع.\nالسبب:\n${iso(m[2])}`,
    fr: (m) => m[0],
  },
  {
    id: 'brand_reopened',
    re: new RegExp(`^${BRAND_FR} : votre marque « ([\\s\\S]*) » a été réouverte\\. La simulation reprend à partir de maintenant\\.$`),
    ar: (m) => `${BRAND_AR}: تمت إعادة فتح علامتك التجارية « ${iso(m[1])} ». تُستأنف المحاكاة ابتداءً من الآن.`,
    fr: (m) => m[0],
  },
  {
    id: 'brand_authorized',
    re: new RegExp(`^${BRAND_FR} : vous êtes autorisé\\(e\\) à faire une nouvelle demande de marque\\.$`),
    ar: () => `${BRAND_AR}: أصبح بإمكانك تقديم طلب علامة تجارية جديد.`,
    fr: (m) => m[0],
  },
]);

/** Which notification template a stored message matches (id), or null. Exported for tests. */
export function notificationTemplateOf(message) {
  if (typeof message !== 'string') return null;
  for (const tpl of NOTIFICATION_TEMPLATES) {
    if (tpl.match ? tpl.match(message) : tpl.re.exec(message)) return tpl.id;
  }
  return null;
}

/**
 * A stored AffiliateNotification.message re-rendered in the market language.
 * The stored text is never modified; unrecognised messages are returned unchanged.
 */
export function localizeNotification(message, lang) {
  if (typeof message !== 'string' || !message) return message ?? '';
  const L = langOf(lang);
  for (const tpl of NOTIFICATION_TEMPLATES) {
    const m = tpl.match ? tpl.match(message) : tpl.re.exec(message);
    if (m) return tpl[L](m);
  }
  return message;
}
