#!/usr/bin/env node
/**
 * scripts/brandSimulation.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — the TRAINING SIMULATION engine and its isolation.
 * Proves:
 *   • the generator is deterministic and seeded per access; daily volume stays
 *     in the admin range; outcomes follow the admin distribution (0 % never
 *     appears); statuses progress with the admin delays (speed)
 *   • nothing is simulated before activation + start delay, nor during a pause
 *   • persisted hours are written once and kept PERMANENTLY (no cap, no
 *     pruning): re-runs, a "restart" and concurrent dashboard reads never
 *     duplicate or change a row (history rules: brandHistory.test.mjs)
 *   • dashboard windows (24 h / 7 d / 30 d) are consistent and labelled simulated
 *   • ISOLATION: simulated events never touch real orders, affiliate orders,
 *     commissions, Rewards, payouts, deposits, boosters, UGC or the Fake Orders
 *     Engine; no balance provider reads brand data; the wallet balance is the
 *     same before and after any amount of simulation — so no wallet credit can
 *     exist, let alone be duplicated by a restart
 * Run: node scripts/brandSimulation.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID, SIM_OUTCOMES, SIM_STATUSES } from "../src/lib/brandProgram.js";
import {
  HOUR_MS, DAY_MS, simulateDay, countHour, statusAt, buildHourRows,
  liveHourCounts, windowBuckets, windowStats, floorHour, ceilHour,
} from "../src/lib/brandSimulation.js";
import { accessWindows, generableHours, toTimeline } from "../src/lib/brandSimTimeline.js";
import { requestBrandAccess } from "../src/lib/services/brandAccessService.js";
import { materializeAccessSimulation, getAffiliateSimulationDashboard, getAdminSimulationDashboard } from "../src/lib/services/brandSimulationService.js";
import { saveBrandConfig } from "../src/lib/services/brandProgramService.js";
import { affiliateBrandHandlers } from "../src/lib/brandRouteHandlers.js";
import { getAffiliateBalanceBreakdown } from "../src/lib/services/affiliateSystemService.js";
import { getBalanceProviders } from "../src/lib/balance/providerRegistry.js";
import { makeBrandFakeDb, BRAND_MODELS, SHARED_MODELS } from "./lib/brandFakeDb.mjs";
import { payAndAccept } from "./lib/brandProofKit.mjs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Test values only — not product defaults. */
const SIM = { enabled: true, startDelayHours: 5, dailyVolumeMin: 8, dailyVolumeMax: 20, confirmationDelayHours: 2, deliveryDelayHours: 48,
  distribution: { delivered: 50, refused: 10, returned: 5, noResponse: 20, cancelled: 15 }, activeSince: "2026-10-01T00:00:00.000Z" };
const PRICING = { deliveryCost: 40, logisticsCost: 10, vatPercent: 20, productCount: 3, productIds: ["prod-1", "prod-2", "prod-3"],
  percentages: { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 10, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } } };
const CONFIG = { enabled: true, packages: [{ id: "p1", name: "Formation", price: 1000, active: true, features: [], ...PRICING }], brandingOptions: [], simulation: SIM,
  catalogProductIds: ["prod-1", "prod-2", "prod-3"] };
const PRODUCTS = ["prod-1", "prod-2", "prod-3"].map((id) => ({ id, title: `Produit ${id}`, regularPrice: 199, salePrice: 149 }));
const PICK = ["prod-1", "prod-2", "prod-3"];
const TERMS = { draft: { text: "T" }, published: { version: 1, text: "T", publishedAt: "2026-10-01T00:00:00Z" } };
const T0 = new Date("2026-10-28T10:20:00Z");

/**
 * A brand never configured before, configured by an admin at `configAt` (so the
 * settings timeline is fully verified from then), then requested, paid and
 * accepted at `activateAt`.
 */
async function activeAccessDb({ strict = true, config = CONFIG, activateAt = T0, configAt = new Date(activateAt.getTime() - DAY_MS) } = {}) {
  const db = makeBrandFakeDb({ strict, affiliates: [{ id: "a1", username: "amina" }], products: PRODUCTS, settings: { [BRAND_TERMS_SETTING_ID]: TERMS } });
  await saveBrandConfig(config, { db, actorId: "admin-1", now: configAt });
  const acc = await requestBrandAccess("a1", { productIds: PICK, packageId: "p1", brandName: "Ma Marque", termsVersion: 1, acceptTerms: true, clientRequestId: "req-00000001" }, { db, now: activateAt });
  await payAndAccept(db, "a1", acc.id, { now: activateAt });
  return { db, accessId: acc.id };
}
const ON = toTimeline([{ effectiveFrom: new Date(0), enabled: true, proven: true, settings: SIM }]);
const hoursBetween = (from, to) => { const out = []; for (let h = from; h < to; h += HOUR_MS) out.push(h); return out; };

// ── 1. Pure generator ─────────────────────────────────────────────────────────
console.log("\n1. Deterministic generator");
{
  const day = Date.UTC(2026, 9, 20);
  ok("same seed + day + settings → identical orders", JSON.stringify(simulateDay("acc-1", day, SIM)) === JSON.stringify(simulateDay("acc-1", day, SIM)));
  ok("seeded per access", JSON.stringify(simulateDay("acc-1", day, SIM)) !== JSON.stringify(simulateDay("acc-2", day, SIM)));
  let inRange = true;
  for (let d = 0; d < 60; d++) { const n = simulateDay("acc-1", day + d * DAY_MS, SIM).length; if (n < SIM.dailyVolumeMin || n > SIM.dailyVolumeMax) inRange = false; }
  ok("daily volume always within the admin range (60 days)", inRange);
  ok("min = max → exact daily volume", simulateDay("x", day, { ...SIM, dailyVolumeMin: 7, dailyVolumeMax: 7 }).length === 7);

  const big = { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 };
  const freq = Object.fromEntries(SIM_OUTCOMES.map((k) => [k, 0]));
  for (let d = 0; d < 30; d++) for (const o of simulateDay("acc-1", day + d * DAY_MS, big)) freq[o.outcome]++;
  ok("outcome frequencies follow the distribution (±2 points over 30 000 orders)",
    SIM_OUTCOMES.every((k) => Math.abs(freq[k] / 300 - SIM.distribution[k]) <= 2), JSON.stringify(freq));
  const noRet = { ...big, distribution: { delivered: 60, refused: 10, returned: 0, noResponse: 20, cancelled: 10 } };
  ok("a 0 % outcome never appears", !simulateDay("acc-1", day, noRet).some((o) => o.outcome === "returned"));
  const orders = simulateDay("acc-1", day, SIM);
  ok("hours and minutes in range", orders.every((o) => o.hour >= 0 && o.hour < 24 && o.minute >= 0 && o.minute < 60));
  const full = Array.from({ length: 24 }, (_, h) => countHour(orders, h).created).reduce((a, b) => a + b, 0);
  ok("hour counts add up to the day", full === orders.length);
}

console.log("\n2. Status progression (speed settings)");
{
  ok("younger than the confirmation delay → pending", statusAt("delivered", 1.5, SIM) === "pending" && statusAt("cancelled", 0, SIM) === "pending");
  ok("no response / cancelled shown once confirmation time passes", statusAt("noResponse", 2, SIM) === "noResponse" && statusAt("cancelled", 100, SIM) === "cancelled");
  // confirmation 2 h, delivery 48 h → halfway point 25 h
  ok("delivered / refused / returned are 'confirmed' for the first half of the delivery time", statusAt("delivered", 2, SIM) === "confirmed" && statusAt("delivered", 10, SIM) === "confirmed" && statusAt("refused", 24.9, SIM) === "confirmed");
  ok("…then 'inDelivery' for the second half", statusAt("refused", 25, SIM) === "inDelivery" && statusAt("delivered", 40, SIM) === "inDelivery" && statusAt("returned", 47.9, SIM) === "inDelivery");
  ok("…then their final outcome", statusAt("delivered", 48, SIM) === "delivered" && statusAt("returned", 60, SIM) === "returned");
  ok("zero delays → final outcome immediately", statusAt("refused", 0, { confirmationDelayHours: 0, deliveryDelayHours: 0 }) === "refused");
  ok("equal delays → no confirmed / inDelivery phase", ["delivered", "refused", "returned"].every((o) => statusAt(o, 5, { confirmationDelayHours: 5, deliveryDelayHours: 5 }) === o));
  ok("no response / cancelled never pass through confirmed or inDelivery", [2, 10, 25, 40, 47.9, 100].every((a) => statusAt("noResponse", a, SIM) === "noResponse" && statusAt("cancelled", a, SIM) === "cancelled"));
  ok("a delivered order moves pending → confirmed → inDelivery → delivered, never back",
    [0, 1, 2, 10, 24.9, 25, 30, 47.9, 48, 100].map((a) => statusAt("delivered", a, SIM)).join() === "pending,pending,confirmed,confirmed,confirmed,inDelivery,inDelivery,inDelivery,delivered,delivered");
  ok("statuses: inDelivery added as a display status; the admin outcomes are unchanged",
    SIM_STATUSES.join() === "pending,confirmed,inDelivery,delivered,refused,returned,noResponse,cancelled" && SIM_OUTCOMES.join() === "delivered,refused,returned,noResponse,cancelled");
}

console.log("\n3. Ranges, live hour, windows");
{
  const now = Date.UTC(2026, 9, 28, 10, 37);
  const win = (start) => accessWindows([{ startedAt: new Date(start - 2 * HOUR_MS), endedAt: null }], new Date(start), now);
  const g = generableHours(ON, win(Date.UTC(2026, 9, 25, 3, 15)), Date.UTC(2026, 9, 25), floorHour(now));
  ok("first simulated hour = next full hour after the start; last = the last complete hour", g[0] === Date.UTC(2026, 9, 25, 4) && g.at(-1) === floorHour(now) - HOUR_MS);
  const year = generableHours(ON, win(Date.UTC(2026, 0, 1)), Date.UTC(2026, 0, 1), floorHour(now));
  ok("no history cap: a start ten months ago generates every hour since", year.length === (floorHour(now) - Date.UTC(2026, 0, 1)) / HOUR_MS);
  ok("start in the future → nothing to generate", generableHours(ON, win(now + 3 * HOUR_MS), now - DAY_MS, floorHour(now)).length === 0);
  let mono = true, prev = -1;
  for (let m = 0; m < 60; m++) { const c = liveHourCounts("acc-1", Date.UTC(2026, 9, 28, 9, m), SIM).created; if (c < prev) mono = false; prev = c; }
  ok("live hour only grows during the hour", mono);
  ok("…and ends equal to the stored full hour", liveHourCounts("acc-1", Date.UTC(2026, 9, 28, 9, 59, 59), SIM).created === countHour(simulateDay("acc-1", Date.UTC(2026, 9, 28), SIM), 9).created);
  ok("window buckets: 24 hourly, 7 and 30 daily", windowBuckets("24h", now).starts.length === 24 && windowBuckets("7d", now).starts.length === 7 && windowBuckets("30d", now).starts.length === 30 && windowBuckets("1y", now) === null);
  const rows = buildHourRows("acc-1", "acc-1", hoursBetween(Date.UTC(2026, 9, 1), floorHour(now)), SIM);
  const live = liveHourCounts("acc-1", now, SIM);
  const w = Object.fromEntries(["24h", "7d", "30d"].map((k) => [k, windowStats(rows, live, now, k, SIM)]));
  ok("totals grow with the window", w["24h"].total <= w["7d"].total && w["7d"].total <= w["30d"].total);
  ok("status breakdown and buckets add up to the total", ["24h", "7d", "30d"].every((k) =>
    SIM_STATUSES.reduce((s, x) => s + w[k].byStatus[x], 0) === w[k].total && w[k].buckets.reduce((s, b) => s + b.total, 0) === w[k].total));
  ok("recent orders still pending / confirmed, older ones final", w["24h"].byStatus.delivered === 0 && w["24h"].byStatus.confirmed > 0 && w["30d"].byStatus.delivered > 0);
  // inDelivery = orders aged 25–48 h (confirmation 2 h, delivery 48 h): none inside the last 24 h
  ok("inDelivery and cancelled are counted (inDelivery only in windows reaching back past 25 h)",
    w["24h"].byStatus.inDelivery === 0 && w["7d"].byStatus.inDelivery > 0 && w["30d"].byStatus.inDelivery === w["7d"].byStatus.inDelivery
    && w["7d"].byStatus.cancelled > 0 && w["24h"].byStatus.cancelled <= w["7d"].byStatus.cancelled && w["7d"].byStatus.cancelled <= w["30d"].byStatus.cancelled);
  // independent recount: every created hour inside the window, by the status statusAt gives it now
  const recount = (k, status) => {
    const from = windowBuckets(k, now).from; let n = 0;
    for (const r of [...rows, live]) {
      const h = new Date(r.hourStart).getTime(); if (h < from || h > now) continue;
      for (const o of SIM_OUTCOMES) if (statusAt(o, (now - h) / HOUR_MS, SIM) === status) n += Number(r[o]) || 0;
    }
    return n;
  };
  ok("24h / 7d / 30d filters: inDelivery and cancelled match an independent recount",
    ["24h", "7d", "30d"].every((k) => w[k].byStatus.inDelivery === recount(k, "inDelivery") && w[k].byStatus.cancelled === recount(k, "cancelled")),
    JSON.stringify(["24h", "7d", "30d"].map((k) => [w[k].byStatus.inDelivery, recount(k, "inDelivery"), w[k].byStatus.cancelled, recount(k, "cancelled")])));
  ok("chart data: every bucket carries per-status counts that add up to its total",
    ["24h", "7d", "30d"].every((k) => w[k].buckets.every((b) => SIM_STATUSES.every((x) => Number.isInteger(b.byStatus[x])) && SIM_STATUSES.reduce((s, x) => s + b.byStatus[x], 0) === b.total)));
  ok("chart data: each status's buckets add up to its window count (cards and chart agree)",
    ["24h", "7d", "30d"].every((k) => SIM_STATUSES.every((x) => w[k].buckets.reduce((s, b) => s + b.byStatus[x], 0) === w[k].byStatus[x])));
  ok("chart data: the existing total series is unchanged (buckets keep start + total)",
    ["24h", "7d", "30d"].every((k) => w[k].buckets.every((b) => typeof b.start === "string" && Number.isInteger(b.total))) && w["7d"].buckets.some((b) => b.byStatus.inDelivery > 0) && w["30d"].buckets.some((b) => b.byStatus.cancelled > 0));
}

