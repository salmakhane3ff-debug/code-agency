/**
 * src/lib/rewards.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards & Gifts — PURE rules (no DB, no I/O). The services in
 * src/lib/services/rewardsService.js and rewardRedemptionService.js apply them
 * inside transactions; the affiliate/admin APIs reuse them for display.
 *
 * Points are integers and a SEPARATE currency from commissions: nothing here
 * touches the MAD wallet / balance providers.
 *
 * Approved decisions encoded here:
 *   D1  suspicious orders earn no points (config.excludeSuspicious, default ON)
 *   D2  signup bonus only for affiliates CREATED after the bonus was enabled
 *   D3  balance may go negative only through an order reversal ("points debt");
 *       spending and admin debits can never push it below zero
 *   D4  optional hold period before order points become spendable (default 0)
 *   D5  RETURNED status — admin chooses refund/restock explicitly
 *   D6  affiliate may cancel their own request while PENDING_REVIEW
 *   D7  one item per request; points never expire
 *   D9  re-award after a reversal reuses the original points snapshot
 *   D11 nothing is awarded for orders delivered before launch (launch baseline)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const REWARDS_SETTING_ID = 'rewards-config';
/** Where reconcileOrderRewards keeps its resume cursors (system-managed). */
export const REWARDS_RECONCILE_STATE_ID = 'rewards-reconcile-state';

/** The only AffiliateOrder status that earns points (same as commissions). */
export const DELIVERED_STATUS = 'delivered';

export const LEDGER_TYPE = Object.freeze({
  SIGNUP_BONUS:      'SIGNUP_BONUS',
  ORDER_DELIVERED:   'ORDER_DELIVERED',
  ORDER_REVERSAL:    'ORDER_REVERSAL',
  REDEMPTION_DEBIT:  'REDEMPTION_DEBIT',
  REDEMPTION_REFUND: 'REDEMPTION_REFUND',
  ADMIN_ADJUSTMENT:  'ADMIN_ADJUSTMENT',
});

/** Ledger types that make up "total earned" (net of reversals/adjustments). */
export const EARNING_LEDGER_TYPES = Object.freeze([
  LEDGER_TYPE.SIGNUP_BONUS, LEDGER_TYPE.ORDER_DELIVERED,
  LEDGER_TYPE.ORDER_REVERSAL, LEDGER_TYPE.ADMIN_ADJUSTMENT,
]);

export const ACTOR = Object.freeze({ SYSTEM: 'SYSTEM', ADMIN: 'ADMIN', AFFILIATE: 'AFFILIATE' });

export const AWARD_STATE = Object.freeze({ AWARDED: 'AWARDED', REVERSED: 'REVERSED', EXCLUDED: 'EXCLUDED' });
/** Why an order can never earn: delivered before launch / while rewards were OFF. */
export const EXCLUSION_REASON = Object.freeze({ PRE_LAUNCH: 'PRE_LAUNCH', DISABLED_PERIOD: 'DISABLED_PERIOD' });

export const REDEMPTION_STATUS = Object.freeze({
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED:       'APPROVED',
  PREPARING:      'PREPARING',
  SHIPPED:        'SHIPPED',
  IN_TRANSIT:     'IN_TRANSIT',
  DELIVERED:      'DELIVERED',
  REJECTED:       'REJECTED',
  CANCELLED:      'CANCELLED',
  RETURNED:       'RETURNED',
});

const S = REDEMPTION_STATUS;

/** Requests that still hold a gift (count toward maxOpenRedemptions). */
export const OPEN_REDEMPTION_STATUSES = Object.freeze([S.PENDING_REVIEW, S.APPROVED, S.PREPARING, S.SHIPPED, S.IN_TRANSIT]);
/** Requests that never consumed a gift (excluded from maxPerAffiliate). */
export const VOID_REDEMPTION_STATUSES = Object.freeze([S.REJECTED, S.CANCELLED]);
export const TERMINAL_REDEMPTION_STATUSES = Object.freeze([S.DELIVERED, S.REJECTED, S.CANCELLED, S.RETURNED]);

