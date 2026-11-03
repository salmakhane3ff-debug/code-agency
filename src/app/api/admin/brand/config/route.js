/**
 * /api/admin/brand/config
 * GET  → "Create Your Own Brand" configuration
 * PUT  → save the whole configuration (validated; saved packages can only be deactivated)
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const GET = withAdminAuth(h.getConfig);
export const PUT = withAdminAuth(h.putConfig);
