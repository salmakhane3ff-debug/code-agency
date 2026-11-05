/**
 * /api/admin/recruiter-identity/[id]/[front|back]  (Phase 6 part 3c — admin)
 * GET → one CIN image of a recruiter identity verification, streamed privately
 * (no-store, private, nosniff, image/jpeg). Admin only; the storage key never leaves the server.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { recruiterIdentityAdminHandlers } from '@/lib/recruiterIdentityAdminHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterIdentityAdminHandlers();
export const GET = withAdminAuth(h.image);
