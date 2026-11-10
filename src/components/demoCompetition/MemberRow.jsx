"use client";
/**
 * MemberRow — the approved leaderboard card for a demo member (see LeaderCard): rank, circular
 * photo (crown on #1, "online" dot when live), name, live + SIMULATION badges, movement, demo
 * earnings (30 d, count-up, orange) and demo orders (30 d). `showNetwork` (the full /top-members
 * page) adds the separate demo network earnings (30 d) — never mixed into the ranking.
 * Top-3 glow from the CURRENT rank. MembersLeaderboard — the animated list with live diffs.
 */
import Avatar from "./Avatar";
import LeaderCard, { CardStat } from "./LeaderCard";
import { Count, Money } from "./CountUp";
import LeaderboardList, { LeaderboardSkeleton } from "./LeaderboardList";
import { useRankDiff } from "./useLivePolling";
import { flameClass } from "./flame";
import "./demoCompetition.css";

export function MemberRow({ member, t, lang, diff, flash, showNetwork = false }) {
  const hasNetwork = (member.networkAffiliates ?? 0) > 0 || (member.networkEarnings30dCents ?? 0) > 0;
  return (
    <LeaderCard
      href={`/top-members/${encodeURIComponent(member.id)}`}
      title={t("view_profile", { name: member.name })}
      rank={member.rank}
      glowClass={flameClass(member.rank)}
      flash={flash}
      live={member.live}
      name={member.name}
      media={<Avatar src={member.photoUrl} name={member.name} id={member.id} alt={t("photo_alt", { name: member.name })} size={56} ring="ring-2 ring-white shadow-sm" />}
      diff={diff}
      rankChange24h={member.rankChange24h}
      t={t}
      statCount={showNetwork ? 3 : 2}
      stats={(
        <>
          <CardStat label={t("earnings_30d")}>
            <Money cents={member.earnings30dCents} lang={lang} animate className="text-orange-600" />
          </CardStat>
          <CardStat label={t("orders_30d")} divider><Count value={member.orders30d} lang={lang} /></CardStat>
          {showNetwork && (
            <CardStat label={t("network_30d")} divider>
              {hasNetwork
                ? <Money cents={member.networkEarnings30dCents} lang={lang} animate className="text-indigo-700" />
                : <span className="text-xs font-medium text-gray-400">{t("not_configured")}</span>}
            </CardStat>
          )}
        </>
      )}
    />
  );
}

export function MembersLeaderboard({ members, t, lang, skeletonRows = 5, showNetwork = false }) {
  const { diffs, flash } = useRankDiff(members);
  const label = t("leaderboard_members_label");
  if (!Array.isArray(members)) return <LeaderboardSkeleton rows={skeletonRows} label={label} />;
  if (!members.length) return <p className="rounded-2xl bg-white p-6 text-center text-sm text-gray-500">{t("empty_members")}</p>;
  return (
    <LeaderboardList
      items={members}
      label={label}
      renderItem={(m) => <MemberRow member={m} t={t} lang={lang} diff={diffs[m.id]} flash={!!flash[m.id]} showNetwork={showNetwork} />}
    />
  );
}
