/**
 * src/lib/services/depositService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate balance top-up ("💰 Dépôt de solde") business logic.
 * (Formerly the "Dépôt de garantie" security deposit — converted to a normal
 * balance recharge by explicit product decision on 2026-08-01. Table/model
 * names are kept for a non-destructive migration.)
 *
 * ACCOUNTING: the approved total is DERIVED from the SUM of APPROVED rows
 * (never a stored, mutable field), using the SAME Decimal money helpers as the
 * rest of the balance. It now feeds "Solde disponible" through the
 * `deposit_topup` balance provider (affiliateSystemService) — an admin-approved
 * deposit credits the available balance; PENDING/REJECTED rows never count.
 * There is NO second wallet anywhere.
 *
 * IDEMPOTENT REVIEW: approve/reject use a conditional `updateMany` gated on
 * status = 'PENDING'. Only one call can ever match (count === 1); double-clicks,
 * retries and concurrent admins get count 0 → no double credit. Because the
 * balance is derived from status, the single atomic status flip IS the credit.
 *
 * All DB + storage access is injectable for unit tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { toDecimal, serializeAmount } from '../balance/composeBalance.js';
import { isRechargeEnabled, isRechargeEnabledForDisplay } from './rechargeFeatureService.js';
import {
  validateDepositUpload, processAndStoreDeposit, readDepositByKey, deleteDepositByKey,
} from '../depositStorage.js';

export const DEPOSIT_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' };
const MAX_DEPOSIT_AMOUNT = 10_000_000;

// The deposit amount is FIXED by the admin (stored in the team-bonus-config
// settings row). It is read server-side on every submission — the client can
// display it but can NEVER set or manipulate it.
export const DEFAULT_DEPOSIT_AMOUNT = 500;

export async function getConfiguredDepositAmount(db = prisma) {
  try {
    const row = await db.setting.findUnique({ where: { id: 'team-bonus-config' } });
    const v = Number(row?.data?.securityDepositAmount);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DEPOSIT_AMOUNT;
  } catch {
    return DEFAULT_DEPOSIT_AMOUNT;
  }
}

function sumAmounts(rows) {
  let sum = toDecimal(0);
  for (const r of rows) sum = sum.plus(toDecimal(r.amount || 0));
  return serializeAmount(sum);
}

/** Approved top-up total (derived; credited to Solde disponible via the deposit_topup provider). */
export async function getDepositBalance(affiliateId, db = prisma) {
  const rows = await db.affiliateSecurityDeposit.findMany({ where: { affiliateId, status: 'APPROVED' }, select: { amount: true } });
  return sumAmounts(rows);
}

/** Total amount currently awaiting validation (informational only). */
export async function getPendingDepositTotal(affiliateId, db = prisma) {
  const rows = await db.affiliateSecurityDeposit.findMany({ where: { affiliateId, status: 'PENDING' }, select: { amount: true } });
  return sumAmounts(rows);
}

/**
 * Combined summary for the affiliate dashboard/page. `rechargeEnabled` = the admin switch
 * "Recharge de solde des Affiliés" (display only — submitDeposit enforces it); the balances are
 * returned unchanged whatever the switch says.
 */
export async function getDepositSummary(affiliateId, db = prisma) {
  const [approved, pending, rechargeEnabled] = await Promise.all([
    getDepositBalance(affiliateId, db),
    getPendingDepositTotal(affiliateId, db),
    isRechargeEnabledForDisplay(db),
  ]);
  return { approvedBalance: approved, pendingTotal: pending, rechargeEnabled };
}

const rechargeDisabled = () => Object.assign(new Error('La recharge de solde est désactivée pour le moment.'), { code: 'DEPOSIT_DISABLED' });

/** Throws DEPOSIT_DISABLED while the admin switch is OFF — the route calls it first, before reading the upload. */
export async function ensureRechargeEnabled(db = prisma) {
  if (!(await isRechargeEnabled(db))) throw rechargeDisabled();
}

