/**
 * /api/admin/brand/terms
 * GET  → refund terms: the draft and the published version
 * PUT  → save the draft { text } (never visible to affiliates)
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const GET = withAdminAuth(h.getTerms);
export const PUT = withAdminAuth(h.putTermsDraft);
