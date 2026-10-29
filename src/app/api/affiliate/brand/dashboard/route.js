/**
 * /api/affiliate/brand/dashboard?window=24h|7d|30d
 * GET → SIMULATED training statistics of the participant's active access.
 * Affiliate only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateBrandHandlers();

export const GET = withAffiliateAuth(h.dashboard);
