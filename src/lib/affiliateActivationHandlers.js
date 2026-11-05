/**
 * src/lib/affiliateActivationHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * PUBLIC endpoint body: an affiliate redeems their one-time activation code and sets their
 * own password (Phase 6, part 1). No session is created and the account is NOT activated:
 * the existing admin approval stays the only activation.
 *
 *   redeem  POST { code, password, passwordConfirm } → 200 { ok: true }
 * Errors: { code[, fields] } only — INVALID_INPUT (fields: code / password / passwordConfirm /
 * body), INVALID_OR_EXPIRED_CODE (one answer for every code problem: no enumeration),
 * RATE_LIMITED, SERVER_ERROR. The code is never logged.
 * Rate limits: by IP (the shared limiter) and by code selector; each code also has 5 attempts
 * in the database.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { trustedRateLimit as defaultRateLimit } from './trustedProxy.js'; // Phase 6 part 2: trusted client IP only
import { redeemActivationCode } from './services/affiliateActivationService.js';

export const ACTIVATION_RATE = Object.freeze({ ip: { max: 10, windowMs: 60_000 }, code: { max: 5, windowMs: 15 * 60_000 } });
const FIELD_CODES = Object.freeze({
  code: ['INVALID_CODE_FORMAT'], password: ['WEAK_PASSWORD'], passwordConfirm: ['PASSWORD_MISMATCH'], body: ['UNKNOWN_FIELD'],
});
const STATUS = Object.freeze({ INVALID_INPUT: 400, INVALID_OR_EXPIRED_CODE: 400, RATE_LIMITED: 429 });
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function errorBody(e) {
  const code = Object.prototype.hasOwnProperty.call(STATUS, e?.code) ? e.code : 'SERVER_ERROR';
  if (code === 'SERVER_ERROR') console.error('[affiliate-activation]', e?.code ?? e?.name ?? 'ERROR'); // never the request body
  const out = { code };
  if (code === 'INVALID_INPUT' && e?.fields && typeof e.fields === 'object') {
    const fields = {};
    for (const f of Object.keys(FIELD_CODES)) if (typeof e.fields[f] === 'string' && FIELD_CODES[f].includes(e.fields[f])) fields[f] = e.fields[f];
    if (Object.keys(fields).length) out.fields = fields;
  }
  return json(out, STATUS[code] ?? 500);
}

const selectorOf = (body) => (typeof body?.code === 'string' ? body.code.trim().split('.')[0].slice(0, 16) : '');

export function affiliateActivationHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), rateLimit = defaultRateLimit } = deps;
  return {
    redeem: async (req) => {
      try {
        if (rateLimit(req, 'affiliate-activation', ACTIVATION_RATE.ip)) return json({ code: 'RATE_LIMITED' }, 429);
        const body = await req.json().catch(() => undefined);
        const sel = selectorOf(body);
        if (sel && rateLimit(req, `affiliate-activation-code:${sel}`, ACTIVATION_RATE.code)) return json({ code: 'RATE_LIMITED' }, 429);
        await redeemActivationCode(body, { db, now: now() });
        return json({ ok: true });
      } catch (e) {
        return errorBody(e);
      }
    },
  };
}
