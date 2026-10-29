#!/usr/bin/env node
/**
 * scripts/brandLifecycle.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — access LIFECYCLE, PAYMENT PROOFS, single-use
 * AUTHORIZATIONS and NOTIFICATIONS, against the brand fake DB (which mirrors
 * the database rules). Proves:
 *   • proofs: own request only, awaiting payment only, one per request, valid
 *     file only; SHA-256 of the original upload unique across ALL proofs
 *     (rejected / withdrawn included); orphan file removed when the insert
 *     fails; file key and fingerprint never returned
 *   • one policy gate at submission, acceptance and activation, failing safely
 *   • activation only through an accepted proof; a rejected proof is final;
 *     cancel vs accept (and cancel vs reject) → exactly one wins, consistently
 *   • authorizations: admin only, reason, after a closure only, one unused per
 *     participant, claimed atomically by the next request, revocable only
 *     before use; reopening consumes none; the DB enforces all of it
 *   • exactly six notification types, each once, keyed by its audit row
 *   • routes: ownership server-side, multipart upload, private file streams,
 *     reference warnings (read-only against deposits)
 *   • the deposit table is only read; no wallet / order / Rewards table touched
 * Run: node scripts/brandLifecycle.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from "node:crypto";
import { BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID } from "../src/lib/brandProgram.js";
import {
  requestBrandAccess, cancelOwnAccess, adminRejectAccess, adminCloseAccess, adminReopenAccess,
  adminGrantAuthorization, adminRevokeAuthorization, adminListAuthorizations,
} from "../src/lib/services/brandAccessService.js";
import { submitPaymentProof, adminAcceptProof, getOwnPaymentProof } from "../src/lib/services/brandPaymentService.js";
import { classifyConsent, termsTextSha256 } from "../src/lib/services/brandConsentService.js";
import { saveRefundTermsDraft, publishRefundTerms } from "../src/lib/services/brandProgramService.js";
import { BRAND_NOTIFICATION_TYPES, notifyBrand, brandEventKey } from "../src/lib/brandNotifications.js";
import { adminBrandHandlers, affiliateBrandHandlers } from "../src/lib/brandRouteHandlers.js";
import { makeBrandFakeDb, BRAND_MODELS, SHARED_MODELS } from "./lib/brandFakeDb.mjs";
import { makeProofStorage, proofInput, pngBytes, payAndAccept } from "./lib/brandProofKit.mjs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** Test values only — not product defaults. */
const PRICING = { deliveryCost: 40, logisticsCost: 10, vatPercent: 20, productCount: 3, productIds: ["prod-1", "prod-2", "prod-3"],
  percentages: { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 10, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } } };
const SIM = { enabled: true, startDelayHours: 1, dailyVolumeMin: 2, dailyVolumeMax: 4, confirmationDelayHours: 1, deliveryDelayHours: 24,
  distribution: { delivered: 50, refused: 10, returned: 5, noResponse: 20, cancelled: 15 } };
const CONFIG = { enabled: true, packages: [{ id: "p1", name: "Formation", price: 1000, active: true, features: [], ...PRICING }], brandingOptions: [], simulation: SIM,
  catalogProductIds: ["prod-1", "prod-2", "prod-3"] };
const PRODUCTS = ["prod-1", "prod-2", "prod-3"].map((id) => ({ id, title: `Produit ${id}` }));
const TERMS = { draft: { text: "T" }, published: { version: 1, text: "Conditions", publishedAt: "2026-10-01T00:00:00Z" } };
const NOW = new Date("2026-10-28T10:00:00Z");
const DEPOSITS = [{ id: "dep-1", affiliateId: "a2", transferReference: "vir 2026/001", status: "APPROVED", amount: "200.00" }, { id: "dep-2", affiliateId: "a2", transferReference: null }];

const newDb = () => {
  const db = makeBrandFakeDb({
    affiliates: [{ id: "a1", username: "amina" }, { id: "a2", username: "badr" }, { id: "a3", username: "chama" }],
    products: PRODUCTS, deposits: DEPOSITS,
    settings: { [BRAND_SETTING_ID]: CONFIG, [BRAND_TERMS_SETTING_ID]: TERMS },
  });
  return db;
};
let reqSeq = 0;
const request = (db, aff = "a1", termsVersion = 1) => requestBrandAccess(aff, {
  productIds: ["prod-1", "prod-2", "prod-3"], packageId: "p1", brandName: "Ma Marque", termsVersion, acceptTerms: true, clientRequestId: `req-${String(++reqSeq).padStart(8, "0")}`,
}, { db, now: NOW });
const audits = (db, action) => db._tables.brandAuditLog.filter((a) => a.action === action);
const notes = (db) => db._tables.affiliateNotification;
const proofOf = (db, accessId) => db._tables.brandPaymentProof.find((p) => p.accessId === accessId);
const accessOf = (db, id) => db._tables.brandAccess.find((a) => a.id === id);

