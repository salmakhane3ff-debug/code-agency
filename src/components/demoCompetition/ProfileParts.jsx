"use client";
/**
 * Building blocks of the public Top Members / Top Brands pages: page shell (language
 * direction + the discreet simulation footnote), status notices, back link,
 * not-found state, stat tiles (highlighted ~1.5 s when their value changes),
 * the 30-day CSS bar chart and the recent activity list.
 */
import Link from "next/link";
import { ChevronLeft, SearchX } from "lucide-react";
import { Money, Count } from "./CountUp";
import { SimulationNote } from "./Badges";
import { useValueFlash } from "./useLivePolling";
import { dayLabel, formatMoney, formatCount, relativeTime } from "@/lib/demoCompetition/i18n";
import "./demoCompetition.css";

/**
 * Page root: direction + language of the storefront, mobile-first width, and — on every page and profile, whatever
 * the state (loading, error, not found) — the discreet simulation footnote at the bottom (central disclosure).
 */
export function PageShell({ shellRef, dir, lang, children }) {
  return (
    <main ref={shellRef} dir={dir} lang={lang} className="mx-auto w-full max-w-3xl overflow-x-clip px-4 pb-12 pt-6 text-start sm:pt-10">
      {children}
      <SimulationNote lang={lang} className="mt-8" />
    </main>
  );
}

/** Error notices: no data yet → "retrying"; data kept → "last values shown". */
export function StatusNotice({ error, hasData, t }) {
  if (!error) return null;
  return (
    <p role="status" className={`mb-4 rounded-xl px-3 py-2 text-xs ${hasData ? "bg-gray-100 text-gray-600" : "bg-red-50 text-red-700"}`}>
      {hasData ? t("error_stale") : t("error_load")}
    </p>
  );
}

export function BackLink({ href, label }) {
  return (
    <Link href={href} className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-gray-600 hover:text-gray-900">
      <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
      {label}
    </Link>
  );
}

export function NotFoundState({ title, text, href, back }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white px-6 py-10 text-center shadow-sm">
      <SearchX className="mx-auto h-10 w-10 text-gray-300" aria-hidden="true" />
      <h1 className="mt-3 text-xl font-black text-gray-900">{title}</h1>
      <p className="mt-1 text-sm text-gray-500">{text}</p>
      <Link href={href} className="mt-5 inline-flex items-center gap-1 rounded-full bg-gray-900 px-5 py-2 text-sm font-bold text-white hover:bg-gray-800">
        <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        {back}
      </Link>
    </div>
  );
}

export function ProfileSkeleton() {
  return (
    <div className="space-y-4 motion-safe:animate-pulse" aria-busy="true">
      <div className="h-28 rounded-2xl bg-gray-100" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-xl bg-gray-100" />)}
      </div>
      <div className="h-40 rounded-2xl bg-gray-100" />
    </div>
  );
}

export function Section({ title, children, aside = null }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-black text-gray-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One stat tile; `cents` → money, `count` → integer, `empty` → muted text. Flashes on change. */
export function StatTile({ label, cents, count, lang, empty, tone = "text-gray-900" }) {
  const value = cents ?? count ?? null;
  const flash = useValueFlash(value);
  return (
    <div className={`min-w-0 rounded-xl border border-gray-100 bg-white px-3 py-2.5 shadow-sm ${flash ? "dc-highlight" : ""}`}>
      <p className="truncate text-[11px] text-gray-500">{label}</p>
      <p className={`mt-0.5 truncate text-base font-black ${tone}`}>
        {empty ? <span className="text-sm font-medium text-gray-400">{empty}</span>
          : cents != null ? <Money cents={cents} lang={lang} animate />
            : <Count value={count} lang={lang} />}
      </p>
    </div>
  );
}

/** Earnings tiles 24 h / 7 d / 30 d / all-time (+ optional extra tiles). */
export function PeriodTiles({ values, t, lang, tone, empty, extra = null }) {
  const periods = [["period_24h", values?.h24], ["period_7d", values?.d7], ["period_30d", values?.d30], ["period_all", values?.all]];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {periods.map(([k, v]) => <StatTile key={k} label={t(k)} cents={empty ? null : (v ?? 0)} empty={empty} lang={lang} tone={tone} />)}
      {extra}
    </div>
  );
}

/**
 * 30-day daily history, simple CSS bars (oldest → newest, left → right). Each
 * stream = { key, ordersKey, label, color, swatch }; several streams are drawn
 * side by side per day so they stay distinguishable.
 */
export function HistoryChart({ daily, streams, t, lang }) {
  const days = Array.isArray(daily) ? daily : [];
  if (!days.length) return null;
  const max = Math.max(1, ...days.flatMap((d) => streams.map((s) => Number(d[s.key]) || 0)));
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-gray-600">
        {streams.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${s.swatch}`} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
      <div role="img" aria-label={t("history_label")} dir="ltr" className="flex h-36 items-end gap-[2px] border-b border-gray-100">
        {days.map((d) => (
          <div key={d.day} className="flex h-full min-w-0 flex-1 items-end gap-px">
            {streams.map((s) => {
              const v = Number(d[s.key]) || 0;
              const pct = (v / max) * 100;
              return (
                <div
                  key={s.key}
                  title={t("bar_title", { day: dayLabel(d.day, lang), label: s.label, amount: formatMoney(v, lang), orders: formatCount(d[s.ordersKey], lang) })}
                  className={`dc-bar min-w-0 flex-1 rounded-t-sm ${s.color}`}
                  style={{ height: v > 0 ? `max(${pct.toFixed(2)}%, 2px)` : "0px" }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div dir="ltr" className="mt-1 flex justify-between text-[11px] text-gray-400">
        <span>{dayLabel(days[0].day, lang)}</span>
        <span>{dayLabel(days[days.length - 1].day, lang)}</span>
      </div>
    </div>
  );
}

const EVENT_DOT = { PERSONAL_SALE: "bg-amber-500", NETWORK_SALE: "bg-indigo-500", BRAND_SALE: "bg-orange-500" };

export function RecentActivity({ recent, asOf, t, lang }) {
  const items = Array.isArray(recent) ? recent : [];
  if (!items.length) return <p className="rounded-2xl bg-white p-4 text-center text-sm text-gray-500">{t("recent_empty")}</p>;
  return (
    <ul className="divide-y divide-gray-50 rounded-2xl border border-gray-100 bg-white shadow-sm">
      {items.map((e) => (
        <li key={`${e.type}-${e.at}-${e.quantity}-${e.earningsCents}`} className="flex items-center gap-3 px-3 py-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${EVENT_DOT[e.type] || "bg-gray-400"}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-900">{t(`event_${e.type}`)}</p>
            <p className="truncate text-xs text-gray-500">
              {t("event_qty", { n: formatCount(e.quantity, lang) })}
              {" · "}
              <time dateTime={String(e.at)}>{relativeTime(e.at, asOf, lang)}</time>
            </p>
          </div>
          <span className="shrink-0 text-sm font-bold text-emerald-700">
            <Money cents={e.earningsCents} lang={lang} prefix="+" />
          </span>
        </li>
      ))}
    </ul>
  );
}
