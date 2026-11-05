/**
 * src/lib/services/recruiterIdentityService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System, Phase 6 part 3c — the RECRUITER's identity verification (CIN).
 * (db + storage injected, so tests run on an in-memory fake or an isolated local database.)
 *
 * Separate from the affiliate KYC (identityService.js / identity_verifications — untouched).
 * Only the owner-agnostic private CIN storage is reused (identityStorage.js: sharp re-encode to
 * JPEG, metadata dropped, <uuid>.jpg keys in the private directory).
 *
 * State machine (also enforced by the DB guard, migration 20261111):
 *   NOT_SUBMITTED (no row) → PENDING            first upload (submission 1)
 *   PENDING  → APPROVED | REJECTED              admin decision on THAT submission
 *   APPROVED → REJECTED                         admin revocation
 *   REJECTED → PENDING                          a NEW upload only (submission + 1)
 * A REJECTED submission can never be approved directly; an admin decision names the status and
 * the submission it saw, so an outdated decision never overwrites a newer state (STALE_DECISION).
 *
 * Money (D1/D2/D4): only APPROVED lets a recruiter request a withdrawal, and only APPROVED at
 * PAYMENT time lets an admin pay one (recruiterWalletService.js). An admin decision takes the
 * per-recruiter money lock (lockRecruiterMoney) so it is strictly serialised with payments.
 * Lock order: decision = money lock → KYC row; payment = recruiter row → money lock (KYC read
 * only); request = recruiter row (KYC read only); upload = KYC row only. No cycle.
 * Recruiter rewards never read this table (rejection never stops reward accrual).
 *
 * Files (D3): new files are written first; superseded files are deleted only AFTER the database
 * transaction committed; a failed transaction deletes the new files instead. File keys, images
 * and reviewer identities never reach a recruiter, and never enter an audit row.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { CIN_MAX_BYTES, deleteCinByKey, isAcceptedCinType, processAndStoreCin, readCinByKey } from '../identityStorage.js';
import { sniffKind } from '../depositStorage.js';
import { lockRecruiterMoney } from './recruiterRewardService.js';

export const RECRUITER_IDENTITY_STATUS = Object.freeze({
  NOT_SUBMITTED: 'NOT_SUBMITTED', PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED',
});
export const RECRUITER_IDENTITY_LIMITS = Object.freeze({ FILE_MAX_BYTES: CIN_MAX_BYTES, REASON_MAX: 500, ADMIN_LIST: 500, HISTORY: 50 });
/** Audit actions of the recruiter KYC (append-only recruiter_audit_log). */
export const RECRUITER_IDENTITY_AUDIT_ACTIONS = Object.freeze([
  'RECRUITER_IDENTITY_SUBMITTED', 'RECRUITER_IDENTITY_APPROVED', 'RECRUITER_IDENTITY_REJECTED',
]);

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const isUnique = (e) => e?.code === 'P2002';
// Declared MIME → the signature it must carry (image/jpg is a common alias of image/jpeg).
const KIND_OF_MIME = Object.freeze({ 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' });

/** Current KYC status of a recruiter (APPROVED / PENDING / REJECTED / NOT_SUBMITTED). */
export async function recruiterIdentityStatus(recruiterId, { db = prisma } = {}) {
  const row = await db.recruiterIdentityVerification.findUnique({ where: { recruiterId }, select: { status: true } });
  return row?.status ?? RECRUITER_IDENTITY_STATUS.NOT_SUBMITTED;
}

/** The recruiter's OWN KYC state (no file key, no reviewer) — shaped by toRecruiterIdentityView. */
export async function getRecruiterIdentity(recruiterId, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const row = await db.recruiterIdentityVerification.findUnique({
    where: { recruiterId }, select: { status: true, rejectionReason: true, submittedAt: true, reviewedAt: true },
  });
  return row ?? { status: RECRUITER_IDENTITY_STATUS.NOT_SUBMITTED };
}

/**
 * Validate one uploaded CIN side { buffer, mime }: present, ≤ 5 MB, an accepted declared type
 * AND a matching real signature (jpeg / png / webp magic bytes) — the declared MIME alone is
 * never trusted. → null | 'FILE_REQUIRED' | 'FILE_TOO_LARGE' | 'INVALID_FILE'
 */
export function checkCinFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) return 'FILE_REQUIRED';
  if (file.buffer.length > CIN_MAX_BYTES) return 'FILE_TOO_LARGE';
  const mime = typeof file.mime === 'string' ? file.mime.toLowerCase() : '';
  if (!isAcceptedCinType(mime)) return 'INVALID_FILE';
  const kind = sniffKind(file.buffer);
  if (!kind || kind !== KIND_OF_MIME[mime]) return 'INVALID_FILE';
  return null;
}

