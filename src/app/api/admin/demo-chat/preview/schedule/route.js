/**
 * /api/admin/demo-chat/preview/schedule — what a demo profile's chat would show
 * at a chosen moment (admin only, Phase 3C-4).
 * POST { journeyId, versionId?, demoAffiliateId, anchorDate, atDate?, atTime? | at?, locale? }
 * Read-only: no assignment, no message, no earnings-history write. Africa/Casablanca.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse } from '@/lib/demoChatErrors';
import { previewSchedule } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const POST = withAdminAuth(async (req) => {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== 'object') return Response.json({ error: 'Données invalides', code: 'VALIDATION' }, { status: 400 });
    return Response.json(await previewSchedule({
      journeyId: b.journeyId, versionId: b.versionId || undefined, demoAffiliateId: b.demoAffiliateId, anchorDate: b.anchorDate,
      at: b.at, atDate: b.atDate, atTime: b.atTime, locale: b.locale || 'ar',
    }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/preview/schedule POST'); }
});
