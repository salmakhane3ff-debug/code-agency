/**
 * /api/admin/payment-proofs/[id]
 * PATCH { date, time, displayName?, amount?, privacyConfirmed, authenticityConfirmed } → edit before publication
 * POST  { action: 'cancel' }                  → cancel before publication (record kept)
 * Admin only.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminPaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
const h = adminPaymentProofHandlers();
export const PATCH = withAdminAuth(h.update);
export const POST = withAdminAuth(h.act);
