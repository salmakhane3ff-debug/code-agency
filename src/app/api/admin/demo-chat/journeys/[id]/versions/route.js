/**
 * /api/admin/demo-chat/journeys/:id/versions — published versions (admin only, read-only)
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse } from '@/lib/demoChatErrors';
import { listVersions } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const GET = withAdminAuth(async (req, ctx) => {
  try { const { id } = await ctx.params; return Response.json(await listVersions(id)); } catch (e) { return errorResponse(e, 'admin/demo-chat/versions GET'); }
});
