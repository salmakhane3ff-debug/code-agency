/**
 * src/lib/services/brandAccessService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — ACCESS to the training simulator and its lifecycle.
 *
 *   none            → PENDING_PAYMENT  participant request (package, products,
 *                                      brand name, PUBLISHED terms accepted);
 *                                      after a CLOSED access it must claim a
 *                                      single-use admin authorization (atomic)
 *   PENDING_PAYMENT → ACTIVE           only by accepting the payment proof
 *                                      (brandPaymentService) — never directly
 *   PENDING_PAYMENT → REJECTED         admin, reason required (a submitted proof
 *                                      is rejected with it — final)
 *   PENDING_PAYMENT → CANCELLED        owner, until the proof is accepted (a
 *                                      submitted proof becomes WITHDRAWN)
 *   ACTIVE          → CLOSED           admin, reason required: the period ends,
 *                                      history stays readable (read-only)
 *   CLOSED          → ACTIVE           admin, reason required: a NEW period
 *                                      starts now; the closed gap is never filled
 *
 * Guarantees:
 *   • idempotent request: (affiliateId, clientRequestId) is unique; one open
 *     (pending/active) access per affiliate (partial unique index)
 *   • every transition is a conditional update gated on the current status, in
 *     one transaction with its audit row (and its notification); the database
 *     also refuses any other transition (brand_accesses_guard)
 *   • lock order: payment proof row, then access row — cancellation, proof
 *     acceptance and rejection can never deadlock, and exactly one wins
 *   • the package, pricing breakdown, amount, branding, accepted terms and
 *     selected products are snapshotted and frozen
 *
 * Refund-terms consent (brandConsentService): a request snapshots the latest
 * IMMUTABLE published version (exact text + SHA-256; acceptance time written by
 * the database). A participant whose original consent cannot be verified may
 * record a separate FRESH consent: on a PENDING request it never authorizes
 * payment; on a CLOSED request a renewal to the latest version allows reopening.
 * Lock order everywhere: terms lock → per-access lock → row locks.
 *
 * This service moves NO money: it never touches the wallet, deposits, payouts,
 * orders, commissions or Rewards.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { randomUUID } from 'crypto';
import {
  isOfferedPackage, packageProducts, normalizeBrandName, isValidClientRequestId, normalizeProductSelection,
  normalizeTransferReference,
} from '../brandProgram.js';
import { packageBreakdown } from '../brandPricing.js';
import { getBrandConfig, getEligibleCatalog, writeBrandAudit, BRAND_ACTOR } from './brandProgramService.js';
import { advisoryXactLock, advisoryXactLockShared, accessLockKey } from './brandSimSettingsService.js';
import {
  TERMS_LOCK_KEY, CONSENT, CONSENT_CONTEXT, getPublishedTermsVersion, classifyConsent, originalConsent, consentForReopen,
  assessLegacyIntegrity, brandDbErrorCode,
} from './brandConsentService.js';
import { notifyBrand } from '../brandNotifications.js';

export const ACCESS_STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT', ACTIVE: 'ACTIVE', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', CLOSED: 'CLOSED',
});
export const PROOF_STATUS = Object.freeze({ SUBMITTED: 'SUBMITTED', ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED', WITHDRAWN: 'WITHDRAWN' });
export const OPEN_ACCESS_STATUSES = Object.freeze([ACCESS_STATUS.PENDING_PAYMENT, ACCESS_STATUS.ACTIVE]);

const HOUR_MS = 3_600_000;
const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const cleanText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const requireReason = (reason) => {
  const why = cleanText(reason, 500);
  if (!why) throw err('REASON_REQUIRED', 'Le motif est obligatoire.', { errors: { reason: 'REQUIRED' } });
  return why;
};
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Participant-facing consent state (never claims an unverifiable consent is valid):
 * OK | UNVERIFIABLE | PAYMENT_BLOCKED | RENEWED_PAYMENT_BLOCKED | RENEWAL_REQUIRED | RENEWED
 */
function consentStatus(row, info) {
  if (!info) return null;
  if (info.original === CONSENT.VERIFIED) return 'OK';
  const has = (context) => info.renewals.some((r) => r.context === context && (context !== CONSENT_CONTEXT.REOPEN_RENEWAL || r.termsVersion === info.latestVersion));
  if (row.status === ACCESS_STATUS.PENDING_PAYMENT) return has(CONSENT_CONTEXT.PENDING_RENEWAL) ? 'RENEWED_PAYMENT_BLOCKED' : 'PAYMENT_BLOCKED';
  if (row.status === ACCESS_STATUS.CLOSED) return has(CONSENT_CONTEXT.REOPEN_RENEWAL) ? 'RENEWED' : 'RENEWAL_REQUIRED';
  return 'UNVERIFIABLE';
}

const publicRenewal = (r) => ({ id: r.id, context: r.context, termsVersion: r.termsVersion, acceptedAt: iso(r.acceptedAt) });

/**
 * Consent information of several requests (two batch reads): original consent
 * class, fresh consents and the latest published version. Map id → info.
 */
