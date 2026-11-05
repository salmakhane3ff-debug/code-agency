#!/usr/bin/env node
/**
 * scripts/recruiterAuth.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 2: recruiter accounts (admin-managed) and
 * the separate recruiter login (JWT type "recruiter", HttpOnly cookie
 * recruiter_token, Path=/api/recruiter). In-memory fake database only.
 * Proves:
 *   • admin create / list / enable / disable, with validation, uniqueness,
 *     bcrypt-only storage and an audit row in the same transaction
 *   • login: cookie flags, profile-only body, uniform INVALID_CREDENTIALS,
 *     disabled accounts refused only after a correct password, rate limiting
 *   • /me and logout, a recruiter disabled after login refused at once
 *   • isolation of admin / affiliate / recruiter tokens and cookies
 *   • error hygiene (codes only for recruiters, fixed French text for admins)
 *   • static wiring and model isolation (recruiter + recruiterAuditLog only)
 * Run: node scripts/recruiterAuth.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-auth-test-secret-not-real';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const { adminRecruiterHandlers, recruiterHandlers, RECRUITER_COOKIE_MAX_AGE } = await import('../src/lib/recruiterRouteHandlers.js');
const { withRecruiterAuth, RECRUITER_COOKIE } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { withAffiliateAuth } = await import('../src/lib/middleware/withAffiliateAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const { RECRUITER_ERROR_CODES } = await import('../src/lib/recruiterVisibility.js');
const { toRecruiterProfileView } = await import('../src/lib/recruiterProfileView.js');
const S = await import('../src/lib/services/recruiterService.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const T0 = new Date('2026-11-05T09:00:00.000Z');
let clock = T0.getTime();
const now = () => new Date(clock);
const noLimit = () => null;

const ADMIN = { userId: 'admin-1', email: 'admin@example.test', role: 'ADMIN' };
const adminToken = () => signToken(ADMIN);
const userToken = () => signToken({ userId: 'u-1', email: 'u@example.test', role: 'USER' });
const affiliateToken = () => signToken({ affiliateId: 'aff-1', username: 'aff', type: 'affiliate' });
const recruiterToken = (id, username = 'x') => signToken({ recruiterId: id, username, type: 'recruiter' });

const req = (url, { method = 'GET', body, cookie, bearer, raw } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
};
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const call = async (handler, r, c) => { const res = await handler(r, c); const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; } return { status: res.status, body, setCookie: res.headers.get('set-cookie'), text }; };

/** Build the route-shaped handlers on one fake db. */
function setup({ db = makeRecruiterFakeDb(), rateLimit = noLimit } = {}) {
  const a = adminRecruiterHandlers({ db, now });
  const r = recruiterHandlers({ db, now, rateLimit });
  return {
    db,
    admin: { list: withAdminAuth(a.list), create: withAdminAuth(a.create), setActive: withAdminAuth(a.setActive) },
    rec: { login: r.login, logout: r.logout, me: withRecruiterAuth(r.me) },
  };
}
const asAdmin = (extra = {}) => ({ cookie: `auth_token=${adminToken()}`, ...extra });
const createVia = (A, body) => call(A.admin.create, req('/api/admin/recruiters', { method: 'POST', body, ...asAdmin() }));
const loginVia = (A, body) => call(A.rec.login, req('/api/recruiter/auth', { method: 'POST', body }));
const cookieOf = (setCookie) => (setCookie || '').match(new RegExp(`${RECRUITER_COOKIE}=([^;]*)`))?.[1] ?? null;
const meVia = (A, token, extra = {}) => call(A.rec.me, req('/api/recruiter/me', { cookie: token !== null && token !== undefined ? `${RECRUITER_COOKIE}=${token}` : undefined, ...extra }));

const recruiterBodies = []; // every recruiter-facing response body, for the hygiene checks
const track = (res) => { recruiterBodies.push(res); return res; };

const VALID = { username: 'ali.r', name: 'Ali Recruiter', password: 'S3cure-pass', phone: '+212612345678' };

