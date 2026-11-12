/**
 * src/lib/paymentProofs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Payment Proofs — PURE rules (no database, no files): statuses, the 72-hour
 * visibility window, input validation, Africa/Casablanca local time → UTC for
 * manual scheduling, feed pagination cursors and the public (affiliate) shape.
 *
 * A payment proof is an admin-managed DISPLAY / ANNOUNCEMENT record: a display
 * name and amount typed by the admin plus a receipt image the admin uploads. It is
 * completely independent of affiliates, users, payouts, balances, commissions,
 * rewards and every other financial record — it reads and writes none of them.
 *
 * ONE global feed: every active affiliate sees exactly the same proofs, in the same
 * order. Visibility (server-side, the only rule the slider uses):
 *   status = PUBLISHED  AND  not removed  AND  publishedAt <= now  AND  now < visibleUntil
 * visibleUntil = publishedAt + the display duration captured AT PUBLICATION (admin setting
 * "Durée d'affichage", 72 h by default; 7 d, 30 d or a custom number of hours). A proof
 * published before that setting existed has no visibleUntil and keeps publishedAt + 72 h.
 * So a proof published exactly N hours ago (its duration) is no longer visible, and a later
 * change of the setting never moves a proof already published. publishedAt is the ACTUAL
 * publication instant (written when the proof is published), never the creation, upload,
 * transfer or scheduled date. A removed proof ("Supprimer") is hidden at once.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { CASABLANCA_TZ, casablancaParts, casablancaLocal, casablancaCandidates } from './casablancaTime.js';
import { checkProofSchedule, SCHEDULE_MIN_LEAD_MS, SCHEDULE_MAX_AHEAD_DAYS } from './paymentProofSchedule.js';

export const PROOF_STATUS = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  PUBLISHED: 'PUBLISHED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});
export const PROOF_STATUSES = Object.freeze(Object.values(PROOF_STATUS));

export const PROOF_TIMEZONE = CASABLANCA_TZ;
export const HOUR_MS = 3_600_000;
export const VISIBILITY_HOURS = 72;
export const VISIBILITY_MS = VISIBILITY_HOURS * HOUR_MS;

// ── Display duration (admin setting "Durée d'affichage des preuves de paiement") ──
/** Settings row (existing admin settings table) holding { hours, updatedAt, updatedBy, history }. */
export const PROOF_DISPLAY_SETTING_ID = 'payment-proof-display';
/** Default and rule of the proofs published before the setting existed. */
export const DEFAULT_DISPLAY_HOURS = VISIBILITY_HOURS;
/** Custom duration: whole hours, 1 … 8760 (365 days) — the DB CHECK mirrors it. */
export const MIN_DISPLAY_HOURS = 1;
export const MAX_DISPLAY_HOURS = 8760;
export const DISPLAY_DURATION_PRESETS = Object.freeze([
  Object.freeze({ key: '72h', hours: 72 }),
  Object.freeze({ key: '7d', hours: 7 * 24 }),
  Object.freeze({ key: '30d', hours: 30 * 24 }),
]);

/** A custom duration typed by the admin (number or digits only) → whole hours, or null when invalid / ≤ 0 / too long. */
export function parseDisplayHours(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*\d{1,6}\s*$/.test(value)) n = Number(value.trim());
  else return null;
  return Number.isInteger(n) && n >= MIN_DISPLAY_HOURS && n <= MAX_DISPLAY_HOURS ? n : null;
}

/** The duration stored in the setting row's data, or the 72 h default (missing / invalid row). */
export function displayHoursOf(settingData) {
  const h = settingData && typeof settingData === 'object' ? parseDisplayHours(settingData.hours) : null;
  return h ?? DEFAULT_DISPLAY_HOURS;
}

/** The preset key of a duration ('72h' | '7d' | '30d') or 'custom'. */
export const displayPresetOf = (hours) => DISPLAY_DURATION_PRESETS.find((p) => p.hours === hours)?.key ?? 'custom';

