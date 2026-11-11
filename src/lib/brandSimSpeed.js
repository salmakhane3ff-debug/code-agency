/**
 * src/lib/brandSimSpeed.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — PER-BRAND simulation speed (PURE: no DB, no I/O).
 *
 * An administrator may give ONE brand (one brand access) its own speed:
 *   { enabled, limits: { hourMin, hourMax, dayMin, dayMax } | null }
 * stored as an append-only list of VERSIONS per access, each taking effect at a
 * full hour (`effectiveFrom`, always the NEXT hour boundary when saved), so an
 * hour that was — or could have been — generated before a change is never
 * altered by it. A brand with no version (or whose version has `limits: null`)
 * keeps the existing behaviour: the global daily volume (brandSimulation.simulateDay).
 * `enabled: false` pauses THAT brand only (its hours are not generated).
 *
 * With limits, every hour gets its own count, chosen in this order of priority:
 *   1. never above the 24-hour maximum over ANY 24-hour period: a period [t − 24 h, t] (the
 *      dashboard's sliding "24 h") touches at most 25 clock hours, so the count keeps every
 *      25 consecutive clock hours ≤ dayMaxEff: count ≤ dayMaxEff − (sum of the 24 previous hours)
 *   2. within the hourly range [hourMin, hourCap], hourCap = min(hourMax, dayMaxEff − dayMinEff)
 *   3. high enough for the 24-hour minimum (each block of 24 consecutive clock hours) once the
 *      brand has run a full day: count ≥ dayMinEff − (sum of the 23 previous hours)
 * where the effective 24-hour range is [max(dayMin, 24·hourMin), min(dayMax, 24·hourMax)].
 * Validation requires dayMaxEff − dayMinEff ≥ min(hourMax, ⌈dayMinEff / 24⌉) (DAY_RANGE_TOO_NARROW
 * otherwise): then, if the previous hours respected 1–3, a count satisfying all three always exists
 * (the count of the hour 24 hours earlier is one), so after the first full day every 24-hour block
 * stays inside the range and no 24-hour period ever exceeds the maximum. Within that, the count
 * follows a daily target drawn in the range (spread evenly over the hours, ±1 jitter) — no burst.
 * Inside an hour, orders get random minutes and outcomes (the global distribution).
 *
 * Everything is a deterministic function of (seed, hour, previous counts): a restart, a
 * concurrent run or a dashboard read recomputes the same values; generation runs in hour
 * order under the per-access lock (brandSimulationService). Nothing here touches money,
 * wallets, commissions or real orders.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SIM_OUTCOMES } from './brandProgram.js';
import { HOUR_MS, DAY_MS, floorHour, floorDay, hashSeed, mulberry32, simulatedOrderRef } from './brandSimulation.js';

export const BRAND_SIM_SPEED_SETTING_ID = 'brand-sim-speed';

export const SPEED_LIMITS = Object.freeze({
  MAX_PER_HOUR: 300,  // order positions per hour (reference numbering: see speedOrderIndex)
  MAX_PER_DAY: 1000,  // same ceiling as the global daily volume
});

/** First reference position of the per-hour orders: positions 0–999 belong to the daily generator. */
const SPEED_INDEX_BASE = 1000;
/** Reference position of the k-th order of a UTC hour: unique per day, disjoint from the daily generator's. */
export const speedOrderIndex = (utcHour, k) => SPEED_INDEX_BASE + utcHour * SPEED_LIMITS.MAX_PER_HOUR + k;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const LIMIT_KEYS = Object.freeze(['hourMin', 'hourMax', 'dayMin', 'dayMax']);

function intOrNaN(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v.trim()) : NaN);
  return Number.isSafeInteger(n) ? n : NaN;
}

/**
 * Validate an admin input { enabled, custom, hourMin, hourMax, dayMin, dayMax }.
 * `custom: false` → { enabled, limits: null } (the global behaviour, optionally paused).
 * Returns { ok, errors: { field|'limits': CODE }, value: { enabled, limits } }.
 * Conflicts are refused, never adjusted: HOUR_RANGE (min > max), DAY_RANGE (min > max),
 * HOUR_MIN_OVER_DAY_MAX (24 × hourly min > 24 h max), HOUR_MAX_UNDER_DAY_MIN (24 × hourly max < 24 h min),
 * DAY_RANGE_TOO_NARROW (effective 24 h range narrower than requiredDayGap: the maximum could not be
 * guaranteed over every sliding 24-hour period).
 */
