/**
 * src/lib/services/recruiterService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 2: recruiter accounts and authentication.
 * (db injected, so tests run on an in-memory fake or an isolated local database.)
 *
 *   • Only an admin creates, lists, enables and disables recruiters.
 *   • Passwords are bcrypt hashes (authService.hashPassword; the DB refuses anything
 *     else). A login answers INVALID_CREDENTIALS for an unknown username OR a wrong
 *     password (a dummy hash comparison keeps the timing similar); a disabled
 *     account is reported only AFTER a correct password (RECRUITER_DISABLED).
 *   • Every change and every login writes recruiter_audit_log in the same
 *     transaction. Nothing here reads or writes affiliates or any other system.
 *   • Sessions (Phase 6 part 2): the token carries the account's tokenVersion ("tv"; a token
 *     without it counts as 0). It is bumped on disable AND enable, on a password change and
 *     on an admin reset — every older token is rejected, a re-enabled account never revives
 *     a token issued before. The admin reset never changes isActive.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { hashPassword, comparePassword, signToken } from './authService.js';
import { checkLock, clearFailures, registerFailure, sweep, throttleKey } from '../loginThrottle.js';

export const RECRUITER_LIMITS = Object.freeze({ PASSWORD_MIN: 8, PASSWORD_MAX: 128, NAME_MIN: 2, NAME_MAX: 80, REASON_MAX: 300 });
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/; // mirrors the DB CHECK
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
// A real bcrypt hash of a random string: compared when the username is unknown, so an
// unknown user and a wrong password take about the same time.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5nBy2tQZcq2Yk1i3mUyQq3u1q0nJx7S';

const fail = (code, field) => Object.assign(new Error(code), { code, ...(field ? { field } : {}) });
const isUnique = (e, field) => e?.code === 'P2002' && JSON.stringify(e?.meta?.target ?? '').includes(field);

export function normalizeUsername(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** The two independent recruiter permissions an admin can switch (Phase 6 part 4). */
export const RECRUITER_PERMISSION_KEYS = Object.freeze(['canViewOrders', 'canCreateAffiliates']);

/** Admin input → { value } or { errors: { field: code } }. */
export function validateRecruiterInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = {};
  const username = normalizeUsername(src.username);
  if (!USERNAME_RE.test(username)) errors.username = 'INVALID_USERNAME';
  const name = typeof src.name === 'string' ? src.name.replace(/\s+/g, ' ').trim() : '';
  if (name.length < RECRUITER_LIMITS.NAME_MIN || name.length > RECRUITER_LIMITS.NAME_MAX || /[<>]/.test(name)) errors.name = 'INVALID_NAME';
  const password = typeof src.password === 'string' ? src.password : '';
  if (password.length < RECRUITER_LIMITS.PASSWORD_MIN || password.length > RECRUITER_LIMITS.PASSWORD_MAX) errors.password = 'INVALID_PASSWORD';
  let phone = null;
  if (src.phone !== undefined && src.phone !== null && String(src.phone).trim() !== '') {
    phone = String(src.phone).replace(/[\s.-]/g, '');
    if (!PHONE_RE.test(phone)) errors.phone = 'INVALID_PHONE';
  }
  // Phase 6 part 4 (D5): optional permissions at creation — booleans only; omitted = true.
  const permissions = {};
  for (const key of RECRUITER_PERMISSION_KEYS) {
    if (src[key] === undefined) permissions[key] = true;
    else if (typeof src[key] === 'boolean') permissions[key] = src[key];
    else errors[key] = 'INVALID_PERMISSION';
  }
  if (Object.keys(errors).length) return { errors };
  return { value: { username, name, password, phone, ...permissions } };
}

/** Admin-facing shape (never the password hash). */
export function adminRecruiterView(r) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id, username: r.username, name: r.name, phone: r.phone ?? null,
    isActive: r.isActive === true, canCreateAffiliates: r.canCreateAffiliates === true, canViewOrders: r.canViewOrders === true,
    disabledAt: iso(r.disabledAt), disabledBy: r.disabledBy ?? null, disabledReason: r.disabledReason ?? null,
    lastLoginAt: iso(r.lastLoginAt), createdBy: r.createdBy, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  };
}

