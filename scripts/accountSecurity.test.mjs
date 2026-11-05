/**
 * scripts/accountSecurity.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 6 part 2 — account & session security (docs/recruiter-system.md §8; decisions D1–D7; D5 —
 * the per-account login throttle — is covered in depth by scripts/loginThrottleAccounts.test.mjs). No real database: recruiter flows run on scripts/lib/recruiterFakeDb.mjs,
 * affiliate flows on scripts/lib/rewardsFakeDb.mjs. The services / routes that use the DEFAULT
 * prisma client (loginAffiliate, updateAffiliateProfile, the affiliate auth / me routes, the admin
 * affiliates route) get the fake through a module-resolve seam: every import of src/lib/prisma.js
 * resolves to a proxy of `globalThis.__acctPrisma` (this process only).
 *
 *   1. Trusted proxy / client IP (D6)        5. Affiliate admin edit + profile (D4)
 *   2. Recruiter sessions (D1, D2)           6. Affiliate login enumeration (D4)
 *   3. Recruiter passwords (D7)              7. Activation / recovery bump the version
 *   4. Affiliate sessions (D1, D4)           8. Sensitive data, migration, D5 wiring
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'account-security-test-secret-not-real';
delete process.env.TRUSTED_PROXY_MODE;
delete process.env.TRUSTED_PROXY_SECRET;

// ── module seam: src/lib/prisma.js → the current fake (and '@/' → src/) ────────
const SRC = new URL('../src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  const SRC = ${JSON.stringify(SRC)};
  const FAKE = "data:text/javascript," + encodeURIComponent("export default new Proxy({}, { get: (_t, k) => { const db = globalThis.__acctPrisma; if (!db) throw new Error('no fake prisma installed'); const v = db[k]; return typeof v === 'function' ? v.bind(db) : v; } });");
  export async function resolve(spec, ctx, next) {
    let r;
    if (spec.startsWith("@/")) {
      const base = SRC + spec.slice(2);
      try { r = await next(base, ctx); } catch { r = await next(base + ".js", ctx); }
    } else r = await next(spec, ctx);
    if (String(r.url).endsWith("/src/lib/prisma.js")) return { url: FAKE, shortCircuit: true };
    return r;
  }`)}`);

const { makeRecruiterFakeDb } = await import('./lib/recruiterFakeDb.mjs');
const { makeRewardsFakeDb } = await import('./lib/rewardsFakeDb.mjs');
const TP = await import('../src/lib/trustedProxy.js');
const { rateLimit, rateLimitStoreKey } = await import('../src/lib/rateLimit.js');
const { recruiterHandlers, adminRecruiterHandlers } = await import('../src/lib/recruiterRouteHandlers.js');
const RS = await import('../src/lib/services/recruiterService.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { withAffiliateAuth } = await import('../src/lib/middleware/withAffiliateAuth.js');
const { signToken, verifyToken, comparePassword, hashPassword } = await import('../src/lib/services/authService.js');
const ASYS = await import('../src/lib/services/affiliateSystemService.js');
const { recruiterAffiliateHandlers } = await import('../src/lib/recruiterAffiliateRouteHandlers.js');
const { affiliateActivationHandlers } = await import('../src/lib/affiliateActivationHandlers.js');
const AR = await import('../src/lib/services/affiliateActivationRecoveryService.js');
const affAuthRoute = await import('../src/app/api/affiliate/auth/route.js');
const affMeRoute = await import('../src/app/api/affiliate/me/route.js');
const adminAffRoute = await import('../src/app/api/admin/affiliates/route.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const big = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));

// capture every console line (sensitive-data checks)
const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : big(x))).join(' ')); orig(...a); };
}
const SECRETS = new Set(); // every password / hash / token produced by the tests
const remember = (...xs) => { for (const x of xs) if (typeof x === 'string' && x.length >= 6) SECRETS.add(x); return xs[0]; };
const RESPONSE_TEXTS = [];

let ipSeq = 0;
const req = (url, { method = 'GET', body, cookie, bearer, raw, headers = {} } = {}) => {
  const h = { 'x-forwarded-for': `10.55.${(ipSeq >> 8) & 255}.${(++ipSeq) & 255}`, ...headers };
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
};
const call = async (handler, r, ctx = {}) => {
  const res = await handler(r, ctx);
  const text = await res.text();
  RESPONSE_TEXTS.push(text);
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, setCookie: res.headers.get('set-cookie') };
};
const cookieToken = (setCookie, name) => (new RegExp(`${name}=([^;]*)`).exec(setCookie || '') || [])[1] || null;
const adminToken = () => signToken({ userId: 'admin-1', email: 'admin@test.local', role: 'ADMIN' });
const asAdmin = () => ({ cookie: `auth_token=${adminToken()}` });
const ctx = (id) => ({ params: Promise.resolve({ id }) });

// ── 1. Trusted proxy (D6) ─────────────────────────────────────────────────────
console.log('\n1. Trusted proxy and client IP (D6)');
{
  const SECRET = 'x'.repeat(40);
  const R = (headers) => new Request('http://localhost/x', { headers });
  const spoof = R({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.9.9.9', 'x-real-ip': '7.7.7.7' });
  ok('no configuration → nothing trusted: spoofed cf-connecting-ip / x-forwarded-for / x-real-ip are ignored (null)',
    TP.trustedClientIp(spoof, {}) === null && TP.trustedProxyConfig({}).mode === 'none' && TP.trustedProxyConfig({}).reason === 'NOT_CONFIGURED');
  ok('an unknown mode → nothing trusted', TP.trustedClientIp(spoof, { TRUSTED_PROXY_MODE: 'cloudflare-ish' }) === null);
  ok('cloudflare WITHOUT a secret, or with a secret < 32 chars → nothing trusted (fail safe)',
    TP.trustedClientIp(spoof, { TRUSTED_PROXY_MODE: 'cloudflare' }) === null
    && TP.trustedClientIp(R({ 'cf-connecting-ip': '1.2.3.4', 'x-trusted-proxy-secret': 'short' }), { TRUSTED_PROXY_MODE: 'cloudflare', TRUSTED_PROXY_SECRET: 'short' }) === null
    && TP.trustedProxyConfig({ TRUSTED_PROXY_MODE: 'cloudflare', TRUSTED_PROXY_SECRET: 'short' }).reason === 'CLOUDFLARE_WITHOUT_VALID_SECRET');
  const CF = { TRUSTED_PROXY_MODE: 'cloudflare', TRUSTED_PROXY_SECRET: SECRET };
  ok('cloudflare + a valid secret: a request WITHOUT the secret header → null (a direct request cannot spoof cf-connecting-ip)', TP.trustedClientIp(spoof, CF) === null);
  ok('cloudflare: a WRONG secret header → null', TP.trustedClientIp(R({ 'cf-connecting-ip': '1.2.3.4', 'x-trusted-proxy-secret': 'y'.repeat(40) }), CF) === null);
  ok('cloudflare: the RIGHT secret header → the cf-connecting-ip value', TP.trustedClientIp(R({ 'cf-connecting-ip': '1.2.3.4', 'x-trusted-proxy-secret': SECRET }), CF) === '1.2.3.4');
  // a real Request refuses a newline in a header value; a raw stub reaches the parser anyway
  const stub = (h) => ({ headers: { get: (n) => h[n] ?? null } });
  ok('cloudflare: an invalid IP format (header injection) → null',
    TP.trustedClientIp(stub({ 'cf-connecting-ip': '1.2.3.4\nX: y', 'x-trusted-proxy-secret': SECRET }), CF) === null
    && TP.trustedClientIp(R({ 'cf-connecting-ip': 'evil host', 'x-trusted-proxy-secret': SECRET }), CF) === null);
  ok('proxy mode (no secret): the LAST x-forwarded-for hop (the one the proxy appends), never the first', TP.trustedClientIp(spoof, { TRUSTED_PROXY_MODE: 'proxy' }) === '9.9.9.9');
  const PX = { TRUSTED_PROXY_MODE: 'proxy', TRUSTED_PROXY_SECRET: SECRET };
  ok('proxy mode WITH a secret: the secret header is required (missing → null, right → last hop)',
    TP.trustedClientIp(spoof, PX) === null && TP.trustedClientIp(R({ 'x-forwarded-for': '5.6.7.8, 9.9.9.9', 'x-trusted-proxy-secret': SECRET }), PX) === '9.9.9.9');
  ok('proxy mode with an INVALID (short) secret → nothing trusted', TP.trustedClientIp(spoof, { TRUSTED_PROXY_MODE: 'proxy', TRUSTED_PROXY_SECRET: 'short' }) === null);

  // trustedRateLimit: rotating spoofed headers share ONE bucket without configuration
  const key = `acct-test-untrusted-${randomUUID()}`;
  const rot = [];
  for (let i = 0; i < 5; i++) rot.push(TP.trustedRateLimit(R({ 'cf-connecting-ip': `1.1.1.${i}`, 'x-forwarded-for': `2.2.2.${i}` }), key, { max: 3, windowMs: 60_000 }, {}));
  ok('no config: 5 requests with 5 different spoofed IPs share the "untrusted" bucket → the 4th and 5th are limited (429)',
    rot.slice(0, 3).every((x) => x === null) && rot.slice(3).every((x) => x && x.status === 429));
  const key2 = `acct-test-trusted-${randomUUID()}`;
  const sep = [];
  for (let i = 0; i < 5; i++) sep.push(TP.trustedRateLimit(R({ 'cf-connecting-ip': `3.3.3.${i}`, 'x-trusted-proxy-secret': SECRET }), key2, { max: 1, windowMs: 60_000 }, CF));
  ok('with the trusted configuration, 5 different TRUSTED IPs get 5 separate buckets (none limited at max 1)', sep.every((x) => x === null));
  const same = [0, 1].map(() => TP.trustedRateLimit(R({ 'cf-connecting-ip': '4.4.4.4', 'x-trusted-proxy-secret': SECRET }), `acct-test-same-${key2}`, { max: 1, windowMs: 60_000 }, CF));
  ok('…and the same trusted IP twice at max 1 → the 2nd is limited', same[0] === null && same[1]?.status === 429);
  // rateLimit() itself is unchanged (legacy derivation, per claimed IP) and is now a thin wrapper
  const key3 = `acct-test-legacy-${randomUUID()}`;
  const legacy = [0, 1, 2].map((i) => rateLimit(R({ 'cf-connecting-ip': `8.8.8.${i}` }), key3, { max: 1, windowMs: 60_000 }));
  ok('rateLimit() unchanged: still keyed on its own IP derivation (3 different cf IPs at max 1 → none limited)', legacy.every((x) => x === null));
  const rl = stripJs(read('src/lib/rateLimit.js'));
  ok('rateLimit() = rateLimitStoreKey(`${key}:${getIp(req)}`) — the same store key as before; getIp untouched',
    /export function rateLimit\(req, key, \{ max = 30, windowMs = 60_000 \} = \{\}\) \{\s*return rateLimitStoreKey\(`\$\{key\}:\$\{getIp\(req\)\}`, \{ max, windowMs \}\);\s*\}/.test(rl)
    && /const cf\s+= req\.headers\?\.get\?\.\('cf-connecting-ip'\)/.test(rl));
  ok('rateLimitStoreKey counts per explicit key (2nd call at max 1 → 429 with Retry-After)',
    (() => { const k = `acct-test-store-${randomUUID()}`; const a = rateLimitStoreKey(k, { max: 1 }); const b = rateLimitStoreKey(k, { max: 1 }); return a === null && b?.status === 429 && !!b.headers.get('retry-after'); })());
  ok('the trusted limiter is used by exactly the approved routes (recruiter login / password, affiliate login / password, activation + recovery requests)',
    /trustedRateLimit as defaultRateLimit/.test(read('src/lib/recruiterRouteHandlers.js'))
    && /trustedRateLimit as rateLimit/.test(read('src/app/api/affiliate/auth/route.js'))
    && /trustedRateLimit\(req, `affiliate-password:/.test(read('src/app/api/affiliate/me/route.js'))
    && /trustedRateLimit as defaultRateLimit/.test(read('src/lib/affiliateActivationHandlers.js'))
    && /trustedRateLimit as defaultRateLimit/.test(read('src/lib/affiliateActivationRecoveryHandlers.js')));
}

// ── 2. Recruiter sessions (D1, D2) ────────────────────────────────────────────
console.log('\n2. Recruiter sessions: tokenVersion');
function recruiterEnv() {
  const db = makeRecruiterFakeDb();
  const rec = recruiterHandlers({ db, rateLimit: () => null });
  const adm = adminRecruiterHandlers({ db });
  return {
    db, rec, adm,
    me: (token) => call(withRecruiterAuth(rec.me), req('/api/recruiter/me', { cookie: token ? `recruiter_token=${token}` : undefined })),
    login: (body) => call(rec.login, req('/api/recruiter/auth', { method: 'POST', body })),
    setActive: (id, action) => call(withAdminAuth(adm.setActive), req(`/api/admin/recruiters/${id}`, { method: 'PATCH', body: { action }, ...asAdmin() }), ctx(id)),
    change: (token, body) => call(withRecruiterAuth(rec.changePassword), req('/api/recruiter/password', { method: 'PUT', body, cookie: `recruiter_token=${token}` })),
    reset: (id, body, auth = asAdmin()) => call(withAdminAuth(adm.resetPassword), req(`/api/admin/recruiters/${id}/password`, { method: 'POST', body, ...auth }), ctx(id)),
  };
}
const RPW = remember('Rec-Passw0rd');
async function newRecruiter(E, username = `rec.${randomUUID().slice(0, 6)}`) {
  const c = await call(withAdminAuth(E.adm.create), req('/api/admin/recruiters', { method: 'POST', body: { username, name: 'Recruteur Test', password: RPW }, ...asAdmin() }));
  if (c.status !== 201) throw new Error(`setup: create ${c.text}`);
  const l = await E.login({ username, password: RPW });
  const token = remember(cookieToken(l.setCookie, 'recruiter_token'));
  return { id: c.body.recruiter.id, username, token };
}
const recRow = (E, id) => E.db._tables.recruiter.find((r) => r.id === id);
{
  const E = recruiterEnv();
  const r = await newRecruiter(E);
  ok('login issues a token carrying tv = the account tokenVersion (0)', verifyToken(r.token).tv === 0 && recRow(E, r.id).tokenVersion === 0);
  ok('a current token → /me 200', (await E.me(r.token)).status === 200);
  const legacy = signToken({ recruiterId: r.id, username: r.username, type: 'recruiter' }); // issued before versions existed
  ok('a legacy token WITHOUT tv is accepted while the version is 0 (D2: nobody is logged out by the deployment)', (await E.me(legacy)).status === 200);
  const dis = await E.setActive(r.id, 'disable');
  ok('disable → tokenVersion 1', dis.status === 200 && recRow(E, r.id).tokenVersion === 1);
  const afterDisable = await E.me(r.token);
  ok('disable → the old token is refused (403 RECRUITER_DISABLED) and the cookie cleared', afterDisable.status === 403 && eq(afterDisable.body, { code: 'RECRUITER_DISABLED' }) && /Max-Age=0/.test(afterDisable.setCookie || ''));
  await E.setActive(r.id, 'enable');
  ok('enable → tokenVersion 2 (bumped again)', recRow(E, r.id).tokenVersion === 2);
  const revived = await E.me(r.token);
  ok('re-enabled → the OLD token is STILL refused (401 UNAUTHORIZED): re-enabling never revives a session', revived.status === 401 && eq(revived.body, { code: 'UNAUTHORIZED' }));
  ok('…the legacy (no tv) token is refused too once the version moved', (await E.me(legacy)).status === 401);
  const outdated = signToken({ recruiterId: r.id, username: r.username, type: 'recruiter', tv: 1 });
  ok('an outdated token (tv 1 < version 2) → 401', (await E.me(outdated)).status === 401);
  const future = signToken({ recruiterId: r.id, username: r.username, type: 'recruiter', tv: 3 });
  ok('a token with a version that does not exist yet (tv 3 > version 2) → 401 (exact match only)', (await E.me(future)).status === 401);
  const relog = await E.login({ username: r.username, password: RPW });
  const fresh = cookieToken(relog.setCookie, 'recruiter_token');
  ok('a new login after re-enabling works and carries tv 2', relog.status === 200 && verifyToken(fresh).tv === 2 && (await E.me(fresh)).status === 200);
  ok('re-saving the same state (enable an active recruiter) changes nothing (idempotent, no bump)',
    (await E.setActive(r.id, 'enable')).body.changed === false && recRow(E, r.id).tokenVersion === 2 && (await E.me(fresh)).status === 200);
  ok('tokenVersionOf: a missing / negative / non-integer tv counts as 0', RS.tokenVersionOf({}) === 0 && RS.tokenVersionOf({ tv: -1 }) === 0 && RS.tokenVersionOf({ tv: '2' }) === 0 && RS.tokenVersionOf({ tv: 2 }) === 2);
}
{
  // concurrency: requests with an old token racing a disable
  const E = recruiterEnv();
  const r = await newRecruiter(E);
  const results = [];
  let committed = false;
  const fire = (tag) => E.me(r.token).then((x) => results.push({ tag, status: x.status }));
  const before = Array.from({ length: 10 }, (_, i) => fire(`pre${i}`));
  const disable = E.setActive(r.id, 'disable').then(() => { committed = true; });
  const mid = Array.from({ length: 10 }, (_, i) => fire(`mid${i}`));
  await Promise.all([...before, disable, ...mid]);
  ok('20 concurrent requests racing a disable all resolve with 200 / 403 / 401 only (no error)', results.length === 20 && results.every((x) => [200, 401, 403].includes(x.status)), big(results));
  const after = await Promise.all(Array.from({ length: 20 }, () => E.me(r.token)));
  ok('after the disable committed, EVERY later request with the old token is refused (0 accepted out of 20)', committed && after.every((x) => x.status !== 200));
  await E.setActive(r.id, 'enable');
  const afterEnable = await Promise.all(Array.from({ length: 10 }, () => E.me(r.token)));
  ok('…and after a concurrent-safe re-enable, the old token stays refused (0 / 10 accepted)', afterEnable.every((x) => x.status === 401));
}

// ── 3. Recruiter passwords (D7) ───────────────────────────────────────────────
console.log('\n3. Recruiter password change and admin reset');
{
  const E = recruiterEnv();
  const r = await newRecruiter(E);
  const NEW = remember('N3w-Recruiter-pass');
  const wrong = await E.change(r.token, { currentPassword: 'not-the-password', newPassword: NEW, newPasswordConfirm: NEW });
  ok('wrong current password → 401 { code: INVALID_CREDENTIALS }, nothing changed', wrong.status === 401 && eq(wrong.body, { code: 'INVALID_CREDENTIALS' }) && recRow(E, r.id).tokenVersion === 0);
  const weak = await E.change(r.token, { currentPassword: RPW, newPassword: 'short', newPasswordConfirm: 'short' });
  const long = await E.change(r.token, { currentPassword: RPW, newPassword: 'x'.repeat(129), newPasswordConfirm: 'x'.repeat(129) });
  ok('too short / too long (policy 8–128, as at creation) → 400 INVALID_INPUT fields.newPassword',
    [weak, long].every((x) => x.status === 400 && eq(x.body, { code: 'INVALID_INPUT', fields: { newPassword: 'INVALID_PASSWORD' } })));
  const mis = await E.change(r.token, { currentPassword: RPW, newPassword: NEW, newPasswordConfirm: `${NEW}x` });
  ok('confirmation mismatch → 400 fields.newPasswordConfirm PASSWORD_MISMATCH', mis.status === 400 && eq(mis.body, { code: 'INVALID_INPUT', fields: { newPasswordConfirm: 'PASSWORD_MISMATCH' } }));
  const extra = await E.change(r.token, { currentPassword: RPW, newPassword: NEW, newPasswordConfirm: NEW, isActive: true });
  ok('strict body: an extra field → 400 fields.body UNKNOWN_FIELD', extra.status === 400 && eq(extra.body, { code: 'INVALID_INPUT', fields: { body: 'UNKNOWN_FIELD' } }));
  ok('…none of the refused attempts changed the hash, the version or wrote an audit row',
    (await comparePassword(RPW, recRow(E, r.id).passwordHash)) && recRow(E, r.id).tokenVersion === 0 && !E.db._tables.recruiterAuditLog.some((a) => a.action === 'RECRUITER_PASSWORD_CHANGED'));
  const good = await E.change(r.token, { currentPassword: RPW, newPassword: NEW, newPasswordConfirm: NEW });
  const freshTok = remember(cookieToken(good.setCookie, 'recruiter_token'));
  ok('correct current password → 200 with a fresh cookie (tv 1) and the own profile only',
    good.status === 200 && verifyToken(freshTok).tv === 1 && /HttpOnly; Path=\/api\/recruiter; Max-Age=604800; SameSite=Strict/.test(good.setCookie) && eq(Object.keys(good.body), ['recruiter']) && !('passwordHash' in good.body.recruiter));
  ok('…every older session is revoked (the old token → 401) and the fresh one works', (await E.me(r.token)).status === 401 && (await E.me(freshTok)).status === 200);
  ok('…the new password logs in, the old one no longer does', (await E.login({ username: r.username, password: NEW })).status === 200 && (await E.login({ username: r.username, password: RPW })).status === 401);
  const ca = E.db._tables.recruiterAuditLog.filter((a) => a.action === 'RECRUITER_PASSWORD_CHANGED');
  ok('audit RECRUITER_PASSWORD_CHANGED (RECRUITER actor, no password / hash in details)', ca.length === 1 && ca[0].actorType === 'RECRUITER' && ca[0].actorId === r.id && !/pass|hash|\$2/i.test(big(ca[0].details)));

  // concurrent password changes with the same current password → exactly one wins
  const E2 = recruiterEnv();
  const r2 = await newRecruiter(E2);
  const cands = ['Alpha-pass-1', 'Bravo-pass-2', 'Charlie-pass-3', 'Delta-pass-4'].map((p) => remember(p));
  const conc = await Promise.all(cands.map((p) => E2.change(r2.token, { currentPassword: RPW, newPassword: p, newPasswordConfirm: p })));
  const winners = conc.filter((x) => x.status === 200);
  const finalHash = recRow(E2, r2.id).passwordHash;
  const matching = [];
  for (const p of cands) if (await comparePassword(p, finalHash)) matching.push(p);
  ok('4 concurrent password changes from the same current password → exactly ONE succeeds (conditional write), version +1 once',
    winners.length === 1 && conc.filter((x) => x.status === 401).length === 3 && matching.length === 1 && recRow(E2, r2.id).tokenVersion === 1, conc.map((x) => x.status).join(','));

  // admin reset
  const E3 = recruiterEnv();
  const r3 = await newRecruiter(E3);
  await E3.setActive(r3.id, 'disable');
  const vBefore = recRow(E3, r3.id).tokenVersion;
  const RESET = remember('Reset-by-Admin-9');
  const rs = await E3.reset(r3.id, { newPassword: RESET });
  ok('admin reset → 200, the DISABLED recruiter stays disabled (isActive false), version +1',
    rs.status === 200 && rs.body.recruiter.isActive === false && recRow(E3, r3.id).isActive === false && recRow(E3, r3.id).tokenVersion === vBefore + 1);
  ok('…the response never contains the password or the hash', !rs.text.includes(RESET) && !/passwordHash|\$2[aby]\$/.test(rs.text));
  const ra = E3.db._tables.recruiterAuditLog.filter((a) => a.action === 'RECRUITER_PASSWORD_RESET');
  ok('…audit RECRUITER_PASSWORD_RESET (ADMIN actor = the admin id, details without any password)',
    ra.length === 1 && ra[0].actorType === 'ADMIN' && ra[0].actorId === 'admin-1' && eq(ra[0].details, { sessionsRevoked: true, isActive: false }));
  ok('…the disabled recruiter cannot log in even with the reset password (403 RECRUITER_DISABLED)', (await E3.login({ username: r3.username, password: RESET })).status === 403);
  await E3.setActive(r3.id, 'enable');
  ok('…once re-enabled by the admin, the reset password works and the pre-reset token stays refused',
    (await E3.login({ username: r3.username, password: RESET })).status === 200 && (await E3.me(r3.token)).status === 401);
  const E4 = recruiterEnv();
  const r4 = await newRecruiter(E4);
  await E4.reset(r4.id, { newPassword: remember('Reset-active-123') });
  ok('admin reset of an ACTIVE recruiter → its current session is revoked (401), it stays active', (await E4.me(r4.token)).status === 401 && recRow(E4, r4.id).isActive === true);
  const weakReset = await E4.reset(r4.id, { newPassword: 'short' });
  const extraReset = await E4.reset(r4.id, { newPassword: 'Long-enough-1', isActive: true });
  const unknown = await E4.reset('11111111-1111-1111-1111-111111111111', { newPassword: 'Long-enough-1' });
  ok('admin reset validation: weak → 400, extra field (e.g. isActive) → 400, unknown id → 404',
    weakReset.status === 400 && extraReset.status === 400 && unknown.status === 404 && recRow(E4, r4.id).isActive === true);
  const recTokAsAdmin = await E4.reset(r4.id, { newPassword: 'Long-enough-1' }, { cookie: `auth_token=${r4.token}` });
  const affTokAsAdmin = await E4.reset(r4.id, { newPassword: 'Long-enough-1' }, { cookie: `auth_token=${signToken({ affiliateId: 'a1', type: 'affiliate' })}` });
  const noTok = await E4.reset(r4.id, { newPassword: 'Long-enough-1' }, {});
  ok('admin reset refuses non-admin tokens (recruiter / affiliate token as auth_token → 401/403, no token → 401)',
    [recTokAsAdmin, affTokAsAdmin].every((x) => x.status === 401 || x.status === 403) && noTok.status === 401);
  ok('routes: PUT /api/recruiter/password under withRecruiterAuth; POST /api/admin/recruiters/[id]/password under withAdminAuth',
    /export const PUT = withRecruiterAuth\(h\.changePassword\)/.test(read('src/app/api/recruiter/password/route.js'))
    && /export const POST = withAdminAuth\(h\.resetPassword\)/.test(read('src/app/api/admin/recruiters/[id]/password/route.js')));
}

// ── 4. Affiliate sessions (withAffiliateAuth, injected db) ────────────────────
console.log('\n4. Affiliate sessions: per-request account check');
{
  const accounts = new Map([['A', { isActive: true, tokenVersion: 0 }], ['B', { isActive: true, tokenVersion: 3 }], ['OFF', { isActive: false, tokenVersion: 0 }]]);
  const reads = [];
  let deferReads = false; // concurrency block: the account is read one event-loop turn later
  const db = { affiliate: { async findUnique({ where, select }) {
    if (deferReads) await new Promise((r) => setImmediate(r));
    reads.push({ where, select }); const a = accounts.get(where.id); return a ? { ...a } : null;
  } } };
  let called = 0;
  const h = withAffiliateAuth(async () => { called++; return Response.json({ ok: true }); }, { db });
  const tok = (id, tv) => signToken({ affiliateId: id, username: id.toLowerCase(), type: 'affiliate', ...(tv === undefined ? {} : { tv }) });
  const run = (t) => call(h, req('/api/affiliate/x', { bearer: t }));
  ok('current token (tv = version) → 200', (await run(tok('B', 3))).status === 200 && called === 1);
  ok('legacy token without tv while the version is 0 → 200', (await run(tok('A'))).status === 200 && called === 2);
  const outdated = await run(tok('B', 2));
  ok('outdated token (tv 2 < version 3) → 401, handler NOT called', outdated.status === 401 && called === 2);
  ok('legacy token (no tv) once the version moved (3) → 401', (await run(tok('B'))).status === 401 && called === 2);
  ok('inactive account (valid signature, current version) → 401, handler NOT called', (await run(tok('OFF', 0))).status === 401 && called === 2);
  ok('missing account (deleted) → 401', (await run(tok('GHOST', 0))).status === 401 && called === 2);
  ok('every account read is by id with exactly { isActive, tokenVersion }', reads.every((r) => typeof r.where.id === 'string' && eq(Object.keys(r.select), ['isActive', 'tokenVersion'])));
  const broken = withAffiliateAuth(async () => { called++; return Response.json({ ok: true }); }, { db: { affiliate: { findUnique: async () => { throw new Error('db down at 10.0.0.9'); } } } });
  const down = await call(broken, req('/api/affiliate/x', { bearer: tok('A', 0) }));
  ok('a database error → 503 (never a silent pass, never a forced logout), handler NOT called, no internal message', down.status === 503 && called === 2 && !/10\.0\.0\.9|db down/.test(down.text));
  const recTok = signToken({ recruiterId: 'r1', type: 'recruiter' });
  const before = reads.length;
  ok('a recruiter / admin / tampered token is refused BEFORE any account read', [recTok, adminToken(), `${tok('A', 0)}x`].every(Boolean)
    && (await run(recTok)).status === 401 && (await run(adminToken())).status === 401 && (await run(`${tok('A', 0)}x`)).status === 401 && reads.length === before);
  // concurrency: an admin bump racing requests
  accounts.set('A', { isActive: true, tokenVersion: 0 });
  const t0 = tok('A', 0);
  deferReads = true;
  const flight = Array.from({ length: 10 }, () => run(t0)); // signature checked, account read still pending
  accounts.set('A', { isActive: true, tokenVersion: 1 });   // the bump commits while they are in flight
  const flightRes = await Promise.all(flight);
  const later = await Promise.all(Array.from({ length: 10 }, () => run(t0)));
  deferReads = false;
  ok('in-flight requests whose account read happens after the bump never accept the old token (10 concurrent + 10 later → all 401)',
    flightRes.every((x) => x.status === 401) && later.every((x) => x.status === 401));
}

// ── 5. Affiliate admin edit + profile (D4) ────────────────────────────────────
console.log('\n5. Affiliate: admin edit and self-service password');
const affRow = (db, id) => db._tables.affiliate.find((a) => a.id === id);
const affAudits = (db, action) => db._tables.recruiterAuditLog.filter((a) => a.action === action);
async function affiliateDb() {
  const pw = remember('Affil-pass-1');
  const hash = remember(await hashPassword(pw));
  const db = makeRewardsFakeDb({
    affiliate: [
      { id: 'A', username: 'aff.a', name: 'A', phone: '0611111111', password: hash, isActive: true, tokenVersion: 0, createdAt: new Date('2026-01-01') },
      { id: 'OFF', username: 'aff.off', name: 'Off', phone: '0622222222', password: hash, isActive: false, tokenVersion: 0, createdAt: new Date('2026-01-01') },
    ],
  });
  globalThis.__acctPrisma = db;
  return { db, pw };
}
{
  const { db } = await affiliateDb();
  await ASYS.adminUpdateAffiliate('A', { isActive: false }, { db, actorId: 'admin-1' });
  ok('admin disable → tokenVersion +1, audit AFFILIATE_DISABLED (ADMIN, sessionsRevoked)',
    affRow(db, 'A').tokenVersion === 1 && affRow(db, 'A').isActive === false && affAudits(db, 'AFFILIATE_DISABLED').length === 1
    && eq(affAudits(db, 'AFFILIATE_DISABLED')[0].details, { sessionsRevoked: true }) && affAudits(db, 'AFFILIATE_DISABLED')[0].actorId === 'admin-1' && affAudits(db, 'AFFILIATE_DISABLED')[0].recruiterId === null);
  await ASYS.adminUpdateAffiliate('A', { isActive: false, name: 'Renamed' }, { db, actorId: 'admin-1' });
  ok('re-saving the SAME activation state (false) → no bump, no audit', affRow(db, 'A').tokenVersion === 1 && affAudits(db, 'AFFILIATE_DISABLED').length === 1 && affRow(db, 'A').name === 'Renamed');
  await ASYS.adminUpdateAffiliate('A', { isActive: true }, { db, actorId: 'admin-1' });
  ok('admin enable → tokenVersion +1 again (2), audit AFFILIATE_ENABLED', affRow(db, 'A').tokenVersion === 2 && affAudits(db, 'AFFILIATE_ENABLED').length === 1);
  await ASYS.adminUpdateAffiliate('A', { isActive: true, commissionRate: 0.4 }, { db, actorId: 'admin-1' });
  ok('an edit with the same activation state and no password → no bump', affRow(db, 'A').tokenVersion === 2);
  const RESET = remember('Admin-reset-77');
  await ASYS.adminUpdateAffiliate('OFF', { password: RESET }, { db, actorId: 'admin-1' });
  const pr = affAudits(db, 'AFFILIATE_PASSWORD_RESET');
  ok('admin password reset of a DISABLED affiliate → version +1, it STAYS disabled (never activated by a reset)',
    affRow(db, 'OFF').tokenVersion === 1 && affRow(db, 'OFF').isActive === false && (await comparePassword(RESET, affRow(db, 'OFF').password)));
  ok('…audit AFFILIATE_PASSWORD_RESET (ADMIN = admin-1) with details { sessionsRevoked, isActive: the actual state } and no password',
    pr.length === 1 && pr[0].actorType === 'ADMIN' && pr[0].actorId === 'admin-1' && eq(pr[0].details, { sessionsRevoked: true, isActive: false }) && !big(pr[0]).includes(RESET) && !/\$2[aby]\$/.test(big(pr[0])));
  // through the real admin route (default prisma → the fake)
  const shortPw = await call(adminAffRoute.PUT, req('/api/admin/affiliates', { method: 'PUT', body: { id: 'A', password: 'abc' }, ...asAdmin() }));
  ok('admin route: a reset password shorter than 6 → 400, nothing changed', shortPw.status === 400 && affRow(db, 'A').tokenVersion === 2);
  const routeReset = await call(adminAffRoute.PUT, req('/api/admin/affiliates', { method: 'PUT', body: { id: 'A', password: remember('Route-reset-1') }, ...asAdmin() }));
  const lastReset = affAudits(db, 'AFFILIATE_PASSWORD_RESET').at(-1);
  ok('admin route: a valid reset → 200, version +1, audited with the acting admin (userId), response without password / hash',
    routeReset.status === 200 && affRow(db, 'A').tokenVersion === 3 && lastReset.actorId === 'admin-1' && eq(lastReset.details, { sessionsRevoked: true, isActive: true })
    && !routeReset.text.includes('Route-reset-1') && !/\$2[aby]\$/.test(routeReset.text) && !('password' in routeReset.body));
  ok('admin route still requires an admin (no token → 401, affiliate token → 401/403)',
    (await call(adminAffRoute.PUT, req('/api/admin/affiliates', { method: 'PUT', body: { id: 'A', password: 'Whatever-1' } }))).status === 401
    && [401, 403].includes((await call(adminAffRoute.PUT, req('/api/admin/affiliates', { method: 'PUT', body: { id: 'A', password: 'Whatever-1' }, cookie: `auth_token=${signToken({ affiliateId: 'A', type: 'affiliate' })}` }))).status));
}
{
  const { db, pw } = await affiliateDb();
  await ASYS.updateAffiliateProfile('A', { name: 'Nouveau nom' });
  ok('updateAffiliateProfile without a password → no bump', affRow(db, 'A').tokenVersion === 0 && affRow(db, 'A').name === 'Nouveau nom');
  await ASYS.updateAffiliateProfile('A', { password: remember('Profile-new-1') });
  ok('updateAffiliateProfile with a password → version +1 and a bcrypt hash', affRow(db, 'A').tokenVersion === 1 && (await comparePassword('Profile-new-1', affRow(db, 'A').password)));

  // the real /api/affiliate/me PUT (withAffiliateAuth + default prisma → the fake)
  const { db: db2, pw: pw2 } = await affiliateDb();
  const tok0 = remember(signToken({ affiliateId: 'A', username: 'aff.a', type: 'affiliate', tv: 0 }));
  const put = (token, body) => call(affMeRoute.PUT, req('/api/affiliate/me', { method: 'PUT', body: { type: 'profile', ...body }, bearer: token }));
  const tooShort = await put(tok0, { currentPassword: pw2, newPassword: 'abc' });
  ok('affiliate me: a new password shorter than 6 → 400 (the existing policy, now server-side), nothing changed', tooShort.status === 400 && affRow(db2, 'A').tokenVersion === 0);
  const wrongCur = await put(tok0, { currentPassword: 'wrong-current', newPassword: 'Abcdef-1' });
  ok('affiliate me: a wrong current password → 400 "Mot de passe actuel incorrect", nothing changed', wrongCur.status === 400 && wrongCur.body.error === 'Mot de passe actuel incorrect' && affRow(db2, 'A').tokenVersion === 0);
  const NEWPW = remember('Abcdef-2025');
  const good = await put(tok0, { currentPassword: pw2, newPassword: NEWPW });
  const freshTok = remember(good.body?.token);
  ok('affiliate me: correct current password → 200 with a fresh token (tv 1) in the body AND the cookie, no password / hash',
    good.status === 200 && verifyToken(freshTok).tv === 1 && cookieToken(good.setCookie, 'affiliate_token') === freshTok && /HttpOnly; Path=\/api\/affiliate/.test(good.setCookie)
    && !good.text.includes(NEWPW) && !/\$2[aby]\$/.test(good.text));
  const getMe = (t) => call(withAffiliateAuth(async () => Response.json({ ok: true })), req('/api/affiliate/me', { bearer: t }));
  ok('…every older session is revoked (old token → 401) and the fresh token works (200)', (await getMe(tok0)).status === 401 && (await getMe(freshTok)).status === 200);
  void pw;
}

// ── 6. Affiliate login: no enumeration ────────────────────────────────────────
console.log('\n6. Affiliate login: password first, no enumeration');
{
  const { db, pw } = await affiliateDb();
  const login = async (username, password) => { try { return { ok: true, value: await ASYS.loginAffiliate(username, password) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
  const unknown = await login('nobody.here', 'Whatever-1');
  const wrong = await login('aff.a', 'Wrong-pass-1');
  ok('an unknown identifier and a wrong password → the SAME error (code + message)', !unknown.ok && !wrong.ok && unknown.code === 'INVALID_CREDENTIALS' && eq([unknown.code, unknown.msg], [wrong.code, wrong.msg]));
  const inactiveWrong = await login('aff.off', 'Wrong-pass-1');
  ok('an INACTIVE account with a WRONG password → the same INVALID_CREDENTIALS (its state is not revealed)', !inactiveWrong.ok && eq([inactiveWrong.code, inactiveWrong.msg], [wrong.code, wrong.msg]));
  const inactiveRight = await login('aff.off', pw);
  ok('"Compte inactif" only with the CORRECT password (and no token)', !inactiveRight.ok && inactiveRight.code === 'INACTIVE' && /Compte inactif/.test(inactiveRight.msg));
  affRow(db, 'A').tokenVersion = 4;
  const good = await login('aff.a', pw);
  ok('active + correct password → a token with tv = the account tokenVersion (4)', good.ok && verifyToken(good.value.token).tv === 4 && verifyToken(good.value.token).type === 'affiliate');
  remember(good.value?.token);
  const byPhone = await login('0611111111', pw);
  ok('login by phone still works (unchanged OR lookup)', byPhone.ok);
  // through the real route
  const post = (body) => call(affAuthRoute.POST, req('/api/affiliate/auth', { method: 'POST', body }));
  const rUnknown = await post({ username: 'nobody.here', password: 'Whatever-1' });
  const rWrong = await post({ username: 'aff.a', password: 'Wrong-pass-1' });
  const rInactiveWrong = await post({ username: 'aff.off', password: 'Wrong-pass-1' });
  ok('route: unknown / wrong password / inactive+wrong password → byte-identical 401 bodies, no cookie',
    [rUnknown, rWrong, rInactiveWrong].every((x) => x.status === 401 && x.text === rUnknown.text && !x.setCookie));
  const src = stripJs(read('src/lib/services/affiliateSystemService.js'));
  const H = /const LOGIN_TIMING_HASH = '([^']+)'/.exec(src)?.[1];
  ok('the dummy hash is a valid bcrypt hash with cost 12 (same cost as real hashes) and never matches a guess',
    !!H && H.length === 60 && bcrypt.getRounds(H) === 12 && !(await comparePassword('Whatever-1', H)));
  ok('loginAffiliate compares (real or dummy hash) BEFORE checking isActive, and signs only after both',
    (() => { const b = src.slice(src.indexOf('export async function loginAffiliate'), src.indexOf('// ── Profile')); return b.indexOf('comparePassword(password, affiliate ? affiliate.password : LOGIN_TIMING_HASH)') > 0 && b.indexOf('comparePassword') < b.indexOf('if (!affiliate.isActive)') && b.indexOf('if (!affiliate.isActive)') < b.indexOf('affiliateSessionToken(affiliate)'); })());
}

// ── 7. Activation / recovery bump the version ─────────────────────────────────
console.log('\n7. A password set through an activation code / admin recovery bumps the version');
{
  const db = makeRecruiterFakeDb({ recovery: true, allowPasswordUpdate: true });
  const A = db._seed.recruiter({ username: 'rec.act', name: 'Recruteur Act' });
  const ha = recruiterAffiliateHandlers({ db, rateLimit: () => null });
  const hp = affiliateActivationHandlers({ db, rateLimit: () => null });
  const created = await call(withRecruiterAuth(ha.createAffiliate), req('/api/recruiter/affiliates', {
    method: 'POST', body: { username: 'act.vers', name: 'Affilié Version', requestId: randomUUID() },
    cookie: `recruiter_token=${signToken({ recruiterId: A.id, username: A.username, type: 'recruiter' })}`,
  }));
  const id = created.body.affiliate.id;
  const code = remember(created.body.activation.code);
  ok('setup: a recruiter-created affiliate starts at tokenVersion 0 (or unset)', created.status === 201 && !(db._tables.affiliate.find((a) => a.id === id).tokenVersion > 0));
  const PW = remember('Activation-pw-1');
  const red = await call(hp.redeem, req('/api/affiliate-activation', { method: 'POST', body: { code, password: PW, passwordConfirm: PW } }));
  ok('activation redemption → password set AND tokenVersion +1 (1)', red.status === 200 && db._tables.affiliate.find((a) => a.id === id).tokenVersion === 1);
  await AR.requestActivationRecovery({ identifier: 'act.vers', message: 'Mon code a été utilisé par quelqu’un d’autre' }, { db });
  const rec = db._tables.affiliateActivationRecovery.find((r) => r.affiliateId === id);
  const issued = await AR.adminApproveRecovery(rec.id, { db, actorId: 'admin-1' });
  remember(issued.code);
  ok('admin recovery approval → the password replaced AND tokenVersion +1 (2)', db._tables.affiliate.find((a) => a.id === id).tokenVersion === 2);
}

// ── 8. Sensitive data, migration, D5 ──────────────────────────────────────────
console.log('\n8. Sensitive data, migration, D5 wiring');
{
  const leakedResp = RESPONSE_TEXTS.filter((t) => [...SECRETS].some((s) => t.includes(s) && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)));
  // fresh tokens are legitimately returned once (login / password change body / Set-Cookie);
  // passwords and hashes must never appear in any response body.
  const pwsAndHashes = [...SECRETS].filter((s) => !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s) && !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/.test(s));
  ok('no password or password hash in ANY response body of this suite', RESPONSE_TEXTS.every((t) => !pwsAndHashes.some((s) => t.includes(s))), leakedResp.length);
  ok('no password, hash, session token or activation code in ANY captured console line', logged.every((l) => ![...SECRETS].some((s) => l.includes(s))));
  ok('error bodies are codes / fixed texts only (no stack, no Prisma message)', RESPONSE_TEXTS.every((t) => !/at .*\.(m?js):\d+|PrismaClient|Invalid `prisma/.test(t)));
  const sql = read('prisma/migrations/20261109_account_token_version/migration.sql');
  const code = stripJs(sql.replace(/^--.*$/gm, ''));
  ok('migration 20261109: exactly 2 additive columns (affiliates / recruiters "tokenVersion" INTEGER NOT NULL DEFAULT 0) + 2 CHECKs >= 0 (NOT VALID then VALIDATE), re-runnable',
    (code.match(/ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0/g) || []).length === 2
    && /ALTER TABLE "affiliates" ADD COLUMN IF NOT EXISTS "tokenVersion"/.test(code) && /ALTER TABLE "recruiters" ADD COLUMN IF NOT EXISTS "tokenVersion"/.test(code)
    && (code.match(/CHECK \("tokenVersion" >= 0\) NOT VALID/g) || []).length === 2 && (code.match(/VALIDATE CONSTRAINT/g) || []).length === 2
    && (code.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || []).length === 2);
  ok('migration 20261109 changes nothing else (no UPDATE / DELETE / DROP / TYPE change / other table)',
    !/\bUPDATE\s+"|DELETE\s+FROM|\bDROP\b|ALTER COLUMN|TRUNCATE/i.test(code) && [...code.matchAll(/ALTER TABLE "(\w+)"/g)].every((m) => ['affiliates', 'recruiters'].includes(m[1])));
  const schema = read('prisma/schema.prisma');
  ok('schema: Affiliate.tokenVersion and Recruiter.tokenVersion are Int @default(0)',
    /model Affiliate \{[\s\S]*?tokenVersion\s+Int\s+@default\(0\)[\s\S]*?\n\}/.test(schema) && /model Recruiter \{[\s\S]*?tokenVersion\s+Int\s+@default\(0\)[\s\S]*?\n\}/.test(schema));
  // D5 (approved: ONE production web instance) — the in-memory per-account throttle is wired in
  // both login paths, checked AND registered before the password comparison; behaviour is
  // covered in scripts/loginThrottleAccounts.test.mjs.
  const affLogin = (() => { const x = stripJs(read('src/lib/services/affiliateSystemService.js')); return x.slice(x.indexOf('export async function loginAffiliate'), x.indexOf('// ── Profile')); })();
  const recLogin = (() => { const x = stripJs(read('src/lib/services/recruiterService.js')); return x.slice(x.indexOf('export async function loginRecruiter'), x.indexOf('export async function recordRecruiterLogout')); })();
  const order = (b, ...marks) => marks.every((m, i) => b.indexOf(m) >= 0 && (i === 0 || b.indexOf(marks[i - 1]) < b.indexOf(m)));
  ok('D5 affiliate: checkLock → registerFailure → comparePassword → clearFailures (reservation before the slow compare; clear only after a correct password)',
    order(affLogin, 'checkLock(throttle, key, t)', 'registerFailure(throttle, key, t)', 'comparePassword(password', 'clearFailures(throttle, key)')
    && /`affiliate:\$\{affiliate\.id\}`/.test(affLogin) && /`affiliate-id:\$\{throttleKey\(input\)\}`/.test(affLogin) && /LOGIN_THROTTLED/.test(affLogin));
  ok('D5 recruiter: checkLock → registerFailure BEFORE the first await (findUnique) → comparePassword → clearFailures',
    order(recLogin, 'checkLock(throttle, key, t)', 'registerFailure(throttle, key, t)', 'await db.recruiter.findUnique', 'comparePassword(password', 'clearFailures(throttle, key)')
    && /`recruiter:\$\{throttleKey\(username\)\}`/.test(recLogin) && /fail\('RATE_LIMITED'\)/.test(recLogin));
  ok('D5 affiliate route: LOGIN_THROTTLED → 429 with a fixed generic body (code RATE_LIMITED)',
    /err\.code === 'LOGIN_THROTTLED'[\s\S]{0,200}status: 429/.test(stripJs(read('src/app/api/affiliate/auth/route.js'))));
  ok('D5 reuses the shared loginThrottle module (5 failures / 15 min)',
    /LOGIN_MAX_FAILURES = 5/.test(read('src/lib/loginThrottle.js')) && /LOGIN_WINDOW_MS\s*=\s*15 \* 60_000/.test(read('src/lib/loginThrottle.js')));
  const docs = read('docs/recruiter-system.md');
  ok('docs §8: D5 implemented in memory on ONE web instance, its section present, and the trusted-proxy deployment configuration documented',
    /D5 \(per-account login throttling\) is\s+implemented in memory, because production runs \*\*one\*\* Next\.js web instance/.test(docs)
    && /### Per-account login throttling \(D5\)/.test(docs) && /5 failed attempts per account per 15-minute fixed\s+window/.test(docs)
    && /TRUSTED_PROXY_MODE=cloudflare/.test(docs) && !/\*\*on hold\*\*/.test(docs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