// ── 1. Admin: create ───────────────────────────────────────────────────────────
console.log('\n1. Admin create');
{
  const A = setup();
  const res = await createVia(A, VALID);
  const row = A.db._tables.recruiter[0];
  ok('valid create → 201 { recruiter } (admin view)', res.status === 201 && eq(keys(res.body), ['recruiter']) && res.body.recruiter.username === 'ali.r' && res.body.recruiter.isActive === true, JSON.stringify(res.body));
  ok('admin view keys are exactly the documented set (no passwordHash)', eq(keys(res.body.recruiter),
    ['canCreateAffiliates', 'canViewOrders', 'createdAt', 'createdBy', 'disabledAt', 'disabledBy', 'disabledReason', 'id', 'isActive', 'lastLoginAt', 'name', 'phone', 'updatedAt', 'username']), keys(res.body.recruiter).join(','));
  ok('the response never contains the password or its hash', !res.text.includes(VALID.password) && !res.text.includes(row.passwordHash) && !/passwordHash|\$2[aby]\$/.test(res.text));
  ok('stored passwordHash is bcrypt (cost 12) and NOT the plaintext; it verifies the password',
    /^\$2[aby]\$12\$.{53}$/.test(row.passwordHash) && row.passwordHash !== VALID.password && bcrypt.compareSync(VALID.password, row.passwordHash));
  ok('createdBy = the admin actor (userId from the admin token)', row.createdBy === 'admin-1' && res.body.recruiter.createdBy === 'admin-1');
  const aud = A.db._tables.recruiterAuditLog;
  ok('exactly one RECRUITER_CREATED audit row: actorType ADMIN, actorId admin-1, entity = the recruiter, details = username only',
    aud.length === 1 && aud[0].action === 'RECRUITER_CREATED' && aud[0].actorType === 'ADMIN' && aud[0].actorId === 'admin-1'
    && aud[0].recruiterId === row.id && aud[0].entityType === 'recruiter' && aud[0].entityId === row.id && eq(aud[0].details, { username: 'ali.r' }));
  const txs = A.db._log.filter((l) => l.model === '$transaction').length;
  ok('the create and its audit row are written in ONE transaction', txs === 1 && A.db._log.findIndex((l) => l.op === 'create' && l.model === 'recruiter') > A.db._log.findIndex((l) => l.model === '$transaction'));

  // username normalisation
  const B = setup();
  const up = await createVia(B, { ...VALID, username: '  Ali.R  ' });
  ok('username is trimmed and lower-cased (" Ali.R " → "ali.r")', up.status === 201 && up.body.recruiter.username === 'ali.r');
  const phoneNorm = await createVia(B, { ...VALID, username: 'other1', phone: '06 12 34 56 78' });
  ok('phone with spaces is normalised ("06 12 34 56 78" → "0612345678")', phoneNorm.status === 201 && phoneNorm.body.recruiter.phone === '0612345678');
  const noPhone = await createVia(B, { ...VALID, username: 'other2', phone: '' });
  ok('phone is optional (empty → null)', noPhone.status === 201 && noPhone.body.recruiter.phone === null);

  // invalid fields
  const bad = [
    ['username too short', { ...VALID, username: 'ab' }, 'username', 'INVALID_USERNAME'],
    ['username with space', { ...VALID, username: 'ali r' }, 'username', 'INVALID_USERNAME'],
    ['username starting with a dot', { ...VALID, username: '.alir' }, 'username', 'INVALID_USERNAME'],
    ['username with Arabic / markup', { ...VALID, username: '<b>x</b>' }, 'username', 'INVALID_USERNAME'],
    ['username 41 chars', { ...VALID, username: 'a'.repeat(41) }, 'username', 'INVALID_USERNAME'],
    ['missing username', { ...VALID, username: undefined }, 'username', 'INVALID_USERNAME'],
    ['name 1 char', { ...VALID, name: 'A' }, 'name', 'INVALID_NAME'],
    ['name 81 chars', { ...VALID, name: 'a'.repeat(81) }, 'name', 'INVALID_NAME'],
    ['name with markup', { ...VALID, name: '<script>x</script>' }, 'name', 'INVALID_NAME'],
    ['password 7 chars', { ...VALID, password: '1234567' }, 'password', 'INVALID_PASSWORD'],
    ['password 129 chars', { ...VALID, password: 'p'.repeat(129) }, 'password', 'INVALID_PASSWORD'],
    ['password not a string', { ...VALID, password: 12345678 }, 'password', 'INVALID_PASSWORD'],
    ['phone letters', { ...VALID, phone: 'abc' }, 'phone', 'INVALID_PHONE'],
    ['phone too short', { ...VALID, phone: '123' }, 'phone', 'INVALID_PHONE'],
  ];
  const C = setup();
  const results = [];
  for (const [label, body, field, code] of bad) {
    const r = await createVia(C, body);
    results.push([label, r.status === 400 && r.body.code === 'INVALID_INPUT' && r.body.errors?.[field] === code && r.body.error === 'Données invalides.', JSON.stringify(r.body)]);
  }
  ok('every invalid field → 400 INVALID_INPUT with the right per-field code and fixed French text', results.every((x) => x[1]), results.filter((x) => !x[1]).map((x) => `${x[0]}: ${x[2]}`).join(' | '));
  ok('nothing stored and no audit row after invalid creates', C.db._tables.recruiter.length === 0 && C.db._tables.recruiterAuditLog.length === 0);
  const okBounds = await createVia(C, { ...VALID, username: 'bnd1', password: 'p'.repeat(8) });
  const okBounds2 = await createVia(C, { ...VALID, username: 'bnd2', phone: '+212600000002', password: 'p'.repeat(128) });
  ok('password bounds 8 and 128 are accepted', okBounds.status === 201 && okBounds2.status === 201);
  const notObj = await call(C.admin.create, req('/api/admin/recruiters', { method: 'POST', raw: 'not json', ...asAdmin() }));
  const arr = await call(C.admin.create, req('/api/admin/recruiters', { method: 'POST', raw: '[1]', ...asAdmin() }));
  ok('non-JSON / non-object body → 400 INVALID_INPUT', notObj.status === 400 && notObj.body.code === 'INVALID_INPUT' && arr.status === 400);

  // uniqueness
  const D = setup();
  await createVia(D, VALID);
  const dupUser = await createVia(D, { ...VALID, username: 'ALI.R', phone: '+212600000009' });
  const dupPhone = await createVia(D, { ...VALID, username: 'someone', phone: '+212612345678' });
  ok('duplicate username (any case) → 409 USERNAME_TAKEN', dupUser.status === 409 && dupUser.body.code === 'USERNAME_TAKEN' && dupUser.body.error === "Ce nom d'utilisateur est déjà utilisé.", JSON.stringify(dupUser.body));
  ok('duplicate phone → 409 PHONE_TAKEN', dupPhone.status === 409 && dupPhone.body.code === 'PHONE_TAKEN' && dupPhone.body.error === 'Ce numéro de téléphone est déjà utilisé.', JSON.stringify(dupPhone.body));
  ok('no row and no audit row written by the refused duplicates', D.db._tables.recruiter.length === 1 && D.db._tables.recruiterAuditLog.length === 1);

  // atomicity: a failing audit write rolls the recruiter back
  const E = setup({ db: makeRecruiterFakeDb({ failAuditCreate: true }) });
  const failed = await createVia(E, VALID);
  ok('a failing audit write rolls back the recruiter (500 SERVER_ERROR, nothing stored)',
    failed.status === 500 && failed.body.code === 'SERVER_ERROR' && E.db._tables.recruiter.length === 0 && E.db._tables.recruiterAuditLog.length === 0, JSON.stringify(failed.body));
  ok('the 500 body has fixed French text and never the internal message', failed.body.error === 'Erreur serveur.' && !failed.text.includes('injected'));

  // no actor
  const F = makeRecruiterFakeDb();
  let noActor = null;
  try { await S.adminCreateRecruiter(VALID, { db: F, actorId: null, now: T0 }); } catch (e) { noActor = e; }
  let emptyActor = null;
  try { await S.adminCreateRecruiter(VALID, { db: F, actorId: '', now: T0 }); } catch (e) { emptyActor = e; }
  ok('no admin actor → refused (UNAUTHORIZED) and nothing stored', noActor?.code === 'UNAUTHORIZED' && emptyActor?.code === 'UNAUTHORIZED' && F._tables.recruiter.length === 0);
  const tokNoId = signToken({ role: 'ADMIN' });
  const viaRoute = await call(setup({ db: F }).admin.create, req('/api/admin/recruiters', { method: 'POST', body: VALID, cookie: `auth_token=${tokNoId}` }));
  ok('an ADMIN token without userId/email → 401 UNAUTHORIZED (no actor), nothing stored', viaRoute.status === 401 && viaRoute.body.code === 'UNAUTHORIZED' && F._tables.recruiter.length === 0, JSON.stringify(viaRoute.body));
  const emailActor = await call(setup({ db: F }).admin.create, req('/api/admin/recruiters', { method: 'POST', body: VALID, cookie: `auth_token=${signToken({ email: 'boss@x.test', role: 'ADMIN' })}` }));
  ok('an ADMIN token with only an email → the email is the actor', emailActor.status === 201 && emailActor.body.recruiter.createdBy === 'boss@x.test');
}

