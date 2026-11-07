/**
 * src/lib/recruiterProgressHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP body of the Affiliate Recruiter System, Phase 7 Stage B: the recruiter's progress summary
 * (READ-ONLY). The route wraps it with withRecruiterAuth; tests inject a fake db and rate limiter.
 *
 *   summary  GET → { progress }: linked / downline counts, the group progress (qualified affiliates
 *                  toward the next group reward), switches, current thresholds and the recruiter's
 *                  own reward counts (cents) — aggregates only, also with canViewOrders off (no
 *                  per-affiliate delivered count is ever returned).
 * Every request re-checks the recruiter account (active); the response is built ONLY with
 * recruiterVisibility.js. Rate-limited per recruiter like the network endpoints.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { requireActiveRecruiter } from './services/recruiterService.js';
import { getRecruiterProgressSummary } from './services/recruiterProgressService.js';
import { toRecruiterError as defaultToRecruiterError, toRecruiterProgressSummaryView } from './recruiterVisibility.js';
import { json, recruiterErrorResponse } from './recruiterRouteHandlers.js';

export const RECRUITER_PROGRESS_RATE = Object.freeze({ max: 120, windowMs: 60_000 });

export function recruiterProgressHandlers(deps = {}) {
  const { db = prisma, rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError } = deps;
  return {
    summary: async (req, ctx, decoded) => {
      try {
        const rid = typeof decoded?.recruiterId === 'string' ? decoded.recruiterId : '-';
        if (rateLimit(req, `recruiter-progress:${rid}`, RECRUITER_PROGRESS_RATE)) return json({ code: 'RATE_LIMITED' }, 429);
        const me = await requireActiveRecruiter(decoded, { db });
        return json({ progress: toRecruiterProgressSummaryView(await getRecruiterProgressSummary(me.id, { db })) });
      } catch (e) {
        return recruiterErrorResponse(e, toRecruiterError);
      }
    },
  };
}
