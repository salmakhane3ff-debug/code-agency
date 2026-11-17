/**
 * POST   /api/affiliate/auth  Affiliate login — username + password.
 * DELETE /api/affiliate/auth  Logout — clears the HttpOnly `affiliate_token` cookie (always 200,
 *                              no session needed: the dashboard and the nav gate call it before
 *                              clearing localStorage, so the old cookie stops authenticating).
 *
 * Security:
 *   - Rate limited (10 req/min per IP)
 *   - Returns JWT in BOTH:
 *       1. HttpOnly Secure SameSite=Strict cookie (preferred — XSS-resistant)
 *       2. Response body token field (backward compat for existing frontend)
 *   - Frontend should migrate to cookie-only; localStorage storage is insecure
 */

import { loginAffiliate } from '@/lib/services/affiliateSystemService';
// Phase 6 part 2: keyed on the TRUSTED client IP only (src/lib/trustedProxy.js).
import { trustedRateLimit as rateLimit } from '@/lib/trustedProxy';
import { affiliateCookieHeader } from '@/lib/middleware/withAffiliateAuth';

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export async function POST(req) {
  const limited = rateLimit(req, 'affiliate-auth', { max: 10, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { username, password } = await req.json();

    if (!username?.trim() || !password) {
      return Response.json({ error: 'Identifiant et mot de passe requis' }, { status: 400 });
    }

    const result = await loginAffiliate(username, password);

    // Set HttpOnly cookie (XSS-proof) in addition to returning token in body
    // (affiliate_token=…; HttpOnly; Path=/api/affiliate; Max-Age=…; SameSite=Strict[; Secure in production])
    const response = Response.json(result);
    response.headers.set('Set-Cookie', affiliateCookieHeader(result.token, COOKIE_MAX_AGE));

    return response;
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS' || err.code === 'INACTIVE') {
      return Response.json({ error: err.message }, { status: 401 });
    }
    // Phase 6 part 2 (D5): per-account throttle — the same answer for every account / identifier.
    if (err.code === 'LOGIN_THROTTLED') {
      return Response.json({ error: 'Trop de tentatives. Réessayez plus tard.', code: 'RATE_LIMITED' }, { status: 429 });
    }
    console.error('Affiliate auth error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

/** Logout: clears the session cookie with the same attributes as the setter above. */
export async function DELETE() {
  return Response.json({ ok: true }, {
    status: 200,
    headers: { 'Set-Cookie': affiliateCookieHeader('', 0), 'Cache-Control': 'no-store' },
  });
}
