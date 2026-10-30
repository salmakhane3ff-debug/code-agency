/**
 * /api/affiliate/brand/access
 * POST { packageId, brandName, brandingOptionId?, termsVersion, acceptTerms, clientRequestId }
 *      → request access to the simulator (PENDING_PAYMENT). Idempotent per
 *        clientRequestId; records no payment and moves no money.
 * Affiliate only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateBrandHandlers();

export const POST = withAffiliateAuth(h.requestAccess);