// ── 4. Persistence: once, whatever happens ────────────────────────────────────
console.log("\n4. Persisted once: re-runs, restart, concurrency");
{
  const { db, accessId } = await activeAccessDb();
  const T = db._tables;
  const early = await getAffiliateSimulationDashboard("a1", { db, now: new Date(T0.getTime() + HOUR_MS), window: "24h" });
  ok("before the start delay: not started, nothing generated", early.started === false && early.stats.total === 0 && T.brandSimHour.length === 0);
  ok("dashboard is flagged simulated", early.simulated === true && early.brandName === "Ma Marque");

  const now = new Date(T0.getTime() + 10 * DAY_MS);
  const d30 = await getAffiliateSimulationDashboard("a1", { db, now, window: "30d" });
  ok("API response: buckets carry per-status counts matching the cards (inDelivery, cancelled, every status)",
    d30.stats.buckets.every((b) => Number.isInteger(b.total) && SIM_STATUSES.reduce((x, k) => x + b.byStatus[k], 0) === b.total)
    && SIM_STATUSES.every((k) => d30.stats.buckets.reduce((x, b) => x + b.byStatus[k], 0) === d30.stats.byStatus[k])
    && d30.stats.byStatus.inDelivery > 0 && d30.stats.byStatus.cancelled > 0, JSON.stringify(d30.stats.byStatus));
  ok("simulation only: still nothing but brand_sim_hours rows written (no order, wallet or commission table touched)",
    Object.entries(T).every(([name, rows]) => !/^(order|affiliateOrder|commission|wallet|payout|deposit|reward)/i.test(name) || rows.length === 0));
  const startsAt = T.brandAccess[0].simulationStartsAt.getTime();
  const expected = (floorHour(now.getTime()) - ceilHour(startsAt)) / HOUR_MS;
  ok(`every completed hour since the start stored once (${expected} hours)`, T.brandSimHour.length === expected, `${T.brandSimHour.length}`);
  ok("no hour before activation + start delay", T.brandSimHour.every((r) => r.hourStart.getTime() >= startsAt));
  const snapshot = JSON.stringify(T.brandSimHour.map(({ createdAt: _createdAt, ...r }) => r));
  const again = await materializeAccessSimulation(T.brandAccess[0], { db, now });
  ok("re-run → nothing inserted, rows unchanged", again.inserted === 0 && JSON.stringify(T.brandSimHour.map(({ createdAt: _createdAt, ...r }) => r)) === snapshot);
  const fresh = buildHourRows(accessId, accessId, hoursBetween(ceilHour(startsAt), floorHour(now.getTime())), SIM);
  ok("stored rows = an independent recomputation (deterministic)", JSON.stringify(fresh.map((r) => [r.hourStart.toISOString(), r.created, r.delivered, r.noResponse]))
    === JSON.stringify(T.brandSimHour.map((r) => [new Date(r.hourStart).toISOString(), r.created, r.delivered, r.noResponse])));
  const restarted = affiliateBrandHandlers({ db, now: () => now });
  const res = await restarted.dashboard(new Request("http://x/api/affiliate/brand/dashboard?window=7d"), {}, { affiliateId: "a1" });
  ok("after a 'restart' (new handlers): 200 and still no duplicate", res.status === 200 && T.brandSimHour.length === expected);

  const c = await activeAccessDb();
  await Promise.all([1, 2, 3, 4].map(() => getAffiliateSimulationDashboard("a1", { db: c.db, now, window: "24h" })));
  ok("4 concurrent dashboard reads → each hour stored once", c.db._tables.brandSimHour.length === expected
    && new Set(c.db._tables.brandSimHour.map((r) => new Date(r.hourStart).getTime())).size === expected);

  await saveBrandConfig({ ...CONFIG, simulation: { ...SIM, distribution: { delivered: 0, refused: 0, returned: 0, noResponse: 100, cancelled: 0 } } }, { db, actorId: "admin-1", now });
  await getAffiliateSimulationDashboard("a1", { db, now, window: "30d" });
  ok("a settings change never rewrites stored hours", JSON.stringify(T.brandSimHour.map(({ createdAt: _createdAt, ...r }) => r)) === snapshot);
}

console.log("\n5. Pause, windows, errors");
{
  const { db } = await activeAccessDb();
  const T = db._tables;
  const t1 = new Date(T0.getTime() + 3 * DAY_MS);
  await getAffiliateSimulationDashboard("a1", { db, now: t1, window: "24h" });
  const stored = T.brandSimHour.length;
  await saveBrandConfig({ ...CONFIG, simulation: { ...SIM, enabled: false } }, { db, actorId: "admin-1", now: t1 });
  const paused = await getAffiliateSimulationDashboard("a1", { db, now: new Date(t1.getTime() + DAY_MS), window: "7d" });
  ok("paused: running=false, stored data still shown, nothing new generated", paused.running === false && paused.stats.total > 0 && T.brandSimHour.length === stored);
  const t2 = new Date(t1.getTime() + 2 * DAY_MS);
  await saveBrandConfig({ ...CONFIG, simulation: { ...SIM } }, { db, actorId: "admin-1", now: t2 });
  await getAffiliateSimulationDashboard("a1", { db, now: new Date(t2.getTime() + 6 * HOUR_MS), window: "7d" });
  const gap = T.brandSimHour.filter((r) => { const h = new Date(r.hourStart).getTime(); return h >= floorHour(t1.getTime()) && h < ceilHour(t2.getTime()); });
  ok("the paused period is never filled in afterwards", gap.length === 0);
  ok("resumes after the switch-on", T.brandSimHour.some((r) => new Date(r.hourStart).getTime() >= ceilHour(t2.getTime())));
  ok("invalid window → INVALID_WINDOW", (await rejects(getAffiliateSimulationDashboard("a1", { db, now: t2, window: "1y" })))?.code === "INVALID_WINDOW");

  const pending = makeBrandFakeDb({ affiliates: [{ id: "a1", username: "a" }], products: PRODUCTS, settings: { [BRAND_SETTING_ID]: CONFIG, [BRAND_TERMS_SETTING_ID]: TERMS } });
  const acc = await requestBrandAccess("a1", { productIds: PICK, packageId: "p1", brandName: "Ma Marque", termsVersion: 1, acceptTerms: true, clientRequestId: "req-00000002" }, { db: pending, now: T0 });
  ok("pending access: no dashboard (NO_ACTIVE_ACCESS) and nothing generated", (await rejects(getAffiliateSimulationDashboard("a1", { db: pending, now: t2 })))?.code === "NO_ACTIVE_ACCESS"
    && (await rejects(getAdminSimulationDashboard(acc.id, { db: pending, now: t2 })))?.code === "NO_ACTIVE_ACCESS" && pending._tables.brandSimHour.length === 0);
}

// ── 5a. Permanence: no cap, no pruning ────────────────────────────────────────
console.log("\n5a. Permanent history");
{
  const start = new Date(T0.getTime() - 45 * DAY_MS);
  const { db } = await activeAccessDb({ strict: true, activateAt: start });
  const early = new Date(start.getTime() + 20 * DAY_MS);
  await materializeAccessSimulation(db._tables.brandAccess[0], { db, now: early });
  const before = db._tables.brandSimHour.map((h) => new Date(h.hourStart).getTime());
  const r = await materializeAccessSimulation(db._tables.brandAccess[0], { db, now: T0 });
  ok("older hours are kept on the next materialization (nothing pruned)", before.length > 0 && !("pruned" in r)
    && before.every((h) => db._tables.brandSimHour.some((x) => new Date(x.hourStart).getTime() === h)));
  const startsAt = db._tables.brandAccess[0].simulationStartsAt.getTime();
  ok("all 45 days are stored", db._tables.brandSimHour.length === (floorHour(T0.getTime()) - ceilHour(startsAt)) / HOUR_MS, `${db._tables.brandSimHour.length}`);
  const e1 = await rejects(db.brandSimHour.deleteMany({ where: { accessId: db._tables.brandAccess[0].id } }));
  const e2 = await rejects(db.brandSimHour.updateMany({ where: {}, data: { created: 0 } }));
  ok("the database refuses deleting or updating simulated hours", /permanent/.test(e1?.message || "") && /permanent/.test(e2?.message || ""));
}

// ── 5b. Latest simulated orders (dashboard list) ──────────────────────────────
console.log("\n5b. Latest simulated orders");
{
  const { recentSimulatedOrders, simulateDay: genDay, floorDay: fDay, HOUR_MS: H } = await import("../src/lib/brandSimulation.js");
  const now = Date.parse("2026-10-28T15:20:00Z"), day = fDay(now);
  const counted = Array.from({ length: 15 }, (_, h) => day + h * H);
  const prods = [{ id: "prod-1", title: "Un", image: null }, { id: "prod-2", title: "Deux", image: "/a.png" }];
  const args = { countedHours: counted, liveHour: day + 15 * H, nowMs: now, sim: SIM, products: prods, limit: 50 };
  const a = recentSimulatedOrders("acc-x", args), b = recentSimulatedOrders("acc-x", args);
  ok("deterministic (same seed → same list)", JSON.stringify(a) === JSON.stringify(b) && a.length > 0);
  const expected = genDay("acc-x", day, SIM).filter((o) => o.hour < 15 || (o.hour === 15 && o.minute <= 20)).length
    + genDay("acc-x", day - 86_400_000, SIM).length * 0;
  ok("today's listed orders = the generator's orders in counted hours up to now", a.filter((o) => o.at.startsWith("2026-10-28")).length === expected, `${a.length} vs ${expected}`);
  ok("newest first, never in the future", a.every((o, i) => Date.parse(o.at) <= now && (i === 0 || a[i - 1].at >= o.at)));
  ok("each order: training reference, status, one of the selected products — no amount", a.every((o) => /^SIM-[0-9A-Z]{4}-\d{6}-\d{4}$/.test(o.ref)
    && SIM_STATUSES.includes(o.status) && prods.some((p) => p.id === o.product.id) && Object.keys(o).sort().join() === "at,product,ref,status"));
  ok("orders of uncounted (paused / not started) hours are never listed", recentSimulatedOrders("acc-x", { ...args, countedHours: [], liveHour: null }).length === 0);
  ok("limit respected", recentSimulatedOrders("acc-x", { ...args, limit: 3 }).length === 3);
  // short delays (confirmed 0.5 h, delivery 10 h → halfway 5.25 h) so the latest orders reach inDelivery
  const quick = { ...SIM, confirmationDelayHours: 0.5, deliveryDelayHours: 10 };
  const q = recentSimulatedOrders("acc-x", { ...args, sim: quick });
  const phase = (o) => { const age = (now - Date.parse(o.at)) / H; return age < 0.5 ? "pending" : age < 5.25 ? "confirmed" : age < 10 ? "inDelivery" : "final"; };
  ok("latest orders show inDelivery and cancelled from the same generator",
    q.some((o) => o.status === "inDelivery") && q.some((o) => o.status === "cancelled"), [...new Set(q.map((o) => o.status))].join());
  ok("each listed status matches its age (pending → confirmed → inDelivery → final; no response / cancelled once confirmed)", q.every((o) => {
    const p = phase(o);
    if (p === "pending") return o.status === "pending";
    if (o.status === "noResponse" || o.status === "cancelled") return true;
    return p === "final" ? ["delivered", "refused", "returned"].includes(o.status) : o.status === p;
  }));
  const { db } = await activeAccessDb({ strict: true, activateAt: new Date(T0.getTime() - 3 * DAY_MS) });
  const dash = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "24h" });
  ok("dashboard returns the latest simulated orders with the brand's products", Array.isArray(dash.recent) && dash.recent.length > 0
    && dash.recent.every((o) => PICK.includes(o.product.id) && !("amount" in o)) && dash.simulated === true);
  ok("…and the list is consistent with the window total", dash.recent.length <= dash.stats.total);
}

