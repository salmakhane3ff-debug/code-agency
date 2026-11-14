/**
 * /api/admin/payout-banks  (admin — bank logo picker catalogue, Phase 4)
 * GET  → every bank (active or not) + how many users chose it
 * POST { name, isActive?, ribRequired?, sortOrder? } → create
 * There is no DELETE: a bank is deactivated (PATCH /[id] { isActive: false }).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { payoutBankHandlers } from '@/lib/services/payoutBankService';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = payoutBankHandlers();
export const GET = withAdminAuth(h.adminList);
export const POST = withAdminAuth(h.adminCreate);
