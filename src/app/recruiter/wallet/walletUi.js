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
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const GROUP_ROW_TITLE = Object.freeze({ GROUP_REWARD: "مكافأة المجموعة", GROUP_REVERSAL: "إلغاء مكافأة المجموعة" });

/** Title of a reward history row: the group label for group rows, null otherwise. */
export function rewardRowTitle(row) {
  return Object.prototype.hasOwnProperty.call(GROUP_ROW_TITLE, row?.type) ? GROUP_ROW_TITLE[row.type] : null;
}

const pos = (v) => (Number.isInteger(v) && v >= 1 ? v : null);

/** "الدورة 2 · مجموعة من 10 أفلييت مؤهَّلين (10 طلبيات حقيقية مسلّمة لكل واحد)" — only the known parts. */
export function groupRowDetail(row) {
  const parts = [];
  const cycle = pos(row?.cycle);
  const size = pos(row?.groupSize);
  const req = pos(row?.requiredDeliveredOrders);
  if (row?.type === "GROUP_REVERSAL") parts.push("عدد الأفلييت المؤهَّلين أصبح أقل من حجم المجموعة");
  if (cycle) parts.push(`الدورة ${cycle}`);
  if (size) parts.push(`مجموعة من ${size} أفلييت مؤهَّلين${req ? ` (${req} طلبيات حقيقية مسلّمة لكل واحد + بطاقة مقبولة)` : ""}`);
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
