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
 *   delivered / refused / returned        → "confirmed" for the first half of the
 *                                            time between the two delays,
 *                                            "inDelivery" for the second half,
 *                                            then the final outcome
 *
 * Nothing here knows about real orders, products, customers, money or wallets.
 * The only amounts are TRAINING figures (simOrderMoney: the pack's simulated
 * selling price minus fixed simulated expenses): computed on read, never stored,
 * never credited, never connected to a wallet or a commission.
 *
 * Day buckets (7 d / 30 d) follow Africa/Casablanca calendar days, computed
 * here (casablancaMidnight) so they stay right on Morocco's clock-change days;
 * generation itself stays seeded per UTC day (internal, unchanged).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SIM_OUTCOMES, SIM_STATUSES, SIM_ORDER_EXPENSES, SIM_OPEN_STATUSES } from './brandProgram.js';

/** Display / bucketing timezone of the simulator (same as the rest of the platform). */
export const SIM_TIMEZONE = 'Africa/Casablanca';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Dashboard windows (bounds: see windowBuckets): 24 h = exactly [asOf − 24 h, asOf], split into 24
 * one-hour chart buckets starting at asOf − 24 h; 7 / 30 d = Casablanca calendar days, today included.
 */
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
  if (ageHours < sim.deliveryDelayHours) {
    const half = sim.confirmationDelayHours + (sim.deliveryDelayHours - sim.confirmationDelayHours) / 2;
    return ageHours < half ? 'confirmed' : 'inDelivery';
  }
  return outcome;
}

// ── Casablanca calendar days ──────────────────────────────────────────────────

const CASA_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SIM_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** Casablanca wall-clock parts of an instant: { year, month, day, hour, minute }. */
function casaParts(ms) {
  const p = {};
  for (const { type, value } of CASA_FMT.formatToParts(new Date(ms))) if (type !== 'literal') p[type] = Number(value);
  if (p.hour === 24) p.hour = 0;
  return p;
}

/** How far Casablanca wall-clock time is ahead of UTC at `ms` (ms; 0 or 1 h, changes around Ramadan). */
function casaOffset(ms) {
  const p = casaParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/**
 * UTC instant of Casablanca local midnight that starts the calendar day y-m-d.
 * The offset is read AROUND that midnight (a few hours either side), never at
 * noon, so a day whose clock changes later that night keeps its true midnight.
 * Each offset seen near midnight gives a candidate; the earliest candidate whose
 * local time really is y-m-d 00:00 wins. Should a midnight ever not exist (a
 * clock change exactly at 00:00), the first instant of that local date is used.
 */
export function casablancaMidnight(y, m, d) {
  const utcMid = Date.UTC(y, m - 1, d);
  const offsets = new Set([-14, -3, -1, 1, 3, 14].map((h) => casaOffset(utcMid + h * HOUR_MS)));
  const ok = [...offsets].map((o) => utcMid - o).filter((t) => {
    const p = casaParts(t);
    return p.year === y && p.month === m && p.day === d && p.hour === 0 && p.minute === 0;
  });
  if (ok.length) return Math.min(...ok);
  for (let t = utcMid - 14 * HOUR_MS; t < utcMid + 14 * HOUR_MS; t += 15 * 60_000) {
    const p = casaParts(t);
    if (p.year === y && p.month === m && p.day === d) return t;
  }
  return utcMid; // unreachable for a real IANA zone
}

/** The last `count` Casablanca day starts, oldest → newest (newest = the day containing `nowMs`); strictly increasing. */
export function casablancaDayStarts(nowMs, count) {
  const { year, month, day } = casaParts(nowMs);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const c = new Date(Date.UTC(year, month - 1, day - i)); // calendar arithmetic only (no offsets)
    out.push(casablancaMidnight(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate()));
  }
  return out;
}

/**
 * Window bounds and bucket starts for a window ending at `now` (the asOf instant):
 *   24 h  → exactly [now − 24 h, now]: 24 one-hour buckets starting at now − 24 h
 *           (bucket i = [from + i h, from + (i + 1) h), the last one ends at now);
 *   7 / 30 d → the last 7 / 30 Casablanca days, today included (daily buckets
 *           starting at Casablanca midnight), i.e. [first midnight, now].
 * Boundary rule, the same everywhere (order list, counts, chart, money, balance
 * split): an order belongs to the window iff from ≤ order time ≤ now — the lower
 * bound is INCLUSIVE, the upper bound (now) is INCLUSIVE.
 */
