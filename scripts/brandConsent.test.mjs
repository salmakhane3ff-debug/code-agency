#!/usr/bin/env node
/**
 * scripts/brandConsent.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — refund-terms CONSENT (Phase 1, migration 20261030),
 * against the brand fake DB (which mirrors the database rules). Proves:
 *   • publishing writes settings + audit + immutable version atomically; drafts
 *     publish nothing; TERMS_UNCHANGED kept
 *   • a request snapshots the exact immutable version + fingerprint; the
 *     acceptance time comes from the database clock; participants never see the
 *     fingerprint; a newer version does not invalidate an older valid request
 *   • legacy requests: ACTIVE stays active (admin warning); PENDING can record a
 *     fresh consent but stays non-payable at every layer; CLOSED reopens only
 *     with a fresh consent to the LATEST version (refused again after a newer
 *     publication); original evidence is never changed
 *   • fresh-consent rules, append-only evidence, error mapping, TRY_AGAIN,
 *     streaming upload cap, integrity diagnostics, notifications unchanged
 * Run: node scripts/brandConsent.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID } from "../src/lib/brandProgram.js";
import {
  requestBrandAccess, adminCloseAccess, adminReopenAccess, recordFreshConsent, adminListAccesses, publicAccessWithConsent,
} from "../src/lib/services/brandAccessService.js";
import { submitPaymentProof, adminAcceptProof } from "../src/lib/services/brandPaymentService.js";
import { saveRefundTermsDraft, publishRefundTerms } from "../src/lib/services/brandProgramService.js";
import {
  termsTextSha256, brandDbErrorCode, assessLegacyIntegrity, isStrictUtcTimestamp,
} from "../src/lib/services/brandConsentService.js";
import { adminBrandHandlers, affiliateBrandHandlers, readFormDataCapped, PROOF_BODY_LIMIT } from "../src/lib/brandRouteHandlers.js";
import { BRAND_NOTIFICATION_TYPES } from "../src/lib/brandNotifications.js";
import { makeBrandFakeDb } from "./lib/brandFakeDb.mjs";
import { makeProofStorage, proofInput, pngBytes, payAndAccept } from "./lib/brandProofKit.mjs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** Test values only — not product defaults (and not refund terms: placeholder text). */
const PRICING = { deliveryCost: 40, logisticsCost: 10, vatPercent: 20, productCount: 3, productIds: ["prod-1", "prod-2", "prod-3"],
  percentages: { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 10, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } } };
const SIM = { enabled: true, startDelayHours: 1, dailyVolumeMin: 2, dailyVolumeMax: 4, confirmationDelayHours: 1, deliveryDelayHours: 24,
  distribution: { delivered: 50, refused: 10, returned: 5, noResponse: 20, cancelled: 15 } };
const CONFIG = { enabled: true, packages: [{ id: "p1", name: "Formation", price: 1000, active: true, features: [], ...PRICING }], brandingOptions: [], simulation: SIM,
  catalogProductIds: ["prod-1", "prod-2", "prod-3"] };
const PRODUCTS = ["prod-1", "prod-2", "prod-3"].map((id) => ({ id, title: `Produit ${id}` }));
const TERMS = { draft: { text: "Texte de test" }, published: { version: 1, text: "Texte de test", publishedAt: "2026-10-01T00:00:00.000Z" } };
const NOW = new Date("2026-10-28T10:00:00Z");
let clockNow = new Date("2026-10-28T10:00:00.123Z");

const newDb = () => makeBrandFakeDb({
  affiliates: [{ id: "a1", username: "amina" }, { id: "a2", username: "badr" }, { id: "a3", username: "chama" }, { id: "a4", username: "off", isActive: false }],
  products: PRODUCTS, settings: { [BRAND_SETTING_ID]: CONFIG, [BRAND_TERMS_SETTING_ID]: TERMS }, clock: () => clockNow,
});
let reqSeq = 0;
const request = (db, aff = "a1", termsVersion = 1) => requestBrandAccess(aff, {
  productIds: ["prod-1", "prod-2", "prod-3"], packageId: "p1", brandName: "Ma Marque", termsVersion, acceptTerms: true, clientRequestId: `req-c${String(++reqSeq).padStart(7, "0")}`,
}, { db, now: NOW });
const accessOf = (db, id) => db._tables.brandAccess.find((a) => a.id === id);
const audits = (db, action) => db._tables.brandAuditLog.filter((a) => a.action === action);
/** Simulate a pre-20261030 row whose consent cannot be verified (bypasses the guards, as legacy data would). */
const makeLegacy = (db, id) => { const r = accessOf(db, id); r.termsSnapshot = { ...r.termsSnapshot, text: "texte d'une ancienne version" }; r.termsTextSha256 = null; };
const publishV2 = async (db, text = "Texte de test v2") => { await saveRefundTermsDraft({ text }, { db, actorId: "admin-1" }); return publishRefundTerms({ db, actorId: "admin-1" }); };

