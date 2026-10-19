/**
 * /api/admin/rewards/gifts/[id]
 * GET    → one gift
 * PUT    → edit catalog fields
 * PATCH  → { action: activate|deactivate|archive|restore }
 * Admin only. Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const GET   = withAdminAuth(h.getGift);
export const PUT   = withAdminAuth(h.updateGift);
export const PATCH = withAdminAuth(h.patchGift);
