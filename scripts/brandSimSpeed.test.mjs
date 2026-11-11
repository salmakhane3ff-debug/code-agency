#!/usr/bin/env node
/**
 * scripts/brandSimSpeed.test.mjs — PER-BRAND simulation speed ("Create Your Own Brand").
 *   1. Rules (pure): validation + conflicts, effective 24 h range, version selection / append
 *   2. Generator (pure): hourly range + 24 h range over 60 days, several configs and seeds, plus
 *      random valid configs; the maximum holds over EVERY sliding 24 h period, checked order by order
 *      (a period [t − 24 h, t] touches 25 clock hours); determinism; minutes spread; after a change
 *   3. Engine + service (fake DB): independent brands, default brands unchanged, pause one brand,
 *      concurrent runs → no duplicate and the same history, dashboard consistent with stored hours
 *   4. Isolation: only brand tables + the reserved setting are written; routes; reserved setting type
 *
 *   node scripts/brandSimSpeed.test.mjs
 */
import { readFileSync } from "node:fs";
import { BRAND_TERMS_SETTING_ID } from "../src/lib/brandProgram.js";
import { HOUR_MS, DAY_MS, floorHour } from "../src/lib/brandSimulation.js";
import {
  BRAND_SIM_SPEED_SETTING_ID, SPEED_LIMITS, validateSpeedInput, effectiveDayRange, normalizeSpeedConfig, speedVersionAt, appendSpeedVersion,
  speedHourCount, speedHourOrders, prevWindow, speedOrderIndex, requiredDayGap, hourCap,
} from "../src/lib/brandSimSpeed.js";
import { saveBrandConfig } from "../src/lib/services/brandProgramService.js";
import { requestBrandAccess } from "../src/lib/services/brandAccessService.js";
import { materializeAccessSimulation, getAdminSimulationDashboard } from "../src/lib/services/brandSimulationService.js";
import { saveAccessSpeed, getAccessSpeed } from "../src/lib/services/brandSimSpeedService.js";
import { adminBrandHandlers } from "../src/lib/brandRouteHandlers.js";
import { makeBrandFakeDb, BRAND_MODELS, SHARED_MODELS } from "./lib/brandFakeDb.mjs";
import { payAndAccept } from "./lib/brandProofKit.mjs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Test values only — not product defaults. */
const SIM = { enabled: true, startDelayHours: 0, dailyVolumeMin: 8, dailyVolumeMax: 20, confirmationDelayHours: 2, deliveryDelayHours: 48,
  distribution: { delivered: 50, refused: 10, returned: 5, noResponse: 20, cancelled: 15 } };
const PRICING = { deliveryCost: 40, logisticsCost: 10, vatPercent: 20, productCount: 3, productIds: ["prod-1", "prod-2", "prod-3"],
  percentages: { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 10, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } } };
const CONFIG = { enabled: true, packages: [{ id: "p1", name: "Formation", price: 1000, active: true, features: [], simulatedSellingPrice: 299, ...PRICING }], brandingOptions: [], simulation: SIM,
  catalogProductIds: ["prod-1", "prod-2", "prod-3"] };
const PRODUCTS = ["prod-1", "prod-2", "prod-3"].map((id) => ({ id, title: `Produit ${id}` }));
const TERMS = { draft: { text: "T" }, published: { version: 1, text: "T", publishedAt: "2026-10-01T00:00:00Z" } };
const EX = { hourMin: 2, hourMax: 5, dayMin: 30, dayMax: 60 }; // the user's example values
const T0 = new Date("2026-11-01T08:20:00Z");

