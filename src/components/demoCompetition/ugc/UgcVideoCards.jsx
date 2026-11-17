"use client";
/**
 * Cards of the affiliate dashboard "UGC Videos" tab (SIMULATED Demo Competition leaderboard), built on the
 * shared Demo Competition UI — no second design system:
 *   · RankBadge / MovementIndicator (Badges), Avatar, Money / Count (CountUp), flameClass (Top-3 glow),
 *     and the dc-card / dc-flame / dc-row / dc-crown / dc-highlight styles of demoCompetition.css;
 *   · PodiumCard — the Top 3 (gold / silver / bronze glow, crown + "leader" ribbon on #1);
 *   · VideoRow   — the following ranks, compact rows like the homepage preview (CompactLeaderboard).
 * Every card is a <button> that opens the player (UgcVideoModal). Thumbnails are images only — a list
 * never mounts a video element; a missing / broken thumbnail shows a gradient with a play icon.
 * Texts: the dashboard dictionary (`t`, ugcv_* keys) + the Demo Competition one for the badges (`dt`).
 */
import { useState } from "react";
import { Crown, Play } from "lucide-react";
import Avatar from "../Avatar";
import { Count, Money } from "../CountUp";
import { MovementIndicator, RankBadge } from "../Badges";
import { flameClass } from "../flame";
import { fillParts } from "@/lib/affiliateTabsI18n";
import "../demoCompetition.css";

