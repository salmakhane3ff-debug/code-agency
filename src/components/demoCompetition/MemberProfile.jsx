"use client";
/**
 * /top-members/[id] — a member's public profile, polled live.
 * Personal earnings and the NETWORK earnings are kept separate (the
 * ranking uses the personal ones only); "not configured" when the network is off.
 */
import Link from "next/link";
import Avatar from "./Avatar";
import { LiveBadge, MovementIndicator, RankBadge } from "./Badges";
import {
  BackLink, HistoryChart, NotFoundState, PageShell, PeriodTiles, ProfileSkeleton, RecentActivity, Section, StatTile, StatusNotice,
} from "./ProfileParts";
import { useDemoText, useLivePolling } from "./useLivePolling";
import { flameClass } from "./flame";
import "./demoCompetition.css";

export default function MemberProfile({ id }) {
  const { t, lang, dir } = useDemoText();
  const { data, error, notFound, ref } = useLivePolling(`/api/demo-competition/members/${encodeURIComponent(id)}`);
  const m = data?.member;

  let body;
  if (notFound) {
    body = <NotFoundState title={t("not_found_member_title")} text={t("not_found_member_text")} href="/top-members" back={t("back_members")} />;
  } else if (!m) {
    body = <><StatusNotice error={error} hasData={false} t={t} />{!error && <ProfileSkeleton />}</>;
  } else {
    const s = m.stats || {};
    const n = m.network || {};
    const configured = !!n.configured;
    const streams = [
      { key: "earningsCents", ordersKey: "orders", label: t("legend_personal"), color: "bg-amber-500", swatch: "bg-amber-500" },
      ...(configured ? [{ key: "networkEarningsCents", ordersKey: "networkOrders", label: t("legend_network"), color: "bg-indigo-400", swatch: "bg-indigo-400" }] : []),
    ];
    body = (
      <>
        <StatusNotice error={error} hasData t={t} />
        <div className={`relative isolate rounded-2xl ${flameClass(m.rank)} ${m.rank <= 3 ? "mt-6" : ""}`}>
          <div className="dc-flame-inner rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-4">
              <Avatar src={m.photoUrl} name={m.name} id={m.id} alt={t("photo_alt", { name: m.name })} size={80} ring="ring-4 ring-amber-100" />
              <div className="min-w-0 flex-1">
                <h1 className="break-words text-xl font-black text-gray-900 sm:text-2xl"><bdi>{m.name}</bdi></h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-600">
                  <RankBadge rank={m.rank} t={t} />
                  <span>{t("rank_of", { rank: m.rank, total: m.total })}</span>
                  <MovementIndicator rankChange24h={m.rankChange24h} t={t} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 empty:hidden">
                  <LiveBadge live={m.live} t={t} />
                </div>
              </div>
            </div>
          </div>
        </div>

        <Section title={t("personal_title")}>
          <PeriodTiles
            values={{ h24: s.earnings24hCents, d7: s.earnings7dCents, d30: s.earnings30dCents, all: s.earningsAllCents }}
            t={t} lang={lang} tone="text-amber-700"
            extra={<StatTile label={t("total_orders")} count={s.ordersAll ?? 0} lang={lang} />}
          />
        </Section>

        <Section title={t("network_title")}>
          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label={t("network_affiliates")} count={n.affiliates ?? 0} lang={lang} />
          </div>
          {configured ? (
            <>
              <PeriodTiles
                values={{ h24: n.earnings24hCents, d7: n.earnings7dCents, d30: n.earnings30dCents, all: n.earningsAllCents }}
                t={t} lang={lang} tone="text-indigo-700"
              />
              <p className="mt-2 text-xs text-gray-500">{t("network_note")}</p>
            </>
          ) : (
            <>
              <PeriodTiles values={null} t={t} lang={lang} empty={t("not_configured")} />
              <p className="mt-2 text-xs text-gray-500">{t("network_off")}</p>
            </>
          )}
        </Section>

        <Section title={t("owned_brands")}>
          {Array.isArray(m.brands) && m.brands.length ? (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {m.brands.map((b) => (
                <li key={b.id}>
                  <Link href={`/top-brands/${encodeURIComponent(b.id)}`} className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-2.5 shadow-sm hover:shadow-md">
                    <Avatar src={b.imageUrl} name={b.name} id={b.id} alt={t("product_alt", { name: b.name })} size={40} ring="ring-2 ring-amber-100" />
                    <span className="min-w-0 flex-1 truncate text-sm font-bold text-gray-900"><bdi>{b.name}</bdi></span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-gray-500">{t("no_brands")}</p>}
        </Section>

        <Section title={t("history_title")}>
          <HistoryChart daily={m.history?.daily} streams={streams} t={t} lang={lang} />
        </Section>

        <Section title={t("recent_title")}>
          <RecentActivity recent={m.history?.recent} asOf={data.asOf} t={t} lang={lang} />
        </Section>
      </>
    );
  }

  return (
    <PageShell shellRef={ref} dir={dir} lang={lang} t={t}>
      <BackLink href="/top-members" label={t("back_members")} />
      {body}
    </PageShell>
  );
}
