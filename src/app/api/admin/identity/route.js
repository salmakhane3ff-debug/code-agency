/**
 * /api/admin/identity
 * GET → all identity verification requests (metadata only — NO document keys)
 * PUT → { id, action: 'approve'|'reject'|'reset', reason? }
 *
 * Admin-only (withAdminAuth). Documents themselves are streamed separately from
 * /api/admin/identity/[id]/[side].
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import {
  adminListIdentityVerifications,
  adminApproveIdentity,
  adminRejectIdentity,
  adminResetIdentity,
} from '@/lib/services/identityService';
import { onRecruiterIdentityApprovedCommitted } from '@/lib/recruiterRewardHooks';

export const dynamic = 'force-dynamic';

export const GET = withAdminAuth(async () => {
  try {
    const list = await adminListIdentityVerifications();
    return Response.json(list);
  } catch (err) {
    console.error('admin/identity GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});

export const PUT = withAdminAuth(async (req, _ctx, user) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { id, action, reason } = body;
    if (!id || !action) return Response.json({ error: 'id et action requis' }, { status: 400 });

    if (action === 'approve') {
      const adminId = user?.id || user?.email || user?.userId || null;
      const approved = await adminApproveIdentity(id, adminId);
      // Recruiter reward (post-commit, never throws): the affiliate's CIN is now APPROVED.
      await onRecruiterIdentityApprovedCommitted(String(id));
      return Response.json(approved);
    }
    if (action === 'reject') {
      return Response.json(await adminRejectIdentity(id, reason));
    }
    if (action === 'reset') {
      return Response.json(await adminResetIdentity(id));
    }
    return Response.json({ error: 'Action inconnue' }, { status: 400 });
  } catch (err) {
    if (err.code === 'REJECTION_REASON_REQUIRED') {
      return Response.json({ error: err.message, code: err.code }, { status: 400 });
    }
    console.error('admin/identity PUT error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
});
