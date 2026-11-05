"use client";
/**
 * /admin/recruiters — manage Affiliate Recruiter accounts (Phase 2). Admin only (the
 * API refuses anyone else). List, create, enable / disable. The password typed here is
 * sent once to POST /api/admin/recruiters and then cleared; it is never shown or logged.
 * Phase 6 part 2: "Réinitialiser le mot de passe" (POST /api/admin/recruiters/<id>/password)
 * closes every session of the recruiter and never changes its active / disabled state; the
 * new password is never echoed back and is cleared after the request.
 */
import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Plus, RefreshCw, UserCog } from "lucide-react";

const API = "/api/admin/recruiters";

const FIELD_ERRORS = {
  INVALID_USERNAME: "3 à 40 caractères : lettres minuscules, chiffres, « . », « _ » ou « - » (commence par une lettre ou un chiffre).",
  INVALID_NAME: "Nom de 2 à 80 caractères, sans « < » ni « > ».",
  INVALID_PASSWORD: "Mot de passe de 8 à 128 caractères.",
  INVALID_PHONE: "Numéro invalide (8 à 15 chiffres, « + » autorisé au début).",
};
const GENERIC_ERROR = "Une erreur est survenue. Veuillez réessayer.";
const ERROR_TEXT = {
  USERNAME_TAKEN: "Ce nom d'utilisateur est déjà utilisé.",
  PHONE_TAKEN: "Ce numéro de téléphone est déjà utilisé.",
  NOT_FOUND: "Recruteur introuvable.",
  UNAUTHORIZED: "Session expirée ou accès refusé. Reconnectez-vous.",
  INVALID_INPUT: "Données invalides.",
};

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Casablanca", dateStyle: "short", timeStyle: "short" });
const fmtDate = (iso) => (iso ? DATE_FMT.format(new Date(iso)) : "—");
const EMPTY_FORM = { name: "", username: "", password: "", phone: "" };

async function readBody(res) {
  return res.json().catch(() => null);
}
function errorText(res, body) {
  if (res.status === 401 || res.status === 403) return ERROR_TEXT.UNAUTHORIZED;
  return ERROR_TEXT[body?.code] ?? GENERIC_ERROR;
}

function Field({ id, label, hint, error, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-semibold text-gray-700 mb-1">{label}</label>
      {children}
      {error
        ? <p id={`${id}-err`} className="mt-1 text-xs text-red-600" data-field-error={id}>{error}</p>
        : hint ? <p className="mt-1 text-[11px] text-gray-400">{hint}</p> : null}
    </div>
  );
}

const inputCls = (bad) =>
  `w-full min-w-0 rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-900/10 ${bad ? "border-red-400" : "border-gray-300 focus:border-gray-500"}`;

