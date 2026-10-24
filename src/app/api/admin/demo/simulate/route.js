/**
 * POST /api/admin/demo/simulate
 * Runs one simulation tick (add daily activity to all demo affiliates), under the
 * same advisory lock as the auto-simulation engine (409 while a tick is running).
 */
import { runManualSimTick } from '@/lib/services/demoService';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';

export const POST = withAdminAuth(async () => {
  try {
    const result = await runManualSimTick();
    if (result?.skipped === 'busy') return Response.json({ error: 'Simulation déjà en cours : réessayez dans un instant.', code: 'SIM_BUSY' }, { status: 409 });
    return Response.json(result);
  } catch (err) {
    console.error('admin/demo/simulate error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});
