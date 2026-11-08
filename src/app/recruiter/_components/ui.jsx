"use client";
/**
 * src/app/recruiter/_components/ui.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The recruiter area's ONE visual system — the AFFILIATE dashboard's look (src/app/affiliate/dashboard/page.jsx:
 * gray-50 page, white rounded-2xl cards with a gray-100 border and no heavy shadow, gray-900 active pills, violet
 * accent, Rubik, touch targets ≥ 44 px). Every authenticated recruiter page is rendered inside RecruiterShell
 * (sidebar / header / bottom bar / "المزيد" sheet) and builds its content from these primitives — no per-page
 * design system. Presentation only: no fetch, no data, no business rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import Link from "next/link";
import { ArrowRight, Info, RefreshCw } from "lucide-react";
import { recruiterErrorLabel } from "../errorLabels";

/** Class tokens (Tailwind) shared by every recruiter page. */
export const ui = {
  card: "bg-white rounded-2xl border border-gray-100 min-w-0",
  cardPad: "p-4 sm:p-5",
  /** Soft inner panel (inside a card). */
  panel: "rounded-xl border border-gray-100 bg-gray-50",
  btnPrimary: "inline-flex items-center justify-center gap-2 min-h-11 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 active:scale-[0.98] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-60 disabled:cursor-not-allowed",
  btnSecondary: "inline-flex items-center justify-center gap-2 min-h-11 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-60 disabled:cursor-not-allowed",
  btnDanger: "inline-flex items-center justify-center gap-2 min-h-11 rounded-xl bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-100 disabled:opacity-60 disabled:cursor-not-allowed",
  /** Text fields, selects, textareas. */
  input: "w-full min-h-11 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-base sm:text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 disabled:opacity-60",
  label: "block text-sm font-semibold text-gray-700 mb-1.5",
  hint: "text-xs text-gray-500 leading-relaxed",
  link: "font-semibold text-violet-600 hover:underline",
  /** Table wrapper (horizontal scroll INSIDE the card, never the page). */
  tableWrap: "overflow-x-auto max-w-full rounded-xl border border-gray-100",
  th: "text-start text-xs font-semibold text-gray-500 bg-gray-50 px-3 py-2.5 whitespace-nowrap",
  td: "px-3 py-2.5 text-sm text-gray-700",
};

const TONES = {
  violet: "bg-violet-50 text-violet-600 border-violet-100",
  green: "bg-green-50 text-green-700 border-green-100",
  amber: "bg-amber-50 text-amber-700 border-amber-100",
  red: "bg-red-50 text-red-600 border-red-100",
  sky: "bg-blue-50 text-blue-600 border-blue-100",
  slate: "bg-gray-100 text-gray-600 border-gray-200",
};
/** Small rounded status badge. */
export function Badge({ tone = "slate", className = "", children, ...rest }) {
  return <span className={`inline-flex items-center gap-1 shrink-0 text-xs font-bold rounded-full border px-2.5 py-1 ${TONES[tone] ?? TONES.slate} ${className}`} {...rest}>{children}</span>;
}

/** White card with the area's radius, border and soft violet shadow. */
export function Card({ className = "", children, ...rest }) {
  return <section className={`${ui.card} ${className}`} {...rest}>{children}</section>;
}

export function CardTitle({ Icon, tone = "text-gray-400", title, id, aside }) {
  return (
    <div className="flex items-start justify-between gap-3 min-w-0">
      <h2 id={id} className="flex items-center gap-2 text-sm font-bold text-gray-700 min-w-0">
        {Icon && <Icon className={`w-4 h-4 shrink-0 ${tone}`} aria-hidden="true" />}
        <span className="min-w-0">{title}</span>
      </h2>
      {aside}
    </div>
  );
}

/**
 * Page title block inside the shell: back button (to the dashboard by default, keeps `data-back`),
 * icon tile, h1 title, subtitle, optional actions (rendered ONCE: beside the title from sm, under it on a
 * phone) and an optional row under it (tabs, filters).
 */
