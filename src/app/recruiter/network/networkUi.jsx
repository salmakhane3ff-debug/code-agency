"use client";
/**
 * src/app/recruiter/network/networkUi.jsx
 * Shared pieces of the recruiter network pages (Affiliate Recruiter System, Phase 4):
 * label KEYS (texts in RECRUITER_TEXT, market language), the read-only API helper, the page header and small chips. Read only —
 * nothing here can change an affiliate, an order, a verification or a parent.
 * Presentation: the recruiter app shell's visual system (`../_components/ui`) — the pages render
 * inside RecruiterShell (no own <header> / <main>).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BarChart3, Network, RefreshCw, Users } from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { CenteredNotice, PageHeader, ui, useRecruiterLocale } from "../_components/ui";
import { recruiterErrorLabel } from "../errorLabels";
import { authAction, networkInvitedHint, nodeBadges, permsFromMe, progressDisplay } from "../recruiterUiState";

const NUM = new Map();
/** Integer → the market's number format (intlLocale of useRecruiterLocale: 'ar-MA' default | 'fr-MA'). */
export const fmt = (n, locale = "ar-MA") => {
  if (!NUM.has(locale)) NUM.set(locale, new Intl.NumberFormat(locale));
  return NUM.get(locale).format(Number.isFinite(n) ? n : 0);
};

/** Dictionary keys (RECRUITER_TEXT) of the statuses — the texts follow the market language. */
export const STATUS_KEY = { ACTIVE: "status_active", INACTIVE: "status_inactive" };
export const IDENTITY_KEY = { APPROVED: "identity_approved", PENDING: "identity_pending", REJECTED: "identity_rejected", NONE: "identity_none" };
export const IDENTITY_KEYS = ["APPROVED", "PENDING", "REJECTED", "NONE"];
/** Real order statuses, in display order (the existing order lifecycle — read only). */
export const ORDER_KEY = {
  delivered: "order_delivered", pending: "order_pending", confirmed: "order_confirmed", shipped: "order_shipped",
  cancelled: "order_cancelled", returned: "order_returned", other: "order_other",
};
export const ORDER_KEYS = ["delivered", "pending", "confirmed", "shipped", "cancelled", "returned", "other"];

/**
 * GET a recruiter API → { ok, status, body, code }. Never throws; only the error CODE is
 * kept (allowlisted by toRecruiterError), never any server text.
 */
export async function getJson(url) {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (res.ok) return { ok: true, status: res.status, body, code: null };
    return { ok: false, status: res.status, body: null, code: toRecruiterError(body).code };
  } catch {
    return { ok: false, status: 0, body: null, code: "SERVER_ERROR" };
  }
}

/**
 * ONLY 401 → login page; 403 RECRUITER_DISABLED → notice then login. Returns true when the caller
 * must stop. Anything else (5xx, 429, network) stays on the page as an error with a retry button.
 * The notice state receives the error CODE (rendered by PageNotice in the current market language).
 */
export function handleAuth(result, router, setNotice) {
  const action = authAction(result.status, result.code);
  if (action === "login") { router.replace("/recruiter/login"); return true; }
  if (action === "disabled") {
    setNotice(result.code);
    setTimeout(() => router.replace("/recruiter/login"), 2500);
    return true;
  }
  return false;
}

/**
 * The recruiter's permissions (GET /api/recruiter/me) for the network / affiliates pages: creation
 * actions stay hidden until the server said canCreateAffiliates = true. A failed check (not 401)
 * keeps the page usable and shows an error with a retry.
 */
export function useRecruiterPerms(router, setNotice) {
  const [perms, setPerms] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    setError(null);
    const r = await getJson("/api/recruiter/me");
    if (!alive.current) return;
    if (handleAuth(r, router, setNotice)) return;
    if (!r.ok) { setError(r.code); return; }
    setPerms(permsFromMe(r.body));
  }, [router, setNotice]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);
  return { perms, permsError: error, retryPerms: load, canCreate: perms?.canCreateAffiliates === true };
}

/** A notice before the redirect (session ended, account disabled: the error `code`) — inside the shell, never a <main>. */
export function PageNotice({ code }) {
  const { lang } = useRecruiterLocale();
  return <CenteredNotice hook="data-page-notice">{recruiterErrorLabel(code, lang)}</CenteredNotice>;
}

/**
 * Page header (PageHeader of the app shell): back to the dashboard + one link to the affiliates list
 * (the tree view now lives there: /recruiter/affiliates?id=<root>).
 */
export function NetworkHeader({ title, current, root }) {
  const { t } = useRecruiterLocale();
  const href = root ? `/recruiter/affiliates?id=${encodeURIComponent(root)}` : "/recruiter/affiliates";
  return (
    <PageHeader Icon={current === "stats" ? BarChart3 : Network} title={title}
      actions={<Link href={href} className={ui.btnSecondary} data-affiliates-link><Users className="w-4 h-4" aria-hidden="true" />{t("net_show_affiliates")}</Link>} />
  );
}

