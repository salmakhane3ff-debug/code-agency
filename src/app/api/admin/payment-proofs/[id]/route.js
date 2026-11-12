/**
 * /api/admin/payment-proofs/[id]
 * PATCH { date, time, displayName?, amount?, privacyConfirmed, authenticityConfirmed } → edit before publication
 * POST  { action: 'cancel' }                  → cancel before publication (record kept)
 * POST  { action: 'publish_now' }             → publish a scheduled proof now (same pipeline as the worker)
 * POST  { action: 'remove' }                → "Supprimer": hide it from every affiliate now (record + history kept)
 * Admin only.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminPaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
const h = adminPaymentProofHandlers();
export const PATCH = withAdminAuth(h.update);
export const POST = withAdminAuth(h.act);
