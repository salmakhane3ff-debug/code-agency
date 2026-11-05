/**
 * /api/admin/affiliate-orders
 * GET  → all affiliate orders (with affiliate info)
 * PUT  → update order status
 */

import {
  adminGetAllAffiliateOrders,
  adminUpdateAffiliateOrderStatus,
} from '@/lib/services/affiliateSystemService';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { onRecruiterOrderStatusCommitted } from '@/lib/recruiterRewardHooks';

async function getHandler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const source = (searchParams.get('source') || 'all').toLowerCase(); // all | real | fake

    const orders = await adminGetAllAffiliateOrders();
    let filtered = status ? orders.filter((o) => o.status === status) : orders;
    if (source === 'real') filtered = filtered.filter((o) => !o.isFake);
    else if (source === 'fake') filtered = filtered.filter((o) => o.isFake);
    return Response.json(filtered);
  } catch (err) {
    console.error('Admin affiliate-orders GET error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

async function putHandler(req) {
  try {
    const { id, _id, status } = await req.json();
    const orderId = id || _id;

    if (!orderId || !status) {
      return Response.json({ error: 'id et status requis' }, { status: 400 });
    }

    const order = await adminUpdateAffiliateOrderStatus(orderId, status);
    // Recruiter reward (post-commit, never throws): a REAL order just became 'delivered'.
    if (status === 'delivered') await onRecruiterOrderStatusCommitted(String(orderId));
    return Response.json(order);
  } catch (err) {
    console.error('Admin affiliate-orders PUT error:', err);
    return Response.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}

export const GET = withAdminAuth(getHandler);
export const PUT = withAdminAuth(putHandler);
