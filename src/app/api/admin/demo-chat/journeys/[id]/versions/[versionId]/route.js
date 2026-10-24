/**
 * /api/admin/demo-chat/journeys/:id/versions/:versionId — one immutable version (admin only, read-only)
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse } from '@/lib/demoChatErrors';
import { getVersion } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const GET = withAdminAuth(async (req, ctx) => {
  try { const { id, versionId } = await ctx.params; return Response.json(await getVersion(id, versionId)); } catch (e) { return errorResponse(e, 'admin/demo-chat/versions/[versionId] GET'); }
});
