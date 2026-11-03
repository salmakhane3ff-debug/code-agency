#!/usr/bin/env node
/**
 * scripts/brandHistory.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — PERMANENT, DETERMINISTIC simulated history.
 * Proves:
 *   • settings versions are reconstructed ONLY from what CONFIG_UPDATE audits
 *     prove; anything else is unverified, never generated, reported incomplete
 *   • every configuration save that changes a versioned setting (volume,
 *     distribution, display delays, enabled) appends a version; versions are
 *     append-only
 *   • results depend only on time: frequent or rare dashboard reads, the engine
 *     or a single late read all store exactly the same rows, across settings
 *     changes (one settings version per business day)
 *   • a CLOSED access is read-only and anchored at its closure; reopening
 *     starts a new period from now, the closed gap is never filled
 *   • generation runs in 7-day batches, at most 90 days per dashboard read,
 *     with progress tracked under a per-access advisory lock; the engine tick
 *     catches up the rest; concurrent runs never duplicate an hour
 * Run: node scripts/brandHistory.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID, normalizeBrandConfig } from "../src/lib/brandProgram.js";
import { HOUR_MS, DAY_MS, floorHour, ceilHour, floorDay, simulateDay, countHour } from "../src/lib/brandSimulation.js";
import { dayParams, toTimeline, hourEnabled, versionedSettings, incompleteRanges, accessWindows } from "../src/lib/brandSimTimeline.js";
import { planReconstruction, getSettingsTimeline, accessLockKey } from "../src/lib/services/brandSimSettingsService.js";
import { requestBrandAccess, adminCloseAccess, adminReopenAccess } from "../src/lib/services/brandAccessService.js";
import {
  materializeAccessSimulation, getAffiliateSimulationDashboard, getAdminSimulationDashboard, runBrandSimulationTick,
  SIM_BATCH_DAYS, SIM_MAX_CATCHUP_DAYS,
} from "../src/lib/services/brandSimulationService.js";
import { saveBrandConfig } from "../src/lib/services/brandProgramService.js";
import { makeBrandFakeDb } from "./lib/brandFakeDb.mjs";
import { payAndAccept } from "./lib/brandProofKit.mjs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** Test values only — not product defaults. */
const SIM = { enabled: true, startDelayHours: 0, dailyVolumeMin: 8, dailyVolumeMax: 20, confirmationDelayHours: 2, deliveryDelayHours: 48,
  distribution: { delivered: 50, refused: 10, returned: 5, noResponse: 20, cancelled: 15 } };
const PRICING = { deliveryCost: 40, logisticsCost: 10, vatPercent: 20, productCount: 3, productIds: ["prod-1", "prod-2", "prod-3"],
  percentages: { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 10, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } } };
const CONFIG = (sim = SIM) => ({ enabled: true, packages: [{ id: "p1", name: "Formation", price: 1000, active: true, features: [], ...PRICING }], brandingOptions: [], simulation: sim,
  catalogProductIds: ["prod-1", "prod-2", "prod-3"] });
const PRODUCTS = ["prod-1", "prod-2", "prod-3"].map((id) => ({ id, title: `Produit ${id}` }));
const TERMS = { draft: { text: "T" }, published: { version: 1, text: "T", publishedAt: "2026-01-01T00:00:00Z" } };
const T0 = new Date("2026-10-01T10:20:00Z");
const at = (days, hours = 0) => new Date(T0.getTime() + days * DAY_MS + hours * HOUR_MS);
const rowsOf = (db) => db._tables.brandSimHour.map((r) => [new Date(r.hourStart).toISOString(), r.created, r.delivered, r.refused, r.returned, r.noResponse, r.cancelled].join()).sort();

/** Fresh platform; admin configures at `configAt`; affiliate requests + pays at `activateAt`. */
async function setup({ configAt = at(-1), activateAt = T0, sim = SIM, preexisting = null } = {}) {
  const settings = { [BRAND_TERMS_SETTING_ID]: TERMS, ...(preexisting ? { [BRAND_SETTING_ID]: preexisting } : {}) };
  const db = makeBrandFakeDb({ affiliates: [{ id: "a1", username: "amina" }], products: PRODUCTS, settings });
  if (!preexisting) await saveBrandConfig(CONFIG(sim), { db, actorId: "admin-1", now: configAt });
  const acc = await requestBrandAccess("a1", { productIds: ["prod-1", "prod-2", "prod-3"], packageId: "p1", brandName: "Ma Marque", termsVersion: 1, acceptTerms: true, clientRequestId: "req-00000001" }, { db, now: activateAt });
  await payAndAccept(db, "a1", acc.id, { now: activateAt });
  return { db, id: acc.id, access: () => db._tables.brandAccess.find((a) => a.id === acc.id) };
}

