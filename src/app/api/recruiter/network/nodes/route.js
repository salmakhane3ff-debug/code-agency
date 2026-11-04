/**
 * /api/recruiter/network/nodes  (Affiliate Recruiter System, Phase 4 — read-only)
 * GET → one page of the recruiter's OWN network tree (?parentId=&cursor=&limit=&view=unplaced)
 * Recruiter only (withRecruiterAuth + active account); ownership enforced on the server.
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterNetworkHandlers } from '@/lib/recruiterNetworkRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Errors leave this route only through the recruiterVisibility error projection ({ code }).
const h = recruiterNetworkHandlers({ toRecruiterError });
export const GET = withRecruiterAuth(h.nodes);
