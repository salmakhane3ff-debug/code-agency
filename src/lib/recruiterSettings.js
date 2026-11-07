/**
 * src/lib/recruiterSettings.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — PURE settings rules (no database, no I/O).
 *
 * Settings are append-only versions (recruiter_settings_versions) set by the admin;
 * the current settings are the highest version, and with no row at all the built-in
 * DEFAULTS apply (rewards OFF, 10 orders). A reward row records the version it was
 * computed with, so a later settings change never alters an existing reward.
 *
 * Rewards are in MAD only (integer cents: 1500 = 15.00 MAD), in a ledger that is
 * completely separate from affiliate balances, commissions, reward points and payouts.
 * Rewards are recorded in versioned CYCLES per affiliate created by the recruiter: cycle n =
 * one reward (key recruit:<affiliateId>:v<n>) and, if the affiliate later falls below the
 * threshold, one compensating reversal (key reverse:<affiliateId>:v<n>); the affiliate may then
 * qualify again in cycle n+1. One reward and one reversal per (affiliate, cycle) — idempotency
 * keys + DB unique indexes. Pre-cycle rows keep their legacy keys as cycle 1.
 *
 * A reward is due — and recorded immediately — when the affiliate CREATED by the
 * recruiter has BOTH:
 *   1. at least `minDeliveredSales` REAL delivered orders (default 10):
 *      AffiliateOrder.status === 'delivered' AND isFake === false
 *      (cancelled, pending, confirmed, shipped and fake orders never count);
 *   2. an APPROVED CIN in the EXISTING identity workflow:
 *      IdentityVerification.status === 'APPROVED' — set only by an admin
 *      (adminApproveIdentity); never by a login or a submission.
 * Nothing else is read: in particular no UGC data of any kind.
 *
 * Reward B — GROUP reward (Phase 7, migration 20261112), configured in the SAME settings versions
 * (groupEnabled, groupRewardAmountCents, groupSize, groupMinDeliveredSales; defaults OFF, 0, 10, 10):
 * a recruiter earns the group amount each time `groupSize` DISTINCT affiliates of the network they own are
 * each qualified (real delivered orders ≥ groupMinDeliveredSales AND identity APPROVED — the same two
 * data sources as above; one affiliate counts once whatever its sales; sales are never aggregated).
 * Entitlement = floor(qualified / groupSize) active (non-reversed) group rewards; group cycles are
 * per recruiter (keys group:<recruiterId>:v<n> / group-reverse:<recruiterId>:v<n>).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const CURRENCY = 'MAD';
export const MAX_REWARD_CENTS = 100_000_000;   // mirrors the DB CHECK (1,000,000.00 MAD)
export const MIN_SALES_RANGE = Object.freeze({ min: 1, max: 100_000 }); // mirrors the DB CHECK
export const DEFAULT_MIN_DELIVERED_SALES = 10;

/** Data sources of the two conditions (read by the later reward service). */
export const IDENTITY_APPROVED_STATUS = 'APPROVED'; // IdentityVerification.status (admin approval only)
export const DELIVERED_ORDER_STATUS = 'delivered';  // AffiliateOrder.status, counted only with isFake = false

export const REWARD_TYPES = Object.freeze({
  RECRUIT_REWARD: 'RECRUIT_REWARD', REVERSAL: 'REVERSAL', ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
  // Phase 7 (migration 20261112): the group reward of a recruiter and its compensating reversal.
  GROUP_REWARD: 'GROUP_REWARD', GROUP_REVERSAL: 'GROUP_REVERSAL',
});
export const AUDIT_ACTOR_TYPES = Object.freeze(['RECRUITER', 'ADMIN', 'SYSTEM']);

/** Built-in defaults when no settings version exists yet: rewards OFF, 10 orders. */
export const DEFAULT_RECRUITER_SETTINGS = Object.freeze({
  version: 0,
  enabled: false,
  rewardAmountCents: 0,
  minDeliveredSales: DEFAULT_MIN_DELIVERED_SALES,
});

/** Idempotency key of the single recruit reward / reversal of an affiliate. */
export const recruitRewardKey = (affiliateId) => `recruit:${affiliateId}`;
export const reversalKey = (affiliateId) => `reverse:${affiliateId}`;
/** Cycle-specific keys (Phase 6 part 3a): cycle n = recruit:<id>:v<n> / reverse:<id>:v<n>. */
export const recruitRewardCycleKey = (affiliateId, cycle) => `recruit:${affiliateId}:v${cycle}`;
export const reversalCycleKey = (affiliateId, cycle) => `reverse:${affiliateId}:v${cycle}`;