// ── 1. Proof submission ───────────────────────────────────────────────────────
console.log("\n1. Payment proof submission");
{
  const db = newDb();
  const storage = makeProofStorage();
  const acc = await request(db);
  const code = async (aff, id, inp) => (await rejects(submitPaymentProof(aff, id, inp, { db, storage })))?.code;
  ok("another participant's request → ACCESS_NOT_FOUND", await code("a2", acc.id, proofInput("x")) === "ACCESS_NOT_FOUND");
  ok("unknown request → ACCESS_NOT_FOUND", await code("a1", "nope", proofInput("x")) === "ACCESS_NOT_FOUND");
  ok("payment method required → INVALID_INPUT", await code("a1", acc.id, { ...proofInput("x"), paymentMethod: " " }) === "INVALID_INPUT");
  ok("wrong declared type → INVALID_FILE", await code("a1", acc.id, proofInput("x", { mime: "text/html" })) === "INVALID_FILE");
  ok("no file bytes → INVALID_FILE", await code("a1", acc.id, { paymentMethod: "Virement bancaire", proof: { mime: "image/png", size: 10 } }) === "INVALID_FILE");
  ok("oversized file → INVALID_FILE", await code("a1", acc.id, { paymentMethod: "Virement bancaire", proof: { buffer: pngBytes("big"), mime: "image/png", size: 9 * 1024 * 1024 } }) === "INVALID_FILE");
  ok("refused submissions store nothing", storage.files.size === 0 && db._tables.brandPaymentProof.length === 0);

  const out = await submitPaymentProof("a1", acc.id, proofInput("A", { ref: "VIR-2026-001" }), { db, storage });
  const row = proofOf(db, acc.id);
  ok("proof SUBMITTED in its own table, file stored privately", out.status === "SUBMITTED" && row && storage.files.has(row.fileKey));
  ok("fingerprint = SHA-256 of the ORIGINAL upload", row.fingerprint === createHash("sha256").update(pngBytes("A")).digest("hex"));
  ok("method, reference and normalized reference stored", row.paymentMethod === "Virement bancaire" && row.transferReference === "VIR-2026-001" && row.transferReferenceNormalized === "VIR2026001");
  ok("file key and fingerprint never returned", !JSON.stringify(out).includes(row.fileKey) && !JSON.stringify(out).includes(row.fingerprint)
    && !JSON.stringify(await getOwnPaymentProof("a1", acc.id, { db })).includes(row.fileKey));
  ok("audit PAYMENT_PROOF_SUBMITTED + notification 'submitted'", audits(db, "PAYMENT_PROOF_SUBMITTED").length === 1
    && notes(db).length === 1 && notes(db)[0].eventKey === brandEventKey("submitted", audits(db, "PAYMENT_PROOF_SUBMITTED")[0].id) && notes(db)[0].affiliateId === "a1");
  ok("a second proof for the same request → PROOF_EXISTS", await code("a1", acc.id, proofInput("B")) === "PROOF_EXISTS" && storage.files.size === 1);
  const other = await request(db, "a2");
  ok("the same file on another request → DUPLICATE_PROOF, refused before storing", await code("a2", other.id, proofInput("A")) === "DUPLICATE_PROOF" && storage.files.size === 1);
  ok("not a deposit: the deposit table is never written", db._tables.affiliateSecurityDeposit.length === 2 && !db._stats.log.some((l) => /^affiliateSecurityDeposit\.(create|update)/.test(l)));

  // Orphan cleanup when the database insert fails.
  const db2 = newDb();
  const st2 = makeProofStorage();
  const acc2 = await request(db2);
  const realCreate = db2.brandPaymentProof.create;
  db2.brandPaymentProof.create = async () => { throw Object.assign(new Error("unique"), { code: "P2002", meta: { target: "brand_payment_proofs_fingerprint_key" } }); };
  const e = await rejects(submitPaymentProof("a1", acc2.id, proofInput("C"), { db: db2, storage: st2 }));
  ok("insert race on the fingerprint → DUPLICATE_PROOF and the orphan file is removed", e?.code === "DUPLICATE_PROOF" && st2.files.size === 0 && st2.removed.length === 1);
  db2.brandPaymentProof.create = async () => { throw new Error("connection lost"); };
  const e2 = await rejects(submitPaymentProof("a1", acc2.id, proofInput("D"), { db: db2, storage: st2 }));
  ok("any insert failure → error kept, orphan removed, no audit / notification", e2?.message === "connection lost" && st2.files.size === 0
    && audits(db2, "PAYMENT_PROOF_SUBMITTED").length === 0 && notes(db2).length === 0);
  db2.brandPaymentProof.create = realCreate;
  const e3 = await rejects(submitPaymentProof("a1", acc2.id, proofInput("E"), { db: db2, storage: makeProofStorage({ failStore: true }) }));
  ok("storage failure → nothing recorded", e3?.message === "disk full" && db2._tables.brandPaymentProof.length === 0);
}