export async function loadConsentInfo(db, rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return new Map();
  const versions = [...new Set(list.map((r) => r.termsVersion))];
  const [versionRows, renewals, latest] = await Promise.all([
    db.brandTermsVersion.findMany({ where: { version: { in: versions } } }),
    db.brandAccessConsent.findMany({ where: { accessId: { in: list.map((r) => r.id) } }, orderBy: { acceptedAt: 'asc' } }),
    getPublishedTermsVersion(db),
  ]);
  const byVersion = new Map(versionRows.map((v) => [v.version, v]));
  return new Map(list.map((r) => [r.id, {
    original: classifyConsent(r, byVersion.get(r.termsVersion) || null),
    renewals: renewals.filter((c) => c.accessId === r.id).map(publicRenewal),
    latestVersion: latest ? latest.version : null,
    versionRow: byVersion.get(r.termsVersion) || null,
  }]));
}

/** What the participant sees about their own access (no payment reference, no admin ids, no fingerprint). */
export function publicAccess(row, info = null) {
  if (!row) return null;
  const pkg = row.packageSnapshot || {};
  return {
    id: row.id,
    brandName: row.brandName,
    package: {
      id: row.packageId, name: pkg.name || '', features: Array.isArray(pkg.features) ? pkg.features : [],
      productCount: pkg.productCount ?? null, breakdown: pkg.breakdown || null,
    },
    branding: row.brandingSnapshot ? { label: row.brandingSnapshot.label || '' } : null,
    products: Array.isArray(row.selectedProducts)
      ? row.selectedProducts.map((p) => ({ id: p.id, title: p.title || '', image: p.image || null }))
      : [],
    amount: Number(row.amount),
    status: row.status,
    termsVersion: row.termsVersion,
    createdAt: iso(row.createdAt),
    activatedAt: iso(row.activatedAt),
    simulationStartsAt: iso(row.simulationStartsAt),
    closedAt: iso(row.closedAt),
    rejectionReason: row.status === ACCESS_STATUS.REJECTED ? (row.closeReason || null) : null,
    closureReason: row.status === ACCESS_STATUS.CLOSED ? (row.closeReason || null) : null,
    paymentProof: row.paymentProof ? publicProof(row.paymentProof) : null,
    acceptedTerms: { version: row.termsVersion, acceptedAt: row.termsSnapshot?.acceptedAt || null },
    consentStatus: consentStatus(row, info),
  };
}

/** A payment proof as shown to its owner / the admin — never the private file key or fingerprint. */
export function publicProof(p) {
  return {
    id: p.id, status: p.status, paymentMethod: p.paymentMethod, transferReference: p.transferReference || null,
    submittedAt: iso(p.createdAt), reviewedAt: iso(p.reviewedAt), rejectionReason: p.rejectionReason || null,
  };
}

/** Admin view: everything, plus the affiliate's name and the consent verification state. */
export function adminAccess(row, info = null) {
  if (!row) return null;
  const unverifiable = info && info.original !== CONSENT.VERIFIED;
  return {
    ...publicAccess(row, info),
    consent: info ? info.original : null,
    renewals: info ? info.renewals : [],
    paymentBlockedReason: unverifiable && row.status === ACCESS_STATUS.PENDING_PAYMENT ? 'CONSENT_UNVERIFIED' : null,
    integrity: unverifiable && row.status === ACCESS_STATUS.PENDING_PAYMENT && info.integrity ? info.integrity : null,
    affiliateId: row.affiliateId,
    affiliate: row.affiliate ? { username: row.affiliate.username, name: row.affiliate.name } : null,
    packageSnapshot: row.packageSnapshot,
    brandingSnapshot: row.brandingSnapshot,
    termsSnapshot: row.termsSnapshot,
    selectedProducts: row.selectedProducts || [],
    paymentReference: row.paymentReference || null,
    activatedBy: row.activatedBy || null,
    closedBy: row.closedBy || null,
    closeReason: row.closeReason || null,
    clientRequestId: row.clientRequestId,
    authorizationId: row.authorizationId || null,
    lastReopenedAt: iso(row.lastReopenedAt),
    paymentProof: row.paymentProof ? { ...publicProof(row.paymentProof), reviewedBy: row.paymentProof.reviewedBy || null } : null,
    updatedAt: iso(row.updatedAt),
  };
}

/** The participant's LATEST access: the open one if any, else the most recent one (with its proof). */
export async function getAffiliateAccessRow(affiliateId, db = prisma) {
  const include = { paymentProof: true };
  const open = await db.brandAccess.findFirst({ where: { affiliateId, status: { in: [...OPEN_ACCESS_STATUSES] } }, orderBy: { createdAt: 'desc' }, include });
  return open || db.brandAccess.findFirst({ where: { affiliateId }, orderBy: { createdAt: 'desc' }, include });
}

/** Participant view of one access with its consent state. */
export async function publicAccessWithConsent(row, db = prisma) {
  if (!row) return null;
  return publicAccess(row, (await loadConsentInfo(db, [row])).get(row.id));
}

/** Admin view of one access with its consent state. */
async function adminAccessWithConsent(db, id) {
  const row = await db.brandAccess.findUnique({ where: { id }, include: withAdminIncludes });
  return row ? adminAccess(row, (await loadConsentInfo(db, [row])).get(row.id)) : null;
}

