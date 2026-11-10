"use client";
// Shared client helpers for /admin/demo-competition/* (SIMULATION ONLY — demo profiles, never real money).

import { useState } from "react";
import Link from "next/link";
import { FlaskConical, ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { dhToCents, percentToBps, earningsCents } from "@/lib/demoCompetition/engine";

/** Every request of this section goes to the Demo Competition admin API (existing admin auth cookie). */
export const API_BASE = "/api/admin/demo-competition";

export const inputCls = "w-full text-sm border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 focus:outline-none focus:border-blue-400 disabled:opacity-60";
export const btnPrimary = "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed";
export const btnGhost = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed";
export const btnDanger = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed";
export const cardCls = "bg-white rounded-2xl border border-gray-100 shadow-sm";

// ── API ──────────────────────────────────────────────────────────────────────

const STATUS_TEXT = { 401: "Session admin expirée — reconnectez-vous.", 403: "Accès réservé aux administrateurs." };

/** Top-level API codes → French. */
export const CODE_TEXT = {
  INVALID_SETTINGS: "Paramètres invalides — corrigez les champs signalés.",
  INVALID_INPUT: "Requête invalide.",
  INVALID_JSON: "Requête invalide.",
  NOT_FOUND: "Profil introuvable.",
  MEMBER_LIMIT_REACHED: "Limite atteinte : 21 membres démo maximum (hors archivés). Archivez un membre pour en restaurer ou en créer un autre.",
  BRAND_LIMIT_REACHED: "Limite atteinte : 20 marques démo maximum (hors archivées). Archivez une marque pour en restaurer ou en créer une autre.",
  MEMBER_OWNS_BRANDS: "Ce membre possède encore des marques démo non archivées : archivez-les ou réattribuez-les d'abord.",
  ARCHIVED: "Ce profil est archivé : restaurez-le avant de le modifier.",
  OWNER_ARCHIVED: "Le membre propriétaire de cette marque est archivé : restaurez-le d'abord.",
  ENGINE_DISABLED: "Le moteur démo est désactivé : activez-le avant d'exécuter une génération.",
  OWNER_NOT_FOUND: "Propriétaire introuvable.",
  INVALID_IMAGE_TYPE: "Format non accepté (JPEG, PNG ou WebP uniquement).",
  EMPTY_IMAGE: "Fichier vide.",
  IMAGE_TOO_LARGE: "Image trop lourde (5 Mo maximum).",
  SERVER_ERROR: "Erreur serveur — réessayez.",
};

/** Field-level validation codes → French. Member and brand allocations are separate demo streams: each is validated on its own. */
export const FIELD_TEXT = {
  INVALID_NAME: "Nom requis (1 à 80 caractères, sans < ni >).",
  INVALID_MIN_ORDERS: "Nombre entier entre 0 et 1000.",
  INVALID_MAX_ORDERS: "Nombre entier entre 0 et 1000.",
  MAX_BELOW_MIN: "Le maximum doit être supérieur ou égal au minimum.",
  INVALID_PRICE: "Prix entre 0,01 et 100 000 DH (2 décimales max).",
  INVALID_ALLOCATION: "Pourcentage entre 0,01 et 100 (2 décimales max).",
  INVALID_AFFILIATES: "Nombre entier entre 0 et 100 000.",
  NETWORK_RATE_INCOMPLETE: "Renseignez le prix ET l'allocation réseau, ou laissez les deux vides (réseau désactivé).",
  OWNER_REQUIRED: "Choisissez un membre propriétaire.",
  OWNER_NOT_FOUND: "Propriétaire introuvable.",
  OWNER_ARCHIVED: "Ce membre est archivé : choisissez un membre non archivé (ou restaurez-le).",
  INVALID_TYPE: "Valeur invalide.",
  INVALID_ACTIVE: "Valeur invalide.",
};

/** Server field keys → form keys. The engine now reports networkMinDailyOrders / networkMaxDailyOrders; the lowercase spelling of an earlier draft is still accepted. */
export function normalizeFieldKey(k) {
  return String(k).replace(/^network(min|max)DailyOrders$/, (_m, p) => `network${p[0].toUpperCase()}${p.slice(1)}DailyOrders`);
}

export function normalizeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[normalizeFieldKey(k)] = v;
  return out;
}

