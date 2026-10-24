#!/usr/bin/env node
/**
 * scripts/demoSimCoverage.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-5 — demo simulation coverage + participant evidence.
 * No database: fakes only (the SQL is checked structurally and mirrored by the
 * pure reducers it is documented against). Proves:
 *   • coverage merge: exact gaps in order; duplicates / retries / late or
 *     out-of-order ticks can never make a day look MORE covered
 *   • participants: intersection over every tick (mid-day (de)activation drops
 *     out), idempotent, order-independent
 *   • recorder: one transaction, demo tables only, UTC day key, server-TZ guard
 *   • simulateTick records only after successful history writes; disabled or
 *     failed ticks record nothing; a recorder failure never breaks the tick
 *   • manual ticks take the engine's advisory lock (busy → 409, no tick)
 *   • clearing history clears coverage + participants in the same transaction
 *   • backfill never overwrites a proven zero
 *   • reserved settings key; a missing row becomes 0 only with full proof
 * Run: node scripts/demoSimCoverage.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeCoverageExecutor } from "./demoSimCoverageFake.mjs";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";

const C = await import("../src/lib/demoSimCoverage.js");
const EA = await import("../src/lib/demoChatEarnings.js");
const demo = await import("../src/lib/services/demoService.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = (fn) => Promise.resolve().then(fn).then(() => null, (e) => e);
const T = (iso) => Date.parse(iso);
const S = 1000, MIN = 60 * S, H = 60 * MIN, DAY = 24 * H;

// ── 1. Pure reducers ──────────────────────────────────────────────────────────
console.log("\n1. Coverage merge and participant intersection");
{
  const D = T("2026-10-20T00:00:00Z");
  let cov = null;
  for (const t of [D + 10 * S, D + 20 * S, D + 30 * S]) cov = C.mergeCoverage(cov, t);
  ok("in-order ticks: first/last/count, gap = 10 s", cov.firstTickAt === D + 10 * S && cov.lastTickAt === D + 30 * S && cov.tickCount === 3 && cov.maxGapSec === 10);
  const dup = C.mergeCoverage(cov, D + 30 * S);
  ok("duplicate tick: range and gap unchanged (count +1 is harmless)", dup.firstTickAt === cov.firstTickAt && dup.lastTickAt === cov.lastTickAt && dup.maxGapSec === 10);
  const jump = C.mergeCoverage(cov, D + 30 * S + 10 * MIN);
  ok("outage: the next tick 10 min later records a 600 s gap", jump.maxGapSec === 600);
  const inner = C.mergeCoverage(jump, D + 5 * MIN);
  ok("late tick INSIDE the range never shrinks the recorded gap", inner.maxGapSec === 600 && inner.lastTickAt === jump.lastTickAt);
  let late = null;
  for (let t = D + 6 * H; t <= D + DAY - 10 * S; t += 10 * S) late = C.mergeCoverage(late, t);
  const backdated = C.mergeCoverage(late, D + 30 * S); // a delayed tick stamped near midnight
  ok("back-dated tick before the first one: start extended AND the hole counted (≈6 h gap)", backdated.firstTickAt === D + 30 * S && backdated.maxGapSec >= 6 * 3600 - 30);
  ok("…so that day can NOT be proven", !EA.coverageProves({ ...backdated, tickCount: backdated.tickCount }, D, D + DAY));

  ok("participants: first tick sets the list (sorted, unique)", JSON.stringify(C.intersectParticipants(null, ["b", "a", "b"])) === '["a","b"]');
  ok("deactivated mid-day → dropped", JSON.stringify(C.intersectParticipants(["a", "b", "c"], ["a", "c"])) === '["a","c"]');
  ok("activated mid-day → never added", JSON.stringify(C.intersectParticipants(["a"], ["a", "z"])) === '["a"]');
  ok("re-activated later → stays dropped for that day", JSON.stringify(C.intersectParticipants(C.intersectParticipants(["a", "b"], ["a"]), ["a", "b"])) === '["a"]');
  const order1 = [["a", "b", "c"], ["a", "b"], ["b", "c", "a"]].reduce((acc, ids) => C.intersectParticipants(acc, ids), null);
  const order2 = [["b", "c", "a"], ["a", "b", "c"], ["a", "b"]].reduce((acc, ids) => C.intersectParticipants(acc, ids), null);
  ok("order-independent and idempotent", JSON.stringify(order1) === JSON.stringify(order2) && JSON.stringify(C.intersectParticipants(order1, order1)) === JSON.stringify(order1));
}

// ── 2. Recorder (fake transaction) + SQL structure ────────────────────────────
console.log("\n2. Recorder");
{
  const calls = []; let txCount = 0;
  const db = { $transaction: async (fn) => { txCount++; return fn({ $executeRaw: async (strings, ...vals) => { calls.push({ sql: strings.join("?"), vals }); return 1; } }); } };
  const r = await C.recordSimCoverage(db, { tickAtMs: T("2026-10-20T13:45:10.123Z"), participantIds: ["p2", "p1", "p2", "", null] });
  ok("one transaction, two statements, UTC day key", r.recorded && r.day === "2026-10-20" && txCount === 1 && calls.length === 2);
  ok("coverage statement: day + tick instant as UTC", calls[0].vals[0] === "2026-10-20" && calls[0].vals[1] === "2026-10-20T13:45:10.123Z" && /INSERT INTO "demo_sim_day_coverage"/.test(calls[0].sql));
  ok("participants statement: reserved key + sorted unique ids", calls[1].vals[0] === "demo-sim-participants:2026-10-20" && calls[1].vals[1] === '["p1","p2"]' && /INSERT INTO "settings"/.test(calls[1].sql));
  const cov = calls[0].sql; const par = calls[1].sql;
  ok("SQL: upsert on the day; min/max range; count + 1", /ON CONFLICT \("day"\) DO UPDATE/.test(cov) && /LEAST\(c\."firstTickAt", EXCLUDED\."firstTickAt"\)/.test(cov) && /GREATEST\(c\."lastTickAt", EXCLUDED\."lastTickAt"\)/.test(cov) && /"tickCount" = c\."tickCount" \+ 1/.test(cov));
  ok("SQL: gap grows only when a tick extends the range (later or earlier), never shrinks",
    /GREATEST\(\s*c\."maxGapSec",/.test(cov) && /WHEN EXCLUDED\."lastTickAt" > c\."lastTickAt"/.test(cov) && /WHEN EXCLUDED\."firstTickAt" < c\."firstTickAt"/.test(cov));
  ok("SQL: timestamps stored as UTC regardless of the DB session time zone", (cov.match(/AT TIME ZONE 'UTC'/g) || []).length >= 3);
  ok("SQL: participants = intersection (existing ∩ this tick), malformed → empty", /WHERE x IN \(SELECT jsonb_array_elements_text\(EXCLUDED\."data"->'ids'\)\)/.test(par) && /COALESCE\(s\."data"->'ids', '\[\]'::jsonb\)/.test(par));
  ok("invalid tick time → nothing recorded", (await C.recordSimCoverage(db, { tickAtMs: NaN })).recorded === false && txCount === 1);
  ok("database error propagates (caller logs it; nothing half-written thanks to the transaction)", (await rejects(() => C.recordSimCoverage({ $transaction: async () => { throw new Error("db down"); } }, { tickAtMs: Date.now() })))?.message === "db down");
}

// ── 3. Server time-zone guard (child processes; the test's own TZ is untouched) ─
console.log("\n3. Time-zone guard");
{
  const mod = fileURLToPath(new URL("../src/lib/demoSimCoverage.js", import.meta.url));
  const probe = (tz) => {
    const code = `import(${JSON.stringify(mod)}).then(async (C) => { let tx = 0; const r = await C.recordSimCoverage({ $transaction: async () => { tx++; } }, { tickAtMs: Date.parse('2026-10-20T13:00:00Z'), participantIds: ['p1'] }); console.log(JSON.stringify({ align: C.bucketsAlignWithUtc(Date.parse('2026-10-20T13:00:00Z')), r, tx })); });`;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    return JSON.parse(out.stdout.trim().split("\n").pop());
  };
  const utc = probe("UTC");
  ok("server TZ = UTC → buckets align → recorded", utc.align === true && utc.r.recorded === true && utc.tx === 1);
  const casa = probe("Africa/Casablanca");
  ok("server TZ = Africa/Casablanca → local midnight ≠ UTC midnight → NOT recorded (no DB access)", casa.align === false && casa.r.reason === "timezone_mismatch" && casa.tx === 0);
  const ny = probe("America/New_York");
  ok("server TZ = America/New_York → NOT recorded", ny.align === false && ny.r.recorded === false);
  ok("the guard never sets process.env.TZ", !/process\.env\.TZ\s*=/.test(src("src/lib/demoSimCoverage.js")));
}

// ── 4. A simulated day end to end (executor = the SQL's mirror) ───────────────
console.log("\n4. Full simulated days → resolver");
{
  const day = "2026-10-19"; const start = T(`${day}T00:00:00Z`);
  const run = async (ticks) => {
    const tables = { demoSimDayCoverage: [], setting: [] };
    const exec = makeCoverageExecutor(tables);
    const db = { $transaction: async (fn) => fn({ $executeRaw: exec }) };
    for (const [t, ids] of ticks) await C.recordSimCoverage(db, { tickAtMs: t, participantIds: ids });
    const participants = Object.fromEntries(tables.setting.map((r) => [r.id.slice(C.SIM_PARTICIPANTS_PREFIX.length), r.data.ids]));
    return (profileId, history = []) => EA.resolvePeriod(EA.buildEarningsContext({ history, coverage: tables.demoSimDayCoverage, participants, profileId, nowMs: T("2026-10-20T15:00:00Z"), profileCreatedAt: new Date("2026-01-01T00:00:00Z") }), "yesterday", "2026-10-20");
  };
  const every10s = (from, to, idsAt) => { const out = []; for (let t = from; t < to; t += 10 * S) out.push([t, idsAt(t)]); return out; };
  const full = await run(every10s(start + 5 * S, start + DAY, () => ["p1", "p2"]));
  ok("ticks every 10 s all day: no row → proven ZERO for a participant", full("p1").status === "complete" && full("p1").reason === "observed_zero" && full("p1").commission === 0);
  ok("…a profile never present that day → unavailable", full("p9").status === "unavailable");
  const outage = await run([...every10s(start + 5 * S, start + 10 * H, () => ["p1"]), ...every10s(start + 10 * H + 15 * MIN, start + DAY, () => ["p1"])]);
  ok("15-minute outage → not proven → unavailable", outage("p1").status === "unavailable" && outage("p1").reason === "no_row_coverage_not_proven");
  const deact = await run(every10s(start + 5 * S, start + DAY, (t) => (t > start + 12 * H && t < start + 13 * H ? ["p2"] : ["p1", "p2"])));
  ok("profile inactive for an hour → dropped from participants → unavailable (not zero)", deact("p1").reason === "profile_participation_not_proven" && deact("p2").reason === "observed_zero");
  const act = await run(every10s(start + 5 * S, start + DAY, (t) => (t < start + 8 * H ? ["p2"] : ["p1", "p2"])));
  ok("profile activated at 08:00 → not observed all day → unavailable", act("p1").status === "unavailable");
  ok("profile inactive part of the day but WITH a row → incomplete (value may be partial)", deact("p1", [{ id: "h", date: new Date(start), orders: 2, revenue: 200, commission: 10 }]).status === "incomplete");
  const dup = await run([...every10s(start + 5 * S, start + DAY, () => ["p1"]), ...every10s(start + 5 * S, start + DAY, () => ["p1"])]);
  ok("every tick delivered twice (retries) → same verdict, still sound", dup("p1").reason === "observed_zero");
  const late = await run([...every10s(start + 6 * H, start + DAY, () => ["p1"]), [start + 10 * S, ["p1"]]]);
  ok("delayed tick stamped 00:00:10 after a day that started at 06:00 → still unavailable", late("p1").status === "unavailable");
  const partial = await run(every10s(start + 5 * S, start + 20 * H, () => ["p1"]));
  ok("simulation stopped at 20:00 → unavailable", partial("p1").status === "unavailable");
  const manualOnly = await run([[start + 9 * H, ["p1"]], [start + 15 * H, ["p1"]]]);
  ok("a couple of manual ticks never prove a day", manualOnly("p1").status === "unavailable");
}

// ── 5. simulateTick integration (permissive demo fake) ────────────────────────
console.log("\n5. simulateTick, manual lock, history clearing");
function permissiveDb({ settings, affiliates, failHistory = false, failRaw = false, lock = true }) {
  const tables = { demoSimDayCoverage: [], setting: [] }; const raw = []; const writes = [];
  const exec = makeCoverageExecutor(tables, raw);
  const generic = (name) => new Proxy({}, { get: (_, op) => async (args = {}) => {
    writes.push(`${name}.${String(op)}`);
    if (name === "demoSettings" && op === "findUnique") return settings;
    if (name === "demoAffiliate" && op === "findMany") return affiliates;
    if (name === "demoEarningsHistory" && op === "create" && failHistory) throw new Error("history write failed");
    if (op === "findMany") return [];
    if (op === "findUnique" || op === "findFirst") return null;
    if (op === "count") return 0;
    if (op === "updateMany" || op === "deleteMany") return { count: 0 };
    return args.data || args.create || {};
  } });
  const allowed = new Set(["demoSettings", "demoAffiliate", "demoStats", "demoEarningsHistory", "demoCompetition", "demoAvatar", "setting", "demoSimDayCoverage"]);
  const base = {
    tables, raw, writes,
    $executeRaw: async (...a) => { if (failRaw) throw new Error("raw failed"); return exec(...a); },
    $queryRaw: async (strings) => (/pg_try_advisory_xact_lock/.test(strings.join("?")) ? [{ locked: lock }] : []),
  };
  const db = new Proxy(base, { get: (o, k) => {
    if (k in o || typeof k === "symbol" || k === "then") return o[k];
    if (k === "$transaction") return async (fn) => fn(db);
    if (allowed.has(k)) return generic(k);
    throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: db.${String(k)}`);
  } });
  return db;
}
{
  const aff = [{ id: "p1", growthType: "consistent", isActive: true, stats: { totalOrders: 0 } }, { id: "p2", growthType: "slow", isActive: true, stats: { totalOrders: 0 } }, { id: "nostats", growthType: "slow", isActive: true, stats: null }];
  const enabled = { id: "settings", isEnabled: true, lastSimAt: null };
  const quiet = async (fn) => { const o = console.error; const logs = []; console.error = (...a) => logs.push(a.join(" ")); try { return { out: await fn(), logs }; } finally { console.error = o; } };

  let db = permissiveDb({ settings: enabled, affiliates: aff }); demo.__setDemoDb(db);
  await demo.simulateTick();
  ok("successful tick → coverage + participants recorded (eligible profiles only)", db.tables.demoSimDayCoverage.length === 1 && JSON.stringify(db.tables.setting[0].data.ids) === '["p1","p2"]');
  ok("…recorded AFTER the history writes", db.writes.lastIndexOf("demoEarningsHistory.create") >= 0 && db.raw.length === 2);

  db = permissiveDb({ settings: { ...enabled, isEnabled: false }, affiliates: aff }); demo.__setDemoDb(db);
  const off = await demo.simulateTick();
  ok("simulation disabled → skipped, nothing recorded", off.skipped === true && db.raw.length === 0);

  db = permissiveDb({ settings: enabled, affiliates: aff, failHistory: true }); demo.__setDemoDb(db);
  ok("history write fails → tick throws, NO coverage recorded", (await rejects(() => demo.simulateTick()))?.message === "history write failed" && db.raw.length === 0);

  db = permissiveDb({ settings: enabled, affiliates: aff, failRaw: true }); demo.__setDemoDb(db);
  const q = await quiet(() => demo.simulateTick());
  ok("recorder failure → logged, tick still completes (day stays unproven)", typeof q.out.orders === "number" && q.logs.some((l) => /coverage not recorded/.test(l)) && db.tables.demoSimDayCoverage.length === 0);

  db = permissiveDb({ settings: enabled, affiliates: aff, lock: false }); demo.__setDemoDb(db);
  const busy = await demo.runManualSimTick();
  ok("manual tick while the engine holds the lock → { skipped: 'busy' }, nothing simulated", busy.skipped === "busy" && !db.writes.some((w) => w.startsWith("demoStats.update")) && db.raw.length === 0);
  db = permissiveDb({ settings: enabled, affiliates: aff, lock: true }); demo.__setDemoDb(db);
  const manual = await demo.runManualSimTick();
  ok("manual tick with the lock → runs and records coverage", typeof manual.orders === "number" && db.raw.length === 2);
  const svcSrc = src("src/lib/services/demoService.js");
  ok("manual lock uses the engine's key in the same advisory-lock space", /pg_try_advisory_xact_lock\(\$\{DEMO_SIM_LOCK_KEY\}::bigint\)/.test(svcSrc) && /pg_try_advisory_lock\(\$1\)/.test(src("src/lib/ugcAdvisoryLock.js")));
  const route = src("src/app/api/admin/demo/simulate/route.js");
  ok("simulate route uses the locked manual tick and answers 409 when busy", /runManualSimTick\(\)/.test(route) && !/simulateTick\(\)/.test(route) && /status: 409/.test(route) && /export const POST = withAdminAuth\(/.test(route));
  ok("auto runner still uses its session lock", /runAutoSimTick\(\{ lock \}\)/.test(src("scripts/demo-competition-engine.mjs")));

  // clearCompetitionHistory: one transaction, coverage + participants included.
  const deleted = []; let txs = 0;
  const cdb = new Proxy({}, { get: (_, k) => {
    if (k === "$transaction") return async (fn) => { txs++; return fn(cdb); };
    if (typeof k === "symbol" || k === "then") return undefined;
    return { deleteMany: async (args = {}) => { deleted.push(`${String(k)}:${args.where?.id?.startsWith || "*"}`); return { count: 3 }; } };
  } });
  const res = await demo.clearCompetitionHistory({ db: cdb });
  ok("clearing history also clears coverage + participants, in ONE transaction", txs === 1 && deleted.includes("demoEarningsHistory:*") && deleted.includes("demoSimDayCoverage:*") && deleted.includes(`setting:${C.SIM_PARTICIPANTS_PREFIX}`) && deleted.includes("setting:demo-competition-cycle:") && res.deletedCoverageDays === 3 && res.deletedParticipantDays === 3);
}

// ── 6. Backfill keeps proven zeros; reserved settings key ─────────────────────
console.log("\n6. Backfill and reserved settings");
{
  const svc = await import("../src/lib/services/demoProfileService.js");
  const NOW = T("2026-10-20T15:00:00Z");
  const proven = "2026-10-15"; const unproven = "2026-10-14";
  const startP = T(`${proven}T00:00:00Z`);
  const t = { history: [], created: [], meta: null };
  const covRow = { day: new Date(startP), firstTickAt: new Date(startP + 5 * S), lastTickAt: new Date(startP + DAY - 5 * S), tickCount: 8000, maxGapSec: 30 };
  const bdb = new Proxy({}, { get: (_, k) => {
    if (typeof k === "symbol" || k === "then") return undefined;
    if (k === "demoAffiliate") return { findUnique: async () => ({ id: "p1", growthType: "consistent", createdAt: new Date("2026-01-01T00:00:00Z") }) };
    if (k === "demoEarningsHistory") return { findMany: async () => [], create: async ({ data }) => { t.created.push(data.date.toISOString().slice(0, 10)); return data; } };
    if (k === "demoSimDayCoverage") return { findMany: async () => [covRow] };
    if (k === "setting") return {
      findUnique: async () => t.meta,
      findMany: async ({ where }) => (where.id.in.includes(`${C.SIM_PARTICIPANTS_PREFIX}${proven}`) ? [{ id: `${C.SIM_PARTICIPANTS_PREFIX}${proven}`, data: { ids: ["p1"] } }] : []),
      upsert: async ({ create }) => { t.meta = create; return create; },
    };
    throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: db.${String(k)}`);
  } });
  demo.__setDemoDb(bdb);
  const r = await svc.backfillHistory("p1", { now: NOW });
  ok("backfill skips the day proven to be zero", r.skippedProvenZero === 1 && !t.created.includes(proven));
  ok("…and still fills unproven missing days", t.created.includes(unproven) && r.created === 88);

  const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");
  const resp = await upsertSettingsHandler(new Request(`http://x/api/setting?type=${C.SIM_PARTICIPANTS_PREFIX}2026-10-20`, { method: "POST", body: JSON.stringify({ ids: ["p1"] }), headers: { "content-type": "application/json" } }));
  ok("generic /api/setting refuses demo-sim-participants:* (reserved)", resp.status === 400);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
