#!/usr/bin/env node
/**
 * scripts/demoProfiles.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3B — admin management of DEMO profiles + 90-day demo earnings history.
 * In-memory fake: demo models + demo-prefixed settings rows only (anything else
 * throws). Proves:
 *   • admin-only routes; validation, invalid/unknown ids, conflicts
 *   • create / edit / deactivate / safe delete keep ids, identities and history
 *   • batch generation (target / add) reuses ids, never replaces
 *   • 90-day window, stable across requests and restarts, totals = rows shown,
 *     statuses, deterministic + idempotent backfill, validated edits
 *   • reset / automatic rollover keep the history
 *   • leaderboard / list / detail / archive share identity and ranking
 *   • nothing touches real financial or order tables; chat stays disabled
 *   • D1: deletion is atomic (row lock + one transaction, rollback on FK failure)
 *   • D2: backfill never fills today, only missing days before it
 *   • today's history row is not editable (server-enforced), earlier days are
 * Run: node scripts/demoProfiles.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  validateProfileInput, validateGenerateInput, validateHistoryEdit, isValidProfileId,
  normalizeChatConfig, PROFILE_META_PREFIX, HISTORY_DAYS,
} from "../src/lib/demoProfileValidation.js";
import { CYCLE_ARCHIVE_PREFIX } from "../src/lib/demoCompetitionCycle.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = (p) => p.then(() => null, (e) => e);
const DAY = 86400000;
const NOW = new Date(2026, 9, 23, 15, 30).getTime(); // 23 Oct 2026 15:30 server-local
const localMidnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
const daysAgo = (n) => { const d = localMidnight(NOW); d.setDate(d.getDate() - n); return d; };
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ── Fake DB (demo models + demo settings rows only) ───────────────────────────
function makeDb() {
  let seq = 1;
  const nid = () => `id_${String(seq++).padStart(4, "0")}`;
  const t = { demoAffiliate: [], demoStats: [], demoEarningsHistory: [], demoCompetition: [], demoSettings: [], demoAvatar: [], setting: [] };
  const writes = [];
  const hooks = {};
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === "stats") continue;
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] || 0) + v.increment;
      else row[k] = v;
    }
  };
  const cond = (val, c) => {
    if (c instanceof Date) return val instanceof Date && val.getTime() === c.getTime();
    if (c && typeof c === "object") {
      if ("startsWith" in c) return String(val).startsWith(c.startsWith);
      if ("gte" in c || "lt" in c) return (!("gte" in c) || val >= c.gte) && (!("lt" in c) || val < c.lt);
    }
    return val === c;
  };
  const match = (row, where = {}) => Object.entries(where).every(([k, c]) => cond(row[k], c));
  const withStats = (a, include) => {
    if (!include?.stats) return { ...a };
    const s = t.demoStats.find((x) => x.demoAffiliateId === a.id);
    return { ...a, stats: s ? { ...s } : null };
  };
  const demoSettingId = (id) => String(id).startsWith(CYCLE_ARCHIVE_PREFIX) || String(id).startsWith(PROFILE_META_PREFIX);
  const models = {
    demoAffiliate: {
      create: async ({ data }) => {
        if (t.demoAffiliate.some((a) => a.username === data.username)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const a = { id: nid(), isActive: true, avatarColor: "#6366f1", avatarUrl: null, createdAt: new Date(NOW + seq) }; apply(a, data); t.demoAffiliate.push(a);
        if (data.stats?.create) { const s = { id: nid(), demoAffiliateId: a.id, rank: 0, totalOrders: 0, totalRevenue: 0 }; apply(s, data.stats.create); t.demoStats.push(s); }
        writes.push("demoAffiliate.create"); return { ...a };
      },
      findMany: async ({ where, include } = {}) => t.demoAffiliate.filter((a) => match(a, where)).map((a) => withStats(a, include)),
      findUnique: async ({ where, include, select }) => {
        const a = t.demoAffiliate.find((x) => match(x, where)); if (!a) return null;
        if (select) return Object.fromEntries(Object.keys(select).map((k) => [k, a[k]]));
        return withStats(a, include);
      },
      update: async ({ where, data }) => {
        const a = t.demoAffiliate.find((x) => match(x, where));
        if (data.username && t.demoAffiliate.some((x) => x.username === data.username && x.id !== a.id)) throw Object.assign(new Error("unique"), { code: "P2002" });
        apply(a, data); writes.push("demoAffiliate.update"); return { ...a };
      },
      delete: async ({ where }) => {
        await hooks.beforeAffiliateDelete?.(where.id);
        const i = t.demoAffiliate.findIndex((x) => match(x, where));
        if (i < 0) throw Object.assign(new Error("not found"), { code: "P2025" });
        // ON DELETE RESTRICT (demo_stats / demo_earnings_history → demo_affiliates)
        if (t.demoEarningsHistory.some((h) => h.demoAffiliateId === where.id) || t.demoStats.some((x) => x.demoAffiliateId === where.id)) {
          throw Object.assign(new Error("foreign key"), { code: "P2003" });
        }
        const [a] = t.demoAffiliate.splice(i, 1); writes.push("demoAffiliate.delete"); return a;
      },
      count: async ({ where } = {}) => t.demoAffiliate.filter((a) => match(a, where)).length,
    },
    demoStats: {
      findMany: async () => t.demoStats.map((s) => ({ ...s })),
      update: async ({ where, data }) => { const s = t.demoStats.find((x) => match(x, where)); apply(s, data); return { ...s }; },
      updateMany: async ({ data }) => { for (const s of t.demoStats) apply(s, data); return { count: t.demoStats.length }; },
      deleteMany: async ({ where } = {}) => { const n = t.demoStats.length; t.demoStats = t.demoStats.filter((s) => !match(s, where)); return { count: n - t.demoStats.length }; },
    },
    demoEarningsHistory: {
      create: async ({ data }) => { const r = { id: nid(), ...data }; t.demoEarningsHistory.push(r); writes.push("history.create"); return { ...r }; },
      findMany: async ({ where, orderBy } = {}) => {
        let rows = t.demoEarningsHistory.filter((h) => match(h, where)).map((h) => ({ ...h }));
        if (orderBy?.date === "desc") rows.sort((a, b) => b.date - a.date);
        if (orderBy?.date === "asc") rows.sort((a, b) => a.date - b.date);
        return rows;
      },
      findFirst: async ({ where }) => { const r = t.demoEarningsHistory.find((h) => match(h, where)); return r ? { ...r } : null; },
      update: async ({ where, data }) => { const r = t.demoEarningsHistory.find((h) => match(h, where)); apply(r, data); writes.push("history.update"); return { ...r }; },
      count: async ({ where } = {}) => { const n = t.demoEarningsHistory.filter((h) => match(h, where)).length; await hooks.afterHistoryCount?.(where); return n; },
      deleteMany: async () => { const n = t.demoEarningsHistory.length; t.demoEarningsHistory = []; return { count: n }; },
    },
    demoCompetition: {
      findUnique: async ({ where }) => { const r = t.demoCompetition.find((x) => match(x, where)); return r ? { ...r } : null; },
      create: async ({ data }) => { if (t.demoCompetition.length) throw Object.assign(new Error("u"), { code: "P2002" }); t.demoCompetition.push({ ...data }); return { ...data }; },
      update: async ({ where, data }) => { const r = t.demoCompetition.find((x) => match(x, where)); apply(r, data); return { ...r }; },
    },
    demoSettings: {
      findUnique: async ({ where }) => { const r = t.demoSettings.find((x) => match(x, where)); return r ? { ...r } : null; },
      upsert: async ({ where, update, create }) => { let r = t.demoSettings.find((x) => match(x, where)); if (r) apply(r, update); else { r = { ...create }; t.demoSettings.push(r); } return { ...r }; },
    },
    demoAvatar: { findMany: async () => t.demoAvatar.map((a) => ({ ...a })) },
    setting: {
      findUnique: async ({ where }) => { const r = t.setting.find((x) => x.id === where.id); return r ? structuredClone(r) : null; },
      findMany: async ({ where }) => t.setting.filter((r) => match(r, where)).map((r) => structuredClone(r)),
      create: async ({ data }) => {
        if (!demoSettingId(data.id)) throw new Error(`NON-DEMO SETTING WRITE: ${data.id}`);
        if (t.setting.some((r) => r.id === data.id)) throw Object.assign(new Error("u"), { code: "P2002" });
        t.setting.push(structuredClone(data)); return data;
      },
      upsert: async ({ where, update, create }) => {
        if (!demoSettingId(where.id)) throw new Error(`NON-DEMO SETTING WRITE: ${where.id}`);
        const r = t.setting.find((x) => x.id === where.id);
        if (r) Object.assign(r, structuredClone(update)); else t.setting.push(structuredClone(create));
        return {};
      },
      deleteMany: async ({ where }) => {
        if (typeof where.id === "string" && !demoSettingId(where.id)) throw new Error(`NON-DEMO SETTING DELETE: ${where.id}`);
        const n = t.setting.length; t.setting = t.setting.filter((r) => !match(r, where)); return { count: n - t.setting.length };
      },
    },
  };
  const guard = (o) => new Proxy(o, { get(x, k) { if (typeof k === "symbol" || k === "then") return undefined; if (k in x) return x[k]; throw new Error(`PRODUCTION TABLE ACCESS BLOCKED: db.${String(k)}`); } });
  // Row locks (FOR UPDATE) held until the transaction ends; rollback on throw.
  const locks = new Map();
  const db = guard({
    ...models, _t: t, _writes: writes,
    _hooks: hooks,
    $transaction: async (fn) => {
      const held = [];
      // Rollback snapshot. Retaken when the row lock is acquired: by then the
      // lock holder has committed, and a real rollback only undoes OUR writes.
      let snapshot = structuredClone(t);
      const tx = guard({
        ...models,
        $queryRaw: async (strings, ...vals) => {
          const sql = strings.join("?");
          if (/FROM "demo_affiliates"[\s\S]*FOR UPDATE/.test(sql)) {
            const id = vals[0];
            while (locks.has(id)) await locks.get(id).promise;
            let release; const promise = new Promise((r) => { release = r; });
            locks.set(id, { promise, release }); held.push(id);
            snapshot = structuredClone(t);
            await new Promise((r) => setImmediate(r));
            return t.demoAffiliate.filter((a) => a.id === id).map((a) => ({ id: a.id }));
          }
          return t.demoCompetition.filter((r) => r.id === "current").map((r) => ({ ...r }));
        },
      });
      try { return await fn(tx); }
      catch (e) { for (const k of Object.keys(t)) t[k] = snapshot[k]; throw e; }
      finally { for (const id of held) { const l = locks.get(id); locks.delete(id); l.release(); } }
    },
  });
  return db;
}

const demo = await import("../src/lib/services/demoService.js");
const svc = await import("../src/lib/services/demoProfileService.js");
const fresh = () => { const db = makeDb(); demo.__setDemoDb(db); demo.invalidateDemoCache(); return db; };
const seedHistory = (db, id, n, dayOffsets) => { for (const d of dayOffsets) db._t.demoEarningsHistory.push({ id: `h_${id}_${d}`, demoAffiliateId: id, date: daysAgo(d), orders: n, revenue: n * 100, commission: n * 5 }); };

// ── 1. Validation ────────────────────────────────────────────────────────────
console.log("\n1. Validation");
{
  ok("create requires name + username", !validateProfileInput({}).ok && validateProfileInput({ name: "Salma B", username: "demo_salma" }).ok);
  ok("name 2..60, whitespace normalised", !validateProfileInput({ name: "S", username: "abc" }).ok && validateProfileInput({ name: "  Salma   Bennani ", username: "abc" }).value.name === "Salma Bennani");
  ok("username pattern + lowercased", !validateProfileInput({ name: "Ab", username: "a b" }).ok && validateProfileInput({ name: "Ab", username: "Demo_X1" }).value.username === "demo_x1");
  ok("unknown / protected fields rejected (id, stats, rank…)", ["id", "stats", "rank", "totalOrders", "chat"].every((k) => validateProfileInput({ [k]: 1 }, { partial: true }).field === k));
  ok("avatar must be in the library (or null)", !validateProfileInput({ avatarUrl: "https://evil/x.png" }, { partial: true }).ok
    && validateProfileInput({ avatarUrl: "/a.webp" }, { partial: true, avatarAllowed: (u) => u === "/a.webp" }).ok && validateProfileInput({ avatarUrl: null }, { partial: true }).value.avatarUrl === null);
  ok("colour / gender / growth / city / isActive checked", !validateProfileInput({ avatarColor: "red" }, { partial: true }).ok && !validateProfileInput({ gender: "x" }, { partial: true }).ok
    && !validateProfileInput({ growthType: "x" }, { partial: true }).ok && !validateProfileInput({ city: "x".repeat(61) }, { partial: true }).ok && !validateProfileInput({ isActive: "yes" }, { partial: true }).ok);
  ok("empty PATCH rejected", !validateProfileInput({}, { partial: true }).ok);
  ok("generate count 1..100 (10/50/100 allowed)", [0, 101, 2.5, "x"].every((c) => !validateGenerateInput({ count: c }).ok) && [1, 10, 50, 100].every((c) => validateGenerateInput({ count: c }).ok));
  ok("history edit: integer orders 0..10000, revenue 0..1e7, no revenue without orders",
    !validateHistoryEdit({ historyId: "h1", orders: -1, revenue: 0 }).ok && !validateHistoryEdit({ historyId: "h1", orders: 1.5, revenue: 0 }).ok
    && !validateHistoryEdit({ historyId: "h1", orders: 2, revenue: -3 }).ok && !validateHistoryEdit({ historyId: "h1", orders: 0, revenue: 10 }).ok
    && validateHistoryEdit({ historyId: "h1", orders: 2, revenue: 10.555 }).value.revenue === 10.56);
  ok("ids validated", isValidProfileId("a1-b_2") && !isValidProfileId("../x") && !isValidProfileId("") && !isValidProfileId("x".repeat(65)));
  ok("chat extension point never enabled in 3B", JSON.stringify(normalizeChatConfig({ journeyId: "j1", enabled: true })) === '{"journeyId":"j1","enabled":false}' && normalizeChatConfig(null).journeyId === null);
}

// ── 2. CRUD ──────────────────────────────────────────────────────────────────
console.log("\n2. Create / edit / errors");
let db = fresh();
db._t.demoAvatar.push({ id: "av1", gender: "women", url: "/uploads/demo/avatars/w1.webp" });
{
  const created = await svc.createProfile({ name: "Salma Bennani", username: "demo_salma", city: "Fès" });
  const id = created.profile.id;
  ok("create → stable id, city stored, current cycle at 0, no history", created.profile.city === "Fès" && created.currentCycle.stats.totalOrders === 0 && created.history.days.length === 0 && created.demo === true);
  ok("username conflict → 409", (await rejects(svc.createProfile({ name: "Other", username: "demo_salma" })))?.status === 409);
  ok("invalid input → 400 with field", (await rejects(svc.createProfile({ name: "X", username: "ok_user" })))?.field === "name");
  ok("invalid id → 400, unknown id → 404, supplemental pool id → 404",
    (await rejects(svc.getProfileDetail("../etc")))?.status === 400 && (await rejects(svc.getProfileDetail("nope")))?.status === 404 && (await rejects(svc.getProfileDetail("demo-extra-001")))?.status === 404);

  seedHistory(db, id, 3, [0, 1, 2]);
  const before = (await svc.getProfileDetail(id, { now: NOW })).history;
  const edited = await svc.updateProfile(id, { name: "Salma B.", username: "demo_salma_b", city: "Rabat", avatarUrl: "/uploads/demo/avatars/w1.webp", avatarColor: "#123456", growthType: "aggressive" }, { now: NOW });
  ok("edit name/username/city/avatar/colour/growth persisted, same id", edited.profile.id === id && edited.profile.name === "Salma B." && edited.profile.username === "demo_salma_b" && edited.profile.city === "Rabat" && edited.profile.avatarUrl === "/uploads/demo/avatars/w1.webp" && edited.profile.growthType === "aggressive");
  ok("edit keeps the history intact", JSON.stringify(edited.history.days) === JSON.stringify((await svc.getProfileDetail(id, { now: NOW })).history.days) && edited.history.totals.orders === before.totals.orders);
  // Regression: the edit response uses the caller's clock, not the wall clock (failed on any day after the fixture date).
  const PAST = NOW - 400 * DAY; // far from any real clock: seeded rows fall outside that window
  const editedPast = await svc.updateProfile(id, { city: "Rabat" }, { now: PAST });
  ok("updateProfile honours an injected now (history window follows it)",
    before.days.length === 3 && editedPast.history.days.length === 0
    && JSON.stringify(editedPast.history) === JSON.stringify((await svc.getProfileDetail(id, { now: PAST })).history));
  ok("avatar outside the library → 400", (await rejects(svc.updateProfile(id, { avatarUrl: "https://elsewhere/x.png" })))?.field === "avatarUrl");
  ok("current avatar stays allowed even if removed from the library", (db._t.demoAvatar.length = 0, (await svc.updateProfile(id, { avatarUrl: "/uploads/demo/avatars/w1.webp", name: "Salma B." })).profile.avatarUrl === "/uploads/demo/avatars/w1.webp"));
  ok("rename to a taken username → 409", (await svc.createProfile({ name: "Nadia K", username: "demo_nadia" }), (await rejects(svc.updateProfile(id, { username: "demo_nadia" })))?.status === 409));
  ok("unknown field in PATCH → 400", (await rejects(svc.updateProfile(id, { totalOrders: 999 })))?.status === 400);
  ok("leaderboard + identity pool show the edited identity (same id)", (demo.invalidateDemoCache(), (await demo.getLeaderboard(50)).find((r) => r.id === id)?.name === "Salma B.") && (await demo.getDemoIdentityPool()).find((p) => p.id === id)?.name === "Salma B.");
}

// ── 3. Deactivate / delete ───────────────────────────────────────────────────
console.log("\n3. Deactivate vs safe deletion");
{
  const withHist = db._t.demoAffiliate.find((a) => a.username === "demo_salma_b").id;
  const off = await svc.updateProfile(withHist, { isActive: false });
  ok("deactivate → hidden from leaderboard, rank 0, history kept", off.profile.isActive === false && off.currentCycle.rank === 0 && off.history.days.length === 3 && !(await demo.getLeaderboard(50)).some((r) => r.id === withHist));
  ok("reactivate → back on the leaderboard with the same id", (await svc.updateProfile(withHist, { isActive: true })).profile.isActive && (await demo.getLeaderboard(50)).some((r) => r.id === withHist));
  const e = await rejects(svc.deleteProfile(withHist));
  ok("delete a profile with history → 409 PROFILE_REFERENCED (nothing removed)", e?.status === 409 && e.code === "PROFILE_REFERENCED" && db._t.demoAffiliate.some((a) => a.id === withHist));
  const nadia = db._t.demoAffiliate.find((a) => a.username === "demo_nadia").id;
  await demo.resetCompetition({ now: NOW }); // nadia now appears in archived standings
  ok("delete a profile present in an archived cycle → 409", (await rejects(svc.deleteProfile(nadia)))?.status === 409);
  const lone = (await svc.createProfile({ name: "Temp Profile", username: "demo_temp", city: "Agadir" })).profile.id;
  const del = await svc.deleteProfile(lone);
  ok("unreferenced profile → deleted with its stats + meta row only", del.deleted && !db._t.demoAffiliate.some((a) => a.id === lone) && !db._t.demoStats.some((s) => s.demoAffiliateId === lone) && !db._t.setting.some((r) => r.id === `${PROFILE_META_PREFIX}${lone}`) && db._t.setting.some((r) => r.id === `${PROFILE_META_PREFIX}${withHist}`));
  ok("deleting an unknown id → 404", (await rejects(svc.deleteProfile(lone)))?.status === 404);
}

// ── 4. Batch generation ──────────────────────────────────────────────────────
console.log("\n4. Batch generation reuses ids");
{
  db = fresh();
  const r1 = await svc.generateProfiles({ count: 10, strategy: "add" });
  const ids1 = db._t.demoAffiliate.map((a) => `${a.id}|${a.name}|${a.username}`);
  const r2 = await svc.generateProfiles({ count: 10, strategy: "target" });
  ok("add 10 → 10 created; target 10 again → nothing created or replaced", r1.created === 10 && r2.created === 0 && JSON.stringify(db._t.demoAffiliate.map((a) => `${a.id}|${a.name}|${a.username}`)) === JSON.stringify(ids1));
  const r3 = await svc.generateProfiles({ count: 50, strategy: "add" });
  ok("add 50 → 60 active, the first 10 identical", r3.target === 60 && r3.created === 50 && JSON.stringify(db._t.demoAffiliate.slice(0, 10).map((a) => `${a.id}|${a.name}|${a.username}`)) === JSON.stringify(ids1));
  await svc.generateProfiles({ count: 20, strategy: "target" });
  ok("target 20 → 40 hidden, none deleted", db._t.demoAffiliate.length === 60 && db._t.demoAffiliate.filter((a) => a.isActive).length === 20);
  const r4 = await svc.generateProfiles({ count: 100, strategy: "target" });
  ok("target 100 → 40 reactivated + 40 created, ids unique", r4.reactivated === 40 && r4.created === 40 && new Set(db._t.demoAffiliate.map((a) => a.id)).size === 100 && new Set(db._t.demoAffiliate.map((a) => a.username)).size === 100);
  ok("invalid count → 400", (await rejects(svc.generateProfiles({ count: 0 })))?.status === 400);
}

// ── 5. 90-day history ────────────────────────────────────────────────────────
console.log("\n5. 90-day demo history");
{
  db = fresh();
  const id = (await svc.createProfile({ name: "History Profile", username: "demo_hist" })).profile.id;
  seedHistory(db, id, 2, [0, 1, 5, 89, 90, 120]);                     // 90 and 120 days ago are outside
  db._t.demoEarningsHistory.push({ id: "h_future", demoAffiliateId: id, date: daysAgo(-1), orders: 9, revenue: 900, commission: 45 }); // tomorrow
  db._t.demoEarningsHistory.push({ id: "h_other", demoAffiliateId: "someone-else", date: daysAgo(0), orders: 7, revenue: 700, commission: 35 });
  const d1 = await svc.getProfileDetail(id, { now: NOW });
  ok(`window = ${HISTORY_DAYS} days ending today (${key(daysAgo(89))} → ${key(daysAgo(0))})`, d1.history.from === key(daysAgo(89)) && d1.history.to === key(daysAgo(0)));
  ok("only this profile's rows inside the window (0,1,5,89 days ago), newest first", JSON.stringify(d1.history.days.map((x) => x.day)) === JSON.stringify([0, 1, 5, 89].map((n) => key(daysAgo(n)))));
  const sum = (k) => Math.round(d1.history.days.reduce((s, x) => s + x[k], 0) * 100) / 100;
  ok("displayed totals == sum of displayed rows", d1.history.totals.days === 4 && d1.history.totals.orders === sum("orders") && d1.history.totals.revenue === sum("revenue") && d1.history.totals.commission === sum("commission"));
  ok("rows labelled 'simulated', time flagged unavailable", d1.history.days.every((x) => x.status === "simulated") && d1.history.timeAvailable === false);
  ok("history is separate from the current-cycle score", d1.currentCycle.stats.totalOrders === 0 && d1.history.totals.orders === 8);
  const d2 = await svc.getProfileDetail(id, { now: NOW });
  ok("repeated reads → identical history, nothing written", JSON.stringify(d1.history) === JSON.stringify(d2.history) && !db._writes.includes("history.create"));
  const restarted = await import("../src/lib/services/demoProfileService.js?restart=1");
  ok("after a restart (new module instance) → identical history", JSON.stringify((await restarted.getProfileDetail(id, { now: NOW })).history) === JSON.stringify(d1.history));

  const b1 = await svc.backfillHistory(id, { now: NOW });
  const d3 = await svc.getProfileDetail(id, { now: NOW });
  ok("backfill fills exactly the 86 missing days of the window", b1.created === 86 && b1.existing === 4 && d3.history.days.length === 90);
  ok("existing days untouched; filled days labelled 'backfilled'", d3.history.days.filter((x) => x.status === "simulated").length === 4 && d3.history.days.filter((x) => x.status === "backfilled").length === 86 && d3.history.days.find((x) => x.day === key(daysAgo(0))).orders === 2);
  ok("backfill is idempotent", (await svc.backfillHistory(id, { now: NOW })).created === 0);
  ok("backfilled figures deterministic (same profile id + day → same numbers)", (() => {
    const a = svc.seededDemoDay(id, "2026-08-01", "consistent"), b = svc.seededDemoDay(id, "2026-08-01", "consistent");
    return JSON.stringify(a) === JSON.stringify(b) && a.commission === Math.round(a.revenue * 0.05 * 100) / 100 && a.orders >= 2 && a.orders <= 5;
  })());
  const db2 = makeDb(); demo.__setDemoDb(db2); db2._t.demoAffiliate.push({ id, name: "x", username: "x", growthType: "consistent", isActive: true });
  db2._t.demoStats.push({ id: "s", demoAffiliateId: id, totalOrders: 0, totalRevenue: 0 });
  await svc.backfillHistory(id, { now: NOW });
  const otherDb = new Map((await svc.getProfileDetail(id, { now: NOW })).history.days.map((x) => [x.day, `${x.orders}:${x.revenue}:${x.commission}`]));
  demo.__setDemoDb(db);
  const filled = d3.history.days.filter((x) => x.status === "backfilled");
  ok("same profile id on another database → identical values for all 86 backfilled days",
    filled.length === 86 && filled.every((x) => otherDb.get(x.day) === `${x.orders}:${x.revenue}:${x.commission}`));

  const target = d3.history.days.find((x) => x.day === key(daysAgo(1)));
  const after = await svc.editHistoryEntry(id, { historyId: target.id, orders: 4, revenue: 1234.5 }, { now: NOW });
  const row = after.history.days.find((x) => x.id === target.id);
  ok("edit saved: orders/revenue, commission = 5 % recalculated, status 'edited'", row.orders === 4 && row.revenue === 1234.5 && row.commission === 61.73 && row.status === "edited");
  ok("totals recalculated from the rows", after.history.totals.orders === after.history.days.reduce((s, x) => s + x.orders, 0) && after.history.totals.revenue === Math.round(after.history.days.reduce((s, x) => s + x.revenue, 0) * 100) / 100);
  ok("edit persists across reads", (await svc.getProfileDetail(id, { now: NOW })).history.days.find((x) => x.id === target.id).revenue === 1234.5);
  ok("edit validation → 400; other profile's entry → 404; out-of-window entry → 400",
    (await rejects(svc.editHistoryEntry(id, { historyId: target.id, orders: -2, revenue: 0 }, { now: NOW })))?.status === 400
    && (await rejects(svc.editHistoryEntry(id, { historyId: "h_other", orders: 1, revenue: 1 }, { now: NOW })))?.status === 404
    && (await rejects(svc.editHistoryEntry(id, { historyId: `h_${id}_120`, orders: 1, revenue: 1 }, { now: NOW })))?.status === 400);

  // Reset + automatic rollover keep the history (incl. edited/backfilled rows).
  const snapshot = JSON.stringify((await svc.getProfileDetail(id, { now: NOW })).history);
  await demo.resetCompetition({ now: NOW });
  const comp = db._t.demoCompetition[0];
  await demo.getCompetitionInfo({ now: comp.endDate.getTime() + 1000 });
  const afterCycles = await svc.getProfileDetail(id, { now: NOW });
  ok("manual reset + automatic rollover → history (values + statuses) unchanged", JSON.stringify(afterCycles.history) === snapshot && afterCycles.currentCycle.cycleNum === comp.cycleNum);
  ok("archived cycles listed on the profile with its archived rank", afterCycles.cycles.length === 2 && afterCycles.cycles.every((c) => c.rank >= 1));
}

// ── 6. Identity + ranking consistency ────────────────────────────────────────
console.log("\n6. Same identity and ranking everywhere");
{
  db = fresh();
  await svc.generateProfiles({ count: 12, strategy: "add" });
  db._t.demoStats.forEach((s, i) => { s.totalOrders = [5, 5, 9, 0, 5, 2, 2, 7, 1, 3, 3, 4][i]; s.totalRevenue = [100, 100, 1, 0, 300, 2, 2, 7, 1, 3, 3, 4][i]; });
  demo.invalidateDemoCache();
  const board = await demo.getLeaderboard(50);
  const list = (await svc.listProfiles()).profiles;
  const details = await Promise.all(board.map((r) => svc.getProfileDetail(r.id, { now: NOW })));
  ok("admin list rank === leaderboard rank === profile detail rank", board.every((r, i) => list.find((p) => p.id === r.id).rank === r.rank && details[i].currentCycle.rank === r.rank));
  ok("same name / username / avatar in leaderboard, list and detail", board.every((r, i) => { const l = list.find((p) => p.id === r.id); return l.name === r.name && details[i].profile.username === r.username && (details[i].profile.avatarUrl ?? null) === (r.avatarUrl ?? null); }));
  await demo.resetCompetition({ now: NOW });
  const arch = db._t.setting.find((x) => x.id === `${CYCLE_ARCHIVE_PREFIX}1`).data.standings;
  const d0 = await svc.getProfileDetail(board[0].id, { now: NOW });
  ok("archived standings === leaderboard order; profile shows the archived rank", JSON.stringify(arch.map((s) => s.demoAffiliateId)) === JSON.stringify(board.map((r) => r.id)) && d0.cycles[0].rank === 1);
  ok("list search by name / username / city", (await svc.listProfiles({ q: board[0].username })).profiles.length === 1 && (await svc.listProfiles({ status: "inactive" })).profiles.length === 0);
}

// ── 7. Isolation + authorization ─────────────────────────────────────────────
console.log("\n7. Isolation from real money; admin-only routes");
{
  let blocked = 0;
  for (const m of ["affiliate", "affiliateOrder", "affiliatePayout", "order", "ugcEarning", "affiliateSecurityDeposit", "affiliateBoosterPurchase", "rewardPointsLedger"]) {
    try { db[m].findMany(); } catch { blocked++; }
  }
  ok("real tables unreachable through the demo seam (all CRUD/history above ran on it)", blocked === 8);
  ok("only demo-prefixed settings rows writable", (await rejects(db.setting.upsert({ where: { id: "team-bonus-config" }, update: {}, create: {} }))) !== null);
  const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");
  const r = await upsertSettingsHandler(new Request(`http://x/api/setting?type=${PROFILE_META_PREFIX}abc`, { method: "POST", body: "{}" }));
  ok("profile meta rows cannot be written through /api/setting (400)", r.status === 400);
  const svcSrc = src("src/lib/services/demoProfileService.js");
  ok("profile service imports no financial / order service", !/affiliateSystemService|orderService|payout|depositService|boosterService|rewardsService|fakeOrder/.test(svcSrc.split("\n").filter((l) => l.startsWith("import") || l.startsWith("} from")).join("\n")));
  const routes = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (f === "route.js") routes.push(p); } };
  walk(new URL("../src/app/api/admin/demo/profiles", import.meta.url).pathname);
  ok("3 profile route files", routes.length === 3);
  for (const p of routes) {
    const s = readFileSync(p, "utf8");
    const methods = [...s.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = (\w+)\(/g)];
    ok(`${p.split("/api/")[1]}: every method wrapped in withAdminAuth (${methods.map((m) => m[1]).join(", ")})`,
      methods.length > 0 && methods.every((m) => m[2] === "withAdminAuth") && !/export (async )?function/.test(s));
  }
  const detail = await svc.getProfileDetail(db._t.demoAffiliate[0].id, { now: NOW });
  ok("chat extension point present but disabled; demo flag set", JSON.stringify(detail.chat) === '{"journeyId":null,"enabled":false}' && detail.demo === true);
}

// ── 8. D1 — atomic deletion ───────────────────────────────────────────────────
console.log("\n8. D1: atomic profile deletion");
{
  db = fresh();
  const mk = async (u) => (await svc.createProfile({ name: `Profile ${u}`, username: u, city: "Tanger" })).profile.id;
  const state = (id) => ({ aff: db._t.demoAffiliate.some((a) => a.id === id), stats: db._t.demoStats.some((s) => s.demoAffiliateId === id), meta: db._t.setting.some((r) => r.id === `${PROFILE_META_PREFIX}${id}`) });

  // a) FK failure on the final delete → full rollback, 409.
  const a = await mk("demo_fk_fail");
  db._hooks.beforeAffiliateDelete = async (id) => { if (id === a) db._t.demoEarningsHistory.push({ id: "h_late", demoAffiliateId: a, date: daysAgo(0), orders: 1, revenue: 10, commission: 0.5 }); };
  const ea = await rejects(svc.deleteProfile(a));
  db._hooks.beforeAffiliateDelete = null;
  ok("history written just before the delete → 409 PROFILE_REFERENCED", ea?.status === 409 && ea.code === "PROFILE_REFERENCED");
  ok("…and the transaction rolled back: profile, stats AND meta (city) intact", JSON.stringify(state(a)) === '{"aff":true,"stats":true,"meta":true}');
  const da = await svc.getProfileDetail(a, { now: NOW });
  ok("…profile still has its city and stays on the leaderboard", da.profile.city === "Tanger" && (demo.invalidateDemoCache(), (await demo.getLeaderboard(50)).some((r) => r.id === a)));

  // b) Simulation tick inserts history between the reference check and the deletes.
  const b = await mk("demo_tick_race");
  db._hooks.afterHistoryCount = async (where) => { if (where?.demoAffiliateId === b) db._t.demoEarningsHistory.push({ id: "h_tick", demoAffiliateId: b, date: daysAgo(0), orders: 2, revenue: 20, commission: 1 }); };
  const eb = await rejects(svc.deleteProfile(b));
  db._hooks.afterHistoryCount = null;
  ok("tick adds history after the check → delete refused (409), nothing half-deleted", eb?.status === 409 && JSON.stringify(state(b)) === '{"aff":true,"stats":true,"meta":true}');

  // c) Two concurrent deletions of the same unreferenced profile.
  db._t.demoEarningsHistory = db._t.demoEarningsHistory.filter((h) => h.demoAffiliateId !== a && h.demoAffiliateId !== b);
  const c = await mk("demo_concurrent");
  const results = await Promise.allSettled([svc.deleteProfile(c), svc.deleteProfile(c)]);
  const okCount = results.filter((r) => r.status === "fulfilled" && r.value.deleted).length;
  const notFound = results.filter((r) => r.status === "rejected" && r.reason?.status === 404).length;
  ok("2 concurrent deletes → exactly one succeeds, the other gets 404", okCount === 1 && notFound === 1);
  ok("…profile, stats and meta all gone, no residue", JSON.stringify(state(c)) === '{"aff":false,"stats":false,"meta":false}');

  // d) Unreferenced profile still deletes; other profiles untouched.
  const before = db._t.setting.length;
  const d = await mk("demo_plain");
  await svc.deleteProfile(d);
  ok("plain unreferenced deletion still works; other meta rows untouched", !state(d).aff && db._t.setting.length === before && state(a).meta && state(b).meta);
  ok("deletion runs inside a transaction with a FOR UPDATE row lock", /\$transaction\(async \(tx\)[\s\S]{0,200}FROM "demo_affiliates" WHERE "id" = \$\{id\} FOR UPDATE/.test(src("src/lib/services/demoProfileService.js")));
}

// ── 9. D2 — backfill date boundary ───────────────────────────────────────────
console.log("\n9. D2: backfill only before today");
{
  db = fresh();
  const id = (await svc.createProfile({ name: "Boundary Profile", username: "demo_boundary" })).profile.id;
  const r1 = await svc.backfillHistory(id, { now: NOW });
  const d1 = await svc.getProfileDetail(id, { now: NOW });
  ok("empty profile → 89 days filled (today − 89 … yesterday)", r1.created === 89 && d1.history.days.length === 89);
  ok("no row dated today", !d1.history.days.some((x) => x.day === key(daysAgo(0))) && !db._t.demoEarningsHistory.some((h) => h.demoAffiliateId === id && h.date.getTime() === daysAgo(0).getTime()));
  ok("oldest filled day = window start, newest = yesterday", d1.history.days.at(-1).day === key(daysAgo(89)) && d1.history.days[0].day === key(daysAgo(1)));
  ok("idempotent (second run creates 0)", (await svc.backfillHistory(id, { now: NOW })).created === 0);
  db._t.demoEarningsHistory.push({ id: "h_today_sim", demoAffiliateId: id, date: daysAgo(0), orders: 3, revenue: 300, commission: 15 }); // simulation writes today
  const d2 = await svc.getProfileDetail(id, { now: NOW });
  ok("today's row written by the simulation is labelled 'simulated' (never 'backfilled')", d2.history.days[0].day === key(daysAgo(0)) && d2.history.days[0].status === "simulated");
  ok("backfill still never touches today's row", (await svc.backfillHistory(id, { now: NOW })).created === 0 && db._t.demoEarningsHistory.filter((h) => h.demoAffiliateId === id && h.date.getTime() === daysAgo(0).getTime()).length === 1);

  const last = new Date(daysAgo(0)); last.setHours(23, 59, 59, 999);
  const id2 = (await svc.createProfile({ name: "Midnight Profile", username: "demo_midnight" })).profile.id;
  ok("23:59:59.999 → today still excluded (89 days)", (await svc.backfillHistory(id2, { now: last.getTime() })).created === 89);
  const next = last.getTime() + 1; // 00:00:00.000 the next day
  const r3 = await svc.backfillHistory(id2, { now: next });
  const d3 = await svc.getProfileDetail(id2, { now: next });
  ok("next midnight → exactly 1 new day (the former 'today'), new today still empty", r3.created === 1 && d3.history.days[0].day === key(daysAgo(0)) && d3.history.days.length === 89);
  ok("existing entries preserved and deterministic", d3.history.days.every((x) => { const v = svc.seededDemoDay(id2, x.day, "consistent"); return x.orders === v.orders && x.revenue === v.revenue; }));
}

// ── 10. Today's row is not editable ──────────────────────────────────────────
console.log("\n10. Only days before today are editable");
{
  db = fresh();
  const id = (await svc.createProfile({ name: "Edit Lock Profile", username: "demo_editlock" })).profile.id;
  seedHistory(db, id, 2, [0, 1, 89]);
  const today = `h_${id}_0`, yesterday = `h_${id}_1`, oldest = `h_${id}_89`;
  const d = await svc.getProfileDetail(id, { now: NOW });
  const byId = new Map(d.history.days.map((x) => [x.id, x]));
  ok("detail flags today's row as not editable, earlier rows as editable", byId.get(today).editable === false && byId.get(yesterday).editable === true && byId.get(oldest).editable === true);
  const before = JSON.stringify(db._t.demoEarningsHistory.find((h) => h.id === today));
  const writesBefore = db._writes.length;
  const e = await rejects(svc.editHistoryEntry(id, { historyId: today, orders: 9, revenue: 900 }, { now: NOW }));
  ok("editing today's row → 400 TODAY_LOCKED with an explanation", e?.status === 400 && e.code === "TODAY_LOCKED" && e.field === "historyId" && /demain/.test(e.message));
  ok("…nothing written: row unchanged, no 'edited' marker", JSON.stringify(db._t.demoEarningsHistory.find((h) => h.id === today)) === before && db._writes.length === writesBefore
    && !((db._t.setting.find((r) => r.id === `${PROFILE_META_PREFIX}${id}`)?.data?.historyEdits || {})[today]));
  const lateToday = new Date(daysAgo(0)); lateToday.setHours(23, 59, 59, 999);
  ok("still locked at 23:59:59.999 the same day", (await rejects(svc.editHistoryEntry(id, { historyId: today, orders: 1, revenue: 1 }, { now: lateToday.getTime() })))?.code === "TODAY_LOCKED");
  const y = await svc.editHistoryEntry(id, { historyId: yesterday, orders: 3, revenue: 300 }, { now: NOW });
  ok("yesterday's row stays editable (saved, 5 % commission, 'edited')", (() => { const r = y.history.days.find((x) => x.id === yesterday); return r.orders === 3 && r.revenue === 300 && r.commission === 15 && r.status === "edited" && r.editable === true; })());
  ok("oldest day of the window (today − 89) stays editable", (await svc.editHistoryEntry(id, { historyId: oldest, orders: 1, revenue: 50 }, { now: NOW })).history.days.find((x) => x.id === oldest).revenue === 50);
  const nextMidnight = lateToday.getTime() + 1;
  const tomorrowView = await svc.editHistoryEntry(id, { historyId: today, orders: 4, revenue: 400 }, { now: nextMidnight });
  ok("from the next midnight, the former today's row becomes editable", tomorrowView.history.days.find((x) => x.id === today).revenue === 400 && tomorrowView.history.days.find((x) => x.id === today).editable === true);
  ok("90-day display window unchanged (today still shown, still 90 days)", d.history.to === key(daysAgo(0)) && d.history.from === key(daysAgo(89)) && d.history.days.some((x) => x.day === key(daysAgo(0))));
  const page = src("src/app/admin/demo-profiles/[id]/page.jsx");
  ok("UI: edit button only for editable rows, lock + explanation for today", /\{d\.editable \? \(\s*<button onClick=\{\(\) => setEdit\(true\)\}/.test(page) && /modifiable à partir de demain/.test(page) && /<Lock /.test(page));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