/** Allowed status changes. Anything not listed is rejected. */
export const ADMIN_TRANSITIONS = Object.freeze({
  [S.PENDING_REVIEW]: Object.freeze([S.APPROVED, S.REJECTED, S.CANCELLED]),
  [S.APPROVED]:       Object.freeze([S.PREPARING, S.CANCELLED]),
  [S.PREPARING]:      Object.freeze([S.SHIPPED, S.CANCELLED]),
  [S.SHIPPED]:        Object.freeze([S.IN_TRANSIT, S.DELIVERED, S.RETURNED]),
  [S.IN_TRANSIT]:     Object.freeze([S.DELIVERED, S.RETURNED]),
});
export const AFFILIATE_TRANSITIONS = Object.freeze({
  [S.PENDING_REVIEW]: Object.freeze([S.CANCELLED]), // D6
});

/** Statuses that ALWAYS refund points and release stock (gift never shipped). */
export const AUTO_REFUND_STATUSES = Object.freeze([S.REJECTED, S.CANCELLED]);

export function canTransition(from, to, actorType) {
  const table = actorType === ACTOR.ADMIN ? ADMIN_TRANSITIONS
    : actorType === ACTOR.AFFILIATE ? AFFILIATE_TRANSITIONS
      : null;
  if (!table || !Object.prototype.hasOwnProperty.call(table, from)) return false;
  return table[from].includes(to);
}

// ── Limits ────────────────────────────────────────────────────────────────────
export const LIMITS = Object.freeze({
  MAX_POINTS:          1_000_000, // per order / bonus / gift cost
  MAX_ADJUSTMENT:      1_000_000,
  MAX_HOLD_DAYS:       365,
  MAX_OPEN_REDEMPTIONS: 50,
  REASON_MIN:          5,
  REASON_MAX:          500,
});

// ── Config ────────────────────────────────────────────────────────────────────
export const DEFAULT_REWARDS_CONFIG = Object.freeze({
  enabled:                  false,
  pointsPerDeliveredOrder:  0,
  signupBonusEnabled:       false,
  signupBonusPoints:        0,
  excludeSuspicious:        true,  // D1
  orderPointsHoldDays:      0,     // D4
  maxOpenRedemptions:       3,
  defaultLowStockThreshold: 3,
  // System-managed timestamps (ISO strings) — never taken from admin input.
  launchedAt:               null,  // first time rewards were enabled
  enabledAt:                null,  // last false→true switch of `enabled`
  signupBonusEnabledAt:     null,  // last false→true switch of the bonus
});

/** Admin-editable keys; timestamps are managed by the service only. */
export const EDITABLE_CONFIG_KEYS = Object.freeze([
  'enabled', 'pointsPerDeliveredOrder', 'signupBonusEnabled', 'signupBonusPoints',
  'excludeSuspicious', 'orderPointsHoldDays', 'maxOpenRedemptions', 'defaultLowStockThreshold',
]);

/** Integer in [min, max] (numbers or integer strings), else `fallback`. */
export function toIntInRange(value, min, max, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Normalize a stored/submitted config; invalid fields fall back to defaults. */
export function normalizeRewardsConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_REWARDS_CONFIG;
  return {
    enabled:                  toBool(r.enabled, d.enabled),
    pointsPerDeliveredOrder:  toIntInRange(r.pointsPerDeliveredOrder, 0, LIMITS.MAX_POINTS, d.pointsPerDeliveredOrder),
    signupBonusEnabled:       toBool(r.signupBonusEnabled, d.signupBonusEnabled),
    signupBonusPoints:        toIntInRange(r.signupBonusPoints, 0, LIMITS.MAX_POINTS, d.signupBonusPoints),
    excludeSuspicious:        toBool(r.excludeSuspicious, d.excludeSuspicious),
    orderPointsHoldDays:      toIntInRange(r.orderPointsHoldDays, 0, LIMITS.MAX_HOLD_DAYS, d.orderPointsHoldDays),
    maxOpenRedemptions:       toIntInRange(r.maxOpenRedemptions, 1, LIMITS.MAX_OPEN_REDEMPTIONS, d.maxOpenRedemptions),
    defaultLowStockThreshold: toIntInRange(r.defaultLowStockThreshold, 0, 100_000, d.defaultLowStockThreshold),
    launchedAt:               toIsoOrNull(r.launchedAt),
    enabledAt:                toIsoOrNull(r.enabledAt),
    signupBonusEnabledAt:     toIsoOrNull(r.signupBonusEnabledAt),
  };
}

