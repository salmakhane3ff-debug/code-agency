/**
 * /api/recruiter/wallet/withdrawals  (Affiliate Recruiter System, Phase 5)
 * POST { amountMad, requestId } → a withdrawal request of the recruiter's OWN available
 *      rewards, through the existing withdrawal workflow (bank gate, reserved funds,
 *      the admin's payouts list). Never more than the available amount.
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterWalletHandlers } from '@/lib/recruiterWalletRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterWalletHandlers({ toRecruiterError });
export const POST = withRecruiterAuth(h.withdraw);
