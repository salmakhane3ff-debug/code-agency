"use client";
/**
 * src/app/recruiter/affiliates/ActivationCodeCard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Shows a one-time affiliate ACTIVATION CODE to the recruiter (Phase 6, part 1), right
 * after it was issued (creation or regeneration). The code is only in React state: it is
 * never stored (no localStorage / sessionStorage), never logged and never fetched again —
 * the server keeps a hash only. The activation link carries the code in the URL FRAGMENT
 * (#code=…), which browsers never send to the server.
 * Also exports requestNewActivationCode(): POST /api/recruiter/affiliates/<id>/activation-code.
 * Phase 2 (UI only): styled with the recruiter area's shared ui.jsx tokens.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { Copy, KeyRound, MessageCircle } from "lucide-react";
import { toRecruiterActivationCodeView, toRecruiterError } from "@/lib/recruiterVisibility";
import { ui } from "../_components/ui";

/** Issue a new code for one of the recruiter's affiliates → { ok, status, activation?, code? }. */
export async function requestNewActivationCode(affiliateId) {
  const res = await fetch(`/api/recruiter/affiliates/${encodeURIComponent(affiliateId)}/activation-code`, {
    method: "POST", credentials: "include", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const body = await res.json().catch(() => null);
  if (res.ok) {
    const activation = toRecruiterActivationCodeView(body?.activation);
    return activation.code ? { ok: true, status: res.status, activation } : { ok: false, status: res.status, code: "SERVER_ERROR" };
  }
  return { ok: false, status: res.status, code: toRecruiterError(body).code };
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime())
    ? d.toLocaleString("ar-MA", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
};

export default function ActivationCodeCard({ activation }) {
  const [copied, setCopied] = useState("");
  const code = typeof activation?.code === "string" ? activation.code : "";
  if (!code) return null;
  const link = `${typeof window !== "undefined" ? window.location.origin : ""}/affiliate/activate#code=${encodeURIComponent(code)}`;
  const share = `https://wa.me/?text=${encodeURIComponent(`مرحباً، هذا رابط تفعيل حسابك كأفلييت. افتحه واختر كلمة السر الخاصة بك (صالح لمدة 24 ساعة):\n${link}`)}`;
  const doCopy = async (what, text) => { setCopied((await copyText(text)) ? what : "fail"); };

  return (
    <div className="rounded-2xl border border-violet-200 bg-gradient-to-b from-violet-50 to-white p-4 sm:p-5 space-y-4 min-w-0" data-activation-card>
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm" aria-hidden="true">
          <KeyRound className="w-5 h-5" />
        </span>
        <h3 className="text-base font-extrabold text-slate-900">رمز التفعيل</h3>
      </div>

      <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 leading-relaxed" role="note" data-activation-warning>
        يظهر هذا الرمز مرة واحدة فقط. أرسله للأفلييت بنفسك عبر واتساب أو أي وسيلة أخرى. لا تستعمله أنت ولا تشاركه مع أي شخص آخر.
        الأفلييت سيختار كلمة السر الخاصة به، ولن يتم تفعيل الحساب إلا بعد موافقة الإدارة.
      </p>

      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-500 mb-1.5">الرمز</p>
        <code dir="ltr" className="block w-full min-w-0 select-all break-all rounded-2xl border border-violet-200 bg-white px-3.5 py-2.5 font-mono text-sm text-left text-slate-900" data-activation-code>
          {code}
        </code>
        <button type="button" onClick={() => doCopy("code", code)} data-copy-code className={`${ui.btnSecondary} mt-2`}>
          <Copy className="w-4 h-4" aria-hidden="true" />
          نسخ الرمز
        </button>
      </div>

      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-500 mb-1.5">رابط التفعيل</p>
        <code dir="ltr" className="block w-full min-w-0 select-all break-all rounded-2xl border border-violet-200 bg-white px-3.5 py-2.5 font-mono text-xs text-left text-slate-700" data-activation-link>
          {link}
        </code>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => doCopy("link", link)} data-copy-link className={ui.btnSecondary}>
            <Copy className="w-4 h-4" aria-hidden="true" />
            نسخ الرابط
          </button>
          <a href={share} target="_blank" rel="noopener noreferrer" data-share-whatsapp
            className="inline-flex items-center justify-center gap-2 min-h-11 rounded-2xl bg-green-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-300">
            <MessageCircle className="w-4 h-4" aria-hidden="true" />
            مشاركة عبر واتساب
          </a>
        </div>
      </div>

      {copied && (
        <p className={`text-xs font-semibold ${copied === "fail" ? "text-red-700" : "text-emerald-700"}`} aria-live="polite" data-copy-status>
          {copied === "fail" ? "تعذّر النسخ، انسخ النص يدوياً." : copied === "code" ? "تم نسخ الرمز." : "تم نسخ الرابط."}
        </p>
      )}
      {activation?.expiresAt && (
        <p className={ui.hint} data-activation-expiry>صالح لمدة 24 ساعة، حتى {fmtDate(activation.expiresAt)}</p>
      )}
    </div>
  );
}
