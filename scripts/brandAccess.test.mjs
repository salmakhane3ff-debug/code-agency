#!/usr/bin/env node
/**
 * scripts/brandAccess.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — purchase of ACCESS to the training simulator.
 * Drives the real access service and route handlers against the brand fake DB
 * (strict: any non-brand table throws). Proves:
 *   • a request needs 3–4 DIFFERENT products from the admin catalogue that are
 *     eligible now (published, active, not locked); names/images are read from
 *     the store and snapshotted, never taken from the request; no price is kept
 *   • a request needs: offer enabled, an active package, a valid fictional brand
 *     name, an active branding option (if any), the CURRENT published terms
 *     explicitly accepted, and a valid client request id
 *   • package, price, branding and accepted terms text are snapshotted
 *   • idempotent replays; one open (pending/active) access per affiliate, also
 *     under concurrent clicks
 *   • the participant can cancel only their own PENDING request
 *   • activation ONLY by an admin accepting the participant's payment proof,
 *     only from PENDING_PAYMENT; start time = activation + start delay,
 *     snapshotted; concurrent double acceptance activates once; rejection needs
 *     a reason (lifecycle, proofs and authorizations: brandLifecycle.test.mjs)
 *   • every action audited; identity from the session only; no payment is
 *     recorded and no wallet / order / commission / Rewards table is touched
 * Run: node scripts/brandAccess.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID } from "../src/lib/brandProgram.js";
import {
  requestBrandAccess, cancelOwnAccess, adminRejectAccess, adminListAccesses, publicAccess, ACCESS_STATUS,
} from "../src/lib/services/brandAccessService.js";
import { adminAcceptProof, submitPaymentProof } from "../src/lib/services/brandPaymentService.js";
import { makeProofStorage, proofInput, payAndAccept } from "./lib/brandProofKit.mjs";
import { termsTextSha256 } from "../src/lib/services/brandConsentService.js";
import { saveBrandConfig } from "../src/lib/services/brandProgramService.js";
import { adminBrandHandlers, affiliateBrandHandlers } from "../src/lib/brandRouteHandlers.js";
import { makeBrandFakeDb } from "./lib/brandFakeDb.mjs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const NOW = new Date("2026-10-28T10:00:00Z");
const HOUR = 3_600_000;
/** Test values only — not product defaults. */
const LIST = ["prod-1", "prod-2", "prod-3", "prod-4", "prod-draft", "prod-off", "prod-locked", "prod-gone"];
const PRICING = { deliveryCost: 50, logisticsCost: 25, vatPercent: 20,
  percentages: { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 10, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } } };
const config = (over = {}) => ({
  enabled: true,
  packages: [
    { id: "p1", name: "Formation essentielle", price: 1500, active: true, description: "d", features: ["Module A", "Module B"], productCount: 3, productIds: LIST, ...PRICING },
    { id: "p2", name: "Ancienne formation", price: 900, active: false },
    { id: "p3", name: "Formation complète", price: 2500, active: true, productCount: 4, productIds: LIST, ...PRICING },
    { id: "p4", name: "Formation courte", price: 700, active: true, productCount: 3, productIds: ["prod-1", "prod-2", "prod-3"], ...PRICING },
  ],
  brandingOptions: [{ id: "o1", label: "Logo minimaliste", description: "", active: true }, { id: "o2", label: "Caché", active: false }],
  simulation: { enabled: true, startDelayHours: 5, dailyVolumeMin: 2, dailyVolumeMax: 6, confirmationDelayHours: 1, deliveryDelayHours: 24,
    distribution: { delivered: 50, refused: 10, returned: 5, noResponse: 20, cancelled: 15 } },
  catalogProductIds: ["prod-1", "prod-2", "prod-3", "prod-4", "prod-draft", "prod-off", "prod-locked", "prod-gone"],
  ...over,
});
/** Store products (test rows). prod-x is eligible but NOT in the brand catalogue. */
const PRODUCTS = [
  { id: "prod-1", title: "Sérum éclat", images: ["https://cdn.test/1.jpg"], regularPrice: 300, salePrice: 199, costPerItem: 40 },
  { id: "prod-2", title: "Crème de nuit", images: [{ url: "/uploads/2.jpg" }], regularPrice: 250 },
  { id: "prod-3", title: "Huile d'argan", images: [] },
  { id: "prod-4", title: "Savon noir", images: ["javascript:alert(1)"] },
  { id: "prod-draft", title: "Brouillon", status: "Draft" },
  { id: "prod-off", title: "Désactivé", isActive: false },
  { id: "prod-locked", title: "Verrouillé", isLocked: true },
  { id: "prod-x", title: "Hors catalogue" },
];
const terms = (version = 1) => ({ draft: { text: `Conditions v${version}` }, published: { version, text: `Conditions v${version}`, publishedAt: "2026-10-27T00:00:00Z" } });
const newDb = (over = {}) => makeBrandFakeDb({
  clock: () => NOW, // acceptance times are written by the database clock
  affiliates: [{ id: "a1", username: "amina" }, { id: "a2", username: "badr" }, { id: "a3", username: "off", isActive: false }],
  products: PRODUCTS,
  settings: { [BRAND_SETTING_ID]: over.config ?? config(), ...(over.terms === null ? {} : { [BRAND_TERMS_SETTING_ID]: over.terms ?? terms() }) },
});
const input = (over = {}) => ({ productIds: ["prod-1", "prod-2", "prod-3"], packageId: "p1", brandName: "Ma Marque", brandingOptionId: "o1", termsVersion: 1, acceptTerms: true, clientRequestId: "req-00000001", ...over });

// ── 1. Request validation ─────────────────────────────────────────────────────
console.log("\n1. Request validation");
{
  const code = async (db, inp) => (await rejects(requestBrandAccess("a1", inp, { db, now: NOW })))?.code;
  ok("offer disabled → BRAND_DISABLED", await code(newDb({ config: config({ enabled: false }) }), input()) === "BRAND_DISABLED");
  const db = newDb();
  ok("unknown package → PACKAGE_NOT_FOUND", await code(db, input({ packageId: "zz" })) === "PACKAGE_NOT_FOUND");
  ok("inactive package → PACKAGE_NOT_FOUND", await code(db, input({ packageId: "p2" })) === "PACKAGE_NOT_FOUND");
  ok("invalid brand name → INVALID_BRAND_NAME", await code(db, input({ brandName: "<b>" })) === "INVALID_BRAND_NAME" && await code(db, input({ brandName: "x" })) === "INVALID_BRAND_NAME");
  ok("inactive branding option → BRANDING_NOT_FOUND", await code(db, input({ brandingOptionId: "o2" })) === "BRANDING_NOT_FOUND");
  ok("no published terms → TERMS_NOT_PUBLISHED", await code(newDb({ terms: null }), input()) === "TERMS_NOT_PUBLISHED");
  ok("terms changed since displayed → TERMS_CHANGED", await code(newDb({ terms: terms(2) }), input({ termsVersion: 1 })) === "TERMS_CHANGED");
  ok("terms not explicitly accepted → TERMS_NOT_ACCEPTED", await code(db, input({ acceptTerms: "yes" })) === "TERMS_NOT_ACCEPTED");
  ok("bad client request id → INVALID_INPUT", await code(db, input({ clientRequestId: "x" })) === "INVALID_INPUT");
  ok("nothing written by refused requests", db._tables.brandAccess.length === 0 && db._tables.brandAuditLog.length === 0);
}

