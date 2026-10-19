/**
 * /api/admin/rewards/gifts/[id]/stock
 * POST  → { delta, reason } — audited stock adjustment
 * Admin only. Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const POST = withAdminAuth(h.adjustStock);
