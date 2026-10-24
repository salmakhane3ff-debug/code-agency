/**
 * /api/admin/demo-chat/preview — 30-day timeline of a draft or a version (admin only)
 * POST → { journeyId, versionId? } ; writes nothing. Earnings use labelled SAMPLE values.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse } from '@/lib/demoChatErrors';
import { previewTimeline } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const POST = withAdminAuth(async (req) => {
  try {
    const body = await req.json().catch(() => null);
    return Response.json(await previewTimeline({ journeyId: body?.journeyId, versionId: body?.versionId }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/preview POST'); }
});
