"use client";
/**
 * src/app/recruiter/network/networkUi.jsx
 * Shared pieces of the recruiter network pages (Affiliate Recruiter System, Phase 4):
 * Arabic labels, the read-only API helper, the page header and small chips. Read only —
 * nothing here can change an affiliate, an order, a verification or a parent.
 * Presentation: the recruiter app shell's visual system (`../_components/ui`) — the pages render
 * inside RecruiterShell (no own <header> / <main>).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BarChart3, GitBranch, ListChecks, Network, RefreshCw } from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { CenteredNotice, PageHeader, Tabs } from "../_components/ui";
import { recruiterErrorLabel } from "../errorLabels";
import { NETWORK_INVITED_HINT, authAction, nodeBadges, permsFromMe, progressDisplay } from "../recruiterUiState";

const NUM = new Intl.NumberFormat("ar-MA");
export const fmt = (n) => NUM.format(Number.isFinite(n) ? n : 0);

export const STATUS_LABEL = { ACTIVE: "مفعّل", INACTIVE: "غير مفعّل" };
export const IDENTITY_LABEL = { APPROVED: "مقبولة", PENDING: "قيد المراجعة", REJECTED: "مرفوضة", NONE: "غير مرسلة" };
export const IDENTITY_KEYS = ["APPROVED", "PENDING", "REJECTED", "NONE"];
/** Real order statuses, in display order (the existing order lifecycle — read only). */
export const ORDER_LABEL = {
  delivered: "تم التوصيل", pending: "قيد الانتظار", confirmed: "مؤكدة", shipped: "تم الشحن",
  cancelled: "ملغاة", returned: "مرتجعة", other: "أخرى",
};
export const ORDER_KEYS = ["delivered", "pending", "confirmed", "shipped", "cancelled", "returned", "other"];
export const FAKE_LABEL = "طلبات تجريبية (غير محتسبة)";

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
 */
