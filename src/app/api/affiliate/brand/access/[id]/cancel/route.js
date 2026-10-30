/**
 * /api/affiliate/brand/access/[id]/cancel
 * POST → cancel the participant's own request while it still awaits payment.
 * Affiliate only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateBrandHandlers();

export const POST = withAffiliateAuth(h.cancelAccess);
