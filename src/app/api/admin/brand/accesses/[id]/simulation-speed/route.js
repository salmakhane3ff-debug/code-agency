/**
 * /api/admin/brand/accesses/[id]/simulation-speed
 * GET → this brand's simulation speed (current / pending version, history, global defaults).
 * PUT { enabled, custom, hourMin, hourMax, dayMin, dayMax } → a new version from the next full hour
 *     (conflicting limits are refused with explicit codes). SIMULATED orders only — nothing financial.
 * Admin only. Bodies live in src/lib/brandRouteHandlers.js (testable).
 */

import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminBrandHandlers } from '@/lib/brandRouteHandlers';

export const dynamic = 'force-dynamic';

const h = adminBrandHandlers();

export const GET = withAdminAuth(h.getAccessSpeed);
export const PUT = withAdminAuth(h.saveAccessSpeed);
