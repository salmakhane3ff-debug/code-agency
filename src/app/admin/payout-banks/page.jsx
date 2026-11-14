"use client";

/**
 * /admin/payout-banks — catalogue of the banks shown to affiliates and recruiters in the
 * withdrawal bank picker (Phase 4). Not the company "Bank Settings" page.
 * Banks are never deleted: they are deactivated (users who chose one keep it).
 * Rules (hints only, the server decides): src/lib/payoutBanks.js.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Edit3, Landmark, Loader2, CheckCircle, XCircle, X, Upload, Users, Info, Power, PowerOff,
} from "lucide-react";
import {
  PAYOUT_BANK_LIMITS, PAYOUT_BANK_LOGO_EXTS, PAYOUT_BANK_LOGO_TYPES, checkLogoFile, cleanBankText, parseAdminBankInput,
} from "@/lib/payoutBanks";

const API = "/api/admin/payout-banks";
const MAX_MB = PAYOUT_BANK_LIMITS.LOGO_MAX_BYTES / 1024 / 1024;

// ── Messages (server codes → French) ─────────────────────────────────────────

const FIELD_MESSAGES = {
  INVALID_NAME: `Nom requis (1 à ${PAYOUT_BANK_LIMITS.NAME_MAX} caractères, sans « < » ni « > »).`,
  NAME_TAKEN: "Une banque porte déjà ce nom.",
  INVALID_FLAG: "Valeur invalide.",
  INVALID_SORT_ORDER: `L'ordre doit être un nombre entier entre 0 et ${PAYOUT_BANK_LIMITS.SORT_MAX}.`,
  UNKNOWN_FIELD: "Requête invalide (champ inconnu).",
  EMPTY_UPDATE: "Aucune modification à enregistrer.",
  INVALID_BODY: "Requête invalide.",
  LOGO_MISSING: "Choisissez un fichier image.",
  LOGO_TYPE: "Formats acceptés : PNG, JPG, WEBP.",
  LOGO_EMPTY: "Le fichier est vide.",
  LOGO_TOO_LARGE: `Image trop lourde (max ${MAX_MB} Mo).`,
  LOGO_INVALID: "Image invalide ou corrompue.",
};
const fieldMsg = (code) => FIELD_MESSAGES[code] || "Valeur invalide.";

/** fetch → { ok, status, data } (never throws on a non-JSON body). Same-origin: the auth_token cookie goes along. */
async function call(url, init = {}) {
  const res = await fetch(url, { cache: "no-store", ...init });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data: data || {} };
}

/** A failed response → { message, fields }. */
function readError({ status, data }) {
  if (status === 401 || status === 403) return { message: "Session admin expirée ou accès refusé — reconnectez-vous.", fields: {} };
  if (data?.code === "NOT_FOUND") return { message: "Banque introuvable (elle a peut-être changé) — rechargez la page.", fields: {} };
  const fields = data?.fields && typeof data.fields === "object" ? { ...data.fields } : {};
  // Logo errors come back as a bare code (415 / 413 / 400).
  if (["LOGO_TYPE", "LOGO_INVALID", "LOGO_EMPTY", "LOGO_TOO_LARGE"].includes(data?.code)) fields.logo = data.code;
  const message = fields.body ? fieldMsg(fields.body) : (data?.error || (status >= 500 ? "Erreur serveur." : "Erreur."));
  return { message, fields };
}

const initials = (name) => {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || "") + (words[1]?.[0] || "")).toUpperCase() || "?";
};
const usageLabel = (n) => `${n} utilisateur${n > 1 ? "s" : ""}`;
const byCatalogueOrder = (a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name, "fr", { sensitivity: "base" }) || String(a.id).localeCompare(String(b.id));

// ── Small UI pieces ──────────────────────────────────────────────────────────

function BankLogo({ bank, size = "w-11 h-11" }) {
  return (
    <div className={`${size} rounded-xl border border-gray-100 bg-white flex items-center justify-center shrink-0 overflow-hidden shadow-sm`}>
      {bank?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={bank.logoUrl} alt={bank.name} className="w-full h-full object-contain p-1" loading="lazy" />
      ) : (
        <span className="text-xs font-bold text-gray-400" aria-hidden="true">{initials(bank?.name)}</span>
      )}
    </div>
  );
}

