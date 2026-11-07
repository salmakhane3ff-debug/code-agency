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
 *   • Phase 6 (activation code): the recruiter NEVER chooses the password. The affiliate is
 *     created with an unusable random password and a one-time activation code is issued in
 *     the same transaction (affiliateActivationService); it is returned ONCE, and the
 *     affiliate sets their own password with it. A `password` in the body is refused.
 *   • Parent: none (root) or a member of THIS recruiter's network N(R) (Phase 7 Stage F: its
 *     owner — the recruiter of the TOPMOST linked affiliate of its chain — is this recruiter; a
 *     recruiter can never create under another recruiter's network, even below a nested legacy link
 *     to itself), checked on the server inside the transaction (never trusted from the client). The
 *     new affiliate is linked to that same recruiter, so creation always extends its ownership.
 *   • One transaction: lock the recruiter row (FOR NO KEY UPDATE — serialises this
 *     recruiter's creations and any concurrent admin disable), re-check the account,
 *     idempotency replay (requestId), parent checks, uniqueness checks, affiliate, link,
 *     audit. Any failure rolls everything back: no partial affiliate, link or audit row.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';
import prisma from '../prisma.js';
import { issueActivationCode, unusablePasswordHash } from './affiliateActivationService.js';
import { NETWORK_LIMITS, getAffiliateCounts, getAffiliatePlacement } from './recruiterNetworkService.js';

export const RECRUITER_AFFILIATE_LIMITS = Object.freeze({
  PASSWORD_MIN: 8, PASSWORD_MAX: 128, NAME_MIN: 2, NAME_MAX: 80, LIST_MAX: 50, QUERY_MAX: 40, ANCESTRY_MAX: 10000, LIST_LIMIT_MAX: 100,
});
// A username always contains a letter, so it can never equal a phone number (the affiliate
// login accepts a username OR a phone).
const USERNAME_RE = /^(?=[a-z0-9._-]*[a-z])[a-z0-9][a-z0-9._-]{2,29}$/;
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** Phase 7 Stage B: keyset cursor of the affiliate list — "<createdAt in ms>.<affiliateId>" (Stage E: the affiliate's createdAt). */
export const LIST_CURSOR_RE = /^(0|[1-9][0-9]{0,14})\.([A-Za-z0-9_-]{1,100})$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_FIELDS = new Set(['username', 'name', 'phone', 'parentId', 'requestId']);

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
  return { value: { username, name, phone, parentId, requestId } };
}

/** Phase 7 Stage E: the members of N(R) among `extraIds` (a parent shown in a view) — one ancestry statement each (≤ 1 id here). */
async function networkIdSet(db, recruiterId, extraIds = []) {
  const ids = [...new Set(extraIds.filter((x) => typeof x === 'string'))];
  const out = new Set();
  for (const id of ids) if (await parentInNetwork(db, recruiterId, id)) out.add(id);
  return out;
}

/** Plain identity fields of an affiliate row (the projection happens in recruiterVisibility). */
const AFFILIATE_SELECT = { id: true, username: true, name: true, parentId: true, createdAt: true };

/**
 * The recruiter's own network for the parent selector and the affiliate list. Phase 7 Stage E → F: the
 * members of N(R) (every affiliate whose owner — the recruiter of the TOPMOST linked affiliate of its
 * chain — is the recruiter: linked to it or below one of its affiliates at any depth, whatever a nested
 * link says; recruiterNetworkService), newest first (affiliate createdAt DESC, then id), optional
 * search on username / name (case-insensitive substring, wildcards escaped), keyset `cursor`
 * ("<createdAt in ms>.<affiliateId>" of the last item) and `limit` (default LIST_MAX, max
 * LIST_LIMIT_MAX), the `total` matching `q`, and per row linkedToMe (information: linked to R), its
 * level / parent in N(R), identity status and (includeOrders only) order counts.
 * Statements: ONE `recruiter-affiliate-list` (the shared N(R) CTEs of recruiterNetworkService — roots,
 * every descendant, the cyclic part — then a primary-key lookup per member, the search, the total and the page) + the ancestry
 * statement and the two page reads of the network service, whatever the network size. Cost O(|N(R)|)
 * index probes + a sort of the matching members (never a scan of the affiliates table).
 * → { rows, networkIds, truncated, total, nextCursor }
 * `networkIds`: a parentId is shown only when the parent is a member of N(R).
 */
export async function listRecruiterNetwork(recruiterId, { db = prisma, q = '', cursor = null, limit = null, includeOrders = true } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const query = typeof q === 'string' ? q.trim().slice(0, RECRUITER_AFFILIATE_LIMITS.QUERY_MAX) : '';
  const size = limit === null || limit === undefined ? RECRUITER_AFFILIATE_LIMITS.LIST_MAX
    : Math.min(Math.max(Number.isInteger(limit) ? limit : RECRUITER_AFFILIATE_LIMITS.LIST_MAX, 1), RECRUITER_AFFILIATE_LIMITS.LIST_LIMIT_MAX);
  let afterMs = null;
  let afterId = null;
  if (cursor !== null && cursor !== undefined) {
    const m = typeof cursor === 'string' ? LIST_CURSOR_RE.exec(cursor) : null;
    if (!m) throw fail('INVALID_INPUT');
    afterMs = Number(m[1]);
    afterId = m[2];
  }
  const pattern = query ? `%${query.replace(/[\\%_]/g, '\\$&')}%` : null; // ILIKE wildcards / escape taken literally
  const take = size + 1;
  const cap = NETWORK_LIMITS.DEPTH_CAP;
  const found = await db.$queryRaw`
    /* recruiter-affiliate-list */
    WITH RECURSIVE cand AS (
      SELECT sa."id", sa."parentId"
      FROM unnest(ARRAY(SELECT l."affiliateId" FROM "recruiter_affiliate_links" l WHERE l."recruiterId" = ${recruiterId}::text)) AS s("id")
      CROSS JOIN LATERAL (
        SELECT f."id", f."parentId" FROM "affiliates" f WHERE f."id" = s."id" OFFSET 0
      ) sa
      WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = sa."parentId")
    ),
    up AS (
      SELECT c."id" AS seed, p."id", p."parentId", p.linked, p.top
      FROM cand c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.linked, p.top
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE NOT u.linked
    ),
    rs AS (
      SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top
      FROM up u
      GROUP BY u.seed
    ),
    roots AS (
      SELECT c."id"
      FROM cand c
      LEFT JOIN rs ON rs.seed = c."id"
      WHERE rs.seed IS NULL OR (NOT rs.linked AND rs.top)
    ),
    net AS (
      SELECT s."id", 0 AS depth FROM unnest(ARRAY(SELECT r."id" FROM roots r)) AS s("id")
      UNION ALL
      SELECT ch."id", n.depth + 1
      FROM net n
      CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
      WHERE n.depth < ${cap}::int
    ),
    orph AS (
      SELECT s."id"
      FROM unnest(ARRAY(
        SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
        WHERE l."recruiterId" = ${recruiterId}::text
          AND NOT EXISTS (SELECT 1 FROM net n WHERE n."id" = l."affiliateId")
      )) AS s("id")
    ),
    oup AS (
      SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
      FROM orph op
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = op."id"
        OFFSET 0
      ) p
      UNION
      SELECT u.seed, p."id", p."parentId", p.rid, p.top
      FROM oup u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId",
               (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
    ),
    cseed AS (
      SELECT op."id"
      FROM orph op
      WHERE NOT EXISTS (SELECT 1 FROM oup u WHERE u.seed = op."id" AND (u.top OR u.rid <> ${recruiterId}::text))
    ),
    cnet AS (
      SELECT s."id" FROM cseed s
      UNION
      SELECT ch."id"
      FROM cnet c
      CROSS JOIN LATERAL (
        SELECT a."id" FROM "affiliates" a
        WHERE a."parentId" = c."id"
          AND NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" ox WHERE ox."affiliateId" = a."id" AND ox."recruiterId" <> ${recruiterId}::text)
        OFFSET 0
      ) ch
    ),
    mem AS (
      SELECT n."id" FROM net n
      UNION ALL
      SELECT c."id" FROM unnest(ARRAY(SELECT cx."id" FROM cnet cx)) AS c("id")
    ),
    hit AS (
      SELECT a."id", a."username", a."name", a."parentId", a."isActive", a."createdAt",
             (extract(epoch FROM a."createdAt") * 1000)::bigint AS ms
      FROM mem m
      CROSS JOIN LATERAL (
        SELECT f."id", f."username", f."name", f."parentId", f."isActive", f."createdAt" FROM "affiliates" f WHERE f."id" = m."id" OFFSET 0
      ) a
      WHERE (${pattern}::text IS NULL OR a."username" ILIKE ${pattern}::text OR a."name" ILIKE ${pattern}::text)
    ),
    page AS (
      SELECT h."id", h."username", h."name", h."parentId", h."isActive", h."createdAt", h.ms
      FROM hit h
      WHERE (${afterMs}::bigint IS NULL OR h.ms < ${afterMs}::bigint OR (h.ms = ${afterMs}::bigint AND h."id" > ${afterId}::text))
      ORDER BY h.ms DESC, h."id"
      LIMIT ${take}::int
    )
    SELECT (SELECT count(*)::int FROM hit) AS total,
           p."id", p."username", p."name", p."parentId", p."isActive", p."createdAt", p.ms,
           EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = p."id" AND x."recruiterId" = ${recruiterId}::text) AS mine
    FROM (SELECT 1) one
    LEFT JOIN page p ON true
    ORDER BY p.ms DESC, p."id"`;
  const list = Array.isArray(found) ? found : [];
  const total = list.length ? Number(list[0]?.total) || 0 : 0;
  const all = list.filter((r) => typeof r?.id === 'string');
  const page = all.slice(0, size);
  const ids = page.map((r) => r.id);
  const placement = await getAffiliatePlacement(recruiterId, ids, { db });
  const counts = await getAffiliateCounts(ids, { db, includeOrders });
  const rows = page.map((r) => {
    const at = placement.get(r.id);
    const c = counts.get(r.id);
    return {
      id: r.id, username: r.username ?? null, name: r.name ?? null, parentId: r.parentId ?? null, createdAt: r.createdAt ?? null,
      status: r.isActive === true ? 'ACTIVE' : 'INACTIVE', level: at?.level ?? null, parent: at?.parent ?? null,
      identityStatus: c?.identityStatus ?? 'NONE', orders: c?.orders ?? null, linkedToMe: r.mine === true,
    };
  });
  const networkIds = new Set(rows.filter((r) => r.parentId && placement.get(r.id)?.parentInNetwork === true).map((r) => r.parentId));
  const more = all.length > size;
  const last = page[page.length - 1];
  const lastMs = last ? Number(last.ms) : NaN;
  return {
    rows, networkIds, truncated: more, total,
    nextCursor: more && last && Number.isSafeInteger(lastMs) && lastMs >= 0 ? `${lastMs}.${last.id}` : null,
  };
}

/**
 * Walk the parent's WHOLE ancestry (parent, its parent, … up to the top) — Phase 7 Stage F: the parent
 * must be a member of this recruiter's network N(R): owner(parent) — the TOPMOST linked affiliate of its
 * chain (a parent cycle: the one recruiter of its links) — is this recruiter (a nested legacy link to another recruiter below it changes nothing; a nested legacy link
 * to THIS recruiter inside another recruiter's network does not make it a member). Parents are never
 * changed after creation anywhere in the code, links are only created for brand-new affiliates (leaves)
 * and an affiliate with children cannot be deleted (Stage F), so the owner of an existing affiliate is
 * stable; it is verified on the server anyway, inside the creation transaction.
 */
//
// Phase 6 part 5c → Phase 7 Stage F: ONE recursive statement — the owner rule of
// recruiterRewardService.findAffiliateOwner applied to the parent, with the ANCESTRY_MAX walk cap:
//   chain   the parent's chain upwards (primary-key lookups; UNION keeps each row once, so a parent cycle
//           ends after one lap), each row with its link (rid) and top (its parent row does not exist);
//   capped  at most ANCESTRY_MAX + 1 chain rows (PostgreSQL evaluates a WITH query only as far as it is
//           read: a longer chain is never walked further);
//   info    n, nr = distinct recruiters linked on it, rid, top;  up = the UNION ALL walk bounded by n, read
//           only when nr > 1 on a chain with a top (a legacy nested link): the topmost = the highest k.
// `mine` = owner(parent) is THIS recruiter (no other recruiter id is returned): nr = 1 → that recruiter;
// nr > 1 with a top → the topmost link's recruiter; nr > 1 on a parent cycle → NULL (an ambiguous cycle,
// refused). Accepted only when 1 ≤ n ≤ ANCESTRY_MAX (a chain longer than ANCESTRY_MAX is refused) and
// mine: the parent is then a member of N(R) (owner(parent) = R) — at any depth, also below a nested legacy
// link of another recruiter; never inside another recruiter's network, even below a legacy link to R.
// Unlinked ancestors (affiliates invited by another affiliate, e.g. created by an admin) are crossed. A
// dangling parentId (no affiliate row) or a chain without any link is refused.
// Runs on `tx`, i.e. inside the caller's transaction, after its recruiter row lock.
async function parentInNetwork(tx, recruiterId, parentId) {
  const cap = RECRUITER_AFFILIATE_LIMITS.ANCESTRY_MAX + 1;
  const rows = await tx.$queryRaw`
    /* recruiter-ancestry */
    WITH RECURSIVE chain AS (
      SELECT a."id", a."parentId", l."recruiterId" AS rid,
             NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
      FROM "affiliates" a
      LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
      WHERE a."id" = ${parentId}::text
      UNION
      SELECT p."id", p."parentId", p.rid, p.top
      FROM chain c
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId", l."recruiterId" AS rid,
               NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
        FROM "affiliates" a
        LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
        WHERE a."id" = c."parentId"
        OFFSET 0
      ) p
    ),
    capped AS (
      SELECT c."id", c.rid, c.top FROM chain c LIMIT ${cap}::int
    ),
    info AS (
      SELECT count(*)::int AS n, count(DISTINCT c.rid)::int AS nr, min(c.rid) AS rid, bool_or(c.top) AS top
      FROM capped c
    ),
    up AS (
      SELECT a."id", a."parentId", l."recruiterId" AS rid, 1 AS k
      FROM "affiliates" a
      LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
      WHERE a."id" = ${parentId}::text
      UNION ALL
      SELECT p."id", p."parentId", p.rid, u.k + 1
      FROM up u
      CROSS JOIN LATERAL (
        SELECT a."id", a."parentId", l."recruiterId" AS rid
        FROM "affiliates" a
        LEFT JOIN "recruiter_affiliate_links" l ON l."affiliateId" = a."id"
        WHERE a."id" = u."parentId"
        OFFSET 0
      ) p
      WHERE u.k < (SELECT i.n FROM info i)
    )
    SELECT i.n,
           CASE WHEN i.nr = 1 THEN i.rid = ${recruiterId}::text
                WHEN i.nr > 1 AND i.top THEN (SELECT u.rid = ${recruiterId}::text FROM up u WHERE u.rid IS NOT NULL ORDER BY u.k DESC LIMIT 1)
           END AS mine
    FROM info i`;
  const r = Array.isArray(rows) ? rows[0] : null;
  const n = Number(r?.n ?? 0);
  return n >= 1 && n <= RECRUITER_AFFILIATE_LIMITS.ANCESTRY_MAX && r?.mine === true;
}
async function assertAncestryInNetwork(tx, recruiterId, parentId) {
  if (!(await parentInNetwork(tx, recruiterId, parentId))) throw fail('PARENT_NOT_IN_NETWORK');
}

/**
 * Recruiter: create an affiliate (inactive) in their own network.
 * → { row, networkIds, replayed, activation: { code, expiresAt } | null (replay) } ; throws UNAUTHORIZED / RECRUITER_DISABLED / FORBIDDEN /
 * INVALID_INPUT (with fields) / PARENT_NOT_IN_NETWORK / USERNAME_TAKEN / PHONE_TAKEN /
 * IDEMPOTENCY_CONFLICT.
 */
export async function recruiterCreateAffiliate(recruiterId, input, { db = prisma, now = new Date(), newId = randomUUID } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const { value: v, fields } = validateRecruiterAffiliateInput(input);
  if (fields) throw fail('INVALID_INPUT', { fields });
  // An unusable random password (nobody knows it): the affiliate sets their own with the
  // activation code. Hashed outside the transaction (slow).
  const passwordHash = await unusablePasswordHash();
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
        // The code was returned once with the first response; only its hash exists now.
        return { row, networkIds: await networkIdSet(tx, recruiterId, [row.parentId]), replayed: true, activation: null };
      }

      // 3. Parent: none, or a member of THIS recruiter's network N(R) (Stage F: topmost link = this recruiter).
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
      const activation = await issueActivationCode(tx, { affiliateId: id, passwordHash, createdByType: 'RECRUITER', createdById: recruiterId, now });
      await tx.recruiterAuditLog.create({
        data: {
          recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'AFFILIATE_CREATED', entityType: 'affiliate', entityId: id,
          details: { requestId: v.requestId, username: v.username, parentId: v.parentId, activationCodeId: activation.id }, createdAt: now,
        },
      });
      const { isActive: _ignored, ...plain } = row;
      return {
        row: plain, networkIds: new Set(plain.parentId ? [plain.parentId] : []), replayed: false, // Stage E: the parent passed step 3
        activation: { code: activation.code, expiresAt: activation.expiresAt },
      };
    });
  } catch (e) {
    if (isUnique(e, 'username')) throw fail('USERNAME_TAKEN');
    if (isUnique(e, 'phone')) throw fail('PHONE_TAKEN');
    throw e;
  }
}