/** "72 heures (3 jours)", "36 heures (1 jour et 12 heures)", "5 heures" — the French label of a duration. */
export function describeDisplayHours(hours) {
  const h = Number(hours);
  if (!Number.isInteger(h) || h <= 0) return '';
  const days = Math.floor(h / 24), rest = h % 24;
  const H = (n) => `${n} heure${n > 1 ? 's' : ''}`;
  const D = (n) => `${n} jour${n > 1 ? 's' : ''}`;
  if (!days) return H(h);
  return `${H(h)} (${D(days)}${rest ? ` et ${H(rest)}` : ''})`;
}

/** End of display of a proof published at `publishedAtMs` with `hours`. */
export const visibleUntilOf = (publishedAtMs, hours) => new Date(publishedAtMs + hours * HOUR_MS);

export const PROOF_LIMITS = Object.freeze({
  MAX_AMOUNT_CENTS: 100_000_000,       // 1,000,000.00 MAD (DB CHECK mirrors it)
  ALIAS_MIN: 2,
  ALIAS_MAX: 40,
  MAX_BATCH_ITEMS: 200,
  MAX_SCHEDULE_AHEAD_DAYS: SCHEDULE_MAX_AHEAD_DAYS,
  MIN_LEAD_MS: SCHEDULE_MIN_LEAD_MS,   // a new / edited schedule must be ≥ 1 min in the future
  FEED_PAGE_SIZE: 50,                  // feed page size (cursor pagination — nothing is ever omitted)
  PUBLISH_BATCH_LIMIT: 200,            // bounded publication pass
  ADMIN_PAGE_SIZE: 50,
});

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export { err as proofError };

// ── Visibility ────────────────────────────────────────────────────────────────

/** [from (exclusive), to (inclusive)] publication bounds of the LEGACY 72 h window at `nowMs` (proofs without visibleUntil). */
export function visibilityWindow(nowMs) {
  return { fromExclusive: nowMs - VISIBILITY_MS, toInclusive: nowMs };
}

/** End of display (ms) of a published proof: its captured visibleUntil, else the legacy publishedAt + 72 h. */
export function displayEndMs(proof) {
  if (!proof?.publishedAt) return null;
  if (proof.visibleUntil) return new Date(proof.visibleUntil).getTime();
  return new Date(proof.publishedAt).getTime() + VISIBILITY_MS;
}

/**
 * The single visibility rule (mirrors the database query). `proof.removed` (or `removedAt`)
 * = a REMOVE event exists ("Supprimer") → never visible.
 */
export function isVisibleAt(proof, nowMs) {
  if (!proof || proof.status !== PROOF_STATUS.PUBLISHED || !proof.publishedAt) return false;
  if (proof.removed || proof.removedAt) return false;
  const p = new Date(proof.publishedAt).getTime();
  const end = displayEndMs(proof);
  return Number.isFinite(p) && Number.isFinite(end) && p <= nowMs && nowMs < end;
}

/**
 * Prisma `where` of the visible feed at `now` (mirrors isVisibleAt): published, not removed,
 * publishedAt <= now, and now < visibleUntil (legacy rows: publishedAt > now − 72 h).
 */
export function visibleFeedWhere(now) {
  const nowMs = new Date(now).getTime();
  return {
    status: PROOF_STATUS.PUBLISHED,
    publishedAt: { lte: new Date(nowMs) },
    OR: [
      { visibleUntil: { gt: new Date(nowMs) } },
      { visibleUntil: null, publishedAt: { gt: new Date(nowMs - VISIBILITY_MS) } },
    ],
    events: { none: { action: 'REMOVE' } },
  };
}

// ── Input validation ──────────────────────────────────────────────────────────

/** Amount in MAD (number or "1500", "1500.5", "1500,50") → integer cents, or NaN. */
export function parseAmountCents(value) {
  let s;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    s = String(value);
  } else if (typeof value === 'string') {
    s = value.trim().replace(',', '.');
  } else return NaN;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return cents > 0 && cents <= PROOF_LIMITS.MAX_AMOUNT_CENTS ? cents : NaN;
}

