/**
 * /api/recruiter/wallet  (Affiliate Recruiter System, Phase 5)
 * GET → the recruiter's OWN wallet: reward settings (amount, threshold), earned / available /
 *       pending / paid (MAD cents), reward history, withdrawals, bank details.
 * Recruiter only (withRecruiterAuth + active account).
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterWalletHandlers } from '@/lib/recruiterWalletRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterWalletHandlers({ toRecruiterError });
export const GET = withRecruiterAuth(h.wallet);
