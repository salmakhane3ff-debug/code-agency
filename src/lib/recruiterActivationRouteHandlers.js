/**
 * src/lib/recruiterActivationRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the recruiter side of affiliate ACTIVATION CODES (Phase 6, part 1).
 * Routes wrap them with withRecruiterAuth; tests inject a fake db, clock and rate limiter.
 *
 *   pending     GET          → their affiliates whose credentials are still pending (state
 *                               of the latest code only — never a code)
 *   regenerate  POST (id)    → a NEW code for one of them (invalidates the previous one),
 *                               returned ONCE; refused once the credentials were set
 * Every request re-checks the recruiter account (active). Responses: recruiterVisibility only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { requireActiveRecruiter } from './services/recruiterService.js';
import { listPendingActivations, regenerateActivationCode } from './services/affiliateActivationService.js';
import { toRecruiterActivationCodeView, toRecruiterError as defaultToRecruiterError, toRecruiterPendingActivationView } from './recruiterVisibility.js';
import { json, recruiterErrorResponse } from './recruiterRouteHandlers.js';

export const RECRUITER_ACTIVATION_RATE = Object.freeze({ read: { max: 60, windowMs: 60_000 }, write: { max: 10, windowMs: 60_000 } });
const STATUS = Object.freeze({ ACTIVATION_NOT_AVAILABLE: 409 });

export function recruiterActivationHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError } = deps;
  const safe = (kind, fn) => async (req, ctx, decoded) => {
    try {
      const rid = typeof decoded?.recruiterId === 'string' ? decoded.recruiterId : '-';
      if (rateLimit(req, `recruiter-activation-${kind}:${rid}`, RECRUITER_ACTIVATION_RATE[kind])) return json({ code: 'RATE_LIMITED' }, 429);
      const me = await requireActiveRecruiter(decoded, { db });
      return await fn(req, ctx, me);
    } catch (e) {
      return recruiterErrorResponse(e, toRecruiterError, STATUS);
    }
  };
  return {
    pending: safe('read', async (_req, _ctx, me) => {
      const rows = await listPendingActivations(me.id, { db, now: now() });
      return json({ pending: rows.map(toRecruiterPendingActivationView) });
    }),
    regenerate: safe('write', async (_req, ctx, me) => {
      const id = (await ctx?.params)?.id;
      const issued = await regenerateActivationCode(me.id, typeof id === 'string' ? id : '', { db, now: now() });
      return json({ activation: toRecruiterActivationCodeView(issued) }, 201);
    }),
  };
}
