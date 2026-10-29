"use client";

/**
 * Simulated training statistics of one "Create Your Own Brand" access
 * (presentation only — data comes from the brand dashboard APIs).
 * Shared by the affiliate tab and the admin access view; texts come from the
 * caller's translator (brandT). Every block is labelled as SIMULATED data.
 *
 *   summary tiles (total / delivered / refused / no response) · period selector
 *   · line chart (keyboard + pointer readable) · status donut with legend
 */

import { useMemo, useState } from "react";
import { FlaskConical, ShoppingCart, Truck, XCircle, Clock } from "lucide-react";
import { SIM_WINDOWS } from "@/lib/brandSimulation";
import { SIM_STATUSES } from "@/lib/brandProgram";

/** One colour per simulated status (tiles, donut, chips). */
export const STATUS_COLOR = {
  pending:    { hex: "#9ca3af", chip: "bg-gray-100 text-gray-700" },
  confirmed:  { hex: "#3b82f6", chip: "bg-blue-50 text-blue-700" },
  delivered:  { hex: "#10b981", chip: "bg-emerald-50 text-emerald-700" },
  refused:    { hex: "#ef4444", chip: "bg-red-50 text-red-700" },
  returned:   { hex: "#f97316", chip: "bg-orange-50 text-orange-700" },
  noResponse: { hex: "#f59e0b", chip: "bg-amber-50 text-amber-700" },
  cancelled:  { hex: "#6b7280", chip: "bg-gray-100 text-gray-600" },
};

export function SimulatedBadge({ t }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold whitespace-nowrap">
      <FlaskConical className="w-3 h-3" aria-hidden="true" />{t("dash_badge")}
    </span>
  );
}

function windowLabel(key, t) {
  const w = SIM_WINDOWS[key];
  return w.unit === "hour" ? t("window_hours", { n: w.size }) : t("window_days", { n: w.size });
}

/** Period selector (24 h / 7 days / 30 days), styled like the reference dropdown. */
export function WindowSelect({ windowKey, onWindow, t }) {
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">{t("range_label")}</span>
      <select value={windowKey} onChange={(e) => onWindow?.(e.target.value)}
        className="appearance-none ps-3 pe-8 py-2 rounded-xl border border-gray-200 bg-white text-xs font-semibold text-gray-700 focus:outline-none focus:ring-2 focus:ring-violet-400">
        {Object.keys(SIM_WINDOWS).map((k) => <option key={k} value={k}>{windowLabel(k, t)}</option>)}
      </select>
      <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute end-2.5 w-3.5 h-3.5 text-gray-500"><path fill="currentColor" d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" /></svg>
    </label>
  );
}

/** Four summary tiles: total, delivered, refused, no response. */
export function SummaryTiles({ stats, t, locale }) {
  const n = (v) => Number(v || 0).toLocaleString(locale);
  const tiles = [
    { key: "total", value: stats?.total, label: t("sum_total"), cls: "text-gray-900", Icon: ShoppingCart, icon: "text-violet-600 bg-violet-50" },
    { key: "delivered", value: stats?.byStatus?.delivered, label: t("sum_delivered"), cls: "text-emerald-600", Icon: Truck, icon: "text-emerald-600 bg-emerald-50" },
    { key: "refused", value: stats?.byStatus?.refused, label: t("sum_refused"), cls: "text-red-600", Icon: XCircle, icon: "text-red-500 bg-red-50" },
    { key: "noResponse", value: stats?.byStatus?.noResponse, label: t("sum_noResponse"), cls: "text-amber-600", Icon: Clock, icon: "text-amber-500 bg-amber-50" },
  ];
  return (
    <div className="grid grid-cols-4 divide-x divide-gray-100 rtl:divide-x-reverse bg-white rounded-2xl border border-gray-100 shadow-sm py-3" data-summary>
      {tiles.map(({ key, value, label, cls, Icon, icon }) => (
        <div key={key} className="px-1.5 text-center min-w-0">
          <span className={`mx-auto mb-1 w-7 h-7 rounded-full flex items-center justify-center ${icon}`}><Icon className="w-3.5 h-3.5" aria-hidden="true" /></span>
          <p className={`text-xl font-black leading-tight ${cls}`}>{n(value)}</p>
          <p className="text-[11px] text-gray-500 leading-tight mt-0.5 truncate" title={label}>{label}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Line chart of simulated orders per bucket. A point is highlighted (the peak by
 * default); pointer moves and ←/→ keys change it, and its value is announced.
 */
export function LineChart({ stats, t, locale }) {
  const buckets = stats?.buckets || [];
  const W = 320, H = 150, P = { l: 26, r: 8, t: 14, b: 22 };
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const niceMax = max <= 5 ? 5 : Math.ceil(max / 5) * 5;
  const peak = buckets.reduce((best, b, i) => (b.total > (buckets[best]?.total ?? -1) ? i : best), 0);
  const [active, setActive] = useState(null);
  const idx = active ?? peak;
  const x = (i) => P.l + (buckets.length <= 1 ? 0 : (i * (W - P.l - P.r)) / (buckets.length - 1));
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / niceMax);
  const pts = buckets.map((b, i) => [x(i), y(b.total)]);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = pts.length ? `${line} L${pts.at(-1)[0].toFixed(1)},${y(0)} L${pts[0][0].toFixed(1)},${y(0)} Z` : "";
  const fmt = (iso, long = false) => (stats?.unit === "hour"
    ? new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", ...(long ? { minute: "2-digit" } : {}) })
    : new Date(iso).toLocaleDateString(locale, long ? { day: "2-digit", month: "short" } : { day: "2-digit", month: "2-digit" }));
  const every = Math.max(1, Math.ceil(buckets.length / 6));
  const cur = buckets[idx];
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach(([px], i) => { if (Math.abs(px - rel) < Math.abs(pts[best][0] - rel)) best = i; });
    setActive(best);
  };
  const onKey = (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1; // the chart is always drawn left → right
      setActive(Math.min(buckets.length - 1, Math.max(0, idx + d)));
    }
  };
  if (!buckets.length) return null;
  const tipX = Math.min(Math.max(pts[idx][0], 44), W - 44);
  return (
    <div dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-violet-400 rounded-lg"
        role="img" tabIndex={0} aria-label={`${t("chart_aria")} — ${fmt(cur.start, true)} : ${cur.total}`}
        onPointerMove={onMove} onPointerDown={onMove} onKeyDown={onKey} data-chart>
        <defs>
          <linearGradient id="brandArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.28" /><stop offset="100%" stopColor="#7c3aed" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={P.l} x2={W - P.r} y1={y(niceMax * f)} y2={y(niceMax * f)} stroke="#eef0f4" strokeWidth="1" />
            <text x={P.l - 5} y={y(niceMax * f) + 3} textAnchor="end" fontSize="8" fill="#9ca3af">{Math.round(niceMax * f)}</text>
          </g>
        ))}
        <path d={area} fill="url(#brandArea)" />
        <path d={line} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map(([px, py], i) => (i % every === 0 || i === idx) && <circle key={i} cx={px} cy={py} r={i === idx ? 4 : 2.6} fill={i === idx ? "#7c3aed" : "#fff"} stroke="#7c3aed" strokeWidth="1.6" />)}
        <line x1={pts[idx][0]} x2={pts[idx][0]} y1={pts[idx][1]} y2={y(0)} stroke="#7c3aed" strokeOpacity="0.35" strokeDasharray="3 3" />
        <g transform={`translate(${tipX - 40}, ${Math.max(0, pts[idx][1] - 34)})`}>
          <rect width="80" height="26" rx="6" fill="#1f2937" />
          <text x="40" y="11" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff">{t("chart_tip", { n: cur.total })}</text>
          <text x="40" y="21" textAnchor="middle" fontSize="7.5" fill="#d1d5db">{fmt(cur.start, true)}</text>
        </g>
        {buckets.map((b, i) => (i % every === 0 ? <text key={b.start} x={pts[i][0]} y={H - 6} textAnchor="middle" fontSize="8" fill="#9ca3af">{fmt(b.start)}</text> : null))}
      </svg>
    </div>
  );
}

