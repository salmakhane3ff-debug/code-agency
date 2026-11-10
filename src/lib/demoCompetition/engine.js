/**
 * src/lib/demoCompetition/engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition (Top Members / Top Brands) — the PURE simulation engine.
 * No database, no React, no I/O, no Math.random: everything is a deterministic
 * function of (stream, profile id, Casablanca day, settings), so re-running it
 * always produces the same events — the base of idempotent generation.
 *
 * SIMULATION ONLY. Nothing here is a real order, sale, commission or amount of
 * money; the services that persist it only ever write the demo_comp_* tables.
 *
 * Model
 *   • Three independent streams: PERSONAL (a member's own demo sales), NETWORK
 *     (a member's demo affiliate network) and BRAND (a demo brand's sales).
 *   • Per stream, per profile, per Africa/Casablanca day: ONE plan whose target
 *     number of demo orders is drawn in [min, max] of the settings version in
 *     force at the day's start.
 *   • The target is split into events of 1..3 orders, spread over the day with
 *     busier hours (late morning, evening). An event becomes visible only once
 *     its scheduled time has passed.
 *   • An event's price / allocation are those of the settings version in force at
 *     its scheduled time (snapshotted on the event): settings changes affect
 *     future events only; history is never recalculated.
 *   • earningsCents = round(quantity × priceCents × allocationBps / 10000).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEMO_TIMEZONE = 'Africa/Casablanca';
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Rolling windows (exact hours, upper bound = now): 24 h, 7 d = 168 h, 30 d = 720 h. */
export const WINDOWS = Object.freeze({ h24: 24 * HOUR_MS, d7: 168 * HOUR_MS, d30: 720 * HOUR_MS });
export const RANKING_WINDOW = 'd30';

/** Days of history generated for a new profile (and by the initial backfill). */
export const BACKFILL_DAYS = 30;

/** Exact target sizes requested for the competition. */
export const MAX_MEMBERS = 21;
export const MAX_BRANDS = 20;

export const STREAMS = Object.freeze({ PERSONAL: 'PERSONAL', NETWORK: 'NETWORK', BRAND: 'BRAND' });
export const EVENT_TYPES = Object.freeze({ PERSONAL: 'PERSONAL_SALE', NETWORK: 'NETWORK_SALE', BRAND: 'BRAND_SALE' });

/** Validation limits (mirrored by CHECK constraints in migration 20261113_demo_competition). */
export const LIMITS = Object.freeze({
  nameMax: 80,
  ordersMax: 1000,          // demo orders per day
  priceCentsMin: 1,
  priceCentsMax: 10_000_000, // 100 000 DH
  bpsMin: 1,                // 0.01 %
  bpsMax: 10_000,           // 100 %
  affiliatesMax: 100_000,
});

export const DEFAULTS = Object.freeze({
  priceCents: 30_000,   // 300 DH
  memberBps: 3_000,     // 30 % → 90 DH per demo order
  brandBps: 7_000,      // 70 % → 210 DH per demo order
  minDailyOrders: 5,
  maxDailyOrders: 30,
});

// ── Deterministic randomness ──────────────────────────────────────────────────

/** FNV-1a 32-bit hash of a string → seed. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG → () => float in [0, 1). */
export function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Africa/Casablanca days (offset changes around Ramadan are handled) ───────

const PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function casaParts(ms) {
  const o = {};
  for (const p of PARTS_FMT.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

function casaOffset(ms) {
  const p = casaParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of Casablanca midnight y-m-d (robust on clock-change days). */
export function casablancaMidnight(y, m, d) {
  const utcMid = Date.UTC(y, m - 1, d);
  const candidates = new Set([-14, -3, -1, 1, 3, 14].map((h) => utcMid - casaOffset(utcMid + h * HOUR_MS)));
  const ok = [...candidates].filter((t) => {
    const p = casaParts(t);
    return p.year === y && p.month === m && p.day === d && p.hour === 0 && p.minute === 0;
  });
  if (ok.length) return Math.min(...ok);
  for (let t = utcMid - 14 * HOUR_MS; t < utcMid + 14 * HOUR_MS; t += 15 * 60_000) {
    const p = casaParts(t);
    if (p.year === y && p.month === m && p.day === d) return t;
  }
  return utcMid;
}

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of the Casablanca day containing `ms`. */
export function dayKeyOf(ms) {
  const p = casaParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** { dayKey, start, end } of a Casablanca day ([start, end), 23..25 hours long). */
export function dayBounds(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    dayKey,
    start: casablancaMidnight(y, m, d),
    end: casablancaMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

/** The Casablanca day `n` days after `dayKey` (n may be negative). */
export function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Day keys from `fromKey` to `toKey` inclusive (ascending). */
export function dayKeysBetween(fromKey, toKey) {
  const out = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) out.push(k);
  return out;
}

/** Start of the backfill: Casablanca midnight BACKFILL_DAYS days before the day containing `nowMs`. */
export function backfillStart(nowMs, days = BACKFILL_DAYS) {
  return dayBounds(addDays(dayKeyOf(nowMs), -days)).start;
}

// ── Settings validation ───────────────────────────────────────────────────────

const isInt = (v) => Number.isInteger(v);
const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;

/** Parse a DH amount (number or "300" / "300.50") into centimes; null when invalid. */
export function dhToCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
  if (!Number.isFinite(n)) return null;
  const c = Math.round(n * 100);
  return Math.abs(c / 100 - n) < 1e-9 ? c : null;
}

/** Parse a percentage (number or "30" / "12.5") into basis points; null when invalid. */
export function percentToBps(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
  if (!Number.isFinite(n)) return null;
  const b = Math.round(n * 100);
  return Math.abs(b / 100 - n) < 1e-9 ? b : null;
}

/** Per-field validation errors of a min / max daily-orders pair. */
function orderRangeErrors(min, max, prefix, errors) {
  // field names: minDailyOrders / maxDailyOrders, or networkMinDailyOrders / networkMaxDailyOrders
  const field = (name) => (prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name);
  if (!inRange(min, 0, LIMITS.ordersMax)) errors[field('minDailyOrders')] = 'INVALID_MIN_ORDERS';
  if (!inRange(max, 0, LIMITS.ordersMax)) errors[field('maxDailyOrders')] = 'INVALID_MAX_ORDERS';
  else if (inRange(min, 0, LIMITS.ordersMax) && max < min) errors[field('maxDailyOrders')] = 'MAX_BELOW_MIN';
}

export function normalizeName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Validate a complete member settings object (amounts already in centimes / bps).
 * Returns { ok, errors: { field: CODE } }.
 */
export function validateMemberSettings(s) {
  const errors = {};
  const name = normalizeName(s?.name);
  if (!name || name.length > LIMITS.nameMax || /[<>]/.test(name)) errors.name = 'INVALID_NAME';
  orderRangeErrors(s?.minDailyOrders, s?.maxDailyOrders, '', errors);
  if (!inRange(s?.priceCents, LIMITS.priceCentsMin, LIMITS.priceCentsMax)) errors.priceCents = 'INVALID_PRICE';
  if (!inRange(s?.allocationBps, LIMITS.bpsMin, LIMITS.bpsMax)) errors.allocationBps = 'INVALID_ALLOCATION';
  if (!inRange(s?.networkAffiliates, 0, LIMITS.affiliatesMax)) errors.networkAffiliates = 'INVALID_AFFILIATES';
  orderRangeErrors(s?.networkMinDailyOrders, s?.networkMaxDailyOrders, 'network', errors);
  const np = s?.networkPriceCents ?? null, nb = s?.networkAllocationBps ?? null;
  if ((np === null) !== (nb === null)) errors.networkAllocationBps = 'NETWORK_RATE_INCOMPLETE';
  if (np !== null && !inRange(np, LIMITS.priceCentsMin, LIMITS.priceCentsMax)) errors.networkPriceCents = 'INVALID_PRICE';
  if (nb !== null && !inRange(nb, LIMITS.bpsMin, LIMITS.bpsMax)) errors.networkAllocationBps = 'INVALID_ALLOCATION';
  if (typeof s?.active !== 'boolean') errors.active = 'INVALID_ACTIVE';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Validate a complete brand settings object. */
export function validateBrandSettings(s) {
  const errors = {};
  const name = normalizeName(s?.name);
  if (!name || name.length > LIMITS.nameMax || /[<>]/.test(name)) errors.name = 'INVALID_NAME';
  if (typeof s?.ownerId !== 'string' || !s.ownerId) errors.ownerId = 'OWNER_REQUIRED';
  orderRangeErrors(s?.minDailyOrders, s?.maxDailyOrders, '', errors);
  if (!inRange(s?.priceCents, LIMITS.priceCentsMin, LIMITS.priceCentsMax)) errors.priceCents = 'INVALID_PRICE';
  if (!inRange(s?.allocationBps, LIMITS.bpsMin, LIMITS.bpsMax)) errors.allocationBps = 'INVALID_ALLOCATION';
  if (typeof s?.active !== 'boolean') errors.active = 'INVALID_ACTIVE';
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Engine defaults: price + the two default allocations. Member and brand allocations belong to
 * SEPARATE demo sales streams, so each is validated on its own (0.01 %..100 %) — no combined cap.
 */
export function validateDefaults(d) {
  const errors = {};
  if (!inRange(d?.defaultPriceCents, LIMITS.priceCentsMin, LIMITS.priceCentsMax)) errors.defaultPriceCents = 'INVALID_PRICE';
  if (!inRange(d?.defaultMemberBps, LIMITS.bpsMin, LIMITS.bpsMax)) errors.defaultMemberBps = 'INVALID_ALLOCATION';
  if (!inRange(d?.defaultBrandBps, LIMITS.bpsMin, LIMITS.bpsMax)) errors.defaultBrandBps = 'INVALID_ALLOCATION';
  return { ok: Object.keys(errors).length === 0, errors };
}

// ── Earnings ──────────────────────────────────────────────────────────────────

/** Earnings (centimes) of `quantity` demo orders at a price / allocation snapshot. */
export function earningsCents(quantity, priceCents, allocationBps) {
  return Math.round((quantity * priceCents * allocationBps) / 10_000);
}

// ── Settings versions ─────────────────────────────────────────────────────────

/** The version in force at `t` (versions sorted by effectiveFrom ascending), or null. */
export function versionAt(versions, t) {
  let found = null;
  for (const v of versions) {
    if (+new Date(v.effectiveFrom) <= t) found = v; else break;
  }
  return found;
}

/** The stream's parameters within a version; null when the stream is off in that version. */
export function streamParams(stream, v) {
  if (!v) return null;
  if (stream === STREAMS.NETWORK) {
    if (v.networkPriceCents == null || v.networkAllocationBps == null || !(v.networkAffiliates > 0)) return null;
    return { min: v.networkMinDailyOrders, max: v.networkMaxDailyOrders, priceCents: v.networkPriceCents, allocationBps: v.networkAllocationBps };
  }
  return { min: v.minDailyOrders, max: v.maxDailyOrders, priceCents: v.priceCents, allocationBps: v.allocationBps };
}

// ── Daily plan + schedule ─────────────────────────────────────────────────────

/** The day's target, deterministic in [min, max]. */
export function planTarget(stream, profileId, dayKey, min, max) {
  if (!(max > 0) || max < min) return Math.max(0, Math.min(min, max));
  const rnd = mulberry32(hashSeed(`target:${stream}:${profileId}:${dayKey}`));
  return min + Math.floor(rnd() * (max - min + 1));
}

/**
 * Relative activity per Casablanca hour (0..23): quiet nights, a late-morning
 * and a strong evening peak (typical COD e-commerce traffic).
 */
export const HOUR_WEIGHTS = Object.freeze([
  1.5, 0.8, 0.4, 0.25, 0.25, 0.4, 0.8, 1.5, 2.5, 3.5, 4.5, 5.5,
  6, 6, 5, 4.5, 4.5, 5.5, 6.5, 7.5, 8.5, 8.5, 6.5, 3.5,
]);
const HOUR_CUM = (() => {
  let acc = 0;
  return HOUR_WEIGHTS.map((w) => (acc += w));
})();
const HOUR_TOTAL = HOUR_CUM[HOUR_CUM.length - 1];

function pickHour(r) {
  const x = r * HOUR_TOTAL;
  for (let h = 0; h < 24; h++) if (x < HOUR_CUM[h]) return h;
  return 23;
}

/** Event sizes: 1 (55 %), 2 (30 %), 3 (15 %), never more than what is left. */
function pickQuantity(r, left) {
  const q = r < 0.55 ? 1 : r < 0.85 ? 2 : 3;
  return Math.min(q, left);
}

/**
 * The day's schedule: the target split into events of 1..3 orders at
 * deterministic times inside [start, end), ascending, strictly increasing.
 * Returns [{ seq, quantity, at }].
 */
export function daySchedule(stream, profileId, dayKey, target, start, end) {
  if (!(target > 0)) return [];
  const rnd = mulberry32(hashSeed(`schedule:${stream}:${profileId}:${dayKey}`));
  const span = end - start;
  const chunks = [];
  let left = target;
  while (left > 0) {
    const q = pickQuantity(rnd(), left);
    left -= q;
    const hour = pickHour(rnd());
    const at = start + Math.floor(((hour + rnd()) / 24) * span);
    chunks.push({ quantity: q, at: Math.min(Math.max(at, start), end - 1) });
  }
  chunks.sort((a, b) => a.at - b.at || a.quantity - b.quantity);
  for (let i = 1; i < chunks.length; i++) if (chunks[i].at <= chunks[i - 1].at) chunks[i].at = chunks[i - 1].at + 1;
  return chunks.map((c, seq) => ({ seq, quantity: c.quantity, at: c.at }));
}

/** Idempotency key of one event (unique in the database). */
export const eventKey = (stream, profileId, dayKey, seq) => `${stream}:${profileId}:${dayKey}:${seq}`;

/**
 * The plan of one stream / profile / day from the versions (null when no version is in force at
 * the day's start, i.e. before the profile's history begins).
 */
export function buildPlan(stream, profileId, dayKey, versions) {
  const { start, end } = dayBounds(dayKey);
  const v = versionAt(versions, start);
  if (!v) return null;
  const params = streamParams(stream, v);
  const min = params ? params.min : 0;
  const max = params ? params.max : 0;
  return {
    stream, profileId, dayKey, dayStart: start, dayEnd: end,
    minOrders: min, maxOrders: max, versionId: v.id,
    targetOrders: params ? planTarget(stream, profileId, dayKey, min, max) : 0,
  };
}

/**
 * The events of one plan that are due in (fromMs, toMs] — each with the price / allocation of the
 * version in force at its time. Events falling while the profile is inactive or the stream is off
 * are skipped (deterministically: re-running gives the same result).
 */
export function dueEvents(plan, versions, fromMs, toMs) {
  const out = [];
  for (const s of daySchedule(plan.stream, plan.profileId, plan.dayKey, plan.targetOrders, plan.dayStart, plan.dayEnd)) {
    if (s.at <= fromMs || s.at > toMs) continue;
    const v = versionAt(versions, s.at);
    if (!v || !v.active) continue;
    const p = streamParams(plan.stream, v);
    if (!p) continue;
    out.push({
      eventType: EVENT_TYPES[plan.stream],
      seq: s.seq,
      quantity: s.quantity,
      priceCents: p.priceCents,
      allocationBps: p.allocationBps,
      earningsCents: earningsCents(s.quantity, p.priceCents, p.allocationBps),
      versionId: v.id,
      scheduledAt: s.at,
      idempotencyKey: eventKey(plan.stream, plan.profileId, plan.dayKey, s.seq),
    });
  }
  return out;
}

// ── Rankings ──────────────────────────────────────────────────────────────────

/**
 * Rank profiles by rolling 30-day earnings (descending). Deterministic tie-break:
 * 30-day orders (desc), then creation time (oldest first), then id.
 * rows: [{ id, createdAt, earnings30dCents, orders30d }] → same rows + rank (1..n).
 */
export function rankProfiles(rows) {
  return [...rows]
    .sort((a, b) => (b.earnings30dCents - a.earnings30dCents)
      || (b.orders30d - a.orders30d)
      || (+new Date(a.createdAt) - +new Date(b.createdAt))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Rank change between two rankings (positive = moved up). New entries → null. */
export function rankChange(previousRank, currentRank) {
  if (!Number.isInteger(previousRank)) return null;
  return previousRank - currentRank;
}

/** A profile is "live" when it had a demo event in the last `windowMs` (default 10 min). */
export const LIVE_WINDOW_MS = 10 * 60_000;
export const isLive = (lastEventAt, nowMs, windowMs = LIVE_WINDOW_MS) => !!lastEventAt && nowMs - +new Date(lastEventAt) <= windowMs;
