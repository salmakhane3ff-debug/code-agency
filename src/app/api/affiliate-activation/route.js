/**
 * /api/affiliate-activation  (Affiliate Recruiter System, Phase 6 part 1 — PUBLIC)
 * POST { code, password, passwordConfirm } → the affiliate sets their OWN password with the
 *      one-time code shared by their recruiter. Public by design (the person has no account
 *      session yet); rate-limited; never activates the account (admin approval unchanged).
 */
import { affiliateActivationHandlers } from '@/lib/affiliateActivationHandlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = affiliateActivationHandlers();
export const POST = h.redeem;
