/**
 * /api/affiliate/brand/access/[id]/proof
 * POST (multipart: paymentMethod, transferReference?, proof) → submit the payment
 *      proof of the participant's OWN request awaiting payment
 * GET  → own proof metadata;  GET ?file=1 → own proof file (private stream)
 * Affiliate only; ownership is checked server-side. Bodies live in
 * src/lib/brandRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateBrandHandlers();

export const GET = withAffiliateAuth(h.getProof);
export const POST = withAffiliateAuth(h.submitProof);