export function handleAuth(result, router, setNotice) {
  const action = authAction(result.status, result.code);
  if (action === "login") { router.replace("/recruiter/login"); return true; }
  if (action === "disabled") {
    setNotice(recruiterErrorLabel(result.code));
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

/** A notice before the redirect (session ended, account disabled) — inside the shell, never a <main>. */
export function PageNotice({ text }) {
  return <CenteredNotice hook="data-page-notice">{text}</CenteredNotice>;
}

const HEADER = {
  tree: { Icon: Network, subtitle: "كل الأفلييت في شبكتك، فرعاً بفرع، مع حالتهم وتقدّمهم." },
  stats: { Icon: BarChart3, subtitle: "أرقام شبكتك الحقيقية: الأعضاء، التحقق من البطاقة والطلبات، حسب المستوى." },
};

/** Page header (PageHeader of the app shell): back to the dashboard + switch between the tree, the statistics and the list. */
export function NetworkHeader({ title, current, root }) {
  const q = root ? `?root=${encodeURIComponent(root)}` : "";
  const head = HEADER[current] ?? HEADER.tree;
  const tab = (key, href, label, Icon) => ({ key, href, label, Icon, attrs: { "data-tab": key, "aria-label": label, title: label } });
  return (
    <PageHeader Icon={head.Icon} title={title} subtitle={head.subtitle}>
      <Tabs label="أقسام الشبكة" current={current} items={[
        tab("tree", `/recruiter/network${q}`, "الشجرة", GitBranch),
        tab("stats", `/recruiter/network/stats${q}`, "الإحصائيات", BarChart3),
        tab("list", "/recruiter/affiliates", "القائمة", ListChecks),
      ]} />
    </PageHeader>
  );
}

/** Breadcrumb: "شبكتي" › ancestors… › current (from the API `path`, own network only). */
export function Breadcrumb({ path, base }) {
  return (
    <nav aria-label="مسار الشبكة" data-breadcrumb className="text-sm min-w-0 max-w-full">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0">
        <li><Link href={base} className="inline-flex items-center min-h-11 font-bold text-violet-700 hover:underline" data-breadcrumb-home>شبكتي</Link></li>
        {path.map((p, i) => (
          <li key={p.id ?? i} className="flex items-center gap-1.5 min-w-0">
            <span className="text-violet-300" aria-hidden="true">‹</span>
            {i === path.length - 1
              ? <span className="font-bold text-slate-900 truncate max-w-[12rem]" aria-current="page">{p.name || p.username || "—"}</span>
              : <Link href={`${base}?root=${encodeURIComponent(p.id)}`} className="block py-2.5 font-semibold text-violet-700 hover:underline truncate max-w-[10rem]" data-breadcrumb-item>{p.name || p.username || "—"}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Chip({ tone = "slate", children, ...rest }) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    slate: "bg-slate-50 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    sky: "bg-sky-50 text-sky-700 border-sky-200",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold whitespace-nowrap ${tones[tone] ?? tones.slate}`} {...rest}>{children}</span>;
}

export const identityTone = (s) => (s === "APPROVED" ? "green" : s === "PENDING" ? "amber" : s === "REJECTED" ? "red" : "slate");

export function ErrorBox({ code, onRetry }) {
  return (
    <div role="alert" data-error className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3">
      <span className="min-w-0">{code === "NOT_FOUND" ? recruiterErrorLabel("NOT_FOUND") : recruiterErrorLabel(code)}</span>
      {onRetry && code !== "NOT_FOUND" && (
        <button type="button" onClick={onRetry} data-retry
          className="shrink-0 inline-flex items-center gap-1.5 min-h-11 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
          <RefreshCw className="w-4 h-4" aria-hidden="true" /> إعادة المحاولة
        </button>
      )}
    </div>
  );
}

export const Loading = ({ label = "جارٍ التحميل…" }) => (
  <p className="flex items-center gap-2 text-sm text-slate-500 py-3" aria-live="polite" data-loading>
    <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" aria-hidden="true" />
    {label}
  </p>
);

/**
 * One figure of the network pages as a <dt>/<dd> pair (inside a <dl>), styled like the shell's StatTile;
 * `attrs` (data-* hooks) stay on the value (<dd>). Tones: violet (default), green (success), amber (warning).
 */
export function FigureTile({ label, value, attrs = {}, tone = "violet" }) {
  const bg = { violet: "bg-violet-50/70", green: "bg-emerald-50/70", amber: "bg-amber-50/80", slate: "bg-slate-50" }[tone] ?? "bg-violet-50/70";
  return (
    <div className={`rounded-2xl ${bg} border border-white px-4 py-3 min-w-0`}>
      <dt className="text-xs font-semibold text-slate-500 leading-tight">{label}</dt>
      <dd className="mt-1 text-xl font-extrabold text-slate-900 break-words" {...attrs}>{fmt(value)}</dd>
    </div>
  );
}

/** Phase 6 part 4: the admin turned off order visibility (canViewOrders) — the server sends orders: null. */
export const ORDERS_HIDDEN_TEXT = "عرض أرقام الطلبات معطّل لحسابك من طرف الإدارة. باقي معلومات الشبكة تبقى متاحة.";
export function OrdersHidden() {
  return (
    <p className="text-xs leading-relaxed text-slate-700 bg-violet-50/50 border border-violet-100 rounded-2xl px-3.5 py-2.5" data-orders-hidden>{ORDERS_HIDDEN_TEXT}</p>
  );
}

/**
 * Phase 7 Stage C: "x / T مبيعات" of one affiliate (its own real delivered orders vs the individual
 * threshold). Nothing at all when the count is withheld (canViewOrders off) — never a zero.
 */
export function ProgressBar({ progress }) {
  const p = progressDisplay(progress);
  if (!p) return null;
  return (
    <div className="min-w-0 space-y-1" data-progress={p.threshold ? `${p.delivered}/${p.threshold}` : `${p.delivered}`}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-slate-500">المبيعات الحقيقية المسلّمة</span>
        <span className={`font-bold ${p.reached ? "text-emerald-700" : "text-slate-700"}`} data-progress-text><bdi dir="ltr">{p.ratio}</bdi> مبيعات</span>
      </div>
      {p.threshold && (
        <div className="h-1.5 w-full rounded-full bg-violet-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={p.threshold}
          aria-valuenow={Math.min(p.delivered, p.threshold)} aria-label="التقدّم نحو المكافأة">
          <div className={`h-full rounded-full ${p.reached ? "bg-emerald-500" : "bg-gradient-to-l from-violet-500 to-indigo-500"}`} style={{ width: `${p.pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** "مدعو عبر الشبكة" (information, Stage E) and the qualified / reward state badges of a network member. */
export function NodeBadges({ node }) {
  const badges = nodeBadges(node);
  if (!badges.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-node-badges>
      {badges.map((b) => (
        <Chip key={b.key} tone={b.tone} data-badge={b.key} title={b.key === "invited" ? NETWORK_INVITED_HINT : undefined}>{b.label}</Chip>
      ))}
    </div>
  );
}
