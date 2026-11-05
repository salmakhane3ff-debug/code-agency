/**
 * /api/admin/recruiters/[id]/permissions  (Affiliate Recruiter System, Phase 6 part 4)
 * PATCH { canViewOrders?: boolean, canCreateAffiliates?: boolean } → set the recruiter's
 * permissions independently (at least one field; booleans only; no other field). Admin only.
 * Each changed permission is audited once (RECRUITER_PERMISSION_CHANGED); a no-op writes nothing.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRecruiterHandlers } from '@/lib/recruiterRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = adminRecruiterHandlers();
export const PATCH = withAdminAuth(h.setPermissions);