/**
 * Create a request for access (status PENDING_PAYMENT). No money is recorded.
 * @param {object} input { productIds, packageId, brandName, brandingOptionId?, termsVersion, acceptTerms, clientRequestId }
 * @throws BRAND_DISABLED | PACKAGE_NOT_FOUND | INVALID_PRODUCT_SELECTION | PRODUCT_NOT_AVAILABLE
 *         | INVALID_BRAND_NAME | BRANDING_NOT_FOUND | TERMS_NOT_PUBLISHED
 *         | TERMS_CHANGED | TERMS_NOT_ACCEPTED | INVALID_INPUT | ACCESS_EXISTS | IDEMPOTENCY_CONFLICT
 *         | AUTHORIZATION_REQUIRED (a previous access is CLOSED and no unused authorization exists)
 */
export async function requestBrandAccess(affiliateId, input = {}, { db = prisma, now = new Date() } = {}) {
  const config = await getBrandConfig(db);
  if (!config.enabled) throw err('BRAND_DISABLED', 'Ce service n’est pas disponible pour le moment.');

  const clientRequestId = input.clientRequestId;
  if (!isValidClientRequestId(clientRequestId)) throw err('INVALID_INPUT', 'Requête invalide', { errors: { clientRequestId: 'INVALID_REQUEST_ID' } });

  // Package: active, complete and with enough eligible products right now.
  const catalog = await getEligibleCatalog(config, db);
  const pkg = config.packages.find((p) => p.id === String(input.packageId || '') && isOfferedPackage(p, catalog));
  if (!pkg) throw err('PACKAGE_NOT_FOUND', 'Pack introuvable ou indisponible.');
  const breakdown = packageBreakdown(pkg);

  // Products: only ids are taken from the request — names and images come from the store.
  const productIds = normalizeProductSelection(input.productIds);
  if (!productIds || productIds.length !== pkg.productCount) {
    throw err('INVALID_PRODUCT_SELECTION', `Ce pack demande exactement ${pkg.productCount} produits différents.`,
      { errors: { productIds: 'INVALID_PRODUCT_SELECTION' }, expected: pkg.productCount });
  }
  const byId = new Map(packageProducts(pkg, catalog).map((p) => [p.id, p]));
  const unavailable = productIds.filter((id) => !byId.has(id));
  if (unavailable.length) {
    throw err('PRODUCT_NOT_AVAILABLE', 'Un des produits choisis n’est pas disponible pour ce pack.', { errors: { productIds: 'PRODUCT_NOT_AVAILABLE' }, unavailable });
  }
  const selectedProducts = productIds.map((id) => byId.get(id));
  const brandName = normalizeBrandName(input.brandName);
  if (!brandName) throw err('INVALID_BRAND_NAME', 'Nom de marque invalide.', { errors: { brandName: 'INVALID_BRAND_NAME' } });

  let branding = null;
  if (input.brandingOptionId) {
    branding = config.brandingOptions.find((o) => o.id === String(input.brandingOptionId) && o.active);
    if (!branding) throw err('BRANDING_NOT_FOUND', 'Option de personnalisation indisponible.');
  }

  if (!(await getPublishedTermsVersion(db))) throw err('TERMS_NOT_PUBLISHED', 'Les conditions ne sont pas encore publiées.');
  if (input.acceptTerms !== true) throw err('TERMS_NOT_ACCEPTED', 'Vous devez accepter les conditions.', { errors: { acceptTerms: 'REQUIRED' } });

  const data = {
    affiliateId,
    brandName,
    packageId: pkg.id,
    packageSnapshot: {
      id: pkg.id, name: pkg.name, description: pkg.description, features: pkg.features, productCount: pkg.productCount,
      price: pkg.price, deliveryCost: pkg.deliveryCost, logisticsCost: pkg.logisticsCost, vatPercent: pkg.vatPercent,
      percentages: pkg.percentages, breakdown,
    },
    brandingOptionId: branding ? branding.id : null,
    brandingSnapshot: branding ? { id: branding.id, label: branding.label, description: branding.description } : undefined,
    amount: breakdown.total.toFixed(2), // amount to pay = breakdown total (server-computed)
    // termsVersion / termsSnapshot / termsTextSha256: set inside the transaction
    // from the immutable published version; acceptedAt is written by the database.
    selectedProducts,
    clientRequestId,
    status: ACCESS_STATUS.PENDING_PAYMENT,
  };

  const idsOf = (row) => (Array.isArray(row.selectedProducts) ? row.selectedProducts.map((p) => p.id) : []).join(',');
  const sameRequest = (row) => row.packageId === data.packageId && row.brandName === data.brandName
    && (row.brandingOptionId || null) === data.brandingOptionId && idsOf(row) === productIds.join(',');
  const replay = async () => {
    const row = await db.brandAccess.findUnique({ where: { affiliateId_clientRequestId: { affiliateId, clientRequestId } } });
    if (!row) return null;
    if (!sameRequest(row)) throw err('IDEMPOTENCY_CONFLICT', 'Cette demande a déjà été envoyée avec d’autres informations.');
    return publicAccess(row);
  };

  try {
    return await db.$transaction(async (tx) => {
      // Lock order: terms lock (shared; publishing takes it exclusively) first.
      await advisoryXactLockShared(tx, TERMS_LOCK_KEY);
      const existing = await tx.brandAccess.findUnique({ where: { affiliateId_clientRequestId: { affiliateId, clientRequestId } } });
      if (existing) {
        if (!sameRequest(existing)) throw err('IDEMPOTENCY_CONFLICT', 'Cette demande a déjà été envoyée avec d’autres informations.');
        return publicAccess(existing);
      }
      // Terms: the latest IMMUTABLE published version, read under the shared terms
      // lock. Its exact text and fingerprint are snapshotted; the database checks
      // them and writes the acceptance time.
      const published = await getPublishedTermsVersion(tx);
      if (!published) throw err('TERMS_NOT_PUBLISHED', 'Les conditions ne sont pas encore publiées.');
      if (Number(input.termsVersion) !== published.version) throw err('TERMS_CHANGED', 'Les conditions ont été mises à jour : relisez-les.');
      data.termsVersion = published.version;
      data.termsSnapshot = { version: published.version, text: published.text, publishedAt: iso(published.publishedAt), acceptedAt: null };
      data.termsTextSha256 = published.textSha256;
      const open = await tx.brandAccess.findFirst({ where: { affiliateId, status: { in: [...OPEN_ACCESS_STATUSES] } }, select: { id: true } });
      if (open) throw err('ACCESS_EXISTS', 'Vous avez déjà une demande en cours ou un accès actif.');
      // After a CLOSED access a new request needs a single-use admin authorization,
      // claimed atomically here (the database enforces it too).
      const hasClosed = (await tx.brandAccess.count({ where: { affiliateId, status: ACCESS_STATUS.CLOSED } })) > 0;
      const authorization = hasClosed
        ? await tx.brandRequestAuthorization.findFirst({ where: { affiliateId, revokedAt: null, consumedAt: null } })
        : null;
      if (hasClosed && !authorization) throw err('AUTHORIZATION_REQUIRED', 'Une autorisation de l’administrateur est nécessaire pour une nouvelle demande.');
      const row = await tx.brandAccess.create({ data: authorization ? { ...data, authorizationId: authorization.id } : data });
      if (authorization) {
        const used = await tx.brandRequestAuthorization.updateMany({
          where: { id: authorization.id, revokedAt: null, consumedAt: null },
          data: { consumedAt: new Date(now), consumedByAccessId: row.id },
        });
        if (used.count !== 1) throw err('AUTHORIZATION_REQUIRED', 'Une autorisation de l’administrateur est nécessaire pour une nouvelle demande.');
        await writeBrandAudit(tx, {
          action: 'REQUEST_AUTHORIZATION_USED', entityType: 'brand_authorization', entityId: authorization.id,
          actorType: BRAND_ACTOR.AFFILIATE, actorId: affiliateId, after: { consumedByAccessId: row.id },
        });
      }
      await writeBrandAudit(tx, {
        action: 'ACCESS_REQUESTED', entityType: 'brand_access', entityId: row.id,
        actorType: BRAND_ACTOR.AFFILIATE, actorId: affiliateId,
        after: { brandName, packageId: pkg.id, amount: data.amount, subtotal: breakdown.subtotal, vat: breakdown.vat.amount, termsVersion: published.version, termsTextSha256: published.textSha256, productIds },
      });
      return publicAccess(row);
    }, { isolationLevel: 'Serializable' });
  } catch (e) {
    // Lost a race: on a unique index (a replay of the same request, or a second
    // open access — partial unique index) or on serialization. Never a duplicate row.
    if (e?.code === 'P2002' || e?.code === 'P2034') {
      const same = await replay();
      if (same) return same;
      const open = await db.brandAccess.findFirst({ where: { affiliateId, status: { in: [...OPEN_ACCESS_STATUSES] } }, select: { id: true } });
      if (open || e.code === 'P2002') throw err('ACCESS_EXISTS', 'Vous avez déjà une demande en cours ou un accès actif.');
      // Serialization conflict with nothing to replay and no open request: retryable.
      throw err('TRY_AGAIN', 'La demande n’a pas pu être enregistrée pour le moment : réessayez.');
    }
    const code = brandDbErrorCode(e);
    if (code) throw err(code, 'Les conditions acceptées ne correspondent pas à une version publiée.');
    throw e;
  }
}

