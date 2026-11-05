/**
 * src/lib/services/affiliateActivationRecoveryService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ADMIN ACTIVATION RECOVERY (Phase 6, part 1). For an affiliate whose one-time activation
 * code was used before them (the bearer-code limitation of the recruiter hand-over).
 * (db injected, so tests run on an in-memory fake or an isolated local database.)
 *
 *   1. The affiliate reports it on a PUBLIC form (identifier = username or phone, a message,
 *      an optional contact phone). The answer is ALWAYS the same ({ ok: true }) whether or
 *      not the account exists, is eligible, or already has a pending request: no enumeration.
 *      A request is recorded only for an eligible account (inactive, created through the
 *      activation-code flow); one PENDING request per affiliate (partial unique index).
 *   2. An admin (withAdminAuth) lists and inspects requests: the affiliate, its recruiter, its
 *      code history (states only — never a code, selector or hash) and the audit trail.
 *   3. Approval (one transaction, the same per-affiliate advisory lock as the activation):
 *      the affiliate must still be INACTIVE → its password is replaced by an unusable random
 *      one (whoever redeemed the hijacked code is locked out), every active code is
 *      invalidated (ADMIN_RECOVERY), a fresh ADMIN code is issued and the request becomes
 *      APPROVED (conditional write: concurrent approvals → exactly one). The new code is
 *      returned ONCE to that admin, who hands it to the affiliate directly. Recruiters can
 *      never see it, and can no longer issue codes for this affiliate (an ADMIN code in the
 *      history blocks recruiter regeneration).
 *   4. The affiliate sets a password on the existing /affiliate/activate page. The account
 *      stays INACTIVE until the existing admin approval (identity rules unchanged).
 *
 * Every step is audited in recruiter_audit_log (no recruiterId: never shown to a recruiter):
 * ACTIVATION_RECOVERY_REQUESTED (SYSTEM / PUBLIC_FORM), _APPROVED / _REJECTED (ADMIN + note).
 * No code ever appears in a row (hash only), an audit detail, a log line or a GET response.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { issueActivationCode, unusablePasswordHash } from './affiliateActivationService.js';

export const RECOVERY_LIMITS = Object.freeze({ MESSAGE_MIN: 10, MESSAGE_MAX: 500, NOTE_MAX: 300, IDENTIFIER_MAX: 40, LIST_MAX: 200 });
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const isUnique = (e) => e?.code === 'P2002';

async function lockAffiliateCodes(tx, affiliateId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'affiliate-activation:' + affiliateId}))`;
}

/** Public input → { value } or { fields }. Format checks only (they reveal nothing about accounts). */
export function validateRecoveryRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['identifier', 'message', 'contactPhone'].includes(k))) {
    return { fields: { body: 'UNKNOWN_FIELD' } };
  }
  const fields = {};
  const identifier = typeof input.identifier === 'string' ? input.identifier.trim().toLowerCase() : '';
  if (identifier.length < 3 || identifier.length > RECOVERY_LIMITS.IDENTIFIER_MAX || !/^[a-z0-9._+-]+$/.test(identifier)) fields.identifier = 'INVALID_IDENTIFIER';
  const message = typeof input.message === 'string' ? input.message.replace(/\s+/g, ' ').trim() : '';
  if (message.length < RECOVERY_LIMITS.MESSAGE_MIN || message.length > RECOVERY_LIMITS.MESSAGE_MAX || /[<>]/.test(message)) fields.message = 'INVALID_MESSAGE';
  let contactPhone = null;
  if (input.contactPhone !== undefined && input.contactPhone !== null && !(typeof input.contactPhone === 'string' && input.contactPhone.trim() === '')) {
    contactPhone = typeof input.contactPhone === 'string' ? input.contactPhone.replace(/[\s.-]/g, '') : '';
    if (!PHONE_RE.test(contactPhone)) fields.contactPhone = 'INVALID_PHONE';
  }
  if (Object.keys(fields).length) return { fields };
  return { value: { identifier, message, contactPhone } };
}

/** The affiliate an identifier designates: exact username first, then phone. */
async function findByIdentifier(db, identifier) {
  const byUsername = await db.affiliate.findUnique({ where: { username: identifier }, select: { id: true, isActive: true } });
  if (byUsername) return byUsername;
  return db.affiliate.findFirst({ where: { phone: identifier }, select: { id: true, isActive: true } });
}

/**
 * Public: record a recovery request. ALWAYS → { ok: true } (unless the input format is
 * invalid): nothing tells whether the account exists, is eligible or already has a request.
 */
