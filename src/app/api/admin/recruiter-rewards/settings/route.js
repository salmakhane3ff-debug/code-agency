/**
 * /api/admin/recruiter-rewards/settings  (Affiliate Recruiter System, Phase 5 — admin)
 * POST { enabled, rewardAmountMad, minDeliveredSales } → append the next settings version
 *      (validated server-side, audited); earned rewards are never changed.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { recruiterRewardAdminHandlers } from '@/lib/recruiterRewardAdminHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterRewardAdminHandlers();
export const POST = withAdminAuth(h.saveSettings);
