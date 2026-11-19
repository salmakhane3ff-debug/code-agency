"use client";
/**
 * HomeTopUgcVideos — the Affiliate Dashboard HOME preview of the Demo Competition "UGC Videos":
 * the THIRD compact ranking section next to Top Members / Top Brands, built from the SAME pieces
 * and the SAME row design (no new visual design):
 *   · HomeSectionFrame — white panel, small icon + title + live dot, small "Voir tout" → the full
 *     leaderboard page /top-ugc-videos;
 *   · the Top 3 only, one compact horizontal row per video, one below the other — the CompactRow
 *     structure and classes (dc-row + gold / silver / bronze tint, medal, crown on #1, 34 px image,
 *     title + "par <creator>" line, numbers at the end, chevron); the round photo becomes a small
 *     video thumbnail and orders / earnings become sales / reward (rolling 30 days).
 * A row opens the existing video player (UgcVideoModal: controls, never autoplay). Data: ONLY the
 * public demo endpoint /api/demo-competition/ugc-videos (polled live while in view, like the other
 * sections). Module switched off by the admin, or no ranked video → the section is hidden.
 */
import { useMemo, useState } from "react";
import { MotionConfig, motion } from "framer-motion";
import { ChevronRight, Clapperboard, Crown } from "lucide-react";
import { useMarketLocale } from "@/context/useMarketLocale";
import { AFFILIATE_DASHBOARD_TEXT } from "@/lib/affiliateDashboardI18n";
import { useDemoText, useLivePolling, useRankDiff } from "../useLivePolling";
import HomeSectionFrame from "../HomeSectionFrame";
import { Count, Money } from "../CountUp";
import { MovementIndicator, RankBadge } from "../Badges";
import { VideoThumb } from "./UgcVideoCards";
import UgcVideoModal from "./UgcVideoModal";
import { UGC_PODIUM_SIZE, UGC_VIDEOS_ENDPOINT, normalizeUgcVideos, ugcViewState } from "./ugcVideos";
import "../demoCompetition.css";

/** The home preview shows the Top 3 (the podium) only. */
export const UGC_HOME_COUNT = UGC_PODIUM_SIZE;
export const UGC_HOME_URL = `${UGC_VIDEOS_ENDPOINT}?limit=${UGC_HOME_COUNT}`;
/** "Voir tout" — the full UGC leaderboard page. */
export const UGC_FULL_PAGE = "/top-ugc-videos";

const TOP = { 1: "dc-row--1", 2: "dc-row--2", 3: "dc-row--3" };

/** "par <creator>" with the name bidi-isolated (as the Top Brands owner line). */
function CreatorText({ owner, t }) {
  if (!owner) return null;
  const [before, after = ""] = t("ugcv_by").split("{name}");
  return <span className="min-w-0 truncate">{before}<bdi>{owner.name}</bdi>{after}</span>;
}

