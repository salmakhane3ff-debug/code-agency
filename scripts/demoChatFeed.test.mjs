#!/usr/bin/env node
/**
 * scripts/demoChatFeed.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-7 — affiliate Mini Chat feed + UI helpers.
 * No database, no network: the REAL withAffiliateAuth (signed test tokens)
 * over an in-memory fake that throws on any table the feed must not touch
 * (real affiliates are readable ONLY as `findUnique … select { isActive }`;
 * demo earnings history / coverage are not readable at all → proves the feed
 * never re-resolves earnings). Proves:
 *   • authentication (401), inactive accounts (403), feature gates (404)
 *   • no client-supplied profile / assignment / affiliate id is ever read;
 *     only enabled assignments of active demo profiles; same feed for all
 *   • ordering, Casablanca dates/times, no future messages, current cycle
 *   • media rendering (image / audio), unsafe URLs dropped, kind mismatch
 *   • stored earnings snapshots rendered as is; unavailable / corrupt
 *     snapshots never show an amount or a zero
 *   • disabled by default, UI wiring; the only writes are the Phase 3C-6
 *     insert-or-ignore + audit row, via lazy materialization on authenticated
 *     feed access (bounded, idempotent under 20 concurrent requests)
 * Run: node scripts/demoChatFeed.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";

const T = await import("../src/lib/demoChatTime.js");
const G = await import("../src/lib/demoChatGate.js");
const M = await import("../src/lib/services/demoChatMessageService.js");
const F = await import("../src/lib/services/demoChatFeedService.js");
const V = await import("../src/lib/demoMiniChatView.js");
const { demoChatFeedHandler } = await import("../src/lib/demoChatFeedRoute.js");
const { withAffiliateAuth } = await import("../src/lib/middleware/withAffiliateAuth.js");
const { signToken } = await import("../src/lib/services/authService.js");

let pass = 0, fail = 0;
const skipped = []; const matFails = []; const realErr = console.error;
console.error = (...a) => {
  const m = String(a[0]);
  if (m.includes("conversation skipped")) skipped.push(a); else if (m.includes("materialization failed")) matFails.push(a); else realErr(...a);
};
const yieldNow = () => new Promise((r) => setImmediate(r));
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const CASA = T.CHAT_TIMEZONE;
const at = (date, time) => T.zonedTimeToUtc(date, time, CASA).ms;
const ENV_ON = { DEMO_CHAT_ENABLED: "true" };
const utc = (key) => new Date(`${key}T00:00:00.000Z`);
const tokenFor = (affiliateId) => signToken({ affiliateId, username: affiliateId, type: "affiliate" });

const snap = (resolution, scheduled) => M.buildEarningsSnapshot(resolution, { nowMs: scheduled, scheduledAtMs: scheduled, metric: "commission" });

// ── Fake ──────────────────────────────────────────────────────────────────────
function makeDb({ gateOn = true, steps = {} } = {}) {
  const t = {
    versions: ["v1", "v2", "v3", "v4"].map((id) => ({ id, steps: structuredClone(steps[id] || []) })),
    audit: [],
    settings: gateOn ? [{ id: G.DEMO_CHAT_SETTING_ID, data: { enabled: true } }] : [],
    affiliates: [{ id: "aff-1", isActive: true }, { id: "aff-2", isActive: true }, { id: "aff-off", isActive: false }],
    profiles: [
      { id: "p1", name: "Salma", avatarUrl: "https://cdn.example.com/a/salma.webp", avatarColor: "#f43f5e", isActive: true },
      { id: "p2", name: "Youssef", avatarUrl: "javascript:alert(1)", avatarColor: "#22c55e", isActive: true },
      { id: "p3", name: "Hidden", avatarUrl: null, avatarColor: "#000", isActive: false },
      { id: "p4", name: "Disabled", avatarUrl: null, avatarColor: "#000", isActive: true },
    ],
    assignments: [
      { id: "as1", demoAffiliateId: "p1", versionId: "v1", anchorDate: utc("2026-10-01"), revision: 2, enabled: true, enabledAt: new Date("2026-10-01T00:00:00Z") },
      { id: "as2", demoAffiliateId: "p2", versionId: "v2", anchorDate: utc("2026-10-10"), revision: 1, enabled: true, enabledAt: new Date("2026-10-02T00:00:00Z") },
      { id: "as3", demoAffiliateId: "p3", versionId: "v3", anchorDate: utc("2026-10-01"), revision: 1, enabled: true, enabledAt: new Date("2026-10-03T00:00:00Z") },
      { id: "as4", demoAffiliateId: "p4", versionId: "v4", anchorDate: utc("2026-10-01"), revision: 1, enabled: false, enabledAt: null },
    ],
    assets: [
      { id: "img1", kind: "image", url: "/uploads/demo-chat/a.webp", mimeType: "image/webp", width: 640, height: 480, durationSec: null, storageKey: "SECRET-KEY", sha256: "h1", createdBy: "admin" },
      { id: "aud1", kind: "audio", url: "https://cdn.example.com/v.m4a", mimeType: "audio/mp4", width: null, height: null, durationSec: 12.5, storageKey: "k2", sha256: "h2", createdBy: "admin" },
      { id: "bad1", kind: "image", url: "data:text/html,<script>x</script>", mimeType: "image/png", width: 1, height: 1, durationSec: null },
      { id: "aud2", kind: "audio", url: "/uploads/demo-chat/x.m4a", mimeType: "audio/mp4", durationSec: 3 },
    ],
    messages: [],
  };
  const calls = { affiliateSelects: [], assignmentWhere: [], writes: 0, createMany: 0, failInsert: false };
  let seq = 0;
  const add = (m) => t.messages.push({ id: `m${++seq}`, position: 0, text: null, assetId: null, earningsPeriod: null, metric: null, earningsSnapshot: null, ...m });
  const blockWrites = (name) => new Proxy({}, { get: (_x, k) => async () => { calls.writes++; throw new Error(`TEST: write ${name}.${String(k)} forbidden`); } });
  const cond = (v, c) => (c && typeof c === "object" && !(c instanceof Date) ? (("in" in c ? c.in.includes(v) : true)) : v === c);
  const match = (r, w = {}) => Object.entries(w).every(([k, c]) => cond(r[k], c));
  const models = {
    setting: {
      findUnique: async ({ where }) => {
        if (where.id !== G.DEMO_CHAT_SETTING_ID) throw new Error(`TEST: forbidden setting ${where.id}`);
        return t.settings.find((x) => x.id === where.id) ?? null;
      },
    },
    affiliate: {
      findUnique: async ({ where, select }) => {
        calls.affiliateSelects.push(select);
        if (!select || Object.keys(select).join() !== "isActive") throw new Error("TEST: real affiliate read beyond isActive");
        const r = t.affiliates.find((x) => x.id === where.id); return r ? { isActive: r.isActive } : null;
      },
    },
    demoChatAssignment: {
      findMany: async ({ where, select, orderBy, take }) => {
        calls.assignmentWhere.push(where);
        let rows = t.assignments.filter((a) => (where.enabled === undefined || a.enabled === where.enabled)
          && (!where.demoAffiliate || t.profiles.find((p) => p.id === a.demoAffiliateId)?.isActive === where.demoAffiliate.isActive));
        if (orderBy) rows = [...rows].sort((a, b) => (a.enabledAt ?? 0) - (b.enabledAt ?? 0) || (a.id < b.id ? -1 : 1));
        rows = rows.slice(0, take ?? rows.length);
        return rows.map((a) => ({ id: a.id, demoAffiliate: (({ id, name, avatarUrl, avatarColor, isActive }) => ({ id, name, avatarUrl, avatarColor, isActive }))(t.profiles.find((p) => p.id === a.demoAffiliateId)) }));
      },
      findUnique: async ({ where }) => { const r = t.assignments.find((x) => x.id === where.id); return r ? structuredClone(r) : null; },
    },
    demoChatMessage: {
      findMany: async ({ where }) => {
        await yieldNow();
        return t.messages.filter((x) => match(x, where))
          .sort((a, b) => a.scheduledAt - b.scheduledAt || a.day - b.day || a.position - b.position || (a.stepId < b.stepId ? -1 : 1))
          .map((r) => structuredClone(r));
      },
    },
    demoChatJourneyVersion: { findUnique: async ({ where }) => structuredClone(t.versions.find((v) => v.id === where.id) ?? null) },
    demoAffiliate: { findUnique: async ({ where }) => { const r = t.profiles.find((p) => p.id === where.id); return r ? { ...r, username: r.name, createdAt: new Date("2026-01-01T00:00:00Z") } : null; } },
    demoChatAuditLog: {},
    demoChatAsset: {
      findMany: async ({ where, select }) => {
        if (select.storageKey || select.sha256 || select.createdBy) throw new Error("TEST: private asset fields selected");
        return t.assets.filter((a) => where.id.in.includes(a.id)).map((a) => Object.fromEntries(Object.keys(select).map((k) => [k, a[k] ?? null])));
      },
    },
  };
  for (const m of Object.values(models)) for (const w of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) m[w] = blockWrites("model")[w];
  // The ONLY writes allowed: the Phase 3C-6 materializer's insert-or-ignore + its SYSTEM audit row.
  models.demoChatMessage.createMany = async ({ data, skipDuplicates }) => {
    calls.createMany++; await yieldNow();
    if (calls.failInsert) throw Object.assign(new Error("db down"), { code: "P1001" });
    if (!skipDuplicates) throw new Error("TEST: createMany without skipDuplicates");
    let count = 0;
    for (const d of data) {
      if (t.messages.some((m) => m.assignmentId === d.assignmentId && m.revision === d.revision && m.loopIndex === d.loopIndex && m.stepId === d.stepId)) continue;
      add(structuredClone(d)); count++;
    }
    return { count };
  };
  models.demoChatAuditLog.create = async ({ data }) => { t.audit.push(data); return data; };
  const guard = (o) => new Proxy(o, { get: (x, k) => { if (k in x || typeof k === "symbol" || k === "then") return x[k]; throw new Error(`TABLE ACCESS BLOCKED: db.${String(k)}`); } });
  const tx = guard({
    ...models,
    $queryRaw: async (strings, ...vals) => {
      if (!/FROM "demo_chat_assignments"[\s\S]*FOR SHARE/.test(strings.join("?"))) throw new Error("TEST: unexpected raw SQL");
      const r = t.assignments.find((x) => x.id === vals[0]);
      return r ? [structuredClone(r)] : [];
    },
  });
  return guard({
    ...models, _t: t, _calls: calls, _add: add,
    $transaction: async (fn) => fn(tx), $queryRaw: blockWrites("raw").run, $executeRaw: blockWrites("raw").run,
  });
}

const mk = (assignmentId, revision, loopIndex, day, stepId, date, time, extra = {}) => {
  const a = { as1: "p1", as2: "p2", as3: "p3", as4: "p4" }[assignmentId];
  return { assignmentId, demoAffiliateId: a, versionId: `v${assignmentId.slice(2)}`, revision, loopIndex, day, stepId, scheduledAt: new Date(at(date, time)), type: "text", text: stepId, createdAt: new Date(), ...extra };
};

function seed(db) {
  const s2 = at("2026-10-02", "12:30");
  // p1 (anchor 10-01, revision 2) — current cycle 0
  db._add(mk("as1", 2, 0, 1, "a-text", "2026-10-01", "09:00", { text: "Bienvenue 👋" }));
  db._add(mk("as1", 2, 0, 2, "a-earn", "2026-10-02", "12:30", {
    type: "earnings", text: "حققت {amount} {period}", earningsPeriod: "yesterday", metric: "commission",
    earningsSnapshot: snap({ period: "yesterday", status: "complete", reason: "row_and_coverage", day: "2026-10-01", orders: 4, revenue: 250, commission: 12.5 }, s2),
  }));
  db._add(mk("as1", 2, 0, 2, "a-unav", "2026-10-02", "12:30", {
    position: 1, type: "earnings", text: "{amount} {period}", earningsPeriod: "week", metric: "commission",
    earningsSnapshot: snap({ period: "week", status: "unavailable", reason: "week_incomplete" }, s2),
  }));
  db._add(mk("as1", 2, 0, 2, "a-img", "2026-10-02", "18:00", { type: "image", text: "Ma vitrine", assetId: "img1" }));
  db._add(mk("as1", 2, 0, 3, "a-aud", "2026-10-03", "08:15", { type: "audio", assetId: "aud1" }));
  db._add(mk("as1", 2, 0, 3, "a-badimg", "2026-10-03", "08:20", { type: "image", assetId: "bad1" }));
  db._add(mk("as1", 2, 0, 3, "a-kind", "2026-10-03", "08:25", { type: "image", assetId: "aud2" }));
  db._add(mk("as1", 2, 0, 20, "a-future", "2026-10-20", "10:00", { text: "FUTURE" }));            // > now
  db._add(mk("as1", 1, 0, 1, "a-oldrev", "2026-10-01", "08:00", { text: "OLD REVISION" }));      // previous revision
  db._add(mk("as1", 2, 1, 1, "a-nextloop", "2026-10-31", "09:00", { text: "NEXT LOOP" }));       // other cycle
  // p2 (anchor 10-10)
  db._add(mk("as2", 1, 0, 1, "b-text", "2026-10-10", "09:00", { text: "Salam" }));
  db._add(mk("as2", 1, 0, 1, "b-same", "2026-10-01", "09:00", { text: "BEFORE ANCHOR (other cycle)", loopIndex: -1 }));
  // p3 inactive, p4 disabled — must never appear
  db._add(mk("as3", 1, 0, 1, "c-hidden", "2026-10-01", "10:00", { text: "INACTIVE PROFILE" }));
  db._add(mk("as4", 1, 0, 1, "d-hidden", "2026-10-01", "10:00", { text: "DISABLED ASSIGNMENT" }));
}

const NOW = at("2026-10-12", "10:00");
const feedOf = async (db, extra = {}) => F.getMiniChatFeed({ now: NOW, env: ENV_ON, db, ...extra });
const handlerFor = (db, extra = {}) => withAffiliateAuth(demoChatFeedHandler({ db, demoDb: db, env: ENV_ON, now: () => NOW, rateLimit: () => null, ...extra }));
const req = (url = "http://x/api/affiliate/demo-chat", headers = {}) => new Request(url, { headers });
const call = async (h, opts = {}) => {
  const r = await h(req(opts.url, opts.token ? { authorization: `Bearer ${opts.token}` } : {}), {});
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

// ── 1. Authentication ─────────────────────────────────────────────────────────
console.log("\n1. Authentication");
{
  const db = makeDb(); seed(db); const h = handlerFor(db);
  ok("no token → 401", (await call(h)).status === 401);
  ok("forged / invalid token → 401", (await call(h, { token: "abc.def.ghi" })).status === 401);
  ok("admin token (not affiliate) → 401", (await call(h, { token: signToken({ userId: "u1", email: "a@x", role: "ADMIN" }) })).status === 401);
  ok("affiliate token without affiliateId → 401", (await call(h, { token: signToken({ type: "affiliate" }) })).status === 401);
  ok("HttpOnly cookie token accepted", (await (await h(req(undefined, { cookie: `affiliate_token=${tokenFor("aff-1")}` }), {})).status) === 200);
  const r = await call(h, { token: tokenFor("aff-1") });
  ok("valid active affiliate → 200, private no-store", r.status === 200 && r.headers.get("cache-control") === "private, no-store");
}

// ── 2. Authorization ──────────────────────────────────────────────────────────
console.log("\n2. Authorization (active account, server-side only)");
{
  const db = makeDb(); seed(db); const h = handlerFor(db);
  ok("deactivated affiliate (token still valid) → 403, no chat data", await call(h, { token: tokenFor("aff-off") }).then((r) => r.status === 403 && !r.body?.messages));
  ok("unknown affiliate id in token → 403", (await call(h, { token: tokenFor("ghost") })).status === 403);
  ok("real affiliate table read only as findUnique select {isActive}", db._calls.affiliateSelects.every((s) => Object.keys(s).join() === "isActive"));
  const rl = handlerFor(db, { rateLimit: () => new Response("{}", { status: 429 }) });
  ok("rate limit applies before any read", (await call(rl, { token: tokenFor("aff-1") })).status === 429);
}

// ── 3. Assignment isolation / no client ids ───────────────────────────────────
console.log("\n3. Assignment isolation — no client-supplied ids");
{
  const db = makeDb(); seed(db); const h = handlerFor(db);
  const base = await call(h, { token: tokenFor("aff-1") });
  const texts = base.body.messages.map((m) => m.text).join("|");
  ok("inactive demo profile never shown", !texts.includes("INACTIVE PROFILE") && !base.body.profiles.some((p) => p.name === "Hidden"));
  ok("disabled assignment never shown", !texts.includes("DISABLED ASSIGNMENT") && !base.body.profiles.some((p) => p.name === "Disabled"));
  ok("query only enabled assignments of active profiles", db._calls.assignmentWhere.every((w) => w.enabled === true && w.demoAffiliate?.isActive === true));
  const tampered = await call(h, { token: tokenFor("aff-1"), url: "http://x/api/affiliate/demo-chat?profileId=p3&assignmentId=as4&demoAffiliateId=p4&affiliateId=aff-2" });
  ok("client profileId / assignmentId / affiliateId params ignored (identical feed)", JSON.stringify(tampered.body.messages) === JSON.stringify(base.body.messages));
  const other = await call(h, { token: tokenFor("aff-2") });
  ok("same shared feed for every viewer (no per-viewer data)", JSON.stringify(other.body.messages) === JSON.stringify(base.body.messages));
  const json = JSON.stringify(base.body);
  const leak = json.match(/"(as[1-4]|p[1-4]|v[1-4]?|img1|aud1)"|assignmentId|demoAffiliateId|versionId|stepId|assetId/);
  ok(`no database ids leak (assignment, demo profile, version, asset)${leak ? ` — found ${leak[0]}` : ""}`, !leak);
  ok("profiles referenced by opaque per-response keys", base.body.profiles.every((p) => /^c\d+$/.test(p.key) && !("id" in p)) && base.body.messages.every((m) => base.body.profiles.some((p) => p.key === m.profile)));
  ok("route file accepts no params and wires withAffiliateAuth", /export const GET = withAffiliateAuth\(demoChatFeedHandler\(\)\);/.test(src("src/app/api/affiliate/demo-chat/route.js")) && !/searchParams\.get\('(profile|assignment|affiliate)/i.test(src("src/lib/demoChatFeedRoute.js")));
  ok("no forbidden write; nothing due (empty journeys) → nothing inserted", db._calls.writes === 0 && db._t.audit.length === 0 && db._t.messages.length === 14);
}

// ── 4. Feature gates ──────────────────────────────────────────────────────────
console.log("\n4. Feature gates (disabled by default)");
{
  const db = makeDb(); seed(db);
  const off1 = await call(handlerFor(db, { env: {} }), { token: tokenFor("aff-1") });
  ok("env DEMO_CHAT_ENABLED unset → 404, no chat data", off1.status === 404 && !off1.body.messages);
  ok("env 'TRUE' / '1' are not 'true' → 404", (await call(handlerFor(db, { env: { DEMO_CHAT_ENABLED: "1" } }), { token: tokenFor("aff-1") })).status === 404);
  const db2 = makeDb({ gateOn: false }); seed(db2);
  ok("protected setting off → 404", (await call(handlerFor(db2), { token: tokenFor("aff-1") })).status === 404);
  ok("gates off → the real affiliate table is not even read", db2._calls.affiliateSelects.length === 0);
  ok("gates off → inactive account cannot tell (same 404)", (await call(handlerFor(db2), { token: tokenFor("aff-off") })).status === 404);
  ok("service returns null when disabled", (await F.getMiniChatFeed({ now: NOW, env: {}, db })) === null);
  ok("no code writes the protected setting / enables profiles", !/\.(upsert|update|updateMany|create|createMany|delete|deleteMany)\(/.test(src("src/lib/services/demoChatFeedService.js") + src("src/lib/demoChatFeedRoute.js")));
}

// ── 5. Ordering, timestamps, visibility ───────────────────────────────────────
console.log("\n5. Ordering, Casablanca timestamps, no future, current cycle");
{
  const db = makeDb(); seed(db);
  const feed = await feedOf(db);
  const ids = feed.messages.map((m) => m.text ?? m.type);
  ok("chronological across conversations (scheduledAt asc)", feed.messages.every((m, i, a) => i === 0 || Date.parse(a[i - 1].scheduledAt) <= Date.parse(m.scheduledAt)));
  ok("same instant keeps the conversation's own order (position)", feed.messages.findIndex((m) => m.earningsPeriod === "yesterday") < feed.messages.findIndex((m) => m.earningsPeriod === "week"));
  ok("future message excluded", !ids.includes("FUTURE"));
  ok("previous revision excluded", !ids.includes("OLD REVISION"));
  ok("other cycle excluded", !ids.includes("NEXT LOOP") && !ids.join().includes("BEFORE ANCHOR"));
  const first = feed.messages[0];
  ok("original Casablanca local date/time kept", first.localDate === "2026-10-01" && first.localTime === "09:00" && first.scheduledAt === new Date(at("2026-10-01", "09:00")).toISOString());
  ok("feed carries Casablanca 'today' + timezone", feed.today === "2026-10-12" && feed.timezone === "Africa/Casablanca");
  ok("every message flagged simulated", feed.simulated === true && feed.messages.every((m) => m.simulated === true));
  // Casablanca vs UTC: 00:30 local on 10-05 is 23:30 UTC on 10-04.
  const db3 = makeDb(); db3._add(mk("as1", 2, 0, 5, "late", "2026-10-05", "00:30", { text: "late night" }));
  const f3 = await feedOf(db3);
  ok("local date is Casablanca's, not UTC's (00:30 → same local day)", f3.messages[0].localDate === "2026-10-05" && f3.messages[0].localTime === "00:30" && f3.messages[0].scheduledAt.startsWith("2026-10-04T23:30"));
  const db4 = makeDb(); db4._add(mk("as1", 2, 0, 12, "edge", "2026-10-12", "10:00", { text: "exactly now" })); db4._add(mk("as1", 2, 0, 12, "edge2", "2026-10-12", "10:01", { text: "one minute later" }));
  const f4 = await feedOf(db4);
  ok("scheduledAt === now shown; now + 1 min hidden", f4.messages.map((m) => m.text).join() === "exactly now");
  // Truncation keeps the newest.
  const db5 = makeDb();
  for (let i = 0; i < F.FEED_MAX_MESSAGES + 5; i++) db5._add(mk("as1", 2, 0, 1 + Math.floor(i / 60), `t${String(i).padStart(3, "0")}`, `2026-10-${String(1 + Math.floor(i / 60)).padStart(2, "0")}`, `${String(Math.floor((i % 60) / 6) + 8).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}`, { text: `n${i}` }));
  const f5 = await feedOf(db5);
  ok(`bounded to the newest ${F.FEED_MAX_MESSAGES} messages, flagged truncated`, f5.messages.length === F.FEED_MAX_MESSAGES && f5.truncated && f5.messages.at(-1).text === `n${F.FEED_MAX_MESSAGES + 4}`);
}

// ── 6. Media rendering ────────────────────────────────────────────────────────
console.log("\n6. Media (image / audio)");
{
  const db = makeDb(); seed(db);
  const feed = await feedOf(db);
  const img = feed.messages.find((m) => m.text === "Ma vitrine");
  ok("image: url, mime, dimensions, caption", img.state === "ok" && img.media.kind === "image" && img.media.url === "/uploads/demo-chat/a.webp" && img.media.width === 640 && img.media.height === 480);
  const aud = feed.messages.find((m) => m.type === "audio");
  ok("audio: url, mime, duration", aud.state === "ok" && aud.media.kind === "audio" && aud.media.url === "https://cdn.example.com/v.m4a" && aud.media.durationSec === 12.5);
  ok("asset private fields never exposed (storageKey, sha256, uploader)", !/SECRET-KEY|sha256|storageKey|createdBy/.test(JSON.stringify(feed)));
  const bad = feed.messages.filter((m) => m.type === "image" && m.state === "media_unavailable");
  ok("unsafe URL (data:/javascript:) dropped → media_unavailable", bad.length === 2 && bad.every((m) => m.media === null));
  ok("asset kind ≠ message type → media_unavailable", bad.length === 2);
  ok("avatar with unsafe URL dropped (falls back to initials)", feed.profiles.find((p) => p.name === "Youssef").avatarUrl === null);
  ok("safeMediaUrl: protocol-relative / javascript / data rejected", [F.safeMediaUrl("//evil.com/x"), F.safeMediaUrl("javascript:x"), F.safeMediaUrl("data:x"), F.safeMediaUrl("")].every((x) => x === null) && F.safeMediaUrl("/a.png") === "/a.png");
  const vImg = V.messageView(img, "fr"), vAud = V.messageView(aud, "ar"), vBad = V.messageView(bad[0], "fr");
  ok("view: image → kind image with media + caption", vImg.kind === "image" && vImg.media.url === img.media.url && vImg.caption === "Ma vitrine");
  ok("view: audio → kind audio with media", vAud.kind === "audio" && vAud.media.url === aud.media.url && vAud.label === "رسالة صوتية");
  ok("view: missing media → notice, no url", vBad.media === null && vBad.notice === "Fichier indisponible.");
  ok("view: media kind mismatch rejected client-side too", V.messageView({ type: "image", media: { kind: "audio", url: "/x" } }, "fr").media === null);
  ok("view: unknown type → not rendered", V.messageView({ type: "html", text: "<b>x</b>" }, "fr").kind === "unknown");
  const ui = src("src/components/DemoMiniChat.jsx");
  ok("UI: <img loading=lazy>, <audio controls preload=none>, no dangerouslySetInnerHTML", /<img data-mini-chat-image[\s\S]*loading="lazy"/.test(ui) && /<audio data-mini-chat-audio controls preload="none"/.test(ui) && !/dangerouslySetInnerHTML/.test(ui));
}

// ── 7. Immutable earnings snapshots ───────────────────────────────────────────
console.log("\n7. Stored earnings snapshots — never recalculated, never invented");
{
  const db = makeDb(); seed(db);
  const feed = await feedOf(db);
  const e = feed.messages.find((m) => m.earningsPeriod === "yesterday");
  ok("complete snapshot rendered server-side from the stored values", e.state === "ok" && e.text.includes("12,50") && e.text.includes("درهم"));
  const later = await F.getMiniChatFeed({ now: at("2026-10-25", "23:00"), env: ENV_ON, db });
  ok("same text on a later day (snapshot, not re-resolved)", later.messages.find((m) => m.earningsPeriod === "yesterday").text === e.text);
  ok("feed never reads demo history / coverage (blocked tables; no conversation skipped)", skipped.length === 0);
  const u = feed.messages.find((m) => m.earningsPeriod === "week");
  ok("unavailable snapshot → 'unavailable' sentence, no amount, no zero", u.state === "unavailable" && !/\d/.test(u.text) && u.metricLabel === null);
  // Corrupted / missing snapshots.
  const s = at("2026-10-02", "12:30");
  const db2 = makeDb();
  db2._add(mk("as1", 2, 0, 2, "x-nan", "2026-10-02", "12:30", { type: "earnings", text: "{amount}", earningsPeriod: "yesterday", metric: "commission", earningsSnapshot: { ...snap({ period: "yesterday", status: "complete", orders: 1, revenue: 10, commission: 0.5 }, s), values: { orders: 1, revenue: 10, commission: "NaN" } } }));
  db2._add(mk("as1", 2, 0, 2, "x-neg", "2026-10-02", "12:31", { type: "earnings", text: "{amount}", earningsPeriod: "yesterday", metric: "commission", earningsSnapshot: { ...snap({ period: "yesterday", status: "complete", orders: 1, revenue: 10, commission: 0.5 }, s), values: { orders: 1, revenue: 10, commission: -5 } } }));
  db2._add(mk("as1", 2, 0, 2, "x-null", "2026-10-02", "12:32", { type: "earnings", text: "{amount}", earningsPeriod: "yesterday", metric: "commission", earningsSnapshot: null }));
  db2._add(mk("as1", 2, 0, 2, "x-badstatus", "2026-10-02", "12:33", { type: "earnings", text: "{amount}", earningsPeriod: "yesterday", metric: "commission", earningsSnapshot: { ...snap({ period: "yesterday", status: "complete", orders: 1, revenue: 10, commission: 0.5 }, s), status: "incomplete" } }));
  db2._add(mk("as1", 2, 0, 2, "x-v2", "2026-10-02", "12:34", { type: "earnings", text: "{amount}", earningsPeriod: "yesterday", metric: "commission", earningsSnapshot: { ...snap({ period: "yesterday", status: "complete", orders: 1, revenue: 10, commission: 0.5 }, s), v: 99 } }));
  const f2 = await feedOf(db2);
  ok("corrupt (NaN / negative), missing, inconsistent status or unknown version → unavailable, no number", f2.messages.length === 5 && f2.messages.every((m) => m.state === "unavailable" && !/\d/.test(m.text)));
  const p = at("2026-10-12", "12:30");
  const db3 = makeDb();
  db3._add(mk("as1", 2, 0, 12, "x-prov", "2026-10-12", "12:30", { type: "earnings", text: "{amount} {period}", earningsPeriod: "today", metric: "commission", earningsSnapshot: snap({ period: "today", status: "provisional", orders: 2, revenue: 100, commission: 5 }, p) }));
  const f3 = await F.getMiniChatFeed({ now: at("2026-10-12", "13:00"), locale: "fr", env: ENV_ON, db: db3 });
  ok("provisional snapshot → marked provisional (fr locale)", f3.messages[0].state === "provisional" && f3.messages[0].text.includes("5,00") && f3.messages[0].text.includes("MAD") && f3.messages[0].text.includes("(provisoire)"));
  // Client view never invents.
  const vu = V.messageView({ type: "earnings", state: "unavailable", text: "0,00 MAD" }, "fr");
  ok("view: unavailable ignores any server text (even '0,00') → fixed sentence", vu.available === false && vu.text === "Données indisponibles pour cette période." && !/\d/.test(vu.text));
  ok("view: unknown state → unavailable", V.messageView({ type: "earnings", state: "weird", text: "99 MAD" }, "ar").available === false);
  const va = V.messageView({ type: "earnings", state: "ok", text: "12,50 MAD hier", metricLabel: "commission" }, "fr");
  ok("view: available earnings text passed through verbatim", va.available && va.text === "12,50 MAD hier");
  const viewSrc = src("src/lib/demoMiniChatView.js") + src("src/components/DemoMiniChat.jsx");
  ok("client code has no amount formatting / arithmetic on earnings", !/NumberFormat\([^)]*currency|toFixed|commission\s*\*|revenue\s*\*|resolvePeriod|renderEarningsText/.test(viewSrc));
}

// ── 8. UI helpers, states and wiring ──────────────────────────────────────────
console.log("\n8. UI states, labels and integration");
{
  ok("status mapping: 200 ready; 401/403/404 disabled; others error", V.feedStatus(200) === "ready" && ["401", "403", "404"].every((s) => V.feedStatus(+s) === "disabled") && [0, 429, 500, 502].every((s) => V.feedStatus(s) === "error"));
  ok("day labels: today / yesterday from the server's Casablanca date", V.dayLabel("2026-10-12", "2026-10-12", "fr") === "Aujourd'hui" && V.dayLabel("2026-10-11", "2026-10-12", "ar") === "البارح");
  ok("day label across a month boundary", V.dayLabel("2026-09-30", "2026-10-01", "fr") === "Hier");
  ok("older day label is the calendar date itself (no tz shift)", V.dayLabel("2026-10-05", "2026-10-12", "fr") === "5 octobre 2026");
  ok("invalid date / time strings are not rendered", V.dayLabel("x", "2026-10-12", "fr") === "" && V.messageView({ type: "text", localTime: "25:99", text: "a" }, "fr").time === "");
  const groups = V.groupByDay([{ localDate: "2026-10-01" }, { localDate: "2026-10-01" }, { localDate: "2026-10-02" }]);
  ok("groupByDay keeps server order and splits per Casablanca day", groups.length === 2 && groups[0].items.length === 2);
  ok("RTL for Arabic, LTR for French", V.miniChatDir("ar") === "rtl" && V.miniChatDir("fr") === "ltr" && V.miniChatDir(undefined) === "rtl");
  ok("both languages define every label", Object.keys(V.MINI_CHAT_T.ar).every((k) => typeof V.MINI_CHAT_T.fr[k] === "string"));
  const ui = src("src/components/DemoMiniChat.jsx");
  ok("UI: loading, empty, error (+retry), disabled (render nothing) states", /aria-busy="true"/.test(ui) && /t\.empty/.test(ui) && /t\.retry/.test(ui) && /state === "disabled"\) return null/.test(ui));
  ok("UI: permanent simulation disclosure independent of payload", /data-mini-chat-disclosure[\s\S]*t\.disclosure/.test(ui));
  ok("UI: fetches only /api/affiliate/demo-chat?lang=… — no ids sent", /fetch\(`\/api\/affiliate\/demo-chat\?lang=\$\{L\}`/.test(ui) && !/profileId|assignmentId|demoAffiliateId/.test(ui));
  ok("UI: no client re-sort, no Date-based time formatting of messages", !/\.sort\(/.test(ui) && !/toLocale(Time|Date)?String/.test(ui));
  ok("UI: responsive (max-w %, scroll container, mobile-first padding)", /max-w-\[85%\] sm:max-w-\[75%\]/.test(ui) && /overflow-y-auto/.test(ui) && /p-4 sm:p-6/.test(ui));
  const dash = src("src/app/affiliate/dashboard/page.jsx");
  ok("dashboard: Mini Chat placed directly above Live Activity", /<DemoMiniChat \/>\s*\n\s*\{\/\* 🔥 النشاط المباشر[\s\S]{0,200}<LiveActivity windowSize=\{4\} showViewAll \/>/.test(dash));
  ok("not on the public homepage (affiliate auth required)", !/DemoMiniChat/.test(src("src/app/page.jsx")));
}

// ── 9. Isolation ──────────────────────────────────────────────────────────────
console.log("\n9. Isolation from real money / orders / messaging");
{
  const files = ["src/lib/services/demoChatFeedService.js", "src/lib/demoChatFeedRoute.js", "src/lib/demoMiniChatView.js", "src/components/DemoMiniChat.jsx", "src/app/api/affiliate/demo-chat/route.js"];
  const all = files.map(src).join("\n");
  ok("imports no order / commission / payout / notification / WhatsApp / UGC / rewards / fake-order code",
    !/from ['"][^'"]*(order|commission|payout|withdraw|deposit|booster|notification|whatsapp|ugc|reward|fakeOrder|affiliateSystem)[^'"]*['"]/i.test(all));
  const fs = src("src/lib/services/demoChatFeedService.js"), rs = src("src/lib/demoChatFeedRoute.js");
  ok("service is read only by default (materialize = false)", /materialize = false/.test(fs));
  ok("only the route enables materialization, after gates + active check", rs.indexOf("materialize: true") > rs.indexOf("AFFILIATE_INACTIVE") && rs.indexOf("AFFILIATE_INACTIVE") > rs.indexOf("readDemoChatGates(demoDb"));
  ok("no scheduler / bulk materialization in this phase", !/materializeDue|setInterval|setTimeout|cron/i.test(fs + rs));
  ok("no viewer-state write in this phase", !/demoChatViewerState/.test(all));
}

// ── 10. Lazy materialization on feed access ─────────────────────────────────
console.log("\n10. Lazy materialization (Phase 3C-6 service, on authenticated feed access)");
ok("sections 1–9: materialization ran without error (nothing due)", matFails.length === 0);
{
  const STEPS_P1 = [
    { id: "w1", day: 1, time: "09:00", position: 0, type: "text", text: "Bienvenue", earningsPeriod: null, metric: null, assetId: null },
    { id: "w2", day: 2, time: "18:00", position: 0, type: "image", text: "Vitrine", earningsPeriod: null, metric: null, assetId: "img1" },
    { id: "w3", day: 12, time: "09:59", position: 0, type: "audio", text: null, earningsPeriod: null, metric: null, assetId: "aud1" },
    { id: "w4", day: 12, time: "10:01", position: 0, type: "text", text: "FUTURE", earningsPeriod: null, metric: null, assetId: null },
    { id: "w5", day: 25, time: "08:00", position: 0, type: "text", text: "FAR FUTURE", earningsPeriod: null, metric: null, assetId: null },
  ];
  const STEPS_P2 = [{ id: "y1", day: 1, time: "08:00", position: 0, type: "text", text: "Salam", earningsPeriod: null, metric: null, assetId: null }];
  const STEPS_HIDDEN = [{ id: "z1", day: 1, time: "08:00", position: 0, type: "text", text: "MUST NOT EXIST", earningsPeriod: null, metric: null, assetId: null }];
  const fresh = (o = {}) => makeDb({ steps: { v1: STEPS_P1, v2: STEPS_P2, v3: STEPS_HIDDEN, v4: STEPS_HIDDEN }, ...o });
  const tok = tokenFor("aff-1");
  // as1 revision 2 / anchor 10-01; as2 anchor 10-10 (day 3 at NOW).

  let db = fresh(); let h = handlerFor(db);
  const r1 = await call(h, { token: tok });
  const texts = r1.body.messages.map((m) => m.text);
  ok("first feed access creates the due messages and returns them", r1.status === 200 && texts.includes("Bienvenue") && texts.includes("Vitrine") && texts.includes("Salam") && r1.body.messages.some((m) => m.type === "audio" && m.state === "ok"));
  ok("future steps never created (10:01 and day 25)", !db._t.messages.some((m) => m.stepId === "w4" || m.stepId === "w5") && !texts.includes("FUTURE"));
  ok("rows keep the original Casablanca instants", db._t.messages.find((m) => m.stepId === "w1").scheduledAt.getTime() === at("2026-10-01", "09:00") && db._t.messages.find((m) => m.stepId === "w3").scheduledAt.getTime() === at("2026-10-12", "09:59"));
  ok("rows carry the assignment's current revision", db._t.messages.filter((m) => m.assignmentId === "as1").every((m) => m.revision === 2 && m.loopIndex === 0));
  ok("inactive profile / disabled assignment never materialized", !db._t.messages.some((m) => m.assignmentId === "as3" || m.assignmentId === "as4"));
  ok("one SYSTEM audit row per conversation that got new messages", db._t.audit.length === 2 && db._t.audit.every((a) => a.action === "MESSAGES_MATERIALIZE" && a.actorType === "SYSTEM"));
  const rows1 = db._t.messages.length;
  const r2 = await call(h, { token: tokenFor("aff-2") });
  ok("second access (another affiliate) → nothing new, same feed", db._t.messages.length === rows1 && db._t.audit.length === 2 && JSON.stringify(r2.body.messages) === JSON.stringify(r1.body.messages));
  ok("only insert-or-ignore was used (skipDuplicates), no other write", db._calls.writes === 0);

  db = fresh(); h = handlerFor(db);
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => call(h, { token: tokenFor(i % 2 ? "aff-1" : "aff-2") })));
  const keys = db._t.messages.map((m) => `${m.assignmentId}|${m.revision}|${m.loopIndex}|${m.stepId}`);
  ok(`20 concurrent feed requests → each message exactly once (${db._t.messages.length} rows, ${db._calls.createMany} insert attempts)`,
    many.every((r) => r.status === 200) && db._t.messages.length === 4 && new Set(keys).size === keys.length && db._calls.createMany > 2);
  ok("concurrent responses agree once settled", (await call(h, { token: tok })).body.messages.length === 4);

  db = fresh(); h = handlerFor(db);
  db._t.messages.length = 0;
  await call(h, { token: tokenFor("aff-1") });
  const later = await withAffiliateAuth(demoChatFeedHandler({ db, demoDb: db, env: ENV_ON, now: () => at("2026-10-12", "10:05"), rateLimit: () => null }))(req(undefined, { authorization: `Bearer ${tok}` }), {}).then((r) => r.json());
  ok("a later access materializes only what became due since (10:01 step at 10:05)", later.messages.some((m) => m.text === "FUTURE") && db._t.messages.length === 5 && !db._t.messages.some((m) => m.stepId === "w5"));

  // No writes unless authenticated + active + gates on.
  for (const [label, run] of [
    ["unauthenticated", (d) => call(handlerFor(d))],
    ["inactive account", (d) => call(handlerFor(d), { token: tokenFor("aff-off") })],
    ["env gate off", (d) => call(handlerFor(d, { env: {} }), { token: tok })],
    ["rate limited", (d) => call(handlerFor(d, { rateLimit: () => new Response("{}", { status: 429 }) }), { token: tok })],
  ]) {
    const d = fresh(); await run(d);
    ok(`${label} → nothing materialized`, d._t.messages.length === 0 && d._calls.createMany === 0);
  }
  const dOff = fresh({ gateOn: false }); await call(handlerFor(dOff), { token: tok });
  ok("protected setting off → nothing materialized", dOff._t.messages.length === 0 && dOff._calls.createMany === 0);

  // Read-only service call (materialize defaults to false).
  const dRo = fresh(); await F.getMiniChatFeed({ now: NOW, env: ENV_ON, db: dRo });
  ok("service without the flag never materializes", dRo._t.messages.length === 0 && dRo._calls.createMany === 0);

  // Bounded: wall-clock budget exhausted → read only.
  let tick = 0; const dB = fresh();
  const fb = await F.getMiniChatFeed({ now: NOW, env: ENV_ON, db: dB, materialize: true, clock: () => (tick++ === 0 ? 0 : F.MATERIALIZE_BUDGET_MS + 1) });
  ok("time budget exhausted → no further materialization, stored messages still read", dB._t.messages.length === 0 && Array.isArray(fb.messages));
  ok("at most FEED_MAX_PROFILES conversations per request (query take)", /take: FEED_MAX_PROFILES/.test(src("src/lib/services/demoChatFeedService.js")) && F.FEED_MAX_PROFILES === 20);

  // Failure isolation.
  const dF = fresh(); dF._add(mk("as1", 2, 0, 1, "w1", "2026-10-01", "09:00", { text: "already stored" }));
  dF._calls.failInsert = true; const before = matFails.length;
  const rf = await call(handlerFor(dF), { token: tok });
  ok("materialization failure → logged, stored messages still served (200)", rf.status === 200 && rf.body.messages.some((m) => m.text === "already stored") && matFails.length > before);

  // Existing rows / snapshots never overwritten by lazy materialization.
  const dS = fresh(); dS._add(mk("as1", 2, 0, 1, "w1", "2026-10-01", "09:00", { text: "ORIGINAL TEXT" }));
  await call(handlerFor(dS), { token: tok });
  ok("an existing message is never overwritten", dS._t.messages.filter((m) => m.stepId === "w1").length === 1 && dS._t.messages.find((m) => m.stepId === "w1").text === "ORIGINAL TEXT");
}

ok("no conversation was silently skipped by an error anywhere in this run", skipped.length === 0);
{
  const db = makeDb(); seed(db);
  const orig = db.demoChatMessage.findMany;
  db.demoChatMessage.findMany = async (q) => { if (q.where.assignmentId === "as2") throw Object.assign(new Error("boom"), { code: "P1001" }); return orig(q); };
  const f = await feedOf(db);
  ok("one broken conversation is skipped (logged), the others still shown", skipped.length === 1 && f.profiles.length === 1 && f.profiles[0].name === "Salma" && f.messages.length > 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
