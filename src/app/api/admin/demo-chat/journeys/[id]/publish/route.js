/**
 * /api/admin/demo-chat/journeys/:id/publish — freeze the draft as an immutable version (admin only)
 * POST → { expectedUpdatedAt } ; 409 NO_CHANGES when identical to the latest version.
 * Publishing does NOT assign the journey to any profile or enable the chat.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse, actorIdOf } from '@/lib/demoChatErrors';
import { publishJourney } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const POST = withAdminAuth(async (req, ctx, user) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await publishJourney(id, body, { actorId: actorIdOf(user) }), { status: 201 });
  } catch (e) { return errorResponse(e, 'admin/demo-chat/publish POST'); }
});
