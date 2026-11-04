/**
 * src/lib/middleware/withRecruiterAuth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Middleware for recruiter-protected API routes (Affiliate Recruiter System).
 *
 *   • Token source: ONLY the HttpOnly cookie `recruiter_token` (Path=/api/recruiter,
 *     SameSite=Strict, Secure in production). No Authorization header fallback.
 *   • Token payload must be { recruiterId, username, type: 'recruiter' }.
 *     An admin token (role ADMIN, no type) or an affiliate token (type 'affiliate')
 *     is refused here; conversely a recruiter token has no `role`, so withAdminAuth
 *     refuses it, and its type is not 'affiliate', so withAffiliateAuth refuses it.
 *   • Account state (active / disabled) is checked per request by the handlers
 *     (recruiterRouteHandlers → requireActiveRecruiter), so a disabled recruiter is
 *     refused immediately, even with an unexpired token.
 *   • Errors are codes only ({ code }), never messages.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { verifyToken } from '../services/authService.js';

export const RECRUITER_COOKIE = 'recruiter_token';

function readCookie(cookieStr, name) {
  if (!cookieStr) return null;
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const unauthorized = () => Response.json({ code: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });

/** The decoded recruiter token of a request, or null. Never throws. */
export function readRecruiterToken(req) {
  try {
    const token = readCookie(req.headers.get?.('cookie') || '', RECRUITER_COOKIE);
    if (!token) return null;
    const decoded = verifyToken(token);
    if (decoded?.type !== 'recruiter' || typeof decoded.recruiterId !== 'string' || !decoded.recruiterId) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function withRecruiterAuth(handler) {
  return async function (req, context) {
    const decoded = readRecruiterToken(req);
    if (!decoded) return unauthorized();
    return handler(req, context, decoded);
  };
}