// ── 1. Reconstruction (pure) ──────────────────────────────────────────────────
console.log("\n1. Reconstruction from CONFIG_UPDATE audits only");
{
  const NOW = Date.parse("2026-10-28T00:00:00Z");
  const on = { simulation: SIM }, off = { simulation: { ...SIM, enabled: false } }, big = { simulation: { ...SIM, dailyVolumeMin: 50, dailyVolumeMax: 60 } };
  const A = (id, d, before, after) => ({ id, createdAt: new Date(`2026-10-${d}T00:00:00Z`), before, after });

  const never = planReconstruction([], null, NOW);
  ok("never configured → disabled since the beginning, verified", never.length === 1 && never[0].enabled === false && never[0].proven === true);
  const noAudit = planReconstruction([], on, NOW);
  ok("settings row but no audit → unverified until now, current state verified from now",
    noAudit.length === 2 && noAudit[0].proven === false && noAudit[1].proven === true && noAudit[1].effectiveFrom.getTime() === NOW && noAudit[1].enabled === true);
  const chain = planReconstruction([A("x1", "05", off, on), A("x2", "10", on, big)], big, NOW);
  ok("consistent chain starting disabled → every version verified, effective at its audit",
    chain.length === 3 && chain.every((v) => v.proven) && chain[1].auditId === "x1" && chain[2].effectiveFrom.toISOString() === "2026-10-10T00:00:00.000Z");
  const startedOn = planReconstruction([A("x1", "05", on, big)], big, NOW);
  ok("enabled before the first audit → that earlier period is unverified", startedOn[0].proven === false && startedOn[0].enabled === true && startedOn[1].proven === true);
  const broken = planReconstruction([A("x1", "05", off, on), A("x2", "10", big, off)], off, NOW);
  ok("an audit whose `before` contradicts the previous `after` → the gap is unverified", broken[1].proven === false && broken.at(-1).proven === true && broken.at(-1).auditId === "x2");
  const drift = planReconstruction([A("x1", "05", off, on)], big, NOW);
  ok("stored config differs from the last audit → unverified since it, current verified from now",
    drift.at(-2).proven === false && drift.at(-1).source === "CURRENT_AT_RECONSTRUCTION" && drift.at(-1).effectiveFrom.getTime() === NOW);
  const unreadable = planReconstruction([A("x1", "05", off, { packages: [] })], null, NOW);
  ok("an audit without a readable simulation snapshot → unverified from it", unreadable[1].proven === false);
  ok("only versioned settings are recorded (no start delay, no activeSince)", Object.keys(chain[1].settings).sort().join() === "confirmationDelayHours,dailyVolumeMax,dailyVolumeMin,deliveryDelayHours,distribution");
}

// ── 2. Unverified history is never generated ──────────────────────────────────
console.log("\n2. Pre-existing config without audit: unverified period reported, not generated");
{
  // A config stored before versioning existed (no audit) and an access already active.
  const pre = normalizeBrandConfig(CONFIG());
  const { db, id, access } = await setup({ preexisting: pre, activateAt: T0 });
  const firstLook = at(3);
  const d1 = await getAffiliateSimulationDashboard("a1", { db, now: firstLook, window: "7d" });
  ok("nothing generated before the reconstruction time (unprovable settings)", db._tables.brandSimHour.length === 0 && d1.stats.total === 0);
  ok("the unverified period is reported as incomplete", d1.incomplete.length === 1 && Date.parse(d1.incomplete[0].from) <= T0.getTime() + HOUR_MS
    && Date.parse(d1.incomplete[0].to) === floorHour(firstLook.getTime()), JSON.stringify(d1.incomplete)); // the live hour is not complete yet
  const versions = db._tables.brandSimSettingsVersion;
  ok("timeline: INITIAL_STATE unverified, CURRENT_AT_RECONSTRUCTION verified", versions.length === 2 && versions[0].proven === false && versions[1].source === "CURRENT_AT_RECONSTRUCTION");
  const d2 = await getAffiliateSimulationDashboard("a1", { db, now: at(5), window: "7d" });
  ok("generated from the reconstruction on", db._tables.brandSimHour.length > 0 && db._tables.brandSimHour.every((h) => new Date(h.hourStart).getTime() >= ceilHour(firstLook.getTime())));
  ok("the incomplete period stays reported (never back-filled)", d2.incomplete.length === 1 && d2.incomplete[0].from === d1.incomplete[0].from);
  ok("versions are append-only", /append-only/.test((await rejects(db.brandSimSettingsVersion.updateMany({ where: {}, data: { proven: true } })))?.message || "")
    && /append-only/.test((await rejects(db.brandSimSettingsVersion.deleteMany({ where: {} })))?.message || ""));
  ok("advisory lock key per access", accessLockKey(id) === `brand-sim:${id}` && access().status === "ACTIVE");
}

