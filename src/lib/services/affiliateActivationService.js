/**
 * src/lib/services/affiliateActivationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time ACTIVATION CODES for affiliates created by a recruiter (Phase 6, part 1).
 * (db injected, so tests run on an in-memory fake or an isolated local database.)
 *
 * Goal: the recruiter never chooses nor learns the affiliate's permanent password. The
 * affiliate is created with an unusable random password; the recruiter receives a code ONCE
 * and shares it manually; the affiliate redeems it on /affiliate/activate with a password of
 * their own choice.
 *
 *   • Code = "<selector>.<verifier>": selector = 12 random bytes (16 base64url chars, a
 *     non-secret lookup key), verifier = 32 random bytes (256 bits, 43 base64url chars).
 *     Stored: selector + SHA-256(verifier) only — never the code, in no row, log or audit.
 *   • 24 h, single use, 5 failed attempts then invalid, one active code per affiliate,
 *     a new code invalidates the previous one.
 *   • passwordFingerprint = SHA-256 of the affiliate's password hash when the code was
 *     issued. A code is STALE as soon as the password changed by any other way (admin, or the
 *     affiliate after activation), and no new code can be issued once credentials exist —
 *     so a recruiter can never reset an affiliate's password through this flow.
 *   • Redemption and regeneration of an affiliate are serialised by an advisory lock and the
 *     single-use flag is a conditional write: concurrent redemptions → exactly one success.
 *   • Redeeming a code NEVER activates the account (isActive is not touched): the existing
 *     admin approval stays the only activation, with the existing identity rules.
 *
 * LIMITATION (by design, documented): the code is a BEARER secret seen by the recruiter.
 * A malicious recruiter could redeem it before handing it over. This flow prevents the
 * recruiter from CHOOSING or LEARNING the password the affiliate sets, but it cannot prove
 * that the intended person redeemed the code first.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import prisma from '../prisma.js';
import { hashPassword } from './authService.js';

export const ACTIVATION_LIMITS = Object.freeze({
  TTL_MS: 24 * 3600 * 1000, MAX_ATTEMPTS: 5, PASSWORD_MIN: 8, PASSWORD_MAX: 128, LIST_MAX: 50,
});
const CODE_RE = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/** SHA-256 of a stored password hash (never the hash itself in the code table). */
export const passwordFingerprint = (passwordHash) => sha256(passwordHash ?? '');

/** A fresh code: { code, selector, verifierHash }. */
export function generateActivationCode() {
  const selector = randomBytes(12).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  return { code: `${selector}.${verifier}`, selector, verifierHash: sha256(verifier) };
}

/** An unusable random password hash for a new affiliate (nobody knows its plaintext). */
export async function unusablePasswordHash() {
  return hashPassword(randomBytes(32).toString('base64url'));
}

