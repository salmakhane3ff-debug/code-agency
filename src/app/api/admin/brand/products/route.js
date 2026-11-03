/**
 * /api/admin/brand/products
 * GET  → store products for the "Create Your Own Brand" catalogue picker:
 *        id, name, first image, status flags, eligibility and whether each is in
 *        the catalogue. Read only — products are never written by this program.
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const GET = withAdminAuth(h.listProducts);