/**
 * Review a SUBMITTED proof of `accessId` (withdraw / reject) → the proof, or null.
 * Called before the access update (proof locked first, against a concurrent
 * acceptance) and once more after it: a proof inserted concurrently holds the
 * access row (FOR SHARE, DB trigger) until it commits, so the second pass sees it.
 */
async function settleSubmittedProof(tx, accessId, data) {
  const proof = await tx.brandPaymentProof.findUnique({ where: { accessId } });
  if (!proof) return null;
  const r = await tx.brandPaymentProof.updateMany({ where: { id: proof.id, status: PROOF_STATUS.SUBMITTED }, data });
  return r.count === 1 ? proof : null;
}

/**
 * The owner cancels their request while it awaits payment — allowed until the
 * payment proof is accepted; a SUBMITTED proof becomes WITHDRAWN (file and
 * audit kept). Lock order: proof, then access — against a concurrent proof
 * acceptance exactly one of the two succeeds. @throws ACCESS_NOT_FOUND | NOT_PENDING
 */
export async function cancelOwnAccess(affiliateId, accessId, { db = prisma, now = new Date() } = {}) {
  const at = new Date(now);
  return db.$transaction(async (tx) => {
    const row = await tx.brandAccess.findUnique({ where: { id: String(accessId || '') } });
    if (!row || row.affiliateId !== affiliateId) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
    const withdraw = { status: PROOF_STATUS.WITHDRAWN };
    let proof = await settleSubmittedProof(tx, row.id, withdraw);
    const r = await tx.brandAccess.updateMany({
      where: { id: row.id, affiliateId, status: ACCESS_STATUS.PENDING_PAYMENT },
      data: { status: ACCESS_STATUS.CANCELLED, closedAt: at, closedBy: affiliateId, closeReason: 'CANCELLED_BY_PARTICIPANT' },
    });
    if (r.count !== 1) throw err('NOT_PENDING', 'Cette demande ne peut plus être annulée.');
    proof = proof || await settleSubmittedProof(tx, row.id, withdraw);
    if (proof) {
      await writeBrandAudit(tx, {
        action: 'PAYMENT_PROOF_WITHDRAWN', entityType: 'brand_payment_proof', entityId: proof.id,
        actorType: BRAND_ACTOR.AFFILIATE, actorId: affiliateId, before: { status: PROOF_STATUS.SUBMITTED }, after: { status: PROOF_STATUS.WITHDRAWN, accessId: row.id },
      });
    }
    await writeBrandAudit(tx, {
      action: 'ACCESS_CANCELLED', entityType: 'brand_access', entityId: row.id,
      actorType: BRAND_ACTOR.AFFILIATE, actorId: affiliateId, before: { status: row.status }, after: { status: ACCESS_STATUS.CANCELLED },
    });
    return publicAccessWithConsent(await tx.brandAccess.findUnique({ where: { id: row.id }, include: { paymentProof: true } }), tx);
  });
}

