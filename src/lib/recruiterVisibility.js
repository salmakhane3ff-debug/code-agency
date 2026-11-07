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
  // Phase 6 part 3c: recruiter identity verification (KYC)
  'RECRUITER_IDENTITY_NOT_APPROVED', 'IDENTITY_SUBMISSION_NOT_ALLOWED',
]);

/** Per-field validation codes of the affiliate-creation form (Phase 3): field → allowed codes. */
export const RECRUITER_FIELD_ERROR_CODES = Object.freeze({
  username: Object.freeze(['INVALID_USERNAME']),
  name: Object.freeze(['INVALID_NAME']),
  password: Object.freeze(['INVALID_PASSWORD']),
  phone: Object.freeze(['INVALID_PHONE']),
  parentId: Object.freeze(['INVALID_PARENT']),
  requestId: Object.freeze(['INVALID_REQUEST_ID']),
  body: Object.freeze(['UNKNOWN_FIELD', 'TOO_LARGE']),
  // Phase 5: withdrawal request and bank details
  amountMad: Object.freeze(['INVALID_AMOUNT']),
  bankName: Object.freeze(['INVALID_BANK_NAME']),
  rib: Object.freeze(['INVALID_RIB']),
  accountName: Object.freeze(['INVALID_ACCOUNT_NAME']),
  // Phase 6 part 2: password change
  newPassword: Object.freeze(['INVALID_PASSWORD']),
  newPasswordConfirm: Object.freeze(['PASSWORD_MISMATCH']),
  // Phase 6 part 3c: CIN upload (front / back)
  front: Object.freeze(['FILE_REQUIRED', 'FILE_TOO_LARGE', 'INVALID_FILE']),
  back: Object.freeze(['FILE_REQUIRED', 'FILE_TOO_LARGE', 'INVALID_FILE']),
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
 * verification or any amount. `networkIds` = ids of the recruiter's network (Phase 7 Stage E: members
 * of N(R)): a parentId outside it is never shown (null). Filtering rows by recruiter is the caller's job.
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
/** Order counts, or null when they are withheld (the recruiter's canViewOrders is off) — never zeros. */
const ordersOrNull = (o) => (o === null ? null : realFakeView(o));
function identityCountView(o) {
  const out = {};
  for (const k of NETWORK_IDENTITY_KEYS) out[k] = count(o?.[k]);
  return out;
}

// ── Phase 7 Stage B → E: network progress (N(R) — the same network the rewards use) ──
const PROGRESS_THRESHOLD_MAX = 100000;
const REWARD_STATE_KEYS = Object.freeze(['NONE', 'AWARDED', 'REVERSED']);
const threshold = (v) => (Number.isInteger(v) && v >= 1 && v <= PROGRESS_THRESHOLD_MAX ? v : null);
const flag = (v) => (v === true ? true : v === false ? false : null);
/**
 * Progress of one network node: its OWN real delivered orders against the CURRENT thresholds, and
 * whether its identity is APPROVED. Without a delivered count (canViewOrders off) both qualified
 * values are null too — nothing derived from delivered orders is shown.
 */
function progressView(p) {
  if (!p || typeof p !== 'object') return null;
  const delivered = Number.isInteger(p.realDelivered) && p.realDelivered >= 0 ? p.realDelivered : null;
  return {
    realDelivered: delivered,
    individualThreshold: threshold(p.individualThreshold),
    groupThreshold: threshold(p.groupThreshold),
    identityApproved: p.identityApproved === true,
    qualifiedIndividual: delivered === null ? null : flag(p.qualifiedIndividual),
    qualifiedGroup: delivered === null ? null : flag(p.qualifiedGroup),
  };
}
/** The latest individual reward cycle of a network member (already visible in the wallet). */
function rewardStateView(r) {
  if (!r || typeof r !== 'object') return null;
  const state = REWARD_STATE_KEYS.includes(r.state) ? r.state : 'NONE';
  return { state, cycle: state !== 'NONE' && Number.isInteger(r.cycle) && r.cycle >= 1 ? r.cycle : null };
}

/**
 * Recruiter-facing node of their network tree: identity, level, account status, identity
 * STATUS only, counts of children / descendants and order counts (real vs fake) — never a
 * document, password, phone, customer field, amount or any order detail. `orders` is null when
 * the recruiter may not view orders (Phase 6 part 4).
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
    orders: ordersOrNull(node?.orders),
    // Phase 7 Stage B → E: the node is a member of the recruiter's network N(R); linkedToMe = directly
    // recruited (information only — every member is reward-eligible), its progress (delivered values
    // null without canViewOrders) and the latest individual reward cycle.
    linkedToMe: node?.linkedToMe === true,
    progress: progressView(node?.progress),
    rewardState: rewardStateView(node?.rewardState),
  };
}

/** Breadcrumb entry (an ancestor in the recruiter's own network). */
export function toRecruiterNetworkPathView(entry) {
  return { id: str(entry?.id), username: str(entry?.username), name: str(entry?.name), level: level(entry?.level), linkedToMe: entry?.linkedToMe === true };
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
    orders: ordersOrNull(stats?.orders),
    levels: levels.map((l) => ({
      level: level(l?.level), affiliates: count(l?.affiliates), active: count(l?.active), inactive: count(l?.inactive),
      identity: identityCountView(l?.identity), orders: ordersOrNull(l?.orders),
    })),
  };
}

