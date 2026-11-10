/**
 * /tsajlim3ana — public affiliate-recruitment landing page. The visible UI follows
 * the visitor's market (MA → Darija/RTL, FR → French/LTR) in the client components;
 * the metadata below stays in Darija (server-rendered, unchanged).
 *
 * The enabled/disabled flag is enforced SERVER-SIDE here (not just in the UI):
 *   • disabled → render a simple "unavailable" page + robots noindex, and the
 *     landing content is never sent to the client.
 *   • enabled  → render the landing; indexable.
 * Statistics + team-% range are read server-side (cached / reused affiliate
 * config); competition + live feed are fetched client-side from public cached
 * endpoints. The WhatsApp CTA link is resolved from the existing support settings.
 */
import { getSettings } from "@/lib/services/settingsService";
import { getTeamBonusConfig } from "@/lib/services/affiliateSystemService";
import { getRecruitmentStats } from "@/lib/services/recruitmentData";
import { normalizeRecruitmentConfig, buildRecruitmentWhatsappLink, teamRangeFromTiers } from "@/lib/recruitmentCta";
import RecruitmentLanding, { RecruitmentUnavailable } from "./RecruitmentLanding";

export const dynamic = "force-dynamic";

async function loadConfig() {
  const raw = await getSettings("recruitment-landing").catch(() => null);
  return normalizeRecruitmentConfig(raw);
}

export async function generateMetadata() {
  const config = await loadConfig();
  return {
    title: "سجلي معانا — ربحي دخل إضافي وأنتِ فالدار",
    description: "برنامج الأفلييت: ربحي من الدار عبر تأكيد الطلبات وفيديوهات UGC. إحنا كنجيبو الطلبات والزبناء وإنتِ غير كتأكدي.",
    robots: config.enabled ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function TsajlimPage() {
  const [config, support] = await Promise.all([
    loadConfig(),
    getSettings("affiliate-support").catch(() => null),
  ]);

  // Server-side gate — disabled means the content is never rendered/sent.
  if (!config.enabled) {
    // Tiny client view: same markup as before, but text + direction follow the market.
    return <RecruitmentUnavailable />;
  }

  // Real stats (cached) + team % range reused from the affiliate commission tiers.
  const [stats, bonusCfg] = await Promise.all([
    config.statistics.enabled ? getRecruitmentStats().catch(() => null) : Promise.resolve(null),
    getTeamBonusConfig().catch(() => null),
  ]);
  const teamRange = teamRangeFromTiers(bonusCfg?.commissionTiers);
  const whatsappLink = buildRecruitmentWhatsappLink(support);

  return <RecruitmentLanding config={config} whatsappLink={whatsappLink} stats={stats} teamRange={teamRange} />;
}
