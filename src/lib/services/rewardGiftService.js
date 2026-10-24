/**
 * src/lib/services/rewardGiftService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards gift catalog — admin management. Every change writes a
 * reward_audit_log row (who, what, before/after).
 *
 *   • Gifts are never hard-deleted: "archive" hides them from the catalog and
 *     keeps every past request's gift row intact (FK RESTRICT).
 *   • Stock is set at creation; afterwards it only moves by an audited DELTA,
 *     applied as a conditional `stock = stock + delta` so it composes with
 *     concurrent redemptions (which decrement) instead of overwriting them.
 *   • An archived gift cannot be activated or edited until restored.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  ACTOR, OPEN_REDEMPTION_STATUSES, GIFT_LIMITS, GIFT_ACTIONS,
  normalizeGiftInput, computeStockState, validateReason, isNonEmptyId,
} from '../rewards.js';
import { getRewardsConfig } from './rewardsService.js';

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const GIFT_FILTERS = Object.freeze(['all', 'active', 'inactive', 'archived', 'low', 'out']);

/** Plain JSON for Json columns (Dates → ISO strings), whatever the row holds. */
const plain = (v) => JSON.parse(JSON.stringify(v));

async function audit(tx, { action, entityId, actorId, before = null, after = null, reason = null }) {
  return tx.rewardAuditLog.create({
    data: {
      action, entityType: 'reward_gift', entityId, actorType: ACTOR.ADMIN, actorId,
      ...(before ? { before: plain(before) } : {}), ...(after ? { after: plain(after) } : {}), reason,
    },
  });
}

async function requireGift(db, id) {
  if (!isNonEmptyId(id)) throw err('GIFT_NOT_FOUND', 'Cadeau introuvable');
  const gift = await db.rewardGift.findUnique({ where: { id } });
  if (!gift) throw err('GIFT_NOT_FOUND', 'Cadeau introuvable');
  return gift;
}

/**
 * Admin catalog list with stock state and open-request counts.
 * filter: all (not archived) | active | inactive | archived | low | out
 */
export async function listGiftsAdmin({ filter = 'all', db = prisma } = {}) {
  const f = GIFT_FILTERS.includes(filter) ? filter : 'all';
  const where = f === 'archived' ? { archivedAt: { not: null } }
    : f === 'active' ? { archivedAt: null, isActive: true }
      : f === 'inactive' ? { archivedAt: null, isActive: false }
        : { archivedAt: null };
  const [gifts, config, open] = await Promise.all([
    db.rewardGift.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] }),
    getRewardsConfig(db),
    db.rewardRedemption.groupBy({ by: ['giftId'], where: { status: { in: [...OPEN_REDEMPTION_STATUSES] } }, _count: { _all: true } }),
  ]);
  const openBy = Object.fromEntries(open.map((g) => [g.giftId, g._count._all]));
  const rows = gifts.map((g) => ({
    ...g,
    stockState: computeStockState(g, config.defaultLowStockThreshold),
    openRequests: openBy[g.id] ?? 0,
  }));
  if (f === 'low') return rows.filter((g) => g.stockState === 'LOW');
  if (f === 'out') return rows.filter((g) => g.stockState === 'OUT');
  return rows;
}

export async function getGiftAdmin(id, { db = prisma } = {}) {
  const [gift, config] = await Promise.all([requireGift(db, id), getRewardsConfig(db)]);
  return { ...gift, stockState: computeStockState(gift, config.defaultLowStockThreshold) };
}

export async function createGift(input, { actorId = null, db = prisma } = {}) {
  const v = normalizeGiftInput(input);
  if (!v.ok) throw err('INVALID_INPUT', 'Cadeau invalide', { errors: v.errors });
  return db.$transaction(async (tx) => {
    const gift = await tx.rewardGift.create({ data: v.value });
    await audit(tx, { action: 'GIFT_CREATE', entityId: gift.id, actorId, after: gift });
    return gift;
  });
}

/** Edit catalog fields (not stock, not activation — see the dedicated actions). */
export async function updateGift(id, input, { actorId = null, db = prisma } = {}) {
  const v = normalizeGiftInput(input, { partial: true });
  if (!v.ok) throw err('INVALID_INPUT', 'Cadeau invalide', { errors: v.errors });
  return db.$transaction(async (tx) => {
    const before = await requireGift(tx, id);
    if (before.archivedAt) throw err('GIFT_ARCHIVED', 'Cadeau archivé — restaurez-le avant de le modifier');
    const gift = await tx.rewardGift.update({ where: { id }, data: v.value });
    await audit(tx, { action: 'GIFT_UPDATE', entityId: id, actorId, before, after: gift });
    return gift;
  });
}

/**
 * activate | deactivate | archive | restore. Conditional writes, so a double
 * click is harmless and an archived gift can never be activated.
 */
export async function setGiftStatus(id, action, { actorId = null, db = prisma, now = new Date() } = {}) {
  if (!GIFT_ACTIONS.includes(action)) throw err('INVALID_INPUT', 'Action inconnue', { errors: { action: 'INVALID_ACTION' } });
  const data = {
    activate:   { where: { archivedAt: null }, set: { isActive: true } },
    deactivate: { where: {},                   set: { isActive: false } },
    archive:    { where: {},                   set: { isActive: false, archivedAt: new Date(now) } },
    restore:    { where: {},                   set: { archivedAt: null, isActive: false } },
  }[action];
  return db.$transaction(async (tx) => {
    const before = await requireGift(tx, id);
    if (action === 'activate' && before.archivedAt) throw err('GIFT_ARCHIVED', 'Cadeau archivé — restaurez-le avant de l’activer');
    await tx.rewardGift.updateMany({ where: { id, ...data.where }, data: data.set });
    const gift = await tx.rewardGift.findUnique({ where: { id } });
    await audit(tx, {
      action: `GIFT_${action.toUpperCase()}`, entityId: id, actorId,
      before: { isActive: before.isActive, archivedAt: before.archivedAt },
      after:  { isActive: gift.isActive, archivedAt: gift.archivedAt },
    });
    return gift;
  });
}

/**
 * Move stock by a signed delta with a mandatory reason. Applied as
 * `stock = stock + delta WHERE stock + delta >= 0`, so it stacks correctly with
 * redemptions happening at the same moment and can never go negative.
 */
export async function adjustGiftStock(id, { delta, reason } = {}, { actorId = null, db = prisma } = {}) {
  const errors = {};
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > GIFT_LIMITS.MAX_STOCK) {
    errors.delta = 'INVALID_DELTA';
  }
  const cleanReason = validateReason(reason);
  if (!cleanReason) errors.reason = 'REASON_REQUIRED';
  if (Object.keys(errors).length) throw err('INVALID_INPUT', 'Ajustement de stock invalide', { errors });

  return db.$transaction(async (tx) => {
    await requireGift(tx, id);
    const moved = await tx.rewardGift.updateMany({
      where: { id, ...(delta < 0 ? { stock: { gte: -delta } } : {}) },
      data:  { stock: { increment: delta } },
    });
    if (moved.count !== 1) throw err('STOCK_NEGATIVE', 'Le stock ne peut pas devenir négatif');
    const gift = await tx.rewardGift.findUnique({ where: { id } });
    await audit(tx, {
      action: 'GIFT_STOCK_ADJUST', entityId: id, actorId, reason: cleanReason,
      before: { stock: gift.stock - delta }, after: { stock: gift.stock, delta },
    });
    return gift;
  });
}
