/**
 * /api/recruiter/wallet/bank  (Affiliate Recruiter System, Phase 5)
 * PUT { bankId, accountName, rib? } → save the recruiter's OWN bank details: a bank of the admin
 *     catalogue (Phase 4 — bank logo picker), the RIB only when that bank requires it
 *     (same fields and rules as the affiliate bank details).
 */
import { withRecruiterAuth } from '@/lib/middleware/withRecruiterAuth';
import { recruiterWalletHandlers } from '@/lib/recruiterWalletRouteHandlers';
import { toRecruiterError } from '@/lib/recruiterVisibility';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = recruiterWalletHandlers({ toRecruiterError });
export const PUT = withRecruiterAuth(h.bank);