// ── 3. Versions from configuration saves ──────────────────────────────────────
console.log("\n3. Configuration saves append versions");
{
  const { db } = await setup();
  const n = db._tables.brandSimSettingsVersion.length;
  await saveBrandConfig({ ...CONFIG(), brandingOptions: [{ id: "o1", label: "Logo", description: "", active: true }] }, { db, actorId: "admin-1", now: at(1) });
  ok("a save that changes no versioned setting appends nothing", db._tables.brandSimSettingsVersion.length === n);
  await saveBrandConfig(CONFIG({ ...SIM, startDelayHours: 9 }), { db, actorId: "admin-1", now: at(1, 1) });
  ok("the start delay is not versioned (snapshotted per access instead)", db._tables.brandSimSettingsVersion.length === n);
  await saveBrandConfig(CONFIG({ ...SIM, deliveryDelayHours: 72 }), { db, actorId: "admin-1", now: at(2) });
  const v = db._tables.brandSimSettingsVersion.at(-1);
  ok("a display-delay change appends a verified version linked to its audit", db._tables.brandSimSettingsVersion.length === n + 1 && v.proven && v.settings.deliveryDelayHours === 72
    && db._tables.brandAuditLog.find((a) => a.id === v.auditId)?.action === "CONFIG_UPDATE" && new Date(v.effectiveFrom).getTime() === at(2).getTime());
  const tl = await getSettingsTimeline(db, { now: at(3) });
  ok("the timeline is sorted and complete", tl.length === n + 1 && tl.every((x, i) => i === 0 || tl[i - 1].effectiveFrom <= x.effectiveFrom));
}

