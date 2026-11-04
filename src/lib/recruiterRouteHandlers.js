/**
 * src/lib/recruiterRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the Affiliate Recruiter System, Phase 2 (accounts + login).
 * The route files only wrap them with withAdminAuth / withRecruiterAuth; tests
 * inject a fake db, clock and rate limiter.
 *
 *   Admin (withAdminAuth, role ADMIN): list, create, enable / disable recruiters.
 *   Recruiter: login (sets the HttpOnly cookie recruiter_token, Path=/api/recruiter),
 *     logout (clears it), me (own profile; refused when disabled).
 * Recruiter responses are built ONLY with recruiterVisibility.js (profile view and
 * error codes) — never raw rows, never error messages.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import {
  adminCreateRecruiter, adminListRecruiters, adminSetRecruiterActive, loginRecruiter,
  recordRecruiterLogout, requireActiveRecruiter,
} from './services/recruiterService.js';
import { toRecruiterError as defaultToRecruiterError } from './recruiterVisibility.js';
import { toRecruiterProfileView } from './recruiterProfileView.js';
import { RECRUITER_COOKIE, readRecruiterToken } from './middleware/withRecruiterAuth.js';

export const RECRUITER_COOKIE_MAX_AGE = 7 * 24 * 3600; // = JWT lifetime (authService: 7d)

const noStore = { 'Cache-Control': 'no-store' };
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...noStore, ...headers } });

function cookieHeader(value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${RECRUITER_COOKIE}=${value}; HttpOnly; Path=/api/recruiter; Max-Age=${maxAge}; SameSite=Strict${secure}`;
}

const RECRUITER_STATUS = {
  UNAUTHORIZED: 401, INVALID_CREDENTIALS: 401, RECRUITER_DISABLED: 403, FORBIDDEN: 403, NOT_FOUND: 404,
  INVALID_INPUT: 400, RATE_LIMITED: 429,
};
/** Recruiter-facing error: { code } only (allowlisted by toRecruiterError). */
function recruiterErrorResponse(e, toRecruiterError = defaultToRecruiterError) {
  const { code } = toRecruiterError(e);
  if (code === 'SERVER_ERROR') console.error('[recruiter]', e?.code ?? e);
  return json({ code }, RECRUITER_STATUS[code] ?? 500);
}

const ADMIN_ERRORS = {
  INVALID_INPUT: [400, 'Données invalides.'],
  USERNAME_TAKEN: [409, "Ce nom d'utilisateur est déjà utilisé."],
  PHONE_TAKEN: [409, 'Ce numéro de téléphone est déjà utilisé.'],
  NOT_FOUND: [404, 'Recruteur introuvable.'],
  UNAUTHORIZED: [401, 'Non autorisé.'],
};
/** Admin-facing error: fixed French text per code (never an internal message). */
function adminErrorResponse(e) {
  const known = ADMIN_ERRORS[e?.code];
  if (!known) {
    console.error('[admin recruiters]', e?.code ?? e);
    return json({ code: 'SERVER_ERROR', error: 'Erreur serveur.' }, 500);
  }
  return json({ code: e.code, error: known[1], ...(e.errors ? { errors: e.errors } : {}) }, known[0]);
}

async function readJson(req) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
  return body;
}
const param = async (ctx, name) => (await ctx?.params)?.[name];
const actorOf = (user) => (user?.userId ? String(user.userId) : user?.email ? String(user.email) : null);

export function adminRecruiterHandlers(deps = {}) {
  const { db = prisma, now = () => new Date() } = deps;
  const safe = (fn) => async (req, ctx, user) => { try { return await fn(req, ctx, user); } catch (e) { return adminErrorResponse(e); } };
  return {
    /** GET → every recruiter (no password hash). */
    list: safe(async () => json({ recruiters: await adminListRecruiters({ db }) })),
    /** POST { username, name, password, phone? } → the created recruiter. */
    create: safe(async (req, _ctx, user) => json({ recruiter: await adminCreateRecruiter(await readJson(req), { db, actorId: actorOf(user), now: now() }) }, 201)),
    /** PATCH { action: 'enable' | 'disable', reason? } */
    setActive: safe(async (req, ctx, user) => {
      const body = await readJson(req);
      if (body.action !== 'enable' && body.action !== 'disable') throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
      return json(await adminSetRecruiterActive(await param(ctx, 'id'), body.action === 'enable', { db, actorId: actorOf(user), reason: body.reason ?? null, now: now() }));
    }),
  };
}

export function recruiterHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError } = deps;
  const safe = (fn) => async (req, ctx, decoded) => { try { return await fn(req, ctx, decoded); } catch (e) { return recruiterErrorResponse(e, toRecruiterError); } };
  return {
    /** POST { username, password } → sets the cookie; body = own profile only (no token). */
    login: safe(async (req) => {
      if (rateLimit(req, 'recruiter-auth', { max: 10, windowMs: 60_000 })) return json({ code: 'RATE_LIMITED' }, 429);
      const body = await readJson(req);
      const { token, recruiter } = await loginRecruiter(body.username, body.password, { db, now: now() });
      return json({ recruiter: toRecruiterProfileView(recruiter) }, 200, { 'Set-Cookie': cookieHeader(token, RECRUITER_COOKIE_MAX_AGE) });
    }),
    /** DELETE → clears the cookie (always 200); audited when the token is valid. */
    logout: safe(async (req) => {
      const decoded = readRecruiterToken(req);
      if (decoded) await recordRecruiterLogout(decoded.recruiterId, { db, now: now() }).catch(() => false);
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
    }),
    /** GET (withRecruiterAuth) → own profile; disabled → 403 RECRUITER_DISABLED (cookie cleared). */
    me: async (req, ctx, decoded) => {
      try {
        const row = await requireActiveRecruiter(decoded, { db });
        return json({ recruiter: toRecruiterProfileView(row) });
      } catch (e) {
        const res = recruiterErrorResponse(e, toRecruiterError);
        if (res.status === 401 || res.status === 403) res.headers.set('Set-Cookie', cookieHeader('', 0));
        return res;
      }
    },
  };
}
