/**
 * /api/admin/payment-proofs/validate
 * POST { items } → review of a bulk schedule before confirmation (nothing is written).
 * Admin only.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminPaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
const h = adminPaymentProofHandlers();
export const POST = withAdminAuth(h.validateBatch);
