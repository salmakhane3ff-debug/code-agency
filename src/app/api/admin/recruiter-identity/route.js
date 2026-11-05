/**
 * /api/admin/recruiter-identity  (Affiliate Recruiter System, Phase 6 part 3c — admin)
 * GET → the recruiter identity verification (KYC) queue with each recruiter's KYC history
 * PUT { id, action: 'approve' | 'reject', expectedStatus, submission, reason } → decision
 * Admin only (withAdminAuth). Separate from the affiliate /api/admin/identity routes.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { recruiterIdentityAdminHandlers } from '@/lib/recruiterIdentityAdminHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterIdentityAdminHandlers();
export const GET = withAdminAuth(h.list);
export const PUT = withAdminAuth(h.decide);
