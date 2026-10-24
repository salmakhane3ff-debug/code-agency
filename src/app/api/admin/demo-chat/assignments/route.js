/**
 * /api/admin/demo-chat/assignments — DEMO Mini Chat assignments (admin only, Phase 3C-9B)
 * GET ?q=&status=active|all → demo profiles + current assignment, assignable published
 *     versions, gate states, Casablanca anchor range. Body: src/lib/demoChatAssignmentRoutes.js.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { demoChatAssignmentHandlers } from '@/lib/demoChatAssignmentRoutes';

export const dynamic = 'force-dynamic';

const h = demoChatAssignmentHandlers();

export const GET = withAdminAuth(h.list);