// ── 1. Publishing ─────────────────────────────────────────────────────────────
console.log("\n1. Publishing immutable versions");
{
  const db = newDb();
  const T = db._tables;
  ok("seeded version 1 exists with its fingerprint", T.brandTermsVersion.length === 1 && T.brandTermsVersion[0].textSha256 === termsTextSha256("Texte de test"));
  await saveRefundTermsDraft({ text: "Brouillon non publié" }, { db, actorId: "admin-1" });
  ok("saving a draft publishes nothing", T.brandTermsVersion.length === 1);
  await publishRefundTerms({ db, actorId: "admin-7" });
  const v2 = T.brandTermsVersion.find((v) => v.version === 2);
  const audit = audits(db, "TERMS_PUBLISHED").at(-1);
  ok("publish → one immutable version linked to its audit row, same text and fingerprint",
    v2 && v2.text === "Brouillon non publié" && v2.textSha256 === termsTextSha256("Brouillon non publié") && v2.publishAuditId === audit.id
    && audit.after.textSha256 === v2.textSha256 && v2.publishedBy === "admin-7" && v2.source === "PUBLISH");
  ok("republishing the same text → TERMS_UNCHANGED", (await rejects(publishRefundTerms({ db, actorId: "admin-1" })))?.code === "TERMS_UNCHANGED");
  await saveRefundTermsDraft({ text: "Version trois" }, { db, actorId: "admin-1" });
  const before = { settings: JSON.stringify(T.setting), audits: T.brandAuditLog.length, versions: T.brandTermsVersion.length };
  const realCreate = db.brandTermsVersion.create;
  db.brandTermsVersion.create = async () => { throw new Error("version insert failed"); };
  await rejects(publishRefundTerms({ db, actorId: "admin-1" }));
  db.brandTermsVersion.create = realCreate;
  ok("a failed version insert rolls back the settings and the audit row too",
    JSON.stringify(T.setting) === before.settings && T.brandAuditLog.length === before.audits && T.brandTermsVersion.length === before.versions);
  ok("versions are append-only", /append-only/.test((await rejects(db.brandTermsVersion.updateMany({ where: {}, data: { text: "x" } })))?.message || "")
    && /append-only/.test((await rejects(db.brandTermsVersion.deleteMany({ where: {} })))?.message || ""));
}