// ── Eligibility ───────────────────────────────────────────────────────────────

/**
 * Can this affiliate order earn points right now?
 * `requireConfiguredPoints: false` is used for re-awards, which reuse the
 * original snapshot (D9) even if the per-order setting is now 0.
 */
export function evaluateOrderEligibility({ affiliateOrder, order, config }, { requireConfiguredPoints = true } = {}) {
  const no = (reason) => ({ eligible: false, reason });
  if (!config?.enabled) return no('REWARDS_DISABLED');
  if (requireConfiguredPoints && !(config.pointsPerDeliveredOrder > 0)) return no('NO_POINTS_CONFIGURED');
  if (!affiliateOrder) return no('NOT_FOUND');
  if (affiliateOrder.status !== DELIVERED_STATUS) return no('NOT_DELIVERED');
  if (affiliateOrder.isFake) return no('FAKE_ORDER');
  if (config.excludeSuspicious && affiliateOrder.isSuspicious) return no('SUSPICIOUS'); // D1
  if (!affiliateOrder.orderId) return no('NOT_LINKED');
  if (!order) return no('ORDER_MISSING');
  if (order.isFake) return no('FAKE_ORDER');
  if (order.affiliateId && order.affiliateId !== affiliateOrder.affiliateId) return no('AFFILIATE_MISMATCH');
  return { eligible: true, reason: null };
}

/** D2: only affiliates created after the bonus (and rewards) were switched on. */
export function evaluateSignupBonusEligibility({ affiliate, config }) {
  const no = (reason) => ({ eligible: false, reason });
  if (!config?.enabled) return no('REWARDS_DISABLED');
  if (!config.signupBonusEnabled || !(config.signupBonusPoints > 0)) return no('BONUS_DISABLED');
  if (!affiliate) return no('AFFILIATE_NOT_FOUND');
  if (!affiliate.isActive) return no('AFFILIATE_INACTIVE');
  const since = [config.launchedAt, config.signupBonusEnabledAt].filter(Boolean).map((v) => new Date(v).getTime());
  if (since.length < 2) return no('BONUS_DISABLED');
  const createdAt = new Date(affiliate.createdAt).getTime();
  if (!(createdAt >= Math.max(...since))) return no('EXISTING_AFFILIATE');
  return { eligible: true, reason: null };
}

/**
 * Server-side redemption gate (check order = what the affiliate sees first).
 * All numbers come from the database, never from the browser.
 */
export function evaluateRedemptionEligibility({
  config, affiliate, gift, spendable, deliveredOrders = 0, giftRedemptions = 0, openRedemptions = 0,
}) {
  const no = (code) => ({ ok: false, code });
  if (!config?.enabled) return no('REWARDS_DISABLED');
  if (!affiliate?.isActive) return no('AFFILIATE_INACTIVE');
  if (!gift || !gift.isActive || gift.archivedAt) return no('GIFT_UNAVAILABLE');
  if (!(gift.stock > 0)) return no('OUT_OF_STOCK');
  if (gift.minDeliveredOrders && deliveredOrders < gift.minDeliveredOrders) return no('MIN_ORDERS_NOT_MET');
  if (gift.maxPerAffiliate && giftRedemptions >= gift.maxPerAffiliate) return no('GIFT_LIMIT_REACHED');
  if (openRedemptions >= config.maxOpenRedemptions) return no('TOO_MANY_OPEN_REQUESTS');
  if (!(spendable >= gift.pointsCost)) return no('INSUFFICIENT_POINTS');
  return { ok: true, code: null };
}

/** Spendable = balance minus points still in their hold period; never < 0. */
export function computeSpendable(balance, heldPoints) {
  return Math.max(0, (balance || 0) - (heldPoints || 0));
}

