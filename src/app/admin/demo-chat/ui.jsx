"use client";

/** Shared bits of the DEMO chat admin pages (Phase 3C-2). */
export { DemoBadge } from "../demo-profiles/ui";

export const field = "w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400";

export async function api(url, method = "GET", body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "Erreur"), { status: r.status, code: d.code, field: d.field });
  return d;
}

export function SimulationBadge() {
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black bg-indigo-50 text-indigo-700 border border-indigo-200">SIMULATION</span>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>;
}

export const STATUS_LABEL = { draft: "Brouillon", archived: "Archivé" };
export const TYPE_LABEL = { text: "Texte", earnings: "Gains", image: "Image", audio: "Audio" };
export const PERIOD_LABEL = { today: "Aujourd'hui", yesterday: "Hier", week: "Semaine" };
export const METRIC_LABEL = { commission: "Commission (MAD)", orders: "Commandes (nombre)", revenue: "Chiffre d'affaires (MAD)" };
export const fmtDate = (s) => (s ? new Date(s).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—");
