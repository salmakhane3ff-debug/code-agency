/**
 * src/lib/services/affiliateSystemService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Complete business logic for the new Affiliate Platform.
 * Independent from the old affiliateService.js — no shared state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma                            from '../prisma.js';
import { hashPassword, comparePassword, signToken } from './authService.js';
import {
  registerBalanceProvider, computeRegisteredBalance, BALANCE_PRIORITY,
} from '../balance/providerRegistry.js';
import { serializeAmount, toDecimal } from '../balance/composeBalance.js';
import { deleteAffiliateSafely } from '../affiliateDeletion.js';
// Rewards points (separate currency) — post-commit hooks only; they never throw.
import { onAffiliateOrderStatusCommitted, onAffiliateActivationCommitted } from '../rewardsHooks.js';
// ── TEMPORARY WIRING (refinement #1) ──────────────────────────────────────────
// Provider registration currently happens as a side effect of importing the
// services that own each balance component: importing ugcEarningsService here
// registers the 'ugc_earning' provider, and this module registers the referral
// providers below. This keeps the composed balance complete regardless of entry
// point, but the wiring is implicit.
// TODO: replace this with a dedicated balance bootstrap module
//   (e.g. src/lib/balance/bootstrap.js) that explicitly imports every component
//   service and owns ALL provider registration in one place — so no service
//   imports another purely to trigger a registration side effect.
import '../services/ugcEarningsService.js';

// ── Balance component functions (business rules live here) ────────────────────
// Which statuses count toward the balance is decided in THESE named functions;
// the providers below are thin adapters that only expose the final component.
// Values/signs are identical to the legacy formula (earned + bonus − paid);
// balanceEquivalence.test.mjs proves no-UGC affiliates keep the exact value.

/** Σ delivered referral commissions (read-only). */
export async function getReferralCommissionComponent(affiliateId, db = prisma) {
  const r = await db.affiliateOrder.aggregate({
    where: { affiliateId, status: 'delivered' }, _sum: { commissionAmount: true },
  });
  return r._sum.commissionAmount ?? 0;
}

/** Affiliate team-bonus balance (read-only). */
export async function getReferralBonusComponent(affiliateId, db = prisma) {
  const a = await db.affiliate.findUnique({ where: { id: affiliateId }, select: { bonusBalance: true } });
  return a?.bonusBalance ?? 0;
}

/**
 * Payout statuses that RELEASE a reservation — the money goes back to the
 * affiliate. EVERYTHING ELSE reserves (pending, processing, paid, and any
 * future/unknown status): failing closed is the money-safe default, since a
 * status we do not recognise must never silently free funds.
 */
export const PAYOUT_RELEASING_STATUSES = Object.freeze(['rejected', 'cancelled', 'canceled', 'refused']);

/**
 * Σ RESERVED payouts as a NEGATIVE deduction component (read-only):
 * paid + pending + processing. A pending request therefore reserves the
 * earnings immediately, so it can be neither withdrawn a second time nor spent
 * on a booster while it waits. Rejected/cancelled rows release the reservation.
 */
export async function getPayoutDeductionComponent(affiliateId, db = prisma) {
  const p = await db.affiliatePayout.aggregate({
    where: { affiliateId, status: { notIn: PAYOUT_RELEASING_STATUSES } },
    _sum: { amount: true },
  });
  return -(p._sum.amount ?? 0);
}

/** Σ payouts reserved but NOT yet paid out ("Montant en attente de paiement"). */
export async function getPendingPayoutTotal(affiliateId, db = prisma) {
  const p = await db.affiliatePayout.aggregate({
    where: { affiliateId, status: { notIn: [...PAYOUT_RELEASING_STATUSES, 'paid'] } },
    _sum: { amount: true },
  });
  return serializeAmount(toDecimal(p._sum.amount ?? 0));
}

/**
 * Σ APPROVED balance top-ups ("💰 Dépôt de solde") as a POSITIVE component
 * (read-only). The former "security deposit" is now a normal balance recharge:
 * an admin-validated deposit credits "Solde disponible" directly (explicit
 * product decision, 2026-08-01 — supersedes the old isolation rule). Same
 * admin-validation workflow; PENDING/REJECTED rows never count. Priority 25 —
 * an earning-side slot between the bonus (20) and deductions (30+).
 */
export async function getDepositTopupComponent(affiliateId, db = prisma) {
  const d = await db.affiliateSecurityDeposit.aggregate({
    where: { affiliateId, status: 'APPROVED' }, _sum: { amount: true },
  });
  return d._sum.amount ?? 0;
}

/**
 * Σ ACTIVE, BALANCE-paid Starter Booster purchases as a NEGATIVE deduction
 * (read-only). CARD-paid purchases never touch the balance. Priority 50 — the
 * documented free "new deduction" slot; no separate wallet exists anywhere.
 */
export async function getBoosterDeductionComponent(affiliateId, db = prisma) {
  const b = await db.affiliateBoosterPurchase.aggregate({
    where: { affiliateId, paymentMethod: 'BALANCE', status: 'ACTIVE' }, _sum: { price: true },
  });
  return -(b._sum.price ?? 0);
}

// Thin adapters — pure wiring, no logic (see providerRegistry read-only contract).
registerBalanceProvider({ source: 'referral_commission', priority: BALANCE_PRIORITY.REFERRAL_COMMISSION, compute: getReferralCommissionComponent });
registerBalanceProvider({ source: 'referral_bonus',      priority: BALANCE_PRIORITY.REFERRAL_BONUS,      compute: getReferralBonusComponent });
registerBalanceProvider({ source: 'deposit_topup',       priority: 25,                                   compute: getDepositTopupComponent });
registerBalanceProvider({ source: 'payout_deduction',    priority: BALANCE_PRIORITY.PAYOUT_DEDUCTION,    compute: getPayoutDeductionComponent });
registerBalanceProvider({ source: 'booster_purchase',    priority: 50,                                   compute: getBoosterDeductionComponent });

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapAffiliate(a) {
  if (!a) return null;
  return {
    _id:                 a.id,
    id:                  a.id,
    username:            a.username,
    name:                a.name,
    phone:               a.phone     || null,
    avatarUrl:           a.avatarUrl || null,
    commissionRate:      a.commissionRate,
    isActive:            a.isActive,
    bankName:            a.bankName,
    rib:                 a.rib,
    accountName:         a.accountName,
    parentId:            a.parentId,
    totalClicks:         a.totalClicks,
    totalOrders:         a.totalOrders,
    totalCommission:     a.totalCommission,
    referralStatus:      a.referralStatus      ?? 'pending',
    deliveredOrdersCount:a.deliveredOrdersCount ?? 0,
    generatedRevenue:    a.generatedRevenue     ?? 0,
    teamBonusClaimed:    a.teamBonusClaimed     ?? false,
    bonusBalance:        a.bonusBalance         ?? 0,
    goalOrders:          a.goalOrders           ?? null,
    goalValidReferrals:  a.goalValidReferrals   ?? null,
    createdAt:           a.createdAt,
  };
}

