/**
 * src/lib/recruiterNetworkRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the Affiliate Recruiter System, Phase 4: the recruiter's network tree and
 * statistics (READ-ONLY). The routes wrap them with withRecruiterAuth; tests inject a fake
 * db and rate limiter.
 *
 *   stats  GET ?rootId=                          → statistics of the whole network or of one
 *                                                  of the recruiter's own sub-networks
 *   nodes  GET ?parentId=&cursor=&limit=&view=   → one page of the tree (roots, children of
 *                                                  one of their affiliates, or `unplaced`)
 * Every request re-checks the recruiter account (active); ownership of rootId / parentId is
 * enforced by the service (anything outside the network → 404 NOT_FOUND). Phase 7 Stage E: the
 * network is N(R) (every affiliate whose owner — Stage F: the TOPMOST linked affiliate of its chain — is the
 * recruiter; levels absolute everywhere; other recruiters' affiliates are never visible); each node
 * carries linkedToMe (information only), its progress and rewardState. Responses are
 * built ONLY with recruiterVisibility.js. Phase 6 part 4: when the recruiter's canViewOrders is
 * off, no order query runs and every `orders` is null (the tree and identity counts stay).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { requireActiveRecruiter } from './services/recruiterService.js';
import { getNetworkNodes, getNetworkStats } from './services/recruiterNetworkService.js';
import { withProgress } from './services/recruiterProgressService.js';
import {
  toRecruiterError as defaultToRecruiterError, toRecruiterNetworkNodeView, toRecruiterNetworkPathView, toRecruiterNetworkStatsView,
} from './recruiterVisibility.js';
import { json, recruiterErrorResponse } from './recruiterRouteHandlers.js';

export const RECRUITER_NETWORK_RATE = Object.freeze({ max: 120, windowMs: 60_000 });
const invalid = () => Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
const INT_RE = /^(0|[1-9][0-9]{0,6})$/;

export function recruiterNetworkHandlers(deps = {}) {
  const { db = prisma, rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError } = deps;
  const safe = (fn) => async (req, ctx, decoded) => {
    try {
      const rid = typeof decoded?.recruiterId === 'string' ? decoded.recruiterId : '-';
      if (rateLimit(req, `recruiter-network:${rid}`, RECRUITER_NETWORK_RATE)) return json({ code: 'RATE_LIMITED' }, 429);
      const me = await requireActiveRecruiter(decoded, { db });
      return await fn(new URL(req.url, 'http://local').searchParams, me);
    } catch (e) {
      return recruiterErrorResponse(e, toRecruiterError);
    }
  };
  return {
    stats: safe(async (q, me) => {
      // canViewOrders (Phase 6 part 4), re-read with the account on every request: off → no order query, orders null.
      const stats = await getNetworkStats(me.id, { db, rootId: q.get('rootId') || null, includeOrders: me.canViewOrders === true });
      return json({ stats: toRecruiterNetworkStatsView(stats) });
    }),
    nodes: safe(async (q, me) => {
      const view = q.get('view');
      if (view !== null && view !== 'unplaced') throw invalid();
      const cursor = q.get('cursor');
      const limit = q.get('limit');
      if ((cursor !== null && !INT_RE.test(cursor)) || (limit !== null && !INT_RE.test(limit))) throw invalid();
      const includeOrders = me.canViewOrders === true;
      const page = await getNetworkNodes(me.id, {
        db, parentId: view ? null : q.get('parentId') || null, view,
        cursor: cursor === null ? 0 : Number(cursor), ...(limit === null ? {} : { limit: Number(limit) }),
        includeOrders,
      });
      // Phase 7 Stage B → E: progress of every node (delivered values null without canViewOrders) and the
      // latest individual reward cycle of every node (all members are reward-eligible) — settings + ledger reads only.
      const nodes = await withProgress(me.id, page.nodes, { db, includeOrders });
      return json({
        parent: page.parent ? toRecruiterNetworkPathView(page.parent) : null,
        path: page.path.map(toRecruiterNetworkPathView),
        nodes: nodes.map(toRecruiterNetworkNodeView),
        total: Number.isInteger(page.total) ? page.total : 0,
        nextCursor: Number.isInteger(page.nextCursor) ? page.nextCursor : null,
      });
    }),
  };
}
