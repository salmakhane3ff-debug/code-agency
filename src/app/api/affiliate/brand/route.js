/**
 * /api/affiliate/brand
 * GET  → "Create Your Own Brand" (training simulator): active packages and
 *        branding options, the PUBLISHED refund terms (only while the program is
 *        enabled) and the participant's own access, if any
 * Affiliate only — identity from the session token, never from the body.
 * Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateBrandHandlers();

export const GET = withAffiliateAuth(h.overview);
