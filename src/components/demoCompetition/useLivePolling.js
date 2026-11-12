"use client";
/**
 * React side of the Demo Competition live updates.
 *   useLivePolling(url)   — polls `url` every 5 s through createPoller (pure, see
 *                           src/lib/demoCompetition/livePolling.js): paused while the
 *                           tab is hidden or the element behind `ref` is off-screen,
 *                           immediate refetch when visible again, aborted on unmount,
 *                           last good data kept on errors, 404 → notFound (stops).
 *   useRankDiff(items)    — per-id movement / new / value-changed between two polls,
 *                           with a temporary highlight set (~1.5 s).
 *   useValueFlash(value)  — true for ~1.5 s after `value` changed (not on first render).
 *   useDemoText()         — { lang, dir, t } for the current storefront language.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/context/LanguageContext";
import { demoDir, demoLang, demoT } from "@/lib/demoCompetition/i18n";
import {
  POLL_INTERVAL_MS, HIGHLIGHT_MS, createPoller, createJsonFetcher, diffRanks,
} from "@/lib/demoCompetition/livePolling";

/**
 * { lang, dir, t } — the storefront language by default; `langOverride` lets a host page impose its own language
 * (the Affiliate Dashboard passes the dashboard language, so the leaderboard never differs from the page around it).
 */
export function useDemoText(langOverride) {
  const { lang } = useLanguage();
  const l = demoLang(langOverride || lang);
  const t = useMemo(() => demoT(l), [l]);
  return { lang: l, dir: demoDir(l), t };
}

export function useLivePolling(url, { intervalMs = POLL_INTERVAL_MS, observe = true } = {}) {
  const ref = useRef(null);
  const [state, setState] = useState({ data: null, error: null, notFound: false, loading: true });

  useEffect(() => {
    if (!url) return undefined;
    const el = ref.current;
    const canObserve = observe && !!el && typeof IntersectionObserver === "function";
    let poller = null;
    poller = createPoller({
      fetcher: createJsonFetcher(url),
      intervalMs,
      hidden: typeof document !== "undefined" && document.hidden,
      // With an observer, wait for its first answer: nothing is fetched off-screen.
      onScreen: !canObserve,
      onData: (data) => setState({ data, error: null, notFound: false, loading: false }),
      onError: (err) => {
        if (err?.status === 404) {
          setState({ data: null, error: null, notFound: true, loading: false });
          poller?.stop();
          return;
        }
        // Keep the last good data; only the error flag changes.
        setState((prev) => ({ ...prev, error: err, loading: false }));
      },
    });

    const onVisibility = () => poller.setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);

    let io = null;
    if (canObserve) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) poller.setOnScreen(e.isIntersecting);
      }, { rootMargin: "120px 0px" });
      io.observe(el);
    }

    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (io) io.disconnect();
      poller.stop();
    };
  }, [url, intervalMs, observe]);

  return { ...state, ref };
}

export function useRankDiff(items, valueKey = "earnings30dCents") {
  const prevRef = useRef(null);
  const [state, setState] = useState({ diffs: {}, flash: {} });

  useEffect(() => {
    if (!Array.isArray(items)) return undefined;
    const diffs = diffRanks(prevRef.current, items, { valueKey });
    prevRef.current = items;
    const flash = {};
    for (const [id, d] of Object.entries(diffs)) if (d.valueChanged || d.moved !== 0 || d.isNew) flash[id] = true;
    setState({ diffs, flash });
    if (!Object.keys(flash).length) return undefined;
    const timer = setTimeout(() => setState((s) => ({ ...s, flash: {} })), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [items, valueKey]);

  return state;
}

export function useValueFlash(value) {
  const prevRef = useRef(value);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prevRef.current === value) return undefined;
    prevRef.current = value;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [value]);

  return flash;
}
