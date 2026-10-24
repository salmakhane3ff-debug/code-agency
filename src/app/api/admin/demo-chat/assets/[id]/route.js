/**
 * /api/admin/demo-chat/assets/:id — one DEMO chat media asset (admin only)
 * DELETE → only when no draft step, published version or message uses it (else 409).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse, actorIdOf } from '@/lib/demoChatErrors';
import { deleteAsset } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const DELETE = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id } = await ctx.params;
    return Response.json(await deleteAsset(id, { actorId: actorIdOf(user) }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/assets/[id] DELETE'); }
});
