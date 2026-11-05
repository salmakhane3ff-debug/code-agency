/**
 * /api/admin/activation-recovery/[id]  (Affiliate Recruiter System, Phase 6 part 1 — admin)
 * GET  → the request, the affiliate, its recruiter, its code history (states only) and audit.
 * POST { action: 'approve' | 'reject', note? } → approve returns the NEW activation code ONCE
 *      (to this admin only; the old credentials are invalidated); reject closes the request.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { activationRecoveryHandlers } from '@/lib/affiliateActivationRecoveryHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = activationRecoveryHandlers();
export const GET = withAdminAuth(h.detail);
export const POST = withAdminAuth(h.review);
