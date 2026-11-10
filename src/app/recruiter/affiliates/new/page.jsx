"use client";
/**
 * /recruiter/affiliates/new — a recruiter creates an affiliate in THEIR OWN network
 * (Affiliate Recruiter System, Phase 3). Market language (MA → Arabic RTL, FR → French LTR).
 *
 *   • GET  /api/recruiter/me          → session check (401 / 403 RECRUITER_DISABLED → login page;
 *                                       Phase 7 Stage C: 5xx / 429 / network → error + retry)
 *   • GET  /api/recruiter/affiliates  → parent selector: the recruiter's own network only
 *   • POST /api/recruiter/affiliates  → { username, name, phone?, parentId?, requestId }
 * The server is the authority (validation, network ownership, idempotency); the client
 * checks are hints only. Only error CODES are read (kept as codes in state) and shown with fixed texts of the
 * market language.
 * The new account is inactive until an admin activates it.
 *
 * Phase 6 (activation code): the recruiter does NOT choose the affiliate's password. The
 * creation response carries a one-time activation code, shown ONCE here (React state only,
 * never stored); the affiliate chooses their own password with it on /affiliate/activate.
 * A replayed creation has no code any more: the recruiter can issue a new one.
 *
 * Phase 6 part 4: when the admin turned off the recruiter's canCreateAffiliates (read from
 * /api/recruiter/me), the form is replaced by a note; the server refuses anyway (403 FORBIDDEN).
 * Phase 2 (UI only): rendered inside the recruiter app shell with the shared ui.jsx primitives.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, KeyRound, Search, UserPlus } from "lucide-react";
import { toRecruiterActivationCodeView, toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../../errorLabels";
import { authAction } from "../../recruiterUiState";
import ActivationCodeCard, { requestNewActivationCode } from "../ActivationCodeCard";
import { Card, CenteredNotice, LoadingBlock, PageHeader, RetryError, ui, useRecruiterLocale } from "../../_components/ui";

const EMPTY = { name: "", username: "", phone: "" };
const USERNAME_RE = /^(?=[a-z0-9._-]*[a-z])[a-z0-9][a-z0-9._-]{2,29}$/;
const PHONE_RE = /^\+?[0-9]{8,15}$/;

const newRequestId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback (old browsers): RFC 4122 v4 from getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Client-side hints (same rules as the server; the server decides). */
function localFieldErrors(f) {
  const out = {};
  if (!USERNAME_RE.test(f.username.trim().toLowerCase())) out.username = "INVALID_USERNAME";
  const name = f.name.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80 || /[<>]/.test(name)) out.name = "INVALID_NAME";
  const phone = f.phone.replace(/[\s.-]/g, "");
  if (phone && !PHONE_RE.test(phone)) out.phone = "INVALID_PHONE";
  return out;
}

/** Shared input style; an invalid field (aria-invalid) turns red. */
const inputCls = `${ui.input} aria-[invalid=true]:border-red-400 aria-[invalid=true]:bg-red-50/40`;

function Field({ id, label, hint, error, field, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={ui.label}>{label}</label>
      {children}
      {hint && !error && <p className={`mt-1.5 ${ui.hint}`}>{hint}</p>}
      {error && <p id={`${id}-err`} className="mt-1.5 text-xs text-red-700" role="alert" data-field-error={field}>{error}</p>}
    </div>
  );
}

