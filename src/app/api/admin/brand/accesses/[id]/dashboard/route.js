/**
 * /api/admin/brand/accesses/[id]/dashboard?window=24h|7d|30d
 * GET → the SIMULATED training statistics of one active access.
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const GET = withAdminAuth(h.accessDashboard);