export function windowBuckets(windowKey, nowMs) {
  const w = SIM_WINDOWS[windowKey];
  if (!w) return null;
  const starts = w.unit === 'hour'
    ? Array.from({ length: w.size }, (_, i) => nowMs - (w.size - i) * HOUR_MS)
    : casablancaDayStarts(nowMs, w.size);
  return { unit: w.unit, step: w.unit === 'hour' ? HOUR_MS : DAY_MS, from: starts[0], starts };
}

/** Start of the bucket containing `t` (the last start ≤ t), or null before the window. */
export function bucketOf(starts, t) {
  let found = null;
  for (const s of starts) { if (s <= t) found = s; else break; }
  return found;
}

/**
 * Stats for one window ending at `nowMs` (now, or the closure of a closed
 * access): orders CREATED in the window, counted by the status they display at
 * that instant, plus per-bucket totals and per-bucket status counts (the same
 * count, split by bucket: each status's buckets add up to its window count).
 * `rows` are persisted hours; `live` is the
 * current hour so far (or null). `delaysFor(hourStartMs)` returns the display
 * delays of the day the orders were created (a plain object = fixed delays).
 */
export function windowStats(rows, live, nowMs, windowKey, delaysFor) {
  const delays = typeof delaysFor === 'function' ? delaysFor : () => delaysFor;
  const b = windowBuckets(windowKey, nowMs);
  if (!b) return null;
  const byStatus = Object.fromEntries(SIM_STATUSES.map((s) => [s, 0]));
  const totals = new Map(b.starts.map((s) => [s, 0]));
  const bucketStatus = new Map(b.starts.map((s) => [s, Object.fromEntries(SIM_STATUSES.map((x) => [x, 0]))]));
  let total = 0;
  const add = (hourStartMs, counts) => {
    if (hourStartMs < b.from || hourStartMs > nowMs) return;
    const bucket = bucketOf(b.starts, hourStartMs); // hour granularity: an hour lands in the bucket containing its start
    if (!totals.has(bucket)) return;
    const age = (nowMs - hourStartMs) / HOUR_MS;
    for (const k of SIM_OUTCOMES) {
      const n = Number(counts[k]) || 0;
      if (!n) continue;
      const status = statusAt(k, age, delays(hourStartMs));
      byStatus[status] += n;
      bucketStatus.get(bucket)[status] += n;
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
    buckets: b.starts.map((s) => ({ start: new Date(s).toISOString(), total: totals.get(s), byStatus: bucketStatus.get(s) })),
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
    const daySim = paramsFor(day);
    if (!daySim) continue;
    simulateDay(seed, day, daySim).forEach((o, i) => {
      const at = day + o.hour * HOUR_MS + o.minute * 60_000;
      const hourStart = day + o.hour * HOUR_MS;
      const inLive = liveHour !== null && hourStart === liveHour && at <= nowMs;
      if (at > nowMs || !(counted.has(hourStart) || inLive)) return;
      const { ref, hash: h } = simulatedOrderRef(seed, day, i);
      out.push({
        ref,
        at: new Date(at).toISOString(),
        status: statusAt(o.outcome, (nowMs - at) / HOUR_MS, daySim),
        product: products.length ? products[h % products.length] : null,
      });
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

// ── Order-level dataset (single source of truth for the dashboard) ───────────

/**
 * Calls `fn(order)` for every COUNTED simulated order created in [fromMs, nowMs]:
 * orders of stored hours (`countedHours`) and of the live hour up to now — the
 * very orders the stored hourly counts were built from (same seed, same day
 * settings), so nothing is added or invented. `order` = { at, hourStart, outcome,
 * status (as displayed at nowMs), day, index }.
 */
export function forEachSimulatedOrder(seed, { fromMs, nowMs, countedHours, liveHour = null, sim }, fn) {
  const paramsFor = typeof sim === 'function' ? sim : () => sim;
  const counted = new Set(countedHours);
  const days = new Set([...counted].filter((h) => h >= floorHour(fromMs) && h <= nowMs).map(floorDay));
  if (liveHour !== null && liveHour >= floorHour(fromMs) && liveHour <= nowMs) days.add(floorDay(liveHour));
  for (const day of [...days].sort((a, b) => a - b)) {
    const daySim = paramsFor(day);
    if (!daySim) continue;
    simulateDay(seed, day, daySim).forEach((o, index) => {
      const hourStart = day + o.hour * HOUR_MS;
      const at = hourStart + o.minute * 60_000;
      if (at < fromMs || at > nowMs) return;
      if (!(counted.has(hourStart) || (liveHour !== null && hourStart === liveHour))) return;
      fn({ at, hourStart, outcome: o.outcome, status: statusAt(o.outcome, (nowMs - at) / HOUR_MS, daySim), day, index });
    });
  }
}

/**
 * Training reference of one simulated order: SIM-<brand tag>-<YYMMDD>-<NNNN>.
 * Unique BY CONSTRUCTION within a brand: the generation day (year included)
 * plus the order's 1-based position in that day's deterministic list (a day
 * holds at most MAX_DAILY_VOLUME orders) — no hash is involved in that part.
 * The 4-character brand tag (from the access id) only tells different brands'
 * lists apart. Same seed, day and position → same reference on every refresh
 * and page. `hash` (unchanged) only picks the order's product.
 */
export function simulatedOrderRef(seed, dayMs, index) {
  const dayKey = new Date(floorDay(dayMs)).toISOString().slice(0, 10);
  const tag = hashSeed(String(seed)).toString(36).toUpperCase().padStart(4, '0').slice(-4);
  return {
    ref: `SIM-${tag}-${dayKey.slice(2).replace(/-/g, '')}-${String(index + 1).padStart(4, '0')}`,
    hash: hashSeed(`${seed}:${dayKey}:${index}`),
  };
}

const cents = (x) => Math.round(x * 100);

/**
 * SIMULATED money of one training order, in MAD. `price` = the pack's simulated
 * selling price from the request snapshot; no valid price → null (nothing is
 * computed). Expenses are the fixed SIM_ORDER_EXPENSES. Net may be negative.
 *   delivered                     → realized  (counts in revenue / profit / balance)
 *   pending, confirmed, inDelivery → expected  (shown on the card only, never totalled)
 *   refused, returned, noResponse, cancelled → none (contributes 0)
 */
export function simOrderMoney(status, price) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const e = SIM_ORDER_EXPENSES;
  const totalC = cents(e.delivery) + cents(e.notification) + cents(e.confirmation);
  const kind = status === 'delivered' ? 'realized' : SIM_OPEN_STATUSES.includes(status) ? 'expected' : 'none';
  return {
    price: cents(price) / 100,
    expenses: { delivery: e.delivery, notification: e.notification, confirmation: e.confirmation, total: totalC / 100 },
    net: (cents(price) - totalC) / 100,
    kind,
  };
}

/**
 * Every counted simulated order of [fromMs, nowMs], newest first, each with its
 * reference, displayed status, one of the brand's selected products
 * (deterministic) and its simulated money (null without a price).
 */
export function simulatedOrders(seed, { fromMs, nowMs, countedHours, liveHour = null, sim, products = [], price = null, plan = null }) {
  // Same selection as forEachSimulatedOrder (counted hours + live hour, fromMs ≤ at ≤ nowMs, statusAt at nowMs);
  // the per-day facts (time, position, reference, product hash) come from the memo, status and money are computed here.
  const paramsFor = typeof sim === 'function' ? sim : () => sim;
  const counted = new Set(countedHours);
  const days = new Set([...counted].filter((h) => h >= floorHour(fromMs) && h <= nowMs).map(floorDay));
  if (liveHour !== null && liveHour >= floorHour(fromMs) && liveHour <= nowMs) days.add(floorDay(liveHour));
  const out = [];
  for (const day of [...days].sort((a, b) => a - b)) {
    const daySim = paramsFor(day);
    if (!daySim) continue;
    for (const o of planDayOrders(seed, day, daySim, plan)) {
      if (o.at < fromMs || o.at > nowMs) continue;
      if (!(counted.has(o.hourStart) || (liveHour !== null && o.hourStart === liveHour))) continue;
      const status = statusAt(o.outcome, (nowMs - o.at) / HOUR_MS, daySim);
      // atMs: numeric time for sorting / bucketing (the service strips it from API responses)
      out.push({ ref: o.ref, at: o.iso, atMs: o.at, status, product: products.length ? products[o.hash % products.length] : null, money: simOrderMoney(status, price) });
    }
  }
  return out.sort((a, b) => (a.atMs !== b.atMs ? b.atMs - a.atMs : a.ref < b.ref ? -1 : 1));
}

/**
 * Window statistics computed from the order list itself (the same orders the
 * dashboard lists): total, status counts, per-bucket totals / status counts for
 * the chart, and the simulated revenue / net profit of the DELIVERED orders
 * (null when the pack has no simulated price).
 */
export function ordersStats(orders, nowMs, windowKey, price = null) {
  const b = windowBuckets(windowKey, nowMs);
  if (!b) return null;
  const byStatus = Object.fromEntries(SIM_STATUSES.map((s) => [s, 0]));
  const buckets = new Map(b.starts.map((s) => [s, { total: 0, byStatus: Object.fromEntries(SIM_STATUSES.map((x) => [x, 0])) }]));
  const priced = simOrderMoney('delivered', price) !== null;
  let total = 0, revenueC = 0, profitC = 0;
  for (const o of orders) {
    const t = typeof o.atMs === 'number' ? o.atMs : new Date(o.at).getTime();
    const key = bucketOf(b.starts, t);
    if (key === null || t > nowMs) continue;
    total++;
    byStatus[o.status]++;
    const bk = buckets.get(key);
    bk.total++;
    bk.byStatus[o.status]++;
    if (priced && o.money && o.money.kind === 'realized') { revenueC += cents(o.money.price); profitC += cents(o.money.net); }
  }
  return {
    window: windowKey,
    unit: b.unit,
    from: new Date(b.from).toISOString(),
    to: new Date(nowMs).toISOString(),
    total,
    byStatus,
    buckets: b.starts.map((s) => ({ start: new Date(s).toISOString(), total: buckets.get(s).total, byStatus: buckets.get(s).byStatus })),
    money: priced ? { revenue: revenueC / 100, profit: profitC / 100, delivered: byStatus.delivered } : null,
  };
}

/**
 * SIMULATED balance at `nowMs`: the net of every delivered simulated order since
 * the simulation started (counted hours only). Training figure — never a wallet.
 */
export function simulatedBalance(seed, { nowMs, countedHours, liveHour = null, sim, price }) {
  const unit = simOrderMoney('delivered', price);
  if (!unit) return null;
  let delivered = 0;
  const first = countedHours.reduce((m, h) => (h < m ? h : m), liveHour ?? nowMs);
  forEachSimulatedOrder(seed, { fromMs: first, nowMs, countedHours, liveHour, sim }, (o) => {
    if (o.status === 'delivered') delivered++;
  });
  return { balance: (delivered * cents(unit.net)) / 100, delivered };
}

// ── Performance: memoised day facts + settled-hour delivered counts ──────────
// Neither changes a result: the memo holds only what simulateDay already makes
// deterministic, and settled hours are counted with the exact statusAt rule.

/** Upper bound of orders kept in the day memo (≈ 300 days at the maximum 1,000 orders/day). */
export const SIM_DAY_CACHE_MAX_ORDERS = 300_000;
const dayCache = new Map(); // key → frozen array of order facts (Map order = least recently used first)
let dayCacheOrders = 0;

/**
 * A day's generated orders with their fixed facts — { at, hourStart, outcome, index, ref, hash, iso } —
 * memoised. The key is everything simulateDay depends on: the brand access seed (never shared between
 * brands), the UTC day, the day's volume range and outcome distribution; a settings change gives a new
 * key. Statuses (they depend on "now"), the live-hour cutoff and money are never memoised.
 */
export function simulatedDayOrders(seed, dayMs, sim) {
  const day = floorDay(dayMs);
  const typed = (v) => `${typeof v}:${String(v)}`; // 50, "50", null, undefined and NaN are different inputs to simulateDay
  const key = JSON.stringify([String(seed), day, typed(sim.dailyVolumeMin), typed(sim.dailyVolumeMax), ...SIM_OUTCOMES.map((k) => typed(sim.distribution?.[k]))]);
  const hit = dayCache.get(key);
  if (hit) { dayCache.delete(key); dayCache.set(key, hit); return hit; }
  const list = Object.freeze(simulateDay(seed, day, sim).map((o, index) => {
    const hourStart = day + o.hour * HOUR_MS;
    const at = hourStart + o.minute * 60_000;
    const { ref, hash } = simulatedOrderRef(seed, day, index);
    return Object.freeze({ at, hourStart, outcome: o.outcome, index, ref, hash, iso: new Date(at).toISOString() });
  }));
  dayCache.set(key, list);
  dayCacheOrders += list.length;
  while (dayCacheOrders > SIM_DAY_CACHE_MAX_ORDERS && dayCache.size > 1) {
    const [oldKey, oldList] = dayCache.entries().next().value;
    dayCache.delete(oldKey);
    dayCacheOrders -= oldList.length;
  }
  return list;
}

/**
 * The orders of one UTC day for one brand: the daily generator's, except for hours under the brand's
 * own speed (plan.custom(h)) whose orders come from plan.hourOrders(h, daySim) (brandSimSpeed). No plan
 * (or no custom hour that day) → exactly simulatedDayOrders.
 */
export function planDayOrders(seed, dayMs, daySim, plan) {
  const day = floorDay(dayMs);
  const base = simulatedDayOrders(seed, day, daySim);
  if (!plan) return base;
  const custom = [];
  for (let h = day; h < day + DAY_MS; h += HOUR_MS) if (plan.custom(h)) custom.push(h);
  if (!custom.length) return base;
  const set = new Set(custom);
  const out = base.filter((o) => !set.has(o.hourStart));
  for (const h of custom) out.push(...plan.hourOrders(h, daySim));
  return out.sort((a, b) => a.at - b.at || a.index - b.index);
}

/** Memo size (tests / benchmarks). */
export function simulationCacheStats() { return { days: dayCache.size, orders: dayCacheOrders }; }
/** Empty the memo (tests / benchmarks; never needed for correctness). */
export function clearSimulationCache() { dayCache.clear(); dayCacheOrders = 0; }

/**
 * Delivered simulated orders, as displayed at `nowMs`, among stored COMPLETE hours
 * `rows` ({ hourStart, created, delivered }), counting only orders created before
 * `beforeMs` (the window start: the window's own orders are counted by the list).
 * statusAt shows an order's own outcome once its age ≥ max(confirmation, delivery)
 * delays of its day, so an hour entirely before `beforeMs` whose LAST minute is that
 * old is settled: its delivered count is exactly the stored `delivered` outcome count.
 * Other hours (younger, or straddling `beforeMs`) are counted order by order with
 * statusAt, as the order list does. Days without settings are skipped, like
 * forEachSimulatedOrder.
 */
export function deliveredInRows(seed, { rows, nowMs, sim, beforeMs = Infinity, plan = null }) {
  const paramsFor = typeof sim === 'function' ? sim : () => sim;
  let delivered = 0;
  const young = new Map(); // day → Set(hourStart)
  for (const r of rows) {
    if (!(Number(r.created) > 0)) continue;
    const h = new Date(r.hourStart).getTime();
    const day = floorDay(h);
    const daySim = paramsFor(day);
    if (!daySim) continue;
    const settledAge = Math.max(daySim.confirmationDelayHours ?? 0, daySim.deliveryDelayHours ?? 0);
    if (h + HOUR_MS <= beforeMs && (nowMs - (h + 59 * 60_000)) / HOUR_MS >= settledAge) { delivered += Number(r.delivered) || 0; continue; }
    if (!young.has(day)) young.set(day, new Set());
    young.get(day).add(h);
  }
  for (const [day, hours] of young) {
    const daySim = paramsFor(day);
    for (const o of planDayOrders(seed, day, daySim, plan)) {
      if (hours.has(o.hourStart) && o.at < beforeMs && o.at <= nowMs && statusAt(o.outcome, (nowMs - o.at) / HOUR_MS, daySim) === 'delivered') delivered++;
    }
  }
  return delivered;
}

/**
 * Every stored hour before the returned instant is SETTLED at `anchorMs` and lies
 * entirely before the window start `fromMs`: its last minute is older than
 * `maxDelayHours` (the longest confirmation / delivery delay any settings version
 * ever had), so its delivered orders are exactly its stored `delivered` count.
 */
export function settledHoursBefore(anchorMs, fromMs, maxDelayHours) {
  return Math.min(floorHour(anchorMs - HOUR_MS - (Number(maxDelayHours) || 0) * HOUR_MS), floorHour(fromMs));
}

/** SIMULATED balance from a delivered count (same cents rule as simulatedBalance); null without a valid price. */
export function simulatedBalanceOf(delivered, price) {
  const unit = simOrderMoney('delivered', price);
  return unit ? { balance: (delivered * cents(unit.net)) / 100, delivered } : null;
}

/**
 * Identity of one complete simulated order list (W3 "see all" guard): two 32-bit FNV-style lanes over
 * the header (brand, window, bounds, snapshot price, products) and every order's reference (unique within
 * a brand) and status — money and product follow from those and the header. Change detection only (not a
 * security token: a forged value can only make its own sender's request fail). 16 hex characters.
 */
export function simulatedListId(header, orders) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  const feed = (str) => {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15;
    }
  };
  feed(JSON.stringify(header));
  for (const o of orders) { feed(o.ref); feed('|'); feed(o.status); feed('\n'); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