export function validateSpeedInput(input) {
  const src = isObj(input) ? input : {};
  const errors = {};
  if (typeof src.enabled !== 'boolean') errors.enabled = 'INVALID_BOOLEAN';
  const enabled = src.enabled === true;
  if (src.custom === false) return { ok: !errors.enabled, errors, value: { enabled, limits: null } };
  const v = {};
  for (const k of LIMIT_KEYS) {
    const n = intOrNaN(src[k]);
    const max = k.startsWith('hour') ? SPEED_LIMITS.MAX_PER_HOUR : SPEED_LIMITS.MAX_PER_DAY;
    if (Number.isNaN(n) || n < 0 || n > max) errors[k] = 'INVALID_NUMBER';
    v[k] = n;
  }
  if (!errors.hourMax && v.hourMax < 1) errors.hourMax = 'INVALID_NUMBER';
  if (!errors.dayMax && v.dayMax < 1) errors.dayMax = 'INVALID_NUMBER';
  if (!errors.hourMin && !errors.hourMax && v.hourMin > v.hourMax) errors.hourMin = 'HOUR_RANGE';
  if (!errors.dayMin && !errors.dayMax && v.dayMin > v.dayMax) errors.dayMin = 'DAY_RANGE';
  if (!Object.keys(errors).length) {
    if (24 * v.hourMin > v.dayMax) errors.limits = 'HOUR_MIN_OVER_DAY_MAX';
    else if (24 * v.hourMax < v.dayMin) errors.limits = 'HOUR_MAX_UNDER_DAY_MIN';
    else {
      const eff = effectiveDayRange(v);
      if (eff.max - eff.min < requiredDayGap(v)) errors.limits = 'DAY_RANGE_TOO_NARROW';
    }
  }
  return { ok: !Object.keys(errors).length, errors, value: { enabled, limits: Object.keys(errors).length ? null : v } };
}

/** The 24-hour range the limits really allow: [max(dayMin, 24·hourMin), min(dayMax, 24·hourMax)]. */
export function effectiveDayRange(limits) {
  return { min: Math.max(limits.dayMin, 24 * limits.hourMin), max: Math.min(limits.dayMax, 24 * limits.hourMax) };
}

/**
 * Smallest gap (effective 24 h max − effective 24 h min) for which both the 24-hour minimum (per block of
 * 24 clock hours) and the maximum over every sliding 24-hour period can always be kept:
 * min(hourMax, ⌈effective min / 24⌉). Always ≥ hourMin.
 */
export function requiredDayGap(limits) {
  return Math.min(limits.hourMax, Math.ceil(effectiveDayRange(limits).min / 24));
}

/** Highest count an hour may get: min(hourMax, effective 24 h max − effective 24 h min). */
export function hourCap(limits) {
  const eff = effectiveDayRange(limits);
  return Math.min(limits.hourMax, eff.max - eff.min);
}

/** Clean stored limits (all four integers, consistent) or null. */
function cleanLimits(l) {
  if (!isObj(l)) return null;
  const r = validateSpeedInput({ enabled: true, ...l });
  if (r.ok) return r.value.limits;
  // A version stored before the DAY_RANGE_TOO_NARROW rule keeps its limits (history is never re-read
  // differently); speedHourCount still never exceeds the maximum with it.
  const keys = Object.keys(r.errors);
  return keys.length === 1 && r.errors.limits === 'DAY_RANGE_TOO_NARROW' ? Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(l[k])])) : null;
}

/** Normalize the stored setting → { accesses: { [accessId]: versions sorted by effectiveFrom } }. */
export function normalizeSpeedConfig(raw) {
  const src = isObj(raw) && isObj(raw.accesses) ? raw.accesses : {};
  const accesses = {};
  for (const [id, list] of Object.entries(src)) {
    if (!Array.isArray(list)) continue;
    const versions = list
      .filter((v) => isObj(v) && !Number.isNaN(new Date(v.effectiveFrom).getTime()))
      .map((v) => ({
        effectiveFrom: new Date(floorHour(new Date(v.effectiveFrom).getTime())).toISOString(),
        enabled: v.enabled !== false,
        limits: cleanLimits(v.limits),
        savedAt: typeof v.savedAt === 'string' ? v.savedAt : null,
        savedBy: typeof v.savedBy === 'string' ? v.savedBy : null,
      }))
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
    if (versions.length) accesses[id] = versions;
  }
  return { accesses };
}

/** Version of one access in force at hour `h` (last effectiveFrom ≤ h), or null (= global behaviour). */
export function speedVersionAt(versions, h) {
  let found = null;
  for (const v of versions || []) {
    if (new Date(v.effectiveFrom).getTime() <= h) found = v; else break;
  }
  return found;
}

/** The access's simulation is not paused by its own setting at hour `h`. */
export const speedEnabledAt = (versions, h) => speedVersionAt(versions, h)?.enabled !== false;
/** Custom limits in force at hour `h`, or null (global daily behaviour). */
export const speedLimitsAt = (versions, h) => speedVersionAt(versions, h)?.limits || null;

/**
 * Append a version taking effect at the next full hour after `nowMs`. A version not yet in
 * force (same effectiveFrom) is replaced: no hour has used it. Earlier versions never change.
 */
