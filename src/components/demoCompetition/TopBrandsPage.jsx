"use client";
/**
 * /top-brands — the 20 brands, polled live (every 5 s while visible).
 * Simulated data: one discreet <SimulationNote> at the bottom of the page (PageShell).
 */
import { MAX_BRANDS } from "@/lib/demoCompetition/engine";
import { useDemoText, useLivePolling } from "./useLivePolling";
import { BrandsLeaderboard } from "./BrandRow";
import { PageShell, StatusNotice } from "./ProfileParts";

export default function TopBrandsPage() {
  const { t, lang, dir } = useDemoText();
  const { data, error, ref } = useLivePolling(`/api/demo-competition/brands?limit=${MAX_BRANDS}`);
  return (
    <PageShell shellRef={ref} dir={dir} lang={lang} t={t}>
      <header className="mb-5 text-center">
        <h1 className="text-2xl font-black text-gray-900 sm:text-3xl">{t("brands_title")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("brands_subtitle")}</p>
      </header>
      <StatusNotice error={error} hasData={!!data} t={t} />
      <BrandsLeaderboard brands={data?.brands} t={t} lang={lang} skeletonRows={8} />
    </PageShell>
  );
}
