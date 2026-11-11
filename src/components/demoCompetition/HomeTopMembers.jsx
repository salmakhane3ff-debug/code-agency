"use client";
/**
 * Homepage builder section "top_members": a COMPACT preview panel — trophy + title + live dot +
 * "Démo / Simulation" badge + small "Voir tout" → /top-members (when showViewAll), then the
 * previewCount short rows (CompactLeaderboard), polled live ONLY while the section is in view.
 * Each row opens the member's detail page. The simulation disclaimer is in the block banner.
 * An empty competition hides the section (reported to the DemoCompetitionBlock, with the total).
 */
import { Trophy } from "lucide-react";
import { MAX_MEMBERS } from "@/lib/demoCompetition/engine";
import { useDemoText, useNeutralDemoText, useLivePolling } from "./useLivePolling";
import CompactLeaderboard from "./CompactLeaderboard";
import HomeSectionFrame from "./HomeSectionFrame";
import { useDemoBlockReport } from "./DemoCompetitionBlock";

export const HOME_PREVIEW_DEFAULT = 5;

/** previewCount → integer in [1, max] (missing / invalid → 5). */
export function previewCountOf(value, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return Math.min(HOME_PREVIEW_DEFAULT, max);
  return Math.min(max, Math.max(1, n));
}

/** `lang` (optional): the page's own language (the Affiliate Dashboard passes its market language); default: the site language. */
export default function HomeTopMembers({ data = {}, sectionId = "top_members", lang: langOverride }) {
  const { t, lang, dir } = useNeutralDemoText(useDemoText(langOverride));
  const count = previewCountOf(data.previewCount, MAX_MEMBERS);
  const { data: res, error, ref } = useLivePolling(`/api/demo-competition/members?limit=${count}`);
  const members = res?.members;
  const empty = Array.isArray(members) && members.length === 0;
  useDemoBlockReport(sectionId, empty, "member", res?.total);
  const title = (typeof data.title === "string" && data.title.trim()) || t("members_title");

  return (
    <HomeSectionFrame
      sectionRef={ref} dir={dir} lang={lang} hidden={empty} title={title} t={t}
      icon={<Trophy className="h-[18px] w-[18px] shrink-0 text-amber-500" fill="#fcd34d" strokeWidth={1.8} aria-hidden="true" />}
      viewAllHref="/top-members" showViewAll={data.showViewAll !== false}
      error={error} hasData={!!res}
    >
      <CompactLeaderboard kind="member" items={members} t={t} lang={lang} skeletonRows={Math.min(count, 5)} />
    </HomeSectionFrame>
  );
}