/** This affiliate's deposit requests — NO storage keys ever (only `hasProof`). */
export async function getAffiliateDeposits(affiliateId, db = prisma) {
  const rows = await db.affiliateSecurityDeposit.findMany({ where: { affiliateId }, orderBy: { createdAt: 'desc' } });
  return rows.map(mapAffiliateDeposit);
}

function mapAffiliateDeposit(r) {
  return {
    id:                r.id,
    amount:            Number(r.amount), // Decimal → plain number for JSON/UI

    paymentMethod:     r.paymentMethod,
    transferReference: r.transferReference || null,
    affiliateNote:     r.affiliateNote || null,
    status:            r.status,
    rejectionReason:   r.status === 'REJECTED' ? (r.rejectionReason || null) : null,
    hasProof:          Boolean(r.proofFile),
    createdAt:         r.createdAt,
    reviewedAt:        r.reviewedAt,
  };
}

/**
 * Create a PENDING deposit request. Does NOT change any balance.
 * @param {{amount, paymentMethod, transferReference?, affiliateNote?, proof:{buffer,mime,size}}} input
 */
export async function submitDeposit(affiliateId, input, db = prisma, storage = { process: processAndStoreDeposit, remove: deleteDepositByKey }) {
  // Admin switch "Recharge de solde des Affiliés": OFF → no NEW request (nothing stored).
  if (!(await isRechargeEnabled(db))) throw rechargeDisabled();
  // Only ONE open request at a time. Fast pre-check for a clean error in the
  // common case; the DB PARTIAL UNIQUE INDEX (one PENDING per affiliate) is the
  // real concurrency guard — two simultaneous submits can never both insert.
  const existingPending = await db.affiliateSecurityDeposit.findFirst({
    where: { affiliateId, status: 'PENDING' }, select: { id: true },
  });
  if (existingPending) {
    throw Object.assign(new Error('Vous avez déjà une demande en attente de validation.'), { code: 'DEPOSIT_PENDING_EXISTS' });
  }

  // SERVER-AUTHORITATIVE amount — read the admin-configured value; NEVER trust
  // any amount sent by the client (prevents amount manipulation).
  const amount = await getConfiguredDepositAmount(db);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DEPOSIT_AMOUNT) {
    throw Object.assign(new Error('Montant invalide.'), { code: 'DEPOSIT_INVALID_AMOUNT' });
  }
  const paymentMethod = String(input?.paymentMethod || '').trim();
  if (!paymentMethod) throw Object.assign(new Error('Méthode de paiement requise.'), { code: 'DEPOSIT_NO_METHOD' });

  const proof = input?.proof;
  if (!proof) throw Object.assign(new Error('La preuve du virement est requise.'), { code: 'DEPOSIT_NO_PROOF' });
  const perr = validateDepositUpload({ mime: proof.mime, size: proof.size });
  if (perr.length) throw Object.assign(new Error('Fichier invalide (JPG/PNG/WEBP/PDF, max 8 Mo).'), { code: 'DEPOSIT_INVALID_FILE', details: perr });

  const proofFile = await storage.process(proof.buffer); // re-encodes/validates + stores privately (new file per request)

  // Re-checked right before the insert: a request racing the admin switching it OFF is not created.
  if (!(await isRechargeEnabled(db).catch(() => false))) {
    await storage.remove?.(proofFile).catch(() => {});
    throw rechargeDisabled();
  }

  try {
    const row = await db.affiliateSecurityDeposit.create({
      data: {
        affiliateId,
        // Store as a 2-dp string → Prisma writes it to DECIMAL exactly (never Float).
        amount: amount.toFixed(2),
        paymentMethod,
        transferReference: String(input?.transferReference || '').trim() || null,
        affiliateNote:     String(input?.affiliateNote || '').trim() || null,
        proofFile,
        status: 'PENDING',
      },
    });
    return mapAffiliateDeposit(row);
  } catch (err) {
    // Lost a concurrent race → the partial unique index rejected the 2nd insert.
    // Clean up the just-stored (orphan) proof and surface the pending message.
    if (err?.code === 'P2002') {
      await storage.remove?.(proofFile).catch(() => {});
      throw Object.assign(new Error('Vous avez déjà une demande en attente de validation.'), { code: 'DEPOSIT_PENDING_EXISTS' });
    }
    throw err;
  }
}