function mapOrder(o, rawData = null) {
  // Accept either a plain array (legacy) or { items, shippingAddress } object
  const rawItems     = Array.isArray(rawData) ? rawData : (rawData?.items     || []);
  const shippingAddr = Array.isArray(rawData) ? null    : (rawData?.shippingAddress || null);

  // Build structured orderItems from Order.items (if fetched)
  const orderItems = rawItems.map((item) => {
    const snap = (item.productSnapshot && typeof item.productSnapshot === 'object')
      ? item.productSnapshot
      : {};
    // images can be an array or a single string depending on how snapshot was saved
    const rawImages = snap.images;
    const productImage = Array.isArray(rawImages)
      ? (rawImages[0] || null)
      : (typeof rawImages === 'string' ? rawImages : null);
    return {
      productName:  snap.title || o.productTitle || 'Produit',
      productImage,
      quantity:     item.quantity || 1,
      price:        item.price    || 0,
    };
  });
  const totalItems = orderItems.reduce((s, i) => s + i.quantity, 0);

  return {
    _id:             o.id,
    id:              o.id,
    affiliateId:     o.affiliateId,
    orderId:         o.orderId,
    clientName:      o.clientName,
    clientPhone:     o.clientPhone,
    productTitle:    o.productTitle,
    total:           o.total,
    commissionAmount:o.commissionAmount,
    status:          o.status,
    ipAddress:       o.ipAddress,
    isSuspicious:    o.isSuspicious,
    suspicionReason: o.suspicionReason,
    createdAt:       o.createdAt,
    orderItems,
    totalItems,
    shippingAddress: shippingAddr,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Login with username + password.
 * Returns { token, affiliate } or throws.
 */
export async function loginAffiliate(username, password) {
  const input = username.toLowerCase().trim();
  // Accept login by username OR phone number
  const affiliate = await prisma.affiliate.findFirst({
    where: { OR: [{ username: input }, { phone: input }] },
  });

  if (!affiliate) throw Object.assign(new Error('Identifiant ou mot de passe incorrect'), { code: 'INVALID_CREDENTIALS' });
  if (!affiliate.isActive) throw Object.assign(new Error('Compte inactif. Contactez l\'administrateur.'), { code: 'INACTIVE' });

  const valid = await comparePassword(password, affiliate.password);
  if (!valid)  throw Object.assign(new Error('Identifiant ou mot de passe incorrect'), { code: 'INVALID_CREDENTIALS' });

  const token = signToken({ affiliateId: affiliate.id, username: affiliate.username, type: 'affiliate' });
  return { token, affiliate: mapAffiliate(affiliate) };
}

// ── Profile ───────────────────────────────────────────────────────────────────

export async function getAffiliateById(id) {
  const a = await prisma.affiliate.findUnique({ where: { id } });
  return mapAffiliate(a);
}

export async function updateAffiliateBank(id, { bankName, rib, accountName }) {
  const a = await prisma.affiliate.update({
    where: { id },
    data:  { bankName, rib, accountName },
  });
  return mapAffiliate(a);
}

export async function updateAffiliateProfile(id, data) {
  const update = {};
  if (data.name      !== undefined) update.name      = data.name;
  if (data.isActive  !== undefined) update.isActive  = Boolean(data.isActive);
  if (data.commissionRate !== undefined) update.commissionRate = parseFloat(data.commissionRate);
  if (data.password  !== undefined && data.password.trim()) {
    update.password = await hashPassword(data.password);
  }

  // Avatar URL — freely updatable
  if (data.avatarUrl !== undefined) update.avatarUrl = data.avatarUrl || null;

  // Phone is set-once: only update if currently null/empty
  if (data.phone !== undefined && data.phone.trim()) {
    const current = await prisma.affiliate.findUnique({ where: { id }, select: { phone: true } });
    if (!current?.phone) {
      update.phone = data.phone.trim();
    }
  }

  const a = await prisma.affiliate.update({ where: { id }, data: update });
  return mapAffiliate(a);
}

// ── Validate ref (public) ─────────────────────────────────────────────────────

export async function validateAffiliateRef(username) {
  const a = await prisma.affiliate.findFirst({
    where: { username: username.toLowerCase().trim(), isActive: true },
  });
  if (!a) return null;
  return { affiliateId: a.id, username: a.username, name: a.name };
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function getAffiliateOrders(affiliateId) {
  const affOrders = await prisma.affiliateOrder.findMany({
    where:   { affiliateId },
    orderBy: { createdAt: 'desc' },
  });

  // Bulk-fetch linked Order items (one extra query — avoids N+1)
  const orderIds = affOrders.map((o) => o.orderId).filter(Boolean);
  const itemsByOrderId = {};
  if (orderIds.length > 0) {
    const linkedOrders = await prisma.order.findMany({
      where:  { id: { in: orderIds } },
      select: {
        id:              true,
        shippingAddress: true,
        items: {
          select: { quantity: true, price: true, productSnapshot: true },
        },
      },
    });
    for (const lo of linkedOrders) {
      itemsByOrderId[lo.id] = { items: lo.items, shippingAddress: lo.shippingAddress };
    }
  }

  console.log('[Affiliate] getAffiliateOrders | count:', affOrders.length, '| with items:', orderIds.length);
  return affOrders.map((o) => mapOrder(o, itemsByOrderId[o.orderId] || null));
}

/**
 * Record an affiliate order (called after checkout order creation).
 * Creates AffiliateOrder + AffiliateNotification + links Order.affiliateId.
 * Returns null if affiliate not found.
 * Accepts either `affiliateId` (direct FK) or `username` (fallback lookup).
 */
export async function recordAffiliateOrder({ username, affiliateId, orderId, clientName, clientPhone, productTitle, total, ipAddress, isFake = false }) {
  // Look up affiliate — prefer affiliateId for accuracy, fall back to username
  let affiliate = null;
  if (affiliateId?.trim()) {
    affiliate = await prisma.affiliate.findFirst({
      where: { id: affiliateId.trim(), isActive: true },
    });
  }
  if (!affiliate && username?.trim()) {
    affiliate = await prisma.affiliate.findFirst({
      where: { username: username.toLowerCase().trim(), isActive: true },
    });
  }
  if (!affiliate) return null;

  const commissionAmount = parseFloat((total * affiliate.commissionRate).toFixed(2));
  const since1h = new Date(Date.now() - 60 * 60 * 1000);

  // ── Fraud detection (parallel lookups, no blocking) ───────────────────────
  const reasons = [];

  const [ipCount, phoneCount, nameCount, affiliateCount] = await Promise.all([
    // Same IP in last hour
    ipAddress
      ? prisma.affiliateOrder.count({
          where: { ipAddress, createdAt: { gte: since1h } },
        })
      : Promise.resolve(0),
    // Same phone number ever
    clientPhone?.trim()
      ? prisma.affiliateOrder.count({
          where: { clientPhone: clientPhone.trim() },
        })
      : Promise.resolve(0),
    // Same client name in last 24h
    clientName?.trim()
      ? prisma.affiliateOrder.count({
          where: {
            clientName: { equals: clientName.trim(), mode: 'insensitive' },
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        })
      : Promise.resolve(0),
    // Same affiliate: more than 10 orders in last hour
    prisma.affiliateOrder.count({
      where: { affiliateId: affiliate.id, createdAt: { gte: since1h } },
    }),
  ]);

  if (ipAddress && ipCount >= 3)  reasons.push('Duplicate IP');
  if (clientPhone && phoneCount >= 1) reasons.push('Repeated phone');
  if (clientName && nameCount >= 2)  reasons.push('Repeated name');
  if (affiliateCount >= 10)          reasons.push('High frequency orders');

  const isSuspicious    = reasons.length > 0;
  const suspicionReason = isSuspicious ? reasons.join(', ') : null;

  const [affOrder] = await prisma.$transaction([
    prisma.affiliateOrder.create({
      data: {
        affiliateId:      affiliate.id,
        orderId:          orderId      || null,
        clientName:       clientName   || '',
        clientPhone:      clientPhone  || null,
        productTitle:     productTitle || '',
        total:            parseFloat(total) || 0,
        commissionAmount,
        status:           'pending',
        ipAddress:        ipAddress    || null,
        isSuspicious,
        suspicionReason,
        isFake:           Boolean(isFake),
      },
    }),
    prisma.affiliateNotification.create({
      data: {
        affiliateId: affiliate.id,
        message:     `Nouvelle commande: ${Number(total).toFixed(0)} MAD - Client: ${clientName || 'Inconnu'}${isSuspicious ? ' ⚠' : ''}`,
      },
    }),
    prisma.affiliate.update({
      where: { id: affiliate.id },
      data:  { totalOrders: { increment: 1 }, totalCommission: { increment: commissionAmount } },
    }),
  ]);

  // Link the main Order record to this affiliate (fire-and-forget, non-blocking)
  if (orderId) {
    prisma.order.update({
      where: { id: orderId },
      data:  { affiliateId: affiliate.id },
    }).catch(() => {}); // Don't fail if order ID doesn't exist
  }

  return mapOrder(affOrder);
}

/**
 * When an AffiliateOrder becomes "delivered":
 *  - increment deliveredOrdersCount
 *  - add order total to generatedRevenue
 *  - flip referralStatus to "active" once deliveredOrdersCount >= 1
 */
async function activateReferralIfDelivered(affiliateId, orderTotal = 0, db = prisma) {
  const updated = await db.affiliate.update({
    where:  { id: affiliateId },
    data:   {
      deliveredOrdersCount: { increment: 1 },
      generatedRevenue:     { increment: parseFloat(orderTotal) || 0 },
    },
    select: { deliveredOrdersCount: true, referralStatus: true },
  });
  if (updated.deliveredOrdersCount >= 1 && updated.referralStatus !== 'active') {
    await db.affiliate.update({
      where: { id: affiliateId },
      data:  { referralStatus: 'active' },
    });
  }
}

/** Statuses an affiliate may set on their own order. */
export const AFFILIATE_SETTABLE_ORDER_STATUSES = Object.freeze(['confirmed', 'cancelled']);

/**
 * Statuses an affiliate's order may be changed FROM. An allowlist (not a
 * blocklist) so it fails closed: 'delivered', 'cancelled' and any unknown or
 * differently-cased value (e.g. an admin-typed 'Delivered') are locked.
 */
export const AFFILIATE_EDITABLE_ORDER_STATUSES = Object.freeze(['pending', 'confirmed', 'shipped']);

/**
 * Affiliate-initiated status change (PUT /api/affiliate/orders).
 *
 * Ownership and eligibility are enforced in ONE conditional write: the WHERE
 * clause matches only the caller's own order in an editable status, so a
 * concurrent admin "delivered" update can never be overwritten. Another
 * affiliate's order and a missing id both report ORDER_NOT_FOUND, so the
 * response never reveals that someone else's order exists.
 *
 * Admin status changes go through adminUpdateAffiliateOrderStatus instead.
 */
export async function updateAffiliateOrderStatus(affiliateOrderId, status, { affiliateId, db = prisma } = {}) {
  if (typeof affiliateId !== 'string' || !affiliateId.trim()) {
    throw Object.assign(new Error('Affilié requis'), { code: 'AFFILIATE_REQUIRED' });
  }
  if (typeof affiliateOrderId !== 'string' || !affiliateOrderId.trim()) {
    throw Object.assign(new Error('id requis'), { code: 'INVALID_ID' });
  }
  if (!AFFILIATE_SETTABLE_ORDER_STATUSES.includes(status)) {
    throw Object.assign(new Error('Statut non autorisé'), { code: 'INVALID_STATUS' });
  }

  const result = await db.affiliateOrder.updateMany({
    where: { id: affiliateOrderId, affiliateId, status: { in: [...AFFILIATE_EDITABLE_ORDER_STATUSES] } },
    data:  { status },
  });

  if (result.count === 0) {
    const own = await db.affiliateOrder.findFirst({
      where:  { id: affiliateOrderId, affiliateId },
      select: { id: true },
    });
    if (!own) throw Object.assign(new Error('Commande introuvable'), { code: 'ORDER_NOT_FOUND' });
    throw Object.assign(new Error('Cette commande ne peut plus être modifiée'), { code: 'ORDER_LOCKED' });
  }

  // Re-read scoped to the caller, never by id alone.
  const order = await db.affiliateOrder.findFirst({ where: { id: affiliateOrderId, affiliateId } });
  if (!order) throw Object.assign(new Error('Commande introuvable'), { code: 'ORDER_NOT_FOUND' });
  return mapOrder(order);
}

/**
 * Propagate a store Order's status change to its linked AffiliateOrder, reusing
 * the SAME delivery-credit path as real orders (activateReferralIfDelivered) so
 * the wallet / commission / ranking all update through the existing engine — no
 * second commission logic. Idempotent: only a genuine transition INTO 'delivered'
 * credits, so re-saving 'delivered' never double-counts.
 *
 * Used by the Fake Orders Engine sync (orderService.updateOrder) so an admin can
 * drive a fake order NEW→CONFIRMED→SHIPPED→DELIVERED from the normal Orders page.
 * Also emits a status-change AffiliateNotification via the EXISTING notification
 * table so the affiliate is notified exactly like a real event.
 *
 * @returns {Promise<{synced:boolean, delivered?:boolean}>}
 */
export async function syncLinkedAffiliateOrderStatus(orderId, rawStatus, { notify = true, db = prisma } = {}) {
  if (!orderId) return { synced: false };
  const status = String(rawStatus || '').toLowerCase();
  const linked = await db.affiliateOrder.findFirst({
    where:  { orderId },
    select: { id: true, affiliateId: true, total: true, status: true, clientName: true },
  });
  if (!linked) return { synced: false };
  if (linked.status === status) return { synced: false }; // no change → nothing to do

  await db.affiliateOrder.update({ where: { id: linked.id }, data: { status } });

  const becameDelivered = status === 'delivered' && linked.status !== 'delivered';
  if (becameDelivered) {
    await activateReferralIfDelivered(linked.affiliateId, linked.total, db).catch(() => {});
  }

  if (notify) {
    const label = {
      confirmed: 'confirmée', shipped: 'expédiée', delivered: 'livrée',
      cancelled: 'annulée',   pending: 'en attente',
    }[status] || status;
    await db.affiliateNotification.create({
      data: {
        affiliateId: linked.affiliateId,
        message:     `Commande ${label}: ${Number(linked.total).toFixed(0)} MAD - Client: ${linked.clientName || 'Inconnu'}`,
      },
    }).catch(() => {});
  }

  // Rewards: after the status write committed (deferred if `db` is a tx client).
  await onAffiliateOrderStatusCommitted(linked.id, { db });

  return { synced: true, delivered: becameDelivered };
}

// ── Payouts ───────────────────────────────────────────────────────────────────

/**
 * Get affiliate's available balance:
 *   balance = sum(commissionAmount for delivered orders) - sum(paid payouts)
 *
 * @param {string} affiliateId
 * @param {object} [db=prisma]  — pass a Prisma transaction client for atomic reads
 */
/**
 * Available balance = sum of all registered balance providers (referral
 * commission + bonus − payouts + UGC earnings + any future source), composed
 * exactly in Decimal and serialized to a Number at this boundary.
 *
 * Providers are read-only, so passing a transaction handle (`db`) keeps the read
 * inside the caller's transaction (e.g. requestPayout's Serializable tx) exactly
 * as before. Return type is unchanged (Number), so every caller is unaffected.
 */
export async function getAffiliateBalance(affiliateId, db = prisma) {
  return serializeAmount(await computeRegisteredBalance(affiliateId, db));
}

// ── Two-component accounting: earnings (withdrawable) vs top-up (spend-only) ──
// ONE wallet, one total (the provider registry above), but two server-side
// components. Booster purchases consume the TOP-UP first and snapshot the split
// on the purchase row (paidFromTopup / paidFromEarnings) — attribution is fixed
// at purchase time, so a later top-up can never retroactively free up spent
// earnings. Withdrawals are validated against the EARNINGS component only.

/**
 * Decimal sums of how much ACTIVE BALANCE-paid boosters consumed from each
 * component. Legacy rows (created before the split existed: both fields 0 with
 * a positive price) count as EARNINGS-paid — conservative: it can only reduce
 * the withdrawable side, never unlock top-up money.
 */
export async function getBoosterSpendSplit(affiliateId, db = prisma) {
  const rows = await db.affiliateBoosterPurchase.findMany({
    where: { affiliateId, paymentMethod: 'BALANCE', status: 'ACTIVE' },
    select: { price: true, paidFromTopup: true, paidFromEarnings: true },
  });
  let topup = toDecimal(0), earnings = toDecimal(0);
  for (const r of rows) {
    const t = toDecimal(r.paidFromTopup || 0);
    const e = toDecimal(r.paidFromEarnings || 0);
    const p = toDecimal(r.price || 0);
    if (t.plus(e).isZero() && p.greaterThan(0)) earnings = earnings.plus(p); // legacy row
    else { topup = topup.plus(t); earnings = earnings.plus(e); }
  }
  return { topup, earnings };
}

/**
 * Spend-only top-up component still available:
 *   Σ APPROVED "Dépôt de solde" − Σ booster paidFromTopup   (floored at 0).
 * Usable for boosters/paid services; NEVER withdrawable.
 */
export async function getTopupAvailable(affiliateId, db = prisma) {
  const [topups, spend] = await Promise.all([
    getDepositTopupComponent(affiliateId, db),
    getBoosterSpendSplit(affiliateId, db),
  ]);
  const avail = toDecimal(topups).minus(spend.topup);
  return serializeAmount(avail.lessThan(0) ? toDecimal(0) : avail);
}

/**
 * Withdrawable balance = EARNINGS only:
 *   total (all providers) − top-up still available
 * which equals commissions + bonus + UGC − paid payouts − booster earnings
 * spend, computed in Decimal. This is the ONLY number payouts validate against.
 */
export async function getWithdrawableBalance(affiliateId, db = prisma) {
  return (await getAffiliateBalanceBreakdown(affiliateId, db)).withdrawable;
}

/**
 * The wallet in ONE read: the single total the affiliate sees, plus its
 * server-side components.
 *   total          = every registered provider (already NET of reserved payouts)
 *   topupAvailable = approved top-ups − top-up already spent on boosters  (≥ 0)
 *   withdrawable   = total − topupAvailable   (= earnings still available)
 *   pendingPayouts = reserved but not yet paid (informational — ALREADY excluded
 *                    from `withdrawable`, never subtract it again)
 * Invariant: withdrawable + topupAvailable === total.
 * @returns {Promise<{ total:number, withdrawable:number, topupAvailable:number, pendingPayouts:number }>}
 */
export async function getAffiliateBalanceBreakdown(affiliateId, db = prisma) {
  const [total, spend, topups, pendingPayouts] = await Promise.all([
    computeRegisteredBalance(affiliateId, db),
    getBoosterSpendSplit(affiliateId, db),
    getDepositTopupComponent(affiliateId, db),
    getPendingPayoutTotal(affiliateId, db),
  ]);
  const raw = toDecimal(topups).minus(spend.topup);
  const topupAvail = raw.lessThan(0) ? toDecimal(0) : raw;
  return {
    total:          serializeAmount(total),
    withdrawable:   serializeAmount(total.minus(topupAvail)),
    topupAvailable: serializeAmount(topupAvail),
    pendingPayouts,
  };
}

export async function getAffiliatePayouts(affiliateId) {
  const payouts = await prisma.affiliatePayout.findMany({
    where:   { affiliateId },
    orderBy: { createdAt: 'desc' },
  });
  return payouts;
}

/**
 * Bank details must be complete before ANY withdrawal (server-side gate — never
 * rely on the frontend). Trims all fields; RIB length must be 10–34.
 * @returns {string[]} list of problems (empty = complete)
 */
export function validateBankInfo({ bankName, accountName, rib } = {}) {
  const errors = [];
  if (!String(bankName ?? '').trim())    errors.push('bankName');
  if (!String(accountName ?? '').trim()) errors.push('accountName');
  const ribTrim = String(rib ?? '').trim();
  if (!ribTrim) errors.push('rib');
  else if (ribTrim.length < 10 || ribTrim.length > 34) errors.push('ribLength');
  return errors;
}

export async function requestPayout(affiliateId, amount, db = prisma) {
  // Validate inputs before entering the transaction
  const parsedAmount = parseFloat(amount);
  if (!isFinite(parsedAmount) || isNaN(parsedAmount) || parsedAmount <= 0) {
    throw Object.assign(new Error('Montant invalide'), { code: 'INVALID_AMOUNT' });
  }

  // Bank details must be complete BEFORE a withdrawal can be requested — checked
  // here (server-side), never relying on the frontend, and BEFORE the balance tx.
  const affiliate = await db.affiliate.findUnique({
    where: { id: affiliateId },
    select: { bankName: true, accountName: true, rib: true },
  });
  if (validateBankInfo(affiliate || {}).length > 0) {
    throw Object.assign(
      new Error('Veuillez ajouter vos coordonnées bancaires avant de demander un retrait.'),
      { code: 'INCOMPLETE_BANK_INFO' },
    );
  }

  // Identity must be APPROVED before ANY withdrawal — enforced server-side, never
  // relying on the frontend. Read the verification status directly (no row or any
  // non-APPROVED status blocks the request).
  const idv = await db.identityVerification.findUnique({
    where: { affiliateId }, select: { status: true },
  });
  if (idv?.status !== 'APPROVED') {
    throw Object.assign(
      new Error('Votre identité doit être vérifiée avant de pouvoir effectuer un retrait.'),
      { code: 'IDENTITY_NOT_VERIFIED' },
    );
  }

  // Serializable transaction: the withdrawable balance is RECOMPUTED inside the
  // tx (reading the payout rows it also writes), so two concurrent requests
  // cannot both pass the check — one serialises after the other and sees the
  // first as already reserved.
  //   • WITHDRAWABLE = EARNINGS ONLY — approved "Dépôt de solde" top-ups are
  //     spend-only and can never be cashed out.
  //   • Already-reserved payouts (pending / processing / paid) are subtracted,
  //     so stacked pending requests can never exceed the available earnings.
  const payout = await db.$transaction(async (tx) => {
    const balance = await getWithdrawableBalance(affiliateId, tx);
    if (parsedAmount > balance) {
      throw Object.assign(new Error('Montant supérieur aux gains disponibles'), { code: 'INSUFFICIENT_BALANCE' });
    }
    return tx.affiliatePayout.create({
      data: { affiliateId, amount: parsedAmount, status: 'pending' },
    });
  }, { isolationLevel: 'Serializable' });

  return payout;
}

// ── Notifications ─────────────────────────────────────────────────────────────

export async function getAffiliateNotifications(affiliateId) {
  return prisma.affiliateNotification.findMany({
    where:   { affiliateId },
    orderBy: { createdAt: 'desc' },
    take:    50,
  });
}

export async function markNotificationsRead(affiliateId) {
  await prisma.affiliateNotification.updateMany({
    where: { affiliateId, read: false },
    data:  { read: true },
  });
  return { ok: true };
}

// ── Team ──────────────────────────────────────────────────────────────────────

// ── In-memory cache for team aggregations (TTL: 45 s) ─────────────────────────
const _teamCache = new Map(); // parentId → { data: [], ts: number }
const TEAM_CACHE_TTL = 45_000;

export function invalidateTeamCache(parentId) {
  if (parentId) _teamCache.delete(parentId);
}

export async function getAffiliateTeam(parentId) {
  const cached = _teamCache.get(parentId);
  if (cached && Date.now() - cached.ts < TEAM_CACHE_TTL) return cached.data;

  const members = await prisma.affiliate.findMany({
    where:   { parentId },
    orderBy: { createdAt: 'asc' },
  });

  if (members.length === 0) {
    _teamCache.set(parentId, { data: [], ts: Date.now() });
    return [];
  }

  const memberIds = members.map((m) => m.id);

  // Single grouped query — counts level-2 referrals without N+1
  const subCounts = await prisma.affiliate.groupBy({
    by:     ['parentId', 'referralStatus'],
    where:  { parentId: { in: memberIds } },
    _count: { _all: true },
  });

  // Build a lookup: memberId → { active, pending }
  const subMap = {};
  for (const row of subCounts) {
    if (!subMap[row.parentId]) subMap[row.parentId] = { active: 0, pending: 0 };
    if (row.referralStatus === 'active')  subMap[row.parentId].active  = row._count._all;
    if (row.referralStatus === 'pending') subMap[row.parentId].pending = row._count._all;
  }

  const data = members.map((m) => ({
    ...mapAffiliate(m),
    subReferrals: subMap[m.id] ?? { active: 0, pending: 0 },
  }));

  _teamCache.set(parentId, { data, ts: Date.now() });
  return data;
}

/**
 * Fetch direct children of one team member (level-2) for the lazy expandable view.
 * Returns a minimal shape to keep the payload small.
 */
export async function getSubTeamMembers(memberId) {
  const rows = await prisma.affiliate.findMany({
    where:   { parentId: memberId },
    orderBy: { createdAt: 'asc' },
    select: {
      id:                   true,
      username:             true,
      name:                 true,
      referralStatus:       true,
      deliveredOrdersCount: true,
    },
  });
  return rows.map((r) => ({
    id:                   r.id,
    username:             r.username,
    name:                 r.name || null,
    referralStatus:       r.referralStatus,
    deliveredOrdersCount: r.deliveredOrdersCount,
  }));
}

/**
 * Fetch all orders belonging to one team member (lazy, max 100 most-recent).
 * commissionAmount is already stored on AffiliateOrder at creation time.
 */
export async function getMemberOrders(memberId) {
  const rows = await prisma.affiliateOrder.findMany({
    where:   { affiliateId: memberId },
    orderBy: { createdAt: 'desc' },
    take:    100,
    select: {
      id:               true,
      orderId:          true,
      productTitle:     true,
      clientName:       true,
      total:            true,
      commissionAmount: true,
      status:           true,
      createdAt:        true,
    },
  });
  return rows.map((o) => ({
    id:               o.id,
    orderId:          o.orderId  || null,
    productTitle:     o.productTitle || null,
    clientName:       o.clientName  || null,
    total:            o.total,
    commissionAmount: o.commissionAmount,
    status:           o.status,
    createdAt:        o.createdAt,
  }));
}

// ── Stats (dashboard) ─────────────────────────────────────────────────────────

export async function getAffiliateDashboardStats(affiliateId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    affiliateRow,
    allOrders,
    todayOrders,
    teamCount,
    validReferrals,
    unreadCount,
    breakdown,
    payouts,
    teamMembers,
    ugcValidated,
  ] = await Promise.all([
    prisma.affiliate.findUnique({ where: { id: affiliateId }, select: { totalClicks: true, totalOrders: true } }),
    prisma.affiliateOrder.findMany({
      where:   { affiliateId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.affiliateOrder.findMany({
      where: { affiliateId, createdAt: { gte: today } },
    }),
    prisma.affiliate.count({ where: { parentId: affiliateId } }),
    prisma.affiliate.count({ where: { parentId: affiliateId, referralStatus: 'active' } }),
    prisma.affiliateNotification.count({ where: { affiliateId, read: false } }),
    getAffiliateBalanceBreakdown(affiliateId),
    getAffiliatePayouts(affiliateId),
    prisma.affiliate.findMany({ where: { parentId: affiliateId }, select: { id: true } }),
    // Validated UGC = strictly APPROVED. RUNNING / PENDING / REJECTED are excluded.
    prisma.ugcVideoSubmission.count({ where: { affiliateId, status: 'APPROVED' } }),
  ]);

  // Total commission from all team members' delivered orders
  let teamCommission = 0;
  if (teamMembers.length > 0) {
    const teamIds = teamMembers.map(m => m.id);
    const teamOrders = await prisma.affiliateOrder.findMany({
      where: { affiliateId: { in: teamIds } },
      select: { commissionAmount: true },
    });
    teamCommission = teamOrders.reduce((s, o) => s + (o.commissionAmount || 0), 0);
  }

  const byStatus = (status) => allOrders.filter((o) => o.status === status);

  // ── Part 1: Count ITEMS not rows for delivered progress ───────────────────
  const deliveredAffOrders = byStatus('delivered');
  const deliveredOrderIds  = deliveredAffOrders.map((o) => o.orderId).filter(Boolean);
  let deliveredItems = deliveredAffOrders.length; // fallback: row count

  if (deliveredOrderIds.length > 0) {
    const deliveredLinked = await prisma.order.findMany({
      where:  { id: { in: deliveredOrderIds } },
      select: { id: true, items: { select: { quantity: true } } },
    });
    const qtyMap = {};
    for (const lo of deliveredLinked) {
      qtyMap[lo.id] = lo.items.reduce((s, i) => s + i.quantity, 0);
    }
    deliveredItems = deliveredAffOrders.reduce((sum, o) => {
      return sum + (o.orderId && qtyMap[o.orderId] != null ? qtyMap[o.orderId] : 1);
    }, 0);
    console.log('[Affiliate] deliveredItems (quantities):', deliveredItems, '| rows:', deliveredAffOrders.length);
  }

  const totalClicks = affiliateRow?.totalClicks ?? 0;
  const totalOrders = affiliateRow?.totalOrders ?? allOrders.length;
  const conversionRate = totalClicks > 0
    ? parseFloat(((totalOrders / totalClicks) * 100).toFixed(1))
    : 0;

  return {
    todaySales:       todayOrders.length,
    todayRevenue:     todayOrders.reduce((s, o) => s + o.total, 0),
    confirmed:        byStatus('confirmed').length,
    cancelled:        byStatus('cancelled').length,
    shipping:         byStatus('shipped').length,
    delivered:        deliveredItems,
    totalRevenue:     allOrders.reduce((s, o) => s + o.total, 0),
    totalCommission:  allOrders.reduce((s, o) => s + o.commissionAmount, 0),
    // ONE wallet total + its server-side components (see getAffiliateBalanceBreakdown).
    balance:          breakdown.total,
    withdrawable:     breakdown.withdrawable,   // earnings still available — the payout ceiling
    topupAvailable:   breakdown.topupAvailable, // spend-only (boosters / paid services)
    pendingPayouts:   breakdown.pendingPayouts, // already reserved, awaiting payment
    teamCount,
    totalReferrals:   teamCount,        // all invited affiliates
    validReferrals,                     // only those with ≥1 delivered order
    unreadCount,
    payouts,
    totalClicks,
    totalOrders,
    conversionRate,
    teamCommission,
    ugcValidated,
  };
}

// ── Gamification ──────────────────────────────────────────────────────────────

/**
 * Bonus progression based on VALID referrals (team members with ≥1 delivered order).
 * Goal: reach `target` valid referrals to unlock the bonus.
 * Target scales down as the team grows (max reduction: -2 per 2 members, floor 3).
 */
export function computeGamification(validReferrals, teamSize, explicitTarget) {
  // Per-affiliate "Objectif parrainages valides" wins when set; otherwise the
  // existing computed target behavior is preserved unchanged.
  const target = (Number.isInteger(explicitTarget) && explicitTarget > 0)
    ? explicitTarget
    : Math.max(3, 5 - Math.floor(teamSize / 2));
  const progress = Math.min(100, Math.round((validReferrals / target) * 100));
  return { target, progress, remaining: Math.max(0, target - validReferrals), validReferrals };
}

// ── Team Bonus & Commission Tiers ─────────────────────────────────────────────

const DEFAULT_BONUS_CONFIG = {
  requiredActiveAffiliates: 10,
  bonusAmount: 2000,
  ugcGoal: 5, // "Objectif UGC" — target validated UGC videos (admin-configurable)
  securityDepositAmount: 500, // "Montant du dépôt de solde" (MAD) — admin-fixed top-up amount
  commissionTiers: [
    { minDelivered: 0, maxDelivered: 2,    commissionPct: 5  },
    { minDelivered: 3, maxDelivered: 5,    commissionPct: 7  },
    { minDelivered: 6, maxDelivered: null, commissionPct: 10 },
  ],
};

export async function getTeamBonusConfig() {
  const setting = await prisma.setting.findUnique({ where: { id: 'team-bonus-config' } });
  if (!setting?.data) return DEFAULT_BONUS_CONFIG;
  const d = setting.data;
  const ugcGoal = parseInt(d.ugcGoal, 10);
  const depositAmount = Number(d.securityDepositAmount);
  return {
    requiredActiveAffiliates: d.requiredActiveAffiliates ?? DEFAULT_BONUS_CONFIG.requiredActiveAffiliates,
    bonusAmount:               d.bonusAmount              ?? DEFAULT_BONUS_CONFIG.bonusAmount,
    ugcGoal:                   Number.isFinite(ugcGoal) && ugcGoal > 0 ? ugcGoal : DEFAULT_BONUS_CONFIG.ugcGoal,
    securityDepositAmount:     Number.isFinite(depositAmount) && depositAmount > 0 ? depositAmount : DEFAULT_BONUS_CONFIG.securityDepositAmount,
    commissionTiers:           Array.isArray(d.commissionTiers) && d.commissionTiers.length > 0
      ? d.commissionTiers
      : DEFAULT_BONUS_CONFIG.commissionTiers,
  };
}

export async function saveTeamBonusConfig(data) {
  const saved = await prisma.setting.upsert({
    where:  { id: 'team-bonus-config' },
    update: { data },
    create: { id: 'team-bonus-config', data },
  });
  return saved.data;
}

/** Returns the commission % for this member based on their delivered count */
export function computeMemberCommissionPct(deliveredCount, tiers) {
  const list = (Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_BONUS_CONFIG.commissionTiers)
    .slice()
    .sort((a, b) => a.minDelivered - b.minDelivered);
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (deliveredCount >= t.minDelivered) return t.commissionPct;
  }
  return list[0]?.commissionPct ?? 0;
}

/**
 * Claim team bonus: validates conditions then credits bonusAmount to affiliate.
 * Returns { ok, bonus } or throws with a user-facing message.
 */
export async function claimTeamBonus(affiliateId) {
  const [config, affiliate, validReferrals] = await Promise.all([
    getTeamBonusConfig(),
    prisma.affiliate.findUnique({
      where:  { id: affiliateId },
      select: { teamBonusClaimed: true },
    }),
    prisma.affiliate.count({ where: { parentId: affiliateId, referralStatus: 'active' } }),
  ]);

  if (!affiliate)
    throw Object.assign(new Error('Affilié introuvable'), { code: 'NOT_FOUND' });
  if (affiliate.teamBonusClaimed)
    throw Object.assign(new Error('Bonus déjà réclamé'), { code: 'ALREADY_CLAIMED' });
  if (validReferrals < config.requiredActiveAffiliates)
    throw Object.assign(
      new Error(`Objectif non atteint : ${validReferrals} / ${config.requiredActiveAffiliates} parrainages valides`),
      { code: 'GOAL_NOT_MET' }
    );

  // Atomic check-and-set: updateMany only matches rows where teamBonusClaimed is
  // still false, eliminating the TOCTOU window between the read above and the write.
  // If count === 0 a concurrent request already claimed it.
  const { count } = await prisma.affiliate.updateMany({
    where: { id: affiliateId, teamBonusClaimed: false },
    data:  { teamBonusClaimed: true, bonusBalance: { increment: config.bonusAmount } },
  });

  if (count === 0) {
    throw Object.assign(new Error('Bonus déjà réclamé'), { code: 'ALREADY_CLAIMED' });
  }

  return { ok: true, bonus: config.bonusAmount };
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export async function adminGetAllAffiliates() {
  const affiliates = await prisma.affiliate.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { affiliateOrders: true, children: true } } },
  });
  return affiliates.map((a) => ({
    ...mapAffiliate(a),
    ordersCount:  a._count.affiliateOrders,
    teamCount:    a._count.children,
  }));
}

export async function adminCreateAffiliate({ name, username, password, commissionRate, parentId, goalOrders, goalValidReferrals }) {
  if (!username || !password) throw new Error('username et password sont requis');

  // Optional team parent — verify it exists before linking (avoids FK P2003).
  // Empty/absent parentId → standalone affiliate, exactly as before.
  let validParentId = null;
  if (parentId) {
    const parentExists = await prisma.affiliate.count({ where: { id: parentId } });
    if (parentExists === 0) {
      throw Object.assign(new Error('Affilié parent introuvable'), { code: 'PARENT_NOT_FOUND' });
    }
    validParentId = parentId;
  }

  // Optional per-affiliate objectives — stored only when a valid integer is given.
  const parsedGoalOrders         = parseInt(goalOrders, 10);
  const parsedGoalValidReferrals = parseInt(goalValidReferrals, 10);

  const hashed = await hashPassword(password);
  const a = await prisma.affiliate.create({
    data: {
      name:           name || username,
      username:       username.toLowerCase().trim(),
      password:       hashed,
      commissionRate: parseFloat(commissionRate) || 0.5,
      isActive:       false,
      ...(validParentId ? { parentId: validParentId } : {}),
      ...(Number.isInteger(parsedGoalOrders)         ? { goalOrders: parsedGoalOrders } : {}),
      ...(Number.isInteger(parsedGoalValidReferrals) ? { goalValidReferrals: parsedGoalValidReferrals } : {}),
    },
  });

  // Refresh the parent's cached "Mon équipe" so the new member shows immediately.
  if (validParentId) invalidateTeamCache(validParentId);

  return mapAffiliate(a);
}

export async function adminUpdateAffiliate(id, data, { db = prisma } = {}) {
  const update = {};
  if (data.name           !== undefined) update.name           = data.name;
  if (data.commissionRate !== undefined) update.commissionRate = parseFloat(data.commissionRate);
  if (data.isActive       !== undefined) update.isActive       = Boolean(data.isActive);
  if (data.password       !== undefined && data.password.trim()) {
    update.password = await hashPassword(data.password);
  }
  // Per-affiliate objectives — only touched when present in the payload (so the
  // quick active-toggle never wipes them). Empty/invalid → null = dashboard fallback.
  if (data.goalOrders !== undefined) {
    const n = parseInt(data.goalOrders, 10);
    update.goalOrders = Number.isInteger(n) ? n : null;
  }
  if (data.goalValidReferrals !== undefined) {
    const n = parseInt(data.goalValidReferrals, 10);
    update.goalValidReferrals = Number.isInteger(n) ? n : null;
  }
  const before = update.isActive === true
    ? await db.affiliate.findUnique({ where: { id }, select: { isActive: true } })
    : null;
  const a = await db.affiliate.update({ where: { id }, data: update });
  // Rewards: signup bonus on the first inactive → active switch (post-commit, never throws).
  if (before) await onAffiliateActivationCommitted(id, { wasActive: before.isActive, isActive: a.isActive, db });
  return mapAffiliate(a);
}

/** false = not found; throws AFFILIATE_HAS_HISTORY (→ 409) when referenced. */
export async function adminDeleteAffiliate(id) {
  return deleteAffiliateSafely(prisma, id);
}

export async function adminGetAllAffiliateOrders() {
  const affOrders = await prisma.affiliateOrder.findMany({
    orderBy: { createdAt: 'desc' },
    include: { affiliate: { select: { username: true, name: true } } },
  });

  // Bulk-fetch linked Order items (same pattern as getAffiliateOrders)
  const orderIds = affOrders.map((o) => o.orderId).filter(Boolean);
  const itemsByOrderId = {};
  if (orderIds.length > 0) {
    const linkedOrders = await prisma.order.findMany({
      where:  { id: { in: orderIds } },
      select: {
        id:              true,
        shippingAddress: true,
        items: {
          select: { quantity: true, price: true, productSnapshot: true },
        },
      },
    });
    for (const lo of linkedOrders) {
      itemsByOrderId[lo.id] = { items: lo.items, shippingAddress: lo.shippingAddress };
    }
  }

  return affOrders.map((o) => ({
    ...mapOrder(o, itemsByOrderId[o.orderId] || null),
    affiliateUsername: o.affiliate?.username,
    affiliateName:     o.affiliate?.name,
    // Admin-only flag (never included in the affiliate-facing mapOrder) so the
    // Orders/analytics views can filter All / Real / Fake.
    isFake:            Boolean(o.isFake),
  }));
}

export async function adminUpdateAffiliateOrderStatus(id, status, { db = prisma } = {}) {
  const o = await db.affiliateOrder.update({ where: { id }, data: { status } });
  if (status === 'delivered') {
    activateReferralIfDelivered(o.affiliateId, o.total, db).catch(() => {});
  }
  // Rewards: the update above has committed; award/reverse/re-award is
  // idempotent and never throws (failures are left for reconcile).
  await onAffiliateOrderStatusCommitted(o.id, { db });
  return mapOrder(o);
}

export async function adminGetAllPayouts() {
  const payouts = await prisma.affiliatePayout.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      affiliate: { select: { username: true, name: true, bankName: true, rib: true, accountName: true } },
    },
  });
  return payouts.map((p) => ({
    _id:               p.id,
    id:                p.id,
    affiliateId:       p.affiliateId,
    amount:            p.amount,
    status:            p.status,
    createdAt:         p.createdAt,
    affiliateUsername: p.affiliate?.username,
    affiliateName:     p.affiliate?.name,
    bankName:          p.affiliate?.bankName,
    rib:               p.affiliate?.rib,
    accountName:       p.affiliate?.accountName,
  }));
}

export async function adminApprovePayout(id) {
  const p = await prisma.affiliatePayout.update({ where: { id }, data: { status: 'paid' } });
  return { _id: p.id, id: p.id, status: p.status, amount: p.amount };
}