export function appendSpeedVersion(versions, { enabled, limits }, { nowMs, actorId = null }) {
  const effectiveFrom = new Date(floorHour(nowMs) + HOUR_MS).toISOString();
  const kept = (versions || []).filter((v) => new Date(v.effectiveFrom).getTime() <= nowMs);
  return [...kept, { effectiveFrom, enabled: !!enabled, limits: limits || null, savedAt: new Date(nowMs).toISOString(), savedBy: actorId }];
}

/**
 * Count of the hour starting at `h` under `limits`, given its previous hours `win` = prevWindow(counts, h):
 * { sum, present } over the 23 previous hours and { sum24, present24 } over the 24 previous hours
 * (missing hours = 0; present = how many exist). Deterministic in (seed, h, win). While fewer previous
 * hours exist (start, after a pause or a change), capacity is reserved for the hours still to come so the
 * first full windows can stay inside both ranges. See the header for the priorities; the maximum always wins.
 */
export function speedHourCount(seed, h, limits, win) {
  const prevSum = Number(win?.sum) || 0;
  const prevPresent = win?.present ?? 23;
  const prevSum24 = Number(win?.sum24 ?? prevSum) || 0;
  const prevPresent24 = win?.present24 ?? 24;
  const { min: dayMinEff, max: dayMaxEff } = effectiveDayRange(limits);
  const day = floorDay(h);
  const dayRng = mulberry32(hashSeed(`${seed}:speed-day:${new Date(day).toISOString().slice(0, 10)}`));
  const target = dayMinEff + Math.floor(dayRng() * (dayMaxEff - dayMinEff + 1));
  const rng = mulberry32(hashSeed(`${seed}:speed-hour:${new Date(h).toISOString()}`));
  const base = target / 24;
  let desired = Math.floor(base) + (rng() < base - Math.floor(base) ? 1 : 0);
  const j = rng();
  if (j < 0.2) desired -= 1; else if (j >= 0.8) desired += 1;
  const cap = hourCap(limits);
  const toCome24 = Math.max(0, 23 - prevPresent);   // hours of the first full 24-hour block still to come
  const toCome25 = Math.max(0, 24 - prevPresent24); // hours of the first full 25-hour span still to come
  const lo = Math.max(limits.hourMin, dayMinEff - prevSum - cap * toCome24);
  const hi = Math.min(cap, dayMaxEff - prevSum24 - limits.hourMin * toCome25);
  if (lo > hi) return Math.max(0, hi); // only after a gap / a change: the maximum wins
  return Math.min(hi, Math.max(lo, desired));
}

/**
 * The orders of one hour under custom limits: `count` orders with random minutes and
 * outcomes from the day's distribution, sorted by time. Same shape as simulatedDayOrders.
 */
export function speedHourOrders(seed, h, count, distribution) {
  const rng = mulberry32(hashSeed(`${seed}:speed-orders:${new Date(h).toISOString()}`));
  const cumulative = [];
  let acc = 0;
  for (const k of SIM_OUTCOMES) { acc += Number(distribution?.[k]) || 0; cumulative.push([k, acc]); }
  const utcHour = new Date(h).getUTCHours();
  const drafts = [];
  for (let k = 0; k < count; k++) {
    const minute = Math.floor(rng() * 60);
    const roll = rng() * 100;
    const outcome = (cumulative.find(([, c]) => roll < c) || cumulative[cumulative.length - 1])[0];
    drafts.push({ minute, outcome });
  }
  drafts.sort((a, b) => a.minute - b.minute);
  return drafts.map((d, k) => {
    const at = h + d.minute * 60_000;
    const index = speedOrderIndex(utcHour, k);
    const { ref, hash } = simulatedOrderRef(seed, h, index);
    return Object.freeze({ at, hourStart: h, outcome: d.outcome, index, ref, hash, iso: new Date(at).toISOString() });
  });
}

/** Outcome counts of one hour's speed orders (a brand_sim_hours row without ids). */
export function speedHourRowCounts(orders) {
  const c = { created: orders.length, ...Object.fromEntries(SIM_OUTCOMES.map((k) => [k, 0])) };
  for (const o of orders) c[o.outcome]++;
  return c;
}

/**
 * The hours before `h` in a Map(hourStart → created): { sum, present } over the 23 previous hours and
 * { sum24, present24 } over the 24 previous hours (present = hours that exist).
 */
export function prevWindow(counts, h) {
  let sum = 0, present = 0;
  for (let x = h - 23 * HOUR_MS; x < h; x += HOUR_MS) {
    if (!counts.has(x)) continue;
    present++;
    sum += Number(counts.get(x)) || 0;
  }
  const first = h - 24 * HOUR_MS;
  const has = counts.has(first);
  return { sum, present, sum24: sum + (has ? Number(counts.get(first)) || 0 : 0), present24: present + (has ? 1 : 0) };
}

/** First hour start whose previous hours speedHourCount needs: 24 hours before `h`. */
export const SPEED_HISTORY_HOURS = 24;

export { DAY_MS };