// ── 1b. Product selection ─────────────────────────────────────────────────────
console.log("\n1b. Product selection (server-side)");
{
  const db = newDb();
  const code = async (inp) => (await rejects(requestBrandAccess("a1", inp, { db, now: NOW })))?.code;
  ok("no products → INVALID_PRODUCT_SELECTION", await code(input({ productIds: undefined })) === "INVALID_PRODUCT_SELECTION");
  ok("2 products (too few) → INVALID_PRODUCT_SELECTION", await code(input({ productIds: ["prod-1", "prod-2"] })) === "INVALID_PRODUCT_SELECTION");
  ok("5 products (too many) → INVALID_PRODUCT_SELECTION", await code(input({ productIds: ["prod-1", "prod-2", "prod-3", "prod-4", "prod-x"] })) === "INVALID_PRODUCT_SELECTION");
  ok("the same product twice → INVALID_PRODUCT_SELECTION", await code(input({ productIds: ["prod-1", "prod-1", "prod-2"] })) === "INVALID_PRODUCT_SELECTION");
  ok("non-string / malformed ids → INVALID_PRODUCT_SELECTION", await code(input({ productIds: [1, 2, 3] })) === "INVALID_PRODUCT_SELECTION"
    && await code(input({ productIds: ["prod-1", "prod-2", "<x>"] })) === "INVALID_PRODUCT_SELECTION" && await code(input({ productIds: "prod-1,prod-2,prod-3" })) === "INVALID_PRODUCT_SELECTION");
  ok("objects with client prices are refused (only ids accepted)", await code(input({ productIds: [{ id: "prod-1", price: 1 }, "prod-2", "prod-3"] })) === "INVALID_PRODUCT_SELECTION");
  ok("eligible product outside the brand catalogue → PRODUCT_NOT_AVAILABLE", await code(input({ productIds: ["prod-1", "prod-2", "prod-x"] })) === "PRODUCT_NOT_AVAILABLE");
  for (const id of ["prod-draft", "prod-off", "prod-locked", "prod-gone"]) {
    ok(`catalogue product that is ${id.slice(5)} → PRODUCT_NOT_AVAILABLE`, await code(input({ productIds: ["prod-1", "prod-2", id] })) === "PRODUCT_NOT_AVAILABLE");
  }
  ok("the package is checked first (the product count depends on it)", await code(input({ productIds: ["prod-1"], packageId: "zz", brandName: "x" })) === "PACKAGE_NOT_FOUND");
  ok("4 products for a 3-product package → INVALID_PRODUCT_SELECTION", await code(input({ productIds: ["prod-4", "prod-1", "prod-2", "prod-3"] })) === "INVALID_PRODUCT_SELECTION");
  ok("3 products for a 4-product package → INVALID_PRODUCT_SELECTION", await code(input({ packageId: "p3" })) === "INVALID_PRODUCT_SELECTION");
  ok("catalogue product not in this package's list → PRODUCT_NOT_AVAILABLE", await code(input({ packageId: "p4", productIds: ["prod-1", "prod-2", "prod-4"] })) === "PRODUCT_NOT_AVAILABLE");
  ok("nothing written by refused selections", db._tables.brandAccess.length === 0 && db._tables.brandAuditLog.length === 0);
  const four = await requestBrandAccess("a1", input({ packageId: "p3", productIds: ["prod-4", "prod-1", "prod-2", "prod-3"] }), { db, now: NOW });
  ok("4-product package: 4 eligible products accepted, in the participant's order", four.products.map((p) => p.id).join() === "prod-4,prod-1,prod-2,prod-3");
  const empty = newDb({ config: config({ catalogProductIds: [] }) });
  ok("empty catalogue → no package offered (PACKAGE_NOT_FOUND)", (await rejects(requestBrandAccess("a1", input(), { db: empty, now: NOW })))?.code === "PACKAGE_NOT_FOUND");
  const few = newDb({ config: config({ packages: [{ ...config().packages[0], productIds: ["prod-1", "prod-2", "prod-locked"] }] }) });
  ok("package with fewer eligible products than its count is not offered", (await rejects(requestBrandAccess("a1", input(), { db: few, now: NOW })))?.code === "PACKAGE_NOT_FOUND");
  const incomplete = newDb({ config: config({ packages: [{ ...config().packages[0], vatPercent: null }] }) });
  ok("incomplete package (VAT not configured) is not offered", (await rejects(requestBrandAccess("a1", input(), { db: incomplete, now: NOW })))?.code === "PACKAGE_NOT_FOUND");
}