/** Thumbnail image (lazy) over a gradient + play icon; the gradient stays when there is no image or it fails. */
export function VideoThumb({ src, className = "", iconSize = 40 }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const show = !!src && failedSrc !== src;
  return (
    <span className={`relative block overflow-hidden bg-gradient-to-br from-violet-600 via-fuchsia-600 to-amber-500 ${className}`}>
      {show && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span
          className="flex items-center justify-center rounded-full bg-black/45 text-white shadow-lg ring-1 ring-white/50 backdrop-blur-[2px] transition-transform group-hover:scale-110"
          style={{ width: iconSize, height: iconSize }}
        >
          {/* A play triangle points right in both directions (media convention). */}
          <Play className="h-1/2 w-1/2" style={{ marginLeft: "8%" }} fill="currentColor" strokeWidth={1.5} />
        </span>
      </span>
    </span>
  );
}

/** "par <owner>" with the owner's avatar; the name is bidi-isolated. */
export function OwnerLine({ owner, t, size = 20, className = "" }) {
  if (!owner) return null;
  const [before, after = ""] = t("ugcv_by").split("{name}");
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[12px] leading-tight text-gray-600 ${className}`}>
      <Avatar src={owner.avatarUrl} name={owner.name} id={owner.id} alt="" size={size} />
      <span className="min-w-0 truncate">{before}<bdi className="font-semibold text-gray-800">{owner.name}</bdi>{after}</span>
    </span>
  );
}

/** "<n> ventes" (singular for 1). */
export function SalesText({ sales, t, lang, className = "" }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <Count value={sales} lang={lang} className="font-bold text-gray-800" />{" "}
      {t(sales === 1 ? "ugcv_sales_one" : "ugcv_sales_other")}
    </span>
  );
}

/** "6 DH / vente" — the configured reward per (simulated) sale. */
export function PerSaleText({ cents, t, lang, className = "whitespace-nowrap" }) {
  return <span className={className}>{fillParts(t("ugcv_per_sale"), { amount: <Money key="a" cents={cents} lang={lang} /> })}</span>;
}

const playLabel = (v, t) => t("ugcv_play", { title: v.title, rank: v.rank });
const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";

/** Top-3 card: big thumbnail, rank medal, title, owner, total reward (count-up) + sales and reward per sale. */
export function PodiumCard({ v, t, dt, lang, diff, flash, onOpen }) {
  const first = v.rank === 1;
  return (
    <button
      type="button"
      onClick={() => onOpen(v)}
      aria-label={playLabel(v, t)}
      title={v.title}
      data-ugc-video={v.id}
      className={`group block h-full w-full rounded-2xl text-start ${FOCUS_RING}`}
    >
      <span className={`dc-card ${flameClass(v.rank)} ${flash ? "dc-highlight" : ""} flex h-full flex-col p-2.5 sm:p-3`}>
        <span className="relative block">
          {first && <Crown className="dc-crown z-10" fill="currentColor" strokeWidth={1.5} aria-hidden="true" />}
          <VideoThumb src={v.thumbnailUrl} className={`w-full rounded-xl ${first ? "aspect-video" : "aspect-[4/3]"}`} iconSize={first ? 56 : 42} />
          <span className="absolute start-2 top-2"><RankBadge rank={v.rank} t={dt} size={first ? "lg" : "card"} /></span>
          {first && (
            <span className="absolute end-2 top-2 rounded-full bg-amber-400 px-2.5 py-0.5 text-[11px] font-black text-amber-950 shadow-md">
              {t("ugcv_leader")}
            </span>
          )}
        </span>
        <span className="mt-2.5 flex items-start gap-1.5">
          <bdi className={`line-clamp-2 min-w-0 flex-1 break-words font-extrabold leading-snug text-gray-900 ${first ? "text-[16px] sm:text-[17px]" : "text-[14px] sm:text-[15px]"}`}>{v.title}</bdi>
          <span className="shrink-0"><MovementIndicator diff={diff} t={dt} compact /></span>
        </span>
        <OwnerLine owner={v.owner} t={t} size={first ? 24 : 20} className="mt-1.5" />
        <span className="mt-auto block pt-2.5">
          <span className="block border-t border-gray-100 pt-2 text-[11px] leading-tight text-gray-500">{t("ugcv_total_label")}</span>
          <span className={`block font-black leading-tight ${first ? "text-[22px]" : "text-[18px]"}`}>
            <Money cents={v.totalRewardCents} lang={lang} animate className="text-orange-600" />
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-gray-600">
            <SalesText sales={v.sales} t={t} lang={lang} />
            <span className="text-gray-300" aria-hidden="true">·</span>
            <PerSaleText cents={v.rewardPerSaleCents} t={t} lang={lang} />
          </span>
        </span>
      </span>
    </button>
  );
}

/** Rank 4+ row: "#n", portrait thumbnail, title, owner, sales · reward per sale, total reward at the end. */
export function VideoRow({ v, t, dt, lang, diff, flash, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(v)}
      aria-label={playLabel(v, t)}
      title={v.title}
      data-ugc-video={v.id}
      className={`dc-row group ${flash ? "dc-highlight" : ""} flex w-full items-center gap-2 rounded-xl border p-2 text-start min-[400px]:gap-3 ${FOCUS_RING}`}
    >
      <span
        className="inline-flex w-7 shrink-0 justify-center text-[13px] font-bold tabular-nums text-gray-400"
        aria-label={dt("rank_label", { rank: v.rank })}
        title={dt("rank_label", { rank: v.rank })}
      >
        <bdi dir="ltr">#{v.rank}</bdi>
      </span>
      <VideoThumb src={v.thumbnailUrl} className="h-[68px] w-[52px] shrink-0 rounded-lg" iconSize={24} />
      <span className="min-w-0 flex-1">
        <bdi className="line-clamp-2 break-words text-[14px] font-bold leading-tight text-gray-900">{v.title}</bdi>
        <OwnerLine owner={v.owner} t={t} size={18} className="mt-1" />
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-tight text-gray-500">
          <SalesText sales={v.sales} t={t} lang={lang} />
          <span className="text-gray-300" aria-hidden="true">·</span>
          <PerSaleText cents={v.rewardPerSaleCents} t={t} lang={lang} />
          <MovementIndicator diff={diff} t={dt} compact />
        </span>
      </span>
      <span className="shrink-0 text-end text-[14px] font-extrabold leading-tight" title={t("ugcv_total_label")}>
        <Money cents={v.totalRewardCents} lang={lang} animate className="text-orange-600" />
      </span>
    </button>
  );
}
