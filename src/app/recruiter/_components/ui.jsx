"use client";
/**
 * src/app/recruiter/_components/ui.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The recruiter area's ONE visual system (Ecome Agency — purple / deep indigo, white and soft lavender,
 * rounded 3xl cards, soft violet shadows, touch targets ≥ 44 px). Every authenticated recruiter page is
 * rendered inside RecruiterShell (sidebar / header / drawer / bottom bar) and builds its content from
 * these primitives — no per-page design system. Presentation only: no fetch, no data, no business rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import Link from "next/link";
import { ArrowRight, Info, RefreshCw } from "lucide-react";
import { recruiterErrorLabel } from "../errorLabels";

/** Class tokens (Tailwind) shared by every recruiter page. */
export const ui = {
  card: "bg-white rounded-3xl border border-violet-100/80 shadow-[0_10px_30px_-12px_rgba(76,29,149,0.18)] min-w-0",
  cardPad: "p-5 sm:p-6",
  /** Soft inner panel (inside a card). */
  panel: "rounded-2xl border border-violet-100 bg-violet-50/50",
  btnPrimary: "inline-flex items-center justify-center gap-2 min-h-11 rounded-2xl bg-gradient-to-l from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-violet-500/25 hover:from-violet-700 hover:to-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-60 disabled:cursor-not-allowed",
  btnSecondary: "inline-flex items-center justify-center gap-2 min-h-11 rounded-2xl border border-violet-200 bg-white px-4 py-2.5 text-sm font-bold text-violet-700 hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:opacity-60 disabled:cursor-not-allowed",
  btnDanger: "inline-flex items-center justify-center gap-2 min-h-11 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700 hover:bg-red-100 disabled:opacity-60 disabled:cursor-not-allowed",
  /** Text fields, selects, textareas. */
  input: "w-full min-h-11 rounded-2xl border border-violet-100 bg-violet-50/40 px-3.5 py-2.5 text-base sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-violet-400 focus:bg-white focus:ring-2 focus:ring-violet-200 disabled:opacity-60",
  label: "block text-sm font-semibold text-slate-700 mb-1.5",
  hint: "text-xs text-slate-500 leading-relaxed",
  link: "font-semibold text-violet-700 hover:underline",
  /** Table wrapper (horizontal scroll INSIDE the card, never the page). */
  tableWrap: "overflow-x-auto max-w-full rounded-2xl border border-violet-100",
  th: "text-start text-xs font-semibold text-slate-500 bg-violet-50/60 px-3 py-2.5 whitespace-nowrap",
  td: "px-3 py-2.5 text-sm text-slate-700",
};

const TONES = {
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  slate: "bg-slate-50 text-slate-600 border-slate-200",
};
/** Small rounded status badge. */
export function Badge({ tone = "slate", className = "", children, ...rest }) {
  return <span className={`inline-flex items-center gap-1 shrink-0 text-xs font-bold rounded-full border px-2.5 py-1 ${TONES[tone] ?? TONES.slate} ${className}`} {...rest}>{children}</span>;
}

/** White card with the area's radius, border and soft violet shadow. */
export function Card({ className = "", children, ...rest }) {
  return <section className={`${ui.card} ${className}`} {...rest}>{children}</section>;
}

export function CardTitle({ Icon, tone = "text-violet-600", title, id, aside }) {
  return (
    <div className="flex items-start justify-between gap-3 min-w-0">
      <h2 id={id} className="flex items-center gap-2 text-base sm:text-lg font-extrabold text-slate-900 min-w-0">
        {Icon && <Icon className={`w-6 h-6 shrink-0 ${tone}`} aria-hidden="true" />}
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
            className="grid place-items-center w-11 h-11 shrink-0 rounded-2xl bg-white border border-violet-100 shadow-sm text-slate-700 hover:bg-violet-50">
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
        )}
        {Icon && (
          <span className="hidden sm:grid place-items-center w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-md shadow-violet-500/30" aria-hidden="true">
            <Icon className="w-6 h-6" />
          </span>
        )}
        <div className="min-w-0 flex-1 basis-0 pt-0.5">
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 leading-tight break-words">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500 leading-relaxed">{subtitle}</p>}
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
      <div className="inline-flex items-center gap-1 rounded-2xl bg-white border border-violet-100 p-1 shadow-sm">
        {items.map(({ key, href, label: l, Icon, attrs = {} }) => (
          <Link key={key} href={href} aria-current={current === key ? "page" : undefined} {...attrs}
            className={`inline-flex items-center gap-1.5 min-h-10 rounded-xl px-3 py-2 text-sm font-bold whitespace-nowrap ${
              current === key ? "bg-gradient-to-l from-violet-600 to-indigo-600 text-white shadow" : "text-slate-600 hover:bg-violet-50"}`}>
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
  const bg = { violet: "bg-violet-50/70", green: "bg-emerald-50/70", amber: "bg-amber-50/70", red: "bg-rose-50/70", sky: "bg-sky-50/70", slate: "bg-slate-50" }[tone] ?? "bg-violet-50/70";
  return (
    <div className={`rounded-2xl ${bg} border border-white px-4 py-3 min-w-0`} {...attrs}>
      <p className="text-xs font-semibold text-slate-500 leading-tight">{label}</p>
      <p className="mt-1 text-xl font-extrabold text-slate-900 break-words" {...(hook ? { [`data-${hook}`]: "" } : {})}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-500 leading-tight">{sub}</p>}
    </div>
  );
}

export function EmptyState({ Icon = Info, text, hook = "", children }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 rounded-2xl border border-dashed border-violet-200 bg-violet-50/40 px-4 py-8 text-sm text-slate-500" data-empty-state={hook}>
      <Icon className="w-7 h-7 text-violet-300" aria-hidden="true" />
      <p className="max-w-xs">{text}</p>
      {children}
    </div>
  );
}

export function RetryError({ code, onRetry, hook = "" }) {
  return (
    <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3" data-error={hook}>
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
      <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-2xl px-4 py-3" {...{ [hook]: "" }}>{children}</p>
    </div>
  );
}

/** Loading line (screen-reader friendly) with a soft skeleton block. */
export function LoadingBlock({ label = "جارٍ التحميل…", hook = "data-loading" }) {
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="text-sm text-slate-500" {...{ [hook]: "" }}>{label}</p>
      <div className="h-24 rounded-3xl bg-white border border-violet-100 animate-pulse" aria-hidden="true" />
    </div>
  );
}
