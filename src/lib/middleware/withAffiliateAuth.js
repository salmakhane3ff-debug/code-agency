/**
 * src/lib/middleware/withAffiliateAuth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Middleware for affiliate-protected API routes.
 *
 * Token sources:
 *   1. HttpOnly cookie: `affiliate_token`  ← preferred (XSS-resistant)
 *   2. Authorization: Bearer <token>       ← backward-compat for existing frontend
 *
 * Token payload must contain: { affiliateId, username, type: 'affiliate' }
 *
 * Session check (Phase 6 part 2), on EVERY request after the signature check: the affiliate
 * must exist, be ACTIVE, and the token's version ("tv"; none = 0) must equal the account's
 * tokenVersion. Disabling an account, re-enabling it, a password change or an admin reset
 * bumps the version, so every older token is refused at once. One primary-key read per
 * request; a database failure answers 503 (never a silent pass, never a forced logout).
 * `opts.db` is injectable for tests.
 *
 * Stale cookie: when the cookie is present but REFUSED (bad signature, expired, wrong type,
 * unknown / inactive account, outdated version) and a Bearer token is also sent, the Bearer
 * token is checked with exactly the same full checks and used only if it passes. Whenever the
 * cookie was refused, the response (401 or the handler's) clears it (Max-Age=0, same
 * attributes as the login setter) unless the handler itself issued a fresh cookie. The cookie
 * still wins when it is valid; a valid cookie is never replaced by the Bearer token.
 *
 * A handler that throws answers 500, not 401: a server error must never look like an
 * expired session to the client (the dashboard logs out on 401).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { verifyToken } from '../services/authService.js';

export const AFFILIATE_COOKIE = 'affiliate_token';

/** The affiliate session cookie (login sets it; logout / a refused cookie clear it with maxAge 0). */
export function affiliateCookieHeader(value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${AFFILIATE_COOKIE}=${value}; HttpOnly; Path=/api/affiliate; Max-Age=${maxAge}; SameSite=Strict${secure}`;
}

const tokenVersionOf = (decoded) => (Number.isInteger(decoded?.tv) && decoded.tv >= 0 ? decoded.tv : 0);

/**
 * Full check of ONE token: signature + expiry, type 'affiliate', account exists, is active and
 * the token version matches. → { decoded } | { status, error }. Never throws.
 */
async function checkAffiliateToken(token, db) {
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return { status: 401, error: 'Token expiré ou invalide' };
  }
  if (decoded?.type !== 'affiliate' || !decoded.affiliateId) {
    return { status: 401, error: 'Token invalide' };
  }
  let account;
  try {
    account = await db.affiliate.findUnique({ where: { id: String(decoded.affiliateId) }, select: { isActive: true, tokenVersion: true } });
  } catch {
    return { status: 503, error: 'Service indisponible' };
  }
  const current = Number.isInteger(account?.tokenVersion) ? account.tokenVersion : 0;
  if (!account || account.isActive !== true || tokenVersionOf(decoded) !== current) {
    return { status: 401, error: 'Token expiré ou invalide' };
  }
  return { decoded };
}

const setsAffiliateCookie = (res) => {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  return all.some((c) => c.trimStart().startsWith(`${AFFILIATE_COOKIE}=`));
};

/** Appends the cookie-clearing header (copying the response when its headers are immutable). */
function clearStaleCookie(res) {
  if (!(res instanceof Response)) return res;
  if (setsAffiliateCookie(res)) return res; // the handler issued a fresh cookie: keep it
  const clear = affiliateCookieHeader('', 0);
  try {
    res.headers.append('Set-Cookie', clear);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', clear);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

export function withAffiliateAuth(handler, opts = {}) {
  const db = opts.db ?? prisma;
  return async function (req, context) {
    let cookieToken = null;
    let bearerToken = null;
    try {
      cookieToken = parseCookieHeader(req.headers.get?.('cookie') || '', AFFILIATE_COOKIE);
      const authHeader = req.headers.get?.('authorization') || '';
      bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() || null : null;
    } catch {
      return Response.json({ error: 'Token expiré ou invalide' }, { status: 401 });
    }

    if (!cookieToken && !bearerToken) {
      return Response.json({ error: 'Token requis' }, { status: 401 });
    }

    let cookieRefused = false;
    let result;
    if (cookieToken) {
      result = await checkAffiliateToken(cookieToken, db);
      // 503: the database is unavailable; nothing is known about the cookie, keep it.
      if (result.status === 401) {
        cookieRefused = true;
        if (bearerToken) result = await checkAffiliateToken(bearerToken, db);
      }
    } else {
      result = await checkAffiliateToken(bearerToken, db);
    }

    if (!result.decoded) {
      const res = Response.json({ error: result.error }, { status: result.status });
      return cookieRefused ? clearStaleCookie(res) : res;
    }

    let res;
    try {
      res = await handler(req, context, result.decoded);
    } catch (err) {
      let path = '';
      try { path = new URL(req.url).pathname; } catch {}
      console.error('Affiliate route error:', path, err?.name || 'Error', err?.code || '');
      res = Response.json({ error: 'Erreur serveur' }, { status: 500 });
    }
    return cookieRefused ? clearStaleCookie(res) : res;
  };
}

function parseCookieHeader(cookieStr, name) {
  if (!cookieStr) return null;
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