/** Display alias: trimmed, single spaces, 2–40 chars, no control characters or markup. */
export function normalizeAlias(value) {
  if (typeof value !== 'string') return null;
  const s = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < PROOF_LIMITS.ALIAS_MIN || s.length > PROOF_LIMITS.ALIAS_MAX) return null;
  if (/[\u0000-\u001f\u007f-\u009f<>{}\\]/.test(s) || /[‪-‮⁦-⁩]/.test(s)) return null;
  return s;
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_-]{8,100}$/;
export const isValidId = (v) => typeof v === 'string' && ID_RE.test(v);
/** The two mandatory admin declarations arrive as true / "true" (checkbox). */
export const isConfirmed = (v) => v === true || v === 'true';
export const isValidClientRef = (v) => typeof v === 'string' && REF_RE.test(v);
export const isValidPublicToken = (v) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);

// ── Africa/Casablanca local time ──────────────────────────────────────────────
// One explicit rule table shared with the admin browser (src/lib/casablancaTime.js):
// the runtime's own time-zone data is not trusted (an outdated ICU applied +01 to
// Morocco after its 2026-09-20 change to +00, refusing valid future times).

export { casablancaParts, casablancaLocal };

/**
 * Casablanca wall-clock date + time → UTC instant (ms).
 *   • a time that does not exist (skipped by a clock change) → NONEXISTENT_LOCAL_TIME
 *   • a time that occurs twice (clock set back) → the EARLIER instant
 *     (validateProofInput instead takes the earliest one still in the future)
 * Returns { ms } or { error }.
 */
export function casablancaToUtc(date, time) {
  const r = casablancaCandidates(date, time);
  return r.error ? { error: r.error } : { ms: r.candidates[0] };
}

/**
 * Validate one proof's fields. `nowMs` = server clock. Display name and amount are
 * presentation data typed by the admin; both declarations (privacy masked,
 * authenticity) are mandatory.
 * `publishMode`: absent / 'schedule' → the Casablanca `date` + `time` (the existing scheduling rule);
 * 'now' → "Publier maintenant": no date / time needed, scheduledAt = the server time `nowMs`
 * (the proof is published right after its creation — publishedAt is set at that moment).
 * Returns { value: { displayName, amountCents, scheduledAt, clientRef, batchId, publishMode: 'SCHEDULE'|'NOW' }, errors: {field: code} }.
 */
export function validateProofInput(input, { nowMs }) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const displayName = normalizeAlias(src.displayName);
  if (!displayName) errors.displayName = 'INVALID_ALIAS';
  const amountCents = parseAmountCents(src.amount);
  if (Number.isNaN(amountCents)) errors.amount = 'INVALID_AMOUNT';
  let scheduledAt = null;
  const mode = src.publishMode === undefined || src.publishMode === null || src.publishMode === '' || src.publishMode === 'schedule'
    ? 'SCHEDULE' : src.publishMode === 'now' ? 'NOW' : null;
  if (!mode) errors.publishMode = 'INVALID_PUBLISH_MODE';
  else if (mode === 'NOW') scheduledAt = new Date(nowMs);
  else {
    const sched = checkProofSchedule(src.date, src.time, nowMs); // same rule as the admin browser
    if (sched.error) errors.scheduledAt = sched.error;
    else scheduledAt = new Date(sched.ms);
  }
  const clientRef = isValidClientRef(src.clientRef) ? src.clientRef : null;
  if (!clientRef) errors.clientRef = 'INVALID_CLIENT_REF';
  let batchId = null;
  if (src.batchId !== undefined && src.batchId !== null && src.batchId !== '') {
    if (isValidClientRef(src.batchId)) batchId = src.batchId; else errors.batchId = 'INVALID_BATCH';
  }
  if (!isConfirmed(src.privacyConfirmed)) errors.privacyConfirmed = 'PRIVACY_CONFIRMATION_REQUIRED';
  if (!isConfirmed(src.authenticityConfirmed)) errors.authenticityConfirmed = 'AUTHENTICITY_CONFIRMATION_REQUIRED';
  return { value: { displayName, amountCents, scheduledAt, clientRef, batchId, publishMode: mode || 'SCHEDULE' }, errors };
}

