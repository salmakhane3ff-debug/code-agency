/**
 * scripts/affiliateActivationRecovery.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 6 part 1: ADMIN ACTIVATION RECOVERY.
 * An affiliate whose activation code was used before them reports it (public form, always
 * the same answer); an admin reviews it; approval replaces the password with an unusable one,
 * invalidates the active code (ADMIN_RECOVERY) and issues a fresh ADMIN code shown ONCE to that
 * admin; the affiliate sets a password on the existing activation page. The account stays
 * inactive until the existing admin approval. Recruiters can never see, approve or intercept it.
 *
 * Runs on the in-memory fake db (scripts/lib/recruiterFakeDb.mjs, { recovery: true } +
 * password-only affiliate update) — never a real database. Real-PostgreSQL concurrency /
 * migration checks are done separately on an isolated disposable database.
 * ─────────────────────────────────────────────────────────────────────────────
 */

process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'activation-recovery-test-secret-not-real';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const { recruiterAffiliateHandlers } = await import('../src/lib/recruiterAffiliateRouteHandlers.js');
const { recruiterActivationHandlers } = await import('../src/lib/recruiterActivationRouteHandlers.js');
const { affiliateActivationHandlers } = await import('../src/lib/affiliateActivationHandlers.js');
const { activationRecoveryHandlers, RECOVERY_RATE } = await import('../src/lib/affiliateActivationRecoveryHandlers.js');
const { recruiterNetworkHandlers } = await import('../src/lib/recruiterNetworkRouteHandlers.js');
const { recruiterHandlers } = await import('../src/lib/recruiterRouteHandlers.js');
const { recruiterWalletHandlers } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { signToken, comparePassword } = await import('../src/lib/services/authService.js');
const { rateLimit: realRateLimit } = await import('../src/lib/rateLimit.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const big = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));

const T0 = new Date('2026-11-05T09:00:00.000Z');
const HOUR = 3600 * 1000;
const at = (ms) => () => new Date(T0.getTime() + ms);
const noLimit = () => null;
const CODE_RE = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const PW = 'MonMotDePasse9';
const HIJACK_PW = 'Hijack3rPass1';

// Capture every console line: no code may ever be logged.
const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : big(x))).join(' ')); orig(...a); };
}

let ipSeq = 0;
const req = (url, { method = 'GET', body, cookie, raw, ip } = {}) => {
  const headers = { 'x-forwarded-for': ip || `10.77.${(ipSeq >> 8) & 255}.${(++ipSeq) & 255}` };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
};
const call = async (handler, r, ctx = {}) => {
  const res = await handler(r, ctx);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, cache: res.headers.get('cache-control'), cookie: res.headers.get('set-cookie') };
};
const ADMIN_ID = 'admin-1';
const adminCookie = (id = ADMIN_ID) => `auth_token=${signToken({ userId: id, email: `${id}@example.test`, role: 'ADMIN' })}`;
const recruiterCookie = (rec) => `recruiter_token=${signToken({ recruiterId: rec.id, username: rec.username, type: 'recruiter' })}`;
const params = (id) => ({ params: Promise.resolve({ id }) });

/** One fake db (recovery mode) with recruiters A and B and every handler. */
function setup({ now = at(0), rateLimit = noLimit, failOnce = {} } = {}) {
  const db = makeRecruiterFakeDb({ recovery: true, allowPasswordUpdate: true, failOnce });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  const clock = { now };
  const nowFn = () => clock.now();
  const ha = recruiterAffiliateHandlers({ db, now: nowFn, rateLimit });
  const hr = recruiterActivationHandlers({ db, now: nowFn, rateLimit });
  const hp = affiliateActivationHandlers({ db, now: nowFn, rateLimit });
  const hv = activationRecoveryHandlers({ db, now: nowFn, rateLimit });
  return {
    db, A, B, clock,
    create: withRecruiterAuth(ha.createAffiliate), list: withRecruiterAuth(ha.affiliates),
    pending: withRecruiterAuth(hr.pending), regenerate: withRecruiterAuth(hr.regenerate), redeem: hp.redeem,
    request: hv.request, adminList: withAdminAuth(hv.list), adminDetail: withAdminAuth(hv.detail), adminReview: withAdminAuth(hv.review),
    nodes: withRecruiterAuth(recruiterNetworkHandlers({ db, rateLimit }).nodes),
    stats: withRecruiterAuth(recruiterNetworkHandlers({ db, rateLimit }).stats),
    me: withRecruiterAuth(recruiterHandlers({ db, now: nowFn, rateLimit }).me),
    wallet: withRecruiterAuth(recruiterWalletHandlers({ db, now: nowFn, rateLimit }).wallet),
  };
}
let uniq = 0;
const createAff = async (E, rec = E.A, over = {}) => {
  const body = { username: `rcv${++uniq}x`, name: `Affilié ${uniq}`, requestId: randomUUID(), ...over };
  const r = await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body, cookie: recruiterCookie(rec) }));
  return { id: r.body?.affiliate?.id, username: body.username, code: r.body?.activation?.code, res: r };
};
const redeem = (E, code, password = PW) => call(E.redeem, req('/api/affiliate-activation', { method: 'POST', body: { code, password, passwordConfirm: password } }));
const ask = (E, body, opts = {}) => call(E.request, req('/api/affiliate-activation/recovery', { method: 'POST', body, ...opts }));
const MSG = 'Mon code a déjà été utilisé par quelqu\'un d\'autre, je ne peux pas activer mon compte.';
const review = (E, id, body, cookie = adminCookie()) => call(E.adminReview, req(`/api/admin/activation-recovery/${id}`, { method: 'POST', body, cookie }), params(id));
const detail = (E, id, cookie = adminCookie()) => call(E.adminDetail, req(`/api/admin/activation-recovery/${id}`, { cookie }), params(id));
const adminList = (E, qs = '', cookie = adminCookie()) => call(E.adminList, req(`/api/admin/activation-recovery${qs}`, { cookie }));
const recoveries = (E, affiliateId) => E.db._tables.affiliateActivationRecovery.filter((r) => !affiliateId || r.affiliateId === affiliateId);
const codeRows = (E, affiliateId) => E.db._tables.affiliateActivationCode.filter((c) => c.affiliateId === affiliateId);
const affRow = (E, id) => E.db._tables.affiliate.find((a) => a.id === id);
const audits = (E, action) => E.db._tables.recruiterAuditLog.filter((a) => !action || a.action === action);
const snapshot = (E) => big(E.db._tables);
const OK202 = '{"ok":true}';

