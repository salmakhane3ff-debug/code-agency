"use client";
/**
 * Small leaderboard badges: RankBadge, LiveBadge, MovementIndicator (▲ / ▼ from live
 * diffs, else from the 24 h rank change) and SimulationNote — the discreet simulation
 * footnote, whose text comes ONLY from src/lib/demoCompetition/disclosure.js.
 */
import { Info } from "lucide-react";
import { movementOf } from "@/lib/demoCompetition/livePolling";
import { demoDir } from "@/lib/demoCompetition/i18n";
import { simulationDisclosure } from "@/lib/demoCompetition/disclosure";
import "./demoCompetition.css";

// Gold / silver / bronze medals for 1-3, a light neutral disc for the others.
const RANK_STYLES = {
  1: "bg-gradient-to-br from-yellow-300 to-amber-500 text-amber-950 shadow-[0_2px_6px_rgba(245,158,11,0.45)] ring-2 ring-amber-200",
  2: "bg-gradient-to-br from-slate-100 to-slate-300 text-slate-800 shadow-[0_2px_6px_rgba(100,116,139,0.35)] ring-2 ring-slate-200",
  3: "bg-gradient-to-br from-orange-300 to-orange-600 text-orange-950 shadow-[0_2px_6px_rgba(234,88,12,0.35)] ring-2 ring-orange-200",
};

const RANK_DIMS = { lg: "h-11 w-11 text-base", card: "h-9 w-9 text-[15px]", md: "h-8 w-8 text-sm", sm: "h-6 w-6 text-[12px]" };

export function RankBadge({ rank, t, size = "md" }) {
  const dim = RANK_DIMS[size] || RANK_DIMS.md;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-black tabular-nums ${dim} ${RANK_STYLES[rank] || "bg-gray-100 text-gray-700"}`}
      aria-label={t("rank_label", { rank })}
      title={t("rank_label", { rank })}
    >
      <bdi dir="ltr">{rank}</bdi>
    </span>
  );
}

export function LiveBadge({ live, t }) {
  if (!live) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-600" title={t("live_title")}>
      <span className="dc-live-dot" aria-hidden="true" />
      {t("live")}
    </span>
  );
}

/**
 * Discreet simulation footnote (small muted text, direction of the page language). The sentence is the central
 * disclosure (src/lib/demoCompetition/disclosure.js); when it is disabled there, nothing is rendered.
 */
export function SimulationNote({ lang, className = "" }) {
  const text = simulationDisclosure(lang);
  if (!text) return null;
  return (
    <p role="note" dir={demoDir(lang)} lang={lang} className={`flex items-start justify-center gap-1 text-center text-[11px] leading-snug text-gray-500 ${className}`}>
      <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

export function MovementIndicator({ diff, rankChange24h, t, compact = false }) {
  const m = movementOf(diff, rankChange24h);
  if (m.kind === "none") return null;
  if (m.kind === "new") {
    return <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-bold text-blue-700">{t("new_entry")}</span>;
  }
  if (m.kind === "same") {
    if (compact) return null; // compact rows (homepage preview) only show real moves
    return <span className="text-xs font-bold text-gray-400" title={t("no_change_24h")} aria-label={t("no_change_24h")}>=</span>;
  }
  const up = m.kind === "up";
  const live = m.source === "live";
  const label = t(`moved_${m.kind}${live ? "" : "_24h"}`, { n: m.n });
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full tabular-nums ${compact ? "px-1 text-[11px] font-bold" : "px-1.5 py-0.5 text-sm font-extrabold"} ${up ? "text-emerald-700" : "text-red-600"} ${live ? (up ? "bg-emerald-50" : "bg-red-50") : ""}`}
      title={label}
      aria-label={label}
    >
      <span aria-hidden="true">{up ? "▲" : "▼"}</span>
      <bdi dir="ltr" aria-hidden="true">{up ? `+${m.n}` : `-${m.n}`}</bdi>
    </span>
  );
}