// ── Shapes ────────────────────────────────────────────────────────────────────

export const centsToAmount = (c) => Math.round(Number(c)) / 100;

/** Affiliate-facing proof: display name, amount, publication time and an opaque image token — nothing else. */
export function publicProof(row) {
  return {
    token: row.publicToken,
    name: row.displayName,
    amount: centsToAmount(row.displayAmountCents),
    publishedAt: new Date(row.publishedAt).toISOString(),
  };
}

/**
 * Feed order, identical for every affiliate: publishedAt DESC, then publicToken ASC
 * (unique, already public — so a cursor never reveals an internal id).
 * Cursor = base64url("<publishedAt ms>.<publicToken>") of the last item of a page.
 */
export function encodeFeedCursor(item) {
  return Buffer.from(`${new Date(item.publishedAt).getTime()}.${item.token}`).toString('base64url');
}
export function decodeFeedCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 80 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { invalid: true };
  const m = /^(\d{13})\.([a-f0-9]{32})$/.exec(Buffer.from(raw, 'base64url').toString('latin1'));
  return m ? { publishedAtMs: Number(m[1]), token: m[2] } : { invalid: true };
}

/** Admin shape (no storage key, no fingerprint). */
export const PROOF_EVENT_ACTIONS = Object.freeze(['CREATE', 'CONFIRM_PRIVACY', 'CONFIRM_AUTHENTICITY', 'EDIT', 'CANCEL', 'PUBLISH', 'FAIL', 'REMOVE']);
/**
 * `publishedImmediately`: the proof was published by "Publier maintenant" (its PUBLISH event has
 * mode IMMEDIATE) — the admin list then shows only the actual publication time, not the planned one.
 * `removal`: { at, by } of its REMOVE event ("Supprimer"), or null.
 * `nowMs` (optional): adds `onSlider` — shown to affiliates right now (published, not removed, not expired).
 */
export function adminProof(row, { publishedImmediately = false, removal = null, nowMs = null } = {}) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: row.id,
    displayName: row.displayName,
    amount: centsToAmount(row.displayAmountCents),
    status: row.status,
    scheduledAt: iso(row.scheduledAt),
    scheduledLocal: row.scheduledAt ? casablancaLocal(new Date(row.scheduledAt).getTime()) : null,
    publishedAt: iso(row.publishedAt),
    publishedImmediately: row.status === 'PUBLISHED' && publishedImmediately === true,
    visibleHours: row.publishedAt ? (row.visibleHours ?? VISIBILITY_HOURS) : null,
    visibleUntil: row.publishedAt ? new Date(displayEndMs(row)).toISOString() : null,
    removed: !!removal,
    removedAt: removal ? iso(removal.at) : null,
    removedBy: removal ? removal.by || null : null,
    removedByName: removal ? removal.byName || null : null, // display name (adminNameService), never the e-mail
    ...(nowMs === null ? {} : { onSlider: isVisibleAt({ ...row, removed: !!removal }, nowMs) }),
    cancelledAt: iso(row.cancelledAt),
    failedAt: iso(row.failedAt),
    failureReason: row.failureReason || null,
    publishAttempts: row.publishAttempts ?? 0,
    privacyConfirmedAt: iso(row.privacyConfirmedAt),
    privacyConfirmedBy: row.privacyConfirmedBy || null,
    authenticityConfirmedAt: iso(row.authenticityConfirmedAt),
    authenticityConfirmedBy: row.authenticityConfirmedBy || null,
    batchId: row.batchId || null,
    clientRef: row.clientRef,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