// ── 2. Consent gate (the request's OWN original consent) ─────────────────────
console.log("\n2. Consent gate (submission, acceptance, activation)");
{
  const v1 = { version: 1, text: "Conditions", textSha256: termsTextSha256("Conditions") };
  const good = { termsVersion: 1, termsTextSha256: v1.textSha256, termsSnapshot: { version: 1, text: "Conditions", acceptedAt: "2026-10-28T10:00:00.000Z" } };
  const cls = (over) => classifyConsent({ ...good, ...over }, v1);
  ok("intact snapshot of its own immutable version → VERIFIED", cls({}) === "VERIFIED");
  ok("other version / other text / missing snapshot → UNVERIFIABLE", cls({ termsSnapshot: { ...good.termsSnapshot, version: 2 } }) === "UNVERIFIABLE"
    && cls({ termsSnapshot: { ...good.termsSnapshot, text: "Conditions " } }) === "UNVERIFIABLE" && cls({ termsSnapshot: null }) === "UNVERIFIABLE");
  ok("permissive or impossible timestamps rejected ('now', 'epoch', 30 February, no Z)",
    ["now", "epoch", "2026-02-30T00:00:00Z", "2026-10-28T10:00:00", "2026-10-28 10:00:00Z"].every((at) => cls({ termsSnapshot: { ...good.termsSnapshot, acceptedAt: at } }) === "UNVERIFIABLE"));
  ok("fingerprint mismatch → UNVERIFIABLE; legacy without fingerprint judged on the snapshot", cls({ termsTextSha256: "0".repeat(64) }) === "UNVERIFIABLE" && cls({ termsTextSha256: null }) === "VERIFIED");

  const db = newDb();
  const storage = makeProofStorage();
  const acc = await request(db);
  await saveRefundTermsDraft({ text: "Conditions v2" }, { db, actorId: "admin-1" });
  await publishRefundTerms({ db, actorId: "admin-1" });
  ok("a newer published version does not block an older valid request (proof + acceptance)",
    (await submitPaymentProof("a1", acc.id, proofInput("G1"), { db, storage })).status === "SUBMITTED"
    && (await adminAcceptProof(acc.id, { db, actorId: "admin-1", now: NOW })).status === "ACTIVE");
  ok("the request keeps the version and text it accepted", accessOf(db, acc.id).termsVersion === 1 && accessOf(db, acc.id).termsSnapshot.text === "Conditions");

  // A legacy request whose snapshot does not match any immutable version.
  const legacy = await request(db, "a2", 2);
  accessOf(db, legacy.id).termsSnapshot = { ...accessOf(db, legacy.id).termsSnapshot, text: "texte inconnu" }; // simulates pre-migration data
  ok("unverifiable consent → submission refused (CONSENT_UNVERIFIED), nothing stored",
    (await rejects(submitPaymentProof("a2", legacy.id, proofInput("G2"), { db, storage })))?.code === "CONSENT_UNVERIFIED" && storage.files.size === 1 && !proofOf(db, legacy.id));
  ok("…and the database refuses the proof too (BRC02)", /BRC02/.test((await rejects(db.brandPaymentProof.create({ data: {
    accessId: legacy.id, fileKey: "k.jpg", fingerprint: "f".repeat(64), paymentMethod: "Virement bancaire", status: "SUBMITTED" } })))?.message || ""));
}