/**
 * Phase 7 Stage B → E: one affiliate of the recruiter's paged list (GET /api/recruiter/affiliates) — the
 * former parent-selector fields unchanged (toRecruiterNetworkAffiliateView: id, username, name,
 * parentId only when the parent is in the recruiter's network, createdAt) plus its activation (status
 * ACTIVE / INACTIVE, like the network nodes), identity STATUS, level in N(R) (null = unplaced), its
 * parent when it is a placed member (masked otherwise), linkedToMe (directly recruited — information
 * only), progress and latest individual reward cycle. Every listed affiliate is a member of N(R).
 */
export function toRecruiterAffiliateListItemView(row, networkIds) {
  const base = toRecruiterNetworkAffiliateView(row, networkIds);
  const p = row?.parent;
  return {
    id: base.id, username: base.username, name: base.name, parentId: base.parentId, createdAt: base.createdAt,
    // activation as the network nodes show it (this module never reads the activation flag itself)
    status: row?.status === 'ACTIVE' || row?.status === 'INACTIVE' ? row.status : null,
    identityStatus: NETWORK_IDENTITY_KEYS.includes(row?.identityStatus) ? row.identityStatus : 'NONE',
    level: level(row?.level),
    parent: p && typeof p === 'object' && typeof p.id === 'string'
      ? { id: p.id, username: str(p.username), name: str(p.name), linkedToMe: p.linkedToMe === true } : null,
    linkedToMe: row?.linkedToMe === true,
    progress: progressView(row?.progress),
    rewardState: rewardStateView(row?.rewardState),
  };
}

/** Phase 7 Stage B: one side (individual / group) of the recruiter's own reward counts (MAD cents). */
function rewardCountsView(x) {
  return { awarded: count(x?.awarded), awardedCents: count(x?.awardedCents), reversed: count(x?.reversed), reversedCents: count(x?.reversedCents) };
}
/**
 * Phase 7 Stage B: the recruiter's progress summary (GET /api/recruiter/progress) — aggregates only:
 * linked (directly recruited) / network counts (Phase 7 Stage E: downlineAffiliates = |N(R)|), the
 * group progress ("progressTowardNextGroup / groupSize"), the switches, the current thresholds and the
 * recruiter's own reward counts. No per-affiliate delivered count.
 */