// ── 2. Admin: list ─────────────────────────────────────────────────────────────
console.log('\n2. Admin list');
{
  const A = setup();
  for (const u of ['first1', 'second2', 'third3']) await createVia(A, { ...VALID, username: u, phone: null });
  const res = await call(A.admin.list, req('/api/admin/recruiters', asAdmin()));
  ok('list → 200 { recruiters } newest first', res.status === 200 && eq(keys(res.body), ['recruiters']) && eq(res.body.recruiters.map((r) => r.username), ['third3', 'second2', 'first1']), JSON.stringify(res.body.recruiters?.map((r) => r.username)));
  ok('list never contains a password hash or the password', !/passwordHash|\$2[aby]\$/.test(res.text) && !res.text.includes(VALID.password));
  const empty = await call(setup().admin.list, req('/api/admin/recruiters', asAdmin()));
  ok('empty list → { recruiters: [] }', empty.status === 200 && eq(empty.body, { recruiters: [] }));
}

// ── 3. Admin: enable / disable ─────────────────────────────────────────────────
console.log('\n3. Admin enable / disable');
{
  const A = setup();
  const id = (await createVia(A, VALID)).body.recruiter.id;
  const patch = (rid, body, extra = asAdmin()) => call(A.admin.setActive, req(`/api/admin/recruiters/${rid}`, { method: 'PATCH', body, ...extra }), ctx(rid));
  clock = T0.getTime() + 60_000;
  const dis = await patch(id, { action: 'disable', reason: '  Comportement abusif  ' });
  const row = A.db._tables.recruiter.find((r) => r.id === id);
  ok('disable → 200 { recruiter, changed:true }, isActive false', dis.status === 200 && dis.body.changed === true && dis.body.recruiter.isActive === false && eq(keys(dis.body), ['changed', 'recruiter']));
  ok('disable records disabledAt (clock), disabledBy (admin) and the trimmed reason',
    new Date(row.disabledAt).getTime() === clock && row.disabledBy === 'admin-1' && row.disabledReason === 'Comportement abusif');
  let aud = A.db._tables.recruiterAuditLog;
  ok('RECRUITER_DISABLED audit row (ADMIN, admin-1, details.reason)', aud.length === 2 && aud[1].action === 'RECRUITER_DISABLED' && aud[1].actorType === 'ADMIN' && aud[1].actorId === 'admin-1' && eq(aud[1].details, { reason: 'Comportement abusif' }));
  const dis2 = await patch(id, { action: 'disable', reason: 'again' });
  ok('a second disable is idempotent: changed:false, no extra audit row, reason unchanged',
    dis2.status === 200 && dis2.body.changed === false && A.db._tables.recruiterAuditLog.length === 2 && row.disabledReason === 'Comportement abusif');
  const en = await patch(id, { action: 'enable' });
  ok('enable → isActive true and disabledAt/By/Reason cleared', en.status === 200 && en.body.changed === true && row.isActive === true && row.disabledAt === null && row.disabledBy === null && row.disabledReason === null);
  aud = A.db._tables.recruiterAuditLog;
  ok('RECRUITER_ENABLED audit row written (details null)', aud.length === 3 && aud[2].action === 'RECRUITER_ENABLED' && aud[2].details === null);
  const en2 = await patch(id, { action: 'enable' });
  ok('a second enable is idempotent (changed:false, no audit row)', en2.body.changed === false && A.db._tables.recruiterAuditLog.length === 3);
  const disNoReason = await patch(id, { action: 'disable' });
  ok('disable without a reason → disabledReason null (still records when / by whom)', disNoReason.status === 200 && row.disabledReason === null && row.disabledBy === 'admin-1');
  const longReason = await patch(id, { action: 'enable' }).then(() => patch(id, { action: 'disable', reason: 'r'.repeat(500) }));
  ok('a long reason is truncated to 300 characters', longReason.status === 200 && row.disabledReason.length === 300);
  const unknown = await patch('00000000-0000-0000-0000-000000000000', { action: 'disable' });
  const malformed = await patch('bad id!', { action: 'disable' });
  ok('unknown id → 404 NOT_FOUND (fixed text)', unknown.status === 404 && unknown.body.code === 'NOT_FOUND' && unknown.body.error === 'Recruteur introuvable.');
  ok('malformed id → 404 NOT_FOUND', malformed.status === 404 && malformed.body.code === 'NOT_FOUND');
  const badAction = await patch(id, { action: 'delete' });
  const noAction = await patch(id, {});
  ok('action other than enable / disable → 400 INVALID_INPUT', badAction.status === 400 && badAction.body.code === 'INVALID_INPUT' && noAction.status === 400);
}

