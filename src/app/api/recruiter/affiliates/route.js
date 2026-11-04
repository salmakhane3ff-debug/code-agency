/**
 * /api/recruiter/affiliates  (Affiliate Recruiter System, Phase 3)
 * GET  ?q=  → the recruiter's OWN network (parent selector), projected by recruiterVisibility
 * POST { username, name, password, phone?, parentId?, requestId } → create an INACTIVE affiliate
 *      in the recruiter's own network (root, or under one of their own affiliates).
 * Recruiter only (withRecruiterAuth + active account). No PUT / PATCH / DELETE: a parent is
 * never changed after creation and no existing affiliate can be linked.
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterAffiliateHandlers } from '@/lib/recruiterAffiliateRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';
import { invalidateTeamCache } from '@/lib/services/affiliateSystemService';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Errors leave this route only through the recruiterVisibility error projection ({ code, fields? }).
// invalidateTeamCache: the parent's "Mon équipe" shows the new member at once (same as the admin creation).
const h = recruiterAffiliateHandlers({ toRecruiterError, invalidateTeam: invalidateTeamCache });
export const GET = withRecruiterAuth(h.affiliates);
export const POST = withRecruiterAuth(h.createAffiliate);