// ── 2. Successful request ─────────────────────────────────────────────────────
console.log("\n2. Request recorded (PENDING_PAYMENT), snapshots, audit");
{
  const db = newDb();
  const out = await requestBrandAccess("a1", input(), { db, now: NOW });
  const row = db._tables.brandAccess[0];
  ok("status PENDING_PAYMENT", out.status === ACCESS_STATUS.PENDING_PAYMENT && row.status === "PENDING_PAYMENT");
  ok("package and features snapshotted", row.packageSnapshot.name === "Formation essentielle" && row.packageSnapshot.features.length === 2 && row.packageSnapshot.productCount === 3);
  ok("amount = server-computed total: (1500 + 50 + 25) + 20 % VAT = 1890.00", row.amount === "1890.00");
  ok("pricing settings and breakdown snapshotted", row.packageSnapshot.price === 1500 && row.packageSnapshot.deliveryCost === 50 && row.packageSnapshot.vatPercent === 20
    && row.packageSnapshot.breakdown.subtotal === 1575 && row.packageSnapshot.breakdown.vat.amount === 315 && row.packageSnapshot.breakdown.total === 1890
    && row.packageSnapshot.percentages.advertising.base === "PACKAGE_PRICE");
  ok("participant view carries the snapshot breakdown", out.amount === 1890 && out.package.breakdown.total === 1890 && out.package.productCount === 3);
  ok("audit row records amount, subtotal and VAT", db._tables.brandAuditLog[0].after.amount === "1890.00" && db._tables.brandAuditLog[0].after.subtotal === 1575 && db._tables.brandAuditLog[0].after.vat === 315);
  ok("branding and accepted terms snapshotted", row.brandingSnapshot.label === "Logo minimaliste" && row.termsVersion === 1
    && row.termsSnapshot.text === "Conditions v1" && row.termsSnapshot.acceptedAt === NOW.toISOString() // written by the database clock
    && row.termsTextSha256 === termsTextSha256("Conditions v1"));
  ok("audit ACCESS_REQUESTED by the affiliate", db._tables.brandAuditLog.length === 1 && db._tables.brandAuditLog[0].action === "ACCESS_REQUESTED"
    && db._tables.brandAuditLog[0].actorType === "AFFILIATE" && db._tables.brandAuditLog[0].actorId === "a1");
  ok("participant view hides payment reference, request key and admin ids", !("paymentReference" in out) && !("clientRequestId" in out) && !("activatedBy" in out));
  ok("selected products snapshotted from the store: id, name, first image only", JSON.stringify(row.selectedProducts) === JSON.stringify([
    { id: "prod-1", title: "Sérum éclat", image: "https://cdn.test/1.jpg" }, { id: "prod-2", title: "Crème de nuit", image: "/uploads/2.jpg" }, { id: "prod-3", title: "Huile d'argan", image: null }]));
  ok("no store price, cost or stock copied into the request", !/regularPrice|salePrice|costPerItem|199|300|\b40\b/.test(JSON.stringify(row.selectedProducts)));
  ok("participant view lists the selected products", out.products.length === 3 && out.products[0].title === "Sérum éclat");
  ok("audit row records the selected product ids", db._tables.brandAuditLog[0].after.productIds.join() === "prod-1,prod-2,prod-3");

  await saveBrandConfig(config({ packages: [{ ...config().packages[0], price: 9999, vatPercent: 10, deliveryCost: 0 }, ...config().packages.slice(1)] }), { db, actorId: "admin-1" });
  ok("a later price / VAT / cost change never alters the request", db._tables.brandAccess[0].amount === "1890.00" && db._tables.brandAccess[0].packageSnapshot.breakdown.total === 1890
    && db._tables.brandAccess[0].packageSnapshot.vatPercent === 20);
  const forged = newDb();
  const f = await requestBrandAccess("a1", input({ amount: 1, price: 1, total: 1, breakdown: { total: 1 }, vatPercent: 0 }), { db: forged, now: NOW });
  ok("amounts sent by the browser are ignored", f.amount === 1890 && forged._tables.brandAccess[0].amount === "1890.00");
}

