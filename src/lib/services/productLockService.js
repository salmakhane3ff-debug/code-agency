/**
 * src/lib/services/productLockService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin lock / open for one product (see src/lib/productLock.js for the rules).
 * The ONLY writer of products.isLocked: the column is deliberately not in
 * productService's PRODUCT_COLUMNS, so the product form and "duplicate" never
 * change it. Independent of affiliates, orders thresholds, commissions, Rewards.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import prisma from '../prisma.js';

const err = (code, message) => Object.assign(new Error(message), { code });
const isId = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 100;

/** Ids of every locked product (the admin list merges these in). */
export async function listLockedProductIds({ db = prisma } = {}) {
  const rows = await db.product.findMany({ where: { isLocked: true }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Which of these product ids are locked (Set). Used to keep locked products out of spin-wheel draws. */
export async function lockedIdsAmong(ids, { db = prisma } = {}) {
  const list = [...new Set((ids || []).filter(isId))];
  if (!list.length) return new Set();
  const rows = await db.product.findMany({ where: { id: { in: list }, isLocked: true }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/**
 * Lock (true) or open (false) one product. `locked` must be a real boolean.
 * @throws INVALID_INPUT · NOT_FOUND
 */
export async function setProductLock(id, locked, { db = prisma } = {}) {
  if (!isId(id)) throw err('NOT_FOUND', 'Produit introuvable');
  if (typeof locked !== 'boolean') throw err('INVALID_INPUT', '`locked` doit être true ou false');
  const res = await db.product.updateMany({ where: { id }, data: { isLocked: locked } });
  if (res.count !== 1) throw err('NOT_FOUND', 'Produit introuvable');
  return { id, isLocked: locked };
}
