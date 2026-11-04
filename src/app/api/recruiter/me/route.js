/**
 * /api/recruiter/me
 * GET → the recruiter's own profile (toRecruiterProfileView). Recruiter only;
 *       a disabled account → 403 RECRUITER_DISABLED.
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterHandlers } from '@/lib/recruiterRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Errors leave this route only through the recruiterVisibility error projection ({ code }).
const h = recruiterHandlers({ toRecruiterError });
export const GET = withRecruiterAuth(h.me);
