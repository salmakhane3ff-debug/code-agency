"use client";
/**
 * RecentWinners — "الفائزون مؤخراً / Les gagnants récents" on the affiliate Rewards / Gifts page,
 * between the points card and the gifts listing (RewardsTab only).
 *
 * Data: GET /api/affiliate/rewards/winners (read only) — newest first (wonAt DESC), at most 30:
 * accepted gift requests (masked names) + computed demo winners (existing Top Members identities)
 * while the Demo Competition engine is ON. Rewards program OFF → the section is not rendered.
 *
 * Slider: 3 cards on desktop, 3 → 2 → 1 as the width shrinks; one page = the next `perView`
 * winners (pageStarts), so every winner is shown once per cycle before it restarts at the newest.
 * Moves on its own (paused on hover / focus / touch, when off screen or the tab is hidden, and
 * never under prefers-reduced-motion), arrows, swipe, pagination dots. No link, no "view all".
 * RTL (ar) / LTR (fr) from the caller's `dir`. A broken avatar / gift image falls back to an
 * icon; it never breaks the slider.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Crown, Gift, Info } from "lucide-react";
import { pageStarts, perViewFor, relativeWin, winnerTime } from "@/lib/recentWinners";
import DemoAvatar from "@/components/demoCompetition/Avatar";

export const RECENT_WINNERS_URL = "/api/affiliate/rewards/winners";
const AUTOPLAY_MS = 4500;
const REFRESH_MS = 120_000;
const SWIPE_PX = 40;

function authHeaders() {
  const t = (typeof localStorage !== "undefined" && localStorage.getItem("affiliateToken")) || "";
  return { Authorization: `Bearer ${t}` };
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** The Top Members avatar (photo, or initials on the member's colour; falls back when the photo fails) + crown. */
function Avatar({ src, name, avatarKey }) {
  return (
    <span className="relative inline-flex" data-winner-avatar={src ? "photo" : "initials"}>
      <DemoAvatar src={src} name={name} id={avatarKey || name} size={50} ring="ring-2 ring-white shadow-sm" />
      <span className="absolute -top-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 ring-2 ring-white" aria-hidden="true">
        <Crown className="h-3 w-3 text-white" fill="currentColor" strokeWidth={1.5} />
      </span>
    </span>
  );
}

function GiftImage({ src }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="relative mt-2 block w-full">
      <span className="flex aspect-[4/3] max-h-32 w-full items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-violet-50 to-fuchsia-50 sm:max-h-36">
        {src && !broken
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt="" className="h-full w-full object-contain p-1.5" loading="lazy" onError={() => setBroken(true)} data-winner-gift-image />
          : <Gift className="h-8 w-8 text-violet-300" aria-hidden="true" data-winner-gift-fallback />}
      </span>
      <span className="absolute -bottom-1.5 end-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-fuchsia-600 ring-2 ring-white shadow" aria-hidden="true" data-winner-gift-icon>
        <Gift className="h-3.5 w-3.5 text-white" strokeWidth={2.25} />
      </span>
    </span>
  );
}

function WinnerCard({ w, t, lang, nowMs, width, hidden }) {
  const name = w.name || t("winners_member");
  return (
    <li
      role="group"
      aria-roledescription="slide"
      aria-label={t("winners_won", { name, gift: w.giftName })}
      aria-hidden={hidden || undefined}
      style={{ width, flex: `0 0 ${width}px` }}
      className="flex min-w-0 flex-col items-center rounded-2xl border border-violet-100/70 bg-white px-2 pb-2.5 pt-3 text-center shadow-[0_6px_18px_-8px_rgba(109,40,217,0.25)] sm:px-3"
      data-winner={w.key}
      data-winner-demo={w.demo ? "true" : undefined}
    >
      <Avatar src={w.avatarUrl} name={name} avatarKey={w.avatarKey} />
      <p dir="auto" className="mt-1.5 w-full truncate text-center text-[13px] font-black text-gray-900 sm:text-sm"><bdi>{name}</bdi></p>
      <GiftImage src={w.giftImage} />
      <p dir="auto" className="mt-2.5 w-full truncate text-center text-[13px] font-extrabold text-gray-900 sm:text-sm" title={w.giftName}><bdi>{w.giftName}</bdi></p>
      <div className="mt-1.5 flex w-full flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-gray-500 sm:text-[11px]">
        <span className="inline-flex items-center gap-1" data-winner-time>
          <Clock className="h-3 w-3 shrink-0" aria-hidden="true" /><span dir="ltr" className="tabular-nums">{winnerTime(w.wonAt)}</span>
        </span>
        <span className="inline-flex items-center gap-1" data-winner-relative>
          <CalendarDays className="h-3 w-3 shrink-0" aria-hidden="true" /><span>{relativeWin(w.wonAt, nowMs, lang)}</span>
        </span>
      </div>
    </li>
  );
}

