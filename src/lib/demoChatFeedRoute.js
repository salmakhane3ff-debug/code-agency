/**
 * src/lib/demoChatFeedRoute.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Body of GET /api/affiliate/demo-chat (Phase 3C-7) as a dependency-injected
 * handler (same pattern as rewardsRouteHandlers.js); the route file only wires
 * withAffiliateAuth.
 *
 *   1. withAffiliateAuth has verified the token (401 otherwise).
 *   2. Rate limit (30 / min).
 *   3. Both gates (env DEMO_CHAT_ENABLED + protected "demo-chat-config") —
 *      off → uniform 404, no chat data, no further reads.
 *   4. The token's account must exist and be active (403): withAffiliateAuth
 *      does not re-check isActive and a token outlives a deactivation.
 *   5. Lazy materialization of due messages, then the feed — the same for
 *      every viewer, chosen by the server. Query
 *      parameters other than `lang` are ignored: no profile, assignment or
 *      affiliate id from the client is ever read.
 *
 * Writes only demo chat messages (+ their SYSTEM audit row), through the
 * Phase 3C-6 idempotent materializer, for the conversations of this feed.
 * No viewer state, no scheduler.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as realRateLimit } from './rateLimit.js';
import { readDemoChatGates } from './demoChatGate.js';
import { getDemoDb } from './services/demoService.js';
import { getMiniChatFeed } from './services/demoChatFeedService.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const json = (data, status = 200) => Response.json(data, { status, headers: NO_STORE });

export function demoChatFeedHandler(deps = {}) {
  const {
    db = prisma, now = Date.now, env = process.env,
    rateLimit = realRateLimit, getFeed = getMiniChatFeed,
  } = deps;

  return async function getDemoChatFeed(req, _ctx, decoded) {
    const limited = rateLimit(req, 'demo_chat_feed', { max: 30, windowMs: 60_000 });
    if (limited) return limited;
    const demoDb = deps.demoDb ?? getDemoDb();
    try {
      if (!(await readDemoChatGates(demoDb, env)).enabled) return json({ error: 'NOT_FOUND' }, 404);

      const id = decoded?.affiliateId;
      const acc = typeof id === 'string' && id
        ? await db.affiliate.findUnique({ where: { id }, select: { isActive: true } })
        : null;
      if (!acc?.isActive) return json({ error: 'AFFILIATE_INACTIVE' }, 403);

      const lang = new URL(req.url).searchParams.get('lang') === 'fr' ? 'fr' : 'ar';
      // Lazy materialization only here: authenticated + active + gates on.
      const feed = await getFeed({ now: now(), locale: lang, env, db: demoDb, materialize: true });
      if (!feed) return json({ error: 'NOT_FOUND' }, 404); // gate turned off meanwhile
      return json(feed);
    } catch (e) {
      console.error('[demo-chat feed] error:', e?.code || e?.message || e);
      return json({ error: 'SERVER_ERROR' }, 500);
    }
  };
}
