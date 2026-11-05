/**
 * /api/admin/affiliate-payouts
 * GET  → all payout requests (affiliate rows unchanged; recruiter rows — Affiliate Recruiter
 *        System, Phase 5 — carry ownerType 'recruiter' and the recruiter's name / bank)
 * PUT  → approve payout (mark as paid). Recruiter rows go through the recruiter service
 *        (pending only, audited) and also accept { action: 'reject', reason }.
 */

import {
  adminGetAllPayouts,
  adminApprovePayout,
} from '@/lib/services/affiliateSystemService';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { adminListRecruiterPayouts, recruiterPayoutOwner } from '@/lib/services/recruiterWalletService';
import { recruiterRewardAdminHandlers } from '@/lib/recruiterRewardAdminHandlers';

const recruiterAdmin = recruiterRewardAdminHandlers();

async function getHandler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');

    const [all, recruiterRows] = await Promise.all([adminGetAllPayouts(), adminListRecruiterPayouts()]);
    // Recruiter rows (affiliateId NULL) are shown with their recruiter's name / bank details.
    const byId = new Map(recruiterRows.map((r) => [r.id, r]));
    const payouts = all.map((p) => byId.get(p.id) ?? { ...p, ownerType: 'affiliate' });
    const filtered = status ? payouts.filter((p) => p.status === status) : payouts;
    return Response.json(filtered);
  } catch (err) {
    console.error('Admin affiliate-payouts GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

async function putHandler(req, _ctx, user) {
  try {
    const { id, _id, action, reason } = await req.json();
    const payoutId = id || _id;

    if (!payoutId) return Response.json({ error: 'id requis' }, { status: 400 });

    // Recruiter withdrawal: same "approve & mark paid" action (+ reject), audited.
    if (await recruiterPayoutOwner(String(payoutId))) {
      return recruiterAdmin.payoutAction(String(payoutId), action === 'reject' ? 'reject' : 'pay', user, reason);
    }
    if (action === 'reject') return Response.json({ error: 'Action non supportée pour ce retrait' }, { status: 400 });

    const result = await adminApprovePayout(payoutId);
    return Response.json(result);
  } catch (err) {
    console.error('Admin affiliate-payouts PUT error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
export const PUT = withAdminAuth(putHandler);
