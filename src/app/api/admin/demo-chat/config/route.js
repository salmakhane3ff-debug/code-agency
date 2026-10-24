/**
 * /api/admin/demo-chat/config — global protected switch "demo-chat-config" (admin only, Phase 3C-9B)
 * GET   → { env, setting, enabled, confirmation }
 * PATCH → { enabled: true, confirm: "ACTIVER" } (requires DEMO_CHAT_ENABLED=true) | { enabled: false } (always allowed)
 * The generic /api/setting route refuses this row; this is its only writer.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { demoChatAssignmentHandlers } from '@/lib/demoChatAssignmentRoutes';

export const dynamic = 'force-dynamic';

const h = demoChatAssignmentHandlers();

export const GET = withAdminAuth(h.config);
export const PATCH = withAdminAuth(h.setConfig);
