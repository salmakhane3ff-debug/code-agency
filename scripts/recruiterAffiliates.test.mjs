#!/usr/bin/env node
/**
 * scripts/recruiterAffiliates.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 3: a recruiter creates affiliates in their OWN
 * network (POST / GET /api/recruiter/affiliates). In-memory fake database only
 * (scripts/lib/recruiterFakeDb.mjs, phase3 mode: affiliates, links, the Phase 1 link
 * trigger, the recruiter row lock, atomic transactions with READ COMMITTED visibility).
 * Proves:
 *   • root / child / grandchild creation: inactive row, link, one audit row, exact view
 *   • parent only from the recruiter's own network (another network, unlinked without an owner,
 *     unknown → the same PARENT_NOT_IN_NETWORK). Phase 7 Stage E (approved rule, documented pin
 *     updates marked "Stage E"): the network is N(R) — the parent's OWNER (the recruiter of the
 *     nearest linked affiliate at or above it) must be the recruiter: an affiliate invited below one
 *     of its affiliates (admin-created, no link) is a valid parent, a nearer link to another recruiter
 *     refuses, a parent cycle without a link runs into the 10,000 cap and is refused
 *   • no assignment of an existing affiliate (strict body, trigger, no update path)
 *   • the parent can never change after creation (no PUT/PATCH/DELETE, idempotency conflict)
 *   • idempotency and concurrency: replays, one creation per requestId, unique usernames /
 *     phones across both columns, the recruiter row lock vs a concurrent admin disable
 *   • atomicity: an injected failure at any step leaves no affiliate, link or audit row
 *   • validation (boundaries, exact allowlisted field codes), rate limit, error hygiene
 *   • cross-recruiter isolation of the list and of the tokens
 *   • the admin affiliate creation and the affiliate auth flow are unchanged
 *   • Phase 6 part 5c: the ancestry check is ONE tagged `recruiter-ancestry` statement (run after
 *     the recruiter row lock, in the creation transaction); Stage E: its verdict equals an oracle of
 *     owner(parent) = R (≤ 10,000 nodes walked) on hand-built and randomized data, and every parent
 *     the former per-ancestor loop (loaded from git) accepted is still accepted; a nearest link
 *     10,000 nodes up passes, 10,001 fails; the number of database calls does not depend on the depth
 * Phase 7 Stage F (approved clarification, pins marked "Stage F"): the parent must be owned by the recruiter
 * under the TOPMOST-link rule (a parent cycle: the one recruiter of its links); the admin DELETE route and the
 * legacy controller additionally map AFFILIATE_HAS_CHILDREN → 409 (exact pinned diff versus 7e111e1).
 * Run: node scripts/recruiterAffiliates.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-affiliates-test-secret-not-real';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const { recruiterAffiliateHandlers, RECRUITER_CREATE_RATE } = await import('../src/lib/recruiterAffiliateRouteHandlers.js');
const S = await import('../src/lib/services/recruiterAffiliateService.js');
const RS = await import('../src/lib/services/recruiterService.js');
const V = await import('../src/lib/recruiterVisibility.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const { rateLimit: realRateLimit } = await import('../src/lib/rateLimit.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };

const T0 = new Date('2026-11-05T09:00:00.000Z');
const now = () => new Date(T0);
const noLimit = () => null;
const VIEW_KEYS = ['createdAt', 'id', 'name', 'parentId', 'username'];
// Phase 7 Stage B: a LIST item = the same five fields + activation status, identity status, level / parent in the
// downline, linkedToMe (Stage E: directly recruited — information; the list holds N(R)), progress and the latest individual reward cycle (additive).
const LIST_ITEM_KEYS = ['createdAt', 'id', 'identityStatus', 'level', 'linkedToMe', 'name', 'parent', 'parentId', 'progress', 'rewardState', 'status', 'username'];
const RATE_KEY = ['commission', 'Rate'].join(''); // an admin-only field name, built from parts

const recruiterToken = (id, username = 'x') => signToken({ recruiterId: id, username, type: 'recruiter' });
const req = (url, { method = 'GET', body, cookie, bearer, raw, ip } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (ip) headers['x-forwarded-for'] = ip;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
};
const call = async (handler, r) => {
  const res = await handler(r, {});
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, cache: res.headers.get('cache-control') };
};

/** One fake db (phase 3) with two active recruiters A and B, and the route-shaped handlers. */
function setup({ rateLimit = noLimit, failOnce = {}, newId, invalidateTeam } = {}) {
  const hookBox = { fn: null };
  // Phase 7 Stage B: phase5 — the list (GET) also reads the downline placement, identity / order counts, settings and ledger
  const db = makeRecruiterFakeDb({ phase5: true, failOnce, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  const invalidated = [];
  const h = recruiterAffiliateHandlers({ db, now, rateLimit, invalidateTeam: invalidateTeam || ((id) => invalidated.push(id)), ...(newId ? { newId } : {}) });
  return { db, A, B, invalidated, hookBox, create: withRecruiterAuth(h.createAffiliate), list: withRecruiterAuth(h.affiliates) };
}
const cookieOf = (rec) => `recruiter_token=${recruiterToken(rec.id, rec.username)}`;
const post = (E, rec, body, extra = {}) => call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body, cookie: cookieOf(rec), ...extra }));
const get = (E, rec, q) => call(E.list, req(`/api/recruiter/affiliates${q !== undefined ? `?q=${encodeURIComponent(q)}` : ''}`, { cookie: cookieOf(rec) }));
let uniq = 0;
// Phase 6 part 1: the recruiter never sends a password (the affiliate sets it with the activation code).
const mk = (over = {}) => ({ username: `aff${++uniq}x`, name: `Affilié ${uniq}`, requestId: randomUUID(), ...over });
const counts = (db) => ({ aff: db._tables.affiliate.length, links: db._tables.recruiterAffiliateLink.length, audit: db._tables.recruiterAuditLog.length, codes: db._tables.affiliateActivationCode.length });
const plus1 = (b) => ({ aff: b.aff + 1, links: b.links + 1, audit: b.audit + 1, codes: b.codes + 1 });
const CODE_RE = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/;
const errorBodyOk = (b) => b && typeof b === 'object' && (eq(keys(b), ['code']) || eq(keys(b), ['code', 'fields'])) && !('message' in b) && !('error' in b);
const allErrorBodies = [];
const track = (r) => { if (r.status >= 400) allErrorBodies.push(r); return r; };

