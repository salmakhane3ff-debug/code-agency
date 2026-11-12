"use client";
/**
 * CompactLeaderboard — the HOMEPAGE preview of the Demo Competition (Top Members / Top Brands):
 * short horizontal rows, the same structure for every rank (the Top 3 only get a gold / silver /
 * bronze tint and their medal), so the preview never dominates the homepage.
 *
 *   rank (medal 1-3, "#n" after) · small circular photo / product image (green dot when live)
 *   · name (crown on #1) + a details line (brand owner, live, movement)
 *   · orders (30 d) and earnings (30 d) aligned at the end · chevron.
 *
 * Every row links to the existing detail page (/top-members/[id], /top-brands/[id]) where the full
 * information lives (24 h / 7 d / 30 d / all-time, network, history, recent activity). The full
 * listing pages keep the detailed cards (MemberRow / BrandRow → LeaderCard). Live updates: the
 * rows reorder with framer-motion (reduced motion respected) and flash when a value changes.
 */
import Link from "next/link";
import { MotionConfig, motion } from "framer-motion";
import { ChevronRight, Crown } from "lucide-react";
import Avatar from "./Avatar";
import { Count, Money } from "./CountUp";
import { LiveBadge, MovementIndicator, RankBadge } from "./Badges";
import { useRankDiff } from "./useLivePolling";
import "./demoCompetition.css";

const TOP = { 1: "dc-row--1", 2: "dc-row--2", 3: "dc-row--3" };

/** Medal (gold / silver / bronze disc) for 1-3, a discreet "#n" for the others. */
function RankMark({ rank, t }) {
  if (rank >= 1 && rank <= 3) return <RankBadge rank={rank} t={t} size="sm" />;
  return (
    <span className="inline-flex h-6 min-w-6 items-center justify-center text-[12px] font-bold tabular-nums text-gray-400" aria-label={t("rank_label", { rank })} title={t("rank_label", { rank })}>
      <bdi dir="ltr">#{rank}</bdi>
    </span>
  );
}

/** "par <owner>" with the owner name bidi-isolated. */
function OwnerText({ owner, t }) {
  if (!owner) return null;
  const [before, after = ""] = t("owner_by").split("{name}");
  return <span className="min-w-0 truncate">{before}<bdi>{owner.name}</bdi>{after}</span>;
}

export function CompactRow({ kind, item, t, lang, diff, flash }) {
  const isBrand = kind === "brand";
  const href = `/${isBrand ? "top-brands" : "top-members"}/${encodeURIComponent(item.id)}`;
  const image = isBrand ? item.imageUrl : item.photoUrl;
  const alt = isBrand ? t("product_alt", { name: item.name }) : t("photo_alt", { name: item.name });
  return (
    <Link
      href={href}
      title={t("view_profile", { name: item.name })}
      className={`dc-row ${TOP[item.rank] || ""} ${flash ? "dc-highlight" : ""} flex min-h-[60px] items-center gap-2 rounded-xl border px-2 py-2 min-[400px]:gap-2.5 min-[400px]:px-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500`}
    >
      <span className="flex w-6 shrink-0 justify-center min-[400px]:w-7"><RankMark rank={item.rank} t={t} /></span>
      <span className="relative shrink-0">
        <Avatar src={image} name={item.name} id={item.id} alt={alt} size={34} ring={isBrand ? "ring-1 ring-violet-100" : ""} />
        {item.live && <span className="dc-online-dot dc-online-dot--sm" title={t("live_title")} aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-1 text-[14px] font-bold leading-tight text-gray-900">
          {item.rank === 1 && <Crown className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" fill="currentColor" strokeWidth={1.5} aria-hidden="true" />}
          <bdi className="line-clamp-2 break-words">{item.name}</bdi>
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-tight text-gray-500">
          {isBrand && <OwnerText owner={item.owner} t={t} />}
          <LiveBadge live={item.live} t={t} />
          <MovementIndicator diff={diff} rankChange24h={item.rankChange24h} t={t} compact />
        </span>
      </span>
      <span className="shrink-0 text-end leading-tight">
        <span className="block text-[14px] font-extrabold text-gray-900" title={t("orders_30d")}>
          <Count value={item.orders30d} lang={lang} />
          <span className="ms-1 text-[11px] font-medium text-gray-400">{t("orders_short")}</span>
        </span>
        <span className="mt-0.5 block text-[12.5px] font-bold" title={t("earnings_30d")}>
          <Money cents={item.earnings30dCents} lang={lang} animate className="text-orange-600" />
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 rtl:rotate-180" aria-hidden="true" />
    </Link>
  );
}

/** Placeholder rows while the first response is loading. */
function CompactSkeleton({ rows, label }) {
  return (
    <ol className="flex flex-col gap-2" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex h-[60px] list-none items-center gap-2.5 rounded-xl border border-gray-100 bg-white px-2.5 motion-safe:animate-pulse">
          <span className="h-6 w-6 rounded-full bg-gray-200" />
          <span className="h-[34px] w-[34px] rounded-full bg-gray-200" />
          <span className="h-3.5 flex-1 rounded bg-gray-200" />
          <span className="h-3.5 w-16 rounded bg-gray-200" />
        </li>
      ))}
    </ol>
  );
}

/** kind: "member" | "brand". items: the API's members / brands (null while loading). */
export default function CompactLeaderboard({ kind, items, t, lang, skeletonRows = 5 }) {
  const { diffs, flash } = useRankDiff(items);
  const label = t(kind === "brand" ? "leaderboard_brands_label" : "leaderboard_members_label");
  if (!Array.isArray(items)) return <CompactSkeleton rows={skeletonRows} label={label} />;
  if (!items.length) return <p className="rounded-xl bg-gray-50 p-4 text-center text-sm text-gray-500">{t(kind === "brand" ? "empty_brands" : "empty_members")}</p>;
  return (
    <MotionConfig reducedMotion="user">
      <ol className="flex flex-col gap-2" aria-label={label}>
        {items.map((item) => (
          <motion.li key={item.id} layout="position" initial={false} transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.9 }} className="list-none">
            <CompactRow kind={kind} item={item} t={t} lang={lang} diff={diffs[item.id]} flash={!!flash[item.id]} />
          </motion.li>
        ))}
      </ol>
    </MotionConfig>
  );
}