/** A hijack scenario: recruiter A creates the affiliate, someone redeems the code first. */
async function hijacked(E) {
  const a = await createAff(E);
  const r = await redeem(E, a.code, HIJACK_PW);
  if (r.status !== 200) throw new Error(`setup: hijack redemption failed ${r.text}`);
  return a;
}

// ── 1. a valid request ───────────────────────────────────────────────────────
console.log('\n1. A valid recovery request');
{
  const E = setup();
  const a = await hijacked(E);
  const before = audits(E).length;
  // Phase 6 part 2 (D6): the request IP is recorded ONLY when a configured trusted proxy vouches for
  // it — here TRUSTED_PROXY_MODE=proxy (last x-forwarded-for hop), for this one request.
  const savedMode = process.env.TRUSTED_PROXY_MODE;
  process.env.TRUSTED_PROXY_MODE = 'proxy';
  let r;
  try { r = await ask(E, { identifier: a.username.toUpperCase(), message: `  ${MSG}  `, contactPhone: '06 12 34 56 78' }, { ip: '10.9.8.7' }); }
  finally { if (savedMode === undefined) delete process.env.TRUSTED_PROXY_MODE; else process.env.TRUSTED_PROXY_MODE = savedMode; }
  ok('an inactive code-flow affiliate → 202 { ok:true }, no-store, no cookie', r.status === 202 && r.text === OK202 && /no-store/.test(r.cache || '') && !r.cookie, r.text);
  const rows = recoveries(E, a.id);
  ok('exactly 1 PENDING request: trimmed message, normalised contact phone, the TRUSTED request IP, requestedAt = now, no review fields',
    rows.length === 1 && rows[0].status === 'PENDING' && rows[0].message === MSG && rows[0].contactPhone === '0612345678' && rows[0].requestIp === '10.9.8.7'
    && new Date(rows[0].requestedAt).getTime() === T0.getTime() && rows[0].reviewedBy === null && rows[0].reviewedAt === null && rows[0].reviewNote === null && rows[0].activationCodeId === null, big(rows));
  // Without a trusted-proxy configuration, a client-supplied x-forwarded-for is NEVER recorded.
  const E2 = setup();
  const a2 = await hijacked(E2);
  const savedMode2 = process.env.TRUSTED_PROXY_MODE;
  delete process.env.TRUSTED_PROXY_MODE;
  try { await ask(E2, { identifier: a2.username, message: MSG }, { ip: '203.0.113.66' }); }
  finally { if (savedMode2 !== undefined) process.env.TRUSTED_PROXY_MODE = savedMode2; }
  const rows2 = recoveries(E2, a2.id);
  ok('no trusted proxy configured → a spoofable x-forwarded-for is NOT recorded (requestIp null)', rows2.length === 1 && rows2[0].requestIp === null, big(rows2));
  const au = audits(E, 'ACTIVATION_RECOVERY_REQUESTED');
  ok('exactly 1 ACTIVATION_RECOVERY_REQUESTED audit row: SYSTEM / PUBLIC_FORM, recruiterId null, entity = the affiliate, details = { recoveryId }',
    audits(E).length === before + 1 && au.length === 1 && au[0].actorType === 'SYSTEM' && au[0].actorId === 'PUBLIC_FORM' && au[0].recruiterId === null
    && au[0].entityType === 'affiliate' && au[0].entityId === a.id && eq(au[0].details, { recoveryId: rows[0].id }), big(au));
  const byPhone = setup();
  const b = await createAff(byPhone, byPhone.A, { phone: '+212611223344' });
  const rp = await ask(byPhone, { identifier: '+212611223344', message: MSG });
  ok('the identifier may be the phone (exact username first, then phone)', rp.status === 202 && recoveries(byPhone, b.id).length === 1, rp.text);
  const unused = setup();
  const c = await createAff(unused);
  ok('an affiliate whose code was never used (e.g. never handed over) may also ask', (await ask(unused, { identifier: c.username, message: MSG })).status === 202 && recoveries(unused, c.id).length === 1);
}