/** Three brands (a1, a2, a3) activated at `activateAt`; config saved a day before. */
async function threeBrands({ activateAt = T0 } = {}) {
  const affs = ["a1", "a2", "a3"].map((id) => ({ id, username: `u-${id}` }));
  const db = makeBrandFakeDb({ strict: true, affiliates: affs, products: PRODUCTS, settings: { [BRAND_TERMS_SETTING_ID]: TERMS } });
  await saveBrandConfig(CONFIG, { db, actorId: "admin-1", now: new Date(activateAt.getTime() - DAY_MS) });
  const ids = [];
  for (const [i, a] of affs.entries()) {
    const acc = await requestBrandAccess(a.id, { packageId: "p1", brandName: `Marque ${i + 1}`, termsVersion: 1, acceptTerms: true, clientRequestId: `req-0000000${i + 1}` }, { db, now: activateAt });
    await payAndAccept(db, a.id, acc.id, { now: activateAt });
    ids.push(acc.id);
  }
  return { db, ids };
}
const rowsOf = (db, id) => db._tables.brandSimHour.filter((r) => r.accessId === id).map((r) => ({ h: new Date(r.hourStart).getTime(), c: r.created }))
  .sort((a, b) => a.h - b.h);
/** Rolling sums of a stored history (missing hours = 0): [{ end, sum, sum25, full }] — sum = 24 clock hours
 *  ending at `end`, sum25 = the 25 clock hours ending at `end`, full = 24 stored hours. */
function rolling(rows, from, to) {
  const m = new Map(rows.map((r) => [r.h, r.c]));
  const out = [];
  for (let end = from; end < to; end += HOUR_MS) {
    let sum = 0, present = 0;
    for (let h = end - 23 * HOUR_MS; h <= end; h += HOUR_MS) if (m.has(h)) { present++; sum += m.get(h); }
    out.push({ end, sum, sum25: sum + (m.get(end - 24 * HOUR_MS) || 0), full: present === 24 });
  }
  return out;
}
/** Largest number of orders in any sliding period [t − 24 h, t] (both bounds inclusive, as the dashboard counts). */
function maxSliding24(times) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0, i = 0;
  for (let j = 0; j < t.length; j++) {
    while (t[i] < t[j] - DAY_MS) i++;
    let k = j; while (k + 1 < t.length && t[k + 1] === t[j]) k++; // every order at the same instant counts
    best = Math.max(best, k - i + 1);
  }
  return best;
}
/** Simulate `hours` hours of one brand under `L` (pure generator); optional `gap` = [fromIndex, toIndex) with no hour. */
function runPure(seed, L, hours, { t0 = Date.UTC(2026, 10, 1, 7), gap = null } = {}) {
  const counts = new Map();
  const times = [];
  const log = [];
  for (let i = 0; i < hours; i++) {
    if (gap && i >= gap[0] && i < gap[1]) continue;
    const h = t0 + i * HOUR_MS;
    const w = prevWindow(counts, h);
    const c = speedHourCount(seed, h, L, w);
    counts.set(h, c);
    log.push({ i, h, c, w });
    for (const o of speedHourOrders(seed, h, c, SIM.distribution)) times.push(o.at);
  }
  return { counts, times, log };
}

