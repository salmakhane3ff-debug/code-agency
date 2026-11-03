/**
 * /api/affiliate/brand/access/[id]/consent
 * POST { termsVersion, acceptTerms: true } → record a FRESH consent to the latest
 *      published terms for the participant's OWN request whose original consent
 *      cannot be verified (separate append-only evidence; the original snapshot is
 *      never changed). It never reopens a request and never authorizes payment.
 * Affiliate only; ownership is checked server-side. Bodies live in
 * src/lib/brandRouteHandlers.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliateBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = affiliateBrandHandlers();

export const POST = withAffiliateAuth(h.renewConsent);
