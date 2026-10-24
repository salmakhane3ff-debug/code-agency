/**
 * /api/admin/rewards/accounts/[affiliateId]/adjust
 * POST  → { delta, reason, clientRequestId } — audited
 * Admin only. Bodies live in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const POST = withAdminAuth(h.adjustAccount);
