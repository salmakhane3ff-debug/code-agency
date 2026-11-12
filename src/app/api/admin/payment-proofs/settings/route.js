/**
 * /api/admin/payment-proofs/settings
 * GET → the global "Durée d'affichage des preuves de paiement" (72 h by default) + presets, history, revision
 * PUT { hours, revision } → save it (conflict-safe). It applies to proofs published from then on: each proof
 *     keeps the duration captured at its actual publication.
 * Admin only. Bodies live in src/lib/paymentProofRouteHandlers.js (testable).
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminPaymentProofHandlers } from '@/lib/paymentProofRouteHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = adminPaymentProofHandlers();
export const GET = withAdminAuth(h.getSettings);
export const PUT = withAdminAuth(h.saveSettings);