// ── 4. Determinism: results depend only on time ───────────────────────────────
console.log("\n4. Determinism across reads and settings changes");
{
  const change = at(4, 7); // mid-day change of volume and distribution
  const sim2 = { ...SIM, dailyVolumeMin: 30, dailyVolumeMax: 40, distribution: { delivered: 0, refused: 0, returned: 0, noResponse: 100, cancelled: 0 } };
  const end = at(9);
  // A: read every 5 hours, the config changes in between.
  const A = await setup();
  for (let t = T0.getTime(); t < change.getTime(); t += 5 * HOUR_MS) await getAffiliateSimulationDashboard("a1", { db: A.db, now: new Date(t), window: "24h" });
  await saveBrandConfig(CONFIG(sim2), { db: A.db, actorId: "admin-1", now: change });
  for (let t = change.getTime(); t <= end.getTime(); t += 5 * HOUR_MS) await getAffiliateSimulationDashboard("a1", { db: A.db, now: new Date(t), window: "24h" });
  await materializeAccessSimulation(A.access(), { db: A.db, now: end });
  // B: nobody looks until the end.
  const B = await setup();
  await saveBrandConfig(CONFIG(sim2), { db: B.db, actorId: "admin-1", now: change });
  await getAffiliateSimulationDashboard("a1", { db: B.db, now: end, window: "30d" });
  // C: the engine alone.
  const C = await setup();
  await saveBrandConfig(CONFIG(sim2), { db: C.db, actorId: "admin-1", now: change });
  await runBrandSimulationTick({ db: C.db, now: end });
  ok("same access id in every scenario", A.id === B.id && B.id === C.id);
  ok("frequent reads, one late read and the engine store identical rows", rowsOf(A.db).join("|") === rowsOf(B.db).join("|") && rowsOf(B.db).join("|") === rowsOf(C.db).join("|"),
    `${rowsOf(A.db).length}/${rowsOf(B.db).length}/${rowsOf(C.db).length}`);
  const tl = await getSettingsTimeline(B.db, { now: end });
  const day = floorDay(change.getTime());
  ok("the day of the change keeps the parameters in force at its start", dayParams(tl, day).dailyVolumeMin === 8 && dayParams(tl, day + DAY_MS).dailyVolumeMin === 30);
  const expected = (h) => countHour(simulateDay(B.id, floorDay(h), dayParams(tl, h)), new Date(h).getUTCHours());
  ok("every stored hour = the generator with its day's settings version", B.db._tables.brandSimHour.every((r) => {
    const h = new Date(r.hourStart).getTime(); const e = expected(h); return e.created === r.created && e.noResponse === r.noResponse && e.delivered === r.delivered;
  }));
  const later = B.db._tables.brandSimHour.filter((r) => new Date(r.hourStart).getTime() >= day + DAY_MS);
  ok("the new distribution applies from the next day (100 % no response)", later.length > 0 && later.every((r) => r.created === r.noResponse));
  const done = (db) => rowsOf(db).filter((r) => Date.parse(r.split(",")[0]) < floorHour(end.getTime())).join("|");
  const before = done(B.db);
  await saveBrandConfig(CONFIG(SIM), { db: B.db, actorId: "admin-1", now: at(10) });
  await getAffiliateSimulationDashboard("a1", { db: B.db, now: at(12), window: "30d" });
  ok("a later change never rewrites earlier history", before.length > 0 && done(B.db) === before);
  const disabledDay = toTimeline([{ effectiveFrom: new Date(0), enabled: false, proven: true, settings: versionedSettings(SIM) },
    { effectiveFrom: new Date(day + 10 * HOUR_MS), enabled: true, proven: true, settings: versionedSettings(sim2) }]);
  ok("a day starting disabled uses the first runnable version of that day; disabled hours are not generated",
    dayParams(disabledDay, day).dailyVolumeMin === 30 && !hourEnabled(disabledDay, day + 9 * HOUR_MS) && hourEnabled(disabledDay, day + 10 * HOUR_MS));
}

// ── 5. Closed: read-only, anchored; reopen: new period, no backfill ───────────
console.log("\n5. Closure and reopening");
{
  const { db, id, access } = await setup();
  const closeAt = at(3, 0.5);
  await getAffiliateSimulationDashboard("a1", { db, now: at(2), window: "24h" });
  await adminCloseAccess(id, { reason: "Formation terminée" }, { db, actorId: "admin-1", now: closeAt });
  const c1 = await getAffiliateSimulationDashboard("a1", { db, now: at(4), window: "7d" });
  const c2 = await getAffiliateSimulationDashboard("a1", { db, now: at(20), window: "7d" });
  ok("closed dashboard is read-only and anchored at the closure", c1.readOnly === true && c1.status === "CLOSED" && c1.anchor === closeAt.toISOString() && c1.running === false);
  ok("the closed view never changes with time", JSON.stringify(c1.stats) === JSON.stringify(c2.stats) && JSON.stringify(c1.recent) === JSON.stringify(c2.recent));
  ok("hours up to the closure are complete; none at or after it", db._tables.brandSimHour.every((h) => new Date(h.hourStart).getTime() + HOUR_MS <= closeAt.getTime())
    && db._tables.brandSimHour.some((h) => new Date(h.hourStart).getTime() === floorHour(closeAt.getTime()) - HOUR_MS));
  const admin = await getAdminSimulationDashboard(id, { db, now: at(20), window: "7d" });
  ok("the admin sees the same closed history", JSON.stringify(admin.stats) === JSON.stringify(c1.stats));
  const stored = db._tables.brandSimHour.length;
  await runBrandSimulationTick({ db, now: at(25) });
  ok("the engine adds nothing to a closed access", db._tables.brandSimHour.length === stored);

  const reopenAt = at(30, 0.25);
  await adminReopenAccess(id, { reason: "Reprise demandée" }, { db, actorId: "admin-1", now: reopenAt });
  ok("reopened: ACTIVE again, closure cleared, a new REOPEN period", access().status === "ACTIVE" && access().closedAt === null
    && db._tables.brandAccessPeriod.filter((p) => p.accessId === id).length === 2 && db._tables.brandAccessPeriod.at(-1).startReason === "REOPEN");
  const r = await getAffiliateSimulationDashboard("a1", { db, now: at(32), window: "30d" });
  const gap = db._tables.brandSimHour.filter((h) => { const t = new Date(h.hourStart).getTime(); return t >= floorHour(closeAt.getTime()) && t < ceilHour(reopenAt.getTime()); });
  ok("the closed gap is never filled; generation resumes from the reopening", gap.length === 0 && r.readOnly === false
    && db._tables.brandSimHour.some((h) => new Date(h.hourStart).getTime() === ceilHour(reopenAt.getTime())));
  ok("the gap is not reported as incomplete (it is outside any period)", r.incomplete.length === 0);
  const w = accessWindows(db._tables.brandAccessPeriod.filter((p) => p.accessId === id), access().simulationStartsAt, at(32).getTime());
  ok("two windows: activation → closure, reopening → now", w.length === 2 && w[0].to === closeAt.getTime() && w[1].from === reopenAt.getTime() && w[1].open === true);
  ok("reopening an active one → NOT_CLOSED", (await rejects(adminReopenAccess(id, { reason: "x" }, { db, now: at(33) })))?.code === "NOT_CLOSED");
  ok("closure needs a reason", (await rejects(adminCloseAccess(id, { reason: " " }, { db, now: at(33) })))?.code === "REASON_REQUIRED");
}