export function holdUntil(now, holdDays) {
  return new Date(new Date(now).getTime() + (holdDays || 0) * 86_400_000);
}

// ── Idempotency keys (one deterministic key per ledger effect) ────────────────
export const ledgerKey = Object.freeze({
  signup:           (affiliateId)            => `signup:${affiliateId}`,
  orderAward:       (affiliateOrderId, v)    => `order:${affiliateOrderId}:award:v${v}`,
  orderReversal:    (affiliateOrderId, v)    => `order:${affiliateOrderId}:reverse:v${v}`,
  redemptionDebit:  (redemptionId)           => `redemption:${redemptionId}:debit`,
  redemptionRefund: (redemptionId)           => `redemption:${redemptionId}:refund`,
  adjustment:       (affiliateId, requestId) => `adjust:${affiliateId}:${requestId}`,
});

// ── Input validation ──────────────────────────────────────────────────────────

/** Trim, drop control characters, collapse whitespace runs; non-strings → ''. */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isValidClientRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

export function isNonEmptyId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
}

/** Delivery details for a gift request. Returns { ok, value, errors }. */
export function validateRecipient(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const fullName = cleanText(src.fullName);
  const phoneRaw = cleanText(src.phone).replace(/[\s.\-()]/g, '');
  const city = cleanText(src.city);
  const address = cleanText(src.address);
  const notes = cleanText(src.deliveryNotes);

  if (fullName.length < 2 || fullName.length > 100) errors.fullName = 'INVALID_FULL_NAME';
  if (!/^\+?\d{8,15}$/.test(phoneRaw)) errors.phone = 'INVALID_PHONE';
  if (city.length < 2 || city.length > 80) errors.city = 'INVALID_CITY';
  if (address.length < 5 || address.length > 300) errors.address = 'INVALID_ADDRESS';
  if (notes.length > 500) errors.deliveryNotes = 'NOTES_TOO_LONG';

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok ? { fullName, phone: phoneRaw, city, address, deliveryNotes: notes || null } : null,
  };
}

/** A required human reason (adjustments, rejections, admin cancellations). */
export function validateReason(value) {
  const reason = cleanText(value);
  if (reason.length < LIMITS.REASON_MIN || reason.length > LIMITS.REASON_MAX) return null;
  return reason;
}

export function validateAdjustment({ delta, reason, clientRequestId } = {}) {
  const errors = {};
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > LIMITS.MAX_ADJUSTMENT) {
    errors.delta = 'INVALID_DELTA';
  }
  const cleanReason = validateReason(reason);
  if (!cleanReason) errors.reason = 'REASON_REQUIRED';
  if (!isValidClientRequestId(clientRequestId)) errors.clientRequestId = 'INVALID_REQUEST_ID';
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, value: ok ? { delta, reason: cleanReason, clientRequestId } : null };
}

// ── References & projections ──────────────────────────────────────────────────
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I L O U)

/** e.g. RW-20261019-7K3Q9A — date + 6 random base32 chars (unique index backs it). */
export function generateRedemptionReference(now, bytes) {
  const d = new Date(now);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += REF_ALPHABET[bytes[i] % 32];
  return `RW-${ymd}-${suffix}`;
}

/** Affiliate-facing view of a redemption: admin-only fields removed. */
export function toPublicRedemption(r) {
  if (!r) return null;
  const { internalNotes: _internalNotes, clientRequestId: _clientRequestId, ...rest } = r;
  return rest;
}

// ── Gift catalog (admin input) ────────────────────────────────────────────────
export const GIFT_LIMITS = Object.freeze({
  NAME_MIN: 2, NAME_MAX: 120, DESCRIPTION_MAX: 2000, MAX_IMAGES: 10, URL_MAX: 1000,
  MAX_STOCK: 1_000_000, MAX_THRESHOLD: 100_000, MAX_PER_AFFILIATE: 1000, MAX_MIN_ORDERS: 100_000, SORT_MAX: 100_000,
});

/** Multi-line text: drop control characters except newlines, trim. */
export function cleanMultiline(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, ' ').trim();
}

