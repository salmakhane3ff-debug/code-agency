/**
 * /api/affiliate/rewards/redemptions/[id]/cancel
 * POST  → cancel own request while PENDING_REVIEW
 * Affiliate only — identity from the session token, never from the body.
 * Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateRewardsHandlers();

export const POST = withAffiliateAuth(h.cancelRedemption);
