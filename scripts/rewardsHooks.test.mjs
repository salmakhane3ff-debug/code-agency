#!/usr/bin/env node
/**
 * scripts/rewardsHooks.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards Phase 3 — the engine connected to the EXISTING order-status and
 * affiliate-activation flows. Drives the real functions
 * (adminUpdateAffiliateOrderStatus, syncLinkedAffiliateOrderStatus,
 * adminUpdateAffiliate, legacy updateAffiliate) against the rewards fake DB.
 * Proves:
 *   • points only when an eligible order becomes delivered; duplicate saves,
 *     retries and concurrent updates award once; ledger net == final state
 *   • reversal + re-award with the ORIGINAL snapshot through the real flow
 *   • nothing for pre-launch / disabled-period / suspicious / fake / unlinked
 *   • hook failures (incl. mid-transaction rollback) never break the status
 *     change, are logged, and reconcile repairs them exactly once
 *   • hooks never run inside a caller's transaction (deferred to reconcile)
 *   • signup bonus on the FIRST admin activation only, both admin paths,
 *     concurrency-safe; no bonus for existing affiliates
 *   • commissions untouched (separate currency)
 * Run: node scripts/rewardsHooks.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { makeRewardsFakeDb } from "./lib/rewardsFakeDb.mjs";
import {
  adminUpdateAffiliateOrderStatus, syncLinkedAffiliateOrderStatus, adminUpdateAffiliate,
  getReferralCommissionComponent,
} from "../src/lib/services/affiliateSystemService.js";
import { updateAffiliate as legacyUpdateAffiliate } from "../src/lib/services/affiliateService.js";
import { getBalanceProviders } from "../src/lib/balance/providerRegistry.js";
import {
  saveRewardsConfig, reconcileOrderRewards, reconcileSignupBonuses, verifyAccountBalance,
} from "../src/lib/services/rewardsService.js";
import { onAffiliateOrderStatusCommitted, onAffiliateActivationCommitted } from "../src/lib/rewardsHooks.js";
import { adminRewardsHandlers } from "../src/lib/rewardsRouteHandlers.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const quiet = async (fn) => {
  const e = console.error, w = console.warn; const logs = [];
  console.error = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
  try { return { out: await fn(), logs }; } finally { console.error = e; console.warn = w; }
};

const PRE = new Date("2026-01-01T00:00:00Z");
const LAUNCH = new Date("2026-10-19T10:00:00Z");
const affRow = (id, extra = {}) => ({ id, username: id.toLowerCase(), name: id, isActive: true, createdAt: PRE,
  deliveredOrdersCount: 0, generatedRevenue: 0, referralStatus: "pending", bonusBalance: 0, ...extra });
const ao = (id, affiliateId, orderId, extra = {}) => ({ id, affiliateId, orderId, status: "pending", total: 200,
  commissionAmount: 100, clientName: "Client", isFake: false, isSuspicious: false, createdAt: PRE, ...extra });
function seed() {
  return makeRewardsFakeDb({
    affiliate: [affRow("A"), affRow("B")],
    order: [
      { id: "o1", isFake: false, affiliateId: "A" }, { id: "o2", isFake: false, affiliateId: "A" },
      { id: "o3", isFake: false, affiliateId: "A" }, { id: "o-fake", isFake: true, affiliateId: "A" },
      { id: "o-pre", isFake: false, affiliateId: "A" }, { id: "o-sus", isFake: false, affiliateId: "A" },
    ],
    affiliateOrder: [
      ao("ao1", "A", "o1"), ao("ao2", "A", "o2"), ao("ao3", "A", "o3"),
      ao("ao-fake", "A", "o-fake", { isFake: true }), ao("ao-pre", "A", "o-pre", { status: "delivered" }),
      ao("ao-sus", "A", "o-sus", { isSuspicious: true }), ao("ao-unlinked", "A", null),
    ],
  });
}
const ledger = (db, sourceId) => db._tables.rewardPointsLedger.filter((l) => !sourceId || l.sourceId === sourceId);
const balance = (db, aff = "A") => db._tables.rewardPointsAccount.find((a) => a.affiliateId === aff)?.balance ?? 0;
const setStatus = (db, id, status) => adminUpdateAffiliateOrderStatus(id, status, { db });
const launch = (db, cfg = {}) => saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10, ...cfg }, { db, now: LAUNCH, actorId: "admin-1" });

// ── 1. Delivered transition through the real admin flow ─────────────────────
console.log("\n1. Admin status flow");
{
  const db = seed();
  await launch(db);
  const r = await setStatus(db, "ao1", "confirmed");
  ok("non-delivered status → no points, status saved", r.status === "confirmed" && ledger(db).length === 0);
  const d = await setStatus(db, "ao1", "delivered");
  ok("delivered → 10 points, status saved", d.status === "delivered" && balance(db) === 10 && ledger(db, "ao1").length === 1);
  for (let i = 0; i < 4; i++) await setStatus(db, "ao1", "delivered");
  ok("re-saving 'delivered' 4× (retries) → still one award", ledger(db, "ao1").length === 1 && balance(db) === 10);
  await Promise.all(Array.from({ length: 10 }, () => setStatus(db, "ao2", "delivered")));
  ok("10 concurrent 'delivered' updates → exactly one award", ledger(db, "ao2").length === 1 && balance(db) === 20);
  await setStatus(db, "ao-pre", "delivered");
  ok("order delivered before launch → never awarded (D11)", ledger(db, "ao-pre").length === 0);
  for (const [id, why] of [["ao-sus", "suspicious"], ["ao-unlinked", "unlinked"]]) {
    const res = await setStatus(db, id, "delivered");
    ok(`${why} order → status saved, no points`, res.status === "delivered" && ledger(db, id).length === 0);
  }
}

// ── 2. Reversal & re-award with the original snapshot ───────────────────────
console.log("\n2. Reversal & re-award");
{
  const db = seed();
  await launch(db);
  await setStatus(db, "ao1", "delivered");
  await saveRewardsConfig({ pointsPerDeliveredOrder: 50 }, { db, now: LAUNCH });
  await setStatus(db, "ao1", "cancelled");
  ok("delivered → cancelled reverses the 10", balance(db) === 0 && ledger(db, "ao1").at(-1).delta === -10);
  await setStatus(db, "ao1", "cancelled");
  ok("re-saving 'cancelled' → no second reversal", ledger(db, "ao1").length === 2);
  await setStatus(db, "ao1", "delivered");
  ok("re-delivered → +10 (original snapshot), not the new 50", balance(db) === 10 && ledger(db, "ao1").at(-1).delta === 10);
  await setStatus(db, "ao1", "shipped");
  ok("delivered → shipped also reverses", balance(db) === 0);

  // Concurrent flip-flops: whatever the interleaving, net points match the final status.
  const db2 = seed();
  await launch(db2);
  const seqs = ["delivered", "cancelled", "delivered", "shipped", "delivered", "cancelled", "delivered"];
  await Promise.all(seqs.map((s) => setStatus(db2, "ao3", s)));
  await reconcileOrderRewards({ db: db2 });
  const final = db2._tables.affiliateOrder.find((o) => o.id === "ao3").status;
  const net = ledger(db2, "ao3").reduce((s, l) => s + l.delta, 0);
  ok(`concurrent flip-flops: net points (${net}) match final status '${final}'`, net === (final === "delivered" ? 10 : 0));
  ok("ledger sum == balance after the storm", (await verifyAccountBalance("A", { db: db2 })).ok);
}

// ── 3. Disabled rewards & disabled periods ──────────────────────────────────
console.log("\n3. Disabled rewards");
{
  const db = seed();
  await setStatus(db, "ao1", "delivered");
  ok("rewards never enabled → no points", ledger(db).length === 0);
  await launch(db);
  await setStatus(db, "ao1", "delivered");
  ok("delivered while OFF, re-saved after launch → still excluded", ledger(db, "ao1").length === 0
    && db._tables.rewardOrderAward.find((a) => a.affiliateOrderId === "ao1").state === "EXCLUDED");
  await saveRewardsConfig({ enabled: false }, { db, now: LAUNCH });
  await setStatus(db, "ao2", "delivered");
  ok("delivered during a disabled period → no points", ledger(db, "ao2").length === 0);
  await saveRewardsConfig({ enabled: true }, { db, now: new Date("2026-10-25T00:00:00Z") });
  await setStatus(db, "ao2", "delivered");
  const t = await reconcileOrderRewards({ db });
  ok("after re-enable: disabled-period delivery excluded, reconcile awards nothing",
    ledger(db, "ao2").length === 0 && t.awarded === 0
    && db._tables.rewardOrderAward.find((a) => a.affiliateOrderId === "ao2").exclusionReason === "DISABLED_PERIOD");
  await setStatus(db, "ao3", "delivered");
  ok("a delivery after re-enable earns", ledger(db, "ao3").length === 1);
}

// ── 4. Fake orders (Fake Orders Engine sync path) ───────────────────────────
console.log("\n4. Fake-order sync path");
{
  const db = seed();
  await launch(db);
  const r = await syncLinkedAffiliateOrderStatus("o-fake", "DELIVERED", { db, notify: false });
  ok("fake order synced to delivered (existing behaviour kept)", r.synced && r.delivered
    && db._tables.affiliateOrder.find((o) => o.id === "ao-fake").status === "delivered");
  ok("…but earns no points", ledger(db, "ao-fake").length === 0);
}

// ── 5. Failures: logged, retryable, never break the status change ───────────
console.log("\n5. Failure & rollback");
{
  const db = seed();
  await launch(db);
  let boom = true;
  db._stats.hooks["rewardPointsAccount.upsert"] = async () => { if (boom) throw new Error("db connection reset"); };
  const { out, logs } = await quiet(() => setStatus(db, "ao1", "delivered"));
  ok("rewards failure: status change still succeeds", out.status === "delivered"
    && db._tables.affiliateOrder.find((o) => o.id === "ao1").status === "delivered");
  ok("…failure logged with retry hint", logs.some((l) => /order points sync failed \(reconcile will retry\)/.test(l)));
  ok("…nothing half-written", ledger(db).length === 0 && db._tables.rewardOrderAward.filter((a) => a.state === "AWARDED").length === 0);
  boom = false;
  const t = await reconcileOrderRewards({ db });
  ok("reconcile repairs it exactly once", t.awarded === 1 && ledger(db, "ao1").length === 1);
  ok("second reconcile is a no-op", (await reconcileOrderRewards({ db })).awarded === 0);

  // Failure in the MIDDLE of the award transaction → rolled back, then repaired.
  const db2 = seed();
  await launch(db2);
  let fails = 1;
  db2._stats.hooks["rewardPointsLedger.create"] = async () => { if (fails-- > 0) throw new Error("disk full"); };
  await quiet(() => setStatus(db2, "ao1", "delivered"));
  ok("mid-transaction failure → award row rolled back too",
    !db2._tables.rewardOrderAward.some((a) => a.affiliateOrderId === "ao1") && ledger(db2).length === 0 && balance(db2) === 0);
  await reconcileOrderRewards({ db: db2 });
  ok("…reconcile awards once; books balance", ledger(db2, "ao1").length === 1 && (await verifyAccountBalance("A", { db: db2 })).ok);

  // Hooks never run inside a caller's transaction.
  let called = false;
  const txLike = { affiliateOrder: {} }; // a Prisma tx client has no $transaction
  const d = await quiet(() => onAffiliateOrderStatusCommitted("ao1", { db: txLike, sync: async () => { called = true; } }));
  ok("hook inside a transaction → deferred, sync not called", d.out.action === "deferred" && !called);
  const throwing = new Proxy({}, { get() { throw new Error("denied"); } });
  ok("hostile client accessor → treated as in-transaction, no throw",
    (await quiet(() => onAffiliateOrderStatusCommitted("ao1", { db: throwing }))).out.action === "deferred");
  ok("hook never throws even if sync throws",
    (await quiet(() => onAffiliateOrderStatusCommitted("ao1", { db, sync: async () => { throw new Error("x"); } }))).out.action === "error");
}

// ── 6. Signup bonus on first admin activation ───────────────────────────────
console.log("\n6. Activation bonus");
{
  const NEW = new Date("2026-10-21T00:00:00Z");
  const db = makeRewardsFakeDb({
    affiliate: [
      affRow("OLD", { isActive: false }),                                   // existed before launch
      affRow("N1", { isActive: false, createdAt: NEW }), affRow("N2", { isActive: false, createdAt: NEW }),
      affRow("N3", { isActive: false, createdAt: NEW }), affRow("N4", { isActive: false, createdAt: NEW }),
      affRow("L1", { isActive: false, createdAt: NEW }),
    ],
  });
  await launch(db, { signupBonusEnabled: true, signupBonusPoints: 25 });
  const bonusRows = (id) => db._tables.rewardPointsLedger.filter((l) => l.affiliateId === id && l.type === "SIGNUP_BONUS");
  const decisions = (id) => db._tables.rewardAuditLog.filter((a) => a.action === "SIGNUP_BONUS_DECISION" && a.entityId === id);

  await adminUpdateAffiliate("N1", { isActive: true }, { db });
  ok("first activation of a new affiliate → 25 bonus points", bonusRows("N1").length === 1 && balance(db, "N1") === 25);
  ok("…decision recorded", decisions("N1").length === 1 && decisions("N1")[0].after.awarded === true);
  await adminUpdateAffiliate("N1", { isActive: false }, { db });
  await adminUpdateAffiliate("N1", { isActive: true }, { db });
  ok("deactivate + reactivate → no second bonus", bonusRows("N1").length === 1 && balance(db, "N1") === 25);
  await adminUpdateAffiliate("N1", { name: "Renamed", isActive: true }, { db });
  ok("editing an already-active affiliate → no hook effect", bonusRows("N1").length === 1);

  await adminUpdateAffiliate("OLD", { isActive: true }, { db });
  ok("existing affiliate (created before launch) → no bonus, decision recorded",
    bonusRows("OLD").length === 0 && decisions("OLD")[0]?.after.reason === "EXISTING_AFFILIATE");

  await Promise.all([1, 2, 3].map(() => adminUpdateAffiliate("N2", { isActive: true }, { db })));
  ok("3 concurrent activations → exactly one bonus", bonusRows("N2").length === 1 && balance(db, "N2") === 25);

  // First activation while rewards are OFF counts as THE first activation.
  await saveRewardsConfig({ enabled: false }, { db, now: LAUNCH });
  await adminUpdateAffiliate("N3", { isActive: true }, { db });
  await saveRewardsConfig({ enabled: true }, { db, now: new Date("2026-10-22T00:00:00Z") });
  await adminUpdateAffiliate("N3", { isActive: false }, { db });
  await adminUpdateAffiliate("N3", { isActive: true }, { db });
  ok("first activation while rewards OFF → never a bonus later", bonusRows("N3").length === 0
    && decisions("N3")[0]?.after.reason === "REWARDS_DISABLED");

  // Transient failure: activation succeeds, no decision recorded, reconcile pays once.
  let boom = true;
  db._stats.hooks["rewardPointsAccount.upsert"] = async () => { if (boom) throw new Error("timeout"); };
  const { out, logs } = await quiet(() => adminUpdateAffiliate("N4", { isActive: true }, { db }));
  ok("bonus failure: activation still succeeds", out.isActive === true && db._tables.affiliate.find((a) => a.id === "N4").isActive === true);
  ok("…logged, no decision recorded (retryable)", logs.some((l) => /signup bonus failed \(reconcile will retry\)/.test(l)) && decisions("N4").length === 0);
  boom = false;
  const t = await reconcileSignupBonuses({ db });
  ok("reconcileSignupBonuses pays the missed bonus once", t.awarded === 1 && bonusRows("N4").length === 1);
  ok("…and skips everyone already decided", (await reconcileSignupBonuses({ db })).awarded === 0);

  await legacyUpdateAffiliate("L1", { isActive: true }, { db });
  ok("legacy admin route (/api/affiliate PUT) activation → bonus too", bonusRows("L1").length === 1);

  ok("hook ignores non-activations",
    (await onAffiliateActivationCommitted("N1", { wasActive: true, isActive: true, db })).reason === "NOT_AN_ACTIVATION"
    && (await onAffiliateActivationCommitted("N1", { wasActive: false, isActive: false, db })).reason === "NOT_AN_ACTIVATION");
  ok("affiliate creation itself never awards (created inactive)", db._tables.rewardPointsLedger.every((l) => l.affiliateId !== "OLD"));
}

// ── 7. Separation from commissions + reconcile endpoint ─────────────────────
console.log("\n7. Separation & reconcile endpoint");
{
  const db = seed();
  await launch(db);
  const commissionBefore = await getReferralCommissionComponent("A", db);
  const rowsBefore = JSON.stringify(db._tables.affiliateOrder.map((o) => [o.id, o.commissionAmount, o.total]));
  await setStatus(db, "ao1", "delivered");
  const commissionAfter = await getReferralCommissionComponent("A", db);
  ok("commission is driven by the status, exactly as before (100 MAD delivered)", commissionAfter - commissionBefore === 100);
  ok("points never alter commission amounts / order totals",
    JSON.stringify(db._tables.affiliateOrder.map((o) => [o.id, o.commissionAmount, o.total])) === rowsBefore);
  ok("affiliate money fields untouched by points", db._tables.affiliate.find((a) => a.id === "A").bonusBalance === 0);
  ok("no rewards balance provider registered", !getBalanceProviders().some((p) => /reward|point/i.test(p.source)));

  const h = adminRewardsHandlers({ db });
  await quiet(async () => {
    db._stats.hooks["rewardPointsAccount.upsert"] = async () => { throw new Error("down"); };
    await setStatus(db, "ao2", "delivered");
    delete db._stats.hooks["rewardPointsAccount.upsert"];
  });
  const res = await h.reconcile(new Request("http://x/api/admin/rewards/reconcile", { method: "POST" }), {}, { userId: "admin-1" });
  const body = await res.json();
  ok("POST /api/admin/rewards/reconcile repairs and reports", res.status === 200 && body.orders.awarded === 1 && "signupBonuses" in body);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
