/**
 * src/lib/rewardsRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bodies of the /api/admin/rewards/* routes as dependency-injected handlers
 * (same pattern as ugcRouteHandlers.js). Route files only wire withAdminAuth +
 * these handlers; tests inject a fake db and drive them directly.
 *
 * Every handler has the signature (req, ctx, user) — `user` is the verified
 * token payload from withAdminAuth / withAffiliateAuth, and is the ONLY source
 * of identity (admin actor id; affiliate id). Ids in the body are never trusted.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { ACTOR, REDEMPTION_STATUS } from './rewards.js';
import { rateLimit as realRateLimit } from './rateLimit.js';
import { rewardsErrorResponse, readJsonObject } from './rewardsHttp.js';
import {
  getRewardsConfig, saveRewardsConfig, adjustPoints,
  adminListAccounts, adminGetAccount, listRewardAudit,
  reconcileOrderRewards, reconcileSignupBonuses,
} from './services/rewardsService.js';
import {
  listGiftsAdmin, getGiftAdmin, createGift, updateGift, setGiftStatus, adjustGiftStock,
} from './services/rewardGiftService.js';
import {
  adminListRedemptions, adminGetRedemption, transitionRedemption, updateRedemptionFulfillment, resolveCarrier,
  requestRedemption, getAffiliateRewardsOverview, listAffiliateRedemptions, publicRedemption,
} from './services/rewardRedemptionService.js';
import { listLedger } from './services/rewardsService.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const json = (data, status = 200) => Response.json(data, { status, headers: NO_STORE });

/** Audit actor from the verified admin session (never from the request). */
export const actorIdOf = (user) => user?.userId || user?.email || null;

const param = async (ctx, name) => (await ctx?.params)?.[name];

