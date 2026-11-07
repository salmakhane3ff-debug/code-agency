/**
 * src/lib/recruiterAffiliateRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the Affiliate Recruiter System, Phase 3: a recruiter creates affiliates
 * in their OWN network. The route wraps them with withRecruiterAuth; tests inject a fake
 * db, clock, rate limiter and id generator.
 *
 *   affiliates      GET ?q=&cursor=&limit=  → own network N(R) (Phase 7 Stage E: every affiliate whose
 *                   owner is the recruiter — parent selector and list), newest first, 50 by default
 *                   (max 100), keyset cursor, total; per item the activation, identity status, level /
 *                   parent in N(R), linkedToMe (information), progress (delivered values only with
 *                   canViewOrders) and the latest individual reward cycle
 *   createAffiliate POST     → a new INACTIVE affiliate, root or under a member of their network
 * Every request re-checks the recruiter account (active) on the server; responses are built
 * ONLY with recruiterVisibility.js (network view, error codes + allowlisted field codes).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { requireActiveRecruiter } from './services/recruiterService.js';
import { LIST_CURSOR_RE, listRecruiterNetwork, recruiterCreateAffiliate } from './services/recruiterAffiliateService.js';
import { withProgress } from './services/recruiterProgressService.js';
import {
  toRecruiterActivationCodeView, toRecruiterAffiliateListItemView, toRecruiterError as defaultToRecruiterError, toRecruiterNetworkAffiliateView,
} from './recruiterVisibility.js';
import { json, recruiterErrorResponse } from './recruiterRouteHandlers.js';

export const RECRUITER_CREATE_RATE = Object.freeze({ max: 20, windowMs: 60_000 });
const invalid = () => Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
const INT_RE = /^(0|[1-9][0-9]{0,6})$/;

export function recruiterAffiliateHandlers(deps = {}) {
  const {
    db = prisma, now = () => new Date(), rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError,
    invalidateTeam = () => {}, newId,
  } = deps;
  const safe = (fn) => async (req, ctx, decoded) => { try { return await fn(req, ctx, decoded); } catch (e) { return recruiterErrorResponse(e, toRecruiterError); } };
  return {
    affiliates: safe(async (req, _ctx, decoded) => {
      const me = await requireActiveRecruiter(decoded, { db });
      const params = new URL(req.url, 'http://local').searchParams;
      const q = params.get('q') ?? '';
      // Phase 7 Stage B: keyset paging (?cursor=<ms>.<affiliateId>&limit=1…100) — without them, the former page.
      const cursor = params.get('cursor');
      const limit = params.get('limit');
      if ((cursor !== null && !LIST_CURSOR_RE.test(cursor)) || (limit !== null && !INT_RE.test(limit))) throw invalid();
      // canViewOrders (Phase 6 part 4), re-read with the account: off → no order query, delivered progress null.
      const includeOrders = me.canViewOrders === true;
      const page = await listRecruiterNetwork(me.id, { db, q, cursor, limit: limit === null ? null : Number(limit), includeOrders });
      const rows = await withProgress(me.id, page.rows, { db, includeOrders });
      const ids = new Set([...page.networkIds, ...rows.map((r) => r.id)]);
      return json({
        affiliates: rows.map((r) => toRecruiterAffiliateListItemView(r, ids)), truncated: page.truncated,
        total: Number.isInteger(page.total) ? page.total : 0, nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
      });
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
