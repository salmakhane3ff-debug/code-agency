/**
 * /api/admin/demo-chat/journeys/:id — one DEMO chat journey (admin only)
 * GET    → journey, ordered draft steps, published versions
 * PATCH  → { expectedUpdatedAt, name?, description? } or { expectedUpdatedAt, action: 'archive'|'unarchive' }
 * DELETE → { expectedUpdatedAt } — only if never published (else 409: archive)
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse, actorIdOf } from '@/lib/demoChatErrors';
import { getJourney, updateJourney, deleteJourney } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const GET = withAdminAuth(async (req, ctx) => {
  try { const { id } = await ctx.params; return Response.json(await getJourney(id)); } catch (e) { return errorResponse(e, 'admin/demo-chat/journeys/[id] GET'); }
});

export const PATCH = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await updateJourney(id, body, { actorId: actorIdOf(user) }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/journeys/[id] PATCH'); }
});

export const DELETE = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await deleteJourney(id, body, { actorId: actorIdOf(user) }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/journeys/[id] DELETE'); }
});
