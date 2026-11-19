/**
 * /api/affiliate/rewards/winners
 * GET → Recent Winners of the Rewards / Gifts page (newest first): accepted gift requests
 *       (masked names) + computed demo winners while the Demo Competition engine is ON.
 * Affiliate only, read only. Body in src/lib/services/recentWinnersService.js (testable).
 */

import { withAffiliateAuth } from '@/lib/middleware/withAffiliateAuth';
import { recentWinnersHandler } from '@/lib/services/recentWinnersService';

export const dynamic = 'force-dynamic';

export const GET = withAffiliateAuth(recentWinnersHandler());
