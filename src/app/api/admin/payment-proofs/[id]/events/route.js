/**
 * /api/admin/payment-proofs/[id]/events
 * GET → the append-only audit history of one payment proof. Admin only.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminPaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
const h = adminPaymentProofHandlers();
export const GET = withAdminAuth(h.events);
