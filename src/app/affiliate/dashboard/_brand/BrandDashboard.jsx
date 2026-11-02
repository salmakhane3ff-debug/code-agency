"use client";

/**
 * 🏪 Create Your Own Brand — affiliate dashboard of an ACTIVE or CLOSED brand
 * (mobile first, one scrolling page). Used only by ../BrandTab.jsx, which loads
 * the data (brand + simulated dashboard APIs) and refreshes it; this file only
 * presents it:
 *
 *   hero (title, simulator chips, brand identity) · disclaimer / closed notice
 *   · analyses (24 h / 7 j / 30 j, four counts, chart) · latest simulated
 *   orders (tap → details) · training pack (price + selected products' images)
 *
 * Every figure comes from the APIs. Simulated orders carry no amount, so no
 * revenue, profit or gain is shown anywhere; the pack card is the price paid
 * for the training, never earnings. Stock and availability are not shown.
 */

import { useEffect, useState } from "react";
import {
  BarChart3, ShoppingCart, Truck, XCircle, Clock, CheckCircle, Undo2, Ban, ChevronRight, ChevronLeft,
  Zap, GraduationCap, ShoppingBag, Package, Info, PauseCircle, X, Store, Route,
} from "lucide-react";
import { SimulatedBadge, LineChart, STATUS_COLOR } from "@/components/brand/BrandSimStats";
import { SIM_WINDOWS } from "@/lib/brandSimulation";
import { displayBreakdown } from "@/lib/brandPricing";
import { dashboardT } from "./dashboardText";

const CARD = "bg-white rounded-3xl border border-violet-100/70 shadow-[0_4px_18px_rgba(124,58,237,0.07)]";

/** One style per simulated status: purple / green / orange / red identity. */
const ORDER_STATUS = {
  pending:    { Icon: Clock,       cls: "bg-gray-100 text-gray-700" },
  confirmed:  { Icon: CheckCircle, cls: "bg-violet-50 text-violet-700" },
  inDelivery: { Icon: Route,       cls: "bg-sky-50 text-sky-700" },
  delivered:  { Icon: Truck,       cls: "bg-emerald-50 text-emerald-700" },
  refused:    { Icon: XCircle,     cls: "bg-red-50 text-red-600" },
  returned:   { Icon: Undo2,       cls: "bg-orange-50 text-orange-600" },
  noResponse: { Icon: Clock,       cls: "bg-amber-50 text-amber-700" },
  cancelled:  { Icon: Ban,         cls: "bg-gray-100 text-gray-600" },
};

