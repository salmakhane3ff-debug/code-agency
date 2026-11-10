"use client";

/**
 * src/app/tsajlim3ana/RecruitmentLanding.jsx
 * Public affiliate-recruitment landing (mobile-first). Follows the visitor's
 * market: MA → Moroccan Darija / RTL, FR → French / LTR (src/lib/landingI18n.js).
 * Admin-configured copy is shown as authored; only its built-in defaults (when the
 * admin left a field untouched) and the hard-coded chrome are translated.
 * CTAs: "تسجيل الدخول" → /affiliate/dashboard; join CTAs → support WhatsApp
 * (resolved server-side into `whatsappLink`, disabled gracefully when missing).
 * Sections follow the required order; competition + live feed reuse public
 * cached endpoints; stats come from the server (real, cached). No guaranteed
 * income; UGC/team framed as optional/level-based.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import {
  GraduationCap, Truck, ShoppingBag, Wallet, Phone, Video, Gift, Megaphone,
  CheckCircle, LayoutDashboard, LineChart, Headphones, ChevronLeft, ChevronRight,
  Star, ChevronDown, MessageCircle, Users, Trophy, PackageCheck, X,
} from "lucide-react";
import {
  publicVideos, publicTestimonials, maskSurname,
  DEFAULT_CONFIRMATION_BENEFITS, LIVE_FEED_NEUTRAL,
} from "@/lib/recruitmentCta";
import LiveActivity from "@/components/LiveActivity";
import { useMarketLocale, useMarketPaintGate } from "@/context/useMarketLocale";
import { LANDING_TEXT } from "@/lib/landingI18n";
import { localizeLiveFeedText } from "@/lib/serverText/liveText";

const useRlT = () => useMarketLocale(LANDING_TEXT);

// Admin-configurable copy: shown exactly as authored. When the value is still the
// built-in Arabic default (byte-identical — the admin never authored it), show the
// market's version of that default instead.
function authoredOr(t, value, key) {
  return value === LANDING_TEXT.ar[key] ? t(key) : value;
}
// Same idea for list items / messages that come from a default array.
function defaultItemOr(t, value, defaults, keyPrefix) {
  const idx = defaults.indexOf(value);
  return idx >= 0 && LANDING_TEXT.ar[`${keyPrefix}${idx}`] === value ? t(`${keyPrefix}${idx}`) : value;
}

function track(event) {
  try {
    fetch("/api/tsajlim3ana/track", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, source: "tsajlim3ana" }), keepalive: true,
    }).catch(() => {});
  } catch {}
}

// Fire `event` once when the ref enters the viewport.
function useSectionView(event) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { track(event); io.disconnect(); }
    }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [event]);
  return ref;
}

// Count-up on viewport entry; respects prefers-reduced-motion.
function useCountUp(target) {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      if (reduce || target <= 0) { setVal(target); return; }
      const dur = 1200, t0 = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [target]);
  return [val, ref];
}

// Tween a number smoothly from its PREVIOUS displayed value to the latest value
// received (used by the live competition board). No random/independent motion —
// it only ever animates between the old value and the new API value.
function CountUpNumber({ value }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(value) || 0;
    if (from === to) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setDisplay(to); fromRef.current = to; return; }
    const dur = 800, t0 = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);
  return <>{display.toLocaleString("en-US")}</>;
}

const CTA_PRIMARY =
  "inline-flex items-center justify-center gap-2 px-8 py-4 bg-rose-500 hover:bg-rose-600 active:scale-[0.98] text-white rounded-2xl font-black text-base shadow-lg shadow-rose-200 border-2 border-transparent transition-all";

// Secondary CTA — white with a colored border, matching the primary's height.
// Navigates directly to the public store homepage (same tab, same domain).
const CTA_SECONDARY =
  "inline-flex items-center justify-center gap-2 px-8 py-4 bg-white hover:bg-rose-50 active:scale-[0.98] text-rose-600 rounded-2xl font-black text-base shadow-sm border-2 border-rose-500 transition-all";

function JoinCta({ link, event = "hero_whatsapp_click", className = "", children }) {
  const { t } = useRlT();
  if (!link) {
    return (
      <div className="text-center">
        <button disabled className={`opacity-60 cursor-not-allowed ${className}`}>{children}</button>
        <p className="text-xs text-gray-400 mt-2">{t("rl_support_unavailable")}</p>
      </div>
    );
  }
  return (
    <a href={link} target="_blank" rel="noopener noreferrer" onClick={() => track(event)} className={className}>
      {children}
    </a>
  );
}

function SectionTitle({ children }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-6">
      <span className="h-0.5 w-8 bg-rose-300 rounded-full" />
      <h2 className="text-xl sm:text-2xl font-black text-gray-900 text-center">{children}</h2>
      <span className="h-0.5 w-8 bg-rose-300 rounded-full" />
    </div>
  );
}

function Faq({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-2xl border border-gray-100">
      <button onClick={() => { setOpen((o) => !o); if (!open) track("faq_open"); }} className="w-full flex items-center justify-between gap-3 px-5 py-4 text-start">
        <span className="text-sm font-bold text-gray-800">{q}</span>
        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <p className="px-5 pb-4 text-sm text-gray-500 leading-relaxed">{a}</p>}
    </div>
  );
}

// ── Video slider (TikTok-style) ────────────────────────────────────────────────
function VideoSlider({ videos }) {
  const { t, dir } = useRlT();
  const scrollerRef = useRef(null);
  const videoRefs = useRef([]);
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.6) { e.target.play?.().catch(() => {}); track("video_play"); }
        else e.target.pause?.();
      }
    }, { threshold: [0, 0.6, 1] });
    videoRefs.current.forEach((v) => v && io.observe(v));
    return () => io.disconnect();
  }, [videos]);
  const scrollBy = (dir) => scrollerRef.current?.scrollBy({ left: dir * Math.round(scrollerRef.current.clientWidth * 0.75), behavior: "smooth" });
  return (
    <div className="relative">
      {/* Previous on the inline START side, Next on the END side; chevrons point outward in both directions. */}
      <button onClick={() => scrollBy(-1)} aria-label={t("common_prev")} className="hidden md:flex absolute start-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-white shadow-md items-center justify-center text-gray-600 hover:text-rose-500">{dir === "rtl" ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}</button>
      <button onClick={() => scrollBy(1)} aria-label={t("common_next")} className="hidden md:flex absolute end-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-white shadow-md items-center justify-center text-gray-600 hover:text-rose-500">{dir === "rtl" ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}</button>
      <div ref={scrollerRef} className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-3 px-1" style={{ scrollbarWidth: "none" }}>
        {videos.map((v, i) => (
          <div key={v.id} className="snap-center shrink-0 w-[72%] sm:w-56 rounded-2xl overflow-hidden bg-black relative">
            <video ref={(el) => (videoRefs.current[i] = el)} src={v.url} poster={v.thumbnail || undefined}
              className="w-full aspect-[9/16] object-cover" muted loop playsInline preload="none" />
            {v.title && <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-2.5"><p className="text-white text-xs font-semibold line-clamp-1">{v.title}</p></div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Competition ────────────────────────────────────────────────────────────────
// Reuses the EXACT same source as the dashboard / admin demo competition
// (/api/demo/leaderboard → demoService). When the admin "Simuler activité" runs,
// that source is updated + its cache invalidated, so polling here reflects the
// growing simulated totals automatically — no separate/random client-side data.
// Polling runs only while the section is on screen AND the tab is visible, with
// an in-flight guard so requests never overlap.
const COMPETITION_POLL_MS = 7000;

function CompetitionSection({ whatsappLink }) {
  const { t } = useRlT();
  const ref = useSectionView("competition_section_view");
  const [state, setState] = useState({ loading: true, rows: [], error: false });
  const inViewRef  = useRef(false);
  const inFlightRef = useRef(false);
  const timerRef   = useRef(null);

  const fetchBoard = useCallback(async () => {
    if (inFlightRef.current) return;            // avoid duplicate/overlapping polls
    inFlightRef.current = true;
    try {
      const r = await fetch("/api/demo/leaderboard?limit=10", { cache: "no-store" });
      const d = await r.json();
      const rows = Array.isArray(d?.leaderboard) ? d.leaderboard : [];
      setState({ loading: false, rows, error: false });
    } catch {
      setState((s) => ({ loading: false, rows: s.rows, error: true }));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const start = () => {
      if (timerRef.current) return;
      fetchBoard();                             // immediate refresh on (re)activation
      timerRef.current = setInterval(fetchBoard, COMPETITION_POLL_MS);
    };
    const stop = () => { clearInterval(timerRef.current); timerRef.current = null; };
    const evaluate = () => {
      const active = inViewRef.current && document.visibilityState === "visible";
      if (active) start(); else stop();         // pause off-screen or when tab hidden
    };

    const io = new IntersectionObserver((entries) => {
      inViewRef.current = entries.some((e) => e.isIntersecting);
      evaluate();
    }, { threshold: 0.15 });
    io.observe(el);
    document.addEventListener("visibilitychange", evaluate);

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", evaluate);
      stop();
    };
  }, [fetchBoard, ref]);

  return (
    <section ref={ref} id="competition" className="bg-rose-50/50">
      <div className="max-w-5xl mx-auto px-4 py-10">
        <SectionTitle>{t("rl_comp_title")}</SectionTitle>
        <p className="text-center text-sm text-gray-500 -mt-3 mb-6">{t("rl_comp_subtitle")}</p>
        {state.loading ? (
          <div className="flex justify-center py-8"><div className="w-6 h-6 border-2 border-rose-300 border-t-transparent rounded-full animate-spin" /></div>
        ) : state.rows.length === 0 ? (
          <p className="text-center text-sm text-gray-400">{t("rl_comp_empty")}</p>
        ) : (
          <div className="max-w-md mx-auto space-y-2">
            {state.rows.slice(0, 10).map((m, i) => {
              const rank = m.rank || i + 1;
              return (
                <div key={m.id || i} className="flex items-center gap-3 bg-white rounded-2xl border border-gray-100 px-4 py-2.5 transition-all duration-500">
                  <span className={`w-6 text-center font-black ${rank <= 3 ? "text-rose-500" : "text-gray-400"}`}>{rank}</span>
                  {m.avatarUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={m.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover" loading="lazy" />
                    : <span className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold" style={{ background: m.avatarColor || "#f43f5e" }}>{(m.name || "?")[0]}</span>}
                  <span className="flex-1 text-sm font-semibold text-gray-800 truncate">{maskSurname(m.name)}</span>
                  <span className="text-xs text-gray-500 shrink-0 tabular-nums"><bdi dir="ltr"><CountUpNumber value={m.totalOrders ?? 0} /></bdi> {t("rl_comp_orders_unit")}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="text-center mt-6">
          <JoinCta link={whatsappLink} event="competition_section_view" className={CTA_PRIMARY}>{t("rl_comp_cta")}</JoinCta>
        </div>
      </div>
    </section>
  );
}

// ── Statistics (real, animated on view) ────────────────────────────────────────
function StatItem({ value, label }) {
  const [v, ref] = useCountUp(value);
  return (
    <div ref={ref} className="rounded-2xl bg-white border border-gray-100 p-5 text-center">
      <p className="text-3xl font-black text-rose-500" dir="ltr">{v.toLocaleString("fr-FR")}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}
function StatisticsSection({ stats, counters }) {
  const { t } = useRlT();
  const items = [
    { key: "members",          label: t("rl_stat_members"),          value: stats?.members },
    { key: "activeAffiliates", label: t("rl_stat_activeAffiliates"), value: stats?.activeAffiliates },
    { key: "confirmedOrders",  label: t("rl_stat_confirmedOrders"),  value: stats?.confirmedOrders },
    { key: "successfulOrders", label: t("rl_stat_successfulOrders"), value: stats?.successfulOrders },
    { key: "ugcApproved",      label: t("rl_stat_ugcApproved"),      value: stats?.ugcApproved },
    { key: "activeTeams",      label: t("rl_stat_activeTeams"),      value: stats?.activeTeams },
  ].filter((s) => counters?.[s.key] && Number(s.value) > 0); // real, non-zero, admin-enabled
  if (!items.length) return null;
  return (
    <section className="max-w-5xl mx-auto px-4 py-10">
      <SectionTitle>{t("rl_stats_title")}</SectionTitle>
      <div className={`grid grid-cols-2 ${items.length >= 3 ? "sm:grid-cols-3" : ""} gap-3`}>
        {items.map((s) => <StatItem key={s.key} value={Number(s.value)} label={s.label} />)}
      </div>
    </section>
  );
}

// ── Live activity feed (floating) ──────────────────────────────────────────────
const FEED_DISMISS_KEY = "tsajlim_feed_dismissed";
function LiveFeed() {
  const { t, lang } = useRlT();
  const [data, setData] = useState(null); // { enabled, events, config }
  const [current, setCurrent] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const idxRef = useRef(-1);
  const timers = useRef([]);

  useEffect(() => {
    try { if (sessionStorage.getItem(FEED_DISMISS_KEY) === "1") { setDismissed(true); return; } } catch {}
    fetch("/api/tsajlim3ana/live-feed").then((r) => r.json()).then((d) => setData(d)).catch(() => {});
  }, []);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  useEffect(() => {
    if (dismissed || !data?.enabled || !data.events?.length) return;
    const cfg = data.config || {};
    const minMs = Math.max(15, cfg.minInterval || 30) * 1000;
    const maxMs = Math.max(minMs, (cfg.maxInterval || 60) * 1000);
    const showMs = Math.max(2, cfg.displayDuration || 5) * 1000;
    let stopped = false;

    const showNext = () => {
      if (stopped || document.visibilityState === "hidden") { // paused when tab inactive
        timers.current.push(setTimeout(showNext, 5000));
        return;
      }
      let next = idxRef.current;
      // never repeat the same notification consecutively
      if (data.events.length === 1) next = 0;
      else { do { next = Math.floor(Math.random() * data.events.length); } while (next === idxRef.current); }
      idxRef.current = next;
      setCurrent(data.events[next]);
      track("live_feed_impression");
      timers.current.push(setTimeout(() => {
        setCurrent(null);
        const gap = minMs + Math.random() * (maxMs - minMs);
        timers.current.push(setTimeout(showNext, gap));
      }, showMs));
    };

    // first notification only after ≥10s
    timers.current.push(setTimeout(showNext, Math.max(10000, minMs)));
    const onVis = () => {}; // showNext already checks visibility each cycle
    document.addEventListener("visibilitychange", onVis);
    return () => { stopped = true; clearTimers(); document.removeEventListener("visibilitychange", onVis); };
  }, [data, dismissed]);

  const close = () => {
    setDismissed(true); setCurrent(null); clearTimers();
    try { sessionStorage.setItem(FEED_DISMISS_KEY, "1"); } catch {}
    track("live_feed_close");
  };

  if (dismissed || !current) return null;
  return (
    <div className="fixed bottom-4 inset-x-0 z-40 flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto max-w-sm w-full bg-white rounded-2xl shadow-xl border border-gray-100 px-4 py-3 flex items-center gap-3 animate-[fadeInUp_0.35s_ease]">
        <div className="w-8 h-8 rounded-full bg-rose-100 flex items-center justify-center text-rose-500 shrink-0"><Trophy className="w-4 h-4" /></div>
        {/* Neutral platform messages are translated; real-activity sentences arrive pre-formatted (Darija) from the API
            (formatLiveFeedEvent) and are re-rendered for FR by src/lib/serverText/liveText.js — MA shows them as received. */}
        <p className="flex-1 text-xs font-semibold text-gray-700 leading-snug">{current.type === "neutral" ? defaultItemOr(t, current.text, LIVE_FEED_NEUTRAL, "rl_feed_neutral_") : localizeLiveFeedText(current.text, current.type, lang)}</p>
        <button onClick={close} aria-label={t("common_close")} className="text-gray-300 hover:text-gray-500 shrink-0"><X className="w-4 h-4" /></button>
      </div>
      <style>{`@keyframes fadeInUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// ── Referral link explainer (how the affiliate link works) ─────────────────────
// Texts live in src/lib/landingI18n.js (keys below); only icons/colors stay here.
const REFERRAL_STEPS = [
  { icon: "📋", title: "rl_ref_step1_title", text: "rl_ref_step1_text", color: "bg-rose-50 border-rose-100" },
  { icon: "📲", title: "rl_ref_step2_title", text: "rl_ref_step2_text", color: "bg-sky-50 border-sky-100" },
  { icon: "🛒", title: "rl_ref_step3_title", text: "rl_ref_step3_text", color: "bg-amber-50 border-amber-100" },
  { icon: "📞", title: "rl_ref_step4_title", text: "rl_ref_step4_text", color: "bg-violet-50 border-violet-100" },
  { icon: "💰", title: "rl_ref_step5_title", text: "rl_ref_step5_text", color: "bg-emerald-50 border-emerald-100" },
];

const REFERRAL_TIMELINE = [
  { t: "rl_tl_signup",     c: "bg-rose-500" },
  { t: "rl_tl_link",       c: "bg-sky-500" },
  { t: "rl_tl_order",      c: "bg-amber-500" },
  { t: "rl_tl_confirm",    c: "bg-violet-500" },
  { t: "rl_tl_delivery",   c: "bg-indigo-500" },
  { t: "rl_tl_commission", c: "bg-emerald-500" },
];

function ReferralHowItWorks() {
  const { t } = useRlT();
  return (
    <section id="referral" className="bg-white scroll-mt-16">
      <div className="max-w-5xl mx-auto px-4 py-10">
        <SectionTitle>{t("rl_ref_title")}</SectionTitle>
        <p className="text-center text-sm text-gray-500 -mt-3 mb-6 max-w-2xl mx-auto">
          {t("rl_ref_subtitle")}
        </p>

        {/* 5 illustrated cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {REFERRAL_STEPS.map((s) => (
            <div key={s.title} className={`rounded-2xl border ${s.color} p-5 flex flex-col items-center text-center`}>
              <div className="w-14 h-14 rounded-2xl bg-white shadow-sm flex items-center justify-center text-3xl mb-3">{s.icon}</div>
              <p className="text-sm font-black text-gray-900 mb-1">{t(s.title)}</p>
              <p className="text-xs text-gray-600 leading-relaxed">{t(s.text)}</p>
            </div>
          ))}
        </div>

        {/* Important note */}
        <div className="mt-6 max-w-2xl mx-auto rounded-2xl bg-amber-50 border border-amber-200 px-5 py-4 text-center">
          <p className="text-sm font-black text-amber-800 mb-1">{t("rl_ref_note_title")}</p>
          <p className="text-sm text-amber-800 leading-relaxed">
            {t("rl_ref_note_1")}<br />
            {t("rl_ref_note_2")}
          </p>
        </div>

        {/* Visual flow timeline */}
        <div className="mt-8 flex flex-col items-center">
          {REFERRAL_TIMELINE.map((step, i) => (
            <div key={step.t} className="flex flex-col items-center w-full max-w-xs">
              <div className={`w-full text-center ${step.c} text-white rounded-2xl px-5 py-3 text-sm font-bold shadow-sm`}>{t(step.t)}</div>
              {i < REFERRAL_TIMELINE.length - 1 && <ChevronDown className="w-5 h-5 text-gray-300 my-1.5" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────────
export default function RecruitmentLanding({ config, whatsappLink, stats, teamRange }) {
  const videos = publicVideos(config);
  const testimonials = publicTestimonials(config);
  const { hero, confirmation, ugc, team, competition, statistics, liveActivity } = config;
  const { t, dir, lang } = useRlT();
  useMarketPaintGate(); // first paint: lift the market gate once rendered in the visitor's market

  const confRef = useSectionView("confirmation_section_view");
  const ugcRef = useSectionView("ugc_section_view");
  const teamRef = useSectionView("team_section_view");
  const testiRef = useSectionView("testimonial_view");

  return (
    <div dir={dir} lang={lang} data-market-scope={lang} className="min-h-screen bg-white text-gray-900">
      {/* 1. Sticky header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <span className="font-black text-rose-500 tracking-tight">COD <span className="text-gray-900">AFFILIÉ</span></span>
          <nav className="hidden md:flex items-center gap-5 text-sm text-gray-600">
            <a href="#hero" className="hover:text-rose-500">{t("rl_nav_home")}</a>
            <a href="#how" className="hover:text-rose-500">{t("rl_nav_how")}</a>
            <a href="#competition" className="hover:text-rose-500">{t("rl_nav_competition")}</a>
            <a href="#faq" className="hover:text-rose-500">{t("rl_nav_faq")}</a>
          </nav>
          <div className="flex items-center gap-2">
            <a href="/affiliate/dashboard" onClick={() => track("header_login_click")}
              className="text-sm font-semibold text-gray-700 hover:text-rose-500 px-2">{t("rl_login")}</a>
            <JoinCta link={whatsappLink} className="inline-flex items-center gap-1.5 px-4 py-2 bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-bold shadow-sm">{t("rl_join")}</JoinCta>
          </div>
        </div>
      </header>

      {/* 2. Hero */}
      <section id="hero" className="bg-gradient-to-b from-rose-50 to-white">
        <div className="max-w-5xl mx-auto px-4 py-10 grid md:grid-cols-2 gap-8 items-center">
          <div>
            <h1 className="text-3xl sm:text-4xl font-black leading-tight">{authoredOr(t, hero.title, "rl_default_hero_title")}</h1>
            <p className="text-gray-600 mt-3 leading-relaxed">{authoredOr(t, hero.subtitle, "rl_default_hero_subtitle")}</p>
            <div className="grid grid-cols-5 gap-1.5 my-6 max-w-md">
              {[
                { icon: GraduationCap, k: "rl_badge_capital" },
                { icon: ShoppingBag, k: "rl_badge_purchase" },
                { icon: PackageCheck, k: "rl_badge_stock" },
                { icon: Truck, k: "rl_badge_delivery" },
                { icon: Wallet, k: "rl_badge_experience" },
              ].map(({ icon: I, k }) => (
                <div key={k} className="flex flex-col items-center gap-1.5 text-center">
                  <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center text-rose-500"><I className="w-4 h-4" /></div>
                  <span className="text-[10px] text-gray-600 font-medium leading-tight">{t(k)}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <JoinCta link={whatsappLink} className={CTA_PRIMARY}>{t("rl_join")}</JoinCta>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full navigation to the store home, unchanged */}
              <a href="/" className={CTA_SECONDARY}>
                <span className="text-lg leading-none">📦</span> {t("rl_our_products")}
              </a>
            </div>
            <p className="text-xs text-gray-400 mt-3 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-green-500" /> {t("rl_free_signup")}</p>
          </div>
          <div className="relative w-full aspect-[4/3] rounded-3xl overflow-hidden bg-rose-100/60">
            {hero.image ? (
              <Image src={hero.image} alt={t("rl_hero_img_alt")} fill priority unoptimized sizes="(max-width:768px) 100vw, 480px" className="object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-rose-300"><Phone className="w-20 h-20" /></div>
            )}
          </div>
        </div>
      </section>

      {/* 3. Strong clarification */}
      <section className="max-w-5xl mx-auto px-4 -mt-2">
        <div className="rounded-2xl bg-gray-900 text-white px-5 py-4 text-center">
          <p className="text-sm sm:text-base font-black">{t("rl_clarify")}</p>
          <p className="text-xs text-gray-300 mt-1">{authoredOr(t, confirmation.title, "rl_default_confirmation_title")}</p>
        </div>
      </section>

      {/* 4. Target audience */}
      <section className="max-w-5xl mx-auto px-4 py-10">
        <SectionTitle>{t("rl_audience_title")}</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { icon: "🏠", k: "rl_audience_housewife" },
            { icon: "👶", k: "rl_audience_kids" },
            { icon: "🎓", k: "rl_audience_student" },
            { icon: "💁‍♀️", k: "rl_audience_unemployed" },
            { icon: "💰", k: "rl_audience_extra" },
          ].map(({ icon, k }) => (
            <div key={k} className="rounded-2xl border border-gray-100 bg-white p-4 text-center">
              <div className="text-3xl mb-2">{icon}</div>
              <p className="text-sm font-bold text-gray-800">{t(k)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 5. How confirmation works */}
      <section id="how" ref={confRef} className="bg-rose-50/50">
        <div className="max-w-5xl mx-auto px-4 py-10">
          <SectionTitle>{t("rl_how_title")}</SectionTitle>
          <ol className="max-w-2xl mx-auto space-y-3">
            {[
              t("rl_how_1"),
              t("rl_how_2"),
              t("rl_how_3"),
              t("rl_how_4"),
              t("rl_how_5"),
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-3 bg-white rounded-2xl border border-gray-100 px-4 py-3">
                <span className="w-6 h-6 rounded-full bg-rose-500 text-white text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                <span className="text-sm text-gray-700">{step}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4 max-w-2xl mx-auto rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-center">
            <p className="text-sm font-semibold text-amber-800">{t("rl_how_note")}</p>
          </div>
        </div>
      </section>

      {/* 5b. How the referral link works */}
      <ReferralHowItWorks />

      {/* 5c. Live activity (🔥 النشاط المباشر) — shared server-side engine */}
      {liveActivity?.enabled && (
        <section id="live-activity" className="max-w-5xl mx-auto px-4 py-10">
          <LiveActivity windowSize={4} showViewAll />
        </section>
      )}

      {/* 6. Benefits */}
      <section className="max-w-5xl mx-auto px-4 py-10">
        <SectionTitle>{t("rl_benefits_title")}</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {confirmation.benefits.map((b, i) => {
            const Icon = [ShoppingBag, Users, Megaphone, PackageCheck, Truck, Headphones, LayoutDashboard, LineChart, CheckCircle][i % 9];
            return (
              <div key={i} className="rounded-2xl border border-gray-100 bg-white p-4 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-rose-50 flex items-center justify-center text-rose-500 shrink-0"><Icon className="w-4 h-4" /></div>
                <p className="text-sm font-semibold text-gray-800">{defaultItemOr(t, b, DEFAULT_CONFIRMATION_BENEFITS, "rl_benefit_")}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* 7. UGC optional */}
      {ugc.enabled && (
        <section ref={ugcRef} className="bg-rose-50/50">
          <div className="max-w-5xl mx-auto px-4 py-10">
            <div className="flex items-center justify-center gap-2 mb-2">
              <span className="px-3 py-1 rounded-full bg-rose-500 text-white text-xs font-black">{t("rl_ugc_badge")}</span>
            </div>
            <SectionTitle>{authoredOr(t, ugc.title, "rl_default_ugc_title")}</SectionTitle>
            <p className="text-center text-sm text-gray-500 -mt-3 mb-6 max-w-2xl mx-auto">{authoredOr(t, ugc.description, "rl_default_ugc_description")}</p>
            <div className="grid md:grid-cols-2 gap-4">
              <ol className="space-y-2">
                {[
                  t("rl_ugc_1"),
                  t("rl_ugc_2"),
                  t("rl_ugc_3"),
                  t("rl_ugc_4"),
                  t("rl_ugc_5"),
                ].map((s, i) => (
                  <li key={i} className="flex items-start gap-3 bg-white rounded-2xl border border-gray-100 px-4 py-2.5">
                    <span className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="text-sm text-gray-700">{s}</span>
                  </li>
                ))}
              </ol>
              <div className="space-y-3">
                <div className="rounded-2xl bg-gray-900 text-white p-5 text-center">
                  <p className="text-xs opacity-70 mb-1">{t("rl_ugc_commission_label")}</p>
                  <p className="text-2xl font-black">{t("rl_ugc_commission_range", { min: ugc.minCommission, max: ugc.maxCommission })}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded-2xl bg-white border border-gray-100 p-3">
                    <p className="font-black text-gray-800 mb-1">{t("rl_cmp_confirm_title")}</p>
                    <ul className="text-gray-500 space-y-1"><li>• {t("rl_cmp_confirm_1")}</li><li>• {t("rl_cmp_confirm_2")}</li><li>• {t("rl_cmp_confirm_3")}</li></ul>
                  </div>
                  <div className="rounded-2xl bg-white border border-rose-100 p-3">
                    <p className="font-black text-rose-600 mb-1">UGC</p>
                    <ul className="text-gray-500 space-y-1"><li>• {t("rl_cmp_ugc_1")}</li><li>• {t("rl_cmp_ugc_2")}</li><li>• {t("rl_cmp_ugc_3")}</li></ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 8. Team building */}
      {team.enabled && (
        <section ref={teamRef} className="max-w-5xl mx-auto px-4 py-10">
          <SectionTitle>{authoredOr(t, team.title, "rl_default_team_title")}</SectionTitle>
          <p className="text-center text-sm text-gray-500 -mt-3 mb-6 max-w-2xl mx-auto">{authoredOr(t, team.description, "rl_default_team_description")}</p>
          <div className="grid md:grid-cols-2 gap-4 max-w-3xl mx-auto">
            <div className="rounded-2xl bg-white border border-gray-100 p-5">
              <div className="w-10 h-10 rounded-full bg-rose-50 flex items-center justify-center text-rose-500 mb-3"><Users className="w-5 h-5" /></div>
              <ul className="text-sm text-gray-600 space-y-2">
                <li>• {t("rl_team_1")}</li>
                <li>• {t("rl_team_2")}</li>
                <li>• {t("rl_team_3")}</li>
              </ul>
              {teamRange && (
                <p className="text-xs text-gray-700 mt-3 bg-rose-50 rounded-lg px-3 py-2 font-semibold">
                  {t("rl_team_range", { min: teamRange.min, max: teamRange.max })}
                </p>
              )}
            </div>
            <div className="rounded-2xl bg-rose-50 border border-rose-100 p-5">
              <p className="text-xs font-black text-rose-600 mb-2">{t("rl_team_example_title")}</p>
              <p className="text-sm text-gray-700 leading-relaxed">{t("rl_team_example_text")}</p>
              <p className="text-[11px] text-gray-400 mt-3">{t("rl_team_example_note")}</p>
            </div>
          </div>
        </section>
      )}

      {/* 9. Competition du mois */}
      {competition.enabled && <CompetitionSection whatsappLink={whatsappLink} />}

      {/* 10. Statistics */}
      {statistics.enabled && stats && <StatisticsSection stats={stats} counters={statistics.counters} />}

      {/* 11. Videos */}
      {videos.length > 0 && (
        <section className="max-w-5xl mx-auto px-4 py-10">
          <SectionTitle>{t("rl_videos_title")}</SectionTitle>
          <VideoSlider videos={videos} />
        </section>
      )}

      {/* 12. Testimonials */}
      {testimonials.length > 0 && (
        <section id="avis" ref={testiRef} className="bg-rose-50/50">
          <div className="max-w-5xl mx-auto px-4 py-10">
            <SectionTitle>{t("rl_testimonials_title")}</SectionTitle>
            <div className="grid md:grid-cols-3 gap-3">
              {testimonials.map((tm) => (
                <div key={tm.id} className="rounded-2xl bg-white border border-gray-100 p-5">
                  <div className="flex gap-0.5 mb-2">{Array.from({ length: tm.rating }).map((_, i) => <Star key={i} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />)}</div>
                  <p className="text-sm text-gray-600 leading-relaxed">{tm.text}</p>
                  {tm.name && <p className="text-xs font-bold text-gray-800 mt-3">{tm.name}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 13. FAQ */}
      <section id="faq" className="max-w-5xl mx-auto px-4 py-10">
        <SectionTitle>{t("rl_faq_title")}</SectionTitle>
        <div className="max-w-2xl mx-auto space-y-2.5">
          {[
            { id: "faq1", q: t("rl_faq_1_q"), a: t("rl_faq_1_a") },
            { id: "faq2", q: t("rl_faq_2_q"), a: t("rl_faq_2_a") },
            { id: "faq3", q: t("rl_faq_3_q"), a: t("rl_faq_3_a") },
            { id: "faq4", q: t("rl_faq_4_q"), a: t("rl_faq_4_a") },
            { id: "faq5", q: t("rl_faq_5_q"), a: t("rl_faq_5_a") },
          ].map((f) => <Faq key={f.id} q={f.q} a={f.a} />)}
        </div>
      </section>

      {/* 14. Final CTA */}
      <section className="bg-rose-500">
        <div className="max-w-5xl mx-auto px-4 py-10 text-center">
          <h2 className="text-2xl font-black text-white mb-2">{t("rl_final_title")}</h2>
          <p className="text-rose-50 text-sm mb-6 leading-relaxed">{t("rl_final_text")}</p>
          <JoinCta link={whatsappLink} event="final_whatsapp_click"
            className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-white text-rose-600 rounded-2xl font-black text-base shadow-lg hover:bg-rose-50 active:scale-[0.98] transition-all">
            <MessageCircle className="w-5 h-5" /> {t("rl_join_now")}
          </JoinCta>
        </div>
      </section>

      {/* 15. Live activity feed (floating) */}
      <LiveFeed />
    </div>
  );
}

// Shown by the server page when the admin disabled the landing (no landing
// content is sent). Client-side only so it can follow the visitor's market.
export function RecruitmentUnavailable() {
  const { t, dir, lang } = useRlT();
  useMarketPaintGate(); // first paint: lift the market gate once rendered in the visitor's market
  return (
    <div dir={dir} lang={lang} data-market-scope={lang} className="min-h-screen flex items-center justify-center bg-gray-50 px-6 text-center">
      <div>
        <div className="text-4xl mb-3">🌸</div>
        <p className="text-lg font-bold text-gray-700">{t("rl_unavailable")}</p>
      </div>
    </div>
  );
}