// ── 1. Rules ──────────────────────────────────────────────────────────────────
console.log("\n1. Validation, effective range, versions");
{
  const v = (o) => validateSpeedInput({ enabled: true, ...o });
  ok("the example values are valid", v(EX).ok && JSON.stringify(v(EX).value.limits) === JSON.stringify(EX));
  ok("effective 24 h range = [max(dayMin, 24·hourMin), min(dayMax, 24·hourMax)] (example → 48–60)",
    JSON.stringify(effectiveDayRange(EX)) === '{"min":48,"max":60}' && JSON.stringify(effectiveDayRange({ hourMin: 0, hourMax: 3, dayMin: 10, dayMax: 100 })) === '{"min":10,"max":72}');
  ok("hourly min > max refused (HOUR_RANGE)", v({ ...EX, hourMin: 6 }).errors.hourMin === "HOUR_RANGE");
  ok("24 h min > max refused (DAY_RANGE)", v({ ...EX, dayMin: 70 }).errors.dayMin === "DAY_RANGE");
  ok("24 × hourly min above the 24 h max refused (HOUR_MIN_OVER_DAY_MAX)", v({ hourMin: 3, hourMax: 5, dayMin: 30, dayMax: 60 }).errors.limits === "HOUR_MIN_OVER_DAY_MAX");
  ok("24 × hourly max below the 24 h min refused (HOUR_MAX_UNDER_DAY_MIN)", v({ hourMin: 0, hourMax: 1, dayMin: 30, dayMax: 60 }).errors.limits === "HOUR_MAX_UNDER_DAY_MIN");
  // A sliding 24 h period touches 25 clock hours: with exactly 3 orders every hour (3/3/72/72) it could show 75 > 72.
  ok("effective 24 h range too narrow to guarantee the maximum over every 24 h period refused (DAY_RANGE_TOO_NARROW)",
    v({ hourMin: 3, hourMax: 3, dayMin: 72, dayMax: 72 }).errors.limits === "DAY_RANGE_TOO_NARROW"
    && v({ hourMin: 2, hourMax: 5, dayMin: 30, dayMax: 48 }).errors.limits === "DAY_RANGE_TOO_NARROW"  // effective 48–48
    && v({ hourMin: 0, hourMax: 10, dayMin: 100, dayMax: 104 }).errors.limits === "DAY_RANGE_TOO_NARROW"); // gap 4 < ⌈100/24⌉ = 5
  ok("…the tightest accepted ranges (gap = min(hourMax, ⌈effective min / 24⌉))", v({ hourMin: 2, hourMax: 3, dayMin: 48, dayMax: 50 }).ok
    && v({ hourMin: 0, hourMax: 10, dayMin: 100, dayMax: 105 }).ok && requiredDayGap(EX) === 2 && hourCap(EX) === 5 && hourCap({ hourMin: 2, hourMax: 3, dayMin: 48, dayMax: 50 }) === 2);
  ok("the user's example values and the second example stay valid", v(EX).ok && v({ hourMin: 0, hourMax: 3, dayMin: 10, dayMax: 20 }).ok);
  ok("non-integers, negatives, empty and out-of-range values refused field by field",
    ["1.5", -1, "", "abc", null].every((x) => v({ ...EX, hourMax: x }).errors.hourMax === "INVALID_NUMBER")
    && v({ ...EX, hourMax: SPEED_LIMITS.MAX_PER_HOUR + 1 }).errors.hourMax === "INVALID_NUMBER" && v({ ...EX, dayMax: SPEED_LIMITS.MAX_PER_DAY + 1 }).errors.dayMax === "INVALID_NUMBER"
    && v({ ...EX, hourMax: 0, hourMin: 0 }).errors.hourMax === "INVALID_NUMBER" && v({ ...EX, dayMax: 0, dayMin: 0 }).errors.dayMax === "INVALID_NUMBER");
  ok("numeric strings accepted (form values)", v({ hourMin: "2", hourMax: "5", dayMin: "30", dayMax: "60" }).ok);
  ok("enabled must be a boolean", validateSpeedInput({ ...EX }).errors.enabled === "INVALID_BOOLEAN");
  ok("custom: false → global behaviour (limits null), pause allowed", JSON.stringify(validateSpeedInput({ enabled: false, custom: false }).value) === '{"enabled":false,"limits":null}');

  const now = Date.parse("2026-11-01T08:20:00Z");
  const v1 = appendSpeedVersion([], { enabled: true, limits: EX }, { nowMs: now, actorId: "admin-1" });
  ok("a save takes effect at the NEXT full hour", v1[0].effectiveFrom === "2026-11-01T09:00:00.000Z" && v1[0].savedBy === "admin-1");
  const v2 = appendSpeedVersion(v1, { enabled: false, limits: null }, { nowMs: now + 10 * 60_000 });
  ok("a version not yet in force is replaced (no hour used it); in-force ones are never changed",
    v2.length === 1 && v2[0].enabled === false);
  const v3 = appendSpeedVersion(v1, { enabled: false, limits: null }, { nowMs: now + 2 * HOUR_MS });
  ok("after it took effect, a new save appends", v3.length === 2 && v3[0].limits.hourMax === 5 && v3[1].effectiveFrom === "2026-11-01T11:00:00.000Z");
  ok("version at an hour: none before, then the right one", speedVersionAt(v3, Date.parse("2026-11-01T08:00:00Z")) === null
    && speedVersionAt(v3, Date.parse("2026-11-01T10:00:00Z")).limits.hourMax === 5 && speedVersionAt(v3, Date.parse("2026-11-01T11:00:00Z")).enabled === false);
  const norm = normalizeSpeedConfig({ accesses: { x: [{ effectiveFrom: "2026-11-01T09:00:00Z", enabled: true, limits: { hourMin: 9, hourMax: 1, dayMin: 0, dayMax: 5 } }], y: "bad" } });
  ok("stored garbage is normalized (inconsistent limits → null, invalid entries dropped)", norm.accesses.x[0].limits === null && !("y" in norm.accesses));
  const legacy = normalizeSpeedConfig({ accesses: { x: [{ effectiveFrom: "2026-11-01T09:00:00Z", enabled: true, limits: { hourMin: 3, hourMax: 3, dayMin: 72, dayMax: 72 } }] } });
  ok("a version stored before the gap rule keeps its limits (history never re-read differently)", legacy.accesses.x[0].limits?.dayMax === 72);
  ok("reference positions of per-hour orders are unique and never collide with the daily generator's (0–999)",
    speedOrderIndex(0, 0) === 1000 && speedOrderIndex(23, SPEED_LIMITS.MAX_PER_HOUR - 1) < 10000 && speedOrderIndex(1, 0) > speedOrderIndex(0, SPEED_LIMITS.MAX_PER_HOUR - 1));
}