// ── 2. no enumeration, duplicates ────────────────────────────────────────────
console.log('\n2. No enumeration; duplicates absorbed');
{
  const E = setup();
  const a = await hijacked(E);
  const active = await hijacked(E);
  E.db._tables.affiliate.find((x) => x.id === active.id).isActive = true; // activated by the admin
  const adminMade = E.db._seed.affiliate({ username: 'admin.made', password: '$2a$12$' + 'b'.repeat(53), isActive: false }); // no code: not the code flow
  const first = await ask(E, { identifier: a.username, message: MSG });
  const snap = snapshot(E);
  const cases = {
    unknown: await ask(E, { identifier: 'nobody.here', message: MSG }),
    unknownPhone: await ask(E, { identifier: '+212699999999', message: MSG }),
    active: await ask(E, { identifier: active.username, message: MSG }),
    adminCreated: await ask(E, { identifier: adminMade.username, message: MSG }),
    duplicate: await ask(E, { identifier: a.username, message: `${MSG} (encore)` }),
  };
  ok('unknown username / unknown phone / active affiliate / admin-created (no code) / duplicate → byte-identical 202 { ok:true }',
    first.status === 202 && Object.values(cases).every((r) => r.status === 202 && r.text === first.text && r.text === OK202), Object.entries(cases).map(([k, r]) => `${k}:${r.status}:${r.text}`).join(' | '));
  ok('…and none of them wrote anything (no extra request, no audit row)', snapshot(E) === snap && recoveries(E).length === 1);
  // concurrent duplicates
  const C = setup();
  const x = await hijacked(C);
  const all = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(C, { identifier: x.username, message: `${MSG} #${i}` })));
  ok('10 concurrent requests for one affiliate → all 202, exactly 1 PENDING row and 1 audit row',
    all.every((r) => r.status === 202 && r.text === OK202) && recoveries(C, x.id).filter((r) => r.status === 'PENDING').length === 1 && audits(C, 'ACTIVATION_RECOVERY_REQUESTED').length === 1,
    `${recoveries(C, x.id).length} rows`);
  // a new request is possible once the previous one was reviewed
  await review(C, recoveries(C, x.id)[0].id, { action: 'reject', note: 'pas vérifié' });
  ok('after a review, a new request opens a new PENDING row', (await ask(C, { identifier: x.username, message: MSG })).status === 202 && recoveries(C, x.id).filter((r) => r.status === 'PENDING').length === 1 && recoveries(C, x.id).length === 2);
}

// ── 3. validation and rate limits ────────────────────────────────────────────
console.log('\n3. Validation, strict body and rate limits');
{
  const E = setup();
  const snap = snapshot(E);
  const bad = [
    [{ identifier: 'ab', message: MSG }, { identifier: 'INVALID_IDENTIFIER' }],
    [{ identifier: 'a b c', message: MSG }, { identifier: 'INVALID_IDENTIFIER' }],
    [{ identifier: 'x'.repeat(41), message: MSG }, { identifier: 'INVALID_IDENTIFIER' }],
    [{ identifier: 'valid.user', message: 'trop cour' }, { message: 'INVALID_MESSAGE' }], // 9 < 10 characters
    [{ identifier: 'valid.user', message: 'x'.repeat(501) }, { message: 'INVALID_MESSAGE' }],
    [{ identifier: 'valid.user', message: `${MSG} <script>` }, { message: 'INVALID_MESSAGE' }],
    [{ identifier: 'valid.user', message: MSG, contactPhone: '12345' }, { contactPhone: 'INVALID_PHONE' }],
    [{ identifier: 'valid.user', message: MSG, password: 'x' }, { body: 'UNKNOWN_FIELD' }],
    [{ identifier: 'valid.user', message: MSG, affiliateId: 'x' }, { body: 'UNKNOWN_FIELD' }],
  ];
  const results = [];
  for (const [body, fields] of bad) results.push([await ask(E, body), fields]);
  ok(`invalid formats / unknown keys → 400 { code: INVALID_INPUT, fields } with the exact field codes only (${bad.length} cases)`,
    results.every(([r, f]) => r.status === 400 && eq(r.body, { code: 'INVALID_INPUT', fields: f })), results.map(([r]) => r.text).join(' | '));
  const nonObj = await call(E.request, req('/api/affiliate-activation/recovery', { method: 'POST', raw: '[1,2]' }));
  const broken = await call(E.request, req('/api/affiliate-activation/recovery', { method: 'POST', raw: '{nope' }));
  ok('a non-object / malformed body → 400 INVALID_INPUT body UNKNOWN_FIELD', [nonObj, broken].every((r) => r.status === 400 && eq(r.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } })), `${nonObj.text} ${broken.text}`);
  ok('…nothing written by the invalid requests', snapshot(E) === snap);

  const L = setup({ rateLimit: realRateLimit });
  const ip = '10.200.1.1';
  const ipRes = [];
  for (let i = 0; i < RECOVERY_RATE.ip.max + 1; i++) ipRes.push(await ask(L, { identifier: `who${i}.there`, message: MSG }, { ip }));
  ok(`the IP limit: ${RECOVERY_RATE.ip.max} requests per IP and window, then 429 { code: RATE_LIMITED }`,
    ipRes.slice(0, RECOVERY_RATE.ip.max).every((r) => r.status === 202) && ipRes[RECOVERY_RATE.ip.max].status === 429 && eq(ipRes[RECOVERY_RATE.ip.max].body, { code: 'RATE_LIMITED' }), ipRes.map((r) => r.status).join(','));
  const ip2 = '10.200.2.2';
  const idRes = [];
  for (let i = 0; i < RECOVERY_RATE.identifier.max + 1; i++) idRes.push(await ask(L, { identifier: 'same.target', message: MSG }, { ip: ip2 }));
  ok(`the identifier limit: ${RECOVERY_RATE.identifier.max} requests per identifier, then 429 (before the IP limit)`,
    RECOVERY_RATE.identifier.max < RECOVERY_RATE.ip.max && idRes.slice(0, RECOVERY_RATE.identifier.max).every((r) => r.status === 202) && idRes[RECOVERY_RATE.identifier.max].status === 429, idRes.map((r) => r.status).join(','));
  const other = await ask(L, { identifier: 'another.target', message: MSG }, { ip: ip2 });
  ok('…another identifier from that IP is still accepted (limit keyed by identifier)', other.status === 202, other.text);
}

