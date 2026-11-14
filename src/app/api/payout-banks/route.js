/**
 * GET /api/payout-banks → the ACTIVE bank catalogue for the affiliate / recruiter bank
 * picker: [{ id, name, logoUrl, isActive, ribRequired }] (names + public logos only).
 */
import { payoutBankHandlers } from '@/lib/services/payoutBankService';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const h = payoutBankHandlers();
export const GET = h.publicList;
