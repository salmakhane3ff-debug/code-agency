"use client";

/**
 * Shared "🔥 النشاط المباشر" (Live Activity) card — used by BOTH the landing page
 * and the affiliate dashboard. It only READS the single server-side engine via
 * GET /api/live-activity (polled while the tab is visible). No localStorage, no
 * client-generated feed — both pages therefore stay perfectly in sync.
 *
 * UGC rows show ONLY: name, number of videos, total sales, total earnings
 * (earnings come from the server as sales × commissionPerSale). Never views,
 * likes, product names or city — per the UGC display rules.
 *
 * The feed is SIMULATED: the disclosure below is always rendered (it does not
 * depend on the API payload) and each row's time comes from the event's true
 * timestamp (relative label + Casablanca clock in the tooltip).
 */
import { useEffect, useRef, useState } from "react";
import { LIVE_ACTIVITY_DISCLOSURE } from "@/lib/liveActivityTime";

const STAT_META = [
  { key: "todayOrders",      icon: "🛍️", label: "طلبات اليوم",   bg: "bg-rose-50",    fg: "text-rose-500" },
  { key: "todayDelivered",   icon: "✅",  label: "مسلمة اليوم",   bg: "bg-green-50",   fg: "text-green-600" },
  { key: "todayCommissions", icon: "💰",  label: "عمولات اليوم",  bg: "bg-amber-50",   fg: "text-amber-600", suffix: " DH" },
  { key: "affiliatesOnline", icon: "👥",  label: "مسوقات متصلات", bg: "bg-violet-50",  fg: "text-violet-600", dot: true },
];

function CountUp({ value, suffix }) {
  const [d, setD] = useState(Number(value) || 0);
  const from = useRef(Number(value) || 0);
  const raf = useRef(0);
  useEffect(() => {
    const to = Number(value) || 0, start = from.current;
    if (start === to) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setD(to); from.current = to; return; }
    const t0 = performance.now(), dur = 700;
    cancelAnimationFrame(raf.current);
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      setD(Math.round(start + (to - start) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf.current = requestAnimationFrame(tick); else from.current = to;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return <>{d.toLocaleString("en-US")}{suffix || ""}</>;
}

const videosLabel = (n) => (n === 1 ? "فيديو واحد UGC" : `${n} ${n >= 3 && n <= 10 ? "فيديوهات" : "فيديو"} UGC`);
const salesLabel  = (n) => `${n} ${n >= 3 && n <= 10 ? "مبيعات" : "مبيعة"}`;

// Stable identity avatar: the person's real demo photo (same one as in the
// Monthly Competition). Initials are ONLY a fallback when the image is missing
// or fails to load — never a replacement for an existing avatar.
function Avatar({ ev }) {
  const [broken, setBroken] = useState(false);
  const showImg = !!ev.avatarUrl && !broken;
  return (
    <div className="relative shrink-0">
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ev.avatarUrl} alt="" loading="lazy" onError={() => setBroken(true)}
          className="w-11 h-11 rounded-full object-cover" />
      ) : (
        <div className="w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-black" style={{ background: ev.color || "#f43f5e" }}>
          {(ev.name || "?").slice(0, 1)}
        </div>
      )}
      <span className="absolute -bottom-1 -left-1 w-5 h-5 rounded-full bg-white shadow flex items-center justify-center text-[11px]">{ev.icon}</span>
    </div>
  );
}

function SimulatedBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-black">
      🧪 محاكاة
    </span>
  );
}

function ActivityRow({ ev, animate }) {
  const earned = (ev.type === "delivered" || ev.type === "commission") && ev.amount ? `ربحت ${ev.amount} درهم` : null;
  return (
    <div className={`flex items-start gap-3 bg-white rounded-2xl border border-gray-100 px-3.5 py-3 ${animate ? "animate-[laIn_0.45s_ease]" : ""}`}>
      <Avatar ev={ev} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-black text-gray-800 truncate">{ev.name}</p>
        {ev.type === "ugc" ? (
          <>
            <p className="text-xs text-gray-500">{videosLabel(ev.videos)}</p>
            <p className="text-xs text-gray-500">🛒 {salesLabel(ev.sales)}</p>
            <p className="text-xs text-gray-500">💰 ربحت {ev.earnings} درهم</p>
          </>
        ) : ev.type === "booster" ? (
          <>
            <p className="text-xs text-gray-500 truncate">{ev.activity}</p>
            <p className="text-xs text-violet-600 font-semibold">{ev.detail}</p>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-500 truncate">{ev.activity}</p>
            {earned ? <p className="text-xs text-green-600 font-semibold">{earned}</p>
              : ev.city ? <p className="text-xs text-gray-400 truncate">{ev.city}</p> : null}
          </>
        )}
      </div>
      <time
        dateTime={Number.isFinite(ev.at) ? new Date(ev.at).toISOString() : undefined}
        title={ev.clock ? `${ev.clock} (توقيت المغرب)` : undefined}
        className="text-[11px] text-gray-400 shrink-0 whitespace-nowrap">{ev.time}</time>
    </div>
  );
}

