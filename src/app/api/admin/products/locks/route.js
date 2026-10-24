/**
 * /api/admin/products/locks
 * GET → { lockedIds: string[] } — products currently locked on the storefront.
 * Admin only. Bodies live in src/lib/productLockRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { productLockHandlers } from '@/lib/productLockRouteHandlers';

export const dynamic = 'force-dynamic';

const h = productLockHandlers();

export const GET = withAdminAuth(h.listLocks);