export function PageHeader({ Icon, title, subtitle, back = { href: "/recruiter", label: "الرجوع للوحة" }, actions, children }) {
  return (
    <div className="flex flex-col gap-4 min-w-0" data-page-header>
      <div className="flex flex-wrap sm:flex-nowrap items-start gap-3 min-w-0">
        {back && (
          <Link href={back.href} aria-label={back.label} title={back.label} data-back
            className="grid place-items-center w-11 h-11 shrink-0 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400">
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
        )}
        {Icon && (
          <span className="hidden sm:grid place-items-center w-11 h-11 shrink-0 rounded-xl bg-violet-50 text-violet-600" aria-hidden="true">
            <Icon className="w-5 h-5" />
          </span>
        )}
        <div className="min-w-0 flex-1 basis-0 pt-1">
          <h1 className="text-lg sm:text-xl font-bold text-gray-900 leading-tight break-words">{title}</h1>
          {subtitle && <p className="mt-1 text-xs sm:text-sm text-gray-500 leading-relaxed">{subtitle}</p>}
        </div>
        {actions && <div className="w-full sm:w-auto flex flex-wrap items-center gap-2 sm:shrink-0" data-page-actions>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * Segmented tabs (links) — items: [{ key, href, label, Icon, attrs }]. The current tab carries
 * aria-current="page"; on a phone the other tabs keep their label (scrolls inside its own row).
 */
export function Tabs({ items, current, label }) {
  return (
    <nav aria-label={label} className="max-w-full overflow-x-auto">
      <div className="flex gap-1.5 pb-1">
        {items.map(({ key, href, label: l, Icon, attrs = {} }) => (
          <Link key={key} href={href} aria-current={current === key ? "page" : undefined} {...attrs}
            className={`inline-flex items-center gap-1.5 min-h-10 whitespace-nowrap px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
              current === key ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-600 hover:border-gray-400"}`}>
            {Icon && <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />}
            <span>{l}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** One figure (label, value, optional sub-line); `hook` adds a data-* attribute on the value. */
export function StatTile({ label, value, sub, tone = "violet", hook, attrs = {} }) {
  const bg = { violet: "bg-violet-50", green: "bg-green-50", amber: "bg-amber-50", red: "bg-red-50", sky: "bg-blue-50", slate: "bg-gray-50" }[tone] ?? "bg-gray-50";
  return (
    <div className={`rounded-xl ${bg} px-3.5 py-3 min-w-0`} {...attrs}>
      <p className="text-xs text-gray-500 leading-tight">{label}</p>
      <p className="mt-1 text-lg font-bold text-gray-900 leading-none break-words" {...(hook ? { [`data-${hook}`]: "" } : {})}>{value}</p>
      {sub && <p className="mt-1 text-[11px] text-gray-400 leading-tight">{sub}</p>}
    </div>
  );
}

/** The affiliate dashboard's colours of a stat icon tile (bg-*-50 text-*-600). */
const STAT_COLORS = {
  gray: "bg-gray-100 text-gray-700", blue: "bg-blue-50 text-blue-600", green: "bg-green-50 text-green-600",
  purple: "bg-purple-50 text-purple-600", red: "bg-red-50 text-red-600", amber: "bg-amber-50 text-amber-600", teal: "bg-teal-50 text-teal-600",
};
/** The affiliate dashboard's StatCard: icon tile, number, label, optional sub-line; `hook` → data-* on the value. */
export function StatCard({ Icon, label, value, sub, color = "gray", hook, valueLtr = false }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2.5 min-w-0" {...(hook ? { "data-stat": hook } : {})}>
      <span className={`w-9 h-9 rounded-xl flex items-center justify-center ${STAT_COLORS[color] ?? STAT_COLORS.gray}`}>
        <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-lg sm:text-xl font-bold text-gray-900 leading-tight break-words" dir={valueLtr ? "ltr" : undefined} style={valueLtr ? { textAlign: "right" } : undefined}
          {...(hook ? { [`data-${hook}`]: "" } : {})}>{value}</p>
        <p className="text-xs text-gray-500 mt-1">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

/** The affiliate dashboard's Section: white card with a light title strip. */
export function Section({ Icon, title, aside, children, className = "", bodyClass = "p-4 sm:p-5", ...rest }) {
  return (
    <section className={`bg-white rounded-2xl border border-gray-100 overflow-hidden min-w-0 ${className}`} {...rest}>
      <div className="px-4 sm:px-5 py-3.5 border-b border-gray-50 bg-gray-50/60 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold text-gray-700 min-w-0">
          {Icon && <Icon className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />}
          <span className="min-w-0 truncate">{title}</span>
        </h2>
        {aside}
      </div>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function EmptyState({ Icon = Info, text, hook = "", children }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-sm text-gray-500" data-empty-state={hook}>
      <Icon className="w-7 h-7 text-gray-300" aria-hidden="true" />
      <p className="max-w-xs">{text}</p>
      {children}
    </div>
  );
}

export function RetryError({ code, onRetry, hook = "" }) {
  return (
    <div role="alert" className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3" data-error={hook}>
      <span className="min-w-0">{recruiterErrorLabel(code)}</span>
      <button type="button" onClick={onRetry} data-retry={hook}
        className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
        <RefreshCw className="w-4 h-4" aria-hidden="true" /> إعادة المحاولة
      </button>
    </div>
  );
}

/** A full-width notice inside the shell (session ended, account disabled…) — never a nested <main>. */
export function CenteredNotice({ children, hook = "data-page-notice" }) {
  return (
    <div className="py-16 flex items-center justify-center">
      <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3" {...{ [hook]: "" }}>{children}</p>
    </div>
  );
}

/** Loading line (screen-reader friendly) with a soft skeleton block. */
export function LoadingBlock({ label = "جارٍ التحميل…", hook = "data-loading" }) {
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="text-sm text-gray-500" {...{ [hook]: "" }}>{label}</p>
      <div className="h-24 rounded-2xl bg-white border border-gray-100 animate-pulse" aria-hidden="true" />
    </div>
  );
}