// ── 3. Idempotency and one open access ────────────────────────────────────────
console.log("\n3. Idempotency and one open access per affiliate");
{
  const db = newDb();
  const first = await requestBrandAccess("a1", input(), { db, now: NOW });
  const again = await requestBrandAccess("a1", input(), { db, now: NOW });
  ok("same request id → same request, one row, one audit row", first.id === again.id && db._tables.brandAccess.length === 1 && db._tables.brandAuditLog.length === 1);
  ok("same request id, different content → IDEMPOTENCY_CONFLICT", (await rejects(requestBrandAccess("a1", input({ brandName: "Autre" }), { db, now: NOW })))?.code === "IDEMPOTENCY_CONFLICT");
  ok("same request id, different products → IDEMPOTENCY_CONFLICT", (await rejects(requestBrandAccess("a1", input({ productIds: ["prod-1", "prod-2", "prod-4"] }), { db, now: NOW })))?.code === "IDEMPOTENCY_CONFLICT");
  ok("a second request while one is open → ACCESS_EXISTS", (await rejects(requestBrandAccess("a1", input({ clientRequestId: "req-00000002" }), { db, now: NOW })))?.code === "ACCESS_EXISTS");
  ok("another affiliate is not affected", (await requestBrandAccess("a2", input({ clientRequestId: "req-00000009" }), { db, now: NOW })).status === "PENDING_PAYMENT");

  const db2 = newDb();
  const results = await Promise.allSettled([1, 2, 3, 4].map((i) => requestBrandAccess("a1", input({ clientRequestId: `req-0000010${i}` }), { db: db2, now: NOW })));
  ok("4 concurrent clicks with different keys → exactly one request", results.filter((r) => r.status === "fulfilled").length === 1
    && results.filter((r) => r.status === "rejected" && r.reason.code === "ACCESS_EXISTS").length === 3 && db2._tables.brandAccess.length === 1);
  const db3 = newDb();
  await Promise.all([1, 2, 3].map(() => requestBrandAccess("a1", input(), { db: db3, now: NOW })));
  ok("3 concurrent retries of the same click → one request", db3._tables.brandAccess.length === 1);
}

// ── 3b. Immutable request snapshot ────────────────────────────────────────────
console.log("\n3b. Immutable request snapshot");
{
  const db = newDb();
  const acc = await requestBrandAccess("a1", input(), { db, now: NOW });
  for (const [col, value] of [["amount", "1.00"], ["packageSnapshot", {}], ["selectedProducts", []], ["termsSnapshot", {}], ["brandName", "Autre"]]) {
    const e = await rejects(db.brandAccess.updateMany({ where: { id: acc.id }, data: { [col]: value } }));
    ok(`changing ${col} after creation is refused`, /immutable/.test(e?.message || ""));
  }
  ok("lifecycle columns still move (activation)", (await payAndAccept(db, "a1", acc.id, { ref: "VIR-77", now: NOW })).status === "ACTIVE"
    && db._tables.brandAccess[0].amount === "1890.00");
}

