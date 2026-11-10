"use client";
/**
 * /affiliate/activate — an affiliate created by a recruiter chooses their OWN password with
 * the one-time activation code the recruiter shared (Affiliate Recruiter System, Phase 6
 * part 1). Language follows the visitor's market like the rest of /affiliate
 * (useMarketLocale → AFFILIATE_TABS_TEXT, act_* keys): MA → Arabic / RTL, FR → French /
 * LTR. The code and password inputs stay LTR islands. Error state holds CODES / keys only,
 * so a language switch re-translates what is shown.
 *
 *   • POST /api/affiliate-activation { code, password, passwordConfirm } → { ok: true }
 * The code may arrive in the URL FRAGMENT (#code=…, never sent to the server); it is read
 * once on mount and removed from the address bar. Nothing is stored, no session is created:
 * the account still has to be validated by the administration before any login.
 * Only error CODES are read; server text is never shown.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useMarketLocale } from "@/context/useMarketLocale";
import { AFFILIATE_TABS_TEXT } from "@/lib/affiliateTabsI18n";

const CODE_RE = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/;

// Server / client error CODES → dictionary keys (texts live in AFFILIATE_TABS_TEXT).
const FIELD_TEXT = {
  code: { INVALID_CODE_FORMAT: "act_err_code_format" },
  password: { WEAK_PASSWORD: "act_err_weak_password" },
  passwordConfirm: { PASSWORD_MISMATCH: "act_err_mismatch" },
  body: { UNKNOWN_FIELD: "act_err_unknown_field" },
};
const ERROR_TEXT = {
  INVALID_INPUT: "act_err_invalid_input",
  INVALID_OR_EXPIRED_CODE: "act_err_invalid_code",
  RATE_LIMITED: "act_err_rate_limited",
};
const GENERIC = "act_err_generic";

/** Client-side hints (the server decides). */
function localErrors(code, password, confirm) {
  const out = {};
  if (!CODE_RE.test(code.trim())) out.code = "INVALID_CODE_FORMAT";
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) out.password = "WEAK_PASSWORD";
  else if (confirm !== password) out.passwordConfirm = "PASSWORD_MISMATCH";
  return out;
}

const fieldKey = (field, c) => (c && FIELD_TEXT[field]?.[c]) || (c ? "act_err_invalid_value" : "");

