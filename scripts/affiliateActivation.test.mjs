/**
 * scripts/affiliateActivation.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 6 part 1: one-time ACTIVATION CODES. The recruiter
 * never chooses nor learns the affiliate's permanent password: the affiliate is created
 * with an unusable random password, the recruiter gets a code ONCE, and the affiliate sets
 * their own password with it (POST /api/affiliate-activation). Redemption never activates
 * the account (admin approval unchanged).
 *
 * Runs on the in-memory fake db (scripts/lib/recruiterFakeDb.mjs, phase 5 + password-only
 * affiliate update) — never a real database. Real-PostgreSQL concurrency / migration checks
 * are done separately on an isolated disposable database.
 *
 * LIMITATION (documented, not testable away): the code is a bearer secret the recruiter
 * sees; a malicious recruiter could redeem it first. These tests prove the recruiter can
 * neither choose nor read the password the affiliate sets, nor re-issue a code once
 * credentials exist.
 * ─────────────────────────────────────────────────────────────────────────────
 */

process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'affiliate-activation-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const { recruiterAffiliateHandlers } = await import('../src/lib/recruiterAffiliateRouteHandlers.js');
const { recruiterActivationHandlers } = await import('../src/lib/recruiterActivationRouteHandlers.js');
const { affiliateActivationHandlers, ACTIVATION_RATE } = await import('../src/lib/affiliateActivationHandlers.js');
const { recruiterNetworkHandlers } = await import('../src/lib/recruiterNetworkRouteHandlers.js');
const { recruiterHandlers } = await import('../src/lib/recruiterRouteHandlers.js');
const { recruiterWalletHandlers } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const AS = await import('../src/lib/services/affiliateActivationService.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
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
const GOOD_PW = 'MonMotDePasse9';

// Capture every console line: the code must never be logged.
const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : big(x))).join(' ')); orig(...a); };
}

const recruiterToken = (id, username = 'x') => signToken({ recruiterId: id, username, type: 'recruiter' });
let ipSeq = 0;
const req = (url, { method = 'GET', body, cookie, raw, ip } = {}) => {
  const headers = { 'x-forwarded-for': ip || `10.66.${(ipSeq >> 8) & 255}.${(++ipSeq) & 255}` };
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
const cookieOf = (rec) => `recruiter_token=${recruiterToken(rec.id, rec.username)}`;

/** One fake db (phase 5 + password-only affiliate update) with recruiters A and B and every handler. */
function setup({ now = at(0), rateLimit = noLimit, failOnce = {} } = {}) {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ phase5: true, allowPasswordUpdate: true, failOnce, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  const clock = { now };
  const nowFn = () => clock.now();
  const ha = recruiterAffiliateHandlers({ db, now: nowFn, rateLimit });
  const hr = recruiterActivationHandlers({ db, now: nowFn, rateLimit });
  const hp = affiliateActivationHandlers({ db, now: nowFn, rateLimit });
  return {
    db, A, B, clock, hookBox,
    create: withRecruiterAuth(ha.createAffiliate), list: withRecruiterAuth(ha.affiliates),
    pending: withRecruiterAuth(hr.pending), regenerate: withRecruiterAuth(hr.regenerate), redeem: hp.redeem,
    nodes: withRecruiterAuth(recruiterNetworkHandlers({ db, rateLimit }).nodes),
    stats: withRecruiterAuth(recruiterNetworkHandlers({ db, rateLimit }).stats),
    me: withRecruiterAuth(recruiterHandlers({ db, now: nowFn, rateLimit }).me),
    wallet: withRecruiterAuth(recruiterWalletHandlers({ db, now: nowFn, rateLimit }).wallet),
  };
}
let uniq = 0;
const mk = (over = {}) => ({ username: `act${++uniq}x`, name: `Affilié ${uniq}`, requestId: randomUUID(), ...over });
const create = async (E, rec, over = {}) => call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body: mk(over), cookie: cookieOf(rec) }));
const redeem = (E, body, opts = {}) => call(E.redeem, req('/api/affiliate-activation', { method: 'POST', body, ...opts }));
const regen = (E, rec, id) => call(E.regenerate, req(`/api/recruiter/affiliates/${id}/activation-code`, { method: 'POST', cookie: cookieOf(rec) }), { params: Promise.resolve({ id }) });
const codeRows = (E, affiliateId) => E.db._tables.affiliateActivationCode.filter((c) => c.affiliateId === affiliateId);
const affRow = (E, id) => E.db._tables.affiliate.find((a) => a.id === id);
const INVALID = { code: 'INVALID_OR_EXPIRED_CODE' };