const withAdminIncludes = { affiliate: { select: { username: true, name: true } }, paymentProof: true };

/**
 * Activation INSIDE a proof-acceptance transaction (brandPaymentService): the
 * proof is already ACCEPTED in `tx`. Starts the first access period; the
 * simulation start = activation + the start delay configured now (snapshotted).
 */
export async function activateAfterAcceptedProof(tx, row, { proof, actorId, at, config }) {
  const delayHours = config.simulation.startDelayHours ?? 0;
  const startsAt = new Date(at.getTime() + delayHours * HOUR_MS);
  const paymentReference = cleanText(proof.transferReference, 200) || `PROOF:${proof.id}`;
  const r = await tx.brandAccess.updateMany({
    where: { id: row.id, status: ACCESS_STATUS.PENDING_PAYMENT },
    data: { status: ACCESS_STATUS.ACTIVE, paymentReference, activatedAt: at, activatedBy: actorId ? String(actorId) : null, simulationStartsAt: startsAt },
  });
  if (r.count !== 1) throw err('NOT_PENDING', 'Cette demande n’attend plus de paiement.');
  const audit = await writeBrandAudit(tx, {
    action: 'ACCESS_ACTIVATED', entityType: 'brand_access', entityId: row.id, actorId,
    before: { status: row.status }, after: { status: ACCESS_STATUS.ACTIVE, simulationStartsAt: startsAt.toISOString(), startDelayHours: delayHours, proofId: proof.id },
    reason: `payment proof accepted: ${proof.id}`,
  });
  await tx.brandAccessPeriod.create({ data: { accessId: row.id, startedAt: at, startReason: 'ACTIVATION', startAuditId: audit.id } });
  return audit;
}

/**
 * Admin rejection of a request awaiting payment (reason required). A SUBMITTED
 * proof is rejected with it — final: the participant must make a new request.
 * Lock order: proof, then access. @throws REASON_REQUIRED | ACCESS_NOT_FOUND | NOT_PENDING
 */
export async function adminRejectAccess(accessId, { reason } = {}, { actorId = null, db = prisma, now = new Date() } = {}) {
  const why = requireReason(reason);
  const at = new Date(now);
  return db.$transaction(async (tx) => {
    const row = await tx.brandAccess.findUnique({ where: { id: String(accessId || '') } });
    if (!row) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
    const reject = { status: PROOF_STATUS.REJECTED, reviewedBy: actorId ? String(actorId) : 'admin', reviewedAt: at, rejectionReason: why };
    let proof = await settleSubmittedProof(tx, row.id, reject);
    const r = await tx.brandAccess.updateMany({
      where: { id: row.id, status: ACCESS_STATUS.PENDING_PAYMENT },
      data: { status: ACCESS_STATUS.REJECTED, closedAt: at, closedBy: actorId ? String(actorId) : null, closeReason: why },
    });
    if (r.count !== 1) throw err('NOT_PENDING', 'Cette demande n’attend plus de paiement.');
    proof = proof || await settleSubmittedProof(tx, row.id, reject);
    if (proof) {
      await writeBrandAudit(tx, {
        action: 'PAYMENT_PROOF_REJECTED', entityType: 'brand_payment_proof', entityId: proof.id, actorId,
        before: { status: PROOF_STATUS.SUBMITTED }, after: { status: PROOF_STATUS.REJECTED, accessId: row.id }, reason: why,
      });
    }
    const audit = await writeBrandAudit(tx, {
      action: 'ACCESS_REJECTED', entityType: 'brand_access', entityId: row.id, actorId,
      before: { status: row.status }, after: { status: ACCESS_STATUS.REJECTED }, reason: why,
    });
    await notifyBrand(tx, { type: 'rejected', affiliateId: row.affiliateId, auditId: audit.id, brandName: row.brandName, reason: why });
    return adminAccessWithConsent(tx, row.id);
  });
}