/** One compact horizontal row — the Top Members / Top Brands CompactRow, for a video. */
export function UgcCompactRow({ v, t, dt, lang, diff, flash, onOpen }) {
  const label = t("ugcv_play", { title: v.title, rank: v.rank });
  return (
    <button
      type="button"
      onClick={() => onOpen(v)}
      aria-label={label}
      title={label}
      data-ugc-home-row={v.id}
      className={`dc-row ${TOP[v.rank] || ""} ${flash ? "dc-highlight" : ""} group flex min-h-[60px] w-full items-center gap-2 rounded-xl border px-2 py-2 text-start min-[400px]:gap-2.5 min-[400px]:px-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500`}
    >
      <span className="flex w-6 shrink-0 justify-center min-[400px]:w-7"><RankBadge rank={v.rank} t={dt} size="sm" /></span>
      <VideoThumb src={v.thumbnailUrl} className="h-[34px] w-[34px] shrink-0 rounded-lg ring-1 ring-violet-100" iconSize={18} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1 text-[14px] font-bold leading-tight text-gray-900">
          {v.rank === 1 && <Crown className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" fill="currentColor" strokeWidth={1.5} aria-hidden="true" />}
          <bdi className="line-clamp-2 break-words">{v.title}</bdi>
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-tight text-gray-500">
          <CreatorText owner={v.owner} t={t} />
          <MovementIndicator diff={diff} t={dt} compact />
        </span>
      </span>
      <span className="shrink-0 text-end leading-tight">
        <span className="block text-[14px] font-extrabold text-gray-900" title={t("ugcv_sales_label")}>
          <Count value={v.sales} lang={lang} />
          <span className="ms-1 text-[11px] font-medium text-gray-400">{t(v.sales === 1 ? "ugcv_sales_one" : "ugcv_sales_other")}</span>
        </span>
        <span className="mt-0.5 block text-[12.5px] font-bold" title={t("ugcv_total_label")}>
          <Money cents={v.totalRewardCents} lang={lang} animate className="text-orange-600" />
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 rtl:rotate-180" aria-hidden="true" />
    </button>
  );
}

/** Placeholder rows while the first response is loading (the CompactLeaderboard skeleton, 3 rows). */
function CompactSkeleton({ label }) {
  return (
    <ol className="flex flex-col gap-2" aria-label={label} aria-busy="true">
      {Array.from({ length: UGC_HOME_COUNT }, (_, i) => (
        <li key={i} className="flex h-[60px] list-none items-center gap-2.5 rounded-xl border border-gray-100 bg-white px-2.5 motion-safe:animate-pulse">
          <span className="h-6 w-6 rounded-full bg-gray-200" />
          <span className="h-[34px] w-[34px] rounded-lg bg-gray-200" />
          <span className="h-3.5 flex-1 rounded bg-gray-200" />
          <span className="h-3.5 w-16 rounded bg-gray-200" />
        </li>
      ))}
    </ol>
  );
}

export default function HomeTopUgcVideos() {
  const { t, lang, dir } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const { t: dt } = useDemoText(lang);
  const { data, error, notFound, ref } = useLivePolling(UGC_HOME_URL);
  const rows = useMemo(() => (data ? normalizeUgcVideos(data.videos).slice(0, UGC_HOME_COUNT) : null), [data]);
  const { diffs, flash } = useRankDiff(rows, "totalRewardCents");
  const [selected, setSelected] = useState(null);
  const view = ugcViewState({ data, error, notFound, rows });
  // Live values for the open video (kept as opened if it leaves the Top 3 meanwhile).
  const current = selected ? (rows || []).find((r) => r.id === selected.id) || selected : null;
  const label = t("ugcv_podium_label");

  return (
    <>
      <HomeSectionFrame
        sectionRef={ref} dir={dir} lang={lang} hidden={view === "disabled" || view === "empty"} title={t("ugcv_home_title")} t={dt}
        icon={<Clapperboard className="h-[18px] w-[18px] shrink-0 text-violet-600" strokeWidth={2} aria-hidden="true" />}
        viewAllHref={UGC_FULL_PAGE} showViewAll
        error={error} hasData={!!data}
      >
        {Array.isArray(rows) && rows.length ? (
          <MotionConfig reducedMotion="user">
            <ol className="flex flex-col gap-2" aria-label={label} data-ugc-home-list>
              {rows.map((v) => (
                <motion.li key={v.id} layout="position" initial={false} transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.9 }} className="list-none">
                  <UgcCompactRow v={v} t={t} dt={dt} lang={lang} diff={diffs[v.id]} flash={!!flash[v.id]} onOpen={setSelected} />
                </motion.li>
              ))}
            </ol>
          </MotionConfig>
        ) : (
          <CompactSkeleton label={label} />
        )}
      </HomeSectionFrame>
      <UgcVideoModal video={current} t={t} dt={dt} lang={lang} dir={dir} onClose={() => setSelected(null)} />
    </>
  );
}
