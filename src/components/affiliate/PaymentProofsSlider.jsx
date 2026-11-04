"use client";

/**
 * src/components/affiliate/PaymentProofsSlider.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The single "recent payment proofs" slider of the Affiliate Dashboard (overview).
 *
 *   • data: GET /api/affiliate/payment-proofs[?cursor=] — ONE global feed (same for
 *     every active affiliate): the SERVER returns only proofs published during the
 *     last 72 h, in pages of 50 ({ proofs, total, nextCursor }). The next page is
 *     fetched lazily when the viewer nears the end of the loaded proofs, so EVERY
 *     eligible proof is reachable; the slider wraps only once all pages are loaded
 *   • receipts: GET /api/affiliate/payment-proofs/{token}/image with the Bearer
 *     token, shown through blob object URLs (revoked on change / unmount); only the
 *     current slide and its neighbours are loaded
 *   • fetched once on mount (+ at most every 5 min when the tab becomes visible
 *     again, from the first page, keeping the current proof selected); renders
 *     nothing while loading, on error (incl. 403 inactive) or when there is no proof
 *   • auto-rotation every 5 s, paused on hover / focus / touch, hidden page, open
 *     preview and prefers-reduced-motion; prev / next buttons, dots (≤ 10 proofs) or
 *     an "i / total" counter, arrow keys
 *     and swipe (mirrored in Arabic RTL); click → full-size preview dialog
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, BadgeCheck, ZoomIn, Loader2 } from "lucide-react";

const ROTATE_MS = 5000;
const REFRESH_MIN_MS = 5 * 60 * 1000;
const SWIPE_PX = 40;
const PREFETCH_WITHIN = 3; // fetch the next page when ≤ 3 loaded slides remain
const MAX_DOTS = 10;

/** One feed page; throws on any non-OK answer (e.g. 403 inactive affiliate). */
async function fetchFeedPage(cursor) {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const r = await fetch(`/api/affiliate/payment-proofs${q}`, { headers: authHeader(), cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  const data = await r.json();
  const list = Array.isArray(data?.proofs)
    ? data.proofs.filter((p) => p && typeof p.token === "string" && typeof p.name === "string")
    : [];
  const total = Number.isInteger(data?.total) && data.total >= 0 ? data.total : list.length;
  const nextCursor = typeof data?.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
  return { list, total, nextCursor };
}

/** Append without duplicates (by token), keeping order. */
function mergeUnique(a, b) {
  const seen = new Set(a.map((p) => p.token));
  return [...a, ...b.filter((p) => !seen.has(p.token) && seen.add(p.token))];
}

const TEXT = {
  fr: {
    title: "Preuves de paiement récentes",
    caption: "Paiements des dernières 72 h",
    prev: "Preuve précédente",
    next: "Preuve suivante",
    open: "Agrandir le reçu",
    close: "Fermer",
    goTo: (n) => `Afficher la preuve ${n}`,
    position: (i, n) => `Preuve ${i} sur ${n}`,
    receiptOf: (name) => `Reçu de paiement — ${name}`,
    paid: "Payé",
    unavailable: "Reçu indisponible",
    ago: (h) => (h < 1 ? "il y a moins d’une heure" : `il y a ${h} h`),
    currency: "MAD",
  },
  ar: {
    title: "إثباتات الدفع الأخيرة",
    caption: "مدفوعات آخر 72 ساعة",
    prev: "الإثبات السابق",
    next: "الإثبات التالي",
    open: "تكبير الوصل",
    close: "إغلاق",
    goTo: (n) => `عرض الإثبات ${n}`,
    position: (i, n) => `الإثبات ${i} من ${n}`,
    receiptOf: (name) => `وصل الدفع — ${name}`,
    paid: "تم الدفع",
    unavailable: "الوصل غير متوفر",
    ago: (h) => (h < 1 ? "منذ أقل من ساعة" : `منذ ${h} ساعة`),
    currency: "درهم",
  },
};

function authHeader() {
  try {
    const token = localStorage.getItem("affiliateToken") || "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function fmtAmount(n, lang, cur) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toLocaleString(lang === "ar" ? "ar-MA" : "fr-FR", { maximumFractionDigits: 2 })} ${cur}`;
}

function hoursSince(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 3_600_000));
}

/** Receipt images keyed by token → object URL ("loading" | "error" while not ready). */
function useReceiptImages(proofs, index) {
  const [urls, setUrls] = useState({});
  const urlsRef = useRef({});
  const pending = useRef(new Set());

  useEffect(() => {
    if (!proofs.length) return;
    const wanted = [index, index + 1, index - 1].map((i) => proofs[(i + proofs.length) % proofs.length]?.token).filter(Boolean);
    for (const token of wanted) {
      if (urlsRef.current[token] || pending.current.has(token)) continue;
      pending.current.add(token);
      fetch(`/api/affiliate/payment-proofs/${encodeURIComponent(token)}/image`, { headers: authHeader(), cache: "no-store" })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          urlsRef.current = { ...urlsRef.current, [token]: url };
          setUrls(urlsRef.current);
        })
        .catch(() => {
          urlsRef.current = { ...urlsRef.current, [token]: "error" };
          setUrls(urlsRef.current);
        })
        .finally(() => pending.current.delete(token));
    }
  }, [proofs, index]);

  // Drop (and revoke) images of proofs that are no longer in the list.
  useEffect(() => {
    const keep = new Set(proofs.map((p) => p.token));
    let changed = false;
    const next = {};
    for (const [token, url] of Object.entries(urlsRef.current)) {
      if (keep.has(token)) next[token] = url;
      else { changed = true; if (url !== "error") URL.revokeObjectURL(url); }
    }
    if (changed) { urlsRef.current = next; setUrls(next); }
  }, [proofs]);

  // Revoke everything on unmount.
  useEffect(() => () => {
    for (const url of Object.values(urlsRef.current)) if (url !== "error") URL.revokeObjectURL(url);
    urlsRef.current = {};
  }, []);

  return urls;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function ReceiptPreview({ proof, url, t, lang, onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-950/85 p-4" onClick={onClose} data-proof-preview>
      <div role="dialog" aria-modal="true" aria-label={t.receiptOf(proof.name)} dir={lang === "ar" ? "rtl" : "ltr"}
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-gray-900">{proof.name}</p>
            <p className="text-sm font-black text-emerald-600">{fmtAmount(proof.amount, lang, t.currency)}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t.close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-gray-50 p-2">
          {url && url !== "error"
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={url} alt={t.receiptOf(proof.name)} className="max-h-[75vh] w-full object-contain" />
            : <p className="py-16 text-sm text-gray-500">{url === "error" ? t.unavailable : <Loader2 className="h-6 w-6 animate-spin text-gray-400" aria-hidden="true" />}</p>}
        </div>
      </div>
    </div>
  );
}

