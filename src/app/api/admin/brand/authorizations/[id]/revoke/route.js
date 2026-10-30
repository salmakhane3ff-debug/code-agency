/**
 * /api/admin/brand/authorizations/[id]/revoke
 * POST { reason } → revoke an UNUSED new-request authorization
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const POST = withAdminAuth(h.revokeAuthorization);
