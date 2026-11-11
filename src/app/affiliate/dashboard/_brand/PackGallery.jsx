"use client";

/**
 * Gallery of the chosen pack (step 2 of the flow, used by ../BrandTab.jsx): a large image with its caption, compact
 * thumbnails of what the pack contains (the pack cover first when the admin set one, then each product of the pack with
 * its quantity) — a thumbnail shows that item in the main area — and a click-to-zoom full-screen viewer over the same
 * items.
 *
 * Viewer: role="dialog" + aria-modal, focus moves to its close button and returns to the opener on close, Tab stays
 * inside it, Escape / ✕ / a click on the backdrop close it; with several images: previous / next buttons, arrow keys
 * and swipe, all following the reading direction (in RTL the "next" image is on the left). The page does not scroll
 * behind it. Items come from the API (the admin's pack cover + the pack's own products); a missing or failing image shows
 * the package icon — never a broken image. Plain <img>: catalogue images come from hosts not all configured for
 * next/image (same as the rest of the tab).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Package, ZoomIn, X, ChevronLeft, ChevronRight } from "lucide-react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SWIPE_PX = 40;

/** One image with the package-icon fallback. */
function SafeImg({ src, alt, className = "", iconCls = "w-10 h-10" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <Package className={`${iconCls} text-violet-300`} aria-hidden="true" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={className} />;
}

/** "Title ×qty" caption of an item (bidi-isolated title). */
function Caption({ item, className = "" }) {
  if (!item?.title) return null;
  return (
    <p className={`flex items-center justify-center gap-1.5 min-w-0 ${className}`}>
      <bdi dir="auto" className="truncate">{item.title}</bdi>
      {item.quantity ? <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-violet-600 text-white text-[11px] font-black"><bdi dir="ltr">×{item.quantity}</bdi></span> : null}
    </p>
  );
}

function Viewer({ items, start, name, t, dir, onClose }) {
  const images = items.map((x) => x.src);
  const [i, setI] = useState(start);
  const box = useRef(null);
  const closeBtn = useRef(null);
  const touchX = useRef(null);
  // The element that opened the viewer (read on the first render, before the close button takes focus).
  const [opener] = useState(() => (typeof document !== "undefined" ? document.activeElement : null));
  const n = images.length;
  const go = (delta) => setI((x) => (x + delta + n) % n);
  const latest = useRef({ go, onClose, i });
  latest.current = { go, onClose, i };
  const rtl = dir === "rtl";
  const PrevIcon = rtl ? ChevronRight : ChevronLeft;
  const NextIcon = rtl ? ChevronLeft : ChevronRight;

  useEffect(() => {
    closeBtn.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      const { go: move, onClose: close, i: cur } = latest.current;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(cur); return; }
      if (n > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        move(e.key === (rtl ? "ArrowLeft" : "ArrowRight") ? 1 : -1);
        return;
      }
      if (e.key === "Tab" && box.current) { // keep the focus inside the dialog
        const els = [...box.current.querySelectorAll(FOCUSABLE)];
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && (document.activeElement === first || !box.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !box.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (opener && opener !== document.body && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, [n, rtl, opener]);

  const stop = (e) => e.stopPropagation();
  const onTouchStart = (e) => { touchX.current = e.touches[0]?.clientX ?? null; };
  const onTouchEnd = (e) => {
    const x0 = touchX.current;
    touchX.current = null;
    const x1 = e.changedTouches[0]?.clientX;
    if (n < 2 || x0 === null || x1 === undefined || Math.abs(x1 - x0) < SWIPE_PX) return;
    // LTR: swipe towards the start (left) shows the next image; RTL: the other way round.
    go((x1 < x0) !== rtl ? 1 : -1);
  };

  return createPortal(
    <div ref={box} role="dialog" aria-modal="true" aria-label={t("gallery_dialog", { name })} dir={dir} data-pack-lightbox
      onClick={() => onClose(i)} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
      className="fixed inset-0 z-[90] bg-gray-950/90 flex items-center justify-center p-4 pt-16 pb-16 text-start">
      <button ref={closeBtn} type="button" onClick={(e) => { stop(e); onClose(i); }} aria-label={t("gallery_close")} data-lightbox-close
        className="absolute top-3 end-3 w-11 h-11 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
        <X className="w-5 h-5" aria-hidden="true" />
      </button>
      <div onClick={stop} className="max-w-full max-h-full flex flex-col items-center justify-center gap-3">
        <SafeImg key={images[i]} src={images[i]} alt={items[i].title || t("gallery_alt", { name, n: i + 1 })} iconCls="w-16 h-16"
          className="max-w-full max-h-[72vh] w-auto h-auto object-contain rounded-2xl bg-white" />
        <Caption item={items[i]} className="max-w-[80vw] text-sm font-bold text-white" />
      </div>
      {n > 1 && (
        <>
          <button type="button" onClick={(e) => { stop(e); go(-1); }} aria-label={t("gallery_prev")} data-lightbox-prev
            className="absolute start-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-gray-900/70 ring-1 ring-white/40 shadow-lg hover:bg-gray-900/85 text-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
            <PrevIcon className="w-6 h-6" aria-hidden="true" />
          </button>
          <button type="button" onClick={(e) => { stop(e); go(1); }} aria-label={t("gallery_next")} data-lightbox-next
            className="absolute end-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-gray-900/70 ring-1 ring-white/40 shadow-lg hover:bg-gray-900/85 text-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
            <NextIcon className="w-6 h-6" aria-hidden="true" />
          </button>
          <p aria-live="polite" className="absolute top-5 inset-x-16 text-center text-sm font-bold text-white/90">
            {t("gallery_count", { n: i + 1, total: n })}
          </p>
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * `items`: [{ key, src, title, quantity }] — the pack cover (optional) then the pack's products, in order;
 * `name`: the pack name (alt texts / dialog label). Items without an image still get a thumbnail (package icon).
 */
export default function PackGallery({ items, name, t, dir }) {
  const list = (items || []).filter((x) => x && x.key);
  const listKey = list.map((x) => x.key).join("\n");
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => { setIndex(0); setOpen(false); }, [listKey]); // another pack → first item, viewer closed
  const cur = Math.min(index, Math.max(list.length - 1, 0));
  const item = list[cur] || null;
  const zoomable = list.filter((x) => x.src);
  const zoomStart = Math.max(0, zoomable.indexOf(item));

  return (
    <div className="space-y-2.5" data-pack-gallery>
      {item?.src ? (
        <button type="button" onClick={() => setOpen(true)} aria-label={t("gallery_open")} data-gallery-main
          className="group relative w-full h-72 sm:h-96 rounded-3xl bg-gradient-to-b from-violet-50 via-white to-white border border-violet-100 shadow-sm flex items-center justify-center overflow-hidden p-4 cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2">
          <SafeImg src={item.src} alt={item.title || t("gallery_alt", { name, n: cur + 1 })} className="max-w-full max-h-full object-contain drop-shadow-sm transition-transform group-hover:scale-[1.03]" />
          <span aria-hidden="true" className="absolute top-3 end-3 w-9 h-9 rounded-xl bg-white/90 shadow text-violet-700 flex items-center justify-center">
            <ZoomIn className="w-4 h-4" />
          </span>
          {list.length > 1 && (
            <span aria-hidden="true" className="absolute top-3 start-3 px-2 py-0.5 rounded-lg bg-white/90 shadow text-[11px] font-bold text-gray-700"><bdi dir="ltr">{cur + 1}/{list.length}</bdi></span>
          )}
        </button>
      ) : (
        <div className="w-full h-72 sm:h-96 rounded-3xl bg-gradient-to-b from-violet-50 to-white border border-violet-100 flex items-center justify-center" data-gallery-empty>
          <Package className="w-14 h-14 text-violet-300" aria-hidden="true" />
        </div>
      )}
      <Caption item={item} className="text-sm font-bold text-gray-800" />
      {list.length > 1 && (
        <ul className="flex gap-2 overflow-x-auto px-0.5 pt-1.5 pb-1 justify-start sm:justify-center" data-gallery-thumbs>
          {list.map((x, i) => (
            <li key={x.key} className="shrink-0">
              <button type="button" onClick={() => setIndex(i)} aria-label={x.title ? `${x.title}${x.quantity ? ` ×${x.quantity}` : ""}` : t("gallery_thumb", { n: i + 1, total: list.length })}
                aria-current={i === cur ? "true" : undefined} data-gallery-thumb={x.key}
                className={`relative w-16 h-16 rounded-2xl border-2 bg-white flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${i === cur ? "border-violet-600 shadow-md shadow-violet-100" : "border-gray-100 hover:border-gray-300"}`}>
                <span className="w-full h-full rounded-[14px] overflow-hidden flex items-center justify-center">
                  <SafeImg src={x.src} alt="" iconCls="w-6 h-6" className="w-full h-full object-cover" />
                </span>
                {x.quantity ? <span aria-hidden="true" className="absolute -top-1.5 -end-1.5 min-w-[22px] h-[18px] px-1 rounded-full bg-violet-600 text-white text-[10px] font-black flex items-center justify-center ring-2 ring-white"><bdi dir="ltr">×{x.quantity}</bdi></span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && item?.src && <Viewer items={zoomable} start={zoomStart} name={name} t={t} dir={dir} onClose={(i) => { setIndex(Math.max(0, list.indexOf(zoomable[i]))); setOpen(false); }} />}
    </div>
  );
}
