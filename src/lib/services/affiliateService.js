/**
 * src/lib/services/affiliateService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate system service.
 *
 * Data model:
 *   Affiliate — one per user (role = AFFILIATE), identified by a unique username.
 *               Stores commission rate and denormalised counters.
 *   AffiliateClick — one row per referral link click.
 *
 * Affiliate referral URLs:  site.com/<username>  or  site.com?ref=<username>
 * Order attribution:        orders.affiliateId FK is set at checkout.
 * Commission calculation:   paymentTotal * commissionRate per order.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { deleteAffiliateSafely } from '../affiliateDeletion.js';
import { onAffiliateActivationCommitted } from '../rewardsHooks.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapAffiliate(a) {
  if (!a) return null;
  return {
    _id:            a.id,
    ...a,
    // Expose user profile if joined
    user: a.user
      ? { _id: a.user.id, name: a.user.name, email: a.user.email, role: a.user.role }
      : undefined,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** List all affiliates (admin). */
export async function getAllAffiliates() {
  const rows = await prisma.affiliate.findMany({
    include:  { user: true },
    orderBy:  { createdAt: 'desc' },
  });
  return rows.map(mapAffiliate);
}

/** Get a single affiliate by UUID id (admin). */
export async function getAffiliateById(id) {
  const row = await prisma.affiliate.findUnique({
    where:   { id },
    include: { user: true },
  });
  return mapAffiliate(row);
}

/**
 * Get an affiliate by username (public referral lookup).
 * Returns null when not found or inactive.
 */
export async function getAffiliateByUsername(username) {
  const row = await prisma.affiliate.findFirst({
    where:   { username, isActive: true },
    include: { user: { select: { id: true, name: true } } },
  });
  return mapAffiliate(row);
}

// ── Writes — Affiliate CRUD ───────────────────────────────────────────────────

/**
 * Create a new affiliate.
 * `userId` must point to an existing User with role AFFILIATE.
 */
export async function createAffiliate({ username, userId, commissionRate = 0.1 }) {
  if (!username || !userId) throw new Error('username and userId are required');

  // Promote the user to AFFILIATE role
  await prisma.user.update({
    where: { id: userId },
    data:  { role: 'AFFILIATE' },
  });

  const row = await prisma.affiliate.create({
    data: {
      username:       username.toLowerCase().trim(),
      userId,
      commissionRate: parseFloat(commissionRate) || 0.1,
    },
    include: { user: true },
  });
  return mapAffiliate(row);
}

/** Update affiliate settings (commission rate, isActive). */
export async function updateAffiliate(id, { commissionRate, isActive, username }, { db = prisma } = {}) {
  const data = {};
  if (commissionRate !== undefined) data.commissionRate = parseFloat(commissionRate);
  if (isActive       !== undefined) data.isActive       = Boolean(isActive);
  if (username       !== undefined) data.username       = username.toLowerCase().trim();

  try {
    const before = data.isActive === true
      ? await db.affiliate.findUnique({ where: { id }, select: { isActive: true } })
      : null;
    const row = await db.affiliate.update({
      where:   { id },
      data,
      include: { user: true },
    });
    // Rewards: signup bonus on the first inactive → active switch (post-commit, never throws).
    if (before) await onAffiliateActivationCommitted(id, { wasActive: before.isActive, isActive: row.isActive, db });
    return mapAffiliate(row);
  } catch (err) {
    if (err.code === 'P2025') return null;
    throw err;
  }
}

/** Delete an affiliate record. false = not found; throws AFFILIATE_HAS_HISTORY (→ 409) when referenced. */
export async function deleteAffiliate(id) {
  return deleteAffiliateSafely(prisma, id);
}

// ── Writes — Click tracking ───────────────────────────────────────────────────

/**
 * Record a referral click and increment the affiliate's click counter.
 * Returns the created AffiliateClick row.
 */
export async function recordClick({
  affiliateId,
  ipAddress    = null,
  userAgent    = null,
  source       = null,
  landingPage  = null,
  referer      = null,
}) {
  const exists = await prisma.affiliate.findUnique({ where: { id: affiliateId }, select: { id: true } });
  if (!exists) return null;

  const [click] = await prisma.$transaction([
    prisma.affiliateClick.create({
      data: { affiliateId, ipAddress, userAgent, source: source || null, landingPage, referer },
    }),
    prisma.affiliate.update({
      where: { id: affiliateId },
      data:  { totalClicks: { increment: 1 } },
    }),
  ]);
  return click;
}

// ── Writes — Commission updates ───────────────────────────────────────────────

/**
 * Called when an order is confirmed/paid.
 * Increments totalOrders + totalCommission on the affiliate.
 */
export async function creditCommission({ affiliateId, orderTotal, commissionRate }) {
  const commission = (parseFloat(orderTotal) || 0) * (parseFloat(commissionRate) || 0);
  await prisma.affiliate.update({
    where: { id: affiliateId },
    data: {
      totalOrders:     { increment: 1 },
      totalCommission: { increment: commission },
    },
  });
  return commission;
}

// ── Reads — Stats ─────────────────────────────────────────────────────────────

/**
 * Dashboard stats for a single affiliate.
 */
export async function getAffiliateStats(affiliateId) {
  const [affiliate, recentClicks, recentOrders] = await Promise.all([
    prisma.affiliate.findUnique({ where: { id: affiliateId }, include: { user: true } }),
    prisma.affiliateClick.findMany({
      where:   { affiliateId },
      orderBy: { createdAt: 'desc' },
      take:    20,
    }),
    prisma.order.findMany({
      where:   { affiliateId },
      orderBy: { createdAt: 'desc' },
      take:    20,
      select:  { id: true, sessionId: true, status: true, paymentTotal: true, createdAt: true },
    }),
  ]);

  return {
    affiliate:    mapAffiliate(affiliate),
    recentClicks,
    recentOrders: recentOrders.map((o) => ({ ...o, _id: o.id })),
  };
}
