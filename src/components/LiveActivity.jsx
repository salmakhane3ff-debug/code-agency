"use client";

/**
 * Shared "🔥 النشاط المباشر" / "Activité en direct" (Live Activity) card — used by BOTH the landing page
 * and the affiliate dashboard. It only READS the single server-side engine via
 * GET /api/live-activity (polled while the tab is visible). No localStorage, no
 * client-generated feed — both pages therefore stay perfectly in sync.
 *
 * UGC rows show ONLY: name, number of videos, total sales, total earnings
 * (earnings come from the server as sales × commissionPerSale). Never views,
 * likes, product names or city — per the UGC display rules.
 */
import { useEffect, useRef, useState } from "react";
import { useMarketLocale } from "@/context/useMarketLocale";
import { localizeLiveActivityEvent } from "@/lib/serverText/liveText";

// Only rendered inside market-scoped areas (affiliate dashboard, /tsajlim3ana): the card's own texts
// follow the visitor's market (MA Arabic RTL / FR French LTR). Event sentences (activity, detail,
// time, default name, city) arrive written in Darija by the server: for FR they are re-rendered at
// display time by src/lib/serverText/liveText.js (exact server templates only; MA shows them as received).
const LIVE_TEXT = Object.freeze({
  ar: Object.freeze({
    stat_todayOrders: "طلبات اليوم", stat_todayDelivered: "مسلمة اليوم", stat_todayCommissions: "عمولات اليوم", stat_affiliatesOnline: "مسوقات متصلات",
    title: "🔥 النشاط المباشر", view_all: "عرض الكل", subtitle: "أخر الأنشطة داخل المنصة لحظة بلحظة",
    empty: "المنصة نشيطة، الأنشطة غادي تبان دابا…", all_title: "🔥 كل الأنشطة", close: "إغلاق",
    earned: "ربحت {amount} درهم", ugc_one: "فيديو واحد UGC", ugc_few: "{n} فيديوهات UGC", ugc_many: "{n} فيديو UGC",
    sales_few: "{n} مبيعات", sales_many: "{n} مبيعة", currency_suffix: " درهم",
  }),
  fr: Object.freeze({
    stat_todayOrders: "Commandes du jour", stat_todayDelivered: "Livrées aujourd'hui", stat_todayCommissions: "Commissions du jour", stat_affiliatesOnline: "Affiliées en ligne",
    title: "🔥 Activité en direct", view_all: "Tout voir", subtitle: "Les dernières activités de la plateforme, en temps réel",
    empty: "La plateforme est active, les activités vont apparaître d'un instant à l'autre…", all_title: "🔥 Toutes les activités", close: "Fermer",
    earned: "A gagné {amount} DH", ugc_one: "1 vidéo UGC", ugc_few: "{n} vidéos UGC", ugc_many: "{n} vidéos UGC",
    sales_few: "{n} ventes", sales_many: "{n} ventes", currency_suffix: " DH",
  }),
});

const STAT_META = [
  { key: "todayOrders",      icon: "🛍️", bg: "bg-rose-50",    fg: "text-rose-500" },
  { key: "todayDelivered",   icon: "✅",  bg: "bg-green-50",   fg: "text-green-600" },
  { key: "todayCommissions", icon: "💰",  bg: "bg-amber-50",   fg: "text-amber-600", currency: true },
  { key: "affiliatesOnline", icon: "👥",  bg: "bg-violet-50",  fg: "text-violet-600", dot: true },
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

const videosLabel = (t, n) => (n === 1 ? t("ugc_one") : t(n >= 3 && n <= 10 ? "ugc_few" : "ugc_many", { n }));
const salesLabel  = (t, n) => t(n >= 3 && n <= 10 ? "sales_few" : "sales_many", { n });

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
      <span className="absolute -bottom-1 -end-1 w-5 h-5 rounded-full bg-white shadow flex items-center justify-center text-[11px]">{ev.icon}</span>
    </div>
  );
}