function Thumb({ src, className = "" }) {
  return (
    <div className={`bg-gray-50 flex items-center justify-center overflow-hidden shrink-0 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" /> : <Package className="w-5 h-5 text-gray-300" aria-hidden="true" />}
    </div>
  );
}

function SectionTitle({ Icon, children, extra }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 mb-3">
      <h3 className="flex items-center gap-2 text-base sm:text-lg font-black text-gray-900 whitespace-nowrap">
        <span className="w-8 h-8 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0"><Icon className="w-[18px] h-[18px]" aria-hidden="true" /></span>
        <span>{children}</span>
      </h3>
      {extra}
    </div>
  );
}

function StatusChip({ status, d, small = false }) {
  const s = ORDER_STATUS[status] || ORDER_STATUS.pending;
  return (
    // Small badges are capped (112 px) so a long label ("En cours de livraison") wraps instead of covering the row's time.
    <span className={`inline-flex items-center gap-1 rounded-xl font-bold ${small ? "px-2 py-1 text-[11px] leading-tight max-w-[112px]" : "px-2.5 py-1.5 text-xs whitespace-nowrap"} ${s.cls}`}>
      <s.Icon className={`shrink-0 ${small ? "w-3.5 h-3.5" : "w-4 h-4"}`} aria-hidden="true" />{d(`order_status_${status}`)}
    </span>
  );
}

/** "il y a 7 min" — from the order's own time, in the page language. */
function useRelativeTime(locale) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  return (iso) => {
    const s = Math.round((new Date(iso).getTime() - now) / 1000);
    const a = Math.abs(s);
    if (a < 60) return rtf.format(0, "minute");
    if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
    return rtf.format(Math.round(s / 86400), "day");
  };
}

/** B — purple hero: title, simulator chips, then the brand's identity and status. */
function Hero({ access, t, d, closed }) {
  const letter = (access.brandName || "?").trim().charAt(0).toUpperCase();
  const chips = [
    { key: "hero_no_stock", Icon: Zap, icon: "text-amber-500" },
    { key: "hero_training", Icon: GraduationCap, icon: "text-violet-600" },
  ];
  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-violet-700 via-violet-600 to-fuchsia-500 text-white p-4 sm:p-6 shadow-lg shadow-violet-200" data-brand-hero>
      <div aria-hidden="true" className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
      <div aria-hidden="true" className="absolute -bottom-12 end-16 w-28 h-28 rounded-full bg-fuchsia-300/20" />
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-xl sm:text-2xl font-black leading-tight">
            <Store className="w-6 h-6 shrink-0" aria-hidden="true" />{d("hero_title")}
          </h2>
          <p className="text-[13px] sm:text-sm text-violet-50/90 mt-1 leading-snug">{d("hero_subtitle")}</p>
        </div>
        <div aria-hidden="true" className="relative w-16 h-16 sm:w-20 sm:h-20 shrink-0">
          <span className="absolute inset-0 rounded-2xl bg-white/15 rotate-6" />
          <span className="absolute inset-0 rounded-2xl bg-white/20 flex items-center justify-center"><ShoppingBag className="w-9 h-9 sm:w-11 sm:h-11 text-white" /></span>
          <span className="absolute -bottom-1.5 -start-1.5 w-7 h-7 rounded-lg bg-amber-400 flex items-center justify-center shadow"><Package className="w-4 h-4 text-amber-900" /></span>
        </div>
      </div>

      <ul className="relative grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
        {chips.map(({ key, Icon, icon }) => (
          <li key={key} className="flex items-center gap-1.5 rounded-2xl bg-white text-gray-900 px-2.5 py-2 text-[12px] font-bold leading-tight shadow-sm min-w-0">
            <Icon className={`w-4 h-4 shrink-0 ${icon}`} aria-hidden="true" /><span className="min-w-0">{d(key)}</span>
          </li>
        ))}
      </ul>

      <div className="relative mt-3 flex items-center gap-3 rounded-2xl bg-white/15 backdrop-blur-sm px-3 py-2.5" data-brand-header>
        <div className="w-10 h-10 rounded-full bg-gray-950 ring-2 ring-amber-400/80 flex items-center justify-center shrink-0" aria-hidden="true">
          <span className="text-lg font-black text-amber-400 font-serif">{letter}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p dir="auto" className="text-sm font-black truncate">{access.brandName}</p>
          <p dir="auto" className="text-[11px] text-violet-50/85 truncate">{access.package?.name}{access.branding?.label ? ` · ${access.branding.label}` : ""}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`px-2 py-0.5 rounded-lg text-[11px] font-bold ${closed ? "bg-slate-100 text-slate-700" : "bg-emerald-100 text-emerald-800"}`}>{t(closed ? "chip_closed" : "chip_active")}</span>
        </div>
      </div>
    </section>
  );
}

/** C — period pills, the four real counts and the orders chart. */
function Analyses({ stats, windowKey, onWindow, t, d, locale, loading }) {
  const n = (v) => Number(v || 0).toLocaleString(locale);
  const kpis = [
    { key: "total", value: stats?.total, label: t("sum_total"), Icon: ShoppingCart, cls: "bg-white", icon: "bg-violet-100 text-violet-600", num: "text-gray-900" },
    { key: "delivered", value: stats?.byStatus?.delivered, label: t("sum_delivered"), Icon: Truck, cls: "bg-emerald-50/70", icon: "bg-emerald-100 text-emerald-600", num: "text-emerald-700" },
    { key: "refused", value: stats?.byStatus?.refused, label: t("sum_refused"), Icon: XCircle, cls: "bg-red-50/60", icon: "bg-red-100 text-red-500", num: "text-red-600" },
    { key: "noResponse", value: stats?.byStatus?.noResponse, label: t("sum_noResponse"), Icon: Clock, cls: "bg-amber-50/70", icon: "bg-amber-100 text-amber-600", num: "text-amber-700" },
    { key: "inDelivery", value: stats?.byStatus?.inDelivery, label: d("kpi_inDelivery"), Icon: Route, cls: "bg-sky-50/70", icon: "bg-sky-100 text-sky-600", num: "text-sky-700" },
    { key: "cancelled", value: stats?.byStatus?.cancelled, label: d("kpi_cancelled"), Icon: Ban, cls: "bg-gray-50", icon: "bg-gray-200 text-gray-600", num: "text-gray-700" },
  ];
  // Extra chart lines, from each bucket's per-status counts (same counts as the cards above).
  const series = [
    { key: "inDelivery", label: d("kpi_inDelivery"), color: STATUS_COLOR.inDelivery.hex },
    { key: "cancelled", label: d("kpi_cancelled"), color: STATUS_COLOR.cancelled.hex },
  ];
  return (
    <section className={`${CARD} p-4 sm:p-5`} data-analytics aria-busy={loading}>
      <SectionTitle Icon={BarChart3} extra={<SimulatedBadge t={t} />}>{d("analytics_title")}</SectionTitle>
      <div role="radiogroup" aria-label={t("range_label")} className="grid grid-cols-3 gap-1 p-1 rounded-2xl bg-violet-50/70 border border-violet-100 mb-3">
        {Object.entries(SIM_WINDOWS).map(([k, w]) => (
          <button key={k} type="button" role="radio" aria-checked={windowKey === k} onClick={() => onWindow(k)}
            className={`py-2 rounded-xl text-sm font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${windowKey === k ? "bg-violet-600 text-white shadow" : "text-gray-700 hover:bg-white"}`}>
            {w.unit === "hour" ? d("pill_hours", { n: w.size }) : d("pill_days", { n: w.size })}
          </button>
        ))}
      </div>
      <div className={`grid grid-cols-2 gap-2.5 ${loading ? "opacity-60" : ""}`} data-kpis>
        {kpis.map(({ key, value, label, Icon, cls, icon, num }) => (
          // ≤380 px: slightly smaller icon, gap and side padding, so the longest single word ("Commandes") fits; labels wrap between words.
          <div key={key} className={`flex items-center gap-2.5 max-[380px]:gap-2 rounded-2xl border border-gray-100 p-3 max-[380px]:px-2.5 min-w-0 ${cls}`} data-kpi={key}>
            <span className={`w-10 h-10 max-[380px]:w-9 max-[380px]:h-9 rounded-full flex items-center justify-center shrink-0 ${icon}`}><Icon className="w-5 h-5" aria-hidden="true" /></span>
            <div className="min-w-0">
              <p className={`text-xl sm:text-2xl font-black leading-none ${num}`}>{n(value)}</p>
              <p className="text-[12px] font-semibold text-gray-600 mt-1 leading-tight break-words">{label}</p>
            </div>
          </div>
        ))}
      </div>
      <div className={`mt-3 ${loading ? "opacity-60" : ""}`}>
        <p className="text-[11px] text-gray-500 mb-1">{stats?.unit === "hour" ? t("chart_hour") : t("chart_day")}</p>
        {stats?.total ? (
          <>
            <LineChart stats={stats} t={t} locale={locale} series={series} />
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] font-semibold text-gray-600" data-chart-legend>
              {[{ key: "total", label: t("sum_total"), color: "#7c3aed" }, ...series].map((s) => (
                <li key={s.key} className="flex items-center gap-1.5"><span className="w-3 h-1 rounded-full" style={{ background: s.color }} aria-hidden="true" />{s.label}</li>
              ))}
            </ul>
          </>
        ) : <p className="text-sm text-gray-500 py-8 text-center">{t("no_data")}</p>}
      </div>
    </section>
  );
}

/** Details of one simulated order: reference, product, status and time only. */
function OrderSheet({ order, t, d, locale, ago, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const row = (label, value) => (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="text-xs text-gray-500">{label}</span><span className="text-sm font-bold text-gray-900 text-end min-w-0">{value}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-gray-900/40" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="brand-order-title" onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-5 pb-[calc(20px+env(safe-area-inset-bottom))] shadow-xl" data-order-sheet>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h4 id="brand-order-title" className="text-base font-black text-gray-900">{d("order_detail_title")}</h4>
          <button type="button" onClick={onClose} autoFocus aria-label={d("close")}
            className="w-9 h-9 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"><X className="w-4 h-4" aria-hidden="true" /></button>
        </div>
        <div className="flex items-center gap-3 rounded-2xl bg-violet-50/60 p-3 mb-1">
          <Thumb src={order.product?.image} className="w-14 h-14 rounded-xl border border-white" />
          <div className="min-w-0 flex-1">
            <p dir="auto" className="text-sm font-black text-gray-900 truncate">{order.product?.title || "—"}</p>
            <span className="inline-block mt-1 px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-black tracking-wide">{d("sim_tag")}</span>
          </div>
        </div>
        <div className="divide-y divide-gray-100">
          {row(d("detail_ref"), <span dir="ltr">{order.ref}</span>)}
          {row(d("detail_product"), <span dir="auto" className="truncate block">{order.product?.title || "—"}</span>)}
          {row(d("detail_status"), <StatusChip status={order.status} d={d} small />)}
          {row(d("detail_time"), <>{new Date(order.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })} <span className="font-normal text-gray-500">· {ago(order.at)}</span></>)}
        </div>
        <p className="text-[11px] text-gray-500 mt-2">{t("recent_note")}</p>
      </div>
    </div>
  );
}

/** D — latest simulated orders (refreshed with the dashboard); tap a row for its details. */
function LiveOrders({ orders, closed, running, t, d, locale, dir }) {
  const ago = useRelativeTime(locale);
  const [open, setOpen] = useState(null);
  const Chevron = dir === "rtl" ? ChevronLeft : ChevronRight;
  const current = open && orders?.find((o) => o.ref === open);
  return (
    <section className={`${CARD} p-4 sm:p-5`} data-recent>
      <SectionTitle Icon={ShoppingCart} extra={<SimulatedBadge t={t} />}>
        {d("orders_title")}{running && !closed && <> <span className="text-sm font-bold text-gray-500" data-live-title>{d("orders_live")}</span></>}
      </SectionTitle>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        {closed
          ? <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-100 text-slate-700 text-[11px] font-bold">{d("readonly_chip")}</span>
          : running && <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 text-[11px] font-bold" data-live>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />{d("live_chip")}
            </span>}
        {orders?.length > 0 && <span className="text-xs font-bold text-violet-700">{d("latest_count", { n: orders.length })}</span>}
      </div>
      {orders?.length ? (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li key={o.ref}>
              <button type="button" onClick={() => setOpen(o.ref)} aria-label={d("open_order", { ref: o.ref })}
                className="w-full flex items-center gap-2.5 rounded-2xl border border-gray-100 bg-white p-2.5 text-start hover:border-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400" data-order={o.ref}>
                <Thumb src={o.product?.image} className="w-11 h-11 rounded-xl" />
                {/* The reference has its own full-width line, so the status column can never cover it. */}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-black text-gray-900 whitespace-nowrap text-start"><span dir="ltr">{o.ref}</span></p>
                  <div className="flex items-start justify-between gap-2 mt-0.5">
                    <div className="min-w-0">
                      <p className="text-[11px] text-gray-600 truncate text-start"><bdi>{o.product?.title || "—"}</bdi></p>
                      <p className="flex items-center gap-1 text-[11px] text-gray-400 whitespace-nowrap"><Clock className="w-3 h-3 shrink-0" aria-hidden="true" />{ago(o.at)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <StatusChip status={o.status} d={d} small />
                      <span className="px-1 py-px rounded bg-amber-100 text-amber-800 text-[9px] font-black tracking-wide">{d("sim_tag")}</span>
                    </div>
                  </div>
                </div>
                <Chevron className="w-4 h-4 text-gray-400 shrink-0 -mx-1" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-gray-500 py-4 text-center">{t("recent_empty")}</p>}
      <p className="text-[11px] text-gray-500 mt-3">{t("recent_note")}</p>
      {current && <OrderSheet order={current} t={t} d={d} locale={locale} ago={ago} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** F — the training pack: its price (what was paid for the training, never earnings) and the selected products' images. */
function MyPack({ breakdown, products, t, d, money }) {
  const b = displayBreakdown(breakdown);
  if (!b) return null;
  return (
    <section className={`${CARD} p-4 sm:p-5`} data-pack>
      <SectionTitle Icon={GraduationCap}>{d("pack_title")}</SectionTitle>
      <div className="flex items-center gap-3 rounded-2xl bg-violet-50/70 border border-violet-100 p-3.5" data-pack-price>
        <span className="w-11 h-11 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center shrink-0"><Package className="w-5 h-5" aria-hidden="true" /></span>
        <div className="min-w-0">
          <p className="text-xl font-black text-violet-700 whitespace-nowrap">{b.price === null ? "—" : money(b.price)}</p>
          <p className="text-xs font-semibold text-gray-600">{t("bd_price")}</p>
        </div>
      </div>
      {products?.length > 0 && (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 mt-3" data-pack-products>
          {products.map((p) => (
            <li key={p.id} className="rounded-2xl border border-gray-100 bg-white overflow-hidden">
              <Thumb src={p.image} className="aspect-square w-full" />
              <span className="sr-only">{p.title}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-gray-500 mt-2">{t("package_costs_note")}</p>
    </section>
  );
}

export default function BrandDashboard({ access, dash, error, loading, windowKey, onWindow, t, lang, dir, locale, money, fmtDate }) {
  const d = dashboardT(lang);
  const closed = access.status === "CLOSED";
  return (
    <div className="space-y-4">
      <Hero access={access} t={t} d={d} closed={closed} />

      {closed && (
        <div role="status" className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm text-slate-800">
          <p className="font-bold">{t("closed_title", { date: fmtDate(access.closedAt) })}</p>
          {access.closureReason && <p dir="auto" className="mt-1">{t("closed_reason", { reason: access.closureReason })}</p>}
          <p className="mt-1 text-xs">{t("closed_readonly")}</p>
        </div>
      )}
      <div className="rounded-2xl bg-amber-50 border border-amber-100 px-4 py-3 space-y-1.5">
        <SimulatedBadge t={t} />
        <p className="text-xs font-semibold text-amber-900">{t("dash_disclaimer")}</p>
        <p className="text-[11px] text-amber-800">{t("activated_on", { date: fmtDate(access.activatedAt) })}</p>
        {dash && !dash.started && <p className="text-xs text-gray-700 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" aria-hidden="true" />{t("starts_on", { date: fmtDate(dash.simulationStartsAt) })}</p>}
        {dash && dash.started && !dash.running && !dash.readOnly && <p className="text-xs text-gray-700 flex items-center gap-1.5"><PauseCircle className="w-3.5 h-3.5" aria-hidden="true" />{t("paused")}</p>}
        {dash?.incomplete?.length > 0 && <p className="text-xs text-gray-700 flex items-center gap-1.5"><Info className="w-3.5 h-3.5" aria-hidden="true" />{t("dash_incomplete")}</p>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {dash ? (
        <>
          <Analyses stats={dash.stats} windowKey={windowKey} onWindow={onWindow} t={t} d={d} locale={locale} loading={loading} />
          <LiveOrders orders={dash.recent} closed={closed} running={dash.running === true} t={t} d={d} locale={locale} dir={dir} />
        </>
      ) : <div className="flex justify-center py-10"><span className="w-6 h-6 rounded-full border-2 border-violet-200 border-t-violet-600 animate-spin" aria-label={t("sending")} /></div>}

      <MyPack breakdown={access.package?.breakdown} products={access.products} t={t} d={d} money={money} />
    </div>
  );
}
