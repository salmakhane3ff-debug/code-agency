/**
 * PATCH /api/admin/payout-banks/[id] { name?, isActive?, ribRequired?, sortOrder? }
 * (admin). Deactivating keeps every user's saved details valid.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { payoutBankHandlers } from '@/lib/services/payoutBankService';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = payoutBankHandlers();
export const PATCH = withAdminAuth(h.adminUpdate);
