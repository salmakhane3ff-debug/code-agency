/**
 * /api/admin/demo-chat/status — state of the two chat gates (admin only, read-only)
 * Read-only; the switch is changed only via /api/admin/demo-chat/config (Phase 3C-9B).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { errorResponse } from '@/lib/demoChatErrors';
import { getChatStatus } from '@/lib/services/demoChatService';

export const dynamic = 'force-dynamic';

export const GET = withAdminAuth(async () => {
  try { return Response.json(await getChatStatus()); } catch (e) { return errorResponse(e, 'admin/demo-chat/status GET'); }
});
