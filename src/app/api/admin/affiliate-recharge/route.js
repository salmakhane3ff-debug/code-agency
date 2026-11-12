/**
 * /api/admin/affiliate-recharge
 * GET → the "Recharge de solde des Affiliés" switch: { enabled, isDefault, updatedAt, updatedBy, history, revision }
 * PUT { enabled: boolean, revision } → turn it ON / OFF (conflict-safe, history kept).
 * OFF hides the affiliate recharge UI and refuses NEW recharge requests; existing requests, balances,
 * Create Your Own Brand payments, commissions, rewards and payouts are not affected.
 * Admin only. Bodies live in src/lib/services/rechargeFeatureService.js (testable).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { rechargeSettingHandlers } from '@/lib/services/rechargeFeatureService';

export const dynamic = 'force-dynamic';
const h = rechargeSettingHandlers();
export const GET = withAdminAuth(h.get);
export const PUT = withAdminAuth(h.put);