/** Media URLs come from the media library (/api/image): absolute http(s) or /uploads/… */
export function isValidMediaUrl(value) {
  return typeof value === 'string' && value.length <= GIFT_LIMITS.URL_MAX
    && (/^https?:\/\/[^\s"'<>]+$/i.test(value) || /^\/uploads\/[^\s"'<>]+$/.test(value));
}

const optionalInt = (value, min, max) => {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = toIntInRange(value, min, max, NaN);
  return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
};

/**
 * Validate gift fields from the admin form. `partial: true` (edit) validates
 * only the keys present. Stock is set on CREATE only — later changes go through
 * the audited, race-safe stock adjustment (a raw "stock = N" write could erase a
 * concurrent redemption's reservation). Activation has its own action too.
 */
export function normalizeGiftInput(input, { partial = false } = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const want = (k) => !partial || has(k);
  const errors = {};
  const value = {};
  const L = GIFT_LIMITS;

  if (want('name')) {
    const name = cleanText(src.name);
    if (name.length < L.NAME_MIN || name.length > L.NAME_MAX) errors.name = 'INVALID_NAME';
    else value.name = name;
  }
  if (want('description')) {
    const d = cleanMultiline(src.description ?? '');
    if (d.length > L.DESCRIPTION_MAX) errors.description = 'DESCRIPTION_TOO_LONG';
    else value.description = d;
  }
  if (want('images')) {
    const list = src.images ?? [];
    if (!Array.isArray(list) || list.length > L.MAX_IMAGES || !list.every(isValidMediaUrl)) errors.images = 'INVALID_IMAGES';
    else value.images = [...new Set(list)];
  }
  if (want('pointsCost')) {
    const n = toIntInRange(src.pointsCost, 1, LIMITS.MAX_POINTS, NaN);
    if (Number.isNaN(n)) errors.pointsCost = 'INVALID_POINTS_COST';
    else value.pointsCost = n;
  }
  if (partial) {
    if (has('stock')) errors.stock = 'USE_STOCK_ADJUSTMENT';
    if (has('isActive')) errors.isActive = 'USE_STATUS_ACTION';
  } else {
    const n = toIntInRange(src.stock ?? 0, 0, L.MAX_STOCK, NaN);
    if (Number.isNaN(n)) errors.stock = 'INVALID_STOCK';
    else value.stock = n;
    if (has('isActive') && typeof src.isActive !== 'boolean') errors.isActive = 'INVALID_BOOLEAN';
    else value.isActive = src.isActive === true;
  }
  for (const [key, min, max] of [
    ['lowStockThreshold', 0, L.MAX_THRESHOLD],
    ['maxPerAffiliate', 1, L.MAX_PER_AFFILIATE],
    ['minDeliveredOrders', 0, L.MAX_MIN_ORDERS],
  ]) {
    if (!want(key)) continue;
    const r = optionalInt(src[key], min, max);
    if (!r.ok) errors[key] = 'INVALID_NUMBER';
    else value[key] = r.value;
  }
  if (want('sortOrder')) {
    const n = toIntInRange(src.sortOrder ?? 0, -L.SORT_MAX, L.SORT_MAX, NaN);
    if (Number.isNaN(n)) errors.sortOrder = 'INVALID_NUMBER';
    else value.sortOrder = n;
  }

  const ok = Object.keys(errors).length === 0;
  if (ok && partial && Object.keys(value).length === 0) return { ok: false, errors: { _: 'NOTHING_TO_UPDATE' }, value: null };
  return { ok, errors, value: ok ? value : null };
}

/** OUT (≤ 0) / LOW (≤ threshold; gift's own or the config default) / OK. */
export function computeStockState(gift, defaultThreshold = DEFAULT_REWARDS_CONFIG.defaultLowStockThreshold) {
  const stock = gift?.stock ?? 0;
  if (stock <= 0) return 'OUT';
  const threshold = gift?.lowStockThreshold ?? defaultThreshold;
  return stock <= threshold ? 'LOW' : 'OK';
}

/** Admin gift actions → the state they produce. */
export const GIFT_ACTIONS = Object.freeze(['activate', 'deactivate', 'archive', 'restore']);
