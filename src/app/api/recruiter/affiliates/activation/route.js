/**
 * /api/recruiter/affiliates/activation  (Affiliate Recruiter System, Phase 6 part 1)
 * GET → the recruiter's OWN affiliates whose credentials are still pending (code state only).
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterActivationHandlers } from '@/lib/recruiterActivationRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterActivationHandlers({ toRecruiterError });
export const GET = withRecruiterAuth(h.pending);
