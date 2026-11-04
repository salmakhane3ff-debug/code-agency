/**
 * src/app/recruiter/errorLabels.js
 * Arabic texts for the recruiter error CODES (allowlisted in recruiterVisibility.js).
 * Server text is never shown: an unknown or missing code gets the generic label.
 */
import { RECRUITER_ERROR_CODES, RECRUITER_FIELD_ERROR_CODES } from "@/lib/recruiterVisibility";

const LABELS = {
  INVALID_CREDENTIALS: "اسم المستخدم أو كلمة السر غير صحيحة",
  RECRUITER_DISABLED: "هذا الحساب معطّل. تواصل مع الإدارة.",
  RATE_LIMITED: "محاولات كثيرة، حاول بعد دقيقة",
  UNAUTHORIZED: "انتهت الجلسة، المرجو تسجيل الدخول من جديد.",
  INVALID_INPUT: "المرجو التحقق من المعلومات المدخلة.",
  USERNAME_TAKEN: "اسم المستخدم هذا مستعمل من قبل، اختر اسماً آخر.",
  PHONE_TAKEN: "رقم الهاتف هذا مستعمل من قبل.",
  PARENT_NOT_IN_NETWORK: "الأفلييت الأب المختار ليس من شبكتك.",
  IDEMPOTENCY_CONFLICT: "تم إرسال هذا الطلب من قبل بمعلومات مختلفة. المرجو إعادة المحاولة.",
  FORBIDDEN: "ليست لديك صلاحية القيام بهذه العملية.",
  NOT_FOUND: "العنصر المطلوب غير موجود.",
};
export const GENERIC_ERROR = "وقع خطأ، المرجو المحاولة من جديد.";

/** Arabic label for an error code (only codes from RECRUITER_ERROR_CODES are recognised). */
export function recruiterErrorLabel(code) {
  return RECRUITER_ERROR_CODES.includes(code) && LABELS[code] ? LABELS[code] : GENERIC_ERROR;
}

const FIELD_LABELS = {
  username: { INVALID_USERNAME: "اسم المستخدم: من 3 إلى 30 حرفاً (حروف لاتينية صغيرة، أرقام، . _ -) ويحتوي على حرف واحد على الأقل." },
  name: { INVALID_NAME: "الاسم: من 2 إلى 80 حرفاً، بدون الرمزين < و >." },
  password: { INVALID_PASSWORD: "كلمة السر: من 8 إلى 128 حرفاً." },
  phone: { INVALID_PHONE: "رقم الهاتف غير صحيح (من 8 إلى 15 رقماً)." },
  parentId: { INVALID_PARENT: "الأفلييت الأب غير صالح." },
  requestId: { INVALID_REQUEST_ID: "وقع خطأ في الطلب، المرجو إعادة المحاولة." },
  body: { UNKNOWN_FIELD: "الطلب يحتوي على معلومات غير مقبولة." },
};
export const GENERIC_FIELD_ERROR = "قيمة غير صالحة.";

/** Arabic label for a field error (only codes allowlisted in RECRUITER_FIELD_ERROR_CODES[field]). */
export function recruiterFieldErrorLabel(field, code) {
  const allowed = Object.prototype.hasOwnProperty.call(RECRUITER_FIELD_ERROR_CODES, field) ? RECRUITER_FIELD_ERROR_CODES[field] : null;
  if (!allowed || !allowed.includes(code)) return GENERIC_FIELD_ERROR;
  return FIELD_LABELS[field]?.[code] ?? GENERIC_FIELD_ERROR;
}
