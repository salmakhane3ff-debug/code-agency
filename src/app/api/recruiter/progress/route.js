/**
 * /api/recruiter/progress  (Affiliate Recruiter System, Phase 7 Stage B — read-only)
 * GET → the recruiter's OWN progress summary (linked / downline counts, group progress, thresholds,
 * reward counts). Recruiter only (withRecruiterAuth + active account).
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterProgressHandlers } from '@/lib/recruiterProgressHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Errors leave this route only through the recruiterVisibility error projection ({ code }).
const h = recruiterProgressHandlers({ toRecruiterError });
export const GET = withRecruiterAuth(h.summary);
