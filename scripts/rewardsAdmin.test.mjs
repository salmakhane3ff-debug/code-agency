#!/usr/bin/env node
/**
 * scripts/rewardsAdmin.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards Phase 2 — admin settings, gift catalog and redemption management.
 * Drives the real services and route handlers (src/lib/rewardsRouteHandlers.js)
 * against the rewards fake DB, with an admin session object exactly as
 * withAdminAuth passes it. Proves:
 *   • gift input validation (images from the media library only, stock/activation
 *     only through their dedicated actions) and stock state
 *   • catalog actions + audited, race-safe stock adjustment (never negative,
 *     composes with concurrent redemptions)
 *   • handlers: actor id ONLY from the session, malformed JSON → 400, error
 *     codes → 4xx, unknown errors → generic 500 without internals
 *   • redemption management: allowed transitions only, carrier name resolved
 *     from Shipping Companies (not the browser), tracking/notes audited
 *   • accounts: audited idempotent adjustments, books balanced
 *   • every admin rewards route is withAdminAuth-wrapped; sidebar + media refs
 * Run: node scripts/rewardsAdmin.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeRewardsFakeDb } from "./lib/rewardsFakeDb.mjs";
import { normalizeGiftInput, computeStockState, isValidMediaUrl, REDEMPTION_STATUS as S } from "../src/lib/rewards.js";
import { createGift, updateGift, setGiftStatus, adjustGiftStock, listGiftsAdmin } from "../src/lib/services/rewardGiftService.js";
import { saveRewardsConfig, adjustPoints } from "../src/lib/services/rewardsService.js";
import { requestRedemption } from "../src/lib/services/rewardRedemptionService.js";
import { adminRewardsHandlers, actorIdOf } from "../src/lib/rewardsRouteHandlers.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
async function code(fn) { try { await fn(); return null; } catch (e) { return e.code || e.message; } }

const ADMIN = { userId: "admin-1", email: "admin@test", role: "ADMIN" };
const NOW = new Date("2026-10-20T10:00:00Z");
let seq = 0; const rid = () => `req-${String(++seq).padStart(8, "0")}`;
const recipient = { fullName: "Salma Test", phone: "+212612345678", city: "Casablanca", address: "12 rue des Fleurs" };
const req = (method, path, body, raw) => new Request(`http://x${path}`, {
  method, headers: { "content-type": "application/json" },
  ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const ctx = (params) => ({ params: Promise.resolve(params) });
const seed = () => makeRewardsFakeDb({
  affiliate: [
    { id: "A", username: "salma", name: "Salma B", isActive: true, createdAt: new Date("2026-01-01") },
    { id: "B", username: "youssef", name: "Youssef K", isActive: true, createdAt: new Date("2026-02-01") },
  ],
  shippingCompany: [{ id: "sc-amana", name: "Amana", isActive: true }],
});

// ── 1. Gift input validation ─────────────────────────────────────────────────
console.log("\n1. Gift validation");
{
  const v = normalizeGiftInput({ name: "  Casque  BT ", description: "Ligne 1\nLigne 2\u0007", images: ["https://cdn.x/a.webp", "/uploads/b.webp", "https://cdn.x/a.webp"], pointsCost: "300", stock: 4 });
  ok("valid gift normalized", v.ok && v.value.name === "Casque BT" && v.value.pointsCost === 300 && v.value.stock === 4);
  ok("description keeps newlines, drops control chars", v.value.description === "Ligne 1\nLigne 2");
  ok("duplicate images removed", v.value.images.length === 2);
  ok("new gifts start inactive unless asked", v.value.isActive === false);
  const bad = normalizeGiftInput({ name: "x", pointsCost: 0, stock: -1, images: ["javascript:alert(1)"], maxPerAffiliate: 0 });
  ok("all bad fields reported", !bad.ok && bad.errors.name && bad.errors.pointsCost && bad.errors.stock && bad.errors.images && bad.errors.maxPerAffiliate);
  ok("media URLs: http(s) or /uploads only",
    isValidMediaUrl("https://cdn/x.webp") && isValidMediaUrl("/uploads/x.webp") && !isValidMediaUrl("data:image/png;base64,AA")
    && !isValidMediaUrl("//evil.com/x") && !isValidMediaUrl("/etc/passwd") && !isValidMediaUrl('https://x/"onerror='));
  ok("more than 10 images rejected", !normalizeGiftInput({ name: "Gift", pointsCost: 1, images: Array.from({ length: 11 }, (_, i) => `/uploads/${i}.webp`) }).ok);
  ok("float points rejected", !normalizeGiftInput({ name: "Gift", pointsCost: 10.5 }).ok);
  const p = normalizeGiftInput({ stock: 5, isActive: true }, { partial: true });
  ok("edit cannot set stock/activation directly", p.errors.stock === "USE_STOCK_ADJUSTMENT" && p.errors.isActive === "USE_STATUS_ACTION");
  ok("empty edit → NOTHING_TO_UPDATE", normalizeGiftInput({}, { partial: true }).errors._ === "NOTHING_TO_UPDATE");
  ok("optional limits: '' / null → none", normalizeGiftInput({ maxPerAffiliate: "", lowStockThreshold: null }, { partial: true }).value.maxPerAffiliate === null);
  ok("stock state uses the gift threshold, else the default",
    computeStockState({ stock: 5, lowStockThreshold: 5 }, 3) === "LOW" && computeStockState({ stock: 5, lowStockThreshold: null }, 3) === "OK"
    && computeStockState({ stock: 3 }, 3) === "LOW" && computeStockState({ stock: 0 }, 3) === "OUT");
}

// ── 2. Catalog service ───────────────────────────────────────────────────────
console.log("\n2. Catalog service");
{
  const db = seed();
  const g = await createGift({ name: "Casque", pointsCost: 30, stock: 5 }, { db, actorId: "admin-1" });
  const audit = () => db._tables.rewardAuditLog;
  ok("create audited with actor", audit().at(-1).action === "GIFT_CREATE" && audit().at(-1).actorId === "admin-1" && audit().at(-1).entityId === g.id);
  const u = await updateGift(g.id, { name: "Casque Pro", pointsCost: 40 }, { db, actorId: "admin-1" });
  ok("edit applied + audited with before/after", u.name === "Casque Pro" && audit().at(-1).before.pointsCost === 30 && audit().at(-1).after.pointsCost === 40);
  ok("edit rejects stock", (await code(() => updateGift(g.id, { stock: 99 }, { db }))) === "INVALID_INPUT");
  ok("unknown gift → GIFT_NOT_FOUND", (await code(() => updateGift("nope", { name: "Xyz" }, { db }))) === "GIFT_NOT_FOUND");

  ok("activate", (await setGiftStatus(g.id, "activate", { db, actorId: "admin-1" })).isActive === true);
  ok("deactivate", (await setGiftStatus(g.id, "deactivate", { db })).isActive === false);
  const arch = await setGiftStatus(g.id, "archive", { db, now: NOW });
  ok("archive hides + deactivates", arch.archivedAt && arch.isActive === false);
  ok("archived gift cannot be activated", (await code(() => setGiftStatus(g.id, "activate", { db }))) === "GIFT_ARCHIVED");
  ok("archived gift cannot be edited", (await code(() => updateGift(g.id, { name: "Autre" }, { db }))) === "GIFT_ARCHIVED");
  const rest = await setGiftStatus(g.id, "restore", { db });
  ok("restore → visible again, still inactive", rest.archivedAt === null && rest.isActive === false);
  ok("unknown action rejected", (await code(() => setGiftStatus(g.id, "delete", { db }))) === "INVALID_INPUT");
  ok("each status action audited", ["GIFT_ACTIVATE", "GIFT_DEACTIVATE", "GIFT_ARCHIVE", "GIFT_RESTORE"].every((a) => audit().some((x) => x.action === a)));

  const s1 = await adjustGiftStock(g.id, { delta: 7, reason: "Réception fournisseur" }, { db, actorId: "admin-1" });
  ok("stock +7 → 12", s1.stock === 12 && audit().at(-1).before.stock === 5 && audit().at(-1).after.stock === 12);
  ok("stock below zero refused, unchanged",
    (await code(() => adjustGiftStock(g.id, { delta: -13, reason: "Inventaire" }, { db }))) === "STOCK_NEGATIVE" && db._tables.rewardGift[0].stock === 12);
  ok("stock to exactly zero allowed", (await adjustGiftStock(g.id, { delta: -12, reason: "Inventaire" }, { db })).stock === 0);
  ok("reason required", (await code(() => adjustGiftStock(g.id, { delta: 1, reason: "x" }, { db }))) === "INVALID_INPUT");
  ok("delta must be a non-zero integer",
    (await code(() => adjustGiftStock(g.id, { delta: 1.5, reason: "Inventaire" }, { db }))) === "INVALID_INPUT"
    && (await code(() => adjustGiftStock(g.id, { delta: "5", reason: "Inventaire" }, { db }))) === "INVALID_INPUT");
}
{
  // Stock adjustments compose with concurrent redemptions (no lost update).
  const db = seed();
  await saveRewardsConfig({ enabled: true, maxOpenRedemptions: 50 }, { db, now: NOW });
  for (const a of ["A", "B"]) await adjustPoints({ affiliateId: a, delta: 100, reason: "Solde de test", clientRequestId: rid(), actorId: "admin-1" }, { db });
  const g = await createGift({ name: "Montre", pointsCost: 10, stock: 5, isActive: true }, { db });
  await Promise.all([
    requestRedemption({ affiliateId: "A", giftId: g.id, recipient, clientRequestId: rid() }, { db, now: NOW }),
    adjustGiftStock(g.id, { delta: 10, reason: "Réassort urgent" }, { db }),
    requestRedemption({ affiliateId: "B", giftId: g.id, recipient, clientRequestId: rid() }, { db, now: NOW }),
    requestRedemption({ affiliateId: "A", giftId: g.id, recipient, clientRequestId: rid() }, { db, now: NOW }),
  ]);
  ok("5 + 10 − 3 concurrent redemptions = 12 (adjustment composes, nothing lost)", db._tables.rewardGift.find((x) => x.id === g.id).stock === 12);

  await createGift({ name: "Mug", pointsCost: 5, stock: 2, isActive: true }, { db });
  await createGift({ name: "Sac", pointsCost: 5, stock: 0, isActive: false }, { db });
  const arch = await createGift({ name: "Ancien", pointsCost: 5, stock: 9 }, { db });
  await setGiftStatus(arch.id, "archive", { db });
  const names = async (filter) => (await listGiftsAdmin({ filter, db })).map((x) => x.name).sort().join(",");
  ok("filter all (archived hidden)", (await names("all")) === "Montre,Mug,Sac");
  ok("filter active / inactive", (await names("active")) === "Montre,Mug" && (await names("inactive")) === "Sac");
  ok("filter low (default threshold 3) / out", (await names("low")) === "Mug" && (await names("out")) === "Sac");
  ok("filter archived", (await names("archived")) === "Ancien");
  ok("open request count per gift", (await listGiftsAdmin({ db })).find((x) => x.name === "Montre").openRequests === 3);
}

// ── 3. Handlers: identity, parsing, error mapping ────────────────────────────
console.log("\n3. Handlers");
const db = seed();
const h = adminRewardsHandlers({ db, now: () => NOW });
const call = async (fn, method, path, body, params, raw) => {
  const res = await fn(req(method, path, body, raw), ctx(params || {}), ADMIN);
  return { status: res.status, body: await res.json(), headers: res.headers };
};
{
  ok("actor id from the session", actorIdOf(ADMIN) === "admin-1" && actorIdOf({ email: "e@x" }) === "e@x" && actorIdOf(null) === null);
  const s0 = await call(h.getSettings, "GET", "/s");
  ok("GET settings → defaults (OFF), no-store", s0.status === 200 && s0.body.enabled === false && /no-store/.test(s0.headers.get("cache-control")));
  const s1 = await call(h.putSettings, "PUT", "/s", { enabled: true, pointsPerDeliveredOrder: 10, actorId: "hacker", launchedAt: "1999-01-01" });
  ok("PUT settings enables (baseline result returned)", s1.status === 200 && s1.body.config.enabled === true && typeof s1.body.baselineExcluded === "number");
  ok("…launchedAt is system-set, not from the body", s1.body.config.launchedAt === NOW.toISOString());
  ok("…audit actor is the session admin, not the body", db._tables.rewardAuditLog.at(-1).actorId === "admin-1");
  for (const [name, raw] of [["malformed JSON", "{oops"], ["array body", "[1]"], ["null body", "null"]]) {
    const r = await call(h.putSettings, "PUT", "/s", undefined, {}, raw);
    ok(`${name} → 400 INVALID_JSON`, r.status === 400 && r.body.code === "INVALID_JSON");
  }

  const bad = await call(h.createGift, "POST", "/g", { name: "x", pointsCost: -1 });
  ok("invalid gift → 400 with field errors", bad.status === 400 && bad.body.code === "INVALID_INPUT" && bad.body.errors.name && bad.body.errors.pointsCost);
  const created = await call(h.createGift, "POST", "/g", { name: "Casque", pointsCost: 30, stock: 3, images: ["/uploads/c.webp"], isActive: true });
  ok("create gift → 201", created.status === 201 && created.body.id && created.body.isActive === true);
  const gid = created.body.id;
  ok("get gift → stockState", (await call(h.getGift, "GET", "/g", undefined, { id: gid })).body.stockState === "LOW");
  ok("unknown gift → 404", (await call(h.getGift, "GET", "/g", undefined, { id: "nope" })).status === 404);
  ok("PUT gift edits", (await call(h.updateGift, "PUT", "/g", { pointsCost: 35 }, { id: gid })).body.pointsCost === 35);
  ok("stock adjust below zero → 409 STOCK_NEGATIVE",
    (await call(h.adjustStock, "POST", "/g", { delta: -10, reason: "Inventaire" }, { id: gid })).status === 409);
  ok("stock adjust → 200", (await call(h.adjustStock, "POST", "/g", { delta: 7, reason: "Réception" }, { id: gid })).body.stock === 10);
  ok("list gifts", (await call(h.listGifts, "GET", "/g?filter=active")).body.length === 1);
  await call(h.patchGift, "PATCH", "/g", { action: "archive" }, { id: gid });
  ok("edit archived → 409 GIFT_ARCHIVED", (await call(h.updateGift, "PUT", "/g", { pointsCost: 1 }, { id: gid })).status === 409);
  await call(h.patchGift, "PATCH", "/g", { action: "restore" }, { id: gid });
  await call(h.patchGift, "PATCH", "/g", { action: "activate" }, { id: gid });

  const broken = adminRewardsHandlers({ db: { ...db, setting: { findUnique: async () => null, upsert: async () => { throw new Error("SECRET connection string postgres://u:p@h"); } }, $transaction: (fn) => db.$transaction(async (tx) => fn({ ...tx, setting: { upsert: async () => { throw new Error("SECRET connection string postgres://u:p@h"); } } })) } });
  const silence = console.error; console.error = () => {};
  const boom = await call(broken.putSettings, "PUT", "/s", { enabled: false });
  console.error = silence;
  ok("unexpected error → 500 generic, internals never sent", boom.status === 500 && boom.body.error === "Erreur serveur" && !JSON.stringify(boom.body).includes("SECRET"));
}

// ── 4. Redemption management ─────────────────────────────────────────────────
console.log("\n4. Redemptions");
{
  await saveRewardsConfig({ maxOpenRedemptions: 50 }, { db, now: NOW });
  for (const a of ["A", "B"]) await adjustPoints({ affiliateId: a, delta: 200, reason: "Solde de test", clientRequestId: rid(), actorId: "admin-1" }, { db });
  const gid = db._tables.rewardGift[0].id;
  const r1 = (await requestRedemption({ affiliateId: "A", giftId: gid, recipient, clientRequestId: rid() }, { db, now: NOW })).redemption;
  const r2 = (await requestRedemption({ affiliateId: "B", giftId: gid, recipient: { ...recipient, fullName: "Youssef Dest" }, clientRequestId: rid() }, { db, now: NOW })).redemption;

  const list = await call(h.listRedemptions, "GET", "/r?status=OPEN");
  ok("list open requests with affiliate info", list.body.items.length === 2 && list.body.items.every((r) => r.affiliate?.username));
  ok("search by affiliate username", (await call(h.listRedemptions, "GET", "/r?q=youss")).body.items.map((r) => r.id).join() === r2.id);
  ok("search by reference", (await call(h.listRedemptions, "GET", `/r?q=${r1.reference.slice(-6)}`)).body.items[0]?.id === r1.id);
  ok("status filter", (await call(h.listRedemptions, "GET", "/r?status=DELIVERED")).body.items.length === 0);
  const page = await call(h.listRedemptions, "GET", "/r?status=ALL");
  ok("pagination shape", Array.isArray(page.body.items) && "nextCursor" in page.body);

  const p = (body) => call(h.patchRedemption, "PATCH", "/r", body, { id: r1.id });
  ok("unknown status → 400", (await p({ toStatus: "LOST" })).status === 400);
  ok("skipping a step → 409", (await p({ toStatus: "SHIPPED", carrierName: "X" })).status === 409);
  ok("tracking before shipping → 409", (await p({ trackingNumber: "T1" })).status === 409);
  await p({ toStatus: "APPROVED" });
  await p({ toStatus: "PREPARING" });
  ok("unknown carrier id → 400", (await p({ toStatus: "SHIPPED", carrierId: "nope" })).status === 400);
  const shipped = await p({ toStatus: "SHIPPED", carrierId: "sc-amana", carrierName: "Fake Express", trackingNumber: "AM123" });
  ok("shipped with carrier resolved from Shipping Companies (browser name ignored)",
    shipped.status === 200 && shipped.body.status === S.SHIPPED && shipped.body.carrierName === "Amana" && shipped.body.carrierId === "sc-amana");
  ok("history actor = session admin", shipped.body.history.at(-1).actorType === "ADMIN" && shipped.body.history.at(-1).actorId === "admin-1");
  const notes = await p({ internalNotes: "Client appelé, livraison mardi" });
  ok("internal notes saved (admin view)", notes.body.internalNotes === "Client appelé, livraison mardi");
  const t2 = await p({ trackingNumber: "AM999" });
  ok("tracking corrected after shipping", t2.body.trackingNumber === "AM999");
  ok("fulfilment edits audited with before/after",
    db._tables.rewardAuditLog.filter((a) => a.action === "REDEMPTION_FULFILLMENT_UPDATE").length === 2
    && db._tables.rewardAuditLog.at(-1).before.trackingNumber === "AM123" && db._tables.rewardAuditLog.at(-1).after.trackingNumber === "AM999");
  ok("empty edit → 400", (await p({})).status === 400);
  ok("RETURNED without explicit choices → 400", (await p({ toStatus: "RETURNED", refundPoints: true })).status === 400);
  const ret = await p({ toStatus: "RETURNED", refundPoints: false, restock: true, note: "Colis refusé" });
  ok("RETURNED refund=no restock=yes", ret.body.status === S.RETURNED && !ret.body.pointsRefundedAt && ret.body.restockedAt);

  const rej = await call(h.patchRedemption, "PATCH", "/r", { toStatus: "REJECTED", reason: "Adresse incomplète", internalNotes: "Vérifier l'adresse" }, { id: r2.id });
  ok("reject with reason + notes in one call", rej.body.status === S.REJECTED && rej.body.rejectionReason === "Adresse incomplète" && rej.body.internalNotes === "Vérifier l'adresse");
  ok("reject refunded B", db._tables.rewardPointsAccount.find((a) => a.affiliateId === "B").balance === 200);
  ok("unknown request → 404", (await call(h.getRedemption, "GET", "/r", undefined, { id: "nope" })).status === 404);
}

// ── 5. Accounts & audit ──────────────────────────────────────────────────────
console.log("\n5. Accounts & audit");
{
  const list = await call(h.listAccounts, "GET", "/a?q=sal");
  ok("search accounts", list.body.length === 1 && list.body[0].username === "salma" && typeof list.body[0].balance === "number");
  ok("affiliates without points listed with 0", (await call(h.listAccounts, "GET", "/a")).body.every((a) => typeof a.balance === "number"));
  const key = rid();
  const adj = await call(h.adjustAccount, "POST", "/a", { delta: 25, reason: "Geste commercial", clientRequestId: key, actorId: "hacker", affiliateId: "B" }, { affiliateId: "A" });
  ok("adjust → 201, affiliate from URL, actor from session (body ignored)",
    adj.status === 201 && adj.body.entry.affiliateId === "A" && adj.body.entry.actorId === "admin-1");
  const again = await call(h.adjustAccount, "POST", "/a", { delta: 25, reason: "Geste commercial", clientRequestId: key }, { affiliateId: "A" });
  ok("retry same request id → 200 duplicate, no second entry", again.status === 200 && again.body.duplicate === true);
  ok("reason required → 400", (await call(h.adjustAccount, "POST", "/a", { delta: 5, reason: "", clientRequestId: rid() }, { affiliateId: "A" })).status === 400);
  ok("debit below zero → 409", (await call(h.adjustAccount, "POST", "/a", { delta: -100000, reason: "Correction", clientRequestId: rid() }, { affiliateId: "A" })).status === 409);
  ok("unknown affiliate → 404", (await call(h.adjustAccount, "POST", "/a", { delta: 5, reason: "Correction", clientRequestId: rid() }, { affiliateId: "ZZ" })).status === 404);
  const acc = await call(h.getAccount, "GET", "/a", undefined, { affiliateId: "A" });
  ok("account detail: summary, ledger, awards, requests, books balanced",
    acc.status === 200 && acc.body.summary.balance === acc.body.ledger.items[0].balanceAfter
    && Array.isArray(acc.body.awards) && acc.body.redemptions.length === 1 && acc.body.booksBalanced === true);
  ok("unknown account → 404", (await call(h.getAccount, "GET", "/a", undefined, { affiliateId: "ZZ" })).status === 404);
  const gifts = await call(h.listAudit, "GET", "/au?entityType=reward_gift");
  ok("audit filtered by entity", gifts.body.items.length > 0 && gifts.body.items.every((a) => a.entityType === "reward_gift"));
  ok("audit newest first", new Date(gifts.body.items[0].createdAt) >= new Date(gifts.body.items.at(-1).createdAt));
}

// ── 6. Static wiring ─────────────────────────────────────────────────────────
console.log("\n6. Static wiring");
{
  const root = new URL("../src/app/api/admin/rewards/", import.meta.url).pathname;
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "route.js") files.push(p);
    }
  };
  walk(root);
  const handlerNames = Object.keys(adminRewardsHandlers({ db }));
  ok("11 admin rewards route files", files.length === 11);
  let wrapped = 0, total = 0, unknown = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*(.+);$/gm)) {
      total++;
      const w = m[2].match(/^withAdminAuth\(h\.(\w+)\)$/);
      if (w) { wrapped++; if (!handlerNames.includes(w[1])) unknown.push(w[1]); }
    }
    ok(`${f.split("/rewards/")[1]}: no unwrapped handler exports`, !/^export (async )?function (GET|POST|PUT|PATCH|DELETE)/m.test(src));
  }
  ok(`every method withAdminAuth-wrapped (${wrapped}/${total})`, total > 0 && wrapped === total);
  ok("every route points at an existing handler", unknown.length === 0);
  const sidebar = readFileSync(new URL("../src/components/admin/SideBar.jsx", import.meta.url), "utf8");
  ok("sidebar links /admin/rewards", /href: "\/admin\/rewards"/.test(sidebar));
  const media = readFileSync(new URL("../src/lib/mediaReferences.js", import.meta.url), "utf8");
  ok("gift images protected from media cleanup",
    /table: 'reward_gifts',\s+columns: \['images'\]/.test(media) && /table: 'reward_redemptions', columns: \['giftSnapshot'\]/.test(media));
  const ui = (f) => readFileSync(new URL(`../src/app/admin/rewards/${f}`, import.meta.url), "utf8");
  ok("UI never sends an actor id", !/actorId/.test(ui("AccountsTab.jsx") + ui("RedemptionsTab.jsx") + ui("GiftsTab.jsx") + ui("SettingsTab.jsx")));
  ok("UI offers only allowed transitions (ADMIN_TRANSITIONS)", /ADMIN_TRANSITIONS\[red\.status\]/.test(ui("RedemptionsTab.jsx")));
  ok("adjustments carry an idempotency key", /clientRequestId: requestId/.test(ui("AccountsTab.jsx")));
  ok("images picked from the existing media library", /import ImageSelector from "@\/components\/block\/ImageSelector"/.test(ui("GiftsTab.jsx")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