// ── 4. Login ───────────────────────────────────────────────────────────────────
console.log('\n4. Login');
{
  const A = setup();
  const created = await createVia(A, VALID);
  const id = created.body.recruiter.id;
  clock = T0.getTime() + 5 * 60_000;
  const res = track(await loginVia(A, { username: 'ali.r', password: VALID.password }));
  const row = A.db._tables.recruiter.find((r) => r.id === id);
  ok('correct credentials → 200', res.status === 200, JSON.stringify(res.body));
  ok('Set-Cookie: recruiter_token=…; HttpOnly; Path=/api/recruiter; Max-Age=604800; SameSite=Strict (no Secure outside production)',
    /^recruiter_token=[^;]+; HttpOnly; Path=\/api\/recruiter; Max-Age=604800; SameSite=Strict$/.test(res.setCookie || '') && RECRUITER_COOKIE_MAX_AGE === 604800, res.setCookie);
  const token = cookieOf(res.setCookie);
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  ok('the cookie holds an HS256 JWT { recruiterId, username, type: "recruiter" } valid 7 days',
    decoded.type === 'recruiter' && decoded.recruiterId === id && decoded.username === 'ali.r' && decoded.exp - decoded.iat === 7 * 24 * 3600 && !('role' in decoded) && !('affiliateId' in decoded));
  ok('body is exactly { recruiter: <profile view> } — the token is NOT in the body', eq(keys(res.body), ['recruiter']) && !res.text.includes(token));
  ok('profile view has exactly username / name / phone / status / createdAt / lastLoginAt', eq(keys(res.body.recruiter), ['createdAt', 'lastLoginAt', 'name', 'phone', 'status', 'username']));
  ok('profile values: ACTIVE, own username / name / phone, lastLoginAt = login time', res.body.recruiter.status === 'ACTIVE' && res.body.recruiter.username === 'ali.r'
    && res.body.recruiter.name === VALID.name && res.body.recruiter.phone === VALID.phone && res.body.recruiter.lastLoginAt === new Date(clock).toISOString());
  ok('profile never carries id, hash, createdBy, disabledBy or permission flags', !/passwordHash|\$2[aby]\$|createdBy|disabledBy|canCreate|canView|"id"/.test(res.text));
  ok('lastLoginAt updated in the database', new Date(row.lastLoginAt).getTime() === clock);
  const aud = A.db._tables.recruiterAuditLog;
  ok('RECRUITER_LOGIN audit row (actorType RECRUITER, actorId = recruiter, createdAt = clock)',
    aud.at(-1).action === 'RECRUITER_LOGIN' && aud.at(-1).actorType === 'RECRUITER' && aud.at(-1).actorId === id && aud.at(-1).recruiterId === id && new Date(aud.at(-1).createdAt).getTime() === clock);

  const caseRes = track(await loginVia(A, { username: 'ALI.R', password: VALID.password }));
  ok('username is case-insensitive ("ALI.R" logs in as "ali.r")', caseRes.status === 200 && caseRes.body.recruiter.username === 'ali.r');
  const spaced = track(await loginVia(A, { username: '  ali.r ', password: VALID.password }));
  ok('surrounding spaces in the username are ignored', spaced.status === 200);

  // failures — all INVALID_CREDENTIALS, identical body
  const auditBefore = A.db._tables.recruiterAuditLog.length;
  const wrong = track(await loginVia(A, { username: 'ali.r', password: 'Wrong-pass1' }));
  const unknown = track(await loginVia(A, { username: 'nobody', password: VALID.password }));
  const malformed = track(await loginVia(A, { username: 'a b', password: VALID.password }));
  const missing = track(await loginVia(A, {}));
  const missingPw = track(await loginVia(A, { username: 'ali.r' }));
  const longPw = track(await loginVia(A, { username: 'ali.r', password: 'x'.repeat(300) }));
  const nonString = track(await loginVia(A, { username: 'ali.r', password: 12345678 }));
  const all = [wrong, unknown, malformed, missing, missingPw, longPw, nonString];
  ok('wrong password / unknown user / malformed username / missing fields / 300-char or non-string password → 401 INVALID_CREDENTIALS',
    all.every((r) => r.status === 401 && eq(r.body, { code: 'INVALID_CREDENTIALS' })), all.map((r) => `${r.status}:${JSON.stringify(r.body)}`).join(' | '));
  ok('unknown user and wrong password give byte-identical responses (status, body, no cookie)', wrong.text === unknown.text && wrong.status === unknown.status && !wrong.setCookie && !unknown.setCookie);
  ok('failed logins carry no message / error text and set no cookie', all.every((r) => !('message' in r.body) && !('error' in r.body) && !r.setCookie));
  ok('failed logins write no audit row and do not touch lastLoginAt', A.db._tables.recruiterAuditLog.length === auditBefore && new Date(row.lastLoginAt).getTime() === clock);
  const badJson = track(await call(A.rec.login, req('/api/recruiter/auth', { method: 'POST', raw: '{oops' })));
  ok('non-JSON body → 400 { code: INVALID_INPUT } (no message)', badJson.status === 400 && eq(badJson.body, { code: 'INVALID_INPUT' }));

  // the unknown-user path still runs a bcrypt comparison (no fast path)
  const t1 = performance.now(); await loginVia(A, { username: 'nobody2', password: 'whatever-1' }); const unknownMs = performance.now() - t1;
  const t2 = performance.now(); await loginVia(A, { username: 'ali.r', password: 'whatever-1' }); const wrongMs = performance.now() - t2;
  ok('unknown username still pays a bcrypt comparison (timing within the same order as a wrong password)', unknownMs > 30 && unknownMs > wrongMs * 0.4, `${unknownMs.toFixed(0)}ms vs ${wrongMs.toFixed(0)}ms`);

  // disabled account
  await call(A.admin.setActive, req(`/api/admin/recruiters/${id}`, { method: 'PATCH', body: { action: 'disable' }, ...asAdmin() }), ctx(id));
  const disabledOk = track(await loginVia(A, { username: 'ali.r', password: VALID.password }));
  const disabledWrong = track(await loginVia(A, { username: 'ali.r', password: 'Wrong-pass1' }));
  ok('disabled + correct password → 403 { code: RECRUITER_DISABLED }, no cookie', disabledOk.status === 403 && eq(disabledOk.body, { code: 'RECRUITER_DISABLED' }) && !disabledOk.setCookie);
  ok('disabled + wrong password → 401 INVALID_CREDENTIALS (the disabled status is not disclosed)', disabledWrong.status === 401 && eq(disabledWrong.body, { code: 'INVALID_CREDENTIALS' }));

  // rate limit
  let limiterArgs = null;
  const L = setup({ db: A.db, rateLimit: (r, key, opts) => { limiterArgs = { key, opts }; return new Response('x', { status: 429 }); } });
  const limited = track(await loginVia(L, { username: 'ali.r', password: VALID.password }));
  ok('rate limiter returning a value → 429 { code: RATE_LIMITED } (own body, not the limiter\'s)', limited.status === 429 && eq(limited.body, { code: 'RATE_LIMITED' }) && !limited.setCookie);
  ok('the limiter is keyed "recruiter-auth", 10 / minute', limiterArgs?.key === 'recruiter-auth' && limiterArgs.opts.max === 10 && limiterArgs.opts.windowMs === 60_000);

  // production cookie
  process.env.NODE_ENV = 'production';
  try {
    await call(A.admin.setActive, req(`/api/admin/recruiters/${id}`, { method: 'PATCH', body: { action: 'enable' }, ...asAdmin() }), ctx(id));
    const prod = track(await loginVia(A, { username: 'ali.r', password: VALID.password }));
    ok('in production the cookie adds "; Secure"', /^recruiter_token=[^;]+; HttpOnly; Path=\/api\/recruiter; Max-Age=604800; SameSite=Strict; Secure$/.test(prod.setCookie || ''), prod.setCookie);
  } finally {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

// ── 5. /me ─────────────────────────────────────────────────────────────────────
console.log('\n5. /api/recruiter/me');
{
  const A = setup();
  const id = (await createVia(A, VALID)).body.recruiter.id;
  const login = await loginVia(A, { username: 'ali.r', password: VALID.password });
  const token = cookieOf(login.setCookie);
  const row = A.db._tables.recruiter.find((r) => r.id === id);
  const me = track(await meVia(A, token));
  ok('valid cookie → 200 { recruiter: toRecruiterProfileView(row) }', me.status === 200 && eq(me.body, { recruiter: toRecruiterProfileView(row) }) && !me.setCookie, JSON.stringify(me.body));
  const withOther = track(await call(A.rec.me, req('/api/recruiter/me', { cookie: `foo=bar; ${RECRUITER_COOKIE}=${token}; baz=1` })));
  ok('the recruiter cookie is found among other cookies', withOther.status === 200);
  const noCookie = track(await meVia(A, null));
  ok('no cookie → 401 { code: UNAUTHORIZED }', noCookie.status === 401 && eq(noCookie.body, { code: 'UNAUTHORIZED' }));
  const bearerOnly = track(await call(A.rec.me, req('/api/recruiter/me', { bearer: token })));
  ok('a valid recruiter token sent ONLY as Authorization Bearer → 401 (cookie only)', bearerOnly.status === 401 && eq(bearerOnly.body, { code: 'UNAUTHORIZED' }));
  const adminInCookie = track(await meVia(A, adminToken()));
  const affInCookie = track(await meVia(A, affiliateToken()));
  ok('an admin token in recruiter_token → 401', adminInCookie.status === 401 && eq(adminInCookie.body, { code: 'UNAUTHORIZED' }));
  ok('an affiliate token in recruiter_token → 401', affInCookie.status === 401 && eq(affInCookie.body, { code: 'UNAUTHORIZED' }));
  const noType = track(await meVia(A, signToken({ recruiterId: id, username: 'ali.r' })));
  const wrongType = track(await meVia(A, signToken({ recruiterId: id, username: 'ali.r', type: 'affiliate' })));
  const noId = track(await meVia(A, signToken({ username: 'ali.r', type: 'recruiter' })));
  ok('a token without type "recruiter", or without recruiterId → 401', [noType, wrongType, noId].every((r) => r.status === 401));
  const [h, p, s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), recruiterId: 'someone-else' })).toString('base64url');
  const tampered = track(await meVia(A, `${h}.${forged}.${s}`));
  const expired = track(await meVia(A, jwt.sign({ recruiterId: id, username: 'ali.r', type: 'recruiter', exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET, { algorithm: 'HS256' })));
  const wrongSecret = track(await meVia(A, jwt.sign({ recruiterId: id, username: 'ali.r', type: 'recruiter' }, 'not-the-secret', { algorithm: 'HS256', expiresIn: '7d' })));
  const algNone = track(await meVia(A, `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`));
  ok('tampered / expired / wrong-secret / alg:none tokens → 401', [tampered, expired, wrongSecret, algNone].every((r) => r.status === 401 && eq(r.body, { code: 'UNAUTHORIZED' })),
    [tampered, expired, wrongSecret, algNone].map((r) => r.status).join(','));
  const ghost = track(await meVia(A, recruiterToken('11111111-1111-1111-1111-111111111111')));
  ok('a token of a deleted / unknown recruiter → 401 UNAUTHORIZED and the cookie is cleared', ghost.status === 401 && eq(ghost.body, { code: 'UNAUTHORIZED' }) && /recruiter_token=; .*Max-Age=0/.test(ghost.setCookie || ''));
  const malformedId = track(await meVia(A, recruiterToken('bad id!')));
  ok('a token with a malformed recruiterId → 401', malformedId.status === 401);

  // disabled after login: refused immediately, cookie cleared
  await call(A.admin.setActive, req(`/api/admin/recruiters/${id}`, { method: 'PATCH', body: { action: 'disable' }, ...asAdmin() }), ctx(id));
  const after = track(await meVia(A, token));
  ok('recruiter disabled AFTER login → the next /me is 403 { code: RECRUITER_DISABLED } with the still-valid token',
    after.status === 403 && eq(after.body, { code: 'RECRUITER_DISABLED' }));
  ok('…and the response clears the cookie (recruiter_token=; HttpOnly; Path=/api/recruiter; Max-Age=0; SameSite=Strict)',
    /^recruiter_token=; HttpOnly; Path=\/api\/recruiter; Max-Age=0; SameSite=Strict$/.test(after.setCookie || ''), after.setCookie);
  await call(A.admin.setActive, req(`/api/admin/recruiters/${id}`, { method: 'PATCH', body: { action: 'enable' }, ...asAdmin() }), ctx(id));
  // Phase 6 part 2 (D1): disabling AND re-enabling bump tokenVersion — a re-enabled account never
  // revives a token issued before; a fresh login does work.
  const reEnabled = track(await meVia(A, token));
  ok('re-enabled → the OLD token stays refused (401 UNAUTHORIZED, cookie cleared): re-enabling never revives a session',
    reEnabled.status === 401 && eq(reEnabled.body, { code: 'UNAUTHORIZED' }) && /recruiter_token=; .*Max-Age=0/.test(reEnabled.setCookie || ''));
  const relogin = await loginVia(A, { username: 'ali.r', password: VALID.password });
  const freshToken = cookieOf(relogin.setCookie);
  ok('…a fresh login after re-enabling works (new token, /me 200)', relogin.status === 200 && freshToken && freshToken !== token && (await meVia(A, freshToken)).status === 200);
  ok('/me reads only the recruiter table (no audit write, no other model)', (() => {
    const before = A.db._log.length;
    return meVia(A, token).then(() => A.db._log.slice(before).every((l) => l.model === 'recruiter' && l.op === 'findUnique'));
  })() instanceof Promise);
  const beforeLen = A.db._log.length;
  await meVia(A, token);
  ok('/me performs exactly one recruiter.findUnique (read only)', eq(A.db._log.slice(beforeLen).map((l) => `${l.model}.${l.op}`), ['recruiter.findUnique']));

  // a database failure → generic SERVER_ERROR (no message)
  const broken = makeRecruiterFakeDb();
  broken.recruiter.findUnique = async () => { throw new Error('connection refused at 10.0.0.1'); };
  const B = setup({ db: broken });
  const errMe = track(await meVia(B, token));
  const errLogin = track(await loginVia(B, { username: 'ali.r', password: VALID.password }));
  ok('an unexpected error → 500 { code: SERVER_ERROR } on /me and login, never the internal message',
    errMe.status === 500 && eq(errMe.body, { code: 'SERVER_ERROR' }) && errLogin.status === 500 && eq(errLogin.body, { code: 'SERVER_ERROR' })
    && !errMe.text.includes('10.0.0.1') && !errLogin.text.includes('10.0.0.1'));
}

