/**
 * /api/admin/affiliates
 * GET    → list all affiliates with order/team counts
 * POST   → create new standalone affiliate
 * PUT    → update affiliate (commissionRate, isActive, name, password)
 * DELETE → delete affiliate
 */

import {
  adminGetAllAffiliates,
  adminCreateAffiliate,
  adminUpdateAffiliate,
  adminDeleteAffiliate,
} from '@/lib/services/affiliateSystemService';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { AFFILIATE_HAS_CHILDREN, AFFILIATE_HAS_HISTORY } from '@/lib/affiliateDeletion';

async function getHandler() {
  try {
    const affiliates = await adminGetAllAffiliates();
    return Response.json(affiliates);
  } catch (err) {
    console.error('Admin affiliates GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

async function postHandler(req) {
  try {
    const body = await req.json();
    const { name, username, password, commissionRate, parentId, goalOrders, goalValidReferrals } = body;

    if (!username || !password) {
      return Response.json({ error: 'username et password requis' }, { status: 400 });
    }

    const affiliate = await adminCreateAffiliate({ name, username, password, commissionRate, parentId, goalOrders, goalValidReferrals });
    return Response.json(affiliate, { status: 201 });
  } catch (err) {
    if (err.code === 'P2002') {
      return Response.json({ error: 'Ce nom d\'utilisateur est déjà pris' }, { status: 409 });
    }
    if (err.code === 'PARENT_NOT_FOUND') {
      return Response.json({ error: 'Affilié parent introuvable' }, { status: 400 });
    }
    console.error('Admin affiliates POST error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

async function putHandler(req, _ctx, user) {
  try {
    const body = await req.json();
    const { id, _id, ...data } = body;
    const affiliateId = id || _id;

    if (!affiliateId) return Response.json({ error: 'id requis' }, { status: 400 });
    // Phase 6 part 2: a password reset follows the affiliate policy (6–128 characters).
    if (typeof data.password === 'string' && data.password.trim() && (data.password.length < 6 || data.password.length > 128)) {
      return Response.json({ error: 'Le mot de passe doit contenir entre 6 et 128 caractères' }, { status: 400 });
    }

    const actorId = user?.userId ? String(user.userId) : user?.email ? String(user.email) : user?.id ? String(user.id) : null;
    const affiliate = await adminUpdateAffiliate(affiliateId, data, { actorId });
    return Response.json(affiliate);
  } catch (err) {
    console.error('Admin affiliates PUT error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

async function deleteHandler(req) {
  try {
    const { id, _id } = await req.json();
    const affiliateId = id || _id;

    if (!affiliateId) return Response.json({ error: 'id requis' }, { status: 400 });

    const deleted = await adminDeleteAffiliate(affiliateId);
    if (!deleted) return Response.json({ error: 'Affilié introuvable' }, { status: 404 });

    return Response.json({ ok: true, id: affiliateId });
  } catch (err) {
    // Referenced by points/orders/payouts, or (Phase 7 Stage F) still has children → clear 409, never the raw DB error.
    if (err?.code === AFFILIATE_HAS_HISTORY || err?.code === AFFILIATE_HAS_CHILDREN) {
      return Response.json({ error: err.message, code: err.code }, { status: 409 });
    }
    console.error('Admin affiliates DELETE error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

export const GET    = withAdminAuth(getHandler);
export const POST   = withAdminAuth(postHandler);
export const PUT    = withAdminAuth(putHandler);
export const DELETE = withAdminAuth(deleteHandler);
