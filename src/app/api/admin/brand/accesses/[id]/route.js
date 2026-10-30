/**
 * /api/admin/brand/accesses/[id]
 * POST { action: 'accept-proof' }   → accept the payment proof (activates the access)
 * POST { action: 'reject', reason } → reject a request awaiting payment (and its proof)
 * POST { action: 'close', reason }  → close an active access (history stays read-only)
 * POST { action: 'reopen', reason } → reopen a closed access (new period from now)
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const POST = withAdminAuth(h.actOnAccess);
