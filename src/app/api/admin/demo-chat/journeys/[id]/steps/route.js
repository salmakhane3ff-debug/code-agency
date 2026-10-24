/**
 * /api/admin/demo-chat/journeys/:id/steps — draft steps (admin only)
 * POST  → create { expectedUpdatedAt, day, time, position?, type: 'text'|'earnings', text, earningsPeriod?, metric? }
 * PATCH → reorder { expectedUpdatedAt, steps: [{ id, position }] }
 * Image/audio steps are deferred to Phase 3C-3.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse, actorIdOf } from '@/lib/demoChatErrors';
import { createStep, reorderSteps } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const POST = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await createStep(id, body, { actorId: actorIdOf(user) }), { status: 201 });
  } catch (e) { return errorResponse(e, 'admin/demo-chat/steps POST'); }
});

export const PATCH = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await reorderSteps(id, body, { actorId: actorIdOf(user) }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/steps PATCH'); }
});
