#!/usr/bin/env node
/**
 * scripts/demoChatAssignments.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-9B — Mini Chat admin assignment workflow + global switch.
 * No database: an in-memory fake (unique demoAffiliateId, transactional
 * rollback, interleaving awaits, blocked non-demo models, only the
 * "demo-chat-config" settings row) behind the REAL withAdminAuth (signed test
 * tokens) and the real route handlers. Proves:
 *   • admin-only (401 / 403 for no token, affiliate or non-admin tokens)
 *   • validation (ids, version, archived journey, inactive profile, anchor range)
 *   • created DISABLED; reassignment bumps revision, disables, clears enabledAt
 *   • duplicate creation / stale expectedUpdatedAt → 409; audit rows exactly
 *     once per change, none for unchanged requests
 *   • global switch: env gate + typed "ACTIVER" to enable; disable always;
 *     generic /api/setting still refuses the row; no affiliate/public import
 *   • archiving a journey used by an enabled assignment → 409 IN_USE
 *   • end to end with the Phase 3C-6 materializer + 3C-7 feed: revisions,
 *     both gates, no duplicates, earlier revisions hidden but kept
 * Run: node scripts/demoChatAssignments.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";

const T = await import("../src/lib/demoChatTime.js");
const G = await import("../src/lib/demoChatGate.js");
const demo = await import("../src/lib/services/demoService.js");
const S = await import("../src/lib/services/demoChatAssignmentService.js");
const C = await import("../src/lib/services/demoChatService.js");
const F = await import("../src/lib/services/demoChatFeedService.js");
const { demoChatAssignmentHandlers } = await import("../src/lib/demoChatAssignmentRoutes.js");
const { withAdminAuth } = await import("../src/lib/middleware/withAdminAuth.js");
const { signToken } = await import("../src/lib/services/authService.js");
const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = (fn) => Promise.resolve().then(fn).then(() => null, (e) => e);
const CASA = T.CHAT_TIMEZONE;
const at = (date, time) => T.zonedTimeToUtc(date, time, CASA).ms;
const yieldNow = () => new Promise((r) => setImmediate(r));
const ENV_ON = { DEMO_CHAT_ENABLED: "true" };
const NOW = at("2026-10-24", "12:00");
const TODAY = "2026-10-24";
const utcDate = (k) => new Date(`${k}T00:00:00.000Z`);

const STEPS_V1 = [
  { id: "s1", day: 1, time: "09:00", position: 0, type: "text", text: "Bonjour", earningsPeriod: null, metric: null, assetId: null },
  { id: "s3", day: 1, time: "10:00", position: 0, type: "image", text: "Vitrine", earningsPeriod: null, metric: null, assetId: "a1" },
  { id: "s2", day: 2, time: "09:00", position: 0, type: "text", text: "Jour 2", earningsPeriod: null, metric: null, assetId: null },
];
const STEPS_V2 = [{ id: "t1", day: 1, time: "09:00", position: 0, type: "text", text: "Nouvelle version", earningsPeriod: null, metric: null, assetId: null }];

// ── Fake ──────────────────────────────────────────────────────────────────────
function makeDb({ gateOn = false } = {}) {
  const t = {
    profiles: [
      { id: "p1", name: "سلمى", username: "salma", avatarUrl: null, avatarColor: "#f43f5e", isActive: true, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "p2", name: "Youssef", username: "youssef", avatarUrl: null, avatarColor: "#22c55e", isActive: true, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "p9", name: "Hidden", username: "hidden", avatarUrl: null, avatarColor: "#000", isActive: false, createdAt: new Date("2026-01-01T00:00:00Z") },
    ],
    journeys: [
      { id: "j1", name: "Parcours A", description: "", status: "draft", createdBy: null, createdAt: new Date(NOW), updatedAt: new Date("2026-10-01T00:00:00Z") },
      { id: "j2", name: "Parcours archivé", description: "", status: "archived", createdBy: null, createdAt: new Date(NOW), updatedAt: new Date("2026-10-01T00:00:00Z") },
    ],
    versions: [
      { id: "v1", journeyId: "j1", version: 1, steps: STEPS_V1, stepsHash: "h1", publishedAt: new Date("2026-10-02T00:00:00Z"), publishedBy: null },
      { id: "v2", journeyId: "j1", version: 2, steps: STEPS_V2, stepsHash: "h2", publishedAt: new Date("2026-10-03T00:00:00Z"), publishedBy: null },
      { id: "v3", journeyId: "j2", version: 1, steps: STEPS_V2, stepsHash: "h3", publishedAt: new Date("2026-10-01T00:00:00Z"), publishedBy: null },
    ],
    assets: [{ id: "a1", kind: "image", url: "/uploads/demo-chat/a1.webp", mimeType: "image/webp", width: 10, height: 10, durationSec: null, bytes: 100, formatDetected: "webp", sha256: "x", storageKey: null, createdBy: null, createdAt: new Date(NOW) }],
    assignments: [], messages: [], audit: [],
    settings: gateOn ? [{ id: G.DEMO_CHAT_SETTING_ID, data: { enabled: true } }] : [],
  };
  const calls = { settingWrites: 0, raw: [] };
  let seq = 0;
  const nid = (p) => `${p}${++seq}`;
  const versionWithJourney = (vid) => {
    const v = t.versions.find((x) => x.id === vid); if (!v) return null;
    const j = t.journeys.find((x) => x.id === v.journeyId);
    return { id: v.id, version: v.version, journeyId: v.journeyId, journey: { id: j.id, name: j.name, status: j.status } };
  };
  const hydrate = (a, include) => (a ? { ...structuredClone(a), ...(include?.version ? { version: versionWithJourney(a.versionId) } : {}) } : null);
  const matchAssign = (a, w = {}) => (w.id === undefined || a.id === w.id) && (w.demoAffiliateId === undefined || (typeof w.demoAffiliateId === "object" ? w.demoAffiliateId.in.includes(a.demoAffiliateId) : a.demoAffiliateId === w.demoAffiliateId))
    && (w.enabled === undefined || a.enabled === w.enabled)
    && (!w.version || t.versions.find((v) => v.id === a.versionId)?.journeyId === w.version.journeyId)
    && (!w.demoAffiliate || t.profiles.find((p) => p.id === a.demoAffiliateId)?.isActive === w.demoAffiliate.isActive);
  const models = {
    demoAffiliate: {
      findMany: async ({ where = {}, take, select }) => {
        let rows = t.profiles.filter((p) => (where.isActive === undefined || p.isActive === where.isActive)
          && (!where.OR || where.OR.some((o) => { const [k, c] = Object.entries(o)[0]; return String(p[k]).toLowerCase().includes(c.contains.toLowerCase()); })));
        rows = [...rows].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));
        return rows.slice(0, take ?? rows.length).map((p) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, p[k]])) : { ...p }));
      },
      findUnique: async ({ where }) => { const p = t.profiles.find((x) => x.id === where.id); return p ? { ...p } : null; },
    },
    demoChatAssignment: {
      findUnique: async ({ where, include, select }) => {
        await yieldNow();
        const a = t.assignments.find((x) => matchAssign(x, where));
        if (!a) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, a[k]])) : hydrate(a, include);
      },
      findMany: async ({ where = {}, include, select, orderBy, take }) => {
        let rows = t.assignments.filter((a) => matchAssign(a, where));
        if (orderBy) rows = [...rows].sort((a, b) => (a.enabledAt ?? 0) - (b.enabledAt ?? 0) || (a.id < b.id ? -1 : 1));
        rows = rows.slice(0, take ?? rows.length);
        if (select?.demoAffiliate) return rows.map((a) => ({ id: a.id, demoAffiliate: (({ id, name, avatarUrl, avatarColor, isActive }) => ({ id, name, avatarUrl, avatarColor, isActive }))(t.profiles.find((p) => p.id === a.demoAffiliateId)) }));
        return rows.map((a) => hydrate(a, include));
      },
      count: async ({ where = {} } = {}) => t.assignments.filter((a) => matchAssign(a, where)).length,
      create: async ({ data }) => {
        await yieldNow();
        if (t.assignments.some((a) => a.demoAffiliateId === data.demoAffiliateId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { id: nid("as"), ...structuredClone(data) }; t.assignments.push(row); return structuredClone(row);
      },
      update: async ({ where, data }) => {
        const a = t.assignments.find((x) => x.id === where.id); if (!a) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(a, structuredClone(data)); return structuredClone(a);
      },
      delete: async () => { throw new Error("TEST: assignments are never deleted"); },
      deleteMany: async () => { throw new Error("TEST: assignments are never deleted"); },
    },
    demoChatJourneyVersion: {
      findUnique: async ({ where, select }) => { const v = t.versions.find((x) => x.id === where.id); if (!v) return null; return select ? Object.fromEntries(Object.keys(select).map((k) => [k, v[k]])) : structuredClone(v); },
      findMany: async ({ where = {}, select, orderBy }) => {
        let rows = t.versions.filter((v) => (!where.journeyId || v.journeyId === where.journeyId)
          && (!where.journey || t.journeys.find((j) => j.id === v.journeyId)?.status === where.journey.status));
        rows = [...rows].sort((a, b) => (orderBy && !Array.isArray(orderBy) && orderBy.version === "desc" ? b.version - a.version : b.publishedAt - a.publishedAt));
        return rows.map((v) => (select?.journey ? { ...structuredClone(v), journey: { id: v.journeyId, name: t.journeys.find((j) => j.id === v.journeyId).name } } : structuredClone(v)));
      },
      findFirst: async () => null,
    },
    demoChatJourney: {
      findUnique: async ({ where }) => { const j = t.journeys.find((x) => x.id === where.id); return j ? { ...j } : null; },
      update: async ({ where, data }) => { const j = t.journeys.find((x) => x.id === where.id); Object.assign(j, data); return { ...j }; },
    },
    demoChatJourneyStep: { findMany: async () => [] },
    demoChatAsset: {
      findUnique: async ({ where }) => { const a = t.assets.find((x) => x.id === where.id); return a ? { ...a } : null; },
      findMany: async ({ where, select }) => t.assets.filter((a) => where.id.in.includes(a.id)).map((a) => Object.fromEntries(Object.keys(select).map((k) => [k, a[k] ?? null]))),
    },
    demoChatMessage: {
      findMany: async ({ where }) => {
        await yieldNow();
        return t.messages.filter((m) => m.assignmentId === where.assignmentId && m.revision === where.revision && m.loopIndex === where.loopIndex)
          .sort((a, b) => a.scheduledAt - b.scheduledAt || a.day - b.day || a.position - b.position || (a.stepId < b.stepId ? -1 : 1))
          .map((m) => structuredClone(m));
      },
      createMany: async ({ data, skipDuplicates }) => {
        await yieldNow();
        if (!skipDuplicates) throw new Error("TEST: createMany without skipDuplicates");
        let count = 0;
        for (const d of data) {
          if (t.messages.some((m) => m.assignmentId === d.assignmentId && m.revision === d.revision && m.loopIndex === d.loopIndex && m.stepId === d.stepId)) continue;
          t.messages.push({ id: nid("m"), earningsSnapshot: null, ...structuredClone(d) }); count++;
        }
        return { count };
      },
      update: async () => { throw new Error("TEST: messages are never updated"); },
      deleteMany: async () => { throw new Error("TEST: messages are never deleted"); },
    },
    demoChatAuditLog: {
      create: async ({ data }) => { t.audit.push(structuredClone(data)); return data; },
      update: async () => { throw new Error("TEST: audit is append-only"); },
    },
    setting: {
      findUnique: async ({ where }) => {
        if (where.id !== G.DEMO_CHAT_SETTING_ID) throw new Error(`TEST: forbidden setting ${where.id}`);
        return structuredClone(t.settings.find((x) => x.id === where.id) ?? null);
      },
      upsert: async ({ where, update, create }) => {
        if (where.id !== G.DEMO_CHAT_SETTING_ID) throw new Error(`TEST: forbidden setting write ${where.id}`);
        calls.settingWrites++;
        const row = t.settings.find((x) => x.id === where.id);
        if (row) row.data = structuredClone(update.data); else t.settings.push(structuredClone(create));
        return {};
      },
    },
  };
  const raw = async (strings, ...vals) => {
    await yieldNow();
    const q = strings.join("?").replace(/\s+/g, " ");
    calls.raw.push(q);
    if (/FROM "demo_affiliates" WHERE "id" = \? FOR SHARE/.test(q)) { const p = t.profiles.find((x) => x.id === vals[0]); return p ? [{ id: p.id, isActive: p.isActive }] : []; }
    if (/FROM "demo_chat_journeys" WHERE "id" = \? FOR (SHARE|UPDATE)/.test(q)) { const j = t.journeys.find((x) => x.id === vals[0]); return j ? [{ ...j }] : []; }
    if (/FROM "demo_chat_assignments" WHERE "demoAffiliateId" = \? FOR UPDATE/.test(q)) { const a = t.assignments.find((x) => x.demoAffiliateId === vals[0]); return a ? [structuredClone(a)] : []; }
    if (/FROM "demo_chat_assignments" WHERE "id" = \? FOR SHARE/.test(q)) { const a = t.assignments.find((x) => x.id === vals[0]); return a ? [structuredClone(a)] : []; }
    if (/FROM "settings" WHERE "id" = \? FOR UPDATE/.test(q)) { if (vals[0] !== G.DEMO_CHAT_SETTING_ID) throw new Error("TEST: forbidden settings lock"); const r = t.settings.find((x) => x.id === vals[0]); return r ? [structuredClone(r)] : []; }
    throw new Error(`TEST: unexpected raw SQL: ${q}`);
  };
  const guard = (o) => new Proxy(o, { get: (x, k) => { if (k in x || typeof k === "symbol" || k === "then") return x[k]; throw new Error(`TABLE ACCESS BLOCKED: db.${String(k)}`); } });
  const db = guard({
    ...models, _t: t, _calls: calls, $queryRaw: raw,
    // Per-transaction undo log: a failed transaction reverts only ITS OWN writes, so
    // concurrent transactions interleave like separate PostgreSQL sessions.
    $transaction: async (fn) => {
      const undo = [];
      const logged = (table, op) => async (args) => {
        const before = structuredClone(t[table]);
        const res = await op(args);
        const after = t[table];
        const added = after.filter((r) => !before.some((b) => b.id !== undefined ? b.id === r.id : JSON.stringify(b) === JSON.stringify(r)));
        const changed = before.filter((b) => { const cur = after.find((r) => r.id !== undefined && r.id === b.id); return cur && JSON.stringify(cur) !== JSON.stringify(b); });
        undo.push(() => {
          t[table] = t[table].filter((r) => !added.includes(r));
          for (const b of changed) { const cur = t[table].find((r) => r.id === b.id); if (cur) Object.assign(cur, b); }
        });
        return res;
      };
      const txModels = {
        ...models,
        demoChatAssignment: { ...models.demoChatAssignment, create: logged("assignments", models.demoChatAssignment.create), update: logged("assignments", models.demoChatAssignment.update) },
        demoChatAuditLog: { ...models.demoChatAuditLog, create: logged("audit", models.demoChatAuditLog.create) },
        demoChatJourney: { ...models.demoChatJourney, update: logged("journeys", models.demoChatJourney.update) },
        demoChatMessage: { ...models.demoChatMessage, createMany: logged("messages", models.demoChatMessage.createMany) },
        setting: { ...models.setting, upsert: logged("settings", models.setting.upsert) },
      };
      try { return await fn(guard({ ...txModels, $queryRaw: raw })); } catch (e) { for (const u of undo.reverse()) u(); throw e; }
    },
  });
  return db;
}

const use = (db) => { demo.__setDemoDb(db); return db; };
const admin = signToken({ userId: "admin-1", email: "a@x", role: "ADMIN" });
const H = (env = ENV_ON) => demoChatAssignmentHandlers({ env, now: () => NOW });
const wrap = (fn) => withAdminAuth(fn);
const call = async (fn, { method = "GET", url = "http://x/api/admin/demo-chat/assignments", body, token = admin, profileId } = {}) => {
  const headers = { "content-type": "application/json", ...(token ? { cookie: `auth_token=${token}` } : {}) };
  const r = await wrap(fn)(new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined }), { params: Promise.resolve({ profileId }) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const assign = (h, profileId, body, token) => call(h.assign, { method: "PUT", profileId, body, token });
const toggle = (h, profileId, body, token) => call(h.toggle, { method: "PATCH", profileId, body, token });
const setCfg = (h, body, token) => call(h.setConfig, { method: "PATCH", body, token });

// ── 1. Authentication ─────────────────────────────────────────────────────────
console.log("\n1. Admin authentication");
{
  const db = use(makeDb()); const h = H();
  ok("no cookie → 401, nothing written", (await call(h.list, { token: null })).status === 401 && (await assign(h, "p1", { versionId: "v1" }, null)).status === 401 && db._t.assignments.length === 0);
  const aff = signToken({ affiliateId: "aff-1", username: "aff", type: "affiliate" });
  ok("affiliate token → 403 on every operation", [await call(h.list, { token: aff }), await assign(h, "p1", { versionId: "v1" }, aff), await setCfg(h, { enabled: false }, aff)].every((r) => r.status === 403));
  const nonAdmin = signToken({ userId: "u2", email: "c@x", role: "CUSTOMER" });
  ok("non-admin role → 403", (await toggle(h, "p1", { enabled: true, expectedUpdatedAt: new Date().toISOString() }, nonAdmin)).status === 403);
  ok("forged token → 401", (await call(h.config, { token: "abc.def.ghi" })).status === 401);
  const bearerOnly = await withAdminAuth(h.list)(new Request("http://x/api/admin/demo-chat/assignments", { headers: { authorization: `Bearer ${admin}` } }), {});
  ok("Bearer header is not accepted for admin routes (cookie only)", bearerOnly.status === 401);
  ok("nothing written by rejected requests", db._t.assignments.length === 0 && db._t.audit.length === 0 && db._calls.settingWrites === 0);
  const r = await call(h.list);
  ok("admin → 200, private no-store", r.status === 200 && r.headers.get("cache-control") === "private, no-store");
  for (const f of ["src/app/api/admin/demo-chat/assignments/route.js", "src/app/api/admin/demo-chat/assignments/[profileId]/route.js", "src/app/api/admin/demo-chat/config/route.js"]) {
    const s = src(f); const methods = [...s.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (\w+)\(h\.(\w+)\);/g)];
    ok(`${f.split("/api/")[1]}: every method withAdminAuth-wrapped real handler`, methods.length > 0 && methods.every((m) => m[2] === "withAdminAuth") && !/export (async )?function/.test(s));
  }
}

// ── 2. Overview ───────────────────────────────────────────────────────────────
console.log("\n2. Overview (profiles, versions, gates)");
{
  use(makeDb()); const h = H();
  const all = (await call(h.list, { url: "http://x/api/admin/demo-chat/assignments?status=all" })).body;
  ok("all profiles listed, active first", all.profiles.map((p) => p.id).join() === "p2,p1,p9" || all.profiles.map((p) => p.id).join() === "p1,p2,p9");
  ok("status=active hides inactive profiles", (await call(h.list, { url: "http://x/api/admin/demo-chat/assignments?status=active" })).body.profiles.every((p) => p.isActive));
  ok("search by name (Arabic) / username", (await call(h.list, { url: "http://x/api/admin/demo-chat/assignments?q=%D8%B3%D9%84%D9%85%D9%89" })).body.profiles.map((p) => p.id).join() === "p1"
    && (await call(h.list, { url: "http://x/api/admin/demo-chat/assignments?q=YOUSS" })).body.profiles.map((p) => p.id).join() === "p2");
  ok("only versions of non-archived journeys are assignable", all.versions.map((v) => v.id).sort().join() === "v1,v2" && all.versions.every((v) => v.journeyName === "Parcours A"));
  ok("gates + Casablanca anchor range + confirmation word", all.gates.enabled === false && all.anchor.today === TODAY && all.anchor.min === "2025-10-24" && all.anchor.max === "2026-12-23" && all.confirmation === "ACTIVER");
  ok("bad status filter → 400", (await call(h.list, { url: "http://x/api/admin/demo-chat/assignments?status=weird" })).status === 400);
}

// ── 3. Validation ─────────────────────────────────────────────────────────────
console.log("\n3. Validation");
{
  const db = use(makeDb()); const h = H();
  ok("invalid profile id → 404", (await assign(h, "../x", { versionId: "v1" })).status === 404);
  ok("unknown profile → 404", (await assign(h, "nope", { versionId: "v1" })).status === 404);
  ok("missing / invalid versionId → 400", (await assign(h, "p1", {})).status === 400 && (await assign(h, "p1", { versionId: "x y" })).status === 400);
  ok("unknown (unpublished) version → 404", (await assign(h, "p1", { versionId: "draft-nope" })).status === 404);
  const arch = await assign(h, "p1", { versionId: "v3" });
  ok("version of an archived journey → 409 JOURNEY_ARCHIVED", arch.status === 409 && arch.body.code === "JOURNEY_ARCHIVED");
  const inact = await assign(h, "p9", { versionId: "v1" });
  ok("inactive profile → 409 PROFILE_INACTIVE", inact.status === 409 && inact.body.code === "PROFILE_INACTIVE");
  ok("anchor not a date → 400", (await assign(h, "p1", { versionId: "v1", anchorDate: "24/10/2026" })).status === 400 && (await assign(h, "p1", { versionId: "v1", anchorDate: "2026-02-30" })).status === 400);
  ok("anchor today − 366 → 400; today − 365 accepted", (await assign(h, "p1", { versionId: "v1", anchorDate: "2025-10-23" })).status === 400 && (await assign(h, "p2", { versionId: "v1", anchorDate: "2025-10-24" })).status === 201);
  ok("anchor today + 61 → 400; today + 60 accepted", (await assign(h, "p1", { versionId: "v1", anchorDate: "2026-12-24" })).status === 400 && (await assign(h, "p1", { versionId: "v1", anchorDate: "2026-12-23" })).status === 201);
  ok("Casablanca 'today' near midnight (23:30 UTC on the 23rd = 00:30 on the 24th)", S.anchorRange(Date.parse("2026-10-23T23:30:00Z")).today === "2026-10-24");
  ok("validation failures wrote nothing beyond the two valid creates", db._t.assignments.length === 2 && db._t.audit.length === 2);
}

// ── 4. Create / reassign / toggle ─────────────────────────────────────────────
console.log("\n4. Create, reassign, enable / disable, concurrency, audit");
{
  const db = use(makeDb()); const h = H();
  const c = await assign(h, "p1", { versionId: "v1" });
  const a1 = c.body.assignment;
  ok("create → 201, DISABLED, revision 1, anchor defaults to Casablanca today", c.status === 201 && c.body.created === true && a1.enabled === false && a1.revision === 1 && a1.anchorDate === TODAY && a1.enabledAt === null);
  ok("anchor stored as the calendar date (@db.Date at 00:00 UTC)", db._t.assignments[0].anchorDate.toISOString() === "2026-10-24T00:00:00.000Z");
  ok("audit ASSIGNMENT_CREATE with actor + after", db._t.audit.length === 1 && db._t.audit[0].action === "ASSIGNMENT_CREATE" && db._t.audit[0].actorType === "ADMIN" && db._t.audit[0].actorId === "admin-1" && db._t.audit[0].after.enabled === false);
  const dup = await assign(h, "p1", { versionId: "v2" });
  ok("second create without expectedUpdatedAt → 409 STALE (no duplicate)", dup.status === 409 && dup.body.code === "STALE" && db._t.assignments.length === 1);
  const stale = await assign(h, "p1", { versionId: "v2", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
  ok("stale expectedUpdatedAt → 409 STALE", stale.status === 409 && stale.body.code === "STALE");
  const same = await assign(h, "p1", { versionId: "v1", anchorDate: TODAY, expectedUpdatedAt: a1.updatedAt });
  ok("same version + anchor → 409 NO_CHANGES, no audit", same.status === 409 && same.body.code === "NO_CHANGES" && db._t.audit.length === 1);

  ok("toggle without expectedUpdatedAt → 400", (await toggle(h, "p1", { enabled: true })).status === 400);
  ok("toggle with non-boolean → 400", (await toggle(h, "p1", { enabled: "yes", expectedUpdatedAt: a1.updatedAt })).status === 400);
  ok("toggle unknown assignment → 404", (await toggle(h, "p2", { enabled: true, expectedUpdatedAt: a1.updatedAt })).status === 404);
  const en = await toggle(h, "p1", { enabled: true, expectedUpdatedAt: a1.updatedAt });
  ok("enable → enabled, enabledAt set, audit ASSIGNMENT_ENABLE", en.status === 200 && en.body.assignment.enabled === true && en.body.assignment.enabledAt === new Date(NOW).toISOString() && db._t.audit.at(-1).action === "ASSIGNMENT_ENABLE");
  const again = await toggle(h, "p1", { enabled: true, expectedUpdatedAt: en.body.assignment.updatedAt });
  ok("enable again → unchanged, no audit row", again.status === 200 && again.body.unchanged === true && db._t.audit.length === 2);
  ok("toggle with the pre-enable token → 409 STALE", (await toggle(h, "p1", { enabled: false, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" })).status === 409);

  const H2 = demoChatAssignmentHandlers({ env: ENV_ON, now: () => NOW + 60_000 });
  const re = await call(H2.assign, { method: "PUT", profileId: "p1", body: { versionId: "v2", expectedUpdatedAt: en.body.assignment.updatedAt } });
  const a2 = re.body.assignment;
  ok("reassign → 200, revision 2, DISABLED, enabledAt cleared", re.status === 200 && re.body.created === false && a2.revision === 2 && a2.enabled === false && a2.enabledAt === null && a2.versionId === "v2");
  const up = db._t.audit.at(-1);
  ok("audit ASSIGNMENT_UPDATE with before (rev 1, enabled) and after (rev 2, disabled)", up.action === "ASSIGNMENT_UPDATE" && up.before.revision === 1 && up.before.enabled === true && up.after.revision === 2 && up.after.enabled === false && /hidden/.test(up.reason));
  const anchorOnly = await call(demoChatAssignmentHandlers({ env: ENV_ON, now: () => NOW + 120_000 }).assign, { method: "PUT", profileId: "p1", body: { versionId: "v2", anchorDate: "2026-10-20", expectedUpdatedAt: a2.updatedAt } });
  ok("anchor-only change is a reassignment too (revision 3)", anchorOnly.status === 200 && anchorOnly.body.assignment.revision === 3 && anchorOnly.body.assignment.anchorDate === "2026-10-20");
  const auditN = db._t.audit.length;
  // Concurrent first creates for p2: exactly one wins.
  const [r1, r2] = await Promise.all([assign(h, "p2", { versionId: "v1" }), assign(h, "p2", { versionId: "v2" })]);
  ok(`concurrent creates → one 201, one 409 (${r1.status}/${r2.status} ${r1.body.code || ""}${r2.body.code || ""})`, [r1.status, r2.status].sort().join() === "201,409" && db._t.assignments.filter((a) => a.demoAffiliateId === "p2").length === 1);
  ok("…and exactly one audit row for it (loser rolled back)", db._t.audit.length === auditN + 1);
  // Profile deactivated after assignment: can be disabled, not enabled.
  db._t.profiles.find((p) => p.id === "p2").isActive = false;
  const p2a = db._t.assignments.find((a) => a.demoAffiliateId === "p2");
  const enInactive = await toggle(h, "p2", { enabled: true, expectedUpdatedAt: p2a.updatedAt.toISOString() });
  ok("enable for an inactive profile → 409 PROFILE_INACTIVE", enInactive.status === 409 && enInactive.body.code === "PROFILE_INACTIVE");
  ok("no write path deletes assignments", !/demoChatAssignment\.(delete|deleteMany)/.test(src("src/lib/services/demoChatAssignmentService.js")));
}

// ── 5. Global switch ──────────────────────────────────────────────────────────
console.log("\n5. Global protected switch");
{
  const db = use(makeDb());
  const off = H({});
  const e1 = await setCfg(off, { enabled: true, confirm: "ACTIVER" });
  ok("enable with env switch off → 409 ENV_GATE_OFF, nothing written", e1.status === 409 && e1.body.code === "ENV_GATE_OFF" && db._calls.settingWrites === 0);
  const on = H(ENV_ON);
  ok("enable without confirmation → 400 CONFIRMATION_REQUIRED", (await setCfg(on, { enabled: true })).body.code === "CONFIRMATION_REQUIRED");
  ok("enable with the wrong word → 400", (await setCfg(on, { enabled: true, confirm: "activer" })).status === 400 && db._calls.settingWrites === 0);
  ok("non-boolean enabled → 400", (await setCfg(on, { enabled: "true", confirm: "ACTIVER" })).status === 400);
  const e2 = await setCfg(on, { enabled: true, confirm: "ACTIVER" });
  ok("env on + ACTIVER → enabled; setting row written once", e2.status === 200 && e2.body.setting === true && e2.body.enabled === true && db._calls.settingWrites === 1 && db._t.settings[0].data.enabled === true);
  ok("audit CHAT_ENABLE on entity 'config'", db._t.audit.at(-1).action === "CHAT_ENABLE" && db._t.audit.at(-1).entityType === "config" && db._t.audit.at(-1).entityId === G.DEMO_CHAT_SETTING_ID);
  const n = db._t.audit.length;
  ok("enable again → unchanged, no write, no audit", (await setCfg(on, { enabled: true, confirm: "ACTIVER" })).body.unchanged === true && db._calls.settingWrites === 1 && db._t.audit.length === n);
  const d = await setCfg(off, { enabled: false });
  ok("disable works with the env switch OFF (no confirmation needed)", d.status === 200 && d.body.setting === false && db._t.settings[0].data.enabled === false && db._t.audit.at(-1).action === "CHAT_DISABLE");
  ok("GET /config reflects both gates", (await call(on.config, { url: "http://x/api/admin/demo-chat/config" })).body.env === true);
  const g = await upsertSettingsHandler(new Request("http://x/api/setting?type=demo-chat-config", { method: "POST", body: JSON.stringify({ enabled: true }) }));
  ok("generic /api/setting still refuses demo-chat-config (400, no write)", g.status === 400 && db._calls.settingWrites === 2);
  // Only this service writes the row.
  const writers = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) { if (f !== "generated") walk(p); } else if (/\.(js|jsx|ts|tsx)$/.test(f)) { const s = readFileSync(p, "utf8"); if (/(DEMO_CHAT_SETTING_ID|demo-chat-config)/.test(s) && /setting\s*\.\s*(upsert|update|create|createMany|updateMany)\s*\(/.test(s)) writers.push(p); } } };
  walk("src");
  ok(`the assignment service is the only writer of demo-chat-config (${writers.join(", ")})`, writers.length === 1 && writers[0].endsWith("services/demoChatAssignmentService.js"));
}

// ── 6. No affiliate / public exposure ─────────────────────────────────────────
console.log("\n6. Not reachable from affiliate or public code");
{
  const IMPORTS_IT = /(from|import\()\s*['"][^'"]*demoChatAssignment(Service|Routes)/;
  const offenders = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) { if (f !== "generated") walk(p); } else if (/\.(js|jsx|ts|tsx)$/.test(f) && IMPORTS_IT.test(readFileSync(p, "utf8"))) offenders.push(p); } };
  walk("src");
  const allowed = (p) => p.startsWith("src/app/api/admin/demo-chat/") || p === "src/lib/demoChatAssignmentRoutes.js" || p === "src/lib/services/demoChatAssignmentService.js";
  ok(`only admin routes import the assignment service/handlers (${offenders.join(", ")})`, offenders.length === 4 && offenders.every(allowed));
  ok("affiliate feed code does not import it", !IMPORTS_IT.test(src("src/lib/demoChatFeedRoute.js") + src("src/lib/services/demoChatFeedService.js") + src("src/app/api/affiliate/demo-chat/route.js")));
  ok("admin page calls only /api/admin/demo-chat/* endpoints", [...src("src/app/admin/demo-chat/assignments/page.jsx").matchAll(/api\(`?["']?(\/api\/[^`"'?$]+)/g)].every((m) => m[1].startsWith("/api/admin/demo-chat/")));
}

// ── 7. Journey archiving ──────────────────────────────────────────────────────
console.log("\n7. Archiving a journey in use");
{
  const db = use(makeDb()); const h = H();
  const a = (await assign(h, "p1", { versionId: "v1" })).body.assignment;
  const en = (await toggle(h, "p1", { enabled: true, expectedUpdatedAt: a.updatedAt })).body.assignment;
  const jUpdated = db._t.journeys.find((j) => j.id === "j1").updatedAt.toISOString();
  const e = await rejects(() => C.updateJourney("j1", { expectedUpdatedAt: jUpdated, action: "archive" }, { actorId: "admin-1", now: NOW }));
  ok("archive while an ENABLED assignment uses it → 409 IN_USE", e?.status === 409 && e.code === "IN_USE" && db._t.journeys.find((j) => j.id === "j1").status === "draft");
  ok("…no audit row for the refused archive", !db._t.audit.some((x) => x.action === "JOURNEY_ARCHIVE"));
  await toggle(h, "p1", { enabled: false, expectedUpdatedAt: en.updatedAt });
  const ar = await C.updateJourney("j1", { expectedUpdatedAt: jUpdated, action: "archive" }, { actorId: "admin-1", now: NOW });
  ok("disabled assignment → archiving allowed", ar.journey.status === "archived" && db._t.audit.at(-1).action === "JOURNEY_ARCHIVE");
  const cur = db._t.assignments[0];
  const reEn = await toggle(h, "p1", { enabled: true, expectedUpdatedAt: cur.updatedAt.toISOString() });
  ok("enabling an assignment of an archived journey → 409 JOURNEY_ARCHIVED", reEn.status === 409 && reEn.body.code === "JOURNEY_ARCHIVED");
  ok("assigning a version of the now-archived journey → 409", (await assign(h, "p2", { versionId: "v2" })).body.code === "JOURNEY_ARCHIVED");
  ok("archive lock + assignment lock order shared (journey FOR SHARE in assignment writes)", db._calls.raw.some((q) => /demo_chat_journeys" WHERE "id" = \? FOR SHARE/.test(q)) && db._calls.raw.some((q) => /demo_chat_journeys" WHERE "id" = \? FOR UPDATE/.test(q)));
}

// ── 8. End to end with the 3C-6 materializer + 3C-7 feed ──────────────────────
console.log("\n8. Feed across revisions and both gates (Phase 3C-6 / 3C-7 regression)");
{
  const db = use(makeDb()); const h = H(ENV_ON);
  const feed = (env = ENV_ON, now = NOW) => F.getMiniChatFeed({ now, env, db, materialize: true });
  const a = (await assign(h, "p1", { versionId: "v1" })).body.assignment;
  ok("assignment created but feature off → feed null, nothing materialized", (await feed()) === null && db._t.messages.length === 0);
  await setCfg(h, { enabled: true, confirm: "ACTIVER" });
  const f0 = await feed();
  ok("gates on, assignment disabled → empty feed, nothing materialized", f0 && f0.profiles.length === 0 && db._t.messages.length === 0);
  const en = (await toggle(h, "p1", { enabled: true, expectedUpdatedAt: a.updatedAt })).body.assignment;
  const f1 = await feed();
  ok("enabled → due messages of revision 1 (day 1 09:00 + 10:00), not day 2", f1.messages.map((m) => m.text).join("|") === "Bonjour|Vitrine" && db._t.messages.length === 2 && db._t.messages.every((m) => m.revision === 1));
  ok("image message carries validated media", f1.messages[1].media?.url === "/uploads/demo-chat/a1.webp");
  ok("Casablanca local times preserved", f1.messages.map((m) => m.localTime).join() === "09:00,10:00" && f1.messages[0].localDate === TODAY);
  await Promise.all([feed(), feed(), feed()]);
  ok("repeated / concurrent feed reads → no duplicates", db._t.messages.length === 2);
  const re = (await call(demoChatAssignmentHandlers({ env: ENV_ON, now: () => NOW + 60_000 }).assign, { method: "PUT", profileId: "p1", body: { versionId: "v2", expectedUpdatedAt: en.updatedAt } })).body.assignment;
  const f2 = await feed(ENV_ON, NOW + 120_000);
  ok("after reassignment (disabled) → conversation gone from the feed", f2.profiles.length === 0 && f2.messages.length === 0);
  await toggle(h, "p1", { enabled: true, expectedUpdatedAt: re.updatedAt });
  const f3 = await feed(ENV_ON, NOW + 180_000);
  ok("re-enabled → only revision 2 messages shown", f3.messages.map((m) => m.text).join("|") === "Nouvelle version");
  ok("revision 1 messages kept in storage (hidden, not deleted)", db._t.messages.filter((m) => m.revision === 1).length === 2 && db._t.messages.filter((m) => m.revision === 2).length === 1);
  ok("env switch off → feed null even with the setting on", (await feed({})) === null);
  await setCfg(H({}), { enabled: false });
  ok("setting off (disabled with env off) → feed null", (await feed()) === null);
  ok("materializer writes stayed insert-only (no update/delete thrown)", db._t.messages.length === 3);
}

// ── 9. Status endpoint + docs wiring ──────────────────────────────────────────
console.log("\n9. Status, navigation, audit filter");
{
  const db = use(makeDb({ gateOn: true }));
  await assign(H(), "p1", { versionId: "v1" });
  const s = await C.getChatStatus();
  ok("status: gates + assignment counts + phase", s.setting === true && s.assignments === 1 && s.enabledAssignments === 0 && s.phase === "3C-9B");
  ok("audit list accepts 'assignment' and 'config' filters", /'assignment', 'config'/.test(src("src/lib/services/demoChatService.js")) && /value="config"/.test(src("src/app/admin/demo-chat/audit/page.jsx")));
  ok("demo-chat index links to the assignments page", /href="\/admin\/demo-chat\/assignments"/.test(src("src/app/admin/demo-chat/page.jsx")));
  const ui = src("src/app/admin/demo-chat/assignments/page.jsx");
  ok("UI: typed confirmation, reassignment warning, preview link, stale handling, dir=auto names", /typed !== confirmation/.test(ui) && /désactive<\/b> l'attribution et masque les messages/.test(ui) && /\/preview\?version=/.test(ui) && /STALE/.test(ui) && /dir="auto"/.test(ui));
  ok("UI: loading, empty, error + retry states", /Loader2 className="w-5 h-5 animate-spin/.test(ui) && /Aucun profil démo/.test(ui) && /Réessayer/.test(ui));
  ok("feature stays off by default (.env.example + no default setting row)", /^DEMO_CHAT_ENABLED=false$/m.test(src(".env.example")) && makeDb()._t.settings.length === 0);
  void db;
}

demo.__setDemoDb(null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
