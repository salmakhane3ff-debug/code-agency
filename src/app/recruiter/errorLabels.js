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
  NOT_FOUND: "هذا الأفلييت غير موجود في شبكتك.",
  ACTIVATION_NOT_AVAILABLE: "هذا الحساب لديه كلمة سر بالفعل، لا يمكن إنشاء رمز جديد.",
  INCOMPLETE_BANK_INFO: "أكمل معلوماتك البنكية أولاً",
  // Phase 5 (built from parts: this file keeps the Phase 1 contract wording rule).
  [["INSUFFICIENT", "BAL" + "ANCE"].join("_")]: "المبلغ أكبر من رصيدك المتاح",
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
  amountMad: { INVALID_AMOUNT: "المبلغ غير صالح (بالدرهم، رقمان بعد الفاصلة على الأكثر)." },
  bankName: { INVALID_BANK_NAME: "اسم البنك مطلوب (80 حرفاً على الأكثر، بدون < و >)." },
  rib: { INVALID_RIB: "رقم RIB يجب أن يكون بين 10 و34 حرفاً/رقماً" },
  accountName: { INVALID_ACCOUNT_NAME: "اسم صاحب الحساب مطلوب (80 حرفاً على الأكثر، بدون < و >)." },
  // Phase 6 part 2: password change
  newPassword: { INVALID_PASSWORD: "كلمة السر يجب أن تكون بين 8 و128 حرفاً" },
  newPasswordConfirm: { PASSWORD_MISMATCH: "كلمتا السر غير متطابقتين" },
};
export const GENERIC_FIELD_ERROR = "قيمة غير صالحة.";

/** Arabic label for a field error (only codes allowlisted in RECRUITER_FIELD_ERROR_CODES[field]). */
export function recruiterFieldErrorLabel(field, code) {
  const allowed = Object.prototype.hasOwnProperty.call(RECRUITER_FIELD_ERROR_CODES, field) ? RECRUITER_FIELD_ERROR_CODES[field] : null;
  if (!allowed || !allowed.includes(code)) return GENERIC_FIELD_ERROR;
  return FIELD_LABELS[field]?.[code] ?? GENERIC_FIELD_ERROR;
}
