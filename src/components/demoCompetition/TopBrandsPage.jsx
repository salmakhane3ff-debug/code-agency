"use client";
/**
 * /top-brands — the 20 demo brands, polled live (every 5 s while visible).
 * DEMO / SIMULATION: the disclosure banner + a badge on every card.
 */
import { MAX_BRANDS } from "@/lib/demoCompetition/engine";
import { useDemoText, useLivePolling } from "./useLivePolling";
import { BrandsLeaderboard } from "./BrandRow";
import { SimulationBadge } from "./Badges";
import { PageShell, StatusNotice } from "./ProfileParts";

export default function TopBrandsPage() {
  const { t, lang, dir } = useDemoText();
  const { data, error, ref } = useLivePolling(`/api/demo-competition/brands?limit=${MAX_BRANDS}`);
  return (
    <PageShell shellRef={ref} dir={dir} lang={lang} t={t}>
      <header className="mb-5 text-center">
        <SimulationBadge t={t} />
        <h1 className="mt-2 text-2xl font-black text-gray-900 sm:text-3xl">{t("brands_title")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("brands_subtitle")}</p>
      </header>
      <StatusNotice error={error} hasData={!!data} t={t} />
      <BrandsLeaderboard brands={data?.brands} t={t} lang={lang} skeletonRows={8} />
    </PageShell>
  );
}
