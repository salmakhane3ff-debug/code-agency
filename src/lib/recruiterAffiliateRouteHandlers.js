/**
 * src/lib/recruiterAffiliateRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the Affiliate Recruiter System, Phase 3: a recruiter creates affiliates
 * in their OWN network. The route wraps them with withRecruiterAuth; tests inject a fake
 * db, clock, rate limiter and id generator.
 *
 *   affiliates      GET ?q=  → own network only (parent selector), newest first, max 50
 *   createAffiliate POST     → a new INACTIVE affiliate, root or under one of their own
 * Every request re-checks the recruiter account (active) on the server; responses are built
 * ONLY with recruiterVisibility.js (network view, error codes + allowlisted field codes).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { requireActiveRecruiter } from './services/recruiterService.js';
import { listRecruiterNetwork, recruiterCreateAffiliate } from './services/recruiterAffiliateService.js';
import { toRecruiterActivationCodeView, toRecruiterError as defaultToRecruiterError, toRecruiterNetworkAffiliateView } from './recruiterVisibility.js';
import { json, recruiterErrorResponse } from './recruiterRouteHandlers.js';

export const RECRUITER_CREATE_RATE = Object.freeze({ max: 20, windowMs: 60_000 });

export function recruiterAffiliateHandlers(deps = {}) {
  const {
    db = prisma, now = () => new Date(), rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError,
    invalidateTeam = () => {}, newId,
  } = deps;
  const safe = (fn) => async (req, ctx, decoded) => { try { return await fn(req, ctx, decoded); } catch (e) { return recruiterErrorResponse(e, toRecruiterError); } };
  return {
    affiliates: safe(async (req, _ctx, decoded) => {
      const me = await requireActiveRecruiter(decoded, { db });
      const q = new URL(req.url, 'http://local').searchParams.get('q') ?? '';
      const { rows, networkIds, truncated } = await listRecruiterNetwork(me.id, { db, q });
      const ids = new Set([...networkIds, ...rows.map((r) => r.id)]);
      return json({ affiliates: rows.map((r) => toRecruiterNetworkAffiliateView(r, ids)), truncated });
    }),
    /**
     * POST { username, name, phone?, parentId?, requestId } → 201 { affiliate, replayed:false,
     * activation: { code, expiresAt } } (the ONLY time the code is returned) | 200 replay with
     * activation: null (the code was returned once; a new one can be issued).
     */
    createAffiliate: safe(async (req, _ctx, decoded) => {
      const rid = typeof decoded?.recruiterId === 'string' ? decoded.recruiterId : '-';
      if (rateLimit(req, `recruiter-create-affiliate:${rid}`, RECRUITER_CREATE_RATE)) return json({ code: 'RATE_LIMITED' }, 429);
      const me = await requireActiveRecruiter(decoded, { db });
      const body = await req.json().catch(() => undefined);
      const { row, networkIds, replayed, activation } = await recruiterCreateAffiliate(me.id, body, { db, now: now(), ...(newId ? { newId } : {}) });
      if (!replayed && row.parentId) { try { invalidateTeam(row.parentId); } catch { /* cache only */ } }
      return json({
        affiliate: toRecruiterNetworkAffiliateView(row, networkIds), replayed,
        activation: !replayed && activation ? toRecruiterActivationCodeView(activation) : null,
      }, replayed ? 200 : 201);
    }),
  };
}