// ── 6. Logout ──────────────────────────────────────────────────────────────────
console.log('\n6. Logout');
{
  const A = setup();
  const id = (await createVia(A, VALID)).body.recruiter.id;
  const token = cookieOf((await loginVia(A, { username: 'ali.r', password: VALID.password })).setCookie);
  clock = T0.getTime() + 30 * 60_000;
  const out = await call(A.rec.logout, req('/api/recruiter/auth', { method: 'DELETE', cookie: `${RECRUITER_COOKIE}=${token}` }));
  ok('logout with a valid token → 200 { ok: true }, cookie cleared (Max-Age=0, same Path / flags)',
    out.status === 200 && eq(out.body, { ok: true }) && /^recruiter_token=; HttpOnly; Path=\/api\/recruiter; Max-Age=0; SameSite=Strict$/.test(out.setCookie || ''), out.setCookie);
  const aud = A.db._tables.recruiterAuditLog.at(-1);
  ok('RECRUITER_LOGOUT audit row (RECRUITER, own id, clock)', aud.action === 'RECRUITER_LOGOUT' && aud.actorType === 'RECRUITER' && aud.actorId === id && new Date(aud.createdAt).getTime() === clock);
  const n = A.db._tables.recruiterAuditLog.length;
  const anon = await call(A.rec.logout, req('/api/recruiter/auth', { method: 'DELETE' }));
  ok('logout without a token → still 200, cookie cleared, no audit row', anon.status === 200 && /Max-Age=0/.test(anon.setCookie || '') && A.db._tables.recruiterAuditLog.length === n);
  const bogus = await call(A.rec.logout, req('/api/recruiter/auth', { method: 'DELETE', cookie: `${RECRUITER_COOKIE}=garbage` }));
  const ghost = await call(A.rec.logout, req('/api/recruiter/auth', { method: 'DELETE', cookie: `${RECRUITER_COOKIE}=${recruiterToken('22222222-2222-2222-2222-222222222222')}` }));
  ok('logout with a garbage or unknown-recruiter token → 200, no audit row', bogus.status === 200 && ghost.status === 200 && A.db._tables.recruiterAuditLog.length === n);
  const adminTok = await call(A.rec.logout, req('/api/recruiter/auth', { method: 'DELETE', cookie: `${RECRUITER_COOKIE}=${adminToken()}` }));
  ok('logout with an admin token in recruiter_token → 200, no audit row (not a recruiter token)', adminTok.status === 200 && A.db._tables.recruiterAuditLog.length === n);
}

