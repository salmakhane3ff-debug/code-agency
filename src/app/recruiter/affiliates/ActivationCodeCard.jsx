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
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { Copy, KeyRound, MessageCircle } from "lucide-react";
import { toRecruiterActivationCodeView, toRecruiterError } from "@/lib/recruiterVisibility";

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
    <div className="rounded-2xl border border-emerald-300 bg-emerald-50/60 p-4 space-y-3 min-w-0" data-activation-card>
      <div className="flex items-center gap-2 text-emerald-800">
        <KeyRound className="w-5 h-5 shrink-0" aria-hidden="true" />
        <h3 className="text-sm font-bold">رمز التفعيل</h3>
      </div>

      <p className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-xl px-3 py-2" role="note" data-activation-warning>
        يظهر هذا الرمز مرة واحدة فقط. أرسله للأفلييت بنفسك عبر واتساب أو أي وسيلة أخرى. لا تستعمله أنت ولا تشاركه مع أي شخص آخر.
        الأفلييت سيختار كلمة السر الخاصة به، ولن يتم تفعيل الحساب إلا بعد موافقة الإدارة.
      </p>

      <div className="min-w-0">
        <p className="text-xs text-slate-600 mb-1">الرمز</p>
        <code dir="ltr" className="block w-full min-w-0 select-all break-all rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-left" data-activation-code>
          {code}
        </code>
        <button type="button" onClick={() => doCopy("code", code)} data-copy-code
          className="mt-2 inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">
          <Copy className="w-4 h-4" aria-hidden="true" />
          نسخ الرمز
        </button>
      </div>

      <div className="min-w-0">
        <p className="text-xs text-slate-600 mb-1">رابط التفعيل</p>
        <code dir="ltr" className="block w-full min-w-0 select-all break-all rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-left" data-activation-link>
          {link}
        </code>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => doCopy("link", link)} data-copy-link
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">
            <Copy className="w-4 h-4" aria-hidden="true" />
            نسخ الرابط
          </button>
          <a href={share} target="_blank" rel="noopener noreferrer" data-share-whatsapp
            className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700">
            <MessageCircle className="w-4 h-4" aria-hidden="true" />
            مشاركة عبر واتساب
          </a>
        </div>
      </div>

      {copied && (
        <p className={`text-xs ${copied === "fail" ? "text-red-700" : "text-emerald-700"}`} aria-live="polite" data-copy-status>
          {copied === "fail" ? "تعذّر النسخ، انسخ النص يدوياً." : copied === "code" ? "تم نسخ الرمز." : "تم نسخ الرابط."}
        </p>
      )}
      {activation?.expiresAt && (
        <p className="text-xs text-slate-600" data-activation-expiry>صالح لمدة 24 ساعة، حتى {fmtDate(activation.expiresAt)}</p>
      )}
    </div>
  );
}