// ── 5c. One dataset: orders, counts, chart, simulated money, Casablanca days ──
console.log("\n5c. Single simulated dataset + simulated money (training figures only)");
{
  const E = await import("../src/lib/brandSimulation.js");
  const { SIM_ORDER_EXPENSES } = await import("../src/lib/brandProgram.js");
  const { businessDateKey } = await import("../src/lib/ugcTime.js");
  const now = Date.parse("2026-10-28T15:20:00Z");
  const counted = hoursBetween(Date.UTC(2026, 9, 1), E.floorHour(now));
  const liveHour = E.floorHour(now);
  const prods = [{ id: "prod-1", title: "Un", image: "/a.png" }, { id: "prod-2", title: "Deux", image: null }];

  // Casablanca day buckets
  const b7 = E.windowBuckets("7d", now), b30 = E.windowBuckets("30d", now);
  const casaClock = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Casablanca", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  ok("7 d / 30 d buckets start at Casablanca midnight, today included, consecutive days",
    b7.starts.length === 7 && b30.starts.length === 30 && [...b7.starts, ...b30.starts].every((t) => casaClock(t) === "00:00")
    && businessDateKey(new Date(b7.starts.at(-1))) === businessDateKey(new Date(now))
    && b30.starts.every((t, i) => i === 0 || businessDateKey(new Date(t - 1)) === businessDateKey(new Date(b30.starts[i - 1]))));
  const b24 = E.windowBuckets("24h", now);
  ok("24 h buckets: exactly [now − 24 h, now] — 24 one-hour buckets, start i = now − (24 − i) h, the last one ends at now (live hour inside)",
    b24.unit === "hour" && b24.step === HOUR_MS && b24.starts.length === 24 && b24.from === now - 24 * HOUR_MS && b24.starts[0] === b24.from
    && b24.starts.every((t, i) => t === now - (24 - i) * HOUR_MS) && b24.starts.at(-1) + HOUR_MS === now && b24.starts.at(-1) <= liveHour + HOUR_MS && liveHour <= now,
    JSON.stringify([b24.from, now]));

  // money of one order
  const m = (st, price) => E.simOrderMoney(st, price);
  const exp = SIM_ORDER_EXPENSES.delivery + SIM_ORDER_EXPENSES.notification + SIM_ORDER_EXPENSES.confirmation;
  ok("fixed simulated expenses: delivery 15 + notification 20 + confirmation 30 = 65 MAD",
    SIM_ORDER_EXPENSES.delivery === 15 && SIM_ORDER_EXPENSES.notification === 20 && SIM_ORDER_EXPENSES.confirmation === 30 && exp === 65 && m("delivered", 299).expenses.total === 65);
  ok("delivered at 299 MAD: gross 299, net 234, realized", m("delivered", 299).price === 299 && m("delivered", 299).net === 234 && m("delivered", 299).kind === "realized");
  ok("price below 65 MAD → negative net (no minimum enforced)", m("delivered", 50).net === -15 && m("delivered", 64.99).net === -0.01);
  ok("pending / confirmed / inDelivery → expected (never realized)", ["pending", "confirmed", "inDelivery"].every((x) => m(x, 299).kind === "expected"));
  ok("refused / returned / noResponse / cancelled → no profit", ["refused", "returned", "noResponse", "cancelled"].every((x) => m(x, 299).kind === "none"));
  ok("no price in the snapshot → no money computed", [null, undefined, 0, -10, "299", NaN].every((x) => m("delivered", x) === null));
  ok("decimal prices stay exact (cents)", m("delivered", 99.99).net === 34.99 && m("delivered", 0.1).net === -64.9);

  const args = { countedHours: counted, liveHour, sim: SIM, products: prods, price: 299 };
  // Independent recount straight from the generator (no memo, no bucketOf, no ordersStats): counted hours + the live
  // hour, from ≤ at ≤ now; bucket i holds starts[i] ≤ at < starts[i + 1] (the last one up to now).
  const countedSet = new Set(counted);
  const recount = (seed, from, nowMs, starts) => {
    const out = { total: 0, buckets: starts.map(() => 0) };
    const days = new Set([...counted.filter((h) => h >= Math.floor(from / HOUR_MS) * HOUR_MS && h <= nowMs), liveHour].map((h) => h - (h % DAY_MS)));
    for (const day of days) for (const o of simulateDay(seed, day, SIM)) {
      const hs = day + o.hour * HOUR_MS, at = hs + o.minute * 60000;
      if (!(countedSet.has(hs) || hs === liveHour) || at < from || at > nowMs) continue;
      out.total++;
      let i = starts.length - 1; while (starts[i] > at) i--;
      out.buckets[i]++;
    }
    return out;
  };
  for (const k of ["24h", "7d", "30d"]) {
    const from = E.windowBuckets(k, now).from;
    const list = E.simulatedOrders("acc-x", { ...args, fromMs: from, nowMs: now });
    const st = E.ordersStats(list, now, k, 299);
    const rows = buildHourRows("acc-x", "acc-x", counted.filter((h) => h >= from), SIM);
    const hourLevel = windowStats(rows, liveHourCounts("acc-x", now, SIM), now, k, SIM);
    const count = (x) => list.filter((o) => o.status === x).length;
    const delivered = list.filter((o) => o.status === "delivered");
    const rc = recount("acc-x", from, now, E.windowBuckets(k, now).starts);
    // Stored rows are clock hours: 7 d / 30 d start at a Casablanca midnight (whole hour) so every bucket matches; the
    // exact 24 h window starts inside a clock hour, so stored-hour totals are compared on the hours fully inside it.
    const storedSide = k === "24h"
      ? list.filter((o) => Date.parse(o.at) >= ceilHour(from)).length === hourLevel.total && from % HOUR_MS !== 0
      : st.total === hourLevel.total && st.buckets.every((bk, i) => bk.total === hourLevel.buckets[i].total);
    ok(`${k}: list = stored hourly counts (${k === "24h" ? "hours fully inside the rolling window" : "same orders: total and every bucket"}) = independent generator recount (total and every bucket)`,
      list.length === st.total && storedSide && st.total === rc.total && st.buckets.every((bk, i) => bk.total === rc.buckets[i]),
      `${list.length} / ${hourLevel.total} / ${rc.total}`);
    ok(`${k}: status counts = the list's statuses; statuses add up to the total; chart buckets add up per status`,
      SIM_STATUSES.every((x) => st.byStatus[x] === count(x)) && SIM_STATUSES.reduce((a, x) => a + st.byStatus[x], 0) === st.total
      && SIM_STATUSES.every((x) => st.buckets.reduce((a, bk) => a + bk.byStatus[x], 0) === st.byStatus[x]));
    ok(`${k}: revenue = delivered × price, profit = delivered × (price − 65), both = sums over the listed orders`,
      st.money.revenue === delivered.length * 299 && st.money.profit === delivered.length * 234
      && st.money.revenue === delivered.reduce((a, o) => a + o.money.price, 0) && st.money.profit === delivered.reduce((a, o) => a + o.money.net, 0));
    ok(`${k}: no order counted twice (unique references), none outside the window or in the future`,
      new Set(list.map((o) => o.ref)).size === list.length && list.every((o) => Date.parse(o.at) >= from && Date.parse(o.at) <= now));
  }
  const L = (k) => E.simulatedOrders("acc-x", { ...args, fromMs: E.windowBuckets(k, now).from, nowMs: now });
  const refs = (k) => new Set(L(k).map((o) => o.ref));
  ok("periods nest: every 24 h order is in 7 d, every 7 d order in 30 d (same order, same status)",
    [...refs("24h")].every((r) => refs("7d").has(r)) && [...refs("7d")].every((r) => refs("30d").has(r))
    && L("24h").every((o) => L("30d").find((x) => x.ref === o.ref).status === o.status));
  const bal = E.simulatedBalance("acc-x", { nowMs: now, countedHours: counted, liveHour, sim: SIM, price: 299 });
  const allDelivered = E.simulatedOrders("acc-x", { ...args, fromMs: counted[0], nowMs: now }).filter((o) => o.status === "delivered").length;
  ok("balance = net of every delivered order since the start (not just the period); ≥ 30 d profit",
    bal.delivered === allDelivered && bal.balance === allDelivered * 234 && bal.balance >= E.ordersStats(L("30d"), now, "30d", 299).money.profit);
  ok("negative net → negative simulated balance (mathematically consistent)",
    E.simulatedBalance("acc-x", { nowMs: now, countedHours: counted, liveHour, sim: SIM, price: 50 }).balance === allDelivered * -15);
  ok("no price → stats without money, balance null", E.ordersStats(L("7d"), now, "7d", null).money === null
    && E.simulatedBalance("acc-x", { nowMs: now, countedHours: counted, liveHour, sim: SIM, price: null }) === null);
  ok("references are stable with the previous list (same generator)",
    E.recentSimulatedOrders("acc-x", { countedHours: counted, liveHour, nowMs: now, sim: SIM, products: prods, limit: 5 }).every((o) => refs("24h").has(o.ref)));

  // Service: snapshot price, option (b) for old requests, history frozen, admin = affiliate
  const PRICED = { ...CONFIG, packages: [{ ...CONFIG.packages[0], quantity: 50, simulatedSellingPrice: 299 }] };
  const { db, accessId } = await activeAccessDb({ strict: true, config: PRICED, activateAt: new Date(T0.getTime() - 3 * DAY_MS) });
  const d7 = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "7d" });
  ok("dashboard: finance from the request snapshot (299 MAD), revenue/profit = the window's delivered orders, balance ≥ profit",
    d7.finance?.simulated === true && d7.finance.price === 299 && d7.finance.revenue === d7.stats.byStatus.delivered * 299
    && d7.finance.profit === d7.stats.byStatus.delivered * 234 && d7.finance.balance >= d7.finance.profit, JSON.stringify(d7.finance));
  ok("dashboard: orders page = the same dataset (total = stats total, recent = first items)",
    d7.orders.total === d7.stats.total && d7.orders.items.length === Math.min(20, d7.stats.total) && d7.recent.every((o, i) => o.ref === d7.orders.items[i].ref));
  const p2 = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "7d", page: 2 });
  ok("see all: page 2 continues page 1 without overlap", p2.orders.page === (d7.orders.total > 20 ? 2 : 1)
    && (d7.orders.total <= 20 || p2.orders.items.every((o) => !d7.orders.items.some((x) => x.ref === o.ref))));
  const adm = await getAdminSimulationDashboard(accessId, { db, now: T0, window: "7d" });
  ok("admin simulated view = same order-level stats and Casablanca buckets", JSON.stringify(adm.stats) === JSON.stringify(d7.stats));
  await saveBrandConfig({ ...PRICED, packages: [{ ...PRICED.packages[0], quantity: 999, simulatedSellingPrice: 10 }] }, { db, actorId: "admin-1", now: T0 });
  const after = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "7d" });
  ok("a later pack edit never changes this brand's figures (frozen snapshot)", JSON.stringify(after.finance) === JSON.stringify(d7.finance)
    && db._tables.brandAccess[0].packageSnapshot.quantity === 50 && db._tables.brandAccess[0].packageSnapshot.simulatedSellingPrice === 299);
  const old = await activeAccessDb({ strict: true, activateAt: new Date(T0.getTime() - 3 * DAY_MS) });
  const od = await getAffiliateSimulationDashboard("a1", { db: old.db, now: T0, window: "7d" });
  ok("request without simulated price (made before the field): finance null, orders without money, counts unchanged",
    od.finance === null && od.stats.money === null && od.orders.items.every((o) => o.money === null) && od.stats.total > 0);
  // The strict fake DB throws on ANY model outside the brand tables (wallet, orders, commissions, payouts…).
  const err = await rejects(getAffiliateSimulationDashboard("a1", { db, now: T0, window: "30d" }));
  ok("simulated money never reaches the real wallet: the dashboard runs on a DB that refuses every wallet / order / commission model",
    err === null && (await rejects(getAffiliateBalanceBreakdown("a1", db)))?.message?.includes("forbidden model access"));
}