// ── 4. admin authorization; recruiters denied ────────────────────────────────
console.log('\n4. Admin authorization; recruiters never see or act on a recovery');
{
  const E = setup();
  const a = await hijacked(E);
  await ask(E, { identifier: a.username, message: MSG });
  const id = recoveries(E, a.id)[0].id;
  const snap = snapshot(E);
  const tokens = {
    none: '', // no cookie at all
    affiliate: `auth_token=${signToken({ affiliateId: a.id, username: a.username, type: 'affiliate' })}`,
    recruiterAsAdminCookie: `auth_token=${signToken({ recruiterId: E.A.id, username: 'rec.a', type: 'recruiter' })}`,
    recruiterCookie: recruiterCookie(E.A),
    customer: `auth_token=${signToken({ userId: 'u-1', role: 'CUSTOMER' })}`,
    forged: 'auth_token=eyJhbGciOiJub25lIn0.eyJyb2xlIjoiQURNSU4ifQ.',
  };
  const denied = [];
  for (const [name, cookie] of Object.entries(tokens)) {
    for (const [what, r] of [
      ['list', await adminList(E, '', cookie)],
      ['detail', await detail(E, id, cookie)],
      ['approve', await review(E, id, { action: 'approve' }, cookie)],
      ['reject', await review(E, id, { action: 'reject' }, cookie)],
    ]) denied.push([`${name}/${what}`, r]);
  }
  ok(`no / affiliate / recruiter / customer / forged tokens → 401 or 403 on list, detail, approve and reject (${denied.length} cases)`,
    denied.every(([, r]) => r.status === 401 || r.status === 403), denied.filter(([, r]) => r.status !== 401 && r.status !== 403).map(([n, r]) => `${n}:${r.status}`).join(','));
  ok('…none of them returned a code or request data, and nothing changed', denied.every(([, r]) => !CODE_RE.test(String(r.body?.activation?.code || '')) && !r.text.includes(MSG.slice(0, 20))) && snapshot(E) === snap);
  const r1 = stripJs(read('src/app/api/admin/activation-recovery/route.js'));
  const r2 = stripJs(read('src/app/api/admin/activation-recovery/[id]/route.js'));
  const r3 = stripJs(read('src/app/api/affiliate-activation/recovery/route.js'));
  ok('admin routes: GET = withAdminAuth(h.list); GET = withAdminAuth(h.detail), POST = withAdminAuth(h.review); nothing else exported',
    /export const GET = withAdminAuth\(h\.list\);/.test(r1) && (r1.match(/export const [A-Z]+/g) || []).length === 1
    && /export const GET = withAdminAuth\(h\.detail\);/.test(r2) && /export const POST = withAdminAuth\(h\.review\);/.test(r2) && (r2.match(/export const [A-Z]+/g) || []).length === 2);
  ok('the public route exports POST = h.request only (no admin action reachable without withAdminAuth)', /export const POST = h\.request;/.test(r3) && (r3.match(/export const [A-Z]+/g) || []).length === 1 && !/review|approve|list|detail/.test(r3.replace(/\/\*[\s\S]*?\*\//g, '')));
  // no recruiter-facing file touches the recovery
  const walk = (dir) => readdirSync(join(ROOT, dir), { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(join(ROOT, f)).isFile() && /\.(m?[jt]sx?)$/.test(f));
  const recruiterFiles = [...walk('src/app/api/recruiter'), ...walk('src/app/recruiter'), ...walk('src/lib').filter((f) => /recruiter/i.test(f.split(sep).pop()))];
  const touching = recruiterFiles.filter((f) => /affiliateActivationRecovery|ActivationRecovery|activation-recovery|adminApproveRecovery|RecoveryService/.test(stripJs(read(f))));
  ok(`no recruiter route / page / service references the recovery (${recruiterFiles.length} files scanned)`, touching.length === 0, touching.join(','));
}

// ── 5. approval ──────────────────────────────────────────────────────────────
console.log('\n5. Approval: old credentials invalidated, a fresh ADMIN code shown once');
{
  const E = setup({ now: at(HOUR) });
  const a = await hijacked(E);
  const hijackedHash = affRow(E, a.id).password;
  ok('setup: the hijacker\'s password works before the recovery', await comparePassword(HIJACK_PW, hijackedHash));
  await ask(E, { identifier: a.username, message: MSG, contactPhone: '0612345678' });
  const rid = recoveries(E, a.id)[0].id;
  const auditBefore = audits(E).length;
  const r = await review(E, rid, { action: 'approve', note: '  Vérifié par téléphone   avec le numéro connu ' });
  const code = r.body?.activation?.code;
  const m = CODE_RE.exec(code || '');
  ok('approve → 201 { activation: { code, expiresAt } }, no-store, no cookie', r.status === 201 && eq(keys(r.body), ['activation']) && eq(keys(r.body.activation), ['code', 'expiresAt']) && /no-store/.test(r.cache || '') && !r.cookie, r.text);
  ok('the code has the activation format (16 + 43 base64url; verifier 256 bits) and expires 24 h after the approval',
    !!m && Buffer.from(m[2], 'base64url').length === 32 && r.body.activation.expiresAt === new Date(T0.getTime() + HOUR + 24 * HOUR).toISOString(), r.body.activation?.expiresAt);
  const row = affRow(E, a.id);
  ok('the affiliate password is REPLACED (an unusable bcrypt hash): the hijacker\'s password no longer matches',
    row.password !== hijackedHash && /^\$2[aby]\$12\$.{53}$/.test(row.password) && !(await comparePassword(HIJACK_PW, row.password)) && !(await comparePassword(code, row.password)));
  ok('…and the account stays INACTIVE', row.isActive === false);
  const codes = codeRows(E, a.id);
  const admin = codes.filter((c) => c.createdByType === 'ADMIN');
  ok('a new ADMIN code row: createdById = the admin, selector of the code, sha256(verifier), fingerprint of the NEW password hash, active',
    admin.length === 1 && admin[0].createdById === ADMIN_ID && admin[0].selector === m[1] && admin[0].verifierHash === sha256(m[2])
    && admin[0].passwordFingerprint === sha256(row.password) && admin[0].usedAt === null && admin[0].invalidatedAt === null, big(admin));
  ok('exactly one active code for the affiliate (the ADMIN one); the hijacked code stays USED', codes.filter((c) => c.usedAt === null && c.invalidatedAt === null).length === 1
    && codes.filter((c) => c.createdByType === 'RECRUITER').every((c) => c.usedAt !== null));
  const rec = recoveries(E, a.id)[0];
  ok('the request is APPROVED: reviewedBy = the admin, reviewedAt = now, the (cleaned) note, activationCodeId = the new code',
    rec.status === 'APPROVED' && rec.reviewedBy === ADMIN_ID && new Date(rec.reviewedAt).getTime() === T0.getTime() + HOUR
    && rec.reviewNote === 'Vérifié par téléphone avec le numéro connu' && rec.activationCodeId === admin[0].id, big(rec));
  const au = audits(E, 'ACTIVATION_RECOVERY_APPROVED');
  ok('exactly 1 ACTIVATION_RECOVERY_APPROVED audit row: ADMIN, actorId = the admin, recruiterId null, details = { recoveryId, activationCodeId, note } (no code)',
    audits(E).length === auditBefore + 1 && au.length === 1 && au[0].actorType === 'ADMIN' && au[0].actorId === ADMIN_ID && au[0].recruiterId === null && au[0].entityId === a.id
    && eq(au[0].details, { recoveryId: rid, activationCodeId: admin[0].id, note: 'Vérifié par téléphone avec le numéro connu' }), big(au));

  // the admin views never contain a code
  const l = await adminList(E);
  const d = await detail(E, rid);
  ok('admin list → the request with the affiliate (username, isActive) and its recruiter username; no-store', l.status === 200 && /no-store/.test(l.cache || '')
    && l.body.recoveries.some((x) => x.id === rid && x.status === 'APPROVED' && x.affiliate?.username === a.username && x.recruiterUsername === 'rec.a'), l.text);
  ok('admin detail → the request, the affiliate, the recruiter, identity status, code history (states) and the audit trail',
    d.status === 200 && eq(keys(d.body), ['affiliate', 'audit', 'codes', 'identityStatus', 'otherRequests', 'recruiter', 'request']) && d.body.recruiter?.username === 'rec.a'
    && d.body.identityStatus === 'NONE' && d.body.codes.length === 2 && d.body.codes.some((c) => c.state === 'USED') && d.body.codes.some((c) => c.state === 'ACTIVE' && c.createdByType === 'ADMIN')
    && ['AFFILIATE_CREATED', 'AFFILIATE_CREDENTIALS_SET', 'ACTIVATION_RECOVERY_REQUESTED', 'ACTIVATION_RECOVERY_APPROVED'].every((x) => d.body.audit.some((e) => e.action === x)), d.text);
  ok('neither the list nor the detail contains the code, its verifier, a selector, a verifierHash or a fingerprint',
    [l.text, d.text].every((t) => !t.includes(code) && !t.includes(m[2]) && !t.includes(m[1]) && !/selector|verifierHash|passwordFingerprint|\$2[aby]\$/.test(t)));
  const detailCodeKeys = keys(d.body.codes[0]);
  ok('a code-history entry carries states only', eq(detailCodeKeys, ['createdAt', 'createdById', 'createdByType', 'expiresAt', 'failedAttempts', 'id', 'invalidatedAt', 'invalidatedReason', 'state', 'usedAt']), JSON.stringify(detailCodeKeys));

  // the recruiter never sees it, cannot regenerate
  const rec2 = recruiterCookie(E.A);
  const views = [
    await call(E.list, req('/api/recruiter/affiliates', { cookie: rec2 })),
    await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: rec2 })),
    await call(E.nodes, req('/api/recruiter/network/nodes', { cookie: rec2 })),
    await call(E.stats, req('/api/recruiter/network/stats', { cookie: rec2 })),
    await call(E.me, req('/api/recruiter/me', { cookie: rec2 })),
    await call(E.wallet, req('/api/recruiter/wallet', { cookie: rec2 })),
  ];
  ok('no recruiter GET (affiliates, pending activations, network nodes / stats, me, wallet) contains the recovery code, its selector or the request data',
    views.every((v) => v.status === 200 && !v.text.includes(code) && !v.text.includes(m[1]) && !v.text.includes(MSG.slice(0, 20)) && !v.text.includes(rid)), views.map((v) => v.status).join(','));
  const g = await call(E.regenerate, req(`/api/recruiter/affiliates/${a.id}/activation-code`, { method: 'POST', cookie: rec2 }), params(a.id));
  ok('the recruiter cannot regenerate after the recovery → 409 ACTIVATION_NOT_AVAILABLE; the ADMIN code stays active', g.status === 409 && eq(g.body, { code: 'ACTIVATION_NOT_AVAILABLE' })
    && codeRows(E, a.id).find((c) => c.id === admin[0].id).invalidatedAt === null, g.text);
  ok('the affiliate is not in the recruiter pending list', !views[1].body.pending.some((p) => p.affiliate.id === a.id));

  // the new code: works once through the existing activation page
  const r1 = await redeem(E, code, PW);
  ok('the ADMIN code works through the existing activation (200): the password is set, the account stays INACTIVE',
    r1.status === 200 && eq(r1.body, { ok: true }) && (await comparePassword(PW, affRow(E, a.id).password)) && affRow(E, a.id).isActive === false, r1.text);
  const r2 = await redeem(E, code, 'AutreMotDePasse7');
  ok('…a second use fails (single use), the password is unchanged', r2.status === 400 && eq(r2.body, { code: 'INVALID_OR_EXPIRED_CODE' }) && (await comparePassword(PW, affRow(E, a.id).password)), r2.text);
}

// ── 6. a code never used (withheld), expiry, attempts ────────────────────────
console.log('\n6. Unused code invalidated ADMIN_RECOVERY; the new code expires and locks after 5 attempts');
{
  const E = setup();
  const a = await createAff(E); // the recruiter's code was never handed over
  await ask(E, { identifier: a.username, message: MSG });
  const rid = recoveries(E, a.id)[0].id;
  const r = await review(E, rid, { action: 'approve' });
  const code = r.body.activation.code;
  const old = codeRows(E, a.id).find((c) => c.createdByType === 'RECRUITER');
  ok('the recruiter\'s unused active code is invalidated with reason ADMIN_RECOVERY', old.invalidatedAt !== null && old.invalidatedReason === 'ADMIN_RECOVERY' && old.usedAt === null, big(old));
  const o = await redeem(E, a.code);
  ok('…and the old code no longer works', o.status === 400 && eq(o.body, { code: 'INVALID_OR_EXPIRED_CODE' }), o.text);
  const g = await call(E.regenerate, req(`/api/recruiter/affiliates/${a.id}/activation-code`, { method: 'POST', cookie: recruiterCookie(E.A) }), params(a.id));
  ok('the recruiter cannot regenerate even though no code was ever used (ADMIN code in the history) → 409', g.status === 409 && eq(g.body, { code: 'ACTIVATION_NOT_AVAILABLE' }), g.text);
  // expiry
  E.clock.now = at(24 * HOUR + 1);
  const ex = await redeem(E, code);
  ok('the new code fails after 24 h (expired)', ex.status === 400 && eq(ex.body, { code: 'INVALID_OR_EXPIRED_CODE' }) && affRow(E, a.id).password !== null, ex.text);
  E.clock.now = at(24 * HOUR - 1);
  // 5 wrong attempts (on a fresh recovery so the code is not expired)
  const F = setup();
  const b = await hijacked(F);
  await ask(F, { identifier: b.username, message: MSG });
  const code2 = (await review(F, recoveries(F, b.id)[0].id, { action: 'approve' })).body.activation.code;
  const [, sel2] = CODE_RE.exec(code2);
  for (let i = 0; i < 5; i++) await redeem(F, `${sel2}.${'Z'.repeat(43)}`);
  const row = codeRows(F, b.id).find((c) => c.createdByType === 'ADMIN');
  const late = await redeem(F, code2);
  ok('5 wrong attempts invalidate the ADMIN code (TOO_MANY_ATTEMPTS); the right code then fails',
    row.failedAttempts === 5 && row.invalidatedReason === 'TOO_MANY_ATTEMPTS' && late.status === 400 && eq(late.body, { code: 'INVALID_OR_EXPIRED_CODE' }), big(row));
}

// ── 7. concurrency and review states ─────────────────────────────────────────
console.log('\n7. Concurrent approvals; review states');
{
  const E = setup();
  const a = await hijacked(E);
  await ask(E, { identifier: a.username, message: MSG });
  const rid = recoveries(E, a.id)[0].id;
  const all = await Promise.all(Array.from({ length: 10 }, (_, i) => review(E, rid, { action: 'approve', note: `admin ${i}` }, adminCookie(`admin-${i}`))));
  const won = all.filter((r) => r.status === 201);
  const lost = all.filter((r) => r.status === 409);
  ok('10 concurrent approvals of one request → exactly 1 code issued, 9 × 409 ALREADY_REVIEWED',
    won.length === 1 && lost.length === 9 && lost.every((r) => r.body.code === 'ALREADY_REVIEWED' && r.body.error === 'Cette demande a déjà été traitée.'), all.map((r) => r.status).join(','));
  ok('…exactly 1 ADMIN code, 1 active code, 1 approval audit row, and the request records the winning admin',
    codeRows(E, a.id).filter((c) => c.createdByType === 'ADMIN').length === 1 && codeRows(E, a.id).filter((c) => c.usedAt === null && c.invalidatedAt === null).length === 1
    && audits(E, 'ACTIVATION_RECOVERY_APPROVED').length === 1 && recoveries(E, a.id)[0].reviewedBy === audits(E, 'ACTIVATION_RECOVERY_APPROVED')[0].actorId);
  const again = await review(E, rid, { action: 'reject', note: 'trop tard' });
  ok('reject after approve → 409 ALREADY_REVIEWED, nothing changed', again.status === 409 && again.body.code === 'ALREADY_REVIEWED' && recoveries(E, a.id)[0].status === 'APPROVED', again.text);

  const R = setup();
  const b = await hijacked(R);
  await ask(R, { identifier: b.username, message: MSG });
  const rid2 = recoveries(R, b.id)[0].id;
  const pwBefore = affRow(R, b.id).password;
  const codesBefore = big(codeRows(R, b.id));
  const rj = await review(R, rid2, { action: 'reject', note: 'identité non confirmée' });
  const rec = recoveries(R, b.id)[0];
  ok('reject → 200 { recovery: { id, status: REJECTED } }; REJECTED with reviewer, time and note; no code issued',
    rj.status === 200 && eq(rj.body, { recovery: { id: rid2, status: 'REJECTED' } }) && rec.status === 'REJECTED' && rec.reviewedBy === ADMIN_ID && rec.reviewNote === 'identité non confirmée' && rec.activationCodeId === null, rj.text);
  ok('…the password and the codes are untouched; ACTIVATION_RECOVERY_REJECTED audited (ADMIN, note)',
    affRow(R, b.id).password === pwBefore && big(codeRows(R, b.id)) === codesBefore
    && audits(R, 'ACTIVATION_RECOVERY_REJECTED').length === 1 && audits(R, 'ACTIVATION_RECOVERY_REJECTED')[0].actorType === 'ADMIN' && eq(audits(R, 'ACTIVATION_RECOVERY_REJECTED')[0].details, { recoveryId: rid2, note: 'identité non confirmée' }));
  const ap = await review(R, rid2, { action: 'approve' });
  ok('approve after reject → 409 ALREADY_REVIEWED, no code issued', ap.status === 409 && ap.body.code === 'ALREADY_REVIEWED' && codeRows(R, b.id).filter((c) => c.createdByType === 'ADMIN').length === 0, ap.text);
  const badAction = await review(R, rid2, { action: 'delete' });
  const unknown = await review(R, 'no-such-request', { action: 'approve' });
  const unknownD = await detail(R, 'no-such-request');
  ok('an unknown action → 400 INVALID_INPUT; an unknown request → 404 NOT_FOUND (approve and detail)',
    badAction.status === 400 && badAction.body.code === 'INVALID_INPUT' && unknown.status === 404 && unknown.body.code === 'NOT_FOUND' && unknownD.status === 404, `${badAction.text} ${unknown.text}`);
}

// ── 8. an active affiliate cannot be reset ───────────────────────────────────
console.log('\n8. An active affiliate cannot be reset through the recovery');
{
  const E = setup();
  const a = await hijacked(E);
  await ask(E, { identifier: a.username, message: MSG });
  const rid = recoveries(E, a.id)[0].id;
  affRow(E, a.id).isActive = true; // the admin activated the account after the request
  const snap = snapshot(E);
  const r = await review(E, rid, { action: 'approve' });
  ok('approve for an affiliate activated meanwhile → 409 AFFILIATE_ACTIVE (French text), no code',
    r.status === 409 && r.body.code === 'AFFILIATE_ACTIVE' && /compte actif/.test(r.body.error) && !r.body.activation, r.text);
  ok('…nothing changed: same password, same codes, the request still PENDING, no approval audit',
    snapshot(E) === snap && recoveries(E, a.id)[0].status === 'PENDING' && (await comparePassword(HIJACK_PW, affRow(E, a.id).password)) && audits(E, 'ACTIVATION_RECOVERY_APPROVED').length === 0);
  // a request recorded for an affiliate whose codes vanished (corrupt data) → NOT_ELIGIBLE
  const N = setup();
  const odd = N.db._seed.affiliate({ username: 'no.code', isActive: false });
  const seeded = N.db._seed.recovery({ affiliateId: odd.id, message: MSG });
  const ne = await review(N, seeded.id, { action: 'approve' });
  ok('an affiliate without any activation code (not the code flow) → 409 NOT_ELIGIBLE, the request stays PENDING', ne.status === 409 && ne.body.code === 'NOT_ELIGIBLE' && recoveries(N, odd.id)[0].status === 'PENDING', ne.text);
  const svc = stripJs(read('src/lib/services/affiliateActivationRecoveryService.js'));
  ok('the recovery service never writes isActive (it only reads it) and only writes the affiliate password + the session-version bump (Phase 6 part 2)', !/data:\s*\{[^}]*isActive/.test(svc) && (svc.match(/tx\.affiliate\.update\(/g) || []).length === 1
    && /tx\.affiliate\.update\(\{ where: \{ id: r\.affiliateId \}, data: \{ password: newHash, tokenVersion: \{ increment: 1 \} \}/.test(svc));
}

// ── 9. failure atomicity ─────────────────────────────────────────────────────
console.log('\n9. A failed approval leaves nothing behind');
{
  const E = setup({ failOnce: {} });
  const a = await hijacked(E);
  await ask(E, { identifier: a.username, message: MSG });
  const rid = recoveries(E, a.id)[0].id;
  const snap = snapshot(E);
  E.db._state.failOnce['recruiterAuditLog.create'] = new Error('audit down (injected)');
  const r = await review(E, rid, { action: 'approve' });
  ok('an error at the audit insert → 500 SERVER_ERROR (fixed French text), no code returned', r.status === 500 && eq(r.body, { code: 'SERVER_ERROR', error: 'Erreur serveur.' }), r.text);
  ok('…the whole approval rolled back: password, codes and request unchanged (still PENDING)', snapshot(E) === snap && recoveries(E, a.id)[0].status === 'PENDING');
  const ok2 = await review(E, rid, { action: 'approve' });
  ok('…and the approval succeeds on retry', ok2.status === 201 && CODE_RE.test(ok2.body.activation.code), ok2.text);
}

// ── 10. no plaintext anywhere ────────────────────────────────────────────────
console.log('\n10. No plaintext code in the database, the audit or the logs');
{
  const E = setup();
  const a = await hijacked(E);
  await ask(E, { identifier: a.username, message: MSG });
  const code = (await review(E, recoveries(E, a.id)[0].id, { action: 'approve', note: 'ok' })).body.activation.code;
  const [, , verifier] = CODE_RE.exec(code);
  const dump = snapshot(E);
  ok('the fake database (every table, every audit detail) contains neither the code nor its verifier', !dump.includes(code) && !dump.includes(verifier));
  const lines = logged.filter((l) => !/^\s*(PASS|FAIL)\b/.test(l.trim()) && !l.includes('  PASS ') && !l.includes('  FAIL '));
  ok('no log line written by the code under test contains a code-shaped token or this code', lines.every((l) => !/[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}/.test(l) && !l.includes(verifier)), lines.filter((l) => /[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}/.test(l)).slice(0, 2).join(' | '));
  const h = stripJs(read('src/lib/affiliateActivationRecoveryHandlers.js'));
  const calls = h.match(/console\.\w+\([^\n]*\);/g) || [];
  ok('the handlers log only a fixed tag + the error code / name (never a body, a code or a request)',
    calls.length === 2 && calls.every((c) => /^console\.error\('\[[a-z ]+\]', e\?\.code \?\? e\?\.name \?\? 'ERROR'\);$/.test(c)), calls.join(' | '));
}

// ── 11. existing flows intact; migration (static) ────────────────────────────
console.log('\n11. Existing flows unchanged; migration 20261108 (static)');
{
  // Phase 6 part 2 (documented allowance, docs/recruiter-system.md §8): only the exact pinned Part 2 diffs.
  const { checkUnchangedExceptPart2 } = await import('./lib/phase6Part2Allowance.mjs');
  let p2;
  try {
    p2 = checkUnchangedExceptPart2('d8f92dbd88f509c68453eaa1c96d9f5a7eddddda', ['src/lib/services/affiliateSystemService.js', 'src/app/api/affiliate', 'src/lib/middleware',
      'src/lib/services/authService.js', 'src/lib/balance', 'src/app/api/admin/affiliates', 'src/app/api/admin/identity']);
  } catch (e) { p2 = { ok: false, error: `git error ${e.status}` }; }
  ok('authService, balances and admin identity are unchanged versus d8f92db; affiliateSystemService, /api/affiliate, withAffiliateAuth and admin affiliates differ ONLY by the exact pinned Phase 6 part 2 diff', p2.ok, JSON.stringify(p2));
  const asys = read('src/lib/services/affiliateSystemService.js');
  ok('the admin affiliate approval (isActive via adminUpdateAffiliate) is untouched and the login still requires an active account',
    /if \(data\.isActive\s+!== undefined\) update\.isActive\s+= Boolean\(data\.isActive\);/.test(asys) && /if \(!affiliate\.isActive\)/.test(asys));

  const sql = read('prisma/migrations/20261108_affiliate_activation_recovery/migration.sql');
  const code = sql.replace(/--.*$/gm, '');
  ok('the table affiliate_activation_recoveries with the request / review columns', /CREATE TABLE IF NOT EXISTS "affiliate_activation_recoveries"/.test(code)
    && ['"affiliateId"', '"status"', '"message"', '"contactPhone"', '"requestIp"', '"requestedAt"', '"reviewedBy"', '"reviewedAt"', '"reviewNote"', '"activationCodeId"'].every((c) => code.includes(c)));
  ok('both FKs are ON DELETE RESTRICT (affiliates, affiliate_activation_codes)',
    /"affiliate_activation_recoveries_affiliateId_fkey"\s+FOREIGN KEY \("affiliateId"\) REFERENCES "affiliates"\("id"\) ON DELETE RESTRICT/.test(code)
    && /"affiliate_activation_recoveries_activationCodeId_fkey"\s+FOREIGN KEY \("activationCodeId"\) REFERENCES "affiliate_activation_codes"\("id"\) ON DELETE RESTRICT/.test(code));
  ok('the CHECK: status set, message 1–500, phone format, IP ≤ 64, note ≤ 300, review columns per status',
    /"status" IN \('PENDING', 'APPROVED', 'REJECTED'\)/.test(code) && /char_length\(btrim\("message"\)\) BETWEEN 1 AND 500/.test(code)
    && /"contactPhone" IS NULL OR "contactPhone" ~/.test(code) && /char_length\("requestIp"\) <= 64/.test(code) && /char_length\("reviewNote"\) <= 300/.test(code)
    && /"status" <> 'APPROVED' OR/.test(code) && /"status" <> 'REJECTED' OR/.test(code) && /"status" <> 'PENDING'\s+OR/.test(code));
  ok('one PENDING request per affiliate (partial unique index)', /CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_activation_recoveries_one_pending"\s+ON "affiliate_activation_recoveries"\("affiliateId"\) WHERE "status" = 'PENDING'/.test(code));
  ok('the guard trigger: no DELETE / TRUNCATE, only a PENDING request reviewed once, request fields immutable',
    /BEFORE UPDATE OR DELETE ON "affiliate_activation_recoveries"/.test(code) && /BEFORE TRUNCATE ON "affiliate_activation_recoveries"/.test(code)
    && /OLD\."status" <> 'PENDING' OR NEW\."status" NOT IN \('APPROVED', 'REJECTED'\)/.test(code)
    && ['message', 'contactPhone', 'requestIp', 'requestedAt', 'affiliateId'].every((c) => new RegExp(`NEW\\."${c}" IS DISTINCT FROM OLD\\."${c}"`).test(code)));
  ok('the activation-codes CHECK is replaced with the same rules + ADMIN_RECOVERY',
    /DROP CONSTRAINT IF EXISTS "affiliate_activation_codes_check"/.test(code) && /ADD CONSTRAINT "affiliate_activation_codes_check"/.test(code)
    && /'REGENERATED', 'TOO_MANY_ATTEMPTS', 'CREDENTIALS_CHANGED', 'ADMIN_RECOVERY'/.test(code) && /"failedAttempts" BETWEEN 0 AND 5/.test(code) && /interval '24 hours'/.test(code));
  const alters = [...code.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
  ok('it alters nothing else: only affiliate_activation_codes (the CHECK) and the new table; no UPDATE / DELETE / DROP TABLE / DROP COLUMN',
    alters.every((t) => ['affiliate_activation_codes', 'affiliate_activation_recoveries'].includes(t))
    && (code.match(/ALTER TABLE "affiliate_activation_codes"/g) || []).length === 2
    && !/\bUPDATE\s+"|\bDELETE\s+FROM|DROP TABLE|DROP COLUMN|TRUNCATE\s+"/i.test(code.replace(/BEFORE UPDATE OR DELETE|BEFORE TRUNCATE|TG_OP <> 'UPDATE'/g, '')), alters.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
