/**
 * /api/spin-wheel-spin
 * POST              — execute a spin; returns winning segment (public — widget)
 * GET  ?admin=true  — analytics (admin — requires auth)
 * PATCH             — track additional events: view, click, reward_unlock, etc. (public — widget)
 */

import { getConfig, pickWinner, recordEvent, getAnalytics } from '@/lib/services/spinWheelConfigService.js';
import { serverError, badRequest } from '@/lib/utils/apiResponse.js';
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { lockedIdsAmong } from '@/lib/services/productLockService.js';

// Prototype pollution guard
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export async function POST(req) {
  try {
    const body = await req.json();
    const { sessionId, clickId } = body;
    if (!sessionId) return badRequest('sessionId required');

    const config = await getConfig();
    if (!config.isEnabled) return badRequest('Spin wheel is disabled');
    if (!config.segments.length) return badRequest('No segments configured');

    const ip        = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
                   || req.headers.get('x-real-ip') || null;
    const userAgent = req.headers.get('user-agent') || null;

    // Admin product lock: a product prize that is locked is never drawn (the
    // wheel still shows it; `index` below refers to the full segment list).
    const lockedPrizes = await lockedIdsAmong(
      config.segments.filter((s) => s.rewardType === 'product').map((s) => s.productId),
    );
    const drawable = config.segments.filter((s) => !(s.rewardType === 'product' && lockedPrizes.has(s.productId)));
    if (!drawable.length) return badRequest('No segments available');

    const winner = pickWinner(drawable);

    await recordEvent({
      sessionId,
      eventType:  'spin_win',
      segmentId:  winner.id,
      rewardType: winner.rewardType,
      couponCode: winner.rewardType === 'coupon' ? winner.couponCode : null,
      productId:  winner.rewardType === 'product' ? winner.productId : null,
      clickId:    clickId || null,
      ipAddress:  ip,
      userAgent,
    });

    return Response.json({
      segmentId:    winner.id,
      label:        winner.label,
      rewardType:   winner.rewardType,
      couponCode:   winner.couponCode || null,
      productId:    winner.productId  || null,
      minCartValue: winner.minCartValue,
      color:        winner.color,
      // position in segments array — used by frontend to calculate stop angle
      index:        config.segments.findIndex((s) => s.id === winner.id),
      total:        config.segments.length,
    });
  } catch (err) {
    console.error('SpinWheelSpin POST error:', err);
    return serverError('Spin failed');
  }
}

// GET analytics — admin only
async function _getAnalytics(_req) {
  try {
    const stats = await getAnalytics();
    return Response.json(stats);
  } catch (err) {
    console.error('SpinWheelSpin GET error:', err);
    return serverError('Failed to fetch analytics');
  }
}

export function GET(req) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get('admin') === 'true') {
    return withAdminAuth(_getAnalytics)(req);
  }
  return badRequest('Admin only');
}

// Track additional events (view, click, reward_unlock, coupon_used, spin_conversion)
// Only whitelisted fields are forwarded — no ...rest spreading to prevent prototype pollution
export async function PATCH(req) {
  try {
    const body = await req.json();

    if (!body || typeof body !== 'object') return badRequest('Invalid payload');

    // Block prototype pollution keys at the top level
    for (const key of Object.keys(body)) {
      if (BLOCKED_KEYS.has(key)) return badRequest('Invalid field: ' + key);
    }

    const { sessionId, eventType } = body;
    if (!sessionId || !eventType) return badRequest('sessionId + eventType required');

    // Whitelist only the fields recordEvent actually uses
    const allowed = {
      sessionId,
      eventType,
      segmentId:  body.segmentId  ?? null,
      rewardType: body.rewardType ?? null,
      couponCode: body.couponCode ?? null,
      productId:  body.productId  ?? null,
      clickId:    body.clickId    ?? null,
    };

    await recordEvent(allowed);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('SpinWheelSpin PATCH error:', err);
    return serverError('Failed to record event');
  }
}