// ── 7. Cross-isolation of tokens and cookies ───────────────────────────────────
console.log('\n7. Cross-isolation (admin / affiliate / recruiter)');
{
  const A = setup();
  const id = (await createVia(A, VALID)).body.recruiter.id;
  const rTok = cookieOf((await loginVia(A, { username: 'ali.r', password: VALID.password })).setCookie);
  const adminRoutes = [
    ['list', (extra) => call(A.admin.list, req('/api/admin/recruiters', extra))],
    ['create', (extra) => call(A.admin.create, req('/api/admin/recruiters', { method: 'POST', body: { ...VALID, username: 'zz9', phone: null }, ...extra }))],
    ['setActive', (extra) => call(A.admin.setActive, req(`/api/admin/recruiters/${id}`, { method: 'PATCH', body: { action: 'disable' }, ...extra }), ctx(id))],
  ];
  const outcomes = {};
  for (const [name, fn] of adminRoutes) {
    outcomes[name] = {
      recruiterAsAuthToken: (await fn({ cookie: `auth_token=${rTok}` })).status,
      recruiterAsRecruiterCookie: (await fn({ cookie: `${RECRUITER_COOKIE}=${rTok}` })).status,
      affiliateAsAuthToken: (await fn({ cookie: `auth_token=${affiliateToken()}` })).status,
      affiliateCookie: (await fn({ cookie: `affiliate_token=${affiliateToken()}` })).status,
      userRole: (await fn({ cookie: `auth_token=${userToken()}` })).status,
      none: (await fn({})).status,
      bearerAdmin: (await fn({ bearer: adminToken() })).status,
    };
  }
  ok('a recruiter token in auth_token → 403 on every admin recruiter route (role check)', Object.values(outcomes).every((o) => o.recruiterAsAuthToken === 403), JSON.stringify(outcomes));
  ok('a recruiter token in its own cookie → 401 on every admin route (admin reads only auth_token)', Object.values(outcomes).every((o) => o.recruiterAsRecruiterCookie === 401));
  ok('an affiliate token (auth_token or affiliate_token cookie) → 403 / 401 on admin routes', Object.values(outcomes).every((o) => o.affiliateAsAuthToken === 403 && o.affiliateCookie === 401));
  ok('a USER-role token → 403 on admin routes', Object.values(outcomes).every((o) => o.userRole === 403));
  ok('no token → 401 on admin routes; an admin token as Bearer only → 401 (admin is cookie-only)', Object.values(outcomes).every((o) => o.none === 401 && o.bearerAdmin === 401));
  ok('none of the refused admin calls changed anything (still 1 recruiter, still active)', A.db._tables.recruiter.length === 1 && A.db._tables.recruiter[0].isActive === true);

  // recruiter token on an affiliate-protected handler
  let affiliateCalled = 0;
  // Phase 6 part 2: withAffiliateAuth reads the account per request — a minimal account table
  // (aff-1 active, tokenVersion 0) is injected; recruiter / admin tokens are refused before any read.
  const affAccountReads = [];
  const affDb = { affiliate: { async findUnique({ where }) { affAccountReads.push(where?.id); return where?.id === 'aff-1' ? { isActive: true, tokenVersion: 0 } : null; } } };
  const affHandler = withAffiliateAuth(async () => { affiliateCalled++; return Response.json({ ok: true }); }, { db: affDb });
  const viaAffCookie = await affHandler(req('/api/affiliate/x', { cookie: `affiliate_token=${rTok}` }));
  const viaBearer = await affHandler(req('/api/affiliate/x', { bearer: rTok }));
  const viaOwnCookie = await affHandler(req('/api/affiliate/x', { cookie: `${RECRUITER_COOKIE}=${rTok}` }));
  const adminOnAff = await affHandler(req('/api/affiliate/x', { bearer: adminToken() }));
  ok('a recruiter token on an affiliate route (affiliate_token cookie, Bearer, or its own cookie) → 401, handler never runs',
    viaAffCookie.status === 401 && viaBearer.status === 401 && viaOwnCookie.status === 401 && adminOnAff.status === 401 && affiliateCalled === 0);
  const realAff = await affHandler(req('/api/affiliate/x', { bearer: affiliateToken() }));
  ok('control: a real affiliate token still passes withAffiliateAuth', realAff.status === 200 && affiliateCalled === 1);
  ok('…and the recruiter / admin tokens were refused BEFORE any account read (only the real affiliate token was looked up)', JSON.stringify(affAccountReads) === '["aff-1"]');

  // admin / affiliate tokens on the recruiter routes
  const adminOnMe = track(await meVia(A, adminToken()));
  const adminAsAuthOnMe = track(await call(A.rec.me, req('/api/recruiter/me', { cookie: `auth_token=${adminToken()}` })));
  const affOnMe = track(await call(A.rec.me, req('/api/recruiter/me', { cookie: `affiliate_token=${affiliateToken()}`, bearer: affiliateToken() })));
  const noneOnMe = track(await meVia(A, null));
  ok('admin token (in recruiter_token or auth_token), affiliate token (cookie or Bearer) and no token → 401 on /me',
    [adminOnMe, adminAsAuthOnMe, affOnMe, noneOnMe].every((r) => r.status === 401 && eq(r.body, { code: 'UNAUTHORIZED' })));
  ok('a recruiter token never yields an admin or affiliate identity (no role / no affiliateId / type recruiter)', (() => {
    const d = jwt.verify(rTok, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return d.type === 'recruiter' && !('role' in d) && !('affiliateId' in d) && !('userId' in d);
  })());
}

// ── 8. Error hygiene ───────────────────────────────────────────────────────────
console.log('\n8. Error hygiene');
{
  const allowed = new Set([...RECRUITER_ERROR_CODES, 'SERVER_ERROR']);
  const shapes = recruiterBodies.map((r) => r.body);
  ok(`every recruiter-facing response body (${shapes.length}) is exactly { code } or { recruiter }`,
    shapes.length > 30 && shapes.every((b) => eq(keys(b), ['code']) || eq(keys(b), ['recruiter'])), JSON.stringify(shapes.filter((b) => !(eq(keys(b), ['code']) || eq(keys(b), ['recruiter'])))));
  ok('every recruiter error code is in RECRUITER_ERROR_CODES or SERVER_ERROR', shapes.filter((b) => 'code' in b).every((b) => allowed.has(b.code)));
  ok('no recruiter response carries message / error / stack / details text', recruiterBodies.every((r) => !/"(message|error|stack|details|errors)"/.test(r.text)));

  // admin error bodies: fixed French text per code; unknown → SERVER_ERROR
  const src = read('src/lib/recruiterRouteHandlers.js');
  const map = {};
  for (const m of src.matchAll(/^\s{2}(\w+): \[(\d{3}), (['"])(.+?)\3\],?$/gm)) map[m[1]] = [Number(m[2]), m[4]];
  ok('admin error map: fixed French text per code (INVALID_INPUT, USERNAME_TAKEN, PHONE_TAKEN, NOT_FOUND, UNAUTHORIZED)',
    eq(Object.keys(map).sort(), ['INVALID_INPUT', 'NOT_FOUND', 'PHONE_TAKEN', 'UNAUTHORIZED', 'USERNAME_TAKEN']) && map.USERNAME_TAKEN[0] === 409 && map.NOT_FOUND[0] === 404, JSON.stringify(map));
  const broken = makeRecruiterFakeDb();
  broken.recruiter.findMany = async () => { throw Object.assign(new Error('secret internal detail'), { code: 'P1001' }); };
  const unk = await call(setup({ db: broken }).admin.list, req('/api/admin/recruiters', asAdmin()));
  ok('unknown admin error (e.g. P1001) → 500 { code: SERVER_ERROR, error: "Erreur serveur." }, never the internal message',
    unk.status === 500 && eq(unk.body, { code: 'SERVER_ERROR', error: 'Erreur serveur.' }) && !unk.text.includes('secret internal detail'));
}

// ── 9. Static wiring and isolation ─────────────────────────────────────────────
console.log('\n9. Static wiring and model isolation');
{
  const routes = {
    'src/app/api/recruiter/auth/route.js': ['DELETE', 'POST'],
    'src/app/api/recruiter/me/route.js': ['GET'],
    'src/app/api/admin/recruiters/route.js': ['GET', 'POST'],
    'src/app/api/admin/recruiters/[id]/route.js': ['PATCH'],
  };
  const HTTP = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
  const found = {};
  for (const [f, want] of Object.entries(routes)) {
    const code = stripJs(read(f));
    found[f] = [...code.matchAll(/export\s+(?:const|async\s+function|function)\s+(\w+)/g)].map((m) => m[1]).filter((n) => HTTP.test(n)).sort();
    found[f + ':ok'] = eq(found[f], want);
  }
  ok('recruiter / admin route files export only the documented HTTP methods', Object.keys(routes).every((f) => found[f + ':ok']), JSON.stringify(found));
  const adminA = stripJs(read('src/app/api/admin/recruiters/route.js'));
  const adminB = stripJs(read('src/app/api/admin/recruiters/[id]/route.js'));
  ok('admin recruiter routes: every method is wrapped in withAdminAuth',
    /export const GET = withAdminAuth\(h\.list\)/.test(adminA) && /export const POST = withAdminAuth\(h\.create\)/.test(adminA) && /export const PATCH = withAdminAuth\(h\.setActive\)/.test(adminB));
  const me = stripJs(read('src/app/api/recruiter/me/route.js'));
  const auth = stripJs(read('src/app/api/recruiter/auth/route.js'));
  ok('/api/recruiter/me is wrapped in withRecruiterAuth; login / logout are public by design (login validates credentials, logout only clears)',
    /export const GET = withRecruiterAuth\(h\.me\)/.test(me) && /export const POST = h\.login/.test(auth) && /export const DELETE = h\.logout/.test(auth));
  ok('withRecruiterAuth reads ONLY the recruiter_token cookie (no Authorization header) and requires type "recruiter"', (() => {
    const c = stripJs(read('src/lib/middleware/withRecruiterAuth.js'));
    return !/authorization|Bearer/i.test(c) && /decoded\?\.type !== 'recruiter'/.test(c) && /RECRUITER_COOKIE = 'recruiter_token'/.test(c);
  })());

  const models = (file) => new Set([...stripJs(read(file)).matchAll(/\b(?:db|tx)\.(\$?\w+)/g)].map((m) => m[1]));
  const svc = models('src/lib/services/recruiterService.js');
  const hnd = models('src/lib/recruiterRouteHandlers.js');
  ok('recruiterService.js touches only recruiter / recruiterAuditLog / $transaction', [...svc].every((m) => ['recruiter', 'recruiterAuditLog', '$transaction'].includes(m)), [...svc].join(','));
  ok('recruiterRouteHandlers.js accesses no model directly (only via the service)', hnd.size === 0, [...hnd].join(','));
  ok('no recruiter Phase 2 file reads affiliates, orders, identity, UGC or any financial model',
    ['src/lib/services/recruiterService.js', 'src/lib/recruiterRouteHandlers.js', 'src/lib/middleware/withRecruiterAuth.js']
      // Only the recruiter's own permission-flag columns are exempt (canCreateAffiliates / canViewOrders).
      .every((f) => !/\baffiliate\b\.|affiliates|affiliateOrder|identityVerification|ugc|payout|balance|commission|wallet/i
        .test(stripJs(read(f)).replace(/\bcanCreateAffiliates\b|\bcanViewOrders\b/g, ''))));
  ok('every db / tx / prisma access in Phase 2 files targets recruiter, recruiterAuditLog or $transaction only',
    ['src/lib/services/recruiterService.js', 'src/lib/recruiterRouteHandlers.js', 'src/lib/middleware/withRecruiterAuth.js']
      .every((f) => !/\b(?:db|tx|prisma|client)\s*\.\s*(?!recruiter\b|recruiterAuditLog\b|\$transaction\b|js['"])[\w$]+/
        .test(stripJs(read(f)))));

  // runtime proof: the fake db throws on ANY other model — every flow above ran on it
  const probe = makeRecruiterFakeDb();
  let threw = false;
  try { void probe.affiliate.findMany; } catch { threw = true; }
  ok('the fake db refuses access to any other model (so every flow above used recruiter / recruiterAuditLog only)', threw);

  // Phase 6 part 2 (documented allowance, docs/recruiter-system.md §8): withAffiliateAuth (per-request
  // session check) and rateLimit.js (the additive rateLimitStoreKey export) differ from the commit Part 2
  // started from by EXACTLY their pinned diff; withAdminAuth, withAuth, authService and the Edge middleware are unchanged.
  const { checkUnchangedExceptPart2, PART2_BASE } = await import('./lib/phase6Part2Allowance.mjs');
  let p2;
  try {
    p2 = checkUnchangedExceptPart2(PART2_BASE, ['src/lib/middleware/withAdminAuth.js', 'src/lib/middleware/withAffiliateAuth.js',
      'src/lib/middleware/withAuth.js', 'src/lib/services/authService.js', 'src/middleware.jsx', 'src/lib/rateLimit.js']);
  } catch (e) { p2 = { ok: false, error: `git error ${e.status}` }; }
  ok('withAdminAuth, withAuth, authService and the Edge middleware are unchanged; withAffiliateAuth and rateLimit differ ONLY by the exact pinned Phase 6 part 2 diff',
    p2.ok && p2.allowed.every((f) => ['src/lib/middleware/withAffiliateAuth.js', 'src/lib/rateLimit.js'].includes(f)), JSON.stringify(p2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
