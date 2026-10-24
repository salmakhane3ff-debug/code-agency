/**
 * GET  /api/admin/affiliate-dashboard-config  → { depositBarEnabled, boosterBarEnabled }
 * POST /api/admin/affiliate-dashboard-config  → partial update (only the toggles sent)
 *
 * Visibility only — see src/lib/affiliateDashboardConfig.js.
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { validateAffiliateDashboardPatch } from '@/lib/affiliateDashboardConfig';
import {
  getAffiliateDashboardConfig,
  saveAffiliateDashboardConfig,
} from '@/lib/services/affiliateDashboardConfigService';

export const GET = withAdminAuth(async () => {
  try {
    return Response.json(await getAffiliateDashboardConfig());
  } catch (err) {
    console.error('affiliate-dashboard-config GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});

export const POST = withAdminAuth(async (req) => {
  try {
    const body = await req.json().catch(() => null);
    const v = validateAffiliateDashboardPatch(body);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
    return Response.json(await saveAffiliateDashboardConfig(v.patch));
  } catch (err) {
    console.error('affiliate-dashboard-config POST error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});
