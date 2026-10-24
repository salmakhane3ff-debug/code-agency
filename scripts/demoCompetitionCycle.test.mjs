#!/usr/bin/env node
/**
 * scripts/demoCompetitionCycle.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3A — demo competition 30-day cycle + persistent demo profiles.
 * In-memory fake (DEMO models + only `demo-competition-cycle:*` settings rows;
 * any other table throws) with a real async row lock for FOR UPDATE. Proves:
 *   • 30 Casablanca days, exact boundaries (normal + Ramadan clock changes),
 *     independent of the server time zone
 *   • automatic rollover at the boundary, no drift, idle periods skipped
 *   • repeated reads / module "restarts" keep the same cycle and profile ids
 *   • manual reset archives standings and keeps history; deletion is separate
 *   • leaderboard / profile / archive share one ranking rule
 *   • generation keeps identities (no replacement set); surplus hidden, not deleted
 *   • no duplicate cycles under concurrent requests/workers
 *   • demo data never touches real financial tables
 * Real-Postgres row lock: scripts/demoCompetitionCycle.harness.mjs.
 * Run: node scripts/demoCompetitionCycle.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  competitionDayStart, addCompetitionDays, cycleWindow, isCycleDue, nextCycleWindow,
  cycleDaysLeft, compareStanding, rankStandings, CYCLE_DAYS, CYCLE_ARCHIVE_PREFIX, COMPETITION_TIMEZONE,
} from "../src/lib/demoCompetitionCycle.js";

const H = 3600000, DAY = 24 * H;
const T = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();
const local = (ms) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

// Child-process mode: print pure cycle results (server TZ independence check).
function pureResults() {
  return {
    w1: Object.values(cycleWindow(T("2026-06-15T12:00:00Z"))).map(iso),
    w2: Object.values(cycleWindow(T("2026-02-01T10:00:00Z"))).map(iso),
    w3: Object.values(cycleWindow(T("2026-03-10T10:00:00Z"))).map(iso),
    next: Object.values(nextCycleWindow(T("2026-06-14T23:00:00Z"), T("2026-09-01T00:00:00Z"))).map(String),
    left: [cycleDaysLeft(T("2026-07-14T23:00:00Z"), T("2026-07-14T22:59:59Z")), cycleDaysLeft(T("2026-07-14T23:00:00Z"), T("2026-06-14T23:00:00Z"))],
  };
}
if (process.argv[2] === "--emit") { process.stdout.write(JSON.stringify(pureResults())); process.exit(0); }

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const tick = () => new Promise((r) => setImmediate(r));

// ── Fake DB ──────────────────────────────────────────────────────────────────
function makeDb() {
  let seq = 1;
  const nid = () => `id_${String(seq++).padStart(4, "0")}`;
  const t = { demoAffiliate: [], demoStats: [], demoEarningsHistory: [], demoCompetition: [], demoSettings: [], demoAvatar: [], setting: [] };
  const calls = { tx: 0, rollovers: 0 };
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === "stats") continue;
      if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] || 0) + v.increment;
      else row[k] = v;
    }
  };
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) =>
    v instanceof Date ? row[k] instanceof Date && row[k].getTime() === v.getTime()
      : v && typeof v === "object" && "startsWith" in v ? String(row[k]).startsWith(v.startsWith) : row[k] === v);
  const withStats = (a, include) => (include?.stats ? { ...a, stats: (() => { const s = t.demoStats.find((x) => x.demoAffiliateId === a.id); return s ? { ...s } : null; })() } : { ...a });

  let lockHeld = null; // promise chain = FOR UPDATE row lock
  const models = {
    demoAffiliate: {
      create: async ({ data }) => {
        const a = { id: nid(), isActive: true, createdAt: new Date(Date.now() + seq) }; apply(a, data); t.demoAffiliate.push(a);
        if (data.stats?.create) { const s = { id: nid(), demoAffiliateId: a.id, rank: 0 }; apply(s, data.stats.create); t.demoStats.push(s); }
        return { ...a };
      },
      findMany: async ({ where, include } = {}) => { await tick(); return t.demoAffiliate.filter((a) => match(a, where)).map((a) => withStats(a, include)); },
      findUnique: async ({ where, include, select }) => {
        const a = t.demoAffiliate.find((x) => match(x, where)); if (!a) return null;
        if (select) return Object.fromEntries(Object.keys(select).map((k) => [k, a[k]]));
        const out = withStats(a, include);
        if (include?.earningsHistory) out.earningsHistory = t.demoEarningsHistory.filter((h) => h.demoAffiliateId === a.id);
        return out;
      },
      update: async ({ where, data }) => { const a = t.demoAffiliate.find((x) => match(x, where)); apply(a, data); return { ...a }; },
      count: async ({ where } = {}) => t.demoAffiliate.filter((a) => match(a, where)).length,
    },
    demoStats: {
      findMany: async () => t.demoStats.map((s) => ({ ...s })),
      update: async ({ where, data }) => { await tick(); const s = t.demoStats.find((x) => match(x, where)); apply(s, data); return { ...s }; },
      updateMany: async ({ data }) => { await tick(); for (const s of t.demoStats) apply(s, data); return { count: t.demoStats.length }; },
    },
    demoEarningsHistory: {
      create: async ({ data }) => { const r = { id: nid(), ...data }; t.demoEarningsHistory.push(r); return { ...r }; },
      findFirst: async ({ where }) => { const r = t.demoEarningsHistory.find((x) => match(x, where)); return r ? { ...r } : null; },
      update: async ({ where, data }) => { const r = t.demoEarningsHistory.find((x) => match(x, where)); apply(r, data); return { ...r }; },
      deleteMany: async () => { const n = t.demoEarningsHistory.length; t.demoEarningsHistory = []; return { count: n }; },
    },
    demoCompetition: {
      findUnique: async ({ where }) => { await tick(); const r = t.demoCompetition.find((x) => match(x, where)); return r ? { ...r } : null; },
      create: async ({ data }) => {
        await tick();
        if (t.demoCompetition.some((r) => r.id === data.id)) throw Object.assign(new Error("unique"), { code: "P2002" });
        t.demoCompetition.push({ ...data }); return { ...data };
      },
      update: async ({ where, data }) => { await tick(); const r = t.demoCompetition.find((x) => match(x, where)); apply(r, data); return { ...r }; },
    },
    demoSettings: {
      findUnique: async ({ where }) => { const r = t.demoSettings.find((x) => match(x, where)); return r ? { ...r } : null; },
      upsert: async ({ where, update, create }) => { let r = t.demoSettings.find((x) => match(x, where)); if (r) apply(r, update); else { r = { ...create }; t.demoSettings.push(r); } return { ...r }; },
    },
    demoAvatar: { findMany: async () => t.demoAvatar.map((a) => ({ ...a })) },
    setting: {
      create: async ({ data }) => {
        await tick();
        if (!String(data.id).startsWith(CYCLE_ARCHIVE_PREFIX)) throw new Error(`NON-DEMO SETTING WRITE: ${data.id}`);
        if (t.setting.some((r) => r.id === data.id)) throw Object.assign(new Error("unique"), { code: "P2002" });
        t.setting.push(structuredClone(data)); return data;
      },
      findMany: async ({ where }) => t.setting.filter((r) => match(r, where)).map((r) => structuredClone(r)),
      deleteMany: async ({ where }) => { const n = t.setting.length; t.setting = t.setting.filter((r) => !match(r, where)); return { count: n - t.setting.length }; },
    },
  };
  const guard = (target) => new Proxy(target, {
    get(o, k) {
      if (typeof k === "symbol" || k === "then") return undefined;
      if (k in o) return o[k];
      throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: db.${String(k)}`);
    },
  });
  const db = guard({
    ...models, _t: t, _calls: calls,
    $transaction: async (fn) => {
      calls.tx++;
      let release = null;
      const tx = guard({
        ...models,
        $queryRaw: async (strings) => {
          if (!/FROM "demo_competition"[\s\S]*FOR UPDATE/.test(strings.join("?"))) throw new Error("unexpected raw query");
          while (lockHeld) await lockHeld;                    // wait for the row lock
          lockHeld = new Promise((r) => { release = r; });
          await tick();
          return t.demoCompetition.filter((r) => r.id === "current").map((r) => ({ ...r }));
        },
      });
      const snapshot = structuredClone(t);                  // rollback on throw
      try { const out = await fn(tx); if (out) calls.rollovers++; return out; }
      catch (e) { Object.assign(t, snapshot); throw e; }
      finally { if (release) { const r = release; lockHeld = null; r(); } }
    },
  });
  return db;
}

const svc = await import("../src/lib/services/demoService.js");
const fresh = (db) => { svc.__setDemoDb(db); svc.invalidateDemoCache(); return db; };
const seedStats = (db, list) => { // list: [orders, revenue] per affiliate (creation order); others → 0
  db._t.demoStats.forEach((s, i) => { s.totalOrders = list[i]?.[0] ?? 0; s.totalRevenue = list[i]?.[1] ?? 0; });
};

// ── 1. Cycle boundaries (pure) ───────────────────────────────────────────────
console.log("\n1. 30-day Casablanca cycle boundaries");
{
  const w = cycleWindow(T("2026-06-15T12:00:00Z"));
  ok("starts at Casablanca midnight (UTC+1 → 23:00Z the day before)", iso(w.start) === "2026-06-14T23:00:00.000Z" && local(w.start) === "2026-06-15 00:00");
  ok("ends 30 local days later at midnight (exclusive): 15 Jul 00:00 local", iso(w.end) === "2026-07-14T23:00:00.000Z" && local(w.end) === "2026-07-15 00:00");
  ok("normal cycle = exactly 720 h", w.end - w.start === CYCLE_DAYS * DAY);
  const wr = cycleWindow(T("2026-02-01T10:00:00Z")); // spans the 15 Feb switch-back (UTC+1→UTC+0)
  ok("cycle across the Ramadan switch-back is 721 h, still midnight → midnight", wr.end - wr.start === 721 * H && local(wr.start) === "2026-02-01 00:00" && local(wr.end) === "2026-03-03 00:00");
  const wf = cycleWindow(T("2026-03-10T10:00:00Z")); // spans the 22 Mar switch-forward
  ok("cycle across the switch-forward is 719 h, still midnight → midnight", wf.end - wf.start === 719 * H && local(wf.start) === "2026-03-10 00:00" && local(wf.end) === "2026-04-09 00:00");
  ok("day start is exact on the switch-back day (14 Feb 23:00Z)", iso(competitionDayStart(T("2026-02-15T12:00:00Z"))) === "2026-02-14T23:00:00.000Z");
  ok("23:59:59.999 local still in the old day, 00:00 local starts the next", competitionDayStart(T("2026-06-15T22:59:59.999Z")) === T("2026-06-14T23:00:00Z") && competitionDayStart(T("2026-06-15T23:00:00Z")) === T("2026-06-15T23:00:00Z"));
  ok("isCycleDue: end − 1 ms → no, end → yes", !isCycleDue(w.end, w.end - 1) && isCycleDue(w.end, w.end));
  const n = nextCycleWindow(w.end, w.end + 5 * 60000);
  ok("next cycle starts exactly at the previous end (no drift)", n.start === w.end && n.end === addCompetitionDays(w.end, 30) && n.skipped === 0);
  const idle = nextCycleWindow(w.end, w.end + 75 * DAY);
  ok("75 idle days → 2 whole cycles skipped, still on the 30-day grid", idle.skipped === 2 && idle.start === addCompetitionDays(w.end, 60) && idle.start <= w.end + 75 * DAY && w.end + 75 * DAY < idle.end);
  ok("days left: 1 ms before end → 1, at start → 30", cycleDaysLeft(w.end, w.end - 1) === 1 && cycleDaysLeft(w.end, w.start) === 30 && cycleDaysLeft(w.end, w.end + 1) === 0);
  ok("timezone constant is Africa/Casablanca", COMPETITION_TIMEZONE === "Africa/Casablanca");

  const me = fileURLToPath(import.meta.url);
  const expected = JSON.stringify(pureResults());
  for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Africa/Casablanca"]) {
    const r = spawnSync(process.execPath, [me, "--emit"], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    ok(`server TZ=${tz} → identical cycle boundaries`, r.status === 0 && r.stdout === expected);
  }
}

// ── 2. Automatic rollover ────────────────────────────────────────────────────
console.log("\n2. Automatic transition at the 30-day boundary");
{
  const db = fresh(makeDb());
  const t0 = T("2026-06-15T12:00:00Z");
  await svc.generateDemoAffiliates(10, "mixed");
  db._t.demoCompetition.length = 0; // pin the first cycle at a known date
  await svc.ensureCompetition({ now: t0 });
  const c1 = db._t.demoCompetition[0];
  ok("first cycle = Casablanca 30-day window (not a calendar month)", iso(c1.startDate.getTime()) === "2026-06-14T23:00:00.000Z" && iso(c1.endDate.getTime()) === "2026-07-14T23:00:00.000Z" && c1.cycleNum === 1);
  seedStats(db, [[50, 900], [40, 800], [40, 950]]);
  const end = c1.endDate.getTime();

  const before = await svc.getCompetitionInfo({ now: end - 1 });
  ok("1 ms before the end: same cycle, 1 day left, no archive", before.cycleNum === 1 && before.daysLeft === 1 && db._t.setting.length === 0);
  const historyBefore = db._t.demoEarningsHistory.length;
  const at = await svc.getCompetitionInfo({ now: end });
  const c2 = db._t.demoCompetition[0];
  ok("at the end instant a plain read rolls over to cycle #2 (no admin click)", at.cycleNum === 2 && c2.cycleNum === 2);
  ok("cycle #2 starts exactly at cycle #1's end, 30 local days long", c2.startDate.getTime() === end && iso(c2.endDate.getTime()) === "2026-08-13T23:00:00.000Z");
  const arch = db._t.setting.find((r) => r.id === `${CYCLE_ARCHIVE_PREFIX}1`)?.data;
  ok("cycle #1 archived with reason 'auto' and its dates", arch && arch.reason === "auto" && arch.cycleNum === 1 && arch.startDate === "2026-06-14T23:00:00.000Z" && arch.endDate === "2026-07-14T23:00:00.000Z");
  ok("archived standings: all participants, ranked by the single rule", arch.participants === 10 && arch.standings[0].totalOrders === 50 && arch.standings[1].totalRevenue === 950 && arch.standings.every((s, i) => s.rank === i + 1));
  ok("scores zeroed for the new cycle", db._t.demoStats.every((s) => s.totalOrders === 0 && s.totalRevenue === 0 && s.rank === 0));
  ok("earnings history kept on automatic rollover", db._t.demoEarningsHistory.length === historyBefore && historyBefore > 0);

  for (let i = 0; i < 5; i++) await svc.getCompetitionInfo({ now: end + i * 1000 });
  ok("repeated reads after the rollover → still cycle #2, one archive", db._t.demoCompetition[0].cycleNum === 2 && db._t.setting.length === 1);

  const c2End = c2.endDate.getTime(); // capture: the fake mutates the row object on update
  const far = await svc.getCompetitionInfo({ now: c2End + 40 * DAY }); // long idle period
  const c3 = db._t.demoCompetition[0];
  ok("after a long idle period: one rollover, start stays on the 30-day grid", far.cycleNum === 3 && c3.startDate.getTime() === addCompetitionDays(c2End, 30) && db._t.setting.length === 2);

  // simulateTick (worker) also rolls over.
  await svc.saveDemoSettings({ isEnabled: true });
  db._t.demoCompetition[0].endDate = new Date(Date.now() - 1000);
  await svc.simulateTick();
  ok("a simulation tick past the end rolls over too", db._t.demoCompetition[0].cycleNum === 4 && db._t.setting.length === 3);
}

// ── 3. Restarts / repeated reads keep cycle + profile ids ────────────────────
console.log("\n3. Restarts and repeated reads preserve cycle and profile ids");
{
  const db = fresh(makeDb());
  const now = T("2026-06-20T10:00:00Z");
  await svc.generateDemoAffiliates(12, "mixed");
  db._t.demoCompetition.length = 0;
  const info1 = await svc.getCompetitionInfo({ now });
  const ids1 = (await svc.getLeaderboard(50)).map((r) => r.id).sort();
  const pool1 = (await svc.getDemoIdentityPool()).map((p) => p.id);

  const restarted = await import("../src/lib/services/demoService.js?restart=1"); // new module instance = process restart
  restarted.__setDemoDb(db);
  const info2 = await restarted.getCompetitionInfo({ now: now + 3600000 });
  const ids2 = (await restarted.getLeaderboard(50)).map((r) => r.id).sort();
  const pool2 = (await restarted.getDemoIdentityPool()).map((p) => p.id);
  ok("same cycle after a restart (number + dates)", info1.cycleNum === info2.cycleNum && +info1.startDate === +info2.startDate && +info1.endDate === +info2.endDate);
  ok("same profile ids after a restart", JSON.stringify(ids1) === JSON.stringify(ids2));
  ok("same identity pool ids after a restart", JSON.stringify(pool1) === JSON.stringify(pool2));
  ok("only one competition row ever", db._t.demoCompetition.length === 1);

  await svc.resetCompetition({ now: now + DAY });
  const ids3 = (await svc.getLeaderboard(50)).map((r) => r.id).sort();
  ok("profile ids unchanged across a new cycle", JSON.stringify(ids1) === JSON.stringify(ids3));
}

// ── 4. Manual reset vs explicit history deletion ─────────────────────────────
console.log("\n4. Manual reset keeps history; deletion is a separate action");
{
  const db = fresh(makeDb());
  const now = T("2026-06-20T10:00:00Z");
  await svc.generateDemoAffiliates(8, "women");
  db._t.demoCompetition.length = 0;
  await svc.ensureCompetition({ now });
  seedStats(db, [[9, 100], [7, 50]]);
  const hist = db._t.demoEarningsHistory.length;
  const r1 = await svc.resetCompetition({ now: now + 5 * DAY });
  const comp = db._t.demoCompetition[0];
  ok("manual reset → new cycle #2, previous #1 archived", r1.cycle === 2 && r1.archived === 1 && db._t.setting.some((r) => r.id === `${CYCLE_ARCHIVE_PREFIX}1` && r.data.reason === "manual"));
  ok("manual cycle restarts on today's Casablanca midnight, 30 days", comp.startDate.getTime() === competitionDayStart(now + 5 * DAY) && comp.endDate.getTime() === addCompetitionDays(comp.startDate.getTime(), 30));
  ok("earnings history KEPT on manual reset", db._t.demoEarningsHistory.length === hist && hist > 0);
  ok("archived standings preserved the winner", db._t.setting[0].data.standings[0].totalOrders === 9);
  ok("legacy boolean argument never deletes history", (await svc.resetCompetition(true), db._t.demoEarningsHistory.length === hist) && db._t.setting.length === 2);
  const list = await svc.listCompetitionHistory();
  ok("history list: newest first with top 3", list.length === 2 && list[0].cycleNum === 2 && list[1].cycleNum === 1 && list[1].top[0].totalOrders === 9);
  const del = await svc.clearCompetitionHistory();
  ok("explicit deletion removes archives + demo earnings history only", del.deletedCycles === 2 && db._t.setting.length === 0 && db._t.demoEarningsHistory.length === 0 && db._t.demoAffiliate.length === 8 && db._t.demoStats.length === 8);

  const resetRoute = src("src/app/api/admin/demo/reset/route.js");
  const histRoute = src("src/app/api/admin/demo/history/route.js");
  ok("reset route calls resetCompetition() (no history deletion)", /await resetCompetition\(\);/.test(resetRoute) && !/clearCompetitionHistory/.test(resetRoute));
  ok("history deletion: separate admin-only DELETE route with explicit confirmation",
    /export const DELETE = withAdminAuth\(/.test(histRoute) && /confirm !== 'DELETE_HISTORY'/.test(histRoute) && /export const GET = withAdminAuth\(/.test(histRoute));
  const svcSrc = src("src/lib/services/demoService.js");
  ok("only clearCompetitionHistory deletes demo earnings history", (svcSrc.match(/demoEarningsHistory\.deleteMany/g) || []).length === 1 && /export async function clearCompetitionHistory[\s\S]{0,300}demoEarningsHistory\.deleteMany/.test(svcSrc));
}

// ── 5. Ranking consistency ───────────────────────────────────────────────────
console.log("\n5. Leaderboard / profile / archive use the same ranking");
{
  ok("rule: orders ↓, revenue ↓, id ↑", JSON.stringify(rankStandings([
    { id: "b", totalOrders: 5, totalRevenue: 10 }, { id: "a", totalOrders: 5, totalRevenue: 10 },
    { id: "c", totalOrders: 5, totalRevenue: 20 }, { id: "d", totalOrders: 9, totalRevenue: 0 },
  ]).map((r) => `${r.rank}${r.id}`)) === '["1d","2c","3a","4b"]' && compareStanding({ id: "x", totalOrders: 1 }, { id: "y", totalOrders: 1 }) < 0);
  const db = fresh(makeDb());
  await svc.generateDemoAffiliates(10, "mixed");
  seedStats(db, [[5, 100], [5, 100], [5, 300], [9, 1], [0, 0], [5, 100], [2, 2], [2, 2], [7, 7], [1, 1]]);
  db._t.demoAffiliate[9].isActive = false; // hidden profile
  svc.invalidateDemoCache();
  const board = await svc.getLeaderboard(50);
  const details = await Promise.all(board.map((r) => svc.getDemoAffiliateDetails(r.id)));
  ok("leaderboard rank === profile rank for every profile (ties included)", board.every((r, i) => details[i].rank === r.rank));
  ok("ties broken by revenue then id", board[0].totalOrders === 9 && board[1].totalOrders === 7 && board[2].totalRevenue === 300 && board[3].id < board[4].id && board[4].id < board[5].id);
  ok("profile exposes the same cycle as the leaderboard", details.every((d) => d.cycleNum === db._t.demoCompetition[0].cycleNum));
  const hidden = await svc.getDemoAffiliateDetails(db._t.demoAffiliate[9].id);
  ok("deactivated profile: not on the board, rank 0", !board.some((r) => r.id === hidden.id) && hidden.rank === 0);
  await svc.resetCompetition({ now: Date.now() });
  const arch = db._t.setting[0].data.standings;
  ok("archived standings === final leaderboard order", JSON.stringify(arch.map((s) => s.demoAffiliateId)) === JSON.stringify(board.map((r) => r.id)));
}

// ── 6. Persistent profiles ───────────────────────────────────────────────────
console.log("\n6. Generation keeps identities (no replacement set)");
{
  const db = fresh(makeDb());
  await svc.generateDemoAffiliates(10, "mixed");
  const snap = () => db._t.demoAffiliate.map((a) => `${a.id}|${a.name}|${a.username}|${a.avatarUrl}|${a.isActive}`);
  const first = snap();
  const again = await svc.generateDemoAffiliates(10, "women");
  ok("generate(10) again → same 10 profiles, nothing created or replaced", JSON.stringify(snap()) === JSON.stringify(first) && again.created === 0);
  const more = await svc.generateDemoAffiliates(13, "mixed");
  ok("generate(13) → the same 10 + 3 new", more.created === 3 && JSON.stringify(snap().slice(0, 10)) === JSON.stringify(first) && db._t.demoAffiliate.length === 13);
  const histLen = db._t.demoEarningsHistory.length;
  const fewer = await svc.generateDemoAffiliates(8, "mixed");
  ok("generate(8) → 5 most recent hidden (isActive=false), none deleted", fewer.deactivated === 5 && db._t.demoAffiliate.length === 13 && db._t.demoAffiliate.filter((a) => a.isActive).length === 8 && db._t.demoAffiliate.slice(0, 8).every((a) => a.isActive));
  ok("generation never deletes history or stats", db._t.demoEarningsHistory.length === histLen && db._t.demoStats.length === 13);
  const back = await svc.generateDemoAffiliates(12, "mixed");
  ok("generate(12) → hidden profiles reactivated with their old ids (no new ones)", back.reactivated === 4 && back.created === 0 && db._t.demoAffiliate.length === 13);
  ok("usernames stay unique", new Set(db._t.demoAffiliate.map((a) => a.username)).size === 13);
  svc.invalidateDemoCache();
  const pool = await svc.getDemoIdentityPool();
  ok("identity pool = active profiles first (same ids) + deterministic extras", pool.slice(0, 12).every((p) => db._t.demoAffiliate.find((a) => a.id === p.id && a.isActive)) && pool[12].id === "demo-extra-001");
}

// ── 7. Concurrency ───────────────────────────────────────────────────────────
console.log("\n7. No duplicate cycles under concurrent requests / workers");
{
  const db = fresh(makeDb());
  await svc.generateDemoAffiliates(6, "mixed");
  db._t.demoCompetition.length = 0;
  await svc.ensureCompetition({ now: T("2026-06-15T12:00:00Z") });
  const end = db._t.demoCompetition[0].endDate.getTime();
  const res = await Promise.all(Array.from({ length: 20 }, () => svc.advanceCompetitionIfDue({ now: end + 10 })));
  ok("20 concurrent rollovers at the boundary → exactly one succeeds", res.filter(Boolean).length === 1 && db._t.demoCompetition[0].cycleNum === 2);
  ok("exactly one archive, no duplicate cycle number", db._t.setting.length === 1 && db._t.setting[0].id === `${CYCLE_ARCHIVE_PREFIX}1`);
  const infos = await Promise.all(Array.from({ length: 10 }, () => svc.getCompetitionInfo({ now: end + 20 })));
  ok("10 concurrent public reads afterwards → all see cycle #2, nothing rolled", infos.every((i) => i.cycleNum === 2) && db._t.setting.length === 1);
  const resets = await Promise.all([1, 2, 3].map(() => svc.resetCompetition({ now: end + DAY })));
  ok("3 concurrent manual resets serialize → cycles 3,4,5, archives #2,#3,#4 (no duplicates)",
    JSON.stringify(resets.map((r) => r.cycle).sort()) === "[3,4,5]" && db._t.setting.map((r) => r.id).sort().join() === ["2", "3", "4", "1"].map((n) => `${CYCLE_ARCHIVE_PREFIX}${n}`).sort().join());

  const db2 = fresh(makeDb());
  await Promise.all(Array.from({ length: 8 }, () => svc.ensureCompetition({ now: T("2026-06-15T12:00:00Z") })));
  ok("concurrent first-time creation → a single competition row", db2._t.demoCompetition.length === 1);
}

// ── 8. Demo / real isolation ─────────────────────────────────────────────────
console.log("\n8. Demo data stays separate from real money");
{
  const db = fresh(makeDb());
  let blocked = 0;
  for (const m of ["affiliate", "affiliateOrder", "affiliatePayout", "order", "ugcEarning", "affiliateSecurityDeposit", "affiliateBoosterPurchase"]) {
    try { db[m].findMany(); } catch { blocked++; }
  }
  ok("real tables unreachable through the demo DB seam", blocked === 7);
  await svc.generateDemoAffiliates(5, "mixed");
  await svc.saveDemoSettings({ isEnabled: true });
  await svc.simulateTick();
  await svc.resetCompetition({ now: Date.now() });
  await svc.listCompetitionHistory();
  await svc.clearCompetitionHistory();
  ok("generate / tick / reset / history ran entirely on demo tables (fake throws otherwise)", true);
  let settingBlocked = false;
  try { await db.setting.create({ data: { id: "team-bonus-config", data: {} } }); } catch { settingBlocked = true; }
  ok("only demo-competition-cycle:* settings rows can be written by the demo code", settingBlocked);
  const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");
  const res = await upsertSettingsHandler(new Request(`http://x/api/setting?type=${CYCLE_ARCHIVE_PREFIX}1`, { method: "POST", body: "{}" }));
  ok("archives cannot be overwritten through /api/setting (400)", res.status === 400);
  const svcSrc = src("src/lib/services/demoService.js");
  ok("demoService imports no financial service", !/affiliateSystemService|orderService|payout|depositService|boosterService|rewardsService/.test(svcSrc.split("\n").filter((l) => l.startsWith("import")).join("\n")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
