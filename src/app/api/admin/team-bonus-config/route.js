/**
 * GET  /api/admin/team-bonus-config  → returns current config
 * POST /api/admin/team-bonus-config  → validates, then MERGES into the stored
 *                                       config (keys not sent — e.g. ugcGoal,
 *                                       securityDepositAmount — are kept)
 */

import { getTeamBonusConfig, saveTeamBonusConfig } from '@/lib/services/affiliateSystemService';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { validateTeamBonusConfigInput } from '@/lib/teamBonusConfigValidation';

export const GET = withAdminAuth(async () => {
  try {
    const config = await getTeamBonusConfig();
    return Response.json(config);
  } catch (err) {
    console.error('team-bonus-config GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});

export const POST = withAdminAuth(async (req) => {
  try {
    const body = await req.json().catch(() => null);
    const v = validateTeamBonusConfigInput(body);
    if (!v.ok) {
      return Response.json({ error: v.error, field: v.field }, { status: 400 });
    }

    const saved = await saveTeamBonusConfig(v.patch);
    return Response.json(saved);
  } catch (err) {
    console.error('team-bonus-config POST error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});
