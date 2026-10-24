/**
 * /api/admin/rewards/settings
 * GET  → rewards settings
 * PUT  → save settings (baseline on enable)
 * Admin only. Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const GET = withAdminAuth(h.getSettings);
export const PUT = withAdminAuth(h.putSettings);
