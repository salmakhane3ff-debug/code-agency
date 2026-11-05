/**
 * /api/admin/activation-recovery  (Affiliate Recruiter System, Phase 6 part 1 — admin)
 * GET ?status=PENDING|APPROVED|REJECTED → activation recovery requests (never a code).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { activationRecoveryHandlers } from '@/lib/affiliateActivationRecoveryHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = activationRecoveryHandlers();
export const GET = withAdminAuth(h.list);