// ── 2. Generator ─────────────────────────────────────────────────────────────
console.log("\n2. Hourly + rolling 24 h limits (pure generator)");
{
  const configs = [EX, { hourMin: 0, hourMax: 3, dayMin: 10, dayMax: 20 }, { hourMin: 1, hourMax: 10, dayMin: 100, dayMax: 120 }, { hourMin: 0, hourMax: 1, dayMin: 0, dayMax: 5 },
    { hourMin: 2, hourMax: 3, dayMin: 48, dayMax: 50 }, { hourMin: 0, hourMax: 300, dayMin: 900, dayMax: 1000 }];
  /** All limits over one run: hourly range, 24 h blocks ≥ min (full ones), 25 clock hours ≤ max, sliding 24 h ≤ max. */
  const checkRun = (L, run, warm = 23) => {
    const eff = effectiveDayRange(L);
    let okHour = true, okMax = true, okMin = true, full = 0;
    for (const { i, c, w } of run.log) {
      if (c < L.hourMin || c > L.hourMax) okHour = false;
      if (w.sum + c > eff.max || w.sum24 + c > eff.max) okMax = false;
      if (i >= warm && w.present === 23) { full++; if (w.sum + c < eff.min) okMin = false; }
    }
    const sliding = maxSliding24(run.times);
    return { okHour, okMax, okMin, full, sliding, okSliding: sliding <= eff.max, eff };
  };
  for (const L of configs) {
    const days = L.hourMax >= 100 ? 20 : 60;
    let all = true, full = 0, worst = 0;
    for (const seed of ["acc-a", "acc-b", "acc-c"]) {
      const r = checkRun(L, runPure(seed, L, 24 * days));
      all &&= r.okHour && r.okMax && r.okMin && r.okSliding; full += r.full; worst = Math.max(worst, r.sliding);
    }
    const eff = effectiveDayRange(L);
    ok(`${JSON.stringify(L)}: every hour in [${L.hourMin}, ${L.hourMax}], every 24 h block ≥ ${eff.min} once a full day ran, and EVERY sliding 24 h period ≤ ${eff.max} (worst ${worst}) — ${days} days × 3 brands`,
      all && full === 3 * (24 * days - 23));
  }
  // Random valid configurations (deterministic PRNG): the guarantees hold for any accepted input.
  {
    let x = 12345; const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
    let tried = 0, failures = [];
    while (tried < 60) {
      const hourMax = 1 + rnd(12), hourMin = rnd(hourMax + 1), dayMax = 1 + rnd(24 * hourMax + 20), dayMin = rnd(dayMax + 1);
      const L = { hourMin, hourMax, dayMin, dayMax };
      if (!validateSpeedInput({ enabled: true, ...L }).ok) continue;
      tried++;
      const r = checkRun(L, runPure(`rand-${tried}`, L, 24 * 12));
      if (!(r.okHour && r.okMax && r.okMin && r.okSliding)) failures.push({ L, ...r });
    }
    ok("60 random accepted configurations × 12 days: hourly range, 24 h minimum, maximum over every sliding 24 h period", failures.length === 0, JSON.stringify(failures.slice(0, 2)));
  }
  // After a pause (no hour for 10 h) the maximum still holds over every sliding period; the minimum is back once a full day ran.
  {
    const r = checkRun(EX, runPure("gap", EX, 24 * 10, { gap: [100, 110] }), 110 + 23);
    ok("after a 10-hour pause: maximum over every sliding 24 h period kept, hourly range kept, 24 h minimum back after a full day",
      r.okHour && r.okMax && r.okSliding && r.okMin, JSON.stringify(r));
  }
  const h = Date.UTC(2026, 10, 3, 14);
  const W = (sum, sum24 = sum) => ({ sum, present: 23, sum24, present24: 24 });
  ok("deterministic: same brand + hour + history → same count and orders", speedHourCount("s", h, EX, W(40, 43)) === speedHourCount("s", h, EX, W(40, 43))
    && JSON.stringify(speedHourOrders("s", h, 4, SIM.distribution)) === JSON.stringify(speedHourOrders("s", h, 4, SIM.distribution)));
  const big = speedHourOrders("s", h, 200, SIM.distribution);
  ok("orders spread over the hour (not all at once) and sorted by time; outcomes follow the distribution",
    new Set(big.map((o) => o.at)).size > 40 && big.every((o, i) => i === 0 || big[i - 1].at <= o.at) && big.every((o) => o.at >= h && o.at < h + HOUR_MS)
    && big.filter((o) => o.outcome === "delivered").length > 70);
  ok("references unique within the hour", new Set(big.map((o) => o.ref)).size === big.length);
  // After a change to LOWER limits, the previous hours may already be high: the maximum still wins.
  ok("never above the 24 h maximum, even right after a change (history already high → 0)", speedHourCount("s", h, EX, W(60)) === 0 && speedHourCount("s", h, EX, W(58)) === 2);
  ok("the hour 24 hours earlier counts too (a sliding 24 h period touches 25 clock hours)", speedHourCount("s", h, EX, W(50, 58)) === 2 && speedHourCount("s", h, EX, W(50, 60)) === 0);
}

