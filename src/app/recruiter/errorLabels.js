/**
 * src/app/recruiter/errorLabels.js
 * Texts for the recruiter error CODES (allowlisted in recruiterVisibility.js), in the visitor's market
 * language: Arabic (MA, default — the historical output) or French (FR). Callers pass the market lang
 * (useMarketLocale → lang). Server text is never shown: an unknown or missing code gets the generic label.
 */
import { RECRUITER_ERROR_CODES, RECRUITER_FIELD_ERROR_CODES } from "@/lib/recruiterVisibility";

const LABELS = {
  INVALID_CREDENTIALS: "اسم المستخدم أو كلمة السر غير صحيحة",
  RECRUITER_DISABLED: "هذا الحساب معطّل. تواصل مع الإدارة.",
  RATE_LIMITED: "محاولات كثيرة، حاول لاحقاً.",
  UNAUTHORIZED: "انتهت الجلسة، المرجو تسجيل الدخول من جديد.",
  INVALID_INPUT: "المرجو التحقق من المعلومات المدخلة.",
  USERNAME_TAKEN: "اسم المستخدم هذا مستعمل من قبل، اختر اسماً آخر.",
  PHONE_TAKEN: "رقم الهاتف هذا مستعمل من قبل.",
  PARENT_NOT_IN_NETWORK: "الأفلييت الأب المختار ليس من شبكتك.",
  IDEMPOTENCY_CONFLICT: "تم إرسال هذا الطلب من قبل بمعلومات مختلفة. المرجو إعادة المحاولة.",
  FORBIDDEN: "ليست لديك صلاحية القيام بهذه العملية.",
  NOT_FOUND: "هذا الأفلييت غير موجود في شبكتك.",
  ACTIVATION_NOT_AVAILABLE: "هذا الحساب لديه كلمة سر بالفعل، لا يمكن إنشاء رمز جديد.",
  INCOMPLETE_BANK_INFO: "أكمل معلوماتك البنكية أولاً",
  // Phase 5 (built from parts: this file keeps the Phase 1 contract wording rule).
  [["INSUFFICIENT", "BAL" + "ANCE"].join("_")]: "رصيدك المتاح غير كافٍ لهذا المبلغ (المكافآت المسحوبة بعد إلغاء أو إرجاع طلبيات لا تُحتسب)",
  // Phase 6 part 3c: identity verification (KYC)
  RECRUITER_IDENTITY_NOT_APPROVED: "لا يمكن طلب السحب قبل قبول التحقق من هويتك (البطاقة الوطنية).",
  IDENTITY_SUBMISSION_NOT_ALLOWED: "لا يمكن إرسال وثائق جديدة الآن: طلبك قيد المراجعة أو تم قبوله.",
};
export const GENERIC_ERROR = "وقع خطأ، المرجو المحاولة من جديد.";

/** French (FR market): the same codes, the same meaning. */
const LABELS_FR = {
  INVALID_CREDENTIALS: "Nom d'utilisateur ou mot de passe incorrect",
  RECRUITER_DISABLED: "Ce compte est désactivé. Contactez l'administration.",
  RATE_LIMITED: "Trop de tentatives, réessayez plus tard.",
  UNAUTHORIZED: "Votre session a expiré, veuillez vous reconnecter.",
  INVALID_INPUT: "Veuillez vérifier les informations saisies.",
  USERNAME_TAKEN: "Ce nom d'utilisateur est déjà utilisé, choisissez-en un autre.",
  PHONE_TAKEN: "Ce numéro de téléphone est déjà utilisé.",
  PARENT_NOT_IN_NETWORK: "L'affilié parent choisi ne fait pas partie de votre réseau.",
  IDEMPOTENCY_CONFLICT: "Cette demande a déjà été envoyée avec des informations différentes. Veuillez réessayer.",
  FORBIDDEN: "Vous n'avez pas l'autorisation d'effectuer cette opération.",
  NOT_FOUND: "Cet affilié n'existe pas dans votre réseau.",
  ACTIVATION_NOT_AVAILABLE: "Ce compte a déjà un mot de passe, impossible de créer un nouveau code.",
  INCOMPLETE_BANK_INFO: "Complétez d'abord vos informations bancaires",
  [["INSUFFICIENT", "BAL" + "ANCE"].join("_")]: "Votre solde disponible est insuffisant pour ce montant (les récompenses annulées après l'annulation ou le retour de commandes ne sont pas comptées)",
  RECRUITER_IDENTITY_NOT_APPROVED: "Impossible de demander un retrait avant la validation de votre identité (carte nationale).",
  IDENTITY_SUBMISSION_NOT_ALLOWED: "Impossible d'envoyer de nouveaux documents pour le moment : votre demande est en cours de vérification ou a été acceptée.",
};
export const GENERIC_ERROR_FR = "Une erreur est survenue, veuillez réessayer.";

const isFr = (lang) => lang === "fr";

/** Label for an error code (only codes from RECRUITER_ERROR_CODES are recognised); lang 'ar' (default) | 'fr'. */
export function recruiterErrorLabel(code, lang = "ar") {
  const labels = isFr(lang) ? LABELS_FR : LABELS;
  const generic = isFr(lang) ? GENERIC_ERROR_FR : GENERIC_ERROR;
  return RECRUITER_ERROR_CODES.includes(code) && labels[code] ? labels[code] : generic;
}