/** Donut of the window's simulated orders by status, with a legend (counts + %). */
export function StatusDonut({ stats, t, locale }) {
  const total = Number(stats?.total || 0);
  const parts = useMemo(() => SIM_STATUSES.map((s) => ({ s, v: Number(stats?.byStatus?.[s] || 0) })).filter((p) => p.v > 0), [stats]);
  let acc = 0;
  const grad = parts.map(({ s, v }) => { const a = (acc / total) * 360; acc += v; return `${STATUS_COLOR[s].hex} ${a}deg ${(acc / total) * 360}deg`; }).join(", ");
  return (
    <div className="flex items-center gap-4" data-donut>
      <div className="relative w-28 h-28 shrink-0 rounded-full" style={{ background: total ? `conic-gradient(${grad})` : "#f3f4f6" }} role="img"
        aria-label={`${t("order_details")}: ${parts.map((p) => `${t(`status_${p.s}`)} ${p.v}`).join(", ")}`}>
        <div className="absolute inset-3 rounded-full bg-white flex flex-col items-center justify-center text-center">
          <span className="text-xl font-black text-gray-900 leading-none">{total.toLocaleString(locale)}</span>
          <span className="text-[10px] text-gray-500 mt-0.5">{t("sum_total")}</span>
        </div>
      </div>
      <ul className="flex-1 min-w-0 space-y-1.5">
        {SIM_STATUSES.map((s) => {
          const v = Number(stats?.byStatus?.[s] || 0);
          return (
            <li key={s} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 min-w-0 text-gray-600"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_COLOR[s].hex }} />
                <span className="truncate">{t(`status_${s}`)}</span></span>
              <span className="font-bold text-gray-900 whitespace-nowrap">{v.toLocaleString(locale)} <span className="font-normal text-gray-400">({total ? Math.round((v / total) * 100) : 0}%)</span></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Full block: summary tiles, analytics (period + line chart) and order details donut. */
export default function BrandSimStats({ stats, windowKey, onWindow, t, locale = "fr-FR", loading = false }) {
  return (
    <div className={`space-y-4 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
      <SummaryTiles stats={stats} t={t} locale={locale} />

      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-base font-black text-gray-900">{t("analytics_title")}</h3>
          <div className="flex items-center gap-2"><SimulatedBadge t={t} /><WindowSelect windowKey={windowKey} onWindow={onWindow} t={t} /></div>
        </div>
        <p className="text-[11px] text-gray-500 mb-2">{t("total_orders")} · {windowLabel(windowKey, t)} · {stats?.unit === "hour" ? t("chart_hour") : t("chart_day")}</p>
        {stats?.total ? <LineChart stats={stats} t={t} locale={locale} /> : <p className="text-sm text-gray-500 py-8 text-center">{t("no_data")}</p>}
      </section>

      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-base font-black text-gray-900">{t("order_details")}</h3>
          <SimulatedBadge t={t} />
        </div>
        <StatusDonut stats={stats} t={t} locale={locale} />
      </section>
    </div>
  );
}