// ── 5d. Casablanca day boundaries across Morocco's clock changes ─────────────
console.log("\n5d. Casablanca day boundaries across the 2026 clock changes (C1)");
{
  const E = await import("../src/lib/brandSimulation.js");
  const H = HOUR_MS;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (ms) => { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
  const offsetH = (ms) => { const l = local(ms); return Math.round((Date.parse(`${l.date}T${l.time}:00Z`) - Math.floor(ms / 60000) * 60000) / H); };
  // precondition: the runtime's tz data has both 2026 changes (UTC+1 → UTC+0 on 15 Feb, back on 22 Mar)
  ok("tz data: Casablanca UTC+1 → UTC+0 at 2026-02-15T02:00Z and back at 2026-03-22T02:00Z",
    offsetH(Date.UTC(2026, 1, 15, 1)) === 1 && offsetH(Date.UTC(2026, 1, 15, 3)) === 0 && offsetH(Date.UTC(2026, 2, 22, 1)) === 0 && offsetH(Date.UTC(2026, 2, 22, 3)) === 1);

  const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
  const feb = E.windowBuckets("7d", Date.parse("2026-02-18T12:00:00Z")).starts.map(iso);
  ok("7 d on 18 Feb 2026: 12 → 18 Feb, each at Casablanca midnight (15 Feb starts 23:00Z on the 14th, 16 Feb at 00:00Z)",
    JSON.stringify(feb) === JSON.stringify(["2026-02-11T23:00", "2026-02-12T23:00", "2026-02-13T23:00", "2026-02-14T23:00", "2026-02-16T00:00", "2026-02-17T00:00", "2026-02-18T00:00"]), JSON.stringify(feb));
  const mar = E.windowBuckets("7d", Date.parse("2026-03-25T12:00:00Z")).starts.map(iso);
  ok("7 d on 25 Mar 2026: 19 → 25 Mar, each at Casablanca midnight (22 Mar at 00:00Z, 23 Mar at 23:00Z on the 22nd)",
    JSON.stringify(mar) === JSON.stringify(["2026-03-19T00:00", "2026-03-20T00:00", "2026-03-21T00:00", "2026-03-22T00:00", "2026-03-22T23:00", "2026-03-23T23:00", "2026-03-24T23:00"]), JSON.stringify(mar));

  // every 7 d / 30 d window that contains a transition: strictly increasing, unique, local midnights of consecutive dates ending today
  const checkWindow = (key, now) => {
    const b = E.windowBuckets(key, now), st = b.starts;
    const inc = st.every((t, i) => i === 0 || t > st[i - 1]) && new Set(st).size === st.length;
    const midnights = st.every((t) => local(t).time === "00:00");
    const dates = st.map((t) => local(t).date);
    const consecutive = dates.every((d, i) => i === 0 || Date.parse(d) - Date.parse(dates[i - 1]) === DAY_MS) && dates.at(-1) === local(now).date;
    const lengths = st.slice(1).map((t, i) => (t - st[i]) / H).every((h) => h === 23 || h === 24 || h === 25);
    let unbucketed = 0; for (let h = b.from; h <= now; h += H) if (E.bucketOf(st, h) === null) unbucketed++;
    return inc && midnights && consecutive && lengths && unbucketed === 0 && st.length === (key === "7d" ? 7 : 30);
  };
  const T = [Date.UTC(2026, 1, 15, 2), Date.UTC(2026, 2, 22, 2)];
  const nows = (t, span) => [t - H, t + H, t + 12 * H, ...Array.from({ length: span }, (_, i) => t + i * DAY_MS + 15 * H)];
  ok("every 7 d window containing a 2026 clock change: 7 strictly increasing, unique Casablanca midnights, consecutive dates, 23/24/25 h days",
    T.every((t) => nows(t, 7).every((n) => checkWindow("7d", n))));
  ok("every 30 d window containing a 2026 clock change: 30 strictly increasing, unique Casablanca midnights, consecutive dates",
    T.every((t) => nows(t, 30).every((n) => checkWindow("30d", n))));
  ok("…and the whole year 2026, every 6 h (7 d and 30 d)", (() => { for (let n = Date.UTC(2026, 0, 1); n < Date.UTC(2027, 0, 1); n += 6 * H) if (!checkWindow("7d", n) || !checkWindow("30d", n)) return false; return true; })());

  // orders at the boundaries: nothing missing, nothing doubled, each in its Casablanca day; totals and revenue follow
  const HV = { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 };
  for (const [label, now, key] of [["7 d over 15 Feb", Date.parse("2026-02-18T12:00:00Z"), "7d"], ["30 d over 15 Feb", Date.parse("2026-03-01T12:00:00Z"), "30d"],
    ["7 d over 22 Mar", Date.parse("2026-03-25T12:00:00Z"), "7d"], ["30 d over 22 Mar", Date.parse("2026-04-10T12:00:00Z"), "30d"]]) {
    const b = E.windowBuckets(key, now);
    const counted = hoursBetween(E.floorDay(b.from) - DAY_MS, E.floorHour(now));
    const liveHour = E.floorHour(now); // the dashboard includes the current hour up to now
    const list = E.simulatedOrders("acc-dst", { fromMs: b.from, nowMs: now, countedHours: counted, liveHour, sim: HV, price: 299 });
    const st = E.ordersStats(list, now, key, 299);
    let expected = 0; // independent recount straight from the generator
    for (let d = E.floorDay(b.from) - DAY_MS; d <= now; d += DAY_MS) for (const o of E.simulateDay("acc-dst", d, HV)) { const at = d + o.hour * H + o.minute * 60000; if (at >= b.from && at <= now) expected++; }
    const perDay = new Map(); for (const o of list) { const k = local(Date.parse(o.at)).date; perDay.set(k, (perDay.get(k) || 0) + 1); }
    const hourly = E.windowStats(E.buildHourRows("acc-dst", "acc-dst", counted.filter((h) => h >= b.from), HV), E.liveHourCounts("acc-dst", now, HV), now, key, HV);
    ok(`${label}: every order of the window counted once (= generator recount), each in its Casablanca day; chart buckets and the hourly rows agree; revenue = delivered × 299`,
      list.length === expected && st.total === expected && new Set(list.map((o) => o.ref)).size === expected
      && st.buckets.every((bk) => bk.total === (perDay.get(local(Date.parse(bk.start)).date) || 0))
      && st.buckets.reduce((a, bk) => a + bk.total, 0) === expected && st.buckets.every((bk, i) => bk.total === hourly.buckets[i].total)
      && st.money.revenue === st.byStatus.delivered * 299 && st.money.profit === st.byStatus.delivered * 234,
      JSON.stringify([list.length, expected, st.total]));
  }
}

// ── 5e. Order references: unique and deterministic at high volume ─────────────
console.log("\n5e. Simulated order references: unique, deterministic (C2)");
{
  const E = await import("../src/lib/brandSimulation.js");
  const seeds = ["acc-a", "acc-b", "3f1c2e9a-1111-4b2b-9c3d-5e6f7a8b9c0d"];
  const first = Date.UTC(2025, 11, 1), DAYS = 1095, PER_DAY = 1000; // Dec 2025 → Nov 2028: months and years
  const RE = /^SIM-[0-9A-Z]{4}-(\d{6})-(\d{4})$/;
  let allUnique = true, allFormat = true, tags = new Set(), total = 0;
  for (const seed of seeds) {
    const seen = new Set();
    let tag = null;
    for (let d = 0; d < DAYS; d++) {
      const day = first + d * DAY_MS, ymd = new Date(day).toISOString().slice(2, 10).replace(/-/g, "");
      for (let i = 0; i < PER_DAY; i++) {
        const { ref } = E.simulatedOrderRef(seed, day, i);
        const m = RE.exec(ref);
        if (!m || m[1] !== ymd || Number(m[2]) !== i + 1) allFormat = false;
        if (seen.has(ref)) allUnique = false;
        seen.add(ref); total++;
        tag = ref.slice(4, 8);
      }
    }
    tags.add(tag);
  }
  ok(`${total.toLocaleString("en")} references (${seeds.length} seeds × ${DAYS} days × ${PER_DAY}/day): all unique within each brand`, allUnique && total === seeds.length * DAYS * PER_DAY);
  ok("each reference = brand tag + generation date (with year) + 1-based position that day", allFormat);
  ok("different brands carry different tags (so references never coincide across these seeds)", tags.size === seeds.length);
  ok("deterministic: the same seed, day and position always give the same reference",
    seeds.every((sd) => [0, 499, 999].every((i) => E.simulatedOrderRef(sd, first + 400 * DAY_MS, i).ref === E.simulatedOrderRef(sd, first + 400 * DAY_MS + 5 * HOUR_MS, i).ref)));
  const HV = { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 };
  const now = Date.UTC(2026, 9, 28, 15, 20), from = E.windowBuckets("30d", now).from;
  const counted = hoursBetween(E.floorDay(from) - DAY_MS, E.floorHour(now));
  const list = E.simulatedOrders("acc-hv", { fromMs: from, nowMs: now, countedHours: counted, sim: HV, price: 299 });
  ok(`30 d at 1000/day: ${list.length.toLocaleString("en")} orders, every reference (= React key) unique`, list.length > 28000 && new Set(list.map((o) => o.ref)).size === list.length);
  ok("same list on a second computation (stable references and order)", JSON.stringify(list.map((o) => o.ref)) === JSON.stringify(E.simulatedOrders("acc-hv", { fromMs: from, nowMs: now, countedHours: counted, sim: HV, price: 299 }).map((o) => o.ref)));

  // service pagination at 1000/day: concatenated pages = the full list, each order exactly once
  const HVCONFIG = { ...CONFIG, simulation: { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 } };
  const { db } = await activeAccessDb({ strict: true, config: HVCONFIG, activateAt: new Date(T0.getTime() - 2 * DAY_MS) });
  const p1 = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "24h", page: 1 });
  const pages = Math.ceil(p1.orders.total / p1.orders.pageSize);
  const refs = [...p1.orders.items.map((o) => o.ref)];
  for (let n = 2; n <= pages; n++) refs.push(...(await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "24h", page: n })).orders.items.map((o) => o.ref));
  ok(`pagination at 1000/day (24 h: ${p1.orders.total} orders, ${pages} pages): every order exactly once, none dropped`,
    p1.orders.total > 500 && refs.length === p1.orders.total && new Set(refs).size === refs.length && p1.stats.total === p1.orders.total, `${refs.length} / ${p1.orders.total}`);
}

