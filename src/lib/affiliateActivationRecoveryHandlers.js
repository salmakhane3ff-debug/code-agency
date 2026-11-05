/**
 * src/lib/affiliateActivationRecoveryHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the ADMIN ACTIVATION RECOVERY (Phase 6, part 1).
 *
 *   PUBLIC  request  POST { identifier, message, contactPhone? } → 202 { ok:true } ALWAYS
 *                    (no enumeration); rate-limited by IP and by identifier.
 *   ADMIN   list     GET ?status=        → requests (never a code)
 *           detail   GET (id)            → request + affiliate + recruiter + code states + audit
 *           review   POST (id) { action: 'approve' | 'reject', note? }
 *                    approve → 201 { activation: { code, expiresAt } } — shown ONCE to this admin
 * Admin routes are wrapped with withAdminAuth (role ADMIN). Every response is no-store; no
 * code is ever logged. Errors: { code[, error | fields] } — never an internal message.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import {
  adminApproveRecovery, adminGetRecovery, adminListRecoveries, adminRejectRecovery, requestActivationRecovery,
} from './services/affiliateActivationRecoveryService.js';

export const RECOVERY_RATE = Object.freeze({ ip: { max: 5, windowMs: 10 * 60_000 }, identifier: { max: 3, windowMs: 60 * 60_000 } });
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const FIELD_CODES = Object.freeze({ identifier: ['INVALID_IDENTIFIER'], message: ['INVALID_MESSAGE'], contactPhone: ['INVALID_PHONE'], body: ['UNKNOWN_FIELD'] });
const ADMIN_ERRORS = Object.freeze({
  INVALID_INPUT: [400, 'Données invalides.'],
  UNAUTHORIZED: [401, 'Non autorisé.'],
  NOT_FOUND: [404, 'Demande introuvable.'],
  ALREADY_REVIEWED: [409, 'Cette demande a déjà été traitée.'],
  AFFILIATE_ACTIVE: [409, 'Ce compte est déjà activé : la récupération ne peut pas réinitialiser un compte actif.'],
  NOT_ELIGIBLE: [409, "Ce compte n'a pas été créé avec un code d'activation."],
});
const actorOf = (user) => (user?.userId ? String(user.userId) : user?.email ? String(user.email) : user?.id ? String(user.id) : null);

/** Client IP for the audit (same derivation as the rate limiter: first trusted header). */
function requestIpOf(req) {
  const h = (n) => req.headers?.get?.(n)?.trim() || '';
  const cf = h('cf-connecting-ip');
  if (cf) return cf;
  const xff = h('x-forwarded-for').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : h('x-real-ip') || null;
}

export function activationRecoveryHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), rateLimit = defaultRateLimit } = deps;

  const adminSafe = (fn) => async (req, ctx, user) => {
    try {
      return await fn(req, ctx, user);
    } catch (e) {
      const known = ADMIN_ERRORS[e?.code];
      if (!known) {
        console.error('[activation recovery]', e?.code ?? e?.name ?? 'ERROR');
        return json({ code: 'SERVER_ERROR', error: 'Erreur serveur.' }, 500);
      }
      return json({ code: e.code, error: known[1] }, known[0]);
    }
  };
  const idOf = async (ctx) => { const id = (await ctx?.params)?.id; return typeof id === 'string' ? id : ''; };

  return {
    /** PUBLIC — always the same answer for a well-formed request. */
    request: async (req) => {
      try {
        if (rateLimit(req, 'activation-recovery', RECOVERY_RATE.ip)) return json({ code: 'RATE_LIMITED' }, 429);
        const body = await req.json().catch(() => undefined);
        const ident = typeof body?.identifier === 'string' ? body.identifier.trim().toLowerCase().slice(0, 40) : '';
        if (ident && rateLimit(req, `activation-recovery-id:${ident}`, RECOVERY_RATE.identifier)) return json({ code: 'RATE_LIMITED' }, 429);
        await requestActivationRecovery(body, { db, now: now(), requestIp: requestIpOf(req) });
        return json({ ok: true }, 202);
      } catch (e) {
        if (e?.code === 'INVALID_INPUT') {
          const fields = {};
          for (const f of Object.keys(FIELD_CODES)) if (typeof e.fields?.[f] === 'string' && FIELD_CODES[f].includes(e.fields[f])) fields[f] = e.fields[f];
          return json({ code: 'INVALID_INPUT', ...(Object.keys(fields).length ? { fields } : {}) }, 400);
        }
        console.error('[activation recovery request]', e?.code ?? e?.name ?? 'ERROR');
        return json({ code: 'SERVER_ERROR' }, 500);
      }
    },
    list: adminSafe(async (req) => {
      const status = new URL(req.url, 'http://local').searchParams.get('status');
      return json({ recoveries: await adminListRecoveries({ db, status }) });
    }),
    detail: adminSafe(async (_req, ctx) => json(await adminGetRecovery(await idOf(ctx), { db, now: now() }))),
    review: adminSafe(async (req, ctx, user) => {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body.action !== 'approve' && body.action !== 'reject')) {
        throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
      }
      const opts = { db, actorId: actorOf(user), note: typeof body.note === 'string' ? body.note : null, now: now() };
      if (body.action === 'reject') return json({ recovery: await adminRejectRecovery(await idOf(ctx), opts) });
      const issued = await adminApproveRecovery(await idOf(ctx), opts);
      const at = issued.expiresAt ? new Date(issued.expiresAt) : null;
      return json({ activation: { code: issued.code, expiresAt: at && Number.isFinite(at.getTime()) ? at.toISOString() : null } }, 201);
    }),
  };
}