export default function PaymentProofsSlider({ lang = "fr" }) {
  const t = TEXT[lang === "ar" ? "ar" : "fr"];
  const rtl = lang === "ar";
  const [proofs, setProofs] = useState([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touching, setTouching] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const reduced = usePrefersReducedMotion();
  const lastLoad = useRef(0);
  const touchX = useRef(null);
  const generation = useRef(0);      // a reload discards answers of older requests
  const loadingMore = useRef(false);
  const currentToken = useRef(null); // keeps the viewed proof selected across reloads

  /** (Re)load from the first page. */
  const load = useCallback(async () => {
    lastLoad.current = Date.now();
    const gen = ++generation.current;
    loadingMore.current = false;
    try {
      const page = await fetchFeedPage(null);
      if (gen !== generation.current) return;
      setProofs(page.list);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
      const keep = currentToken.current ? page.list.findIndex((p) => p.token === currentToken.current) : -1;
      setIndex((i) => (keep >= 0 ? keep : page.list.length ? Math.min(i, page.list.length - 1) : 0));
    } catch {
      if (gen !== generation.current) return;
      setProofs([]);
      setTotal(0);
      setNextCursor(null);
    }
  }, []);

  /** Fetch the next page (if any) and append it. A failure keeps what is shown and retries on the next approach. */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    const gen = generation.current;
    try {
      const page = await fetchFeedPage(nextCursor);
      if (gen !== generation.current) return;
      setProofs((cur) => mergeUnique(cur, page.list));
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch {
      /* keep the loaded proofs; nextCursor stays, so the next approach retries */
    } finally {
      if (gen === generation.current) loadingMore.current = false;
    }
  }, [nextCursor]);

  useEffect(() => {
    load();
    const onVis = () => {
      const hidden = document.hidden;
      setPageHidden(hidden);
      if (!hidden && Date.now() - lastLoad.current >= REFRESH_MIN_MS) load();
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  const count = proofs.length;
  const complete = !nextCursor;           // every eligible proof is loaded
  const shownTotal = Math.max(total, count);
  /** Move by ±1. Wrapping happens only once all pages are loaded; otherwise the end waits for the next page. */
  const go = useCallback((step) => setIndex((i) => {
    if (!count) return 0;
    const j = i + step;
    if (j >= 0 && j < count) return j;
    if (complete) return (j + count) % count;
    return i; // more proofs exist: stay until the next page arrives
  }), [count, complete]);

  useEffect(() => { currentToken.current = proofs[index]?.token ?? null; }, [proofs, index]);

  // Lazily fetch the next page when the viewer approaches the end of the loaded proofs.
  useEffect(() => {
    if (nextCursor && count && index >= count - PREFETCH_WITHIN) loadMore();
  }, [index, count, nextCursor, loadMore]);

  const paused = hovered || focused || touching || pageHidden || preview || reduced || shownTotal < 2;
  useEffect(() => {
    if (paused) return undefined;
    const id = setInterval(() => go(1), ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, go]);

  const urls = useReceiptImages(proofs, index);
  const closePreview = useCallback(() => setPreview(false), []);

  if (!count) return null;
  const current = proofs[Math.min(index, count - 1)];
  const url = urls[current.token];
  // In RTL the visual "previous" arrow points right; keys follow what the user sees.
  const onKeyDown = (e) => {
    if (preview) return; // the preview dialog handles its own keys
    if (e.key === "ArrowLeft") { e.preventDefault(); go(rtl ? 1 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(rtl ? -1 : 1); }
  };
  const PrevIcon = rtl ? ChevronRight : ChevronLeft;
  const NextIcon = rtl ? ChevronLeft : ChevronRight;

  return (
    <section dir={rtl ? "rtl" : "ltr"} aria-roledescription="carousel" aria-label={t.title} data-payment-proofs
      className="overflow-hidden rounded-2xl border border-gray-100 bg-white p-4 shadow-sm"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
      onKeyDown={onKeyDown}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-gray-900 md:text-base">
            <BadgeCheck className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            <span className="truncate">{t.title}</span>
          </h3>
          <p className="text-xs text-gray-500">{t.caption}</p>
        </div>
        {shownTotal > 1 && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => go(-1)} aria-label={t.prev} data-proof-prev
              className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
              <PrevIcon className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label={t.next} data-proof-next
              className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
              <NextIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <div role="group" aria-roledescription="slide" aria-label={`${index + 1} / ${shownTotal}`} aria-live={paused ? "polite" : "off"}
        className="flex flex-col gap-3 sm:flex-row sm:items-center"
        onTouchStart={(e) => { setTouching(true); touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          touchX.current = null;
          setTouching(false);
          if (start == null || end == null || Math.abs(end - start) < SWIPE_PX) return;
          const swipedLeft = end < start;
          // LTR: swipe left → next. RTL: swipe right → next (mirrored).
          go(swipedLeft !== rtl ? 1 : -1);
        }}
        onTouchCancel={() => { touchX.current = null; setTouching(false); }}>
        <button type="button" onClick={() => setPreview(true)} aria-label={t.open} data-proof-open
          className="group relative h-44 w-full shrink-0 overflow-hidden rounded-xl border border-gray-100 bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 sm:h-36 sm:w-56">
          {url && url !== "error"
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={url} alt={t.receiptOf(current.name)} className="h-full w-full object-cover" />
            : <span className="flex h-full w-full items-center justify-center text-xs text-gray-400">
                {url === "error" ? t.unavailable : <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
              </span>}
          <span className="absolute bottom-2 end-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white" aria-hidden="true">
            <ZoomIn className="h-3.5 w-3.5" />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-gray-900" data-proof-name>{current.name}</p>
          <p className="text-xl font-black text-emerald-600" data-proof-amount>{fmtAmount(current.amount, lang, t.currency)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">{t.paid}</span>
            <span>{t.ago(hoursSince(current.publishedAt))}</span>
          </p>
        </div>
      </div>

      {shownTotal > 1 && shownTotal <= MAX_DOTS && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
          {proofs.map((p, i) => (
            <button key={p.token} type="button" onClick={() => setIndex(i)} aria-label={t.goTo(i + 1)} aria-current={i === index ? "true" : undefined}
              className={`h-2 rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${i === index ? "w-5 bg-emerald-600" : "w-2 bg-gray-300 hover:bg-gray-400"}`} />
          ))}
        </div>
      )}
      {shownTotal > MAX_DOTS && (
        <p className="mt-3 text-center text-xs font-semibold text-gray-500 tabular-nums" aria-label={t.position(index + 1, shownTotal)} data-proof-counter>
          <bdi>{index + 1} / {shownTotal}</bdi>
        </p>
      )}

      {preview && <ReceiptPreview proof={current} url={url} t={t} lang={lang} onClose={closePreview} />}
    </section>
  );
}
