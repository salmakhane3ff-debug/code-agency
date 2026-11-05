/**
 * /api/admin/recruiters/[id]/password  (Phase 6 part 2 — account security)
 * POST { newPassword } → reset a recruiter's password. Revokes every session of that recruiter;
 *      never changes its active / disabled state. Audited (RECRUITER_PASSWORD_RESET). Admin only.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRecruiterHandlers } from '@/lib/recruiterRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = adminRecruiterHandlers();
export const POST = withAdminAuth(h.resetPassword);
