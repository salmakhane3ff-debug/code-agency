"use client";
/**
 * BrandRow — the approved leaderboard card for a brand (see LeaderCard): rank, CIRCULAR
 * product image (the brand's identity; initials fallback, never a generic logo; crown on #1),
 * brand name, owner line (small owner photo + "par <owner>"), live badge,
 * movement, earnings (30 d, count-up, orange) and orders (30 d).
 * Top-3 glow from the CURRENT rank. BrandsLeaderboard — the animated list with live diffs.
 */
import Avatar from "./Avatar";
import LeaderCard, { CardStat } from "./LeaderCard";
import { Count, Money } from "./CountUp";
import LeaderboardList, { LeaderboardSkeleton } from "./LeaderboardList";
import { useRankDiff } from "./useLivePolling";
import { flameClass } from "./flame";
import "./demoCompetition.css";

/** "par <owner>" with the owner name bidi-isolated (Latin names in Arabic keep their punctuation in place). */
function OwnerLine({ owner, t }) {
  if (!owner) return null;
  const [before, after = ""] = t("owner_by").split("{name}"); // "par {name}" / "بواسطة {name}"
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-gray-500">
      <Avatar src={owner.photoUrl} name={owner.name} id={owner.id} alt={t("photo_alt", { name: owner.name })} size={20} />
      <span className="truncate">{before}<bdi>{owner.name}</bdi>{after}</span>
    </p>
  );
}

export function BrandRow({ brand, t, lang, diff, flash }) {
  return (
    <LeaderCard
      href={`/top-brands/${encodeURIComponent(brand.id)}`}
      title={t("view_profile", { name: brand.name })}
      rank={brand.rank}
      glowClass={flameClass(brand.rank)}
      flash={flash}
      live={brand.live}
      name={brand.name}
      sub={<OwnerLine owner={brand.owner} t={t} />}
      media={<Avatar src={brand.imageUrl} name={brand.name} id={brand.id} alt={t("product_alt", { name: brand.name })} size={58} ring="ring-2 ring-violet-100 shadow-sm" />}
      diff={diff}
      rankChange24h={brand.rankChange24h}
      t={t}
      stats={(
        <>
          <CardStat label={t("earnings_30d")}>
            <Money cents={brand.earnings30dCents} lang={lang} animate className="text-orange-600" />
          </CardStat>
          <CardStat label={t("orders_30d")} divider><Count value={brand.orders30d} lang={lang} /></CardStat>
        </>
      )}
    />
  );
}

export function BrandsLeaderboard({ brands, t, lang, skeletonRows = 5 }) {
  const { diffs, flash } = useRankDiff(brands);
  const label = t("leaderboard_brands_label");
  if (!Array.isArray(brands)) return <LeaderboardSkeleton rows={skeletonRows} label={label} />;
  if (!brands.length) return <p className="rounded-2xl bg-white p-6 text-center text-sm text-gray-500">{t("empty_brands")}</p>;
  return (
    <LeaderboardList
      items={brands}
      label={label}
      renderItem={(b) => <BrandRow brand={b} t={t} lang={lang} diff={diffs[b.id]} flash={!!flash[b.id]} />}
    />
  );
}