export function toRecruiterProgressSummaryView(s) {
  const size = Number.isInteger(s?.groupSize) && s.groupSize >= 1 && s.groupSize <= 10000 ? s.groupSize : null;
  const toward = count(s?.progressTowardNextGroup);
  return {
    linkedAffiliates: count(s?.linkedAffiliates),
    downlineAffiliates: count(s?.downlineAffiliates),
    qualifiedForGroup: count(s?.qualifiedForGroup),
    groupSize: size,
    activeGroupRewards: count(s?.activeGroupRewards),
    progressTowardNextGroup: size === null ? 0 : Math.min(toward, size),
    groupEnabled: s?.groupEnabled === true,
    individualEnabled: s?.individualEnabled === true,
    individualThreshold: threshold(s?.individualThreshold),
    groupThreshold: threshold(s?.groupThreshold),
    currency: 'MAD',
    rewards: { individual: rewardCountsView(s?.rewards?.individual), group: rewardCountsView(s?.rewards?.group) },
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
  if (type === REWARD_TYPES.GROUP_REWARD || type === REWARD_TYPES.GROUP_REVERSAL) {
    // Phase 7 (Reward B): a group reward belongs to the recruiter's group of qualified affiliates —
    // no affiliate; its cycle, the settings version it was judged with, the group size and the
    // per-affiliate threshold of that version.
    const pos = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);
    return {
      type,
      amountCents: cents(row?.amountCents),
      currency: 'MAD',
      affiliate: null,
      reason: type === REWARD_TYPES.GROUP_REWARD ? 'GROUP_QUALIFIED_AFFILIATES' : 'GROUP_QUALIFIED_BELOW_THRESHOLD',
      requiredDeliveredOrders: pos(row?.requiredDeliveredOrders, 100000),
      cycle: pos(row?.cycle, 2147483647),
      settingsVersion: pos(row?.settingsVersion, 2147483647),
      groupSize: pos(row?.groupSize, 10000),
      createdAt: iso(row?.createdAt),
    };
  }
  return {
    type,
    amountCents: cents(row?.amountCents),
    currency: 'MAD',
    affiliate: a && typeof a === 'object' ? { id: str(a.id), username: str(a.username), name: str(a.name) } : null,
    // Phase 6 part 3a: a REVERSAL is a negative entry with its own reason — the real delivered
    // count fell below the threshold (of the reversed reward's settings version).
    reason: type === REWARD_TYPES.RECRUIT_REWARD ? 'REAL_DELIVERED_AND_CIN_APPROVED' : type === REWARD_TYPES.REVERSAL ? 'REAL_DELIVERED_BELOW_THRESHOLD' : null,
    requiredDeliveredOrders: (type === REWARD_TYPES.RECRUIT_REWARD || type === REWARD_TYPES.REVERSAL) && Number.isInteger(row?.requiredDeliveredOrders) && row.requiredDeliveredOrders >= 1 ? row.requiredDeliveredOrders : null,
    cycle: (type === REWARD_TYPES.RECRUIT_REWARD || type === REWARD_TYPES.REVERSAL) && Number.isInteger(row?.cycle) && row.cycle >= 1 ? row.cycle : null,
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

// ── Phase 6 part 3c: the recruiter's OWN identity verification (KYC) ──────────
export const RECRUITER_IDENTITY_VIEW_STATUS = Object.freeze({
  NOT_SUBMITTED: 'NOT_SUBMITTED', PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED',
});
/**
 * The recruiter's own KYC state: status, the rejection reason (REJECTED only), when it was
 * submitted / reviewed, and whether a (new) upload is possible. Never a file key, a storage
 * path, a reviewer identity or an image.
 */
export function toRecruiterIdentityView(row) {
  const status = Object.values(RECRUITER_IDENTITY_VIEW_STATUS).includes(row?.status) ? row.status : 'NOT_SUBMITTED';
  const reviewed = status === 'APPROVED' || status === 'REJECTED';
  return {
    status,
    rejectionReason: status === 'REJECTED' && typeof row?.rejectionReason === 'string' ? row.rejectionReason.slice(0, 500) : null,
    submittedAt: status === 'NOT_SUBMITTED' ? null : iso(row?.submittedAt),
    reviewedAt: reviewed ? iso(row?.reviewedAt) : null,
    canSubmit: status === 'NOT_SUBMITTED' || status === 'REJECTED',
  };
}