const FIELD_LABELS = {
  username: { INVALID_USERNAME: "اسم المستخدم: من 3 إلى 30 حرفاً (حروف لاتينية صغيرة، أرقام، . _ -) ويحتوي على حرف واحد على الأقل." },
  name: { INVALID_NAME: "الاسم: من 2 إلى 80 حرفاً، بدون الرمزين < و >." },
  password: { INVALID_PASSWORD: "كلمة السر: من 8 إلى 128 حرفاً." },
  phone: { INVALID_PHONE: "رقم الهاتف غير صحيح (من 8 إلى 15 رقماً)." },
  parentId: { INVALID_PARENT: "الأفلييت الأب غير صالح." },
  requestId: { INVALID_REQUEST_ID: "وقع خطأ في الطلب، المرجو إعادة المحاولة." },
  body: { UNKNOWN_FIELD: "الطلب يحتوي على معلومات غير مقبولة.", TOO_LARGE: "حجم الملفات كبير جداً (5 ميغابايت على الأكثر لكل صورة)." },
  amountMad: { INVALID_AMOUNT: "المبلغ غير صالح (بالدرهم، رقمان بعد الفاصلة على الأكثر)." },
  bankName: { INVALID_BANK_NAME: "اسم البنك مطلوب (80 حرفاً على الأكثر، بدون < و >)." },
  rib: { INVALID_RIB: "رقم RIB يجب أن يكون بين 10 و34 حرفاً/رقماً" },
  accountName: { INVALID_ACCOUNT_NAME: "اسم صاحب الحساب مطلوب (80 حرفاً على الأكثر، بدون < و >)." },
  // Phase 6 part 2: password change
  newPassword: { INVALID_PASSWORD: "كلمة السر يجب أن تكون بين 8 و128 حرفاً" },
  newPasswordConfirm: { PASSWORD_MISMATCH: "كلمتا السر غير متطابقتين" },
  // Phase 6 part 3c: CIN upload
  front: { FILE_REQUIRED: "صورة الوجه الأمامي للبطاقة مطلوبة.", FILE_TOO_LARGE: "الصورة أكبر من 5 ميغابايت.", INVALID_FILE: "الملف ليس صورة صالحة (JPG أو PNG أو WEBP)." },
  back: { FILE_REQUIRED: "صورة الوجه الخلفي للبطاقة مطلوبة.", FILE_TOO_LARGE: "الصورة أكبر من 5 ميغابايت.", INVALID_FILE: "الملف ليس صورة صالحة (JPG أو PNG أو WEBP)." },
};
export const GENERIC_FIELD_ERROR = "قيمة غير صالحة.";

const FIELD_LABELS_FR = {
  username: { INVALID_USERNAME: "Nom d'utilisateur : de 3 à 30 caractères (lettres latines minuscules, chiffres, . _ -) avec au moins une lettre." },
  name: { INVALID_NAME: "Nom : de 2 à 80 caractères, sans les symboles < et >." },
  password: { INVALID_PASSWORD: "Mot de passe : de 8 à 128 caractères." },
  phone: { INVALID_PHONE: "Numéro de téléphone invalide (de 8 à 15 chiffres)." },
  parentId: { INVALID_PARENT: "L'affilié parent n'est pas valide." },
  requestId: { INVALID_REQUEST_ID: "Erreur dans la demande, veuillez réessayer." },
  body: { UNKNOWN_FIELD: "La demande contient des informations non acceptées.", TOO_LARGE: "Fichiers trop volumineux (5 Mo maximum par image)." },
  amountMad: { INVALID_AMOUNT: "Montant invalide (en dirhams, deux décimales maximum)." },
  bankName: { INVALID_BANK_NAME: "Le nom de la banque est obligatoire (80 caractères maximum, sans < et >)." },
  rib: { INVALID_RIB: "Le RIB doit contenir entre 10 et 34 lettres/chiffres" },
  accountName: { INVALID_ACCOUNT_NAME: "Le nom du titulaire du compte est obligatoire (80 caractères maximum, sans < et >)." },
  newPassword: { INVALID_PASSWORD: "Le mot de passe doit contenir entre 8 et 128 caractères" },
  newPasswordConfirm: { PASSWORD_MISMATCH: "Les deux mots de passe ne correspondent pas" },
  front: { FILE_REQUIRED: "La photo du recto de la carte est obligatoire.", FILE_TOO_LARGE: "L'image dépasse 5 Mo.", INVALID_FILE: "Le fichier n'est pas une image valide (JPG, PNG ou WEBP)." },
  back: { FILE_REQUIRED: "La photo du verso de la carte est obligatoire.", FILE_TOO_LARGE: "L'image dépasse 5 Mo.", INVALID_FILE: "Le fichier n'est pas une image valide (JPG, PNG ou WEBP)." },
};
export const GENERIC_FIELD_ERROR_FR = "Valeur invalide.";

/** Label for a field error (only codes allowlisted in RECRUITER_FIELD_ERROR_CODES[field]); lang 'ar' (default) | 'fr'. */
export function recruiterFieldErrorLabel(field, code, lang = "ar") {
  const generic = isFr(lang) ? GENERIC_FIELD_ERROR_FR : GENERIC_FIELD_ERROR;
  const allowed = Object.prototype.hasOwnProperty.call(RECRUITER_FIELD_ERROR_CODES, field) ? RECRUITER_FIELD_ERROR_CODES[field] : null;
  if (!allowed || !allowed.includes(code)) return generic;
  return (isFr(lang) ? FIELD_LABELS_FR : FIELD_LABELS)[field]?.[code] ?? generic;
}