// ── 3. Acceptance, rejection (final), DB rules ────────────────────────────────
console.log("\n3. Acceptance and rejection");
{
  const db = newDb();
  const storage = makeProofStorage();
  const acc = await request(db);
  ok("the database refuses activation without an accepted proof", /accepted payment proof/.test((await rejects(db.brandAccess.updateMany({ where: { id: acc.id },
    data: { status: "ACTIVE", activatedAt: NOW, simulationStartsAt: NOW, paymentReference: "R" } })))?.message || ""));
  await submitPaymentProof("a1", acc.id, proofInput("H1", { ref: "VIR-H1" }), { db, storage });
  const a = await adminAcceptProof(acc.id, { db, actorId: "admin-7", now: NOW });
  const p = proofOf(db, acc.id);
  ok("accepted: proof reviewed by the admin, access ACTIVE with the transfer reference", p.status === "ACCEPTED" && p.reviewedBy === "admin-7" && p.reviewedAt
    && a.status === "ACTIVE" && a.paymentReference === "VIR-H1" && a.paymentProof.status === "ACCEPTED");
  ok("audits PAYMENT_PROOF_ACCEPTED then ACCESS_ACTIVATED; an ACTIVATION period starts", audits(db, "PAYMENT_PROOF_ACCEPTED").length === 1 && audits(db, "ACCESS_ACTIVATED").length === 1
    && db._tables.brandAccessPeriod.length === 1 && db._tables.brandAccessPeriod[0].startReason === "ACTIVATION" && db._tables.brandAccessPeriod[0].startAuditId === audits(db, "ACCESS_ACTIVATED")[0].id);
  ok("a reviewed proof cannot be reviewed again or deleted (DB)", /one review/.test((await rejects(db.brandPaymentProof.updateMany({ where: { id: p.id }, data: { status: "REJECTED" } })))?.message || "")
    && /cannot be deleted/.test((await rejects(db.brandPaymentProof.deleteMany({ where: {} })))?.message || ""));

  const r = await request(db, "a2");
  await submitPaymentProof("a2", r.id, proofInput("H2"), { db, storage });
  ok("rejection needs a reason", (await rejects(adminRejectAccess(r.id, { reason: "" }, { db, actorId: "admin-1", now: NOW })))?.code === "REASON_REQUIRED");
  await adminRejectAccess(r.id, { reason: "Virement introuvable" }, { db, actorId: "admin-1", now: NOW });
  const rp = proofOf(db, r.id);
  ok("rejected: proof REJECTED with the reason, request REJECTED", rp.status === "REJECTED" && rp.rejectionReason === "Virement introuvable" && accessOf(db, r.id).status === "REJECTED");
  ok("a rejected proof is final (no acceptance, no new proof on that request)", (await rejects(adminAcceptProof(r.id, { db, now: NOW })))?.code === "NOT_PENDING"
    && (await rejects(submitPaymentProof("a2", r.id, proofInput("H3"), { db, storage })))?.code === "NOT_PENDING");
  const again = await request(db, "a2");
  ok("the rejected file cannot be reused on a new request (fingerprint kept forever)", (await rejects(submitPaymentProof("a2", again.id, proofInput("H2"), { db, storage })))?.code === "DUPLICATE_PROOF");
  ok("rejection audits: PAYMENT_PROOF_REJECTED + ACCESS_REJECTED", audits(db, "PAYMENT_PROOF_REJECTED").length === 1 && audits(db, "ACCESS_REJECTED").length === 1);
  ok("the proof file and row are kept after rejection", storage.files.has(rp.fileKey) && db._tables.brandPaymentProof.length === 2);
}