// ── 1. creation: the code once, no password ──────────────────────────────────
console.log('\n1. Creation: one-time code, no recruiter-chosen password, hash only');
let shared;
{
  const E = setup();
  let createData = null;
  E.hookBox.fn = (m, o, a) => { if (m === 'affiliate' && o === 'create') createData = a.data; };
  const r = await create(E, E.A, { username: 'nadia.k', name: 'Nadia K' });
  const id = r.body?.affiliate?.id;
  const code = r.body?.activation?.code;
  const m = CODE_RE.exec(code || '');
  ok('creation → 201 { affiliate, replayed:false, activation: { code, expiresAt } }, no-store, no cookie',
    r.status === 201 && eq(keys(r.body), ['activation', 'affiliate', 'replayed']) && eq(keys(r.body.activation), ['code', 'expiresAt']) && /no-store/.test(r.cache || '') && !r.cookie, r.text);
  ok('code format: "<selector 16>.<verifier 43>" base64url; verifier decodes to 32 bytes (256 bits), selector to 12 bytes',
    !!m && Buffer.from(m[2], 'base64url').length === 32 && Buffer.from(m[1], 'base64url').length === 12, code);
  ok('expiresAt = creation time + 24 h', r.body.activation.expiresAt === new Date(T0.getTime() + 24 * HOUR).toISOString(), r.body.activation.expiresAt);
  ok('the recruiter response never contains a password, a bcrypt hash, a selector / verifier hash or a fingerprint',
    !/password|\$2[aby]\$|verifierHash|passwordFingerprint|selector/i.test(r.text), r.text);
  const row = affRow(E, id);
  ok('the create data carries a password ONLY as a bcrypt hash (cost 12) — none came from the recruiter', /^\$2[aby]\$12\$.{53}$/.test(createData?.password || '') && createData.password === row.password);
  ok('that password matches nothing the recruiter knows (empty, the code, the verifier, the username, the name, an old default)',
    ['', code, m[2], 'nadia.k', 'Nadia K', 'Secret123', 'password'].every((p) => !bcrypt.compareSync(p, row.password)));
  ok('the account is created INACTIVE', row.isActive === false);
  const c = codeRows(E, id);
  ok('exactly one activation-code row: selector, sha256(verifier), fingerprint of the stored password hash, by recruiter A, 0 attempts, active',
    c.length === 1 && c[0].selector === m[1] && c[0].verifierHash === sha256(m[2]) && c[0].passwordFingerprint === sha256(row.password)
    && c[0].createdByType === 'RECRUITER' && c[0].createdById === E.A.id && c[0].failedAttempts === 0 && c[0].usedAt === null && c[0].invalidatedAt === null
    && new Date(c[0].expiresAt).getTime() - new Date(c[0].createdAt).getTime() === 24 * HOUR);
  const everything = big(E.db._tables);
  ok('the plaintext code and the verifier appear NOWHERE in the database (every table, every row, every audit detail)', !everything.includes(code) && !everything.includes(m[2]));
  const gen = Array.from({ length: 200 }, () => AS.generateActivationCode());
  ok('generateActivationCode: 200 codes all well-formed, all distinct selectors and verifiers, verifierHash = sha256(verifier)',
    gen.every((g) => CODE_RE.test(g.code) && g.verifierHash === sha256(g.code.split('.')[1]) && g.selector === g.code.split('.')[0])
    && new Set(gen.map((g) => g.selector)).size === 200 && new Set(gen.map((g) => g.code.split('.')[1])).size === 200);
  shared = { E, id, code };
}

