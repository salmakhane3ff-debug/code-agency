"use client";
/**
 * LeaderCard — the approved Demo Competition card, shared by Top Members and Top Brands
 * (homepage, /top-members, /top-brands, affiliate dashboard).
 *
 *   rank (gold / silver / bronze for 1-3) · circular photo or product image (crown on #1,
 *   green "online" dot when there was activity in the last minutes) · name, optional
 *   sub-line (brand owner), "En direct" badge when live · movement (▲ +1 / ▼ -1 / =)
 *   · stats (earnings 30 d in orange, orders 30 d, …). No per-card simulation label: the
 *   page carries one discreet <SimulationNote> (src/lib/demoCompetition/disclosure.js).
 *
 * Layout is driven by the card's OWN width (container queries, `@container` on each list row):
 *   narrow (phones, and each column of the desktop two-column block) → two rows, the stats
 *   under the name (full card width below 24rem so the labels never truncate, else starting
 *   under the photo);
 *   wide (≥ 42rem, e.g. the featured leader of a 768 px list) → ONE row, the stats inline
 *   before the movement — so a wide screen never just stretches the phone card. Only for
 *   2-stat cards; a 3-stat card keeps two rows (see LAYOUT).
 * The Top-3 glow comes from flameClass(rank) (classes dc-flame / dc-flame--N).
 */
import Link from "next/link";
import { Crown } from "lucide-react";
import { LiveBadge, MovementIndicator, RankBadge } from "./Badges";
import "./demoCompetition.css";

/**
 * One statistic of the card. `divider` draws the separator before it (logical side: RTL-safe).
 * Labels never truncate: they may use a second line (the values stay aligned at the bottom).
 */
export function CardStat({ label, children, divider = false }) {
  return (
    <div className={`flex min-w-0 flex-col justify-end ${divider ? "border-s border-gray-100 ps-3" : ""}`}>
      <dt className="line-clamp-2 text-[11px] leading-tight text-gray-500 @sm:text-[12px]">{label}</dt>
      <dd className="mt-0.5 truncate text-[17px] font-black leading-tight text-gray-900 sm:text-lg">{children}</dd>
    </div>
  );
}

// dc-stats-3 (demoCompetition.css): on a narrow card the 3 columns are re-sized for the money values (see there).
const STAT_COLS = { 2: "grid-cols-2", 3: "grid-cols-3 dc-stats-3" };

// Card grid. The one-row layout (wide card) is used only with 2 stats: a 3-stat card (the full
// /top-members list, with the network column) keeps the two-row layout at every width, so the
// name never gets squeezed.
const LAYOUT = {
  wide: {
    grid: "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 @2xl:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] @2xl:gap-x-4",
    move: "self-start justify-self-end pt-0.5 @2xl:col-start-5 @2xl:row-start-1 @2xl:flex @2xl:w-14 @2xl:justify-end @2xl:self-center @2xl:pt-0",
    stats: "col-span-4 col-start-1 border-t border-gray-100 pt-2.5 @sm:col-span-3 @sm:col-start-2 @2xl:col-span-1 @2xl:col-start-4 @2xl:row-start-1 @2xl:w-[20rem] @2xl:border-t-0 @2xl:pt-0",
  },
  stacked: {
    grid: "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5",
    move: "self-start justify-self-end pt-0.5",
    stats: "col-span-4 col-start-1 border-t border-gray-100 pt-2.5 @sm:col-span-3 @sm:col-start-2",
  },
};

export default function LeaderCard({
  href, title, rank, glowClass = "", flash = false, media, live = false, name, sub = null,
  stats, statCount = 2, diff, rankChange24h, t,
}) {
  const L = statCount === 2 ? LAYOUT.wide : LAYOUT.stacked;
  return (
    <Link
      href={href}
      title={title}
      className="block rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
    >
      <article className={`dc-card ${glowClass} ${flash ? "dc-highlight" : ""} p-3 sm:p-3.5`}>
        <div className={L.grid}>
          <RankBadge rank={rank} t={t} size="card" />
          <div className="relative shrink-0">
            {rank === 1 && <Crown className="dc-crown" fill="currentColor" strokeWidth={1.5} aria-hidden="true" />}
            {media}
            {live && <span className="dc-online-dot" title={t("live_title")} aria-hidden="true" />}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[16px] font-extrabold leading-snug text-gray-900"><bdi>{name}</bdi></p>
            {sub}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 empty:hidden">
              <LiveBadge live={live} t={t} />
            </div>
          </div>
          <div className={L.move}>
            <MovementIndicator diff={diff} rankChange24h={rankChange24h} t={t} />
          </div>
          <dl className={`grid ${STAT_COLS[statCount] || "grid-cols-2"} gap-x-3 ${L.stats}`}>
            {stats}
          </dl>
        </div>
      </article>
    </Link>
  );
}