// ── 4. Races: cancel vs accept, cancel vs reject ──────────────────────────────
console.log("\n4. Cancel vs accept / reject — exactly one wins");
{
  for (const order of ["cancel-first", "accept-first"]) {
    const db = newDb();
    const acc = await request(db);
    await submitPaymentProof("a1", acc.id, proofInput(`R-${order}`), { db, storage: makeProofStorage() });
    const cancel = () => cancelOwnAccess("a1", acc.id, { db, now: NOW });
    const accept = () => adminAcceptProof(acc.id, { db, actorId: "admin-1", now: NOW });
    const res = await Promise.allSettled(order === "cancel-first" ? [cancel(), accept()] : [accept(), cancel()]);
    const s = accessOf(db, acc.id).status, ps = proofOf(db, acc.id).status;
    ok(`${order}: exactly one succeeds and the state is consistent`, res.filter((x) => x.status === "fulfilled").length === 1
      && ((s === "CANCELLED" && ps === "WITHDRAWN") || (s === "ACTIVE" && ps === "ACCEPTED")), `${s}/${ps}`);
    ok(`${order}: the loser gets a business error`, res.filter((x) => x.status === "rejected").every((x) => ["NOT_PENDING", "PROOF_NOT_SUBMITTED"].includes(x.reason.code)));
  }
  const db = newDb();
  const acc = await request(db);
  await submitPaymentProof("a1", acc.id, proofInput("W"), { db, storage: makeProofStorage() });
  const before = notes(db).length;
  await cancelOwnAccess("a1", acc.id, { db, now: NOW });
  ok("cancellation withdraws the proof in the same transaction (audited, no notification)", proofOf(db, acc.id).status === "WITHDRAWN"
    && audits(db, "PAYMENT_PROOF_WITHDRAWN").length === 1 && audits(db, "ACCESS_CANCELLED").length === 1 && notes(db).length === before);
  const next = await request(db);
  ok("a withdrawn file cannot be reused", (await rejects(submitPaymentProof("a1", next.id, proofInput("W"), { db, storage: makeProofStorage() })))?.code === "DUPLICATE_PROOF");
  await submitPaymentProof("a1", next.id, proofInput("W2"), { db, storage: makeProofStorage() });
  const res = await Promise.allSettled([cancelOwnAccess("a1", next.id, { db, now: NOW }), adminRejectAccess(next.id, { reason: "Doublon" }, { db, actorId: "admin-1", now: NOW })]);
  ok("cancel vs reject → exactly one", res.filter((x) => x.status === "fulfilled").length === 1 && ["WITHDRAWN", "REJECTED"].includes(proofOf(db, next.id).status));
}

// ── 5. Authorizations after a closure ─────────────────────────────────────────
console.log("\n5. Single-use authorizations");
{
  const db = newDb();
  const first = await request(db);
  ok("no closed access → granting is refused (NO_CLOSED_ACCESS)", (await rejects(adminGrantAuthorization("a3", { reason: "x" }, { db, actorId: "admin-1" })))?.code === "NO_CLOSED_ACCESS");
  await payAndAccept(db, "a1", first.id, { now: NOW });
  await adminCloseAccess(first.id, { reason: "Fin" }, { db, actorId: "admin-1", now: NOW });
  ok("after a CLOSED access a new request needs an authorization", (await rejects(request(db)))?.code === "AUTHORIZATION_REQUIRED");
  ok("grant: reason required; unknown affiliate refused", (await rejects(adminGrantAuthorization("a1", { reason: " " }, { db })))?.code === "REASON_REQUIRED"
    && (await rejects(adminGrantAuthorization("zz", { reason: "x" }, { db })))?.code === "AFFILIATE_NOT_FOUND");
  const g = await adminGrantAuthorization("a1", { reason: "Nouvelle formation" }, { db, actorId: "admin-1" });
  ok("granted: unused, with reason, admin and creation time", g.status === "UNUSED" && g.reason === "Nouvelle formation" && g.grantedBy === "admin-1" && !!g.createdAt);
  ok("audit REQUEST_AUTHORIZED + notification 'authorized'", audits(db, "REQUEST_AUTHORIZED").length === 1
    && notes(db).some((n) => n.eventKey === brandEventKey("authorized", audits(db, "REQUEST_AUTHORIZED")[0].id)));
  ok("one unused authorization per participant", (await rejects(adminGrantAuthorization("a1", { reason: "y" }, { db })))?.code === "AUTHORIZATION_EXISTS");
  ok("the database refuses a second unused one too", (await rejects(db.brandRequestAuthorization.create({ data: { affiliateId: "a1", grantedBy: "x", reason: "y" } })))?.code === "P2002");

  const res = await Promise.allSettled([request(db), request(db), request(db)]);
  const winners = res.filter((r) => r.status === "fulfilled");
  const auth = db._tables.brandRequestAuthorization[0];
  ok("concurrent requests → exactly one, claiming the authorization atomically", winners.length === 1 && auth.consumedByAccessId === winners[0].value.id
    && accessOf(db, winners[0].value.id).authorizationId === auth.id && audits(db, "REQUEST_AUTHORIZATION_USED").length === 1);
  ok("a used authorization cannot be revoked", (await rejects(adminRevokeAuthorization(auth.id, { reason: "x" }, { db })))?.code === "NOT_REVOCABLE");
  await cancelOwnAccess("a1", winners[0].value.id, { db, now: NOW });
  ok("single use: after cancelling, another request needs a new authorization", (await rejects(request(db)))?.code === "AUTHORIZATION_REQUIRED");

  const g2 = await adminGrantAuthorization("a1", { reason: "Encore" }, { db, actorId: "admin-1" });
  ok("revocation needs a reason", (await rejects(adminRevokeAuthorization(g2.id, { reason: "" }, { db })))?.code === "REASON_REQUIRED");
  const rv = await adminRevokeAuthorization(g2.id, { reason: "Erreur" }, { db, actorId: "admin-2", now: NOW });
  ok("revoked before use: audited, no notification, the next request is refused", rv.status === "REVOKED" && rv.revokeReason === "Erreur"
    && audits(db, "REQUEST_AUTHORIZATION_REVOKED").length === 1 && !notes(db).some((n) => n.eventKey.includes(g2.id))
    && (await rejects(request(db)))?.code === "AUTHORIZATION_REQUIRED");
  ok("revoking twice → NOT_REVOCABLE", (await rejects(adminRevokeAuthorization(g2.id, { reason: "x" }, { db })))?.code === "NOT_REVOCABLE");

  const g3 = await adminGrantAuthorization("a1", { reason: "Reprise" }, { db, actorId: "admin-1" });
  await adminReopenAccess(first.id, { reason: "Reprise de la même marque" }, { db, actorId: "admin-1", now: NOW });
  ok("reopening consumes no authorization", db._tables.brandRequestAuthorization.find((a) => a.id === g3.id).consumedAt === null);
  ok("granting while the participant has an open access → ACCESS_EXISTS", (await rejects(adminGrantAuthorization("a1", { reason: "z" }, { db })))?.code === "ACCESS_EXISTS"
    && (await adminListAuthorizations({ affiliateId: "a1", db })).filter((a) => a.status === "UNUSED").length === 1);
  // DB rule on a participant with a CLOSED access: insert without an authorization.
  db._tables.brandAccess.push({ ...accessOf(db, first.id), id: "acc-closed-a3", affiliateId: "a3", clientRequestId: "req-closed-a3", status: "CLOSED", closedAt: NOW, closedBy: "x", closeReason: "y", authorizationId: null });
  ok("DB: a new request after a CLOSED access without authorization is refused", /unused admin authorization/.test((await rejects(db.brandAccess.create({ data: {
    affiliateId: "a3", brandName: "X", packageId: "p1", amount: "1.00", termsVersion: 1, clientRequestId: "req-db000002", status: "PENDING_PAYMENT",
    termsSnapshot: { version: 1, text: "Conditions", acceptedAt: null }, termsTextSha256: termsTextSha256("Conditions"), // valid consent: the authorization rule is what refuses
  } })))?.message || ""));
  ok("DB: an authorization cannot be consumed by a request that does not reference it", /does not reference it/.test((await rejects(db.brandRequestAuthorization.updateMany({
    where: { id: g3.id }, data: { consumedAt: NOW, consumedByAccessId: first.id } })))?.message || ""));
}

