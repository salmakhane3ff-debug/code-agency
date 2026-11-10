"use client";

/**
 * 🏪 Create Your Own Brand — affiliate dashboard of an ACTIVE or CLOSED brand
 * (mobile first, one scrolling page). Used only by ../BrandTab.jsx, which loads
 * the data (brand + simulated dashboard APIs) and refreshes it; this file only
 * presents it:
 *
 *   hero (title, training + pieces chips, selected product image → lightbox,
 *   brand identity) · disclaimer / closed notice · analyses (24 h / 7 j / 30 j:
 *   SIMULATED balance / profit / revenue, status counts, chart) · simulated
 *   training orders (cards with simulated price, expenses and net; "see all")
 *   · training pack (price paid for the training)
 *
 * Every figure comes from the simulated dashboard API, which derives the order
 * list, counts, chart and simulated money from ONE dataset. All amounts are
 * TRAINING figures: never credited, never withdrawable, never the real wallet.
 */

import { useEffect, useRef, useState } from "react";
import {
  BarChart3, ShoppingCart, Truck, XCircle, Clock, CheckCircle, Undo2, Ban,
  GraduationCap, ShoppingBag, Package, Info, PauseCircle, X, Store, Route, Wallet, Coins, TrendingUp,
  Boxes, Hourglass, Maximize2,
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

/**
 * Overlays (lightbox, "see all", order details) stack: Escape closes ONLY the topmost one, and
 * closing returns focus to the element that opened it. Each overlay registers on mount.
 */
const overlayStack = [];
let overlaySeq = 0;
function useOverlay(onClose) {
  const close = useRef(onClose);
  close.current = onClose;
  // The opener is read during the overlay's FIRST render: React then commits the overlay and focuses its
  // autoFocus close button before any effect runs, so an effect would only see that button.
  const [opener] = useState(() => (typeof document !== "undefined" ? document.activeElement : null));
  useEffect(() => {
    const id = ++overlaySeq;
    overlayStack.push(id);
    const onKey = (e) => {
      if (e.key !== "Escape" || overlayStack[overlayStack.length - 1] !== id) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = overlayStack.lastIndexOf(id);
      if (i !== -1) overlayStack.splice(i, 1);
      // Only when focus went away with the overlay (it was inside the removed nodes): never steal it from elsewhere.
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && opener && opener !== document.body && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, [opener]);
}

/** A product thumbnail; a missing or failing image shows the package icon (never a broken image). */
function Thumb({ src, className = "" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <div className={`bg-gray-50 flex items-center justify-center overflow-hidden shrink-0 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-cover" /> : <Package className="w-5 h-5 text-gray-300" aria-hidden="true" />}
    </div>
  );
}

/** Full-size view of an image (aspect ratio kept); closes on ✕, Escape or a click outside the image. */
function Lightbox({ src, alt, d, onClose }) {
  useOverlay(onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label={alt} onClick={onClose} data-lightbox
      className="fixed inset-0 z-[80] bg-gray-950/85 flex items-center justify-center p-4 pt-16">
      <button type="button" autoFocus onClick={onClose} aria-label={d("close")}
        className="absolute top-3 end-3 w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="w-5 h-5" aria-hidden="true" /></button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} className="max-w-full max-h-[80vh] w-auto h-auto object-contain rounded-2xl bg-white" />
    </div>
  );
}

/** The selected product's image in the hero (opens the lightbox); without a usable image, the original decorative icon. */
function HeroImage({ src, d }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) {
    return (
      <div aria-hidden="true" className="relative w-16 h-16 sm:w-20 sm:h-20 shrink-0" data-hero-fallback>
        <span className="absolute inset-0 rounded-2xl bg-white/15 rotate-6" />
        <span className="absolute inset-0 rounded-2xl bg-white/20 flex items-center justify-center"><ShoppingBag className="w-9 h-9 sm:w-11 sm:h-11 text-white" /></span>
        <span className="absolute -bottom-1.5 -start-1.5 w-7 h-7 rounded-lg bg-amber-400 flex items-center justify-center shadow"><Package className="w-4 h-4 text-amber-900" /></span>
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={d("hero_image_open")} data-hero-image
        className="relative w-16 h-16 sm:w-20 sm:h-20 shrink-0 rounded-2xl overflow-hidden bg-white ring-2 ring-white/70 shadow-md focus:outline-none focus-visible:ring-amber-300">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={d("hero_image_alt")} onError={() => setFailed(true)} className="w-full h-full object-contain" />
        <span className="absolute bottom-1 end-1 w-5 h-5 rounded-md bg-gray-900/55 flex items-center justify-center" aria-hidden="true"><Maximize2 className="w-3 h-3 text-white" /></span>
      </button>
      {open && <Lightbox src={src} alt={d("hero_image_alt")} d={d} onClose={() => setOpen(false)} />}
    </>
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
function Hero({ access, t, d, closed, locale }) {
  const letter = (access.brandName || "?").trim().charAt(0).toUpperCase();
  // Pieces = the pack's physical quantity frozen in the request (never productCount); unknown → "—".
  const qty = access.package?.quantity;
  const chips = [
    { key: "training", label: d("hero_training"), Icon: GraduationCap, icon: "text-violet-600" },
    { key: "quantity", label: Number.isInteger(qty) && qty > 0 ? d("hero_quantity", { n: qty.toLocaleString(locale) }) : d("hero_quantity_unknown"), Icon: Boxes, icon: "text-amber-500" },
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
        <HeroImage src={access.products?.[0]?.image || null} d={d} />
      </div>

      <ul className="relative grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
        {chips.map(({ key, label, Icon, icon }) => (
          <li key={key} className="flex items-center gap-1.5 rounded-2xl bg-white text-gray-900 px-2.5 py-2 text-[12px] font-bold leading-tight shadow-sm min-w-0" data-hero-chip={key}>
            <Icon className={`w-4 h-4 shrink-0 ${icon}`} aria-hidden="true" /><span className="min-w-0">{label}</span>
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

/** Simulated money of one training order → "1 234,5 DH" / Arabic label (money from BrandTab), or "—". */
const fmtMoney = (money, v) => (typeof v === "number" && Number.isFinite(v) ? money(v) : "—");

/** SIMULATED balance / profit / revenue of the selected period (same orders as the counts below). */
function SimFinance({ stats, finance, d, money }) {
  const items = [
    { key: "balance", value: finance ? finance.balance : null, label: d("fin_balance"), Icon: Wallet, icon: "bg-blue-100 text-blue-600", num: "text-blue-700" },
    { key: "profit", value: finance ? stats?.money?.profit : null, label: d("fin_profit"), Icon: Coins, icon: "bg-emerald-100 text-emerald-600", num: "text-emerald-700" },
    { key: "revenue", value: finance ? stats?.money?.revenue : null, label: d("fin_revenue"), Icon: TrendingUp, icon: "bg-amber-100 text-amber-600", num: "text-amber-700" },
  ];
  return (
    <div className="mb-3" data-sim-finance>
      <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {items.map(({ key, value, label, Icon, icon, num }) => (
          <li key={key} className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white p-3 min-w-0" data-fin={key}>
            <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${icon}`}><Icon className="w-5 h-5" aria-hidden="true" /></span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-gray-600 leading-tight">{label}</p>
              <p dir="ltr" className={`text-lg sm:text-xl font-black leading-tight mt-0.5 whitespace-nowrap text-start ${value < 0 ? "text-red-600" : num}`}>{fmtMoney(money, value)}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-gray-500 mt-1.5">{finance ? d("fin_note") : d("fin_no_price")}</p>
    </div>
  );
}

/** C — period pills, the four real counts and the orders chart. */
function Analyses({ stats, finance, windowKey, onWindow, t, d, locale, loading, money }) {
  const n = (v) => Number(v || 0).toLocaleString(locale);
  const kpis = [
    // Total + one card per status: the status cards always add up to the total (same orders).
    { key: "total", value: stats?.total, label: t("sum_total"), Icon: ShoppingCart, cls: "bg-white col-span-2", icon: "bg-violet-100 text-violet-600", num: "text-gray-900" },
    { key: "confirmed", value: stats?.byStatus?.confirmed, label: t("status_confirmed"), Icon: CheckCircle, cls: "bg-blue-50/70", icon: "bg-blue-100 text-blue-600", num: "text-blue-700" },
    { key: "inDelivery", value: stats?.byStatus?.inDelivery, label: d("kpi_inDelivery"), Icon: Route, cls: "bg-sky-50/70", icon: "bg-sky-100 text-sky-600", num: "text-sky-700" },
    { key: "delivered", value: stats?.byStatus?.delivered, label: t("sum_delivered"), Icon: Truck, cls: "bg-emerald-50/70", icon: "bg-emerald-100 text-emerald-600", num: "text-emerald-700" },
    { key: "refused", value: stats?.byStatus?.refused, label: t("sum_refused"), Icon: XCircle, cls: "bg-red-50/60", icon: "bg-red-100 text-red-500", num: "text-red-600" },
    { key: "noResponse", value: stats?.byStatus?.noResponse, label: t("sum_noResponse"), Icon: Clock, cls: "bg-amber-50/70", icon: "bg-amber-100 text-amber-600", num: "text-amber-700" },
    { key: "cancelled", value: stats?.byStatus?.cancelled, label: d("kpi_cancelled"), Icon: Ban, cls: "bg-gray-50", icon: "bg-gray-200 text-gray-600", num: "text-gray-700" },
    { key: "returned", value: stats?.byStatus?.returned, label: d("order_status_returned"), Icon: Undo2, cls: "bg-orange-50/60", icon: "bg-orange-100 text-orange-600", num: "text-orange-600" },
    { key: "pending", value: stats?.byStatus?.pending, label: d("order_status_pending"), Icon: Hourglass, cls: "bg-gray-50", icon: "bg-gray-100 text-gray-600", num: "text-gray-700" },
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
      <div className={loading ? "opacity-60" : ""}><SimFinance stats={stats} finance={finance} d={d} money={money} /></div>
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

/** Orders that never produce an amount (refused, returned, no response, cancelled): no price, expense or profit is shown. */
const NO_AMOUNT_STATUSES = ["refused", "returned", "noResponse", "cancelled"];

/**
 * Simulated price, expenses and net of one training order: delivered → realized net; pending / confirmed /
 * in delivery → expected net; no simulated price in the request → "—". A non-qualifying status shows only a
 * note that the order has no amount (display only — the calculations are unchanged).
 */
function OrderMoney({ m, status, d, money, locale, detailed = false }) {
  if (NO_AMOUNT_STATUSES.includes(status)) {
    return <p className="mt-2 rounded-xl bg-gray-50/80 px-2.5 py-1.5 text-[11px] text-gray-500" data-order-money="none" data-order-no-amount>{d("fin_no_amount")}</p>;
  }
  const n = (v) => Number(v).toLocaleString(locale);
  const net = !m ? { label: d("fin_net"), value: "—", cls: "text-gray-500" }
    : m.kind === "realized" ? { label: d("fin_net"), value: money(m.net), cls: m.net < 0 ? "text-red-600" : "text-green-600" }
      : { label: d("fin_expected"), value: money(m.net), cls: "text-amber-600" };
  const rows = detailed && m
    ? [[d("fin_exp_delivery"), money(m.expenses.delivery)], [d("fin_exp_notification"), money(m.expenses.notification)], [d("fin_exp_confirmation"), money(m.expenses.confirmation)]]
    : [];
  return (
    <dl className="mt-2 rounded-xl bg-gray-50/80 px-2.5 py-1.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11px]" data-order-money={m ? m.kind : "none"}>
      <dt className="text-gray-500">{d("fin_price")}</dt><dd dir="ltr" className="font-bold text-gray-800 text-end">{m ? money(m.price) : "—"}</dd>
      <dt className="text-gray-500 min-w-0">
        {d("fin_expenses")}{m && !detailed && <span className="text-gray-400"> ({d("fin_exp_delivery")} {n(m.expenses.delivery)} · {d("fin_exp_notification")} {n(m.expenses.notification)} · {d("fin_exp_confirmation")} {n(m.expenses.confirmation)})</span>}
      </dt>
      <dd dir="ltr" className="font-bold text-gray-800 text-end">{m ? `−${money(m.expenses.total)}` : "—"}</dd>
      {rows.map(([label, value]) => (
        <div key={label} className="contents"><dt className="text-gray-400 ps-2">{label}</dt><dd dir="ltr" className="text-gray-500 text-end">{value}</dd></div>
      ))}
      <dt className="font-bold text-gray-700">{net.label}</dt>
      <dd dir={m ? "ltr" : undefined} className={`font-black text-sm text-end ${net.cls}`} data-order-net>{net.value}</dd>
    </dl>
  );
}

/** One simulated training order (Homepage activity-card style): product, reference, status, time, simulated money. */
function OrderCard({ o, d, ago, money, locale, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(o)} aria-label={d("open_order", { ref: o.ref })} data-order={o.ref}
      className="w-full flex items-start gap-3 bg-white rounded-2xl border border-gray-100 px-3.5 py-3 text-start hover:border-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
      <Thumb src={o.product?.image} className="w-11 h-11 rounded-full" />
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-black text-gray-800 truncate min-w-0"><bdi>{o.product?.title || "—"}</bdi></p>
          <span className="text-[11px] text-gray-400 shrink-0 whitespace-nowrap" data-order-time>{ago(o.at)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
          <span className="text-xs text-gray-500 whitespace-nowrap" data-order-ref>{d("order_no")} <bdi dir="ltr">{o.ref}</bdi></span>
          <StatusChip status={o.status} d={d} small />
          <span className="px-1 py-px rounded bg-amber-100 text-amber-800 text-[9px] font-black tracking-wide">{d("sim_tag")}</span>
        </div>
        <OrderMoney m={o.money} status={o.status} d={d} money={money} locale={locale} />
      </div>
    </button>
  );
}

/** Details of one simulated order: reference, product, status, time and its simulated money in detail. */
function OrderSheet({ order, t, d, locale, ago, money, onClose }) {
  useOverlay(onClose);
  const row = (label, value) => (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="text-xs text-gray-500">{label}</span><span className="text-sm font-bold text-gray-900 text-end min-w-0">{value}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-[75] flex items-end sm:items-center justify-center bg-gray-900/40" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="brand-order-title" onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl p-5 pb-[calc(20px+env(safe-area-inset-bottom))] shadow-xl" data-order-sheet>
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
          {row(d("detail_status"), <StatusChip status={order.status} d={d} small />)}
          {row(d("detail_time"), <>{new Date(order.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Casablanca" })} <span className="font-normal text-gray-500">· {ago(order.at)}</span></>)}
        </div>
        <OrderMoney m={order.money} status={order.status} d={d} money={money} locale={locale} detailed />
        <p className="text-[11px] text-gray-500 mt-2">{t("recent_note")} {d("fin_note")}</p>
      </div>
    </div>
  );
}

/**
 * "See all": every simulated order of the selected period, page by page (same dataset as the counts).
 * The list is FROZEN when the sheet opens: every page is requested with the same `asOf` instant and the
 * same period, so no order is skipped or repeated while time passes; closing the sheet drops it.
 */
function AllOrdersSheet({ first, loadPage, d, ago, money, locale, onOpen, onClose }) {
  const [frozen] = useState(() => ({ asOf: first?.asOf || null, window: first?.window || null, listId: first?.listId || null, total: first?.total || 0 }));
  const [items, setItems] = useState(first?.items || []);
  const [page, setPage] = useState(first?.page || 1);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const total = frozen.total;
  useOverlay(onClose);
  const more = async () => {
    setBusy(true);
    const next = await loadPage(page + 1, frozen.asOf, frozen.window, frozen.listId);
    setBusy(false);
    if (!next?.items) { setExpired(true); return; }
    setItems((cur) => { const seen = new Set(cur.map((o) => o.ref)); return [...cur, ...next.items.filter((o) => !seen.has(o.ref))]; });
    setPage(next.page);
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-gray-900/40" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="brand-all-title" onClick={(e) => e.stopPropagation()} data-all-orders
        className="relative w-full sm:max-w-lg max-h-[85vh] bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h4 id="brand-all-title" className="text-sm font-black text-gray-900">{d("all_title")}</h4>
            <p className="text-[11px] text-gray-500">{d("all_count", { n: total.toLocaleString(locale) })}</p>
          </div>
          <button type="button" onClick={onClose} autoFocus aria-label={d("close")}
            className="w-9 h-9 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"><X className="w-4 h-4" aria-hidden="true" /></button>
        </div>
        <div className="overflow-y-auto px-4 py-3 space-y-2.5 pb-[calc(16px+env(safe-area-inset-bottom))]">
          {items.map((o) => <OrderCard key={o.ref} o={o} d={d} ago={ago} money={money} locale={locale} onOpen={onOpen} />)}
          {expired && <p role="alert" className="text-xs text-red-600 text-center" data-all-expired>{d("all_expired")}</p>}
          {items.length < total && !expired && (
            <button type="button" onClick={more} disabled={busy} data-load-more
              className="w-full text-xs font-bold text-violet-700 bg-violet-50 hover:bg-violet-100 rounded-xl py-2.5 disabled:opacity-60">{d("load_more")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** D — latest simulated training orders (refreshed with the dashboard) + "see all"; tap a card for its details. */
function LiveOrders({ dash, closed, running, t, d, locale, money, loadPage }) {
  const ago = useRelativeTime(locale);
  const [open, setOpen] = useState(null);
  const [all, setAll] = useState(false);
  const orders = (dash.recent || []).slice(0, 5);
  const period = dash.orders?.window;
  useEffect(() => { setAll(false); setOpen(null); }, [period]); // another period → the open list is dropped (fresh snapshot next time)
  return (
    <section className={`${CARD} p-4 sm:p-5`} data-recent>
      <SectionTitle Icon={ShoppingCart} extra={<SimulatedBadge t={t} />}>
        {d("orders_title")}{running && !closed && <> <span className="text-sm font-bold text-gray-500" data-live-title>{d("orders_live")}</span></>}
      </SectionTitle>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        {closed
          ? <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-100 text-slate-700 text-[11px] font-bold">{d("readonly_chip")}</span>
          : running ? <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 text-[11px] font-bold" data-live>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />{d("live_chip")}
            </span> : <span />}
        {dash.orders?.total > 0 && (
          <button type="button" onClick={() => setAll(true)} data-see-all
            className="text-xs font-bold text-gray-600 hover:text-gray-900 bg-gray-50 hover:bg-gray-100 rounded-xl px-3 py-1.5">{d("see_all")} ({dash.orders.total.toLocaleString(locale)})</button>
        )}
      </div>
      {orders.length ? (
        <div className="space-y-2.5">
          {orders.map((o) => <OrderCard key={o.ref} o={o} d={d} ago={ago} money={money} locale={locale} onOpen={setOpen} />)}
        </div>
      ) : <p className="text-sm text-gray-500 py-4 text-center">{t("recent_empty")}</p>}
      <p className="text-[11px] text-gray-500 mt-3">{t("recent_note")}</p>
      {all && <AllOrdersSheet first={dash.orders} loadPage={loadPage} d={d} ago={ago} money={money} locale={locale} onOpen={setOpen} onClose={() => setAll(false)} />}
      {open && <OrderSheet order={open} t={t} d={d} locale={locale} ago={ago} money={money} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** F — the training pack: its price (what was paid for the training, never earnings). No product image here (it is in the hero). */
function MyPack({ breakdown, t, d, money }) {
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
      <p className="text-[11px] text-gray-500 mt-2">{t("package_costs_note")}</p>
    </section>
  );
}

export default function BrandDashboard({ access, dash, error, loading, windowKey, onWindow, t, lang, locale, money, fmtDate, loadPage }) {
  const d = dashboardT(lang);
  const closed = access.status === "CLOSED";
  return (
    <div className="space-y-4">
      <Hero access={access} t={t} d={d} closed={closed} locale={locale} />

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
          <Analyses stats={dash.stats} finance={dash.finance || null} windowKey={windowKey} onWindow={onWindow} t={t} d={d} locale={locale} loading={loading} money={money} />
          <LiveOrders dash={dash} closed={closed} running={dash.running === true} t={t} d={d} locale={locale} money={money} loadPage={loadPage} />
        </>
      ) : <div className="flex justify-center py-10"><span className="w-6 h-6 rounded-full border-2 border-violet-200 border-t-violet-600 animate-spin" aria-label={t("sending")} /></div>}

      <MyPack breakdown={access.package?.breakdown} t={t} d={d} money={money} />
    </div>
  );
}
