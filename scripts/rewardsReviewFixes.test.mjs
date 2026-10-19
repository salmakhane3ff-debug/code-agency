#!/usr/bin/env node
/**
 * scripts/rewardsReviewFixes.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression tests for the three fixes from the final Phases 0–5 review:
 *   1. affiliate order UI: FR/AR feedback for the Phase 0 404/409 responses
 *      (instead of failing silently), with a list refresh
 *   2. Rewards serve ACTIVE affiliates only — reads, requests and cancellation
 *      (a token issued before deactivation must not keep access); an admin can
 *      still cancel/refund a deactivated affiliate's pending request
 *   3. bounded reconcile: never-eligible orders cost no lock/write, runs are
 *      capped (maxPerRun) with reversals first — award rules unchanged
 *   4. (second review) status-change hooks always take the account lock, so an
 *      award still in flight when the order is cancelled is reversed; the
 *      lock-free pre-check is reconcile-only
 *   5. (second review) reconcile resumes with circular cursors: never-eligible
 *      orders that sort first cannot starve later awards or re-awards, and
 *      `truncated` is exact
 *   6. (hardening) one reconcile at a time (advisory lock; a 2nd call gets
 *      RECONCILE_IN_PROGRESS and cannot touch the cursors), lock released on
 *      success / failure, award reserve ≥ 1 for small budgets
 * Run: node scripts/rewardsReviewFixes.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { makeRewardsFakeDb } from "./lib/rewardsFakeDb.mjs";
import {
  ORDER_MESSAGES, orderStatusErrorKind, orderStatusErrorMessage, shouldRefreshOrdersAfter, orderMessageDir,
} from "../src/lib/affiliateOrderMessages.js";
import { updateAffiliateOrderStatus } from "../src/lib/services/affiliateSystemService.js";
import { affiliateRewardsHandlers, adminRewardsHandlers } from "../src/lib/rewardsRouteHandlers.js";
import { withAffiliateAuth } from "../src/lib/middleware/withAffiliateAuth.js";
import { signToken } from "../src/lib/services/authService.js";
import {
  saveRewardsConfig, adjustPoints, syncOrderRewards, reconcileOrderRewards, verifyAccountBalance,
  reconcileOrdersReserve, RECONCILE_MAX_PER_RUN,
} from "../src/lib/services/rewardsService.js";
import { requestRedemption } from "../src/lib/services/rewardRedemptionService.js";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const NOW = new Date("2026-10-20T10:00:00Z");

// ── 1. Affiliate order feedback (404 / 409) ──────────────────────────────────
console.log("\n1. Order status feedback");
{
  ok("409 → LOCKED, 404 → NOT_FOUND, 400 → INVALID, 401 → SESSION, network → NETWORK, else DEFAULT",
    orderStatusErrorKind(409) === "LOCKED" && orderStatusErrorKind(404) === "NOT_FOUND" && orderStatusErrorKind(400) === "INVALID"
    && orderStatusErrorKind(401) === "SESSION" && orderStatusErrorKind(0) === "NETWORK" && orderStatusErrorKind(500) === "DEFAULT");
  ok("FR and AR have the same message keys",
    JSON.stringify(Object.keys(ORDER_MESSAGES.fr).sort()) === JSON.stringify(Object.keys(ORDER_MESSAGES.ar).sort()));
  ok("every Arabic message is Arabic, every French one is not", Object.values(ORDER_MESSAGES.ar).every((m) => /[؀-ۿ]/.test(m))
    && Object.values(ORDER_MESSAGES.fr).every((m) => m.trim() && !/[؀-ۿ]/.test(m)));
  ok("message follows the site language (ar → AR, else FR)",
    orderStatusErrorMessage(409, "ar") === ORDER_MESSAGES.ar.LOCKED && orderStatusErrorMessage(409, "fr") === ORDER_MESSAGES.fr.LOCKED
    && orderStatusErrorMessage(404, "en") === ORDER_MESSAGES.fr.NOT_FOUND);
  ok("list refreshed only when it is stale (404 / 409)",
    shouldRefreshOrdersAfter(404) && shouldRefreshOrdersAfter(409) && !shouldRefreshOrdersAfter(400) && !shouldRefreshOrdersAfter(500));
  ok("Arabic notice is RTL", orderMessageDir("ar") === "rtl" && orderMessageDir("fr") === "ltr");

  // The service codes behind those HTTP statuses (Phase 0) and their mapping.
  const db = makeRewardsFakeDb({ affiliateOrder: [
    { id: "a-del", affiliateId: "A", status: "delivered" }, { id: "b-pen", affiliateId: "B", status: "pending" },
  ] });
  const locked = await code(() => updateAffiliateOrderStatus("a-del", "cancelled", { affiliateId: "A", db }));
  const notMine = await code(() => updateAffiliateOrderStatus("b-pen", "cancelled", { affiliateId: "A", db }));
  const route = read("../src/app/api/affiliate/orders/route.js");
  ok("delivered order → ORDER_LOCKED → HTTP 409 → LOCKED message", locked === "ORDER_LOCKED" && /ORDER_LOCKED:\s*409/.test(route));
  ok("someone else's order → ORDER_NOT_FOUND → HTTP 404 → NOT_FOUND message", notMine === "ORDER_NOT_FOUND" && /ORDER_NOT_FOUND:\s*404/.test(route));

  const page = read("../src/app/affiliate/dashboard/page.jsx");
  const handler = page.slice(page.indexOf("const handleOrderStatus"), page.indexOf("// ── Mark notifs read"));
  ok("handler no longer ignores a refused change", /\} else \{\s*showOrderNotice\(orderStatusErrorMessage\(res\.status, lang\)\);/.test(handler));
  ok("…refreshes the list on 404/409", /if \(shouldRefreshOrdersAfter\(res\.status\)\) fetchAll\(token, \{ silent: true \}\);/.test(handler));
  ok("…and reports network failures", /catch \{\s*showOrderNotice\(orderStatusErrorMessage\(0, lang\)\);/.test(handler));
  ok("notice rendered as an alert in the site language direction",
    /role="alert" dir=\{orderMessageDir\(lang\)\}/.test(page) && /\{orderNotice\}/.test(page) && /const \{ lang \} = useLanguage\(\);/.test(page));
}

// ── 2. Rewards for ACTIVE affiliates only ────────────────────────────────────
console.log("\n2. Deactivated-affiliate policy");
{
  const db = makeRewardsFakeDb({
    affiliate: ["A", "B"].map((id) => ({ id, username: id.toLowerCase(), isActive: true, createdAt: new Date("2026-01-01") })),
    rewardGift: [{ id: "g", name: "Casque", description: "", images: [], pointsCost: 10, stock: 9, isActive: true, archivedAt: null, sortOrder: 1, createdAt: NOW }],
  });
  await saveRewardsConfig({ enabled: true, maxOpenRedemptions: 50 }, { db, now: NOW });
  await adjustPoints({ affiliateId: "A", delta: 100, reason: "Solde de test", clientRequestId: "seed-0000a", actorId: "admin-1" }, { db });
  const h = affiliateRewardsHandlers({ db, now: () => NOW, rateLimit: () => null });
  const tokA = signToken({ affiliateId: "A", type: "affiliate" }); // issued while A is active
  const ship = { fullName: "Salma Test", phone: "+212612345678", city: "Casablanca", address: "12 rue des Fleurs" };
  let seq = 0;
  const callAll = async (token, pendingId) => {
    const run = async (fn, { method = "GET", body, params = {} } = {}) => {
      const res = await withAffiliateAuth(fn)(new Request("http://x/api/affiliate/rewards", {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
      }), { params: Promise.resolve(params) });
      return { status: res.status, body: await res.json() };
    };
    return {
      overview: await run(h.overview),
      ledger: await run(h.ledger),
      redemptions: await run(h.redemptions),
      request: await run(h.requestRedemption, { method: "POST", body: { giftId: "g", clientRequestId: `req-pol-${String(++seq).padStart(4, "0")}`, ...ship } }),
      cancel: await run(h.cancelRedemption, { method: "POST", params: { id: pendingId } }),
    };
  };
  const pending = (await requestRedemption({ affiliateId: "A", giftId: "g", recipient: ship, clientRequestId: "req-pend-0001" }, { db, now: NOW })).redemption;
  const keep = (await requestRedemption({ affiliateId: "A", giftId: "g", recipient: ship, clientRequestId: "req-pend-0002" }, { db, now: NOW })).redemption;

  const active = await callAll(tokA, pending.id);
  ok("active: overview / ledger / requests → 200", [active.overview, active.ledger, active.redemptions].every((r) => r.status === 200));
  ok("active: request → 201, cancel own pending → 200", active.request.status === 201 && active.cancel.status === 200);

  db._tables.affiliate.find((a) => a.id === "A").isActive = false;        // admin deactivates; token still valid
  const ledgerBefore = db._tables.rewardPointsLedger.length;
  const redBefore = db._tables.rewardRedemption.length;
  const off = await callAll(tokA, keep.id);
  for (const [name, r] of Object.entries(off)) {
    ok(`deactivated (old token): ${name} → 403 AFFILIATE_INACTIVE`, r.status === 403 && r.body.code === "AFFILIATE_INACTIVE");
  }
  ok("…no data leaked", !off.overview.body.points && !Array.isArray(off.redemptions.body) && !off.ledger.body.items);
  ok("…nothing written (no request, no cancel/refund)", db._tables.rewardPointsLedger.length === ledgerBefore
    && db._tables.rewardRedemption.length === redBefore && db._tables.rewardRedemption.find((r) => r.id === keep.id).status === "PENDING_REVIEW");

  const admin = adminRewardsHandlers({ db, now: () => NOW });
  const balBefore = db._tables.rewardPointsAccount.find((a) => a.affiliateId === "A").balance;
  const res = await admin.patchRedemption(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ toStatus: "CANCELLED", reason: "Compte désactivé" }) }), { params: Promise.resolve({ id: keep.id }) }, { userId: "admin-1" });
  ok("admin can still cancel a deactivated affiliate's pending request, with refund",
    res.status === 200 && db._tables.rewardPointsAccount.find((a) => a.affiliateId === "A").balance === balBefore + 10);

  db._tables.affiliate.find((a) => a.id === "A").isActive = true;          // reactivated
  ok("reactivated → access restored", (await callAll(tokA, "none")).overview.status === 200);
  const ghost = await callAll(signToken({ affiliateId: "DELETED", type: "affiliate" }), "none");
  ok("token for a deleted account → 403", Object.values(ghost).every((r) => r.status === 403));
  ok("books still balance", (await verifyAccountBalance("A", { db })).ok);
}

// ── 3. Bounded reconcile ─────────────────────────────────────────────────────
console.log("\n3. Reconcile cost & bounds");
function bigDb(n) {
  const affiliateOrder = [], order = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 3; // fake / suspicious / unlinked — never eligible under D1
    order.push({ id: `o${i}`, isFake: kind === 0, affiliateId: "A" });
    affiliateOrder.push({ id: `ao${String(i).padStart(4, "0")}`, affiliateId: "A", orderId: kind === 2 ? null : `o${i}`, status: "pending", isFake: kind === 0, isSuspicious: kind === 1 });
  }
  return makeRewardsFakeDb({ affiliate: [{ id: "A", isActive: true, createdAt: new Date(0) }], order, affiliateOrder });
}
const cost = (db) => ({ tx: db._stats.transactions, locks: db._stats.calls["rewardPointsAccount.upsert"] || 0 });
const delta = (a, b) => ({ tx: b.tx - a.tx, locks: b.locks - a.locks });
{
  const db = bigDb(300);
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = "delivered";
  let b = cost(db); await reconcileOrderRewards({ db }); let d = delta(b, cost(db));
  ok(`300 never-eligible delivered orders: reconcile #1 → ${d.tx} transaction (the run's guard), ${d.locks} lock writes (was 300 / 300)`, d.tx === 1 && d.locks === 0);
  b = cost(db); await reconcileOrderRewards({ db }); d = delta(b, cost(db));
  ok(`reconcile #2 → ${d.tx} / ${d.locks} (was 300 / 300 on every run)`, d.tx === 1 && d.locks === 0);

  db._tables.affiliateOrder[0].status = "shipped";
  b = cost(db); const r = await syncOrderRewards("ao0000", { db, now: NOW }); d = delta(b, cost(db));
  ok("status hook (default) always enters the locked transaction (race safety), then noops", d.tx === 1 && d.locks === 1 && r.reason === "NOT_DELIVERED");
  b = cost(db); const rp = await syncOrderRewards("ao0000", { db, now: NOW, precheck: true }); d = delta(b, cost(db));
  ok("reconcile pre-check (opt-in) → no lock, no write, same noop reason", d.tx === 0 && d.locks === 0 && rp.reason === "NOT_DELIVERED");
  ok("…and no ledger write either way", db._tables.rewardPointsLedger.length === 0);
  ok("ineligible reasons unchanged (D1)", (await syncOrderRewards("ao0001", { db })).reason === "SUSPICIOUS"
    && (await syncOrderRewards("ao0002", { db })).reason === "NOT_LINKED" && (await syncOrderRewards("ao0003", { db })).reason === "FAKE_ORDER");

  await saveRewardsConfig({ excludeSuspicious: false }, { db, now: NOW });
  const t = await reconcileOrderRewards({ db });
  ok("D1 toggle respected: with exclusion OFF, suspicious linked orders are scanned and awarded", t.awarded === 100);
}
{
  // Missed awards are still repaired; runs are capped and resumable.
  const db = makeRewardsFakeDb({
    affiliate: [{ id: "A", isActive: true, createdAt: new Date(0) }],
    order: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, isFake: false, affiliateId: "A" })),
    affiliateOrder: Array.from({ length: 5 }, (_, i) => ({ id: `ao${i}`, affiliateId: "A", orderId: `o${i}`, status: "pending", isFake: false, isSuspicious: false })),
  });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = "delivered";       // all hooks "missed"
  const r1 = await reconcileOrderRewards({ db, maxPerRun: 2 });
  const r2 = await reconcileOrderRewards({ db, maxPerRun: 2 });
  const r3 = await reconcileOrderRewards({ db, maxPerRun: 2 });
  ok("capped run: 2 + 2 + 1 awards, truncated until done", r1.awarded === 2 && r1.truncated && r2.awarded === 2 && r2.truncated && r3.awarded === 1 && !r3.truncated);
  ok("each missed award applied exactly once", db._tables.rewardPointsLedger.length === 5);

  // Reversals first when capped; reversals run even while rewards are OFF.
  db._tables.affiliateOrder[0].status = "cancelled";                       // missed reversal
  db._tables.affiliateOrder.push({ id: "ao9", affiliateId: "A", orderId: "o9", status: "delivered", isFake: false, isSuspicious: false });
  db._tables.order.push({ id: "o9", isFake: false, affiliateId: "A" });     // missed award
  const capped = await reconcileOrderRewards({ db, maxPerRun: 1 });
  ok("capped at 1: the missed REVERSAL goes first", capped.reversed === 1 && capped.awarded === 0 && capped.truncated);
  await saveRewardsConfig({ enabled: false }, { db, now: NOW });
  db._tables.affiliateOrder[1].status = "cancelled";
  const offRun = await reconcileOrderRewards({ db });
  ok("rewards OFF: reversals still applied, no awards", offRun.reversed === 1 && offRun.awarded === 0);
  ok("books balance", (await verifyAccountBalance("A", { db })).ok);
}
{
  // Reconcile's stale pre-check (needed → no longer needed): the locked path re-validates.
  const db = makeRewardsFakeDb({
    affiliate: [{ id: "A", isActive: true, createdAt: new Date(0) }],
    order: [{ id: "o1", isFake: false, affiliateId: "A" }],
    affiliateOrder: [{ id: "ao1", affiliateId: "A", orderId: "o1", status: "pending", isFake: false, isSuspicious: false }],
  });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  db._tables.affiliateOrder[0].status = "delivered";
  db._stats.hooks["rewardPointsAccount.upsert"] = async () => { db._tables.affiliateOrder[0].status = "cancelled"; }; // changes after the pre-check
  const r = await syncOrderRewards("ao1", { db, now: NOW, precheck: true });
  ok("status changed between pre-check and lock → re-validated, nothing awarded", r.action === "noop" && db._tables.rewardPointsLedger.length === 0);
  delete db._stats.hooks["rewardPointsAccount.upsert"];
  const h = adminRewardsHandlers({ db });
  const res = await h.reconcile(new Request("http://x", { method: "POST" }), {}, { userId: "admin-1" });
  const body = await res.json();
  ok("reconcile endpoint reports the cap flag", res.status === 200 && body.orders.truncated === false);
}
{
  const svc = read("../src/lib/services/rewardsService.js");
  ok("reconcile award scan excludes fake / unlinked / (D1) suspicious orders in the query",
    /isFake: false, orderId: \{ not: null \}/.test(svc) && /config\.excludeSuspicious \? \{ isSuspicious: false \} : \{\}/.test(svc));
}

// ── 4. Race safety: status hooks always lock ─────────────────────────────────
console.log("\n4. Delivery award in flight vs cancellation");
const oneOrderDb = () => makeRewardsFakeDb({
  affiliate: [{ id: "A", isActive: true, createdAt: new Date(0) }],
  order: [{ id: "o1", isFake: false, affiliateId: "A" }],
  affiliateOrder: [{ id: "ao1", affiliateId: "A", orderId: "o1", status: "pending", isFake: false, isSuspicious: false }],
});
const tick = () => new Promise((r) => setImmediate(r));
for (const pauseAt of ["rewardOrderAward.createMany", "rewardPointsLedger.create"]) {
  const db = oneOrderDb();
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  db._tables.affiliateOrder[0].status = "delivered";                     // delivery committed
  let release, reached;
  const gate = new Promise((r) => { release = r; });
  const atPause = new Promise((r) => { reached = r; });
  db._stats.hooks[pauseAt] = async () => { reached(); await gate; };
  const award = syncOrderRewards("ao1", { db, now: NOW });               // delivered hook: inside the locked tx
  await atPause;                                                          // …award NOT committed yet
  db._tables.affiliateOrder[0].status = "cancelled";                     // cancellation commits meanwhile
  let cancelDone = false;
  const cancel = syncOrderRewards("ao1", { db, now: NOW }).then((r) => { cancelDone = true; return r; }); // cancel hook
  for (let i = 0; i < 20; i++) await tick();
  ok(`[pause at ${pauseAt}] cancel hook waits for the in-flight award (account lock)`, cancelDone === false);
  release();
  const [a, c] = await Promise.all([award, cancel]);
  delete db._stats.hooks[pauseAt];
  const aw = db._tables.rewardOrderAward[0];
  ok(`[pause at ${pauseAt}] award commits, then the cancel reverses it`, a.action === "awarded" && c.action === "reversed");
  ok(`[pause at ${pauseAt}] final state: no active award for the cancelled order, balance 0`,
    aw.state === "REVERSED" && db._tables.rewardPointsAccount[0].balance === 0 && (await verifyAccountBalance("A", { db })).ok);
  ok(`[pause at ${pauseAt}] nothing left for reconcile`, (await reconcileOrderRewards({ db, now: NOW })).reversed === 0);
}
{
  const svc = read("../src/lib/services/rewardsService.js");
  const hooks = read("../src/lib/rewardsHooks.js");
  ok("pre-check is opt-in (precheck = false by default)", /precheck = false \} = \{\}\) \{/.test(svc));
  ok("status hooks never opt into the pre-check", !/precheck/.test(hooks));
  ok("reconcile: reversal track without pre-check, award/re-award track with it",
    /state\.reversals, false\)/.test(svc) && /state\.orders, true\)/.test(svc) && (svc.match(/syncOrderRewards\(id, \{ db, now, precheck \}\)/g) || []).length === 1);
}

// ── 5. Reconcile cannot starve ───────────────────────────────────────────────
console.log("\n5. Circular, resumable reconcile");
function starveDb({ bad = 1000, extra = [] } = {}) {
  const order = [], affiliateOrder = [];
  for (let i = 0; i < bad; i++) {
    // Pass the query filter but can never earn: the store order belongs to another affiliate.
    order.push({ id: `ob${i}`, isFake: false, affiliateId: "OTHER" });
    affiliateOrder.push({ id: `a${String(i).padStart(5, "0")}`, affiliateId: "A", orderId: `ob${i}`, status: "pending", isFake: false, isSuspicious: false });
  }
  for (const e of extra) { order.push({ id: `o-${e}`, isFake: false, affiliateId: "A" }); affiliateOrder.push({ id: e, affiliateId: "A", orderId: `o-${e}`, status: "pending", isFake: false, isSuspicious: false }); }
  return makeRewardsFakeDb({ affiliate: [{ id: "A", isActive: true, createdAt: new Date(0) }], order, affiliateOrder });
}
// Delivered AFTER launch (otherwise the D11 baseline would exclude them).
const deliverBad = (db) => { for (const o of db._tables.affiliateOrder) if (o.orderId?.startsWith("ob")) o.status = "delivered"; };
const stateOf = (db) => db._tables.setting.find((r) => r.id === "rewards-reconcile-state")?.data;
{
  // 1,000 never-eligible orders first in id order, then one eligible order.
  const db = starveDb({ extra: ["z-good"] });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  deliverBad(db);
  const z = db._tables.affiliateOrder.find((o) => o.id === "z-good"); z.status = "delivered"; // hook missed
  const runs = [], cursors = [];
  for (let i = 0; i < 3 && !db._tables.rewardOrderAward.some((a) => a.affiliateOrderId === "z-good"); i++) {
    runs.push(await reconcileOrderRewards({ db, now: NOW }));
    cursors.push(structuredClone(stateOf(db)));
  }
  ok(`eligible order behind 1,000 ineligible ones is awarded on run ${runs.length} (was: never)`,
    runs.length === 2 && db._tables.rewardOrderAward.some((a) => a.affiliateOrderId === "z-good" && a.state === "AWARDED"));
  ok("run 1: 1,000 visits, all noop, truncated (candidates left)", runs[0].noop === 1000 && runs[0].truncated === true);
  ok("run 1 stored its resume cursor (last visited order)", cursors[0]?.orders?.phase === "awards" && cursors[0].orders.id === "a00999");
  ok("run 2 resumed after it: the eligible order first, then wrapped round", runs[1].awarded === 1 && runs[1].noop === 999 && runs[1].truncated);
  ok("ineligible orders still cost no lock or transaction", db._stats.calls["rewardPointsAccount.upsert"] === 1);
  ok("exactly one ledger row, books balance", db._tables.rewardPointsLedger.length === 1 && (await verifyAccountBalance("A", { db })).ok);
  // 1,000 candidates left (all ineligible) = budget → run 3 completes the circle.
  const r3 = await reconcileOrderRewards({ db, now: NOW });
  ok("run 3 visits the remaining 1,000 → complete pass, truncated: false, nothing applied twice",
    r3.noop === 1000 && !r3.truncated && r3.awarded === 0 && db._tables.rewardPointsLedger.length === 1);
}
{
  // Re-awards (phase after awards) are not starved by never-eligible awards.
  const db = starveDb({ extra: ["r-1"] });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  deliverBad(db);
  const ro = db._tables.affiliateOrder.find((o) => o.id === "r-1");
  ro.status = "delivered"; await syncOrderRewards("r-1", { db, now: NOW });   // awarded 10
  ro.status = "cancelled"; await syncOrderRewards("r-1", { db, now: NOW });   // reversed
  await saveRewardsConfig({ pointsPerDeliveredOrder: 25 }, { db, now: NOW });  // D9: snapshot stays 10
  ro.status = "delivered";                                                     // hook missed
  let n = 0, got = false;
  while (n < 3 && !got) { const r = await reconcileOrderRewards({ db, now: NOW }); n++; got = r.reawarded === 1; }
  ok(`missed re-award behind 1,000 ineligible awards is applied on run ${n} (was: never)`, got && n === 2);
  ok("re-award keeps the original 10-point snapshot (D9)", db._tables.rewardPointsAccount[0].balance === 10);
}
{
  // Reversal backlog larger than the cap: reversals first, awards keep a 10% share.
  const db = starveDb({ bad: 0, extra: Array.from({ length: 1205 }, (_, i) => `v${String(i).padStart(5, "0")}`).concat(["w-new"]) });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) if (o.id !== "w-new") o.status = "delivered";
  await reconcileOrderRewards({ db, now: NOW, maxPerRun: 5000 });              // award all 1,205
  for (const o of db._tables.affiliateOrder) o.status = o.id === "w-new" ? "delivered" : "cancelled";
  const r1 = await reconcileOrderRewards({ db, now: NOW });
  ok("capped run with 1,205 reversals: 900 reversals first, award still served from the 10% reserve",
    r1.reversed === 900 && r1.awarded === 1 && r1.truncated);
  const r2 = await reconcileOrderRewards({ db, now: NOW });
  ok("next run resumes the reversals (305) and finishes", r2.reversed === 305 && !r2.truncated);
  ok("no award left active for a cancelled order, books balance",
    !db._tables.rewardOrderAward.some((a) => a.state === "AWARDED" && a.affiliateOrderId !== "w-new") && (await verifyAccountBalance("A", { db })).ok);
}
{
  // Rewards OFF: whole budget goes to reversals; the award cursor is kept untouched.
  const db = starveDb({ bad: 0, extra: Array.from({ length: 1205 }, (_, i) => `v${String(i).padStart(5, "0")}`) });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = "delivered";
  await reconcileOrderRewards({ db, now: NOW, maxPerRun: 5000 });
  db._tables.setting.push({ id: "rewards-reconcile-state", data: { reversals: null, orders: { phase: "awards", id: "v00500" } }, updatedAt: NOW });
  await saveRewardsConfig({ enabled: false }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = "cancelled";
  const r1 = await reconcileOrderRewards({ db, now: NOW });
  const r2 = await reconcileOrderRewards({ db, now: NOW });
  ok("rewards OFF: 1,000 then 205 reversals, no awards", r1.reversed === 1000 && r1.truncated && r2.reversed === 205 && !r2.truncated && r1.awarded + r2.awarded === 0);
  ok("rewards OFF: award/re-award cursor left as it was", stateOf(db).orders?.id === "v00500" && stateOf(db).reversals === null);
  ok("ledger sum == balance == 0", db._tables.rewardPointsAccount[0].balance === 0 && (await verifyAccountBalance("A", { db })).ok);
}
{
  // truncated is exact: budget used up exactly on the last candidate → false.
  const db = starveDb({ bad: 0, extra: ["e0", "e1"] });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = "delivered";
  const r = await reconcileOrderRewards({ db, now: NOW, maxPerRun: 2 });
  ok("budget exactly consumed by the last candidate → truncated: false", r.awarded === 2 && r.truncated === false);
  ok("complete pass leaves no cursor (next run starts from the beginning)", (stateOf(db)?.orders ?? null) === null);
  const again = await reconcileOrderRewards({ db, now: NOW, maxPerRun: 2 });
  ok("idempotent second run", again.awarded === 0 && !again.truncated && db._tables.rewardPointsLedger.length === 2);
  // Corrupt / foreign state is ignored, not trusted.
  db._tables.setting.push({ id: "rewards-reconcile-state", data: { reversals: "x", orders: { phase: "nope", id: 5 } }, updatedAt: NOW });
  ok("malformed cursor state is ignored", !(await reconcileOrderRewards({ db, now: NOW })).truncated);
}
{
  const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");
  const res = await upsertSettingsHandler(new Request("http://x/api/setting?type=rewards-reconcile-state", { method: "POST", body: "{}" }));
  ok("POST /api/setting?type=rewards-reconcile-state → 400 (system-managed)", res.status === 400);
}

// ── 6. One run at a time + small budgets ─────────────────────────────────────
console.log("\n6. Reconcile lock and small budgets");
{
  // Two concurrent attempts: the 2nd is refused and cannot overwrite the 1st run's cursor.
  const db = starveDb({ bad: 1500 });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  deliverBad(db);
  let release, reached, armed = true;
  const gate = new Promise((r) => { release = r; }), atPause = new Promise((r) => { reached = r; });
  db._stats.hooks["affiliateOrder.findMany"] = async () => { if (armed) { armed = false; reached(); await gate; } };
  const first = reconcileOrderRewards({ db, now: NOW });
  await atPause;                                                     // run 1 holds the lock, mid-scan
  const callsBefore = JSON.stringify(db._stats.calls);
  const second = await code(() => reconcileOrderRewards({ db, now: NOW }));
  ok("2nd concurrent reconcile → RECONCILE_IN_PROGRESS", second === "RECONCILE_IN_PROGRESS");
  const after = JSON.parse(JSON.stringify(db._stats.calls)), beforeCalls = JSON.parse(callsBefore);
  ok("…it visited no order and read no candidates",
    (after["affiliateOrder.findMany"] || 0) === (beforeCalls["affiliateOrder.findMany"] || 0)
    && (after["rewardOrderAward.findMany"] || 0) === (beforeCalls["rewardOrderAward.findMany"] || 0)
    && (after["affiliateOrder.findUnique"] || 0) === (beforeCalls["affiliateOrder.findUnique"] || 0));
  ok("…and wrote no cursor", stateOf(db) === undefined);
  const res = await adminRewardsHandlers({ db }).reconcile(new Request("http://x", { method: "POST" }), {}, { userId: "admin-1" });
  const body = await res.json();
  ok("admin endpoint while busy → 409 RECONCILE_IN_PROGRESS with a clear message", res.status === 409 && body.code === "RECONCILE_IN_PROGRESS" && /déjà en cours/.test(body.error));
  release();
  const r1 = await first;
  delete db._stats.hooks["affiliateOrder.findMany"];
  ok("run 1 completes and its cursor is the one saved", r1.noop === 1000 && r1.truncated && stateOf(db)?.orders?.id === "a00999");
  const r2 = await reconcileOrderRewards({ db, now: NOW });
  ok("lock released after success: next run proceeds and resumes from run 1's cursor", r2.noop === 500 + 500 && stateOf(db)?.orders?.id === "a00499");
}
{
  // Lock released after failure; a failed run leaves the cursors untouched.
  const db = starveDb({ bad: 0, extra: ["e0", "e1", "e2"] });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = "delivered";
  await reconcileOrderRewards({ db, now: NOW, maxPerRun: 1 });       // cursor → awards:e0
  const saved = structuredClone(stateOf(db));
  db._stats.hooks["affiliateOrder.findMany"] = async () => { throw new Error("connection reset"); };
  ok("failing run rejects with its own error", (await code(() => reconcileOrderRewards({ db, now: NOW, maxPerRun: 1 }))) === "connection reset");
  delete db._stats.hooks["affiliateOrder.findMany"];
  ok("…cursor unchanged", JSON.stringify(stateOf(db)) === JSON.stringify(saved));
  db._stats.hooks["setting.upsert"] = async () => { throw new Error("disk full"); };
  ok("failure while saving the cursor rejects", (await code(() => reconcileOrderRewards({ db, now: NOW, maxPerRun: 1 }))) === "disk full");
  delete db._stats.hooks["setting.upsert"];
  ok("…the save is rolled back with the guard (cursor unchanged)", JSON.stringify(stateOf(db)) === JSON.stringify(saved));
  const ok3 = await reconcileOrderRewards({ db, now: NOW });
  ok("lock released after both failures: next run proceeds", ok3.truncated === false);
  ok("every award applied exactly once despite the failed runs", db._tables.rewardPointsLedger.length === 3 && (await verifyAccountBalance("A", { db })).ok);
}
{
  // Time limit: a run stops before the guard could expire (truncated, cursor kept).
  const db = starveDb({ bad: 0, extra: ["t0", "t1"] });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = "delivered";
  const r = await reconcileOrderRewards({ db, now: NOW, timeLimitMs: 0 });
  ok("time limit reached → no visit, truncated, nothing saved", r.awarded + r.noop === 0 && r.truncated && stateOf(db) === undefined);
  ok("…next run with time left completes", (await reconcileOrderRewards({ db, now: NOW })).awarded === 2);
}
{
  // Reserve formula.
  let inv = true;
  for (let t = 1; t <= 2000; t++) { const r = reconcileOrdersReserve(t, true); if (!(r >= 0 && r < t && (t < 2 || r >= 1))) inv = false; }
  ok("reserve: 0 < reserve < total for every total 2..2000; 0 for total 1", inv && reconcileOrdersReserve(1, true) === 0);
  ok("reserve: 10% kept for normal budgets (1000 → 100, 200 → 20, 10 → 1)",
    reconcileOrdersReserve(1000, true) === 100 && reconcileOrdersReserve(200, true) === 20 && reconcileOrdersReserve(10, true) === 1);
  ok("reserve: small budgets 2 / 5 / 9 → 1", [2, 5, 9].every((t) => reconcileOrdersReserve(t, true) === 1));
  ok("reserve: rewards OFF → 0 for every budget", [1, 2, 5, 9, 1000].every((t) => reconcileOrdersReserve(t, false) === 0));
}
// 20 pending reversals + 5 missed awards, per budget.
async function budgetDb(enabled) {
  const ids = Array.from({ length: 20 }, (_, i) => `v${String(i).padStart(3, "0")}`), aw = Array.from({ length: 5 }, (_, i) => `w${i}`);
  const db = starveDb({ bad: 0, extra: [...ids, ...aw] });
  await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
  for (const o of db._tables.affiliateOrder) if (o.id.startsWith("v")) o.status = "delivered";
  await reconcileOrderRewards({ db, now: NOW });
  for (const o of db._tables.affiliateOrder) o.status = o.id.startsWith("v") ? "cancelled" : "delivered";
  if (!enabled) await saveRewardsConfig({ enabled: false }, { db, now: NOW });
  return db;
}
for (const [t, rev, awd] of [[1, 1, 0], [2, 1, 1], [5, 4, 1], [9, 8, 1], [10, 9, 1]]) {
  const r = await reconcileOrderRewards({ db: await budgetDb(true), now: NOW, maxPerRun: t });
  ok(`rewards ON, budget ${t}: ${rev} reversal(s) first + ${awd} award visit(s), total ≤ ${t}`,
    r.reversed === rev && r.awarded === awd && r.reversed + r.awarded + r.noop <= t && r.truncated);
}
for (const t of [1, 2, 5, 9]) {
  const r = await reconcileOrderRewards({ db: await budgetDb(false), now: NOW, maxPerRun: t });
  ok(`rewards OFF, budget ${t}: all ${t} visits are reversals, no awards`, r.reversed === t && r.awarded === 0 && r.noop === 0);
}
{
  // Invalid budgets follow the existing contract: anything not a positive integer → 1,000.
  const results = [];
  for (const bad of [0, -5, 1.5, Number.NaN, "5", null, Infinity]) {
    const db = starveDb({ bad: 0, extra: Array.from({ length: 1205 }, (_, i) => `v${String(i).padStart(5, "0")}`) });
    await saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db, now: NOW });
    for (const o of db._tables.affiliateOrder) o.status = "delivered";
    await reconcileOrderRewards({ db, now: NOW, maxPerRun: 5000 });
    await saveRewardsConfig({ enabled: false }, { db, now: NOW });
    for (const o of db._tables.affiliateOrder) o.status = "cancelled";
    const r = await reconcileOrderRewards({ db, now: NOW, maxPerRun: bad });
    results.push(r.reversed);
  }
  ok(`maxPerRun 0 / -5 / 1.5 / NaN / "5" / null / Infinity → default ${RECONCILE_MAX_PER_RUN} visits (got ${results.join(",")})`, results.every((n) => n === RECONCILE_MAX_PER_RUN));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
