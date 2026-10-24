#!/usr/bin/env node
/**
 * scripts/rewardsRules.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards & Gifts — PURE rules (src/lib/rewards.js), no DB:
 *   • config normalization (admin input never trusted; timestamps not editable)
 *   • redemption status transition table per actor (D5, D6)
 *   • order / signup-bonus / redemption eligibility (D1, D2, D3, D4)
 *   • delivery-details and adjustment validation
 *   • deterministic idempotency keys, reference format, public projection
 * Run: node scripts/rewardsRules.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  normalizeRewardsConfig, DEFAULT_REWARDS_CONFIG, EDITABLE_CONFIG_KEYS, toIntInRange,
  canTransition, ADMIN_TRANSITIONS, REDEMPTION_STATUS as S, ACTOR, TERMINAL_REDEMPTION_STATUSES,
  evaluateOrderEligibility, evaluateSignupBonusEligibility, evaluateRedemptionEligibility,
  validateRecipient, validateAdjustment, validateReason, cleanText, isValidClientRequestId,
  generateRedemptionReference, toPublicRedemption, ledgerKey, computeSpendable, holdUntil,
} from "../src/lib/rewards.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

// ── 1. Config normalization ──────────────────────────────────────────────────
console.log("\n1. Config");
{
  const d = normalizeRewardsConfig(undefined);
  ok("defaults: rewards OFF", d.enabled === false);
  ok("defaults: 0 points per order, bonus OFF", d.pointsPerDeliveredOrder === 0 && d.signupBonusEnabled === false);
  ok("defaults: suspicious orders excluded (D1)", d.excludeSuspicious === true);
  ok("defaults: no hold period (D4)", d.orderPointsHoldDays === 0);
  ok("defaults match DEFAULT_REWARDS_CONFIG", JSON.stringify(d) === JSON.stringify({ ...DEFAULT_REWARDS_CONFIG }));
  ok("array / string input → defaults", normalizeRewardsConfig([1]).enabled === false && normalizeRewardsConfig("x").pointsPerDeliveredOrder === 0);

  const c = normalizeRewardsConfig({ enabled: "true", pointsPerDeliveredOrder: "25", signupBonusPoints: 10.5, orderPointsHoldDays: -1, maxOpenRedemptions: 0 });
  ok("non-boolean enabled ignored", c.enabled === false);
  ok("integer string accepted", c.pointsPerDeliveredOrder === 25);
  ok("float rejected → default", c.signupBonusPoints === 0);
  ok("negative hold days → default", c.orderPointsHoldDays === 0);
  ok("maxOpenRedemptions below 1 → default", c.maxOpenRedemptions === 3);
  ok("points above limit → default", normalizeRewardsConfig({ pointsPerDeliveredOrder: 1_000_001 }).pointsPerDeliveredOrder === 0);
  ok("invalid timestamp → null", normalizeRewardsConfig({ launchedAt: "not a date" }).launchedAt === null);
  ok("valid timestamp → ISO", normalizeRewardsConfig({ launchedAt: "2026-10-19T10:00:00Z" }).launchedAt === "2026-10-19T10:00:00.000Z");
  ok("timestamps are not admin-editable", !EDITABLE_CONFIG_KEYS.some((k) => k.endsWith("At")));
  ok("toIntInRange rejects NaN/Infinity/'' ", [NaN, Infinity, "", " ", null].every((v) => toIntInRange(v, 0, 10, 7) === 7));
}

// ── 2. Transition table ──────────────────────────────────────────────────────
console.log("\n2. Transitions");
{
  const happy = [[S.PENDING_REVIEW, S.APPROVED], [S.APPROVED, S.PREPARING], [S.PREPARING, S.SHIPPED],
    [S.SHIPPED, S.IN_TRANSIT], [S.IN_TRANSIT, S.DELIVERED], [S.SHIPPED, S.DELIVERED]];
  ok("admin happy path allowed", happy.every(([f, t]) => canTransition(f, t, ACTOR.ADMIN)));
  ok("admin reject only from PENDING_REVIEW",
    canTransition(S.PENDING_REVIEW, S.REJECTED, ACTOR.ADMIN) && !canTransition(S.APPROVED, S.REJECTED, ACTOR.ADMIN));
  ok("admin cancel before shipping only",
    [S.PENDING_REVIEW, S.APPROVED, S.PREPARING].every((f) => canTransition(f, S.CANCELLED, ACTOR.ADMIN))
    && ![S.SHIPPED, S.IN_TRANSIT, S.DELIVERED].some((f) => canTransition(f, S.CANCELLED, ACTOR.ADMIN)));
  ok("RETURNED only after shipping (D5)",
    canTransition(S.SHIPPED, S.RETURNED, ACTOR.ADMIN) && canTransition(S.IN_TRANSIT, S.RETURNED, ACTOR.ADMIN)
    && !canTransition(S.PREPARING, S.RETURNED, ACTOR.ADMIN));
  ok("no skipping (PENDING_REVIEW → SHIPPED / DELIVERED)",
    !canTransition(S.PENDING_REVIEW, S.SHIPPED, ACTOR.ADMIN) && !canTransition(S.PENDING_REVIEW, S.DELIVERED, ACTOR.ADMIN));
  ok("no going back (DELIVERED → PREPARING, SHIPPED → APPROVED)",
    !canTransition(S.DELIVERED, S.PREPARING, ACTOR.ADMIN) && !canTransition(S.SHIPPED, S.APPROVED, ACTOR.ADMIN));
  ok("terminal statuses have no exits",
    TERMINAL_REDEMPTION_STATUSES.every((f) => Object.values(S).every((t) => !canTransition(f, t, ACTOR.ADMIN))));
  ok("affiliate may cancel only while PENDING_REVIEW (D6)",
    canTransition(S.PENDING_REVIEW, S.CANCELLED, ACTOR.AFFILIATE) && !canTransition(S.APPROVED, S.CANCELLED, ACTOR.AFFILIATE));
  ok("affiliate cannot approve/ship",
    !canTransition(S.PENDING_REVIEW, S.APPROVED, ACTOR.AFFILIATE) && !canTransition(S.PREPARING, S.SHIPPED, ACTOR.AFFILIATE));
  ok("SYSTEM / unknown actor cannot transition",
    !canTransition(S.PENDING_REVIEW, S.APPROVED, ACTOR.SYSTEM) && !canTransition(S.PENDING_REVIEW, S.APPROVED, "ROOT"));
  ok("unknown / prototype keys rejected",
    !canTransition("toString", S.APPROVED, ACTOR.ADMIN) && !canTransition("__proto__", S.APPROVED, ACTOR.ADMIN));
  ok("every listed target is a known status",
    Object.values(ADMIN_TRANSITIONS).flat().every((t) => Object.values(S).includes(t)));
}

// ── 3. Order eligibility ─────────────────────────────────────────────────────
console.log("\n3. Order eligibility");
{
  const config = normalizeRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 });
  const ao = { affiliateId: "A", orderId: "o1", status: "delivered", isFake: false, isSuspicious: false };
  const order = { id: "o1", isFake: false, affiliateId: "A" };
  const r = (patch = {}, ord = order, cfg = config, opts) => evaluateOrderEligibility({ affiliateOrder: { ...ao, ...patch }, order: ord, config: cfg }, opts).reason;
  ok("eligible delivered real order", evaluateOrderEligibility({ affiliateOrder: ao, order, config }).eligible);
  ok("rewards disabled", r({}, order, { ...config, enabled: false }) === "REWARDS_DISABLED");
  ok("0 points configured", r({}, order, { ...config, pointsPerDeliveredOrder: 0 }) === "NO_POINTS_CONFIGURED");
  ok("re-award ignores 0 points setting (D9)", r({}, order, { ...config, pointsPerDeliveredOrder: 0 }, { requireConfiguredPoints: false }) === null);
  for (const s of ["pending", "confirmed", "shipped", "cancelled", "Delivered", "DELIVERED"]) {
    ok(`status '${s}' → NOT_DELIVERED`, r({ status: s }) === "NOT_DELIVERED");
  }
  ok("fake affiliate order", r({ isFake: true }) === "FAKE_ORDER");
  ok("suspicious excluded (D1)", r({ isSuspicious: true }) === "SUSPICIOUS");
  ok("suspicious allowed when excludeSuspicious off", r({ isSuspicious: true }, order, { ...config, excludeSuspicious: false }) === null);
  ok("unlinked order", r({ orderId: null }) === "NOT_LINKED");
  ok("store order missing", r({}, null) === "ORDER_MISSING");
  ok("fake store order", r({}, { ...order, isFake: true }) === "FAKE_ORDER");
  ok("store order attributed to another affiliate", r({}, { ...order, affiliateId: "B" }) === "AFFILIATE_MISMATCH");
  ok("store order with no attribution is fine", r({}, { ...order, affiliateId: null }) === null);
}

// ── 4. Signup bonus eligibility (D2) ─────────────────────────────────────────
console.log("\n4. Signup bonus eligibility");
{
  const config = normalizeRewardsConfig({
    enabled: true, signupBonusEnabled: true, signupBonusPoints: 50,
    launchedAt: "2026-10-01T00:00:00Z", signupBonusEnabledAt: "2026-10-10T00:00:00Z",
  });
  const aff = (createdAt, isActive = true) => ({ id: "A", isActive, createdAt: new Date(createdAt) });
  const r = (a, c = config) => evaluateSignupBonusEligibility({ affiliate: a, config: c }).reason;
  ok("new active affiliate eligible", r(aff("2026-10-11T00:00:00Z")) === null);
  ok("created before launch → EXISTING_AFFILIATE", r(aff("2026-09-01T00:00:00Z")) === "EXISTING_AFFILIATE");
  ok("created after launch but before bonus enabled → EXISTING_AFFILIATE", r(aff("2026-10-05T00:00:00Z")) === "EXISTING_AFFILIATE");
  ok("inactive affiliate", r(aff("2026-10-11T00:00:00Z", false)) === "AFFILIATE_INACTIVE");
  ok("bonus disabled", r(aff("2026-10-11T00:00:00Z"), { ...config, signupBonusEnabled: false }) === "BONUS_DISABLED");
  ok("bonus 0 points", r(aff("2026-10-11T00:00:00Z"), { ...config, signupBonusPoints: 0 }) === "BONUS_DISABLED");
  ok("missing enable timestamp fails closed", r(aff("2026-10-11T00:00:00Z"), { ...config, signupBonusEnabledAt: null }) === "BONUS_DISABLED");
  ok("rewards disabled", r(aff("2026-10-11T00:00:00Z"), { ...config, enabled: false }) === "REWARDS_DISABLED");
  ok("no affiliate", r(null) === "AFFILIATE_NOT_FOUND");
}

// ── 5. Redemption eligibility ────────────────────────────────────────────────
console.log("\n5. Redemption eligibility");
{
  const config = normalizeRewardsConfig({ enabled: true, maxOpenRedemptions: 2 });
  const gift = { isActive: true, archivedAt: null, stock: 3, pointsCost: 100, minDeliveredOrders: 2, maxPerAffiliate: 1 };
  const base = { config, affiliate: { isActive: true }, gift, spendable: 100, deliveredOrders: 2, giftRedemptions: 0, openRedemptions: 0 };
  const c = (patch) => evaluateRedemptionEligibility({ ...base, ...patch }).code;
  ok("eligible with exact points", evaluateRedemptionEligibility(base).ok);
  ok("rewards disabled", c({ config: { ...config, enabled: false } }) === "REWARDS_DISABLED");
  ok("inactive affiliate", c({ affiliate: { isActive: false } }) === "AFFILIATE_INACTIVE");
  ok("inactive gift", c({ gift: { ...gift, isActive: false } }) === "GIFT_UNAVAILABLE");
  ok("archived gift", c({ gift: { ...gift, archivedAt: new Date() } }) === "GIFT_UNAVAILABLE");
  ok("no stock", c({ gift: { ...gift, stock: 0 } }) === "OUT_OF_STOCK");
  ok("min delivered orders", c({ deliveredOrders: 1 }) === "MIN_ORDERS_NOT_MET");
  ok("per-affiliate gift limit", c({ giftRedemptions: 1 }) === "GIFT_LIMIT_REACHED");
  ok("too many open requests", c({ openRedemptions: 2 }) === "TOO_MANY_OPEN_REQUESTS");
  ok("insufficient points", c({ spendable: 99 }) === "INSUFFICIENT_POINTS");
  ok("points debt (negative) blocks (D3)", c({ spendable: -5 }) === "INSUFFICIENT_POINTS");
  ok("spendable never negative", computeSpendable(10, 30) === 0 && computeSpendable(-5, 0) === 0 && computeSpendable(50, 20) === 30);
  ok("holdUntil adds days", holdUntil("2026-10-19T00:00:00Z", 7).toISOString() === "2026-10-26T00:00:00.000Z");
}

// ── 6. Validation ────────────────────────────────────────────────────────────
console.log("\n6. Validation");
{
  const good = { fullName: "  Salma  Ben ", phone: "+212 6-12.34(56)78", city: "Casablanca", address: "12 rue des Fleurs, Maarif", deliveryNotes: "" };
  const v = validateRecipient(good);
  ok("valid recipient", v.ok);
  ok("name whitespace collapsed", v.value.fullName === "Salma Ben");
  ok("phone normalized", v.value.phone === "+212612345678");
  ok("empty notes → null", v.value.deliveryNotes === null);
  ok("control characters stripped", cleanText("a\u0000b\nc\td") === "a b c d");
  const bad = validateRecipient({ fullName: "x", phone: "abc", city: "", address: "1", deliveryNotes: "n".repeat(501) });
  ok("all recipient errors reported",
    !bad.ok && bad.errors.fullName && bad.errors.phone && bad.errors.city && bad.errors.address && bad.errors.deliveryNotes);
  ok("non-object recipient rejected", !validateRecipient(null).ok && !validateRecipient("x").ok);
  ok("non-string fields rejected", !validateRecipient({ ...good, fullName: { $ne: "" } }).ok);

  ok("reason too short rejected", validateReason("abc") === null);
  ok("reason trimmed", validateReason("  bonne raison  ") === "bonne raison");
  const adj = validateAdjustment({ delta: -20, reason: "Correction erreur", clientRequestId: "req-12345678" });
  ok("valid adjustment", adj.ok && adj.value.delta === -20);
  for (const delta of [0, 1.5, "10", 1_000_001, NaN, null]) {
    ok(`adjustment delta ${JSON.stringify(delta)} rejected`, !validateAdjustment({ delta, reason: "Correction erreur", clientRequestId: "req-12345678" }).ok);
  }
  ok("adjustment needs a reason", validateAdjustment({ delta: 5, reason: "", clientRequestId: "req-12345678" }).errors.reason === "REASON_REQUIRED");
  ok("adjustment needs a request id", validateAdjustment({ delta: 5, reason: "Correction erreur" }).errors.clientRequestId === "INVALID_REQUEST_ID");
  ok("client request id format", isValidClientRequestId("a1b2c3d4") && !isValidClientRequestId("short") && !isValidClientRequestId("bad id with spaces!"));
}

// ── 7. Keys, references, projection ──────────────────────────────────────────
console.log("\n7. Keys & references");
{
  ok("signup key", ledgerKey.signup("A") === "signup:A");
  ok("versioned order keys differ per version",
    ledgerKey.orderAward("x", 1) === "order:x:award:v1" && ledgerKey.orderAward("x", 2) !== ledgerKey.orderAward("x", 1)
    && ledgerKey.orderReversal("x", 1) === "order:x:reverse:v1");
  ok("redemption keys", ledgerKey.redemptionDebit("r") === "redemption:r:debit" && ledgerKey.redemptionRefund("r") === "redemption:r:refund");
  ok("adjustment key scoped to affiliate", ledgerKey.adjustment("A", "q") === "adjust:A:q");
  const ref = generateRedemptionReference(new Date("2026-10-19T23:30:00Z"), Uint8Array.from([0, 1, 31, 32, 255, 10]));
  ok("reference format RW-YYYYMMDD-XXXXXX (UTC)", ref === "RW-20261019-01Z0ZA");
  ok("reference alphabet excludes I/L/O/U",
    !/[ILOU]/.test(generateRedemptionReference(new Date(), Uint8Array.from([18, 21, 24, 27, 30, 31]))));
  const pub = toPublicRedemption({ id: "r", internalNotes: "secret", clientRequestId: "q", status: S.SHIPPED });
  ok("public view strips internal notes + request id", !("internalNotes" in pub) && !("clientRequestId" in pub) && pub.status === S.SHIPPED);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