function Shell({ t, dir, children, footer }) {
  return (
    <section
      dir={dir}
      aria-label={t("winners_title")}
      className="rounded-3xl border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50 px-3 py-4 shadow-sm sm:px-5 sm:py-5"
      data-recent-winners
    >
      <div className="px-1">
        <h3 className="flex items-center gap-2 text-base font-black text-gray-900 sm:text-lg">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-600" aria-hidden="true">
            <Gift className="h-4 w-4 text-white" strokeWidth={2.25} />
          </span>
          {t("winners_title")}
        </h3>
        <p className="mt-1 text-xs text-gray-500 sm:text-[13px]">{t("winners_subtitle")}</p>
      </div>
      <div className="mt-3">{children}</div>
      {footer}
    </section>
  );
}

export default function RecentWinners({ t, lang, dir }) {
  const [state, setState] = useState({ status: "loading", winners: [], enabled: true });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState((s) => ({ ...s, status: s.winners.length ? s.status : "loading" }));
    try {
      const res = await fetch(RECENT_WINNERS_URL, { cache: "no-store", headers: authHeaders() });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !Array.isArray(data.winners)) throw new Error("load");
      setState({ status: "ready", winners: data.winners, enabled: data.enabled !== false });
      setNowMs(Date.now());
    } catch {
      // a failed refresh keeps the winners already shown
      setState((s) => (s.winners.length ? s : { ...s, status: "error" }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load({ quiet: true });
    }, REFRESH_MS);
    const tick = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => { clearInterval(id); clearInterval(tick); };
  }, [load]);

  if (!state.enabled) return null;
  if (state.status === "loading") {
    return (
      <Shell t={t} dir={dir}>
        <div className="grid grid-cols-3 gap-2 sm:gap-3" aria-busy="true" data-recent-winners-loading>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col items-center gap-2 rounded-2xl bg-white p-3 motion-safe:animate-pulse">
              <span className="h-12 w-12 rounded-full bg-violet-100" />
              <span className="h-3 w-3/4 rounded bg-gray-200" />
              <span className="aspect-[4/3] w-full rounded-xl bg-violet-50" />
              <span className="h-3 w-2/3 rounded bg-gray-200" />
            </div>
          ))}
        </div>
      </Shell>
    );
  }
  if (state.status === "error") {
    return (
      <Shell t={t} dir={dir}>
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-white/70 py-6 text-center" data-recent-winners-error>
          <p className="text-sm text-gray-600">{t("winners_error")}</p>
          <button type="button" onClick={() => load()} className="rounded-xl bg-violet-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-violet-700">{t("winners_retry")}</button>
        </div>
      </Shell>
    );
  }
  if (!state.winners.length) {
    return (
      <Shell t={t} dir={dir}>
        <p className="rounded-2xl bg-white/70 py-6 text-center text-sm text-gray-500" data-recent-winners-empty>{t("winners_empty")}</p>
      </Shell>
    );
  }
  const hasDemo = state.winners.some((w) => w.demo);
  return (
    <Shell
      t={t} dir={dir}
      footer={hasDemo ? (
        <p role="note" className="mt-2 flex items-start justify-center gap-1 px-2 text-center text-[10.5px] leading-snug text-gray-500" data-recent-winners-note>
          <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" /><span>{t("winners_demo_note")}</span>
        </p>
      ) : null}
    >
      <WinnersSlider winners={state.winners} t={t} lang={lang} dir={dir} nowMs={nowMs} />
    </Shell>
  );
}

