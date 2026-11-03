/**
 * /api/admin/brand/authorizations
 * GET ?affiliateId=            → new-request authorizations
 * POST { affiliateId, reason } → grant ONE new request after a closed brand
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const GET = withAdminAuth(h.listAuthorizations);
export const POST = withAdminAuth(h.grantAuthorization);
