/**
 * src/lib/services/rewardRedemptionService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gift requests: create (points debited + stock reserved atomically) and status
 * transitions (refund / restock exactly once, full history).
 *
 * Nothing about cost, stock or identity is taken from the caller beyond ids:
 * the gift's pointsCost/stock are read from the database inside the
 * transaction, and the affiliate id comes from the authenticated session.
 *
 * Lock order (prevents deadlocks): affiliate points account → redemption row →
 * gift row. Stock changes are conditional (`stock >= 1`) so two affiliates
 * racing for the last unit cannot both win.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import prisma from '../prisma.js';
import {
  REDEMPTION_STATUS, OPEN_REDEMPTION_STATUSES, VOID_REDEMPTION_STATUSES, TERMINAL_REDEMPTION_STATUSES,
  AUTO_REFUND_STATUSES, LEDGER_TYPE, ACTOR, DELIVERED_STATUS,
  canTransition, evaluateRedemptionEligibility, validateRecipient, validateReason,
  computeStockState, toPublicRedemption,
  isValidClientRequestId, isNonEmptyId, cleanText, generateRedemptionReference, ledgerKey,
} from '../rewards.js';
import { getRewardsConfig, lockAccount, appendLedger, getHeldPoints, getPointsSummary } from './rewardsService.js';

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const S = REDEMPTION_STATUS;

/**
 * Request a gift. Idempotent per (affiliate, clientRequestId): a retried or
 * double-clicked submit returns the original request instead of a second one.
 */
export async function requestRedemption(
  { affiliateId, giftId, recipient, clientRequestId },
  { db = prisma, now = new Date(), randomBytes = nodeRandomBytes } = {},
) {
  if (!isNonEmptyId(affiliateId)) throw err('INVALID_INPUT', 'Affilié invalide', { errors: { affiliateId: 'INVALID_ID' } });
  if (!isNonEmptyId(giftId)) throw err('INVALID_INPUT', 'Cadeau invalide', { errors: { giftId: 'INVALID_ID' } });
  if (!isValidClientRequestId(clientRequestId)) {
    throw err('INVALID_INPUT', 'Requête invalide', { errors: { clientRequestId: 'INVALID_REQUEST_ID' } });
  }
  const rec = validateRecipient(recipient);
  if (!rec.ok) throw err('INVALID_INPUT', 'Informations de livraison invalides', { errors: rec.errors });

  const config = await getRewardsConfig(db);
  const at = new Date(now);

  return db.$transaction(async (tx) => {
    const account = await lockAccount(tx, affiliateId);

    const prior = await tx.rewardRedemption.findFirst({ where: { affiliateId, clientRequestId } });
    if (prior) {
      if (prior.giftId !== giftId) throw err('IDEMPOTENCY_CONFLICT', 'Requête déjà utilisée pour un autre cadeau');
      return { redemption: prior, duplicate: true };
    }

    const [affiliate, gift, held, deliveredOrders, giftRedemptions, openRedemptions] = await Promise.all([
      tx.affiliate.findUnique({ where: { id: affiliateId }, select: { id: true, isActive: true } }),
      tx.rewardGift.findUnique({ where: { id: giftId } }),
      getHeldPoints(tx, affiliateId, at),
      tx.affiliateOrder.count({ where: { affiliateId, status: DELIVERED_STATUS, isFake: false } }),
      tx.rewardRedemption.count({ where: { affiliateId, giftId, status: { notIn: [...VOID_REDEMPTION_STATUSES] } } }),
      tx.rewardRedemption.count({ where: { affiliateId, status: { in: [...OPEN_REDEMPTION_STATUSES] } } }),
    ]);

    const spendable = account.balance - held; // may be negative (points debt)
    const gate = evaluateRedemptionEligibility({
      config, affiliate, gift, spendable, deliveredOrders, giftRedemptions, openRedemptions,
    });
    if (!gate.ok) throw err(gate.code, 'Demande de cadeau refusée');

    // Reserve one unit — conditional, so the last unit can only go once.
    const reserved = await tx.rewardGift.updateMany({
      where: { id: giftId, isActive: true, archivedAt: null, stock: { gte: 1 } },
      data:  { stock: { decrement: 1 } },
    });
    if (reserved.count !== 1) throw err('OUT_OF_STOCK', 'Cadeau en rupture de stock');

    const cost = gift.pointsCost;
    const images = Array.isArray(gift.images) ? gift.images : [];
    const redemption = await tx.rewardRedemption.create({
      data: {
        reference: generateRedemptionReference(at, randomBytes(6)),
        affiliateId, giftId, pointsCost: cost, status: S.PENDING_REVIEW, clientRequestId,
        giftSnapshot: { id: gift.id, name: gift.name, description: gift.description, image: images[0] ?? null, pointsCost: cost },
        ...rec.value,
        createdAt: at,
      },
    });
    const entry = await appendLedger(tx, {
      affiliateId, delta: -cost, type: LEDGER_TYPE.REDEMPTION_DEBIT,
      sourceType: 'redemption', sourceId: redemption.id,
      idempotencyKey: ledgerKey.redemptionDebit(redemption.id),
      reason: `Gift request ${redemption.reference}`, actorType: ACTOR.AFFILIATE, actorId: affiliateId,
      metadata: { giftId, reference: redemption.reference },
    });
    // Belt and braces: the debit must never dip into held points or below zero.
    if (entry.balanceAfter - held < 0) throw err('INSUFFICIENT_POINTS', 'Points insuffisants');

    await tx.rewardRedemptionHistory.create({
      data: {
        redemptionId: redemption.id, fromStatus: null, toStatus: S.PENDING_REVIEW,
        actorType: ACTOR.AFFILIATE, actorId: affiliateId, createdAt: at,
      },
    });
    return { redemption, duplicate: false };
  });
}

