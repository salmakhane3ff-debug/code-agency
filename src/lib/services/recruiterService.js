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
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { hashPassword, comparePassword, signToken } from './authService.js';

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
  if (Object.keys(errors).length) return { errors };
  return { value: { username, name, password, phone } };
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
        data: { username: v.username, name: v.name, phone: v.phone, passwordHash, isActive: true, createdBy: actorId },
      });
      await audit(tx, { recruiterId: created.id, actorType: 'ADMIN', actorId, action: 'RECRUITER_CREATED', details: { username: v.username }, at: now });
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
      data: active
        ? { isActive: true, disabledAt: null, disabledBy: null, disabledReason: null }
        : { isActive: false, disabledAt: now, disabledBy: actorId, disabledReason: cleanReason },
    });
    await audit(tx, { recruiterId: id, actorType: 'ADMIN', actorId, action: active ? 'RECRUITER_ENABLED' : 'RECRUITER_DISABLED', details: active ? null : { reason: cleanReason }, at: now });
    return { recruiter: adminRecruiterView(updated), changed: true };
  });
}

/**
 * Recruiter login. → { token, recruiter } ; throws INVALID_CREDENTIALS (unknown user or
 * wrong password) or RECRUITER_DISABLED (correct password, disabled account).
 */
export async function loginRecruiter(usernameInput, password, { db = prisma, now = new Date() } = {}) {
  const username = normalizeUsername(usernameInput);
  if (!USERNAME_RE.test(username) || typeof password !== 'string' || !password || password.length > RECRUITER_LIMITS.PASSWORD_MAX) {
    throw fail('INVALID_CREDENTIALS');
  }
  const row = await db.recruiter.findUnique({ where: { username } });
  const valid = await comparePassword(password, row ? row.passwordHash : DUMMY_HASH);
  if (!row || !valid) throw fail('INVALID_CREDENTIALS');
  if (row.isActive !== true) throw fail('RECRUITER_DISABLED');
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.recruiter.update({ where: { id: row.id }, data: { lastLoginAt: now } });
    await audit(tx, { recruiterId: row.id, actorType: 'RECRUITER', actorId: row.id, action: 'RECRUITER_LOGIN', at: now });
    return u;
  });
  const token = signToken({ recruiterId: row.id, username: row.username, type: 'recruiter' });
  return { token, recruiter: updated };
}

/** Recruiter logout (audit only; the cookie is cleared by the route). */
export async function recordRecruiterLogout(recruiterId, { db = prisma, now = new Date() } = {}) {
  const row = await db.recruiter.findUnique({ where: { id: recruiterId }, select: { id: true } });
  if (!row) return false;
  await db.$transaction((tx) => audit(tx, { recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'RECRUITER_LOGOUT', at: now }));
  return true;
}

/** The token's recruiter if it exists and is active; else UNAUTHORIZED / RECRUITER_DISABLED. */
export async function requireActiveRecruiter(decoded, { db = prisma } = {}) {
  const id = decoded?.recruiterId;
  if (decoded?.type !== 'recruiter' || typeof id !== 'string' || !ID_RE.test(id)) throw fail('UNAUTHORIZED');
  const row = await db.recruiter.findUnique({ where: { id } });
  if (!row) throw fail('UNAUTHORIZED');
  if (row.isActive !== true) throw fail('RECRUITER_DISABLED');
  return row;
}
