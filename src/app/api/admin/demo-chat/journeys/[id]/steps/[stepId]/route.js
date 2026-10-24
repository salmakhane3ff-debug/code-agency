/**
 * /api/admin/demo-chat/journeys/:id/steps/:stepId — one draft step (admin only)
 * PATCH  → { expectedUpdatedAt, ...fields } (whole step re-validated)
 * DELETE → { expectedUpdatedAt }
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse, actorIdOf } from '@/lib/demoChatErrors';
import { updateStep, deleteStep } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const PATCH = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id, stepId } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await updateStep(id, stepId, body, { actorId: actorIdOf(user) }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/steps/[stepId] PATCH'); }
});

export const DELETE = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id, stepId } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await deleteStep(id, stepId, body, { actorId: actorIdOf(user) }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/steps/[stepId] DELETE'); }
});
