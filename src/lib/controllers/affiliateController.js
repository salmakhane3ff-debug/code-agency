/**
 * src/lib/controllers/affiliateController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET    /api/affiliate              → list all affiliates (admin)
 * POST   /api/affiliate              → create affiliate (admin)
 * PUT    /api/affiliate              → update affiliate (admin)
 * DELETE /api/affiliate              → delete affiliate (admin)
 * GET    /api/affiliate/[username]   → public affiliate info + record click
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getAllAffiliates,
  getAffiliateById as _getAffiliateById,
  getAffiliateByUsername,
  createAffiliate,
  updateAffiliate,
  deleteAffiliate,
  recordClick,
  getAffiliateStats,
} from '../services/affiliateService.js';
import { badRequest, notFound, serverError } from '../utils/apiResponse.js';
import { AFFILIATE_HAS_HISTORY } from '../affiliateDeletion.js';

// ── GET /api/affiliate ────────────────────────────────────────────────────────

export async function getAffiliatesHandler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (id) {
      const affiliate = await getAffiliateStats(id);
      if (!affiliate) return notFound('Affiliate not found');
      return Response.json(affiliate);
    }

    const affiliates = await getAllAffiliates();
    return Response.json(affiliates);
  } catch (err) {
    console.error('Affiliate GET error:', err);
    return serverError('Failed to fetch affiliates');
  }
}

// ── POST /api/affiliate ───────────────────────────────────────────────────────

export async function createAffiliateHandler(req) {
  try {
    const body = await req.json();
    const { username, userId, commissionRate } = body;

    if (!username) return badRequest('username is required');
    if (!userId)   return badRequest('userId is required');

    const affiliate = await createAffiliate({ username, userId, commissionRate });
    return Response.json(affiliate, { status: 201 });
  } catch (err) {
    if (err.code === 'P2002') {
      return badRequest('Username already taken');
    }
    console.error('Affiliate POST error:', err);
    return serverError('Failed to create affiliate');
  }
}

// ── PUT /api/affiliate ────────────────────────────────────────────────────────

export async function updateAffiliateHandler(req) {
  try {
    const body = await req.json();
    const { _id, id, ...rest } = body;
    const affiliateId = _id || id;

    if (!affiliateId) return badRequest('_id is required for update');

    const affiliate = await updateAffiliate(affiliateId, rest);
    if (!affiliate) return notFound('Affiliate not found');

    return Response.json(affiliate);
  } catch (err) {
    if (err.code === 'P2002') {
      return badRequest('Username already taken');
    }
    console.error('Affiliate PUT error:', err);
    return serverError('Failed to update affiliate');
  }
}

// ── DELETE /api/affiliate ─────────────────────────────────────────────────────

export async function deleteAffiliateHandler(req) {
  try {
    const body = await req.json();
    const { _id, id } = body;
    const affiliateId = _id || id;

    if (!affiliateId) return badRequest('_id is required for delete');

    const deleted = await deleteAffiliate(affiliateId);
    if (!deleted) return notFound('Affiliate not found');

    return Response.json({ message: 'Affiliate deleted', _id: affiliateId });
  } catch (err) {
    if (err?.code === AFFILIATE_HAS_HISTORY) {
      return Response.json({ error: err.message, code: err.code }, { status: 409 });
    }
    console.error('Affiliate DELETE error:', err);
    return serverError('Failed to delete affiliate');
  }
}

// ── GET /api/affiliate/[username] (public referral handler) ───────────────────

/**
 * Public endpoint called when a visitor follows a referral link.
 * 1. Looks up the affiliate by username.
 * 2. Records a click (with IP / UA / referer).
 * 3. Returns the affiliate details so the frontend can store affiliateId.
 */
export async function getAffiliateByUsernameHandler(req, context) {
  try {
    const { username } = await context.params;

    const affiliate = await getAffiliateByUsername(username);
    if (!affiliate) return notFound('Affiliate not found');

    // Record the click
    const ipAddress =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      null;
    const userAgent   = req.headers.get('user-agent') || null;
    const referer     = req.headers.get('referer')    || null;
    const { searchParams } = new URL(req.url);
    const landingPage = searchParams.get('lp') || null;

    await recordClick({
      affiliateId: affiliate.id,
      ipAddress,
      userAgent,
      referer,
      landingPage,
    });

    return Response.json({
      affiliateId: affiliate.id,
      username:    affiliate.username,
      name:        affiliate.user?.name || affiliate.username,
    });
  } catch (err) {
    console.error('Affiliate username GET error:', err);
    return serverError('Failed to process affiliate link');
  }
}
