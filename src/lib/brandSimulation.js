/**
 * src/lib/brandSimulation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — the TRAINING SIMULATION engine. PURE (no DB, no I/O).
 *
 * Simulated orders are generated, never recorded as orders: each brand access
 * has a deterministic, seeded stream of fictional orders. For one UTC day the
 * stream fixes the day's volume (in the admin range), each order's hour and
 * minute, and its final outcome (drawn from the admin distribution). Because the
 * stream is a pure function of (seed, day, settings), regenerating an hour always
 * yields the same counts — the service persists completed hours with
 * ON CONFLICT DO NOTHING, so a restart or a concurrent request can never
 * duplicate anything.
 *
 * Displayed status depends on the order's age and the admin "speed" settings:
 *   age < confirmationDelayHours          → pending
 *   noResponse / cancelled outcomes       → shown once confirmation time passes
 *   delivered / refused / returned        → "confirmed" until deliveryDelayHours,
 *                                            then the final outcome
 *
 * Nothing here knows about real orders, products, customers, money or wallets.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SIM_OUTCOMES, SIM_STATUSES } from './brandProgram.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Dashboard windows: rolling 24 h in hourly buckets; 7 and 30 days in daily (UTC) buckets. */
export const SIM_WINDOWS = Object.freeze({
  '24h': { unit: 'hour', size: 24 },
  '7d':  { unit: 'day',  size: 7 },
  '30d': { unit: 'day',  size: 30 },
});
/** Oldest day ever generated or read: the longest window. */

export const floorHour = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
export const ceilHour = (ms) => Math.ceil(ms / HOUR_MS) * HOUR_MS;
export const floorDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

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
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Generation ────────────────────────────────────────────────────────────────

/**
 * Every simulated order of one UTC day for one brand access, in a fixed order:
 * [{ hour: 0–23, minute: 0–59, outcome }]. Pure function of (seed, day, settings).
 */
export function simulateDay(seed, dayStartMs, sim) {
  const rng = mulberry32(hashSeed(`${seed}:${new Date(floorDay(dayStartMs)).toISOString().slice(0, 10)}`));
  const volume = sim.dailyVolumeMin + Math.floor(rng() * (sim.dailyVolumeMax - sim.dailyVolumeMin + 1));
  const cumulative = [];
  let acc = 0;
  for (const k of SIM_OUTCOMES) { acc += sim.distribution[k]; cumulative.push([k, acc]); }
  const orders = [];
  for (let i = 0; i < volume; i++) {
    const hour = Math.floor(rng() * 24);
    const minute = Math.floor(rng() * 60);
    const roll = rng() * 100;
    const outcome = (cumulative.find(([, c]) => roll < c) || cumulative[cumulative.length - 1])[0];
    orders.push({ hour, minute, outcome });
  }
  return orders;
}

const emptyCounts = () => ({ created: 0, ...Object.fromEntries(SIM_OUTCOMES.map((k) => [k, 0])) });

/** Outcome counts of one hour's orders (all of them, or only those before `minuteLimit`). */
export function countHour(dayOrders, hour, minuteLimit = 60) {
  const c = emptyCounts();
  for (const o of dayOrders) {
    if (o.hour === hour && o.minute < minuteLimit) { c.created++; c[o.outcome]++; }
  }
  return c;
}

/**
 * Rows for the given hour starts — zero-order hours included, so an hour is
 * generated exactly once. `paramsFor(dayStartMs)` returns the settings of that
 * business day (see brandSimTimeline.dayParams); a plain settings object is
 * accepted for a single fixed configuration.
 */
export function buildHourRows(accessId, seed, hourStarts, paramsFor) {
  const params = typeof paramsFor === 'function' ? paramsFor : () => paramsFor;
  const rows = [];
  const days = new Map();
  for (const h of hourStarts) {
    const day = floorDay(h);
    if (!days.has(day)) days.set(day, simulateDay(seed, day, params(day)));
    rows.push({ accessId, hourStart: new Date(h), ...countHour(days.get(day), new Date(h).getUTCHours()) });
  }
  return rows;
}

/** The current, unfinished hour so far (computed on read, never persisted). */
export function liveHourCounts(seed, nowMs, sim) {
  const hourStart = floorHour(nowMs);
  return {
    hourStart: new Date(hourStart),
    ...countHour(simulateDay(seed, hourStart, sim), new Date(hourStart).getUTCHours(), Math.floor((nowMs - hourStart) / 60_000) + 1),
  };
}

// ── Display ───────────────────────────────────────────────────────────────────