// ── 2. New requests ───────────────────────────────────────────────────────────
console.log("\n2. New requests: exact version, fingerprint, database time");
{
  const db = newDb();
  clockNow = new Date("2026-10-28T10:00:05.678Z");
  const out = await request(db);
  const row = accessOf(db, out.id);
  ok("snapshot = immutable version 1 (text) + fingerprint", row.termsVersion === 1 && row.termsSnapshot.text === "Texte de test"
    && row.termsTextSha256 === termsTextSha256("Texte de test"));
  ok("acceptance time written by the database clock (UTC, milliseconds)", row.termsSnapshot.acceptedAt === "2026-10-28T10:00:05.678Z" && isStrictUtcTimestamp(row.termsSnapshot.acceptedAt));
  ok("participant view: accepted version and time, never the fingerprint", out.acceptedTerms.version === 1 && !JSON.stringify(out).includes(row.termsTextSha256));
  await publishV2(db);
  ok("a participant who saw version 1 after version 2 is published → TERMS_CHANGED", (await rejects(request(db, "a2", 1)))?.code === "TERMS_CHANGED");
  const r2 = await request(db, "a2", 2);
  ok("a new request snapshots the latest version", accessOf(db, r2.id).termsVersion === 2 && accessOf(db, r2.id).termsSnapshot.text === "Texte de test v2");
  ok("the version-1 request is unchanged and still payable", accessOf(db, out.id).termsVersion === 1
    && (await payAndAccept(db, "a1", out.id, { now: NOW })).status === "ACTIVE");
  ok("the database refuses a forged snapshot (BRC01)", /BRC01/.test((await rejects(db.brandAccess.create({ data: {
    affiliateId: "a3", brandName: "X", packageId: "p1", amount: "1.00", termsVersion: 2, clientRequestId: "req-forged01", status: "PENDING_PAYMENT",
    termsSnapshot: { version: 2, text: "autre texte", acceptedAt: null }, termsTextSha256: termsTextSha256("autre texte") } })))?.message || ""));
  ok("…and a request without fingerprint (BRC01)", /BRC01/.test((await rejects(db.brandAccess.create({ data: {
    affiliateId: "a3", brandName: "X", packageId: "p1", amount: "1.00", termsVersion: 2, clientRequestId: "req-forged02", status: "PENDING_PAYMENT",
    termsSnapshot: { version: 2, text: "Texte de test v2", acceptedAt: null } } })))?.message || ""));
  ok("the fingerprint is frozen after insert", /immutable/.test((await rejects(db.brandAccess.updateMany({ where: { id: out.id }, data: { termsTextSha256: null } })))?.message || ""));
}

// ── 3. Legacy ACTIVE ──────────────────────────────────────────────────────────
console.log("\n3. Legacy ACTIVE request");
{
  const db = newDb();
  const r = await request(db);
  await payAndAccept(db, "a1", r.id, { now: NOW });
  makeLegacy(db, r.id);
  const list = await adminListAccesses({ db });
  const row = list.find((x) => x.id === r.id);
  ok("stays ACTIVE; admin sees UNVERIFIABLE (no automatic action)", accessOf(db, r.id).status === "ACTIVE" && row.consent === "UNVERIFIABLE" && row.paymentBlockedReason === null);
  ok("participant view never claims it is valid", (await publicAccessWithConsent(accessOf(db, r.id), db)).consentStatus === "UNVERIFIABLE");
  ok("a fresh consent is not offered for an ACTIVE request", (await rejects(recordFreshConsent("a1", r.id, { termsVersion: 1, acceptTerms: true }, { db })))?.code === "CONSENT_NOT_REQUIRED");
  const nullHash = await request(db, "a2");
  accessOf(db, nullHash.id).termsTextSha256 = null;
  ok("a legacy row without fingerprint whose snapshot matches its version is VERIFIED", (await adminListAccesses({ db })).find((x) => x.id === nullHash.id).consent === "VERIFIED");
}

