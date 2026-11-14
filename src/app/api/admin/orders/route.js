/**
 * /api/admin/orders
 * GET ?page=&pageSize=10|100&q=&status=&source=ALL|REAL|FAKE&sort=desc|asc
 *   → { items, total, overall, page, pageSize, pages } — ONE page of the admin store orders,
 *     filtered and ordered on the server (createdAt, then id). Used by /admin/orders.
 * GET /api/order (the complete array, used by the other admin pages) is unchanged.
 * Admin only. Body lives in src/lib/services/adminOrdersListService.js (testable).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminOrdersHandlers } from '@/lib/services/adminOrdersListService';

export const dynamic = 'force-dynamic';
const h = adminOrdersHandlers();
export const GET = withAdminAuth(h.list);
