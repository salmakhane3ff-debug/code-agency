/**
 * GET    /api/admin/demo/history  → archived competition cycles (newest first)
 * DELETE /api/admin/demo/history  → EXPLICIT deletion of the archived cycles and
 *                                   the demo earnings history (demo tables only).
 *                                   Requires { "confirm": "DELETE_HISTORY" }.
 */
import { listCompetitionHistory, clearCompetitionHistory } from '@/lib/services/demoService';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';

export const GET = withAdminAuth(async () => {
  try {
    return Response.json({ history: await listCompetitionHistory() });
  } catch (err) {
    console.error('admin/demo/history GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});

export const DELETE = withAdminAuth(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.confirm !== 'DELETE_HISTORY') {
      return Response.json({ error: 'Confirmation requise' }, { status: 400 });
    }
    return Response.json(await clearCompetitionHistory());
  } catch (err) {
    console.error('admin/demo/history DELETE error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});
