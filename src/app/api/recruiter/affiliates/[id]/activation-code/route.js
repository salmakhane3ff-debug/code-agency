/**
 * /api/recruiter/affiliates/[id]/activation-code  (Affiliate Recruiter System, Phase 6 part 1)
 * POST → a NEW one-time activation code for one of the recruiter's OWN affiliates whose
 *        credentials are still pending (the previous code is invalidated). Returned ONCE.
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterActivationHandlers } from '@/lib/recruiterActivationRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterActivationHandlers({ toRecruiterError });
export const POST = withRecruiterAuth(h.regenerate);
