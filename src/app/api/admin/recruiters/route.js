/**
 * /api/admin/recruiters
 * GET  → every recruiter (no password hash)
 * POST { username, name, password, phone? } → create a recruiter
 * Admin only. Bodies live in src/lib/recruiterRouteHandlers.js (testable).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminRecruiterHandlers } from '@/lib/recruiterRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = adminRecruiterHandlers();
export const GET = withAdminAuth(h.list);
export const POST = withAdminAuth(h.create);
