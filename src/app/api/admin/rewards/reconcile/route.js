/**
 * /api/admin/rewards/reconcile
 * POST → re-sync order points and pending signup bonuses whose post-commit hook
 *        failed. Idempotent: running it again changes nothing.
 * Admin only. Body lives in src/lib/rewardsRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRewardsHandlers } from '@/lib/rewardsRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminRewardsHandlers();

export const POST = withAdminAuth(h.reconcile);
