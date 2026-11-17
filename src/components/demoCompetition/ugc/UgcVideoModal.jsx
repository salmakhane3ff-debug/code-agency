"use client";
/**
 * UgcVideoModal — the player of the affiliate dashboard "UGC Videos" tab (SIMULATED Demo Competition).
 *
 *   · the video element is created ONLY here, when the visitor opened a card: native controls,
 *     playsInline, preload="metadata" — playback never starts by itself;
 *   · title, owner, rank, simulated sales, reward per sale and total simulated reward;
 *   · closes with Esc, a click on the backdrop or the close button; focus goes to the close button on open,
 *     Tab stays inside the dialog, and focus returns to the card that opened it;
 *   · on close (unmount) the video is paused and unloaded (src removed + load()) so nothing keeps playing
 *     or downloading; it also pauses when the browser tab is hidden;
 *   · z-[65]: above the mobile bottom nav (z-60) like the other dashboard modals; page scroll locked while open;
 *     m-0 so a parent's space-y-* margin can never offset the fixed overlay.
 */
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import Avatar from "../Avatar";
import { Money } from "../CountUp";
import { RankBadge } from "../Badges";
import { PerSaleText, SalesText } from "./UgcVideoCards";

const FOCUSABLE = 'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

export default function UgcVideoModal({ video, t, dt, lang, dir, onClose }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const videoRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const [failedSrc, setFailedSrc] = useState(null);
  const src = video?.videoUrl || null;
  const playable = !!src && failedSrc !== src;

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const close = () => {
    try { videoRef.current?.pause(); } catch { /* ignore */ }
    onCloseRef.current?.();
  };

  // Focus, Esc, focus trap, page scroll lock — once per opening; focus is given back on close.
  useEffect(() => {
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        try { videoRef.current?.pause(); } catch { /* ignore */ }
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = [...panelRef.current.querySelectorAll(FOCUSABLE)];
      if (!nodes.length) return;
      const firstEl = nodes[0];
      const lastEl = nodes[nodes.length - 1];
      if (!panelRef.current.contains(document.activeElement)) { e.preventDefault(); firstEl.focus(); }
      else if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, []);

  // Pause when the browser tab is hidden; pause + unload the element when it goes away (close / new source).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    const onVisibility = () => { if (document.hidden) { try { el.pause(); } catch { /* ignore */ } } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
    };
  }, [src, playable]);

  if (!video) return null;

  return (
    <div
      className="fixed inset-0 z-[65] m-0 flex items-end justify-center bg-black/75 sm:items-center sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-ugc-video-modal
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        dir={dir}
        lang={lang}
        className="relative flex max-h-[94dvh] w-full max-w-md flex-col overflow-y-auto rounded-t-3xl bg-white text-start shadow-2xl pb-[env(safe-area-inset-bottom)] sm:max-h-[92vh] sm:rounded-3xl sm:pb-0"
      >
        <div className="flex items-center justify-end gap-2 px-4 pb-2 pt-3">
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label={t("close")}
            title={t("close")}
            className="rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="bg-black">
          {playable ? (
            <video
              key={src}
              ref={videoRef}
              src={src}
              poster={video.thumbnailUrl || undefined}
              controls
              playsInline
              preload="metadata"
              onError={() => setFailedSrc(src)}
              className="mx-auto block max-h-[55vh] w-full bg-black object-contain"
            />
          ) : (
            <p className="flex aspect-video items-center justify-center p-6 text-center text-sm text-white/80" role="status">{t("ugcv_no_video")}</p>
          )}
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <RankBadge rank={video.rank} t={dt} size="md" />
            <h2 id={titleId} className="min-w-0 flex-1 break-words text-[17px] font-black leading-snug text-gray-900">
              <bdi>{video.title}</bdi>
            </h2>
          </div>

          {video.owner && (
            <p className="flex min-w-0 items-center gap-2 text-[13px] text-gray-600">
              <Avatar src={video.owner.avatarUrl} name={video.owner.name} id={video.owner.id} alt={t("ugcv_owner_alt", { name: video.owner.name })} size={32} />
              <bdi className="min-w-0 truncate font-semibold text-gray-800">{video.owner.name}</bdi>
            </p>
          )}

          <dl className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-gray-50 px-1.5 py-2">
              <dt className="text-[10.5px] leading-tight text-gray-500">{t("ugcv_sales_label")}</dt>
              <dd className="mt-1 text-[13px] text-gray-700"><SalesText sales={video.sales} t={t} lang={lang} /></dd>
            </div>
            <div className="rounded-xl bg-gray-50 px-1.5 py-2">
              <dt className="text-[10.5px] leading-tight text-gray-500">{t("ugcv_per_sale_label")}</dt>
              <dd className="mt-1 text-[13px] font-bold text-gray-800"><PerSaleText cents={video.rewardPerSaleCents} t={t} lang={lang} className="" /></dd>
            </div>
            <div className="rounded-xl bg-orange-50 px-1.5 py-2">
              <dt className="text-[10.5px] leading-tight text-gray-500">{t("ugcv_total_label")}</dt>
              <dd className="mt-1 text-[15px] font-black"><Money cents={video.totalRewardCents} lang={lang} className="text-orange-600" /></dd>
            </div>
          </dl>

        </div>
      </div>
    </div>
  );
}
