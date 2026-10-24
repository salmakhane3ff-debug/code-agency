/**
 * /api/affiliate/rewards/ledger
 * GET  → own points history (?cursor=)
 * Affiliate only — identity from the session token, never from the body.
 * Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateRewardsHandlers();

export const GET = withAffiliateAuth(h.ledger);