// ── 6. Notifications: exactly six types, each once, keyed by its audit row ────
console.log("\n6. Notifications");
{
  ok("exactly six types", BRAND_NOTIFICATION_TYPES.join() === "submitted,accepted,rejected,closed,reopened,authorized");
  const db = newDb();
  const acc = await request(db);
  await payAndAccept(db, "a1", acc.id, { now: NOW });                                   // submitted + accepted
  await adminCloseAccess(acc.id, { reason: "Fin" }, { db, actorId: "admin-1", now: NOW }); // closed
  await adminReopenAccess(acc.id, { reason: "Reprise" }, { db, actorId: "admin-1", now: NOW }); // reopened
  await adminCloseAccess(acc.id, { reason: "Fin bis" }, { db, actorId: "admin-1", now: NOW }); // closed (second event)
  await adminGrantAuthorization("a1", { reason: "Nouvelle" }, { db, actorId: "admin-1" }); // authorized
  const next = await request(db);
  await adminRejectAccess(next.id, { reason: "Non" }, { db, actorId: "admin-1", now: NOW }); // rejected
  const types = notes(db).map((n) => n.eventKey.split(":")[1]);
  ok("each event notified once", types.sort().join() === "accepted,authorized,closed,closed,rejected,reopened,submitted", types.join());
  ok("each key = brand:<type>:<audit id of that event>", notes(db).every((n) => { const [, , auditId] = n.eventKey.split(":"); return db._tables.brandAuditLog.some((a) => a.id === auditId); }));
  ok("only the participant is notified, with French messages", notes(db).every((n) => n.affiliateId === "a1" && /Create Your Own Brand/.test(n.message)));
  ok("rejection and closure messages carry the reason", notes(db).find((n) => n.eventKey.startsWith("brand:rejected")).message.includes("Non")
    && notes(db).find((n) => n.eventKey.startsWith("brand:closed")).message.includes("Fin"));
  const a = audits(db, "ACCESS_CLOSED")[0];
  ok("a retried notification for the same audit row is refused (idempotent)", (await rejects(notifyBrand(db, { type: "closed", affiliateId: "a1", auditId: a.id, brandName: "x", reason: "y" })))?.code === "P2002");
  ok("unknown type or missing audit id → refused", !!(await rejects(Promise.resolve().then(() => notifyBrand(db, { type: "cancelled", affiliateId: "a1", auditId: "x" }))))
    && !!(await rejects(Promise.resolve().then(() => notifyBrand(db, { type: "closed", affiliateId: "a1" })))));
  ok("notifications are messages only (no amount field)", notes(db).every((n) => Object.keys(n).sort().join() === "affiliateId,createdAt,eventKey,id,message,read"));
  const failing = newDb();
  const f = await request(failing);
  await submitPaymentProof("a1", f.id, proofInput("N1"), { db: failing, storage: makeProofStorage() });
  failing.affiliateNotification.create = async () => { throw new Error("notification store down"); };
  await rejects(adminAcceptProof(f.id, { db: failing, actorId: "admin-1", now: NOW }));
  ok("notification written in the same transaction: if it fails, nothing is accepted", accessOf(failing, f.id).status === "PENDING_PAYMENT"
    && proofOf(failing, f.id).status === "SUBMITTED" && audits(failing, "PAYMENT_PROOF_ACCEPTED").length === 0);
}

