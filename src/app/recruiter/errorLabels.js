/**
 * src/app/recruiter/errorLabels.js
 * Arabic texts for the recruiter error CODES (allowlisted in recruiterVisibility.js).
 * Server text is never shown: an unknown or missing code gets the generic label.
 */
import { RECRUITER_ERROR_CODES } from "@/lib/recruiterVisibility";

const LABELS = {
  INVALID_CREDENTIALS: "اسم المستخدم أو كلمة السر غير صحيحة",
  RECRUITER_DISABLED: "هذا الحساب معطّل. تواصل مع الإدارة.",
  RATE_LIMITED: "محاولات كثيرة، حاول بعد دقيقة",
  UNAUTHORIZED: "انتهت الجلسة، المرجو تسجيل الدخول من جديد.",
  INVALID_INPUT: "المرجو التحقق من المعلومات المدخلة.",
};
export const GENERIC_ERROR = "وقع خطأ، المرجو المحاولة من جديد.";

/** Arabic label for an error code (only codes from RECRUITER_ERROR_CODES are recognised). */
export function recruiterErrorLabel(code) {
  return RECRUITER_ERROR_CODES.includes(code) && LABELS[code] ? LABELS[code] : GENERIC_ERROR;
}
