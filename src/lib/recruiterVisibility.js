/**
 * src/lib/recruiterVisibility.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — the ONLY shapes a recruiter may receive about rewards,
 * settings, ledger rows, audit entries and errors (PURE allowlist projections).
 *
 * MANDATORY CONTRACT (Phase 2+): every recruiter-facing endpoint, page payload,
 * statistic or error MUST be built with the functions of this file — never from raw
 * rows of recruiter_settings_versions / recruiter_reward_ledger / recruiter_audit_log,
 * never from internal objects. Enforced by the contract test in
 * scripts/recruiterVisibility.test.mjs and documented in docs/recruiter-system.md.
 *
 * Rewards are shown IMMEDIATELY: a recorded reward is visible to its recruiter at once,
 * with its real amount (MAD) and time — no delay, no hidden reward.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { normalizeRecruiterSettings, REWARD_TYPES } from './recruiterSettings.js';

export const RECRUITER_REWARD_STATUS = Object.freeze({ EARNED: 'EARNED', PENDING: 'PENDING', UNAVAILABLE: 'UNAVAILABLE' });

/**
 * Recruiter-facing reward status of ONE created affiliate.
 * `reward` = its RECRUIT_REWARD ledger row or null; `reversal` = its REVERSAL row or null.
 * EARNED as soon as the reward row exists (and is not reversed).
 */
export function toRecruiterQualificationView({ reward = null, reversal = null } = {}, settings) {
  const earned = !!reward && reward.type === REWARD_TYPES.RECRUIT_REWARD;
  const reversed = !!reversal && reversal.type === REWARD_TYPES.REVERSAL;
  if (earned && !reversed) return { rewardStatus: RECRUITER_REWARD_STATUS.EARNED };
  const s = normalizeRecruiterSettings(settings);
  if (!s.enabled || !(s.rewardAmountCents > 0)) return { rewardStatus: RECRUITER_REWARD_STATUS.UNAVAILABLE };
  return { rewardStatus: RECRUITER_REWARD_STATUS.PENDING };
}

/** Recruiter-facing settings: rewards on/off, the amount (MAD) and the number of orders required. */
export function toRecruiterSettingsView(settings) {
  const s = normalizeRecruiterSettings(settings);
  const on = s.enabled && s.rewardAmountCents > 0;
  return { rewardsEnabled: on, rewardAmountCents: on ? s.rewardAmountCents : 0, currency: 'MAD', requiredDeliveredOrders: s.minDeliveredSales };
}

/** Recruiter-facing ledger row (their own rows only — filtering by recruiter is the caller's job). */
export function toRecruiterRewardView(row) {
  const type = Object.values(REWARD_TYPES).includes(row?.type) ? row.type : null;
  const at = row?.createdAt ? new Date(row.createdAt) : null;
  return {
    type,
    amountCents: Number.isInteger(row?.amountCents) ? row.amountCents : 0,
    currency: 'MAD',
    affiliateId: typeof row?.affiliateId === 'string' ? row.affiliateId : null,
    createdAt: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
  };
}

/** Recruiter-facing total of their ledger rows (all recorded rows, immediately). */
export function toRecruiterRewardTotals(rows) {
  let earnedCents = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (Object.values(REWARD_TYPES).includes(r?.type) && Number.isInteger(r?.amountCents)) earnedCents += r.amountCents;
  }
  return { earnedCents, currency: 'MAD' };
}

/** Audit actions a recruiter may see in "سجل العمليات" — their own actions only. */
export const RECRUITER_VISIBLE_AUDIT_ACTIONS = Object.freeze([
  'RECRUITER_LOGIN', 'RECRUITER_LOGOUT', 'RECRUITER_PASSWORD_CHANGED', 'AFFILIATE_CREATED',
]);

/** Recruiter-facing audit entry, or null when the recruiter must not see it. */
export function toRecruiterAuditView(entry, recruiterId) {
  if (!entry || entry.actorType !== 'RECRUITER' || entry.recruiterId !== recruiterId || entry.actorId !== recruiterId) return null;
  if (!RECRUITER_VISIBLE_AUDIT_ACTIONS.includes(entry.action)) return null;
  return {
    action: entry.action,
    entityId: entry.action === 'AFFILIATE_CREATED' && typeof entry.entityId === 'string' ? entry.entityId : null,
    createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
  };
}

/** Error codes a recruiter may receive (with their own fixed Arabic text, Phase 2+). */
export const RECRUITER_ERROR_CODES = Object.freeze([
  'UNAUTHORIZED', 'RECRUITER_DISABLED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'USERNAME_TAKEN',
  'PHONE_TAKEN', 'PARENT_NOT_IN_NETWORK', 'RATE_LIMITED',
]);

/** Any error → { code } safe for a recruiter (unknown codes become SERVER_ERROR; messages never pass). */
export function toRecruiterError(err) {
  const code = RECRUITER_ERROR_CODES.includes(err?.code) ? err.code : 'SERVER_ERROR';
  return { code };
}
