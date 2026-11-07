"use client";
/**
 * /recruiter/password — the recruiter changes their OWN password (Phase 6 part 2). Arabic, RTL.
 *
 *   • PUT /api/recruiter/password { currentPassword, newPassword, newPasswordConfirm }
 *     → 200: every OTHER session is revoked; this one continues (the server refreshed the cookie).
 *   • INVALID_CREDENTIALS here means "wrong CURRENT password" — it is shown on the field and
 *     never treated as an expired session. Only UNAUTHORIZED / RECRUITER_DISABLED (or a 401
 *     without a code) send the recruiter back to the login page.
 * Client checks are hints only (the server decides). Nothing is stored; server text is never shown.
 * Phase 7 Stage C: the session check sends to the login page ONLY on 401 (403 RECRUITER_DISABLED with
 * its notice); 5xx / 429 / network show an error with a retry. A ref guards against double submits.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Lock } from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../errorLabels";
import { authAction } from "../recruiterUiState";

const MIN = 8;
const MAX = 128;
const EMPTY = { currentPassword: "", newPassword: "", newPasswordConfirm: "" };
const WRONG_CURRENT = "كلمة السر الحالية غير صحيحة";

/** Client-side hints with the same rules as the server (8–128 characters, confirmation). */
function localErrors(f) {
  const out = {};
  if (!f.currentPassword) out.currentPassword = "REQUIRED";
  if (f.newPassword.length < MIN || f.newPassword.length > MAX) out.newPassword = "INVALID_PASSWORD";
  else if (f.newPasswordConfirm !== f.newPassword) out.newPasswordConfirm = "PASSWORD_MISMATCH";
  return out;
}

