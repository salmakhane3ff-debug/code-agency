/**
 * /api/admin/rewards/redemptions/[id]
 * GET    → request + history
 * PATCH  → status transition or tracking/notes edit
 * Admin only. Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const GET   = withAdminAuth(h.getRedemption);
export const PATCH = withAdminAuth(h.patchRedemption);
