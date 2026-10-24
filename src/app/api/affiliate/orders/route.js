/**
 * GET  /api/affiliate/orders          → affiliate's order list
 * PUT  /api/affiliate/orders          → update OWN order status (confirmed|cancelled);
 *                                        delivered/cancelled orders are locked
 */

import { withAffiliateAuth }                    from '@/lib/middleware/withAffiliateAuth';
import {
  getAffiliateOrders,
  updateAffiliateOrderStatus,
} from '@/lib/services/affiliateSystemService';

async function getHandler(req, _ctx, decoded) {
  try {
    const orders = await getAffiliateOrders(decoded.affiliateId);
    return Response.json(orders);
  } catch (err) {
    console.error('Affiliate orders GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

// Service error code → HTTP status. Ownership/eligibility live in the service.
const PUT_ERROR_STATUS = {
  INVALID_ID:      400,
  INVALID_STATUS:  400,
  ORDER_NOT_FOUND: 404, // also returned for another affiliate's order
  ORDER_LOCKED:    409, // delivered / cancelled / unknown status
};

async function putHandler(req, _ctx, decoded) {
  try {
    // Malformed JSON or a non-object body (null, array, string) → 400, not 500.
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Requête invalide' }, { status: 400 });
    }
    const { id, status } = body;

    if (!id) return Response.json({ error: 'id requis' }, { status: 400 });

    // Affiliate can only mark their OWN, still-editable orders confirmed or cancelled
    const order = await updateAffiliateOrderStatus(id, status, { affiliateId: decoded.affiliateId });
    return Response.json(order);
  } catch (err) {
    const httpStatus = PUT_ERROR_STATUS[err?.code];
    if (httpStatus) return Response.json({ error: err.message }, { status: httpStatus });
    console.error('Affiliate orders PUT error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

export const GET = withAffiliateAuth(getHandler);
export const PUT = withAffiliateAuth(putHandler);