const STATUS_TIMESTAMP = {
  [S.APPROVED]:  'approvedAt',
  [S.PREPARING]: 'preparingAt',
  [S.SHIPPED]:   'shippedAt',
  [S.DELIVERED]: 'deliveredAt',
};

/**
 * Move a request to `toStatus` if the transition table allows it for this
 * actor. REJECTED/CANCELLED always refund points and release stock; RETURNED
 * does so only when the admin explicitly asks (refundPoints / restock, D5).
 * The status change is conditional on the status we read, so a double click or
 * two admins at once can only apply it once.
 */
export async function transitionRedemption(
  {
    redemptionId, toStatus, actor, note, reason,
    carrierId, carrierName, trackingNumber, trackingUrl, refundPoints, restock,
  },
  { db = prisma, now = new Date() } = {},
) {
  if (!actor || ![ACTOR.ADMIN, ACTOR.AFFILIATE].includes(actor.type) || !isNonEmptyId(actor.id)) {
    throw err('INVALID_INPUT', 'Acteur invalide', { errors: { actor: 'INVALID_ACTOR' } });
  }
  if (!isNonEmptyId(redemptionId)) throw err('NOT_FOUND', 'Demande introuvable');
  const isAffiliate = actor.type === ACTOR.AFFILIATE;

  const red = await db.rewardRedemption.findUnique({ where: { id: redemptionId } });
  // Another affiliate's request looks exactly like a missing one.
  if (!red || (isAffiliate && red.affiliateId !== actor.id)) throw err('NOT_FOUND', 'Demande introuvable');
  const from = red.status;
  if (!canTransition(from, toStatus, actor.type)) throw err('INVALID_TRANSITION', `Transition ${from} → ${toStatus} non autorisée`);

  // ── Per-target input requirements ─────────────────────────────────────────
  const data = { status: toStatus };
  const at = new Date(now);
  if (STATUS_TIMESTAMP[toStatus]) data[STATUS_TIMESTAMP[toStatus]] = at;
  if (TERMINAL_REDEMPTION_STATUSES.includes(toStatus)) data.closedAt = at;

  if (toStatus === S.REJECTED) {
    const r = validateReason(reason);
    if (!r) throw err('INVALID_INPUT', 'Motif requis', { errors: { reason: 'REASON_REQUIRED' } });
    data.rejectionReason = r;
  }
  if (toStatus === S.CANCELLED) {
    const r = validateReason(reason);
    if (!r && !isAffiliate) throw err('INVALID_INPUT', 'Motif requis', { errors: { reason: 'REASON_REQUIRED' } });
    // Only a typed reason is stored: no hard-coded (French) text that would show
    // up untranslated in the affiliate's Arabic UI. History records who cancelled.
    if (r) data.cancelReason = r;
  }
  if (toStatus === S.SHIPPED || toStatus === S.IN_TRANSIT) {
    const name = cleanText(carrierName).slice(0, 100);
    if (toStatus === S.SHIPPED && !name && !red.carrierName) {
      throw err('INVALID_INPUT', 'Transporteur requis', { errors: { carrierName: 'REQUIRED' } });
    }
    if (name) data.carrierName = name;
    if (isNonEmptyId(carrierId)) data.carrierId = carrierId;
    const tn = cleanText(trackingNumber).slice(0, 100);
    if (tn) data.trackingNumber = tn;
    const tu = cleanText(trackingUrl).slice(0, 500);
    if (tu) {
      if (!/^https?:\/\//i.test(tu)) throw err('INVALID_INPUT', 'Lien de suivi invalide', { errors: { trackingUrl: 'INVALID_URL' } });
      data.trackingUrl = tu;
    }
  }
  if (toStatus === S.RETURNED && (typeof refundPoints !== 'boolean' || typeof restock !== 'boolean')) {
    throw err('INVALID_INPUT', 'Choisir explicitement remboursement et remise en stock', {
      errors: { refundPoints: 'REQUIRED_BOOLEAN', restock: 'REQUIRED_BOOLEAN' },
    });
  }

  const auto = AUTO_REFUND_STATUSES.includes(toStatus);
  const doRefund = (auto || (toStatus === S.RETURNED && refundPoints)) && !red.pointsRefundedAt;
  const doRestock = (auto || (toStatus === S.RETURNED && restock)) && !red.restockedAt;
  if (doRefund) data.pointsRefundedAt = at;
  if (doRestock) data.restockedAt = at;

  const historyNote = cleanText(note).slice(0, 500) || null;

  return db.$transaction(async (tx) => {
    await lockAccount(tx, red.affiliateId);

    const moved = await tx.rewardRedemption.updateMany({
      where: { id: red.id, status: from, ...(isAffiliate ? { affiliateId: actor.id } : {}) },
      data,
    });
    if (moved.count !== 1) throw err('INVALID_TRANSITION', 'La demande a déjà changé de statut');

    if (doRefund) {
      await appendLedger(tx, {
        affiliateId: red.affiliateId, delta: red.pointsCost, type: LEDGER_TYPE.REDEMPTION_REFUND,
        sourceType: 'redemption', sourceId: red.id,
        idempotencyKey: ledgerKey.redemptionRefund(red.id),
        reason: `Gift request ${red.reference} ${toStatus.toLowerCase()}`,
        actorType: actor.type, actorId: actor.id,
        metadata: { reference: red.reference, toStatus },
      });
    }
    if (doRestock) {
      await tx.rewardGift.update({ where: { id: red.giftId }, data: { stock: { increment: 1 } } });
    }
    await tx.rewardRedemptionHistory.create({
      data: {
        redemptionId: red.id, fromStatus: from, toStatus,
        actorType: actor.type, actorId: actor.id, note: historyNote, createdAt: at,
      },
    });
    return tx.rewardRedemption.findUnique({ where: { id: red.id } });
  });
}

// ── Admin: listing, detail, fulfilment ────────────────────────────────────────

const ADMIN_PAGE_MAX = 100;

/** Attach { username, name } of each request's affiliate (one extra query, no N+1). */
async function withAffiliates(db, rows) {
  const ids = [...new Set(rows.map((r) => r.affiliateId))];
  const affs = ids.length
    ? await db.affiliate.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, name: true } })
    : [];
  const byId = Object.fromEntries(affs.map((a) => [a.id, a]));
  return rows.map((r) => ({ ...r, affiliate: byId[r.affiliateId] ?? null }));
}

