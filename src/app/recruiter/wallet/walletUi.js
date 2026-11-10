/**
 * src/app/recruiter/wallet/walletUi.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System, Phase 7 Stage C: PURE display helpers of the recruiter wallet page
 * (no React, no fetch — unit-tested by scripts/recruiterDashboardUi.test.mjs). Display only: the
 * amounts come from the server (wallet totals and the /api/recruiter/progress aggregates).
 *
 *   • rewardRowTitle   the title of a group reward row ("مكافأة المجموعة" / "إلغاء مكافأة المجموعة");
 *                      null for the per-affiliate rows (their title stays the affiliate)
 *   • groupRowDetail   cycle, group size and per-affiliate threshold of a group row
 *   • walletGrossNet   gross awarded / reversed (aggregates) next to the net the wallet reports;
 *                      the difference (admin adjustments) is shown, never hidden or invented
 * Market language: the text helpers take an optional `lang` ('ar' — the default, the historical Arabic
 * output — or 'fr'); both languages live in this file (it imports nothing).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const GROUP_ROW_TITLE = Object.freeze({ GROUP_REWARD: "مكافأة المجموعة", GROUP_REVERSAL: "إلغاء مكافأة المجموعة" });
export const GROUP_ROW_TITLE_FR = Object.freeze({ GROUP_REWARD: "Récompense de groupe", GROUP_REVERSAL: "Annulation de la récompense de groupe" });

const DETAIL = Object.freeze({
  ar: Object.freeze({
    reversal: "عدد الأفلييت المؤهَّلين أصبح أقل من حجم المجموعة",
    cycle: (n) => `الدورة ${n}`,
    group: (size, req) => `مجموعة من ${size} أفلييت مؤهَّلين${req ? ` (${req} طلبيات حقيقية مسلّمة لكل واحد + بطاقة مقبولة)` : ""}`,
  }),
  fr: Object.freeze({
    reversal: "Le nombre d'affiliés éligibles est passé sous la taille du groupe",
    cycle: (n) => `Cycle ${n}`,
    group: (size, req) => `Groupe de ${size} affiliés éligibles${req ? ` (${req} commandes réelles livrées chacun + carte acceptée)` : ""}`,
  }),
});

/** Title of a reward history row: the group label for group rows, null otherwise. */
export function rewardRowTitle(row, lang = "ar") {
  const titles = lang === "fr" ? GROUP_ROW_TITLE_FR : GROUP_ROW_TITLE;
  return Object.prototype.hasOwnProperty.call(titles, row?.type) ? titles[row.type] : null;
}

const pos = (v) => (Number.isInteger(v) && v >= 1 ? v : null);

/** "الدورة 2 · مجموعة من 10 أفلييت مؤهَّلين (10 طلبيات حقيقية مسلّمة لكل واحد)" — only the known parts. */
export function groupRowDetail(row, lang = "ar") {
  const T = lang === "fr" ? DETAIL.fr : DETAIL.ar;
  const parts = [];
  const cycle = pos(row?.cycle);
  const size = pos(row?.groupSize);
  const req = pos(row?.requiredDeliveredOrders);
  if (row?.type === "GROUP_REVERSAL") parts.push(T.reversal);
  if (cycle) parts.push(T.cycle(cycle));
  if (size) parts.push(T.group(size, req));
  return parts.length ? parts.join(" · ") : "—";
}

/**
 * Gross vs reversed (from the aggregates, both positive cents) next to the wallet's net
 * (earnedCents = every ledger row). adjustmentCents = what the net holds beyond awarded − reversed
 * (admin adjustments) — 0 in the usual case.
 */
export function walletGrossNet(amounts, netCents) {
  const grossCents = Number.isInteger(amounts?.grossCents) ? amounts.grossCents : 0;
  const reversedCents = Number.isInteger(amounts?.reversedCents) ? amounts.reversedCents : 0;
  const net = Number.isInteger(netCents) ? netCents : 0;
  return { grossCents, reversedCents, netCents: net, adjustmentCents: net - (grossCents - reversedCents) };
}
