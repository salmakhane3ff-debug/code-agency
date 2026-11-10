"use client";
/**
 * /recruiter/password — the recruiter changes their OWN password (Phase 6 part 2). Market language
 * (MA → Arabic RTL, FR → French LTR); errors are kept as CODES in state and rendered in the current language.
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
import { useRouter } from "next/navigation";
import { CheckCircle2, Eye, EyeOff, KeyRound, Lock } from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../errorLabels";
import { authAction } from "../recruiterUiState";
import { CenteredNotice, LoadingBlock, PageHeader, RetryError, Section, ui, useRecruiterLocale } from "../_components/ui";

const MIN = 8;
const MAX = 128;
const EMPTY = { currentPassword: "", newPassword: "", newPasswordConfirm: "" };
/** Page-level error code (not a server code): the CURRENT password is wrong (INVALID_CREDENTIALS on this page). */
const WRONG_CURRENT = "WRONG_CURRENT";

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
  const { t, lang } = useRecruiterLocale();
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState(""); // error CODE (RECRUITER_DISABLED)
  const [form, setForm] = useState(EMPTY);
  const [show, setShow] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(""); // error CODE (or WRONG_CURRENT)
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState(null); // session check failed (not 401): retry
  const aliveRef = useRef(true);
  const busyRef = useRef(false); // synchronous double-submit guard (state updates are async)

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(code);
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
    if (field === "currentPassword") return c === "WRONG" ? t("pw_wrong_current") : t("pw_enter_current");
    return recruiterFieldErrorLabel(field, c, lang);
  };

  async function submit(e) {
    e.preventDefault();
    if (busy || busyRef.current) return;
    setError("");
    setDone(false);
    const local = localErrors(form);
    if (Object.keys(local).length) { setFieldErrors(local); setError("INVALID_INPUT"); return; }
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
      setError(err.code);
    } catch {
      if (aliveRef.current) setError("SERVER_ERROR");
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }

  if (!ready || notice) {
    return (
      <div className="min-w-0">
        {notice
          ? <CenteredNotice hook="data-page-notice">{recruiterErrorLabel(notice, lang)}</CenteredNotice>
          : checkError
            ? <div className="max-w-sm mx-auto py-16"><RetryError code={checkError} onRetry={checkSession} /></div>
            : <LoadingBlock />}
      </div>
    );
  }

  return (
    <div className="space-y-5 min-w-0" data-recruiter-password>
      <PageHeader Icon={KeyRound} title={t("pw_title")} />

      <div className="max-w-2xl space-y-4 min-w-0">
        {done && (
          <p role="status" className="flex items-start gap-2 rounded-xl border border-green-100 bg-green-50 p-4 text-sm text-green-700" data-password-success>
            <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t("pw_success")}</span>
          </p>
        )}

        <Section Icon={Lock} title={t("common_password")}>
          <form onSubmit={submit} noValidate className="space-y-4 min-w-0">
            <p className={ui.hint}>
              {t("pw_hint")}
            </p>

            <div>
              <label htmlFor="currentPassword" className={ui.label}>{t("pw_current")}</label>
              <input id="currentPassword" type={show ? "text" : "password"} autoComplete="current-password" dir="ltr"
                value={form.currentPassword} onChange={(e) => set("currentPassword", e.target.value)} maxLength={MAX}
                className={`${ui.input} min-w-0`} data-current-password />
              {fieldErrors.currentPassword && <p className="mt-1.5 text-xs text-red-700" data-field-error="currentPassword">{fieldMessage("currentPassword")}</p>}
            </div>

            <div>
              <label htmlFor="newPassword" className={ui.label}>{t("pw_new")}</label>
              <div className="flex items-stretch gap-2 min-w-0">
                <input id="newPassword" type={show ? "text" : "password"} autoComplete="new-password" dir="ltr"
                  value={form.newPassword} onChange={(e) => set("newPassword", e.target.value)} maxLength={MAX}
                  className={`${ui.input} min-w-0`} data-new-password />
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? t("common_hide_password") : t("common_show_password")}
                  className="shrink-0 grid place-items-center min-h-11 w-11 rounded-xl border border-gray-200 bg-white text-gray-600 hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300" data-toggle-password>
                  {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
              <p className={`mt-1.5 ${ui.hint}`}>{t("pw_length_hint", { min: MIN, max: MAX })}</p>
              {fieldErrors.newPassword && <p className="mt-1 text-xs text-red-700" data-field-error="newPassword">{fieldMessage("newPassword")}</p>}
            </div>

            <div>
              <label htmlFor="newPasswordConfirm" className={ui.label}>{t("pw_confirm")}</label>
              <input id="newPasswordConfirm" type={show ? "text" : "password"} autoComplete="new-password" dir="ltr"
                value={form.newPasswordConfirm} onChange={(e) => set("newPasswordConfirm", e.target.value)} maxLength={MAX}
                className={`${ui.input} min-w-0`} data-confirm-password />
              {fieldErrors.newPasswordConfirm && <p className="mt-1.5 text-xs text-red-700" data-field-error="newPasswordConfirm">{fieldMessage("newPasswordConfirm")}</p>}
            </div>

            {fieldErrors.body && <p className="text-xs text-red-700" data-field-error="body">{fieldMessage("body")}</p>}
            {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2" data-password-error>{error === WRONG_CURRENT ? t("pw_wrong_current") : recruiterErrorLabel(error, lang)}</p>}

            <button type="submit" disabled={busy} data-password-submit className={`${ui.btnPrimary} w-full`}>
              <Lock className="w-4 h-4" aria-hidden="true" />
              {busy ? t("common_saving") : t("pw_title")}
            </button>
          </form>
        </Section>
      </div>
    </div>
  );
}
