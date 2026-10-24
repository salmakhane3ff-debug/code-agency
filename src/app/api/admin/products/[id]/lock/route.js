/**
 * /api/admin/products/[id]/lock
 * PATCH { locked: boolean } → { id, isLocked } — lock or open one product.
 * Locked: still listed in the storefront grids, but nobody can open or buy it.
 * Admin only. Bodies live in src/lib/productLockRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { productLockHandlers } from '@/lib/productLockRouteHandlers';

export const dynamic = 'force-dynamic';

const h = productLockHandlers();

export const PATCH = withAdminAuth(h.setLock);
