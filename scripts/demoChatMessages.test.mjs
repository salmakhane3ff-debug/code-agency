#!/usr/bin/env node
/**
 * scripts/demoChatMessages.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-6 — idempotent DEMO chat message materialization.
 * No database: an in-memory fake that enforces the real unique key
 * (assignmentId, revision, loopIndex, stepId), yields between awaits so
 * concurrent calls interleave, and throws on any non-demo model. Proves:
 *   • gates + assignment.enabled required; nothing written otherwise
 *   • concurrent calls / retries / restarts never duplicate a message;
 *     INSERT … ON CONFLICT DO NOTHING semantics (skipDuplicates) are used
 *   • original Casablanca timestamps, no future messages, late joiners =
 *     current cycle only, timezone boundaries
 *   • published version snapshot used; existing rows / snapshots never
 *     overwritten; version conflicts reported; revision changes isolated
 *   • earnings snapshot stored at materialization and rendered unchanged on
 *     later days; late "today" → unavailable; never a fabricated zero
 *   • old cycles stay stored, hidden from the normal view; nothing deleted
 * Run: node scripts/demoChatMessages.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";

const T = await import("../src/lib/demoChatTime.js");
const G = await import("../src/lib/demoChatGate.js");
const demo = await import("../src/lib/services/demoService.js");
const M = await import("../src/lib/services/demoChatMessageService.js");
const { PROFILE_META_PREFIX } = await import("../src/lib/demoProfileValidation.js");
const { SIM_PARTICIPANTS_PREFIX } = await import("../src/lib/demoSimCoverage.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = (fn) => Promise.resolve().then(fn).then(() => null, (e) => e);
const CASA = T.CHAT_TIMEZONE;
const at = (date, time) => T.zonedTimeToUtc(date, time, CASA).ms;
const ENV_ON = { DEMO_CHAT_ENABLED: "true" };
const yieldNow = () => new Promise((r) => setImmediate(r));
const utc = (key) => new Date(`${key}T00:00:00.000Z`);

const STEPS = [
  { id: "s1", day: 1, time: "09:00", position: 0, type: "text", text: "Bienvenue", earningsPeriod: null, metric: null, assetId: null },
  { id: "s2", day: 2, time: "12:30", position: 0, type: "earnings", text: "{amount} {period}", earningsPeriod: "yesterday", metric: "commission", assetId: null },
  { id: "s3", day: 2, time: "12:30", position: 1, type: "earnings", text: "{amount} {period}", earningsPeriod: "today", metric: "commission", assetId: null },
  { id: "s4", day: 2, time: "18:00", position: 0, type: "image", text: null, earningsPeriod: null, metric: null, assetId: "a1" },
  { id: "s30", day: 30, time: "23:00", position: 0, type: "text", text: "Fin", earningsPeriod: null, metric: null, assetId: null },
];

function makeDb({ anchor = "2026-10-01", steps = STEPS, gateOn = true, enabled = true, history = [], coverage = [], participants = {} } = {}) {
  const t = {
    assignment: [{ id: "as1", demoAffiliateId: "p1", versionId: "v1", anchorDate: utc(anchor), revision: 1, enabled }],
    version: [{ id: "v1", journeyId: "j1", version: 1, steps: structuredClone(steps) }],
    profile: [{ id: "p1", name: "Salma", username: "salma", isActive: true, createdAt: new Date("2026-01-01T00:00:00Z") }],
    messages: [], audit: [], history, coverage, settings: [],
  };
  if (gateOn) t.settings.push({ id: G.DEMO_CHAT_SETTING_ID, data: { enabled: true } });
  for (const [day, ids] of Object.entries(participants)) t.settings.push({ id: `${SIM_PARTICIPANTS_PREFIX}${day}`, data: { ids } });
  const calls = { createMany: 0, deletes: 0, lockOverride: null };
  const cond = (v, c) => (c && typeof c === "object" && !(c instanceof Date) ? (("gte" in c ? v >= c.gte : true) && ("lt" in c ? v < c.lt : true) && ("in" in c ? c.in.includes(v) : true)) : c instanceof Date ? v?.getTime?.() === c.getTime() : v === c);
  const match = (r, w = {}) => Object.entries(w).every(([k, c]) => cond(r[k], c));
  const pick = (r, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : structuredClone(r));
  let seq = 0;
  const models = {
    demoChatAssignment: {
      findUnique: async ({ where }) => { await yieldNow(); const r = t.assignment.find((x) => x.id === where.id); return r ? structuredClone(r) : null; },
      findMany: async ({ where, select }) => t.assignment.filter((x) => match(x, where)).map((r) => pick(r, select)),
    },
    demoChatJourneyVersion: { findUnique: async ({ where }) => { const r = t.version.find((x) => x.id === where.id); return r ? structuredClone(r) : null; } },
    demoAffiliate: { findUnique: async ({ where }) => { const r = t.profile.find((x) => x.id === where.id); return r ? { ...r } : null; } },
    demoChatMessage: {
      findMany: async ({ where, select, orderBy }) => {
        await yieldNow();
        let rows = t.messages.filter((x) => match(x, where));
        if (orderBy) rows = [...rows].sort((a, b) => a.scheduledAt - b.scheduledAt || a.day - b.day || a.position - b.position || (a.stepId < b.stepId ? -1 : 1));
        return rows.map((r) => pick(r, select));
      },
      createMany: async ({ data, skipDuplicates }) => {
        calls.createMany++; await yieldNow();
        let count = 0;
        for (const d of data) {
          const dup = t.messages.some((m) => m.assignmentId === d.assignmentId && m.revision === d.revision && m.loopIndex === d.loopIndex && m.stepId === d.stepId);
          if (dup) { if (!skipDuplicates) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }); continue; }
          t.messages.push({ id: `m${++seq}`, ...structuredClone(d), earningsSnapshot: d.earningsSnapshot ?? null }); count++;
        }
        return { count };
      },
      deleteMany: async () => { calls.deletes++; throw new Error("TEST: messages must never be deleted here"); },
      delete: async () => { calls.deletes++; throw new Error("TEST: messages must never be deleted here"); },
      update: async () => { throw new Error("TEST: messages must never be overwritten"); },
      upsert: async () => { throw new Error("TEST: messages must never be overwritten"); },
    },
    demoChatAuditLog: { create: async ({ data }) => { t.audit.push(data); return data; } },
    demoEarningsHistory: { findMany: async ({ where, select }) => t.history.filter((r) => match(r, where)).map((r) => pick(r, select)) },
    demoSimDayCoverage: { findMany: async ({ where }) => t.coverage.filter((r) => match(r, where)).map((r) => ({ ...r })) },
    setting: {
      findUnique: async ({ where }) => {
        if (where.id !== G.DEMO_CHAT_SETTING_ID && !where.id.startsWith(PROFILE_META_PREFIX)) throw new Error(`TEST: forbidden setting ${where.id}`);
        const r = t.settings.find((x) => x.id === where.id); return r ? structuredClone(r) : null;
      },
      findMany: async ({ where }) => {
        if (!where.id.in.every((id) => id.startsWith(SIM_PARTICIPANTS_PREFIX))) throw new Error("TEST: forbidden settings read");
        return t.settings.filter((x) => where.id.in.includes(x.id)).map((r) => structuredClone(r));
      },
    },
  };
  const guard = (o) => new Proxy(o, { get: (x, k) => { if (k in x || typeof k === "symbol" || k === "then") return x[k]; throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: db.${String(k)}`); } });
  const db = guard({
    ...models, _t: t, _calls: calls,
    $transaction: async (fn) => {
      const snap = structuredClone({ messages: t.messages, audit: t.audit });
      const tx = guard({
        ...models,
        $queryRaw: async (strings, ...vals) => {
          if (!/FROM "demo_chat_assignments"[\s\S]*FOR SHARE/.test(strings.join("?"))) throw new Error("TEST: unexpected raw SQL");
          const r = t.assignment.find((x) => x.id === vals[0]);
          return r ? [{ ...structuredClone(r), ...(calls.lockOverride || {}) }] : [];
        },
      });
      try { return await fn(tx); } catch (e) { t.messages = snap.messages; t.audit = snap.audit; throw e; }
    },
  });
  return db;
}
const run = (db, date, time, extra = {}) => M.materializeAssignment("as1", { now: at(date, time), env: ENV_ON, db, ...extra });

// ── 1. Gates ──────────────────────────────────────────────────────────────────
console.log("\n1. Feature gates and assignment flag");
{
  let db = makeDb();
  ok("env gate off → skipped, nothing written", (await M.materializeAssignment("as1", { now: at("2026-10-02", "15:00"), env: {}, db })).skipped === "feature_disabled" && db._t.messages.length === 0);
  db = makeDb({ gateOn: false });
  ok("protected setting off → skipped", (await run(db, "2026-10-02", "15:00")).skipped === "feature_disabled" && db._t.messages.length === 0);
  db = makeDb({ enabled: false });
  ok("assignment disabled (the default) → skipped", (await run(db, "2026-10-02", "15:00")).skipped === "assignment_disabled" && db._t.messages.length === 0);
  ok("materializeDue with gates off → nothing", (await M.materializeDue({ now: at("2026-10-02", "15:00"), env: {}, db: makeDb() })).skipped === "feature_disabled");
  ok("invalid / unknown assignment → 404", (await rejects(() => M.materializeAssignment("../x", { env: ENV_ON, db: makeDb() })))?.status === 404 && (await rejects(() => M.materializeAssignment("nope", { env: ENV_ON, db: makeDb() })))?.status === 404);
  ok("gates are both required by the shared helper", !G.evaluateGates("true", null).enabled && !G.evaluateGates(undefined, { enabled: true }).enabled);
}

// ── 2. Materialization, timestamps, future exclusion ──────────────────────────
console.log("\n2. Materialization and timestamps");
{
  const db = makeDb();
  const r = await run(db, "2026-10-02", "15:00");
  const ids = db._t.messages.map((m) => m.stepId).sort().join(",");
  ok(`day 2 15:00 → s1, s2, s3 created (created=${r.created})`, r.created === 3 && ids === "s1,s2,s3");
  ok("no future message (18:00 image and day 30 not created)", !db._t.messages.some((m) => ["s4", "s30"].includes(m.stepId)) && db._t.messages.every((m) => m.scheduledAt.getTime() <= at("2026-10-02", "15:00")));
  ok("original Casablanca wall times stored as instants", db._t.messages.every((m) => T.localParts(m.scheduledAt.getTime(), CASA).time === STEPS.find((s) => s.id === m.stepId).time) && db._t.messages.find((m) => m.stepId === "s1").scheduledAt.getTime() === at("2026-10-01", "09:00"));
  ok("rows carry assignment, profile, version, revision, cycle, day, position", db._t.messages.every((m) => m.assignmentId === "as1" && m.demoAffiliateId === "p1" && m.versionId === "v1" && m.revision === 1 && m.loopIndex === 0) && db._t.messages.find((m) => m.stepId === "s3").position === 1);
  ok("one SYSTEM audit row for the batch", db._t.audit.length === 1 && db._t.audit[0].actorType === "SYSTEM" && db._t.audit[0].action === "MESSAGES_MATERIALIZE" && db._t.audit[0].after.created === 3);
  const later = await run(db, "2026-10-02", "18:30");
  ok("later run adds only the newly due message (s4)", later.created === 1 && db._t.messages.length === 4 && db._t.messages.at(-1).stepId === "s4" && db._t.messages.at(-1).assetId === "a1");
}

// ── 3. Retries, restarts, concurrency ─────────────────────────────────────────
console.log("\n3. Retries, restarts and concurrency");
{
  const db = makeDb();
  await run(db, "2026-10-02", "15:00");
  const again = await run(db, "2026-10-02", "15:00");
  ok("retry at the same moment → 0 created, no new audit row", again.created === 0 && db._t.messages.length === 3 && db._t.audit.length === 1);
  const fresh = await import(`../src/lib/services/demoChatMessageService.js?restart=${Date.now()}`); // a "restarted process": no in-memory state survives
  ok("restart (fresh module instance) → 0 created", (await fresh.materializeAssignment("as1", { now: at("2026-10-02", "15:00"), env: ENV_ON, db })).created === 0 && db._t.messages.length === 3);

  const cdb = makeDb();
  const results = await Promise.all(Array.from({ length: 20 }, () => run(cdb, "2026-10-02", "15:00")));
  const keys = cdb._t.messages.map((m) => `${m.assignmentId}|${m.revision}|${m.loopIndex}|${m.stepId}`);
  ok(`20 concurrent calls → each message exactly once (${cdb._t.messages.length} rows, ${cdb._calls.createMany} insert attempts)`, cdb._t.messages.length === 3 && new Set(keys).size === 3 && cdb._calls.createMany > 1);
  ok("…created counts add up to the unique rows; audit rows only for calls that inserted", results.reduce((s, x) => s + x.created, 0) === 3 && cdb._t.audit.length === results.filter((x) => x.created > 0).length);
  ok("inserts use skipDuplicates (INSERT … ON CONFLICT DO NOTHING)", /createMany\(\{ data: rows, skipDuplicates: true \}\)/.test(src("src/lib/services/demoChatMessageService.js")));
  const strict = makeDb(); await run(strict, "2026-10-02", "15:00");
  ok("the fake enforces the unique key (a plain insert of a duplicate fails)", (await rejects(() => strict.demoChatMessage.createMany({ data: [{ assignmentId: "as1", revision: 1, loopIndex: 0, stepId: "s1" }] })))?.code === "P2002");
  ok("database unique key in the schema: (assignmentId, revision, loopIndex, stepId)", /@@unique\(\[assignmentId, revision, loopIndex, stepId\]\)/.test(src("prisma/schema.prisma")));

  const ldb = makeDb(); ldb._calls.lockOverride = { revision: 2 };
  ok("assignment changed between read and insert (lock check) → nothing inserted", (await run(ldb, "2026-10-02", "15:00")).created === 0 && ldb._t.messages.length === 0);
}

// ── 4. Late joiners, cycles, retention ────────────────────────────────────────
console.log("\n4. Late joiners, rollover and retention");
{
  const db = makeDb({ anchor: "2026-10-01" });
  await run(db, "2026-10-16", "10:00");
  ok("late joiner (first run on day 16) → day 1 … now of the current cycle, nothing future", db._t.messages.length === 4 && db._t.messages.every((m) => m.loopIndex === 0 && m.day <= 2));
  await run(db, "2026-10-30", "23:30");
  ok("day 30 23:30 → whole cycle 1 stored (5 rows)", db._t.messages.length === 5);
  const r2 = await run(db, "2026-10-31", "09:30");
  ok("rollover: cycle 2 day 1 → only cycle-2 rows added; cycle-1 rows NOT back-filled or touched", r2.created === 1 && db._t.messages.filter((m) => m.loopIndex === 1).length === 1 && db._t.messages.filter((m) => m.loopIndex === 0).length === 5);
  const view = await M.listAssignmentMessages("as1", { now: at("2026-10-31", "09:30"), db, locale: "fr" });
  ok("normal view shows the current cycle only; previous cycle hidden but kept", view.messages.length === 1 && view.messages[0].loopIndex === 1 && view.cycle.previousCyclesHidden === 1 && db._t.messages.length === 6);
  ok("nothing is ever deleted by materialization or the view", db._calls.deletes === 0 && !/\.delete(Many)?\(/.test(src("src/lib/services/demoChatMessageService.js")));
  const lateCycle = makeDb({ anchor: "2026-09-01" });
  await run(lateCycle, "2026-10-02", "15:00"); // cycle 2 (loop 1) of an older assignment
  ok("first run in cycle 2 never back-fills cycle 1", lateCycle._t.messages.every((m) => m.loopIndex === 1));
  const before = makeDb({ anchor: "2026-11-01" });
  ok("before day 1 → nothing", (await run(before, "2026-10-20", "12:00")).created === 0 && before._t.messages.length === 0);
}

// ── 5. Version snapshots and revisions ────────────────────────────────────────
console.log("\n5. Published version snapshots, no overwrite");
{
  const db = makeDb();
  await run(db, "2026-10-02", "15:00");
  const textBefore = db._t.messages.find((m) => m.stepId === "s1").text;
  db._t.version[0].steps[0].text = "Texte modifié (ne doit pas écraser)";
  await run(db, "2026-10-02", "15:00");
  ok("existing message never overwritten (text unchanged after a re-run)", db._t.messages.find((m) => m.stepId === "s1").text === textBefore && db._t.messages.length === 3);
  db._t.messages.find((m) => m.stepId === "s2").versionId = "v-other";
  const errs = []; const o = console.error; console.error = (...a) => errs.push(a.join(" "));
  const cr = await run(db, "2026-10-02", "15:00");
  console.error = o;
  ok("stored row from another version → reported as conflict, left untouched", cr.conflicts === 1 && db._t.messages.find((m) => m.stepId === "s2").versionId === "v-other" && errs.some((l) => /disagree/.test(l)));

  const rdb = makeDb();
  await run(rdb, "2026-10-02", "15:00");
  rdb._t.version.push({ id: "v2", journeyId: "j1", version: 2, steps: [{ id: "s1", day: 1, time: "10:00", position: 0, type: "text", text: "Version 2", earningsPeriod: null, metric: null, assetId: null }] });
  Object.assign(rdb._t.assignment[0], { versionId: "v2", revision: 2 });
  const r2 = await run(rdb, "2026-10-02", "15:00");
  ok("new version + revision 2 → new rows under revision 2; revision-1 rows kept", r2.created === 1 && rdb._t.messages.filter((m) => m.revision === 1).length === 3 && rdb._t.messages.find((m) => m.revision === 2).text === "Version 2");
  const view = await M.listAssignmentMessages("as1", { now: at("2026-10-02", "15:00"), db: rdb });
  ok("view shows the current revision only", view.messages.length === 1 && view.messages[0].text === "Version 2");
  ok("published versions are only read (no version writes in the service)", !/demoChatJourneyVersion\.(update|create|delete|upsert)/.test(src("src/lib/services/demoChatMessageService.js")));
}

// ── 6. Earnings snapshots ─────────────────────────────────────────────────────
console.log("\n6. Earnings snapshots");
const fullCov = (key) => ({ day: utc(key), firstTickAt: new Date(utc(key).getTime() + 20_000), lastTickAt: new Date(utc(key).getTime() + 86_400_000 - 20_000), tickCount: 5000, maxGapSec: 30 });
const hrow = (id, key, orders, revenue) => ({ id, demoAffiliateId: "p1", date: utc(key), orders, revenue, commission: Math.round(revenue * 5) / 100 });
{
  const history = [hrow("h1", "2026-10-01", 4, 800), hrow("h2", "2026-10-02", 2, 400)];
  const db = makeDb({ history, coverage: [fullCov("2026-10-01")], participants: { "2026-10-01": ["p1"] } });
  await run(db, "2026-10-02", "12:35"); // 5 min after the 12:30 summaries
  const y = db._t.messages.find((m) => m.stepId === "s2").earningsSnapshot;
  const td = db._t.messages.find((m) => m.stepId === "s3").earningsSnapshot;
  ok("yesterday snapshot stored: complete, commission 40", y.v === 1 && y.status === "complete" && y.values.commission === 40 && y.period === "yesterday" && y.metric === "commission");
  ok("today snapshot (materialized 5 min after 12:30): provisional, commission 20", td.status === "provisional" && td.values.commission === 20 && td.resolvedAt === new Date(at("2026-10-02", "12:35")).toISOString());
  const day2 = await M.listAssignmentMessages("as1", { now: at("2026-10-02", "12:40"), db, locale: "fr" });
  ok(`rendered from the snapshot: "${day2.messages.find((m) => m.stepId === "s3").text}"`, day2.messages.find((m) => m.stepId === "s3").text === "20,00 MAD aujourd'hui (provisoire)");
  history[1].commission = 999; history[1].orders = 99; // the day keeps growing / is edited later
  const day9 = await M.listAssignmentMessages("as1", { now: at("2026-10-09", "10:00"), db, locale: "fr" });
  ok("a week later the historical 'today' message is unchanged (not re-resolved)", day9.messages.length === 0 || day9.messages.find((m) => m.stepId === "s3")?.text === "20,00 MAD aujourd'hui (provisoire)");
  const same = await M.listAssignmentMessages("as1", { now: at("2026-10-29", "10:00"), db, locale: "fr" });
  ok("…same cycle, day 29: identical text from the stored snapshot", same.messages.find((m) => m.stepId === "s3").text === "20,00 MAD aujourd'hui (provisoire)" && same.messages.find((m) => m.stepId === "s2").text === "40,00 MAD hier");

  const late = makeDb({ history: [hrow("h2", "2026-10-02", 2, 400)] });
  await run(late, "2026-10-02", "13:00"); // 30 min after the summary was due
  const lt = late._t.messages.find((m) => m.stepId === "s3").earningsSnapshot;
  ok("today summary materialized 30 min late → stored unavailable (materialized_too_late), no value", lt.status === "unavailable" && lt.reason === "materialized_too_late" && lt.values === null);
  const none = makeDb({ history: [], coverage: [], participants: {} });
  await run(none, "2026-10-02", "12:35");
  const ns = none._t.messages.find((m) => m.stepId === "s2").earningsSnapshot;
  const nv = await M.listAssignmentMessages("as1", { now: at("2026-10-02", "13:00"), db: none, locale: "fr" });
  ok("no history and no coverage → snapshot unavailable; view shows the notice, never 0", ns.status === "unavailable" && ns.values === null && nv.messages.find((m) => m.stepId === "s2").state === "unavailable" && !/\d/.test(nv.messages.find((m) => m.stepId === "s2").text));
  const inc = makeDb({ history: [hrow("h1", "2026-10-01", 4, 800)], coverage: [], participants: {} });
  await run(inc, "2026-10-02", "12:35");
  const is = inc._t.messages.find((m) => m.stepId === "s2").earningsSnapshot;
  const iv = await M.listAssignmentMessages("as1", { now: at("2026-10-02", "13:00"), db: inc, locale: "fr" });
  ok("row without proven coverage → stored incomplete, shown as unavailable (no partial amount)", is.status === "incomplete" && is.values === null && iv.messages.find((m) => m.stepId === "s2").state === "unavailable");
  ok("missing / foreign snapshot → unavailable", M.resolutionFromSnapshot(null).status === "unavailable" && M.resolutionFromSnapshot({ v: 99 }).status === "unavailable");
  ok("non-earnings messages carry no snapshot", db._t.messages.filter((m) => m.type !== "earnings").every((m) => m.earningsSnapshot === null));
}

// ── 7. Timezone boundaries ────────────────────────────────────────────────────
console.log("\n7. Timezone boundaries");
{
  const H = 3_600_000; let prev = T.offsetMinutes(Date.UTC(2026, 0, 1), CASA); const tr = [];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += H) { const o = T.offsetMinutes(t, CASA); if (o !== prev) { tr.push({ ms: t, from: prev, to: o }); prev = o; } }
  const back = tr.find((x) => x.to < x.from); const fwd = tr.find((x) => x.to > x.from);
  const anchor = T.addDays(T.localDateKey(back.ms, CASA), -5);
  const daily = Array.from({ length: 30 }, (_, i) => ({ id: `d${i + 1}`, day: i + 1, time: "09:00", position: 0, type: "text", text: "x", earningsPeriod: null, metric: null, assetId: null }));
  const db = makeDb({ anchor, steps: daily });
  await run(db, T.addDays(anchor, 29), "23:00");
  ok(`cycle across the ${T.localDateKey(back.ms, CASA)} offset change: 30 rows, all 09:00 Casablanca`, db._t.messages.length === 30 && db._t.messages.every((m) => T.localParts(m.scheduledAt.getTime(), CASA).time === "09:00"));
  const fwdDay = T.localDateKey(fwd.ms, CASA);
  const skipped = T.localParts(fwd.ms - 30 * 60_000, CASA);
  const gapTime = `${String((skipped.hour + 1) % 24).padStart(2, "0")}:${String(skipped.minute).padStart(2, "0")}`;
  const gdb = makeDb({ anchor: fwdDay, steps: [{ id: "g", day: 1, time: gapTime, position: 0, type: "text", text: "x", earningsPeriod: null, metric: null, assetId: null }] });
  await run(gdb, fwdDay, "12:00");
  ok(`step at a skipped wall time (${fwdDay} ${gapTime}) stored at the first instant after the gap`, gdb._t.messages.length === 1 && gdb._t.messages[0].scheduledAt.getTime() === fwd.ms);
  const edge = makeDb({ anchor: "2026-10-01", steps: [{ id: "e", day: 1, time: "23:59", position: 0, type: "text", text: "x", earningsPeriod: null, metric: null, assetId: null }] });
  ok("23:58 → not yet; 23:59 → created (minute-exact, no early message)", (await run(edge, "2026-10-01", "23:58")).created === 0 && (await run(edge, "2026-10-01", "23:59")).created === 1);
}

// ── 8. Bulk run, isolation ────────────────────────────────────────────────────
console.log("\n8. materializeDue and isolation");
{
  const db = makeDb();
  const r = await M.materializeDue({ now: at("2026-10-02", "15:00"), env: ENV_ON, db });
  ok("materializeDue processes enabled assignments only", r.assignments === 1 && r.created === 3);
  ok("…and is idempotent", (await M.materializeDue({ now: at("2026-10-02", "15:00"), env: ENV_ON, db })).created === 0);
  const banned = /(order|commission|payout|withdraw|deposit|booster|balance|wallet|notification|whatsapp|sms|ugc|reward|fakeOrder|affiliateService|teamBonus|referral)/i;
  ok("service imports no real money / order / messaging / UGC / rewards code", [...src("src/lib/services/demoChatMessageService.js").matchAll(/from\s+['"]([^'"]+)['"]/g)].every((m) => !banned.test(m[1])));
  ok("no route or scheduler job enables materialization in this phase", !/demoChatMessageService/.test(src("src/app/api/admin/demo-chat/journeys/route.js")) && !/demoChatMessageService/.test(src("ecosystem.config.js")));
  ok("fake blocks any non-demo model (would have thrown above)", (await rejects(async () => db.affiliateOrder.findMany()))?.message.includes("BLOCKED"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