export async function requestActivationRecovery(input, { db = prisma, now = new Date(), requestIp = null } = {}) {
  const { value: v, fields } = validateRecoveryRequest(input);
  if (fields) throw fail('INVALID_INPUT', { fields });
  const ip = typeof requestIp === 'string' && requestIp && requestIp !== 'unknown' ? requestIp.slice(0, 64) : null;
  const affiliate = await findByIdentifier(db, v.identifier);
  // Eligible: an INACTIVE affiliate of the activation-code flow (at least one code issued).
  if (!affiliate || affiliate.isActive !== false) return { ok: true };
  const hasCode = await db.affiliateActivationCode.findFirst({ where: { affiliateId: affiliate.id }, select: { id: true } });
  if (!hasCode) return { ok: true };
  try {
    await db.$transaction(async (tx) => {
      const row = await tx.affiliateActivationRecovery.create({
        data: { affiliateId: affiliate.id, status: 'PENDING', message: v.message, contactPhone: v.contactPhone, requestIp: ip, requestedAt: now },
        select: { id: true },
      });
      await tx.recruiterAuditLog.create({
        data: {
          recruiterId: null, actorType: 'SYSTEM', actorId: 'PUBLIC_FORM', action: 'ACTIVATION_RECOVERY_REQUESTED', entityType: 'affiliate', entityId: affiliate.id,
          details: { recoveryId: row.id }, createdAt: now,
        },
      });
    });
  } catch (e) {
    if (!isUnique(e)) throw e; // a PENDING request already exists: same answer
  }
  return { ok: true };
}

const codeState = (c, now) => (c.usedAt ? 'USED' : c.invalidatedAt ? 'INVALIDATED' : new Date(c.expiresAt) <= now ? 'EXPIRED' : 'ACTIVE');
const RECOVERY_SELECT = {
  id: true, affiliateId: true, status: true, message: true, contactPhone: true, requestIp: true, requestedAt: true,
  reviewedBy: true, reviewedAt: true, reviewNote: true, activationCodeId: true,
};

/** Admin: recovery requests (PENDING first, then newest), with the affiliate summary. Never a code. */
export async function adminListRecoveries({ db = prisma, status = null } = {}) {
  const where = status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED' ? { status } : {};
  const rows = await db.affiliateActivationRecovery.findMany({ where, orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }], take: RECOVERY_LIMITS.LIST_MAX, select: RECOVERY_SELECT });
  const ids = [...new Set(rows.map((r) => r.affiliateId))];
  const [affs, links] = await Promise.all([
    ids.length ? db.affiliate.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, name: true, phone: true, isActive: true } }) : [],
    ids.length ? db.recruiterAffiliateLink.findMany({ where: { affiliateId: { in: ids } }, select: { affiliateId: true, recruiter: { select: { username: true } } } }) : [],
  ]);
  const aff = new Map(affs.map((a) => [a.id, a]));
  const rec = new Map(links.map((l) => [l.affiliateId, l.recruiter?.username ?? null]));
  const order = { PENDING: 0, APPROVED: 1, REJECTED: 2 };
  return rows
    .map((r) => ({ ...r, affiliate: aff.get(r.affiliateId) ?? null, recruiterUsername: rec.get(r.affiliateId) ?? null }))
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
}

/** Admin: one request with the affiliate, its recruiter, code history (states only) and audit trail. */
export async function adminGetRecovery(id, { db = prisma, now = new Date() } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const r = await db.affiliateActivationRecovery.findUnique({ where: { id }, select: RECOVERY_SELECT });
  if (!r) throw fail('NOT_FOUND');
  const [affiliate, link, identity, codes, others, audit] = await Promise.all([
    db.affiliate.findUnique({ where: { id: r.affiliateId }, select: { id: true, username: true, name: true, phone: true, isActive: true, createdAt: true } }),
    db.recruiterAffiliateLink.findUnique({ where: { affiliateId: r.affiliateId }, select: { createdAt: true, recruiter: { select: { id: true, username: true, name: true } } } }),
    db.identityVerification.findUnique({ where: { affiliateId: r.affiliateId }, select: { status: true } }),
    db.affiliateActivationCode.findMany({
      where: { affiliateId: r.affiliateId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true, createdAt: true, createdByType: true, createdById: true, expiresAt: true, usedAt: true, invalidatedAt: true, invalidatedReason: true, failedAttempts: true },
    }),
    db.affiliateActivationRecovery.findMany({ where: { affiliateId: r.affiliateId }, orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }], select: { id: true, status: true, requestedAt: true, reviewedAt: true, reviewedBy: true } }),
    db.recruiterAuditLog.findMany({
      where: { entityType: 'affiliate', entityId: r.affiliateId }, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], take: 100,
      select: { action: true, actorType: true, actorId: true, createdAt: true },
    }),
  ]);
  return {
    request: r,
    affiliate: affiliate ?? null,
    recruiter: link?.recruiter ? { id: link.recruiter.id, username: link.recruiter.username, name: link.recruiter.name, linkedAt: link.createdAt } : null,
    identityStatus: identity?.status ?? 'NONE',
    codes: codes.map((c) => ({ ...c, state: codeState(c, now) })),
    otherRequests: others.filter((o) => o.id !== r.id),
    audit,
  };
}

