/**
 * /api/admin/rewards/gifts
 * GET   → catalog (?filter=all|active|inactive|archived|low|out)
 * POST  → create a gift
 * Admin only. Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const GET  = withAdminAuth(h.listGifts);
export const POST = withAdminAuth(h.createGift);
