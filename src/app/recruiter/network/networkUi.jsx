"use client";
/**
 * src/app/recruiter/network/networkUi.jsx
 * Shared pieces of the recruiter network pages (Affiliate Recruiter System, Phase 4):
 * Arabic labels, the read-only API helper, the page header and small chips. Read only —
 * nothing here can change an affiliate, an order, a verification or a parent.
 */
import Link from "next/link";
import { ArrowRight, BarChart3, GitBranch } from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "../errorLabels";

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

/** 401 / 403 (disabled) → login page. Returns true when the caller must stop. */
export function handleAuth(result, router, setNotice) {
  if (result.status === 401) { router.replace("/recruiter/login"); return true; }
  if (result.status === 403 && result.code === "RECRUITER_DISABLED") {
    setNotice(recruiterErrorLabel(result.code));
    setTimeout(() => router.replace("/recruiter/login"), 2500);
    return true;
  }
  return false;
}

export function PageNotice({ text }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3" data-page-notice>{text}</p>
    </main>
  );
}

/** Page header: back to the dashboard + switch between the tree and the statistics. */
export function NetworkHeader({ title, current, root }) {
  const q = root ? `?root=${encodeURIComponent(root)}` : "";
  const tab = (key, href, label, Icon) => (
    <Link href={href} aria-current={current === key ? "page" : undefined} data-tab={key}
      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-semibold ${current === key ? "bg-emerald-600 text-white" : "text-slate-700 hover:bg-slate-100"}`}>
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      {label}
    </Link>
  );
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 min-w-0">
        <Link href="/recruiter" className="shrink-0 p-2 -m-2 rounded-lg text-slate-700 hover:bg-slate-100" aria-label="الرجوع للوحة" data-back>
          <ArrowRight className="w-5 h-5" aria-hidden="true" />
        </Link>
        <h1 className="text-base sm:text-lg font-bold truncate min-w-0 flex-1">{title}</h1>
        <nav aria-label="أقسام الشبكة" className="flex items-center gap-1 shrink-0">
          {tab("tree", `/recruiter/network${q}`, "الشجرة", GitBranch)}
          {tab("stats", `/recruiter/network/stats${q}`, "الإحصائيات", BarChart3)}
        </nav>
      </div>
    </header>
  );
}

/** Breadcrumb: "شبكتي" › ancestors… › current (from the API `path`, own network only). */
export function Breadcrumb({ path, base }) {
  return (
    <nav aria-label="مسار الشبكة" data-breadcrumb className="text-sm min-w-0">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0">
        <li><Link href={base} className="font-semibold text-emerald-700 hover:underline" data-breadcrumb-home>شبكتي</Link></li>
        {path.map((p, i) => (
          <li key={p.id ?? i} className="flex items-center gap-1.5 min-w-0">
            <span className="text-slate-400" aria-hidden="true">‹</span>
            {i === path.length - 1
              ? <span className="font-bold truncate max-w-[12rem]" aria-current="page">{p.name || p.username || "—"}</span>
              : <Link href={`${base}?root=${encodeURIComponent(p.id)}`} className="text-emerald-700 hover:underline truncate max-w-[10rem]" data-breadcrumb-item>{p.name || p.username || "—"}</Link>}
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
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${tones[tone] ?? tones.slate}`} {...rest}>{children}</span>;
}

export const identityTone = (s) => (s === "APPROVED" ? "green" : s === "PENDING" ? "amber" : s === "REJECTED" ? "red" : "slate");

export function ErrorBox({ code, onRetry }) {
  return (
    <div role="alert" data-error className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3">
      <span className="min-w-0">{code === "NOT_FOUND" ? recruiterErrorLabel("NOT_FOUND") : recruiterErrorLabel(code)}</span>
      {onRetry && code !== "NOT_FOUND" && (
        <button type="button" onClick={onRetry} className="shrink-0 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100" data-retry>إعادة المحاولة</button>
      )}
    </div>
  );
}

export const Loading = ({ label = "جارٍ التحميل…" }) => <p className="text-sm text-slate-500 py-3" aria-live="polite" data-loading>{label}</p>;

/** Phase 6 part 4: the admin turned off order visibility (canViewOrders) — the server sends orders: null. */
export const ORDERS_HIDDEN_TEXT = "عرض أرقام الطلبات معطّل لحسابك من طرف الإدارة. باقي معلومات الشبكة تبقى متاحة.";
export function OrdersHidden() {
  return (
    <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2" data-orders-hidden>{ORDERS_HIDDEN_TEXT}</p>
  );
}
