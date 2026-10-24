/**
 * /api/affiliate/demo-chat
 * GET → the simulated Mini Chat feed (Phase 3C-7); creates due demo messages
 *       lazily (idempotent Phase 3C-6 service) before reading.
 * Affiliate only — identity from the session token; no profile/assignment id
 * is accepted. 404 unless DEMO_CHAT_ENABLED=true AND the protected
 * "demo-chat-config" setting is enabled. Body: src/lib/demoChatFeedRoute.js.
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { demoChatFeedHandler } from '@/lib/demoChatFeedRoute';

export const dynamic = 'force-dynamic';

export const GET = withAffiliateAuth(demoChatFeedHandler());