const audit = (tx, { recruiterId, actorType, actorId, action, details = null, at }) =>
  tx.recruiterAuditLog.create({ data: { recruiterId, actorType, actorId, action, entityType: 'recruiter', entityId: recruiterId, details, createdAt: at } });

/** Admin: create a recruiter (active). → admin view. */
export async function adminCreateRecruiter(input, { db = prisma, actorId, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  const { value: v, errors } = validateRecruiterInput(input);
  if (errors) throw Object.assign(fail('INVALID_INPUT'), { errors });
  const passwordHash = await hashPassword(v.password);
  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.recruiter.create({
        data: {
          username: v.username, name: v.name, phone: v.phone, passwordHash, isActive: true, createdBy: actorId,
          canViewOrders: v.canViewOrders, canCreateAffiliates: v.canCreateAffiliates,
        },
      });
      await audit(tx, {
        recruiterId: created.id, actorType: 'ADMIN', actorId, action: 'RECRUITER_CREATED',
        details: { username: v.username, canViewOrders: v.canViewOrders, canCreateAffiliates: v.canCreateAffiliates }, at: now,
      });
      return created;
    });
    return adminRecruiterView(row);
  } catch (e) {
    if (isUnique(e, 'username')) throw fail('USERNAME_TAKEN', 'username');
    if (isUnique(e, 'phone')) throw fail('PHONE_TAKEN', 'phone');
    throw e;
  }
}

/** Admin: every recruiter, newest first (admin view). */
export async function adminListRecruiters({ db = prisma } = {}) {
  const rows = await db.recruiter.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  return rows.map(adminRecruiterView);
}

/**
 * Admin input for a permission change → { value } or { errors }: an object with at least one of
 * RECRUITER_PERMISSION_KEYS, each a boolean; any other key is refused.
 */
export function validateRecruiterPermissionsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { body: 'INVALID_BODY' } };
  const errors = {};
  const value = {};
  for (const key of Object.keys(input)) {
    if (!RECRUITER_PERMISSION_KEYS.includes(key)) errors[key] = 'UNKNOWN_FIELD';
    else if (typeof input[key] !== 'boolean') errors[key] = 'INVALID_PERMISSION';
    else value[key] = input[key];
  }
  if (!Object.keys(errors).length && !Object.keys(value).length) errors.body = 'NO_PERMISSION';
  return Object.keys(errors).length ? { errors } : { value };
}

/**
 * Admin: set one or both recruiter permissions (canViewOrders, canCreateAffiliates), independently.
 * Locks the recruiter row (FOR NO KEY UPDATE — the same lock an affiliate creation / code
 * regeneration takes), re-reads the flags, writes ONLY the fields that change and one append-only
 * audit row per changed permission (RECRUITER_PERMISSION_CHANGED { permission, from, to }); a no-op
 * writes nothing. No session bump (D4): permissions are re-read on every recruiter request.
 * → { recruiter, changed, changes: [{ permission, from, to }] }
 */