/**
 * Recruiter: submit (or, after a rejection, resubmit) the CIN front + back.
 * Allowed from NOT_SUBMITTED or REJECTED only (IDENTITY_SUBMISSION_NOT_ALLOWED otherwise).
 * New files are stored first; the row changes in one transaction (conditional: a concurrent
 * admin decision or a second upload makes it fail cleanly); superseded files are deleted only
 * after the commit, the new ones if the transaction failed.
 * → { status: 'PENDING', submission, submittedAt }
 */
export async function submitRecruiterIdentity(recruiterId, files, {
  db = prisma, now = new Date(), storage = { store: processAndStoreCin, remove: deleteCinByKey },
} = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const fields = {};
  const front = checkCinFile(files?.front);
  const back = checkCinFile(files?.back);
  if (front) fields.front = front;
  if (back) fields.back = back;
  if (Object.keys(fields).length) throw fail('INVALID_INPUT', { fields });

  // Early refusal before any file is written (re-checked atomically below).
  const before = await db.recruiterIdentityVerification.findUnique({ where: { recruiterId }, select: { status: true } });
  if (before && before.status !== RECRUITER_IDENTITY_STATUS.REJECTED) throw fail('IDENTITY_SUBMISSION_NOT_ALLOWED');

  // 1. New files first (sharp re-encode: a non-image fails here with CIN_INVALID_IMAGE).
  const written = [];
  try {
    written.push(await storage.store(files.front.buffer));
    written.push(await storage.store(files.back.buffer));
  } catch (e) {
    for (const k of written) await storage.remove(k);
    if (e?.code === 'CIN_INVALID_IMAGE') throw fail('INVALID_INPUT', { fields: { [written.length === 0 ? 'front' : 'back']: 'INVALID_FILE' } });
    throw e;
  }
  const [frontKey, backKey] = written;

  // 2. The row, atomically (conditional on the state read inside the transaction).
  let superseded = [];
  let result;
  try {
    result = await db.$transaction(async (tx) => {
      const row = await tx.recruiterIdentityVerification.findUnique({
        where: { recruiterId }, select: { id: true, status: true, submission: true, cinFrontFile: true, cinBackFile: true },
      });
      let submission;
      let from;
      if (!row) {
        submission = 1;
        from = RECRUITER_IDENTITY_STATUS.NOT_SUBMITTED;
        try {
          await tx.recruiterIdentityVerification.create({
            data: { recruiterId, status: 'PENDING', submission, cinFrontFile: frontKey, cinBackFile: backKey, submittedAt: now, createdAt: now },
          });
        } catch (e) {
          if (isUnique(e)) throw fail('IDENTITY_SUBMISSION_NOT_ALLOWED'); // a concurrent first upload won
          throw e;
        }
      } else {
        if (row.status !== RECRUITER_IDENTITY_STATUS.REJECTED) throw fail('IDENTITY_SUBMISSION_NOT_ALLOWED');
        submission = row.submission + 1;
        from = row.status;
        const res = await tx.recruiterIdentityVerification.updateMany({
          where: { id: row.id, recruiterId, status: 'REJECTED', submission: row.submission },
          data: {
            status: 'PENDING', submission, cinFrontFile: frontKey, cinBackFile: backKey, submittedAt: now,
            rejectionReason: null, reviewedBy: null, reviewedAt: null, approvedAt: null,
          },
        });
        if (res.count !== 1) throw fail('IDENTITY_SUBMISSION_NOT_ALLOWED'); // changed meanwhile
        superseded = [row.cinFrontFile, row.cinBackFile];
      }
      await tx.recruiterAuditLog.create({
        data: {
          recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'RECRUITER_IDENTITY_SUBMITTED',
          entityType: 'recruiter_identity', entityId: recruiterId, details: { submission, from, to: 'PENDING' }, createdAt: now,
        },
      });
      return { status: 'PENDING', submission, submittedAt: now };
    });
  } catch (e) {
    // The transaction did not commit: the new files are not referenced — remove them.
    await storage.remove(frontKey);
    await storage.remove(backKey);
    throw e;
  }
  // 3. Committed: the superseded (rejected) files are no longer referenced — delete them.
  for (const k of superseded) await storage.remove(k);
  return result;
}

// ── Admin ────────────────────────────────────────────────────────────────────

const historyView = (a) => ({
  action: a.action, actorType: a.actorType, createdAt: a.createdAt,
  submission: Number.isInteger(a.details?.submission) ? a.details.submission : null,
  from: typeof a.details?.from === 'string' ? a.details.from : null,
  to: typeof a.details?.to === 'string' ? a.details.to : null,
  reason: typeof a.details?.reason === 'string' ? a.details.reason : null,
  actor: a.actorType === 'ADMIN' ? a.actorId : null,
});

/**
 * Admin: the recruiter KYC queue (newest submission first), with each row's KYC history from the
 * audit log. Metadata only — never a file key (images go through the private image route).
 */
