/**
 * /api/admin/brand/accesses?status=ALL|PENDING_PAYMENT|ACTIVE|REJECTED|CANCELLED&q=
 * GET → access requests, most recent first.
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const GET = withAdminAuth(h.listAccesses);