// ── 4. Legacy PENDING: fresh consent recorded, payment blocked everywhere ────
console.log("\n4. Legacy PENDING request");
{
  const db = newDb();
  const storage = makeProofStorage();
  const r = await request(db);
  makeLegacy(db, r.id);
  const original = JSON.stringify(accessOf(db, r.id));
  ok("proof submission refused (CONSENT_UNVERIFIED), nothing stored", (await rejects(submitPaymentProof("a1", r.id, proofInput("P1"), { db, storage })))?.code === "CONSENT_UNVERIFIED" && storage.files.size === 0);
  ok("participant sees PAYMENT_BLOCKED; admin sees the reason", (await publicAccessWithConsent(accessOf(db, r.id), db)).consentStatus === "PAYMENT_BLOCKED"
    && (await adminListAccesses({ db })).find((x) => x.id === r.id).paymentBlockedReason === "CONSENT_UNVERIFIED");
  const notesBefore = db._tables.affiliateNotification.length;
  clockNow = new Date("2026-10-28T11:00:00.250Z");
  const c = await recordFreshConsent("a1", r.id, { termsVersion: 1, acceptTerms: true }, { db });
  const row = db._tables.brandAccessConsent.find((x) => x.id === c.id);
  ok("fresh consent recorded separately (PENDING_RENEWAL, latest version, database time, audit link)",
    row.context === "PENDING_RENEWAL" && row.termsVersion === 1 && row.termsTextSha256 === termsTextSha256("Texte de test")
    && new Date(row.acceptedAt).toISOString() === "2026-10-28T11:00:00.250Z" && audits(db, "CONSENT_RENEWED").at(-1).id === row.auditId);
  ok("the original request evidence is unchanged; no notification", JSON.stringify(accessOf(db, r.id)) === original && db._tables.affiliateNotification.length === notesBefore);
  ok("still not payable after the fresh consent (service)", (await rejects(submitPaymentProof("a1", r.id, proofInput("P2"), { db, storage })))?.code === "CONSENT_UNVERIFIED");
  ok("participant sees RENEWED_PAYMENT_BLOCKED", (await publicAccessWithConsent(accessOf(db, r.id), db)).consentStatus === "RENEWED_PAYMENT_BLOCKED");
  ok("database: no proof insert (BRC02)", /BRC02/.test((await rejects(db.brandPaymentProof.create({ data: {
    accessId: r.id, fileKey: "k.jpg", fingerprint: "a".repeat(64), paymentMethod: "Virement bancaire", status: "SUBMITTED" } })))?.message || ""));
  // Even with an accepted proof forced in, activation is refused by the guard.
  db._tables.brandPaymentProof.push({ id: "prf-forced", accessId: r.id, status: "ACCEPTED", fingerprint: "b".repeat(64), fileKey: "k", paymentMethod: "x" });
  ok("database: PENDING → ACTIVE refused without verified ORIGINAL consent (BRC02)", /BRC02/.test((await rejects(db.brandAccess.updateMany({
    where: { id: r.id }, data: { status: "ACTIVE", activatedAt: NOW, simulationStartsAt: NOW, paymentReference: "R" } })))?.message || ""));
  ok("admin acceptance refused too (CONSENT_UNVERIFIED)", (await rejects(adminAcceptProof(r.id, { db, actorId: "admin-1", now: NOW })))?.code === "CONSENT_UNVERIFIED");
  ok("the request stays PENDING_PAYMENT", accessOf(db, r.id).status === "PENDING_PAYMENT");
}

// ── 5. Legacy CLOSED: reopen only with a fresh consent to the LATEST version ─
console.log("\n5. Legacy CLOSED request and reopening");
{
  const db = newDb();
  const r = await request(db);
  await payAndAccept(db, "a1", r.id, { now: NOW });
  await adminCloseAccess(r.id, { reason: "Fin" }, { db, actorId: "admin-1", now: NOW });
  makeLegacy(db, r.id);
  ok("reopen refused without a fresh consent (CONSENT_RENEWAL_REQUIRED)", (await rejects(adminReopenAccess(r.id, { reason: "Reprise" }, { db, actorId: "admin-1", now: NOW })))?.code === "CONSENT_RENEWAL_REQUIRED"
    && accessOf(db, r.id).status === "CLOSED");
  ok("database guard refuses CLOSED → ACTIVE too (BRC03)", /BRC03/.test((await rejects(db.brandAccess.updateMany({
    where: { id: r.id }, data: { status: "ACTIVE", closedAt: null, closedBy: null, closeReason: null } })))?.message || ""));
  ok("participant sees RENEWAL_REQUIRED", (await publicAccessWithConsent(accessOf(db, r.id), db)).consentStatus === "RENEWAL_REQUIRED");
  const c1 = await recordFreshConsent("a1", r.id, { termsVersion: 1, acceptTerms: true }, { db });
  ok("fresh consent (REOPEN_RENEWAL) does not reopen by itself", accessOf(db, r.id).status === "CLOSED" && db._tables.brandAccessConsent.find((x) => x.id === c1.id).context === "REOPEN_RENEWAL");
  await publishV2(db);
  ok("a newer version published after the renewal → reopen refused again", (await rejects(adminReopenAccess(r.id, { reason: "Reprise" }, { db, actorId: "admin-1", now: NOW })))?.code === "CONSENT_RENEWAL_REQUIRED");
  ok("renewing against the old version → TERMS_CHANGED", (await rejects(recordFreshConsent("a1", r.id, { termsVersion: 1, acceptTerms: true }, { db })))?.code === "TERMS_CHANGED");
  const c2 = await recordFreshConsent("a1", r.id, { termsVersion: 2, acceptTerms: true }, { db });
  const reopened = await adminReopenAccess(r.id, { reason: "Reprise" }, { db, actorId: "admin-1", now: NOW });
  ok("renewal to the latest version → reopened; audit records the renewal used", reopened.status === "ACTIVE"
    && audits(db, "ACCESS_REOPENED").at(-1).after.consentBasis === `RENEWAL:${c2.id}`);
  ok("original snapshot untouched by renewals and reopening", accessOf(db, r.id).termsSnapshot.text === "texte d'une ancienne version" && accessOf(db, r.id).termsTextSha256 === null);
  const ok2 = await request(db, "a2", 2);
  await payAndAccept(db, "a2", ok2.id, { now: NOW });
  await adminCloseAccess(ok2.id, { reason: "Fin" }, { db, actorId: "admin-1", now: NOW });
  await publishV2(db, "Texte de test v3");
  const re2 = await adminReopenAccess(ok2.id, { reason: "Reprise" }, { db, actorId: "admin-1", now: NOW });
  ok("verified original consent reopens even after newer versions (consentBasis ORIGINAL)", re2.status === "ACTIVE" && audits(db, "ACCESS_REOPENED").at(-1).after.consentBasis === "ORIGINAL");
}

