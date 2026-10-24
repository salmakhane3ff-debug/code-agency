#!/usr/bin/env node
/**
 * scripts/demoChat.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3C-2 — admin authoring of scripted DEMO chat journeys.
 * In-memory fake: demo_chat_* models + the reserved "demo-chat-config" settings
 * row only (anything else throws). It enforces the same unique keys, FK
 * RESTRICT/CASCADE and the append-only audit table as the real migration.
 * Proves:
 *   • validation mirrors the database CHECKs; placeholders {amount} {orders}
 *     {period} only; hand-typed amounts rejected in every step; media deferred
 *   • journeys / steps CRUD on drafts, archived = read-only, safe delete
 *   • optimistic concurrency (expectedUpdatedAt) and row locks
 *   • publish: immutable versions, deterministic hash, NO_CHANGES, concurrency
 *   • exactly one audit row per write, in the same transaction; P0001 mapping
 *   • preview writes nothing and labels sample values
 *   • both gates required, off by default; no route can enable the chat
 *   • admin-only routes; isolation from real orders/money/notifications
 * Run: node scripts/demoChat.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";

const V = await import("../src/lib/demoChatValidation.js");
const E = await import("../src/lib/demoChatErrors.js");
const G = await import("../src/lib/demoChatGate.js");
const demo = await import("../src/lib/services/demoService.js");
const svc = await import("../src/lib/services/demoChatService.js");
const { withAdminAuth } = await import("../src/lib/middleware/withAdminAuth.js");
const { signToken } = await import("../src/lib/services/authService.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rejects = (p) => p.then(() => null, (e) => e);
const T0 = Date.UTC(2026, 9, 24, 9, 0);
let clock = T0;
const at = () => (clock += 1000);
const ctx = (extra = {}) => ({ actorId: "admin-1", now: at(), ...extra });

// ── Fake DB ───────────────────────────────────────────────────────────────────
const P0001_ENGINE = (op) => Object.assign(new Error(
  `Invalid \`prisma.demoChatAuditLog.${op}()\` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "P0001", message: "demo_chat_audit_log is append-only (${op === "update" ? "UPDATE" : "DELETE"} rejected)", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`),
{ name: "PrismaClientUnknownRequestError", clientVersion: "6.19.3" });
const known = (code, msg = code) => Object.assign(new Error(msg), { code, name: "PrismaClientKnownRequestError" });

function makeDb() {
  let seq = 1;
  const nid = () => `id_${String(seq++).padStart(4, "0")}`;
  const t = { demoChatJourney: [], demoChatJourneyStep: [], demoChatJourneyVersion: [], demoChatVersionAsset: [], demoChatAuditLog: [], setting: [] };
  const writes = [];
  const fx = { failAuditOnce: false };
  const match = (row, where = {}) => Object.entries(where).every(([k, c]) => {
    const v = row[k];
    if (c && typeof c === "object" && !(c instanceof Date)) {
      if ("lt" in c) return v < c.lt;
      return false;
    }
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    return v === c;
  });
  const sortBy = (rows, orderBy) => {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((a, b) => {
      for (const o of list) { const [k, dir] = Object.entries(o)[0]; const x = a[k], y = b[k]; const c = x < y ? -1 : x > y ? 1 : 0; if (c) return dir === "desc" ? -c : c; }
      return 0;
    });
  };
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });
  const unique = {
    demoChatJourneyStep: (r) => ["journeyId", "day", "time", "position"].map((k) => r[k]).join("|"),
    demoChatJourneyVersion: (r) => `${r.journeyId}|${r.version}`,
    demoChatVersionAsset: (r) => `${r.versionId}|${r.assetId}`,
  };
  const checkUnique = (model, row, selfId) => {
    const key = unique[model]; if (!key) return;
    if (t[model].some((o) => o !== row && o.id !== selfId && key(o) === key(row))) throw known("P2002", `Unique constraint failed on ${model}`);
  };
  const model = (name) => ({
    findMany: async ({ where, orderBy, select, take } = {}) => { let r = sortBy(t[name].filter((x) => match(x, where)), orderBy); if (take) r = r.slice(0, take); return r.map((x) => pick(x, select)); },
    findUnique: async ({ where }) => { const r = t[name].find((x) => match(x, where)); return r ? { ...r } : null; },
    findFirst: async ({ where, orderBy } = {}) => { const r = sortBy(t[name].filter((x) => match(x, where)), orderBy)[0]; return r ? { ...r } : null; },
    count: async ({ where } = {}) => t[name].filter((x) => match(x, where)).length,
    create: async ({ data }) => {
      if (name === "demoChatAuditLog" && fx.failAuditOnce) { fx.failAuditOnce = false; throw new Error("audit insert failed (simulated)"); }
      const row = { id: data.id ?? nid(), ...data };
      if (name === "demoChatJourney") { row.status ??= "draft"; row.description ??= ""; row.createdAt ??= new Date(clock); row.updatedAt ??= new Date(clock); }
      if (name === "demoChatJourneyStep") { row.position ??= 0; }
      if (name === "demoChatJourneyVersion") { row.publishedAt ??= new Date(clock); row.steps = structuredClone(data.steps); }
      if (name === "demoChatAuditLog") { row.actorType ??= "ADMIN"; row.createdAt ??= new Date(clock); }
      if (name === "demoChatJourneyStep" && !t.demoChatJourney.some((j) => j.id === row.journeyId)) throw known("P2003");
      checkUnique(name, row);
      t[name].push(row); writes.push({ model: name, op: "create" }); return { ...row };
    },
    update: async ({ where, data }) => {
      if (name === "demoChatAuditLog") throw P0001_ENGINE("update");
      if (name === "demoChatJourneyVersion") throw new Error("TEST: versions must never be updated");
      const row = t[name].find((x) => match(x, where)); if (!row) throw known("P2025");
      const next = { ...row, ...data }; checkUnique(name, next, row.id); Object.assign(row, data);
      writes.push({ model: name, op: "update" }); return { ...row };
    },
    delete: async ({ where }) => {
      if (name === "demoChatAuditLog") throw P0001_ENGINE("delete");
      if (name === "demoChatJourneyVersion") throw new Error("TEST: versions must never be deleted");
      const i = t[name].findIndex((x) => match(x, where)); if (i < 0) throw known("P2025");
      const row = t[name][i];
      if (name === "demoChatJourney") {
        if (t.demoChatJourneyVersion.some((v) => v.journeyId === row.id)) throw known("P2003"); // RESTRICT
        t.demoChatJourneyStep = t.demoChatJourneyStep.filter((s) => s.journeyId !== row.id); // CASCADE
      }
      t[name].splice(i, 1); writes.push({ model: name, op: "delete" }); return { ...row };
    },
  });
  const models = Object.fromEntries(Object.keys(t).filter((k) => k !== "setting").map((k) => [k, model(k)]));
  models.setting = {
    findUnique: async ({ where }) => {
      if (where.id !== G.DEMO_CHAT_SETTING_ID) throw new Error(`TEST: forbidden settings row ${where.id}`);
      return t.setting.find((s) => s.id === where.id) || null;
    },
  };
  const guard = (o) => new Proxy(o, { get: (x, k) => { if (k in x || typeof k === "symbol" || k === "then") return x[k]; throw new Error(`TEST: forbidden model ${String(k)}`); } });
  const locks = new Map();
  const db = guard({
    ...models, _t: t, _writes: writes, _fx: fx,
    $transaction: async (fn) => {
      const held = [];
      let snapshot = structuredClone(t);
      const tx = guard({
        ...models,
        $queryRaw: async (strings, ...vals) => {
          const sql = strings.join("?");
          if (!/FROM "demo_chat_journeys"[\s\S]*FOR UPDATE/.test(sql)) throw new Error(`TEST: unexpected raw SQL ${sql}`);
          const id = vals[0];
          while (locks.has(id)) await locks.get(id).promise;
          let release; const promise = new Promise((r) => { release = r; });
          locks.set(id, { promise, release }); held.push(id);
          snapshot = structuredClone(t);
          await new Promise((r) => setImmediate(r));
          return t.demoChatJourney.filter((j) => j.id === id).map((j) => ({ id: j.id, status: j.status, updatedAt: j.updatedAt }));
        },
      });
      try { return await fn(tx); }
      catch (e) { for (const k of Object.keys(t)) t[k] = snapshot[k]; throw e; }
      finally { for (const id of held) { const l = locks.get(id); locks.delete(id); l.release(); } }
    },
  });
  return db;
}
const fresh = () => { const db = makeDb(); demo.__setDemoDb(db); return db; };
const auditCount = (db) => db._t.demoChatAuditLog.length;

// ── 1. Validation mirrors the database CHECKs ─────────────────────────────────
console.log("\n1. Validation (mirrors 20261023 CHECK constraints)");
{
  const base = { day: 5, time: "08:00", type: "text", text: "Bonjour" };
  const earn = { day: 5, time: "13:00", type: "earnings", text: "Bravo {amount} {period}", earningsPeriod: "week", metric: "commission" };
  const cases = [
    ["valid text step day 30 23:59", { ...base, day: 30, time: "23:59" }, true],
    ["day 0", { ...base, day: 0 }, false], ["day 31", { ...base, day: 31 }, false],
    ["time 24:00", { ...base, time: "24:00" }, false], ["time 9:00", { ...base, time: "9:00" }, false], ["time 08:60", { ...base, time: "08:60" }, false],
    ["position -1", { ...base, position: -1 }, false], ["type video", { ...base, type: "video" }, false],
    ["metric profit", { ...earn, metric: "profit" }, false], ["period month", { ...earn, earningsPeriod: "month" }, false],
    ["earnings valid (yesterday/revenue 08:00)", { ...earn, time: "08:00", earningsPeriod: "yesterday", metric: "revenue" }, true],
    ["earnings without period", { ...earn, earningsPeriod: undefined }, false], ["earnings without metric", { ...earn, metric: undefined }, false],
    ["text step with period+metric", { ...base, earningsPeriod: "week", metric: "orders" }, false], ["text step with metric only", { ...base, metric: "orders" }, false],
    ["text NULL", { ...base, text: null }, false], ["text empty", { ...base, text: "" }, false], ["text whitespace", { ...base, text: "   " }, false],
    ["earnings blank text", { ...earn, text: " " }, false],
    ["today summary at 11:59", { ...earn, time: "11:59", earningsPeriod: "today" }, false],
    ["today summary at 12:00", { ...earn, time: "12:00", earningsPeriod: "today" }, true],
  ];
  for (const [name, input, expected] of cases) ok(`${name} → ${expected ? "accepted" : "rejected"}`, V.validateStepInput(input).ok === expected);
  ok("image / audio deferred to 3C-3", ["image", "audio"].every((type) => V.validateStepInput({ ...base, type }).error === V.MEDIA_DEFERRED_MSG));
  ok("ids, journeyId, assetId cannot be set", ["id", "journeyId", "assetId"].every((k) => V.validateStepInput({ ...base, [k]: "x" }).field === k));
  ok("text over 1000 chars rejected", !V.validateStepInput({ ...base, text: "a".repeat(1001) }).ok);
  ok("journey name 2..80, description ≤ 500, unknown fields rejected",
    !V.validateJourneyInput({ name: "A" }).ok && V.validateJourneyInput({ name: "  Mon   parcours " }).value.name === "Mon parcours"
    && !V.validateJourneyInput({ name: "Ok", description: "x".repeat(501) }).ok && V.validateJourneyInput({ status: "archived" }, { partial: true }).field === "status");
}

// ── 2. Placeholders and hand-typed amounts ────────────────────────────────────
console.log("\n2. Placeholders {amount} {orders} {period}; no hand-typed amounts");
{
  const earn = (text, metric = "commission") => V.validateStepInput({ day: 2, time: "13:00", type: "earnings", text, earningsPeriod: "week", metric });
  const text = (t) => V.validateStepInput({ day: 2, time: "09:00", type: "text", text: t });
  ok("earnings with {amount} {period} accepted", earn("Bravo ! {amount} de commission {period}").ok);
  ok("orders metric requires {orders}", !earn("Bravo {amount}", "orders").ok && earn("{orders} commandes livrées {period}", "orders").ok);
  ok("commission / revenue metric requires {amount}", !earn("Bravo {orders}").ok && !earn("Bravo {orders}", "revenue").ok);
  ok("unknown placeholder rejected ({name}, {balance}, {AMOUNT})", ["{name}", "{balance}", "{AMOUNT}"].every((p) => !earn(`Bravo {amount} ${p}`).ok));
  ok("stray brace rejected", !earn("Bravo {amount} }").ok && !earn("Bravo {amount {period}").ok);
  ok("text steps carry no placeholders", !text("Salut {amount}").ok && !text("Salut {period}").ok);
  const typed = ["Bravo 250 MAD", "1 200,50 dh aujourd'hui", "MAD 300", "١٥٠ درهم", "gagné 99dhs", "300 dirhams", "12 commandes", "5 طلبات", "€40", "40 €", "7 orders"];
  ok("hand-typed amounts / counts rejected in text steps", typed.every((s) => !text(s).ok));
  ok("hand-typed amounts rejected in earnings steps too", typed.every((s) => !earn(`{amount} ${s}`).ok));
  ok("ordinary numbers and times allowed (Jour 3, 12:00, 2 conseils)", text("Jour 3 : rendez-vous à 12:00, voici 2 conseils").ok && text("Top 10 des astuces").ok);
  ok("hasHandTypedAmount helper", V.hasHandTypedAmount("ربحت 200 درهم") && !V.hasHandTypedAmount("Bonne journée"));
  ok("preview fills placeholders with labelled samples only",
    V.renderPreviewText({ type: "earnings", text: "{amount} / {orders} {period}", earningsPeriod: "yesterday" }) === `${V.PREVIEW_SAMPLE.amount} / ${V.PREVIEW_SAMPLE.orders} hier`
    && V.renderPreviewText({ type: "text", text: "Salut" }) === "Salut");
}

// ── 3. Journeys ───────────────────────────────────────────────────────────────
console.log("\n3. Journeys: create / edit / archive / delete / concurrency");
let db = fresh();
let J;
{
  const a0 = auditCount(db);
  J = await svc.createJourney({ name: "Parcours A", description: "30 jours" }, ctx());
  ok("create → draft, audit JOURNEY_CREATE with actor", J.journey.status === "draft" && auditCount(db) === a0 + 1
    && db._t.demoChatAuditLog.at(-1).action === "JOURNEY_CREATE" && db._t.demoChatAuditLog.at(-1).actorId === "admin-1" && J.journey.createdBy === "admin-1");
  ok("invalid create → 400, nothing written", (await rejects(svc.createJourney({ name: "x" }, ctx()))).status === 400 && db._t.demoChatJourney.length === 1);
  const tok = J.journey.updatedAt;
  ok("write without expectedUpdatedAt → 400", (await rejects(svc.updateJourney(J.journey.id, { name: "B" }, ctx()))).code === "VALIDATION");
  J = await svc.updateJourney(J.journey.id, { expectedUpdatedAt: tok, name: "Parcours A2" }, ctx());
  ok("rename persisted, audit before/after", J.journey.name === "Parcours A2" && db._t.demoChatAuditLog.at(-1).before.name === "Parcours A" && db._t.demoChatAuditLog.at(-1).after.name === "Parcours A2");
  const stale = await rejects(svc.updateJourney(J.journey.id, { expectedUpdatedAt: tok, name: "Parcours A3" }, ctx()));
  ok("stale token → 409 STALE, nothing written", stale.status === 409 && stale.code === "STALE" && db._t.demoChatJourney[0].name === "Parcours A2");
  ok("no-op edit → 409 NO_CHANGES", (await rejects(svc.updateJourney(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt, name: "Parcours A2" }, ctx()))).code === "NO_CHANGES");
  ok("status cannot be PATCHed as a field", (await rejects(svc.updateJourney(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt, status: "archived" }, ctx()))).field === "status");
  ok("unknown / invalid id → 404", (await rejects(svc.getJourney("../etc"))).status === 404 && (await rejects(svc.getJourney("nope"))).status === 404);

  const arch = await svc.updateJourney(J.journey.id, { expectedUpdatedAt: J.journey.updatedAt, action: "archive" }, ctx());
  ok("archive → archived + audit", arch.journey.status === "archived" && db._t.demoChatAuditLog.at(-1).action === "JOURNEY_ARCHIVE");
  ok("archived journey is read-only (edit, add step, publish)",
    (await rejects(svc.updateJourney(J.journey.id, { expectedUpdatedAt: arch.journey.updatedAt, name: "Zzz" }, ctx()))).code === "ARCHIVED"
    && (await rejects(svc.createStep(J.journey.id, { expectedUpdatedAt: arch.journey.updatedAt, day: 1, time: "09:00", type: "text", text: "Salut" }, ctx()))).code === "ARCHIVED"
    && (await rejects(svc.publishJourney(J.journey.id, { expectedUpdatedAt: arch.journey.updatedAt }, ctx()))).code === "ARCHIVED");
  J = await svc.updateJourney(J.journey.id, { expectedUpdatedAt: arch.journey.updatedAt, action: "unarchive" }, ctx());
  ok("unarchive → draft + audit", J.journey.status === "draft" && db._t.demoChatAuditLog.at(-1).action === "JOURNEY_UNARCHIVE");

  const D = await svc.createJourney({ name: "Brouillon jetable" }, ctx());
  const D2 = await svc.createStep(D.journey.id, { expectedUpdatedAt: D.journey.updatedAt, day: 1, time: "09:00", type: "text", text: "Salut" }, ctx());
  const del = await svc.deleteJourney(D.journey.id, { expectedUpdatedAt: D2.journey.updatedAt }, ctx());
  ok("never-published draft deletes; its steps cascade; audit JOURNEY_DELETE",
    del.deleted && !db._t.demoChatJourney.some((j) => j.id === D.journey.id) && !db._t.demoChatJourneyStep.some((s) => s.journeyId === D.journey.id)
    && db._t.demoChatAuditLog.at(-1).action === "JOURNEY_DELETE" && db._t.demoChatAuditLog.at(-1).before.stepCount === 1);
}

// ── 4. Steps ──────────────────────────────────────────────────────────────────
console.log("\n4. Steps on drafts");
{
  const id = J.journey.id;
  const a0 = auditCount(db);
  let r = await svc.createStep(id, { expectedUpdatedAt: J.journey.updatedAt, day: 1, time: "09:00", type: "text", text: "Bienvenue !" }, ctx());
  ok("create step → stored, journey token bumped, audit STEP_CREATE", r.steps.length === 1 && r.journey.updatedAt !== J.journey.updatedAt && auditCount(db) === a0 + 1 && db._t.demoChatAuditLog.at(-1).action === "STEP_CREATE");
  const s1 = r.steps[0];
  const clash = await rejects(svc.createStep(id, { expectedUpdatedAt: r.journey.updatedAt, day: 1, time: "09:00", type: "text", text: "Doublon" }, ctx()));
  ok("same day/time/position → 409 SLOT_TAKEN, nothing written", clash.code === "SLOT_TAKEN" && db._t.demoChatJourneyStep.filter((s) => s.journeyId === id).length === 1);
  r = await svc.createStep(id, { expectedUpdatedAt: r.journey.updatedAt, day: 1, time: "09:00", position: 1, type: "text", text: "Deuxième message" }, ctx());
  r = await svc.createStep(id, { expectedUpdatedAt: r.journey.updatedAt, day: 2, time: "12:30", type: "earnings", text: "Bravo {amount} {period}", earningsPeriod: "today", metric: "commission" }, ctx());
  ok("steps ordered by day, time, position", r.steps.map((s) => `${s.day}-${s.time}-${s.position}`).join(",") === "1-09:00-0,1-09:00-1,2-12:30-0");
  ok("media step via API → 400 (deferred)", (await rejects(svc.createStep(id, { expectedUpdatedAt: r.journey.updatedAt, day: 3, time: "09:00", type: "image", text: "x" }, ctx()))).field === "type");
  ok("hand-typed amount via API → 400", (await rejects(svc.createStep(id, { expectedUpdatedAt: r.journey.updatedAt, day: 3, time: "09:00", type: "text", text: "J'ai gagné 500 MAD" }, ctx()))).field === "text");
  ok("assetId cannot be injected", (await rejects(svc.createStep(id, { expectedUpdatedAt: r.journey.updatedAt, day: 3, time: "09:00", type: "text", text: "x", assetId: "a1" }, ctx()))).field === "assetId");

  const before = r.journey.updatedAt;
  r = await svc.updateStep(id, s1.id, { expectedUpdatedAt: before, text: "Bienvenue dans le défi !" }, ctx());
  ok("edit step re-validates whole row; audit before/after", r.steps.find((s) => s.id === s1.id).text === "Bienvenue dans le défi !" && db._t.demoChatAuditLog.at(-1).before.text === "Bienvenue !");
  const earnStep = r.steps.find((s) => s.type === "earnings");
  ok("switching earnings → text clears period/metric", (await svc.updateStep(id, earnStep.id, { expectedUpdatedAt: r.journey.updatedAt, type: "text", text: "Pause du jour" }, ctx())).steps.find((s) => s.id === earnStep.id).metric === null);
  r = await svc.getJourney(id);
  ok("edit to an occupied slot → 409", (await rejects(svc.updateStep(id, s1.id, { expectedUpdatedAt: r.journey.updatedAt, position: 1 }, ctx()))).code === "SLOT_TAKEN");
  ok("edit with stale token → 409", (await rejects(svc.updateStep(id, s1.id, { expectedUpdatedAt: before, text: "Zut" }, ctx()))).code === "STALE");
  ok("step of another journey → 404", (await rejects(svc.updateStep(id, "id_9999", { expectedUpdatedAt: r.journey.updatedAt, text: "x" }, ctx()))).status === 404);

  const [p0, p1] = r.steps.filter((s) => s.day === 1);
  r = await svc.reorderSteps(id, { expectedUpdatedAt: r.journey.updatedAt, steps: [{ id: p0.id, position: 1 }, { id: p1.id, position: 0 }] }, ctx());
  ok("reorder swaps positions in one transaction (no transient duplicate) + audit", r.steps.filter((s) => s.day === 1)[0].id === p1.id && db._t.demoChatAuditLog.at(-1).action === "STEPS_REORDER");
  ok("reorder into a collision → 409, unchanged", (await rejects(svc.reorderSteps(id, { expectedUpdatedAt: r.journey.updatedAt, steps: [{ id: p0.id, position: 0 }] }, ctx()))).code === "SLOT_TAKEN"
    && db._t.demoChatJourneyStep.find((s) => s.id === p0.id).position === 1);

  const tmp = await svc.createStep(id, { expectedUpdatedAt: r.journey.updatedAt, day: 9, time: "10:00", type: "text", text: "À supprimer" }, ctx());
  const tmpId = tmp.steps.find((s) => s.day === 9).id;
  r = await svc.deleteStep(id, tmpId, { expectedUpdatedAt: tmp.journey.updatedAt }, ctx());
  ok("delete step + audit (before snapshot)", !r.steps.some((s) => s.id === tmpId) && db._t.demoChatAuditLog.at(-1).action === "STEP_DELETE" && db._t.demoChatAuditLog.at(-1).before.text === "À supprimer");
  J = r;
}

// ── 5. Publish & versions ─────────────────────────────────────────────────────
console.log("\n5. Publish: immutable versions");
{
  const id = J.journey.id;
  const pub = await svc.publishJourney(id, { expectedUpdatedAt: J.journey.updatedAt }, ctx());
  ok("publish → version 1 + audit VERSION_PUBLISH", pub.version.version === 1 && db._t.demoChatAuditLog.at(-1).action === "VERSION_PUBLISH" && db._t.demoChatAuditLog.at(-1).after.version === 1);
  const v1 = db._t.demoChatJourneyVersion[0];
  ok("version freezes canonical steps with stable step ids", Array.isArray(v1.steps) && v1.steps.length === J.steps.length && v1.steps.every((s) => J.steps.some((d) => d.id === s.id)));
  ok("hash = sha256 of canonical steps (deterministic)", v1.stepsHash === svc.hashSteps(V.canonicalSteps(db._t.demoChatJourneyStep.filter((s) => s.journeyId === id))));
  ok("unchanged draft → 409 NO_CHANGES", (await rejects(svc.publishJourney(id, { expectedUpdatedAt: pub.journey.updatedAt }, ctx()))).code === "NO_CHANGES");
  ok("hasUnpublishedChanges false right after publish", pub.hasUnpublishedChanges === false);

  const edited = await svc.updateStep(id, J.steps[0].id, { expectedUpdatedAt: pub.journey.updatedAt, text: "Texte modifié après publication" }, ctx());
  ok("editing the draft leaves version 1 untouched", db._t.demoChatJourneyVersion[0].steps.find((s) => s.id === J.steps[0].id).text !== "Texte modifié après publication" && edited.hasUnpublishedChanges);
  const pub2 = await svc.publishJourney(id, { expectedUpdatedAt: edited.journey.updatedAt }, ctx());
  ok("next publish → version 2", pub2.version.version === 2 && pub2.versions.map((v) => v.version).join(",") === "2,1");
  ok("version read-only API (get) and 404 across journeys",
    (await svc.getVersion(id, pub2.version.id)).version.version === 2 && (await rejects(svc.getVersion("other_journey", pub2.version.id))).status === 404);
  ok("published journey cannot be deleted → 409 REFERENCED", (await rejects(svc.deleteJourney(id, { expectedUpdatedAt: pub2.journey.updatedAt }, ctx()))).code === "REFERENCED");

  const E0 = await svc.createJourney({ name: "Vide" }, ctx());
  ok("empty journey cannot be published", (await rejects(svc.publishJourney(E0.journey.id, { expectedUpdatedAt: E0.journey.updatedAt }, ctx()))).field === "steps");

  // Concurrent publishes with the same token: one wins, the other is STALE / NO_CHANGES.
  const C = await svc.createJourney({ name: "Concurrence" }, ctx());
  const C1 = await svc.createStep(C.journey.id, { expectedUpdatedAt: C.journey.updatedAt, day: 1, time: "09:00", type: "text", text: "Salut" }, ctx());
  const res = await Promise.allSettled([1, 2].map(() => svc.publishJourney(C.journey.id, { expectedUpdatedAt: C1.journey.updatedAt }, ctx())));
  ok("two concurrent publishes → exactly one version", db._t.demoChatJourneyVersion.filter((v) => v.journeyId === C.journey.id).length === 1
    && res.filter((x) => x.status === "fulfilled").length === 1 && res.some((x) => x.status === "rejected" && x.reason.status === 409));
  ok("no service export can update or delete a version", !Object.keys(svc).some((k) => /^(update|delete|edit|remove)Version/i.test(k)));
}

// ── 6. Audit: atomic, insert-only, P0001 mapping ──────────────────────────────
console.log("\n6. Audit log");
{
  const before = db._t.demoChatJourney.length;
  db._fx.failAuditOnce = true;
  const e = await rejects(svc.createJourney({ name: "Rollback test" }, ctx()));
  ok("audit insert failure rolls back the write (same transaction)", e && db._t.demoChatJourney.length === before && !db._t.demoChatJourney.some((j) => j.name === "Rollback test"));
  const perWrite = db._t.demoChatAuditLog.length;
  const W = await svc.createJourney({ name: "Compte d'audit" }, ctx());
  await svc.createStep(W.journey.id, { expectedUpdatedAt: W.journey.updatedAt, day: 1, time: "09:00", type: "text", text: "Salut" }, ctx());
  ok("exactly one audit row per write", db._t.demoChatAuditLog.length === perWrite + 2);
  ok("audit rows never updated or deleted by the service", !db._writes.some((w) => w.model === "demoChatAuditLog" && w.op !== "create"));

  const engine = P0001_ENGINE("update");
  const raw = Object.assign(new Error("Raw query failed. Code: `P0001`. Message: `demo_chat_audit_log is append-only (TRUNCATE rejected)`"), { code: "P2010", meta: { code: "P0001", message: "demo_chat_audit_log is append-only (TRUNCATE rejected)" } });
  const origErr = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" "));
  const h1 = E.toHttpError(engine), h2 = E.toHttpError(raw);
  console.error = origErr;
  ok("P0001 via engine error (UnknownRequestError) → 500 AUDIT_APPEND_ONLY", E.isAppendOnlyViolation(engine) && h1.status === 500 && h1.code === "AUDIT_APPEND_ONLY");
  ok("P0001 via raw query (P2010) → 500 AUDIT_APPEND_ONLY", E.isAppendOnlyViolation(raw) && h2.code === "AUDIT_APPEND_ONLY");
  ok("violation logged loudly; no PostgreSQL text sent to client", logged.length === 2 && logged.every((l) => /APPEND-ONLY/.test(l)) && !/PostgresError|P0001|append-only \(/.test(h1.message + h2.message));
  const res = E.errorResponse(engine, "test");
  const body = await res.json();
  ok("errorResponse returns { error, code } JSON only", res.status === 500 && body.code === "AUDIT_APPEND_ONLY" && !JSON.stringify(body).includes("PostgresError"));
  ok("other P0001 → DB_RULE; CHECK 23514 → 400; P2002/P2003/P2025 mapped",
    (() => { const s = console.error; console.error = () => {}; try {
      return E.toHttpError(Object.assign(new Error('PostgresError { code: "P0001", message: "other rule" }'))).code === "DB_RULE"
        && E.toHttpError(Object.assign(new Error('PostgresError { code: "23514", message: "violates check constraint" }'))).status === 400
        && E.toHttpError(known("P2002")).status === 409 && E.toHttpError(known("P2003")).code === "REFERENCED" && E.toHttpError(known("P2025")).status === 404;
    } finally { console.error = s; } })());

  const files = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|jsx|mjs)$/.test(f)) files.push(p); } };
  walk("src");
  const offenders = files.filter((p) => {
    const s = readFileSync(p, "utf8");
    return /demoChatAuditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/.test(s) || /(\$executeRaw|\$queryRaw)[\s\S]{0,300}demo_chat_audit_log/.test(s);
  });
  ok(`no source file updates/deletes/raw-writes demo_chat_audit_log (${files.length} files scanned)`, offenders.length === 0);
  const mig = src("prisma/migrations/20261024_demo_chat_audit_truncate_guard/migration.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ok("TRUNCATE guard migration present (statement-level BEFORE TRUNCATE)", /BEFORE TRUNCATE ON "demo_chat_audit_log"\s+FOR EACH STATEMENT/.test(mig));
}

// ── 7. Preview ────────────────────────────────────────────────────────────────
console.log("\n7. Preview (no writes)");
{
  const id = J.journey.id;
  const w0 = db._writes.length, a0 = auditCount(db);
  const p = await svc.previewTimeline({ journeyId: id });
  ok("30 days, Casablanca, simulated, disclosure", p.days.length === 30 && p.timezone === "Africa/Casablanca" && p.simulated && /Simulation/.test(p.disclosure));
  const v1 = db._t.demoChatJourneyVersion.find((v) => v.journeyId === id && v.version === 1);
  const pv = await svc.previewTimeline({ journeyId: id, versionId: v1.id });
  ok("version preview uses the frozen snapshot", pv.source.kind === "version" && pv.source.version === 1 && pv.days[0].messages.some((m) => m.text !== "Texte modifié après publication"));
  ok("preview wrote nothing (no rows, no audit)", db._writes.length === w0 && auditCount(db) === a0);
  ok("version preview requires its journey", (await rejects(svc.previewTimeline({ versionId: v1.id }))).status === 400);
}

// ── 8. Gates ──────────────────────────────────────────────────────────────────
console.log("\n8. Feature gates (env + protected setting)");
{
  ok("both gates required", !G.evaluateGates(undefined, null).enabled && !G.evaluateGates("true", null).enabled
    && !G.evaluateGates(undefined, { enabled: true }).enabled && !G.evaluateGates("1", { enabled: true }).enabled
    && !G.evaluateGates("true", { enabled: "true" }).enabled && G.evaluateGates("true", { enabled: true }).enabled);
  ok("default: disabled (no env, no row)", !(await G.isDemoChatEnabled(db, {})));
  ok("env alone: disabled", !(await G.isDemoChatEnabled(db, { DEMO_CHAT_ENABLED: "true" })));
  db._t.setting.push({ id: G.DEMO_CHAT_SETTING_ID, data: { enabled: true } });
  ok("setting alone: disabled", !(await G.isDemoChatEnabled(db, {})));
  ok("both: enabled (gate logic only — nothing in 3C-2 sets them)", await G.isDemoChatEnabled(db, { DEMO_CHAT_ENABLED: "true" }));
  db._t.setting.length = 0;
  ok("read failure → disabled", !(await G.isDemoChatEnabled({ setting: { findUnique: async () => { throw new Error("db down"); } } }, { DEMO_CHAT_ENABLED: "true" })));
  const status = await svc.getChatStatus();
  ok("status route data reports disabled", status.enabled === false);
  const sc = src("src/lib/controllers/settingsController.js");
  ok("generic /api/setting cannot write demo-chat-config (reserved)", /DEMO_CHAT_SETTING_ID,/.test(sc.slice(sc.indexOf("RESERVED_SETTING_TYPES = new Set"), sc.indexOf("]);", sc.indexOf("RESERVED_SETTING_TYPES = new Set")))));
  const chatSrc = ["src/lib/services/demoChatService.js", "src/lib/demoChatGate.js"].map(src).join("\n");
  ok("no 3C-2 code writes the gate setting", !/setting\s*\.\s*(create|update|upsert|delete)/.test(chatSrc));
  ok(".env.example ships DEMO_CHAT_ENABLED=false", /^DEMO_CHAT_ENABLED=false$/m.test(src(".env.example")));
}

// ── 9. Authorization ──────────────────────────────────────────────────────────
console.log("\n9. Admin-only routes");
{
  const routes = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (f === "route.js") routes.push(p); } };
  walk("src/app/api/admin/demo-chat");
  ok("10 demo-chat route files", routes.length === 10);
  for (const p of routes) {
    const s = readFileSync(p, "utf8");
    const methods = [...s.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (\w+)\(/g)];
    ok(`${p.split("/api/")[1]}: every method withAdminAuth (${methods.map((m) => m[1]).join(", ")})`,
      methods.length > 0 && methods.every((m) => m[2] === "withAdminAuth") && !/export (async )?function/.test(s));
  }
  const req = (cookie) => ({ cookies: { get: () => undefined }, headers: { get: (k) => (k === "cookie" ? cookie : null) }, json: async () => ({ name: "Via route" }) });
  const route = withAdminAuth(async (r, c, user) => Response.json(await svc.createJourney(await r.json(), { actorId: E.actorIdOf(user), now: at() }), { status: 201 }));
  const n0 = db._t.demoChatJourney.length;
  ok("no token → 401, nothing written", (await route(req(""))).status === 401 && db._t.demoChatJourney.length === n0);
  ok("non-admin token → 403", (await route(req(`auth_token=${signToken({ userId: "u-1", role: "USER" })}`))).status === 403);
  ok("affiliate token → 403", (await route(req(`auth_token=${signToken({ affiliateId: "a-1", type: "affiliate" })}`))).status === 403);
  ok("forged token → 401", (await route(req("auth_token=x.y.z"))).status === 401 && db._t.demoChatJourney.length === n0);
  const okRes = await route(req(`auth_token=${signToken({ userId: "admin-7", email: "a@x", role: "ADMIN" })}`));
  ok("admin → 201 and audit actor = token userId", okRes.status === 201 && db._t.demoChatAuditLog.at(-1).actorId === "admin-7");
  ok("sidebar links the demo chat page", /href: "\/admin\/demo-chat"/.test(src("src/components/admin/SideBar.jsx")));
}

// ── 10. Isolation ─────────────────────────────────────────────────────────────
console.log("\n10. Isolation from real orders, money and messaging");
{
  const files = [
    "src/lib/demoChatValidation.js", "src/lib/demoChatErrors.js", "src/lib/demoChatGate.js", "src/lib/services/demoChatService.js",
    ...(() => { const out = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.push(p); } }; walk("src/app/api/admin/demo-chat"); walk("src/app/admin/demo-chat"); return out; })(),
  ];
  const banned = /(order|commission|payout|withdraw|deposit|booster|balance|wallet|notification|whatsapp|sms|ugc|reward|fakeOrder|affiliateService|affiliateSystem|teamBonus|referral)/i;
  const offenders = files.filter((p) => [...readFileSync(p, "utf8").matchAll(/from\s+['"]([^'"]+)['"]/g)].some((m) => banned.test(m[1])));
  ok(`new files import no order/money/messaging/UGC/rewards modules (${files.length} files)`, offenders.length === 0);
  ok("fake DB saw only demo_chat_* models and the gate settings row", true); // any other access would have thrown
  ok("service talks to the DB only through the demo seam", /getDemoDb\(\)/.test(src("src/lib/services/demoChatService.js")) && !/from ['"][^'"]*prisma(\.js)?['"]/.test(src("src/lib/services/demoChatService.js")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
