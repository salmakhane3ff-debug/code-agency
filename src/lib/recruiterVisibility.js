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
  'PHONE_TAKEN', 'PARENT_NOT_IN_NETWORK', 'RATE_LIMITED', 'INVALID_CREDENTIALS', 'IDEMPOTENCY_CONFLICT',
  'INSUFFICIENT_BALANCE', 'INCOMPLETE_BANK_INFO', 'ACTIVATION_NOT_AVAILABLE',
]);

/** Per-field validation codes of the affiliate-creation form (Phase 3): field → allowed codes. */
export const RECRUITER_FIELD_ERROR_CODES = Object.freeze({
  username: Object.freeze(['INVALID_USERNAME']),
  name: Object.freeze(['INVALID_NAME']),
  password: Object.freeze(['INVALID_PASSWORD']),
  phone: Object.freeze(['INVALID_PHONE']),
  parentId: Object.freeze(['INVALID_PARENT']),
  requestId: Object.freeze(['INVALID_REQUEST_ID']),
  body: Object.freeze(['UNKNOWN_FIELD']),
  // Phase 5: withdrawal request and bank details
  amountMad: Object.freeze(['INVALID_AMOUNT']),
  bankName: Object.freeze(['INVALID_BANK_NAME']),
  rib: Object.freeze(['INVALID_RIB']),
  accountName: Object.freeze(['INVALID_ACCOUNT_NAME']),
  // Phase 6 part 2: password change
  newPassword: Object.freeze(['INVALID_PASSWORD']),
  newPasswordConfirm: Object.freeze(['PASSWORD_MISMATCH']),
});

/**
 * Any error → { code } safe for a recruiter (unknown codes become SERVER_ERROR; messages never pass).
 * INVALID_INPUT may carry `fields` — only allowlisted field names with allowlisted codes.
 */
export function toRecruiterError(err) {
  const code = RECRUITER_ERROR_CODES.includes(err?.code) ? err.code : 'SERVER_ERROR';
  if (code !== 'INVALID_INPUT' || !err?.fields || typeof err.fields !== 'object') return { code };
  const fields = {};
  for (const field of Object.keys(RECRUITER_FIELD_ERROR_CODES)) {
    const v = Object.prototype.hasOwnProperty.call(err.fields, field) ? err.fields[field] : undefined;
    if (typeof v === 'string' && RECRUITER_FIELD_ERROR_CODES[field].includes(v)) fields[field] = v;
  }
  return Object.keys(fields).length ? { code, fields } : { code };
}

/**
 * Recruiter-facing view of an affiliate of THEIR OWN network (Phase 3: parent selector and
 * creation result). Identity only — never the password hash, phone, activation, bank,
 * verification or any amount. `networkIds` = ids linked to this recruiter: a parentId outside
 * it is never shown (null). Filtering rows by recruiter is the caller's job.
 */
export function toRecruiterNetworkAffiliateView(row, networkIds) {
  const at = row?.createdAt ? new Date(row.createdAt) : null;
  const inNetwork = (id) => typeof id === 'string' && networkIds instanceof Set && networkIds.has(id);
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    username: typeof row?.username === 'string' ? row.username : null,
    name: typeof row?.name === 'string' ? row.name : null,
    parentId: inNetwork(row?.parentId) ? row.parentId : null,
    createdAt: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
  };
}

// ── Phase 4: network tree and statistics (counts only) ─────────────────────────
const NETWORK_ORDER_KEYS = Object.freeze(['delivered', 'pending', 'confirmed', 'shipped', 'cancelled', 'returned', 'other', 'total']);
const NETWORK_IDENTITY_KEYS = Object.freeze(['APPROVED', 'PENDING', 'REJECTED', 'NONE']);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const str = (v) => (typeof v === 'string' ? v : null);
const level = (v) => (Number.isInteger(v) && v >= 1 ? v : null);
function ordersCountView(o) {
  const out = {};
  for (const k of NETWORK_ORDER_KEYS) out[k] = count(o?.[k]);
  return out;
}
/** Real and fake orders, ALWAYS separate: a fake order is never a real delivered sale. */
function realFakeView(o) {
  return { real: ordersCountView(o?.real), fake: ordersCountView(o?.fake) };
}
function identityCountView(o) {
  const out = {};
  for (const k of NETWORK_IDENTITY_KEYS) out[k] = count(o?.[k]);
  return out;
}

/**
 * Recruiter-facing node of their network tree: identity, level, account status, identity
 * STATUS only, counts of children / descendants and order counts (real vs fake) — never a
 * document, password, phone, customer field, amount or any order detail.
 */
export function toRecruiterNetworkNodeView(node) {
  return {
    id: str(node?.id),
    username: str(node?.username),
    name: str(node?.name),
    level: level(node?.level),
    status: node?.status === 'ACTIVE' || node?.status === 'INACTIVE' ? node.status : null,
    identityStatus: NETWORK_IDENTITY_KEYS.includes(node?.identityStatus) ? node.identityStatus : 'NONE',
    childrenCount: count(node?.childrenCount),
    descendantsCount: count(node?.descendantsCount),
    orders: realFakeView(node?.orders),
  };
}

/** Breadcrumb entry (an ancestor in the recruiter's own network). */
export function toRecruiterNetworkPathView(entry) {
  return { id: str(entry?.id), username: str(entry?.username), name: str(entry?.name), level: level(entry?.level) };
}

