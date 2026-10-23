/**
 * POST /api/admin/demo/reset
 * "Nouveau cycle": archives the current standings, zeroes the demo stats and
 * starts a new 30-day cycle. History is KEPT — deleting it is a separate action
 * (DELETE /api/admin/demo/history).
 */
import { resetCompetition } from '@/lib/services/demoService';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';

export const POST = withAdminAuth(async () => {
  try {
    const result = await resetCompetition();
    return Response.json(result);
  } catch (err) {
    console.error('admin/demo/reset error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});
