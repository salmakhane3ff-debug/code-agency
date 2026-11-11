import { useEffect, useState } from "react";
import { CASABLANCA_TZ, casablancaToday as casablancaTodayAt, formatCasablanca } from "@/lib/casablancaTime";
import { checkProofSchedule } from "@/lib/paymentProofSchedule";

// Shared helpers for /admin/payment-proofs (client side, French admin).
// Payment proofs are an independent DISPLAY feed: name and amount are typed by the
// admin and are not linked to any account, payout or payment record.

export const inputCls = "w-full min-w-0 text-sm border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 focus:outline-none focus:border-gray-400";
export const btnPrimary = "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50";
export const btnGhost = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100 disabled:opacity-50";
export const btnDanger = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-red-50 text-red-700 border border-red-100 hover:bg-red-100 disabled:opacity-50";

export const TZ = CASABLANCA_TZ;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export const PRIVACY_LABEL = "Données sensibles masquées (RIB, numéro de compte, téléphone…)";
export const AUTHENTICITY_LABEL = "J'atteste que ce reçu correspond à un paiement réel (déclaration de l'administrateur)";

/** Field codes (src/lib/paymentProofs.js, paymentProofService.js) → French messages. */
export const ERROR_TEXT = {
  INVALID_ALIAS: "Nom affiché invalide (2 à 40 caractères, sans balises)",
  INVALID_AMOUNT: "Montant invalide (supérieur à 0, 2 décimales max, ≤ 1 000 000 MAD)",
  INVALID_DATETIME: "Date ou heure invalide",
  NONEXISTENT_LOCAL_TIME: "Heure inexistante (changement d'heure) — choisissez une autre heure",
  SCHEDULE_IN_PAST: "L'heure de publication doit être dans le futur",
  SCHEDULE_TOO_FAR: "Date trop lointaine (366 jours maximum)",
  INVALID_CLIENT_REF: "Référence interne invalide — supprimez et recréez la ligne",
  INVALID_BATCH: "Lot invalide",
  PRIVACY_CONFIRMATION_REQUIRED: "Confirmez que les données sensibles sont masquées",
  AUTHENTICITY_CONFIRMATION_REQUIRED: "Confirmez l'authenticité du reçu",
  DUPLICATE_IN_BATCH: "Ligne en double dans le lot",
  ALREADY_CREATED: "Déjà programmée",
  REQUIRED: "Reçu requis",
  type: "Type de fichier refusé (JPEG, PNG ou WebP)",
  size: "Fichier trop volumineux (8 Mo maximum)",
  "type,size": "Type de fichier refusé et fichier trop volumineux",
};
export const errText = (code) => (code ? ERROR_TEXT[code] || code : null);

/** API error codes → clearer French messages (fallback: the server message). */
export const API_ERROR_TEXT = {
  NOT_EDITABLE: "Cette preuve ne peut plus être modifiée (déjà publiée ou annulée).",
  NOT_CANCELLABLE: "Une preuve publiée ne peut pas être annulée.",
  RECEIPT_MISSING: "Le fichier du reçu est introuvable : annulez cette preuve et créez-en une nouvelle.",
  DUPLICATE_RECEIPT: "Ce reçu est déjà programmé ou publié.",
  CLIENT_REF_CONFLICT: "Conflit de référence : cette ligne correspond à une autre preuve.",
  BODY_TOO_LARGE: "Fichier trop volumineux (8 Mo maximum).",
  INVALID_FILE: "Reçu refusé (image JPEG, PNG ou WebP valide, 8 Mo maximum).",
  NOT_FOUND: "Preuve introuvable.",
  UNAUTHORIZED: "Session administrateur expirée — reconnectez-vous.",
};

/** Message for a failed API call: code mapping, field errors, then the server text. */
export function apiErrorText(res) {
  const d = res?.data || {};
  if (res?.status === 401 || res?.status === 403) return API_ERROR_TEXT.UNAUTHORIZED;
  if (d.code && API_ERROR_TEXT[d.code]) return API_ERROR_TEXT[d.code];
  if (d.errors && typeof d.errors === "object") {
    const parts = Object.values(d.errors).map((c) => errText(String(c))).filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  return res?.error || "Erreur";
}

/** fetch → { ok, status, data, error }. Admin auth travels in the HttpOnly cookie. */
export async function api(url, { method = "GET", body, form } = {}) {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: form !== undefined ? form : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data?.error || "Erreur") };
  } catch {
    return { ok: false, status: 0, data: null, error: "Erreur réseau" };
  }
}

