/**
 * /api/affiliate/payment-proofs
 * GET ?cursor= → one page of the GLOBAL payment-proof feed (same for every active
 *       affiliate): proofs published during the last 72 hours (server-side window),
 *       { proofs: [{ token, name, amount, publishedAt }], total, nextCursor }.
 * Active affiliates only.
 */
import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliatePaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = affiliatePaymentProofHandlers();
export const GET = withAffiliateAuth(h.list);