/**
 * Admin list, newest first. status: one REDEMPTION_STATUS or 'OPEN' / 'ALL'.
 * q matches reference, recipient name/phone, or the affiliate's username/name.
 */
export async function adminListRedemptions({ status = 'ALL', q = '', cursor = null, take = 50, db = prisma } = {}) {
  const size = Math.min(Math.max(Number.isSafeInteger(take) ? take : 50, 1), ADMIN_PAGE_MAX);
  const where = {};
  if (status === 'OPEN') where.status = { in: [...OPEN_REDEMPTION_STATUSES] };
  else if (Object.values(S).includes(status)) where.status = status;

  const term = cleanText(q).slice(0, 100);
  if (term) {
    const affs = await db.affiliate.findMany({
      where: { OR: [{ username: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }] },
      select: { id: true }, take: 200,
    });
    where.OR = [
      { reference: { contains: term, mode: 'insensitive' } },
      { fullName: { contains: term, mode: 'insensitive' } },
      { phone: { contains: term } },
      ...(affs.length ? [{ affiliateId: { in: affs.map((a) => a.id) } }] : []),
    ];
  }
  const rows = await db.rewardRedemption.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: size + 1,
    ...(isNonEmptyId(cursor) ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > size;
  const items = await withAffiliates(db, hasMore ? rows.slice(0, size) : rows);
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/** One request with its affiliate and full status history (oldest first). */
export async function adminGetRedemption(id, { db = prisma } = {}) {
  if (!isNonEmptyId(id)) throw err('NOT_FOUND', 'Demande introuvable');
  const red = await db.rewardRedemption.findUnique({ where: { id } });
  if (!red) throw err('NOT_FOUND', 'Demande introuvable');
  const [withAff] = await withAffiliates(db, [red]);
  const history = await db.rewardRedemptionHistory.findMany({
    where: { redemptionId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return { ...withAff, history };
}

/**
 * Carrier from the existing Shipping Companies list: when an id is given, its
 * NAME comes from the database (never from the browser). Without an id a free
 * text name is kept (carriers not in the list).
 */
export async function resolveCarrier({ carrierId, carrierName }, { db = prisma } = {}) {
  if (isNonEmptyId(carrierId)) {
    const sc = await db.shippingCompany.findUnique({ where: { id: carrierId }, select: { id: true, name: true } });
    if (!sc) throw err('INVALID_INPUT', 'Transporteur introuvable', { errors: { carrierId: 'NOT_FOUND' } });
    return { carrierId: sc.id, carrierName: sc.name };
  }
  const name = cleanText(carrierName).slice(0, 100);
  return { carrierId: undefined, carrierName: name || undefined };
}

const TRACKING_EDITABLE = [S.SHIPPED, S.IN_TRANSIT, S.DELIVERED, S.RETURNED];

/**
 * Edit tracking (once shipped) and admin-only internal notes without changing
 * the status. Audited with before/after of the changed fields.
 */
export async function updateRedemptionFulfillment(
  id, { carrierId, carrierName, trackingNumber, trackingUrl, internalNotes } = {},
  { actorId = null, db = prisma } = {},
) {
  if (!isNonEmptyId(id)) throw err('NOT_FOUND', 'Demande introuvable');
  const data = {};
  const wantsTracking = [carrierId, carrierName, trackingNumber, trackingUrl].some((v) => v !== undefined);
  if (internalNotes !== undefined) {
    const notes = typeof internalNotes === 'string' ? internalNotes.replace(/\r\n?/g, '\n').trim().slice(0, 2000) : '';
    data.internalNotes = notes || null;
  }
  return db.$transaction(async (tx) => {
    const before = await tx.rewardRedemption.findUnique({ where: { id } });
    if (!before) throw err('NOT_FOUND', 'Demande introuvable');
    if (wantsTracking) {
      if (!TRACKING_EDITABLE.includes(before.status)) {
        throw err('INVALID_TRANSITION', 'Le suivi se renseigne à partir de l’expédition');
      }
      const carrier = await resolveCarrier({ carrierId, carrierName }, { db: tx });
      if (carrier.carrierId !== undefined) data.carrierId = carrier.carrierId;
      if (carrier.carrierName !== undefined) data.carrierName = carrier.carrierName;
      if (trackingNumber !== undefined) data.trackingNumber = cleanText(trackingNumber).slice(0, 100) || null;
      if (trackingUrl !== undefined) {
        const tu = cleanText(trackingUrl).slice(0, 500);
        if (tu && !/^https?:\/\//i.test(tu)) throw err('INVALID_INPUT', 'Lien de suivi invalide', { errors: { trackingUrl: 'INVALID_URL' } });
        data.trackingUrl = tu || null;
      }
    }
    if (Object.keys(data).length === 0) throw err('INVALID_INPUT', 'Rien à mettre à jour', { errors: { _: 'NOTHING_TO_UPDATE' } });
    const updated = await tx.rewardRedemption.update({ where: { id }, data });
    const changed = Object.keys(data);
    await tx.rewardAuditLog.create({
      data: {
        action: 'REDEMPTION_FULFILLMENT_UPDATE', entityType: 'reward_redemption', entityId: id,
        actorType: ACTOR.ADMIN, actorId,
        before: Object.fromEntries(changed.map((k) => [k, before[k] ?? null])),
        after:  Object.fromEntries(changed.map((k) => [k, updated[k] ?? null])),
      },
    });
    return updated;
  });
}

// ── Affiliate-facing reads (Phase 4) ──────────────────────────────────────────
// Everything is scoped to the authenticated affiliate's id. Admin-only data
// (internal notes, admin ids, history notes, exact stock when plentiful) is
// never included.

/** Public view of one gift for the catalog. Exact stock only when it is low. */
function toPublicGift(g, config) {
  const stockState = computeStockState(g, config.defaultLowStockThreshold);
  return {
    id: g.id, name: g.name, description: g.description,
    images: Array.isArray(g.images) ? g.images : [], pointsCost: g.pointsCost,
    stockState, ...(stockState === 'LOW' ? { remaining: g.stock } : {}),
    maxPerAffiliate: g.maxPerAffiliate ?? null, minDeliveredOrders: g.minDeliveredOrders ?? null,
  };
}

/** Public status history: who acted (role only) and when — no admin ids or notes. */
const toPublicHistory = (h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, actorType: h.actorType, createdAt: h.createdAt });

/**
 * Points + catalog for the dashboard. Each gift carries the SAME server-side
 * eligibility check the request uses (canRedeem + reason), so the UI never
 * decides eligibility itself.
 */
export async function getAffiliateRewardsOverview(affiliateId, { db = prisma, now = new Date() } = {}) {
  if (!isNonEmptyId(affiliateId)) throw err('NOT_FOUND', 'Affilié introuvable');
  const at = new Date(now);
  const [config, summary, affiliate, gifts, deliveredOrders, perGift, openRedemptions] = await Promise.all([
    getRewardsConfig(db),
    getPointsSummary(affiliateId, { db, now: at }),
    db.affiliate.findUnique({ where: { id: affiliateId }, select: { id: true, isActive: true } }),
    db.rewardGift.findMany({ where: { isActive: true, archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] }),
    db.affiliateOrder.count({ where: { affiliateId, status: DELIVERED_STATUS, isFake: false } }),
    db.rewardRedemption.groupBy({
      by: ['giftId'], where: { affiliateId, status: { notIn: [...VOID_REDEMPTION_STATUSES] } }, _count: { _all: true },
    }),
    db.rewardRedemption.count({ where: { affiliateId, status: { in: [...OPEN_REDEMPTION_STATUSES] } } }),
  ]);
  const usedBy = Object.fromEntries(perGift.map((g) => [g.giftId, g._count._all]));
  const spendableRaw = summary.balance - summary.held; // negative when in debt
  return {
    enabled: config.enabled,
    points: summary,
    limits: { maxOpenRedemptions: config.maxOpenRedemptions, openRedemptions, deliveredOrders },
    gifts: gifts.map((g) => {
      const gate = evaluateRedemptionEligibility({
        config, affiliate, gift: g, spendable: spendableRaw, deliveredOrders,
        giftRedemptions: usedBy[g.id] ?? 0, openRedemptions,
      });
      return { ...toPublicGift(g, config), canRedeem: gate.ok, reason: gate.code };
    }),
  };
}

/** The affiliate's own requests, newest first, each with its public history. */
export async function listAffiliateRedemptions(affiliateId, { db = prisma, take = 50 } = {}) {
  if (!isNonEmptyId(affiliateId)) return [];
  const size = Math.min(Math.max(Number.isSafeInteger(take) ? take : 50, 1), 100);
  const rows = await db.rewardRedemption.findMany({
    where: { affiliateId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: size,
  });
  const ids = rows.map((r) => r.id);
  const history = ids.length
    ? await db.rewardRedemptionHistory.findMany({ where: { redemptionId: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    : [];
  const byRed = {};
  for (const h of history) (byRed[h.redemptionId] ||= []).push(toPublicHistory(h));
  return rows.map((r) => ({ ...publicRedemption(r), history: byRed[r.id] ?? [] }));
}

/** toPublicRedemption + drop the carrier's internal id. */
export function publicRedemption(r) {
  if (!r) return null;
  const { carrierId: _carrierId, ...rest } = toPublicRedemption(r);
  return rest;
}
