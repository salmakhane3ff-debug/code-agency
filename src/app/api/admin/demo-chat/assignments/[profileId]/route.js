/**
 * /api/admin/demo-chat/assignments/:profileId — one demo profile's assignment (admin only, Phase 3C-9B)
 * PUT   → { versionId, anchorDate?, expectedUpdatedAt? } create (201, disabled) or reassign
 *         (revision + 1, disabled, earlier messages hidden)
 * PATCH → { enabled, expectedUpdatedAt } enable / disable this conversation
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { demoChatAssignmentHandlers } from '@/lib/demoChatAssignmentRoutes';

export const dynamic = 'force-dynamic';

const h = demoChatAssignmentHandlers();

export const PUT = withAdminAuth(h.assign);
export const PATCH = withAdminAuth(h.toggle);
