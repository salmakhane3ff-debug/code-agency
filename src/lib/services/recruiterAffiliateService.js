/**
 * src/lib/services/recruiterAffiliateService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 3: a recruiter CREATES affiliates in their own
 * network (db injected, so tests run on an in-memory fake or an isolated local database).
 *
 *   • Creation only. There is no path that links, re-parents, activates or edits an
 *     EXISTING affiliate: the link's affiliateId is always the id generated here for the
 *     row created in the same transaction (the Phase 1 trigger
 *     recruiter_link_new_affiliate_only is the database backstop).
 *   • Same account rules as the admin creation (adminCreateAffiliate): lower-cased
 *     username, bcrypt password, INACTIVE account (only an admin activates it), the
 *     database defaults for every other column. Stricter input validation (format,
 *     lengths, optional phone) and no admin-only field (rate, objectives, activation).
 *   • Parent: none (root) or an affiliate already linked to THIS recruiter, checked on the
 *     server inside the transaction (never trusted from the client), with its whole
 *     ancestry verified to be acyclic and inside the same network.
 *   • One transaction: lock the recruiter row (FOR NO KEY UPDATE — serialises this
 *     recruiter's creations and any concurrent admin disable), re-check the account,
 *     idempotency replay (requestId), parent checks, uniqueness checks, affiliate, link,
 *     audit. Any failure rolls everything back: no partial affiliate, link or audit row.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import prisma from '../prisma.js';
import { hashPassword } from './authService.js';

export const RECRUITER_AFFILIATE_LIMITS = Object.freeze({
  PASSWORD_MIN: 8, PASSWORD_MAX: 128, NAME_MIN: 2, NAME_MAX: 80, LIST_MAX: 50, QUERY_MAX: 40, ANCESTRY_MAX: 10000,
});
// A username always contains a letter, so it can never equal a phone number (the affiliate
// login accepts a username OR a phone).
const USERNAME_RE = /^(?=[a-z0-9._-]*[a-z])[a-z0-9][a-z0-9._-]{2,29}$/;
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_FIELDS = new Set(['username', 'name', 'password', 'phone', 'parentId', 'requestId']);

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const isUnique = (e, field) => e?.code === 'P2002' && JSON.stringify(e?.meta?.target ?? '').includes(field);

/** Recruiter input → { value } or { fields: { field: code } } (codes allowlisted in recruiterVisibility). */
export function validateRecruiterAffiliateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fields: { body: 'UNKNOWN_FIELD' } };
  const fields = {};
  // Strict body: an id, an activation flag, a rate or any other field is refused, never ignored.
  if (Object.keys(input).some((k) => !ALLOWED_FIELDS.has(k))) fields.body = 'UNKNOWN_FIELD';
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(username)) fields.username = 'INVALID_USERNAME';
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (name.length < RECRUITER_AFFILIATE_LIMITS.NAME_MIN || name.length > RECRUITER_AFFILIATE_LIMITS.NAME_MAX || /[<>]/.test(name)) fields.name = 'INVALID_NAME';
  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < RECRUITER_AFFILIATE_LIMITS.PASSWORD_MIN || password.length > RECRUITER_AFFILIATE_LIMITS.PASSWORD_MAX) fields.password = 'INVALID_PASSWORD';
  let phone = null;
  if (input.phone !== undefined && input.phone !== null && !(typeof input.phone === 'string' && input.phone.trim() === '')) {
    phone = typeof input.phone === 'string' ? input.phone.replace(/[\s.-]/g, '') : '';
    if (!PHONE_RE.test(phone)) fields.phone = 'INVALID_PHONE';
  }
  let parentId = null;
  if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
    if (typeof input.parentId !== 'string' || !ID_RE.test(input.parentId)) fields.parentId = 'INVALID_PARENT';
    else parentId = input.parentId;
  }
  const requestId = typeof input.requestId === 'string' ? input.requestId.toLowerCase() : '';
  if (!REQUEST_ID_RE.test(requestId)) fields.requestId = 'INVALID_REQUEST_ID';
  if (Object.keys(fields).length) return { fields };
  return { value: { username, name, password, phone, parentId, requestId } };
}

/** The ids of every affiliate linked to this recruiter (their network). */
async function networkIdSet(db, recruiterId, extraIds = []) {
  const ids = [...new Set(extraIds.filter((x) => typeof x === 'string'))];
  if (!ids.length) return new Set();
  const rows = await db.recruiterAffiliateLink.findMany({ where: { recruiterId, affiliateId: { in: ids } }, select: { affiliateId: true } });
  return new Set(rows.map((r) => r.affiliateId));
}

/** Plain identity fields of an affiliate row (the projection happens in recruiterVisibility). */
const AFFILIATE_SELECT = { id: true, username: true, name: true, parentId: true, createdAt: true };

/**
 * The recruiter's own network for the parent selector: newest first, at most LIST_MAX,
 * optional search on username / name. → { rows, networkIds, truncated }
 */
