"use client";
/**
 * src/app/recruiter/_components/DashboardCharts.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Recruiter dashboard redesign (UI only): the two charts of /recruiter, drawn from the network
 * statistics the page already loads (GET /api/recruiter/network/stats — read only):
 *   • OrdersStatusChart  real orders of the whole network by status (test orders are never counted;
 *                        not rendered at all when the admin turned the order view off)
 *   • LevelsChart        affiliates per absolute level, active vs inactive
 * No time series exists in the recruiter APIs, so no "last 30 days" curve is drawn (nothing invented).
 * Loaded with next/dynamic (ssr: false) by the page — recharts measures the browser layout.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, Legend } from "recharts";
import { ORDER_LABEL, fmt } from "../network/networkUi";

const STATUS_COLOR = {
  delivered: "#7c3aed", pending: "#a78bfa", confirmed: "#6366f1", shipped: "#38bdf8",
  cancelled: "#fb7185", returned: "#f59e0b", other: "#94a3b8",
};
const AXIS_TICK = { fontSize: 12, fill: "#64748b", fontFamily: "inherit" };
const TOOLTIP_STYLE = { borderRadius: 14, border: "1px solid #ede9fe", boxShadow: "0 10px 30px -12px rgba(76,29,149,.25)", fontFamily: "inherit", direction: "rtl", textAlign: "right" };

/** series: [{ key, value }] from orderStatusSeries (non-null). Horizontal bars: long Arabic labels stay readable on phones. */
export function OrdersStatusChart({ series }) {
  const data = series.map((s) => ({ key: s.key, name: ORDER_LABEL[s.key] ?? s.key, value: s.value }));
  return (
    <div className="w-full h-72" dir="ltr" data-chart="orders" role="img" aria-label={`الطلبات الحقيقية حسب الحالة: ${data.map((d) => `${d.name} ${d.value}`).join("، ")}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 4 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="#ede9fe" />
          <XAxis type="number" allowDecimals={false} reversed tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(v) => fmt(v)} />
          <YAxis type="category" dataKey="name" orientation="right" width={92} tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: "#f5f3ff" }} contentStyle={TOOLTIP_STYLE} formatter={(v) => [fmt(v), "طلبات حقيقية"]} />
          <Bar dataKey="value" radius={[8, 0, 0, 8]} maxBarSize={22} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.key} fill={STATUS_COLOR[d.key] ?? STATUS_COLOR.other} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** series: [{ label, level, active, inactive }] from levelSeries (non-empty). Stacked active / inactive. */
export function LevelsChart({ series }) {
  const data = [...series].reverse(); // level 1 on the right (RTL reading order)
  return (
    <div className="w-full" dir="ltr" data-chart="levels" role="img"
      aria-label={`الأفلييت حسب المستوى: ${series.map((d) => `${d.label} ${d.active + d.inactive}`).join("، ")}`}>
      <ResponsiveContainer width="100%" height={268}>
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 4, left: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="#ede9fe" />
          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
          <YAxis orientation="right" allowDecimals={false} width={36} tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={(v) => fmt(v)} />
          <Tooltip cursor={{ fill: "#f5f3ff" }} contentStyle={TOOLTIP_STYLE}
            labelFormatter={(l) => `المستوى ${l}`} formatter={(v, n) => [fmt(v), n === "active" ? "مفعّل" : "غير مفعّل"]} />
          <Legend verticalAlign="top" align="right" height={28} iconType="circle"
            formatter={(n) => <span style={{ color: "#475569", fontSize: 12 }}>{n === "active" ? "مفعّل" : "غير مفعّل"}</span>} />
          <Bar dataKey="active" stackId="a" fill="#7c3aed" maxBarSize={34} isAnimationActive={false} />
          <Bar dataKey="inactive" stackId="a" fill="#c4b5fd" radius={[8, 8, 0, 0]} maxBarSize={34} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <p className="text-center text-xs text-slate-500" dir="rtl">المستوى</p>
    </div>
  );
}
