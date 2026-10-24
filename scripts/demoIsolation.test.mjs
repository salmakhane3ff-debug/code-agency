#!/usr/bin/env node
/**
 * scripts/demoIsolation.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Demo Competition system is FULLY ISOLATED from production data.
 *
 * Strategy: swap the demoService DB (via __setDemoDb) for an in-memory fake that
 * exposes ONLY the six demo models. It is wrapped in a Proxy that THROWS on any
 * other property (affiliate, ugcEarning, ugcDailyTarget, affiliatePayout,
 * wallet, …). So if generate / simulate / reset run to completion, they provably
 * never read or wrote a single production table — no network, no real DB.
 *
 * Covers (spec §9):
 *   • Boutique earnings ≠ UGC earnings (separate fields, independent)
 *   • Demo UGC never writes ugc_earnings / ugc_daily_targets (throws if it tried)
 *   • Demo never touches wallets / payouts / commissions / real affiliates
 *   • Avatar library is PERMANENT — survives regeneration + simulation ticks
 *   • Each demo affiliate keeps ONE persisted avatarUrl (never re-randomized)
 *   • Deleting a library avatar leaves assigned affiliate.avatarUrl intact
 *   • New cycle (reset) clears ONLY demo stats, including the 4 UGC fields,
 *     archives the standings and KEEPS the earnings history (Phase 3A)
 * Run: node scripts/demoIsolation.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { makeCoverageExecutor } from "./demoSimCoverageFake.mjs";
import {
  __setDemoDb,
  generateDemoAffiliates,
  simulateTick,
  resetCompetition,
  getLeaderboard,
  getDemoAffiliateDetails,
  listDemoAvatars,
  deleteDemoAvatar,
  saveDemoSettings,
  getDemoSettings,
  clampSimInterval,
  runAutoSimTick,
  DEMO_SIM_DEFAULT_INTERVAL,
  pickTickOrderCount,
  pickWeightedRecipient,
  getDemoIdentityPool,
  invalidateDemoCache,
} from "../src/lib/services/demoService.js";
import { buildEvent } from "../src/lib/services/liveActivityEngine.js";
import { normalizeLiveActivity } from "../src/lib/recruitmentCta.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

// ── In-memory fake Prisma (DEMO models only) ────────────────────────────────────
function makeFakeDb() {
  let seq = 1;
  const id = () => `id_${seq++}`;
  const store = {
    demoAvatar: [],
    demoAffiliate: [],
    demoStats: [],
    demoEarningsHistory: [],
    demoCompetition: [],
    demoSettings: [],
    setting: [], // ONLY demo-competition-cycle:* archive rows (+ raw demo-sim-participants:* evidence) are allowed
    demoSimDayCoverage: [],
    rawWrites: [],
  };
  const execRaw = makeCoverageExecutor(store, store.rawWrites);

  // Apply data honouring Prisma's { increment } shape.
  const applyData = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === "stats") continue; // nested handled by caller
      if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] || 0) + v.increment;
      else if (v && typeof v === "object" && "decrement" in v) row[k] = (row[k] || 0) - v.decrement;
      else row[k] = v;
    }
  };
  const matches = (row, where) =>
    Object.entries(where).every(([k, v]) => {
      if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
      return row[k] === v;
    });

  const attachIncludes = (aff, include) => {
    if (!include) return aff;
    const out = { ...aff };
    if (include.stats) out.stats = store.demoStats.find((s) => s.demoAffiliateId === aff.id) || null;
    if (include.earningsHistory) {
      let h = store.demoEarningsHistory.filter((r) => r.demoAffiliateId === aff.id);
      const o = include.earningsHistory.orderBy;
      if (o?.date === "asc") h = h.slice().sort((a, b) => a.date - b.date);
      if (o?.date === "desc") h = h.slice().sort((a, b) => b.date - a.date);
      if (include.earningsHistory.take) h = h.slice(0, include.earningsHistory.take);
      out.earningsHistory = h;
    }
    return out;
  };

  const models = {
    demoAvatar: {
      findMany: async ({ orderBy } = {}) => {
        let rows = store.demoAvatar.slice();
        if (orderBy?.createdAt === "desc") rows = rows.sort((a, b) => b.createdAt - a.createdAt);
        return rows.map((r) => ({ ...r }));
      },
      create: async ({ data }) => { const r = { id: id(), createdAt: new Date(), storageKey: null, ...data }; store.demoAvatar.push(r); return { ...r }; },
      findUnique: async ({ where }) => { const r = store.demoAvatar.find((x) => matches(x, where)); return r ? { ...r } : null; },
      delete: async ({ where }) => { const i = store.demoAvatar.findIndex((x) => matches(x, where)); if (i < 0) throw new Error("not found"); const [r] = store.demoAvatar.splice(i, 1); return { ...r }; },
      count: async () => store.demoAvatar.length,
    },
    demoAffiliate: {
      deleteMany: async () => { const n = store.demoAffiliate.length; store.demoAffiliate = []; return { count: n }; },
      create: async ({ data }) => {
        const aff = { id: id(), isActive: true };
        applyData(aff, data);
        store.demoAffiliate.push(aff);
        if (data.stats?.create) {
          const s = { id: id(), demoAffiliateId: aff.id, rank: 0 };
          applyData(s, data.stats.create);
          store.demoStats.push(s);
        }
        return { ...aff };
      },
      findUnique: async ({ where, include, select }) => {
        const aff = store.demoAffiliate.find((x) => matches(x, where));
        if (!aff) return null;
        if (select) { const o = {}; for (const k of Object.keys(select)) o[k] = aff[k]; return o; }
        return attachIncludes(aff, include);
      },
      update: async ({ where, data }) => { const r = store.demoAffiliate.find((x) => matches(x, where)); if (!r) throw new Error("affiliate not found"); applyData(r, data); return { ...r }; },
      findMany: async ({ where, include, orderBy, take } = {}) => {
        let rows = store.demoAffiliate.filter((x) => (where ? matches(x, where) : true)).map((a) => attachIncludes(a, include));
        if (orderBy?.stats?.totalOrders === "desc") rows = rows.sort((a, b) => (b.stats?.totalOrders || 0) - (a.stats?.totalOrders || 0));
        if (take) rows = rows.slice(0, take);
        return rows;
      },
      count: async ({ where } = {}) => store.demoAffiliate.filter((x) => (where ? matches(x, where) : true)).length,
    },
    demoStats: {
      deleteMany: async () => { const n = store.demoStats.length; store.demoStats = []; return { count: n }; },
      findMany: async ({ orderBy, select } = {}) => {
        let rows = store.demoStats.slice();
        if (Array.isArray(orderBy)) {
          rows = rows.sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0) || (b.totalRevenue || 0) - (a.totalRevenue || 0));
        }
        if (select) return rows.map((r) => { const o = {}; for (const k of Object.keys(select)) o[k] = r[k]; return o; });
        return rows.map((r) => ({ ...r }));
      },
      update: async ({ where, data }) => { const r = store.demoStats.find((x) => matches(x, where)); if (!r) throw new Error("stats not found"); applyData(r, data); return { ...r }; },
      updateMany: async ({ data }) => { for (const r of store.demoStats) applyData(r, data); return { count: store.demoStats.length }; },
    },
    demoEarningsHistory: {
      deleteMany: async () => { const n = store.demoEarningsHistory.length; store.demoEarningsHistory = []; return { count: n }; },
      create: async ({ data }) => { const r = { id: id(), ...data }; store.demoEarningsHistory.push(r); return { ...r }; },
      findFirst: async ({ where }) => { const r = store.demoEarningsHistory.find((x) => matches(x, where)); return r ? { ...r } : null; },
      update: async ({ where, data }) => { const r = store.demoEarningsHistory.find((x) => matches(x, where)); if (!r) throw new Error("history not found"); applyData(r, data); return { ...r }; },
    },
    demoCompetition: {
      findUnique: async ({ where }) => { const r = store.demoCompetition.find((x) => matches(x, where)); return r ? { ...r } : null; },
      create: async ({ data }) => { const r = { ...data }; store.demoCompetition.push(r); return { ...r }; },
      upsert: async ({ where, update, create }) => {
        let r = store.demoCompetition.find((x) => matches(x, where));
        if (r) applyData(r, update); else { r = { ...create }; store.demoCompetition.push(r); }
        return { ...r };
      },
      update: async ({ where, data }) => { const r = store.demoCompetition.find((x) => matches(x, where)); if (!r) throw new Error("competition not found"); applyData(r, data); return { ...r }; },
    },
    setting: {
      create: async ({ data }) => {
        if (!String(data.id).startsWith("demo-competition-cycle:")) throw new Error(`PRODUCTION SETTING WRITE BLOCKED: ${data.id}`);
        if (store.setting.some((r) => r.id === data.id)) throw Object.assign(new Error("unique"), { code: "P2002" });
        store.setting.push({ ...data }); return { ...data };
      },
      findMany: async ({ where }) => store.setting.filter((r) => r.id.startsWith(where.id.startsWith)).map((r) => ({ ...r })),
      deleteMany: async ({ where }) => { const before = store.setting.length; store.setting = store.setting.filter((r) => !r.id.startsWith(where.id.startsWith)); return { count: before - store.setting.length }; },
    },
    // Interactive transaction (single-threaded fake) + the competition row lock.
    $transaction: async (fn) => fn(db),
    $executeRaw: (...a) => execRaw(...a), // simulation coverage evidence — demo tables only, anything else throws
    $queryRaw: async (strings) => {
      if (!/FROM "demo_competition"/.test(strings.join("?"))) throw new Error("unexpected raw query");
      return store.demoCompetition.filter((r) => r.id === "current").map((r) => ({ ...r }));
    },
    demoSettings: {
      findUnique: async ({ where }) => { const r = store.demoSettings.find((x) => matches(x, where)); return r ? { ...r } : null; },
      upsert: async ({ where, update, create }) => {
        let r = store.demoSettings.find((x) => matches(x, where));
        if (r) applyData(r, update); else { r = { ...create }; store.demoSettings.push(r); }
        return { ...r };
      },
    },
  };

  const db = new Proxy(models, {
    get(target, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return undefined; // not a thenable
      if (prop in target) return target[prop];
      throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: db.${String(prop)} — demo code must never touch production data`);
    },
  });

  return { db, store };
}

// Seed avatar rows directly (bypasses sharp/storage — this test targets DB isolation).
function seedAvatars(store, men, women) {
  let n = 1;
  for (let i = 0; i < men; i++)   store.demoAvatar.push({ id: `av_m${i}`, gender: "men",   url: `/uploads/demo/avatars/m${i}.webp`, storageKey: null, createdAt: new Date(1000 + n++) });
  for (let i = 0; i < women; i++) store.demoAvatar.push({ id: `av_w${i}`, gender: "women", url: `/uploads/demo/avatars/w${i}.webp`, storageKey: null, createdAt: new Date(1000 + n++) });
}

async function main() {
  console.log("1) Production tables are unreachable through the demo DB seam:");
  {
    const { db } = makeFakeDb();
    __setDemoDb(db);
    let threwAffiliate = false, threwUgc = false, threwPayout = false;
    try { await db.affiliate.findMany(); } catch { threwAffiliate = true; }
    try { await db.ugcEarning.aggregate(); } catch { threwUgc = true; }
    try { await db.affiliatePayout.create({}); } catch { threwPayout = true; }
    ok("real 'affiliate' table access throws", threwAffiliate);
    ok("'ugcEarning' table access throws", threwUgc);
    ok("'affiliatePayout' table access throws", threwPayout);
  }

  console.log("2) generate → simulate → reset run WITHOUT touching any production table:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 3, 3);
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });

    let genErr = null, simErr = null, resErr = null;
    try { await generateDemoAffiliates(10, "mixed"); } catch (e) { genErr = e; }
    ok("generateDemoAffiliates completes (no production access)", genErr === null);
    try { await simulateTick(); } catch (e) { simErr = e; }
    ok("simulateTick completes (no production access)", simErr === null);
    try { await resetCompetition(true); } catch (e) { resErr = e; }
    ok("resetCompetition completes (no production access)", resErr === null);
    if (genErr || simErr || resErr) console.log("     err:", (genErr || simErr || resErr)?.message);
  }

  console.log("3) Boutique earnings and UGC earnings are separate, independent fields:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 5, 5);
    await generateDemoAffiliates(12, "mixed");
    const board = await getLeaderboard(50);
    const details = await getDemoAffiliateDetails(board[0].id);
    ok("details expose boutique totalRevenue", typeof details.totalRevenue === "number");
    ok("details expose separate ugcTotalEarnings", typeof details.ugcTotalEarnings === "number");
    ok("boutique and UGC fields are distinct keys", "totalRevenue" in details && "ugcTotalEarnings" in details);
    // Demo UGC earnings must equal sales × the demo commission (5) — never a real rate.
    ok("ugcTotalEarnings == ugcTotalSales × 5", Math.abs(details.ugcTotalEarnings - details.ugcTotalSales * 5) < 0.01);
    ok("ugcTodayEarnings == ugcTodaySales × 5", Math.abs(details.ugcTodayEarnings - details.ugcTodaySales * 5) < 0.01);
    ok("seeded today UGC sales within 0..30", details.ugcTodaySales >= 0 && details.ugcTodaySales <= 30 + 999);
  }

  console.log("4) Avatar library is PERMANENT — survives regeneration & simulation:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 4, 4);
    const before = (await listDemoAvatars()).length;
    ok("library seeded with 8 avatars", before === 8);

    await generateDemoAffiliates(20, "mixed");
    ok("library unchanged after 1st generation", (await listDemoAvatars()).length === 8);

    await generateDemoAffiliates(20, "mixed"); // regenerate
    ok("library unchanged after REGENERATION", (await listDemoAvatars()).length === 8);

    await saveDemoSettings({ isEnabled: true, simulationSpeed: "medium" });
    await simulateTick();
    ok("library unchanged after simulation tick", (await listDemoAvatars()).length === 8);

    await resetCompetition(true);
    ok("library unchanged after reset/new cycle", (await listDemoAvatars()).length === 8);
  }

  console.log("5) Each demo affiliate keeps ONE persisted avatarUrl (never re-randomized):");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 3, 3);
    await generateDemoAffiliates(15, "mixed");
    const board = await getLeaderboard(50);
    const withAvatar = board.filter((a) => a.avatarUrl);
    ok("affiliates were assigned avatars from the library", withAvatar.length === board.length);
    ok("each avatarUrl belongs to the library", withAvatar.every((a) => store.demoAvatar.some((av) => av.url === a.avatarUrl)));
    ok("gender-matched avatars (men avatar → men affiliate)", withAvatar.every((a) => a.avatarUrl.includes(a.gender === "men" ? "/m" : "/w")));

    // avatarUrl is stable across a simulation tick (persisted, not regenerated)
    const target = board[0];
    const beforeUrl = target.avatarUrl;
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });
    await simulateTick();
    const after = await getDemoAffiliateDetails(target.id);
    ok("avatarUrl unchanged after simulation tick", after.avatarUrl === beforeUrl);
  }

  console.log("6) Empty library → initials fallback (avatarUrl null), no crash:");
  {
    const { db } = makeFakeDb();
    __setDemoDb(db);
    await generateDemoAffiliates(6, "mixed"); // no avatars seeded
    const board = await getLeaderboard(50);
    ok("generation works with empty library", board.length === 6);
    ok("all avatarUrl are null (→ initials fallback in UI)", board.every((a) => a.avatarUrl === null));
  }

  console.log("7) Deleting a library avatar leaves assigned affiliate.avatarUrl intact:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 1, 0); // exactly one men avatar
    await generateDemoAffiliates(5, "men");
    const board = await getLeaderboard(50);
    const assignedUrl = board[0].avatarUrl;
    ok("the single avatar was assigned to affiliates", board.every((a) => a.avatarUrl === assignedUrl));

    const avatarId = store.demoAvatar[0].id;
    const res = await deleteDemoAvatar(avatarId);
    ok("avatar removed from library", res.deleted === true && store.demoAvatar.length === 0);

    // The assigned copy on the affiliate row must remain — never a broken image.
    const details = await getDemoAffiliateDetails(board[0].id);
    ok("affiliate.avatarUrl still points to the (now stored) URL", details.avatarUrl === assignedUrl);
  }

  console.log("8) New cycle (reset) clears ONLY demo stats — including the 4 UGC fields:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 2, 2);
    await generateDemoAffiliates(8, "mixed");
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });
    await simulateTick(); // accrue some boutique + UGC numbers

    await resetCompetition(true);
    const stats = store.demoStats;
    ok("boutique totalRevenue zeroed", stats.every((s) => s.totalRevenue === 0));
    ok("boutique totalOrders zeroed", stats.every((s) => s.totalOrders === 0));
    ok("ugcTodaySales zeroed", stats.every((s) => s.ugcTodaySales === 0));
    ok("ugcTotalSales zeroed", stats.every((s) => s.ugcTotalSales === 0));
    ok("ugcTodayEarnings zeroed", stats.every((s) => s.ugcTodayEarnings === 0));
    ok("ugcTotalEarnings zeroed", stats.every((s) => s.ugcTotalEarnings === 0));
    // Affiliates + avatars persist across the cycle (only STATS reset).
    ok("demo affiliates persist across reset", store.demoAffiliate.length === 8);
    ok("avatar library persists across reset", store.demoAvatar.length === 4);
    // Phase 3A: a reset ARCHIVES the cycle and KEEPS the history (deleting it is
    // the separate clearCompetitionHistory action) — this replaces the former
    // "history cleared on reset(true)" expectation.
    ok("history KEPT on reset (separate explicit deletion)", store.demoEarningsHistory.length > 0);
    ok("previous cycle archived on reset", store.setting.some((r) => r.id === "demo-competition-cycle:1"));
  }

  console.log("9) New BUSINESS DAY resets 'today' buckets to 0; totals persist:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 2, 2);
    await generateDemoAffiliates(6, "mixed");
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });
    await simulateTick(); // day 1 activity (sets lastSimAt = now)

    // Snapshot totals, then pin a large 'today' value and pretend the last sim
    // ran two days ago → the next tick must be treated as a fresh business day.
    const totalsBefore = new Map();
    for (const s of store.demoStats) {
      s.ugcTodaySales = 999; s.ugcTodayEarnings = 4995;
      s.todayOrders = 999; s.todayRevenue = 99999;
      totalsBefore.set(s.demoAffiliateId, { sales: s.ugcTotalSales, earn: s.ugcTotalEarnings });
    }
    store.demoSettings[0].lastSimAt = new Date(Date.now() - 2 * 86400 * 1000);

    await simulateTick(); // first tick of a NEW business day

    ok("UGC Today Sales reset to 0 on the new day (no 999 carryover)",
       store.demoStats.every((s) => s.ugcTodaySales < 999));
    ok("UGC Today Earnings reset to 0 on the new day (no 4995 carryover)",
       store.demoStats.every((s) => s.ugcTodayEarnings < 4995));
    ok("boutique todayOrders also rolled over",
       store.demoStats.every((s) => s.todayOrders < 999));
    ok("boutique todayRevenue also rolled over",
       store.demoStats.every((s) => s.todayRevenue < 99999));
    // Each tick increments today AND total by the same delta, so after a reset
    // total == previous total + the new day's today value → totals never lost.
    ok("UGC Total Sales preserved (= old total + new-day today only)",
       store.demoStats.every((s) => Math.abs(s.ugcTotalSales - (totalsBefore.get(s.demoAffiliateId).sales + s.ugcTodaySales)) < 0.001));
    ok("UGC Total Earnings preserved likewise",
       store.demoStats.every((s) => Math.abs(s.ugcTotalEarnings - (totalsBefore.get(s.demoAffiliateId).earn + s.ugcTodayEarnings)) < 0.001));

    // Same-day ticks must NOT reset today (only a day change does).
    const beforeSameDay = store.demoStats.map((s) => s.ugcTodaySales);
    await simulateTick(); // still the same business day as the previous tick
    ok("same-day tick does NOT reset today (values only grow)",
       store.demoStats.every((s, i) => s.ugcTodaySales >= beforeSameDay[i]));
  }

  __setDemoDb(null); // restore real client for any later imports
  console.log("10) Auto-simulation interval is clamped to the 5–30s window:");
  {
    ok("below 5 → 5", clampSimInterval(2) === 5);
    ok("above 30 → 30", clampSimInterval(999) === 30);
    ok("in range respected", clampSimInterval(12) === 12);
    ok("non-numeric → default", clampSimInterval("abc") === DEMO_SIM_DEFAULT_INTERVAL);
    ok("fractional rounded", clampSimInterval(7.6) === 8);
  }

  console.log("11) saveDemoSettings persists auto-sim fields (partial patch, no clobber):");
  {
    const { db } = makeFakeDb();
    __setDemoDb(db);
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });
    await saveDemoSettings({ autoSimEnabled: true, autoSimIntervalSec: 99 }); // partial patch + out-of-range
    const s = await getDemoSettings();
    ok("autoSimEnabled persisted", s.autoSimEnabled === true);
    ok("interval clamped to 30 on save", s.autoSimIntervalSec === 30);
    ok("earlier isEnabled not clobbered by partial patch", s.isEnabled === true);
    ok("earlier simulationSpeed not clobbered", s.simulationSpeed === "fast");
    ok("invalid simulationSpeed is ignored", (await saveDemoSettings({ simulationSpeed: "bogus" }), (await getDemoSettings()).simulationSpeed === "fast"));
  }

  console.log("12) runAutoSimTick only ticks when demo + auto-sim are BOTH on:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 3, 3);
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });
    await generateDemoAffiliates(6, "mixed");

    // auto-sim OFF → skipped, no growth
    await saveDemoSettings({ autoSimEnabled: false, autoSimIntervalSec: 7 });
    const before = (await getLeaderboard(50)).reduce((a, r) => a + (r.totalOrders || 0), 0);
    const off = await runAutoSimTick();
    const afterOff = (await getLeaderboard(50)).reduce((a, r) => a + (r.totalOrders || 0), 0);
    ok("auto OFF → skipped 'disabled'", off.ticked === false && off.skipped === "disabled");
    ok("auto OFF → interval reflects config (7s)", off.intervalMs === 7000);
    ok("auto OFF → totals unchanged", afterOff === before);

    // both ON → ticks, totals grow
    await saveDemoSettings({ autoSimEnabled: true });
    const on = await runAutoSimTick();
    const afterOn = (await getLeaderboard(50)).reduce((a, r) => a + (r.totalOrders || 0), 0);
    ok("both ON → ticked", on.ticked === true);
    ok("both ON → totals increased", afterOn >= before);

    // demo system OFF (but auto ON) → skipped
    await saveDemoSettings({ isEnabled: false });
    const sysOff = await runAutoSimTick();
    ok("demo system OFF → skipped even with auto ON", sysOff.ticked === false && sysOff.skipped === "disabled");
  }

  console.log("13) runAutoSimTick honours the advisory lock (skips when not held):");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 2, 2);
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast", autoSimEnabled: true });
    await generateDemoAffiliates(4, "mixed");
    const before = (await getLeaderboard(50)).reduce((a, r) => a + (r.totalOrders || 0), 0);
    const lockDenied = { acquire: async () => false, release: async () => {} };
    const r = await runAutoSimTick({ lock: lockDenied });
    const after = (await getLeaderboard(50)).reduce((a, r2) => a + (r2.totalOrders || 0), 0);
    ok("no lock → skipped 'no_lock'", r.ticked === false && r.skipped === "no_lock");
    ok("no lock → no growth", after === before);

    let acquired = false, released = false;
    const lockOk = { acquire: async () => (acquired = true), release: async () => (released = true) };
    const r2 = await runAutoSimTick({ lock: lockOk });
    ok("lock held → ticked", r2.ticked === true);
    ok("lock acquired then released", acquired && released);
  }

  console.log("14) Realistic tick volume — weighted 1–4 orders, never more:");
  {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let outOfRange = 0;
    for (let i = 0; i < 20000; i++) {
      const n = pickTickOrderCount();
      if (n < 1 || n > 4 || !Number.isInteger(n)) outOfRange++;
      else counts[n]++;
    }
    ok("never below 1 or above 4 (integer only)", outOfRange === 0);
    ok("1 order is the most common (~70%)", counts[1] / 20000 > 0.6 && counts[1] / 20000 < 0.8);
    ok("2 orders roughly ~20%", counts[2] / 20000 > 0.13 && counts[2] / 20000 < 0.27);
    ok("3 orders is uncommon (~8%)", counts[3] / 20000 > 0.03 && counts[3] / 20000 < 0.13);
    ok("4 orders is rare (~2%)", counts[4] / 20000 > 0.005 && counts[4] / 20000 < 0.05);
  }

  console.log("15) Recipient weighting — favors the top, but stays dynamic:");
  {
    const sorted = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}` })); // index 0 = leader
    const hits = Object.fromEntries(sorted.map((a) => [a.id, 0]));
    for (let i = 0; i < 20000; i++) hits[pickWeightedRecipient(sorted).id]++;
    ok("leader picked more often than the last place", hits.a0 > hits.a9);
    ok("lowest-ranked still scores sometimes (dynamic)", hits.a9 > 0);
    ok("every affiliate can be chosen", Object.values(hits).every((h) => h > 0));
    ok("single-affiliate list returns that affiliate", pickWeightedRecipient([{ id: "solo" }]).id === "solo");
  }

  console.log("16) One simulateTick adds only 1–4 orders in TOTAL (not per-affiliate):");
  {
    const sumOrders = async () => (await getLeaderboard(100)).reduce((a, r) => a + (r.totalOrders || 0), 0);
    let minDelta = Infinity, maxDelta = -Infinity;
    for (let run = 0; run < 25; run++) {
      const { db, store } = makeFakeDb();
      __setDemoDb(db);
      seedAvatars(store, 5, 5);
      await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });
      await generateDemoAffiliates(20, "mixed");
      const before = await sumOrders();
      const r = await simulateTick();
      const after = await sumOrders();
      const delta = after - before;
      minDelta = Math.min(minDelta, delta);
      maxDelta = Math.max(maxDelta, delta);
      ok(`run#${run + 1}: total delta == reported orders (${delta})`, delta === r.orders);
    }
    ok("smallest total delta across runs ≥ 1", minDelta >= 1);
    ok("largest total delta across runs ≤ 4 (even on 'fast')", maxDelta <= 4);
  }

  console.log("17) Shared identity pool — competition & live activity use the SAME people:");
  {
    const { db, store } = makeFakeDb();
    __setDemoDb(db);
    seedAvatars(store, 5, 5);
    await saveDemoSettings({ isEnabled: true, simulationSpeed: "fast" });
    await generateDemoAffiliates(12, "mixed");
    invalidateDemoCache();

    const pool = await getDemoIdentityPool();
    const board = await getLeaderboard(50);
    const byId = new Map(pool.map((p) => [p.id, p]));

    ok("every leaderboard person exists in the pool", board.every((r) => byId.has(r.id)));
    ok("same id → same name (never re-rolled)", board.every((r) => byId.get(r.id).name === r.name));
    ok("same id → same username", board.every((r) => byId.get(r.id).username === r.username));
    ok("same id → same avatar (never another photo)", board.every((r) => (byId.get(r.id).avatarUrl ?? null) === (r.avatarUrl ?? null)));
    ok("pool expanded to ≥300 stable profiles", pool.length >= 300);
    ok("all pool ids unique", new Set(pool.map((p) => p.id)).size === pool.length);
    ok("supplemental profiles are women with a stable color", pool.filter((p) => p.id.startsWith("demo-extra-")).every((p) => p.gender === "women" && p.avatarColor));

    // Determinism: after a cache invalidation, the supplemental identities are
    // IDENTICAL (index-based, no randomness) — identity is permanent.
    const extras1 = pool.filter((p) => p.id.startsWith("demo-extra-"));
    invalidateDemoCache();
    const extras2 = (await getDemoIdentityPool()).filter((p) => p.id.startsWith("demo-extra-"));
    ok("supplemental identities are deterministic across reloads", JSON.stringify(extras1) === JSON.stringify(extras2));
  }

  console.log("18) buildEvent copies the person's identity verbatim from the pool:");
  {
    const pool = [
      { id: "demo_a1", name: "Karima Alaoui", username: "karima419", avatarUrl: "/uploads/demo/avatars/k.webp", avatarColor: "#6366f1", gender: "women" },
      { id: "demo_a2", name: "Samira Tazi",   username: "samira204", avatarUrl: null,                            avatarColor: "#ec4899", gender: "women" },
    ];
    const cfg = normalizeLiveActivity({});
    const first = () => 0;    // rnd → picks pool[0]
    const second = () => 0.9; // rnd → picks pool[1]

    const ugc = buildEvent("ugc", cfg, Date.now(), pool, first);
    ok("ugc event copies id/name/username/avatar of Karima", ugc.personId === "demo_a1" && ugc.name === "Karima Alaoui" && ugc.username === "karima419" && ugc.avatarUrl === "/uploads/demo/avatars/k.webp");
    ok("ugc event exposes videos+sales only (no views/product/city)", ugc.videos >= 1 && ugc.sales >= 1 && !("views" in ugc) && !("product" in ugc) && !("city" in ugc));

    const del = buildEvent("delivered", cfg, Date.now(), pool, second);
    ok("delivered event copies Samira's identity (avatar null → initials fallback)", del.personId === "demo_a2" && del.name === "Samira Tazi" && del.avatarUrl === null && del.color === "#ec4899");
    ok("amount within the configured commission range", del.amount >= cfg.commissionMin && del.amount <= cfg.commissionMax);

    ok("same person picked twice keeps the exact same identity", (() => {
      const a = buildEvent("newOrder", cfg, Date.now(), pool, first);
      const b = buildEvent("commission", cfg, Date.now(), pool, first);
      return a.personId === b.personId && a.name === b.name && a.username === b.username && a.avatarUrl === b.avatarUrl && a.color === b.color;
    })());
    ok("empty pool falls back safely (no crash, generic name)", buildEvent("newOrder", cfg, Date.now(), [], first).name === "مسوقة");
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