/**
 * Admin closure of an ACTIVE access (reason required): the open period ends now;
 * history stays permanent and readable (read-only, anchored at the closure).
 * @throws REASON_REQUIRED | ACCESS_NOT_FOUND | NOT_ACTIVE
 */
export async function adminCloseAccess(accessId, { reason } = {}, { actorId = null, db = prisma, now = new Date() } = {}) {
  const why = requireReason(reason);
  const at = new Date(now);
  return db.$transaction(async (tx) => {
    const row = await tx.brandAccess.findUnique({ where: { id: String(accessId || '') } });
    if (!row) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
    await advisoryXactLock(tx, accessLockKey(row.id)); // serialised with history generation
    const r = await tx.brandAccess.updateMany({
      where: { id: row.id, status: ACCESS_STATUS.ACTIVE },
      data: { status: ACCESS_STATUS.CLOSED, closedAt: at, closedBy: actorId ? String(actorId) : 'admin', closeReason: why },
    });
    if (r.count !== 1) throw err('NOT_ACTIVE', 'Cet accès n’est pas actif.');
    const audit = await writeBrandAudit(tx, {
      action: 'ACCESS_CLOSED', entityType: 'brand_access', entityId: row.id, actorId,
      before: { status: ACCESS_STATUS.ACTIVE }, after: { status: ACCESS_STATUS.CLOSED, closedAt: at.toISOString() }, reason: why,
    });
    await tx.brandAccessPeriod.updateMany({ where: { accessId: row.id, endedAt: null }, data: { endedAt: at, endAuditId: audit.id } });
    await notifyBrand(tx, { type: 'closed', affiliateId: row.affiliateId, auditId: audit.id, brandName: row.brandName, reason: why });
    return adminAccessWithConsent(tx, row.id);
  });
}

/**
 * Admin reopening of a CLOSED access (reason required): the SAME record becomes
 * ACTIVE again and a NEW period starts now — the simulation resumes immediately
 * and the closed gap is never filled. Does not consume an authorization.
 * Consent: verified original consent, or a fresh REOPEN_RENEWAL consent to the
 * LATEST published version (also enforced by the database guard).
 * Lock order: terms lock (shared) → per-access lock → row.
 * @throws REASON_REQUIRED | ACCESS_NOT_FOUND | NOT_CLOSED | ACCESS_EXISTS | CONSENT_RENEWAL_REQUIRED
 */
export async function adminReopenAccess(accessId, { reason } = {}, { actorId = null, db = prisma, now = new Date() } = {}) {
  const why = requireReason(reason);
  const at = new Date(now);
  try {
    return await db.$transaction(async (tx) => {
      const found = await tx.brandAccess.findUnique({ where: { id: String(accessId || '') }, select: { id: true } });
      if (!found) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
      await advisoryXactLockShared(tx, TERMS_LOCK_KEY);
      await advisoryXactLock(tx, accessLockKey(found.id));
      const row = await tx.brandAccess.findUnique({ where: { id: found.id } });
      if (row.status !== ACCESS_STATUS.CLOSED) throw err('NOT_CLOSED', 'Cet accès n’est pas clôturé.');
      const open = await tx.brandAccess.findFirst({ where: { affiliateId: row.affiliateId, status: { in: [...OPEN_ACCESS_STATUSES] } }, select: { id: true } });
      if (open) throw err('ACCESS_EXISTS', 'Ce participant a déjà une demande en cours ou un accès actif.');
      const consent = await consentForReopen(tx, row);
      const r = await tx.brandAccess.updateMany({
        where: { id: row.id, status: ACCESS_STATUS.CLOSED },
        data: { status: ACCESS_STATUS.ACTIVE, closedAt: null, closedBy: null, closeReason: null, lastReopenedAt: at },
      });
      if (r.count !== 1) throw err('NOT_CLOSED', 'Cet accès n’est pas clôturé.');
      const audit = await writeBrandAudit(tx, {
        action: 'ACCESS_REOPENED', entityType: 'brand_access', entityId: row.id, actorId,
        before: { status: ACCESS_STATUS.CLOSED, closedAt: iso(row.closedAt), closeReason: row.closeReason }, after: { status: ACCESS_STATUS.ACTIVE, reopenedAt: at.toISOString(), consentBasis: consent.basis === 'ORIGINAL' ? 'ORIGINAL' : `RENEWAL:${consent.consentId}` },
        reason: why,
      });
      await tx.brandAccessPeriod.create({ data: { accessId: row.id, startedAt: at, startReason: 'REOPEN', startAuditId: audit.id } });
      await notifyBrand(tx, { type: 'reopened', affiliateId: row.affiliateId, auditId: audit.id, brandName: row.brandName });
      return adminAccessWithConsent(tx, row.id);
    });
  } catch (e) {
    if (e?.code === 'P2002') throw err('ACCESS_EXISTS', 'Ce participant a déjà une demande en cours ou un accès actif.');
    if (brandDbErrorCode(e) === 'CONSENT_RENEWAL_REQUIRED') throw err('CONSENT_RENEWAL_REQUIRED', 'Le participant doit d’abord accepter les conditions actuellement publiées.');
    throw e;
  }
}

