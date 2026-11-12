/**
 * scripts/loginThrottleAccounts.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 6 part 2, D5 — per-ACCOUNT failed-login throttle for the affiliate and recruiter logins
 * (docs/recruiter-system.md §8 "Per-account login throttling (D5)"): 5 failures per account per
 * 15-minute fixed window (src/lib/loginThrottle.js, in memory — production runs ONE web instance),
 * checked AND registered before the password comparison, cleared by a correct password, generic
 * 429, independent of the per-IP limiter (D6 trusted proxy).
 *
 * No real database: the affiliate login (which uses the DEFAULT prisma client) gets
 * scripts/lib/rewardsFakeDb.mjs through a module-resolve seam (src/lib/prisma.js → a proxy of
 * `globalThis.__ltPrisma`); the recruiter login runs on scripts/lib/recruiterFakeDb.mjs.
 *
 *   1. Affiliate: limit + window      5. Recruiter: limit, window, isolation, reset, disabled
 *   2. Affiliate: IPs, isolation,     6. Concurrency (affiliate + recruiter)
 *      username/phone, enumeration    7. Independent IP limit
 *   3. Affiliate: reset / inactive    8. Sensitive data, no migration
 *   4. Affiliate route (429 body)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { DEMO_COMP_MIGRATION_DIR, DEMO_COMP_MIGRATION, demoCompPinsHold } from './lib/demoCompetitionAllowance.mjs';
import { DAC_MIGRATION_DIR, DAC_MIGRATION, dacMigrationPinHolds } from './lib/dashboardAdminControlsAllowance.mjs';

process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'login-throttle-test-secret-not-real';
delete process.env.TRUSTED_PROXY_MODE;
delete process.env.TRUSTED_PROXY_SECRET;

const SRC = new URL('../src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  const SRC = ${JSON.stringify(SRC)};
  const FAKE = "data:text/javascript," + encodeURIComponent("export default new Proxy({}, { get: (_t, k) => { const db = globalThis.__ltPrisma; if (!db) throw new Error('no fake prisma installed'); const v = db[k]; return typeof v === 'function' ? v.bind(db) : v; } });");
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
const ASYS = await import('../src/lib/services/affiliateSystemService.js');
const RS = await import('../src/lib/services/recruiterService.js');
const { recruiterHandlers } = await import('../src/lib/recruiterRouteHandlers.js');
const { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS } = await import('../src/lib/loginThrottle.js');
const affAuthRoute = await import('../src/app/api/affiliate/auth/route.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const logged = [];
for (const m of ['log', 'error', 'warn', 'info']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); orig(...a); };
}
const SECRETS = new Set();
const remember = (x) => { if (typeof x === 'string' && x.length >= 6) SECRETS.add(x); return x; };
const RESPONSES = [];

const SECRET = 'q'.repeat(40);
const CF = { TRUSTED_PROXY_MODE: 'cloudflare', TRUSTED_PROXY_SECRET: SECRET };
const setProxyEnv = (on) => {
  if (on) Object.assign(process.env, CF);
  else { delete process.env.TRUSTED_PROXY_MODE; delete process.env.TRUSTED_PROXY_SECRET; }
};
let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };
/** A request that carries the trusted-proxy secret and a DISTINCT trusted client IP each time. */
const trustedReq = (url, body, ip = nextIp()) => new Request(`http://localhost${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, 'x-trusted-proxy-secret': SECRET }, body: JSON.stringify(body),
});
const call = async (handler, r) => {
  const res = await handler(r);
  const text = await res.text();
  RESPONSES.push(text);
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, setCookie: res.headers.get('set-cookie') };
};

// ── fixtures ───────────────────────────────────────────────────────────────────
const PW = remember('Throttle-ok-1');
const HASH = remember(bcrypt.hashSync(PW, 4)); // low cost: only to keep the suite fast
const WRONG = 'Wrong-pass-9';
function affiliateDb() {
  const db = makeRewardsFakeDb({
    affiliate: [
      { id: 'A', username: 'aff.a', name: 'A', phone: '0611111111', password: HASH, isActive: true, tokenVersion: 0, createdAt: new Date('2026-01-01') },
      { id: 'B', username: 'aff.b', name: 'B', phone: '0622222222', password: HASH, isActive: true, tokenVersion: 0, createdAt: new Date('2026-01-01') },
      { id: 'OFF', username: 'aff.off', name: 'Off', phone: '0633333333', password: HASH, isActive: false, tokenVersion: 0, createdAt: new Date('2026-01-01') },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `M${i}`, username: `aff.m${i}`, name: `M${i}`, phone: `07000000${String(i).padStart(2, '0')}`, password: HASH, isActive: true, tokenVersion: 0, createdAt: new Date('2026-01-01') })),
    ],
  });
  globalThis.__ltPrisma = db;
  return db;
}
/** loginAffiliate with an explicit store and clock → { ok, code, msg, token } (never throws). */
const affLogin = async (u, p, store, t) => {
  try { const v = await ASYS.loginAffiliate(u, p, { throttle: store, now: () => t }); remember(v.token); return { ok: true, token: v.token }; }
  catch (e) { return { ok: false, code: e.code, msg: e.message }; }
};
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);

// ── 1. Affiliate: limit + window ──────────────────────────────────────────────
console.log('\n1. Affiliate login: 5 failures per account per 15-minute window');
{
  affiliateDb();
  const store = new Map();
  ok('the shared module limits are the approved ones (5 failures / 15 min)', LOGIN_MAX_FAILURES === 5 && LOGIN_WINDOW_MS === 15 * 60_000);
  const five = [];
  for (let i = 0; i < 5; i++) five.push(await affLogin('aff.a', WRONG, store, T0 + i * 1000));
  ok('5 wrong passwords → 5 × INVALID_CREDENTIALS', five.every((r) => !r.ok && r.code === 'INVALID_CREDENTIALS'), five.map((r) => r.code).join(','));
  const sixth = await affLogin('aff.a', PW, store, T0 + 6000);
  ok('the 6th attempt — even with the CORRECT password — is refused (LOGIN_THROTTLED, generic message, no token)',
    !sixth.ok && sixth.code === 'LOGIN_THROTTLED' && sixth.msg === 'Trop de tentatives. Réessayez plus tard.' && !sixth.token);
  const stillLocked = await affLogin('aff.a', PW, store, T0 + LOGIN_WINDOW_MS - 1);
  ok('still locked 1 ms before the window ends', !stillLocked.ok && stillLocked.code === 'LOGIN_THROTTLED');
  const after = await affLogin('aff.a', PW, store, T0 + LOGIN_WINDOW_MS);
  ok('after the 15-minute window the correct password works (no permanent lockout)', after.ok);
  ok('…and that success cleared the account counter', !store.has('affiliate:A'));
}

// ── 2. Affiliate: rotating IPs, isolation, username/phone, enumeration ────────
console.log('\n2. Affiliate: rotating IPs, account isolation, username/phone, no enumeration');
{
  affiliateDb();
  ASYS.__affiliateLoginThrottleStore.clear();
  // WITHOUT the proxy configuration first: every request of this process shares the "untrusted"
  // IP bucket (10/min) — 6 requests stay under it, so any 429 here is the ACCOUNT limit.
  setProxyEnv(false);
  const spoofed = [];
  for (let i = 0; i < 6; i++) {
    const ip = `203.0.113.${i + 1}`;
    spoofed.push(await call(affAuthRoute.POST, new Request('http://localhost/api/affiliate/auth', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, 'x-forwarded-for': ip }, body: JSON.stringify({ username: 'aff.a', password: WRONG }),
    })));
  }
  ok('no proxy config + rotating spoofed IP headers → 5 × 401, then the ACCOUNT lock (429, the D5 body)',
    spoofed.slice(0, 5).every((r) => r.status === 401) && spoofed[5].status === 429 && eq(spoofed[5].body, { error: 'Trop de tentatives. Réessayez plus tard.', code: 'RATE_LIMITED' }),
    spoofed.map((r) => r.status).join(','));

  // WITH the trusted configuration: a DISTINCT trusted IP per request against ONE account.
  setProxyEnv(true);
  ASYS.__affiliateLoginThrottleStore.clear();
  const rot = [];
  for (let i = 0; i < 6; i++) rot.push(await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'aff.b', password: WRONG })));
  ok('trusted proxy + a DIFFERENT trusted IP per request → still locked after 5 (the account limit is independent of the IP)',
    rot.slice(0, 5).every((r) => r.status === 401) && rot[5].status === 429 && rot[5].body?.code === 'RATE_LIMITED', rot.map((r) => r.status).join(','));
  const bRight = await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'aff.b', password: PW }));
  ok('…and the locked account refuses even its correct password from a fresh IP (429, no cookie, no token)', bRight.status === 429 && !bRight.setCookie && !('token' in (bRight.body || {})));

  // account isolation (service level, explicit store)
  const store = new Map();
  for (let i = 0; i < 5; i++) await affLogin('aff.a', WRONG, store, T0);
  const aLocked = await affLogin('aff.a', PW, store, T0);
  const bOk = await affLogin('aff.b', PW, store, T0);
  const bWrong = await affLogin('aff.b', WRONG, store, T0);
  ok('account A locked → account B is unaffected (its correct password works; a wrong one is a plain INVALID_CREDENTIALS)',
    !aLocked.ok && aLocked.code === 'LOGIN_THROTTLED' && bOk.ok && bWrong.code === 'INVALID_CREDENTIALS');
  const store2 = new Map();
  for (let i = 0; i < 5; i++) await affLogin('aff.b', WRONG, store2, T0);
  const bLocked = await affLogin('aff.b', PW, store2, T0);
  const aOk = await affLogin('aff.a', PW, store2, T0);
  ok('…and the reverse: B locked, A unaffected', !bLocked.ok && bLocked.code === 'LOGIN_THROTTLED' && aOk.ok);

  // username vs phone: ONE counter per account
  const store3 = new Map();
  const mixed = [];
  for (let i = 0; i < 3; i++) mixed.push(await affLogin('aff.a', WRONG, store3, T0));
  for (let i = 0; i < 2; i++) mixed.push(await affLogin('0611111111', WRONG, store3, T0));
  const byPhone = await affLogin('0611111111', PW, store3, T0);
  const byName = await affLogin('AFF.A ', PW, store3, T0);
  ok('the same account by username (3 failures) and by phone (2 failures) shares ONE counter → locked whichever identifier is used',
    mixed.every((r) => r.code === 'INVALID_CREDENTIALS') && byPhone.code === 'LOGIN_THROTTLED' && byName.code === 'LOGIN_THROTTLED' && store3.size === 1 && store3.has('affiliate:A'));

  // unknown identifiers lock too; identical answers (route level, trusted IPs)
  ASYS.__affiliateLoginThrottleStore.clear();
  const unkWrong = await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'nobody.here', password: WRONG }));
  const realWrong = await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'aff.m0', password: WRONG }));
  ok('before any lock: an unknown identifier and an existing account with a wrong password → byte-identical 401 bodies',
    unkWrong.status === 401 && realWrong.status === 401 && unkWrong.text === realWrong.text);
  for (let i = 0; i < 4; i++) {
    await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'nobody.here', password: WRONG }));
    await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'aff.m0', password: WRONG }));
  }
  const unkLocked = await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'nobody.here', password: WRONG }));
  const realLocked = await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'aff.m0', password: PW }));
  ok('an UNKNOWN identifier locks after 5 failures too, and its locked response is byte-identical to an existing account\'s (no enumeration)',
    unkLocked.status === 429 && realLocked.status === 429 && unkLocked.text === realLocked.text,
    `${unkLocked.status} ${unkLocked.text} | ${realLocked.status} ${realLocked.text}`);
  ok('the unknown identifier is keyed by its normalized form (affiliate-id:…), the real account by its id',
    ASYS.__affiliateLoginThrottleStore.has('affiliate-id:nobody.here') && ASYS.__affiliateLoginThrottleStore.has('affiliate:M0'));
  setProxyEnv(false);
}

// ── 3. Affiliate: reset and inactive account ─────────────────────────────────
console.log('\n3. Affiliate: a successful login resets the counter (also for an inactive account)');
{
  affiliateDb();
  const store = new Map();
  for (let i = 0; i < 4; i++) await affLogin('aff.a', WRONG, store, T0);
  const good = await affLogin('aff.a', PW, store, T0);
  const again = [];
  for (let i = 0; i < 5; i++) again.push(await affLogin('aff.a', WRONG, store, T0));
  const locked = await affLogin('aff.a', WRONG, store, T0);
  ok('4 failures, then a success (counter cleared), then 5 more failures are allowed before the lock',
    good.ok && again.every((r) => r.code === 'INVALID_CREDENTIALS') && locked.code === 'LOGIN_THROTTLED', again.map((r) => r.code).join(','));
  const s2 = new Map();
  for (let i = 0; i < 4; i++) await affLogin('aff.off', WRONG, s2, T0);
  const inactiveRight = await affLogin('aff.off', PW, s2, T0);
  ok('an INACTIVE account with the correct password → still INACTIVE (no token), but the counter is cleared',
    !inactiveRight.ok && inactiveRight.code === 'INACTIVE' && !s2.has('affiliate:OFF'));
  const after = [];
  for (let i = 0; i < 5; i++) after.push(await affLogin('aff.off', WRONG, s2, T0));
  ok('…so 5 more failures are allowed for it before the lock', after.every((r) => r.code === 'INVALID_CREDENTIALS') && (await affLogin('aff.off', PW, s2, T0)).code === 'LOGIN_THROTTLED');
}

// ── 4. Affiliate route: the locked answer ─────────────────────────────────────
console.log('\n4. Affiliate route: generic 429');
{
  const route = read('src/app/api/affiliate/auth/route.js');
  ok('the route maps LOGIN_THROTTLED to a fixed body (never err.message) with status 429',
    /err\.code === 'LOGIN_THROTTLED'\)\s*\{\s*return Response\.json\(\{ error: 'Trop de tentatives\. Réessayez plus tard\.', code: 'RATE_LIMITED' \}, \{ status: 429 \}\)/.test(route));
}

// ── 5. Recruiter login ────────────────────────────────────────────────────────
console.log('\n5. Recruiter login: limit, window, isolation, reset, disabled');
const RHASH = remember(bcrypt.hashSync(PW, 4));
function recruiterDb() {
  const db = makeRecruiterFakeDb();
  db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A', passwordHash: RHASH });
  db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B', passwordHash: RHASH });
  db._seed.recruiter({ username: 'rec.off', name: 'Recruteur Off', passwordHash: RHASH, isActive: false, disabledAt: new Date(), disabledBy: 'admin-1' });
  return db;
}
const recLogin = async (db, u, p, store, t) => {
  try { const v = await RS.loginRecruiter(u, p, { db, now: new Date(t), throttle: store }); remember(v.token); return { ok: true }; }
  catch (e) { return { ok: false, code: e.code }; }
};
{
  const db = recruiterDb();
  const store = new Map();
  const five = [];
  for (let i = 0; i < 5; i++) five.push(await recLogin(db, 'rec.a', WRONG, store, T0));
  const sixth = await recLogin(db, 'rec.a', PW, store, T0);
  ok('5 wrong passwords → INVALID_CREDENTIALS; the 6th — even correct — → RATE_LIMITED',
    five.every((r) => r.code === 'INVALID_CREDENTIALS') && sixth.code === 'RATE_LIMITED');
  ok('after the 15-minute window the correct password works', (await recLogin(db, 'rec.a', PW, store, T0 + LOGIN_WINDOW_MS)).ok && !store.has('recruiter:rec.a'));
  ok('the username is normalized (" REC.A " shares the counter of "rec.a")',
    await (async () => { const s = new Map(); for (let i = 0; i < 5; i++) await recLogin(db, ' REC.A ', WRONG, s, T0); return (await recLogin(db, 'rec.a', PW, s, T0)).code === 'RATE_LIMITED'; })());
  const iso = new Map();
  for (let i = 0; i < 5; i++) await recLogin(db, 'rec.a', WRONG, iso, T0);
  ok('recruiter A locked → recruiter B unaffected, and the reverse', (await recLogin(db, 'rec.a', PW, iso, T0)).code === 'RATE_LIMITED' && (await recLogin(db, 'rec.b', PW, iso, T0)).ok
    && await (async () => { const s = new Map(); for (let i = 0; i < 5; i++) await recLogin(db, 'rec.b', WRONG, s, T0); return (await recLogin(db, 'rec.b', PW, s, T0)).code === 'RATE_LIMITED' && (await recLogin(db, 'rec.a', PW, s, T0)).ok; })());
  const reset = new Map();
  for (let i = 0; i < 4; i++) await recLogin(db, 'rec.a', WRONG, reset, T0);
  const good = await recLogin(db, 'rec.a', PW, reset, T0);
  const more = [];
  for (let i = 0; i < 5; i++) more.push(await recLogin(db, 'rec.a', WRONG, reset, T0));
  ok('4 failures, a success (cleared), then 5 more failures allowed, the 6th locked',
    good.ok && more.every((r) => r.code === 'INVALID_CREDENTIALS') && (await recLogin(db, 'rec.a', WRONG, reset, T0)).code === 'RATE_LIMITED');
  const off = new Map();
  for (let i = 0; i < 4; i++) await recLogin(db, 'rec.off', WRONG, off, T0);
  const offRight = await recLogin(db, 'rec.off', PW, off, T0);
  ok('a DISABLED recruiter with the correct password → RECRUITER_DISABLED, and its counter is cleared', offRight.code === 'RECRUITER_DISABLED' && !off.has('recruiter:rec.off'));
  // unknown username locks the same way, through the real handler (identical bodies)
  RS.__recruiterLoginThrottleStore.clear();
  const h = recruiterHandlers({ db, rateLimit: () => null });
  const post = (body) => call(h.login, new Request('http://localhost/api/recruiter/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const uW = await post({ username: 'nobody.rec', password: WRONG });
  const rW = await post({ username: 'rec.b', password: WRONG });
  ok('handler, before the lock: unknown username vs wrong password → byte-identical 401 bodies', uW.status === 401 && rW.status === 401 && uW.text === rW.text);
  for (let i = 0; i < 4; i++) { await post({ username: 'nobody.rec', password: WRONG }); await post({ username: 'rec.b', password: WRONG }); }
  const uL = await post({ username: 'nobody.rec', password: WRONG });
  const rL = await post({ username: 'rec.b', password: PW });
  ok('handler: an unknown username locks after 5 too; both locked answers are byte-identical 429 { code: RATE_LIMITED } (no cookie)',
    uL.status === 429 && rL.status === 429 && uL.text === rL.text && eq(rL.body, { code: 'RATE_LIMITED' }) && !rL.setCookie);
  // rotating trusted IPs through the handler's REAL (trusted) IP limiter
  setProxyEnv(true);
  RS.__recruiterLoginThrottleStore.clear();
  const hReal = recruiterHandlers({ db });
  const rot = [];
  for (let i = 0; i < 6; i++) rot.push(await call(hReal.login, trustedReq('/api/recruiter/auth', { username: 'rec.a', password: i < 5 ? WRONG : PW })));
  ok('handler with the REAL trusted IP limiter and a DIFFERENT trusted IP per request → 5 × 401, then 429 even with the correct password',
    rot.slice(0, 5).every((r) => r.status === 401) && rot[5].status === 429, rot.map((r) => r.status).join(','));
  setProxyEnv(false);
}

// ── 6. Concurrency ───────────────────────────────────────────────────────────
console.log('\n6. Concurrency: parallel attempts cannot bypass the limit');
{
  affiliateDb();
  const store = new Map();
  const par = await Promise.all(Array.from({ length: 20 }, () => affLogin('aff.a', WRONG, store, T0)));
  const inv = par.filter((r) => r.code === 'INVALID_CREDENTIALS').length;
  const thr = par.filter((r) => r.code === 'LOGIN_THROTTLED').length;
  ok('affiliate: 20 parallel wrong attempts → exactly 5 password comparisons (5 × INVALID_CREDENTIALS) and 15 throttled', inv === 5 && thr === 15, `${inv}/${thr}`);
  const right = await Promise.all(Array.from({ length: 20 }, () => affLogin('aff.a', PW, store, T0)));
  ok('affiliate: then 20 parallel CORRECT-password attempts → all throttled (no bypass, no token)', right.every((r) => !r.ok && r.code === 'LOGIN_THROTTLED'));
  const s2 = new Map();
  const mixed = await Promise.all(Array.from({ length: 20 }, (_, i) => affLogin(i % 2 ? '0611111111' : 'aff.a', WRONG, s2, T0)));
  ok('affiliate: 20 parallel attempts alternating username / phone → still exactly 5 evaluated (one counter)',
    mixed.filter((r) => r.code === 'INVALID_CREDENTIALS').length === 5 && mixed.filter((r) => r.code === 'LOGIN_THROTTLED').length === 15);

  const db = recruiterDb();
  const rs = new Map();
  const rpar = await Promise.all(Array.from({ length: 20 }, () => recLogin(db, 'rec.a', WRONG, rs, T0)));
  ok('recruiter: 20 parallel wrong attempts → exactly 5 evaluated, 15 throttled',
    rpar.filter((r) => r.code === 'INVALID_CREDENTIALS').length === 5 && rpar.filter((r) => r.code === 'RATE_LIMITED').length === 15);
  const rright = await Promise.all(Array.from({ length: 20 }, () => recLogin(db, 'rec.a', PW, rs, T0)));
  ok('recruiter: then 20 parallel CORRECT attempts → all throttled', rright.every((r) => !r.ok && r.code === 'RATE_LIMITED'));
  const before = db._tables.recruiter.find((r) => r.username === 'rec.a').lastLoginAt;
  ok('…and no login side effect happened (lastLoginAt untouched)', before === null);
}

// ── 7. Independent IP limit ───────────────────────────────────────────────────
console.log('\n7. The per-IP limit is independent of the account limit');
{
  affiliateDb();
  setProxyEnv(true);
  ASYS.__affiliateLoginThrottleStore.clear();
  const ip = nextIp();
  const res = [];
  for (let i = 0; i < 11; i++) res.push(await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: `aff.m${i + 1}`, password: WRONG }, ip)));
  ok('11 attempts from ONE trusted IP across 11 DIFFERENT accounts → 10 × 401, the 11th IP-limited (the IP limiter body), no account locked',
    res.slice(0, 10).every((r) => r.status === 401) && res[10].status === 429 && /Too many requests/.test(res[10].text)
    && [...ASYS.__affiliateLoginThrottleStore.values()].every((e) => e.count < LOGIN_MAX_FAILURES), res.map((r) => r.status).join(','));
  const other = await call(affAuthRoute.POST, trustedReq('/api/affiliate/auth', { username: 'aff.m11', password: PW }));
  ok('…while another trusted IP can still log in to one of those accounts (no account lock was created)', other.status === 200);
  remember(other.body?.token);
  setProxyEnv(false);
}

// ── 8. Sensitive data, no migration ──────────────────────────────────────────
console.log('\n8. Sensitive data, no migration');
{
  const isJwt = (s) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
  const throttled = RESPONSES.filter((t) => /Trop de tentatives|RATE_LIMITED|Too many requests/.test(t));
  ok('throttled responses contain no password, hash or token', throttled.length > 0 && throttled.every((t) => ![...SECRETS].some((s) => t.includes(s)) && !/"token"|\$2[aby]\$/.test(t)));
  ok('no password or hash in any response body (tokens only in the successful logins)', RESPONSES.every((t) => ![...SECRETS].filter((s) => !isJwt(s)).some((s) => t.includes(s))));
  ok('no password, hash or token in any captured log line', logged.every((l) => ![...SECRETS].some((s) => l.includes(s)) && !l.includes(WRONG)));
  const migrations = readdirSync(join(ROOT, 'prisma/migrations')).filter((d) => /^\d/.test(d)).sort();
  const prismaText = read('prisma/schema.prisma') + migrations.map((d) => { try { return read(`prisma/migrations/${d}/migration.sql`); } catch { return ''; } }).join('\n');
  // The only migration after 20261109 is the Phase 6 part 3a reward-cycles migration (recruiter_reward_ledger only).
  // Demo Competition (simulation only): + exactly 20261113_demo_competition (demo_comp_* tables only, SHA-256 pinned in
  // scripts/lib/demoCompetitionAllowance.mjs). It is excluded from the exact list below and checked separately.
  // Affiliate Dashboard & Admin Controls: + exactly 20261114_payment_proof_display_controls (payment_proofs /
  // payment_proof_events only, SHA-256 pinned in scripts/lib/dashboardAdminControlsAllowance.mjs), checked separately below.
  const after = migrations.slice(migrations.indexOf('20261109_account_token_version') + 1).filter((d) => d !== DEMO_COMP_MIGRATION_DIR && d !== DAC_MIGRATION_DIR);
  // Phase 7: + 20261112_recruiter_group_rewards (recruiter group reward: settings columns + ledger guards only).
  ok('no database migration for D5: 20261109_account_token_version is followed only by 20261110_recruiter_reward_cycles (Phase 6 part 3a, ledger only), 20261111_recruiter_identity_verifications (Phase 6 part 3c, recruiter KYC only) and 20261112_recruiter_group_rewards (Phase 7, group reward only), and nothing in prisma/ stores login attempts',
    migrations.includes('20261109_account_token_version') && JSON.stringify(after) === JSON.stringify(['20261110_recruiter_reward_cycles', '20261111_recruiter_identity_verifications', '20261112_recruiter_group_rewards'])
    && !/login|throttle|attempt/i.test(read('prisma/migrations/20261110_recruiter_reward_cycles/migration.sql'))
    && !/login|throttle|attempt/i.test(read('prisma/migrations/20261111_recruiter_identity_verifications/migration.sql'))
    && !/login|throttle|attempt/i.test(read('prisma/migrations/20261112_recruiter_group_rewards/migration.sql'))
    && !/loginThrottle|login_failures|loginFailure|LoginAttempt|login_attempts|lockedUntil/i.test(prismaText), JSON.stringify(after));
  {
    const pins = demoCompPinsHold();
    ok('Demo Competition migration: the only other addition, pinned, and it stores no login attempts',
      pins.schema && pins.migration && !/login|throttle|attempt/i.test(read(DEMO_COMP_MIGRATION)), pins);
  }
  ok('Dashboard & Admin Controls migration: pinned, payment-proof tables only, and it stores no login attempts',
    dacMigrationPinHolds() && !/login|throttle|attempt/i.test(read(DAC_MIGRATION))
    && [...read(DAC_MIGRATION).replace(/--[^\n]*/g, '').matchAll(/(?:ALTER TABLE|ON|INDEX IF NOT EXISTS "\w+" ON) "(\w+)"/g)].every((m) => /^payment_proof/.test(m[1]) || /_idx$|_key$/.test(m[1])));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