export function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Today's date in Casablanca, "YYYY-MM-DD" — from the same rule table as the server
 * (src/lib/casablancaTime.js), never from this device's own time-zone data.
 */
export function casablancaToday() {
  return casablancaTodayAt(Date.now());
}

/**
 * Immediate check of a Casablanca date + time against the device clock, with the SAME
 * rule as the server (src/lib/paymentProofSchedule.js) → error code or null. Only a
 * convenience: the server re-checks with its own clock and stays the authority.
 */
export function scheduleProblem(date, time, nowMs = Date.now()) {
  if (!date || !time) return null;
  return checkProofSchedule(date, time, nowMs).error || null;
}

/** "YYYY-MM-DD" + n days (calendar arithmetic only). */
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** "2026-11-04" → "mercredi 4 nov. 2026" (the date itself, no timezone shift). */
export function dayLabel(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  if (!y || !m || !d) return String(date);
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** ISO instant → Casablanca date/time in French ("DD/MM/YYYY HH:MM"), same table as the server. */
export function fmtInstant(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? "—" : formatCasablanca(ms);
}

export const fmtMad = (n) => (n === null || n === undefined || n === "" || Number.isNaN(Number(n))
  ? "—"
  : `${Number(n).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} MAD`);

/** Client-side convenience check of a receipt file (the server re-checks everything). */
export function fileProblem(file) {
  if (!file) return "Reçu requis";
  if (!ACCEPTED_TYPES.includes(String(file.type).toLowerCase())) return ERROR_TEXT.type;
  if (file.size > MAX_FILE_BYTES) return ERROR_TEXT.size;
  return null;
}

export const STATUS_META = {
  SCHEDULED: { label: "Programmée", cls: "bg-blue-50 text-blue-700 border-blue-100" },
  PUBLISHED: { label: "Publiée", cls: "bg-emerald-50 text-emerald-700 border-emerald-100" },
  CANCELLED: { label: "Annulée", cls: "bg-gray-100 text-gray-600 border-gray-200" },
  FAILED: { label: "Échec", cls: "bg-red-50 text-red-700 border-red-100" },
};

export const FAILURE_TEXT = {
  RECEIPT_MISSING: "Fichier du reçu introuvable",
  PRIVACY_NOT_CONFIRMED: "Masquage des données non confirmé",
  AUTHENTICITY_NOT_CONFIRMED: "Authenticité non confirmée",
  INVALID_DISPLAY_NAME: "Nom affiché invalide",
  INVALID_AMOUNT: "Montant invalide",
};

export const EVENT_TEXT = {
  CREATE: "Création",
  CONFIRM_PRIVACY: "Masquage des données confirmé",
  CONFIRM_AUTHENTICITY: "Authenticité attestée",
  EDIT: "Modification",
  CANCEL: "Annulation",
  PUBLISH: "Publication",
  FAIL: "Échec de publication",
};

export function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, cls: "bg-gray-100 text-gray-600 border-gray-200" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${m.cls}`}>{m.label}</span>;
}

/** Accessible modal shell: Escape / ✕ / backdrop close it, focus returns to the opener. */
export function Modal({ title, onClose, children, wide = false }) {
  // Read during the first render, before autoFocus moves focus into the dialog.
  const [opener] = useState(() => (typeof document !== "undefined" ? document.activeElement : null));
  useEffect(() => () => {
    if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
  }, [opener]);
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-gray-900/50 p-0 sm:p-4" onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`w-full ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"} max-h-[90vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-xl`}>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 sticky top-0 bg-white">
          <h3 className="text-sm font-bold text-gray-900 min-w-0 truncate">{title}</h3>
          <button type="button" autoFocus onClick={onClose} aria-label="Fermer"
            className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 shrink-0">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/** The two mandatory declarations (privacy + authenticity). */
export function Declarations({ privacy, authenticity, onChange, idPrefix }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={`${idPrefix}-privacy`} className="flex items-start gap-2 text-xs text-gray-700">
        <input id={`${idPrefix}-privacy`} type="checkbox" checked={!!privacy} onChange={(e) => onChange({ privacy: e.target.checked })}
          className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{PRIVACY_LABEL}</span>
      </label>
      <label htmlFor={`${idPrefix}-auth`} className="flex items-start gap-2 text-xs text-gray-700">
        <input id={`${idPrefix}-auth`} type="checkbox" checked={!!authenticity} onChange={(e) => onChange({ authenticity: e.target.checked })}
          className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{AUTHENTICITY_LABEL}</span>
      </label>
    </div>
  );
}
