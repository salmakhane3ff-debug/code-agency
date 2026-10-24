/**
 * src/lib/services/fakeOrderService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fake Orders Engine — data layer. Creates fake orders that flow through the
 * EXACT SAME order + commission + notification pipeline as real orders, but are
 * internally flagged (Order.isFake / orderSource='FAKE') so every external
 * integration and business report can exclude them.
 *
 * REUSE, NOT DUPLICATION:
 *   • Commission / wallet / delivered-count / ranking → driven by the linked
 *     AffiliateOrder via the existing `recordAffiliateOrder` +
 *     `syncLinkedAffiliateOrderStatus` (activateReferralIfDelivered). This file
 *     never computes commission itself.
 *   • Notifications → the existing AffiliateNotification rows that
 *     recordAffiliateOrder already writes.
 *
 * All DB access is dependency-injected (`deps.db`, `deps.record`) so the engine
 * and its scenarios are unit-testable without a database.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { recordAffiliateOrder } from './affiliateSystemService.js';
import { randomMoroccanCustomer } from '../fakeOrderData.js';

const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

// ── Config CRUD ─────────────────────────────────────────────────────────────

/** All fake-order configs joined with minimal affiliate identity, newest first. */
export async function listFakeOrderConfigs(db = prisma) {
  const rows = await db.fakeOrderConfig.findMany({
    include: { affiliate: { select: { id: true, username: true, name: true, isActive: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(mapConfig);
}

export async function getFakeOrderConfig(affiliateId, db = prisma) {
  const row = await db.fakeOrderConfig.findUnique({ where: { affiliateId } });
  return row ? mapConfig(row) : null;
}

const CONFIG_INT_FIELDS = [
  'ordersPerMinute', 'ordersPerHour', 'ordersPerDay',
  'minDelaySec', 'maxDelaySec', 'workingHourStart', 'workingHourEnd',
];

/** Sanitize + upsert a per-affiliate config (admin action). */
export async function upsertFakeOrderConfig(affiliateId, input = {}, db = prisma) {
  if (!affiliateId) throw Object.assign(new Error('affiliateId required'), { code: 'FAKE_NO_AFFILIATE' });
  const data = sanitizeConfigInput(input);
  const row = await db.fakeOrderConfig.upsert({
    where:  { affiliateId },
    update: data,
    create: { affiliateId, ...data },
  });
  return mapConfig(row);
}

export async function deleteFakeOrderConfig(affiliateId, db = prisma) {
  await db.fakeOrderConfig.delete({ where: { affiliateId } }).catch(() => {});
  return { deleted: true };
}

export function sanitizeConfigInput(input = {}) {
  const out = {};
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
  for (const f of CONFIG_INT_FIELDS) {
    if (input[f] !== undefined && input[f] !== null && input[f] !== '') {
      const n = parseInt(input[f], 10);
      if (Number.isFinite(n) && n >= 0) out[f] = n;
    } else if (input[f] === null || input[f] === '') {
      // Rate limits are nullable → allow clearing a limit.
      if (['ordersPerMinute', 'ordersPerHour', 'ordersPerDay'].includes(f)) out[f] = null;
    }
  }
  if (input.workingDays !== undefined) {
    const days = String(input.workingDays)
      .split(',').map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6);
    out.workingDays = [...new Set(days)].join(',');
  }
  if (input.productMode !== undefined) {
    out.productMode = input.productMode === 'selected' ? 'selected' : 'all';
  }
  if (input.productIds !== undefined) {
    out.productIds = Array.isArray(input.productIds) ? input.productIds.filter(Boolean) : [];
  }
  return out;
}

function mapConfig(row) {
  return {
    id:               row.id,
    affiliateId:      row.affiliateId,
    enabled:          row.enabled,
    ordersPerMinute:  row.ordersPerMinute,
    ordersPerHour:    row.ordersPerHour,
    ordersPerDay:     row.ordersPerDay,
    minDelaySec:      row.minDelaySec,
    maxDelaySec:      row.maxDelaySec,
    workingHourStart: row.workingHourStart,
    workingHourEnd:   row.workingHourEnd,
    workingDays:      row.workingDays,
    productMode:      row.productMode,
    productIds:       Array.isArray(row.productIds) ? row.productIds : [],
    lastOrderAt:      row.lastOrderAt,
    nextOrderAt:      row.nextOrderAt,
    createdAt:        row.createdAt,
    affiliate:        row.affiliate
      ? { id: row.affiliate.id, username: row.affiliate.username, name: row.affiliate.name, isActive: row.affiliate.isActive }
      : undefined,
  };
}

// ── Window counting (rate-limit enforcement) ─────────────────────────────────

/**
 * How many fake orders this affiliate already has in the last minute / hour / day.
 * Counts the linked store Order rows (the canonical fake-order record).
 */
export async function countFakeOrdersInWindows(affiliateId, now = new Date(), db = prisma) {
  const since = (ms) => new Date(now.getTime() - ms);
  const [minute, hour, day] = await Promise.all([
    db.order.count({ where: { affiliateId, isFake: true, createdAt: { gte: since(60_000) } } }),
    db.order.count({ where: { affiliateId, isFake: true, createdAt: { gte: since(3_600_000) } } }),
    db.order.count({ where: { affiliateId, isFake: true, createdAt: { gte: since(86_400_000) } } }),
  ]);
  return { minute, hour, day };
}

// ── Fake order creation (reuses the real affiliate-order pipeline) ────────────

/**
 * Create ONE fake order for the given config's affiliate.
 *
 * @param {object} config  a mapped FakeOrderConfig (needs affiliateId, productMode, productIds)
 * @param {object} [deps]
 *   @param {*}        deps.db      Prisma-like client (default: real prisma)
 *   @param {Function} deps.record  recordAffiliateOrder impl (default: real one)
 *   @param {Function} deps.rng     RNG (default Math.random)
 *   @param {Function} deps.now     () => Date (default () => new Date())
 * @returns {Promise<{ok:boolean, reason?:string, orderId?:string}>}
 */
export async function createFakeOrder(config, deps = {}) {
  const {
    db = prisma,
    record = recordAffiliateOrder,
    rng = Math.random,
    now = () => new Date(),
  } = deps;

  // 1. Pick a REAL, active product (respecting all / selected). Never a product
  //    the admin LOCKED: nobody can buy it, so no (fake) sale or commission either.
  const where = { isActive: true, isLocked: false };
  if (config.productMode === 'selected' && Array.isArray(config.productIds) && config.productIds.length) {
    where.id = { in: config.productIds };
  }
  const products = await db.product.findMany({
    where,
    select: { id: true, title: true, images: true, salePrice: true, regularPrice: true },
  });
  if (!products.length) return { ok: false, reason: 'NO_PRODUCTS' };

  const product = pick(products, rng);
  const price = product.salePrice ?? product.regularPrice ?? 0;
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'INVALID_PRICE' };

  // 2. Realistic Moroccan customer identity + current timestamp.
  const customer = randomMoroccanCustomer(rng);
  const createdAt = now();
  const total = price; // quantity is always 1 for a fake order

  // 3. Create the store Order — flagged fake, NO bemobClickId (→ no Bemob),
  //    same shape a COD checkout would produce so it renders identically.
  const order = await db.order.create({
    data: {
      status:          'pending',
      customerName:    customer.name,
      customerPhone:   customer.phone,
      shippingAddress: customer.shippingAddress,
      paymentMethod:   'cod',
      paymentStatus:   'pending',
      paymentTotal:    total,
      paymentDetails:  { paymentMethod: 'cod', total, shippingCompany: null },
      affiliateId:     config.affiliateId,
      isFake:          true,
      orderSource:     'FAKE',
      createdAt,
      items: {
        create: [{
          productId:       product.id,
          quantity:        1,
          price,
          regularPrice:    product.regularPrice ?? null,
          productSnapshot: { title: product.title, images: product.images || [] },
        }],
      },
    },
    include: { items: true },
  });

  // 4. Feed the EXISTING affiliate pipeline: AffiliateOrder + notification +
  //    counters + Order↔affiliate link. commissionAmount uses the affiliate's
  //    real commissionRate. isFake flag mirrors onto the affiliate order.
  await record({
    affiliateId:  config.affiliateId,
    orderId:      order.id,
    clientName:   customer.name,
    clientPhone:  customer.phone,
    productTitle: product.title,
    total,
    ipAddress:    null,
    isFake:       true,
  });

  return { ok: true, orderId: order.id, total, createdAt };
}
