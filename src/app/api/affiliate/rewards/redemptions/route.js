/**
 * /api/affiliate/rewards/redemptions
 * GET   → own gift requests + status history
 * POST  → request a gift { giftId, clientRequestId, recipient fields }
 * Affiliate only — identity from the session token, never from the body.
 * Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateRewardsHandlers();

export const GET  = withAffiliateAuth(h.redemptions);
export const POST = withAffiliateAuth(h.requestRedemption);