// ── 2. redemption ──────────────────────────────────────────────────────────────
console.log('\n2. Redemption: correct / wrong / expired / used');
{
  const { E, id, code } = shared;
  E.clock.now = at(HOUR);
  const before = { ...affRow(E, id) };
  const wrong = await redeem(E, { code: `${code.split('.')[0]}.${'A'.repeat(43)}`, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('a wrong verifier → 400 INVALID_OR_EXPIRED_CODE; failedAttempts 0 → 1; the password untouched', wrong.status === 400 && eq(wrong.body, INVALID) && codeRows(E, id)[0].failedAttempts === 1 && affRow(E, id).password === before.password, wrong.text);
  const good = await redeem(E, { code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  const after = affRow(E, id);
  ok('the correct code → 200 { ok: true }, no-store, NO cookie / token / session', good.status === 200 && eq(good.body, { ok: true }) && /no-store/.test(good.cache || '') && !good.cookie && !/token/i.test(good.text), good.text);
  ok('the new password is a bcrypt hash of the affiliate\'s choice (comparePassword ok); the old unusable one is gone',
    /^\$2[aby]\$12\$/.test(after.password) && (await comparePassword(GOOD_PW, after.password)) && after.password !== before.password && !(await comparePassword(GOOD_PW, before.password)));
  ok('redemption does NOT activate the account: isActive stays false; no other affiliate column changed',
    after.isActive === false && Object.keys(before).filter((k) => !['password', 'updatedAt'].includes(k)).every((k) => eq(after[k], before[k])));
  const c = codeRows(E, id)[0];
  ok('the code is consumed: usedAt = the redemption time, never invalidated', new Date(c.usedAt).getTime() === T0.getTime() + HOUR && c.invalidatedAt === null);
  const aud = E.db._tables.recruiterAuditLog.filter((x) => x.action === 'AFFILIATE_CREDENTIALS_SET');
  ok('one AFFILIATE_CREDENTIALS_SET audit (SYSTEM actor, recruiter A, entity = the affiliate, details = the code row id only)',
    aud.length === 1 && aud[0].actorType === 'SYSTEM' && aud[0].recruiterId === E.A.id && aud[0].entityId === id && eq(aud[0].details, { activationCodeId: c.id }));
  const again = await redeem(E, { code, password: 'Autre123x', passwordConfirm: 'Autre123x' });
  ok('the same (used) code again → 400 INVALID_OR_EXPIRED_CODE; the password is unchanged (replay refused)', again.status === 400 && eq(again.body, INVALID) && (await comparePassword(GOOD_PW, affRow(E, id).password)), again.text);

  // expiry
  const E2 = setup();
  const r = await create(E2, E2.A);
  E2.clock.now = at(24 * HOUR);
  const exp = await redeem(E2, { code: r.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  const row2 = codeRows(E2, r.body.affiliate.id)[0];
  ok('expired (exactly 24 h later) → 400 INVALID_OR_EXPIRED_CODE; no attempt counted; the password unchanged',
    exp.status === 400 && eq(exp.body, INVALID) && row2.failedAttempts === 0 && row2.usedAt === null && !(await comparePassword(GOOD_PW, affRow(E2, r.body.affiliate.id).password)), exp.text);
  E2.clock.now = at(24 * HOUR - 1);
  const justIn = await redeem(E2, { code: r.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('1 ms before expiry → accepted', justIn.status === 200, justIn.text);
}

// ── 3. five failed attempts ───────────────────────────────────────────────────
console.log('\n3. Five failed attempts invalidate the code');
{
  const E = setup({ now: at(HOUR) });
  const r = await create(E, E.A);
  const [sel] = r.body.activation.code.split('.');
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await redeem(E, { code: `${sel}.${String(i).repeat(43)}`, password: GOOD_PW, passwordConfirm: GOOD_PW }));
  const c = codeRows(E, r.body.affiliate.id)[0];
  ok('5 wrong verifiers → 5 × INVALID_OR_EXPIRED_CODE; failedAttempts = 5; invalidated (TOO_MANY_ATTEMPTS)',
    results.every((x) => x.status === 400 && eq(x.body, INVALID)) && c.failedAttempts === 5 && c.invalidatedReason === 'TOO_MANY_ATTEMPTS' && c.invalidatedAt !== null, big(c));
  const right = await redeem(E, { code: r.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('… then even the CORRECT code is refused; the password never set', right.status === 400 && eq(right.body, INVALID) && !(await comparePassword(GOOD_PW, affRow(E, r.body.affiliate.id).password)), right.text);
  const sixth = await redeem(E, { code: `${sel}.${'z'.repeat(43)}`, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('a 6th wrong attempt counts nothing more (failedAttempts stays 5 — the CHECK cap)', sixth.status === 400 && codeRows(E, r.body.affiliate.id)[0].failedAttempts === 5);
  const pend = await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: cookieOf(E.A) }));
  ok('the recruiter sees that affiliate as pending with state INVALIDATED (no code)', pend.status === 200 && pend.body.pending.some((p) => p.affiliate.id === r.body.affiliate.id && p.state === 'INVALIDATED') && !pend.text.includes(sel + '.'), pend.text);
  const re = await regen(E, E.A, r.body.affiliate.id);
  const ok2 = await redeem(E, { code: re.body.activation?.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('a regenerated code after the lock-out works', re.status === 201 && ok2.status === 200, re.text + ok2.text);
}

// ── 4. regeneration ───────────────────────────────────────────────────────────
console.log('\n4. Regeneration: invalidates the previous code; refused once credentials exist');
{
  const E = setup({ now: at(HOUR) });
  const r = await create(E, E.A);
  const id = r.body.affiliate.id;
  const first = r.body.activation.code;
  const g = await regen(E, E.A, id);
  ok('regenerate → 201 { activation: { code, expiresAt } } with a NEW code, expiring 24 h after the regeneration',
    g.status === 201 && eq(keys(g.body), ['activation']) && CODE_RE.test(g.body.activation.code) && g.body.activation.code !== first
    && g.body.activation.expiresAt === new Date(T0.getTime() + 25 * HOUR).toISOString(), g.text);
  const rows = codeRows(E, id);
  ok('the previous code row is invalidated (REGENERATED); exactly one active row; the new one is fresh',
    rows.length === 2 && rows.find((x) => x.selector === first.split('.')[0]).invalidatedReason === 'REGENERATED' && rows.filter((x) => !x.usedAt && !x.invalidatedAt).length === 1);
  ok('a code-issued audit row for the regeneration (recruiter actor), never the code',
    E.db._tables.recruiterAuditLog.some((x) => x.action === 'AFFILIATE_ACTIVATION_CODE_ISSUED' && x.actorId === E.A.id && x.entityId === id) && !big(E.db._tables).includes(g.body.activation.code.split('.')[1]));
  const old = await redeem(E, { code: first, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('the OLD code is refused after regeneration', old.status === 400 && eq(old.body, INVALID), old.text);
  const fresh = await redeem(E, { code: g.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('the NEW code works', fresh.status === 200, fresh.text);
  const after = await regen(E, E.A, id);
  ok('regeneration after the credentials were set → 409 ACTIVATION_NOT_AVAILABLE (a recruiter can never reset the password)', after.status === 409 && eq(after.body, { code: 'ACTIVATION_NOT_AVAILABLE' }), after.text);
  const pend = await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: cookieOf(E.A) }));
  ok('an activated affiliate no longer appears in the pending list', pend.status === 200 && !pend.body.pending.some((p) => p.affiliate.id === id), pend.text);

  // an admin (or any other path) changed the password → stale
  const E2 = setup({ now: at(HOUR) });
  const r2 = await create(E2, E2.A);
  const id2 = r2.body.affiliate.id;
  affRow(E2, id2).password = bcrypt.hashSync('AdminSet1', 4); // simulate adminUpdateAffiliate({ password })
  const g2 = await regen(E2, E2.A, id2);
  ok('regeneration after an ADMIN password change → 409 ACTIVATION_NOT_AVAILABLE', g2.status === 409 && eq(g2.body, { code: 'ACTIVATION_NOT_AVAILABLE' }), g2.text);
  const st = await redeem(E2, { code: r2.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  const row2 = codeRows(E2, id2)[0];
  ok('redeeming the code after a password change elsewhere → rejected; the code invalidated (CREDENTIALS_CHANGED); the admin password intact',
    st.status === 400 && eq(st.body, INVALID) && row2.invalidatedReason === 'CREDENTIALS_CHANGED' && bcrypt.compareSync('AdminSet1', affRow(E2, id2).password), st.text);
  const pend2 = await call(E2.pending, req('/api/recruiter/affiliates/activation', { cookie: cookieOf(E2.A) }));
  ok('that affiliate is not listed as pending (credentials set elsewhere)', !pend2.body.pending.some((p) => p.affiliate.id === id2), pend2.text);

  // an affiliate without any code (legacy / admin-created + linked) → no takeover path
  const legacy = E2.db._seed.affiliate({ username: 'legacy.one', name: 'L', password: bcrypt.hashSync('Known123', 4) });
  E2.db._seed.link({ affiliateId: legacy.id, recruiterId: E2.A.id });
  const gl = await regen(E2, E2.A, legacy.id);
  ok('an affiliate that never had a code (legacy) → 409 ACTIVATION_NOT_AVAILABLE; no code created', gl.status === 409 && codeRows(E2, legacy.id).length === 0, gl.text);
}

// ── 5. concurrency ────────────────────────────────────────────────────────────
console.log('\n5. Concurrency: exactly one redemption wins');
{
  const E = setup({ now: at(HOUR) });
  const r = await create(E, E.A);
  const id = r.body.affiliate.id;
  let updates = 0;
  E.hookBox.fn = (m, o) => { if (m === 'affiliate' && o === 'update') updates += 1; };
  const pws = Array.from({ length: 10 }, (_, i) => `Parallel${i}pw`);
  const res = await Promise.all(pws.map((pw) => redeem(E, { code: r.body.activation.code, password: pw, passwordConfirm: pw })));
  const winners = res.map((x, i) => (x.status === 200 ? i : -1)).filter((i) => i >= 0);
  ok('10 parallel correct redemptions → exactly 1 × 200, 9 × 400 INVALID_OR_EXPIRED_CODE', winners.length === 1 && res.filter((x) => x.status === 400 && eq(x.body, INVALID)).length === 9, res.map((x) => x.status).join(','));
  ok('the password was written exactly once, and it is the winner\'s', updates === 1 && (await comparePassword(pws[winners[0]], affRow(E, id).password)));
  ok('one code row, used once; one AFFILIATE_CREDENTIALS_SET audit; no lock left', codeRows(E, id).length === 1 && codeRows(E, id)[0].usedAt !== null
    && E.db._tables.recruiterAuditLog.filter((x) => x.action === 'AFFILIATE_CREDENTIALS_SET').length === 1 && E.db._locks.size === 0 && E.db._openTx.size === 0);

  // regeneration racing a redemption: the outcomes are always consistent
  const outcomes = [];
  for (let round = 0; round < 6; round += 1) {
    const F = setup({ now: at(HOUR) });
    const c = await create(F, F.A);
    const fid = c.body.affiliate.id;
    const [a, b] = round % 2
      ? await Promise.all([redeem(F, { code: c.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW }), regen(F, F.A, fid)])
      : await Promise.all([regen(F, F.A, fid), redeem(F, { code: c.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW })]).then(([x, y]) => [y, x]);
    const pwSet = await comparePassword(GOOD_PW, affRow(F, fid).password);
    const active = codeRows(F, fid).filter((x) => !x.usedAt && !x.invalidatedAt).length;
    const consistent = (a.status === 200 && b.status === 409 && pwSet && active === 0)
      || (a.status === 400 && b.status === 201 && !pwSet && active === 1);
    outcomes.push(consistent ? `${a.status}/${b.status}` : `INCONSISTENT ${a.status}/${b.status} pw=${pwSet} active=${active}`);
  }
  ok('regeneration vs redemption (6 races): either the redemption wins (regen 409) or the regeneration wins (old code refused, one new active code)', outcomes.every((o) => !o.startsWith('INCONSISTENT')), outcomes.join(' | '));
}

// ── 6. no login before admin approval; login after ────────────────────────────
console.log('\n6. Login: never before the admin approval; works after approval + credentials');
{
  const asys = read('src/lib/services/affiliateSystemService.js');
  const login = asys.slice(asys.indexOf('export async function loginAffiliate'), asys.indexOf('// ── Profile'));
  // Phase 6 part 2 (D4, docs §8): the password is now verified FIRST (an unknown identifier runs a
  // dummy bcrypt compare), and "inactive" is only answered AFTER a correct password — still before
  // any token: an inactive account never gets a session.
  ok('loginAffiliate: password verified first (dummy hash for an unknown identifier), then an INACTIVE account is refused, and only then a token is signed',
    login.indexOf('comparePassword(password, affiliate ? affiliate.password : LOGIN_TIMING_HASH)') > 0
    && login.indexOf('comparePassword') < login.indexOf('if (!affiliate.isActive)')
    && login.indexOf('if (!affiliate.isActive)') < login.indexOf('affiliateSessionToken(affiliate)'));
  const E = setup({ now: at(HOUR) });
  const r = await create(E, E.A);
  const id = r.body.affiliate.id;
  ok('before redemption: no known password works (and the account is inactive)', affRow(E, id).isActive === false && !(await comparePassword(GOOD_PW, affRow(E, id).password)) && !(await comparePassword('', affRow(E, id).password)));
  await redeem(E, { code: r.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('after redemption, before approval: the password matches but isActive is false → loginAffiliate answers INACTIVE (no token)', (await comparePassword(GOOD_PW, affRow(E, id).password)) && affRow(E, id).isActive === false);
  affRow(E, id).isActive = true; // the existing admin approval (adminUpdateAffiliate isActive true)
  ok('after the admin approval: active + the affiliate\'s own password → the login conditions hold', affRow(E, id).isActive === true && (await comparePassword(GOOD_PW, affRow(E, id).password)));
  ok('the recruiter knows nothing that logs in: neither the code nor anything they sent matches the password', !(await comparePassword(r.body.activation.code, affRow(E, id).password)));
  ok('the activation code is never accepted as the password itself', !(await comparePassword(r.body.activation.code.split('.')[1], affRow(E, id).password)));
}

// ── 7. the recruiter cannot retrieve the code later ───────────────────────────
console.log('\n7. The recruiter can never retrieve the code after the creation response');
{
  const E = setup({ now: at(HOUR) });
  const root = await create(E, E.A);
  const code = root.body.activation.code;
  const verifier = code.split('.')[1];
  const replay = await call(E.create, req('/api/recruiter/affiliates', { method: 'POST', body: { username: root.body.affiliate.username, name: E.db._tables.affiliate[0].name, requestId: E.db._tables.recruiterAuditLog.find((x) => x.action === 'AFFILIATE_CREATED').details.requestId }, cookie: cookieOf(E.A) }));
  ok('a replay of the creation (same requestId) → 200 replayed:true with activation: null (the code is gone)', replay.status === 200 && replay.body.replayed === true && replay.body.activation === null && !replay.text.includes(verifier), replay.text);
  const ck = cookieOf(E.A);
  const responses = [
    ['affiliates list', await call(E.list, req('/api/recruiter/affiliates', { cookie: ck }))],
    ['affiliates search', await call(E.list, req(`/api/recruiter/affiliates?q=${encodeURIComponent(root.body.affiliate.username)}`, { cookie: ck }))],
    ['network nodes', await call(E.nodes, req('/api/recruiter/network/nodes', { cookie: ck }))],
    ['network stats', await call(E.stats, req('/api/recruiter/network/stats', { cookie: ck }))],
    ['pending activations', await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: ck }))],
    ['me', await call(E.me, req('/api/recruiter/me', { cookie: ck }))],
    ['wallet', await call(E.wallet, req('/api/recruiter/wallet', { cookie: ck }))],
  ];
  ok('every recruiter GET answers 200', responses.every(([, x]) => x.status === 200), responses.map(([n, x]) => `${n}:${x.status}`).join(','));
  ok('no recruiter GET response contains the code, its verifier, a hash or a fingerprint', responses.every(([, x]) => !x.text.includes(code) && !x.text.includes(verifier) && !/verifierHash|passwordFingerprint|\$2[aby]\$/.test(x.text)),
    responses.filter(([, x]) => x.text.includes(verifier)).map(([n]) => n).join(','));
  const pend = responses.find(([n]) => n === 'pending activations')[1];
  ok('the pending list shows the affiliate with state ACTIVE and its expiry only: exactly { affiliate{id,username,name,createdAt}, state, expiresAt }',
    pend.body.pending.length === 1 && eq(keys(pend.body.pending[0]), ['affiliate', 'expiresAt', 'state']) && pend.body.pending[0].state === 'ACTIVE' && eq(keys(pend.body.pending[0].affiliate), ['createdAt', 'id', 'name', 'username']), pend.text);
  ok('no GET route can return a code: the pending route exports only GET (state list), the code route exports only POST (issues a NEW code)',
    /export const GET = withRecruiterAuth\(h\.pending\);/.test(read('src/app/api/recruiter/affiliates/activation/route.js')) && !/export const (POST|PUT|PATCH|DELETE)/.test(read('src/app/api/recruiter/affiliates/activation/route.js'))
    && /export const POST = withRecruiterAuth\(h\.regenerate\);/.test(read('src/app/api/recruiter/affiliates/[id]/activation-code/route.js')) && !/export const (GET|PUT|PATCH|DELETE)/.test(read('src/app/api/recruiter/affiliates/[id]/activation-code/route.js')));
  const svc = stripJs(read('src/lib/services/affiliateActivationService.js'));
  ok('the service has no way to recover a code: it stores selector + sha256(verifier) only, and returns the code only from issueActivationCode',
    /verifierHash: sha256\(verifier\)/.test(svc) && (svc.match(/code: `\$\{selector\}\.\$\{verifier\}`/g) || []).length === 1 && !/verifier:\s/.test(svc.replace(/const verifier = /, '')));
}

// ── 8. cross-recruiter and account state ──────────────────────────────────────
console.log('\n8. Cross-recruiter access and the recruiter account state');
{
  const E = setup({ now: at(HOUR) });
  const r = await create(E, E.A);
  const id = r.body.affiliate.id;
  const before = big(E.db._tables.affiliateActivationCode);
  const b = await regen(E, E.B, id);
  const unknown = await regen(E, E.B, 'does-not-exist');
  ok('recruiter B regenerating A\'s affiliate → 404 NOT_FOUND, byte-identical to an unknown id; nothing written',
    b.status === 404 && eq(b.body, { code: 'NOT_FOUND' }) && b.text === unknown.text && big(E.db._tables.affiliateActivationCode) === before, b.text);
  const bp = await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: cookieOf(E.B) }));
  ok('B\'s pending list never contains A\'s affiliate', bp.status === 200 && bp.body.pending.length === 0, bp.text);
  const malformed = await regen(E, E.A, 'bad id!');
  ok('a malformed id → 404 NOT_FOUND', malformed.status === 404 && eq(malformed.body, { code: 'NOT_FOUND' }));
  const rec = E.db._tables.recruiter.find((x) => x.id === E.A.id);
  Object.assign(rec, { isActive: false, disabledAt: new Date(), disabledBy: 'admin' });
  const dis = await regen(E, E.A, id);
  const disP = await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: cookieOf(E.A) }));
  ok('a disabled recruiter → 403 RECRUITER_DISABLED on regeneration and on the pending list; nothing written',
    dis.status === 403 && eq(dis.body, { code: 'RECRUITER_DISABLED' }) && disP.status === 403 && big(E.db._tables.affiliateActivationCode) === before, dis.text);
  const noTok = await call(E.regenerate, req(`/api/recruiter/affiliates/${id}/activation-code`, { method: 'POST' }), { params: Promise.resolve({ id }) });
  const affTok = await call(E.regenerate, req(`/api/recruiter/affiliates/${id}/activation-code`, { method: 'POST', cookie: `recruiter_token=${signToken({ affiliateId: id, username: 'x', type: 'affiliate' })}` }), { params: Promise.resolve({ id }) });
  const admTok = await call(E.regenerate, req(`/api/recruiter/affiliates/${id}/activation-code`, { method: 'POST', cookie: `recruiter_token=${signToken({ userId: 'a', email: 'a@x', role: 'ADMIN' })}` }), { params: Promise.resolve({ id }) });
  ok('no token / an affiliate token / an admin token → 401 UNAUTHORIZED', [noTok, affTok, admTok].every((x) => x.status === 401 && eq(x.body, { code: 'UNAUTHORIZED' })));
  // the redemption itself does not care about the recruiter account (the affiliate redeems)
  const red = await redeem(E, { code: r.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('the affiliate can still redeem a code issued before the recruiter was disabled (the code is the affiliate\'s)', red.status === 200, red.text);
}

// ── 9. no enumeration ────────────────────────────────────────────────────────
console.log('\n9. No enumeration: every code failure is the same answer');
{
  const E = setup({ now: at(HOUR) });
  const used = await create(E, E.A);
  await redeem(E, { code: used.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  const expired = await create(E, E.A);
  const wrongTarget = await create(E, E.A);
  const pw = { password: GOOD_PW, passwordConfirm: GOOD_PW };
  const unknownSel = AS.generateActivationCode().code;
  const answers = [
    ['unknown selector', await redeem(E, { code: unknownSel, ...pw })],
    ['wrong verifier', await redeem(E, { code: `${wrongTarget.body.activation.code.split('.')[0]}.${'B'.repeat(43)}`, ...pw })],
    ['used code', await redeem(E, { code: used.body.activation.code, ...pw })],
  ];
  E.clock.now = at(30 * HOUR);
  answers.push(['expired code', await redeem(E, { code: expired.body.activation.code, ...pw })]);
  ok('unknown / wrong / used / expired → the same status 400 and byte-identical bodies {"code":"INVALID_OR_EXPIRED_CODE"}',
    answers.every(([, x]) => x.status === 400 && x.text === '{"code":"INVALID_OR_EXPIRED_CODE"}'), answers.map(([n, x]) => `${n}:${x.status}:${x.text}`).join(' | '));
  const svc = stripJs(read('src/lib/services/affiliateActivationService.js'));
  ok('the password is bcrypt-hashed BEFORE the code lookup for every well-formed request (no timing difference between an unknown and a known selector)',
    svc.indexOf('const passwordHash = await hashPassword(input.password);') > 0 && svc.indexOf('const passwordHash = await hashPassword(input.password);') < svc.indexOf("affiliateActivationCode.findUnique({ where: { selector }, select: { affiliateId: true } })"));
  ok('the verifier is compared in constant time (timingSafeEqual on the sha256 digests)', /timingSafeEqual\(x, y\)/.test(svc) && /sameHex\(createHash\('sha256'\)\.update\(verifier, 'utf8'\)\.digest\('hex'\), row\.verifierHash\)/.test(svc));
}

// ── 10. validation, errors, rate limits ──────────────────────────────────────
console.log('\n10. Validation, error hygiene and rate limits');
{
  const E = setup({ now: at(HOUR) });
  const r = await create(E, E.A);
  const code = r.body.activation.code;
  const verifier = code.split('.')[1];
  const weak = await Promise.all(['short1', 'onlyletterspw', '123456789', 'x'.repeat(127) + '1' + 'x', ''].map((p) => redeem(E, { code, password: p, passwordConfirm: p })));
  ok('weak passwords (< 8, no digit, no letter, > 128, empty) → 400 INVALID_INPUT fields.password WEAK_PASSWORD only',
    weak.every((x) => x.status === 400 && eq(x.body, { code: 'INVALID_INPUT', fields: { password: 'WEAK_PASSWORD' } })), weak.map((x) => x.text).join(' | '));
  const mism = await redeem(E, { code, password: GOOD_PW, passwordConfirm: GOOD_PW + 'x' });
  const missingConfirm = await redeem(E, { code, password: GOOD_PW });
  ok('a mismatched / missing confirmation → fields.passwordConfirm PASSWORD_MISMATCH only', [mism, missingConfirm].every((x) => x.status === 400 && eq(x.body, { code: 'INVALID_INPUT', fields: { passwordConfirm: 'PASSWORD_MISMATCH' } })), mism.text);
  const unknownField = await redeem(E, { code, password: GOOD_PW, passwordConfirm: GOOD_PW, isActive: true });
  const badFormat = await redeem(E, { code: 'abc', password: GOOD_PW, passwordConfirm: GOOD_PW });
  const notObj = await call(E.redeem, req('/api/affiliate-activation', { method: 'POST', raw: '[1]' }));
  const malformed = await call(E.redeem, req('/api/affiliate-activation', { method: 'POST', raw: '{"code":' }));
  ok('an unknown field (e.g. isActive) → fields.body UNKNOWN_FIELD; a malformed code → fields.code INVALID_CODE_FORMAT; non-object / malformed JSON → fields.body',
    eq(unknownField.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } }) && eq(badFormat.body, { code: 'INVALID_INPUT', fields: { code: 'INVALID_CODE_FORMAT' } })
    && eq(notObj.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } }) && eq(malformed.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } }), unknownField.text + badFormat.text);
  const row = codeRows(E, r.body.affiliate.id)[0];
  ok('validation errors never count an attempt nor consume the code; isActive was never set', row.failedAttempts === 0 && row.usedAt === null && affRow(E, r.body.affiliate.id).isActive === false);
  const all = [...weak, mism, missingConfirm, unknownField, badFormat, notObj, malformed];
  ok('no error body contains the code or the verifier, a message or an error text', all.every((x) => !x.text.includes(verifier) && !('message' in x.body) && !('error' in x.body)));
  const E2 = setup({ now: at(HOUR), failOnce: { 'affiliateActivationCode.findUnique': new Error(`db down while reading ${code}`) } });
  const r2 = await create(E2, E2.A);
  const boom = await redeem(E2, { code: r2.body.activation.code, password: GOOD_PW, passwordConfirm: GOOD_PW });
  ok('an internal failure → 500 { code: SERVER_ERROR } only', boom.status === 500 && eq(boom.body, { code: 'SERVER_ERROR' }), boom.text);

  // rate limits (the real in-memory limiter)
  const L = setup({ now: at(HOUR), rateLimit: realRateLimit });
  const lr = await create(L, L.A);
  const ip = '10.200.0.1';
  const burst = [];
  for (let i = 0; i < ACTIVATION_RATE.ip.max + 1; i += 1) burst.push(await redeem(L, { code: AS.generateActivationCode().code, password: GOOD_PW, passwordConfirm: GOOD_PW }, { ip }));
  ok(`by IP: ${ACTIVATION_RATE.ip.max} requests answered, the next → 429 { code: RATE_LIMITED }`, burst.slice(0, -1).every((x) => x.status === 400) && burst.at(-1).status === 429 && eq(burst.at(-1).body, { code: 'RATE_LIMITED' }), burst.map((x) => x.status).join(','));
  const ip2 = '10.200.0.2';
  const [sel] = lr.body.activation.code.split('.');
  const perCode = [];
  for (let i = 0; i < ACTIVATION_RATE.code.max + 1; i += 1) perCode.push(await redeem(L, { code: `${sel}.${String(i % 10).repeat(43)}`, password: GOOD_PW, passwordConfirm: GOOD_PW }, { ip: ip2 }));
  ok(`by code selector: ${ACTIVATION_RATE.code.max} attempts on one code answered, the next → 429 (before the database)`, perCode.slice(0, -1).every((x) => x.status === 400) && perCode.at(-1).status === 429, perCode.map((x) => x.status).join(','));
  ok('the database attempt counter is the global per-code limit (5, whatever the IP): the code is now invalidated', codeRows(L, lr.body.affiliate.id)[0].failedAttempts === 5 && codeRows(L, lr.body.affiliate.id)[0].invalidatedReason === 'TOO_MANY_ATTEMPTS');
  const regenLimiter = setup({ now: at(HOUR), rateLimit: realRateLimit });
  const rl = await create(regenLimiter, regenLimiter.A);
  const regens = [];
  for (let i = 0; i < 11; i += 1) regens.push(await call(regenLimiter.regenerate, req(`/api/recruiter/affiliates/${rl.body.affiliate.id}/activation-code`, { method: 'POST', cookie: cookieOf(regenLimiter.A), ip: '10.200.0.3' }), { params: Promise.resolve({ id: rl.body.affiliate.id }) }));
  ok('regeneration is rate-limited per recruiter + IP (10 / min, then 429)', regens.slice(0, 10).every((x) => x.status === 201) && regens[10].status === 429, regens.map((x) => x.status).join(','));
}

// ── 11. life-cycle guard (fake mirrors the trigger) and DB constraints ───────────
console.log('\n11. Life-cycle guard and constraints (as in the migration)');
{
  const E = setup({ now: at(HOUR) });
  const r = await create(E, E.A);
  const c = codeRows(E, r.body.affiliate.id)[0];
  const tryIt = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e?.meta?.code || e?.code || 'ERR'; } };
  const immut = await tryIt(() => E.db.affiliateActivationCode.updateMany({ where: { id: c.id }, data: { verifierHash: 'a'.repeat(64) } }));
  const back = await tryIt(async () => { await E.db.affiliateActivationCode.updateMany({ where: { id: c.id }, data: { failedAttempts: 2 } }); return E.db.affiliateActivationCode.updateMany({ where: { id: c.id }, data: { failedAttempts: 1 } }); });
  const del = await tryIt(() => E.db.affiliateActivationCode.delete({ where: { id: c.id } }));
  const second = await tryIt(() => E.db.$transaction((tx) => tx.affiliateActivationCode.create({ data: { affiliateId: r.body.affiliate.id, selector: 'Q'.repeat(16), verifierHash: 'b'.repeat(64), passwordFingerprint: 'c'.repeat(64), createdByType: 'RECRUITER', createdById: E.A.id, createdAt: T0, expiresAt: new Date(T0.getTime() + HOUR) } })));
  const tooLong = await tryIt(() => E.db.affiliateActivationCode.create({ data: { affiliateId: r.body.affiliate.id, selector: 'R'.repeat(16), verifierHash: 'b'.repeat(64), passwordFingerprint: 'c'.repeat(64), createdByType: 'RECRUITER', createdById: E.A.id, createdAt: T0, expiresAt: new Date(T0.getTime() + 25 * HOUR), invalidatedAt: T0, invalidatedReason: 'REGENERATED' } }));
  ok('changing an immutable column, decreasing failedAttempts or deleting → refused by the guard (23514)', immut === '23514' && back === '23514' && del === '23514', `${immut} ${back} ${del}`);
  ok('a second ACTIVE code for the same affiliate → unique violation (partial unique index)', second === 'P2002', second);
  ok('an expiry longer than 24 h → CHECK violation', tooLong === 'P2004', tooLong);
  const sql = read('prisma/migrations/20261107_affiliate_activation_codes/migration.sql');
  const code = sql.replace(/--.*$/gm, '');
  ok('migration: the table, the FK to affiliates ON DELETE RESTRICT, the CHECK (selector / hash / fingerprint formats, 24 h, 0–5 attempts, used XOR invalidated, reasons)',
    /CREATE TABLE IF NOT EXISTS "affiliate_activation_codes"/.test(code) && /REFERENCES "affiliates"\("id"\) ON DELETE RESTRICT/.test(code)
    && /"verifierHash" ~ '\^\[0-9a-f\]\{64\}\$'/.test(code) && /"expiresAt" <= "createdAt" \+ interval '24 hours'/.test(code) && /"failedAttempts" BETWEEN 0 AND 5/.test(code)
    && /NOT \("usedAt" IS NOT NULL AND "invalidatedAt" IS NOT NULL\)/.test(code) && /'REGENERATED', 'TOO_MANY_ATTEMPTS', 'CREDENTIALS_CHANGED'/.test(code));
  ok('migration: unique selector, the partial unique "one active per affiliate" index, the guard trigger (UPDATE / DELETE / TRUNCATE)',
    /CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_activation_codes_selector_key"/.test(code) && /WHERE "usedAt" IS NULL AND "invalidatedAt" IS NULL/.test(code)
    && /BEFORE UPDATE OR DELETE ON "affiliate_activation_codes"/.test(code) && /BEFORE TRUNCATE ON "affiliate_activation_codes"/.test(code));
  const otherAlters = [...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]).filter((t) => t !== 'affiliate_activation_codes');
  ok('migration: nothing alters, updates, deletes or drops any existing table / row (additive only)',
    otherAlters.length === 0 && !/\bDROP (TABLE|COLUMN|CONSTRAINT|INDEX)\b|\bUPDATE "|\bDELETE FROM\b|\bTRUNCATE "|\bINSERT INTO\b/i.test(code), otherAlters.join(','));
  ok('migration: no plaintext code column', !/"code"\s+TEXT|"plain|"secret/i.test(code));
}

// ── 12. existing systems unchanged ───────────────────────────────────────────
console.log('\n12. Existing affiliate login, payouts, identity and admin creation unchanged');
{
  // Phase 6 part 2 (documented allowance, docs/recruiter-system.md §8): only the exact pinned Part 2
  // diffs (session version, password-before-state login, audited admin reset, per-request account check).
  const { checkUnchangedExceptPart2 } = await import('./lib/phase6Part2Allowance.mjs');
  let p2;
  try {
    p2 = checkUnchangedExceptPart2('d8f92dbd88f509c68453eaa1c96d9f5a7eddddda', ['src/lib/services/affiliateSystemService.js', 'src/app/api/affiliate', 'src/lib/middleware',
      'src/lib/services/authService.js', 'src/lib/balance', 'src/app/api/admin/affiliates', 'src/lib/services/identityService.js', 'src/app/api/admin/identity', 'src/app/api/admin/affiliate-payouts']);
  } catch (e) { p2 = { ok: false, error: `git error ${e.status}` }; }
  ok('authService, balances, identity, admin identity and payouts are unchanged vs d8f92db; affiliate login / me / admin affiliates / withAffiliateAuth / affiliateSystemService differ ONLY by the exact pinned Phase 6 part 2 diff', p2.ok, JSON.stringify(p2));
  const asys = read('src/lib/services/affiliateSystemService.js');
  const adminCreate = asys.slice(asys.indexOf('export async function adminCreateAffiliate'), asys.indexOf('export async function adminUpdateAffiliate'));
  ok('adminCreateAffiliate still takes the admin-chosen password and creates the account inactive (admin flow unchanged)',
    /const hashed = await hashPassword\(password\);/.test(adminCreate) && /isActive:\s+false,/.test(adminCreate) && !/activation/i.test(adminCreate));
  const svc = stripJs(read('src/lib/services/affiliateActivationService.js'));
  ok('the activation service only ever writes the affiliate PASSWORD + the session-version bump (Phase 6 part 2) — never isActive / any other column',
    (svc.match(/tx\.affiliate\.update\(/g) || []).length === 1
    && /tx\.affiliate\.update\(\{ where: \{ id: affiliate\.id \}, data: \{ password: passwordHash, tokenVersion: \{ increment: 1 \} \}/.test(svc) && !/isActive:\s*(true|false)/.test(svc));
  ok('the public route creates no session (no Set-Cookie / signToken anywhere in the activation path)',
    !/signToken|Set-Cookie|set-cookie/.test(stripJs(read('src/lib/affiliateActivationHandlers.js'))) && !/signToken|Set-Cookie/.test(svc) && !/signToken|Set-Cookie/.test(stripJs(read('src/app/api/affiliate-activation/route.js'))));
}

// ── 12b. an ADMIN (recovery) code blocks the recruiter ───────────────────────
console.log('\n12b. An ADMIN (recovery) code blocks recruiter regeneration and the pending list');
{
  const E = setup();
  const r = await create(E, E.A, { username: 'admin.blocked', name: 'Admin Blocked' });
  const id = r.body.affiliate.id;
  // an admin recovery issued an ADMIN code (the recruiter code was invalidated ADMIN_RECOVERY; nothing used)
  const rc = E.db._tables.affiliateActivationCode.find((c) => c.affiliateId === id);
  Object.assign(rc, { invalidatedAt: T0, invalidatedReason: 'ADMIN_RECOVERY' });
  const sel = 'AdminSel_0123456';
  E.db._seed.activationCode({ affiliateId: id, selector: sel, verifierHash: sha256('v'.repeat(43)), passwordFingerprint: sha256(affRow(E, id).password), createdByType: 'ADMIN', createdById: 'admin-1', createdAt: T0 });
  const before = codeRows(E, id).map((c) => ({ ...c }));
  const g = await regen(E, E.A, id);
  ok('the recruiter cannot issue a new code once an ADMIN code exists (even with no code ever used) → 409 ACTIVATION_NOT_AVAILABLE, nothing written',
    g.status === 409 && eq(g.body, { code: 'ACTIVATION_NOT_AVAILABLE' }) && eq(codeRows(E, id), before), g.text);
  const p = await call(E.pending, req('/api/recruiter/affiliates/activation', { cookie: cookieOf(E.A) }));
  ok('…and the affiliate is not in the recruiter pending list (the hand-over is the admin\'s)', p.status === 200 && !p.body.pending.some((x) => x.affiliate.id === id), p.text);
  ok('…and no recruiter response carries the ADMIN code selector', !p.text.includes(sel) && !g.text.includes(sel));
}

// ── 13. the code never reaches a log ──────────────────────────────────────────
console.log('\n13. Logs');
{
  const seenCodes = [];
  // every code issued in this file is in some fake db; collect them from the logged creation responses is impossible
  // by design — so instead assert that no logged line contains a code-shaped token.
  const codeShaped = /[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}/;
  for (const l of logged) if (codeShaped.test(l) && !/^\s*(PASS|FAIL)\b/.test(l.trim()) && !l.includes('  PASS ') && !l.includes('  FAIL ')) seenCodes.push(l);
  ok('no log line written by the code under test contains an activation code', seenCodes.length === 0, seenCodes.slice(0, 2).join(' | '));
  const handler = stripJs(read('src/lib/affiliateActivationHandlers.js'));
  ok('the public handler logs only an error code / name, never the request body', /console\.error\('\[affiliate-activation\]', e\?\.code \?\? e\?\.name \?\? 'ERROR'\)/.test(handler) && !/console\.\w+\([^)]*body/.test(handler));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
