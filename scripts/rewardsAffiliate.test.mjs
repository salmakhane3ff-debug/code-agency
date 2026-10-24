#!/usr/bin/env node
/**
 * scripts/rewardsAffiliate.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards Phase 4 — affiliate APIs + dashboard tab. Wraps the real handlers in
 * the REAL withAffiliateAuth (signed test tokens) over the rewards fake DB.
 * Proves:
 *   • authentication: no/forged/admin tokens → 401; identity only from the token
 *   • ownership: an affiliate never sees or cancels another affiliate's data;
 *     a body affiliateId / pointsCost is ignored
 *   • validation (400 + field errors), malformed JSON, rate limit (429)
 *   • eligibility: insufficient, held, negative (debt), disabled, out of stock,
 *     min orders, open-request limit — in the catalog AND on request
 *   • cancellation only while PENDING_REVIEW (refund once)
 *   • stock race through the API; ledger/history views hide admin-only data
 *   • FR/AR dictionaries complete and consistent; dashboard integration wiring
 * Run: node scripts/rewardsAffiliate.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { makeRewardsFakeDb } from "./lib/rewardsFakeDb.mjs";
import { affiliateRewardsHandlers } from "../src/lib/rewardsRouteHandlers.js";
import { withAffiliateAuth } from "../src/lib/middleware/withAffiliateAuth.js";
import { signToken } from "../src/lib/services/authService.js";
import { saveRewardsConfig, adjustPoints, syncOrderRewards } from "../src/lib/services/rewardsService.js";
import { transitionRedemption } from "../src/lib/services/rewardRedemptionService.js";
import { REWARDS_TEXT, rewardsT, rewardsDir, rewardsLang, cancellationNote } from "../src/lib/rewardsI18n.js";
import { REDEMPTION_STATUS, LEDGER_TYPE, ACTOR } from "../src/lib/rewards.js";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

const NOW = new Date("2026-10-20T10:00:00Z");
let seq = 0; const rid = () => `req-${String(++seq).padStart(8, "0")}`;
const recipient = { fullName: "Salma Test", phone: "+212 612-345-678", city: "Casablanca", address: "12 rue des Fleurs" };
const tokenFor = (affiliateId) => signToken({ affiliateId, username: affiliateId.toLowerCase(), type: "affiliate" });

function seed() {
  return makeRewardsFakeDb({
    affiliate: ["A", "B", "C", "OFF"].map((id) => ({ id, username: id.toLowerCase(), name: id, isActive: id !== "OFF", createdAt: new Date("2026-01-01") })),
    order: [{ id: "o1", isFake: false, affiliateId: "A" }],
    affiliateOrder: [{ id: "ao1", affiliateId: "A", orderId: "o1", status: "pending", isFake: false, isSuspicious: false, total: 100, commissionAmount: 50 }],
    rewardGift: [
      { id: "g", name: "Casque", description: "BT", images: ["/uploads/c.webp"], pointsCost: 30, stock: 50, isActive: true, archivedAt: null, sortOrder: 1, createdAt: NOW },
      { id: "g-last", name: "Montre", description: "", images: [], pointsCost: 10, stock: 2, isActive: true, archivedAt: null, sortOrder: 2, createdAt: NOW },
      { id: "g-min", name: "VIP", description: "", images: [], pointsCost: 1, stock: 9, isActive: true, archivedAt: null, minDeliveredOrders: 2, sortOrder: 3, createdAt: NOW },
      { id: "g-off", name: "Off", description: "", images: [], pointsCost: 1, stock: 9, isActive: false, archivedAt: null, sortOrder: 4, createdAt: NOW },
      { id: "g-arch", name: "Old", description: "", images: [], pointsCost: 1, stock: 9, isActive: true, archivedAt: NOW, sortOrder: 5, createdAt: NOW },
    ],
  });
}
async function funded(points = 100, cfg = {}) {
  const db = seed();
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10, maxOpenRedemptions: 50, ...cfg }, { db, now: NOW, actorId: "admin-1" });
  if (points) {
    for (const a of ["A", "B", "C"]) await adjustPoints({ affiliateId: a, delta: points, reason: "Solde de test", clientRequestId: rid(), actorId: "admin-1" }, { db });
  }
  return db;
}
function api(db, extra = {}) {
  // The real limiter is per-IP and in-memory: every test request shares one
  // "IP", so it is replaced by a no-op here and exercised on its own below.
  const h = affiliateRewardsHandlers({ db, now: () => NOW, rateLimit: () => null, ...extra });
  const wrap = Object.fromEntries(Object.entries(h).map(([k, fn]) => [k, withAffiliateAuth(fn)]));
  return async (name, { token, method = "GET", path = "/api/affiliate/rewards", body, raw, params = {} } = {}) => {
    const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const res = await wrap[name](new Request(`http://x${path}`, { method, headers, ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve(params) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}
const balance = (db, a) => db._tables.rewardPointsAccount.find((x) => x.affiliateId === a)?.balance ?? 0;
const stock = (db, g) => db._tables.rewardGift.find((x) => x.id === g).stock;

// ── 1. Authentication ────────────────────────────────────────────────────────
console.log("\n1. Authentication");
{
  const db = await funded();
  const call = api(db);
  for (const name of ["overview", "ledger", "redemptions", "requestRedemption", "cancelRedemption"]) {
    ok(`${name}: no token → 401`, (await call(name, { method: "POST", body: {} })).status === 401);
  }
  ok("forged token → 401", (await call("overview", { token: tokenFor("A").slice(0, -4) + "AAAA" })).status === 401);
  const adminTok = signToken({ userId: "admin-1", email: "a@x", role: "ADMIN" });
  ok("admin token (not an affiliate) → 401", (await call("overview", { token: adminTok })).status === 401);
  ok("valid affiliate token → 200", (await call("overview", { token: tokenFor("A") })).status === 200);
}

// ── 2. Overview: points + catalog eligibility ────────────────────────────────
console.log("\n2. Overview");
{
  const db = await funded(40);
  const call = api(db);
  const o = (await call("overview", { token: tokenFor("A") })).body;
  ok("points summary", o.enabled === true && o.points.balance === 40 && o.points.spendable === 40 && o.points.debt === 0);
  ok("only active, non-archived gifts", o.gifts.map((g) => g.id).join() === "g,g-last,g-min");
  ok("exact stock hidden when plentiful, shown when low",
    !("stock" in o.gifts[0]) && !("remaining" in o.gifts[0]) && o.gifts[1].stockState === "LOW" && o.gifts[1].remaining === 2);
  ok("eligible gift → canRedeem", o.gifts.find((g) => g.id === "g").canRedeem === true);
  ok("min delivered orders → MIN_ORDERS_NOT_MET", o.gifts.find((g) => g.id === "g-min").reason === "MIN_ORDERS_NOT_MET");
  ok("no admin fields on gifts", o.gifts.every((g) => !("isActive" in g) && !("archivedAt" in g) && !("sortOrder" in g)));

  const poor = await funded(20);
  ok("insufficient points → INSUFFICIENT_POINTS", (await api(poor)("overview", { token: tokenFor("A") })).body.gifts.find((g) => g.id === "g").reason === "INSUFFICIENT_POINTS");

  const held = await funded(0, { orderPointsHoldDays: 7, pointsPerDeliveredOrder: 50 });
  held._tables.affiliateOrder[0].status = "delivered";
  await syncOrderRewards("ao1", { db: held, now: NOW });
  const ho = (await api(held)("overview", { token: tokenFor("A") })).body;
  ok("held points shown, not spendable → INSUFFICIENT_POINTS", ho.points.held === 50 && ho.points.spendable === 0
    && ho.gifts.find((g) => g.id === "g").reason === "INSUFFICIENT_POINTS");

  const off = await funded(100);
  await saveRewardsConfig({ enabled: false }, { db: off, now: NOW });
  const oo = (await api(off)("overview", { token: tokenFor("A") })).body;
  ok("rewards disabled → enabled:false, every gift REWARDS_DISABLED", oo.enabled === false && oo.gifts.every((g) => g.reason === "REWARDS_DISABLED"));
  // Policy (review fix): Rewards endpoints serve ACTIVE accounts only.
  const inactive = await api(off)("overview", { token: tokenFor("OFF") });
  ok("inactive affiliate → 403 AFFILIATE_INACTIVE (no data)", inactive.status === 403 && inactive.body.code === "AFFILIATE_INACTIVE" && !inactive.body.gifts);
}

// ── 3. Request: ownership, validation, eligibility ───────────────────────────
console.log("\n3. Gift request");
{
  const db = await funded(100);
  const call = api(db);
  const key = rid();
  const r = await call("requestRedemption", { token: tokenFor("A"), method: "POST",
    body: { giftId: "g", clientRequestId: key, ...recipient, affiliateId: "B", pointsCost: 1 } });
  ok("request → 201", r.status === 201 && r.body.redemption.status === "PENDING_REVIEW");
  ok("affiliate from token (body affiliateId ignored)", r.body.redemption.affiliateId === "A" && balance(db, "B") === 100);
  ok("cost from DB (body pointsCost ignored)", r.body.redemption.pointsCost === 30 && balance(db, "A") === 70);
  ok("phone normalized server-side", r.body.redemption.phone === "+212612345678");
  ok("public view: no internal notes / request id / carrier id",
    !("internalNotes" in r.body.redemption) && !("clientRequestId" in r.body.redemption) && !("carrierId" in r.body.redemption));
  const dup = await call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: key, ...recipient } });
  ok("double submit (same request id) → 200, same request, one debit", dup.status === 200 && dup.body.duplicate && dup.body.redemption.id === r.body.redemption.id && balance(db, "A") === 70);
  ok("B reusing A's request id → separate request (ids scoped per affiliate)",
    (await call("requestRedemption", { token: tokenFor("B"), method: "POST", body: { giftId: "g", clientRequestId: key, ...recipient } })).status === 201);

  const bad = await call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), fullName: "x", phone: "12", city: "", address: "1" } });
  ok("invalid recipient → 400 with field errors", bad.status === 400 && bad.body.errors.fullName && bad.body.errors.phone && bad.body.errors.city && bad.body.errors.address);
  ok("missing request id → 400", (await call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", ...recipient } })).status === 400);
  ok("malformed JSON → 400", (await call("requestRedemption", { token: tokenFor("A"), method: "POST", raw: "{oops" })).status === 400);
  for (const [gift, code, status] of [["g-off", "GIFT_UNAVAILABLE", 409], ["g-arch", "GIFT_UNAVAILABLE", 409], ["nope", "GIFT_UNAVAILABLE", 409], ["g-min", "MIN_ORDERS_NOT_MET", 409]]) {
    const res = await call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: gift, clientRequestId: rid(), ...recipient } });
    ok(`${gift} → ${status} ${code}`, res.status === status && res.body.code === code);
  }
  ok("inactive affiliate → 403", (await call("requestRedemption", { token: tokenFor("OFF"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })).status === 403);

  const poor = await funded(20);
  const pr = await api(poor)("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } });
  ok("insufficient → 409, nothing reserved", pr.status === 409 && pr.body.code === "INSUFFICIENT_POINTS" && stock(poor, "g") === 50 && balance(poor, "A") === 20);

  const off = await funded(100);
  await saveRewardsConfig({ enabled: false }, { db: off, now: NOW });
  ok("rewards disabled → 403 REWARDS_DISABLED", (await api(off)("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })).body.code === "REWARDS_DISABLED");

  // Negative balance (debt): award, spend, then the order is cancelled.
  const debt = await funded(0, { pointsPerDeliveredOrder: 30 });
  debt._tables.affiliateOrder[0].status = "delivered";
  await syncOrderRewards("ao1", { db: debt, now: NOW });
  await api(debt)("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } });
  debt._tables.affiliateOrder[0].status = "cancelled";
  await syncOrderRewards("ao1", { db: debt, now: NOW });
  const d = await api(debt)("overview", { token: tokenFor("A") });
  ok("debt shown in overview", d.body.points.balance === -30 && d.body.points.debt === 30);
  ok("negative balance blocks requests", (await api(debt)("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g-last", clientRequestId: rid(), ...recipient } })).body.code === "INSUFFICIENT_POINTS");

  const limited = api(db, { rateLimit: (_req, key) => (key === "rewards_redeem" ? Response.json({ error: "Trop" }, { status: 429 }) : null) });
  ok("rate limited → 429", (await limited("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })).status === 429);

  // Real limiter: 10 requests / minute / IP, then 429.
  const { rateLimit: realLimit } = await import("../src/lib/rateLimit.js");
  const rl = await funded(100);
  const realCall = api(rl, { rateLimit: realLimit });
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await realCall("requestRedemption", { token: tokenFor("A"), method: "POST",
      body: { giftId: "g-last", clientRequestId: rid(), fullName: "x" } })).status);
  }
  ok("real rate limiter: 11th request in a minute → 429", statuses.slice(0, 10).every((x) => x === 400) && statuses[10] === 429);

  const lim = await funded(100, { maxOpenRedemptions: 1 });
  await api(lim)("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } });
  ok("one open request at a time when configured → 409 TOO_MANY_OPEN_REQUESTS",
    (await api(lim)("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g-last", clientRequestId: rid(), ...recipient } })).body.code === "TOO_MANY_OPEN_REQUESTS");
}

// ── 4. Stock race through the API ────────────────────────────────────────────
console.log("\n4. Stock race");
{
  const db = await funded(100);
  const call = api(db);
  const res = await Promise.all(["A", "B", "C"].map((a) =>
    call("requestRedemption", { token: tokenFor(a), method: "POST", body: { giftId: "g-last", clientRequestId: rid(), ...recipient } })));
  ok("3 affiliates, 2 units → exactly 2 × 201, 1 × 409 OUT_OF_STOCK",
    res.filter((r) => r.status === 201).length === 2 && res.filter((r) => r.body.code === "OUT_OF_STOCK").length === 1);
  ok("stock 0, loser keeps points", stock(db, "g-last") === 0 && ["A", "B", "C"].filter((a) => balance(db, a) === 100).length === 1);
  const before = balance(db, "A");
  const many = await Promise.all(Array.from({ length: 12 }, () =>
    call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })));
  const okA = many.filter((r) => r.status === 201).length;
  ok(`12 concurrent requests on ${before} pts → exactly floor(${before}/30) = ${Math.floor(before / 30)} succeed`,
    okA === Math.floor(before / 30) && balance(db, "A") === before - 30 * okA && balance(db, "A") >= 0
    && many.filter((r) => r.status !== 201).every((r) => r.body.code === "INSUFFICIENT_POINTS"));
}

// ── 5. History views & cancellation ──────────────────────────────────────────
console.log("\n5. Requests, ledger, cancellation");
{
  const db = await funded(100);
  const call = api(db);
  const a1 = (await call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })).body.redemption;
  const a2 = (await call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })).body.redemption;
  const b1 = (await call("requestRedemption", { token: tokenFor("B"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })).body.redemption;
  const admin = { type: ACTOR.ADMIN, id: "admin-1" };
  await transitionRedemption({ redemptionId: a2.id, toStatus: "APPROVED", actor: admin, note: "note interne admin" }, { db, now: NOW });
  await transitionRedemption({ redemptionId: a2.id, toStatus: "PREPARING", actor: admin }, { db, now: NOW });
  await transitionRedemption({ redemptionId: a2.id, toStatus: "SHIPPED", actor: admin, carrierName: "Amana", carrierId: "sc-1", trackingNumber: "AM123" }, { db, now: NOW });
  db._tables.rewardRedemption.find((r) => r.id === a2.id).internalNotes = "SECRET admin note";

  const list = (await call("redemptions", { token: tokenFor("A") })).body;
  ok("own requests only", list.length === 2 && list.every((r) => r.affiliateId === "A") && !list.some((r) => r.id === b1.id));
  const shipped = list.find((r) => r.id === a2.id);
  ok("carrier + tracking shown", shipped.carrierName === "Amana" && shipped.trackingNumber === "AM123" && !("carrierId" in shipped));
  ok("status history (oldest first)", shipped.history.map((h) => h.toStatus).join() === "PENDING_REVIEW,APPROVED,PREPARING,SHIPPED");
  ok("no admin ids, history notes or internal notes leak",
    !JSON.stringify(list).includes("admin-1") && !JSON.stringify(list).includes("note interne") && !JSON.stringify(list).includes("SECRET"));

  const led = (await call("ledger", { token: tokenFor("A") })).body;
  ok("own ledger, no admin ids / idempotency keys",
    led.items.length === 3 && led.items.every((l) => !("actorId" in l) && !("idempotencyKey" in l) && !("affiliateId" in l)));

  const before = balance(db, "A");
  const c1 = await call("cancelRedemption", { token: tokenFor("A"), method: "POST", path: "/x", params: { id: a1.id } });
  ok("cancel own PENDING_REVIEW → 200, refunded", c1.status === 200 && c1.body.redemption.status === "CANCELLED" && balance(db, "A") === before + 30);
  // Regression (Phase 5): a self-cancel stored a hard-coded French reason that
  // the Arabic tab then displayed untranslated.
  ok("self-cancel stores no hard-coded reason text", c1.body.redemption.cancelReason == null
    && db._tables.rewardRedemption.find((r) => r.id === a1.id).cancelReason == null);
  const hist = (await call("redemptions", { token: tokenFor("A") })).body.find((r) => r.id === a1.id).history
    .find((h) => h.toStatus === "CANCELLED");
  ok("…the history still shows the affiliate cancelled it", hist?.actorType === "AFFILIATE");
  // Regression (Phase 5): the cancellation line shown to the affiliate is built
  // from the FR/AR dictionaries, through the real list endpoint.
  const cancelled = (await call("redemptions", { token: tokenFor("A") })).body.find((r) => r.id === a1.id);
  ok("self-cancel line (AR) is the Arabic dictionary text", cancellationNote(cancelled, "ar") === REWARDS_TEXT.ar.cancelled_by_you);
  ok("self-cancel line (FR) is the French dictionary text", cancellationNote(cancelled, "fr") === REWARDS_TEXT.fr.cancelled_by_you);

  // Admin cancellation with a typed reason: translated label + the admin's words.
  const a3 = (await call("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } })).body.redemption;
  await transitionRedemption({ redemptionId: a3.id, toStatus: "CANCELLED", actor: admin, reason: "Rupture fournisseur" }, { db, now: NOW });
  const byTeam = (await call("redemptions", { token: tokenFor("A") })).body.find((r) => r.id === a3.id);
  const arLine = cancellationNote(byTeam, "ar");
  ok("admin cancel (AR): Arabic label + reason label + admin's reason",
    arLine.startsWith(REWARDS_TEXT.ar.cancelled_by_team) && arLine.includes(REWARDS_TEXT.ar.cancel_reason) && arLine.endsWith("Rupture fournisseur"));
  ok("admin cancel (FR): French label + reason", cancellationNote(byTeam, "fr").startsWith(REWARDS_TEXT.fr.cancelled_by_team));
  ok("cancel twice → 409, refunded once",
    (await call("cancelRedemption", { token: tokenFor("A"), method: "POST", path: "/x", params: { id: a1.id } })).status === 409 && balance(db, "A") === before + 30);
  ok("cancel after shipping → 409", (await call("cancelRedemption", { token: tokenFor("A"), method: "POST", path: "/x", params: { id: a2.id } })).body.code === "INVALID_TRANSITION");
  const other = await call("cancelRedemption", { token: tokenFor("A"), method: "POST", path: "/x", params: { id: b1.id } });
  ok("cancel another affiliate's request → 404 (looks missing), untouched",
    other.status === 404 && db._tables.rewardRedemption.find((r) => r.id === b1.id).status === "PENDING_REVIEW");
  ok("cancel unknown id → 404", (await call("cancelRedemption", { token: tokenFor("A"), method: "POST", path: "/x", params: { id: "nope" } })).status === 404);
}

// ── 6. Separation from commissions ───────────────────────────────────────────
console.log("\n6. Separation");
{
  const db = await funded(100);
  await api(db)("requestRedemption", { token: tokenFor("A"), method: "POST", body: { giftId: "g", clientRequestId: rid(), ...recipient } });
  ok("affiliate order commission untouched", db._tables.affiliateOrder[0].commissionAmount === 50);
  ok("no payout/booster/deposit rows created", !db._tables.affiliatePayout && !db._tables.affiliateBoosterPurchase);
  const src = readFileSync(new URL("../src/app/affiliate/dashboard/RewardsTab.jsx", import.meta.url), "utf8");
  ok("tab calls only rewards endpoints", [...src.matchAll(/["'`](\/api\/[^"'`$?]+)/g)].every((m) => m[1].startsWith("/api/affiliate/rewards")));
}

// ── 7. Language (FR/AR) ──────────────────────────────────────────────────────
console.log("\n7. Language");
{
  const fr = Object.keys(REWARDS_TEXT.fr).sort(), ar = Object.keys(REWARDS_TEXT.ar).sort();
  ok(`FR and AR have identical keys (${fr.length})`, JSON.stringify(fr) === JSON.stringify(ar));
  ok("no empty strings", [...Object.values(REWARDS_TEXT.fr), ...Object.values(REWARDS_TEXT.ar)].every((v) => typeof v === "string" && v.trim()));
  ok("Arabic texts are Arabic", Object.entries(REWARDS_TEXT.ar).filter(([k]) => !["points"].includes(k)).every(([, v]) => /[؀-ۿ]/.test(v)));
  ok("every redemption status labelled", Object.values(REDEMPTION_STATUS).every((s) => REWARDS_TEXT.fr[`status_${s}`] && REWARDS_TEXT.ar[`status_${s}`]));
  ok("every ledger type labelled", Object.values(LEDGER_TYPE).every((t) => REWARDS_TEXT.fr[`ledger_${t}`] && REWARDS_TEXT.ar[`ledger_${t}`]));
  const codes = ["REWARDS_DISABLED", "AFFILIATE_INACTIVE", "GIFT_UNAVAILABLE", "OUT_OF_STOCK", "MIN_ORDERS_NOT_MET", "GIFT_LIMIT_REACHED",
    "TOO_MANY_OPEN_REQUESTS", "INSUFFICIENT_POINTS", "INVALID_TRANSITION", "NOT_FOUND", "IDEMPOTENCY_CONFLICT", "INVALID_INPUT"];
  ok("every affiliate-facing error code has a message", codes.every((c) => REWARDS_TEXT.fr[`code_${c}`] && REWARDS_TEXT.ar[`code_${c}`]));
  ok("every recipient field error has a message", ["fullName", "phone", "city", "address", "deliveryNotes"].every((f) => REWARDS_TEXT.fr[`err_${f}`] && REWARDS_TEXT.ar[`err_${f}`]));
  ok("placeholders interpolate", rewardsT("fr")("stock_low", { n: 2 }) === "Plus que 2" && rewardsT("ar")("success", { ref: "RW-1" }).includes("RW-1"));
  ok("unknown language → French; Arabic → RTL", rewardsLang("en") === "fr" && rewardsDir("ar") === "rtl" && rewardsDir("fr") === "ltr");
  // cancellationNote: unit cases (incl. a stale stored French string).
  const affHist = [{ toStatus: "PENDING_REVIEW", actorType: "AFFILIATE" }, { toStatus: "CANCELLED", actorType: "AFFILIATE" }];
  const stale = { status: "CANCELLED", cancelReason: "Annulée par l’affilié", history: affHist };
  ok("stored French text on a self-cancel is never shown (AR)", cancellationNote(stale, "ar") === REWARDS_TEXT.ar.cancelled_by_you && !cancellationNote(stale, "ar").includes("Annulée"));
  ok("admin cancel without a reason → label only",
    cancellationNote({ status: "CANCELLED", cancelReason: null, history: [{ toStatus: "CANCELLED", actorType: "ADMIN" }] }, "ar") === REWARDS_TEXT.ar.cancelled_by_team);
  ok("not cancelled → no line", cancellationNote({ status: "REJECTED", cancelReason: "x", history: [] }, "fr") === null && cancellationNote(null, "fr") === null);
  ok("cancellation labels are Arabic in AR", /[\u0600-\u06FF]/.test(REWARDS_TEXT.ar.cancelled_by_you) && /[\u0600-\u06FF]/.test(REWARDS_TEXT.ar.cancelled_by_team));
  ok("placeholders identical in FR and AR",
    fr.every((k) => JSON.stringify((REWARDS_TEXT.fr[k].match(/\{\w+\}/g) || []).sort()) === JSON.stringify((REWARDS_TEXT.ar[k].match(/\{\w+\}/g) || []).sort())));
}

// ── 8. Routes & dashboard integration (static) ───────────────────────────────
console.log("\n8. Routes & UI integration");
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const routes = {
    "../src/app/api/affiliate/rewards/route.js": ["GET"],
    "../src/app/api/affiliate/rewards/ledger/route.js": ["GET"],
    "../src/app/api/affiliate/rewards/redemptions/route.js": ["GET", "POST"],
    "../src/app/api/affiliate/rewards/redemptions/[id]/cancel/route.js": ["POST"],
  };
  const names = Object.keys(affiliateRewardsHandlers({ db: {} }));
  for (const [file, methods] of Object.entries(routes)) {
    const src = read(file);
    const found = [...src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*withAffiliateAuth\(h\.(\w+)\);$/gm)];
    ok(`${file.split("/api/")[1]}: ${methods.join("/")} withAffiliateAuth-wrapped, real handlers`,
      found.map((m) => m[1]).join() === methods.join() && found.every((m) => names.includes(m[2])) && !/export (async )?function/.test(src));
  }
  const page = read("../src/app/affiliate/dashboard/page.jsx");
  ok("dashboard imports RewardsTab", /import RewardsTab from "\.\/RewardsTab";/.test(page));
  ok("desktop tab (French label, like its neighbours)", /\{ id: "rewards",\s+label: "🎁 Récompenses" \}/.test(page));
  ok("mobile « المزيد » entry (Arabic label, like its neighbours)", /\{ icon: Gift,\s+label: "المكافآت",\s+tab: "rewards" \}/.test(page));
  ok("tab rendered", /activeTab === "rewards" && <RewardsTab \/>/.test(page));
  const tab = read("../src/app/affiliate/dashboard/RewardsTab.jsx");
  ok("follows site language (useLanguage + rewardsT) with a local dir", /useLanguage\(\)/.test(tab) && /rewardsT\(lang\)/.test(tab) && /dir=\{dir\}/.test(tab));
  ok("authenticates like the other tabs (Bearer token)", /Authorization: `Bearer \$\{t\}`/.test(tab));
  ok("never sends an affiliate id", !/affiliateId/.test(tab));
  ok("submits with a per-modal idempotency key", /clientRequestId: requestId/.test(tab) && /useState\(newRequestId\)/.test(tab));
  ok("cancel offered only for PENDING_REVIEW", /r\.status === "PENDING_REVIEW" && \(/.test(tab) && (tab.match(/cancelRedemption|\/cancel`/g) || []).length === 1);
  ok("request button follows server eligibility", /disabled=\{!g\.canRedeem\}/.test(tab));
  ok("cancellation shown only via cancellationNote (never the raw stored reason)",
    /cancellationNote\(r, lang\)/.test(tab) && !/\{r\.cancelReason\}/.test(tab));
  ok("no hard-coded user-facing French/Arabic in the tab (all via t())", !/[؀-ۿ]/.test(tab) && !/"(Demander|Annuler|Récompenses)"/.test(tab));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