function Badge({ tone, children }) {
  const cls = {
    green: "bg-green-50 text-green-700 border-green-200",
    gray: "bg-gray-100 text-gray-500 border-gray-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  }[tone] || "bg-gray-100 text-gray-500 border-gray-200";
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap ${cls}`}>{children}</span>;
}

function Modal({ title, onClose, disabled, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !disabled) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, disabled]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col min-w-0">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-sm font-bold text-gray-800 truncate">{title}</h2>
          <button type="button" onClick={onClose} disabled={disabled} aria-label="Fermer" className="text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

const inputCls = (bad) =>
  `w-full px-3 py-2.5 text-sm border rounded-xl bg-gray-50 focus:outline-none ${bad ? "border-red-300 focus:border-red-400" : "border-gray-200 focus:border-gray-400"}`;
const FieldError = ({ code, id }) => (code ? <p id={id} className="mt-1 text-xs font-medium text-red-600">{fieldMsg(code)}</p> : null);

/** Oui / Non segmented choice. */
function YesNo({ name, value, onChange, disabled }) {
  return (
    <div className="inline-flex rounded-xl border border-gray-200 bg-gray-50 p-0.5" role="radiogroup">
      {[[true, "Oui"], [false, "Non"]].map(([v, label]) => (
        <label key={label} className={`px-4 py-1.5 text-sm font-semibold rounded-lg cursor-pointer transition-colors ${value === v ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
          <input type="radio" name={name} className="sr-only" checked={value === v} onChange={() => onChange(v)} disabled={disabled} />
          {label}
        </label>
      ))}
    </div>
  );
}

// ── Create / edit form ───────────────────────────────────────────────────────

/**
 * initial = null → create; otherwise the bank being edited.
 * onSubmit({ values, logoFile }) → resolves to { fields } on failure (shown next to fields) or nothing.
 */