export default function RecruiterNewAffiliatePage() {
  const router = useRouter();
  const { t, lang } = useRecruiterLocale();
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState(""); // error CODE (RECRUITER_DISABLED)
  const [form, setForm] = useState(EMPTY);
  const [parentId, setParentId] = useState(""); // "" = root
  const [parentLabel, setParentLabel] = useState(null);
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState({ list: [], truncated: false, loading: false, failed: false });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(""); // error CODE
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [regen, setRegen] = useState({ busy: false, error: "" }); // error: CODE
  const [canCreate, setCanCreate] = useState(true); // Phase 6 part 4
  const [checkError, setCheckError] = useState(null); // Stage C: session check failed (not 401) → retry
  const requestIdRef = useRef(null);
  const aliveRef = useRef(true);

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(code);
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
    } else {
      router.replace("/recruiter/login");
    }
  }, [router]);

  // Session check: ONLY 401 / 403 RECRUITER_DISABLED → login; any other failure → error + retry.
  const checkSession = useCallback(async () => {
    setCheckError(null);
    try {
      const res = await fetch("/api/recruiter/me", { credentials: "include", cache: "no-store" });
      if (!aliveRef.current) return;
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (!aliveRef.current) return;
        setCanCreate(body?.permissions?.canCreateAffiliates === true);
        setReady(true);
        return;
      }
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

  // Parent selector: the recruiter's own network (debounced search).
  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    setNetwork((n) => ({ ...n, loading: true, failed: false }));
    const t = setTimeout(async () => {
      try {
        const q = query.trim().slice(0, 40);
        const res = await fetch(`/api/recruiter/affiliates${q ? `?q=${encodeURIComponent(q)}` : ""}`, { credentials: "include", cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          const { code } = toRecruiterError(await res.json().catch(() => null));
          const action = authAction(res.status, code);
          if (action) { toLogin(action === "disabled" ? code : "UNAUTHORIZED"); return; }
        }
        if (!res.ok) { setNetwork({ list: [], truncated: false, loading: false, failed: true }); return; }
        const body = await res.json().catch(() => null);
        const list = Array.isArray(body?.affiliates) ? body.affiliates.filter((a) => typeof a?.id === "string") : [];
        setNetwork({ list, truncated: body?.truncated === true, loading: false, failed: false });
      } catch {
        if (alive) setNetwork({ list: [], truncated: false, loading: false, failed: true });
      }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [ready, query, toLogin, created]);

  // Any edit of the payload = a new submission attempt (new requestId).
  const edit = (patch) => {
    requestIdRef.current = null;
    setForm((f) => ({ ...f, ...patch }));
    const keys = Object.keys(patch);
    setFieldErrors((fe) => { const n = { ...fe }; for (const k of keys) delete n[k]; return n; });
    setError("");
  };
  const chooseParent = (id, label) => {
    requestIdRef.current = null;
    setParentId(id);
    setParentLabel(label);
    setFieldErrors((fe) => { const n = { ...fe }; delete n.parentId; return n; });
    setError("");
  };

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const local = localFieldErrors(form);
    if (Object.keys(local).length) { setFieldErrors(local); setError("INVALID_INPUT"); return; }
    setFieldErrors({});
    if (!requestIdRef.current) requestIdRef.current = newRequestId();
    const payload = {
      name: form.name.replace(/\s+/g, " ").trim(),
      username: form.username.trim().toLowerCase(),
      requestId: requestIdRef.current,
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(parentId ? { parentId } : {}),
    };
    setBusy(true);
    try {
      const res = await fetch("/api/recruiter/affiliates", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.affiliate) {
        const a = body.affiliate;
        const activation = toRecruiterActivationCodeView(body.activation);
        setCreated({
          id: typeof a.id === "string" ? a.id : null,
          username: typeof a.username === "string" ? a.username : payload.username,
          name: typeof a.name === "string" ? a.name : payload.name,
          parent: a.parentId ? (parentLabel ?? null) : null,
          // The one-time code: only in this state, shown once. Replay → no code.
          activation: activation.code ? activation : null,
          replayed: body.replayed === true,
        });
        setRegen({ busy: false, error: "" });
        requestIdRef.current = null;
        setForm(EMPTY);
        return;
      }
      const err = toRecruiterError(body);
      if (res.status === 401 || (res.status === 403 && err.code === "RECRUITER_DISABLED")) { toLogin(res.status === 403 ? err.code : "UNAUTHORIZED"); return; }
      // A definitive answer for this payload: the next submit is a new attempt.
      requestIdRef.current = null;
      if (err.fields) setFieldErrors(err.fields);
      if (err.code === "USERNAME_TAKEN") setFieldErrors((fe) => ({ ...fe, username: "TAKEN" }));
      if (err.code === "PHONE_TAKEN") setFieldErrors((fe) => ({ ...fe, phone: "TAKEN" }));
      if (err.code === "PARENT_NOT_IN_NETWORK") setFieldErrors((fe) => ({ ...fe, parentId: "NOT_IN_NETWORK" }));
      if (err.code === "FORBIDDEN") { setCanCreate(false); return; } // turned off by the admin meanwhile
      setError(err.code);
    } catch {
      // Network failure: keep the requestId so a retry of THIS attempt cannot create twice.
      setError("SERVER_ERROR");
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (field) => {
    const c = fieldErrors[field];
    if (!c) return "";
    if (c === "TAKEN") return recruiterErrorLabel(field === "phone" ? "PHONE_TAKEN" : "USERNAME_TAKEN", lang);
    if (c === "NOT_IN_NETWORK") return recruiterErrorLabel("PARENT_NOT_IN_NETWORK", lang);
    return recruiterFieldErrorLabel(field, c, lang);
  };

  // Replay (the first response was lost): the code cannot be shown again → issue a new one.
  const regenerate = async () => {
    if (!created?.id || regen.busy) return;
    setRegen({ busy: true, error: "" });
    try {
      const r = await requestNewActivationCode(created.id);
      if (r.ok) { setCreated((c) => (c ? { ...c, activation: r.activation } : c)); setRegen({ busy: false, error: "" }); return; }
      const action = authAction(r.status, r.code);
      if (action) { toLogin(action === "disabled" ? r.code : "UNAUTHORIZED"); return; }
      setRegen({ busy: false, error: r.code });
    } catch {
      setRegen({ busy: false, error: "SERVER_ERROR" });
    }
  };

  const again = () => {
    setCreated(null); // also drops the one-time code from memory
    setRegen({ busy: false, error: "" });
    setForm(EMPTY);
    setFieldErrors({});
    setError("");
    setParentId("");
    setParentLabel(null);
    setQuery("");
    requestIdRef.current = null;
  };

  // Also when the account is disabled DURING a submit: the form is replaced by the notice
  // until the redirect to the login page.
  if (!ready || notice) {
    if (notice) return <CenteredNotice>{recruiterErrorLabel(notice, lang)}</CenteredNotice>;
    if (checkError) {
      return <div className="max-w-sm mx-auto py-16"><RetryError code={checkError} onRetry={checkSession} /></div>;
    }
    return <LoadingBlock />;
  }

  return (
    <div className="space-y-5 min-w-0" data-recruiter-new-affiliate>
      <PageHeader Icon={UserPlus} title={t("new_title")} />

      <div className="max-w-3xl space-y-5 min-w-0">
        {created ? (
          <Card className={`${ui.cardPad} space-y-5`} data-create-success aria-live="polite">
            <div className="flex items-center gap-3 min-w-0">
              <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-green-50 text-green-600" aria-hidden="true">
                <CheckCircle2 className="w-5 h-5" />
              </span>
              <h2 className="text-base font-bold text-gray-900 min-w-0">{t("new_success")}</h2>
            </div>
            <dl className={`${ui.panel} text-sm divide-y divide-gray-100 px-4`}>
              <div className="flex justify-between gap-3 py-2.5 min-w-0">
                <dt className="text-gray-500 shrink-0">{t("common_name")}</dt>
                <dd className="font-semibold text-gray-900 truncate min-w-0" data-created-name>{created.name}</dd>
              </div>
              <div className="flex justify-between gap-3 py-2.5 min-w-0">
                <dt className="text-gray-500 shrink-0">{t("common_username")}</dt>
                <dd className="font-semibold text-gray-900 truncate min-w-0" dir="ltr" data-created-username>{created.username}</dd>
              </div>
              <div className="flex justify-between gap-3 py-2.5 min-w-0">
                <dt className="text-gray-500 shrink-0">{t("new_parent")}</dt>
                <dd className="font-semibold text-gray-900 truncate min-w-0" data-created-parent>{created.parent ? <bdi>{created.parent}</bdi> : t("new_parent_root")}</dd>
              </div>
            </dl>
            {created.activation ? (
              <ActivationCodeCard activation={created.activation} />
            ) : (
              <div className={`${ui.panel} p-4 space-y-3`} data-activation-missing>
                <p className="text-sm text-gray-700">{t("new_replayed")}</p>
                <button type="button" onClick={regenerate} disabled={regen.busy || !created.id} data-regenerate-code className={ui.btnPrimary}>
                  <KeyRound className="w-4 h-4" aria-hidden="true" />
                  {regen.busy ? t("common_creating") : t("new_regenerate")}
                </button>
                {regen.error && <p role="alert" className="text-xs text-red-700" data-regenerate-error>{recruiterErrorLabel(regen.error, lang)}</p>}
              </div>
            )}
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3" data-inactive-note>
              {t("new_inactive_note")}
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={again} data-create-another className={`${ui.btnPrimary} flex-1`}>
                <UserPlus className="w-4 h-4" aria-hidden="true" />
                {t("new_create_another")}
              </button>
              <Link href="/recruiter" data-back-dashboard className={`${ui.btnSecondary} flex-1`}>
                {t("common_back_dashboard")}
              </Link>
            </div>
          </Card>
        ) : !canCreate ? (
          <section className="rounded-2xl border border-amber-100 bg-amber-50 p-4 sm:p-5 space-y-3 text-sm text-amber-700" data-create-disabled>
            <p>{t("new_create_disabled")}</p>
            <Link href="/recruiter/affiliates" className={ui.btnSecondary}>{t("net_my_network")}</Link>
          </section>
        ) : (
          <form onSubmit={submit} noValidate className={`${ui.card} ${ui.cardPad} space-y-5`} data-create-affiliate-form>
            <p className={`${ui.panel} px-3.5 py-2.5 text-xs text-gray-600 leading-relaxed`}>
              {t("new_intro_1")} <strong className="text-gray-900">{t("new_intro_inactive")}</strong>{t("new_intro_2")}
              {" "}{t("new_intro_3")} <strong className="text-gray-900">{t("new_intro_code")}</strong> {t("new_intro_4")}
            </p>

            <div className="grid gap-4 sm:grid-cols-2 min-w-0">
              <div className="sm:col-span-2 min-w-0">
                <Field id="aff-name" field="name" label={t("new_full_name")} error={fieldError("name")}>
                  <input id="aff-name" name="name" autoComplete="off" value={form.name} maxLength={80} disabled={busy}
                    aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? "aff-name-err" : undefined}
                    onChange={(e) => edit({ name: e.target.value })} className={inputCls} data-input="name" />
                </Field>
              </div>

              <Field id="aff-username" field="username" label={t("common_username")} error={fieldError("username")}
                hint={t("new_username_hint")}>
                <input id="aff-username" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr"
                  value={form.username} maxLength={30} disabled={busy}
                  aria-invalid={!!fieldErrors.username} aria-describedby={fieldErrors.username ? "aff-username-err" : undefined}
                  onChange={(e) => edit({ username: e.target.value })} className={`${inputCls} text-left`} data-input="username" />
              </Field>

              <Field id="aff-phone" field="phone" label={t("new_phone_optional")} error={fieldError("phone")}>
                <input id="aff-phone" name="phone" type="tel" inputMode="tel" autoComplete="off" dir="ltr" value={form.phone} maxLength={20} disabled={busy}
                  aria-invalid={!!fieldErrors.phone} aria-describedby={fieldErrors.phone ? "aff-phone-err" : undefined}
                  onChange={(e) => edit({ phone: e.target.value })} className={`${inputCls} text-left`} data-input="phone" />
              </Field>
            </div>

            <fieldset className="min-w-0 space-y-2.5" data-parent-selector>
              <legend className={ui.label}>{t("new_parent")}</legend>
              <label className={`flex items-center gap-2.5 min-h-11 rounded-xl border px-3.5 py-2.5 cursor-pointer ${parentId === "" ? "border-violet-400 bg-violet-50" : "border-gray-200 bg-white hover:border-gray-400"}`}>
                <input type="radio" name="parent" value="" checked={parentId === ""} disabled={busy}
                  onChange={() => chooseParent("", null)} className="accent-violet-600 w-4 h-4 shrink-0" data-parent-root />
                <span className="text-sm font-semibold text-gray-800">{t("new_parent_root")}</span>
              </label>

              <div className="relative min-w-0">
                <Search className="w-4 h-4 text-gray-400 absolute top-1/2 -translate-y-1/2 start-3.5 pointer-events-none" aria-hidden="true" />
                <input type="search" aria-label={t("new_parent_search_aria")} placeholder={t("new_parent_search_placeholder")} value={query} maxLength={40}
                  onChange={(e) => setQuery(e.target.value)} disabled={busy}
                  className={`${ui.input} ps-10`} data-parent-search />
              </div>

              <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-100 bg-white divide-y divide-gray-100" data-parent-list aria-busy={network.loading}>
                {network.failed ? (
                  <p className="p-3.5 text-sm text-red-700" data-parent-list-error>{t("new_parent_list_error")}</p>
                ) : network.list.length === 0 ? (
                  <p className="p-3.5 text-sm text-gray-500" data-parent-list-empty>
                    {network.loading ? t("common_loading") : query.trim() ? t("new_parent_no_results") : t("new_parent_none")}
                  </p>
                ) : network.list.map((a) => {
                  const label = a.name ? `${a.name} (${a.username ?? ""})` : (a.username ?? "");
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 min-h-11 px-3.5 py-2.5 cursor-pointer min-w-0 ${parentId === a.id ? "bg-violet-50" : "hover:bg-gray-50"}`}>
                      <input type="radio" name="parent" value={a.id} checked={parentId === a.id} disabled={busy}
                        onChange={() => chooseParent(a.id, label)} className="accent-violet-600 w-4 h-4 shrink-0" data-parent-option={a.username ?? ""} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-gray-800 truncate">{a.name || "—"}</span>
                        <span className="block text-xs text-gray-500 truncate" dir="ltr">{a.username}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {network.truncated && (
                <p className={ui.hint} data-parent-truncated>{t("new_parent_truncated")}</p>
              )}
              {parentId && parentLabel && (
                <p className="text-xs text-gray-600" data-parent-selected>{t("new_parent_selected")} <bdi className="font-semibold text-violet-600">{parentLabel}</bdi></p>
              )}
              {fieldErrors.parentId && <p className="text-xs text-red-700" role="alert" data-field-error="parentId">{fieldError("parentId")}</p>}
            </fieldset>

            {(fieldErrors.body || fieldErrors.requestId) && (
              <p className="text-xs text-red-700" role="alert" data-field-error={fieldErrors.body ? "body" : "requestId"}>
                {fieldError(fieldErrors.body ? "body" : "requestId")}
              </p>
            )}
            {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3" data-create-error>{recruiterErrorLabel(error, lang)}</p>}

            <button type="submit" disabled={busy} data-create-submit className={`${ui.btnPrimary} w-full`}>
              <UserPlus className="w-4 h-4" aria-hidden="true" />
              {busy ? t("common_creating") : t("new_submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