export function adminRewardsHandlers(deps = {}) {
  const { db = prisma, now = () => new Date() } = deps;
  const safe = (fn) => async (req, ctx, user) => {
    try { return await fn(req, ctx, user); } catch (e) { return rewardsErrorResponse(e); }
  };

  return {
    // ── Settings ────────────────────────────────────────────────────────────
    getSettings: safe(async () => json(await getRewardsConfig(db))),
    putSettings: safe(async (req, _ctx, user) => {
      const body = await readJsonObject(req);
      return json(await saveRewardsConfig(body, { db, actorId: actorIdOf(user), now: now() }));
    }),

    // ── Gifts ───────────────────────────────────────────────────────────────
    listGifts: safe(async (req) => {
      const filter = new URL(req.url).searchParams.get('filter') || 'all';
      return json(await listGiftsAdmin({ filter, db }));
    }),
    createGift: safe(async (req, _ctx, user) =>
      json(await createGift(await readJsonObject(req), { db, actorId: actorIdOf(user) }), 201)),
    getGift: safe(async (_req, ctx) => json(await getGiftAdmin(await param(ctx, 'id'), { db }))),
    updateGift: safe(async (req, ctx, user) =>
      json(await updateGift(await param(ctx, 'id'), await readJsonObject(req), { db, actorId: actorIdOf(user) }))),
    /** PATCH { action: 'activate'|'deactivate'|'archive'|'restore' } */
    patchGift: safe(async (req, ctx, user) => {
      const { action } = await readJsonObject(req);
      return json(await setGiftStatus(await param(ctx, 'id'), action, { db, actorId: actorIdOf(user), now: now() }));
    }),
    /** POST { delta, reason } */
    adjustStock: safe(async (req, ctx, user) => {
      const { delta, reason } = await readJsonObject(req);
      return json(await adjustGiftStock(await param(ctx, 'id'), { delta, reason }, { db, actorId: actorIdOf(user) }));
    }),

    // ── Redemptions ─────────────────────────────────────────────────────────
    listRedemptions: safe(async (req) => {
      const sp = new URL(req.url).searchParams;
      return json(await adminListRedemptions({
        status: (sp.get('status') || 'ALL').toUpperCase(), q: sp.get('q') || '', cursor: sp.get('cursor'), db,
      }));
    }),
    getRedemption: safe(async (_req, ctx) => json(await adminGetRedemption(await param(ctx, 'id'), { db }))),
    /**
     * PATCH { toStatus?, reason?, note?, carrierId?, carrierName?, trackingNumber?,
     *         trackingUrl?, refundPoints?, restock?, internalNotes? }
     * With toStatus → a status transition (carrier resolved from Shipping
     * Companies server-side). Fields without toStatus → tracking/notes edit.
     */
    patchRedemption: safe(async (req, ctx, user) => {
      const id = await param(ctx, 'id');
      const b = await readJsonObject(req);
      const actorId = actorIdOf(user);
      const tracking = ['carrierId', 'carrierName', 'trackingNumber', 'trackingUrl'];
      if (b.toStatus !== undefined) {
        if (!Object.values(REDEMPTION_STATUS).includes(b.toStatus)) {
          throw Object.assign(new Error('Statut inconnu'), { code: 'INVALID_INPUT', errors: { toStatus: 'INVALID_STATUS' } });
        }
        const carrier = await resolveCarrier({ carrierId: b.carrierId, carrierName: b.carrierName }, { db });
        await transitionRedemption({
          redemptionId: id, toStatus: b.toStatus, actor: { type: ACTOR.ADMIN, id: actorId },
          note: b.note, reason: b.reason, ...carrier,
          trackingNumber: b.trackingNumber, trackingUrl: b.trackingUrl,
          refundPoints: b.refundPoints, restock: b.restock,
        }, { db, now: now() });
        if (b.internalNotes !== undefined) {
          await updateRedemptionFulfillment(id, { internalNotes: b.internalNotes }, { db, actorId });
        }
      } else {
        const fields = Object.fromEntries([...tracking, 'internalNotes'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
        await updateRedemptionFulfillment(id, fields, { db, actorId });
      }
      return json(await adminGetRedemption(id, { db }));
    }),

    // ── Accounts ────────────────────────────────────────────────────────────
    listAccounts: safe(async (req) => json(await adminListAccounts({ q: new URL(req.url).searchParams.get('q') || '', db }))),
    getAccount: safe(async (req, ctx) => json(await adminGetAccount(await param(ctx, 'affiliateId'), {
      db, now: now(), cursor: new URL(req.url).searchParams.get('cursor'),
    }))),
    /** POST { delta, reason, clientRequestId } — affiliate from the URL, admin from the session. */
    adjustAccount: safe(async (req, ctx, user) => {
      const { delta, reason, clientRequestId } = await readJsonObject(req);
      const result = await adjustPoints({
        affiliateId: await param(ctx, 'affiliateId'), delta, reason, clientRequestId, actorId: actorIdOf(user),
      }, { db });
      return json(result, result.duplicate ? 200 : 201);
    }),

    // ── Reconcile (retry path for failed post-commit hooks; idempotent) ──────
    reconcile: safe(async () => json({
      orders:        await reconcileOrderRewards({ db, now: now() }),
      signupBonuses: await reconcileSignupBonuses({ db }),
    })),

    // ── Audit ───────────────────────────────────────────────────────────────
    listAudit: safe(async (req) => {
      const sp = new URL(req.url).searchParams;
      return json(await listRewardAudit({ entityType: sp.get('entityType'), cursor: sp.get('cursor'), db }));
    }),
  };
}

// ── Affiliate (Phase 4) ───────────────────────────────────────────────────────
// `decoded` comes from withAffiliateAuth ({ affiliateId, type: 'affiliate' }).
// The affiliate id is ALWAYS taken from it — a body/query affiliateId is ignored.
//
// ACTIVE ACCOUNTS ONLY: login already refuses inactive accounts
// (loginAffiliate → INACTIVE), but a token issued before deactivation stays
// valid for up to 7 days and withAffiliateAuth does not re-check isActive. Every
// Rewards endpoint therefore re-checks it (403 AFFILIATE_INACTIVE) — reads and
// cancellation included. An admin can still cancel/refund a deactivated
// affiliate's pending request from the admin side.

/** Ledger row as shown to the affiliate: no admin ids or internal keys. */
const publicLedgerEntry = (l) => ({
  id: l.id, delta: l.delta, type: l.type, balanceAfter: l.balanceAfter, reason: l.reason, createdAt: l.createdAt,
});

export function affiliateRewardsHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), rateLimit = realRateLimit } = deps;
  const safe = (fn) => async (req, ctx, decoded) => {
    try { return await fn(req, ctx, decoded); } catch (e) { return rewardsErrorResponse(e); }
  };
  /** The token's affiliate id, if that account exists and is active; else 403. */
  const activeMe = async (decoded) => {
    const id = decoded?.affiliateId;
    const acc = typeof id === 'string' && id
      ? await db.affiliate.findUnique({ where: { id }, select: { isActive: true } })
      : null;
    if (!acc?.isActive) throw Object.assign(new Error('Compte inactif'), { code: 'AFFILIATE_INACTIVE' });
    return id;
  };

  return {
    overview: safe(async (_req, _ctx, decoded) => json(await getAffiliateRewardsOverview(await activeMe(decoded), { db, now: now() }))),

    ledger: safe(async (req, _ctx, decoded) => {
      const page = await listLedger(await activeMe(decoded), { db, cursor: new URL(req.url).searchParams.get('cursor'), take: 30 });
      return json({ items: page.items.map(publicLedgerEntry), nextCursor: page.nextCursor });
    }),

    redemptions: safe(async (_req, _ctx, decoded) => json(await listAffiliateRedemptions(await activeMe(decoded), { db }))),

    /** POST { giftId, clientRequestId, fullName, phone, city, address, deliveryNotes } */
    requestRedemption: safe(async (req, _ctx, decoded) => {
      const limited = rateLimit(req, 'rewards_redeem', { max: 10, windowMs: 60_000 });
      if (limited) return limited;
      const affiliateId = await activeMe(decoded);
      const b = await readJsonObject(req);
      const recipient = b.recipient && typeof b.recipient === 'object' ? b.recipient : b;
      const { redemption, duplicate } = await requestRedemption({
        affiliateId, giftId: b.giftId, clientRequestId: b.clientRequestId,
        recipient: {
          fullName: recipient.fullName, phone: recipient.phone, city: recipient.city,
          address: recipient.address, deliveryNotes: recipient.deliveryNotes,
        },
      }, { db, now: now() });
      return json({ redemption: publicRedemption(redemption), duplicate }, duplicate ? 200 : 201);
    }),

    /** POST /redemptions/[id]/cancel — own request, PENDING_REVIEW only (D6). */
    cancelRedemption: safe(async (req, ctx, decoded) => {
      const limited = rateLimit(req, 'rewards_cancel', { max: 20, windowMs: 60_000 });
      if (limited) return limited;
      const affiliateId = await activeMe(decoded);
      const updated = await transitionRedemption({
        redemptionId: await param(ctx, 'id'), toStatus: REDEMPTION_STATUS.CANCELLED,
        actor: { type: ACTOR.AFFILIATE, id: affiliateId },
      }, { db, now: now() });
      return json({ redemption: publicRedemption(updated) });
    }),
  };
}