/** Group reward (Phase 7): ranges mirror the DB CHECK recruiter_settings_versions_group_check. */
export const GROUP_SIZE_RANGE = Object.freeze({ min: 1, max: 10_000 });
export const DEFAULT_GROUP_SIZE = 10;
export const DEFAULT_GROUP_MIN_DELIVERED_SALES = 10;
/** Built-in group defaults (and what every settings row written before 20261112 reads): OFF, 0, 10, 10. */
export const DEFAULT_RECRUITER_GROUP_SETTINGS = Object.freeze({
  groupEnabled: false,
  groupRewardAmountCents: 0,
  groupSize: DEFAULT_GROUP_SIZE,
  groupMinDeliveredSales: DEFAULT_GROUP_MIN_DELIVERED_SALES,
});
/** Group cycle keys (per RECRUITER): cycle n = group:<recruiterId>:v<n> / group-reverse:<recruiterId>:v<n>. */
export const groupRewardCycleKey = (recruiterId, cycle) => `group:${recruiterId}:v${cycle}`;
export const groupReversalCycleKey = (recruiterId, cycle) => `group-reverse:${recruiterId}:v${cycle}`;

const bool = (v) => v === true || v === 'true';
const intIn = (v, min, max) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
};

/** "15", "15.5", "15,50", 15.5 → cents (MAD), or NaN. */
export function parseMadToCents(value) {
  let s;
  if (typeof value === 'number') { if (!Number.isFinite(value)) return NaN; s = String(value); }
  else if (typeof value === 'string') s = value.trim().replace(',', '.');
  else return NaN;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return NaN;
  const [w, f = ''] = s.split('.');
  const cents = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return cents <= MAX_REWARD_CENTS ? cents : NaN;
}

/**
 * Admin input → the next settings version's values, or { errors }.
 * The reward is entered in MAD (e.g. "150" or "150.50") and stored in cents; the number
 * of required orders defaults to 10 and must be 1–100000.
 */
export function validateRecruiterSettingsInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const enabled = bool(src.enabled);
  const rewardAmountCents = parseMadToCents(src.rewardAmountMad ?? '0');
  if (Number.isNaN(rewardAmountCents)) errors.rewardAmountMad = 'INVALID_AMOUNT';
  else if (enabled && rewardAmountCents === 0) errors.rewardAmountMad = 'AMOUNT_REQUIRED_WHEN_ENABLED';
  const minDeliveredSales = intIn(src.minDeliveredSales ?? DEFAULT_MIN_DELIVERED_SALES, MIN_SALES_RANGE.min, MIN_SALES_RANGE.max);
  if (Number.isNaN(minDeliveredSales)) errors.minDeliveredSales = 'INVALID_COUNT';
  if (Object.keys(errors).length) return { errors };
  return { value: { enabled, rewardAmountCents, minDeliveredSales } };
}

/**
 * Admin input → the group-reward values of the next settings version, or { errors }.
 * { groupEnabled, groupRewardAmountMad (MAD → cents), groupSize (1–10000, default 10),
 *   groupMinDeliveredSales (1–100000, default 10) }; enabled ⇒ an amount > 0.
 */
export function validateRecruiterGroupSettingsInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const groupEnabled = bool(src.groupEnabled);
  const groupRewardAmountCents = parseMadToCents(src.groupRewardAmountMad ?? '0');
  if (Number.isNaN(groupRewardAmountCents)) errors.groupRewardAmountMad = 'INVALID_AMOUNT';
  else if (groupEnabled && groupRewardAmountCents === 0) errors.groupRewardAmountMad = 'AMOUNT_REQUIRED_WHEN_ENABLED';
  const groupSize = intIn(src.groupSize ?? DEFAULT_GROUP_SIZE, GROUP_SIZE_RANGE.min, GROUP_SIZE_RANGE.max);
  if (Number.isNaN(groupSize)) errors.groupSize = 'INVALID_GROUP_SIZE';
  const groupMinDeliveredSales = intIn(src.groupMinDeliveredSales ?? DEFAULT_GROUP_MIN_DELIVERED_SALES, MIN_SALES_RANGE.min, MIN_SALES_RANGE.max);
  if (Number.isNaN(groupMinDeliveredSales)) errors.groupMinDeliveredSales = 'INVALID_COUNT';
  if (Object.keys(errors).length) return { errors };
  return { value: { groupEnabled, groupRewardAmountCents, groupSize, groupMinDeliveredSales } };
}

