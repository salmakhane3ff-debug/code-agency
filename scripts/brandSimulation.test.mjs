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
  ok("delivered / refused / returned are 'confirmed' until the final delay", statusAt("delivered", 10, SIM) === "confirmed" && statusAt("refused", 47.9, SIM) === "confirmed");
  ok("…then their final outcome", statusAt("delivered", 48, SIM) === "delivered" && statusAt("returned", 60, SIM) === "returned");
  ok("zero delays → final outcome immediately", statusAt("refused", 0, { confirmationDelayHours: 0, deliveryDelayHours: 0 }) === "refused");
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
  await getAffiliateSimulationDashboard("a1", { db, now, window: "30d" });
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
  ok("each order: training reference, status, one of the selected products — no amount", a.every((o) => /^SIM-\d{4}-[0-9A-Z]{4}$/.test(o.ref)
    && SIM_STATUSES.includes(o.status) && prods.some((p) => p.id === o.product.id) && Object.keys(o).sort().join() === "at,product,ref,status"));
  ok("orders of uncounted (paused / not started) hours are never listed", recentSimulatedOrders("acc-x", { ...args, countedHours: [], liveHour: null }).length === 0);
  ok("limit respected", recentSimulatedOrders("acc-x", { ...args, limit: 3 }).length === 3);
  const { db } = await activeAccessDb({ strict: true, activateAt: new Date(T0.getTime() - 3 * DAY_MS) });
  const dash = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "24h" });
  ok("dashboard returns the latest simulated orders with the brand's products", Array.isArray(dash.recent) && dash.recent.length > 0
    && dash.recent.every((o) => PICK.includes(o.product.id) && !("amount" in o)) && dash.simulated === true);
  ok("…and the list is consistent with the window total", dash.recent.length <= dash.stats.total);
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