// ── 4. Participant cancellation ───────────────────────────────────────────────
console.log("\n4. Participant cancellation (pending only)");
{
  const db = newDb();
  const acc = await requestBrandAccess("a1", input(), { db, now: NOW });
  ok("another affiliate cannot cancel it → ACCESS_NOT_FOUND", (await rejects(cancelOwnAccess("a2", acc.id, { db, now: NOW })))?.code === "ACCESS_NOT_FOUND");
  const c = await cancelOwnAccess("a1", acc.id, { db, now: NOW });
  ok("own pending request → CANCELLED + audit", c.status === "CANCELLED" && db._tables.brandAuditLog.at(-1).action === "ACCESS_CANCELLED");
  ok("cancelling twice → NOT_PENDING", (await rejects(cancelOwnAccess("a1", acc.id, { db, now: NOW })))?.code === "NOT_PENDING");
  ok("a new request is possible afterwards", (await requestBrandAccess("a1", input({ clientRequestId: "req-00000003" }), { db, now: NOW })).status === "PENDING_PAYMENT");
}

// ── 5. Admin activation (by accepting the payment proof) ─────────────────────
console.log("\n5. Admin activation after payment verification (proof accepted)");
{
  const db = newDb();
  const storage = makeProofStorage();
  const acc = await requestBrandAccess("a1", input(), { db, now: NOW });
  const at = new Date(NOW.getTime() + 2 * HOUR);
  ok("no proof yet → PROOF_NOT_FOUND (nothing activated)", (await rejects(adminAcceptProof(acc.id, { db, actorId: "admin-1", now: at })))?.code === "PROOF_NOT_FOUND"
    && db._tables.brandAccess[0].status === "PENDING_PAYMENT");
  ok("unknown access → ACCESS_NOT_FOUND", (await rejects(adminAcceptProof("nope", { db, actorId: "admin-1", now: at })))?.code === "ACCESS_NOT_FOUND");
  await submitPaymentProof("a1", acc.id, proofInput("A", { ref: "VIR-2026-001" }), { db, storage });
  const a = await adminAcceptProof(acc.id, { db, actorId: "admin-1", now: at });
  ok("ACTIVE, activated by the admin, transfer reference kept", a.status === "ACTIVE" && a.activatedBy === "admin-1" && a.paymentReference === "VIR-2026-001");
  ok("simulation starts at activation + configured delay", a.simulationStartsAt === new Date(at.getTime() + 5 * HOUR).toISOString());
  ok("audit ACCESS_ACTIVATED names the accepted proof", db._tables.brandAuditLog.at(-1).action === "ACCESS_ACTIVATED"
    && db._tables.brandAuditLog.at(-1).after.proofId === db._tables.brandPaymentProof[0].id);
  ok("accepting twice → NOT_PENDING", (await rejects(adminAcceptProof(acc.id, { db, actorId: "admin-2", now: at })))?.code === "NOT_PENDING");
  await saveBrandConfig(config({ simulation: { ...config().simulation, startDelayHours: 48 } }), { db, actorId: "admin-1" });
  ok("a later start-delay change never moves an activated start", db._tables.brandAccess[0].simulationStartsAt.getTime() === at.getTime() + 5 * HOUR);
  ok("an active access cannot be cancelled by the participant", (await rejects(cancelOwnAccess("a1", acc.id, { db, now: at })))?.code === "NOT_PENDING");

  const db2 = newDb();
  const acc2 = await requestBrandAccess("a1", input(), { db: db2, now: NOW });
  await submitPaymentProof("a1", acc2.id, proofInput("B"), { db: db2, storage });
  const both = await Promise.allSettled([
    adminAcceptProof(acc2.id, { db: db2, actorId: "admin-1", now: NOW }),
    adminAcceptProof(acc2.id, { db: db2, actorId: "admin-2", now: NOW }),
  ]);
  ok("two admins accepting at once → exactly one activation", both.filter((r) => r.status === "fulfilled").length === 1
    && db2._tables.brandAuditLog.filter((x) => x.action === "ACCESS_ACTIVATED").length === 1);
  const noDelay = newDb({ config: config({ simulation: { enabled: false } }) });
  const acc3 = await requestBrandAccess("a1", input(), { db: noDelay, now: NOW });
  ok("no start delay configured yet → start = activation time", (await payAndAccept(noDelay, "a1", acc3.id, { now: NOW })).simulationStartsAt === NOW.toISOString());
}