/**
 * JSON request to the Demo Competition admin API.
 * → { ok, status, data, code, fields, error } (error = French message).
 */
export async function dcApi(path, { method = "GET", body, form } = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: form !== undefined ? form : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: res.status, data, code: null, fields: {}, error: null };
    const code = data?.code || null;
    const fields = normalizeFields(data?.fields);
    if (code === "OWNER_NOT_FOUND" && !fields.ownerId) fields.ownerId = "OWNER_NOT_FOUND";
    const error = STATUS_TEXT[res.status] || CODE_TEXT[code] || data?.error || `Erreur (${res.status})`;
    return { ok: false, status: res.status, data, code, fields, error };
  } catch {
    return { ok: false, status: 0, data: null, code: "NETWORK", fields: {}, error: "Erreur réseau." };
  }
}

// ── Formatting / conversions ─────────────────────────────────────────────────

export { dhToCents, percentToBps, earningsCents };

const NUM = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** centimes → "1 234,5 DH" (display only). */
export const fmtDh = (cents) => `${NUM.format((Number(cents) || 0) / 100)} DH`;
/** basis points → "30 %" (display only). */
export const fmtPct = (bps) => `${NUM.format((Number(bps) || 0) / 100)} %`;
/** centimes → "300" / "299.5" for a DH input field. */
export const centsToInput = (cents) => (cents === null || cents === undefined ? "" : String(cents / 100));
/** basis points → "30" / "12.5" for a % input field. */
export const bpsToInput = (bps) => (bps === null || bps === undefined ? "" : String(bps / 100));
export const fmtInt = (n) => new Intl.NumberFormat("fr-FR").format(Number(n) || 0);
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

/** Strict integer from an input string (NaN when not a whole number). */
export function toInt(v) {
  const s = String(v ?? "").trim();
  return /^-?\d+$/.test(s) ? Number(s) : NaN;
}

/** "1 demo order = X DH" preview from DH / % inputs (null when an input is invalid). */
export function previewPerOrder(priceInput, percentInput) {
  const c = dhToCents(priceInput);
  const b = percentToBps(percentInput);
  if (c === null || b === null || c <= 0 || b <= 0 || b > 10000) return null;
  return { priceCents: c, bps: b, earningsCents: earningsCents(1, c, b), remainderCents: c - earningsCents(1, c, b) };
}

// ── Components ───────────────────────────────────────────────────────────────

/** The SIMULATION notice shown on every Demo Competition admin page. */
export function SimulationNotice({ compact = false }) {
  return (
    <div className={`flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 ${compact ? "p-3" : "p-4"}`} role="note" data-simulation-notice>
      <FlaskConical className="w-5 h-5 shrink-0 mt-0.5 text-amber-600" />
      <div className="text-xs leading-relaxed">
        <p className="font-bold uppercase tracking-wide">SIMULATION — données de démonstration</p>
        <p>
          Les membres, marques, commandes et gains de la Demo Competition sont fictifs, générés par le serveur.
          Ce ne sont ni de vraies ventes, ni de vrais gains, ni de l&apos;argent retirable. Aucun lien avec les commandes,
          affiliés, portefeuilles ou paiements réels.
        </p>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, back = true, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        {back && (
          <Link href="/admin/demo-competition" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 mb-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Demo Competition
          </Link>
        )}
        <h1 className="text-xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function FieldError({ code }) {
  const msg = code ? FIELD_TEXT[code] || code : null;
  return msg ? <p className="text-[11px] text-red-600 mt-1">{msg}</p> : null;
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-600 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-400 mt-1">{hint}</span>}
      <FieldError code={error} />
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label className={`inline-flex items-center gap-2 text-sm text-gray-700 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-gray-300"}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${checked ? "start-[18px]" : "start-0.5"}`} />
      </button>
      {label}
    </label>
  );
}

export function ActiveBadge({ active }) {
  return active
    ? <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-50 text-green-700 border border-green-200">Actif</span>
    : <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500 border border-gray-200">Désactivé</span>;
}

export function ArchivedBadge() {
  return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">Archivé</span>;
}

/** Status of a profile: Archivé / Actif / Désactivé. */
export function StatusBadge({ active, archivedAt }) {
  return archivedAt ? <ArchivedBadge /> : <ActiveBadge active={active} />;
}