// ── 6. Fresh-consent rules and evidence protection ────────────────────────────
console.log("\n6. Fresh-consent rules");
{
  const db = newDb();
  const r = await request(db);
  makeLegacy(db, r.id);
  ok("another participant → ACCESS_NOT_FOUND", (await rejects(recordFreshConsent("a2", r.id, { termsVersion: 1, acceptTerms: true }, { db })))?.code === "ACCESS_NOT_FOUND");
  ok("no explicit acceptance → TERMS_NOT_ACCEPTED", (await rejects(recordFreshConsent("a1", r.id, { termsVersion: 1, acceptTerms: "yes" }, { db })))?.code === "TERMS_NOT_ACCEPTED");
  const verified = await request(db, "a2");
  ok("verified original consent → CONSENT_NOT_REQUIRED", (await rejects(recordFreshConsent("a2", verified.id, { termsVersion: 1, acceptTerms: true }, { db })))?.code === "CONSENT_NOT_REQUIRED");
  ok("database: a fresh consent for a verified request is refused (BRC04)", /BRC04/.test((await rejects(db.brandAccessConsent.create({ data: {
    accessId: verified.id, affiliateId: "a2", context: "PENDING_RENEWAL", termsVersion: 1, termsTextSha256: termsTextSha256("Texte de test") } })))?.message || ""));
  ok("database: wrong context for the status is refused (BRC04)", /BRC04/.test((await rejects(db.brandAccessConsent.create({ data: {
    accessId: r.id, affiliateId: "a1", context: "REOPEN_RENEWAL", termsVersion: 1, termsTextSha256: termsTextSha256("Texte de test") } })))?.message || ""));
  await recordFreshConsent("a1", r.id, { termsVersion: 1, acceptTerms: true }, { db });
  ok("consents are append-only", /append-only/.test((await rejects(db.brandAccessConsent.updateMany({ where: {}, data: { termsVersion: 9 } })))?.message || "")
    && /append-only/.test((await rejects(db.brandAccessConsent.deleteMany({ where: {} })))?.message || ""));
}

