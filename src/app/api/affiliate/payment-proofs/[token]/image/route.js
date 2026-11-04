/**
 * /api/affiliate/payment-proofs/[token]/image
 * GET → the receipt of a proof that is visible RIGHT NOW (published, < 72 h);
 *       scheduled, cancelled, failed or older proofs → 404. Active affiliates only.
 */
import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { affiliatePaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = affiliatePaymentProofHandlers();
export const GET = withAffiliateAuth(h.image);
