/**
 * /api/admin/demo-chat/audit — append-only audit trail (admin only, read-only)
 * GET ?entityType=journey|step|version&entityId=…&before=<ISO>&limit=1..200
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse } from '@/lib/demoChatErrors';
import { listAudit } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const GET = withAdminAuth(async (req) => {
  try {
    const q = new URL(req.url).searchParams;
    return Response.json(await listAudit({
      entityType: q.get('entityType') || undefined, entityId: q.get('entityId') || undefined,
      before: q.get('before') || undefined, limit: q.get('limit') || undefined,
    }));
  } catch (e) { return errorResponse(e, 'admin/demo-chat/audit GET'); }
});