export default function LiveActivity({ pollMs = 4000, windowSize = 3, showViewAll = false, className = "" }) {
  const [data, setData] = useState(null); // { enabled, counters, events }
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let stopped = false, timer;
    const load = async () => {
      if (inFlight.current || document.visibilityState === "hidden") return;
      inFlight.current = true;
      try {
        const r = await fetch("/api/live-activity", { cache: "no-store" });
        const d = await r.json();
        if (!stopped) setData(d);
      } catch { /* keep last snapshot */ }
      finally { inFlight.current = false; }
    };
    load();
    timer = setInterval(load, pollMs);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [pollMs]);

  if (!data || !data.enabled) return null;
  const counters = data.counters || {};
  const events = Array.isArray(data.events) ? data.events : [];

  return (
    <div dir="rtl" className={`rounded-3xl bg-white border border-gray-100 shadow-lg shadow-gray-100/70 p-4 sm:p-6 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 text-green-600 text-[11px] font-black">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> LIVE
          </span>
          <h2 className="text-base sm:text-lg font-black text-gray-900">🔥 النشاط المباشر</h2>
          <SimulatedBadge />
        </div>
        {showViewAll && (
          <button type="button" onClick={() => setOpen(true)}
            className="text-xs font-bold text-gray-600 hover:text-gray-900 bg-gray-50 hover:bg-gray-100 rounded-xl px-3 py-1.5">
            عرض الكل ‹
          </button>
        )}
      </div>

      {/* Simulation disclosure — covers the counters and the feed below. */}
      <p data-live-activity-disclosure className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 mb-4">
        ⚠️ {LIVE_ACTIVITY_DISCLOSURE}
      </p>

      {/* Live counters */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
        {STAT_META.map((m) => (
          <div key={m.key} className="rounded-2xl bg-white border border-gray-100 shadow-sm px-3 py-3.5 text-center">
            <div className={`w-9 h-9 mx-auto rounded-full ${m.bg} ${m.fg} flex items-center justify-center text-base mb-1.5`}>{m.icon}</div>
            <p className="text-base font-black text-gray-900 tabular-nums">
              <CountUp value={counters[m.key] || 0} suffix={m.suffix} />
              {m.dot && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 ml-1 align-middle" />}
            </p>
            <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">{m.label}</p>
          </div>
        ))}
      </div>

      {/* Feed — compact (≈3–4 rows); full history lives in "عرض الكل" */}
      <p className="text-xs text-gray-400 mb-2">آخر الأنشطة التجريبية (محاكاة)</p>
      <div className="space-y-2.5">
        {events.slice(0, windowSize).map((ev, i) => <ActivityRow key={ev.id || i} ev={ev} animate={i === 0} />)}
        {events.length === 0 && <p className="text-center text-sm text-gray-400 py-6">المنصة نشيطة، الأنشطة غادي تبان دابا…</p>}
      </div>
      {showViewAll && events.length > windowSize && (
        <button type="button" onClick={() => setOpen(true)} className="w-full mt-2.5 text-xs font-bold text-gray-500 hover:text-gray-800 py-1.5">
          عرض الكل ({events.length}) ‹
        </button>
      )}

      {/* "عرض الكل" bottom sheet / modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div dir="rtl" className="relative w-full sm:max-w-md max-h-[80vh] bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col animate-[laUp_0.3s_ease]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">🔥 كل الأنشطة <SimulatedBadge /></h3>
              <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
            </div>
            <p className="text-[11px] font-semibold text-amber-800 bg-amber-50 px-5 py-2">⚠️ {LIVE_ACTIVITY_DISCLOSURE}</p>
            <div className="overflow-y-auto px-4 py-3 space-y-2.5">
              {events.map((ev, i) => <ActivityRow key={ev.id || i} ev={ev} animate={false} />)}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes laIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes laUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
      `}</style>
    </div>
  );
}