// ── 6. Admin rejection ────────────────────────────────────────────────────────
console.log("\n6. Admin rejection");
{
  const db = newDb();
  const acc = await requestBrandAccess("a1", input(), { db, now: NOW });
  ok("reason required", (await rejects(adminRejectAccess(acc.id, { reason: "" }, { db, actorId: "admin-1", now: NOW })))?.code === "REASON_REQUIRED");
  const r = await adminRejectAccess(acc.id, { reason: "Paiement introuvable" }, { db, actorId: "admin-1", now: NOW });
  ok("REJECTED, reason visible to the participant", r.status === "REJECTED" && publicAccess(db._tables.brandAccess[0]).rejectionReason === "Paiement introuvable");
  ok("cannot activate a rejected request", (await rejects(adminAcceptProof(acc.id, { db, actorId: "admin-1", now: NOW })))?.code === "PROOF_NOT_FOUND"
    && (await rejects(submitPaymentProof("a1", acc.id, proofInput("R"), { db, storage: makeProofStorage() })))?.code === "NOT_PENDING");
  ok("a new request is possible after a rejection", (await requestBrandAccess("a1", input({ clientRequestId: "req-00000004" }), { db, now: NOW })).status === "PENDING_PAYMENT");
  const list = await adminListAccesses({ db, status: "REJECTED" });
  ok("admin list filters by status and shows the affiliate", list.length === 1 && list[0].affiliate.username === "amina");
  ok("admin search by username / brand name", (await adminListAccesses({ db, q: "AMI" })).length === 2 && (await adminListAccesses({ db, q: "inconnu" })).length === 0);
}

