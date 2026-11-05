/**
 * src/lib/middleware/withAffiliateAuth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Middleware for affiliate-protected API routes.
 *
 * Token resolution order (most secure first):
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
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { verifyToken } from '../services/authService.js';

const tokenVersionOf = (decoded) => (Number.isInteger(decoded?.tv) && decoded.tv >= 0 ? decoded.tv : 0);

export function withAffiliateAuth(handler, opts = {}) {
  const db = opts.db ?? prisma;
  return async function (req, context) {
    try {
      // 1. Prefer HttpOnly cookie (set by /api/affiliate/auth)
      const cookieToken = parseCookieHeader(
        req.headers.get?.('cookie') || '',
        'affiliate_token',
      );

      // 2. Fall back to Authorization: Bearer header (legacy frontend support)
      const authHeader  = req.headers.get('authorization') || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      const token = cookieToken || bearerToken;

      if (!token) {
        return Response.json({ error: 'Token requis' }, { status: 401 });
      }

      const decoded = verifyToken(token);

      if (decoded.type !== 'affiliate' || !decoded.affiliateId) {
        return Response.json({ error: 'Token invalide' }, { status: 401 });
      }

      let account;
      try {
        account = await db.affiliate.findUnique({ where: { id: String(decoded.affiliateId) }, select: { isActive: true, tokenVersion: true } });
      } catch {
        return Response.json({ error: 'Service indisponible' }, { status: 503 });
      }
      const current = Number.isInteger(account?.tokenVersion) ? account.tokenVersion : 0;
      if (!account || account.isActive !== true || tokenVersionOf(decoded) !== current) {
        return Response.json({ error: 'Token expiré ou invalide' }, { status: 401 });
      }

      return handler(req, context, decoded);
    } catch {
      return Response.json({ error: 'Token expiré ou invalide' }, { status: 401 });
    }
  };
}

function parseCookieHeader(cookieStr, name) {
  if (!cookieStr) return null;
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