// ── 6. Batches, catch-up bound, progress, concurrency ─────────────────────────
console.log("\n6. Batched generation and catch-up bounds");
{
  const { db, id, access } = await setup({ configAt: at(-210), activateAt: at(-200) });
  const tx0 = db._stats.txCount;
  const d = await getAffiliateSimulationDashboard("a1", { db, now: T0, window: "24h" });
  const through = new Date(access().generatedThrough).getTime();
  const startH = ceilHour(access().simulationStartsAt.getTime());
  ok(`one dashboard read catches up at most ${SIM_MAX_CATCHUP_DAYS} days, in ${SIM_BATCH_DAYS}-day batches`, d.catchUpPending === true
    && through - startH <= (SIM_MAX_CATCHUP_DAYS + SIM_BATCH_DAYS) * DAY_MS && through - startH >= SIM_MAX_CATCHUP_DAYS * DAY_MS, `${(through - startH) / DAY_MS} days`);
  ok("the progress marker matches the stored hours", db._tables.brandSimHour.length === (through - startH) / HOUR_MS && db._tables.brandSimHour.every((h) => new Date(h.hourStart).getTime() < through));
  ok("one transaction per batch", db._stats.txCount - tx0 >= Math.ceil(SIM_MAX_CATCHUP_DAYS / SIM_BATCH_DAYS));
  ok("each batch holds the access's advisory lock", db._stats.log.filter((l) => l.endsWith(`:brand-sim:${id}`)).length >= Math.ceil(SIM_MAX_CATCHUP_DAYS / SIM_BATCH_DAYS));
  const tick = await runBrandSimulationTick({ db, now: T0, maxDaysPerAccess: 400 });
  ok("the engine catches up the rest", tick.accesses === 1 && tick.pending === 0 && new Date(access().generatedThrough).getTime() === floorHour(T0.getTime())
    && db._tables.brandSimHour.length === (floorHour(T0.getTime()) - startH) / HOUR_MS);
  const all = db._tables.brandSimHour.length;
  await Promise.all([
    runBrandSimulationTick({ db, now: at(3) }),
    getAffiliateSimulationDashboard("a1", { db, now: at(3), window: "7d" }),
    materializeAccessSimulation(access(), { db, now: at(3) }),
    materializeAccessSimulation(access(), { db, now: at(3) }),
  ]);
  ok("concurrent engine + reads → each hour exactly once", db._tables.brandSimHour.length === all + 3 * 24
    && new Set(db._tables.brandSimHour.map((h) => new Date(h.hourStart).getTime())).size === db._tables.brandSimHour.length);
  const busy = await runBrandSimulationTick({ db, now: at(4), lock: { acquire: async () => false } });
  ok("a second engine without the engine lock skips its tick", busy.skipped === "no_lock");
  ok("no incomplete period when every version is verified", d.incomplete.length === 0);
  ok("incompleteRanges is empty for a verified timeline", incompleteRanges(toTimeline([{ effectiveFrom: new Date(0), enabled: true, proven: true, settings: SIM }]),
    [{ from: 0, to: 10 * HOUR_MS, open: false }], 0, 10 * HOUR_MS).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
