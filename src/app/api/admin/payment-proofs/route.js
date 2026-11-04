/**
 * /api/admin/payment-proofs
 * GET  → paged list of payment proofs (?status=&batchId=&page=) with status counts
 * POST → create ONE scheduled proof (multipart with the receipt image and the two mandatory
 *        declarations; idempotent per clientRef)
 * Admin only. Bodies live in src/lib/paymentProofRouteHandlers.js (testable).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminPaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = adminPaymentProofHandlers();
export const GET = withAdminAuth(h.list);
export const POST = withAdminAuth(h.create);