/** Serialise every code operation of ONE affiliate (same key in redeem and regenerate). */
async function lockAffiliateCodes(tx, affiliateId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'affiliate-activation:' + affiliateId}))`;
}

/**
 * Inside the caller's transaction: invalidate the active code (if any) and insert a new one.
 * → { code, expiresAt, id } — the ONLY place the plaintext code exists (returned once).
 */
export async function issueActivationCode(tx, { affiliateId, passwordHash, createdByType, createdById, now = new Date() }) {
  await lockAffiliateCodes(tx, affiliateId);
  await tx.affiliateActivationCode.updateMany({
    where: { affiliateId, usedAt: null, invalidatedAt: null },
    data: { invalidatedAt: now, invalidatedReason: 'REGENERATED' },
  });
  const { code, selector, verifierHash } = generateActivationCode();
  const expiresAt = new Date(now.getTime() + ACTIVATION_LIMITS.TTL_MS);
  const row = await tx.affiliateActivationCode.create({
    data: { affiliateId, selector, verifierHash, passwordFingerprint: passwordFingerprint(passwordHash), createdByType, createdById, createdAt: now, expiresAt },
    select: { id: true, expiresAt: true },
  });
  return { code, expiresAt: row.expiresAt, id: row.id };
}

/**
 * May a NEW code be issued for this affiliate (by its recruiter)? Only while its credentials
 * were never set: at least one code exists, none was ever used, none was issued by an ADMIN
 * (an admin recovery code must never be replaced — nor intercepted — by the recruiter), and
 * the password is still the one the latest code was issued for (no admin / affiliate change
 * since). Read inside the lock.
 */
async function credentialsStillPending(tx, affiliateId) {
  const [affiliate, codes] = await Promise.all([
    tx.affiliate.findUnique({ where: { id: affiliateId }, select: { password: true } }),
    tx.affiliateActivationCode.findMany({ where: { affiliateId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: { usedAt: true, passwordFingerprint: true, createdByType: true } }),
  ]);
  if (!affiliate || !codes.length || codes.some((c) => c.usedAt || c.createdByType !== 'RECRUITER')) return { pending: false, affiliate };
  return { pending: codes[0].passwordFingerprint === passwordFingerprint(affiliate.password), affiliate };
}

/**
 * Recruiter: a NEW code for one of THEIR affiliates whose credentials are still pending.
 * → { code, expiresAt } ; NOT_FOUND (not their affiliate) / ACTIVATION_NOT_AVAILABLE.
 */
export async function regenerateActivationCode(recruiterId, affiliateId, { db = prisma, now = new Date() } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  if (typeof affiliateId !== 'string' || !ID_RE.test(affiliateId)) throw fail('NOT_FOUND');
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT "isActive" FROM "recruiters" WHERE "id" = ${recruiterId} FOR NO KEY UPDATE`;
    const me = Array.isArray(locked) ? locked[0] : null;
    if (!me) throw fail('UNAUTHORIZED');
    if (me.isActive !== true) throw fail('RECRUITER_DISABLED');
    const link = await tx.recruiterAffiliateLink.findUnique({ where: { affiliateId }, select: { recruiterId: true } });
    if (!link || link.recruiterId !== recruiterId) throw fail('NOT_FOUND');
    await lockAffiliateCodes(tx, affiliateId);
    const { pending, affiliate } = await credentialsStillPending(tx, affiliateId);
    if (!pending) throw fail('ACTIVATION_NOT_AVAILABLE');
    const issued = await issueActivationCode(tx, { affiliateId, passwordHash: affiliate.password, createdByType: 'RECRUITER', createdById: recruiterId, now });
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'AFFILIATE_ACTIVATION_CODE_ISSUED', entityType: 'affiliate', entityId: affiliateId,
        details: { activationCodeId: issued.id, reason: 'REGENERATED' }, createdAt: now,
      },
    });
    return { code: issued.code, expiresAt: issued.expiresAt };
  });
}

/**
 * Recruiter: their affiliates whose credentials are still pending (newest first, max 50),
 * with the state of the latest code — never the code itself.
 * → [{ affiliate: { id, username, name, createdAt }, state: ACTIVE | EXPIRED | INVALIDATED, expiresAt }]
 */
