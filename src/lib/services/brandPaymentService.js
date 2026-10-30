/**
 * src/lib/services/brandPaymentService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — PAYMENT PROOFS (brand_payment_proofs).
 *
 *   • a dedicated table: a brand proof is NEVER an affiliate security deposit and
 *     never credits the wallet (the deposit balance provider cannot see it)
 *   • one proof per request; the SHA-256 of the ORIGINAL upload is unique across
 *     every proof ever stored (rejected and withdrawn ones included)
 *   • proofs and their files are kept permanently; the only file ever deleted
 *     is one stored by a submission whose database insert then failed (orphan)
 *   • the same consent gate runs at submission, acceptance and activation: the
 *     request's OWN original consent must verify against its immutable terms
 *     version (a newer published version never invalidates it; a fresh consent
 *     never counts) — enforced again by the database (migration 20261030)
 *   • acceptance: proof SUBMITTED → ACCEPTED, then the access becomes ACTIVE, in
 *     one transaction (lock order: proof, then access — see brandAccessService)
 *   • rejection is brandAccessService.adminRejectAccess (final)
 *   • the private file key and the fingerprint are never returned to a client
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { createHash } from 'crypto';
import * as depositStorage from '../depositStorage.js';
import { normalizeTransferReference } from '../brandProgram.js';
import { getBrandConfig, writeBrandAudit, BRAND_ACTOR } from './brandProgramService.js';
import { ACCESS_STATUS, PROOF_STATUS, publicProof, adminAccess, loadConsentInfo, activateAfterAcceptedProof } from './brandAccessService.js';
import { assertOriginalConsent, brandDbErrorCode } from './brandConsentService.js';
import { notifyBrand } from '../brandNotifications.js';

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const cleanText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Storage used for proof files — the private deposit storage functions (injectable for tests). */
export const defaultProofStorage = Object.freeze({
  validate: depositStorage.validateDepositUpload,
  store: depositStorage.processAndStoreDeposit,
  read: depositStorage.readDepositByKey,
  remove: depositStorage.deleteDepositByKey,
});

export const proofFingerprint = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * The participant submits the transfer proof of their OWN request awaiting payment.
 * @param {{paymentMethod, transferReference?, proof:{buffer,mime,size}}} input
 * @throws ACCESS_NOT_FOUND | NOT_PENDING | CONSENT_UNVERIFIED
 *         | INVALID_INPUT | INVALID_FILE | DUPLICATE_PROOF | PROOF_EXISTS
 */
export async function submitPaymentProof(affiliateId, accessId, input = {}, { db = prisma, storage = defaultProofStorage } = {}) {
  const access = await db.brandAccess.findUnique({ where: { id: String(accessId || '') } });
  if (!access || access.affiliateId !== affiliateId) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
  if (access.status !== ACCESS_STATUS.PENDING_PAYMENT) throw err('NOT_PENDING', 'Cette demande n’attend plus de paiement.');
  await assertOriginalConsent(db, access);   // before anything is stored
  if (await db.brandPaymentProof.findUnique({ where: { accessId: access.id } })) throw err('PROOF_EXISTS', 'Une preuve de paiement a déjà été envoyée pour cette demande.');

  const paymentMethod = cleanText(input.paymentMethod, 60);
  if (!paymentMethod) throw err('INVALID_INPUT', 'Méthode de paiement requise.', { errors: { paymentMethod: 'REQUIRED' } });
  const transferReference = cleanText(input.transferReference, 120) || null;

  const file = input.proof || {};
  if (!Buffer.isBuffer(file.buffer) || storage.validate({ mime: file.mime, size: file.size }).length) {
    throw err('INVALID_FILE', 'Fichier invalide (JPG, PNG, WEBP ou PDF, 8 Mo maximum).');
  }
  const fingerprint = proofFingerprint(file.buffer); // of the ORIGINAL bytes, before re-encoding
  if (await db.brandPaymentProof.findUnique({ where: { fingerprint } })) throw err('DUPLICATE_PROOF', 'Ce justificatif a déjà été utilisé.');

  let fileKey;
  try {
    fileKey = await storage.store(file.buffer);
  } catch (e) {
    if (e?.code === 'DEPOSIT_INVALID_FILE') throw err('INVALID_FILE', 'Fichier non supporté ou corrompu.');
    throw e;
  }

  try {
    return await db.$transaction(async (tx) => {
      const proof = await tx.brandPaymentProof.create({
        data: {
          accessId: access.id, fileKey, fingerprint, paymentMethod, transferReference,
          transferReferenceNormalized: normalizeTransferReference(transferReference), status: PROOF_STATUS.SUBMITTED,
        },
      });
      const audit = await writeBrandAudit(tx, {
        action: 'PAYMENT_PROOF_SUBMITTED', entityType: 'brand_payment_proof', entityId: proof.id,
        actorType: BRAND_ACTOR.AFFILIATE, actorId: affiliateId,
        after: { accessId: access.id, paymentMethod, transferReference, status: PROOF_STATUS.SUBMITTED },
      });
      await notifyBrand(tx, { type: 'submitted', affiliateId, auditId: audit.id, brandName: access.brandName });
      return publicProof(proof);
    });
  } catch (e) {
    // Nothing references the stored file: remove the orphan, keep everything else.
    try { await storage.remove(fileKey); } catch { /* cleanup never masks the error */ }
    if (e?.code === 'P2002') {
      const target = String(e.meta?.target || '');
      if (target.includes('fingerprint')) throw err('DUPLICATE_PROOF', 'Ce justificatif a déjà été utilisé.');
      throw err('PROOF_EXISTS', 'Une preuve de paiement a déjà été envoyée pour cette demande.');
    }
    const code = brandDbErrorCode(e);
    if (code === 'NOT_PENDING') throw err('NOT_PENDING', 'Cette demande n’attend plus de paiement.');
    if (code === 'CONSENT_UNVERIFIED') throw err('CONSENT_UNVERIFIED', 'Les conditions acceptées pour cette demande ne peuvent pas être vérifiées : le paiement est indisponible.');
    throw e;
  }
}