export default function RecruiterPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [show, setShow] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState(null); // session check failed (not 401): retry
  const aliveRef = useRef(true);
  const busyRef = useRef(false); // synchronous double-submit guard (state updates are async)

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(recruiterErrorLabel(code));
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
    } else {
      router.replace("/recruiter/login");
    }
  }, [router]);

  // Session check (same pattern as the other recruiter pages): ONLY 401 / 403 disabled → login.
  const checkSession = useCallback(async () => {
    setCheckError(null);
    try {
      const res = await fetch("/api/recruiter/me", { credentials: "include", cache: "no-store" });
      if (!aliveRef.current) return;
      if (res.ok) { setReady(true); return; }
      const { code } = toRecruiterError(await res.json().catch(() => null));
      const action = authAction(res.status, code);
      if (action) { toLogin(action === "disabled" ? code : "UNAUTHORIZED"); return; }
      setCheckError(code);
    } catch {
      if (aliveRef.current) setCheckError("SERVER_ERROR");
    }
  }, [toLogin]);
  useEffect(() => {
    aliveRef.current = true;
    checkSession();
    return () => { aliveRef.current = false; };
  }, [checkSession]);

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((fe) => { const n = { ...fe }; delete n[k]; return n; });
    setError("");
    setDone(false);
  };

  const fieldMessage = (field) => {
    const c = fieldErrors[field];
    if (!c) return "";
    if (field === "currentPassword") return c === "WRONG" ? WRONG_CURRENT : "أدخل كلمة السر الحالية.";
    return recruiterFieldErrorLabel(field, c);
  };

  async function submit(e) {
    e.preventDefault();
    if (busy || busyRef.current) return;
    setError("");
    setDone(false);
    const local = localErrors(form);
    if (Object.keys(local).length) { setFieldErrors(local); setError(recruiterErrorLabel("INVALID_INPUT")); return; }
    setFieldErrors({});
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/recruiter/password", {
        method: "PUT", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (res.ok) { setForm(EMPTY); setShow(false); setDone(true); return; }
      const err = toRecruiterError(body);
      if (err.code === "INVALID_CREDENTIALS") {
        // Wrong CURRENT password — never a session problem on this page.
        setFieldErrors({ currentPassword: "WRONG" });
        setError(WRONG_CURRENT);
        return;
      }
      if (err.code === "RECRUITER_DISABLED" || err.code === "UNAUTHORIZED" || (res.status === 401 && err.code === "SERVER_ERROR")) {
        toLogin(err.code === "RECRUITER_DISABLED" ? err.code : "UNAUTHORIZED");
        return;
      }
      if (err.fields) setFieldErrors(err.fields);
      setError(recruiterErrorLabel(err.code));
    } catch {
      if (aliveRef.current) setError(recruiterErrorLabel(null));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }

  if (!ready || notice) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        {notice
          ? <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3" data-page-notice>{notice}</p>
          : checkError
            ? (
              <div role="alert" className="max-w-sm w-full rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3" data-error>
                <span className="min-w-0">{recruiterErrorLabel(checkError)}</span>
                <button type="button" onClick={checkSession} className="shrink-0 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100" data-retry>إعادة المحاولة</button>
              </div>
            )
            : <p className="text-sm text-slate-500" aria-live="polite">جارٍ التحميل…</p>}
      </main>
    );
  }

  const input = "w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500";

  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-password>
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-2xl mx-auto flex items-center gap-3 px-4 py-3 min-w-0">
          <Link href="/recruiter" className="shrink-0 p-2 -m-2 rounded-lg text-slate-700 hover:bg-slate-100" aria-label="الرجوع للوحة" data-back>
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
          <h1 className="text-base sm:text-lg font-bold truncate">تغيير كلمة السر</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
        <p className="text-sm text-slate-600">
          بعد تغيير كلمة السر، سيتم تسجيل الخروج من جميع الأجهزة الأخرى، وتبقى متصلاً على هذا الجهاز.
        </p>

        {done && (
          <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" data-password-success>
            تم تغيير كلمة السر. تم تسجيل الخروج من جميع الأجهزة الأخرى.
          </p>
        )}

        <form onSubmit={submit} noValidate className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4 min-w-0">
          <div className="space-y-1.5">
            <label htmlFor="currentPassword" className="block text-sm font-semibold">كلمة السر الحالية</label>
            <input id="currentPassword" type={show ? "text" : "password"} autoComplete="current-password" dir="ltr"
              value={form.currentPassword} onChange={(e) => set("currentPassword", e.target.value)} maxLength={MAX}
              className={input} data-current-password />
            {fieldErrors.currentPassword && <p className="text-xs text-red-700" data-field-error="currentPassword">{fieldMessage("currentPassword")}</p>}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="newPassword" className="block text-sm font-semibold">كلمة السر الجديدة</label>
            <div className="flex items-stretch gap-2 min-w-0">
              <input id="newPassword" type={show ? "text" : "password"} autoComplete="new-password" dir="ltr"
                value={form.newPassword} onChange={(e) => set("newPassword", e.target.value)} maxLength={MAX}
                className={input} data-new-password />
              <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "إخفاء كلمة السر" : "إظهار كلمة السر"}
                className="shrink-0 rounded-xl border border-slate-300 px-3 text-slate-600 hover:bg-slate-50" data-toggle-password>
                {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
            <p className="text-xs text-slate-500">من {MIN} إلى {MAX} حرفاً.</p>
            {fieldErrors.newPassword && <p className="text-xs text-red-700" data-field-error="newPassword">{fieldMessage("newPassword")}</p>}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="newPasswordConfirm" className="block text-sm font-semibold">تأكيد كلمة السر الجديدة</label>
            <input id="newPasswordConfirm" type={show ? "text" : "password"} autoComplete="new-password" dir="ltr"
              value={form.newPasswordConfirm} onChange={(e) => set("newPasswordConfirm", e.target.value)} maxLength={MAX}
              className={input} data-confirm-password />
            {fieldErrors.newPasswordConfirm && <p className="text-xs text-red-700" data-field-error="newPasswordConfirm">{fieldMessage("newPasswordConfirm")}</p>}
          </div>

          {fieldErrors.body && <p className="text-xs text-red-700" data-field-error="body">{fieldMessage("body")}</p>}
          {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-password-error>{error}</p>}

          <button type="submit" disabled={busy} data-password-submit
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-bold px-4 py-2.5 hover:bg-emerald-700 disabled:opacity-60">
            <Lock className="w-4 h-4" aria-hidden="true" />
            {busy ? "جارٍ الحفظ…" : "تغيير كلمة السر"}
          </button>
        </form>
      </main>
    </div>
  );
}