// ── 3. Engine + service ──────────────────────────────────────────────────────
console.log("\n3. Independent brands, default brands unchanged, pause, concurrency");
{
  const { db, ids: [A, B, C] } = await threeBrands();
  const { db: ref, ids: [, , Cref] } = await threeBrands(); // same brands, no speed setting at all
  const saveAt = new Date(T0.getTime() + 30 * 60_000); // 08:50 → in force from 09:00
  const a = await saveAccessSpeed(A, { enabled: true, custom: true, ...EX }, { db, now: saveAt, actorId: "admin-1" });
  const b = await saveAccessSpeed(B, { enabled: true, custom: true, hourMin: 0, hourMax: 3, dayMin: 10, dayMax: 20 }, { db, now: saveAt, actorId: "admin-1" });
  ok("each brand gets its own version, effective at the next full hour", a.pending?.effectiveFrom === "2026-11-01T09:00:00.000Z" && a.pending.limits.hourMax === 5
    && b.pending.limits.hourMax === 3 && a.current === null);
  ok("save audited (append-only log) with the admin actor", db._tables.brandAuditLog.filter((r) => r.action === "SIM_SPEED_UPDATED").length === 2
    && db._tables.brandAuditLog.find((r) => r.action === "SIM_SPEED_UPDATED").actorId === "admin-1");

  const end = new Date(T0.getTime() + 4 * DAY_MS);
  const acc = (id) => db._tables.brandAccess.find((x) => x.id === id);
  for (const id of [A, B, C]) await materializeAccessSimulation(acc(id), { db, now: end });
  await materializeAccessSimulation(ref._tables.brandAccess.find((x) => x.id === Cref), { db: ref, now: end });
  const effA = Date.parse("2026-11-01T09:00:00Z");
  const rowsA = rowsOf(db, A), rowsB = rowsOf(db, B), rowsC = rowsOf(db, C);
  const afterA = rowsA.filter((r) => r.h >= effA);
  ok("brand A: every hour after its change within 2–5", afterA.length > 80 && afterA.every((r) => r.c >= 2 && r.c <= 5), JSON.stringify(afterA.slice(0, 6)));
  const winA = rolling(rowsA, effA + 23 * HOUR_MS, floorHour(end.getTime()));
  ok("brand A: every 24 h block ≤ 60 and ≥ 48 once a full day ran under its limits; every 25 clock hours ≤ 60", winA.every((w) => w.sum <= 60 && w.sum >= 48)
    && winA.every((w) => w.end - 24 * HOUR_MS < effA || w.sum25 <= 60), JSON.stringify(winA.map((w) => w.sum).slice(0, 10)));
  const afterB = rowsB.filter((r) => r.h >= effA);
  const winB = rolling(rowsB, effA + 23 * HOUR_MS, floorHour(end.getTime()));
  ok("brand B: its own limits (0–3 / h, 10–20 / 24 h) — different from A", afterB.every((r) => r.c >= 0 && r.c <= 3) && winB.every((w) => w.sum >= 10 && w.sum <= 20)
    && winB.every((w) => w.end - 24 * HOUR_MS < effA || w.sum25 <= 20));
  // What the affiliate sees: the dashboard's sliding "24 h" (from now − 24 h to now), read in the middle of hours.
  {
    const reads = [];
    for (let k = 0; k < 12; k++) {
      const t = new Date(effA + 2 * DAY_MS + k * 3 * HOUR_MS + (7 + k * 4) * 60_000);
      const [da, db2] = [await getAdminSimulationDashboard(A, { db, now: t, window: "24h" }), await getAdminSimulationDashboard(B, { db, now: t, window: "24h" })];
      reads.push([da.orders.total, db2.orders.total]);
    }
    ok("dashboard \"24 h\" figure never above the brand's maximum (A ≤ 60, B ≤ 20) at 12 mid-hour instants", reads.every(([a, b]) => a <= 60 && b <= 20), JSON.stringify(reads));
  }
  ok("brand C (never configured) keeps the existing behaviour: identical history to a platform without the feature",
    JSON.stringify(rowsC.map((r) => r.c)) === JSON.stringify(rowsOf(ref, Cref).map((r) => r.c)) && rowsC.length === rowsOf(ref, Cref).length);
  ok("brand A before its change: the existing daily behaviour too", JSON.stringify(rowsA.filter((r) => r.h < effA).map((r) => r.c))
    === JSON.stringify(rowsOf(ref, ref._tables.brandAccess[0].id).filter((r) => r.h < effA).map((r) => r.c)));
  ok("no duplicate hour (primary key) for any brand", [A, B, C].every((id) => new Set(rowsOf(db, id).map((r) => r.h)).size === rowsOf(db, id).length));

  // Pause brand A only.
  const pauseAt = new Date(end.getTime() + 5 * 60_000);
  const p = await saveAccessSpeed(A, { enabled: false, custom: true, ...EX }, { db, now: pauseAt, actorId: "admin-1" });
  const resumeCheck = new Date(end.getTime() + DAY_MS);
  for (const id of [A, B, C]) await materializeAccessSimulation(acc(id), { db, now: resumeCheck });
  const pausedFrom = Date.parse(p.pending.effectiveFrom);
  ok("pausing brand A: no hour generated for A after the pause", !rowsOf(db, A).some((r) => r.h >= pausedFrom));
  ok("…while brands B and C keep running", rowsOf(db, B).some((r) => r.h >= pausedFrom + 12 * HOUR_MS) && rowsOf(db, C).some((r) => r.h >= pausedFrom + 12 * HOUR_MS));
  const dashA = await getAdminSimulationDashboard(A, { db, now: resumeCheck });
  const dashB = await getAdminSimulationDashboard(B, { db, now: resumeCheck });
  ok("dashboard: A shows paused (not running), B running", dashA.running === false && dashB.running === true);

  // Dashboard of B: the order list agrees with the stored hours (+ live hour), references unique, statuses as before.
  const at = resumeCheck.getTime();
  const dash = await getAdminSimulationDashboard(B, { db, now: resumeCheck, window: "24h" });
  const stored = rowsOf(db, B).filter((r) => r.h >= at - DAY_MS && r.h < floorHour(at)).reduce((s, r) => s + r.c, 0);
  const firstPartial = rowsOf(db, B).find((r) => r.h === floorHour(at - DAY_MS));
  ok("dashboard list = stored orders of the window (+ live hour so far)", dash.orders.total >= stored - (firstPartial?.c || 0) && dash.orders.total <= stored + 3,
    `${dash.orders.total} vs ${stored}`);
  ok("simulated order references unique on the dashboard", new Set(dash.orders.items.map((o) => o.ref)).size === dash.orders.items.length);
  const seven = await getAdminSimulationDashboard(B, { db, now: resumeCheck, window: "7d" });
  ok("7-day view (Morocco calendar days) still works with per-brand speed", seven.stats.buckets.length === 7);
}