function ActivityRow({ ev, animate, t }) {
  const earned = (ev.type === "delivered" || ev.type === "commission") && ev.amount ? t("earned", { amount: ev.amount }) : null;
  return (
    <div className={`flex items-start gap-3 bg-white rounded-2xl border border-gray-100 px-3.5 py-3 ${animate ? "animate-[laIn_0.45s_ease]" : ""}`}>
      <Avatar ev={ev} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-black text-gray-800 truncate">{ev.name}</p>
        {ev.type === "ugc" ? (
          <>
            <p className="text-xs text-gray-500">{videosLabel(t, ev.videos)}</p>
            <p className="text-xs text-gray-500">🛒 {salesLabel(t, ev.sales)}</p>
            <p className="text-xs text-gray-500">💰 {t("earned", { amount: ev.earnings })}</p>
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
      <span className="text-[11px] text-gray-400 shrink-0 whitespace-nowrap">{ev.time}</span>
    </div>
  );
}

export default function LiveActivity({ pollMs = 4000, windowSize = 3, showViewAll = false, className = "" }) {
  const { t, dir, lang } = useMarketLocale(LIVE_TEXT);
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
  // Server-written Darija sentences → visitor's market (FR only; MA = exactly as received).
  const events = (Array.isArray(data.events) ? data.events : []).map((ev) => localizeLiveActivityEvent(ev, lang));

  return (
    <div dir={dir} className={`rounded-3xl bg-white border border-gray-100 shadow-lg shadow-gray-100/70 p-4 sm:p-6 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 text-green-600 text-[11px] font-black">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> LIVE
          </span>
          <h2 className="text-base sm:text-lg font-black text-gray-900">{t("title")}</h2>
        </div>
        {showViewAll && (
          <button type="button" onClick={() => setOpen(true)}
            className="text-xs font-bold text-gray-600 hover:text-gray-900 bg-gray-50 hover:bg-gray-100 rounded-xl px-3 py-1.5">
            {t("view_all")} <span className="inline-block rtl:rotate-0 ltr:rotate-180" aria-hidden="true">‹</span>
          </button>
        )}
      </div>

      {/* Live counters */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
        {STAT_META.map((m) => (
          <div key={m.key} className="rounded-2xl bg-white border border-gray-100 shadow-sm px-3 py-3.5 text-center">
            <div className={`w-9 h-9 mx-auto rounded-full ${m.bg} ${m.fg} flex items-center justify-center text-base mb-1.5`}>{m.icon}</div>
            <p className="text-base font-black text-gray-900 tabular-nums">
              <CountUp value={counters[m.key] || 0} suffix={m.currency ? t("currency_suffix") : ""} />
              {m.dot && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 ms-1 align-middle" />}
            </p>
            <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">{t(`stat_${m.key}`)}</p>
          </div>
        ))}
      </div>

      {/* Feed — compact (≈3–4 rows); full history lives in "عرض الكل" */}
      <p className="text-xs text-gray-400 mb-2">{t("subtitle")}</p>
      <div className="space-y-2.5">
        {events.slice(0, windowSize).map((ev, i) => <ActivityRow key={ev.id || i} ev={ev} animate={i === 0} t={t} />)}
        {events.length === 0 && <p className="text-center text-sm text-gray-400 py-6">{t("empty")}</p>}
      </div>
      {showViewAll && events.length > windowSize && (
        <button type="button" onClick={() => setOpen(true)} className="w-full mt-2.5 text-xs font-bold text-gray-500 hover:text-gray-800 py-1.5">
          {t("view_all")} (<span dir="ltr">{events.length}</span>) <span className="inline-block rtl:rotate-0 ltr:rotate-180" aria-hidden="true">‹</span>
        </button>
      )}

      {/* "عرض الكل" bottom sheet / modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div dir={dir} className="relative w-full sm:max-w-md max-h-[80vh] bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col animate-[laUp_0.3s_ease]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-black text-gray-900">{t("all_title")}</h3>
              <button type="button" onClick={() => setOpen(false)} aria-label={t("close")} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
            </div>
            <div className="overflow-y-auto px-4 py-3 space-y-2.5">
              {events.map((ev, i) => <ActivityRow key={ev.id || i} ev={ev} animate={false} t={t} />)}
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