/** Affiliate proof access — ONLY their own request. Returns null otherwise. */
export async function getDepositProofForAffiliate(affiliateId, id, db = prisma) {
  const row = await db.affiliateSecurityDeposit.findUnique({ where: { id } });
  if (!row || row.affiliateId !== affiliateId || !row.proofFile) return null;
  return readDepositByKey(row.proofFile);
}

// ── Admin ────────────────────────────────────────────────────────────────────

export async function adminListDeposits(status, db = prisma) {
  const where = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? { status } : {};
  const rows = await db.affiliateSecurityDeposit.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { affiliate: { select: { id: true, name: true, username: true, phone: true } } },
  });
  return rows.map((r) => ({
    id:                r.id,
    affiliateId:       r.affiliateId,
    affiliateName:     r.affiliate?.name || null,
    username:          r.affiliate?.username || null,
    phone:             r.affiliate?.phone || null,
    amount:            Number(r.amount), // Decimal → plain number for JSON/UI
    paymentMethod:     r.paymentMethod,
    transferReference: r.transferReference || null,
    affiliateNote:     r.affiliateNote || null,
    status:            r.status,
    rejectionReason:   r.rejectionReason || null,
    reviewedByAdminId: r.reviewedByAdminId || null,
    reviewedAt:        r.reviewedAt,
    createdAt:         r.createdAt,
    hasProof:          Boolean(r.proofFile),
  }));
}

/**
 * Approve a PENDING deposit — idempotent. The amount is read from the DB (never
 * from the client). Returns { ok, credited }. credited === false means it was
 * already reviewed (no double credit).
 */
export async function adminApproveDeposit(id, adminId = null, db = prisma) {
  const row = await db.affiliateSecurityDeposit.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.status !== 'PENDING') return { ok: true, credited: false, status: row.status };

  // Atomic, idempotent transition: only ONE caller can flip PENDING → APPROVED.
  const res = await db.affiliateSecurityDeposit.updateMany({
    where: { id, status: 'PENDING' },
    data:  { status: 'APPROVED', reviewedAt: new Date(), reviewedByAdminId: adminId, rejectionReason: null },
  });
  if (res.count !== 1) return { ok: true, credited: false }; // lost the race — already handled

  // Notification (amount from DB). Non-fatal — never rolls back the approval.
  await db.affiliateNotification.create({
    data: { affiliateId: row.affiliateId, message: `Votre dépôt de solde de ${Number(row.amount).toFixed(0)} MAD a été approuvé et ajouté à votre solde disponible.` },
  }).catch(() => {});

  return { ok: true, credited: true };
}

/** Reject a PENDING deposit — idempotent, requires a reason, changes no balance. */
export async function adminRejectDeposit(id, reason, adminId = null, db = prisma) {
  const clean = String(reason || '').trim();
  if (!clean) throw Object.assign(new Error('Le motif de refus est requis.'), { code: 'REJECTION_REASON_REQUIRED' });

  const row = await db.affiliateSecurityDeposit.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.status !== 'PENDING') return { ok: true, changed: false, status: row.status };

  const res = await db.affiliateSecurityDeposit.updateMany({
    where: { id, status: 'PENDING' },
    data:  { status: 'REJECTED', rejectionReason: clean, reviewedAt: new Date(), reviewedByAdminId: adminId },
  });
  if (res.count !== 1) return { ok: true, changed: false };

  await db.affiliateNotification.create({
    data: { affiliateId: row.affiliateId, message: `Votre dépôt de solde a été refusé.\nRaison :\n${clean}` },
  }).catch(() => {});

  return { ok: true, changed: true };
}

/** Admin proof access — any request. Returns null if missing. */
export async function getDepositProofForAdmin(id, db = prisma) {
  const row = await db.affiliateSecurityDeposit.findUnique({ where: { id } });
  if (!row || !row.proofFile) return null;
  return readDepositByKey(row.proofFile);
}
