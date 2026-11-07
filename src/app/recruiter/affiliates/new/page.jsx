"use client";
/**
 * /recruiter/affiliates/new — a recruiter creates an affiliate in THEIR OWN network
 * (Affiliate Recruiter System, Phase 3). Arabic, RTL.
 *
 *   • GET  /api/recruiter/me          → session check (401 / 403 RECRUITER_DISABLED → login page;
 *                                       Phase 7 Stage C: 5xx / 429 / network → error + retry)
 *   • GET  /api/recruiter/affiliates  → parent selector: the recruiter's own network only
 *   • POST /api/recruiter/affiliates  → { username, name, phone?, parentId?, requestId }
 * The server is the authority (validation, network ownership, idempotency); the client
 * checks are hints only. Only error CODES are read and shown with fixed Arabic texts.
 * The new account is inactive until an admin activates it.
 *
 * Phase 6 (activation code): the recruiter does NOT choose the affiliate's password. The
 * creation response carries a one-time activation code, shown ONCE here (React state only,
 * never stored); the affiliate chooses their own password with it on /affiliate/activate.
 * A replayed creation has no code any more: the recruiter can issue a new one.
 *
 * Phase 6 part 4: when the admin turned off the recruiter's canCreateAffiliates (read from
 * /api/recruiter/me), the form is replaced by a note; the server refuses anyway (403 FORBIDDEN).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, KeyRound, Search, UserPlus } from "lucide-react";
import { toRecruiterActivationCodeView, toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../../errorLabels";
import { authAction } from "../../recruiterUiState";
import ActivationCodeCard, { requestNewActivationCode } from "../ActivationCodeCard";

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

const inputCls = (bad) =>
  `w-full min-w-0 rounded-xl border px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${bad ? "border-red-400 bg-red-50/40" : "border-slate-300"}`;

function Field({ id, label, hint, error, field, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-semibold mb-1">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p id={`${id}-err`} className="mt-1 text-xs text-red-700" role="alert" data-field-error={field}>{error}</p>}
    </div>
  );
}

export default function RecruiterNewAffiliatePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [parentId, setParentId] = useState(""); // "" = root
  const [parentLabel, setParentLabel] = useState(null);
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState({ list: [], truncated: false, loading: false, failed: false });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [regen, setRegen] = useState({ busy: false, error: "" });
  const [canCreate, setCanCreate] = useState(true); // Phase 6 part 4
  const [checkError, setCheckError] = useState(null); // Stage C: session check failed (not 401) → retry
  const requestIdRef = useRef(null);
  const aliveRef = useRef(true);

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(recruiterErrorLabel(code));
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
    if (Object.keys(local).length) { setFieldErrors(local); setError(recruiterErrorLabel("INVALID_INPUT")); return; }
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
      setError(recruiterErrorLabel(err.code));
    } catch {
      // Network failure: keep the requestId so a retry of THIS attempt cannot create twice.
      setError(recruiterErrorLabel(null));
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (field) => {
    const c = fieldErrors[field];
    if (!c) return "";
    if (c === "TAKEN") return recruiterErrorLabel(field === "phone" ? "PHONE_TAKEN" : "USERNAME_TAKEN");
    if (c === "NOT_IN_NETWORK") return recruiterErrorLabel("PARENT_NOT_IN_NETWORK");
    return recruiterFieldErrorLabel(field, c);
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
      setRegen({ busy: false, error: recruiterErrorLabel(r.code) });
    } catch {
      setRegen({ busy: false, error: recruiterErrorLabel(null) });
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

  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-new-affiliate>
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-2xl mx-auto flex items-center gap-3 px-4 py-3 min-w-0">
          <Link href="/recruiter" className="shrink-0 p-2 -m-2 rounded-lg text-slate-700 hover:bg-slate-100" aria-label="الرجوع للوحة" data-back>
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
          <h1 className="text-base sm:text-lg font-bold truncate">إنشاء أفلييت جديد</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
        {created ? (
          <section className="bg-white rounded-2xl border border-emerald-200 shadow-sm p-5 space-y-4" data-create-success aria-live="polite">
            <div className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="w-6 h-6 shrink-0" aria-hidden="true" />
              <h2 className="text-base font-bold">تم إنشاء حساب الأفلييت بنجاح</h2>
            </div>
            <dl className="text-sm divide-y divide-slate-100">
              <div className="flex justify-between gap-3 py-2 min-w-0">
                <dt className="text-slate-500 shrink-0">الاسم</dt>
                <dd className="font-semibold truncate min-w-0" data-created-name>{created.name}</dd>
              </div>
              <div className="flex justify-between gap-3 py-2 min-w-0">
                <dt className="text-slate-500 shrink-0">اسم المستخدم</dt>
                <dd className="font-semibold truncate min-w-0" dir="ltr" data-created-username>{created.username}</dd>
              </div>
              <div className="flex justify-between gap-3 py-2 min-w-0">
                <dt className="text-slate-500 shrink-0">الأفلييت الأب</dt>
                <dd className="font-semibold truncate min-w-0" data-created-parent>{created.parent ?? "حساب رئيسي (بدون أب)"}</dd>
              </div>
            </dl>
            {created.activation ? (
              <ActivationCodeCard activation={created.activation} />
            ) : (
              <div className="rounded-2xl border border-slate-300 bg-slate-50 p-4 space-y-2" data-activation-missing>
                <p className="text-sm text-slate-700">تم إنشاء الحساب سابقاً، والرمز لم يعد قابلاً للعرض.</p>
                <button type="button" onClick={regenerate} disabled={regen.busy || !created.id} data-regenerate-code
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
                  <KeyRound className="w-4 h-4" aria-hidden="true" />
                  {regen.busy ? "جارٍ الإنشاء…" : "إنشاء رمز تفعيل جديد"}
                </button>
                {regen.error && <p role="alert" className="text-xs text-red-700" data-regenerate-error>{regen.error}</p>}
              </div>
            )}
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-inactive-note>
              الحساب غير مفعّل حالياً: سيتم تفعيله من طرف الإدارة بعد التحقق من البطاقة الوطنية.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={again} data-create-another
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-bold py-2.5 hover:bg-emerald-700">
                <UserPlus className="w-4 h-4" aria-hidden="true" />
                إنشاء أفلييت آخر
              </button>
              <Link href="/recruiter" data-back-dashboard
                className="flex-1 inline-flex items-center justify-center rounded-xl border border-slate-300 font-semibold py-2.5 hover:bg-slate-50">
                الرجوع للوحة
              </Link>
            </div>
          </section>
        ) : !canCreate ? (
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 space-y-3 text-sm text-amber-900" data-create-disabled>
            <p>إنشاء أفلييت جدد معطّل لحسابك من طرف الإدارة. يمكنك دائماً الاطلاع على شبكتك.</p>
            <Link href="/recruiter/network" className="inline-block font-bold text-emerald-700 hover:underline">شبكتي</Link>
          </section>
        ) : (
          <form onSubmit={submit} noValidate className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4" data-create-affiliate-form>
            <p className="text-sm text-slate-600">
              الحساب الجديد يُنشأ <strong>غير مفعّل</strong>، ويتم تفعيله من طرف الإدارة بعد التحقق.
              بعد الإنشاء ستحصل على <strong>رمز تفعيل</strong> ترسله للأفلييت ليختار كلمة السر الخاصة به.
            </p>

            <Field id="aff-name" field="name" label="الاسم الكامل" error={fieldError("name")}>
              <input id="aff-name" name="name" autoComplete="off" value={form.name} maxLength={80} disabled={busy}
                aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? "aff-name-err" : undefined}
                onChange={(e) => edit({ name: e.target.value })} className={inputCls(!!fieldErrors.name)} data-input="name" />
            </Field>

            <Field id="aff-username" field="username" label="اسم المستخدم" error={fieldError("username")}
              hint="من 3 إلى 30 حرفاً: حروف لاتينية صغيرة وأرقام و . _ - (حرف واحد على الأقل).">
              <input id="aff-username" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr"
                value={form.username} maxLength={30} disabled={busy}
                aria-invalid={!!fieldErrors.username} aria-describedby={fieldErrors.username ? "aff-username-err" : undefined}
                onChange={(e) => edit({ username: e.target.value })} className={`${inputCls(!!fieldErrors.username)} text-left`} data-input="username" />
            </Field>

            <Field id="aff-phone" field="phone" label="رقم الهاتف (اختياري)" error={fieldError("phone")}>
              <input id="aff-phone" name="phone" type="tel" inputMode="tel" autoComplete="off" dir="ltr" value={form.phone} maxLength={20} disabled={busy}
                aria-invalid={!!fieldErrors.phone} aria-describedby={fieldErrors.phone ? "aff-phone-err" : undefined}
                onChange={(e) => edit({ phone: e.target.value })} className={`${inputCls(!!fieldErrors.phone)} text-left`} data-input="phone" />
            </Field>

            <fieldset className="min-w-0 space-y-2" data-parent-selector>
              <legend className="block text-sm font-semibold mb-1">الأفلييت الأب</legend>
              <label className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 cursor-pointer ${parentId === "" ? "border-emerald-500 bg-emerald-50" : "border-slate-300"}`}>
                <input type="radio" name="parent" value="" checked={parentId === ""} disabled={busy}
                  onChange={() => chooseParent("", null)} data-parent-root />
                <span className="text-sm font-semibold">حساب رئيسي (بدون أب)</span>
              </label>

              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute top-1/2 -translate-y-1/2 right-3 pointer-events-none" aria-hidden="true" />
                <input type="search" aria-label="البحث في شبكتك" placeholder="ابحث في شبكتك بالاسم أو اسم المستخدم" value={query} maxLength={40}
                  onChange={(e) => setQuery(e.target.value)} disabled={busy}
                  className="w-full min-w-0 rounded-xl border border-slate-300 pr-9 pl-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" data-parent-search />
              </div>

              <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100" data-parent-list aria-busy={network.loading}>
                {network.failed ? (
                  <p className="p-3 text-sm text-red-700" data-parent-list-error>تعذّر تحميل الشبكة، المرجو المحاولة من جديد.</p>
                ) : network.list.length === 0 ? (
                  <p className="p-3 text-sm text-slate-500" data-parent-list-empty>
                    {network.loading ? "جارٍ التحميل…" : query.trim() ? "لا توجد نتائج في شبكتك." : "لا يوجد أي أفلييت في شبكتك بعد."}
                  </p>
                ) : network.list.map((a) => {
                  const label = a.name ? `${a.name} (${a.username ?? ""})` : (a.username ?? "");
                  return (
                    <label key={a.id} className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer min-w-0 ${parentId === a.id ? "bg-emerald-50" : "hover:bg-slate-50"}`}>
                      <input type="radio" name="parent" value={a.id} checked={parentId === a.id} disabled={busy}
                        onChange={() => chooseParent(a.id, label)} data-parent-option={a.username ?? ""} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold truncate">{a.name || "—"}</span>
                        <span className="block text-xs text-slate-500 truncate" dir="ltr">{a.username}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {network.truncated && (
                <p className="text-xs text-slate-500" data-parent-truncated>يتم عرض آخر 50 أفلييت فقط، استعمل البحث للعثور على أفلييت آخر.</p>
              )}
              {parentId && parentLabel && (
                <p className="text-xs text-slate-600" data-parent-selected>الأب المختار: <span className="font-semibold">{parentLabel}</span></p>
              )}
              {fieldErrors.parentId && <p className="text-xs text-red-700" role="alert" data-field-error="parentId">{fieldError("parentId")}</p>}
            </fieldset>

            {(fieldErrors.body || fieldErrors.requestId) && (
              <p className="text-xs text-red-700" role="alert" data-field-error={fieldErrors.body ? "body" : "requestId"}>
                {fieldError(fieldErrors.body ? "body" : "requestId")}
              </p>
            )}
            {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-create-error>{error}</p>}

            <button type="submit" disabled={busy} data-create-submit
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-bold py-2.5 hover:bg-emerald-700 disabled:opacity-60">
              <UserPlus className="w-4 h-4" aria-hidden="true" />
              {busy ? "جارٍ الإنشاء…" : "إنشاء الحساب"}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
