/**
 * /api/recruiter/password  (Phase 6 part 2 — account security)
 * PUT { currentPassword, newPassword, newPasswordConfirm } → the recruiter changes their OWN
 *     password (current password verified). Every older session is revoked; the caller gets a
 *     fresh cookie. Recruiter only (withRecruiterAuth + active, current session).
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterHandlers } from '@/lib/recruiterRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterHandlers({ toRecruiterError });
export const PUT = withRecruiterAuth(h.changePassword);