// ── 7. Routes ─────────────────────────────────────────────────────────────────
console.log("\n7. Routes");
{
  const db = newDb();
  const aff = affiliateBrandHandlers({ db, now: () => NOW, storage: makeProofStorage(), rateLimit: () => null });
  const adm = adminBrandHandlers({ db, now: () => NOW });
  const post = (body) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ctx = (id) => ({ params: Promise.resolve({ id }) });
  const r = await request(db);
  makeLegacy(db, r.id);
  const ov = await (await aff.overview(new Request("http://x"), {}, { affiliateId: "a1" })).json();
  ok("overview: terms from the immutable version, consent state, no fingerprint", ov.terms.version === 1 && ov.terms.text === "Texte de test"
    && ov.access.consentStatus === "PAYMENT_BLOCKED" && !JSON.stringify(ov).includes(termsTextSha256("Texte de test")));
  ok("inactive account → 403", (await aff.renewConsent(post({ termsVersion: 1, acceptTerms: true }), ctx(r.id), { affiliateId: "a4" })).status === 403);
  ok("another participant → 404", (await aff.renewConsent(post({ termsVersion: 1, acceptTerms: true }), ctx(r.id), { affiliateId: "a2" })).status === 404);
  const created = await aff.renewConsent(post({ termsVersion: 1, acceptTerms: true }), ctx(r.id), { affiliateId: "a1" });
  ok("own renewal → 201, no fingerprint in the response", created.status === 201 && !(await created.text()).includes(termsTextSha256("Texte de test")));
  const limited = affiliateBrandHandlers({ db, rateLimit: () => new Response("slow", { status: 429 }) });
  ok("rate limited → 429", (await limited.renewConsent(post({}), ctx(r.id), { affiliateId: "a1" })).status === 429);
  const c = await request(db, "a2");
  await payAndAccept(db, "a2", c.id, { now: NOW });
  await adminCloseAccess(c.id, { reason: "Fin" }, { db, actorId: "admin-1", now: NOW });
  makeLegacy(db, c.id);
  const res = await adm.actOnAccess(post({ action: "reopen", reason: "Reprise" }), ctx(c.id), { userId: "admin-1" });
  ok("admin reopen without renewal → 409 CONSENT_RENEWAL_REQUIRED", res.status === 409 && (await res.json()).code === "CONSENT_RENEWAL_REQUIRED");
}

// ── 8. Streaming upload cap ───────────────────────────────────────────────────
console.log("\n8. Upload cap (8 MiB file, 8 MiB + 64 KiB body)");
{
  ok("limit = 8,454,144 bytes", PROOF_BODY_LIMIT === 8 * 1024 * 1024 + 64 * 1024 && PROOF_BODY_LIMIT === 8454144);
  const streamOf = (total, chunk = 1024 * 1024) => {
    let sent = 0, cancelled = false;
    const stream = new ReadableStream({
      pull(ctrl) { if (sent >= total) return ctrl.close(); const n = Math.min(chunk, total - sent); sent += n; ctrl.enqueue(new Uint8Array(n)); },
      cancel() { cancelled = true; },
    });
    return { stream, sentBytes: () => sent, wasCancelled: () => cancelled };
  };
  const fakeReq = (headers, body) => ({ headers: new Headers(headers), body });
  const code = async (p) => (await rejects(p))?.code;
  ok("declared Content-Length above the limit → refused before reading (FILE_TOO_LARGE)",
    await code(readFormDataCapped(fakeReq({ "content-length": String(PROOF_BODY_LIMIT + 1) }, streamOf(10).stream))) === "FILE_TOO_LARGE");
  const lying = streamOf(PROOF_BODY_LIMIT + 5 * 1024 * 1024);
  ok("false (small) Content-Length → stream cut once the limit is passed, never fully read",
    await code(readFormDataCapped(fakeReq({ "content-length": "100", "content-type": "multipart/form-data; boundary=x" }, lying.stream))) === "FILE_TOO_LARGE"
    && lying.wasCancelled() && lying.sentBytes() < PROOF_BODY_LIMIT + 5 * 1024 * 1024);
  const chunked = streamOf(PROOF_BODY_LIMIT + 1, 64 * 1024);
  ok("missing Content-Length (chunked) → cut at the limit", await code(readFormDataCapped(fakeReq({ "content-type": "multipart/form-data; boundary=x" }, chunked.stream))) === "FILE_TOO_LARGE"
    && chunked.wasCancelled());
  const db = newDb();
  const aff = affiliateBrandHandlers({ db, now: () => NOW, storage: makeProofStorage(), rateLimit: () => null });
  const ctx = (id) => ({ params: Promise.resolve({ id }) });
  const upload = (bytes) => { const fd = new FormData(); fd.set("paymentMethod", "Virement bancaire"); fd.set("proof", new File([bytes], "p.png", { type: "image/png" })); return new Request("http://x", { method: "POST", body: fd }); };
  const exact = Buffer.concat([pngBytes("exact"), Buffer.alloc(8 * 1024 * 1024 - pngBytes("exact").length)]);
  const r1 = await request(db);
  ok("exactly 8 MiB file → accepted (201)", (await aff.submitProof(upload(exact), ctx(r1.id), { affiliateId: "a1" })).status === 201);
  const r2 = await request(db, "a2");
  const over = await aff.submitProof(upload(Buffer.concat([exact, Buffer.from([1])])), ctx(r2.id), { affiliateId: "a2" });
  ok("8 MiB + 1 byte → 413 FILE_TOO_LARGE", over.status === 413 && (await over.json()).code === "FILE_TOO_LARGE");
}