/**
 * Admin: approve a PENDING request → { code, expiresAt } returned ONCE (never stored in clear).
 * Errors: NOT_FOUND, ALREADY_REVIEWED (not pending / concurrent approval), AFFILIATE_ACTIVE
 * (an active account is never reset through this workflow), NOT_ELIGIBLE (no code flow).
 */
export async function adminApproveRecovery(id, { db = prisma, actorId, note = null, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const cleanNote = typeof note === 'string' && note.trim() ? note.replace(/\s+/g, ' ').trim().slice(0, RECOVERY_LIMITS.NOTE_MAX) : null;
  const first = await db.affiliateActivationRecovery.findUnique({ where: { id }, select: { affiliateId: true } });
  if (!first) throw fail('NOT_FOUND');
  const newHash = await unusablePasswordHash(); // slow: outside the transaction
  return db.$transaction(async (tx) => {
    await lockAffiliateCodes(tx, first.affiliateId);
    const r = await tx.affiliateActivationRecovery.findUnique({ where: { id }, select: { id: true, affiliateId: true, status: true } });
    if (!r) throw fail('NOT_FOUND');
    if (r.status !== 'PENDING') throw fail('ALREADY_REVIEWED');
    const affiliate = await tx.affiliate.findUnique({ where: { id: r.affiliateId }, select: { id: true, isActive: true } });
    if (!affiliate) throw fail('NOT_FOUND');
    if (affiliate.isActive !== false) throw fail('AFFILIATE_ACTIVE');
    const anyCode = await tx.affiliateActivationCode.findFirst({ where: { affiliateId: r.affiliateId }, select: { id: true } });
    if (!anyCode) throw fail('NOT_ELIGIBLE');
    // 1. Old credentials invalidated: an unusable password, and no active code left.
    await tx.affiliate.update({ where: { id: r.affiliateId }, data: { password: newHash, tokenVersion: { increment: 1 } }, select: { id: true } });
    await tx.affiliateActivationCode.updateMany({
      where: { affiliateId: r.affiliateId, usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now, invalidatedReason: 'ADMIN_RECOVERY' },
    });
    // 2. A fresh ADMIN code bound to the new password.
    const issued = await issueActivationCode(tx, { affiliateId: r.affiliateId, passwordHash: newHash, createdByType: 'ADMIN', createdById: actorId, now });
    // 3. The request is reviewed exactly once.
    const done = await tx.affiliateActivationRecovery.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'APPROVED', reviewedBy: actorId, reviewedAt: now, reviewNote: cleanNote, activationCodeId: issued.id },
    });
    if (done.count !== 1) throw fail('ALREADY_REVIEWED');
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId: null, actorType: 'ADMIN', actorId, action: 'ACTIVATION_RECOVERY_APPROVED', entityType: 'affiliate', entityId: r.affiliateId,
        details: { recoveryId: id, activationCodeId: issued.id, note: cleanNote }, createdAt: now,
      },
    });
    return { code: issued.code, expiresAt: issued.expiresAt };
  });
}

/** Admin: reject a PENDING request (nothing else changes). */
export async function adminRejectRecovery(id, { db = prisma, actorId, note = null, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const cleanNote = typeof note === 'string' && note.trim() ? note.replace(/\s+/g, ' ').trim().slice(0, RECOVERY_LIMITS.NOTE_MAX) : null;
  return db.$transaction(async (tx) => {
    const r = await tx.affiliateActivationRecovery.findUnique({ where: { id }, select: { id: true, affiliateId: true, status: true } });
    if (!r) throw fail('NOT_FOUND');
    const done = await tx.affiliateActivationRecovery.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REJECTED', reviewedBy: actorId, reviewedAt: now, reviewNote: cleanNote } });
    if (done.count !== 1) throw fail('ALREADY_REVIEWED');
    await tx.recruiterAuditLog.create({
      data: { recruiterId: null, actorType: 'ADMIN', actorId, action: 'ACTIVATION_RECOVERY_REJECTED', entityType: 'affiliate', entityId: r.affiliateId, details: { recoveryId: id, note: cleanNote }, createdAt: now },
    });
    return { id, status: 'REJECTED' };
  });
}