/** Status an order with this outcome displays at this age (hours). */
export function statusAt(outcome, ageHours, sim) {
  if (ageHours < sim.confirmationDelayHours) return 'pending';
  if (outcome === 'noResponse' || outcome === 'cancelled') return outcome;
  if (ageHours < sim.deliveryDelayHours) return 'confirmed';
  return outcome;
}

/** Window bounds and bucket starts for a window ending at `now`. */
export function windowBuckets(windowKey, nowMs) {
  const w = SIM_WINDOWS[windowKey];
  if (!w) return null;
  const step = w.unit === 'hour' ? HOUR_MS : DAY_MS;
  const last = w.unit === 'hour' ? floorHour(nowMs) : floorDay(nowMs);
  const starts = Array.from({ length: w.size }, (_, i) => last - (w.size - 1 - i) * step);
  return { unit: w.unit, step, from: starts[0], starts };
}

/**
 * Stats for one window ending at `nowMs` (now, or the closure of a closed
 * access): orders CREATED in the window, counted by the status they display at
 * that instant, plus per-bucket totals. `rows` are persisted hours; `live` is the
 * current hour so far (or null). `delaysFor(hourStartMs)` returns the display
 * delays of the day the orders were created (a plain object = fixed delays).
 */
export function windowStats(rows, live, nowMs, windowKey, delaysFor) {
  const delays = typeof delaysFor === 'function' ? delaysFor : () => delaysFor;
  const b = windowBuckets(windowKey, nowMs);
  if (!b) return null;
  const byStatus = Object.fromEntries(SIM_STATUSES.map((s) => [s, 0]));
  const totals = new Map(b.starts.map((s) => [s, 0]));
  let total = 0;
  const add = (hourStartMs, counts) => {
    if (hourStartMs < b.from || hourStartMs > nowMs) return;
    const bucket = b.unit === 'hour' ? hourStartMs : floorDay(hourStartMs);
    if (!totals.has(bucket)) return;
    const age = (nowMs - hourStartMs) / HOUR_MS;
    for (const k of SIM_OUTCOMES) {
      const n = Number(counts[k]) || 0;
      if (n) byStatus[statusAt(k, age, delays(hourStartMs))] += n;
    }
    const created = Number(counts.created) || 0;
    totals.set(bucket, totals.get(bucket) + created);
    total += created;
  };
  for (const r of rows) add(new Date(r.hourStart).getTime(), r);
  if (live) add(new Date(live.hourStart).getTime(), live);
  return {
    window: windowKey,
    unit: b.unit,
    from: new Date(b.from).toISOString(),
    to: new Date(nowMs).toISOString(),
    total,
    byStatus,
    buckets: b.starts.map((s) => ({ start: new Date(s).toISOString(), total: totals.get(s) })),
  };
}

/**
 * Most recent SIMULATED orders for the dashboard list, derived from the same
 * deterministic generator as the stored hourly counts (nothing is stored or
 * invented): only orders of hours that are counted — `countedHours` (stored
 * hour starts) or the live hour up to now — are listed, so the list always
 * agrees with the totals. Each order gets a training reference, its current
 * simulated status and one of the brand's selected products (deterministic).
 * Simulated orders carry no amount: the program prices nothing per order.
 */
export function recentSimulatedOrders(seed, { countedHours, nowMs, liveHour = null, sim, products = [], limit = 8 }) {
  // `sim` = a fixed settings object, or a function (dayStartMs) → that day's settings.
  const paramsFor = typeof sim === 'function' ? sim : () => sim;
  const counted = new Set(countedHours);
  const out = [];
  for (let d = 0; d < 2 && out.length < limit * 4; d++) {
    const day = floorDay(nowMs) - d * DAY_MS;
    const dayKey = new Date(day).toISOString().slice(0, 10);
    const daySim = paramsFor(day);
    if (!daySim) continue;
    simulateDay(seed, day, daySim).forEach((o, i) => {
      const at = day + o.hour * HOUR_MS + o.minute * 60_000;
      const hourStart = day + o.hour * HOUR_MS;
      const inLive = liveHour !== null && hourStart === liveHour && at <= nowMs;
      if (at > nowMs || !(counted.has(hourStart) || inLive)) return;
      const h = hashSeed(`${seed}:${dayKey}:${i}`);
      out.push({
        ref: `SIM-${dayKey.slice(5).replace('-', '')}-${h.toString(36).slice(-4).toUpperCase().padStart(4, '0')}`,
        at: new Date(at).toISOString(),
        status: statusAt(o.outcome, (nowMs - at) / HOUR_MS, daySim),
        product: products.length ? products[h % products.length] : null,
      });
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}