/**
 * The participant records a FRESH consent to the latest published terms for their
 * OWN request whose original consent cannot be verified — separate append-only
 * evidence; the original snapshot, fingerprint and acceptance time never change.
 *   • PENDING_PAYMENT → PENDING_RENEWAL: payment stays blocked (fresh consent never
 *     authorizes payment)
 *   • CLOSED → REOPEN_RENEWAL: allows an admin to reopen while it matches the latest version
 * No status change, no notification. Lock order: terms lock (shared) → per-access lock.
 * @throws ACCESS_NOT_FOUND | CONSENT_NOT_REQUIRED | TERMS_NOT_ACCEPTED | TERMS_NOT_PUBLISHED | TERMS_CHANGED
 */
export async function recordFreshConsent(affiliateId, accessId, input = {}, { db = prisma } = {}) {
  if (input.acceptTerms !== true) throw err('TERMS_NOT_ACCEPTED', 'Vous devez accepter les conditions.', { errors: { acceptTerms: 'REQUIRED' } });
  try {
    return await db.$transaction(async (tx) => {
      await advisoryXactLockShared(tx, TERMS_LOCK_KEY);
      const found = await tx.brandAccess.findUnique({ where: { id: String(accessId || '') }, select: { id: true, affiliateId: true } });
      if (!found || found.affiliateId !== affiliateId) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
      await advisoryXactLock(tx, accessLockKey(found.id));
      const row = await tx.brandAccess.findUnique({ where: { id: found.id } });
      const context = row.status === ACCESS_STATUS.PENDING_PAYMENT ? CONSENT_CONTEXT.PENDING_RENEWAL
        : row.status === ACCESS_STATUS.CLOSED ? CONSENT_CONTEXT.REOPEN_RENEWAL : null;
      if (!context || (await originalConsent(tx, row)) === CONSENT.VERIFIED) {
        throw err('CONSENT_NOT_REQUIRED', 'Aucun nouveau consentement n’est nécessaire pour cette demande.');
      }
      const latest = await getPublishedTermsVersion(tx);
      if (!latest) throw err('TERMS_NOT_PUBLISHED', 'Les conditions ne sont pas encore publiées.');
      if (Number(input.termsVersion) !== latest.version) throw err('TERMS_CHANGED', 'Les conditions ont été mises à jour : relisez-les.');
      const audit = await writeBrandAudit(tx, {
        action: 'CONSENT_RENEWED', entityType: 'brand_access', entityId: row.id,
        actorType: BRAND_ACTOR.AFFILIATE, actorId: affiliateId,
        after: { context, termsVersion: latest.version, termsTextSha256: latest.textSha256, status: row.status },
      });
      const consent = await tx.brandAccessConsent.create({
        data: { accessId: row.id, affiliateId, context, termsVersion: latest.version, termsTextSha256: latest.textSha256, auditId: audit.id },
      });
      return publicRenewal(consent);
    });
  } catch (e) {
    if (brandDbErrorCode(e) === 'CONSENT_NOT_REQUIRED') throw err('CONSENT_NOT_REQUIRED', 'Aucun nouveau consentement n’est nécessaire pour cette demande.');
    throw e;
  }
}

// ── New-request authorizations (after a CLOSED access) ───────────────────────

export function publicAuthorization(a) {
  if (!a) return null;
  return {
    id: a.id, affiliateId: a.affiliateId, grantedBy: a.grantedBy, reason: a.reason, createdAt: iso(a.createdAt),
    revokedAt: iso(a.revokedAt), revokedBy: a.revokedBy || null, revokeReason: a.revokeReason || null,
    consumedAt: iso(a.consumedAt), consumedByAccessId: a.consumedByAccessId || null,
    status: a.consumedAt ? 'USED' : a.revokedAt ? 'REVOKED' : 'UNUSED',
  };
}

/**
 * Admin grants ONE new request to an affiliate whose access was closed (reason
 * required, no expiry). @throws REASON_REQUIRED | AFFILIATE_NOT_FOUND | NO_CLOSED_ACCESS | ACCESS_EXISTS | AUTHORIZATION_EXISTS
 */
export async function adminGrantAuthorization(affiliateId, { reason } = {}, { actorId = null, db = prisma } = {}) {
  const why = requireReason(reason);
  const id = String(affiliateId || '');
  try {
    return await db.$transaction(async (tx) => {
      const aff = await tx.affiliate.findUnique({ where: { id }, select: { id: true } });
      if (!aff) throw err('AFFILIATE_NOT_FOUND', 'Affilié introuvable.');
      if (await tx.brandAccess.findFirst({ where: { affiliateId: id, status: { in: [...OPEN_ACCESS_STATUSES] } }, select: { id: true } })) {
        throw err('ACCESS_EXISTS', 'Ce participant a déjà une demande en cours ou un accès actif.');
      }
      if ((await tx.brandAccess.count({ where: { affiliateId: id, status: ACCESS_STATUS.CLOSED } })) === 0) {
        throw err('NO_CLOSED_ACCESS', 'Une autorisation n’est nécessaire qu’après une marque clôturée.');
      }
      if (await tx.brandRequestAuthorization.findFirst({ where: { affiliateId: id, revokedAt: null, consumedAt: null } })) {
        throw err('AUTHORIZATION_EXISTS', 'Une autorisation non utilisée existe déjà pour ce participant.');
      }
      const authId = randomUUID();
      const audit = await writeBrandAudit(tx, {
        action: 'REQUEST_AUTHORIZED', entityType: 'brand_authorization', entityId: authId, actorId,
        after: { affiliateId: id }, reason: why,
      });
      const row = await tx.brandRequestAuthorization.create({
        data: { id: authId, affiliateId: id, grantedBy: actorId ? String(actorId) : 'admin', reason: why, grantAuditId: audit.id },
      });
      await notifyBrand(tx, { type: 'authorized', affiliateId: id, auditId: audit.id });
      return publicAuthorization(row);
    });
  } catch (e) {
    if (e?.code === 'P2002') throw err('AUTHORIZATION_EXISTS', 'Une autorisation non utilisée existe déjà pour ce participant.');
    throw e;
  }
}