console.log("\n3b. Concurrent runs: no duplicate, same history, limits respected");
{
  const { db, ids: [A] } = await threeBrands();
  const { db: seq, ids: [Aseq] } = await threeBrands();
  await saveAccessSpeed(A, { enabled: true, custom: true, ...EX }, { db, now: T0 });
  await saveAccessSpeed(Aseq, { enabled: true, custom: true, ...EX }, { db: seq, now: T0 });
  const end = new Date(T0.getTime() + 3 * DAY_MS);
  const acc = db._tables.brandAccess.find((x) => x.id === A);
  await Promise.all([
    materializeAccessSimulation(acc, { db, now: end, batchDays: 1 }),
    materializeAccessSimulation(acc, { db, now: end, batchDays: 2 }),
    getAdminSimulationDashboard(A, { db, now: end }),
    materializeAccessSimulation(acc, { db, now: end }),
  ]);
  await materializeAccessSimulation(seq._tables.brandAccess.find((x) => x.id === Aseq), { db: seq, now: end });
  const r = rowsOf(db, A);
  ok("4 concurrent generations → each hour once", new Set(r.map((x) => x.h)).size === r.length);
  ok("…and exactly the history of a single sequential run", JSON.stringify(r.map((x) => x.c)) === JSON.stringify(rowsOf(seq, Aseq).map((x) => x.c)));
  const eff = Date.parse("2026-11-01T09:00:00Z");
  ok("…with every 24 h block and every 25 clock hours ≤ 60", rolling(r, eff, floorHour(end.getTime())).every((w) => w.sum <= 60 && (w.end - 24 * HOUR_MS < eff || w.sum25 <= 60)));
}