// ── 5f. Performance (W1): same results, memoised days, settled-hour balance ──
console.log("\n5f. Performance without changing a result (W1)");
{
  const E = await import("../src/lib/brandSimulation.js");
  const { getSettingsTimeline } = await import("../src/lib/services/brandSimSettingsService.js");
  const { dayParams } = await import("../src/lib/brandSimTimeline.js");
  const H = HOUR_MS;
  const prods = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
  // the previous implementation, kept as the oracle: forEachSimulatedOrder + simulatedOrderRef, sorted by ISO time then reference
  const oracle = (seed, a) => { const out = []; E.forEachSimulatedOrder(seed, a, (o) => { const { ref, hash } = E.simulatedOrderRef(seed, o.day, o.index);
    out.push({ ref, at: new Date(o.at).toISOString(), status: o.status, product: prods[hash % prods.length], money: E.simOrderMoney(o.status, a.price) }); });
    return out.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.ref < y.ref ? -1 : 1)); };
  const pub = (l) => JSON.stringify(l.map(({ atMs: _atMs, ...o }) => o));
  const now = Date.UTC(2026, 9, 28, 15, 20), live = E.floorHour(now);
  const configs = [["2 h / 48 h", { ...SIM, dailyVolumeMin: 300, dailyVolumeMax: 900 }], ["0.5 h / 10 h", { ...SIM, confirmationDelayHours: 0.5, deliveryDelayHours: 10 }],
    ["0 / 0", { ...SIM, confirmationDelayHours: 0, deliveryDelayHours: 0 }], ["24 h / 20 d", { ...SIM, confirmationDelayHours: 24, deliveryDelayHours: 480 }]];
  for (const [label, sim] of configs) {
    const counted = hoursBetween(now - 400 * DAY_MS - (now % H), live);
    for (const k of ["24h", "7d", "30d"]) {
      const from = E.windowBuckets(k, now).from;
      const a = { fromMs: from, nowMs: now, countedHours: counted, liveHour: live, sim, price: 299 };
      E.clearSimulationCache();
      const cold = E.simulatedOrders("acc-w1", { ...a, products: prods }), warm = E.simulatedOrders("acc-w1", { ...a, products: prods });
      const want = pub(oracle("acc-w1", a));
      // balance: settled SUM + hours before the window + the window's delivered — exactly as the service splits it
      const rows = E.buildHourRows("acc-w1", "acc-w1", counted, sim);
      const maxDelay = Math.max(sim.confirmationDelayHours, sim.deliveryDelayHours);
      const split = E.settledHoursBefore(now, from, maxDelay); // the service's rule: a whole hour, ≤ the window start, settled
      const settled = rows.filter((r) => r.hourStart.getTime() < split).reduce((x, r) => x + r.delivered, 0);
      const fast = settled + E.deliveredInRows("acc-w1", { rows: rows.filter((r) => r.hourStart.getTime() >= split && r.hourStart.getTime() < from), nowMs: now, sim, beforeMs: from })
        + E.ordersStats(cold, now, k, 299).byStatus.delivered;
      const slow = E.simulatedBalance("acc-w1", { nowMs: now, countedHours: counted, liveHour: live, sim, price: 299 });
      ok(`${label} · ${k}: order list identical to the previous implementation (cold and warm memo); balance identical to the full order-level recount`,
        pub(cold) === want && pub(warm) === want && E.simulatedBalanceOf(fast, 299).balance === slow.balance && fast === slow.delivered
        && split % H === 0 && split <= from && split <= E.floorHour(now - H - maxDelay * H), JSON.stringify([fast, slow.delivered, split, from]));
    }
  }

  // memo isolation and invalidation
  E.clearSimulationCache();
  const day = Date.UTC(2026, 9, 20);
  const a1 = E.simulatedDayOrders("acc-one", day, SIM), a2 = E.simulatedDayOrders("acc-two", day, SIM);
  ok("memo never shares a day between two brands (keyed by the access seed): different references and positions",
    a1 !== a2 && a1[0].ref.slice(4, 8) !== a2[0].ref.slice(4, 8) && E.simulationCacheStats().days === 2);
  const changed = { ...SIM, dailyVolumeMin: 500, dailyVolumeMax: 500 };
  const b1 = E.simulatedDayOrders("acc-one", day, changed);
  E.clearSimulationCache();
  ok("a settings change (volume / distribution) gives a new memo key: the result equals a fresh computation, never the old cached day",
    b1 !== a1 && b1.length === 500 && JSON.stringify(b1) === JSON.stringify(E.simulatedDayOrders("acc-one", day, changed)));
  const live2 = Date.UTC(2026, 9, 28, 15), counted2 = hoursBetween(Date.UTC(2026, 9, 27), live2);
  const lists = [5, 25, 59].map((m) => E.simulatedOrders("acc-live", { fromMs: Date.UTC(2026, 9, 27), nowMs: live2 + m * 60000, countedHours: counted2, liveHour: live2, sim: { ...SIM, dailyVolumeMin: 900, dailyVolumeMax: 900 }, price: 299 }));
  E.clearSimulationCache();
  const fresh = [5, 25, 59].map((m) => E.simulatedOrders("acc-live", { fromMs: Date.UTC(2026, 9, 27), nowMs: live2 + m * 60000, countedHours: counted2, liveHour: live2, sim: { ...SIM, dailyVolumeMin: 900, dailyVolumeMax: 900 }, price: 299 }));
  ok("live hour keeps moving with the memo: the list grows minute by minute and equals a fresh computation each time",
    lists[0].length < lists[1].length && lists[1].length < lists[2].length && lists.every((l, i) => JSON.stringify(l) === JSON.stringify(fresh[i])));
  E.clearSimulationCache();
  for (let d = 0; d < 400; d++) E.simulatedDayOrders("acc-big", Date.UTC(2025, 0, 1) + d * DAY_MS, { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 });
  ok(`memo is bounded (≤ ${E.SIM_DAY_CACHE_MAX_ORDERS.toLocaleString("en")} orders, least recently used dropped first)`, E.simulationCacheStats().orders <= E.SIM_DAY_CACHE_MAX_ORDERS && E.simulationCacheStats().days === 300);
  E.clearSimulationCache();

  // service: 130 days of stored history, every window — balance = full order-level recount; 1 SUM + 1 bounded row read
  const { db, accessId } = await activeAccessDb({ strict: true, config: { ...CONFIG, packages: [{ ...CONFIG.packages[0], simulatedSellingPrice: 299 }] }, activateAt: new Date(T0.getTime() - 130 * DAY_MS) });
  const acc = () => db._tables.brandAccess.find((r) => r.id === accessId);
  for (let i = 0; i < 4 && (await materializeAccessSimulation(acc(), { db, now: T0 })).pending; i++);
  const timeline = await getSettingsTimeline(db, { now: T0 });
  const allCounted = db._tables.brandSimHour.filter((r) => r.accessId === accessId && r.created > 0 && r.hourStart.getTime() < T0.getTime()).map((r) => r.hourStart.getTime());
  const want = E.simulatedBalance(accessId, { nowMs: T0.getTime(), countedHours: allCounted, liveHour: E.floorHour(T0.getTime()), sim: (d) => dayParams(timeline, d), price: 299 });
  for (const k of ["24h", "7d", "30d"]) {
    const before = db._stats.log.length;
    const dash = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: k });
    const calls = db._stats.log.slice(before);
    const adm = await getAdminSimulationDashboard(accessId, { db, now: T0, window: k });
    ok(`service ${k}: balance = full order-level recount over ${allCounted.length} stored hours; brand_sim_hours read with 1 SUM + 1 bounded query; admin identical`,
      dash.finance.balance === want.balance && calls.filter((c) => c === "brandSimHour.aggregate").length === 1 && calls.filter((c) => c === "brandSimHour.findMany").length === 1
      && JSON.stringify(adm.stats) === JSON.stringify(dash.stats) && adm.finance.balance === dash.finance.balance && !("atMs" in dash.recent[0]) && !("atMs" in dash.orders.items[0]),
      JSON.stringify([dash.finance.balance, want.balance]));
  }
}

// ── 5g. "See all" frozen at its asOf instant (W3) ─────────────────────────────
console.log("\n5g. Stable 'see all' pagination: frozen asOf (W3)");
{
  const { SIM_AS_OF_MAX_AGE_MS } = await import("../src/lib/brandRouteHandlers.js");
  const HV = { ...CONFIG, simulation: { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 }, packages: [{ ...CONFIG.packages[0], simulatedSellingPrice: 299 }] };
  // two affiliates, two brands, same database
  const db = makeBrandFakeDb({ strict: true, affiliates: [{ id: "a1", username: "amina" }, { id: "a2", username: "karim" }], products: PRODUCTS, settings: { [BRAND_TERMS_SETTING_ID]: TERMS } });
  const act = new Date(T0.getTime() - 3 * DAY_MS);
  await saveBrandConfig(HV, { db, actorId: "admin-1", now: new Date(act.getTime() - DAY_MS) });
  for (const [aff, req] of [["a1", "req-00000001"], ["a2", "req-00000002"]]) {
    const r = await requestBrandAccess(aff, { productIds: PICK, packageId: "p1", brandName: `Marque ${aff}`, termsVersion: 1, acceptTerms: true, clientRequestId: req }, { db, now: act });
    await payAndAccept(db, aff, r.id, { now: act });
  }
  let clock = T0.getTime();
  const h = affiliateBrandHandlers({ db, now: () => new Date(clock) });
  const get = async (aff, q) => { const res = await h.dashboard(new Request(`http://x/api/affiliate/brand/dashboard?${q}`), {}, { affiliateId: aff }); return { status: res.status, body: await res.json() }; };

  for (const [label, start, win] of [["24 h", T0.getTime(), "24h"], ["7 d across Casablanca midnight", Date.parse("2026-10-27T22:50:00Z"), "7d"]]) {
    clock = start;
    const p1 = (await get("a1", `window=${win}`)).body;
    const asOf = p1.orders.asOf, total = p1.orders.total, pages = Math.ceil(total / p1.orders.pageSize);
    // reference: every page computed at the same instant, without time passing
    const ref = [...p1.orders.items.map((o) => o.ref)];
    for (let n = 2; n <= pages; n++) ref.push(...(await get("a1", `window=${win}&page=${n}&asOf=${encodeURIComponent(asOf)}`)).body.orders.items.map((o) => o.ref));
    // the same pages while time passes (≤ 25 min per page, < 20 h in all: inside the 24 h asOf limit; crosses hours, and Casablanca midnight for the 7 d case)
    const step = Math.min(25 * 60000, Math.floor((20 * HOUR_MS) / Math.max(1, pages - 1)));
    const got = [...p1.orders.items.map((o) => o.ref)], seenAsOf = new Set([asOf]), totals = new Set([total]); let latest = 0;
    for (let n = 2; n <= pages; n++) {
      clock = start + (n - 1) * step;
      const r = (await get("a1", `window=${win}&page=${n}&asOf=${encodeURIComponent(asOf)}`)).body.orders;
      got.push(...r.items.map((o) => o.ref)); seenAsOf.add(r.asOf); totals.add(r.total);
      for (const o of r.items) latest = Math.max(latest, Date.parse(o.at));
    }
    clock = start + pages * step;
    const liveNow = (await get("a1", `window=${win}`)).body.orders;
    ok(`${label} at 1000/day (${total} orders, ${pages} pages, ${((pages - 1) * step / HOUR_MS).toFixed(1)} h passing): every page uses the same asOf; same total; no order skipped or repeated; nothing after asOf`,
      seenAsOf.size === 1 && totals.size === 1 && got.length === total && new Set(got).size === total && JSON.stringify(got) === JSON.stringify(ref) && latest <= Date.parse(asOf),
      JSON.stringify([got.length, total, seenAsOf.size, totals.size]));
    ok(`${label}: the live dashboard is not frozen (a request without asOf moves on: new asOf, list keeps changing)`,
      liveNow.asOf !== asOf && Date.parse(liveNow.asOf) === clock && liveNow.items[0].ref !== p1.orders.items[0].ref);
  }

  clock = T0.getTime();
  const own = (await get("a1", "window=24h")).body.orders, other = (await get("a2", `window=24h&page=2&asOf=${encodeURIComponent(own.asOf)}`)).body.orders;
  ok("another affiliate sending a1's asOf only gets ITS OWN brand's orders (asOf fixes a time, never a brand)",
    other.items.length > 0 && other.items.every((o) => o.ref.slice(4, 8) !== own.items[0].ref.slice(4, 8)) && !other.items.some((o) => own.items.some((x) => x.ref === o.ref)));
  const bad = async (v) => { const r = await get("a1", `window=24h&page=2&asOf=${encodeURIComponent(v)}`); return r.status === 400 && r.body.code === "INVALID_AS_OF"; };
  ok("asOf validated: malformed, date-only, epoch number, future, older than 24 h → 400 INVALID_AS_OF",
    await bad("abc") && await bad("2026-10-28") && await bad(String(T0.getTime())) && await bad(new Date(T0.getTime() + 1000).toISOString())
    && await bad(new Date(T0.getTime() - SIM_AS_OF_MAX_AGE_MS - 1).toISOString()));
  const okAsOf = new Date(T0.getTime() - 3 * HOUR_MS).toISOString(), okRes = await get("a1", `window=24h&asOf=${encodeURIComponent(okAsOf)}`);
  ok("a valid asOf (≤ 24 h old) is used as given and echoed", okRes.status === 200 && okRes.body.orders.asOf === okAsOf && okRes.body.orders.items.every((o) => Date.parse(o.at) <= Date.parse(okAsOf)));
}

