/**
 * POST /api/admin/payout-banks/[id]/logo  multipart: logo=<PNG | JPG | WEBP, ≤ 2 MB>
 * (admin) → validated, re-encoded to a ≤ 256 px WebP and stored (public image).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { payoutBankHandlers } from '@/lib/services/payoutBankService';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = payoutBankHandlers();
export const POST = withAdminAuth(h.adminLogo);
