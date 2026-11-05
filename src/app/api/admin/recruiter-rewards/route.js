/**
 * /api/admin/recruiter-rewards  (Affiliate Recruiter System, Phase 5 — admin)
 * GET  → current reward settings + history, recruiter reward ledger, balances per recruiter
 * POST { action: 'reconcile' } → award every recruiter reward that is due now
 * Admin only (withAdminAuth). Recruiter withdrawals are processed in /api/admin/affiliate-payouts.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { recruiterRewardAdminHandlers } from '@/lib/recruiterRewardAdminHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterRewardAdminHandlers();
export const GET = withAdminAuth(h.overview);
export const POST = withAdminAuth(h.reconcile);
