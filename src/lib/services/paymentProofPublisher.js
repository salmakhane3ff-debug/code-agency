/**
 * src/lib/services/paymentProofPublisher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Payment Proofs publication tick — run ONLY by the dedicated PM2 worker
 * scripts/payment-proofs-publisher.mjs (never by a web request).
 *
 * Three independent layers prevent a duplicate publication:
 *   1. A session advisory lock (PAYMENT_PROOF_PUBLISHER_LOCK_KEY, distinct from
 *      every other engine): only one worker ticks at a time; no lock → no work.
 *   2. Per proof, ONE transaction: re-read, verify, then a conditional
 *      UPDATE … WHERE id AND status = 'SCHEDULED' AND scheduledAt <= now. A second
 *      worker, a retry or an admin edit racing it updates 0 rows and writes no event.
 *   3. Database guards: status/state CHECKs and the payment_proofs_guard trigger
 *      (a PUBLISHED proof can never change again).
 *
 * Verification before publication (internal to this feature only — no financial
 * system is consulted): both admin declarations present, display data still valid,
 * receipt file present. Otherwise the proof becomes FAILED (never visible) with a
 * reason; the admin may edit and reschedule it. publishedAt = the actual instant.
 * A restart or a late tick only delays publication; the 72 h window always starts
 * at the real publishedAt.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { defaultPaymentProofStorage } from '../paymentProofStorage.js';
import { PROOF_STATUS, PROOF_LIMITS, normalizeAlias } from '../paymentProofs.js';

export const PAYMENT_PROOF_PUBLISHER_LOCK_KEY = 0x50505046; // "PPPF" — distinct from UGCE/FKOE/DEMC/BSTI/BRSM
export const PAYMENT_PROOF_TICK_MS = 60_000;
export const PUBLISHER_ACTOR = 'worker:payment-proofs-publisher';

/** Why a due proof must not be published (null = publishable). */
async function failureReason(row, storage) {
  if (!row.privacyConfirmedAt || !row.privacyConfirmedBy) return 'PRIVACY_NOT_CONFIRMED';
  if (!row.authenticityConfirmedAt || !row.authenticityConfirmedBy) return 'AUTHENTICITY_NOT_CONFIRMED';
  if (normalizeAlias(row.displayName) !== row.displayName) return 'INVALID_DISPLAY_NAME';
  if (!Number.isInteger(row.displayAmountCents) || row.displayAmountCents <= 0 || row.displayAmountCents > PROOF_LIMITS.MAX_AMOUNT_CENTS) return 'INVALID_AMOUNT';
  const exists = await storage.exists(row.fileKey).catch(() => false);
  return exists ? null : 'RECEIPT_MISSING';
}

/** Publish (or fail) ONE due proof atomically. → 'published' | 'failed' | 'skipped' */
export async function publishOnePaymentProof(id, { db = prisma, storage = defaultPaymentProofStorage, now = new Date() } = {}) {
  return db.$transaction(async (tx) => {
    const row = await tx.paymentProof.findUnique({ where: { id } });
    if (!row || row.status !== PROOF_STATUS.SCHEDULED || new Date(row.scheduledAt).getTime() > now.getTime()) return 'skipped';
    const reason = await failureReason(row, storage);
    const res = await tx.paymentProof.updateMany({
      where: { id, status: PROOF_STATUS.SCHEDULED, scheduledAt: { lte: now } },
      data: reason
        ? { status: PROOF_STATUS.FAILED, failedAt: now, failureReason: reason, publishAttempts: { increment: 1 }, updatedBy: PUBLISHER_ACTOR }
        : { status: PROOF_STATUS.PUBLISHED, publishedAt: now, publishAttempts: { increment: 1 }, updatedBy: PUBLISHER_ACTOR },
    });
    if (res.count !== 1) return 'skipped';
    await tx.paymentProofEvent.create({
      data: { proofId: id, action: reason ? 'FAIL' : 'PUBLISH', actor: PUBLISHER_ACTOR, at: now, details: reason ? { reason } : { publishedAt: now.toISOString() } },
    });
    return reason ? 'failed' : 'published';
  });
}

/**
 * One worker tick. `lock` = createPgAdvisoryLock(...) adapter ({ acquire, release });
 * without the lock nothing is done. Bounded per tick; the next tick continues.
 */
export async function runPaymentProofPublishTick({ db = prisma, storage = defaultPaymentProofStorage, lock, now = () => new Date(), limit = PROOF_LIMITS.PUBLISH_BATCH_LIMIT } = {}) {
  const held = lock ? await lock.acquire().catch(() => false) : false; // a lock error = not acquired (fail closed)
  if (!held) return { ticked: false, skipped: 'lock_not_acquired', published: 0, failed: 0, raced: 0 };
  let published = 0, failed = 0, raced = 0, errors = 0;
  try {
    const at = now();
    const due = await db.paymentProof.findMany({
      where: { status: PROOF_STATUS.SCHEDULED, scheduledAt: { lte: at } },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true },
    });
    for (const { id } of due) {
      try {
        const r = await publishOnePaymentProof(id, { db, storage, now: now() });
        if (r === 'published') published++; else if (r === 'failed') failed++; else raced++;
      } catch {
        errors++; // the proof stays SCHEDULED; the next tick retries it (idempotent)
      }
    }
    return { ticked: true, due: due.length, published, failed, raced, errors, more: due.length === limit };
  } finally {
    await lock.release().catch(() => {});
  }
}