export default function AffiliateActivatePage() {
  const { t } = useMarketLocale(AFFILIATE_TABS_TEXT);
  const fieldText = (field, c) => { const k = fieldKey(field, c); return k ? t(k) : ""; };
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [fields, setFields] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // Read the code from the fragment once, then remove it from the address bar.
  useEffect(() => {
    try {
      const hash = window.location.hash || "";
      const m = /(?:^#|&)code=([^&]+)/.exec(hash);
      if (m) {
        const c = decodeURIComponent(m[1]);
        if (CODE_RE.test(c)) setCode(c);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    } catch { /* ignore a malformed fragment */ }
  }, []);

  const edit = (setter, field) => (e) => {
    setter(e.target.value);
    setFields((f) => { const n = { ...f }; delete n[field]; if (field === "password") delete n.passwordConfirm; return n; });
    setError("");
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading) return;
    setError("");
    const local = localErrors(code, password, confirm);
    if (Object.keys(local).length) { setFields(local); setError(ERROR_TEXT.INVALID_INPUT); return; }
    setFields({});
    setLoading(true);
    try {
      const res = await fetch("/api/affiliate-activation", {
        method: "POST", cache: "no-store", credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), password, passwordConfirm: confirm }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok === true) {
        setDone(true);
        setCode(""); setPassword(""); setConfirm("");
        return;
      }
      const c = typeof body?.code === "string" ? body.code : "";
      if (c === "INVALID_INPUT" && body?.fields && typeof body.fields === "object") {
        const f = {};
        for (const k of Object.keys(FIELD_TEXT)) if (typeof body.fields[k] === "string" && FIELD_TEXT[k][body.fields[k]]) f[k] = body.fields[k];
        setFields(f);
      }
      setError(ERROR_TEXT[c] ?? GENERIC);
    } catch {
      setError(GENERIC);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm min-w-0">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 rounded-2xl mb-4 backdrop-blur">
            <KeyRound className="w-8 h-8 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t("act_title")}</h1>
          <p className="text-gray-400 text-sm mt-1">{t("act_subtitle")}</p>
        </div>

        <div className="bg-white rounded-3xl shadow-2xl p-7 space-y-5">
          {done ? (
            <div className="space-y-4 text-center" data-activate-success role="status">
              <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" aria-hidden="true" />
              <p className="text-sm text-gray-700">
                {t("act_done")}
              </p>
              <Link href="/affiliate/login" className="inline-flex items-center justify-center w-full py-3 bg-gray-900 hover:bg-gray-800 text-white rounded-xl font-bold text-sm" data-login-link>
                {t("act_go_login")}
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <div className="flex items-start gap-2.5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3" role="alert" data-activate-error>
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <p className="text-sm text-red-600">{t(error)}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                <div className="min-w-0">
                  <label htmlFor="act-code" className="block text-xs font-semibold text-gray-600 mb-1.5">{t("act_code_label")}</label>
                  <textarea id="act-code" value={code} onChange={edit(setCode, "code")} rows={2} spellCheck={false} autoComplete="off" autoCapitalize="none"
                    aria-invalid={!!fields.code} placeholder={t("act_code_placeholder")}
                    className={`w-full min-w-0 px-4 py-3 text-sm border rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 font-mono break-all resize-none ${fields.code ? "border-red-300" : "border-gray-200"}`}
                    dir="ltr" data-code-input />
                  {fields.code && <p className="mt-1 text-xs text-red-600" data-field-error="code">{fieldText("code", fields.code)}</p>}
                </div>

                <div className="min-w-0">
                  <label htmlFor="act-password" className="block text-xs font-semibold text-gray-600 mb-1.5">{t("act_password_label")}</label>
                  <div className="relative" dir="ltr">
                    <input id="act-password" type={showPwd ? "text" : "password"} value={password} onChange={edit(setPassword, "password")}
                      autoComplete="new-password" maxLength={128} aria-invalid={!!fields.password} placeholder="••••••••"
                      className={`w-full min-w-0 px-4 py-3 pr-10 text-sm border rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 ${fields.password ? "border-red-300" : "border-gray-200"}`}
                      dir="ltr" data-password-input />
                    <button type="button" onClick={() => setShowPwd((v) => !v)} aria-label={showPwd ? t("act_hide_password") : t("act_show_password")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" data-toggle-password>
                      {showPwd ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                    </button>
                  </div>
                  {fields.password
                    ? <p className="mt-1 text-xs text-red-600" data-field-error="password">{fieldText("password", fields.password)}</p>
                    : <p className="mt-1 text-xs text-gray-400">{t("act_password_hint")}</p>}
                </div>

                <div className="min-w-0">
                  <label htmlFor="act-confirm" className="block text-xs font-semibold text-gray-600 mb-1.5">{t("act_confirm_label")}</label>
                  <input id="act-confirm" type={showPwd ? "text" : "password"} value={confirm} onChange={edit(setConfirm, "passwordConfirm")}
                    autoComplete="new-password" maxLength={128} aria-invalid={!!fields.passwordConfirm} placeholder="••••••••"
                    className={`w-full min-w-0 px-4 py-3 text-sm border rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 ${fields.passwordConfirm ? "border-red-300" : "border-gray-200"}`}
                    dir="ltr" data-confirm-input />
                  {fields.passwordConfirm && <p className="mt-1 text-xs text-red-600" data-field-error="passwordConfirm">{fieldText("passwordConfirm", fields.passwordConfirm)}</p>}
                  {fields.body && <p className="mt-1 text-xs text-red-600" data-field-error="body">{fieldText("body", fields.body)}</p>}
                </div>

                <button type="submit" disabled={loading} data-activate-submit
                  className="w-full flex items-center justify-center gap-2 py-3 bg-gray-900 hover:bg-gray-800 text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50 active:scale-[0.99]">
                  {loading ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t("act_saving")}</> : <><KeyRound className="w-4 h-4" aria-hidden="true" /> {t("act_submit")}</>}
                </button>
              </form>

              <p className="text-center text-xs text-gray-400 pt-1">
                {t("act_have_password")}{" "}
                <Link href="/affiliate/login" className="text-gray-600 font-medium underline">{t("act_login")}</Link>
              </p>
              <p className="text-center text-xs text-gray-400">
                <Link href="/affiliate/activate/recovery" className="text-gray-500 underline" data-recovery-link>{t("act_code_used")}</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