export async function adminSetRecruiterPermissions(id, input, { db = prisma, actorId, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const { value, errors } = validateRecruiterPermissionsInput(input);
  if (errors) throw Object.assign(fail('INVALID_INPUT'), { errors });
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT "canViewOrders", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${id} FOR NO KEY UPDATE`;
    const current = Array.isArray(locked) ? locked[0] : null;
    if (!current) throw fail('NOT_FOUND');
    const changes = [];
    const data = {};
    for (const key of RECRUITER_PERMISSION_KEYS) {
      if (value[key] === undefined) continue;
      const from = current[key] === true;
      if (from === value[key]) continue;
      data[key] = value[key];
      changes.push({ permission: key, from, to: value[key] });
    }
    const row = changes.length
      ? await tx.recruiter.update({ where: { id }, data })
      : await tx.recruiter.findUnique({ where: { id } });
    for (const c of changes) {
      await audit(tx, { recruiterId: id, actorType: 'ADMIN', actorId, action: 'RECRUITER_PERMISSION_CHANGED', details: c, at: now });
    }
    return { recruiter: adminRecruiterView(row), changed: changes.length > 0, changes };
  });
}

/** Admin: enable or disable a recruiter (idempotent). Disabling records when, by whom and why. */
export async function adminSetRecruiterActive(id, active, { db = prisma, actorId, reason = null, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, RECRUITER_LIMITS.REASON_MAX) : null;
  return db.$transaction(async (tx) => {
    const current = await tx.recruiter.findUnique({ where: { id } });
    if (!current) throw fail('NOT_FOUND');
    if (current.isActive === active) return { recruiter: adminRecruiterView(current), changed: false };
    const updated = await tx.recruiter.update({
      where: { id },
      // tokenVersion +1 both ways: disabling revokes every session, re-enabling never revives one.
      data: active
        ? { isActive: true, disabledAt: null, disabledBy: null, disabledReason: null, tokenVersion: { increment: 1 } }
        : { isActive: false, disabledAt: now, disabledBy: actorId, disabledReason: cleanReason, tokenVersion: { increment: 1 } },
    });
    await audit(tx, { recruiterId: id, actorType: 'ADMIN', actorId, action: active ? 'RECRUITER_ENABLED' : 'RECRUITER_DISABLED', details: active ? null : { reason: cleanReason }, at: now });
    return { recruiter: adminRecruiterView(updated), changed: true };
  });
}

/**
 * Recruiter login. → { token, recruiter } ; throws INVALID_CREDENTIALS (unknown user or
 * wrong password) or RECRUITER_DISABLED (correct password, disabled account).
 */
// Per-ACCOUNT failed-login throttle (Phase 6 part 2, D5): 5 failures per 15-minute fixed
// window per normalized username (src/lib/loginThrottle.js), in this process — production runs
// ONE web instance. Independent of the per-IP limiter of the handler. An unknown username
// locks exactly like a real one (no enumeration).
const recruiterLoginFailures = new Map();
let recruiterLoginCalls = 0;
/** Test hook: the throttle store (never exported to routes). */
export const __recruiterLoginThrottleStore = recruiterLoginFailures;

export async function loginRecruiter(usernameInput, password, { db = prisma, now = new Date(), throttle = recruiterLoginFailures } = {}) {
  const username = normalizeUsername(usernameInput);
  if (!USERNAME_RE.test(username) || typeof password !== 'string' || !password || password.length > RECRUITER_LIMITS.PASSWORD_MAX) {
    throw fail('INVALID_CREDENTIALS');
  }
  // D5 — check AND reserve this attempt in ONE synchronous step, BEFORE any await: concurrent
  // attempts cannot all pass the check (at most 5 per window are evaluated). Success clears it.
  const key = `recruiter:${throttleKey(username)}`;
  const t = now instanceof Date ? now.getTime() : Date.now();
  if ((recruiterLoginCalls += 1) % 100 === 0) sweep(throttle, t);
  if (checkLock(throttle, key, t).locked) throw fail('RATE_LIMITED');
  registerFailure(throttle, key, t);
  const row = await db.recruiter.findUnique({ where: { username } });
  const valid = await comparePassword(password, row ? row.passwordHash : DUMMY_HASH);
  if (!row || !valid) throw fail('INVALID_CREDENTIALS');
  clearFailures(throttle, key); // the right password: not a guessing attempt
  if (row.isActive !== true) throw fail('RECRUITER_DISABLED');
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.recruiter.update({ where: { id: row.id }, data: { lastLoginAt: now } });
    await audit(tx, { recruiterId: row.id, actorType: 'RECRUITER', actorId: row.id, action: 'RECRUITER_LOGIN', at: now });
    return u;
  });
  const token = recruiterSessionToken(updated);
  return { token, recruiter: updated };
}

/** Recruiter logout (audit only; the cookie is cleared by the route). */
export async function recordRecruiterLogout(recruiterId, { db = prisma, now = new Date() } = {}) {
  const row = await db.recruiter.findUnique({ where: { id: recruiterId }, select: { id: true } });
  if (!row) return false;
  await db.$transaction((tx) => audit(tx, { recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'RECRUITER_LOGOUT', at: now }));
  return true;
}

/** A session token for this recruiter row, bound to its current tokenVersion. */
export function recruiterSessionToken(row) {
  return signToken({ recruiterId: row.id, username: row.username, type: 'recruiter', tv: Number.isInteger(row.tokenVersion) ? row.tokenVersion : 0 });
}

/** The version a token carries (a token issued before versions existed = 0). */
export const tokenVersionOf = (decoded) => (Number.isInteger(decoded?.tv) && decoded.tv >= 0 ? decoded.tv : 0);

/**
 * The token's recruiter if it exists, is active and the token is CURRENT (same tokenVersion);
 * else UNAUTHORIZED / RECRUITER_DISABLED.
 */
export async function requireActiveRecruiter(decoded, { db = prisma } = {}) {
  const id = decoded?.recruiterId;
  if (decoded?.type !== 'recruiter' || typeof id !== 'string' || !ID_RE.test(id)) throw fail('UNAUTHORIZED');
  const row = await db.recruiter.findUnique({ where: { id } });
  if (!row) throw fail('UNAUTHORIZED');
  if (row.isActive !== true) throw fail('RECRUITER_DISABLED');
  if (tokenVersionOf(decoded) !== (Number.isInteger(row.tokenVersion) ? row.tokenVersion : 0)) throw fail('UNAUTHORIZED');
  return row;
}

/** Password policy of recruiter accounts (the same as at creation). */
function checkNewPassword(password, confirm) {
  const p = typeof password === 'string' ? password : '';
  if (p.length < RECRUITER_LIMITS.PASSWORD_MIN || p.length > RECRUITER_LIMITS.PASSWORD_MAX) return { newPassword: 'INVALID_PASSWORD' };
  if (confirm !== undefined && confirm !== p) return { newPasswordConfirm: 'PASSWORD_MISMATCH' };
  return null;
}

/**
 * Recruiter: change their OWN password { currentPassword, newPassword, newPasswordConfirm }.
 * The current password is verified; on success every session is revoked (tokenVersion +1) and
 * the caller receives a fresh token for the new version. → { token, recruiter }
 */
export async function changeRecruiterPassword(recruiterId, input, { db = prisma, now = new Date() } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!src || Object.keys(src).some((k) => !['currentPassword', 'newPassword', 'newPasswordConfirm'].includes(k))) throw Object.assign(fail('INVALID_INPUT'), { fields: { body: 'UNKNOWN_FIELD' } });
  const bad = checkNewPassword(src.newPassword, src.newPasswordConfirm);
  if (bad) throw Object.assign(fail('INVALID_INPUT'), { fields: bad });
  if (typeof src.currentPassword !== 'string' || !src.currentPassword || src.currentPassword.length > RECRUITER_LIMITS.PASSWORD_MAX) throw fail('INVALID_CREDENTIALS');
  const row = await db.recruiter.findUnique({ where: { id: recruiterId } });
  if (!row || row.isActive !== true) throw fail('UNAUTHORIZED');
  if (!(await comparePassword(src.currentPassword, row.passwordHash))) throw fail('INVALID_CREDENTIALS');
  const passwordHash = await hashPassword(src.newPassword);
  const updated = await db.$transaction(async (tx) => {
    // Conditional on the hash just verified: a concurrent change cannot be silently overwritten.
    const res = await tx.recruiter.updateMany({ where: { id: recruiterId, passwordHash: row.passwordHash, isActive: true }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    if (res.count !== 1) throw fail('INVALID_CREDENTIALS');
    await audit(tx, { recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'RECRUITER_PASSWORD_CHANGED', at: now });
    return tx.recruiter.findUnique({ where: { id: recruiterId } });
  });
  return { token: recruiterSessionToken(updated), recruiter: updated };
}

/**
 * Admin: reset a recruiter's password { newPassword }. Revokes every session (tokenVersion +1);
 * NEVER changes isActive (a disabled recruiter stays disabled). Audited (no password stored).
 */
export async function adminResetRecruiterPassword(id, input, { db = prisma, actorId, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!src || Object.keys(src).some((k) => k !== 'newPassword')) throw Object.assign(fail('INVALID_INPUT'), { errors: { body: 'UNKNOWN_FIELD' } });
  if (checkNewPassword(src.newPassword)) throw Object.assign(fail('INVALID_INPUT'), { errors: { newPassword: 'INVALID_PASSWORD' } });
  const passwordHash = await hashPassword(src.newPassword);
  return db.$transaction(async (tx) => {
    const current = await tx.recruiter.findUnique({ where: { id }, select: { id: true, isActive: true } });
    if (!current) throw fail('NOT_FOUND');
    const updated = await tx.recruiter.update({ where: { id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    await audit(tx, { recruiterId: id, actorType: 'ADMIN', actorId, action: 'RECRUITER_PASSWORD_RESET', details: { sessionsRevoked: true, isActive: current.isActive === true }, at: now });
    return { recruiter: adminRecruiterView(updated) };
  });
}
