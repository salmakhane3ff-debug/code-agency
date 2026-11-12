"use client";
/**
 * Homepage builder section "top_brands": a COMPACT preview panel — tag icon + title + live dot +
 * "Démo / Simulation" badge + small "Voir tout" → /top-brands (when showViewAll), then the
 * previewCount short rows with the small product images (CompactLeaderboard), polled live ONLY
 * while the section is in view. Each row opens the brand's detail page. The simulation disclaimer
 * is in the block banner. An empty competition hides the section (reported to the block).
 */
import { Tag } from "lucide-react";
import { MAX_BRANDS } from "@/lib/demoCompetition/engine";
import { useDemoText, useNeutralDemoText, useLivePolling } from "./useLivePolling";
import CompactLeaderboard from "./CompactLeaderboard";
import { previewCountOf } from "./HomeTopMembers";
import HomeSectionFrame from "./HomeSectionFrame";
import { useDemoBlockReport } from "./DemoCompetitionBlock";

/** `lang` (optional): the page's own language (the Affiliate Dashboard passes its market language); default: the site language. */
export default function HomeTopBrands({ data = {}, sectionId = "top_brands", lang: langOverride }) {
  const { t, lang, dir } = useNeutralDemoText(useDemoText(langOverride));
  const count = previewCountOf(data.previewCount, MAX_BRANDS);
  const { data: res, error, ref } = useLivePolling(`/api/demo-competition/brands?limit=${count}`);
  const brands = res?.brands;
  const empty = Array.isArray(brands) && brands.length === 0;
  useDemoBlockReport(sectionId, empty, "brand", res?.total);
  const title = (typeof data.title === "string" && data.title.trim()) || t("brands_title");

  return (
    <HomeSectionFrame
      sectionRef={ref} dir={dir} lang={lang} hidden={empty} title={title} t={t}
      icon={<Tag className="h-[18px] w-[18px] shrink-0 -scale-x-100 text-violet-600 rtl:scale-x-100" strokeWidth={2.4} aria-hidden="true" />}
      viewAllHref="/top-brands" showViewAll={data.showViewAll !== false}
      error={error} hasData={!!res}
    >
      <CompactLeaderboard kind="brand" items={brands} t={t} lang={lang} skeletonRows={Math.min(count, 5)} />
    </HomeSectionFrame>
  );
}