function CreateForm({ onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const set = (k) => (e) => {
    const v = k === "username" ? e.target.value.toLowerCase() : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((fe) => ({ ...fe, [k]: undefined }));
  };

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setOk(""); setFieldErrors({});
    const payload = { name: form.name, username: form.username.trim(), password: form.password, phone: form.phone.trim() || undefined };
    try {
      const res = await fetch(API, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const body = await readBody(res);
      if (res.ok) {
        setForm(EMPTY_FORM); setShowPwd(false);
        setOk(`Recruteur « ${body?.recruiter?.username ?? payload.username} » créé.`);
        onCreated?.(body?.recruiter);
        return;
      }
      const fe = {};
      for (const [k, code] of Object.entries(body?.errors ?? {})) if (FIELD_ERRORS[code]) fe[k] = FIELD_ERRORS[code];
      if (body?.code === "USERNAME_TAKEN") fe.username = ERROR_TEXT.USERNAME_TAKEN;
      if (body?.code === "PHONE_TAKEN") fe.phone = ERROR_TEXT.PHONE_TAKEN;
      setFieldErrors(fe);
      if (!Object.keys(fe).length) setError(errorText(res, body));
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setForm((f) => ({ ...f, password: "" })); // never keep the password around
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5 space-y-4 min-w-0" data-create-recruiter>
      <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Plus className="w-4 h-4" aria-hidden="true" /> Nouveau recruteur</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
        <Field id="rc-name" label="Nom complet" error={fieldErrors.name}>
          <input id="rc-name" className={inputCls(fieldErrors.name)} value={form.name} onChange={set("name")} maxLength={80} required
            autoComplete="off" aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? "rc-name-err" : undefined} />
        </Field>
        <Field id="rc-username" label="Nom d'utilisateur" hint="minuscules, chiffres, . _ - (3 à 40)" error={fieldErrors.username}>
          <input id="rc-username" className={inputCls(fieldErrors.username)} value={form.username} onChange={set("username")} maxLength={40} required
            autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr"
            aria-invalid={!!fieldErrors.username} aria-describedby={fieldErrors.username ? "rc-username-err" : undefined} />
        </Field>
        <Field id="rc-password" label="Mot de passe" hint="8 à 128 caractères" error={fieldErrors.password}>
          <div className="relative min-w-0">
            <input id="rc-password" type={showPwd ? "text" : "password"} className={`${inputCls(fieldErrors.password)} pr-10`} value={form.password}
              onChange={set("password")} maxLength={128} required autoComplete="new-password" dir="ltr"
              aria-invalid={!!fieldErrors.password} aria-describedby={fieldErrors.password ? "rc-password-err" : undefined} />
            <button type="button" onClick={() => setShowPwd((s) => !s)} aria-label={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
              className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-800">
              {showPwd ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
        </Field>
        <Field id="rc-phone" label="Téléphone (optionnel)" error={fieldErrors.phone}>
          <input id="rc-phone" type="tel" inputMode="tel" className={inputCls(fieldErrors.phone)} value={form.phone} onChange={set("phone")} maxLength={20}
            autoComplete="off" dir="ltr" aria-invalid={!!fieldErrors.phone} aria-describedby={fieldErrors.phone ? "rc-phone-err" : undefined} />
        </Field>
      </div>
      {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-create-error>{error}</p>}
      {ok && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2" data-create-ok>{ok}</p>}
      <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-gray-900 text-white px-4 py-2 text-sm font-semibold disabled:opacity-60">
        {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Créer le recruteur
      </button>
    </form>
  );
}

function ConfirmDialog({ target, onCancel, onDone }) {
  const disabling = target.isActive;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function confirm() {
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API}/${encodeURIComponent(target.id)}`, {
        method: "PATCH", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(disabling ? { action: "disable", reason: reason.trim() || undefined } : { action: "enable" }),
      });
      const body = await readBody(res);
      if (res.ok) { onDone(body?.recruiter); return; }
      setError(errorText(res, body));
    } catch {
      setError(GENERIC_ERROR);
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="rc-confirm-title" data-confirm-dialog>
      <button type="button" className="absolute inset-0 bg-gray-900/40" aria-label="Annuler" onClick={() => !busy && onCancel()} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-5 space-y-4 min-w-0">
        <h3 id="rc-confirm-title" className="text-base font-bold text-gray-900 break-words">
          {disabling ? "Désactiver" : "Réactiver"} « {target.username} » ?
        </h3>
        <p className="text-sm text-gray-600">
          {disabling
            ? "Le recruteur ne pourra plus se connecter ; sa session en cours sera refusée dès sa prochaine requête."
            : "Le recruteur pourra de nouveau se connecter."}
        </p>
        {disabling && (
          <div>
            <label htmlFor="rc-reason" className="block text-xs font-semibold text-gray-700 mb-1">Motif (optionnel)</label>
            <textarea id="rc-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500" />
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold disabled:opacity-60">Annuler</button>
          <button type="button" onClick={confirm} disabled={busy} data-confirm
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${disabling ? "bg-red-600" : "bg-emerald-600"}`}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {disabling ? "Désactiver" : "Réactiver"}
          </button>
        </div>
      </div>
    </div>
  );
}

const RESET_MIN = 8;
const RESET_MAX = 128;

function ResetPasswordDialog({ target, onCancel }) {
  const [pwd, setPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState({});
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError(""); setDone(false);
    const fe = {};
    if (pwd.length < RESET_MIN || pwd.length > RESET_MAX) fe.new = FIELD_ERRORS.INVALID_PASSWORD;
    else if (confirm !== pwd) fe.confirm = "Les deux mots de passe ne correspondent pas.";
    setFieldError(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/${encodeURIComponent(target.id)}/password`, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: pwd }),
      });
      const body = await readBody(res);
      if (res.ok) {
        setPwd(""); setConfirm(""); setShow(false); setDone(true);
      } else {
        if (body?.errors?.newPassword === "INVALID_PASSWORD") setFieldError({ new: FIELD_ERRORS.INVALID_PASSWORD });
        setError(typeof body?.error === "string" && body.error ? body.error : errorText(res, body));
      }
    } catch {
      setError(GENERIC_ERROR);
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="rc-reset-title" data-reset-dialog>
      <button type="button" className="absolute inset-0 bg-gray-900/40" aria-label="Fermer" onClick={() => !busy && onCancel()} />
      <form onSubmit={submit} noValidate className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-5 space-y-4 min-w-0">
        <h3 id="rc-reset-title" className="text-base font-bold text-gray-900 break-words">
          Réinitialiser le mot de passe de « {target.username} »
        </h3>
        <p className="text-sm text-gray-600">
          Toutes les sessions de ce recruteur seront fermées. Son statut (actif/désactivé) ne change pas.
          Transmettez le nouveau mot de passe directement au recruteur.
        </p>
        <Field id="rc-reset-new" label="Nouveau mot de passe" hint={`${RESET_MIN} à ${RESET_MAX} caractères.`} error={fieldError.new}>
          <div className="flex items-stretch gap-2 min-w-0">
            <input id="rc-reset-new" type={show ? "text" : "password"} autoComplete="new-password" maxLength={RESET_MAX}
              value={pwd} onChange={(e) => { setPwd(e.target.value); setDone(false); }} className={inputCls(!!fieldError.new)} data-reset-new />
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Masquer" : "Afficher"}
              className="shrink-0 rounded-xl border border-gray-300 px-3 text-gray-600 hover:bg-gray-50">
              {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
        </Field>
        <Field id="rc-reset-confirm" label="Confirmer le mot de passe" error={fieldError.confirm}>
          <input id="rc-reset-confirm" type={show ? "text" : "password"} autoComplete="new-password" maxLength={RESET_MAX}
            value={confirm} onChange={(e) => { setConfirm(e.target.value); setDone(false); }} className={inputCls(!!fieldError.confirm)} data-reset-confirm />
        </Field>
        {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-reset-error>{error}</p>}
        {done && (
          <p role="status" className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2" data-reset-success>
            Mot de passe réinitialisé. Toutes les sessions du recruteur ont été fermées.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold disabled:opacity-60">
            {done ? "Fermer" : "Annuler"}
          </button>
          <button type="submit" disabled={busy} data-reset-submit
            className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            Réinitialiser
          </button>
        </div>
      </form>
    </div>
  );
}

function StatusBadge({ active }) {
  return (
    <span className={`shrink-0 text-[11px] font-bold rounded-full px-2 py-0.5 border ${active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`}
      data-status={active ? "active" : "disabled"}>
      {active ? "Actif" : "Désactivé"}
    </span>
  );
}

function RecruiterCard({ r, onToggle, onReset }) {
  return (
    <li className="bg-white rounded-2xl border border-gray-200 p-4 min-w-0" data-recruiter-row={r.id}>
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="font-semibold text-gray-900 truncate">{r.name}</p>
            <StatusBadge active={r.isActive} />
          </div>
          <p className="text-xs text-gray-500 truncate" dir="ltr">@{r.username}{r.phone ? ` · ${r.phone}` : ""}</p>
        </div>
        <div className="shrink-0 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => onReset(r)} data-reset-password
            className="inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50">
            <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
            Réinitialiser le mot de passe
          </button>
          <button type="button" onClick={() => onToggle(r)} data-toggle-recruiter
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold border ${r.isActive ? "border-red-300 text-red-700 hover:bg-red-50" : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}>
            {r.isActive ? "Désactiver" : "Réactiver"}
          </button>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs min-w-0">
        <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Créé le :</dt><dd className="text-gray-800 truncate">{fmtDate(r.createdAt)}</dd></div>
        <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Dernière connexion :</dt><dd className="text-gray-800 truncate">{fmtDate(r.lastLoginAt)}</dd></div>
        {!r.isActive && (
          <>
            <div className="flex gap-1 min-w-0"><dt className="text-gray-500 shrink-0">Désactivé le :</dt><dd className="text-gray-800 truncate">{fmtDate(r.disabledAt)}</dd></div>
            <div className="flex gap-1 min-w-0 sm:col-span-2"><dt className="text-gray-500 shrink-0">Motif :</dt><dd className="text-gray-800 break-words min-w-0">{r.disabledReason || "—"}</dd></div>
          </>
        )}
      </dl>
    </li>
  );
}

export default function AdminRecruitersPage() {
  const [list, setList] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError("");
    try {
      const res = await fetch(API, { credentials: "include", cache: "no-store" });
      const body = await readBody(res);
      if (res.ok) setList(Array.isArray(body?.recruiters) ? body.recruiters : []);
      else setLoadError(errorText(res, body));
    } catch {
      setLoadError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const replace = (rec) => { if (rec?.id) setList((l) => (l ?? []).map((x) => (x.id === rec.id ? rec : x))); };
  const closeDialog = useCallback(() => setTarget(null), []);
  const closeReset = useCallback(() => setResetTarget(null), []);
  const activeCount = (list ?? []).filter((r) => r.isActive).length;

  return (
    <div className="py-6 max-w-4xl space-y-5 min-w-0 [contain:inline-size]" data-admin-recruiters>
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <UserCog className="w-6 h-6 text-gray-700 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">🧑‍💼 Recruteurs</h1>
            <p className="text-sm text-gray-500">Comptes des recruteurs d&apos;affiliés : création, activation et désactivation.</p>
          </div>
        </div>
        <button type="button" onClick={load} disabled={loading} aria-label="Actualiser"
          className="shrink-0 p-2 rounded-xl border border-gray-200 bg-white text-gray-600 hover:border-gray-400 disabled:opacity-60">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </div>

      <CreateForm onCreated={(rec) => { if (rec?.id) setList((l) => [rec, ...(l ?? []).filter((x) => x.id !== rec.id)]); else load(); }} />

      <section aria-labelledby="rc-list-title" className="space-y-3 min-w-0">
        <h2 id="rc-list-title" className="text-sm font-bold text-gray-900">
          Liste{list ? ` (${list.length} — ${activeCount} actif${activeCount > 1 ? "s" : ""})` : ""}
        </h2>
        {loadError && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-load-error>{loadError}</p>}
        {!list && !loadError && <p className="text-sm text-gray-500">Chargement…</p>}
        {list && list.length === 0 && <p className="text-sm text-gray-500" data-empty>Aucun recruteur pour le moment.</p>}
        {list && list.length > 0 && (
          <ul className="space-y-2 min-w-0">
            {list.map((r) => <RecruiterCard key={r.id} r={r} onToggle={setTarget} onReset={setResetTarget} />)}
          </ul>
        )}
      </section>

      {target && <ConfirmDialog target={target} onCancel={closeDialog} onDone={(rec) => { replace(rec); setTarget(null); }} />}
      {resetTarget && <ResetPasswordDialog key={resetTarget.id} target={resetTarget} onCancel={closeReset} />}
    </div>
  );
}
