/**
 * /api/admin/rewards/accounts/[affiliateId]
 * GET  → summary, ledger, awards, requests
 * Admin only. Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const GET = withAdminAuth(h.getAccount);
