/**
 * src/lib/rateLimit.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight in-memory rate limiter — no external dependencies.
 * Uses a sliding window counter per IP per route key.
 *
 * Usage:
 *   import { rateLimit } from '@/lib/rateLimit';
 *
 *   const limited = rateLimit(req, 'login', { max: 10, windowMs: 60_000 });
 *   if (limited) return limited; // returns a 429 Response automatically
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Map of "key:ip" → { count, resetAt }
const store = new Map();

// Cleanup stale entries every 5 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.resetAt < now) store.delete(k);
  }
}, 5 * 60 * 1000);

/**
 * Check rate limit for a request.
 * @param {Request} req
 * @param {string}  key       — route identifier, e.g. 'login', 'upload'
 * @param {object}  options
 * @param {number}  options.max        — max requests per window (default 30)
 * @param {number}  options.windowMs   — window size in ms (default 60_000 = 1 min)
 * @returns {Response|null}  — 429 Response if limited, null if allowed
 */
export function rateLimit(req, key, { max = 30, windowMs = 60_000 } = {}) {
  return rateLimitStoreKey(`${key}:${getIp(req)}`, { max, windowMs });
}

/**
 * The same sliding counter for an explicit store key (no IP derivation). Used by callers that
 * derive the client identity themselves (e.g. src/lib/trustedProxy.js). rateLimit() above is
 * unchanged: it calls this with `${key}:${ip}` exactly as before.
 * @returns {Response|null} — 429 Response if limited, null if allowed
 */
export function rateLimitStoreKey(storeKey, { max = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();

  let entry = store.get(storeKey);

  if (!entry || entry.resetAt < now) {
    entry = { count: 1, resetAt: now + windowMs };
    store.set(storeKey, entry);
    return null; // allowed
  }

  entry.count++;

  if (entry.count > max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return new Response(
      JSON.stringify({ error: 'Too many requests. Please try again later.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(max),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  return null; // allowed
}

// Loose IP validation — accepts IPv4, IPv6, and common formats.
// The goal is not strict validation but preventing header injection / log poisoning.
const IP_RE = /^[a-fA-F0-9.:]{2,45}$/;

function getIp(req) {
  // CF-Connecting-IP is set by Cloudflare's edge and cannot be forged by clients.
  // x-forwarded-for is user-controlled when not behind a trusted proxy — use last.
  const cf  = req.headers?.get?.('cf-connecting-ip')?.trim();
  if (cf && IP_RE.test(cf)) return cf;

  // Behind a trusted reverse proxy, take the LAST entry in XFF
  // (the one the proxy itself appended) rather than the first (user-controlled).
  const xff = req.headers?.get?.('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const last  = parts[parts.length - 1];
    if (last && IP_RE.test(last)) return last;
  }

  const real = req.headers?.get?.('x-real-ip')?.trim();
  if (real && IP_RE.test(real)) return real;

  return 'unknown';
}
