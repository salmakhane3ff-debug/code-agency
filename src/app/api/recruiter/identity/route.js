/**
 * /api/recruiter/identity  (Affiliate Recruiter System, Phase 6 part 3c)
 * GET  → the recruiter's OWN identity verification state (no file key, no reviewer).
 * POST multipart { front, back } → submit (or, after a rejection, resubmit) the CIN.
 * A withdrawal needs this verification APPROVED (enforced by the withdrawal service).
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterIdentityHandlers } from '@/lib/recruiterIdentityRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterIdentityHandlers({ toRecruiterError });
export const GET = withRecruiterAuth(h.identity);
export const POST = withRecruiterAuth(h.submit);