console.log("\n3c. Admin rules: conflicts refused, closed brand not editable, global reset");
{
  const { db, ids: [A] } = await threeBrands();
  const bad = await rejects(saveAccessSpeed(A, { enabled: true, custom: true, hourMin: 3, hourMax: 5, dayMin: 30, dayMax: 60 }, { db, now: T0 }));
  ok("conflicting limits refused with the explicit code, nothing saved", bad?.code === "INVALID_INPUT" && bad.errors.limits === "HOUR_MIN_OVER_DAY_MAX"
    && !db._tables.setting.some((s) => s.id === BRAND_SIM_SPEED_SETTING_ID));
  ok("unknown brand → ACCESS_NOT_FOUND", (await rejects(saveAccessSpeed("nope", { enabled: true, custom: false }, { db, now: T0 })))?.code === "ACCESS_NOT_FOUND");
  db._tables.brandAccess[0].status = "CLOSED";
  ok("closed brand → ACCESS_NOT_EDITABLE", (await rejects(saveAccessSpeed(A, { enabled: true, custom: false }, { db, now: T0 })))?.code === "ACCESS_NOT_EDITABLE");
  db._tables.brandAccess[0].status = "ACTIVE";
  await saveAccessSpeed(A, { enabled: true, custom: true, ...EX }, { db, now: T0 });
  const back = await saveAccessSpeed(A, { enabled: true, custom: false }, { db, now: new Date(T0.getTime() + 3 * HOUR_MS) });
  ok("back to the global settings: a new version with limits null; history kept", back.history.length === 2 && back.pending.limits === null && back.history[0].limits.hourMax === 5);
  const view = await getAccessSpeed(A, { db, now: new Date(T0.getTime() + 5 * HOUR_MS) });
  ok("view: current version, global defaults shown for reference", view.current.limits === null && view.global.dailyVolumeMin === 8 && view.global.dailyVolumeMax === 20 && view.editable === true);
}