// ── 7. Routes ─────────────────────────────────────────────────────────────────
console.log("\n7. Routes: ownership, uploads, private files, warnings");
{
  const db = newDb();
  const storage = makeProofStorage();
  const aff = affiliateBrandHandlers({ db, now: () => NOW, storage, rateLimit: () => null });
  const adm = adminBrandHandlers({ db, now: () => NOW, storage });
  const ctx = (id) => ({ params: Promise.resolve({ id }) });
  const upload = (tag, ref, { file = true } = {}) => {
    const fd = new FormData();
    fd.set("paymentMethod", "Virement bancaire");
    if (ref) fd.set("transferReference", ref);
    if (file) fd.set("proof", new File([pngBytes(tag)], "preuve.png", { type: "image/png" }));
    return new Request("http://x", { method: "POST", body: fd });
  };
  const post = (body) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const acc = await request(db);
  ok("another participant uploading → 404", (await aff.submitProof(upload("U1", "X"), ctx(acc.id), { affiliateId: "a2" })).status === 404);
  ok("no file part → 400 INVALID_FILE", (await (await aff.submitProof(upload("U1", "X", { file: false }), ctx(acc.id), { affiliateId: "a1" })).json()).code === "INVALID_FILE");
  const limited = affiliateBrandHandlers({ db, storage, rateLimit: () => new Response("slow", { status: 429 }) });
  ok("rate limited → 429 before anything is read", (await limited.submitProof(upload("U1", "X"), ctx(acc.id), { affiliateId: "a1" })).status === 429);
  const up = await aff.submitProof(upload("U1", "vir-2026-001"), ctx(acc.id), { affiliateId: "a1" });
  const upBody = await up.json();
  ok("own upload → 201, no file key in the response", up.status === 201 && upBody.status === "SUBMITTED" && !JSON.stringify(upBody).includes(proofOf(db, acc.id).fileKey));
  ok("duplicate upload → 409", (await aff.submitProof(upload("U1", "X"), ctx(acc.id), { affiliateId: "a1" })).status === 409);
  const meta = await (await aff.getProof(new Request("http://x"), ctx(acc.id), { affiliateId: "a1" })).json();
  ok("own proof metadata", meta.proof.status === "SUBMITTED" && !("fileKey" in meta.proof) && !("fingerprint" in meta.proof));
  const file = await aff.getProof(new Request("http://x?file=1"), ctx(acc.id), { affiliateId: "a1" });
  ok("own proof file streamed privately", file.status === 200 && file.headers.get("cache-control") === "no-store, private" && Buffer.from(await file.arrayBuffer()).equals(pngBytes("U1")));
  ok("someone else's proof (metadata or file) → 404", (await aff.getProof(new Request("http://x"), ctx(acc.id), { affiliateId: "a2" })).status === 404
    && (await aff.getProof(new Request("http://x?file=1"), ctx(acc.id), { affiliateId: "a2" })).status === 404);
  ok("admin proof file → 200; unknown request → 404", (await adm.accessProofFile(new Request("http://x"), ctx(acc.id), { userId: "admin-1" })).status === 200
    && (await adm.accessProofFile(new Request("http://x"), ctx("nope"), { userId: "admin-1" })).status === 404);

  const other = await request(db, "a2");
  await aff.submitProof(upload("U2", "VIR 2026 001"), ctx(other.id), { affiliateId: "a2" });
  const list = await (await adm.listAccesses(new Request("http://x/api/admin/brand/accesses"), {}, { userId: "admin-1" })).json();
  const mine = list.find((r) => r.id === acc.id);
  ok("reference warnings: same normalized reference on another proof and on a deposit", mine.referenceWarnings.otherProofs.length === 1
    && mine.referenceWarnings.otherProofs[0].accessId === other.id && mine.referenceWarnings.deposits.map((d) => d.id).join() === "dep-1");
  ok("admin list never exposes file keys or fingerprints", !db._tables.brandPaymentProof.some((p) => JSON.stringify(list).includes(p.fileKey) || JSON.stringify(list).includes(p.fingerprint)));
  ok("warnings are informative only: both proofs still acceptable", (await adm.actOnAccess(post({ action: "accept-proof" }), ctx(acc.id), { userId: "admin-1" })).status === 200);
  ok("close via the route needs a reason (400), then 200", (await adm.actOnAccess(post({ action: "close" }), ctx(acc.id), { userId: "admin-1" })).status === 400
    && (await adm.actOnAccess(post({ action: "close", reason: "Fin" }), ctx(acc.id), { userId: "admin-1" })).status === 200);
  ok("reopen via the route", (await adm.actOnAccess(post({ action: "reopen", reason: "Reprise" }), ctx(acc.id), { userId: "admin-1" })).status === 200 && accessOf(db, acc.id).status === "ACTIVE");
  ok("reject via the route", (await adm.actOnAccess(post({ action: "reject", reason: "Non" }), ctx(other.id), { userId: "admin-1" })).status === 200);
  await adm.actOnAccess(post({ action: "close", reason: "Fin" }), ctx(acc.id), { userId: "admin-1" });
  const grant = await adm.grantAuthorization(post({ affiliateId: "a1", reason: "Nouvelle" }), {}, { userId: "admin-3" });
  const gBody = await grant.json();
  ok("authorization via the route → 201, actor from the session", grant.status === 201 && gBody.grantedBy === "admin-3");
  ok("second grant → 409", (await adm.grantAuthorization(post({ affiliateId: "a1", reason: "x" }), {}, { userId: "admin-1" })).status === 409);
  const listed = await (await adm.listAuthorizations(new Request("http://x?affiliateId=a1"), {}, { userId: "admin-1" })).json();
  ok("authorizations listed per participant", listed.length === 1 && listed[0].id === gBody.id);
  ok("invalid filter → 400", (await adm.listAuthorizations(new Request("http://x?affiliateId=a%20b"), {}, { userId: "admin-1" })).status === 400);
  ok("revoke via the route", (await adm.revokeAuthorization(post({ reason: "Erreur" }), ctx(gBody.id), { userId: "admin-1" })).status === 200
    && (await adm.revokeAuthorization(post({ reason: "Erreur" }), ctx(gBody.id), { userId: "admin-1" })).status === 409);
  ok("request after closure without authorization → 409 AUTHORIZATION_REQUIRED", (await (await aff.requestAccess(post({
    productIds: ["prod-1", "prod-2", "prod-3"], packageId: "p1", brandName: "Ma Marque", termsVersion: 1, acceptTerms: true, clientRequestId: "req-route001",
  }), {}, { affiliateId: "a1" })).json()).code === "AUTHORIZATION_REQUIRED");
  const used = new Set(db._stats.log.filter((l) => !l.startsWith("$executeRaw")).map((l) => l.split(".")[0]));
  ok("only brand tables, brand notifications and a read of deposits were touched", !db._stats.log.some((l) => l.startsWith("FORBIDDEN"))
    && [...used].every((m) => BRAND_MODELS.includes(m) || SHARED_MODELS.includes(m))
    && db._stats.log.filter((l) => l.startsWith("affiliateSecurityDeposit.")).every((l) => l === "affiliateSecurityDeposit.findMany"));
  ok("deposits unchanged", JSON.stringify(db._tables.affiliateSecurityDeposit) === JSON.stringify(DEPOSITS.map((d) => ({ status: "PENDING", ...d }))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
