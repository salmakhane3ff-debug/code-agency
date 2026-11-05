/**
 * src/lib/trustedProxy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Client IP for SECURITY rate limits (Phase 6 part 2), trusting proxy headers ONLY under an
 * explicit configuration. Next.js route handlers do not expose the socket peer address, so
 * the app cannot check by source IP that a request came through the proxy: the trust must be
 * configured.
 *
 *   TRUSTED_PROXY_MODE=cloudflare  → `cf-connecting-ip` is trusted ONLY when the request also
 *       carries the header `x-trusted-proxy-secret` equal to TRUSTED_PROXY_SECRET (≥ 32 chars;
 *       timing-safe compare). Without a valid secret configuration, nothing is trusted.
 *   TRUSTED_PROXY_MODE=proxy       → the LAST `x-forwarded-for` hop (the one the reverse proxy
 *       appends; Nginx must overwrite / append it). If TRUSTED_PROXY_SECRET is set, the secret
 *       header is required as well (recommended when the origin is reachable directly).
 *   unset / anything else          → NO header is trusted (fail safe).
 *
 * When no trusted IP exists, callers get null and the security limiters use ONE shared bucket
 * per route ("untrusted"): limits stay strict but are shared by all clients. Applied only to
 * the recruiter / affiliate / activation login and password routes — every other limiter of
 * the app still uses src/lib/rateLimit.js unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { timingSafeEqual } from 'node:crypto';
import { rateLimitStoreKey } from './rateLimit.js';

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
export const TRUSTED_PROXY_SECRET_HEADER = 'x-trusted-proxy-secret';
export const UNTRUSTED_BUCKET = 'untrusted';

const header = (req, name) => {
  try { const v = req?.headers?.get?.(name); return typeof v === 'string' ? v.trim() : ''; } catch { return ''; }
};
const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
const validSecret = (s) => typeof s === 'string' && s.length >= 32;

/** The proxy configuration from the environment (invalid → mode 'none'). */
export function trustedProxyConfig(env = process.env) {
  const mode = String(env?.TRUSTED_PROXY_MODE ?? '').trim().toLowerCase();
  const secret = env?.TRUSTED_PROXY_SECRET;
  if (mode === 'cloudflare') return validSecret(secret) ? { mode, secret } : { mode: 'none', reason: 'CLOUDFLARE_WITHOUT_VALID_SECRET' };
  if (mode === 'proxy') {
    if (secret === undefined || secret === '') return { mode, secret: null };
    return validSecret(secret) ? { mode, secret } : { mode: 'none', reason: 'PROXY_WITH_INVALID_SECRET' };
  }
  return { mode: 'none', reason: mode ? 'UNKNOWN_MODE' : 'NOT_CONFIGURED' };
}

/** The client IP if — and only if — the configured proxy vouches for it; otherwise null. */
export function trustedClientIp(req, env = process.env) {
  const cfg = trustedProxyConfig(env);
  if (cfg.mode === 'none') return null;
  if (cfg.secret && !sameSecret(header(req, TRUSTED_PROXY_SECRET_HEADER), cfg.secret)) return null;
  if (cfg.mode === 'cloudflare') {
    const ip = header(req, 'cf-connecting-ip');
    return IP_RE.test(ip) ? ip : null;
  }
  const parts = header(req, 'x-forwarded-for').split(',').map((x) => x.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  return IP_RE.test(last) ? last : null;
}

/**
 * Same contract as rateLimit(req, key, opts) — a 429 Response or null — but keyed on the
 * TRUSTED client IP, or on one shared "untrusted" bucket when no trusted IP exists.
 */
export function trustedRateLimit(req, key, opts = {}, env = process.env) {
  return rateLimitStoreKey(`${key}:${trustedClientIp(req, env) ?? UNTRUSTED_BUCKET}`, opts);
}