export function WinnersSlider({ winners, t, lang, dir, nowMs }) {
  const rtl = dir === "rtl";
  const viewportRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [drag, setDrag] = useState(0);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(true);
  const reduced = usePrefersReducedMotion();
  const pointer = useRef(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const measure = () => { const cs = getComputedStyle(el); setWidth(el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0)); };
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const perView = perViewFor(width);
  const gap = width >= 640 ? 12 : 8;
  const cardW = width > 0 ? (width - gap * (perView - 1)) / perView : 0;
  const starts = useMemo(() => pageStarts(winners.length, perView), [winners.length, perView]);
  const pages = starts.length;
  const current = Math.min(page, pages - 1);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);

  const go = useCallback((p) => setPage(((p % pages) + pages) % pages), [pages]);
  const next = useCallback(() => go(current + 1), [go, current]);
  const prev = useCallback(() => go(current - 1), [go, current]);

  // Automatic movement: next page every AUTOPLAY_MS; after the last page, back to the newest winners.
  useEffect(() => {
    if (pages < 2 || paused || !inView || reduced) return undefined;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setPage((p) => (Math.min(p, pages - 1) + 1) % pages);
    }, AUTOPLAY_MS);
    return () => clearInterval(id);
  }, [pages, paused, inView, reduced]);

  const first = starts[current] ?? 0;
  const sign = rtl ? 1 : -1;
  const offset = sign * first * (cardW + gap) + drag;

  const onPointerDown = (e) => {
    if (pages < 2 || (e.pointerType === "mouse" && e.button !== 0)) return;
    pointer.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    setPaused(true);
  };
  const onPointerMove = (e) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    if (!p.moved && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(e.clientY - p.y)) {
      p.moved = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (p.moved) setDrag(dx);
  };
  const endPointer = (e) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    pointer.current = null;
    setDrag(0);
    setPaused(false);
    if (!p.moved || Math.abs(dx) < SWIPE_PX) return;
    // LTR: swipe left (dx < 0) → next; RTL: swipe right → next.
    if ((dx < 0) !== rtl) next(); else prev();
  };

  const visibleFrom = first;
  const visibleTo = first + perView - 1;
  const arrowCls = "absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-gray-100 bg-white text-gray-800 shadow-md transition hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";
  const PrevIcon = rtl ? ChevronRight : ChevronLeft;
  const NextIcon = rtl ? ChevronLeft : ChevronRight;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={t("winners_title")}
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false); }}
      data-winners-slider
      data-per-view={perView}
      data-page={current}
      data-pages={pages}
    >
      <div
        ref={viewportRef}
        className="overflow-hidden px-1 pb-2 pt-1"
        style={{ touchAction: "pan-y" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        data-winners-viewport
      >
        <ol
          className="flex list-none"
          aria-live={paused ? "polite" : "off"}
          style={{
            gap,
            transform: `translate3d(${offset}px,0,0)`,
            transition: drag || reduced ? "none" : "transform 650ms cubic-bezier(0.22, 0.61, 0.36, 1)",
            visibility: width > 0 ? "visible" : "hidden",
          }}
          data-winners-track
        >
          {winners.map((w, i) => (
            <WinnerCard key={w.key} w={w} t={t} lang={lang} nowMs={nowMs} width={cardW} hidden={i < visibleFrom || i > visibleTo} />
          ))}
        </ol>
      </div>

      {pages > 1 && (
        <>
          <button type="button" onClick={prev} aria-label={t("winners_prev")} className={`${arrowCls} -start-1.5 sm:-start-3`} data-winners-prev>
            <PrevIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <button type="button" onClick={next} aria-label={t("winners_next")} className={`${arrowCls} -end-1.5 sm:-end-3`} data-winners-next>
            <NextIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5" data-winners-dots>
            {starts.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => go(i)}
                aria-label={t("winners_page", { n: i + 1, total: pages })}
                aria-current={i === current ? "true" : undefined}
                className={`rounded-full transition-all ${i === current ? "h-2.5 w-2.5 bg-violet-600" : "h-2 w-2 bg-violet-200 hover:bg-violet-300"}`}
                data-winners-dot={i}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