// ── 4. Isolation, routes ─────────────────────────────────────────────────────
console.log("\n4. Financial isolation, routes, reserved setting");
{
  const { db, ids: [A] } = await threeBrands();
  const before = db._stats.log.length;
  await saveAccessSpeed(A, { enabled: true, custom: true, ...EX }, { db, now: T0 });
  await materializeAccessSimulation(db._tables.brandAccess[0], { db, now: new Date(T0.getTime() + 2 * DAY_MS) });
  await getAdminSimulationDashboard(A, { db, now: new Date(T0.getTime() + 2 * DAY_MS) });
  const touched = new Set(db._stats.log.slice(before).map((l) => l.split(".")[0]).filter((m) => !m.startsWith("$")));
  ok("only brand tables touched (strict fake DB throws on orders, wallets, payouts, commissions, rewards)", [...touched].every((m) => BRAND_MODELS.includes(m) || SHARED_MODELS.includes(m)), [...touched].join());
  ok("only the reserved speed setting is written", db._tables.setting.filter((s) => s.id === BRAND_SIM_SPEED_SETTING_ID).length === 1);
  const svc = read("../src/lib/services/brandSimSpeedService.js") + read("../src/lib/brandSimSpeed.js");
  ok("no wallet / commission / payout / reward / order code in the speed modules", !/wallet|commission|payout|reward|affiliateOrder|\.order\.|balance/i.test(svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));

  const h = adminBrandHandlers({ db, now: () => new Date(T0.getTime() + HOUR_MS) });
  const ctx = { params: Promise.resolve({ id: A }) };
  const put = (body) => new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const g = await h.getAccessSpeed(new Request("http://x"), ctx, { userId: "admin-1" });
  ok("GET route → 200 with the brand's speed", g.status === 200 && (await g.json()).accessId === A);
  const okPut = await h.saveAccessSpeed(put({ enabled: true, custom: true, hourMin: 1, hourMax: 4, dayMin: 20, dayMax: 40 }), ctx, { userId: "admin-9" });
  ok("PUT route → 200, actor from the session", okPut.status === 200 && db._tables.brandAuditLog.some((r) => r.action === "SIM_SPEED_UPDATED" && r.actorId === "admin-9"));
  const badPut = await h.saveAccessSpeed(put({ enabled: true, custom: true, hourMin: 5, hourMax: 1, dayMin: 0, dayMax: 10 }), ctx, { userId: "admin-9" });
  const badBody = await badPut.json();
  ok("PUT conflict → 400 INVALID_INPUT with the field codes", badPut.status === 400 && badBody.code === "INVALID_INPUT" && badBody.errors?.hourMin === "HOUR_RANGE");
  const route = read("../src/app/api/admin/brand/accesses/[id]/simulation-speed/route.js");
  ok("route is admin-only (withAdminAuth on GET and PUT)", /export const GET = withAdminAuth\(h\.getAccessSpeed\)/.test(route) && /export const PUT = withAdminAuth\(h\.saveAccessSpeed\)/.test(route));
  ok("the speed setting is reserved (the generic settings API cannot write it)", /BRAND_SIM_SPEED_SETTING_ID\]\);/.test(read("../src/lib/controllers/settingsController.js")));
  ok("existing timezone rules untouched (Casablanca day buckets)", /export const SIM_TIMEZONE = 'Africa\/Casablanca';/.test(read("../src/lib/brandSimulation.js")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