/** Admin revokes an UNUSED authorization (reason required). @throws REASON_REQUIRED | AUTHORIZATION_NOT_FOUND | NOT_REVOCABLE */
export async function adminRevokeAuthorization(authorizationId, { reason } = {}, { actorId = null, db = prisma, now = new Date() } = {}) {
  const why = requireReason(reason);
  const at = new Date(now);
  return db.$transaction(async (tx) => {
    const row = await tx.brandRequestAuthorization.findUnique({ where: { id: String(authorizationId || '') } });
    if (!row) throw err('AUTHORIZATION_NOT_FOUND', 'Autorisation introuvable.');
    const audit = await writeBrandAudit(tx, {
      action: 'REQUEST_AUTHORIZATION_REVOKED', entityType: 'brand_authorization', entityId: row.id, actorId,
      before: { status: publicAuthorization(row).status }, after: { status: 'REVOKED' }, reason: why,
    });
    const r = await tx.brandRequestAuthorization.updateMany({
      where: { id: row.id, revokedAt: null, consumedAt: null },
      data: { revokedAt: at, revokedBy: actorId ? String(actorId) : 'admin', revokeReason: why, revokeAuditId: audit.id },
    });
    if (r.count !== 1) throw err('NOT_REVOCABLE', 'Seule une autorisation non utilisée peut être révoquée.');
    return publicAuthorization(await tx.brandRequestAuthorization.findUnique({ where: { id: row.id } }));
  });
}

export async function adminListAuthorizations({ affiliateId = null, db = prisma } = {}) {
  const rows = await db.brandRequestAuthorization.findMany({ where: affiliateId ? { affiliateId: String(affiliateId) } : {}, orderBy: { createdAt: 'desc' } });
  return rows.map(publicAuthorization);
}

/**
 * Admin list, most recent first, optional status filter and search (brand name
 * or username). Each request with a proof carries `referenceWarnings`: other
 * brand proofs and existing deposits with the same normalized transfer
 * reference (READ-ONLY comparison — the deposit system is never modified).
 */
export async function adminListAccesses({ status = 'ALL', q = '', db = prisma, take = 100 } = {}) {
  const where = {};
  if (status && status !== 'ALL') where.status = status;
  const needle = cleanText(q, 80);
  if (needle) {
    where.OR = [
      { brandName: { contains: needle, mode: 'insensitive' } },
      { affiliate: { username: { contains: needle, mode: 'insensitive' } } },
    ];
  }
  const rows = await db.brandAccess.findMany({
    where, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(1, take), 200), include: withAdminIncludes,
  });
  const refs = [...new Set(rows.map((r) => r.paymentProof?.transferReferenceNormalized).filter(Boolean))];
  let proofsByRef = new Map(), depositsByRef = new Map();
  if (refs.length) {
    const [proofs, deposits] = await Promise.all([
      db.brandPaymentProof.findMany({ where: { transferReferenceNormalized: { in: refs } } }),
      db.affiliateSecurityDeposit.findMany({ where: { transferReference: { not: null } }, select: { id: true, transferReference: true, affiliateId: true } }),
    ]);
    for (const p of proofs) proofsByRef.set(p.transferReferenceNormalized, [...(proofsByRef.get(p.transferReferenceNormalized) || []), p]);
    for (const d of deposits) {
      const n = normalizeTransferReference(d.transferReference);
      if (n && refs.includes(n)) depositsByRef.set(n, [...(depositsByRef.get(n) || []), d]);
    }
  }
  const consent = await loadConsentInfo(db, rows);
  const needsIntegrity = rows.filter((r) => r.status === ACCESS_STATUS.PENDING_PAYMENT && consent.get(r.id)?.original !== CONSENT.VERIFIED);
  const authIds = needsIntegrity.map((r) => r.authorizationId).filter(Boolean);
  const auths = authIds.length ? await db.brandRequestAuthorization.findMany({ where: { id: { in: authIds } } }) : [];
  for (const r of needsIntegrity) {
    const info = consent.get(r.id);
    info.integrity = assessLegacyIntegrity(r, {
      versionRow: info.versionRow, authorization: auths.find((a) => a.id === r.authorizationId) || null, hasProof: !!r.paymentProof,
    });
  }
  return rows.map((r) => {
    const out = adminAccess(r, consent.get(r.id));
    const n = r.paymentProof?.transferReferenceNormalized;
    if (n) {
      out.referenceWarnings = {
        otherProofs: (proofsByRef.get(n) || []).filter((p) => p.id !== r.paymentProof.id).map((p) => ({ id: p.id, accessId: p.accessId, status: p.status })),
        deposits: (depositsByRef.get(n) || []).map((d) => ({ id: d.id, affiliateId: d.affiliateId })),
      };
    } else out.referenceWarnings = { otherProofs: [], deposits: [] };
    return out;
  });
}