/** Split an admin list into non-archived (main table, counted against the limit) and archived profiles. */
export function splitArchived(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return { current: list.filter((r) => !r?.archivedAt), archived: list.filter((r) => !!r?.archivedAt) };
}

export function LiveDot({ live }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500" title={live ? "Événement démo dans les 10 dernières minutes" : "Pas d'événement récent"}>
      <span className={`w-2 h-2 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-300"}`} />
      {live ? "live" : ""}
    </span>
  );
}

export function Avatar({ src, name, size = 40, round = true }) {
  const style = { width: size, height: size };
  const initials = String(name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return src
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={src} alt={name || ""} style={style} className={`${round ? "rounded-full" : "rounded-xl"} object-cover border border-gray-100 bg-gray-50 shrink-0`} />
    : <span style={style} className={`${round ? "rounded-full" : "rounded-xl"} inline-flex items-center justify-center bg-gray-100 text-gray-500 text-xs font-bold shrink-0`}>{initials}</span>;
}

export function Notice({ notice, onClose }) {
  if (!notice) return null;
  return (
    <div className={`flex items-start justify-between gap-3 rounded-xl px-3 py-2 text-xs ${notice.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
      <span>{notice.text}</span>
      {onClose && <button type="button" onClick={onClose} className="font-bold opacity-60 hover:opacity-100">×</button>}
    </div>
  );
}

/** Collapsible "Archivés (n)" block under a list (closed by default). Renders nothing when there is no archived profile. */
export function ArchivedSection({ count, children }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <section className={cardCls} data-archived-section>
      <button
        type="button" className="w-full flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm font-bold text-gray-700"
        aria-expanded={open} onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-flex items-center gap-1.5">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} Archivés ({count})
        </span>
        <span className="text-[11px] font-normal text-gray-500">Hors classements publics · historique conservé · non comptés dans la limite</span>
      </button>
      {open && <div className="overflow-x-auto border-t border-gray-100">{children}</div>}
    </section>
  );
}

/** Counter "x / max". */
export function Counter({ value, max, label }) {
  const full = value >= max;
  return (
    <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold border ${full ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-white text-gray-700 border-gray-200"}`}>
      {value} / {max} <span className="font-medium text-gray-500">{label}</span>
    </span>
  );
}

/** Rolling-window stats tiles (24 h / 7 j / 30 j / total). */
export function StatsGrid({ stats, extra }) {
  const s = stats || {};
  const tiles = [
    ["24 h", s.earnings24hCents, s.orders24h],
    ["7 jours", s.earnings7dCents, s.orders7d],
    ["30 jours", s.earnings30dCents, s.orders30d],
    ["Total", s.earningsAllCents, s.ordersAll],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {tiles.map(([label, cents, orders]) => (
        <div key={label} className="rounded-xl bg-gray-50 border border-gray-100 p-2.5">
          <p className="text-[11px] text-gray-500">{label}</p>
          <p className="text-sm font-bold text-gray-900">{fmtDh(cents)}</p>
          <p className="text-[11px] text-gray-500">{fmtInt(orders)} cmd démo</p>
        </div>
      ))}
      {extra}
    </div>
  );
}

/** 30-day daily history as simple CSS bars (oldest first). */
export function DailyBars({ daily, network = false }) {
  const rows = Array.isArray(daily) ? daily : [];
  const max = Math.max(1, ...rows.map((d) => (d.earningsCents || 0) + (network ? d.networkEarningsCents || 0 : 0)));
  if (!rows.length) return <p className="text-xs text-gray-400">Aucun historique.</p>;
  return (
    <div>
      <div className="flex items-end gap-[2px] h-28 border-b border-gray-100" aria-label="Historique 30 jours">
        {rows.map((d) => {
          const own = d.earningsCents || 0;
          const net = network ? d.networkEarningsCents || 0 : 0;
          return (
            <div
              key={d.day}
              className="flex-1 flex flex-col justify-end min-w-[3px]"
              title={`${d.day} — ${fmtInt(d.orders)} cmd · ${fmtDh(own)}${network ? ` · réseau ${fmtInt(d.networkOrders)} cmd · ${fmtDh(net)}` : ""}`}
            >
              {net > 0 && <div className="bg-violet-300 rounded-t-sm" style={{ height: `${(net / max) * 100}%` }} />}
              <div className={`bg-blue-500 ${net > 0 ? "" : "rounded-t-sm"}`} style={{ height: `${(own / max) * 100}%` }} />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
        <span>{rows[0]?.day}</span>
        {network && (
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 bg-blue-500 rounded-sm" />personnel</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 bg-violet-300 rounded-sm" />réseau</span>
          </span>
        )}
        <span>{rows[rows.length - 1]?.day}</span>
      </div>
    </div>
  );
}

const EVENT_LABEL = { PERSONAL_SALE: "Vente démo perso", NETWORK_SALE: "Vente démo réseau", BRAND_SALE: "Vente démo marque" };

export function RecentEvents({ recent }) {
  const rows = Array.isArray(recent) ? recent : [];
  if (!rows.length) return <p className="text-xs text-gray-400">Aucun événement démo pour l&apos;instant.</p>;
  return (
    <ul className="divide-y divide-gray-100 text-xs">
      {rows.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex items-center justify-between gap-2 py-1.5">
          <span className="text-gray-700">{EVENT_LABEL[e.type] || e.type} · {e.quantity} cmd</span>
          <span className="text-gray-500">{fmtDh(e.earningsCents)} · {fmtDateTime(e.at)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Settings version history (newest first). */
export function VersionHistory({ versions, network = false }) {
  const rows = Array.isArray(versions) ? versions : [];
  if (!rows.length) return <p className="text-xs text-gray-400">Aucune version.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] text-start">
        <thead className="text-gray-500">
          <tr className="text-start">
            <th className="py-1 pe-2 text-start font-semibold">En vigueur depuis</th>
            <th className="py-1 pe-2 text-start font-semibold">Actif</th>
            <th className="py-1 pe-2 text-start font-semibold">Min–max/j</th>
            <th className="py-1 pe-2 text-start font-semibold">Prix</th>
            <th className="py-1 pe-2 text-start font-semibold">Alloc.</th>
            {network && <th className="py-1 pe-2 text-start font-semibold">Réseau</th>}
            <th className="py-1 text-start font-semibold">Par</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 text-gray-700">
          {rows.map((v, i) => (
            <tr key={v.id || i}>
              <td className="py-1 pe-2 whitespace-nowrap">{fmtDateTime(v.effectiveFrom)}</td>
              <td className="py-1 pe-2">{v.active ? "oui" : "non"}</td>
              <td className="py-1 pe-2">{v.minDailyOrders}–{v.maxDailyOrders}</td>
              <td className="py-1 pe-2 whitespace-nowrap">{fmtDh(v.priceCents)}</td>
              <td className="py-1 pe-2">{fmtPct(v.allocationBps)}</td>
              {network && (
                <td className="py-1 pe-2 whitespace-nowrap">
                  {v.networkPriceCents !== null && v.networkPriceCents !== undefined && v.networkAllocationBps !== null && v.networkAllocationBps !== undefined
                    ? `${v.networkAffiliates} aff. · ${v.networkMinDailyOrders}–${v.networkMaxDailyOrders}/j · ${fmtDh(v.networkPriceCents)} · ${fmtPct(v.networkAllocationBps)}`
                    : "non configuré"}
                </td>
              )}
              <td className="py-1 truncate max-w-[120px]">{v.createdBy || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Client-side check before upload: JPEG / PNG / WebP, ≤ 5 MB. → error code or null. */
export function checkImageFile(file) {
  if (!file) return "EMPTY_IMAGE";
  if (!IMAGE_TYPES.includes(file.type)) return "INVALID_IMAGE_TYPE";
  if (file.size <= 0) return "EMPTY_IMAGE";
  if (file.size > MAX_IMAGE_BYTES) return "IMAGE_TOO_LARGE";
  return null;
}

/** Copy explaining that settings affect future demo events only. */
export function FutureOnlyHint() {
  return (
    <p className="text-[11px] text-gray-500 leading-relaxed">
      Les modifications s&apos;appliquent uniquement aux <strong>futurs</strong> événements démo : l&apos;historique garde ses valeurs.
      Prix et allocation changent immédiatement ; le min/max de commandes par jour s&apos;applique à partir du prochain jour
      (heure de Casablanca).
    </p>
  );
}