// ── 9. Error mapping and TRY_AGAIN ────────────────────────────────────────────
console.log("\n9. Error mapping");
{
  const driver = (state, msg) => new Error(`ConnectorError(PostgresError { code: "${state}", message: "${msg}" })`);
  ok("each guard error maps to its domain code",
    brandDbErrorCode(driver("BRC01", "brand_accesses: consent does not match an immutable published terms version")) === "CONSENT_UNVERIFIED"
    && brandDbErrorCode(driver("BRC02", "brand_payment_proofs: payment requires verified original consent")) === "CONSENT_UNVERIFIED"
    && brandDbErrorCode(driver("BRC03", "brand_accesses: reopening requires verified original consent or a renewal to the latest terms")) === "CONSENT_RENEWAL_REQUIRED"
    && brandDbErrorCode(driver("BRC04", "brand_access_consents: a fresh consent is not allowed for this request or terms version")) === "CONSENT_NOT_REQUIRED"
    && brandDbErrorCode(driver("BRP01", "brand_payment_proofs: a proof is submitted only for a request awaiting payment")) === "NOT_PENDING");
  const rawShape = (state, msg) => new Error(`Raw query failed. Code: \`${state}\`. Message: \`ERROR: ${msg}\``);
  ok("raw-query error shape is recognised too (and its SQLSTATE checked)",
    brandDbErrorCode(rawShape("BRC02", "brand_payment_proofs: payment requires verified original consent")) === "CONSENT_UNVERIFIED"
    && brandDbErrorCode(rawShape("P0001", "brand_payment_proofs: payment requires verified original consent")) === null);
  ok("unrelated errors are never mapped", brandDbErrorCode(new Error("connection lost")) === null && brandDbErrorCode(driver("23505", "duplicate key")) === null
    && brandDbErrorCode(driver("XX000", "brand_accesses: consent does not match an immutable published terms version")) === null && brandDbErrorCode(null) === null);
  const db = newDb();
  const realTx = db.$transaction;
  db.$transaction = async () => { throw Object.assign(new Error("serialization failure"), { code: "P2034" }); };
  const e = await rejects(request(db));
  db.$transaction = realTx;
  ok("serialization conflict with nothing to replay → TRY_AGAIN", e?.code === "TRY_AGAIN");
  db.$transaction = async () => { throw new Error("disk failure"); };
  const e2 = await rejects(request(db));
  db.$transaction = realTx;
  ok("other errors are not turned into TRY_AGAIN", e2?.message === "disk failure" && e2?.code === undefined);
}

// ── 10. Integrity diagnostics and notifications ───────────────────────────────
console.log("\n10. Legacy integrity diagnostics; notifications unchanged");
{
  const db = newDb();
  const r = await request(db);
  const row = accessOf(db, r.id);
  const good = assessLegacyIntegrity(row, { versionRow: db._tables.brandTermsVersion[0] });
  ok("an intact request passes every check, which still does not authorize payment", good.allPassed && good.authorizesPayment === false);
  const bad = assessLegacyIntegrity({ ...row, amount: "1.00", selectedProducts: [{ id: "a" }, { id: "a" }] }, { versionRow: null, hasProof: true });
  ok("inconsistent legacy data is reported, nothing is changed", !bad.allPassed && !bad.checks.amountMatchesSnapshot && !bad.checks.productsValid
    && !bad.checks.noProof && !bad.checks.termsVersionExists && accessOf(db, r.id).amount === row.amount);
  makeLegacy(db, r.id);
  const listed = (await adminListAccesses({ db })).find((x) => x.id === r.id);
  ok("admin list carries the diagnostics for an unverifiable pending request", listed.integrity && listed.integrity.authorizesPayment === false);
  ok("still exactly six notification types", BRAND_NOTIFICATION_TYPES.join() === "submitted,accepted,rejected,closed,reopened,authorized");
  ok("fresh consents never notify", (await recordFreshConsent("a1", r.id, { termsVersion: 1, acceptTerms: true }, { db })) && db._tables.affiliateNotification.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