// ── 7. Route handlers ─────────────────────────────────────────────────────────
console.log("\n7. Route handlers");
{
  const db = newDb();
  const aff = affiliateBrandHandlers({ db, now: () => NOW });
  const adm = adminBrandHandlers({ db, now: () => NOW });
  const post = (body) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const created = await aff.requestAccess(post({ ...input(), affiliateId: "a2" }), {}, { affiliateId: "a1" });
  const body = await created.json();
  ok("POST request → 201", created.status === 201 && body.status === "PENDING_PAYMENT");
  ok("identity from the session, never from the body", db._tables.brandAccess[0].affiliateId === "a1");
  ok("inactive account → 403", (await aff.requestAccess(post(input({ clientRequestId: "req-00000005" })), {}, { affiliateId: "a3" })).status === 403);
  ok("conflict codes map to 409", (await aff.requestAccess(post(input({ clientRequestId: "req-00000006" })), {}, { affiliateId: "a1" })).status === 409);
  const ov = await (await aff.overview(new Request("http://x"), {}, { affiliateId: "a1" })).json();
  ok("overview returns the offer, published terms and own access", ov.enabled === true && ov.terms.version === 1 && ov.access.id === body.id);
  const p1 = ov.packages.find((p) => p.id === "p1");
  ok("overview: offered packages with product count, eligible products (admin order, no price) and breakdown",
    ov.packages.map((p) => p.id).join() === "p4,p1,p3" && p1.productCount === 3 && p1.products.map((p) => p.id).join() === "prod-1,prod-2,prod-3,prod-4"
    && p1.products.every((p) => Object.keys(p).sort().join() === "id,image,title") && p1.breakdown.total === 1890, ov.packages.map((p) => p.id).join());
  ok("inactive / incomplete packages and pricing internals never sent", !ov.packages.some((p) => p.id === "p2") && !("percentages" in p1) && !("productIds" in p1));
  ok("unsafe image URL never sent", p1.products.find((p) => p.id === "prod-4").image === null);
  ok("own access shows brand name and selected products", ov.access.brandName === "Ma Marque" && ov.access.products.map((p) => p.id).join() === "prod-1,prod-2,prod-3");
  ok("bad selection → 400, unavailable product → 409", (await aff.requestAccess(post(input({ clientRequestId: "req-00000007", productIds: ["prod-1"] })), {}, { affiliateId: "a2" })).status === 400
    && (await aff.requestAccess(post(input({ clientRequestId: "req-00000008", productIds: ["prod-1", "prod-2", "prod-locked"] })), {}, { affiliateId: "a2" })).status === 409);
  const cands = await (await adm.listProducts(new Request("http://x"), {}, { userId: "admin-1" })).json();
  ok("admin product picker: every store product with eligibility + catalogue flags", cands.length === PRODUCTS.length
    && cands.find((p) => p.id === "prod-x").eligible === true && cands.find((p) => p.id === "prod-x").inCatalog === false
    && cands.find((p) => p.id === "prod-locked").eligible === false && cands.find((p) => p.id === "prod-1").inCatalog === true
    && cands.every((p) => !("regularPrice" in p) && !("costPerItem" in p)));

  const invalid = await adm.actOnAccess(post({ action: "delete" }), { params: Promise.resolve({ id: body.id }) }, { userId: "admin-1" });
  ok("unknown admin action → 400", invalid.status === 400);
  const legacy = await adm.actOnAccess(post({ action: "activate", paymentReference: "VIR-9" }), { params: Promise.resolve({ id: body.id }) }, { userId: "admin-9" });
  ok("direct activation without a proof no longer exists → 400", legacy.status === 400 && db._tables.brandAccess[0].status === "PENDING_PAYMENT");
  await submitPaymentProof("a1", body.id, proofInput("route"), { db, storage: makeProofStorage() });
  const act = await adm.actOnAccess(post({ action: "accept-proof" }), { params: Promise.resolve({ id: body.id }) }, { userId: "admin-9" });
  ok("admin activation via the route (proof accepted), actor from the session", act.status === 200 && db._tables.brandAccess[0].activatedBy === "admin-9");
  await saveBrandConfig(config({ enabled: false }), { db, actorId: "admin-1" });
  const ov2 = await (await aff.overview(new Request("http://x"), {}, { affiliateId: "a1" })).json();
  ok("offer disabled later: participant still gets their active access", ov2.enabled === false && ov2.access.status === "ACTIVE" && !("packages" in ov2));
  ok("cancel via the route only for own requests", (await aff.cancelAccess(post({}), { params: Promise.resolve({ id: body.id }) }, { affiliateId: "a2" })).status === 404);
  const bad = await affiliateBrandHandlers({ db: newDb(), now: () => NOW }).requestAccess(post(input({ productIds: ["prod-1"] })), {}, { affiliateId: "a2" }); // offer is off in `db` by now
  ok("selection error tells the client the package's exact count", bad.status === 400 && (await bad.json()).expected === 3);
  const reqAudit = await (await adm.listAudit(new Request(`http://x/api/admin/brand/audit?entityId=${body.id}`), {}, { userId: "admin-1" })).json();
  ok("audit filtered to one request", reqAudit.length >= 2 && reqAudit.every((r) => r.entityId === body.id)
    && reqAudit.some((r) => r.action === "ACCESS_REQUESTED") && reqAudit.some((r) => r.action === "ACCESS_ACTIVATED"));
  ok("invalid audit filter → 400", (await adm.listAudit(new Request("http://x/api/admin/brand/audit?entityId=a%20b"), {}, { userId: "admin-1" })).status === 400);
  const list = await (await adm.listAccesses(new Request("http://x/api/admin/brand/accesses?status=ALL"), {}, { userId: "admin-1" })).json();
  ok("admin request view carries the saved breakdown (payment verification)", list.find((r) => r.id === body.id).packageSnapshot.breakdown.total === 1890);
  ok("no table outside the brand feature was touched; products only read", !db._stats.log.some((l) => l.startsWith("FORBIDDEN"))
    && db._stats.log.filter((l) => l.startsWith("product.")).every((l) => l === "product.findMany"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