function BankForm({ initial, onSubmit, onClose, saving, serverFields }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [ribRequired, setRibRequired] = useState(initial ? initial.ribRequired !== false : true);
  const [isActive, setIsActive] = useState(initial ? initial.isActive === true : true);
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const [logoFile, setLogoFile] = useState(null);
  const [preview, setPreview] = useState(null);
  // Server field errors come back from onSubmit; serverFields seeds them when the form remounts
  // (a created bank whose logo upload failed reopens in edit mode).
  const [localFields, setLocalFields] = useState(() => ({ ...(serverFields || {}) }));
  const fileRef = useRef(null);

  useEffect(() => {
    if (!logoFile) { setPreview(null); return undefined; }
    const url = URL.createObjectURL(logoFile);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  const fields = localFields;

  const pickLogo = (e) => {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    const code = checkLogoFile({ type: file.type, name: file.name, size: file.size });
    if (code) {
      setLogoFile(null);
      setLocalFields((f) => ({ ...f, logo: code }));
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setLocalFields(({ logo: _drop, ...rest }) => rest);
    setLogoFile(file);
  };
  const clearLogo = () => {
    setLogoFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const trimmed = sortOrder.trim();
    const order = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    let values;
    if (!isEdit) {
      values = { name, ribRequired, isActive, sortOrder: order };
    } else {
      // Only what changed (the server takes a partial update).
      values = {};
      if (cleanBankText(name) !== initial.name) values.name = name;
      if (ribRequired !== (initial.ribRequired !== false)) values.ribRequired = ribRequired;
      if (Number.isNaN(order) || order !== initial.sortOrder) values.sortOrder = order;
    }
    const pre = (isEdit && Object.keys(values).length === 0) ? null : parseAdminBankInput(values, { partial: isEdit }).fields;
    const logoCode = logoFile ? checkLogoFile({ type: logoFile.type, name: logoFile.name, size: logoFile.size }) : null;
    const next = { ...(pre || {}), ...(logoCode ? { logo: logoCode } : {}) };
    setLocalFields(next);
    if (Object.keys(next).length) return;
    const res = await onSubmit({ values, logoFile });
    if (res?.fields) setLocalFields(res.fields);
  };

  const accept = [...PAYOUT_BANK_LOGO_TYPES, ...PAYOUT_BANK_LOGO_EXTS].join(",");
  const shownLogo = preview || initial?.logoUrl || null;

  return (
    <form onSubmit={submit} className="space-y-4" data-payout-bank-form={isEdit ? initial.id : "new"} noValidate>
      {fields.body && <p className="text-xs font-medium text-red-600">{fieldMsg(fields.body)}</p>}

      {/* Logo */}
      <div>
        <span className="block text-xs font-semibold text-gray-600 mb-1.5">Logo de la banque <span className="font-normal text-gray-400">(optionnel)</span></span>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-14 h-14 rounded-xl border border-gray-200 bg-gray-50 flex items-center justify-center shrink-0 overflow-hidden shadow-sm">
            {shownLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shownLogo} alt="Aperçu du logo" className="w-full h-full object-contain p-1.5" />
            ) : (
              <span className="text-sm font-bold text-gray-300" aria-hidden="true">{initials(name)}</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                {logoFile || initial?.logoUrl ? "Remplacer le logo" : "Choisir un logo"}
              </button>
              {logoFile && (
                <button type="button" onClick={clearLogo} disabled={saving} className="px-3 py-1.5 text-xs font-semibold bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 disabled:opacity-50">
                  Annuler le fichier
                </button>
              )}
            </div>
            <p className="text-[11px] text-gray-400 break-words">
              {logoFile ? logoFile.name : `PNG, JPG ou WEBP — max ${MAX_MB} Mo.`}
            </p>
          </div>
        </div>
        <input ref={fileRef} type="file" accept={accept} onChange={pickLogo} className="hidden" aria-label="Fichier du logo" />
        <FieldError code={fields.logo} id="pb-logo-err" />
      </div>

      {/* Name */}
      <div>
        <label htmlFor="pb-name" className="block text-xs font-semibold text-gray-600 mb-1.5">
          Nom de la banque <span className="text-red-500">*</span>
        </label>
        <input
          id="pb-name"
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setLocalFields(({ name: _n, ...rest }) => rest); }}
          maxLength={PAYOUT_BANK_LIMITS.NAME_MAX}
          placeholder="ex: CIH Bank"
          required
          disabled={saving}
          aria-invalid={!!fields.name}
          aria-describedby={fields.name ? "pb-name-err" : undefined}
          className={inputCls(!!fields.name)}
        />
        <FieldError code={fields.name} id="pb-name-err" />
      </div>

      {/* RIB required */}
      <div>
        <span className="block text-xs font-semibold text-gray-600 mb-1.5">RIB requis</span>
        <YesNo name="pb-rib" value={ribRequired} onChange={setRibRequired} disabled={saving} />
        <p className="mt-1 text-[11px] text-gray-400">
          {ribRequired ? "L'utilisateur doit saisir son RIB (10 à 34 caractères)." : "Le RIB n'est pas demandé (seul le nom du titulaire l'est)."}
        </p>
        <FieldError code={fields.ribRequired} id="pb-rib-err" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Order */}
        <div>
          <label htmlFor="pb-order" className="block text-xs font-semibold text-gray-600 mb-1.5">Ordre d&apos;affichage</label>
          <input
            id="pb-order"
            type="number"
            inputMode="numeric"
            min="0"
            max={PAYOUT_BANK_LIMITS.SORT_MAX}
            step="1"
            value={sortOrder}
            onChange={(e) => { setSortOrder(e.target.value); setLocalFields(({ sortOrder: _s, ...rest }) => rest); }}
            disabled={saving}
            aria-invalid={!!fields.sortOrder}
            aria-describedby={fields.sortOrder ? "pb-order-err" : undefined}
            className={inputCls(!!fields.sortOrder)}
          />
          <FieldError code={fields.sortOrder} id="pb-order-err" />
        </div>

        {/* Active (create only — afterwards use the Activer / Désactiver button) */}
        {!isEdit && (
          <div>
            <span className="block text-xs font-semibold text-gray-600 mb-1.5">Active</span>
            <YesNo name="pb-active" value={isActive} onChange={setIsActive} disabled={saving} />
            <FieldError code={fields.isActive} id="pb-active-err" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 min-w-[140px] flex items-center justify-center gap-2 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-bold disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {saving ? "Enregistrement..." : isEdit ? "Enregistrer" : "Ajouter la banque"}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="px-5 py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminPayoutBanksPage() {
  const [banks, setBanks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null); // null | "create" | bank (edit)
  const [saving, setSaving] = useState(false);
  const [serverFields, setServerFields] = useState({});
  const [togglingId, setTogglingId] = useState(null);
  const [confirmBank, setConfirmBank] = useState(null); // bank awaiting deactivation confirm

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const r = await call(API);
      if (!r.ok) {
        if (!silent) setLoadError(readError(r).message);
        return;
      }
      setBanks(Array.isArray(r.data.banks) ? r.data.banks : []);
      setLoadError(null);
    } catch {
      if (!silent) setLoadError("Erreur réseau — impossible de charger les banques.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Merge a server bank into the list (PATCH / logo responses carry usage 0: keep the known count). */
  const mergeBank = useCallback((bank) => {
    setBanks((list) => {
      const prev = list.find((b) => b.id === bank.id);
      const merged = { ...bank, usage: prev ? prev.usage : (bank.usage ?? 0) };
      const next = prev ? list.map((b) => (b.id === bank.id ? merged : b)) : [...list, merged];
      return [...next].sort(byCatalogueOrder);
    });
  }, []);

  const counts = useMemo(() => ({
    total: banks.length,
    active: banks.filter((b) => b.isActive).length,
  }), [banks]);

  const openModal = (m) => { setServerFields({}); setError(null); setNotice(null); setModal(m); };
  const closeModal = () => { if (!saving) { setModal(null); setServerFields({}); setError(null); } };

  const uploadLogo = async (bankId, file) => {
    const fd = new FormData();
    fd.append("logo", file);
    const r = await call(`${API}/${bankId}/logo`, { method: "POST", body: fd });
    return r;
  };

  const handleSubmit = async ({ values, logoFile }) => {
    const isEdit = modal && modal !== "create";
    setSaving(true);
    setServerFields({});
    setError(null);
    try {
      if (isEdit && !Object.keys(values).length && !logoFile) { setModal(null); return undefined; }
      let bank = isEdit ? modal : null;
      if (!isEdit || Object.keys(values).length) {
        const r = await call(isEdit ? `${API}/${modal.id}` : API, {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        if (!r.ok) {
          const { message, fields } = readError(r);
          setError(Object.keys(fields).length ? "Corrigez les champs indiqués." : message);
          return { fields };
        }
        bank = r.data.bank;
        mergeBank(bank);
      }
      if (logoFile) {
        const r = await uploadLogo(bank.id, logoFile);
        if (!r.ok) {
          const { message, fields } = readError(r);
          const logoFields = fields.logo ? { logo: fields.logo } : {};
          setServerFields(logoFields);
          // The bank itself is saved: keep the modal open in edit mode so a retry never creates a duplicate.
          setModal(bank);
          setError(isEdit ? `Modifications enregistrées, mais le logo n'a pas été envoyé : ${message}` : `Banque créée, mais le logo n'a pas été envoyé : ${message} Choisissez à nouveau le fichier.`);
          return { fields: logoFields };
        }
        bank = r.data.bank;
        mergeBank(bank);
      }
      setModal(null);
      setNotice(isEdit ? `« ${bank.name} » mise à jour.` : `« ${bank.name} » ajoutée.`);
      load({ silent: true });
      return undefined;
    } catch {
      setError("Erreur réseau — réessayez.");
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (bank, isActive) => {
    setTogglingId(bank.id);
    setError(null);
    setNotice(null);
    try {
      const r = await call(`${API}/${bank.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!r.ok) { setError(readError(r).message); return; }
      mergeBank(r.data.bank);
      setNotice(isActive ? `« ${bank.name} » est de nouveau proposée.` : `« ${bank.name} » est désactivée.`);
      load({ silent: true });
    } catch {
      setError("Erreur réseau — réessayez.");
    } finally {
      setTogglingId(null);
      setConfirmBank(null);
    }
  };

  const handleToggle = (bank) => {
    if (togglingId) return;
    if (bank.isActive && bank.usage > 0) { setConfirmBank(bank); return; }
    setActive(bank, !bank.isActive);
  };

  return (
    <div className="py-6 space-y-5 max-w-7xl min-w-0 [contain:inline-size]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Landmark className="w-6 h-6 text-gray-400 shrink-0" /> Banques de retrait
          </h1>
          <p className="text-sm text-gray-500 mt-0.5 break-words">
            Banques proposées aux affiliés et aux recruteurs dans le choix de la banque de retrait (logo + nom).
            Ce n&apos;est pas la page « Bank Settings » des coordonnées bancaires de la boutique.
          </p>
          {!loading && !loadError && (
            <p className="text-xs text-gray-400 mt-1">{counts.active} active(s) / {counts.total} banque(s)</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => openModal("create")}
          className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 hover:bg-gray-700 text-white text-sm font-semibold rounded-xl transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" /> Nouvelle banque
        </button>
      </div>

      <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-2xl px-4 py-3 text-xs text-blue-800">
        <Info className="w-4 h-4 shrink-0 mt-px" />
        <p className="min-w-0 break-words">
          Les banques ne sont jamais supprimées : désactivez une banque pour ne plus la proposer. Les utilisateurs qui l&apos;ont
          déjà choisie la gardent et leurs coordonnées enregistrées restent valides.
        </p>
      </div>

      {error && !modal && (
        <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-auto shrink-0" aria-label="Fermer"><X className="w-4 h-4" /></button>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-2 bg-green-50 border border-green-200 rounded-2xl px-4 py-3 text-sm text-green-700">
          <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="min-w-0 break-words">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="ml-auto shrink-0" aria-label="Fermer"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* List */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16" aria-busy="true">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 py-16 px-4 text-center">
            <XCircle className="w-10 h-10 text-red-200" />
            <p className="text-sm text-red-600">{loadError}</p>
            <button type="button" onClick={() => load()} className="px-4 py-2 text-sm font-semibold border border-gray-200 rounded-xl hover:bg-gray-50">Réessayer</button>
          </div>
        ) : banks.length === 0 ? (
          <div className="flex flex-col items-center py-16 px-4 text-center">
            <Landmark className="w-10 h-10 text-gray-200 mb-3" />
            <p className="text-gray-500 text-sm font-medium">Aucune banque pour le moment</p>
            <p className="text-gray-400 text-xs mt-1">Ajoutez la première banque pour qu&apos;elle apparaisse dans le choix de banque des utilisateurs.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {banks.map((b) => {
              const busy = togglingId === b.id;
              return (
                <li key={b.id} data-payout-bank-row={b.id} className={`flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 ${b.isActive ? "" : "bg-gray-50/60"}`}>
                  <div className="flex items-center gap-3 min-w-0 flex-1 basis-60">
                    <BankLogo bank={b} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className={`font-semibold break-words min-w-0 ${b.isActive ? "text-gray-900" : "text-gray-500"}`}>{b.name}</p>
                        <Badge tone={b.isActive ? "green" : "gray"}>{b.isActive ? "Active" : "Inactive"}</Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-gray-500">
                        <span>RIB requis : <strong className="font-semibold text-gray-700">{b.ribRequired ? "Oui" : "Non"}</strong></span>
                        <span>Ordre : <strong className="font-semibold text-gray-700">{b.sortOrder}</strong></span>
                        <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" />{usageLabel(b.usage ?? 0)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ms-auto">
                    <button
                      type="button"
                      onClick={() => openModal(b)}
                      disabled={busy}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-xl hover:bg-blue-100 transition-colors disabled:opacity-50"
                    >
                      <Edit3 className="w-3.5 h-3.5" /> Modifier
                    </button>
                    <button
                      type="button"
                      data-payout-bank-toggle={b.id}
                      onClick={() => handleToggle(b)}
                      disabled={!!togglingId}
                      aria-pressed={b.isActive}
                      className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl transition-colors disabled:opacity-50 ${
                        b.isActive ? "bg-amber-50 text-amber-700 hover:bg-amber-100" : "bg-green-50 text-green-700 hover:bg-green-100"
                      }`}
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : b.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                      {b.isActive ? "Désactiver" : "Activer"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Create / edit */}
      {modal && (
        <Modal title={modal === "create" ? "Nouvelle banque de retrait" : `Modifier : ${modal.name}`} onClose={closeModal} disabled={saving}>
          {error && (
            <div role="alert" className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">
              <XCircle className="w-4 h-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
          <BankForm
            key={modal === "create" ? "create" : modal.id}
            initial={modal === "create" ? null : modal}
            onSubmit={handleSubmit}
            onClose={closeModal}
            saving={saving}
            serverFields={serverFields}
          />
        </Modal>
      )}

      {/* Deactivation confirm (bank already chosen by users) */}
      {confirmBank && (
        <Modal title={`Désactiver « ${confirmBank.name} » ?`} onClose={() => { if (!togglingId) setConfirmBank(null); }} disabled={!!togglingId}>
          <div className="space-y-3 text-sm text-gray-600">
            <p>
              <strong className="text-gray-900">{usageLabel(confirmBank.usage)}</strong> {confirmBank.usage > 1 ? "ont" : "a"} déjà choisi cette banque.
            </p>
            <ul className="list-disc ps-5 space-y-1">
              <li>Ils la gardent : leurs coordonnées enregistrées restent valides et ils peuvent toujours demander un retrait.</li>
              <li>Les nouveaux utilisateurs (ou ceux qui changent de banque) ne pourront plus la choisir.</li>
              <li>Vous pourrez la réactiver à tout moment.</li>
            </ul>
          </div>
          <div className="flex flex-wrap gap-3 pt-5">
            <button
              type="button"
              onClick={() => setActive(confirmBank, false)}
              disabled={!!togglingId}
              data-payout-bank-confirm-deactivate={confirmBank.id}
              className="flex-1 min-w-[140px] flex items-center justify-center gap-2 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-sm font-bold disabled:opacity-50"
            >
              {togglingId ? <Loader2 className="w-4 h-4 animate-spin" /> : <PowerOff className="w-4 h-4" />}
              Désactiver
            </button>
            <button
              type="button"
              onClick={() => setConfirmBank(null)}
              disabled={!!togglingId}
              className="px-5 py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              Annuler
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
