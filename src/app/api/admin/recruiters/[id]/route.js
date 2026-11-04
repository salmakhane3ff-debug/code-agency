/**
 * /api/admin/recruiters/[id]
 * PATCH { action: 'enable' | 'disable', reason? } → enable or disable a recruiter. Admin only.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRecruiterHandlers } from '@/lib/recruiterRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = adminRecruiterHandlers();
export const PATCH = withAdminAuth(h.setActive);
