/**
 * /api/admin/demo-chat/journeys — scripted DEMO chat journeys (admin only, Phase 3C-2)
 * GET  → list (status, step count, latest version)
 * POST → create a draft journey { name, description? }
 * Simulation only: demo_chat_* tables, never real affiliates, orders or money.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse, actorIdOf } from '@/lib/demoChatErrors';
import { listJourneys, createJourney } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const GET = withAdminAuth(async () => {
  try { return Response.json(await listJourneys()); } catch (e) { return errorResponse(e, 'admin/demo-chat/journeys GET'); }
});

export const POST = withAdminAuth(async (req, ctx, user) => {
  try {
    const body = await req.json().catch(() => null);
    return Response.json(await createJourney(body, { actorId: actorIdOf(user) }), { status: 201 });
  } catch (e) { return errorResponse(e, 'admin/demo-chat/journeys POST'); }
});