// ── 5h. Final hardening: W1 re-audit, cache, W3 list guard, W4 boundaries, asOf clock ──
console.log("\n5h. Final hardening (W1 re-audit vs uncached recount, cache, W3 list guard, W4 boundaries, asOf clock)");
{
  const E = await import("../src/lib/brandSimulation.js");
  const { getSettingsTimeline } = await import("../src/lib/services/brandSimSettingsService.js");
  const { dayParams } = await import("../src/lib/brandSimTimeline.js");
  const { adminBrandHandlers, SIM_AS_OF_MAX_AGE_MS } = await import("../src/lib/brandRouteHandlers.js");
  const H = HOUR_MS, MIN = 60_000;
  const priced = (cfg, price) => ({ ...cfg, packages: [{ ...cfg.packages[0], simulatedSellingPrice: price }] });
  const closeAccess = async (db, id, at) => (await adminBrandHandlers({ db, now: () => at }).actOnAccess(
    new Request(`http://x/api/admin/brand/accesses/${id}`, { method: "POST", body: JSON.stringify({ action: "close", reason: "Fin de la formation" }) }),
    { params: Promise.resolve({ id }) }, { id: "admin-1", role: "ADMIN" })).status;
  const pick = (aff, req) => ({ productIds: PICK, packageId: "p1", brandName: `Marque ${aff}`, termsVersion: 1, acceptTerms: true, clientRequestId: req });
  const casaDate = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const casaClock = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Casablanca", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));

  // ── W1 re-audit: ≥ 1 year, 5 settings versions, two brands (299 / 49.9 MAD), one closed — vs the UNCACHED full recount
  const V = [ // [days before T0, simulation] — whole-hour delays (the admin form accepts integers only)
    [372, { ...SIM, startDelayHours: 0, dailyVolumeMin: 120, dailyVolumeMax: 180, confirmationDelayHours: 2, deliveryDelayHours: 48 }],
    [300, { ...SIM, startDelayHours: 0, dailyVolumeMin: 60, dailyVolumeMax: 90, confirmationDelayHours: 0, deliveryDelayHours: 0, distribution: { delivered: 70, refused: 5, returned: 5, noResponse: 10, cancelled: 10 } }],
    [210, { ...SIM, startDelayHours: 0, dailyVolumeMin: 150, dailyVolumeMax: 200, confirmationDelayHours: 24, deliveryDelayHours: 240 }],
    [120, { ...SIM, startDelayHours: 0, dailyVolumeMin: 40, dailyVolumeMax: 200, confirmationDelayHours: 1, deliveryDelayHours: 10, distribution: { delivered: 40, refused: 20, returned: 10, noResponse: 20, cancelled: 10 } }],
    [25, { ...SIM, startDelayHours: 0, dailyVolumeMin: 100, dailyVolumeMax: 160, confirmationDelayHours: 6, deliveryDelayHours: 72 }],
  ];
  const at = (days, extra = 0) => new Date(T0.getTime() - days * DAY_MS + extra);
  const db = makeBrandFakeDb({ strict: true, affiliates: [{ id: "a1", username: "amina" }, { id: "a2", username: "karim" }], products: PRODUCTS, settings: { [BRAND_TERMS_SETTING_ID]: TERMS } });
  await saveBrandConfig(priced({ ...CONFIG, simulation: V[0][1] }, 299), { db, actorId: "admin-1", now: at(V[0][0]) });
  const r1 = await requestBrandAccess("a1", pick("a1", "req-00000001"), { db, now: at(371) });
  await payAndAccept(db, "a1", r1.id, { now: at(371) });
  await saveBrandConfig(priced({ ...CONFIG, simulation: V[0][1] }, 49.9), { db, actorId: "admin-1", now: at(371, MIN) });
  const r2 = await requestBrandAccess("a2", pick("a2", "req-00000002"), { db, now: at(371, 2 * MIN) });
  await payAndAccept(db, "a2", r2.id, { now: at(371, 2 * MIN) });
  const accRow = (id) => db._tables.brandAccess.find((r) => r.id === id);
  const catchUp = async (now) => { for (const id of [r1.id, r2.id]) await materializeAccessSimulation(accRow(id), { db, now, maxDays: 400 }); };
  for (const [days, sim] of V.slice(1)) { await catchUp(at(days)); await saveBrandConfig(priced({ ...CONFIG, simulation: sim }, 49.9), { db, actorId: "admin-1", now: at(days) }); }
  const closedAt = at(10, 17 * MIN);
  await catchUp(closedAt);
  const closeStatus = await closeAccess(db, r2.id, closedAt);
  await catchUp(T0);
  const timeline = await getSettingsTimeline(db, { now: T0 });
  const simFor = (d) => dayParams(timeline, d);
  const stored = (id, before) => db._tables.brandSimHour.filter((r) => r.accessId === id && r.created > 0 && r.hourStart.getTime() < before).map((r) => r.hourStart.getTime());
  const firstStored = Math.min(...stored(r1.id, T0.getTime()));
  ok(`W1 setup: ${Math.floor((T0.getTime() - firstStored) / DAY_MS)} days of stored history, ${timeline.length} settings versions (delays 2/48, 0/0, 24/240, 1/10, 6/72), brand 2 closed (HTTP ${closeStatus})`,
    T0.getTime() - firstStored >= 365 * DAY_MS && timeline.filter((v) => v.enabled).length >= 5 && closeStatus === 200 && accRow(r2.id).status === "CLOSED");

  // the oracle: uncached (memo cleared, generator only), every stored counted hour < anchor + the live hour of an active brand
  const oracleBalance = (id, anchor, closed, price) => { E.clearSimulationCache();
    return E.simulatedBalance(id, { nowMs: anchor, countedHours: stored(id, anchor), liveHour: closed ? null : E.floorHour(anchor), sim: simFor, price }); };
  const oracleWindow = (id, anchor, closed, k) => {
    const byStatus = Object.fromEntries(SIM_STATUSES.map((x) => [x, 0])); let total = 0;
    E.forEachSimulatedOrder(id, { fromMs: E.windowBuckets(k, anchor).from, nowMs: anchor, countedHours: stored(id, anchor), liveHour: closed ? null : E.floorHour(anchor), sim: simFor },
      (o) => { total++; byStatus[o.status]++; });
    return { total, byStatus };
  };
  const audit = async (aff, id, price, anchors) => {
    const bad = []; let checks = 0;
    for (const anchor of anchors) {
      const closed = id === r2.id, eff = closed ? Math.min(anchor, closedAt.getTime()) : anchor;
      const bal = oracleBalance(id, eff, closed, price);
      for (const k of ["24h", "7d", "30d"]) {
        const w = oracleWindow(id, eff, closed, k);
        for (const mode of ["cold", "warm"]) {
          if (mode === "cold") E.clearSimulationCache();
          const d = await getAffiliateSimulationDashboard(aff, { db, now: new Date(anchor), window: k });
          const a = await getAdminSimulationDashboard(id, { db, now: new Date(anchor), window: k });
          checks++;
          const okOne = d.finance.balance === bal.balance && d.finance.price === price && d.stats.total === w.total && d.orders.total === w.total
            && SIM_STATUSES.every((x) => d.stats.byStatus[x] === w.byStatus[x])
            && JSON.stringify(a.stats) === JSON.stringify(d.stats) && JSON.stringify(a.finance) === JSON.stringify(d.finance);
          if (!okOne) bad.push(`${new Date(anchor).toISOString()} ${k} ${mode}: bal ${d.finance.balance}/${bal.balance} total ${d.stats.total}/${w.total}`);
        }
      }
    }
    return { bad, checks };
  };
  const midnight = Date.parse("2026-10-24T23:00:00Z"); // Casablanca 00:00 (UTC+1)
  const ramadan = [Date.parse("2026-02-15T02:00:00Z"), Date.parse("2026-03-22T02:00:00Z")];
  const past = [midnight - MIN, midnight + MIN, ...ramadan.flatMap((c) => [c - H, c - MIN, c + MIN, c + H])];
  const live = Array.from({ length: 11 }, (_, i) => T0.getTime() + i * MIN);
  const A1 = await audit("a1", r1.id, 299, [...live, ...past]);
  ok(`W1 brand 1 (299 MAD): ${A1.checks} dashboards (live T0…T0+10 min, Casablanca midnight ±1 min, both 2026 Ramadan clock changes ±1 min/±1 h; 24h/7d/30d; cold + warm memo) — balance, total, every status count and orders.total = uncached full recount; admin = affiliate`,
    A1.bad.length === 0, A1.bad.slice(0, 3).join(" | "));
  const A2 = await audit("a2", r2.id, 49.9, [T0.getTime(), ...past]);
  const d2 = await getAffiliateSimulationDashboard("a2", { db, now: T0, window: "30d" });
  ok(`W1 brand 2 (CLOSED, 49.9 MAD → net −15.1 per delivered order): ${A2.checks} dashboards, frozen at the closure — = uncached full recount; admin = affiliate; balance negative`,
    A2.bad.length === 0 && d2.readOnly === true && d2.finance.balance < 0 && d2.finance.balance === Math.round(oracleBalance(r2.id, closedAt.getTime(), true, 49.9).delivered * -1510) / 100,
    A2.bad.slice(0, 3).join(" | "));
  const d1 = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "30d" });
  const refs1 = new Set(d1.orders.items.map((o) => o.ref));
  ok("W1 two brands in one database never share a result: different references (brand tags), prices, balances; each equals its own recount",
    d1.orders.items.every((o) => o.ref.slice(4, 8) !== d2.orders.items[0].ref.slice(4, 8)) && !d2.orders.items.some((o) => refs1.has(o.ref))
    && d1.finance.price === 299 && d2.finance.price === 49.9 && d1.finance.balance !== d2.finance.balance && d1.finance.balance > 0);

  // ── W1 cache: key, isolation, invalidation, bound, live hour
  const day = Date.UTC(2026, 9, 20);
  const fresh = (seed, sim) => { E.clearSimulationCache(); const r = JSON.stringify(E.simulatedDayOrders(seed, day, sim)); E.clearSimulationCache(); return r; };
  const s50 = { ...SIM, dailyVolumeMin: 50, dailyVolumeMax: 50 }, s50s = { ...SIM, dailyVolumeMin: "50", dailyVolumeMax: "50" };
  const dNull = { ...SIM, distribution: { ...SIM.distribution, returned: null } }, dUndef = { ...SIM, distribution: { ...SIM.distribution, returned: undefined } };
  const want = [s50, s50s, dNull, dUndef].map((s) => fresh("acc-k", s));
  const got = [s50, s50s, dNull, dUndef].map((s) => E.simulatedDayOrders("acc-k", day, s));
  ok("cache key is typed: 50 vs \"50\" and null vs undefined are 4 distinct entries; each cached list equals a fresh computation",
    E.simulationCacheStats().days === 4 && new Set(got).size === 4 && got.every((g, i) => JSON.stringify(g) === want[i]));
  E.clearSimulationCache();
  const pA = E.simulatedDayOrders("acc-A", day, SIM), pB = E.simulatedDayOrders("acc-B", day, SIM), pA2 = E.simulatedDayOrders("acc-A", day, SIM);
  ok("cache isolated per brand: same day and settings, two access seeds → 2 entries; each equals its own fresh list; no shared reference",
    E.simulationCacheStats().days === 2 && pA2 === pA && JSON.stringify(pA) === fresh("acc-A", SIM) && JSON.stringify(pB) === fresh("acc-B", SIM)
    && !pA.some((o) => pB.some((x) => x.ref === o.ref)));
  E.clearSimulationCache();
  const dist2 = { ...SIM, distribution: { delivered: 10, refused: 40, returned: 10, noResponse: 20, cancelled: 20 } };
  const c1 = E.simulatedDayOrders("acc-C", day, SIM), c2 = E.simulatedDayOrders("acc-C", day, dist2), c3 = E.simulatedDayOrders("acc-C", day, SIM);
  ok("a settings change gives a new entry (never the stale day); switching back reuses the right entry; all equal fresh computations",
    E.simulationCacheStats().days === 2 && c1 !== c2 && c3 === c1 && JSON.stringify(c2) === fresh("acc-C", dist2) && JSON.stringify(c1) === fresh("acc-C", SIM)
    && c2.filter((o) => o.outcome === "refused").length > c1.filter((o) => o.outcome === "refused").length);
  E.clearSimulationCache();
  const big = { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 };
  for (let d = 0; d < 320; d++) E.simulatedDayOrders("acc-big", Date.UTC(2025, 0, 1) + d * DAY_MS, big);
  const st = E.simulationCacheStats();
  const evicted = Date.UTC(2025, 0, 1), recent = Date.UTC(2025, 0, 1) + 319 * DAY_MS;
  const afterEvict = JSON.stringify(E.simulatedDayOrders("acc-big", evicted, big)), afterRecent = JSON.stringify(E.simulatedDayOrders("acc-big", recent, big));
  E.clearSimulationCache();
  const freshEvicted = JSON.stringify(E.simulatedDayOrders("acc-big", evicted, big)), freshRecent = JSON.stringify(E.simulatedDayOrders("acc-big", recent, big));
  ok(`cache bounded after 320,000 orders: ${st.orders.toLocaleString("en")} ≤ ${E.SIM_DAY_CACHE_MAX_ORDERS.toLocaleString("en")} kept; an evicted day and a kept day both equal fresh computations`,
    st.orders <= E.SIM_DAY_CACHE_MAX_ORDERS && st.days < 320 && afterEvict === freshEvicted && afterRecent === freshRecent);
  E.clearSimulationCache();
  const lh = Date.UTC(2026, 9, 28, 9), ch = hoursBetween(Date.UTC(2026, 9, 27), lh), simV = { ...SIM, dailyVolumeMin: 900, dailyVolumeMax: 900 };
  const listAt = (nowMs, counted, liveH) => E.simulatedOrders("acc-L", { fromMs: lh, nowMs, countedHours: counted, liveHour: liveH, sim: simV, price: 299 });
  const L1 = listAt(lh + 50 * MIN, ch, lh), L2 = listAt(lh + 3 * H + 50 * MIN, [...ch, lh, lh + H, lh + 2 * H], lh + 3 * H);
  E.clearSimulationCache();
  const F1 = listAt(lh + 50 * MIN, ch, lh), F2 = listAt(lh + 3 * H + 50 * MIN, [...ch, lh, lh + H, lh + 2 * H], lh + 3 * H);
  const inL1 = new Set(L1.map((o) => o.ref)), later = L2.filter((o) => inL1.has(o.ref));
  ok("live hour is never cached: statuses and money follow `now` (pending at 50 min, no longer pending 3 h later), each list = a fresh computation",
    L1.length > 0 && L1.every((o) => o.status === "pending" && o.money.kind === "expected") && later.length === L1.length && later.every((o) => o.status !== "pending")
    && JSON.stringify(L1) === JSON.stringify(F1) && JSON.stringify(L2) === JSON.stringify(F2));

  // ── W3: "see all" list identity guard (handler level, controllable clock, two brands)
  const W3CFG = priced({ ...CONFIG, simulation: { ...SIM, dailyVolumeMin: 300, dailyVolumeMax: 300 } }, 299);
  const start = Date.parse("2026-10-27T22:40:00Z"); // Casablanca 23:40 — the pages cross Casablanca midnight (23:00Z) and clock hours
  const w3 = async () => {
    const wdb = makeBrandFakeDb({ strict: true, affiliates: [{ id: "a1", username: "amina" }, { id: "a2", username: "karim" }], products: PRODUCTS, settings: { [BRAND_TERMS_SETTING_ID]: TERMS } });
    const act = new Date(start - 3 * DAY_MS);
    await saveBrandConfig(W3CFG, { db: wdb, actorId: "admin-1", now: new Date(act.getTime() - DAY_MS) });
    const ids = {};
    for (const [aff, req] of [["a1", "req-00000001"], ["a2", "req-00000002"]]) {
      const r = await requestBrandAccess(aff, pick(aff, req), { db: wdb, now: act }); await payAndAccept(wdb, aff, r.id, { now: act }); ids[aff] = r.id;
    }
    const env = { db: wdb, ids, clock: start };
    const h = affiliateBrandHandlers({ db: wdb, now: () => new Date(env.clock) });
    env.get = async (aff, q) => { const res = await h.dashboard(new Request(`http://x/api/affiliate/brand/dashboard?${q}`), {}, { affiliateId: aff }); return { status: res.status, body: await res.json() }; };
    return env;
  };
  const q = (win, page, asOf, list) => `window=${win}&page=${page}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ""}${list !== undefined ? `&list=${list}` : ""}`;
  const sortedDesc = (items) => items.every((o, i) => i === 0 || Date.parse(items[i - 1].at) > Date.parse(o.at) || (items[i - 1].at === o.at && items[i - 1].ref < o.ref));
  {
    const env = await w3();
    for (const win of ["24h", "7d"]) {
      env.clock = start;
      const p1 = (await env.get("a1", q(win, 1))).body.orders;
      const pages = Math.ceil(p1.total / p1.pageSize);
      const ref = [...p1.items];
      for (let n = 2; n <= pages; n++) ref.push(...(await env.get("a1", q(win, n, p1.asOf, p1.listId))).body.orders.items);
      const got = [...p1.items], statuses = []; let sameNoList = true;
      for (let n = 2; n <= pages; n++) {
        env.clock = start + (n - 1) * 7 * MIN; // ≈ 7 min per page: crosses 23:00Z (Casablanca midnight) and several clock hours
        const r = await env.get("a1", q(win, n, p1.asOf, p1.listId)); statuses.push(r.status); got.push(...r.body.orders.items);
        if (n === 2) sameNoList = JSON.stringify((await env.get("a1", q(win, n, p1.asOf))).body.orders.items) === JSON.stringify(r.body.orders.items);
      }
      ok(`W3 ${win}: page 1 → asOf, window and a 16-hex listId; ${pages - 1} more pages with &asOf&list while ${((pages - 1) * 7 / 60).toFixed(1)} h pass (across Casablanca midnight) → all 200, identical to pages computed without time passing; sorted by time desc, reference tie-break; every order exactly once`,
        /^[0-9a-f]{16}$/.test(p1.listId) && p1.window === win && Date.parse(p1.asOf) === start && pages > 2 && statuses.every((s) => s === 200)
        && JSON.stringify(got) === JSON.stringify(ref) && got.length === p1.total && new Set(got.map((o) => o.ref)).size === p1.total && sortedDesc(got)
        && got.every((o) => Date.parse(o.at) <= start) && sameNoList && env.clock - start >= H, JSON.stringify([got.length, p1.total, statuses.filter((s) => s !== 200)]));
    }
    env.clock = start + 26 * 60 * MIN;
    const liveNow = (await env.get("a1", q("24h", 1))).body.orders;
    ok("W3: requests without asOf / list keep the live behaviour (new asOf = now, new list)", Date.parse(liveNow.asOf) === env.clock && /^[0-9a-f]{16}$/.test(liveNow.listId));
  }
  {
    const env = await w3();
    const p1 = (await env.get("a1", q("24h", 1))).body.orders;
    env.clock = start + 15 * MIN;
    await saveBrandConfig(priced({ ...CONFIG, simulation: { ...SIM, dailyVolumeMin: 500, dailyVolumeMax: 500 } }, 299), { db: env.db, actorId: "admin-1", now: new Date(env.clock) });
    const before = JSON.stringify((await (async () => { const e2 = await w3(); return (await e2.get("a1", q("24h", 2, p1.asOf, p1.listId))).body.orders.items; })()));
    const r = await env.get("a1", q("24h", 2, p1.asOf, p1.listId));
    ok("W3: a normal settings save (still enabled, other volume) between pages → still 200 and the same page (past days keep their settings)",
      r.status === 200 && JSON.stringify(r.body.orders.items) === before && r.body.orders.listId === p1.listId);
  }
  {
    const env = await w3();
    const p1 = (await env.get("a1", q("24h", 1))).body.orders;
    const liveOrders = p1.items.filter((o) => Date.parse(o.at) >= E.floorHour(start)).length;
    env.clock = start + 5 * MIN;
    const cs = await closeAccess(env.db, env.ids.a1, new Date(env.clock));
    const r = await env.get("a1", q("24h", 2, p1.asOf, p1.listId));
    const noList = await env.get("a1", q("24h", 2, p1.asOf));
    ok(`W3: the admin closes the brand between pages → 409 LIST_CHANGED (the closed view no longer has the ${liveOrders} live-hour orders), never a page of a different list`,
      liveOrders > 0 && cs === 200 && r.status === 409 && r.body.code === "LIST_CHANGED" && !("orders" in r.body) && noList.status === 200 && noList.body.orders.listId !== p1.listId);
  }
  {
    const env = await w3();
    const p1 = (await env.get("a1", q("24h", 1))).body.orders;
    env.clock = start + 3 * MIN; // same clock hour as asOf, after it
    await saveBrandConfig(priced({ ...CONFIG, simulation: { ...W3CFG.simulation, enabled: false } }, 299), { db: env.db, actorId: "admin-1", now: new Date(env.clock) });
    const r = await env.get("a1", q("24h", 2, p1.asOf, p1.listId));
    ok("W3: simulation disabled by a save inside asOf's clock hour (after asOf) → 409 LIST_CHANGED", r.status === 409 && r.body.code === "LIST_CHANGED");
  }
  {
    const env = await w3();
    env.clock = start;
    const p1 = (await env.get("a1", q("24h", 1))).body.orders;
    const st409 = async (aff, qs) => { const r = await env.get(aff, qs); return r.status === 409 && r.body.code === "LIST_CHANGED" && !("orders" in r.body); };
    const malformed = ["zz", p1.listId.toUpperCase().replace(/^[0-9]/, "A"), p1.listId.slice(0, 15), p1.listId + "0", "<script>"];
    let allMal = true; for (const m of malformed) allMal = allMal && await st409("a1", q("24h", 2, p1.asOf, encodeURIComponent(m)));
    ok("W3: malformed list (non-hex, upper case, 15 / 17 chars, markup) → 409 LIST_CHANGED", allMal);
    const a2 = await env.get("a2", q("24h", 2, p1.asOf, p1.listId));
    ok("W3: another affiliate sending a1's listId → 409, and the body carries no order data at all (no a1, no a2 data)",
      a2.status === 409 && a2.body.code === "LIST_CHANGED" && !JSON.stringify(a2.body).includes("SIM-"));
    ok("W3: the same list sent with another window → 409 LIST_CHANGED", await st409("a1", q("7d", 2, p1.asOf, p1.listId)) && await st409("a1", q("30d", 1, p1.asOf, p1.listId)));
    const withList = await env.get("a1", q("24h", 1, p1.asOf, p1.listId)), withoutList = await env.get("a1", q("24h", 1, p1.asOf));
    ok("W3: requests without list are unchanged (same body as the identical list-checked request)", withList.status === 200 && JSON.stringify(withList.body) === JSON.stringify(withoutList.body));
    const bad400 = async (v) => { const r = await env.get("a1", q("24h", 2, v, p1.listId)); return r.status === 400 && r.body.code === "INVALID_AS_OF"; };
    ok("W3: asOf malformed, date-only, epoch number, future, 24 h + 1 ms old → 400 INVALID_AS_OF (with a valid list too)",
      await bad400("abc") && await bad400("2026-10-27") && await bad400(String(start)) && await bad400(new Date(start + 1000).toISOString())
      && await bad400(new Date(start - SIM_AS_OF_MAX_AGE_MS - 1).toISOString()) && await bad400("2026-10-27T22:40:00+01:00"));
    const edge = new Date(start - SIM_AS_OF_MAX_AGE_MS).toISOString(), edgeRes = await env.get("a1", q("24h", 1, edge));
    ok("W3: an asOf exactly 24 h old is accepted and echoed", edgeRes.status === 200 && edgeRes.body.orders.asOf === edge);
  }

  // ── W4: exact rolling 24 h boundaries (generator-based, minute precision) ──
  {
    const seed = "acc-w4", simB = { ...SIM, dailyVolumeMin: 1000, dailyVolumeMax: 1000 }, d0 = Date.UTC(2026, 9, 20);
    const times = (dayMs) => simulateDay(seed, dayMs, simB).map((o) => dayMs + o.hour * H + o.minute * MIN);
    const t0 = times(d0), t1 = times(d0 + DAY_MS), s0 = new Set(t0), s1 = new Set(t1);
    const X = t0.find((t) => s0.has(t - MIN) && s0.has(t + MIN) && t - d0 > 3 * H && t % H !== 0);
    const counted = hoursBetween(d0 - DAY_MS, d0 + 2 * DAY_MS);
    const list = (asOf) => E.simulatedOrders(seed, { fromMs: E.windowBuckets("24h", asOf).from, nowMs: asOf, countedHours: counted.filter((h) => h < E.floorHour(asOf)), liveHour: E.floorHour(asOf), sim: simB });
    const LX = list(X + 24 * H), atsX = LX.map((o) => o.atMs);
    ok(`W4 lower bound INCLUSIVE: asOf = X + 24 h (X = ${new Date(X).toISOString()}) → from = X; every order at X is in, the order 1 min before is out, the order 1 min after is in`,
      E.windowBuckets("24h", X + 24 * H).from === X && atsX.filter((t) => t === X).length === t0.filter((t) => t === X).length && !atsX.includes(X - MIN) && atsX.includes(X + MIN) && Math.min(...atsX) === X);
    const Y = t1.find((t) => s1.has(t + MIN) && t % H !== 0 && t - (d0 + DAY_MS) > 3 * H);
    const LY = list(Y), atsY = LY.map((o) => o.atMs), bY = E.windowBuckets("24h", Y), stY = E.ordersStats(LY, Y, "24h");
    ok("W4 upper bound INCLUSIVE: asOf = Y (an order's minute) → Y is in, in the LAST bucket; the order 1 min after is out; buckets add up to the total",
      atsY.includes(Y) && E.bucketOf(bY.starts, Y) === bY.starts[23] && !atsY.includes(Y + MIN) && Math.max(...atsY) === Y
      && stY.buckets.reduce((a, b) => a + b.total, 0) === stY.total && stY.total === LY.length && stY.buckets.at(-1).total >= 1);
    const env = await w3();
    env.clock = start;
    const asOf = new Date(start - 3 * H + 17_000).toISOString();
    const r = (await env.get("a1", q("24h", 1, asOf))).body;
    ok("W4 service: stats.from = asOf − 24 h and stats.to = asOf exactly (non-aligned asOf); 24 buckets one hour apart from `from`; buckets add up to the total",
      r.stats.from === new Date(Date.parse(asOf) - 24 * H).toISOString() && r.stats.to === asOf && r.stats.buckets.length === 24
      && r.stats.buckets.every((b, i) => Date.parse(b.start) === Date.parse(r.stats.from) + i * H) && r.stats.buckets.reduce((a, b) => a + b.total, 0) === r.stats.total
      && r.orders.items.every((o) => Date.parse(o.at) >= Date.parse(r.stats.from) && Date.parse(o.at) <= Date.parse(asOf)));
    // 0 / 0 delays (every past order final at once) and a from inside a clock hour: no double count, no omission
    const z = await activeAccessDb({ strict: true, config: priced({ ...CONFIG, simulation: { ...SIM, confirmationDelayHours: 0, deliveryDelayHours: 0, dailyVolumeMin: 300, dailyVolumeMax: 300 } }, 299), activateAt: new Date(T0.getTime() - 40 * DAY_MS) });
    const zd = await getAffiliateSimulationDashboard("a1", { db: z.db, now: T0, window: "24h" });
    const ztl = await getSettingsTimeline(z.db, { now: T0 });
    E.clearSimulationCache();
    const zc = z.db._tables.brandSimHour.filter((x) => x.created > 0 && x.hourStart.getTime() < T0.getTime()).map((x) => x.hourStart.getTime());
    const zo = E.simulatedBalance(z.accessId, { nowMs: T0.getTime(), countedHours: zc, liveHour: E.floorHour(T0.getTime()), sim: (d) => dayParams(ztl, d), price: 299 });
    ok("W4 + W1: 0/0 delays, 24 h window starting inside a clock hour → service balance = uncached full recount", Date.parse(zd.stats.from) % H !== 0 && zd.finance.balance === zo.balance, JSON.stringify([zd.finance.balance, zo.balance]));
    // 7 d / 30 d unchanged: Casablanca midnights, consecutive local days, around both 2026 Ramadan clock changes
    const anchors = ramadan.flatMap((c) => [c - H, c - MIN, c + MIN, c + H, c + 2 * DAY_MS]);
    ok("W4 leaves 7 d / 30 d on Casablanca calendar days: every start is 00:00 in Casablanca, consecutive local dates, today included — around both 2026 Ramadan clock changes",
      anchors.every((t) => ["7d", "30d"].every((k) => { const b = E.windowBuckets(k, t);
        return b.starts.every((s) => casaClock(s) === "00:00") && b.starts.every((s, i) => i === 0 || Date.parse(casaDate(s)) - Date.parse(casaDate(b.starts[i - 1])) === DAY_MS)
          && casaDate(b.starts.at(-1)) === casaDate(t) && b.from === b.starts[0]; })));
  }

  // ── Audit fix: a "see all" asOf never dates the one-time settings-timeline reconstruction ──
  {
    const { db: cdb } = await activeAccessDb({ strict: true, activateAt: new Date(T0.getTime() - DAY_MS) });
    cdb._tables.brandSimSettingsVersion.length = 0; // first-ever timeline read (versions table empty), no audit trail
    cdb._tables.brandAuditLog.length = 0;
    const ch = affiliateBrandHandlers({ db: cdb, now: () => T0 });
    const asOf = new Date(T0.getTime() - 5 * H).toISOString();
    const res = await ch.dashboard(new Request(`http://x/api/affiliate/brand/dashboard?window=24h&page=2&asOf=${encodeURIComponent(asOf)}`), {}, { affiliateId: "a1" });
    const cur = cdb._tables.brandSimSettingsVersion.find((v) => v.source === "CURRENT_AT_RECONSTRUCTION");
    ok("asOf ≠ clock: the one-time timeline reconstruction is dated with the real clock (not the 5 h old asOf); the page still uses the asOf",
      res.status === 200 && cur && new Date(cur.effectiveFrom).getTime() === T0.getTime() && new Date(cur.effectiveFrom).toISOString() !== asOf
      && (await res.json()).orders.asOf === asOf, cur ? new Date(cur.effectiveFrom).toISOString() : "no version");
  }
}