export async function listPendingActivations(recruiterId, { db = prisma, now = new Date() } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const links = await db.recruiterAffiliateLink.findMany({
    // never an affiliate with a used code or an ADMIN (recovery) code: that hand-over is the admin's
    where: { recruiterId, affiliate: { activationCodes: { some: {}, none: { OR: [{ usedAt: { not: null } }, { createdByType: { not: 'RECRUITER' } }] } } } },
    orderBy: [{ createdAt: 'desc' }, { affiliateId: 'asc' }], take: ACTIVATION_LIMITS.LIST_MAX,
    select: { affiliate: { select: { id: true, username: true, name: true, createdAt: true, password: true } } },
  });
  const ids = links.map((l) => l.affiliate?.id).filter(Boolean);
  const codes = ids.length ? await db.affiliateActivationCode.findMany({
    where: { affiliateId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    select: { affiliateId: true, expiresAt: true, usedAt: true, invalidatedAt: true, passwordFingerprint: true, createdByType: true },
  }) : [];
  const latest = new Map();
  for (const c of codes) if (!latest.has(c.affiliateId)) latest.set(c.affiliateId, c);
  const out = [];
  for (const l of links) {
    const a = l.affiliate;
    const c = a ? latest.get(a.id) : null;
    if (!a || !c || c.usedAt || c.createdByType !== 'RECRUITER' || c.passwordFingerprint !== passwordFingerprint(a.password)) continue; // credentials set elsewhere / admin recovery
    const state = c.invalidatedAt ? 'INVALIDATED' : new Date(c.expiresAt) <= now ? 'EXPIRED' : 'ACTIVE';
    out.push({ affiliate: { id: a.id, username: a.username, name: a.name, createdAt: a.createdAt }, state, expiresAt: c.expiresAt });
  }
  return out;
}

/** Password rules of the activation (the same bcrypt hashing as every account). */
export function validateNewPassword(password, confirm) {
  const fields = {};
  const p = typeof password === 'string' ? password : '';
  if (p.length < ACTIVATION_LIMITS.PASSWORD_MIN || p.length > ACTIVATION_LIMITS.PASSWORD_MAX || !/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) fields.password = 'WEAK_PASSWORD';
  else if (confirm !== p) fields.passwordConfirm = 'PASSWORD_MISMATCH';
  return fields;
}

const sameHex = (a, b) => {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
};

/**
 * Affiliate (public): redeem a code and set their own password { code, password, passwordConfirm }.
 * Every failure about the code is the SAME error (INVALID_OR_EXPIRED_CODE): unknown, wrong,
 * expired, used, invalidated or stale codes are indistinguishable. A wrong verifier counts
 * one failed attempt on its record (the 5th invalidates it). Never activates the account.
 * → { ok: true }
 */
export async function redeemActivationCode(input, { db = prisma, now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['code', 'password', 'passwordConfirm'].includes(k))) {
    throw fail('INVALID_INPUT', { fields: { body: 'UNKNOWN_FIELD' } });
  }
  const fields = validateNewPassword(input.password, input.passwordConfirm);
  const m = typeof input.code === 'string' ? CODE_RE.exec(input.code.trim()) : null;
  if (!m) fields.code = 'INVALID_CODE_FORMAT';
  if (Object.keys(fields).length) throw fail('INVALID_INPUT', { fields });
  const [, selector, verifier] = m;
  // Hash first, for every well-formed request: the response time does not reveal whether
  // the selector exists.
  const passwordHash = await hashPassword(input.password);
  const found = await db.affiliateActivationCode.findUnique({ where: { selector }, select: { affiliateId: true } });
  if (!found) throw fail('INVALID_OR_EXPIRED_CODE');

  const result = await db.$transaction(async (tx) => {
    await lockAffiliateCodes(tx, found.affiliateId);
    const row = await tx.affiliateActivationCode.findUnique({
      where: { selector },
      select: { id: true, affiliateId: true, verifierHash: true, passwordFingerprint: true, expiresAt: true, failedAttempts: true, usedAt: true, invalidatedAt: true },
    });
    if (!row || row.usedAt || row.invalidatedAt || new Date(row.expiresAt) <= now || row.failedAttempts >= ACTIVATION_LIMITS.MAX_ATTEMPTS) return { ok: false };
    if (!sameHex(createHash('sha256').update(verifier, 'utf8').digest('hex'), row.verifierHash)) {
      const attempts = row.failedAttempts + 1;
      await tx.affiliateActivationCode.updateMany({
        where: { id: row.id, usedAt: null, invalidatedAt: null },
        data: attempts >= ACTIVATION_LIMITS.MAX_ATTEMPTS
          ? { failedAttempts: attempts, invalidatedAt: now, invalidatedReason: 'TOO_MANY_ATTEMPTS' }
          : { failedAttempts: attempts },
      });
      return { ok: false };
    }
    const affiliate = await tx.affiliate.findUnique({ where: { id: row.affiliateId }, select: { id: true, password: true } });
    if (!affiliate || passwordFingerprint(affiliate.password) !== row.passwordFingerprint) {
      await tx.affiliateActivationCode.updateMany({ where: { id: row.id, usedAt: null, invalidatedAt: null }, data: { invalidatedAt: now, invalidatedReason: 'CREDENTIALS_CHANGED' } });
      return { ok: false };
    }
    const used = await tx.affiliateActivationCode.updateMany({ where: { id: row.id, usedAt: null, invalidatedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) return { ok: false };
    // The password ONLY — the activation flag and everything else stay as they are. Any older
    // session is revoked as for every password change (Phase 6 part 2: tokenVersion +1).
    await tx.affiliate.update({ where: { id: affiliate.id }, data: { password: passwordHash, tokenVersion: { increment: 1 } }, select: { id: true } });
    const link = await tx.recruiterAffiliateLink.findUnique({ where: { affiliateId: affiliate.id }, select: { recruiterId: true } });
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId: link?.recruiterId ?? null, actorType: 'SYSTEM', actorId: 'SYSTEM', action: 'AFFILIATE_CREDENTIALS_SET',
        entityType: 'affiliate', entityId: affiliate.id, details: { activationCodeId: row.id }, createdAt: now,
      },
    });
    return { ok: true };
  });
  if (!result.ok) throw fail('INVALID_OR_EXPIRED_CODE');
  return { ok: true };
}
