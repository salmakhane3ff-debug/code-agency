#!/usr/bin/env node
/**
 * scripts/rewardsService.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards & Gifts — points/ledger + redemption services against the in-memory
 * fake DB (scripts/lib/rewardsFakeDb.mjs: real rollback + per-affiliate locks).
 * Proves:
 *   • launch baseline: orders delivered before launch never earn (D11)
 *   • order points awarded once per delivered order — duplicate, concurrent and
 *     reconcile calls never double count; fake/suspicious/unlinked excluded (D1)
 *   • reversal on cancel, re-award with the ORIGINAL snapshot (D9), debt (D3),
 *     hold period (D4)
 *   • signup bonus once, only for new affiliates (D2)
 *   • audited admin adjustments, idempotent, never below zero
 *   • redemptions: server-side cost/stock, rollback on failure, concurrency,
 *     status machine, refund/restock exactly once, affiliate ownership
 *   • ledger sum == account balance for every affiliate at the end
 *   • separation from commissions + additive migration (static checks)
 * Run: node scripts/rewardsService.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { makeRewardsFakeDb } from "./lib/rewardsFakeDb.mjs";
import {
  getRewardsConfig, saveRewardsConfig, syncOrderRewards, reconcileOrderRewards, awardSignupBonus,
  adjustPoints, getPointsSummary, listLedger, verifyAccountBalance,
} from "../src/lib/services/rewardsService.js";
import { requestRedemption, transitionRedemption } from "../src/lib/services/rewardRedemptionService.js";
import { REDEMPTION_STATUS as S, ACTOR, LEDGER_TYPE } from "../src/lib/rewards.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
async function code(fn) { try { await fn(); return null; } catch (e) { return e.code || e.message; } }

const PRE = new Date("2026-10-01T00:00:00Z");
const LAUNCH = new Date("2026-10-19T10:00:00Z");
const AFTER = new Date("2026-10-20T10:00:00Z");
const ADMIN = { type: ACTOR.ADMIN, id: "admin-1" };
let reqSeq = 0;
const rid = () => `req-${String(++reqSeq).padStart(8, "0")}`;
const recipient = { fullName: "Salma Test", phone: "+212612345678", city: "Casablanca", address: "12 rue des Fleurs" };

function seedDb(extra = {}) {
  return makeRewardsFakeDb({
    affiliate: [
      { id: "A", isActive: true, createdAt: PRE },
      { id: "B", isActive: true, createdAt: PRE },
      { id: "C", isActive: true, createdAt: PRE },
      { id: "OFF", isActive: false, createdAt: PRE },
      ...(extra.affiliate || []),
    ],
    order: [
      { id: "o-pre", isFake: false, affiliateId: "A" },
      { id: "o1", isFake: false, affiliateId: "A" }, { id: "o2", isFake: false, affiliateId: "A" },
      { id: "o3", isFake: false, affiliateId: "A" }, { id: "o-fake", isFake: true, affiliateId: "A" },
      { id: "o-b", isFake: false, affiliateId: "B" }, { id: "o-shared", isFake: false, affiliateId: null },
      ...(extra.order || []),
    ],
    affiliateOrder: [
      { id: "ao-pre", affiliateId: "A", orderId: "o-pre", status: "delivered", isFake: false, isSuspicious: false },
      { id: "ao-preCase", affiliateId: "A", orderId: null, status: "Delivered", isFake: false, isSuspicious: false },
      { id: "ao1", affiliateId: "A", orderId: "o1", status: "pending", isFake: false, isSuspicious: false },
      { id: "ao2", affiliateId: "A", orderId: "o2", status: "pending", isFake: false, isSuspicious: false },
      { id: "ao3", affiliateId: "A", orderId: "o3", status: "pending", isFake: false, isSuspicious: true },
      { id: "ao-fake", affiliateId: "A", orderId: "o-fake", status: "pending", isFake: true, isSuspicious: false },
      { id: "ao-unlinked", affiliateId: "A", orderId: null, status: "pending", isFake: false, isSuspicious: false },
      { id: "ao-b", affiliateId: "B", orderId: "o-b", status: "pending", isFake: false, isSuspicious: false },
      { id: "ao-sh1", affiliateId: "A", orderId: "o-shared", status: "pending", isFake: false, isSuspicious: false },
      { id: "ao-sh2", affiliateId: "B", orderId: "o-shared", status: "pending", isFake: false, isSuspicious: false },
      ...(extra.affiliateOrder || []),
    ],
    rewardGift: extra.rewardGift || [],
  });
}
const setStatus = (db, id, status) => { db._tables.affiliateOrder.find((o) => o.id === id).status = status; };
const ledgerOf = (db, aff) => db._tables.rewardPointsLedger.filter((l) => l.affiliateId === aff);
const balanceOf = (db, aff) => db._tables.rewardPointsAccount.find((a) => a.affiliateId === aff)?.balance ?? 0;
async function launched(db, cfg = {}) {
  return saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10, ...cfg }, { actorId: "admin-1", db, now: LAUNCH });
}

// ── 1. Config & launch baseline (D11) ────────────────────────────────────────
console.log("\n1. Config & launch baseline");
{
  const db = seedDb();
  ok("default config: rewards OFF", (await getRewardsConfig(db)).enabled === false);
  ok("sync while OFF awards nothing", (await syncOrderRewards("ao-pre", { db, now: PRE })).reason === "REWARDS_DISABLED");

  const { config, baselineExcluded } = await launched(db, { launchedAt: "1999-01-01T00:00:00Z" });
  ok("enable sets launchedAt/enabledAt = now (input timestamps ignored)",
    config.launchedAt === LAUNCH.toISOString() && config.enabledAt === LAUNCH.toISOString());
  ok("baseline excludes the 2 orders already delivered (incl. 'Delivered' casing)", baselineExcluded === 2);
  const ex = db._tables.rewardOrderAward.filter((a) => a.state === "EXCLUDED").map((a) => a.affiliateOrderId).sort();
  ok("excluded rows are the pre-launch deliveries", JSON.stringify(ex) === JSON.stringify(["ao-pre", "ao-preCase"]));
  ok("pre-launch delivery never awarded (D11)", (await syncOrderRewards("ao-pre", { db, now: AFTER })).reason === "PRE_LAUNCH");
  setStatus(db, "ao-preCase", "delivered");
  ok("pre-launch 'Delivered' fixed to 'delivered' later is still excluded", (await syncOrderRewards("ao-preCase", { db, now: AFTER })).reason === "PRE_LAUNCH");
  ok("no ledger rows from pre-launch orders", db._tables.rewardPointsLedger.length === 0);
  const audit = db._tables.rewardAuditLog;
  ok("config change audited with before/after + actor",
    audit.length === 1 && audit[0].actorId === "admin-1" && audit[0].before.enabled === false && audit[0].after.enabled === true);

  const again = await saveRewardsConfig({ pointsPerDeliveredOrder: 20, signupBonusEnabled: true, signupBonusPoints: 5 }, { db, now: AFTER });
  ok("later save keeps launchedAt", again.config.launchedAt === LAUNCH.toISOString());
  ok("no second baseline when already enabled", again.baselineExcluded === 0);
  ok("bonus toggle stamps signupBonusEnabledAt", again.config.signupBonusEnabledAt === AFTER.toISOString());
  ok("every save audited", db._tables.rewardAuditLog.length === 2);
}

// ── 2. Order award idempotency ───────────────────────────────────────────────
console.log("\n2. Order awards");
{
  const db = seedDb();
  await launched(db);
  ok("not delivered → nothing", (await syncOrderRewards("ao1", { db, now: AFTER })).reason === "NOT_DELIVERED");
  setStatus(db, "ao1", "delivered");
  const r = await syncOrderRewards("ao1", { db, now: AFTER });
  ok("delivered after launch → awarded 10", r.action === "awarded" && r.points === 10);
  ok("ledger row ORDER_DELIVERED with key v1",
    ledgerOf(db, "A").length === 1 && ledgerOf(db, "A")[0].type === LEDGER_TYPE.ORDER_DELIVERED
    && ledgerOf(db, "A")[0].idempotencyKey === "order:ao1:award:v1" && ledgerOf(db, "A")[0].balanceAfter === 10);
  ok("account balance 10", balanceOf(db, "A") === 10);

  for (let i = 0; i < 5; i++) await syncOrderRewards("ao1", { db, now: AFTER });
  const par = await Promise.all(Array.from({ length: 10 }, () => syncOrderRewards("ao1", { db, now: AFTER })));
  ok("5 repeats + 10 concurrent syncs → still one award", ledgerOf(db, "A").length === 1 && par.every((x) => x.action === "noop"));

  setStatus(db, "ao2", "delivered");
  const conc = await Promise.all(Array.from({ length: 8 }, () => syncOrderRewards("ao2", { db, now: AFTER })));
  ok("8 concurrent first syncs → exactly one 'awarded'", conc.filter((x) => x.action === "awarded").length === 1);
  ok("balance 20 after two orders", balanceOf(db, "A") === 20);

  for (const [id, reason] of [["ao3", "SUSPICIOUS"], ["ao-fake", "FAKE_ORDER"], ["ao-unlinked", "NOT_LINKED"]]) {
    setStatus(db, id, "delivered");
    ok(`${id} → ${reason}, no points`, (await syncOrderRewards(id, { db, now: AFTER })).reason === reason);
  }
  db._tables.order.find((o) => o.id === "o-b").affiliateId = "A";
  setStatus(db, "ao-b", "delivered");
  ok("store order attributed to someone else → AFFILIATE_MISMATCH", (await syncOrderRewards("ao-b", { db, now: AFTER })).reason === "AFFILIATE_MISMATCH");

  setStatus(db, "ao-sh1", "delivered"); setStatus(db, "ao-sh2", "delivered");
  const s1 = await syncOrderRewards("ao-sh1", { db, now: AFTER });
  const s2 = await syncOrderRewards("ao-sh2", { db, now: AFTER });
  ok("one store order shared by two affiliate orders pays once",
    s1.action === "awarded" && s2.reason === "DUPLICATE_ORDER" && ledgerOf(db, "B").length === 0);
  ok("unknown / invalid ids are harmless",
    (await syncOrderRewards("nope", { db })).reason === "NOT_FOUND" && (await syncOrderRewards({ in: [] }, { db })).reason === "INVALID_ID");
  ok("rejected sync attempts rolled back nothing / wrote nothing", ledgerOf(db, "A").length === 3);

  const db2 = seedDb();
  await launched(db2, { excludeSuspicious: false });
  setStatus(db2, "ao3", "delivered");
  ok("suspicious order earns when excludeSuspicious is OFF (D1 toggle)", (await syncOrderRewards("ao3", { db: db2, now: AFTER })).action === "awarded");
}

// ── 3. Reversal, snapshot re-award (D9), debt (D3) ───────────────────────────
console.log("\n3. Reversal & re-award");
{
  const db = seedDb();
  await launched(db);
  setStatus(db, "ao1", "delivered");
  await syncOrderRewards("ao1", { db, now: AFTER });
  await saveRewardsConfig({ pointsPerDeliveredOrder: 50 }, { db, now: AFTER });

  setStatus(db, "ao1", "cancelled");
  const rv = await syncOrderRewards("ao1", { db, now: AFTER });
  ok("delivered → cancelled reverses 10", rv.action === "reversed" && rv.points === 10 && balanceOf(db, "A") === 0);
  ok("reversal key v1", ledgerOf(db, "A").at(-1).idempotencyKey === "order:ao1:reverse:v1" && ledgerOf(db, "A").at(-1).delta === -10);
  await syncOrderRewards("ao1", { db, now: AFTER });
  ok("repeat sync after reversal → no second reversal", ledgerOf(db, "A").length === 2);

  setStatus(db, "ao1", "delivered");
  const ra = await syncOrderRewards("ao1", { db, now: AFTER });
  ok("re-delivered → re-awarded with ORIGINAL 10, not current 50 (D9)", ra.action === "reawarded" && ra.points === 10 && balanceOf(db, "A") === 10);
  ok("re-award key v2", ledgerOf(db, "A").at(-1).idempotencyKey === "order:ao1:award:v2");
  ok("award row version 2, snapshot unchanged",
    (() => { const a = db._tables.rewardOrderAward.find((x) => x.affiliateOrderId === "ao1"); return a.version === 2 && a.points === 10 && a.state === "AWARDED"; })());

  await saveRewardsConfig({ enabled: false }, { db, now: AFTER });
  setStatus(db, "ao1", "cancelled");
  ok("reversal still applies while rewards are OFF", (await syncOrderRewards("ao1", { db, now: AFTER })).action === "reversed");
  setStatus(db, "ao1", "delivered");
  ok("no re-award while rewards are OFF", (await syncOrderRewards("ao1", { db, now: AFTER })).reason === "REWARDS_DISABLED");

  // D3 — reversal after the points were spent creates a debt that blocks spending.
  const db3 = seedDb({ rewardGift: [{ id: "g", name: "Mug", description: "", images: [], pointsCost: 10, stock: 5, isActive: true, archivedAt: null }] });
  await launched(db3);
  setStatus(db3, "ao1", "delivered");
  await syncOrderRewards("ao1", { db: db3, now: AFTER });
  await requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db: db3, now: AFTER });
  setStatus(db3, "ao1", "cancelled");
  await syncOrderRewards("ao1", { db: db3, now: AFTER });
  const sum = await getPointsSummary("A", { db: db3, now: AFTER });
  ok("reversal after spending → balance −10, debt 10 (D3)", sum.balance === -10 && sum.debt === 10 && sum.spendable === 0);
  ok("debt blocks new requests",
    (await code(() => requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db: db3, now: AFTER }))) === "INSUFFICIENT_POINTS");
}

// ── 4. Hold period (D4) ──────────────────────────────────────────────────────
console.log("\n4. Hold period");
{
  const db = seedDb({ rewardGift: [{ id: "g", name: "Mug", description: "", images: [], pointsCost: 10, stock: 5, isActive: true, archivedAt: null }] });
  await launched(db, { orderPointsHoldDays: 7 });
  setStatus(db, "ao1", "delivered");
  await syncOrderRewards("ao1", { db, now: AFTER });
  const s = await getPointsSummary("A", { db, now: AFTER });
  ok("points held for 7 days", s.balance === 10 && s.held === 10 && s.spendable === 0);
  ok("held points cannot be spent",
    (await code(() => requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db, now: AFTER }))) === "INSUFFICIENT_POINTS");
  const later = new Date(AFTER.getTime() + 8 * 86_400_000);
  ok("spendable after the hold", (await getPointsSummary("A", { db, now: later })).spendable === 10);
  ok("redeemable after the hold",
    (await requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db, now: later })).duplicate === false);
}

// ── 5. Reconcile (missed hooks) ──────────────────────────────────────────────
console.log("\n5. Reconcile");
{
  const db = seedDb();
  await launched(db);
  setStatus(db, "ao1", "delivered"); setStatus(db, "ao2", "delivered");
  await syncOrderRewards("ao2", { db, now: AFTER });
  setStatus(db, "ao2", "cancelled");          // reversal hook missed
  setStatus(db, "ao-b", "delivered");         // award hook missed
  const t = await reconcileOrderRewards({ db, now: AFTER, batchSize: 2 });
  ok("reconcile awards missed deliveries", t.awarded === 2);
  ok("reconcile reverses missed cancellations", t.reversed === 1);
  ok("pre-launch + ineligible orders untouched", t.errors === 0 && !db._tables.rewardPointsLedger.some((l) => l.sourceId === "ao-pre"));
  const t2 = await reconcileOrderRewards({ db, now: AFTER });
  ok("second reconcile changes nothing", t2.awarded === 0 && t2.reversed === 0 && t2.reawarded === 0);
  setStatus(db, "ao2", "delivered");
  ok("reconcile re-awards re-delivered orders", (await reconcileOrderRewards({ db, now: AFTER })).reawarded === 1);
}

// ── 6. Signup bonus (D2) ─────────────────────────────────────────────────────
console.log("\n6. Signup bonus");
{
  const NEW = new Date("2026-10-21T00:00:00Z");
  const db = seedDb({ affiliate: [{ id: "NEW", isActive: true, createdAt: NEW }, { id: "MID", isActive: true, createdAt: AFTER }] });
  await launched(db);
  ok("bonus disabled → nothing", (await awardSignupBonus("NEW", { db })).reason === "BONUS_DISABLED");
  await saveRewardsConfig({ signupBonusEnabled: true, signupBonusPoints: 25 }, { db, now: new Date("2026-10-20T12:00:00Z") });
  ok("existing affiliate (created before launch) gets nothing", (await awardSignupBonus("A", { db })).reason === "EXISTING_AFFILIATE");
  ok("affiliate created while bonus was OFF gets nothing", (await awardSignupBonus("MID", { db })).reason === "EXISTING_AFFILIATE");
  const res = await Promise.all([awardSignupBonus("NEW", { db }), awardSignupBonus("NEW", { db }), awardSignupBonus("NEW", { db })]);
  ok("new affiliate gets the bonus exactly once (3 concurrent calls)",
    res.filter((r) => r.awarded).length === 1 && ledgerOf(db, "NEW").length === 1 && balanceOf(db, "NEW") === 25);
  ok("ledger key signup:NEW", ledgerOf(db, "NEW")[0].idempotencyKey === "signup:NEW");
  ok("later call → ALREADY_AWARDED", (await awardSignupBonus("NEW", { db })).reason === "ALREADY_AWARDED");
  db._tables.affiliate.push({ id: "NEWOFF", isActive: false, createdAt: NEW });
  ok("inactive new affiliate gets nothing", (await awardSignupBonus("NEWOFF", { db })).reason === "AFFILIATE_INACTIVE");
}

// ── 7. Admin adjustments ─────────────────────────────────────────────────────
console.log("\n7. Admin adjustments");
{
  const db = seedDb();
  const base = { affiliateId: "A", reason: "Geste commercial", actorId: "admin-1" };
  ok("reason required", (await code(() => adjustPoints({ ...base, delta: 5, reason: "x", clientRequestId: rid() }, { db }))) === "INVALID_INPUT");
  ok("zero / float delta rejected",
    (await code(() => adjustPoints({ ...base, delta: 0, clientRequestId: rid() }, { db }))) === "INVALID_INPUT"
    && (await code(() => adjustPoints({ ...base, delta: 2.5, clientRequestId: rid() }, { db }))) === "INVALID_INPUT");
  ok("admin id required", (await code(() => adjustPoints({ ...base, actorId: "", delta: 5, clientRequestId: rid() }, { db }))) === "INVALID_INPUT");
  ok("unknown affiliate", (await code(() => adjustPoints({ ...base, affiliateId: "ZZ", delta: 5, clientRequestId: rid() }, { db }))) === "AFFILIATE_NOT_FOUND");
  const key = rid();
  const a1 = await adjustPoints({ ...base, delta: 40, clientRequestId: key }, { db });
  ok("credit recorded with admin + reason",
    a1.entry.type === LEDGER_TYPE.ADMIN_ADJUSTMENT && a1.entry.actorType === "ADMIN" && a1.entry.actorId === "admin-1"
    && a1.entry.reason === "Geste commercial" && balanceOf(db, "A") === 40);
  const a2 = await adjustPoints({ ...base, delta: 40, clientRequestId: key }, { db });
  ok("retry with same request id → no duplicate", a2.duplicate && ledgerOf(db, "A").length === 1);
  ok("same request id, different value → conflict", (await code(() => adjustPoints({ ...base, delta: 41, clientRequestId: key }, { db }))) === "IDEMPOTENCY_CONFLICT");
  ok("debit below zero refused (D3)", (await code(() => adjustPoints({ ...base, delta: -41, clientRequestId: rid() }, { db }))) === "INSUFFICIENT_POINTS");
  ok("debit to exactly zero allowed", (await adjustPoints({ ...base, delta: -40, clientRequestId: rid() }, { db })).entry.balanceAfter === 0);
}

// ── 8. Redemptions ───────────────────────────────────────────────────────────
console.log("\n8. Redemptions");
const gifts = () => [
  { id: "g", name: "Casque", description: "Bluetooth", images: ["https://cdn/x.webp"], pointsCost: 30, stock: 10, isActive: true, archivedAt: null },
  { id: "g-last", name: "Montre", description: "", images: [], pointsCost: 10, stock: 2, isActive: true, archivedAt: null },
  { id: "g-off", name: "Off", description: "", images: [], pointsCost: 10, stock: 5, isActive: false, archivedAt: null },
  { id: "g-arch", name: "Old", description: "", images: [], pointsCost: 10, stock: 5, isActive: true, archivedAt: new Date() },
  { id: "g-limit", name: "Lim", description: "", images: [], pointsCost: 1, stock: 5, isActive: true, archivedAt: null, maxPerAffiliate: 1 },
  { id: "g-min", name: "Min", description: "", images: [], pointsCost: 1, stock: 5, isActive: true, archivedAt: null, minDeliveredOrders: 3 },
];
async function funded(points, cfg = {}) {
  const db = seedDb({ rewardGift: gifts() });
  await launched(db, cfg);
  for (const aff of ["A", "B", "C"]) await adjustPoints({ affiliateId: aff, delta: points, reason: "Solde de test", clientRequestId: rid(), actorId: "admin-1" }, { db });
  return db;
}
const stockOf = (db, id) => db._tables.rewardGift.find((g) => g.id === id).stock;
{
  const db = await funded(100);
  const key = rid();
  const { redemption: red } = await requestRedemption(
    { affiliateId: "A", giftId: "g", recipient, clientRequestId: key, pointsCost: 1, stock: 999 }, { db, now: AFTER });
  ok("request created PENDING_REVIEW", red.status === S.PENDING_REVIEW);
  ok("cost taken from the DB (browser pointsCost ignored)", red.pointsCost === 30 && balanceOf(db, "A") === 70);
  ok("stock reserved", stockOf(db, "g") === 9);
  ok("reference format", /^RW-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/.test(red.reference));
  ok("gift snapshot stored", red.giftSnapshot.name === "Casque" && red.giftSnapshot.image === "https://cdn/x.webp" && red.giftSnapshot.pointsCost === 30);
  ok("debit ledger row", ledgerOf(db, "A").some((l) => l.type === LEDGER_TYPE.REDEMPTION_DEBIT && l.delta === -30 && l.idempotencyKey === `redemption:${red.id}:debit`));
  ok("history row created", db._tables.rewardRedemptionHistory.filter((h) => h.redemptionId === red.id).length === 1);
  const dup = await requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: key }, { db, now: AFTER });
  ok("double submit (same request id) → same request, one debit",
    dup.duplicate && dup.redemption.id === red.id && balanceOf(db, "A") === 70 && stockOf(db, "g") === 9);
  ok("same request id for another gift → conflict",
    (await code(() => requestRedemption({ affiliateId: "A", giftId: "g-last", recipient, clientRequestId: key }, { db, now: AFTER }))) === "IDEMPOTENCY_CONFLICT");

  const c = async (patch) => code(() => requestRedemption({ affiliateId: "B", giftId: "g", recipient, clientRequestId: rid(), ...patch }, { db, now: AFTER }));
  ok("inactive gift → GIFT_UNAVAILABLE", (await c({ giftId: "g-off" })) === "GIFT_UNAVAILABLE");
  ok("archived gift → GIFT_UNAVAILABLE", (await c({ giftId: "g-arch" })) === "GIFT_UNAVAILABLE");
  ok("unknown gift → GIFT_UNAVAILABLE", (await c({ giftId: "nope" })) === "GIFT_UNAVAILABLE");
  ok("inactive affiliate → AFFILIATE_INACTIVE", (await c({ affiliateId: "OFF" })) === "AFFILIATE_INACTIVE");
  ok("min delivered orders → MIN_ORDERS_NOT_MET", (await c({ giftId: "g-min" })) === "MIN_ORDERS_NOT_MET");
  ok("invalid recipient → INVALID_INPUT", (await c({ recipient: { ...recipient, phone: "12" } })) === "INVALID_INPUT");
  ok("invalid request id → INVALID_INPUT", (await c({ clientRequestId: "x" })) === "INVALID_INPUT");
  await requestRedemption({ affiliateId: "B", giftId: "g-limit", recipient, clientRequestId: rid() }, { db, now: AFTER });
  ok("per-affiliate gift limit → GIFT_LIMIT_REACHED", (await c({ giftId: "g-limit" })) === "GIFT_LIMIT_REACHED");
  await requestRedemption({ affiliateId: "B", giftId: "g", recipient, clientRequestId: rid() }, { db, now: AFTER });
  await requestRedemption({ affiliateId: "B", giftId: "g", recipient, clientRequestId: rid() }, { db, now: AFTER });
  ok("open-request limit (3) → TOO_MANY_OPEN_REQUESTS", (await c({})) === "TOO_MANY_OPEN_REQUESTS");

  // Insufficient points → whole transaction rolled back (stock untouched).
  const poor = await funded(20);
  const before = stockOf(poor, "g");
  ok("insufficient points → INSUFFICIENT_POINTS",
    (await code(() => requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db: poor, now: AFTER }))) === "INSUFFICIENT_POINTS");
  ok("…stock and points unchanged", stockOf(poor, "g") === before && balanceOf(poor, "A") === 20 && poor._tables.rewardRedemption.length === 0);

  // Out of stock after the gate passed (stock changed under us) → rolled back.
  const empty = await funded(100);
  empty._tables.rewardGift.find((g) => g.id === "g-last").stock = 0;
  ok("out of stock → OUT_OF_STOCK, no debit",
    (await code(() => requestRedemption({ affiliateId: "A", giftId: "g-last", recipient, clientRequestId: rid() }, { db: empty, now: AFTER }))) === "OUT_OF_STOCK"
    && balanceOf(empty, "A") === 100);

  const off = await funded(100);
  await saveRewardsConfig({ enabled: false }, { db: off, now: AFTER });
  ok("rewards disabled → REWARDS_DISABLED",
    (await code(() => requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db: off, now: AFTER }))) === "REWARDS_DISABLED");
}

// ── 9. Concurrency ───────────────────────────────────────────────────────────
console.log("\n9. Concurrency");
{
  // Balance covers 3 gifts of 30 (=90 of 100); 20 parallel requests.
  const db = await funded(100, { maxOpenRedemptions: 50 });
  const reservationsBefore = db._stats.calls["rewardGift.updateMany"] || 0;
  const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
    requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db, now: AFTER })));
  const won = results.filter((r) => r.status === "fulfilled").length;
  ok("20 concurrent requests, points for 3 → exactly 3 succeed", won === 3);
  ok("others fail with INSUFFICIENT_POINTS",
    results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "INSUFFICIENT_POINTS"));
  ok("balance 10, never negative; stock 7", balanceOf(db, "A") === 10 && stockOf(db, "g") === 7);
  ok("account lock serialises: only the 3 winners reach stock reservation",
    (db._stats.calls["rewardGift.updateMany"] || 0) - reservationsBefore === 3);

  // Last units: stock 2, three affiliates race.
  const db2 = await funded(100);
  const race = await Promise.allSettled(["A", "B", "C"].map((aff) =>
    requestRedemption({ affiliateId: aff, giftId: "g-last", recipient, clientRequestId: rid() }, { db: db2, now: AFTER })));
  ok("stock 2, 3 affiliates race → exactly 2 succeed", race.filter((r) => r.status === "fulfilled").length === 2);
  ok("loser gets OUT_OF_STOCK and keeps their points",
    (() => { const lost = race.findIndex((r) => r.status === "rejected"); return race[lost].reason.code === "OUT_OF_STOCK" && balanceOf(db2, ["A", "B", "C"][lost]) === 100; })());
  ok("stock ends at 0, never negative", stockOf(db2, "g-last") === 0);
}

// ── 10. Status transitions, refunds, ownership ───────────────────────────────
console.log("\n10. Transitions");
{
  const db = await funded(100, { maxOpenRedemptions: 50 });
  const make = async (aff = "A", giftId = "g") => (await requestRedemption({ affiliateId: aff, giftId, recipient, clientRequestId: rid() }, { db, now: AFTER })).redemption;
  const t = (id, toStatus, extra = {}) => transitionRedemption({ redemptionId: id, toStatus, actor: ADMIN, ...extra }, { db, now: AFTER });

  const r1 = await make();
  await t(r1.id, S.APPROVED); await t(r1.id, S.PREPARING);
  ok("SHIPPED without carrier refused", (await code(() => t(r1.id, S.SHIPPED))) === "INVALID_INPUT");
  ok("bad tracking URL refused", (await code(() => t(r1.id, S.SHIPPED, { carrierName: "Amana", trackingUrl: "javascript:alert(1)" }))) === "INVALID_INPUT");
  await t(r1.id, S.SHIPPED, { carrierName: "Amana", trackingNumber: "AM123", carrierId: "sc-1" });
  await t(r1.id, S.IN_TRANSIT);
  const done = await t(r1.id, S.DELIVERED, { note: "Remis en main propre" });
  ok("full lifecycle reaches DELIVERED with tracking", done.status === S.DELIVERED && done.trackingNumber === "AM123" && done.carrierName === "Amana");
  ok("milestone timestamps set", done.approvedAt && done.preparingAt && done.shippedAt && done.deliveredAt && done.closedAt);
  ok("history has 6 rows (create + 5 moves)", db._tables.rewardRedemptionHistory.filter((h) => h.redemptionId === r1.id).length === 6);
  ok("DELIVERED is final", (await code(() => t(r1.id, S.PREPARING))) === "INVALID_TRANSITION");
  ok("delivered request: no refund", !ledgerOf(db, "A").some((l) => l.type === LEDGER_TYPE.REDEMPTION_REFUND));

  const r2 = await make();
  ok("skipping steps refused (PENDING_REVIEW → SHIPPED)", (await code(() => t(r2.id, S.SHIPPED, { carrierName: "X" }))) === "INVALID_TRANSITION");
  ok("reject needs a reason", (await code(() => t(r2.id, S.REJECTED))) === "INVALID_INPUT");
  const balBefore = balanceOf(db, "A"); const stockBefore = stockOf(db, "g");
  const both = await Promise.allSettled([t(r2.id, S.REJECTED, { reason: "Adresse incomplète" }), t(r2.id, S.REJECTED, { reason: "Adresse incomplète" })]);
  ok("double reject (concurrent) → applied once", both.filter((x) => x.status === "fulfilled").length === 1);
  ok("reject refunds 30 once and restocks once", balanceOf(db, "A") === balBefore + 30 && stockOf(db, "g") === stockBefore + 1);
  ok("refund ledger key unique", ledgerOf(db, "A").filter((l) => l.idempotencyKey === `redemption:${r2.id}:refund`).length === 1);
  ok("rejected cannot be cancelled later", (await code(() => t(r2.id, S.CANCELLED, { reason: "Encore une fois" }))) === "INVALID_TRANSITION");

  const r3 = await make();
  await t(r3.id, S.APPROVED); await t(r3.id, S.PREPARING);
  ok("admin cancel needs a reason", (await code(() => t(r3.id, S.CANCELLED))) === "INVALID_INPUT");
  const b3 = balanceOf(db, "A");
  await t(r3.id, S.CANCELLED, { reason: "Rupture fournisseur" });
  ok("cancel from PREPARING refunds", balanceOf(db, "A") === b3 + 30);

  // D6 — affiliate cancels own pending request; ownership enforced.
  const r4 = await make("A");
  const asB = { type: ACTOR.AFFILIATE, id: "B" }; const asA = { type: ACTOR.AFFILIATE, id: "A" };
  ok("affiliate B cannot cancel A's request (looks missing)",
    (await code(() => transitionRedemption({ redemptionId: r4.id, toStatus: S.CANCELLED, actor: asB }, { db }))) === "NOT_FOUND");
  ok("affiliate cannot approve", (await code(() => transitionRedemption({ redemptionId: r4.id, toStatus: S.APPROVED, actor: asA }, { db }))) === "INVALID_TRANSITION");
  const b4 = balanceOf(db, "A");
  const c4 = await transitionRedemption({ redemptionId: r4.id, toStatus: S.CANCELLED, actor: asA }, { db, now: AFTER });
  ok("affiliate cancels own pending request → refunded", c4.status === S.CANCELLED && balanceOf(db, "A") === b4 + 30);
  const r5 = await make("A"); await t(r5.id, S.APPROVED);
  ok("affiliate cannot cancel once approved", (await code(() => transitionRedemption({ redemptionId: r5.id, toStatus: S.CANCELLED, actor: asA }, { db }))) === "INVALID_TRANSITION");
  ok("missing / invalid actor refused", (await code(() => transitionRedemption({ redemptionId: r5.id, toStatus: S.PREPARING, actor: { type: "SYSTEM", id: "x" } }, { db }))) === "INVALID_INPUT");

  // D5 — RETURNED with explicit choices.
  const r6 = await make("A");
  await t(r6.id, S.APPROVED); await t(r6.id, S.PREPARING); await t(r6.id, S.SHIPPED, { carrierName: "Amana" });
  ok("RETURNED requires explicit refund/restock booleans", (await code(() => t(r6.id, S.RETURNED, { refundPoints: true }))) === "INVALID_INPUT");
  const b6 = balanceOf(db, "A"); const s6 = stockOf(db, "g");
  await t(r6.id, S.RETURNED, { refundPoints: true, restock: false });
  ok("RETURNED refund yes / restock no", balanceOf(db, "A") === b6 + 30 && stockOf(db, "g") === s6);
}

// ── 11. Reads & ledger invariants ────────────────────────────────────────────
console.log("\n11. Summary, ledger, invariants");
{
  const db = await funded(100);
  setStatus(db, "ao1", "delivered");
  await syncOrderRewards("ao1", { db, now: AFTER });
  const { redemption } = await requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db, now: AFTER });
  await transitionRedemption({ redemptionId: redemption.id, toStatus: S.REJECTED, actor: ADMIN, reason: "Test de refus" }, { db, now: AFTER });
  await requestRedemption({ affiliateId: "A", giftId: "g", recipient, clientRequestId: rid() }, { db, now: AFTER });
  const s = await getPointsSummary("A", { db, now: AFTER });
  ok("summary: earned 110 (100 adjust + 10 order), redeemed 30 net, balance 80",
    s.totalEarned === 110 && s.totalRedeemed === 30 && s.balance === 80 && s.spendable === 80 && s.debt === 0);
  const p1 = await listLedger("A", { db, take: 2 });
  const p2 = await listLedger("A", { db, take: 2, cursor: p1.nextCursor });
  ok("ledger pagination", p1.items.length === 2 && p1.nextCursor && p2.items.length === 2
    && !p2.items.some((x) => p1.items.find((y) => y.id === x.id)));
}
{
  // Re-run a mixed scenario and check every affiliate's books balance.
  const db = await funded(100, { maxOpenRedemptions: 50 });
  for (const id of ["ao1", "ao2", "ao-b"]) { setStatus(db, id, "delivered"); await syncOrderRewards(id, { db, now: AFTER }); }
  setStatus(db, "ao2", "cancelled"); await reconcileOrderRewards({ db, now: AFTER });
  await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
    requestRedemption({ affiliateId: i % 2 ? "A" : "B", giftId: "g", recipient, clientRequestId: rid() }, { db, now: AFTER })));
  const checks = await Promise.all(["A", "B", "C"].map((a) => verifyAccountBalance(a, { db })));
  ok("ledger sum == account balance for every affiliate", checks.every((c) => c.ok));
  ok("ledger never mutated in place (no balanceAfter gaps per affiliate)",
    ["A", "B", "C"].every((a) => {
      const rows = ledgerOf(db, a); let run = 0;
      return rows.every((r) => (run += r.delta) === r.balanceAfter);
    }));
  ok("failed transactions were rolled back (stats)", db._stats.rollbacks >= 0 && db._tables.rewardRedemption.every((r) => r.pointsCost > 0));
}

// ── 12a. Launch-baseline race (D11 hardening) ────────────────────────────────
console.log("\n12a. Launch-baseline race");
const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
{
  // Statement order inside the enabling transaction.
  const db = seedDb();
  await launched(db);
  const log = db._stats.log;
  const lockIdx = log.findIndex((e) => e.call === "$executeRaw" && /LOCK TABLE "affiliate_orders" IN SHARE MODE/.test(e.sql));
  const tx = log[lockIdx]?.tx;
  const inTx = log.filter((e) => e.tx === tx).map((e) => e.call === "$executeRaw" ? e.sql : e.call);
  const pos = (pred) => inTx.findIndex(pred);
  ok("table lock taken inside the enabling transaction", lockIdx >= 0 && tx != null);
  ok("settings row locked first (serialises saves)", inTx[0] === "setting.upsert");
  ok("lock_timeout set before the table lock",
    pos((x) => /SET LOCAL lock_timeout = '15s'/.test(x)) >= 0 && pos((x) => /SET LOCAL lock_timeout/.test(x)) < pos((x) => /LOCK TABLE/.test(x)));
  ok("table lock taken BEFORE the baseline reads", pos((x) => /LOCK TABLE/.test(x)) < pos((x) => x === "affiliateOrder.findMany"));
  ok("config written and audited after the baseline, same transaction",
    pos((x) => x === "affiliateOrder.findMany") < pos((x) => x === "setting.update") && pos((x) => x === "setting.update") < pos((x) => x === "rewardAuditLog.create"));
  const before = log.length;
  await saveRewardsConfig({ pointsPerDeliveredOrder: 15 }, { db, now: AFTER });
  ok("no table lock when rewards are already ON", !log.slice(before).some((e) => e.call === "$executeRaw"));
}
async function raceAtCommit({ disableLock }) {
  // A status change attempted while the enabling transaction is about to commit.
  const db = seedDb();
  db._stats.disableTableLock = disableLock;
  let statusSeenBeforeCommit = null; let pending = null;
  db._stats.hooks["setting.update"] = async ({ ctx }) => {
    if (!ctx || pending) return;
    pending = db.affiliateOrder.update({ where: { id: "ao1" }, data: { status: "delivered" } });
    await ticks();
    statusSeenBeforeCommit = db._tables.affiliateOrder.find((o) => o.id === "ao1").status;
  };
  await launched(db);
  await pending;
  return { db, statusSeenBeforeCommit, award: db._tables.rewardOrderAward.find((a) => a.affiliateOrderId === "ao1") };
}
{
  const r = await raceAtCommit({ disableLock: false });
  ok("with the lock: a concurrent status change waits until rewards are ON", r.statusSeenBeforeCommit === "pending");
  ok("…it lands after the switch and is NOT excluded", r.award === undefined && r.db._tables.affiliateOrder.find((o) => o.id === "ao1").status === "delivered");
  ok("…and earns, as a genuine post-launch delivery", (await syncOrderRewards("ao1", { db: r.db, now: AFTER })).action === "awarded");
  const neg = await raceAtCommit({ disableLock: true });
  ok("negative control (no lock): the change slips in before the switch, un-excluded — the race the lock closes",
    neg.statusSeenBeforeCommit === "delivered" && neg.award === undefined);
}
{
  // A delivery committed before the lock is seen by the baseline.
  const db = seedDb();
  setStatus(db, "ao1", "delivered");
  await launched(db);
  ok("delivery committed before enabling → EXCLUDED",
    db._tables.rewardOrderAward.find((a) => a.affiliateOrderId === "ao1")?.state === "EXCLUDED");
}
{
  // Two admins enable at once: serialised — one baseline, no lost update.
  const db = seedDb();
  const [a, b] = await Promise.all([
    saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: LAUNCH }),
    saveRewardsConfig({ enabled: true, signupBonusPoints: 5 }, { db, now: LAUNCH }),
  ]);
  ok("concurrent enables: baseline runs once", a.baselineExcluded + b.baselineExcluded === 2
    && db._tables.rewardOrderAward.filter((x) => x.state === "EXCLUDED").length === 2);
  const final = await getRewardsConfig(db);
  ok("concurrent saves: both changes kept (no lost update)", final.pointsPerDeliveredOrder === 10 && final.signupBonusPoints === 5);
  ok("concurrent saves: both audited", db._tables.rewardAuditLog.length === 2);
}
{
  // Lock timeout → clean, retryable error; nothing changes.
  const db = seedDb();
  setStatus(db, "ao1", "delivered");
  db._stats.failTableLock = Object.assign(new Error("canceling statement due to lock timeout"), { code: "P2010", meta: { code: "55P03" } });
  ok("lock timeout → BASELINE_LOCK_TIMEOUT", (await code(() => launched(db))) === "BASELINE_LOCK_TIMEOUT");
  ok("…config unchanged, no baseline rows, no audit",
    (await getRewardsConfig(db)).enabled === false && db._tables.rewardOrderAward.length === 0 && db._tables.rewardAuditLog.length === 0);
  ok("…released: a retry succeeds", (db._stats.failTableLock = null, (await launched(db)).config.enabled === true));
}
{
  // Re-enable after a pause: nothing delivered while OFF earns.
  const db = seedDb();
  await launched(db);
  setStatus(db, "ao1", "delivered"); setStatus(db, "ao2", "delivered");
  await syncOrderRewards("ao1", { db, now: AFTER });
  await syncOrderRewards("ao2", { db, now: AFTER });
  await saveRewardsConfig({ enabled: false }, { db, now: AFTER });
  setStatus(db, "ao1", "cancelled"); await syncOrderRewards("ao1", { db, now: AFTER });   // reversed while OFF
  setStatus(db, "ao1", "delivered");                                                     // re-delivered while OFF
  setStatus(db, "ao-b", "delivered");                                                    // first delivered while OFF
  const re = await saveRewardsConfig({ enabled: true }, { db, now: new Date("2026-10-25T00:00:00Z") });
  const st = (id) => db._tables.rewardOrderAward.find((a) => a.affiliateOrderId === id);
  ok("re-enable keeps launchedAt, moves enabledAt", re.config.launchedAt === LAUNCH.toISOString() && re.config.enabledAt === "2026-10-25T00:00:00.000Z");
  ok("re-delivered while OFF → EXCLUDED (DISABLED_PERIOD)", st("ao1").state === "EXCLUDED" && st("ao1").exclusionReason === "DISABLED_PERIOD");
  ok("first delivered while OFF → EXCLUDED (DISABLED_PERIOD)", st("ao-b").state === "EXCLUDED" && st("ao-b").exclusionReason === "DISABLED_PERIOD");
  ok("points earned while ON are kept", st("ao2").state === "AWARDED");
  const t = await reconcileOrderRewards({ db, now: AFTER });
  ok("reconcile after re-enable awards nothing from the OFF period", t.awarded === 0 && t.reawarded === 0);
  ok("books still balance", (await verifyAccountBalance("A", { db })).ok);
}

// ── 12b. rewards-config cannot be written through the generic settings API ───
console.log("\n12b. Reserved settings row");
{
  const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");
  const post = (type) => upsertSettingsHandler(new Request(`http://x/api/setting?type=${type}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, launchedAt: "1999-01-01T00:00:00Z" }),
  }));
  const res = await post("rewards-config");
  ok("POST /api/setting?type=rewards-config → 400 (baseline/audit cannot be bypassed)", res.status === 400);
  ok("…with a clear message", /page dédiée/.test((await res.json()).error || ""));
}

// ── 12. Static: separation from commissions, migration is additive ───────────
console.log("\n12. Static checks");
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const svc = read("../src/lib/services/rewardsService.js");
  const red = read("../src/lib/services/rewardRedemptionService.js");
  const rules = read("../src/lib/rewards.js");
  for (const [name, src] of [["rewardsService", svc], ["rewardRedemptionService", red], ["rewards", rules]]) {
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    ok(`${name} does not import commission/balance code`,
      !imports.some((p) => /providerRegistry|composeBalance|affiliateSystemService|balance\//.test(p)));
    ok(`${name} registers no balance provider`, !/registerBalanceProvider\s*\(/.test(src));
    ok(`${name} never writes affiliate money/counter fields`, !/(bonusBalance|totalCommission|commissionAmount|deliveredOrdersCount)\s*:/.test(src));
  }
  ok("no service writes affiliate_orders / orders",
    !/affiliateOrder\.(update|updateMany|create|delete)|\border\.(update|updateMany|create|delete)/.test(svc + red));
  const aff = read("../src/lib/services/affiliateSystemService.js");
  // Phase 3: commission code reaches rewards ONLY through the post-commit hooks.
  const rewardImports = [...aff.matchAll(/from ['"]([^'"]*reward[^'"]*)['"]/gi)].map((m) => m[1]);
  ok("commission code imports only rewardsHooks (never the rewards services)",
    rewardImports.length === 1 && rewardImports[0] === "../rewardsHooks.js" && !/syncOrderRewards|awardSignupBonus/.test(aff));
  ok("order hook only in the two status writers that can reach/leave 'delivered'",
    (aff.match(/onAffiliateOrderStatusCommitted\(/g) || []).length === 2);
  ok("activation hook only in adminUpdateAffiliate", (aff.match(/onAffiliateActivationCommitted\(/g) || []).length === 1);

  // Statements only — SQL comments may legitimately mention DROP/TRUNCATE.
  const sql = read("../prisma/migrations_archive/20261019_affiliate_rewards/migration.sql")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const schema = read("../prisma/schema.prisma");
  const maps = [...schema.matchAll(/model (Reward\w+) \{[\s\S]*?@@map\("([^"]+)"\)/g)].map((m) => m[2]);
  ok("7 reward tables in the schema", maps.length === 7);
  ok("migration creates every reward table", maps.every((t) => sql.includes(`CREATE TABLE IF NOT EXISTS "${t}"`)));
  ok("migration never alters/drops existing tables",
    !/DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE/i.test(sql)
    && [...sql.matchAll(/ALTER TABLE "([^"]+)"/g)].every((m) => m[1].startsWith("reward_")));
  ok("ledger idempotency key unique", /UNIQUE INDEX IF NOT EXISTS "reward_points_ledger_idempotencyKey_key"/.test(sql));
  ok("one award per affiliate order and per store order",
    /reward_order_awards_affiliateOrderId_key/.test(sql) && /reward_order_awards_orderId_key/.test(sql));
  ok("stock >= 0 and points > 0 CHECKs", /"stock" >= 0/.test(sql) && /"pointsCost" > 0/.test(sql) && /"delta" <> 0/.test(sql));
  ok("ledger + history append-only triggers",
    /BEFORE UPDATE OR DELETE ON "reward_points_ledger"/.test(sql) && /BEFORE UPDATE OR DELETE ON "reward_redemption_history"/.test(sql));
  ok("store orders stay deletable (no FK on award.orderId)", !/FOREIGN KEY \("orderId"\)/.test(sql));
  // Structural match: every reward model's scalar fields ⇔ the table's columns,
  // with NOT NULL exactly where the Prisma field is required.
  const SCALARS = new Set(["String", "Int", "Boolean", "DateTime", "Json"]);
  const mismatches = [];
  for (const m of schema.matchAll(/model (Reward\w+) \{([\s\S]*?)\n\}/g)) {
    const table = (m[2].match(/@@map\("([^"]+)"\)/) || [])[1];
    const fields = {};
    for (const line of m[2].split("\n")) {
      const f = line.trim().match(/^(\w+)\s+(\w+)(\??)(\[\])?/);
      if (f && SCALARS.has(f[2]) && !f[4]) fields[f[1]] = f[3] === "?" ? "NULL" : "NOT NULL";
    }
    const block = (sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\);`)) || [])[1] || "";
    const cols = {};
    for (const c of block.matchAll(/^\s*"(\w+)"\s+([^,\n]+)/gm)) cols[c[1]] = /NOT NULL/.test(c[2]) ? "NOT NULL" : "NULL";
    const names = new Set([...Object.keys(fields), ...Object.keys(cols)]);
    for (const n of names) if (fields[n] !== cols[n]) mismatches.push(`${table}.${n}: schema=${fields[n]} sql=${cols[n]}`);
  }
  ok(`migration columns + nullability match the Prisma models${mismatches.length ? " — " + mismatches.join("; ") : ""}`, mismatches.length === 0);
  ok("triggers use EXECUTE PROCEDURE (valid on all supported Postgres versions)",
    (sql.match(/EXECUTE PROCEDURE "reward_reject_mutation"\(\)/g) || []).length === 2 && !/EXECUTE FUNCTION/.test(sql));
  ok("migration sorts after the latest existing migration", "20261019_affiliate_rewards" > "20260806_feedback_review_date");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
