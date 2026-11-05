/**
 * /api/affiliate-activation/recovery  (Affiliate Recruiter System, Phase 6 part 1 — PUBLIC)
 * POST { identifier, message, contactPhone? } → an affiliate reports that their activation code
 *      was already used. ALWAYS 202 { ok:true } for a well-formed request (no enumeration);
 *      rate-limited. An admin reviews it in /admin/activation-recovery.
 */
import { activationRecoveryHandlers } from '@/lib/affiliateActivationRecoveryHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = activationRecoveryHandlers();
export const POST = h.request;
