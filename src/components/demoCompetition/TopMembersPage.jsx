"use client";
/**
 * /top-members — the 21 demo members, polled live (every 5 s while visible).
 * DEMO / SIMULATION: the disclosure banner + a badge on every card.
 */
import { MAX_MEMBERS } from "@/lib/demoCompetition/engine";
import { useDemoText, useLivePolling } from "./useLivePolling";
import { MembersLeaderboard } from "./MemberRow";
import { SimulationBadge } from "./Badges";
import { PageShell, StatusNotice } from "./ProfileParts";

export default function TopMembersPage() {
  const { t, lang, dir } = useDemoText();
  const { data, error, ref } = useLivePolling(`/api/demo-competition/members?limit=${MAX_MEMBERS}`);
  return (
    <PageShell shellRef={ref} dir={dir} lang={lang} t={t}>
      <header className="mb-5 text-center">
        <SimulationBadge t={t} />
        <h1 className="mt-2 text-2xl font-black text-gray-900 sm:text-3xl">{t("members_title")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("members_subtitle")}</p>
      </header>
      <StatusNotice error={error} hasData={!!data} t={t} />
      <MembersLeaderboard members={data?.members} t={t} lang={lang} skeletonRows={8} showNetwork />
    </PageShell>
  );
}
