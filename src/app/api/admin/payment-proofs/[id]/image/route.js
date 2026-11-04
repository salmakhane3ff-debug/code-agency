/**
 * /api/admin/payment-proofs/[id]/image
 * GET → the receipt image of one proof (any status), streamed privately. Admin only.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminPaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = adminPaymentProofHandlers();
export const GET = withAdminAuth(h.image);