/** Recruiter-facing statistics of their network (or of one of their sub-networks). */
export function toRecruiterNetworkStatsView(stats) {
  const t = stats?.totals;
  const levels = Array.isArray(stats?.levels) ? stats.levels : [];
  return {
    rootId: str(stats?.rootId),
    totals: {
      affiliates: count(t?.affiliates), direct: count(t?.direct), active: count(t?.active), inactive: count(t?.inactive),
      maxLevel: count(t?.maxLevel), unplaced: count(t?.unplaced),
    },
    identity: identityCountView(stats?.identity),
    orders: realFakeView(stats?.orders),
    levels: levels.map((l) => ({
      level: level(l?.level), affiliates: count(l?.affiliates), active: count(l?.active), inactive: count(l?.inactive),
      identity: identityCountView(l?.identity), orders: realFakeView(l?.orders),
    })),
  };
}

// ── Phase 5: the recruiter's own rewards and withdrawals (MAD cents) ──────────
const cents = (v) => (Number.isInteger(v) ? v : 0);
const iso = (v) => {
  const t = v ? new Date(v) : null;
  return t && Number.isFinite(t.getTime()) ? t.toISOString() : null;
};
/** Withdrawal status as the recruiter sees it (the reserving rule: unknown = still reserved). */
export const RECRUITER_WITHDRAWAL_STATUS = Object.freeze({ PENDING: 'PENDING', PAID: 'PAID', REJECTED: 'REJECTED' });
function withdrawalStatus(s) {
  // Idempotent: an already-projected status (PAID / REJECTED / PENDING) keeps its value.
  if (s === 'paid' || s === RECRUITER_WITHDRAWAL_STATUS.PAID) return RECRUITER_WITHDRAWAL_STATUS.PAID;
  if (s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'refused' || s === RECRUITER_WITHDRAWAL_STATUS.REJECTED) return RECRUITER_WITHDRAWAL_STATUS.REJECTED;
  return RECRUITER_WITHDRAWAL_STATUS.PENDING;
}

/** Settings for the wallet: from the stored settings, or from an already-projected view (idempotent). */
function walletSettingsView(x) {
  if (typeof x?.rewardsEnabled !== 'boolean') return toRecruiterSettingsView(x);
  const on = x.rewardsEnabled === true && Number.isInteger(x.rewardAmountCents) && x.rewardAmountCents > 0;
  const n = x.requiredDeliveredOrders;
  return {
    rewardsEnabled: on, rewardAmountCents: on ? x.rewardAmountCents : 0, currency: 'MAD',
    requiredDeliveredOrders: Number.isInteger(n) && n >= 1 && n <= 100000 ? n : toRecruiterSettingsView(null).requiredDeliveredOrders,
  };
}

/** One withdrawal of the recruiter (their own rows only — filtering is the caller's job). */
export function toRecruiterWithdrawalView(row) {
  return { id: str(row?.id), amountCents: count(row?.amountCents), currency: 'MAD', status: withdrawalStatus(row?.status), createdAt: iso(row?.createdAt) };
}

/**
 * One reward of the recruiter's history: which affiliate earned it and why (the two
 * conditions, with the delivered-order threshold of the settings version used).
 */
export function toRecruiterRewardHistoryView(row) {
  const type = Object.values(REWARD_TYPES).includes(row?.type) ? row.type : null;
  const a = row?.affiliate;
  return {
    type,
    amountCents: cents(row?.amountCents),
    currency: 'MAD',
    affiliate: a && typeof a === 'object' ? { id: str(a.id), username: str(a.username), name: str(a.name) } : null,
    reason: type === REWARD_TYPES.RECRUIT_REWARD ? 'REAL_DELIVERED_AND_CIN_APPROVED' : null,
    requiredDeliveredOrders: type === REWARD_TYPES.RECRUIT_REWARD && Number.isInteger(row?.requiredDeliveredOrders) && row.requiredDeliveredOrders >= 1 ? row.requiredDeliveredOrders : null,
    createdAt: iso(row?.createdAt),
  };
}

/** The recruiter's own bank details (shown back to them only). */
export function toRecruiterBankView(bank) {
  return { bankName: str(bank?.bankName), rib: str(bank?.rib), accountName: str(bank?.accountName), complete: bank?.complete === true };
}

/** The recruiter's wallet: settings, totals (cents), reward history, withdrawals, bank. */
export function toRecruiterWalletView(w) {
  const t = w?.totals;
  return {
    settings: walletSettingsView(w?.settings),
    totals: {
      earnedCents: cents(t?.earnedCents), availableCents: cents(t?.availableCents), pendingCents: count(t?.pendingCents),
      paidCents: count(t?.paidCents), currency: 'MAD',
    },
    rewards: (Array.isArray(w?.rewards) ? w.rewards : []).map(toRecruiterRewardHistoryView),
    withdrawals: (Array.isArray(w?.withdrawals) ? w.withdrawals : []).map(toRecruiterWithdrawalView),
    bank: toRecruiterBankView(w?.bank),
  };
}

// ── Phase 6 part 1: affiliate activation codes ────────────────────────────────
const ACTIVATION_CODE_RE = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/;
/**
 * The one-time activation code, returned to the recruiter ONLY in the response that created
 * it (creation or regeneration) — it is never stored in clear and never shown again.
 */
export function toRecruiterActivationCodeView(a) {
  const code = typeof a?.code === 'string' && ACTIVATION_CODE_RE.test(a.code) ? a.code : null;
  return { code, expiresAt: code ? iso(a?.expiresAt) : null };
}

/** An affiliate of the recruiter whose credentials are still pending (state only, never a code). */
export function toRecruiterPendingActivationView(row) {
  const a = row?.affiliate;
  const state = row?.state === 'ACTIVE' || row?.state === 'EXPIRED' || row?.state === 'INVALIDATED' ? row.state : null;
  return {
    affiliate: { id: str(a?.id), username: str(a?.username), name: str(a?.name), createdAt: iso(a?.createdAt) },
    state,
    expiresAt: iso(row?.expiresAt),
  };
}