/** The participant's own proof (metadata only). @throws ACCESS_NOT_FOUND */
export async function getOwnPaymentProof(affiliateId, accessId, { db = prisma } = {}) {
  const access = await db.brandAccess.findUnique({ where: { id: String(accessId || '') }, include: { paymentProof: true } });
  if (!access || access.affiliateId !== affiliateId) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
  return access.paymentProof ? publicProof(access.paymentProof) : null;
}

/** Proof file of the participant's OWN request → {buffer, contentType}. @throws ACCESS_NOT_FOUND | PROOF_NOT_FOUND */
export async function readOwnProofFile(affiliateId, accessId, { db = prisma, storage = defaultProofStorage } = {}) {
  const access = await db.brandAccess.findUnique({ where: { id: String(accessId || '') }, include: { paymentProof: true } });
  if (!access || access.affiliateId !== affiliateId) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
  const file = access.paymentProof ? await storage.read(access.paymentProof.fileKey) : null;
  if (!file) throw err('PROOF_NOT_FOUND', 'Justificatif introuvable.');
  return file;
}

/** Proof file for the admin → {buffer, contentType}. @throws ACCESS_NOT_FOUND | PROOF_NOT_FOUND */
export async function readAdminProofFile(accessId, { db = prisma, storage = defaultProofStorage } = {}) {
  const proof = await db.brandPaymentProof.findUnique({ where: { accessId: String(accessId || '') } });
  if (!proof) {
    if (!(await db.brandAccess.findUnique({ where: { id: String(accessId || '') } }))) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
    throw err('PROOF_NOT_FOUND', 'Justificatif introuvable.');
  }
  const file = await storage.read(proof.fileKey);
  if (!file) throw err('PROOF_NOT_FOUND', 'Justificatif introuvable.');
  return file;
}

/**
 * Admin accepts the SUBMITTED proof → the access becomes ACTIVE (one
 * transaction). Exactly one of accept / owner cancel / reject wins.
 * @throws ACCESS_NOT_FOUND | PROOF_NOT_FOUND | NOT_PENDING | PROOF_NOT_SUBMITTED | CONSENT_UNVERIFIED
 */
export async function adminAcceptProof(accessId, { actorId = null, db = prisma, now = new Date() } = {}) {
  const at = new Date(now);
  const config = await getBrandConfig(db);
  try {
    return await acceptInTransaction(accessId, { actorId, db, at, config });
  } catch (e) {
    if (brandDbErrorCode(e) === 'CONSENT_UNVERIFIED') {
      throw err('CONSENT_UNVERIFIED', 'Les conditions acceptées pour cette demande ne peuvent pas être vérifiées : le paiement est indisponible.');
    }
    throw e;
  }
}

function acceptInTransaction(accessId, { actorId, db, at, config }) {
  return db.$transaction(async (tx) => {
    const row = await tx.brandAccess.findUnique({ where: { id: String(accessId || '') } });
    if (!row) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
    const proof = await tx.brandPaymentProof.findUnique({ where: { accessId: row.id } });
    if (!proof) throw err('PROOF_NOT_FOUND', 'Aucune preuve de paiement pour cette demande.');
    if (row.status !== ACCESS_STATUS.PENDING_PAYMENT) throw err('NOT_PENDING', 'Cette demande n’attend plus de paiement.');
    await assertOriginalConsent(tx, row); // acceptance + activation (the database checks it again)
    const reviewer = actorId ? String(actorId) : 'admin';
    const r = await tx.brandPaymentProof.updateMany({
      where: { id: proof.id, status: PROOF_STATUS.SUBMITTED },
      data: { status: PROOF_STATUS.ACCEPTED, reviewedBy: reviewer, reviewedAt: at },
    });
    if (r.count !== 1) throw err('PROOF_NOT_SUBMITTED', 'Cette preuve a déjà été traitée.');
    await writeBrandAudit(tx, {
      action: 'PAYMENT_PROOF_ACCEPTED', entityType: 'brand_payment_proof', entityId: proof.id, actorId,
      before: { status: PROOF_STATUS.SUBMITTED }, after: { status: PROOF_STATUS.ACCEPTED, accessId: row.id },
    });
    const audit = await activateAfterAcceptedProof(tx, row, { proof, actorId, at, config });
    await notifyBrand(tx, { type: 'accepted', affiliateId: row.affiliateId, auditId: audit.id, brandName: row.brandName });
    const fresh = await tx.brandAccess.findUnique({
      where: { id: row.id }, include: { affiliate: { select: { username: true, name: true } }, paymentProof: true },
    });
    return adminAccess(fresh, (await loadConsentInfo(tx, [fresh])).get(fresh.id));
  });
}