/** Breadcrumb: "شبكتي" › ancestors… › current (from the API `path`, own network only); the separator points to the end side. */
export function Breadcrumb({ path, base }) {
  const { t, dir } = useRecruiterLocale();
  return (
    <nav aria-label={t("net_path")} data-breadcrumb className="text-sm min-w-0 max-w-full">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0">
        <li><Link href={base} className="inline-flex items-center min-h-11 font-semibold text-violet-600 hover:underline" data-breadcrumb-home>{t("net_my_network")}</Link></li>
        {path.map((p, i) => (
          <li key={p.id ?? i} className="flex items-center gap-1.5 min-w-0">
            <span className="text-gray-300" aria-hidden="true">{dir === "rtl" ? "‹" : "›"}</span>
            {i === path.length - 1
              ? <span className="font-bold text-gray-900 truncate max-w-[12rem]" aria-current="page">{p.name || p.username || "—"}</span>
              : <Link href={`${base}?root=${encodeURIComponent(p.id)}`} className="block py-2.5 font-semibold text-violet-600 hover:underline truncate max-w-[10rem]" data-breadcrumb-item>{p.name || p.username || "—"}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Chip({ tone = "slate", children, ...rest }) {
  const tones = {
    green: "bg-green-50 text-green-700 border-green-100",
    red: "bg-red-50 text-red-600 border-red-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
    slate: "bg-gray-100 text-gray-600 border-gray-200",
    violet: "bg-violet-50 text-violet-600 border-violet-100",
    sky: "bg-blue-50 text-blue-600 border-blue-100",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold whitespace-nowrap ${tones[tone] ?? tones.slate}`} {...rest}>{children}</span>;
}

export const identityTone = (s) => (s === "APPROVED" ? "green" : s === "PENDING" ? "amber" : s === "REJECTED" ? "red" : "slate");

export function ErrorBox({ code, onRetry }) {
  const { t, lang } = useRecruiterLocale();
  return (
    <div role="alert" data-error className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3">
      <span className="min-w-0">{code === "NOT_FOUND" ? recruiterErrorLabel("NOT_FOUND", lang) : recruiterErrorLabel(code, lang)}</span>
      {onRetry && code !== "NOT_FOUND" && (
        <button type="button" onClick={onRetry} data-retry
          className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
          <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t("common_retry")}
        </button>
      )}
    </div>
  );
}

export function Loading({ label }) {
  const { t } = useRecruiterLocale();
  return (
    <p className="flex items-center gap-2 text-sm text-gray-500 py-3" aria-live="polite" data-loading>
      <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" aria-hidden="true" />
      {label ?? t("common_loading")}
    </p>
  );
}

/**
 * One figure of the network pages as a <dt>/<dd> pair (inside a <dl>), the shell's StatTile look;
 * `attrs` (data-* hooks) stay on the value (<dd>). Tones: violet / slate (neutral gray, default look), green, amber.
 */
export function FigureTile({ label, value, attrs = {}, tone = "violet" }) {
  const { intlLocale } = useRecruiterLocale();
  const bg = { green: "bg-green-50", amber: "bg-amber-50" }[tone] ?? "bg-gray-50";
  return (
    <div className={`rounded-xl ${bg} px-3.5 py-3 min-w-0`}>
      <dt className="text-xs text-gray-500 leading-tight">{label}</dt>
      <dd className="mt-1 text-lg font-bold text-gray-900 leading-none break-words" {...attrs}>{fmt(value, intlLocale)}</dd>
    </div>
  );
}

/** Phase 6 part 4: the admin turned off order visibility (canViewOrders) — the server sends orders: null. */
export function OrdersHidden() {
  const { t } = useRecruiterLocale();
  return (
    <p className={`${ui.panel} px-3.5 py-2.5 text-xs leading-relaxed text-gray-600`} data-orders-hidden>{t("net_orders_hidden")}</p>
  );
}

/**
 * Phase 7 Stage C: "x / T مبيعات" of one affiliate (its own real delivered orders vs the individual
 * threshold). Nothing at all when the count is withheld (canViewOrders off) — never a zero.
 */
export function ProgressBar({ progress }) {
  const { t, lang } = useRecruiterLocale();
  const p = progressDisplay(progress, lang);
  if (!p) return null;
  return (
    <div className="min-w-0 space-y-1" data-progress={p.threshold ? `${p.delivered}/${p.threshold}` : `${p.delivered}`}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-gray-500">{t("net_real_delivered_sales")}</span>
        <span className={`font-bold ${p.reached ? "text-green-700" : "text-gray-700"}`} data-progress-text><bdi dir="ltr">{p.ratio}</bdi> {t("net_sales")}</span>
      </div>
      {p.threshold && (
        <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={p.threshold}
          aria-valuenow={Math.min(p.delivered, p.threshold)} aria-label={t("net_progress_aria")}>
          <div className={`h-full rounded-full ${p.reached ? "bg-green-500" : "bg-violet-500"}`} style={{ width: `${p.pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** "مدعو عبر الشبكة" (information, Stage E) and the qualified / reward state badges of a network member. */
export function NodeBadges({ node }) {
  const { lang } = useRecruiterLocale();
  const badges = nodeBadges(node, lang);
  if (!badges.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-node-badges>
      {badges.map((b) => (
        <Chip key={b.key} tone={b.tone} data-badge={b.key} title={b.key === "invited" ? networkInvitedHint(lang) : undefined}>{b.label}</Chip>
      ))}
    </div>
  );
}