/** The group-reward fields of a stored settings row (or null / a pre-20261112 row → group defaults). */
export function normalizeRecruiterGroupSettings(row) {
  const r = row && typeof row === 'object' ? row : {};
  const inRange = (v, { min, max }) => Number.isInteger(v) && v >= min && v <= max;
  return {
    groupEnabled: r.groupEnabled === true,
    groupRewardAmountCents: inRange(r.groupRewardAmountCents, { min: 0, max: MAX_REWARD_CENTS }) ? r.groupRewardAmountCents : 0,
    groupSize: inRange(r.groupSize, GROUP_SIZE_RANGE) ? r.groupSize : DEFAULT_GROUP_SIZE,
    groupMinDeliveredSales: inRange(r.groupMinDeliveredSales, MIN_SALES_RANGE) ? r.groupMinDeliveredSales : DEFAULT_GROUP_MIN_DELIVERED_SALES,
  };
}

/** Both reward types of a stored settings row: the 4 individual fields + the 4 group fields. */
export function normalizeRecruiterSettingsWithGroup(row) {
  return { ...normalizeRecruiterSettings(row), ...normalizeRecruiterGroupSettings(row) };
}

/** Group rewards are awarded only when switched on with an amount (reversals never depend on it). */
export const groupRewardsOn = (s) => s?.groupEnabled === true && Number.isInteger(s?.groupRewardAmountCents) && s.groupRewardAmountCents > 0;

/** Normalize a stored settings row (or null → defaults). The order threshold is never below 1. */
export function normalizeRecruiterSettings(row) {
  if (!row) return { ...DEFAULT_RECRUITER_SETTINGS };
  const cents = Number.isInteger(row.rewardAmountCents) && row.rewardAmountCents >= 0 && row.rewardAmountCents <= MAX_REWARD_CENTS
    ? row.rewardAmountCents : 0;
  const sales = Number.isInteger(row.minDeliveredSales) && row.minDeliveredSales >= MIN_SALES_RANGE.min && row.minDeliveredSales <= MIN_SALES_RANGE.max
    ? row.minDeliveredSales : DEFAULT_MIN_DELIVERED_SALES;
  return { version: Number(row.version) || 0, enabled: row.enabled === true, rewardAmountCents: cents, minDeliveredSales: sales };
}

/**
 * Does an affiliate CREATED by this recruiter qualify the recruiter for the reward now?
 * facts = {
 *   linked,          // the affiliate is linked to this recruiter (created by them)
 *   affiliateExists, // the affiliate row exists
 *   identityStatus,  // existing IdentityVerification status: NOT_SUBMITTED | PENDING | APPROVED | REJECTED
 *   deliveredSales,  // count of REAL delivered orders (status 'delivered', isFake = false)
 * }
 * → { qualified, reason, unmet: [reasons…] }  (reason = first unmet condition, or null)
 */
export function evaluateRecruitQualification(facts, settings) {
  const s = normalizeRecruiterSettings(settings);
  const f = facts && typeof facts === 'object' ? facts : {};
  if (!s.enabled) return { qualified: false, reason: 'REWARDS_DISABLED', unmet: ['REWARDS_DISABLED'] };
  if (!(s.rewardAmountCents > 0)) return { qualified: false, reason: 'NO_AMOUNT', unmet: ['NO_AMOUNT'] };
  if (!f.linked) return { qualified: false, reason: 'NOT_LINKED', unmet: ['NOT_LINKED'] };
  if (f.affiliateExists !== true) return { qualified: false, reason: 'AFFILIATE_NOT_FOUND', unmet: ['AFFILIATE_NOT_FOUND'] };
  const unmet = [];
  const sales = Number.isInteger(f.deliveredSales) && f.deliveredSales >= 0 ? f.deliveredSales : 0;
  if (sales < s.minDeliveredSales) unmet.push('NOT_ENOUGH_SALES');
  if (f.identityStatus !== IDENTITY_APPROVED_STATUS) unmet.push('CIN_NOT_APPROVED');
  return { qualified: unmet.length === 0, reason: unmet[0] ?? null, unmet };
}
