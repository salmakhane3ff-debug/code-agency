"use client";
/**
 * src/app/affiliate/dashboard/UgcVideosTab.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The FULL "UGC Videos" leaderboard of the SIMULATED Demo Competition (podium + every ranked video + player),
 * shown on /top-ugc-videos — the "Voir tout" page of the dashboard home's compact Top 3 section
 * (src/components/demoCompetition/ugc/HomeTopUgcVideos.jsx). NOT the real UGC tab (?tab=ugc, UgcTab.jsx).
 *
 *   · Data: ONLY the public read-only GET /api/demo-competition/ugc-videos (no auth, short CDN cache),
 *     polled through the shared Demo Competition live poller (useLivePolling: same 5 s interval as
 *     Top Members / Top Brands, paused while the browser tab is hidden or the section is off-screen,
 *     last good data kept on errors). It never calls the real UGC endpoints, orders, earnings or wallet.
 *   · Wording: neutral — no visible demo / simulation badge or explanatory note (product-owner decision); the
 *     data stays the isolated Demo Competition simulation (demo_comp_ugc_* tables), nothing real is shown.
 *   · UI: the shared Demo Competition components (RankBadge, MovementIndicator, Avatar, Money / Count,
 *     flameClass, LeaderboardSkeleton, useRankDiff, demoCompetition.css): a Top-3 podium, then the list.
 *     Each card opens the player (UgcVideoModal): the only place a video element exists.
 *   · States: loading skeleton, module disabled, empty, network error with retry, stale data notice.
 *   · Language / direction: the dashboard market language (useMarketLocale) — AR right-to-left, FR left-to-right.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useMemo, useState } from "react";
import { MotionConfig, motion } from "framer-motion";
import { AlertCircle, Clapperboard, RefreshCw } from "lucide-react";
import { useMarketLocale } from "@/context/useMarketLocale";
import { AFFILIATE_DASHBOARD_TEXT } from "@/lib/affiliateDashboardI18n";
import { useDemoText, useLivePolling, useRankDiff } from "@/components/demoCompetition/useLivePolling";
import { LeaderboardSkeleton } from "@/components/demoCompetition/LeaderboardList";
import { Count } from "@/components/demoCompetition/CountUp";
import { flameSpaceClass } from "@/components/demoCompetition/flame";
import { PodiumCard, VideoRow } from "@/components/demoCompetition/ugc/UgcVideoCards";
import UgcVideoModal from "@/components/demoCompetition/ugc/UgcVideoModal";
import { UGC_VIDEOS_URL, normalizeUgcVideos, splitPodium, ugcViewState } from "@/components/demoCompetition/ugc/ugcVideos";
import "@/components/demoCompetition/demoCompetition.css";

const SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 };

// Podium placement by position (0 = #1): phones → #1 across the width, #2 / #3 side by side;
// md+ → three columns with #1 in the middle (order), raised.
const PODIUM_CELL = [
  "col-span-2 md:col-span-1 md:order-2",
  "md:order-1 md:mt-8",
  "md:order-3 md:mt-8",
];

export default function UgcVideosTab() {
  // A retry remounts the board: a fresh poller fetches at once.
  const [attempt, setAttempt] = useState(0);
  return <UgcVideosBoard key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function UgcVideosBoard({ onRetry }) {
  const { t, lang, dir } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const { t: dt } = useDemoText(lang);
  const { data, error, notFound, ref } = useLivePolling(UGC_VIDEOS_URL);
  const rows = useMemo(() => (data ? normalizeUgcVideos(data.videos) : null), [data]);
  const { diffs, flash } = useRankDiff(rows, "totalRewardCents");
  const [selected, setSelected] = useState(null);
  const view = ugcViewState({ data, error, notFound, rows });
  const { podium, rest } = splitPodium(rows);
  // Live values for the open video (kept as opened if it leaves the list meanwhile).
  const current = selected ? (rows || []).find((r) => r.id === selected.id) || selected : null;
  const total = view === "ready" || view === "empty" ? (Number.isInteger(data?.total) ? data.total : rows.length) : null;

  return (
    <>
    <section ref={ref} dir={dir} lang={lang} className="space-y-3 text-start" data-ugc-videos-tab>
      {/* ── Header: title, live window, number of ranked videos ── */}
      <header className="overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-700 px-4 py-3.5 text-white shadow-md sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-black leading-tight sm:text-[20px]">
              <Clapperboard className="me-1.5 inline-block h-[1.05em] w-[1.05em] align-[-0.15em] text-amber-300" strokeWidth={2} aria-hidden="true" />
              {t("ugcv_title")}
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-[12px] leading-snug text-indigo-200">
              <span className="dc-live-dot dc-live-dot--green" aria-hidden="true" />
              <span className="min-w-0">{t("ugcv_subtitle")}</span>
            </p>
          </div>
          {total != null && (
            <div className="shrink-0 text-center">
              <p className="text-[28px] font-black leading-none"><Count value={total} lang={lang} /></p>
              <p className="mt-0.5 text-[11px] text-indigo-200">{t("ugcv_videos_count")}</p>
            </div>
          )}
        </div>
      </header>

      {view === "loading" && <LeaderboardSkeleton rows={4} label={t("loading")} />}

      {view === "error" && (
        <div role="alert" className="rounded-2xl border border-red-100 bg-white p-5 text-center shadow-sm">
          <AlertCircle className="mx-auto h-7 w-7 text-red-500" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold text-gray-800">{t("ugcv_error")}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-gray-900 px-4 py-2 text-xs font-bold text-white hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t("retry")}
          </button>
        </div>
      )}

      {view === "disabled" && (
        <div className="rounded-2xl border border-gray-100 bg-white p-6 text-center shadow-sm" data-ugc-disabled>
          <Clapperboard className="mx-auto h-8 w-8 text-gray-300" aria-hidden="true" />
          <p className="mt-2 text-sm font-bold text-gray-800">{t("ugcv_disabled_title")}</p>
          <p className="mt-1 text-xs text-gray-500">{t("ugcv_disabled_body")}</p>
        </div>
      )}

      {view === "empty" && (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-gray-500 shadow-sm">{t("ugcv_empty")}</p>
      )}

      {view === "ready" && (
        <MotionConfig reducedMotion="user">
          {error && (
            <p role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-gray-100 px-3 py-2 text-[12px] text-gray-600">
              <span className="min-w-0">{t("ugcv_stale")}</span>
              <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-bold text-violet-700 hover:underline">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                {t("retry")}
              </button>
            </p>
          )}

          {/* ── Podium: the Top 3 ── */}
          <ol className="grid grid-cols-2 gap-3 md:grid-cols-3" aria-label={t("ugcv_podium_label")}>
            {podium.map((v, i) => (
              <motion.li
                key={v.id}
                layout="position"
                initial={false}
                transition={SPRING}
                className={`list-none ${PODIUM_CELL[i]} ${i === 0 ? flameSpaceClass(1) : ""} ${podium.length === 2 && i === 1 ? "col-span-2 md:col-span-1" : ""}`}
              >
                <PodiumCard v={v} t={t} dt={dt} lang={lang} diff={diffs[v.id]} flash={!!flash[v.id]} onOpen={setSelected} />
              </motion.li>
            ))}
          </ol>

          {/* ── The following ranks ── */}
          {rest.length > 0 && (
            <ol className="grid grid-cols-1 gap-2 lg:grid-cols-2" aria-label={t("ugcv_list_label")}>
              {rest.map((v) => (
                <motion.li key={v.id} layout="position" initial={false} transition={SPRING} className="list-none">
                  <VideoRow v={v} t={t} dt={dt} lang={lang} diff={diffs[v.id]} flash={!!flash[v.id]} onOpen={setSelected} />
                </motion.li>
              ))}
            </ol>
          )}
        </MotionConfig>
      )}

    </section>

    {/* Outside the section (no layout box inside the leaderboard); the overlay itself resets any sibling margin (m-0). */}
    {current && (
      <UgcVideoModal video={current} t={t} dt={dt} lang={lang} dir={dir} onClose={() => setSelected(null)} />
    )}
    </>
  );
}
