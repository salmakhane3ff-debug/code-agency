/**
 * scripts/affiliateAuthSession.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate session authentication (withAffiliateAuth) + logout (DELETE /api/affiliate/auth).
 * No real database: withAffiliateAuth gets an injected `opts.db`; every import of
 * src/lib/prisma.js resolves to a throwing proxy (nothing here may touch the default client).
 *
 *   1. Single-source checks: no token, valid Bearer, valid cookie, expired, wrong type
 *      (recruiter / admin), tokenVersion mismatch, inactive account, DB failure (503).
 *   2. Stale cookie + Bearer: stale cookie + valid Bearer → 200 and the cookie is cleared;
 *      stale cookie + invalid Bearer → 401 (cookie cleared); valid cookie + invalid Bearer →
 *      200 (cookie preferred, nothing cleared); a fresh cookie set by the handler is kept;
 *      the Bearer fallback runs the SAME full checks (expired / wrong type / version / inactive).
 *   3. Handler errors → 500 (never a 401 that would look like an expired session).
 *   4. Logout: DELETE clears the cookie with the setter's exact attributes (dev + production);
 *      the dashboard handleLogout and AffiliateNavGate logout call it before clearing storage.
 *   5. Isolation: an affiliate token is refused by withRecruiterAuth, a recruiter token by
 *      withAffiliateAuth (cookie or Bearer).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.JWT_SECRET = 'affiliate-auth-session-test-secret-not-real';

const SRC = new URL('../src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  const SRC = ${JSON.stringify(SRC)};
  const FAKE = "data:text/javascript," + encodeURIComponent("export default new Proxy({}, { get: () => { throw new Error('default prisma must not be used in this test'); } });");
  export async function resolve(spec, ctx, next) {
    let r;
    if (spec.startsWith("@/")) {
      const base = SRC + spec.slice(2);
      try { r = await next(base, ctx); } catch { r = await next(base + ".js", ctx); }
    } else r = await next(spec, ctx);
    if (String(r.url).endsWith("/src/lib/prisma.js")) return { url: FAKE, shortCircuit: true };
    return r;
  }`)}`);

const jwt = (await import('jsonwebtoken')).default;
const { withAffiliateAuth, affiliateCookieHeader, AFFILIATE_COOKIE } = await import('../src/lib/middleware/withAffiliateAuth.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const authRoute = await import('../src/app/api/affiliate/auth/route.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// silence + capture console.error (handler-error logging check)
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

const accounts = new Map([
  ['A', { isActive: true, tokenVersion: 0 }],
  ['B', { isActive: true, tokenVersion: 2 }],
  ['OFF', { isActive: false, tokenVersion: 0 }],
]);
let reads = 0;
const db = { affiliate: { async findUnique({ where }) { reads++; const a = accounts.get(where.id); return a ? { ...a } : null; } } };
const downDb = { affiliate: { async findUnique() { throw new Error('connect ECONNREFUSED 10.9.9.9:5432'); } } };

const tok = (id, tv) => signToken({ affiliateId: id, username: id.toLowerCase(), type: 'affiliate', ...(tv === undefined ? {} : { tv }) });
const expired = (id) => jwt.sign({ affiliateId: id, username: id.toLowerCase(), type: 'affiliate', tv: 0, iat: Math.floor(Date.now() / 1000) - 8 * 86400, exp: Math.floor(Date.now() / 1000) - 86400 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
const otherSecret = (id) => jwt.sign({ affiliateId: id, type: 'affiliate', tv: 0 }, 'a-different-release-secret', { algorithm: 'HS256', expiresIn: '7d' });
const recruiterTok = () => signToken({ recruiterId: 'r1', username: 'rec', type: 'recruiter' });
const adminTok = () => signToken({ userId: 'admin-1', email: 'admin@test.local', role: 'ADMIN' });

const req = (url, { method = 'GET', cookie, bearer } = {}) => {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  return new Request(`http://localhost${url}`, { method, headers: h });
};
const run = async (handler, r) => {
  const res = await handler(r, {});
  const setCookies = res.headers.getSetCookie();
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body, setCookies };
};
const CLEAR_DEV = 'affiliate_token=; HttpOnly; Path=/api/affiliate; Max-Age=0; SameSite=Strict';
const clears = (r) => r.setCookies.length === 1 && r.setCookies[0] === CLEAR_DEV;
const noCookie = (r) => r.setCookies.length === 0;

let seen = [];
const handler = withAffiliateAuth(async (_r, _c, decoded) => { seen.push(decoded.affiliateId); return Response.json({ ok: true, id: decoded.affiliateId }); }, { db });
const call = (opts) => run(handler, req('/api/affiliate/me', opts));
const cookie = (t) => `theme=dark; ${AFFILIATE_COOKIE}=${t}; other=1`;

// ── 1. Single source ─────────────────────────────────────────────────────────
console.log('\n1. Single token source');
{
  seen = [];
  const none = await call({});
  ok('no token → 401 "Token requis", handler not called', none.status === 401 && none.body?.error === 'Token requis' && seen.length === 0 && noCookie(none));
  const bearer = await call({ bearer: tok('A', 0) });
  ok('valid Bearer → 200 (handler gets the decoded affiliate)', bearer.status === 200 && bearer.body?.id === 'A' && noCookie(bearer));
  const ck = await call({ cookie: cookie(tok('B', 2)) });
  ok('valid cookie → 200, nothing cleared', ck.status === 200 && ck.body?.id === 'B' && noCookie(ck));
  seen = [];
  ok('expired Bearer → 401', (await call({ bearer: expired('A') })).status === 401 && seen.length === 0);
  const expC = await call({ cookie: cookie(expired('A')) });
  ok('expired cookie (no Bearer) → 401 and the stale cookie is cleared', expC.status === 401 && clears(expC) && seen.length === 0);
  ok('token signed with another secret (other release) → 401', (await call({ bearer: otherSecret('A') })).status === 401);
  ok('recruiter token as Bearer → 401', (await call({ bearer: recruiterTok() })).status === 401);
  ok('recruiter token as affiliate_token cookie → 401', (await call({ cookie: cookie(recruiterTok()) })).status === 401);
  ok('admin token as Bearer → 401', (await call({ bearer: adminTok() })).status === 401);
  ok('tokenVersion mismatch (tv 1, account at 2) → 401', (await call({ bearer: tok('B', 1) })).status === 401);
  ok('legacy token without tv once the version moved → 401', (await call({ bearer: tok('B') })).status === 401);
  ok('inactive account → 401', (await call({ bearer: tok('OFF', 0) })).status === 401);
  ok('unknown account → 401', (await call({ bearer: tok('GHOST', 0) })).status === 401);
  ok('tampered token → 401', (await call({ bearer: `${tok('A', 0)}x` })).status === 401);
  ok('handler never ran for any refused token', seen.length === 0);

  const broken = withAffiliateAuth(async () => { seen.push('x'); return Response.json({ ok: true }); }, { db: downDb });
  const d1 = await run(broken, req('/api/affiliate/me', { bearer: tok('A', 0) }));
  const d2 = await run(broken, req('/api/affiliate/me', { cookie: cookie(tok('A', 0)), bearer: tok('A', 0) }));
  ok('DB failure → 503 (Bearer), no internal detail, handler not called', d1.status === 503 && !/ECONNREFUSED|10\.9/.test(JSON.stringify(d1.body)) && seen.length === 0);
  ok('DB failure with a cookie → 503, the cookie is NOT cleared (nothing known about it)', d2.status === 503 && noCookie(d2) && seen.length === 0);
}

// ── 2. Stale cookie + Bearer ─────────────────────────────────────────────────
console.log('\n2. Stale cookie + Bearer');
{
  const stale = [
    ['expired', expired('A')],
    ['outdated version', tok('B', 1)],
    ['inactive account', tok('OFF', 0)],
    ['other secret', otherSecret('A')],
    ['wrong type (recruiter)', recruiterTok()],
    ['garbage', 'not-a-jwt'],
  ];
  for (const [label, st] of stale) {
    seen = [];
    const r = await call({ cookie: cookie(st), bearer: tok('A', 0) });
    ok(`stale cookie (${label}) + valid Bearer → 200 as the Bearer affiliate, response clears the cookie`, r.status === 200 && r.body?.id === 'A' && seen.length === 1 && clears(r), r);
  }
  const invalidBearers = [['expired', expired('A')], ['outdated', tok('B', 0)], ['inactive', tok('OFF', 0)], ['recruiter', recruiterTok()], ['admin', adminTok()], ['tampered', `${tok('A', 0)}x`]];
  for (const [label, bt] of invalidBearers) {
    seen = [];
    const r = await call({ cookie: cookie(expired('A')), bearer: bt });
    ok(`stale cookie + invalid Bearer (${label}) → 401, cookie cleared, handler not called`, r.status === 401 && clears(r) && seen.length === 0, r);
  }
  seen = [];
  const pref = await call({ cookie: cookie(tok('B', 2)), bearer: expired('A') });
  ok('valid cookie + invalid Bearer → 200 as the COOKIE affiliate, nothing cleared', pref.status === 200 && pref.body?.id === 'B' && noCookie(pref));
  const both = await call({ cookie: cookie(tok('B', 2)), bearer: tok('A', 0) });
  ok('valid cookie + valid other Bearer → the cookie is still preferred', both.status === 200 && both.body?.id === 'B' && noCookie(both));
  reads = 0;
  await call({ cookie: cookie(tok('B', 2)), bearer: tok('A', 0) });
  ok('a valid cookie is checked alone (one account read, Bearer not consulted)', reads === 1);

  // the handler issues a fresh cookie (password change): it must survive
  const fresh = withAffiliateAuth(async () => {
    const res = Response.json({ ok: true });
    res.headers.set('Set-Cookie', affiliateCookieHeader('NEWTOKEN', 604800));
    return res;
  }, { db });
  const f = await run(fresh, req('/api/affiliate/me', { cookie: cookie(tok('B', 1)), bearer: tok('B', 2) }));
  ok('stale cookie + valid Bearer, handler sets a fresh cookie → only the fresh cookie, not cleared', f.status === 200 && f.setCookies.length === 1 && f.setCookies[0].startsWith('affiliate_token=NEWTOKEN;'), f.setCookies);

  // immutable handler headers (e.g. a fetched / redirect response) → copied, cookie still cleared
  const immut = withAffiliateAuth(async () => Response.redirect('http://localhost/x', 302), { db });
  const im = await run(immut, req('/api/affiliate/me', { cookie: cookie(expired('A')), bearer: tok('A', 0) }));
  ok('immutable handler response → status kept and cookie cleared on a copy', im.status === 302 && clears(im));

  // empty cookie value (after a logout clear) behaves like no cookie
  const emp = await call({ cookie: `${AFFILIATE_COOKIE}=`, bearer: tok('A', 0) });
  ok('empty affiliate_token= cookie + valid Bearer → 200, nothing to clear', emp.status === 200 && noCookie(emp));
}

// ── 3. Handler errors ────────────────────────────────────────────────────────
console.log('\n3. Handler errors');
{
  errors.length = 0;
  const throwing = withAffiliateAuth(async () => { throw Object.assign(new Error('secret detail sk_live_123'), { code: 'P1001' }); }, { db });
  const r = await run(throwing, req('/api/affiliate/avatar', { bearer: tok('A', 0) }));
  ok('a throwing handler → 500 "Erreur serveur" (not 401)', r.status === 500 && r.body?.error === 'Erreur serveur');
  ok('the error is logged with the path + code, without the message', errors.some((e) => e.includes('/api/affiliate/avatar') && e.includes('P1001')) && !errors.some((e) => e.includes('sk_live_123')));
}

// ── 4. Logout ────────────────────────────────────────────────────────────────
console.log('\n4. Logout (DELETE /api/affiliate/auth)');
{
  const prevEnv = process.env.NODE_ENV;
  const r = await authRoute.DELETE(req('/api/affiliate/auth', { method: 'DELETE', cookie: cookie(tok('A', 0)) }));
  ok('DELETE → 200 { ok: true }', r.status === 200 && (await r.json()).ok === true);
  ok('DELETE clears the cookie with the exact attributes (dev)', eq(r.headers.getSetCookie(), [CLEAR_DEV]), r.headers.getSetCookie());
  ok('DELETE is not cached', r.headers.get('cache-control') === 'no-store');
  process.env.NODE_ENV = 'production';
  const p = await authRoute.DELETE(req('/api/affiliate/auth', { method: 'DELETE' }));
  ok('DELETE in production adds ; Secure', eq(p.headers.getSetCookie(), [`${CLEAR_DEV}; Secure`]));
  ok('the setter and the clearer share the same attributes (production)', affiliateCookieHeader('T', 604800) === 'affiliate_token=T; HttpOnly; Path=/api/affiliate; Max-Age=604800; SameSite=Strict; Secure');
  process.env.NODE_ENV = prevEnv;
  ok('the setter (dev) matches the historical login cookie', affiliateCookieHeader('T', 604800) === 'affiliate_token=T; HttpOnly; Path=/api/affiliate; Max-Age=604800; SameSite=Strict');
  ok('DELETE without any cookie still answers 200 + clear', (await authRoute.DELETE(req('/api/affiliate/auth', { method: 'DELETE' }))).status === 200);

  const route = stripJs(read('src/app/api/affiliate/auth/route.js'));
  ok('login POST sets the cookie through affiliateCookieHeader(result.token, COOKIE_MAX_AGE)', /affiliateCookieHeader\(result\.token, COOKIE_MAX_AGE\)/.test(route) && /COOKIE_MAX_AGE = 7 \* 24 \* 60 \* 60/.test(route));
  ok('login still answers 401 for INVALID_CREDENTIALS / INACTIVE only', /err\.code === 'INVALID_CREDENTIALS' \|\| err\.code === 'INACTIVE'\)\s*\{\s*return Response\.json\(\{ error: err\.message \}, \{ status: 401 \}\)/.test(route));

  const logoutCall = /fetch\("\/api\/affiliate\/auth", \{ method: "DELETE", credentials: "same-origin"[^}]*\}\)\.catch\(/;
  const fnBody = (src, start) => { const i = src.indexOf(start); if (i < 0) return ''; const o = src.indexOf('{', src.indexOf('=>', i)); let d = 0; for (let k = o; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } return ''; };
  const dash = fnBody(stripJs(read('src/app/affiliate/dashboard/page.jsx')), 'const handleLogout = (');
  ok('dashboard handleLogout calls DELETE /api/affiliate/auth before clearing localStorage',
    logoutCall.test(dash) && dash.search(logoutCall) < dash.indexOf('localStorage.removeItem') && dash.indexOf('localStorage.removeItem') < dash.indexOf('router.push'));
  const gate = fnBody(stripJs(read('src/components/affiliate/AffiliateNavGate.jsx')), 'const logout = (');
  ok('AffiliateNavGate logout calls DELETE /api/affiliate/auth before clearing localStorage',
    logoutCall.test(gate) && gate.search(logoutCall) < gate.indexOf('localStorage.removeItem') && gate.indexOf('localStorage.removeItem') < gate.indexOf('router.push'));
}

// ── 5. Isolation affiliate ↔ recruiter ───────────────────────────────────────
console.log('\n5. Affiliate / recruiter isolation');
{
  let recCalled = 0;
  const rec = withRecruiterAuth(async () => { recCalled++; return Response.json({ ok: true }); });
  const viaCookie = await rec(req('/api/recruiter/me', { cookie: `recruiter_token=${tok('A', 0)}` }), {});
  const viaBearer = await rec(req('/api/recruiter/me', { bearer: tok('A', 0) }), {});
  ok('an affiliate token is refused by withRecruiterAuth (cookie or Bearer)', viaCookie.status === 401 && viaBearer.status === 401 && recCalled === 0);
  const ownCookie = await rec(req('/api/recruiter/me', { cookie: `recruiter_token=${recruiterTok()}` }), {});
  ok('withRecruiterAuth still accepts its own cookie', ownCookie.status === 200 && recCalled === 1);
  seen = [];
  const r1 = await call({ cookie: `recruiter_token=${recruiterTok()}` });
  ok('a recruiter cookie is not an affiliate session (401)', r1.status === 401 && seen.length === 0);
  const r2 = await call({ cookie: cookie(recruiterTok()), bearer: recruiterTok() });
  ok('recruiter token in BOTH the affiliate cookie and Bearer → 401', r2.status === 401 && seen.length === 0 && clears(r2));
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.error = origError;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