// ── 6. Isolation from real commerce and the wallet ────────────────────────────
console.log("\n6. Isolation: no real order, commission, reward or wallet credit");
{
  // Strict DB: touching ANY table other than the brand ones throws and is logged.
  const { db } = await activeAccessDb({ strict: true });
  for (let d = 1; d <= 40; d += 3) {
    for (const w of ["24h", "7d", "30d"]) await getAffiliateSimulationDashboard("a1", { db, now: new Date(T0.getTime() + d * DAY_MS), window: w });
  }
  const rawSql = db._stats.log.filter((l) => l.startsWith("$executeRaw"));
  ok("the only raw SQL is the advisory transaction lock", rawSql.length > 0 && rawSql.every((l) => l.startsWith("$executeRaw:SELECT pg_advisory_xact_lock(") || l.startsWith("$executeRaw:SELECT pg_advisory_xact_lock_shared(")));
  const used = new Set(db._stats.log.filter((l) => !l.startsWith("$executeRaw")).map((l) => l.split(".")[0]));
  ok("only brand tables (+ brand-keyed notifications) were ever touched (config → request → proof → activation → 40 days of simulation)",
    !db._stats.log.some((l) => l.startsWith("FORBIDDEN")) && [...used].every((m) => BRAND_MODELS.includes(m) || SHARED_MODELS.includes(m)), [...used].join());
  ok("writes only to brand tables and brand notifications",
    db._stats.log.filter((l) => /\.(create|createMany|update|updateMany|upsert)$/.test(l))
      .every((l) => /^(brandSimHour|brandAccess|brandAuditLog|setting|brandSimSettingsVersion|brandAccessPeriod|brandPaymentProof|affiliateNotification)\./.test(l)));
  ok("the simulation itself writes only brand_sim_hours and the progress column", (() => {
    const i = db._stats.log.findIndex((l) => l.startsWith("brandSimHour."));
    return i > 0 && db._stats.log.slice(i).filter((l) => /\.(create|createMany|update|updateMany|upsert)$/.test(l)).every((l) => l === "brandSimHour.createMany" || l === "brandAccess.updateMany");
  })());
  ok("store products are only read (findMany), never written",
    db._stats.log.some((l) => l === "product.findMany") && db._stats.log.filter((l) => l.startsWith("product.")).every((l) => l === "product.findMany")
    && Object.keys(db.product).join() === "findMany");

  // Real wallet maths, on a ledger that counts every read: same balance before
  // and after a large amount of simulated activity, and the simulation never
  // reads or writes any wallet table.
  const touched = [];
  const counted = (name, obj) => new Proxy(obj, { get(t, p) { if (typeof p === "string") touched.push(`${name}.${p}`); return t[p]; } });
  const wallet = {
    affiliateOrder: counted("affiliateOrder", { aggregate: async () => ({ _sum: { commissionAmount: 420 } }) }),
    affiliate: counted("affiliate", { findUnique: async () => ({ bonusBalance: 30 }) }),
    affiliateSecurityDeposit: counted("affiliateSecurityDeposit", { aggregate: async () => ({ _sum: { amount: 200 } }) }),
    affiliatePayout: counted("affiliatePayout", { aggregate: async () => ({ _sum: { amount: 100 } }) }),
    affiliateBoosterPurchase: counted("affiliateBoosterPurchase", { aggregate: async () => ({ _sum: { price: 0 } }), findMany: async () => [] }),
    ugcEarning: counted("ugcEarning", { aggregate: async () => ({ _sum: { amount: 0 } }) }),
  };
  const before = await getAffiliateBalanceBreakdown("a1", wallet);
  touched.length = 0;
  const sim = await activeAccessDb({ strict: false });
  const combined = Object.assign(Object.create(null), sim.db, wallet); // brand + wallet tables on one client
  for (let d = 1; d <= 30; d += 2) await getAffiliateSimulationDashboard("a1", { db: combined, now: new Date(T0.getTime() + d * DAY_MS), window: "30d" });
  ok("the simulation never read or wrote a wallet table", touched.length === 0, touched.slice(0, 5).join());
  ok(`simulated hours were generated (${sim.db._tables.brandSimHour.length})`, sim.db._tables.brandSimHour.length > 600);
  const after = await getAffiliateBalanceBreakdown("a1", wallet);
  ok("wallet total / withdrawable / top-up identical before and after", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  const sources = getBalanceProviders().map((p) => p.source);
  ok("no balance provider reads brand data", sources.length > 0 && !sources.some((s) => /brand|sim/i.test(s)), sources.join());

  const files = [
    "../src/lib/brandProgram.js", "../src/lib/brandSimulation.js", "../src/lib/brandRouteHandlers.js",
    "../src/lib/services/brandProgramService.js", "../src/lib/services/brandAccessService.js", "../src/lib/services/brandSimulationService.js",
    "../src/lib/services/brandPaymentService.js", "../src/lib/services/brandSimSettingsService.js", "../src/lib/brandSimTimeline.js", "../src/lib/brandNotifications.js",
    "../scripts/brand-simulation-engine.mjs",
  ].map((f) => [f, read(f)]);
  const forbiddenImports = /from ['"][^'"]*(affiliateSystemService|orderService|orderController|fakeOrder|rewards|reward\w*Service|depositService|boosterService|ugcEarnings|balance\/)/;
  const forbiddenModels = /\.(order|orderItem|affiliateOrder|affiliatePayout|affiliateBoosterPurchase|boosterSimulation|rewardPoints\w*|rewardOrderAward|rewardRedemption|ugcEarning|fakeOrderConfig)\b/;
  ok("brand code imports no order / commission / Rewards / deposit / booster / UGC / wallet module",
    files.every(([, s]) => !forbiddenImports.test(s)), files.filter(([, s]) => forbiddenImports.test(s)).map(([f]) => f).join());
  ok("brand code references no real-commerce or wallet model", files.every(([, s]) => !forbiddenModels.test(s)), files.filter(([, s]) => forbiddenModels.test(s)).map(([f]) => f).join());
  const depositUses = files.flatMap(([, s]) => [...s.matchAll(/\.affiliateSecurityDeposit\.(\w+)/g)].map((m) => m[1]));
  ok("deposits are only READ (reference warnings: findMany), never written", depositUses.length === 1 && depositUses[0] === "findMany", depositUses.join());
  ok("Fake Orders Engine and order services unchanged by this feature (no brand reference)",
    !/brand/i.test(read("../src/lib/services/fakeOrderService.js") + read("../src/lib/fakeOrdersEngine.js") + read("../src/lib/services/orderService.js")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