export async function listRecruiterNetwork(recruiterId, { db = prisma, q = '' } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const query = typeof q === 'string' ? q.trim().slice(0, RECRUITER_AFFILIATE_LIMITS.QUERY_MAX) : '';
  const links = await db.recruiterAffiliateLink.findMany({
    where: {
      recruiterId,
      ...(query ? { affiliate: { OR: [{ username: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }] } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { affiliateId: 'asc' }],
    take: RECRUITER_AFFILIATE_LIMITS.LIST_MAX + 1,
    select: { affiliate: { select: AFFILIATE_SELECT } },
  });
  const rows = links.slice(0, RECRUITER_AFFILIATE_LIMITS.LIST_MAX).map((l) => l.affiliate).filter(Boolean);
  const networkIds = await networkIdSet(db, recruiterId, rows.map((r) => r.parentId));
  return { rows, networkIds, truncated: links.length > RECRUITER_AFFILIATE_LIMITS.LIST_MAX };
}

/**
 * Walk the parent's ancestry (parent, its parent, …): every node must be linked to this
 * recruiter and the chain must end (no cycle). Parents are never changed after creation
 * anywhere in the code, so this holds by construction; it is verified anyway (defence in depth).
 */
async function assertAncestryInNetwork(tx, recruiterId, parentId) {
  const seen = new Set();
  let id = parentId;
  while (id) {
    if (seen.has(id) || seen.size >= RECRUITER_AFFILIATE_LIMITS.ANCESTRY_MAX) throw fail('PARENT_NOT_IN_NETWORK');
    seen.add(id);
    const link = await tx.recruiterAffiliateLink.findUnique({ where: { affiliateId: id }, select: { recruiterId: true } });
    if (!link || link.recruiterId !== recruiterId) throw fail('PARENT_NOT_IN_NETWORK');
    const node = await tx.affiliate.findUnique({ where: { id }, select: { parentId: true } });
    if (!node) throw fail('PARENT_NOT_IN_NETWORK');
    id = node.parentId ?? null;
  }
}

/**
 * Recruiter: create an affiliate (inactive) in their own network.
 * → { row, networkIds, replayed } ; throws UNAUTHORIZED / RECRUITER_DISABLED / FORBIDDEN /
 * INVALID_INPUT (with fields) / PARENT_NOT_IN_NETWORK / USERNAME_TAKEN / PHONE_TAKEN /
 * IDEMPOTENCY_CONFLICT.
 */
export async function recruiterCreateAffiliate(recruiterId, input, { db = prisma, now = new Date(), newId = randomUUID } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const { value: v, fields } = validateRecruiterAffiliateInput(input);
  if (fields) throw fail('INVALID_INPUT', { fields });
  const passwordHash = await hashPassword(v.password); // outside the transaction (slow)
  const id = newId();
  if (typeof id !== 'string' || !ID_RE.test(id) || id === v.parentId) throw fail('SERVER_ERROR');

  try {
    return await db.$transaction(async (tx) => {
      // 1. Lock this recruiter's row and re-check the account inside the transaction.
      const locked = await tx.$queryRaw`SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${recruiterId} FOR NO KEY UPDATE`;
      const me = Array.isArray(locked) ? locked[0] : null;
      if (!me) throw fail('UNAUTHORIZED');
      if (me.isActive !== true) throw fail('RECRUITER_DISABLED');
      if (me.canCreateAffiliates !== true) throw fail('FORBIDDEN');

      // 2. Idempotency: the same requestId of this recruiter replays the first result.
      const previous = await tx.recruiterAuditLog.findFirst({
        where: { recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'AFFILIATE_CREATED', details: { path: ['requestId'], equals: v.requestId } },
        select: { entityId: true },
      });
      if (previous) {
        const found = previous.entityId ? await tx.affiliate.findUnique({ where: { id: previous.entityId }, select: { ...AFFILIATE_SELECT, phone: true } }) : null;
        const link = found ? await tx.recruiterAffiliateLink.findUnique({ where: { affiliateId: found.id }, select: { recruiterId: true } }) : null;
        if (!found || link?.recruiterId !== recruiterId || found.username !== v.username || found.name !== v.name
          || (found.phone ?? null) !== v.phone || (found.parentId ?? null) !== v.parentId) throw fail('IDEMPOTENCY_CONFLICT');
        const { phone: _phone, ...row } = found; // the phone is compared, never returned
        return { row, networkIds: await networkIdSet(tx, recruiterId, [row.parentId]), replayed: true };
      }

      // 3. Parent: none, or a member of THIS recruiter's network (whole ancestry checked).
      if (v.parentId) await assertAncestryInNetwork(tx, recruiterId, v.parentId);

      // 4. Uniqueness across username AND phone (the affiliate login accepts either);
      //    the unique indexes remain the final backstop (P2002 → *_TAKEN).
      if (await tx.affiliate.findFirst({ where: { OR: [{ username: v.username }, { phone: v.username }] }, select: { id: true } })) throw fail('USERNAME_TAKEN');
      if (v.phone && await tx.affiliate.findFirst({ where: { OR: [{ phone: v.phone }, { username: v.phone }] }, select: { id: true } })) throw fail('PHONE_TAKEN');

      // 5. The affiliate (inactive; database defaults for every other column), its link, the audit row.
      const row = await tx.affiliate.create({
        data: { id, name: v.name, username: v.username, password: passwordHash, phone: v.phone, isActive: false, ...(v.parentId ? { parentId: v.parentId } : {}) },
        select: { ...AFFILIATE_SELECT, isActive: true },
      });
      if (row.id !== id || row.isActive !== false) throw fail('SERVER_ERROR');
      await tx.recruiterAffiliateLink.create({ data: { affiliateId: id, recruiterId, createdBy: recruiterId } });
      await tx.recruiterAuditLog.create({
        data: {
          recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'AFFILIATE_CREATED', entityType: 'affiliate', entityId: id,
          details: { requestId: v.requestId, username: v.username, parentId: v.parentId }, createdAt: now,
        },
      });
      const { isActive: _ignored, ...plain } = row;
      return { row: plain, networkIds: await networkIdSet(tx, recruiterId, [plain.parentId]), replayed: false };
    });
  } catch (e) {
    if (isUnique(e, 'username')) throw fail('USERNAME_TAKEN');
    if (isUnique(e, 'phone')) throw fail('PHONE_TAKEN');
    throw e;
  }
}
