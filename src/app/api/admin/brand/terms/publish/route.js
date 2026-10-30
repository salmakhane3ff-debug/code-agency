/**
 * /api/admin/brand/terms/publish
 * POST → approve the current draft and publish it as a new version (audited).
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const POST = withAdminAuth(h.publishTerms);