// ── 1. creation ───────────────────────────────────────────────────────────────
console.log('\n1. Creation: a root affiliate, a child and a grandchild');
{
  const E = setup();
  let createData = null;
  E.hookBox.fn = (m, o, a) => { if (m === 'affiliate' && o === 'create') createData = a.data; };
  const body = mk({ username: '  Amina.B ', name: '  Amina   Benali ', phone: '06 12-34.56.78' });
  const r = await post(E, E.A, body);
  const row = E.db._tables.affiliate[0];
  ok('root creation → 201, no-store, { affiliate, replayed:false, activation }', r.status === 201 && r.body.replayed === false && eq(keys(r.body), ['activation', 'affiliate', 'replayed']) && /no-store/.test(r.cache || ''), r.text);
  ok('the activation is exactly { code, expiresAt }: a selector.verifier code, expiring 24 h after the creation',
    eq(keys(r.body.activation), ['code', 'expiresAt']) && CODE_RE.test(r.body.activation.code) && r.body.activation.expiresAt === new Date(T0.getTime() + 24 * 3600 * 1000).toISOString(), JSON.stringify(r.body.activation));
  ok('the view is exactly id, username, name, parentId, createdAt (no password / hash / phone / isActive / amount)',
    eq(keys(r.body.affiliate), VIEW_KEYS) && r.body.affiliate.parentId === null && r.body.affiliate.username === 'amina.b' && r.body.affiliate.name === 'Amina Benali'
    && r.body.affiliate.id === row.id && !/password|\$2[aby]\$|0612345678|isActive|commission|balance/i.test(r.text), r.text);
  ok('the stored row is INACTIVE, lower-cased username, collapsed name, normalised phone, root',
    row.isActive === false && row.username === 'amina.b' && row.name === 'Amina Benali' && row.phone === '0612345678' && row.parentId === null);
  ok('the password is an UNUSABLE random bcrypt hash (cost 12): it matches neither the old recruiter-chosen value, nor empty, nor the activation code',
    /^\$2[aby]\$12\$.{53}$/.test(row.password) && !bcrypt.compareSync('Secret123', row.password) && !bcrypt.compareSync('', row.password) && !bcrypt.compareSync(r.body.activation.code, row.password));
  const codeRow = E.db._tables.affiliateActivationCode[0];
  ok('one activation-code row for this affiliate: hash only (never the code), created by recruiter A, active, 0 attempts',
    E.db._tables.affiliateActivationCode.length === 1 && codeRow.affiliateId === row.id && codeRow.createdByType === 'RECRUITER' && codeRow.createdById === E.A.id
    && codeRow.usedAt === null && codeRow.invalidatedAt === null && codeRow.failedAttempts === 0 && /^[0-9a-f]{64}$/.test(codeRow.verifierHash)
    && codeRow.selector === r.body.activation.code.split('.')[0] && !JSON.stringify(E.db._tables.affiliateActivationCode).includes(r.body.activation.code.split('.')[1]));
  ok('the create data holds ONLY id, name, username, password, phone, isActive (database defaults for every other column; no admin-only field)',
    eq(keys(createData), ['id', 'isActive', 'name', 'password', 'phone', 'username']) && createData.isActive === false, JSON.stringify(keys(createData)));
  const link = E.db._tables.recruiterAffiliateLink[0];
  ok('one recruiter_affiliate_links row: this affiliate → recruiter A, createdBy A', E.db._tables.recruiterAffiliateLink.length === 1 && link.affiliateId === row.id && link.recruiterId === E.A.id && link.createdBy === E.A.id);
  const aud = E.db._tables.recruiterAuditLog;
  ok('one AFFILIATE_CREATED audit row (recruiter actor, entity = the affiliate, details requestId / username / parentId null, the clock time)',
    aud.length === 1 && aud[0].action === 'AFFILIATE_CREATED' && aud[0].actorType === 'RECRUITER' && aud[0].actorId === E.A.id && aud[0].recruiterId === E.A.id
    && aud[0].entityType === 'affiliate' && aud[0].entityId === row.id && eq(aud[0].details, { requestId: body.requestId, username: 'amina.b', parentId: null, activationCodeId: codeRow.id })
    && new Date(aud[0].createdAt).getTime() === T0.getTime(), JSON.stringify(aud[0], (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  ok('the audit row never contains the activation code (only the code row id)', !JSON.stringify(aud, (k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(r.body.activation.code.split('.')[1]));
  ok('the audit row is visible to recruiter A only (toRecruiterAuditView)', eq(V.toRecruiterAuditView(aud[0], E.A.id), { action: 'AFFILIATE_CREATED', entityId: row.id, createdAt: T0.toISOString() }) && V.toRecruiterAuditView(aud[0], E.B.id) === null);
  ok('a root creation invalidates no team cache', E.invalidated.length === 0);
  ok('one transaction per creation, the recruiter row lock first',
    E.db._log.filter((l) => l.model === '$transaction').length === 1 && E.db._log.findIndex((l) => l.model === '$queryRaw') === E.db._log.findIndex((l) => l.model === '$transaction') + 1);

  const c = await post(E, E.A, mk({ username: 'child.one', parentId: row.id }));
  const childRow = E.db._tables.affiliate.find((x) => x.username === 'child.one');
  ok('child under an authorized parent → 201, parentId = the parent (in the view and the row)', c.status === 201 && c.body.affiliate.parentId === row.id && childRow.parentId === row.id && childRow.isActive === false, c.text);
  ok('the parent\'s team cache is invalidated with the parent id', eq(E.invalidated, [row.id]));
  const g = await post(E, E.A, mk({ username: 'grand.child', parentId: childRow.id }));
  ok('grandchild under the child → 201, parentId = the child', g.status === 201 && g.body.affiliate.parentId === childRow.id && eq(E.invalidated, [row.id, childRow.id]), g.text);
  ok('3 affiliates, 3 links (all recruiter A), 3 audit rows, 3 activation codes', eq(counts(E.db), { aff: 3, links: 3, audit: 3, codes: 3 }) && E.db._tables.recruiterAffiliateLink.every((l) => l.recruiterId === E.A.id));

  const E2 = setup({ invalidateTeam: () => { throw new Error('cache down'); } });
  const p = await post(E2, E2.A, mk());
  const ch = await post(E2, E2.A, mk({ parentId: p.body.affiliate.id }));
  ok('a failing team-cache invalidation never fails the (committed) creation', ch.status === 201 && E2.db._tables.affiliate.length === 2, ch.text);
}

// ── 2. parent checks ─────────────────────────────────────────────────────────
console.log('\n2. Parent: only from the recruiter\'s own network');
{
  const E = setup();
  const b1 = await post(E, E.B, mk({ username: 'b.one' }));
  const unlinked = E.db._seed.affiliate({ username: 'admin.made', name: 'Admin Made', isActive: true });
  const before = counts(E.db);
  const other = track(await post(E, E.A, mk({ parentId: b1.body.affiliate.id })));
  const unl = track(await post(E, E.A, mk({ parentId: unlinked.id })));
  const ghost = track(await post(E, E.A, mk({ parentId: randomUUID() })));
  ok('another recruiter\'s affiliate as parent → 400 PARENT_NOT_IN_NETWORK', other.status === 400 && eq(other.body, { code: 'PARENT_NOT_IN_NETWORK' }), other.text);
  ok('an unlinked (admin-created) affiliate as parent → 400 PARENT_NOT_IN_NETWORK', unl.status === 400 && eq(unl.body, { code: 'PARENT_NOT_IN_NETWORK' }), unl.text);
  ok('an unknown parent id → the SAME status and body (no enumeration)', ghost.status === other.status && ghost.text === other.text && unl.text === other.text);
  ok('nothing written by the refused creations (no affiliate, link or audit row)', eq(counts(E.db), before));
  const badFmt = track(await post(E, E.A, mk({ parentId: 'bad id!' })));
  ok('a malformed parent id → 400 INVALID_INPUT with fields.parentId INVALID_PARENT only', badFmt.status === 400 && eq(badFmt.body, { code: 'INVALID_INPUT', fields: { parentId: 'INVALID_PARENT' } }), badFmt.text);
  const bOwn = await post(E, E.B, mk({ parentId: b1.body.affiliate.id }));
  ok('recruiter B can use their own affiliate as parent (the check is per recruiter, not global)', bOwn.status === 201 && bOwn.body.affiliate.parentId === b1.body.affiliate.id, bOwn.text);
  // Stage E: an affiliate invited below a recruiter's affiliate (admin-created, no link) is in its network N(R).
  const a1 = await post(E, E.A, mk({ username: 'a.one' }));
  const invited = E.db._seed.affiliate({ username: 'admin.child', name: 'Admin Child', parentId: a1.body.affiliate.id });
  const invited2 = E.db._seed.affiliate({ username: 'admin.grand', name: 'Admin Grand', parentId: invited.id });
  const underB = E.db._seed.affiliate({ username: 'admin.underb', name: 'Under B', parentId: b1.body.affiliate.id });
  const viaInvited = await post(E, E.A, mk({ parentId: invited2.id }));
  ok('Stage E: an admin-created affiliate two levels below A\'s affiliate (no link of its own) → a valid parent for A (201), its id shown',
    viaInvited.status === 201 && viaInvited.body.affiliate.parentId === invited2.id, viaInvited.text);
  const before2 = counts(E.db);
  const bInvited = track(await post(E, E.A, mk({ parentId: underB.id })));
  const aByB = track(await post(E, E.B, mk({ parentId: invited.id })));
  ok('Stage E: … but an admin-created affiliate below B\'s is B\'s (A → PARENT_NOT_IN_NETWORK), and A\'s invited one is refused to B; nothing written',
    eq(bInvited.body, { code: 'PARENT_NOT_IN_NETWORK' }) && eq(aByB.body, { code: 'PARENT_NOT_IN_NETWORK' }) && bInvited.text === other.text && eq(counts(E.db), before2), `${bInvited.text} ${aByB.text}`);
}

// ── 3. no assignment of an existing affiliate ────────────────────────────────
console.log('\n3. An existing affiliate can never be assigned to a recruiter');
{
  const E = setup();
  const existing = E.db._seed.affiliate({ username: 'old.timer', name: 'Old Timer' });
  const before = counts(E.db);
  const extraKeys = [['id', existing.id], ['affiliateId', existing.id], ['isActive', true], [RATE_KEY, 0.9], ['recruiterId', E.B.id], ['parent', { connect: { id: existing.id } }], ['goalOrders', 3]];
  let allRefused = true;
  for (const [k, v] of extraKeys) {
    const r = track(await post(E, E.A, { ...mk(), [k]: v }));
    if (!(r.status === 400 && eq(r.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } }))) { allRefused = false; console.log('     ↳', k, r.status, r.text); }
  }
  ok('a body with id / affiliateId / isActive / the rate / recruiterId / parent / goalOrders → 400 INVALID_INPUT fields.body UNKNOWN_FIELD (refused, never ignored)', allRefused);
  ok('nothing written by those requests; the existing affiliate is unchanged and unlinked',
    eq(counts(E.db), before) && E.db._tables.recruiterAffiliateLink.every((l) => l.affiliateId !== existing.id) && eq(E.db._tables.affiliate.find((x) => x.id === existing.id), { ...existing, createdAt: E.db._tables.affiliate.find((x) => x.id === existing.id).createdAt, updatedAt: E.db._tables.affiliate.find((x) => x.id === existing.id).updatedAt }));

  // The database backstop (Phase 1 trigger) — emulated by the fake, exercised directly.
  let inTx = null;
  try { await E.db.$transaction((tx) => tx.recruiterAffiliateLink.create({ data: { affiliateId: existing.id, recruiterId: E.A.id, createdBy: E.A.id } })); } catch (e) { inTx = e; }
  let autocommit = null;
  try { await E.db.recruiterAffiliateLink.create({ data: { affiliateId: existing.id, recruiterId: E.A.id, createdBy: E.A.id } }); } catch (e) { autocommit = e; }
  ok('trigger: linking a pre-existing affiliate is refused (inside a transaction and in autocommit)', /only be linked/.test(inTx?.message || '') && /only be linked/.test(autocommit?.message || '') && E.db._tables.recruiterAffiliateLink.length === 0);
  let committedEarlier = null;
  const fresh = await E.db.$transaction((tx) => tx.affiliate.create({ data: { username: 'fresh.one', name: 'F', isActive: false } }));
  try { await E.db.$transaction((tx) => tx.recruiterAffiliateLink.create({ data: { affiliateId: fresh.id, recruiterId: E.A.id, createdBy: E.A.id } })); } catch (e) { committedEarlier = e; }
  let active = null;
  try { await E.db.$transaction(async (tx) => { const a = await tx.affiliate.create({ data: { username: 'act.one', name: 'A', isActive: true } }); await tx.recruiterAffiliateLink.create({ data: { affiliateId: a.id, recruiterId: E.A.id, createdBy: E.A.id } }); }); } catch (e) { active = e; }
  ok('trigger: an affiliate created in an EARLIER transaction, or an ACTIVE one, is refused too', /only be linked/.test(committedEarlier?.message || '') && /only be linked/.test(active?.message || '') && !E.db._tables.affiliate.some((x) => x.username === 'act.one'));

  const svc = stripJs(read('src/lib/services/recruiterAffiliateService.js'));
  ok('service: the link\'s affiliateId is ONLY the server-generated id of the row created in that transaction',
    /const id = newId\(\);/.test(svc) && /tx\.affiliate\.create\(\{\s*data: \{ id, /.test(svc)
    && /tx\.recruiterAffiliateLink\.create\(\{ data: \{ affiliateId: id, recruiterId, createdBy: recruiterId \} \}\)/.test(svc)
    && (svc.match(/recruiterAffiliateLink\.create\(/g) || []).length === 1 && /row\.id !== id \|\| row\.isActive !== false/.test(svc));
  ok('service: the strict body allowlist is exactly username, name, phone, parentId, requestId (Phase 6: NO password)',
    /const ALLOWED_FIELDS = new Set\(\['username', 'name', 'phone', 'parentId', 'requestId'\]\);/.test(svc));
  ok('service: the new affiliate gets an unusable random password and its activation code in the SAME transaction',
    /const passwordHash = await unusablePasswordHash\(\);/.test(svc) && /password: passwordHash/.test(svc) && /await issueActivationCode\(tx, \{ affiliateId: id, passwordHash, createdByType: 'RECRUITER', createdById: recruiterId, now \}\)/.test(svc) && !/v\.password|hashPassword/.test(svc));
}

// ── 4. the parent never changes after creation ───────────────────────────────
console.log('\n4. The parent can never change after creation');
{
  const route = stripJs(read('src/app/api/recruiter/affiliates/route.js'));
  const exported = [...route.matchAll(/export\s+(?:const|async\s+function|function)\s+([A-Z]+)\b/g)].map((m) => m[1]).sort();
  ok('the route exports only GET and POST (no PUT / PATCH / DELETE)', eq(exported, ['GET', 'POST']) && !/export\s*\{/.test(route), exported.join(','));

  const E = setup();
  const p1 = await post(E, E.A, mk({ username: 'par.one' }));
  const p2 = await post(E, E.A, mk({ username: 'par.two' }));
  const body = mk({ username: 'kid.one', parentId: p1.body.affiliate.id });
  const first = await post(E, E.A, body);
  const before = counts(E.db);
  const moved = track(await post(E, E.A, { ...body, parentId: p2.body.affiliate.id }));
  const toRoot = track(await post(E, E.A, { ...body, parentId: null }));
  const renamed = track(await post(E, E.A, { ...body, username: 'kid.other' }));
  const otherName = track(await post(E, E.A, { ...body, name: 'Another Name' }));
  const otherPhone = track(await post(E, E.A, { ...body, phone: '+212611112222' }));
  const kid = E.db._tables.affiliate.find((x) => x.id === first.body.affiliate.id);
  const conflicts = [moved, toRoot, renamed, otherName, otherPhone];
  ok('the same requestId with another parent / no parent / another username / another name / another phone → 409 IDEMPOTENCY_CONFLICT',
    conflicts.every((r) => r.status === 409 && eq(r.body, { code: 'IDEMPOTENCY_CONFLICT' })), conflicts.map((r) => r.text).join(' | '));
  const replay = await post(E, E.A, body);
  ok('the exact same payload still replays (200, same id, no phone in the view)',
    replay.status === 200 && replay.body.replayed === true && replay.body.affiliate.id === first.body.affiliate.id && !('phone' in replay.body.affiliate), replay.text);
  ok('the parent is unchanged and nothing was written', kid.parentId === p1.body.affiliate.id && eq(counts(E.db), before));
  const again = await post(E, E.A, mk({ username: 'kid.one', parentId: p2.body.affiliate.id }));
  ok('re-creating the same username under another parent → 409 USERNAME_TAKEN (no re-parenting through creation)', again.status === 409 && eq(again.body, { code: 'USERNAME_TAKEN' }) && kid.parentId === p1.body.affiliate.id, again.text);

  // static: no recruiter file under src can change an existing affiliate
  const walk = (dir) => readdirSync(join(ROOT, dir), { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(join(ROOT, f)).isFile());
  const files = [...new Set([...walk('src/app/api/recruiter'), ...walk('src/app/recruiter'), ...walk('src/lib').filter((f) => /recruiter/i.test(f.split(sep).pop()))])]
    .filter((f) => /\.(m?[jt]sx?)$/.test(f));
  const offenders = files.filter((f) => /\baffiliate\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b|parent\s*:\s*\{\s*(connect|disconnect|set)|UPDATE\s+"?affiliates"?/i.test(stripJs(read(f))));
  ok(`no recruiter file under src (${files.length} scanned) updates / upserts / deletes an affiliate or connects a parent`, files.length >= 10 && offenders.length === 0, offenders.join(', '));
  ok('the service performs no update / upsert / delete on ANY model', !/\.(update|updateMany|upsert|delete|deleteMany)\s*\(/.test(stripJs(read('src/lib/services/recruiterAffiliateService.js'))));
}

// ── 5. self-parenting and cycles ─────────────────────────────────────────────
console.log('\n5. Self-parenting is rejected; cycles never loop (Stage F: decided by the topmost link / the cycle rule)');
{
  const E0 = setup();
  const p = await post(E0, E0.A, mk({ username: 'self.par' }));
  const Eself = setup({ newId: () => p.body.affiliate.id });
  Eself.db._tables.affiliate.push(...E0.db._tables.affiliate.map((x) => structuredClone(x)));
  Eself.db._tables.recruiterAffiliateLink.push(...E0.db._tables.recruiterAffiliateLink.map((x) => ({ ...structuredClone(x), recruiterId: Eself.A.id, createdBy: Eself.A.id })));
  const before = counts(Eself.db);
  const self = track(await post(Eself, Eself.A, mk({ parentId: p.body.affiliate.id })));
  ok('a generated id equal to the parent id (self-parenting) → refused (500 SERVER_ERROR), nothing written', self.status === 500 && eq(self.body, { code: 'SERVER_ERROR' }) && eq(counts(Eself.db), before), self.text);

  const E = setup();
  const X = E.db._seed.affiliate({ username: 'cyc.x', name: 'X' });
  const Y = E.db._seed.affiliate({ username: 'cyc.y', name: 'Y', parentId: X.id });
  E.db._tables.affiliate.find((a) => a.id === X.id).parentId = Y.id; // corrupt: X → Y → X
  E.db._seed.link({ affiliateId: X.id, recruiterId: E.A.id });
  E.db._seed.link({ affiliateId: Y.id, recruiterId: E.A.id });
  // Stage F: X ⇄ Y are both linked to A — a parent cycle whose links are all A's is owned by A, so X is in N(A) (the
  // former loop refused the cycle; the cycle-safe walk ends after one lap).
  const cyc = track(await post(E, E.A, mk({ parentId: X.id })));
  ok('Stage F: a parent on a cycle (corrupt data X→Y→X) whose links are all A\'s → 201 (owned by A)', cyc.status === 201 && cyc.body.affiliate.parentId === X.id, cyc.text);
  const U1 = E.db._seed.affiliate({ username: 'ucyc.1', name: 'U1' });
  const U2 = E.db._seed.affiliate({ username: 'ucyc.2', name: 'U2', parentId: U1.id });
  E.db._tables.affiliate.find((a) => a.id === U1.id).parentId = U2.id; // corrupt: U1 → U2 → U1, no link
  const USelf = E.db._seed.affiliate({ username: 'uself', name: 'USelf' }); E.db._tables.affiliate.find((a) => a.id === USelf.id).parentId = USelf.id;
  const b1 = counts(E.db);
  const ucyc = track(await post(E, E.A, mk({ parentId: U2.id })));
  const uself = track(await post(E, E.A, mk({ parentId: USelf.id })));
  ok('Stage F: a parent on a cycle WITHOUT any link (and an unlinked self-parent) → PARENT_NOT_IN_NETWORK (no owner), nothing written',
    eq(ucyc.body, { code: 'PARENT_NOT_IN_NETWORK' }) && eq(uself.body, { code: 'PARENT_NOT_IN_NETWORK' }) && eq(counts(E.db), b1), `${ucyc.text} ${uself.text}`);

  const Q = E.db._seed.affiliate({ username: 'foreign.q', name: 'Q' });
  E.db._seed.link({ affiliateId: Q.id, recruiterId: E.B.id });
  const P = E.db._seed.affiliate({ username: 'mixed.p', name: 'P', parentId: Q.id });
  E.db._seed.link({ affiliateId: P.id, recruiterId: E.A.id });
  const U = E.db._seed.affiliate({ username: 'unlinked.u', name: 'U' });
  const P2 = E.db._seed.affiliate({ username: 'mixed.p2', name: 'P2', parentId: U.id });
  E.db._seed.link({ affiliateId: P2.id, recruiterId: E.A.id });
  const P3 = E.db._seed.affiliate({ username: 'dangling.p3', name: 'P3', parentId: randomUUID() });
  E.db._seed.link({ affiliateId: P3.id, recruiterId: E.A.id });
  const mixed = track(await post(E, E.A, mk({ parentId: P.id })));
  const mixed2 = track(await post(E, E.A, mk({ parentId: P2.id })));
  const dangling = track(await post(E, E.A, mk({ parentId: P3.id })));
  // Stage F: the TOPMOST link decides — P's own (legacy) link to A sits inside B's network (Q is above it): B's member.
  ok('Stage F: an A-linked (legacy) parent under ANOTHER recruiter\'s affiliate → PARENT_NOT_IN_NETWORK (the topmost link, B\'s, wins)', eq(mixed.body, { code: 'PARENT_NOT_IN_NETWORK' }), mixed.text);
  ok('Stage E: an A-linked parent under an UNLINKED node or with a dangling parent id → 201', mixed2.status === 201 && dangling.status === 201, `${mixed2.text} ${dangling.text}`);
  const Ui = E.db._seed.affiliate({ username: 'inv.under.q', name: 'Ui', parentId: Q.id });       // unlinked under B's Q → B's
  const Ud = E.db._seed.affiliate({ username: 'inv.dangling', name: 'Ud', parentId: randomUUID() }); // unlinked, dangling parent → no owner
  const Ue = E.db._seed.affiliate({ username: 'inv.empty', name: 'Ue', parentId: '' });             // unlinked, '' parent → no owner
  const b2 = counts(E.db);
  const r1 = track(await post(E, E.A, mk({ parentId: Ui.id })));
  const r2 = track(await post(E, E.A, mk({ parentId: Ud.id })));
  const r3 = track(await post(E, E.A, mk({ parentId: Ue.id })));
  ok('Stage F: an UNLINKED parent whose topmost link is another recruiter\'s, or with no link above (dangling / \'\' parent) → PARENT_NOT_IN_NETWORK',
    [r1, r2, r3].every((r) => eq(r.body, { code: 'PARENT_NOT_IN_NETWORK' })), [r1, r2, r3].map((r) => r.text).join(' '));
  ok('nothing written by the refused ancestry checks', eq(counts(E.db), b2));

  let prev = null;
  for (let i = 0; i < 40; i++) {
    const n = E.db._seed.affiliate({ username: `deep.${i}`, name: `D${i}`, parentId: prev });
    E.db._seed.link({ affiliateId: n.id, recruiterId: E.A.id });
    prev = n.id;
  }
  const deep = await post(E, E.A, mk({ parentId: prev }));
  ok('a legitimate 40-level chain inside the network → 201', deep.status === 201 && deep.body.affiliate.parentId === prev, deep.text);
}

// ── 6. duplicates and concurrency ────────────────────────────────────────────
console.log('\n6. Duplicates and concurrency');
{
  const E = setup();
  const par = await post(E, E.A, mk({ username: 'dup.parent' }));
  const body = mk({ username: 'dup.kid', parentId: par.body.affiliate.id });
  const r1 = await post(E, E.A, body);
  const r2 = await post(E, E.A, body);
  ok('the same requestId twice → 201 then 200 replayed:true with the identical view', r1.status === 201 && r2.status === 200 && r2.body.replayed === true && eq(r2.body.affiliate, r1.body.affiliate), r2.text);
  ok('the replay NEVER returns an activation code again (activation: null) — only its hash exists', r2.body.activation === null && CODE_RE.test(r1.body.activation?.code || '') && !r2.text.includes(r1.body.activation.code.split('.')[1]));
  ok('only 1 affiliate, 1 link, 1 audit row for that request; the team cache invalidated once', E.db._tables.affiliate.filter((x) => x.username === 'dup.kid').length === 1
    && E.db._tables.recruiterAffiliateLink.filter((l) => l.affiliateId === r1.body.affiliate.id).length === 1
    && E.db._tables.recruiterAuditLog.filter((a) => a.entityId === r1.body.affiliate.id).length === 1 && E.invalidated.filter((x) => x === par.body.affiliate.id).length === 1);
  const upper = await post(E, E.A, { ...body, requestId: body.requestId.toUpperCase() });
  ok('the requestId is case-insensitive (upper-case UUID replays too)', upper.status === 200 && upper.body.replayed === true && upper.body.affiliate.id === r1.body.affiliate.id, upper.text);
  const crossReplay = track(await post(E, E.B, body));
  ok('another recruiter re-using that requestId does NOT replay A\'s affiliate (parent not in B\'s network)', crossReplay.status === 400 && eq(crossReplay.body, { code: 'PARENT_NOT_IN_NETWORK' }), crossReplay.text);

  const before = counts(E.db);
  const same = mk({ username: 'conc.same' });
  const res = await Promise.all(Array.from({ length: 10 }, () => post(E, E.A, same)));
  const created = res.filter((r) => r.status === 201);
  const replays = res.filter((r) => r.status === 200 && r.body.replayed === true);
  ok('10 concurrent POSTs with the same requestId → exactly 1 created (201) and 9 replays of the same id',
    created.length === 1 && replays.length === 9 && replays.every((r) => r.body.affiliate.id === created[0].body.affiliate.id), res.map((r) => r.status).join(','));
  ok('… and exactly +1 affiliate, +1 link, +1 audit row, +1 activation code', eq(counts(E.db), plus1(before)));
  ok('only the created response carries the code; the 9 replays carry activation: null', CODE_RE.test(created[0]?.body?.activation?.code || '') && replays.every((x) => x.body.activation === null));

  const b2 = counts(E.db);
  const res2 = await Promise.all(Array.from({ length: 5 }, () => post(E, E.A, mk({ username: 'conc.user' }))));
  ok('5 concurrent POSTs, different requestIds, the same username → 1 created, 4 × 409 USERNAME_TAKEN',
    res2.filter((r) => r.status === 201).length === 1 && res2.filter((r) => r.status === 409 && eq(r.body, { code: 'USERNAME_TAKEN' })).length === 4 && eq(counts(E.db), plus1(b2)), res2.map((r) => r.status).join(','));
  const res3 = await Promise.all([post(E, E.A, mk({ username: 'conc.cross' })), post(E, E.B, mk({ username: 'conc.cross' }))]);
  ok('two recruiters concurrently, the same username → one 201, one 409 USERNAME_TAKEN', eq(res3.map((r) => r.status).sort(), [201, 409]) && E.db._tables.affiliate.filter((x) => x.username === 'conc.cross').length === 1);
  const res4 = await Promise.all([post(E, E.A, mk({ phone: '0699000001' })), post(E, E.B, mk({ phone: '0699000001' }))]);
  ok('two recruiters concurrently, the same phone → one 201, one 409 PHONE_TAKEN', eq(res4.map((r) => r.status).sort(), [201, 409]) && res4.some((r) => eq(r.body, { code: 'PHONE_TAKEN' })) && E.db._tables.affiliate.filter((x) => x.phone === '0699000001').length === 1);

  await post(E, E.A, mk({ username: 'phone.owner', phone: '0611223344' }));
  const dupPhone = track(await post(E, E.A, mk({ phone: '06 11 22 33 44' })));
  ok('a duplicate phone (after normalisation) → 409 PHONE_TAKEN', dupPhone.status === 409 && eq(dupPhone.body, { code: 'PHONE_TAKEN' }), dupPhone.text);
  const upperDup = track(await post(E, E.A, mk({ username: 'PHONE.OWNER' })));
  ok('a duplicate username in another case → 409 USERNAME_TAKEN', upperDup.status === 409 && eq(upperDup.body, { code: 'USERNAME_TAKEN' }));
  E.db._seed.affiliate({ username: 'phone.as.name', phone: 'karim77' });       // an existing phone that looks like a username
  E.db._seed.affiliate({ username: '0655443322', name: 'Numeric' });           // an existing (admin-made) numeric username
  const b3 = counts(E.db);
  const userIsPhone = track(await post(E, E.A, mk({ username: 'karim77' })));
  const phoneIsUser = track(await post(E, E.A, mk({ phone: '0655443322' })));
  ok('a username equal to an existing affiliate\'s PHONE → 409 USERNAME_TAKEN (the login accepts either)', userIsPhone.status === 409 && eq(userIsPhone.body, { code: 'USERNAME_TAKEN' }), userIsPhone.text);
  ok('a phone equal to an existing affiliate\'s USERNAME → 409 PHONE_TAKEN', phoneIsUser.status === 409 && eq(phoneIsUser.body, { code: 'PHONE_TAKEN' }), phoneIsUser.text);
  ok('nothing written by the refused duplicates', eq(counts(E.db), b3));
}

// ── 7. atomicity ─────────────────────────────────────────────────────────────
console.log('\n7. A failed transaction leaves no partial affiliate, link or audit row');
{
  const cases = [
    ['the link insert', { 'recruiterAffiliateLink.create': new Error('link insert failed (injected)') }, 500, 'SERVER_ERROR'],
    ['the audit insert', { 'recruiterAuditLog.create': new Error('audit insert failed (injected)') }, 500, 'SERVER_ERROR'],
    ['the recruiter row lock', { '$queryRaw.query': new Error('lock timeout (injected)') }, 500, 'SERVER_ERROR'],
    ['the affiliate insert (P2002 username — unique backstop)', { 'affiliate.create': Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['username'] } }) }, 409, 'USERNAME_TAKEN'],
    ['the affiliate insert (P2002 phone — unique backstop)', { 'affiliate.create': Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['phone'] } }) }, 409, 'PHONE_TAKEN'],
    ['the link insert (P2002 on the link primary key)', { 'recruiterAffiliateLink.create': Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['affiliateId'] } }) }, 500, 'SERVER_ERROR'],
    ['the activation-code insert (Phase 6)', { 'affiliateActivationCode.create': new Error('code insert failed (injected)') }, 500, 'SERVER_ERROR'],
  ];
  for (const [label, failOnce, status, code] of cases) {
    const E = setup({ failOnce });
    const par = E.db._seed.affiliate({ username: 'atom.par', name: 'P' });
    E.db._seed.link({ affiliateId: par.id, recruiterId: E.A.id });
    const before = counts(E.db);
    const r = track(await post(E, E.A, mk({ parentId: par.id, phone: '0677000000' })));
    const afterFail = counts(E.db);
    const cleanState = E.db._locks.size === 0 && E.db._openTx.size === 0;
    const retry = await post(E, E.A, mk({ username: 'atom.retry', parentId: par.id }));
    ok(`failure at ${label} → ${status} ${code}; no affiliate, link, audit or activation-code row; the lock is released (a retry succeeds)`,
      r.status === status && eq(r.body, { code }) && eq(afterFail, before) && cleanState && E.invalidated.length === 1
        && retry.status === 201 && eq(counts(E.db), plus1(before)),
      `${r.status} ${r.text} / after ${JSON.stringify(afterFail)} vs ${JSON.stringify(before)} / retry ${retry.status}`);
  }
  // A trigger refusal (the database backstop) also rolls back the affiliate row.
  const E = setup();
  const realCreate = E.db.affiliate.create;
  E.db.affiliate.create = async (args) => { const r = await realCreate(args); E.db._tables.affiliate.find((x) => x.id === r.id).isActive = true; return r; }; // corrupt: active at insert
  const before = counts(E.db);
  const r = track(await post(E, E.A, mk()));
  ok('a link refused by the database trigger (affiliate not inactive) → 500 SERVER_ERROR, the affiliate row rolled back', r.status === 500 && eq(r.body, { code: 'SERVER_ERROR' }) && eq(counts(E.db), before), r.text);
}

// ── 8. recruiter account state ───────────────────────────────────────────────
console.log('\n8. The recruiter account is re-checked on every request');
{
  const E = setup();
  const D = E.db._seed.recruiter({ username: 'rec.d', name: 'Disabled', isActive: false, disabledAt: new Date(), disabledBy: 'admin-1' });
  const N = E.db._seed.recruiter({ username: 'rec.n', name: 'No create', canCreateAffiliates: false });
  const before = counts(E.db);
  const d = track(await post(E, D, mk()));
  const dl = track(await get(E, D));
  const n = track(await post(E, N, mk()));
  const ghostRec = { id: randomUUID(), username: 'ghost' };
  const g = track(await post(E, ghostRec, mk()));
  ok('a disabled recruiter → 403 RECRUITER_DISABLED (create and list)', d.status === 403 && eq(d.body, { code: 'RECRUITER_DISABLED' }) && dl.status === 403 && eq(dl.body, { code: 'RECRUITER_DISABLED' }), d.text + dl.text);
  ok('canCreateAffiliates = false → 403 FORBIDDEN', n.status === 403 && eq(n.body, { code: 'FORBIDDEN' }), n.text);
  ok('a valid token of a deleted / unknown recruiter → 401 UNAUTHORIZED', g.status === 401 && eq(g.body, { code: 'UNAUTHORIZED' }), g.text);
  ok('nothing written by those requests', eq(counts(E.db), before));

  // Race 1: disabled AFTER the handler check, BEFORE the transaction → the in-transaction lock re-check refuses.
  {
    const R = setup();
    let reached, go;
    const reachedP = new Promise((r) => { reached = r; });
    const goP = new Promise((r) => { go = r; });
    R.hookBox.fn = async (m) => { if (m === '$queryRaw') { R.hookBox.fn = null; reached(); await goP; } };
    const pending = post(R, R.A, mk());
    await reachedP;
    await RS.adminSetRecruiterActive(R.A.id, false, { db: R.db, actorId: 'admin-1', reason: 'race', now: now() });
    go();
    const r = track(await pending);
    ok('race: disabled between the handler check and the transaction → 403 RECRUITER_DISABLED from the in-transaction re-check, nothing created',
      r.status === 403 && eq(r.body, { code: 'RECRUITER_DISABLED' }) && R.db._tables.affiliate.length === 0 && R.db._tables.recruiterAffiliateLink.length === 0, r.text);
  }
  // Race 2: an admin disable during a creation waits for the creation's row lock.
  {
    const R = setup();
    let reached, go;
    const reachedP = new Promise((r) => { reached = r; });
    const goP = new Promise((r) => { go = r; });
    R.hookBox.fn = async (m, o) => { if (m === 'affiliate' && o === 'create') { R.hookBox.fn = null; reached(); await goP; } };
    const pending = post(R, R.A, mk({ username: 'race.two' }));
    await reachedP;
    let disabledDone = false;
    const disabling = RS.adminSetRecruiterActive(R.A.id, false, { db: R.db, actorId: 'admin-1', reason: 'race', now: now() }).then((x) => { disabledDone = true; return x; });
    await ticks(50);
    const waited = disabledDone === false && R.db._tables.recruiter.find((x) => x.id === R.A.id).isActive === true;
    go();
    const r = await pending;
    const dres = await disabling;
    const after = track(await post(R, R.A, mk()));
    ok('race: an admin disable during a creation waits for the creation\'s row lock (FOR NO KEY UPDATE), then applies', waited && r.status === 201 && dres.changed === true && R.db._tables.recruiter.find((x) => x.id === R.A.id).isActive === false, `${waited} ${r.status}`);
    ok('… and the next creation is refused (403 RECRUITER_DISABLED)', after.status === 403 && eq(after.body, { code: 'RECRUITER_DISABLED' }) && R.db._tables.affiliate.length === 1);
  }
}

// ── 9. validation and rate limit ─────────────────────────────────────────────
console.log('\n9. Validation (exact field codes) and rate limit');
{
  const vf = (over) => S.validateRecruiterAffiliateInput(mk(over)).fields || null;
  const okv = (over) => S.validateRecruiterAffiliateInput(mk(over)).value || null;
  ok('username: 3 and 30 chars valid; 2 and 31 invalid', !!okv({ username: 'abc' }) && !!okv({ username: 'a'.repeat(30) }) && eq(vf({ username: 'ab' }), { username: 'INVALID_USERNAME' }) && eq(vf({ username: 'a'.repeat(31) }), { username: 'INVALID_USERNAME' }));
  ok('username: must contain a letter, start alphanumeric, no spaces / symbols; trimmed and lower-cased',
    ['123456', '_abc', '.abc', 'a b c', 'abc!', 'abç', '', null, 42].every((u) => eq(vf({ username: u }), { username: 'INVALID_USERNAME' })) && okv({ username: '  Karim.B_1-x ' }).username === 'karim.b_1-x' && okv({ username: '1abc' }).username === '1abc');
  ok('name: 2 and 80 valid; 1 and 81 invalid; < > refused; spaces collapsed',
    !!okv({ name: 'Ab' }) && !!okv({ name: 'A'.repeat(80) }) && eq(vf({ name: 'A' }), { name: 'INVALID_NAME' }) && eq(vf({ name: 'A'.repeat(81) }), { name: 'INVALID_NAME' })
    && eq(vf({ name: '<b>Ali' }), { name: 'INVALID_NAME' }) && eq(vf({ name: '   ' }), { name: 'INVALID_NAME' }) && okv({ name: '  Ali   Ben  ' }).name === 'Ali Ben');
  ok('password (Phase 6): ANY password in the body is refused as an unknown field (the recruiter can never choose it); the value has no password key',
    ['12345678', 'x'.repeat(128), '', 12345678, null].every((pw) => eq(vf({ password: pw }), { body: 'UNKNOWN_FIELD' })) && !('password' in okv({})));
  ok('phone: optional (absent / null / blank → null); 8 and 15 digits valid; 7 and 16 invalid; + allowed; separators stripped; non-string invalid',
    okv({}).phone === null && okv({ phone: null }).phone === null && okv({ phone: '  ' }).phone === null && !!okv({ phone: '12345678' }) && !!okv({ phone: '1'.repeat(15) })
    && eq(vf({ phone: '1234567' }), { phone: 'INVALID_PHONE' }) && eq(vf({ phone: '1'.repeat(16) }), { phone: 'INVALID_PHONE' }) && okv({ phone: '+212 6.12-34-56-78' }).phone === '+212612345678'
    && eq(vf({ phone: 'abcdefgh' }), { phone: 'INVALID_PHONE' }) && eq(vf({ phone: 612345678 }), { phone: 'INVALID_PHONE' }));
  ok('parentId: absent / null / "" → root; malformed, 101 chars or non-string → INVALID_PARENT',
    okv({}).parentId === null && okv({ parentId: null }).parentId === null && okv({ parentId: '' }).parentId === null && okv({ parentId: 'a'.repeat(100) }).parentId === 'a'.repeat(100)
    && ['bad id!', 'a'.repeat(101), 42, { id: 'x' }, ['x']].every((p) => eq(vf({ parentId: p }), { parentId: 'INVALID_PARENT' })));
  ok('requestId: a UUID (any case, lower-cased) is required; missing / malformed → INVALID_REQUEST_ID',
    okv({ requestId: '0A1B2C3D-4E5F-4A1B-8C2D-3E4F5A6B7C8D' }).requestId === '0a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d'
    && [undefined, '', 'not-a-uuid', '0a1b2c3d4e5f4a1b8c2d3e4f5a6b7c8d', 42].every((q) => eq(vf({ requestId: q }), { requestId: 'INVALID_REQUEST_ID' })));
  ok('body: not an object (null / array / string / number) → fields.body UNKNOWN_FIELD only',
    [null, undefined, [], 'x', 42].every((b) => eq(S.validateRecruiterAffiliateInput(b), { fields: { body: 'UNKNOWN_FIELD' } })));
  ok('several invalid fields at once → every code at once (a password is just an unknown field now)', eq(S.validateRecruiterAffiliateInput({ username: 'x', name: '', password: '1', phone: 'p', parentId: '!', extra: 1 }).fields,
    { body: 'UNKNOWN_FIELD', username: 'INVALID_USERNAME', name: 'INVALID_NAME', phone: 'INVALID_PHONE', parentId: 'INVALID_PARENT', requestId: 'INVALID_REQUEST_ID' }));
  ok('every code the validator can produce is in the visibility allowlist for its field',
    [S.validateRecruiterAffiliateInput({ username: 'x', name: '', password: '1', phone: 'p', parentId: '!', extra: 1 }).fields].every((f) => Object.entries(f).every(([k, c]) => V.RECRUITER_FIELD_ERROR_CODES[k]?.includes(c))));

  const E = setup();
  const before = counts(E.db);
  const multi = track(await post(E, E.A, { username: 'x', name: 'A', password: '1', requestId: 'nope' }));
  ok('through the handler: 400 { code: INVALID_INPUT, fields } with exactly the failing fields', multi.status === 400 && eq(multi.body, { code: 'INVALID_INPUT', fields: { username: 'INVALID_USERNAME', name: 'INVALID_NAME', requestId: 'INVALID_REQUEST_ID', body: 'UNKNOWN_FIELD' } }), multi.text);
  const withPw = track(await post(E, E.A, { ...mk({ username: 'pw.chosen' }), password: 'Secret123' }));
  ok('a VALID creation body + a recruiter-chosen password → 400 INVALID_INPUT fields.body UNKNOWN_FIELD; nothing created (the old behaviour is gone)',
    withPw.status === 400 && eq(withPw.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } }) && !E.db._tables.affiliate.some((x) => x.username === 'pw.chosen'), withPw.text);
  const malformed = track(await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', raw: '{"username":', cookie: cookieOf(E.A) })));
  const empty = track(await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', raw: '', cookie: cookieOf(E.A) })));
  const arr = track(await post(E, E.A, [mk()]));
  ok('malformed JSON / empty body / an array → 400 INVALID_INPUT fields.body UNKNOWN_FIELD', [malformed, empty, arr].every((r) => r.status === 400 && eq(r.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } })), malformed.text + empty.text + arr.text);
  ok('nothing written by invalid requests; no transaction opened', eq(counts(E.db), before) && E.db._log.filter((l) => l.model === '$transaction').length === 0);

  const calls = [];
  const limiter = (r, key, opts) => { calls.push({ key, opts }); return calls.length >= 3 ? new Response('limited', { status: 429 }) : null; };
  const L = setup({ rateLimit: limiter });
  await post(L, L.A, mk()); await post(L, L.A, mk());
  const logLen = L.db._log.length;
  const b4 = counts(L.db);
  const limited = track(await post(L, L.A, mk()));
  ok('rate limited → 429 { code: RATE_LIMITED } (own body, never the limiter\'s text), nothing read or written', limited.status === 429 && eq(limited.body, { code: 'RATE_LIMITED' }) && L.db._log.length === logLen && eq(counts(L.db), b4), limited.text);
  ok('the limiter key includes the recruiter id; 20 per minute', calls.every((c) => c.key === `recruiter-create-affiliate:${L.A.id}`) && eq(calls[0].opts, { max: 20, windowMs: 60_000 }) && eq(RECRUITER_CREATE_RATE, { max: 20, windowMs: 60_000 }) && Object.isFrozen(RECRUITER_CREATE_RATE));

  const RL = setup({ rateLimit: realRateLimit });
  const ip = `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
  const seen = [];
  for (let i = 0; i < 21; i++) seen.push((await post(RL, RL.A, { bad: true }, { ip })).status);
  const otherRecruiter = await post(RL, RL.B, { bad: true }, { ip });
  ok('real limiter: 20 requests pass to validation (400), the 21st of the same recruiter + IP → 429; another recruiter on that IP is not limited',
    seen.slice(0, 20).every((s) => s === 400) && seen[20] === 429 && otherRecruiter.status === 400, seen.join(','));
}

// ── 10. the list (parent selector) ───────────────────────────────────────────
console.log('\n10. The network list is scoped to the recruiter');
{
  const E = setup();
  const a1 = await post(E, E.A, mk({ username: 'list.a1', name: 'Fatima Zahra' }));
  await post(E, E.A, mk({ username: 'list.a2', name: 'Youssef', parentId: a1.body.affiliate.id }));
  const b1 = await post(E, E.B, mk({ username: 'list.b1', name: 'Fatima B' }));
  E.db._seed.affiliate({ username: 'list.admin', name: 'Fatima Admin' });
  // creation order is the same millisecond: give distinct createdAt for a deterministic newest-first order
  E.db._tables.recruiterAffiliateLink.forEach((l, i) => { l.createdAt = new Date(T0.getTime() + i * 1000); });
  const la = await get(E, E.A);
  const lb = await get(E, E.B);
  ok('A sees exactly A\'s affiliates, newest first, with parentId inside the network', la.status === 200 && eq(la.body.affiliates.map((x) => x.username), ['list.a2', 'list.a1'])
    && la.body.affiliates[0].parentId === a1.body.affiliate.id && la.body.truncated === false && /no-store/.test(la.cache || ''), la.text);
  ok('B sees only B\'s affiliate (never A\'s, never the unlinked admin-made one)', eq(lb.body.affiliates.map((x) => x.username), ['list.b1']) && !lb.text.includes(a1.body.affiliate.id) && !lb.text.includes('list.admin'), lb.text);
  ok('every item is exactly id, username, name, parentId, createdAt + the Stage B fields (status, identityStatus, level, parent, linkedToMe, progress, rewardState); the page adds total / nextCursor',
    [...la.body.affiliates, ...lb.body.affiliates].every((x) => eq(keys(x), LIST_ITEM_KEYS)) && !/password|phone|isActive|\$2[aby]\$/.test(la.text + lb.text)
    && eq(keys(la.body), ['affiliates', 'nextCursor', 'total', 'truncated']) && la.body.total === 2 && la.body.nextCursor === null);
  const qa = await get(E, E.A, 'FATIMA');
  const qb = await get(E, E.A, 'list.b1');
  const qn = await get(E, E.A, 'youss');
  ok('?q= searches username / name (case-insensitive) inside the recruiter\'s network only', eq(qa.body.affiliates.map((x) => x.username), ['list.a1']) && qb.body.affiliates.length === 0 && eq(qn.body.affiliates.map((x) => x.username), ['list.a2']), qa.text + qb.text);
  const longQ = await get(E, E.A, 'x'.repeat(500));
  ok('a long ?q= is accepted (truncated) and still scoped', longQ.status === 200 && longQ.body.affiliates.length === 0);

  // corrupt data: an A-linked root whose parent is an unlinked (admin-made, unowned) affiliate → parentId projected as null
  const lone = E.db._seed.affiliate({ username: 'lone.admin', name: 'Lone' });
  const odd = E.db._seed.affiliate({ username: 'odd.child', name: 'Odd', parentId: lone.id, createdAt: new Date(Date.now() + 99_000) }); // the newest
  E.db._seed.link({ affiliateId: odd.id, recruiterId: E.A.id, createdAt: new Date(T0.getTime() + 99_000) });
  const lo = await get(E, E.A);
  ok('a parentId outside the recruiter\'s network is never shown (null)', lo.body.affiliates[0].username === 'odd.child' && lo.body.affiliates[0].parentId === null && !lo.text.includes(lone.id), lo.text);
  // Stage F: a legacy A link under B's affiliate belongs to B (topmost link): never in A's list, in B's list with its parent
  const legacy = E.db._seed.affiliate({ username: 'legacy.child', name: 'Legacy', parentId: b1.body.affiliate.id });
  E.db._seed.link({ affiliateId: legacy.id, recruiterId: E.A.id, createdAt: new Date(T0.getTime() + 98_000) });
  const lo2 = await get(E, E.A); const lb2 = await get(E, E.B);
  ok('Stage F: a legacy A link under B\'s affiliate is B\'s — absent from A\'s list, in B\'s list (parentId = B\'s affiliate, linkedToMe false)',
    !lo2.text.includes(legacy.id) && lb2.body.affiliates.some((x) => x.id === legacy.id && x.parentId === b1.body.affiliate.id && x.linkedToMe === false), lb2.text.slice(0, 300));

  const M = setup();
  // Stage E: the list = N(R), ordered by the AFFILIATE's createdAt (an invited member has no link row) — seeded
  // equal to its link's createdAt, as the creation writes both in one transaction.
  for (let i = 0; i < 55; i++) {
    const a = M.db._seed.affiliate({ username: `many.${i}`, name: `M${i}`, createdAt: new Date(T0.getTime() + i * 1000) });
    M.db._seed.link({ affiliateId: a.id, recruiterId: M.A.id, createdAt: new Date(T0.getTime() + i * 1000) });
  }
  const lm = await get(M, M.A);
  ok('at most 50 items, newest first, truncated:true when more exist', lm.body.affiliates.length === 50 && lm.body.truncated === true && lm.body.affiliates[0].username === 'many.54' && lm.body.affiliates[49].username === 'many.5');
  const M50 = setup();
  for (let i = 0; i < 50; i++) { const a = M50.db._seed.affiliate({ username: `fifty.${i}` }); M50.db._seed.link({ affiliateId: a.id, recruiterId: M50.A.id }); }
  const l50 = await get(M50, M50.A);
  ok('exactly 50 → truncated:false', l50.body.affiliates.length === 50 && l50.body.truncated === false);
  const writesBefore = E.db._log.filter((l) => /create|update|delete|upsert/.test(l.op)).length;
  await get(E, E.A); await get(E, E.B, 'x');
  ok('the list is read-only (no write, no transaction)', E.db._log.filter((l) => /create|update|delete|upsert/.test(l.op)).length === writesBefore);
}

// ── 11. tokens and route wiring ──────────────────────────────────────────────
console.log('\n11. Only a recruiter token (cookie) reaches these handlers');
{
  const E = setup();
  const before = counts(E.db);
  const logLen = E.db._log.length;
  const tokens = {
    admin: signToken({ userId: 'admin-1', email: 'admin@example.test', role: 'ADMIN' }),
    affiliate: signToken({ affiliateId: 'aff-1', username: 'aff', type: 'affiliate' }),
    foreignSecret: jwt.sign({ recruiterId: E.A.id, username: 'rec.a', type: 'recruiter' }, 'another-secret', { expiresIn: '1h' }),
    expired: jwt.sign({ recruiterId: E.A.id, username: 'rec.a', type: 'recruiter', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET),
  };
  const results = [];
  for (const [name, tok] of Object.entries(tokens)) {
    results.push([`${name} as recruiter_token (POST)`, track(await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body: mk(), cookie: `recruiter_token=${tok}` })))]);
    results.push([`${name} as recruiter_token (GET)`, track(await call(E.list, req('/api/recruiter/affiliates', { cookie: `recruiter_token=${tok}` })))]);
  }
  results.push(['admin auth_token cookie', track(await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body: mk(), cookie: `auth_token=${tokens.admin}` })))]);
  results.push(['affiliate_token cookie', track(await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body: mk(), cookie: `affiliate_token=${tokens.affiliate}` })))]);
  results.push(['recruiter token as Bearer (no cookie)', track(await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body: mk(), bearer: recruiterToken(E.A.id) })))]);
  results.push(['no credentials', track(await call(E.list, req('/api/recruiter/affiliates')))]);
  const bad = results.filter(([, r]) => !(r.status === 401 && eq(r.body, { code: 'UNAUTHORIZED' })));
  ok(`admin / affiliate / foreign-secret / expired tokens, other cookies, Bearer and no credentials → 401 UNAUTHORIZED (${results.length} cases)`, bad.length === 0, bad.map(([n, r]) => `${n}:${r.status}`).join(', '));
  ok('… and the database was never touched', eq(counts(E.db), before) && E.db._log.length === logLen);

  const route = stripJs(read('src/app/api/recruiter/affiliates/route.js'));
  ok('route.js: GET = withRecruiterAuth(h.affiliates), POST = withRecruiterAuth(h.createAffiliate); errors via recruiterVisibility.toRecruiterError',
    /export const GET = withRecruiterAuth\(h\.affiliates\);/.test(route) && /export const POST = withRecruiterAuth\(h\.createAffiliate\);/.test(route)
    && /import \{ toRecruiterError \} from '@\/lib\/recruiterVisibility';/.test(route) && /recruiterAffiliateHandlers\(\{ toRecruiterError, invalidateTeam: invalidateTeamCache \}\)/.test(route));
  const hnd = stripJs(read('src/lib/recruiterAffiliateRouteHandlers.js'));
  ok('the handlers access no model directly (only through the services) and re-check the account (requireActiveRecruiter) in both handlers',
    !/\b(?:db|tx|prisma)\s*\.\s*(?!\$transaction\b)[a-zA-Z$]+\s*\./.test(hnd.replace(/import[^\n]*\n/g, '')) && (hnd.match(/requireActiveRecruiter\(decoded, \{ db \}\)/g) || []).length === 2);
}

// ── 12. error hygiene ────────────────────────────────────────────────────────
console.log('\n12. Error hygiene');
{
  const E = setup({ failOnce: { 'recruiterAuditLog.findFirst': Object.assign(new Error('connection refused at 10.0.0.7:5432 password=hunter2'), { code: 'P1001' }) } });
  const origErr = console.error; const logged = []; console.error = (...a) => logged.push(a); // server-side log only
  const r = track(await post(E, E.A, mk()));
  console.error = origErr;
  ok('an unknown / internal error → 500 { code: SERVER_ERROR } without its message', r.status === 500 && eq(r.body, { code: 'SERVER_ERROR' }) && !/10\.0\.0\.7|hunter2|refused/.test(r.text), r.text);
  ok('the server log gets only the error code (never the message)', logged.length === 1 && logged[0][1] === 'P1001');
  ok(`every error response of this file (${allErrorBodies.length}) is { code } or { code, fields } — never message / error text`, allErrorBodies.length >= 40 && allErrorBodies.every((x) => errorBodyOk(x.body)), allErrorBodies.filter((x) => !errorBodyOk(x.body)).map((x) => x.text).join(' | '));
}

// ── 13. existing systems unchanged ───────────────────────────────────────────
console.log('\n13. The admin affiliate creation and the affiliate auth flow are unchanged');
{
  // Phase 6 part 2 (documented allowance, docs/recruiter-system.md §8): only the exact pinned Part 2
  // diffs (affiliate login / me / admin affiliates / withAffiliateAuth / affiliateSystemService).
  const { checkUnchangedExceptPart2 } = await import('./lib/phase6Part2Allowance.mjs');
  let p2;
  try {
    p2 = checkUnchangedExceptPart2('63abd2d42577570cad31082901f18b8544a0b38f', ['src/lib/services/affiliateSystemService.js', 'src/app/api/admin/affiliates/route.js', 'src/app/api/affiliate',
      'src/lib/middleware/withAffiliateAuth.js', 'src/lib/middleware/withAdminAuth.js', 'src/lib/services/identityService.js', 'src/lib/services/affiliateService.js', 'src/lib/controllers/affiliateController.js', 'src/app/api/affiliate/route.js']);
  } catch (e) { p2 = { ok: false, error: `git error ${e.status}` }; }
  // Phase 7 Stage F (approved): the admin DELETE route and the legacy controller also map AFFILIATE_HAS_CHILDREN → 409.
  // Their diff versus 7e111e1 (the commit the Part 2 allowance above was last verified on) must be EXACTLY these pinned
  // lines (sha-256 of the +/- lines); with that, they are 7e111e1's files + the Stage F lines only.
  const STAGE_F_BASE = '7e111e10df7c2413820f34a52fe200aebdefa72e';
  const STAGE_F_PINS = {
    'src/app/api/admin/affiliates/route.js': [
      "-import { AFFILIATE_HAS_HISTORY } from '@/lib/affiliateDeletion';",
      "+import { AFFILIATE_HAS_CHILDREN, AFFILIATE_HAS_HISTORY } from '@/lib/affiliateDeletion';",
      '-    // Referenced by points/orders/payouts → clear 409, never the raw DB error.',
      '-    if (err?.code === AFFILIATE_HAS_HISTORY) {',
      '+    // Referenced by points/orders/payouts, or (Phase 7 Stage F) still has children → clear 409, never the raw DB error.',
      '+    if (err?.code === AFFILIATE_HAS_HISTORY || err?.code === AFFILIATE_HAS_CHILDREN) {',
    ],
    'src/lib/controllers/affiliateController.js': [
      "-import { AFFILIATE_HAS_HISTORY } from '../affiliateDeletion.js';",
      "+import { AFFILIATE_HAS_CHILDREN, AFFILIATE_HAS_HISTORY } from '../affiliateDeletion.js';",
      '-    if (err?.code === AFFILIATE_HAS_HISTORY) {',
      '+    // Phase 7 Stage F: an affiliate with children is refused the same way (409 + message).',
      '+    if (err?.code === AFFILIATE_HAS_HISTORY || err?.code === AFFILIATE_HAS_CHILDREN) {',
    ],
  };
  const stageFDiff = (f) => { try { return execFileSync('git', ['diff', STAGE_F_BASE, '--', f], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)); } catch (e) { return [`git error ${e.status}`]; } };
  const stageF = Object.keys(STAGE_F_PINS).filter((f) => eq(stageFDiff(f), STAGE_F_PINS[f]));
  const p2Rest = p2.ok || (Array.isArray(p2.unexpected) && p2.unexpected.every((f) => stageF.includes(f)) && p2.mismatched.every((f) => stageF.includes(f)));
  ok('withAdminAuth, identity, the old affiliate service / controller and /api/affiliate/route.js are unchanged versus 63abd2d; affiliateSystemService, admin affiliates, the affiliate auth / me routes and withAffiliateAuth differ ONLY by the exact pinned Phase 6 part 2 diff — Stage F: + exactly the pinned AFFILIATE_HAS_CHILDREN lines of the admin route and the legacy controller (versus 7e111e1)',
    stageF.length === 2 && p2Rest && (p2.allowed ?? []).every((f) => ['src/lib/services/affiliateSystemService.js', 'src/app/api/admin/affiliates/route.js', 'src/app/api/affiliate/auth/route.js', 'src/app/api/affiliate/me/route.js', 'src/lib/middleware/withAffiliateAuth.js'].includes(f)),
    JSON.stringify({ p2, stageF, diffs: Object.keys(STAGE_F_PINS).map(stageFDiff) }));
  // prisma/: the ONLY change since 63abd2d is the documented Phase 5 extension (docs/recruiter-system.md §6):
  // schema.prisma (AffiliatePayout owner + Recruiter bank fields) and the new migration 20261106.
  const gitOut = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return `git error ${e.status}`; } };
  const prismaFiles = [...new Set([
    ...gitOut(['diff', '--name-only', '63abd2d42577570cad31082901f18b8544a0b38f', '--', 'prisma']).split('\n'),
    ...gitOut(['ls-files', '--others', '--exclude-standard', '--', 'prisma']).split('\n'),
  ].filter(Boolean))].sort();
  ok('prisma/ changed since 63abd2d ONLY by the Phase 5 files (schema.prisma + migration 20261106), the Phase 6 part 1 migrations 20261107 (activation codes) + 20261108 (admin activation recovery), the Phase 6 part 2 migration 20261109 (session version), the Phase 6 part 3a migration 20261110 (reward cycles) and the Phase 6 part 3c migration 20261111 (recruiter KYC)',
    eq(prismaFiles, ['prisma/migrations/20261106_recruiter_rewards_withdrawals/migration.sql', 'prisma/migrations/20261107_affiliate_activation_codes/migration.sql',
      'prisma/migrations/20261108_affiliate_activation_recovery/migration.sql', 'prisma/migrations/20261109_account_token_version/migration.sql',
      'prisma/migrations/20261110_recruiter_reward_cycles/migration.sql', 'prisma/migrations/20261111_recruiter_identity_verifications/migration.sql',
      // Phase 7 (Reward B — the recruiter group reward): exactly its migration 20261112.
      'prisma/migrations/20261112_recruiter_group_rewards/migration.sql',
      'prisma/schema.prisma']), prismaFiles.join(','));
  const schemaDiff = gitOut(['diff', '63abd2d42577570cad31082901f18b8544a0b38f', '--', 'prisma/schema.prisma']).split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).map((l) => l[0] + l.slice(1).replace(/\s+/g, ' ').trim());
  const removedLines = schemaDiff.filter((l) => l.startsWith('-')).sort();
  // Phase 6 part 1 (documented): the AffiliateActivationCode model block (+ its /// doc comment) and the
  // Affiliate back-relation line. Everything else must be exactly the Phase 5 lines below.
  const P6_MODEL = ['+model AffiliateActivationCode {', '+id String @id @default(uuid())', '+affiliateId String', '+selector String @unique', '+verifierHash String',
    '+passwordFingerprint String', '+createdByType String // RECRUITER | ADMIN', '+createdById String', '+createdAt DateTime @default(now())', '+expiresAt DateTime',
    '+failedAttempts Int @default(0)', '+usedAt DateTime?', '+invalidatedAt DateTime?', '+invalidatedReason String? // REGENERATED | TOO_MANY_ATTEMPTS | CREDENTIALS_CHANGED | ADMIN_RECOVERY',
    '+affiliate Affiliate @relation(fields: [affiliateId], references: [id], onDelete: Restrict)', '+recoveries AffiliateActivationRecovery[]',
    '+@@index([affiliateId, createdAt])', '+@@map("affiliate_activation_codes")', '+}', '+', '+',
    '+activationCodes AffiliateActivationCode[]'];
  // Phase 6 part 1 — admin activation recovery (documented): the AffiliateActivationRecovery model block
  // (+ its /// doc comment) and the Affiliate.activationRecoveries back-relation line.
  const P6R_MODEL = ['+model AffiliateActivationRecovery {', '+id String @id @default(uuid())', '+affiliateId String', '+status String @default("PENDING") // PENDING | APPROVED | REJECTED',
    '+message String', '+contactPhone String?', '+requestIp String?', '+requestedAt DateTime @default(now())', '+reviewedBy String?', '+reviewedAt DateTime?', '+reviewNote String?',
    '+activationCodeId String?', '+affiliate Affiliate @relation(fields: [affiliateId], references: [id], onDelete: Restrict)',
    '+activationCode AffiliateActivationCode? @relation(fields: [activationCodeId], references: [id], onDelete: Restrict)',
    '+@@index([status, requestedAt])', '+@@index([affiliateId, requestedAt])', '+@@map("affiliate_activation_recoveries")', '+}', '+', '+',
    '+activationRecoveries AffiliateActivationRecovery[]'];
  // Phase 6 part 2 — session version (documented, §8): Affiliate.tokenVersion and Recruiter.tokenVersion.
  const P62_FIELDS = ['+tokenVersion Int @default(0)', '+tokenVersion Int @default(0)'];
  // Phase 6 part 3a — reward cycles (documented, §9): RecruiterRewardLedger.cycle (no default; migration 20261110).
  const P63A_FIELDS = ['+cycle Int'];
  // Phase 6 part 3c — recruiter KYC (documented, §11): the RecruiterIdentityVerification model block
  // (+ its /// doc comment) and the Recruiter.identityVerification back-relation (+ its comment line).
  const P63C_MODEL = ['+model RecruiterIdentityVerification {', '+id String @id @default(uuid())', '+recruiterId String @unique',
    '+status String // PENDING | APPROVED | REJECTED', '+submission Int // 1, 2, … — an admin decision names it, so a stale decision is refused',
    '+cinFrontFile String // private storage key — never returned to a recruiter, never audited', '+cinBackFile String // private storage key',
    '+rejectionReason String?', '+submittedAt DateTime', '+reviewedBy String?', '+reviewedAt DateTime?', '+approvedAt DateTime?',
    '+createdAt DateTime @default(now())', '+updatedAt DateTime @updatedAt',
    '+recruiter Recruiter @relation(fields: [recruiterId], references: [id], onDelete: Restrict)', '+', '+@@index([status, submittedAt])',
    '+@@map("recruiter_identity_verifications")', '+}', '+', '+identityVerification RecruiterIdentityVerification?'];
  // Phase 7 (Reward B, migration 20261112): RecruiterSettingsVersion + exactly the 4 group fields with their defaults (+ 4 comment lines).
  const P7_FIELDS = ['+groupEnabled Boolean @default(false)', '+groupRewardAmountCents Int @default(0)', '+groupSize Int @default(10)', '+groupMinDeliveredSales Int @default(10)'];
  const p6 = [...P6_MODEL, ...P6R_MODEL, ...P62_FIELDS, ...P63A_FIELDS, ...P63C_MODEL, ...P7_FIELDS];
  const addedAll = schemaDiff.filter((l) => l.startsWith('+') && !l.startsWith('+//'));
  const addedCode = [];
  for (const l of addedAll) { const i = p6.indexOf(l); if (i >= 0) p6.splice(i, 1); else addedCode.push(l); }
  addedCode.sort();
  ok('Phase 6 part 1: the schema adds exactly the AffiliateActivationCode + AffiliateActivationRecovery models and the Affiliate.activationCodes / activationRecoveries back-relations (every expected line present)', p6.length === 0, JSON.stringify(p6));
  ok('schema.prisma diff since 63abd2d = exactly the documented AffiliatePayout / Recruiter lines (re-aligned base lines, affiliateId?, the affiliate FK kept, recruiterId + relation + index, bank fields, payouts back-relation)',
    eq(removedLines, ['-affiliate Affiliate @relation(fields: [affiliateId], references: [id])', '-affiliateId String', '-createdAt DateTime @default(now())', '-id String @id @default(uuid())', '-status String @default("pending")'].sort())
    && eq(addedCode, ['+@@index([recruiterId])', '+accountName String?', '+affiliate Affiliate? @relation(fields: [affiliateId], references: [id], onDelete: Restrict) // = the existing FK (unchanged)',
      '+affiliateId String?', '+bankName String?', '+createdAt DateTime @default(now())', '+id String @id @default(uuid())', '+payouts AffiliatePayout[]',
      '+recruiter Recruiter? @relation(fields: [recruiterId], references: [id], onDelete: Restrict)', '+recruiterId String?', '+rib String?', '+status String @default("pending")'].sort())
    // comment lines: Phase 5 (4) + Phase 6 part 1 (6 + 6) + Phase 6 part 2 (2 on Affiliate.tokenVersion, 1 on Recruiter.tokenVersion)
    // + Phase 6 part 3a (3 on RecruiterRewardLedger.cycle) + Phase 6 part 3c (5 /// on the model, 1 on the back-relation)
    // + Phase 7 (4 on the RecruiterSettingsVersion group fields)
    && schemaDiff.filter((l) => l.startsWith('+//')).length === 4 + 6 + 6 + 3 + 3 + 6 + 4
    && schemaDiff.includes('+// Reward B — group reward (Phase 7, migration 20261112): the amount (MAD cents) earned each time')
    && schemaDiff.includes('+// Identity verification (Phase 6 part 3c) — separate from the affiliate IdentityVerification.')
    && schemaDiff.includes('+// Reward / reversal cycle of the affiliate (Phase 6 part 3a): cycle n = one RECRUIT_REWARD and')
    && schemaDiff.includes('+// Session version (Phase 6 part 2): every token carries it; bumped on disable / enable /')
    && schemaDiff.includes('+// password change / admin reset, so older tokens are rejected (a token without it = 0).')
    && schemaDiff.includes('+// Session version (Phase 6 part 2): bumped on disable / enable / password change / reset.'), JSON.stringify(schemaDiff));
  const asys = read('src/lib/services/affiliateSystemService.js');
  const adminCreate = asys.slice(asys.indexOf('export async function adminCreateAffiliate'), asys.indexOf('export async function adminUpdateAffiliate'));
  ok('adminCreateAffiliate keeps its original body (inactive, rate default, parent check, cache invalidation, no recruiter link)',
    /isActive:\s+false,/.test(adminCreate) && /parseFloat\(commissionRate\) \|\| 0\.5/.test(adminCreate) && /PARENT_NOT_FOUND/.test(adminCreate) && /invalidateTeamCache\(validParentId\)/.test(adminCreate) && !/recruiter/i.test(adminCreate));
  ok('the admin affiliates route still calls adminCreateAffiliate under withAdminAuth', /export const POST\s*=\s*withAdminAuth\(postHandler\)/.test(read('src/app/api/admin/affiliates/route.js')) || /POST\s*=\s*withAdminAuth/.test(read('src/app/api/admin/affiliates/route.js')));

  const svc = stripJs(read('src/lib/services/recruiterAffiliateService.js'));
  const models = new Set([...svc.matchAll(/\b(?:db|tx)\.(\$?\w+)/g)].map((m) => m[1]));
  ok('recruiterAffiliateService touches only affiliate, recruiterAffiliateLink, recruiterAuditLog, $transaction, $queryRaw', [...models].every((m) => ['affiliate', 'recruiterAffiliateLink', 'recruiterAuditLog', '$transaction', '$queryRaw'].includes(m)) && models.has('$queryRaw'), [...models].join(','));
  ok('the service never touches identity / CIN / orders / payouts / UGC / balances', !/identityVerification|cinFront|cinBack|affiliateOrder|payout|ugc|balance|commission|withdraw|rewardPoint/i.test(svc));
  // Phase 6 part 5c: the raw statements are tagged templates (bound parameters): the recruiter row lock
  // (unchanged) and the ONE recursive ancestry statement — Stage E: its only interpolations are the
  // parent id, the cap and the recruiter id (the nearest link's recruiter is compared in SQL) — plus,
  // Stage E, ONE tagged `recruiter-affiliate-list` statement (the N(R) list; bound values only). No
  // Prisma.raw / sql helper, no string building, no $queryRawUnsafe / $executeRaw.
  const svcRaw = read('src/lib/services/recruiterAffiliateService.js');
  const ancTpl = /tx\.\$queryRaw`\s*\/\* recruiter-ancestry \*\/([^`]*)`/.exec(svcRaw)?.[1] ?? null;
  const listTpl = /db\.\$queryRaw`\s*\/\* recruiter-affiliate-list \*\/([^`]*)`/.exec(svcRaw)?.[1] ?? null;
  ok('the only raw SQL: the parameterised recruiter row lock (FOR NO KEY UPDATE), the ONE tagged recruiter-ancestry statement (binds parentId, cap, recruiterId only) and (Stage E) the ONE tagged recruiter-affiliate-list statement (bound values only)',
    (svc.match(/\$queryRaw/g) || []).length === 3 && /\$queryRaw`SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = \$\{recruiterId\} FOR NO KEY UPDATE`/.test(svc)
    && (svcRaw.match(/\/\* recruiter-ancestry \*\//g) || []).length === 1 && ancTpl !== null
    // Stage F: the owner rule reads the parent id twice (chain + the topmost walk) and compares the recruiter twice
    && eq(ancTpl.match(/\$\{[^}]*\}/g), ['${parentId}', '${cap}', '${parentId}', '${recruiterId}', '${recruiterId}'])
    && (svcRaw.match(/\/\* recruiter-affiliate-list \*\//g) || []).length === 1 && listTpl !== null
    && (listTpl.match(/\$\{[^}]*\}/g) || []).every((x) => ['${recruiterId}', '${pattern}', '${afterMs}', '${afterId}', '${take}', '${cap}'].includes(x))
    && !/\$queryRaw\s*\(|\$queryRawUnsafe|\$executeRaw|Prisma\.(raw|sql|join)/.test(svc), ancTpl ?? 'no recruiter-ancestry template');

  const walkAll = (dir) => readdirSync(join(ROOT, dir), { recursive: true }).map((f) => join(dir, String(f))).filter((f) => !f.split(sep).includes('generated') && statSync(join(ROOT, f)).isFile() && /\.(m?[jt]sx?)$/.test(f));
  const linkCreators = walkAll('src').filter((f) => /recruiterAffiliateLink\s*\.\s*create/.test(stripJs(read(f)))).map((f) => f.split(sep).join('/'));
  ok('recruiterAffiliateLink.create appears in src ONLY in recruiterAffiliateService.js', eq(linkCreators, ['src/lib/services/recruiterAffiliateService.js']), linkCreators.join(','));
  const affiliateAuth = read('src/app/api/affiliate/auth/route.js');
  ok('the affiliate login still answers by username OR phone and requires an active account (unchanged flow the uniqueness rules protect)', /loginAffiliate/.test(affiliateAuth) && /OR: \[\{ username: input \}, \{ phone: input \}\]/.test(asys) && /if \(!affiliate\.isActive\)/.test(asys));
}

// ── 14. Phase 6 part 5c: the ancestry check is ONE statement ─────────────────
console.log('\n14. Phase 6 part 5c → Stage F: ONE recruiter-ancestry statement, verdict = owner(parent) (topmost link) is the recruiter (oracle); every parent the former loop accepted still accepted');
{
  const BASE = '7e111e10df7c2413820f34a52fe200aebdefa72e'; // the last commit with the per-ancestor loop
  const SVC = 'src/lib/services/recruiterAffiliateService.js';
  const ACT_URL = new URL('../src/lib/services/affiliateActivationService.js', import.meta.url).href;
  const ACT_IMPORT = "import { issueActivationCode, unusablePasswordHash } from './affiliateActivationService.js';";
  const FAST_HASH = `$2a$12$${'u'.repeat(53)}`;
  const big = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x));
  const errText = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
  /**
   * A service source → { mod } or { why } (a clear reason; never a skip). prisma is stubbed (db is
   * always injected); the activation service is imported from src by absolute URL; with fastHash the
   * unusable password hash (bcrypt cost 12, ~0.4 s — irrelevant to the ancestry verdict) is a constant.
   */
  const loadSvc = async (src, label, { fastHash = false } = {}) => {
    let code = src.replace(/^import prisma from '\.\.\/prisma\.js';$/m, 'const prisma = null;');
    // Phase 7 Stage B: the list imports the network service (placement / counts) — resolved from src by absolute URL.
    code = code.replace("from './recruiterNetworkService.js';", `from '${new URL('../src/lib/services/recruiterNetworkService.js', import.meta.url).href}';`);
    if (code === src) return { why: `${label} has no "import prisma from '../prisma.js';" line to stub` };
    if (!code.includes(ACT_IMPORT)) return { why: `${label} has no "${ACT_IMPORT}" line to rewrite` };
    code = code.replace(ACT_IMPORT, fastHash
      ? `import { issueActivationCode } from '${ACT_URL}';\nconst unusablePasswordHash = async () => '${FAST_HASH}';`
      : `import { issueActivationCode, unusablePasswordHash } from '${ACT_URL}';`);
    try {
      const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
      return typeof mod.recruiterCreateAffiliate === 'function' ? { mod } : { why: `${label} does not export recruiterCreateAffiliate` };
    } catch (e) { return { why: `importing ${label} failed: ${errText(e)}` }; }
  };
  const loadOld = async (base) => {
    try { execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) {
      return { why: `commit ${base} is not in this clone (a shallow or partial clone? fetch the history, e.g. git fetch --unshallow) — git: ${errText(e)}` };
    }
    let src;
    try { src = execFileSync('git', ['show', `${base}:${SVC}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      return { why: `git show ${base.slice(0, 7)}:${SVC} failed — git: ${errText(e)}` };
    }
    if (!/seen\.size >= RECRUITER_AFFILIATE_LIMITS\.ANCESTRY_MAX/.test(src) || /recruiter-ancestry/.test(src)) return { why: `${SVC} at ${base.slice(0, 7)} is not the per-ancestor loop` };
    return loadSvc(src, `${SVC} at ${base.slice(0, 7)}`, { fastHash: true });
  };
  const missing = await loadOld('0123456789abcdef0123456789abcdef01234567');
  ok('the loader reports a missing commit with a clear message (no cryptic error, no skip)', !missing.mod && /^commit 0123456789abcdef0123456789abcdef01234567 is not in this clone \(a shallow or partial clone\?/.test(missing.why ?? ''), missing.why);
  const oldL = await loadOld(BASE);
  const OLD = oldL.mod ?? null;
  if (!OLD) console.log(`  ERROR the Part 5c equivalence check cannot run: ${oldL.why}`);
  ok(`the former per-ancestor implementation loads from commit ${BASE.slice(0, 7)} (git show)`, !!OLD, oldL.why ?? '');
  // The CURRENT source, loaded the same way (fast hash) for the randomized batch; the hand-built
  // cases and every other check below run the real module S.
  const newL = await loadSvc(read(SVC), `the working-tree ${SVC}`, { fastHash: true });
  const NEWF = newL.mod ?? null;
  ok('the current service source loads the same way (for the randomized batch)', !!NEWF && /\/\* recruiter-ancestry \*\//.test(read(SVC)), newL.why ?? '');

  /** A fresh phase-3 db with recruiters A and B and the dataset; one creation under parentId → 'CREATED' | error code. */
  const verdict = async (create, data, parentId, { onDb } = {}) => {
    const db = makeRecruiterFakeDb({ phase3: true });
    const A = db._seed.recruiter({ username: 'anc.a', name: 'Recruteur A' });
    const B = db._seed.recruiter({ username: 'anc.b', name: 'Recruteur B' });
    const rid = { A: A.id, B: B.id };
    data.affs.forEach((a, i) => db._seed.affiliate({ id: a.id, username: `seed.${i}`, name: `S${i}`, parentId: a.parentId }));
    for (const l of data.links) db._seed.link({ affiliateId: l.id, recruiterId: rid[l.owner] });
    let out;
    try { await create(A.id, { username: 'anc.new', name: 'Nouveau', requestId: randomUUID(), parentId }, { db, now: now() }); out = 'CREATED'; } catch (e) { out = e?.code ?? `THROWN ${errText(e)}`; }
    if (onDb) onDb(db, A);
    return out;
  };
  // Dataset builders (ids are UUIDs: valid parentIds for the validator).
  const node = (parentId = null) => ({ id: randomUUID(), parentId });
  const chain = (len, top = null) => { const out = []; let p = top; for (let i = 0; i < len; i++) { const n = node(p); out.push(n); p = n.id; } return out; };
  const linkAll = (affs, owner = 'A') => affs.map((a) => ({ id: a.id, owner }));
  const bottom = (affs) => affs[affs.length - 1].id;
  const cases = [];
  const add = (name, expect, make) => cases.push({ name, expect, make });
  // Stage F oracle, straight from the rule: walk up from the parent with a visited set (at most ANCESTRY_MAX distinct
  // nodes, the parent included — a longer chain is refused); owner = the TOPMOST link's recruiter when the walk reaches
  // a top, the one recruiter of every link met on a parent cycle (none when several); CREATED iff the owner is A.
  const oracle = (data, parentId) => {
    const byId = new Map(data.affs.map((a) => [a.id, a]));
    const linkOf = new Map(data.links.map((l) => [l.id, l.owner]));
    const seen = new Set(); const rids = [];
    let cur = byId.get(parentId);
    while (cur && !seen.has(cur.id)) {
      if (seen.size === 10000) return 'PARENT_NOT_IN_NETWORK'; // more than ANCESTRY_MAX
      seen.add(cur.id);
      if (linkOf.has(cur.id)) rids.push(linkOf.get(cur.id));
      cur = cur.parentId === null || cur.parentId === '' ? undefined : byId.get(cur.parentId);
    }
    const cycle = !!cur; // stopped on a revisit
    const set = new Set(rids);
    const owner = set.size === 1 ? rids[0] : set.size > 1 && !cycle ? rids[rids.length - 1] : null;
    return owner === 'A' ? 'CREATED' : 'PARENT_NOT_IN_NETWORK';
  };
  const unlinkAll = () => [];
  add('root parent', 'CREATED', () => { const c = chain(1); return { data: { affs: c, links: linkAll(c) }, parent: bottom(c) }; });
  add('shallow chain (3 levels)', 'CREATED', () => { const c = chain(3); return { data: { affs: c, links: linkAll(c) }, parent: bottom(c) }; });
  add('deep chain (300 levels)', 'CREATED', () => { const c = chain(300); return { data: { affs: c, links: linkAll(c) }, parent: bottom(c) }; });
  add('wide network (1 root, 60 children, 60 grandchildren), parent = a grandchild', 'CREATED', () => {
    const r = node(); const kids = Array.from({ length: 60 }, () => node(r.id)); const gk = kids.map((k) => node(k.id));
    const affs = [r, ...kids, ...gk]; return { data: { affs, links: linkAll(affs) }, parent: gk[37].id };
  });
  // Stage F: the topmost link decides; a parent cycle whose links are all A's is A's.
  add('Stage E: cycle X → Y → X (both linked)', 'CREATED', () => { const x = node(); const y = node(x.id); x.parentId = y.id; return { data: { affs: [x, y], links: linkAll([x, y]) }, parent: x.id }; });
  add('Stage E: self-parent X → X (linked)', 'CREATED', () => { const x = node(); x.parentId = x.id; return { data: { affs: [x], links: linkAll([x]) }, parent: x.id }; });
  add('Stage E: rho: a 5-level tail into a 3-cycle (all linked)', 'CREATED', () => {
    const cyc = chain(3); cyc[0].parentId = cyc[2].id; const tail = chain(5, cyc[1].id); const affs = [...cyc, ...tail];
    return { data: { affs, links: linkAll(affs) }, parent: bottom(tail) };
  });
  add('the parent itself linked to recruiter B', 'PARENT_NOT_IN_NETWORK', () => { const c = chain(1); return { data: { affs: c, links: linkAll(c, 'B') }, parent: bottom(c) }; });
  add('Stage F: the top ancestor (level 1 of 6) linked to recruiter B, the rest to A (B\'s network)', 'PARENT_NOT_IN_NETWORK', () => {
    const c = chain(6); return { data: { affs: c, links: [{ id: c[0].id, owner: 'B' }, ...linkAll(c.slice(1))] }, parent: bottom(c) };
  });
  add('Stage E: a middle ancestor linked to nobody', 'CREATED', () => { const c = chain(6); return { data: { affs: c, links: linkAll(c.filter((_, i) => i !== 2)) }, parent: bottom(c) }; });
  add('Stage E: the parent linked to nobody, invited below A\'s affiliates', 'CREATED', () => { const c = chain(3); return { data: { affs: c, links: linkAll(c.slice(0, 2)) }, parent: bottom(c) }; });
  add('Stage E: a dangling parentId mid-chain (no affiliate row, no link), the parent linked to A', 'CREATED', () => { const c = chain(4, randomUUID()); return { data: { affs: c, links: linkAll(c) }, parent: bottom(c) }; });
  add('Stage E: a dangling parentId mid-chain that HAS a link to A (link row, no affiliate row)', 'CREATED', () => {
    const ghost = randomUUID(); const c = chain(4, ghost); return { data: { affs: c, links: [...linkAll(c), { id: ghost, owner: 'A' }] }, parent: bottom(c) };
  });
  add('a parent id with no affiliate row at all (but a link to A)', 'PARENT_NOT_IN_NETWORK', () => { const ghost = randomUUID(); return { data: { affs: [], links: [{ id: ghost, owner: 'A' }] }, parent: ghost }; });
  add("an ancestor whose parentId is '' (the former while (id) stops there)", 'CREATED', () => { const c = chain(5, ''); return { data: { affs: c, links: linkAll(c) }, parent: bottom(c) }; });
  add("the parent itself has parentId ''", 'CREATED', () => { const c = chain(1, ''); return { data: { affs: c, links: linkAll(c) }, parent: bottom(c) }; });
  add('Stage F: a 300-level chain whose top is linked to B, the rest to A (B\'s network)', 'PARENT_NOT_IN_NETWORK', () => { const c = chain(300); return { data: { affs: c, links: [{ id: c[0].id, owner: 'B' }, ...linkAll(c.slice(1))] }, parent: bottom(c) }; });
  add('Stage E: a 300-level chain hanging off a 2-cycle (all linked)', 'CREATED', () => {
    const cyc = chain(2); cyc[0].parentId = cyc[1].id; const c = chain(300, cyc[0].id); const affs = [...cyc, ...c]; return { data: { affs, links: linkAll(affs) }, parent: bottom(c) };
  });
  add('Stage E: a chain under an ancestor of B that sits ABOVE a node of A (B in the middle)', 'CREATED', () => {
    const c = chain(5); return { data: { affs: c, links: c.map((a, i) => ({ id: a.id, owner: i === 1 ? 'B' : 'A' })) }, parent: bottom(c) };
  });
  // Stage F: unlinked parents — decided by the topmost link above them.
  add('Stage F: an unlinked parent whose nearest link (2 levels up) is B\'s, with A above it (A\'s network)', 'CREATED', () => {
    const c = chain(5); return { data: { affs: c, links: [{ id: c[0].id, owner: 'A' }, { id: c[2].id, owner: 'B' }] }, parent: bottom(c) };
  });
  add('Stage E: an unlinked chain of 300 below ONE A-linked root', 'CREATED', () => { const c = chain(301); return { data: { affs: c, links: [{ id: c[0].id, owner: 'A' }] }, parent: bottom(c) }; });
  add('Stage E: an unlinked chain with no link at all', 'PARENT_NOT_IN_NETWORK', () => { const c = chain(5); return { data: { affs: c, links: unlinkAll() }, parent: bottom(c) }; });
  add('Stage F: an unlinked parent on an unlinked 2-cycle (no link: no owner)', 'PARENT_NOT_IN_NETWORK', () => { const x = node(); const y = node(x.id); x.parentId = y.id; return { data: { affs: [x, y], links: [] }, parent: y.id }; });
  add('Stage E: an unlinked self-parent', 'PARENT_NOT_IN_NETWORK', () => { const x = node(); x.parentId = x.id; return { data: { affs: [x], links: [] }, parent: x.id }; });
  add('Stage E: an unlinked tail into an unlinked 3-cycle (rho without a link)', 'PARENT_NOT_IN_NETWORK', () => {
    const cyc = chain(3); cyc[0].parentId = cyc[2].id; const tail = chain(4, cyc[1].id); return { data: { affs: [...cyc, ...tail], links: [] }, parent: bottom(tail) };
  });
  add('Stage E: an unlinked tail into a 3-cycle with ONE A-linked member', 'CREATED', () => {
    const cyc = chain(3); cyc[0].parentId = cyc[2].id; const tail = chain(4, cyc[1].id); return { data: { affs: [...cyc, ...tail], links: [{ id: cyc[2].id, owner: 'A' }] }, parent: bottom(tail) };
  });
  add('Stage E: an unlinked parent whose chain ends at a dangling id (no link)', 'PARENT_NOT_IN_NETWORK', () => { const c = chain(3, randomUUID()); return { data: { affs: c, links: [] }, parent: bottom(c) }; });
  add('Stage F: an unlinked parent below an A-linked ancestor whose own ancestor is B\'s (B\'s network)', 'PARENT_NOT_IN_NETWORK', () => {
    const c = chain(4); return { data: { affs: c, links: [{ id: c[0].id, owner: 'B' }, { id: c[1].id, owner: 'A' }] }, parent: bottom(c) };
  });
  add('Stage F: an unlinked tail into a 2-cycle linked to A AND B (ambiguous: no owner — a conflict)', 'PARENT_NOT_IN_NETWORK', () => {
    const cyc = chain(2); cyc[0].parentId = cyc[1].id; const tail = chain(3, cyc[0].id); return { data: { affs: [...cyc, ...tail], links: [{ id: cyc[0].id, owner: 'A' }, { id: cyc[1].id, owner: 'B' }] }, parent: bottom(tail) };
  });
  if (OLD) {
    const res = [];
    for (const k of cases) {
      const { data, parent } = k.make();
      res.push({ name: k.name, expect: k.expect, oracle: oracle(data, parent), old: await verdict(OLD.recruiterCreateAffiliate, data, parent), now: await verdict(S.recruiterCreateAffiliate, data, parent) });
    }
    for (const r of res) {
      ok(`hand-built — ${r.name}: new statement = ${r.now} (expected ${r.expect}, oracle ${r.oracle}; former loop ${r.old})`,
        r.now === r.expect && r.oracle === r.expect && (r.old !== 'CREATED' || r.now === 'CREATED'), big(r));
    }

    // Randomized: seeded datasets with trees, chains, cycles, self-parents, '' and dangling parents,
    // nodes of A, of B or of nobody, links without an affiliate row.
    const rand = (s) => () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const rnd = rand(0x5c5c);
    const pickOf = (xs) => xs[Math.floor(rnd() * xs.length)];
    const RUNS = 400;
    const tally = {}; const diffs = []; const lost = [];
    for (let run = 0; run < RUNS; run++) {
      const n = 1 + Math.floor(rnd() * 30);
      const affs = Array.from({ length: n }, () => node());
      const ghosts = Array.from({ length: 3 }, () => randomUUID());
      affs.forEach((a, i) => {
        const p = rnd();
        a.parentId = p < 0.12 ? null : p < 0.17 ? '' : p < 0.82 ? (i ? affs[Math.floor(rnd() * i)].id : null) : p < 0.92 ? pickOf(affs).id : p < 0.96 ? a.id : pickOf(ghosts);
      });
      // Stage E: more unlinked and B nodes than before (60 % A / 15 % B / 25 % none), so both verdicts stay frequent
      const links = [];
      for (const a of affs) { const p = rnd(); if (p < 0.6) links.push({ id: a.id, owner: 'A' }); else if (p < 0.75) links.push({ id: a.id, owner: 'B' }); }
      for (const g of ghosts) if (rnd() < 0.3) links.push({ id: g, owner: 'A' });
      const parent = rnd() < 0.05 ? pickOf(ghosts) : pickOf(affs).id;
      const data = { affs, links };
      const want = oracle(data, parent);
      const o = await verdict(OLD.recruiterCreateAffiliate, data, parent);
      const w = await verdict(NEWF.recruiterCreateAffiliate, data, parent);
      tally[w] = (tally[w] ?? 0) + 1;
      if (w !== want) diffs.push({ run, oracle: want, now: w });
      if (o === 'CREATED' && w !== 'CREATED') lost.push({ run, old: o, now: w });
    }
    ok(`randomized: new verdict = the owner oracle on ${RUNS} seeded datasets (${big(tally)})`, diffs.length === 0, big(diffs.slice(0, 5)));
    ok('randomized: every parent the former loop accepted is still accepted (Stage F: the former loop required an all-A chain — still A\'s)', lost.length === 0, big(lost.slice(0, 5)));
    ok('randomized: both verdicts occur often (≥ 20 % each) and no other outcome', (tally.CREATED ?? 0) >= RUNS * 0.2 && (tally.PARENT_NOT_IN_NETWORK ?? 0) >= RUNS * 0.2
      && Object.keys(tally).every((k) => k === 'CREATED' || k === 'PARENT_NOT_IN_NETWORK'), big(tally));
  }

  // The 10,000-node limit, NEW implementation only (through the route). Stage F: the topmost link must be found, so
  // the cap bounds the parent's WHOLE chain: one A-linked root and 9,999 unlinked affiliates below it → the bottom
  // one's chain is 10,000 nodes → 201; one more level (linked or not) → 10,001 nodes → refused.
  {
    const E = setup();
    const top = E.db._seed.affiliate({ username: 'lim.top', name: 'Top' }); E.db._seed.link({ affiliateId: top.id, recruiterId: E.A.id });
    let prev = top.id;
    for (let i = 1; i < 10000; i++) { const a = E.db._seed.affiliate({ username: `lim.${i}`, name: `L${i}`, parentId: prev }); prev = a.id; }
    const atCap = await post(E, E.A, mk({ parentId: prev }));
    ok('Stage F: an unlinked parent whose chain (topmost link A) is 10,000 nodes (ANCESTRY_MAX) → 201', atCap.status === 201 && atCap.body.affiliate.parentId === prev, atCap.text.slice(0, 200));
    const deeper = E.db._seed.affiliate({ username: 'lim.over', name: 'Over', parentId: prev });
    const b = counts(E.db);
    const over = await post(E, E.A, mk({ parentId: deeper.id }));
    ok('Stage F: … one more unlinked level (a chain of 10,001) → 400 { code: PARENT_NOT_IN_NETWORK } (the existing HTTP mapping), nothing written',
      over.status === 400 && eq(over.body, { code: 'PARENT_NOT_IN_NETWORK' }) && eq(counts(E.db), b), over.text);
    const own = await post(E, E.A, mk({ parentId: atCap.body.affiliate?.id }));
    ok('Stage F: … and the A-linked affiliate created at depth 10,001 cannot be a parent either (its chain is 10,001 > ANCESTRY_MAX: the topmost link must be found within the cap)',
      own.status === 400 && eq(own.body, { code: 'PARENT_NOT_IN_NETWORK' }), own.text.slice(0, 200));
    ok('… each decided by ONE ancestry statement (no per-ancestor query)', E.db._log.filter((l) => l.model === '$queryRaw' && /recruiter-ancestry/.test(l.sql)).length === 3
      && !E.db._log.some((l) => (l.model === 'recruiterAffiliateLink' || l.model === 'affiliate') && l.op === 'findUnique'));
    ok('the service limit is still 10,000 (ANCESTRY_MAX)', S.RECRUITER_AFFILIATE_LIMITS?.ANCESTRY_MAX === 10000, String(S.RECRUITER_AFFILIATE_LIMITS?.ANCESTRY_MAX));
  }

  // Statement count of one creation: independent of the parent's depth (was + 2 per ancestor).
  {
    const E = setup();
    const callsOf = (from) => E.db._log.slice(from).filter((l) => l.model !== '$transaction');
    const m0 = E.db._log.length;
    const root = await post(E, E.A, mk());
    const rootCount = callsOf(m0).length;
    const per = {};
    for (const d of [1, 2, 10, 300]) {
      let prev = null;
      for (let i = 0; i < d; i++) { const a = E.db._seed.affiliate({ username: `dep${d}.${i}`, name: `D${i}`, parentId: prev }); E.db._seed.link({ affiliateId: a.id, recruiterId: E.A.id }); prev = a.id; }
      const m = E.db._log.length;
      const r = await post(E, E.A, mk({ parentId: prev }));
      const q = callsOf(m);
      per[d] = { status: r.status, n: q.length, anc: q.filter((l) => l.model === '$queryRaw' && /recruiter-ancestry/.test(l.sql)).length };
    }
    ok(`through the route, a creation under a parent at depth 1 / 2 / 10 / 300 makes the same number of database calls, ONE of them the ancestry statement (${big({ rootCount, per })})`,
      root.status === 201 && Object.values(per).every((p) => p.status === 201 && p.n === per[1].n && p.anc === 1), big({ rootCount, per }));
    // Service level, same harness for both implementations: the former loop made 2 calls per
    // ancestor; the new service makes the former depth-1 count minus 2 at EVERY depth (Part 5c: − 1;
    // Stage E: − 1 more — the parent passed the check, so its id is shown without re-reading its link).
    const svcCount = async (create, d) => {
      const db = makeRecruiterFakeDb({ phase3: true });
      const A = db._seed.recruiter({ username: 'cnt.a', name: 'Recruteur A' });
      let prev = null;
      for (let i = 0; i < d; i++) { const a = db._seed.affiliate({ username: `cnt${d}.${i}`, name: `C${i}`, parentId: prev }); db._seed.link({ affiliateId: a.id, recruiterId: A.id }); prev = a.id; }
      const m = db._log.length;
      await create(A.id, mk({ parentId: prev }), { db, now: now() });
      return db._log.slice(m).filter((l) => l.model !== '$transaction').length;
    };
    const newPer = {};
    for (const d of [1, 2, 10, 300]) newPer[d] = await svcCount(S.recruiterCreateAffiliate, d);
    if (OLD) {
      const oldPer = {};
      for (const d of [1, 2, 10]) oldPer[d] = await svcCount(OLD.recruiterCreateAffiliate, d);
      ok(`service calls per creation — former loop ${big(oldPer)} (+ 2 per ancestor), new ${big(newPer)} (constant = former depth-1 count − 2)`,
        oldPer[2] - oldPer[1] === 2 && oldPer[10] - oldPer[1] === 18 && Object.values(newPer).every((n) => n === oldPer[1] - 2), big({ oldPer, newPer }));
    } else ok('service calls per creation are independent of the depth', Object.values(newPer).every((n) => n === newPer[1]), big(newPer));
  }

  // Order and transaction: the ancestry statement runs inside the creation transaction, after the
  // recruiter row lock (held at that moment by that same open transaction), before any write.
  {
    const E = setup();
    const c = chain(3);
    c.forEach((a, i) => { E.db._seed.affiliate({ id: a.id, username: `ord.${i}`, name: `O${i}`, parentId: a.parentId }); E.db._seed.link({ affiliateId: a.id, recruiterId: E.A.id }); });
    let atStmt = null;
    E.hookBox.fn = (m, o, a) => {
      if (m === '$queryRaw' && /recruiter-ancestry/.test(a?.sql ?? '')) {
        const l = E.db._locks.get(E.A.id);
        atStmt = { open: [...E.db._openTx], lockTx: l?.tx ?? null, values: a.values };
      }
    };
    const m = E.db._log.length;
    const r = await post(E, E.A, mk({ parentId: bottom(c) }));
    E.hookBox.fn = null;
    const log = E.db._log.slice(m);
    const iBegin = log.findIndex((l) => l.model === '$transaction');
    const iLock = log.findIndex((l) => l.model === '$queryRaw' && /FOR NO KEY UPDATE/.test(l.sql));
    const iAnc = log.findIndex((l) => l.model === '$queryRaw' && /recruiter-ancestry/.test(l.sql));
    const iWrite = log.findIndex((l) => /create|update|delete|upsert/.test(l.op));
    ok('one transaction; order: begin → recruiter row lock → … → the ancestry statement → the first write',
      r.status === 201 && log.filter((l) => l.model === '$transaction').length === 1 && iBegin >= 0 && iBegin < iLock && iLock < iAnc && iAnc < iWrite, big({ iBegin, iLock, iAnc, iWrite }));
    ok('while the ancestry statement runs, exactly one transaction is open and it holds recruiter A\'s row lock; binds = [parentId, 10001, parentId, A, A] (Stage F)',
      atStmt && atStmt.open.length === 1 && atStmt.lockTx === atStmt.open[0] && eq(atStmt.values, [bottom(c), 10001, bottom(c), E.A.id, E.A.id]), big(atStmt));

    // The fake's own guards for this statement (the emulation is strict, not permissive).
    const sql = log[iAnc].sql;
    const strings = sql.split('$?');
    const vals = [bottom(c), 10001, bottom(c), E.A.id, E.A.id]; // Stage F
    const tryRaw = async (fn) => { try { return { rows: await fn() }; } catch (e) { return { err: errText(e) }; } };
    const outside = await tryRaw(() => E.db.$queryRaw(strings, ...vals));
    const noLock = await tryRaw(() => E.db.$transaction((tx) => tx.$queryRaw(strings, ...vals)));
    const locked = await tryRaw(() => E.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${E.A.id} FOR NO KEY UPDATE`;
      return tx.$queryRaw(strings, ...vals);
    }));
    const lockedB = await tryRaw(() => E.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${E.B.id} FOR NO KEY UPDATE`;
      return tx.$queryRaw(strings, ...vals);
    }));
    const inLock = (s, v) => tryRaw(() => E.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${E.A.id} FOR NO KEY UPDATE`;
      return tx.$queryRaw(s, ...v);
    }));
    const drift = await inLock([strings[0].replace('WITH RECURSIVE', 'WITH RECURSIVE /* x */'), ...strings.slice(1)], vals);
    const badCap = await inLock(strings, [bottom(c), 10000, bottom(c), E.A.id, E.A.id]);
    const nullParent = await inLock(strings, [null, 10001, null, E.A.id, E.A.id]);
    const otherRid = await inLock(strings, [bottom(c), 10001, bottom(c), E.B.id, E.B.id]); // B's lock is not held
    const ghost = randomUUID();
    const none = await inLock(strings, [ghost, 10001, ghost, E.A.id, E.A.id]);
    ok('fake: the ancestry statement is refused outside a transaction, and inside one that does not hold THIS recruiter\'s row lock',
      /inside the creation transaction/.test(outside.err ?? '') && /holds the recruiter row lock/.test(noLock.err ?? '') && /holds the recruiter row lock/.test(lockedB.err ?? ''), big({ outside, noLock, lockedB }));
    // Stage F: the walk goes to the top: n = 3 (the whole chain), mine = its owner is A.
    ok('fake: under the lock it answers ONE row { n, mine } — the 3-level linked chain → { n: 3, mine: true } (Stage F: the whole chain)',
      eq(locked.rows, [{ n: 3, mine: true }]), big(locked));
    ok('fake: no start row → { n: 0, mine: null } (count over nothing, no link)', eq(none.rows, [{ n: 0, mine: null }]), big(none));
    ok('fake: drift guard (added text), cap ≠ 10001, a NULL parent id and a recruiter whose row lock is not held are all refused',
      /recruiter-ancestry query changed/.test(drift.err ?? '') && /cap must be/.test(badCap.err ?? '') && /parent id as text/.test(nullParent.err ?? '') && /holds the recruiter row lock/.test(otherRid.err ?? ''),
      big({ drift, badCap, nullParent, otherRid }));
    // Emulation semantics on hand data (Stage F): the walk goes to the top (UNION: a cycle ends after one lap);
    // mine = owner(parent) is A — the topmost link (another recruiter's → false), a cycle's one recruiter, NULL
    // without any link; a '' parent ends the walk.
    const E2 = setup();
    const x = E2.db._seed.affiliate({ username: 'em.x', name: 'X' }); const y = E2.db._seed.affiliate({ username: 'em.y', name: 'Y', parentId: x.id });
    E2.db._tables.affiliate.find((a) => a.id === x.id).parentId = y.id;
    E2.db._seed.link({ affiliateId: x.id, recruiterId: E2.A.id }); E2.db._seed.link({ affiliateId: y.id, recruiterId: E2.A.id });
    const f = E2.db._seed.affiliate({ username: 'em.f', name: 'F' }); E2.db._seed.link({ affiliateId: f.id, recruiterId: E2.B.id });
    const g = E2.db._seed.affiliate({ username: 'em.g', name: 'G', parentId: f.id }); E2.db._seed.link({ affiliateId: g.id, recruiterId: E2.A.id });
    const e = E2.db._seed.affiliate({ username: 'em.e', name: 'E', parentId: '' });
    const h = E2.db._seed.affiliate({ username: 'em.h', name: 'H', parentId: f.id });                 // unlinked under B's f
    const u = E2.db._seed.affiliate({ username: 'em.u', name: 'U' }); const v = E2.db._seed.affiliate({ username: 'em.v', name: 'V', parentId: u.id });
    E2.db._tables.affiliate.find((a) => a.id === u.id).parentId = v.id;                              // unlinked u ⇄ v
    const q2 = (pid) => tryRaw(() => E2.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "isActive", "canCreateAffiliates" FROM "recruiters" WHERE "id" = ${E2.A.id} FOR NO KEY UPDATE`;
      return tx.$queryRaw(strings, pid, 10001, pid, E2.A.id, E2.A.id);
    }));
    const [rc, rg, rh, ruv, re] = [await q2(x.id), await q2(g.id), await q2(h.id), await q2(u.id), await q2(e.id)];
    ok("fake (Stage F): a member of an all-A cycle → n = 2, mine true; A's legacy g under B's f → n = 2, mine false (topmost f is B's); an unlinked node under B's → n = 2, mine false; an unlinked 2-cycle → n = 2, mine null; an unlinked '' parent → n = 1, mine null",
      eq(rc.rows, [{ n: 2, mine: true }]) && eq(rg.rows, [{ n: 2, mine: false }]) && eq(rh.rows, [{ n: 2, mine: false }]) && eq(ruv.rows, [{ n: 2, mine: null }]) && eq(re.rows, [{ n: 1, mine: null }]),
      big({ rc, rg, rh, ruv, re }));
  }

  // The error code and its HTTP mapping are unchanged.
  const gitQ = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return `git error ${e.status}`; } };
  // Phase 7 (Reward B): recruiterVisibility.js may differ from HEAD ONLY by added lines inside
  // toRecruiterRewardHistoryView (the GROUP_REWARD / GROUP_REVERSAL branch) — nothing removed.
  // Phase 7 Stage B (documented): + added lines inside the downline-progress helpers, the node view, the
  // affiliate list item / progress summary projections, and ONE replaced line (the path view gains linkedToMe).
  const visDiff = gitQ(['diff', '--unified=0', 'HEAD', '--', 'src/lib/recruiterVisibility.js']);
  const visOnlyAllowed = (() => {
    const lines = visDiff.split('\n').filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (!lines.length) return true;
    const removed = lines.filter((l) => l[0] === '-');
    // Stage E (documented): + the two doc-comment lines of toRecruiterNetworkAffiliateView (networkIds = the
    // members of N(R), no longer "ids linked to this recruiter"), rewritten inside that comment.
    if (!eq(removed, ["- * verification or any amount. `networkIds` = ids linked to this recruiter: a parentId outside",
      "- * it is never shown (null). Filtering rows by recruiter is the caller's job.",
      "-  return { id: str(entry?.id), username: str(entry?.username), name: str(entry?.name), level: level(entry?.level) };"])) return false;
    const cur = read('src/lib/recruiterVisibility.js');
    const region = (a, b) => { const i = cur.indexOf(a); const j = i >= 0 ? cur.indexOf(b, i + a.length) : -1; return i >= 0 && j > i ? cur.slice(i, j) : ''; };
    const regions = [
      region('export function toRecruiterRewardHistoryView(row) {', '\n}\n'),
      region('// ── Phase 7 Stage B → E: network progress', '/**\n * Recruiter-facing node of their network tree'),
      region('export function toRecruiterNetworkNodeView(node) {', '\n}\n'),
      region('export function toRecruiterNetworkPathView(entry) {', '\n}\n'),
      region('/**\n * Phase 7 Stage B → E: one affiliate of the recruiter', "// ── Phase 5: the recruiter's own rewards"),
      region('/**\n * Recruiter-facing view of an affiliate of THEIR OWN network', 'export function toRecruiterNetworkAffiliateView(row, networkIds) {'),
    ];
    return /GROUP_REWARD/.test(regions[0]) && regions.every((r) => r.length > 0)
      && lines.filter((l) => l[0] === '+').every((l) => regions.some((r) => r.includes(l.slice(1))));
  })();
  // Phase 7 Stage B (documented): recruiterAffiliateRouteHandlers.js changes ONLY its list handler (GET): the
  // createAffiliate handler is byte-identical to HEAD; recruiterRouteHandlers.js is unchanged.
  const createBody = (src) => { const i = src.indexOf('    createAffiliate: safe('); return i >= 0 ? src.slice(i) : null; };
  const headHandlers = gitQ(['show', 'HEAD:src/lib/recruiterAffiliateRouteHandlers.js']);
  ok('PARENT_NOT_IN_NETWORK → 400 in the route mapping; recruiterRouteHandlers.js unchanged versus HEAD; the createAffiliate handler unchanged (Stage B changes the list handler only); visibility: only the Phase 7 group-history branch and the Stage B downline projections added',
    /PARENT_NOT_IN_NETWORK: 400/.test(read('src/lib/recruiterRouteHandlers.js'))
    && gitQ(['diff', '--name-only', 'HEAD', '--', 'src/lib/recruiterRouteHandlers.js']).trim() === ''
    && createBody(headHandlers) !== null && createBody(headHandlers) === createBody(read('src/lib/recruiterAffiliateRouteHandlers.js')) && visOnlyAllowed, visDiff.slice(0, 300));
  ok('every refusal of the new check is PARENT_NOT_IN_NETWORK (one throw site in assertAncestryInNetwork; Stage E: the verdict comes from parentInNetwork)', (() => {
    const s = stripJs(read(SVC));
    const fn = s.slice(s.indexOf('async function assertAncestryInNetwork('), s.indexOf('export async function recruiterCreateAffiliate'));
    return (fn.match(/throw /g) || []).length === 1 && /throw fail\('PARENT_NOT_IN_NETWORK'\)/.test(fn);
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
