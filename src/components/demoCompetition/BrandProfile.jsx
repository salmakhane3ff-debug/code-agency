"use client";
/**
 * /top-brands/[id] — a demo brand's public profile, polled live. The circular
 * product image is the brand's identity; the owner block links to the owner's
 * member profile only when the owner is public (active).
 */
import Link from "next/link";
import Avatar from "./Avatar";
import { LiveBadge, MovementIndicator, RankBadge, SimulationBadge } from "./Badges";
import {
  BackLink, HistoryChart, NotFoundState, PageShell, PeriodTiles, ProfileSkeleton, RecentActivity, Section, StatTile, StatusNotice,
} from "./ProfileParts";
import { useDemoText, useLivePolling } from "./useLivePolling";
import { flameClass } from "./flame";
import "./demoCompetition.css";

function OwnerBlock({ owner, t }) {
  if (!owner) return null;
  const inner = (
    <>
      <Avatar src={owner.photoUrl} name={owner.name} id={owner.id} alt={t("photo_alt", { name: owner.name })} size={32} />
      <span className="min-w-0">
        <span className="block text-[11px] text-gray-500">{t("owner_label")}</span>
        <span className="block truncate text-sm font-bold text-gray-900"><bdi>{owner.name}</bdi></span>
      </span>
    </>
  );
  return owner.public ? (
    <Link
      href={`/top-members/${encodeURIComponent(owner.id)}`}
      className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-gray-100 bg-gray-50 py-1 pe-4 ps-1 hover:bg-gray-100"
      title={t("view_profile", { name: owner.name })}
    >
      {inner}
    </Link>
  ) : (
    <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-gray-100 bg-gray-50 py-1 pe-4 ps-1">{inner}</div>
  );
}

export default function BrandProfile({ id }) {
  const { t, lang, dir } = useDemoText();
  const { data, error, notFound, ref } = useLivePolling(`/api/demo-competition/brands/${encodeURIComponent(id)}`);
  const b = data?.brand;

  let body;
  if (notFound) {
    body = <NotFoundState title={t("not_found_brand_title")} text={t("not_found_brand_text")} href="/top-brands" back={t("back_brands")} />;
  } else if (!b) {
    body = <><StatusNotice error={error} hasData={false} t={t} />{!error && <ProfileSkeleton />}</>;
  } else {
    const s = b.stats || {};
    body = (
      <>
        <StatusNotice error={error} hasData t={t} />
        <div className={`${flameClass(b.rank) || "rounded-2xl"} ${b.rank <= 3 ? "mt-6" : ""}`}>
          <div className="dc-flame-inner rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-4">
              <Avatar src={b.imageUrl} name={b.name} id={b.id} alt={t("product_alt", { name: b.name })} size={96} ring="ring-4 ring-amber-100" />
              <div className="min-w-0 flex-1">
                <h1 className="break-words text-xl font-black text-gray-900 sm:text-2xl"><bdi>{b.name}</bdi></h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-600">
                  <RankBadge rank={b.rank} t={t} />
                  <span>{t("rank_of", { rank: b.rank, total: b.total })}</span>
                  <MovementIndicator rankChange24h={b.rankChange24h} t={t} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <LiveBadge live={b.live} t={t} />
                  <SimulationBadge t={t} />
                </div>
              </div>
            </div>
            <OwnerBlock owner={b.owner} t={t} />
          </div>
        </div>

        <Section title={t("stats_title")}>
          <PeriodTiles
            values={{ h24: s.earnings24hCents, d7: s.earnings7dCents, d30: s.earnings30dCents, all: s.earningsAllCents }}
            t={t} lang={lang} tone="text-amber-700"
            extra={<StatTile label={t("total_orders")} count={s.ordersAll ?? 0} lang={lang} />}
          />
        </Section>

        <Section title={t("history_title")}>
          <HistoryChart
            daily={b.history?.daily}
            streams={[{ key: "earningsCents", ordersKey: "orders", label: t("legend_brand"), color: "bg-orange-500", swatch: "bg-orange-500" }]}
            t={t} lang={lang}
          />
        </Section>

        <Section title={t("recent_title")}>
          <RecentActivity recent={b.history?.recent} asOf={data.asOf} t={t} lang={lang} />
        </Section>
      </>
    );
  }

  return (
    <PageShell shellRef={ref} dir={dir} lang={lang} t={t}>
      <BackLink href="/top-brands" label={t("back_brands")} />
      {body}
    </PageShell>
  );
}