export async function adminListRecruiterIdentities({ db = prisma, take = RECRUITER_IDENTITY_LIMITS.ADMIN_LIST } = {}) {
  const rows = await db.recruiterIdentityVerification.findMany({
    orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }], take,
    select: {
      id: true, recruiterId: true, status: true, submission: true, rejectionReason: true, submittedAt: true,
      reviewedBy: true, reviewedAt: true, approvedAt: true,
      recruiter: { select: { username: true, name: true, isActive: true } },
    },
  });
  const ids = rows.map((r) => r.recruiterId);
  const audits = ids.length ? await db.recruiterAuditLog.findMany({
    where: { recruiterId: { in: ids }, action: { in: [...RECRUITER_IDENTITY_AUDIT_ACTIONS] } },
    orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
    select: { recruiterId: true, action: true, actorType: true, actorId: true, details: true, createdAt: true },
  }) : [];
  const byRecruiter = new Map();
  for (const a of audits) {
    const list = byRecruiter.get(a.recruiterId) ?? [];
    if (list.length < RECRUITER_IDENTITY_LIMITS.HISTORY) list.push(historyView(a));
    byRecruiter.set(a.recruiterId, list);
  }
  return rows.map((r) => ({
    id: r.id, recruiterId: r.recruiterId, status: r.status, submission: r.submission,
    rejectionReason: r.rejectionReason ?? null, submittedAt: r.submittedAt, reviewedBy: r.reviewedBy ?? null,
    reviewedAt: r.reviewedAt ?? null, approvedAt: r.approvedAt ?? null,
    recruiterUsername: r.recruiter?.username ?? null, recruiterName: r.recruiter?.name ?? null, recruiterActive: r.recruiter?.isActive === true,
    history: byRecruiter.get(r.recruiterId) ?? [],
  }));
}

/**
 * Admin decision { action: 'approve' | 'reject', expectedStatus, submission, reason }:
 *   approve — only PENDING (never REJECTED: a new upload is needed);
 *   reject  — PENDING, or APPROVED (revocation); a reason of 1–500 characters is required.
 * The decision applies only if the row is still exactly in `expectedStatus` with `submission`
 * (STALE_DECISION otherwise). Serialised with payments by the per-recruiter money lock; audited.
 */
export async function adminDecideRecruiterIdentity(id, input, { db = prisma, actorId, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId.trim()) throw fail('UNAUTHORIZED');
  const reviewer = actorId.trim().slice(0, 200);
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const action = input?.action;
  const expectedStatus = input?.expectedStatus;
  const submission = input?.submission;
  const reason = typeof input?.reason === 'string' ? input.reason.replace(/\s+/g, ' ').trim() : '';
  if (!['approve', 'reject'].includes(action) || !Number.isInteger(submission) || submission < 1
    || !['PENDING', 'APPROVED', 'REJECTED'].includes(expectedStatus)) throw fail('INVALID_INPUT');
  // No decision from REJECTED (a new upload is needed); approve only from PENDING.
  if (expectedStatus === 'REJECTED' || (action === 'approve' && expectedStatus !== 'PENDING')) throw fail('INVALID_STATE');
  if (action === 'reject' && (reason.length < 1 || reason.length > RECRUITER_IDENTITY_LIMITS.REASON_MAX)) {
    throw fail('INVALID_INPUT', { errors: { reason: 'REASON_REQUIRED' } });
  }
  return db.$transaction(async (tx) => {
    const row = await tx.recruiterIdentityVerification.findUnique({ where: { id }, select: { id: true, recruiterId: true } });
    if (!row) throw fail('NOT_FOUND');
    // Serialised with withdrawal payments of this recruiter (same lock, same order: money → KYC row).
    await lockRecruiterMoney(tx, row.recruiterId);
    const to = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const data = action === 'approve'
      ? { status: to, reviewedBy: reviewer, reviewedAt: now, approvedAt: now, rejectionReason: null }
      : { status: to, reviewedBy: reviewer, reviewedAt: now, approvedAt: null, rejectionReason: reason };
    const res = await tx.recruiterIdentityVerification.updateMany({ where: { id, recruiterId: row.recruiterId, status: expectedStatus, submission }, data });
    if (res.count !== 1) throw fail('STALE_DECISION');
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId: row.recruiterId, actorType: 'ADMIN', actorId: reviewer,
        action: action === 'approve' ? 'RECRUITER_IDENTITY_APPROVED' : 'RECRUITER_IDENTITY_REJECTED',
        entityType: 'recruiter_identity', entityId: row.recruiterId,
        details: { submission, from: expectedStatus, to, ...(action === 'reject' ? { reason } : {}) }, createdAt: now,
      },
    });
    return { id, recruiterId: row.recruiterId, status: to, submission };
  });
}

/** Admin: one CIN side as a JPEG buffer (the key never leaves the server), or null. */
export async function adminRecruiterCinFile(id, side, { db = prisma, read = readCinByKey } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id) || (side !== 'front' && side !== 'back')) return null;
  const row = await db.recruiterIdentityVerification.findUnique({ where: { id }, select: { cinFrontFile: true, cinBackFile: true } });
  const key = side === 'front' ? row?.cinFrontFile : row?.cinBackFile;
  return key ? read(key) : null;
}
