/**
 * src/lib/services/recentWinnersService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Recent Winners of the affiliate Rewards / Gifts page — READ ONLY (rules in ../recentWinners.js).
 *
 *   • Rewards program OFF (existing rewards setting)       → { enabled: false, winners: [] } (section hidden).
 *   • Real winners: reward_redemptions with an accepted status, newest first (createdAt DESC), at most
 *     MAX_WINNERS, joined to the affiliate's name + avatar only.
 *   • Demo winners: only while the existing Demo Competition engine switch is ON; computed from the
 *     existing Top Members demo members and the active gift catalogue on 30-day cycles (rules in
 *     ../recentWinners.js); display only — never written anywhere, never a real account, point,
 *     balance, stock, request, order or payment.
 *
 * Never writes: no points, ledger, balance, commission, withdrawal or request change. One small
 * in-memory cache (same answer for every affiliate) keeps the page cheap with many visitors.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import prisma from '../prisma.js';
import { getRewardsConfig } from './rewardsService.js';
import { rewardsErrorResponse } from '../rewardsHttp.js';
import {
  DEMO_CYCLE_DAYS, GIFT_STATE_ACTIONS, MAX_WINNERS, WINNER_STATUSES, cycleAnchorMs, demoCycleOf, demoWinners, giftActiveIntervals,
  mergeWinners, realWinnerItem,
} from '../recentWinners.js';

export const RECENT_WINNERS_CACHE_MS = 30_000;
const DEMO_MEMBERS_MAX = 200;
const DEMO_GIFTS_MAX = 500;

let cache = null; // { at, value }
export function __resetRecentWinnersCache() { cache = null; }

/** Real winners (accepted gift requests), newest first. */
export async function listRealWinners(db, limit = MAX_WINNERS) {
  const rows = await db.rewardRedemption.findMany({
    where: { status: { in: [...WINNER_STATUSES] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true, status: true, createdAt: true, giftSnapshot: true,
      affiliate: { select: { name: true, avatarUrl: true } },
    },
  });
  return rows.map(realWinnerItem).filter(Boolean);
}

/**
 * Demo winners — only while the Demo Competition engine is ON. Identities: ONLY the existing Top
 * Members demo members (demo_comp_members), never a real affiliate:
 *   • current members (not archived) — an active one keeps winning; a disabled one stops at the
 *     moment it was disabled (its last settings version with active = false);
 *   • members archived during the two cycles shown keep the wins dated before their archive date;
 *   • a member created during a cycle only gets the wins scheduled after its creation.
 */
export async function listDemoWinners(db, now) {
  const engine = await db.demoCompEngine.findUnique({ where: { id: 'engine' }, select: { enabled: true, initializedAt: true } });
  if (!engine?.enabled) return [];
  const nowMs = new Date(now).getTime();
  // Cycle anchor = the Top Members start (initializedAt); profiles created without the initial setup → the oldest one.
  let anchor = engine.initializedAt;
  if (!anchor) {
    const first = await db.demoCompMember.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    anchor = first?.createdAt ?? null;
  }
  if (!anchor) return [];
  const anchorMs = cycleAnchorMs(anchor);
  const windowStart = new Date(anchorMs + Math.max(0, demoCycleOf(nowMs, anchorMs) - 1) * DEMO_CYCLE_DAYS * 86_400_000);
  const [rows, gifts] = await Promise.all([
    db.demoCompMember.findMany({
      where: { OR: [{ archivedAt: null }, { archivedAt: { gte: windowStart } }] }, orderBy: { createdAt: 'asc' }, take: DEMO_MEMBERS_MAX,
      select: { id: true, name: true, photoUrl: true, active: true, archivedAt: true, createdAt: true },
    }),
    // every gift (also inactive / archived ones: a past win keeps the gift that was offered then)
    db.rewardGift.findMany({
      where: { createdAt: { lte: new Date(nowMs) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: DEMO_GIFTS_MAX,
      select: { id: true, name: true, images: true, isActive: true, archivedAt: true, createdAt: true },
    }),
  ]);
  // their active periods, from the existing gift audit trail (read only)
  const events = gifts.length ? await db.rewardAuditLog.findMany({
    where: { entityType: 'reward_gift', entityId: { in: gifts.map((g) => g.id) }, action: { in: [...GIFT_STATE_ACTIONS] }, createdAt: { lte: new Date(nowMs) } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { entityId: true, action: true, before: true, after: true, createdAt: true },
  }) : [];
  const byGift = new Map();
  for (const e of events) { if (!byGift.has(e.entityId)) byGift.set(e.entityId, []); byGift.get(e.entityId).push(e); }
  const catalogue = gifts.map((g) => ({ id: g.id, name: g.name, images: g.images, activeIntervals: giftActiveIntervals(g, byGift.get(g.id) || []) }))
    .filter((g) => g.activeIntervals.length); // never-offered drafts never appear
  // When was each disabled (not archived) member switched off? (its latest settings version)
  const disabledIds = rows.filter((m) => !m.archivedAt && !m.active).map((m) => m.id);
  const offAt = new Map();
  if (disabledIds.length) {
    const versions = await db.demoCompMemberVersion.findMany({
      where: { memberId: { in: disabledIds }, active: false }, orderBy: { effectiveFrom: 'desc' },
      select: { memberId: true, effectiveFrom: true },
    });
    for (const v of versions) if (!offAt.has(v.memberId)) offAt.set(v.memberId, v.effectiveFrom);
  }
  const members = rows.map((m) => ({
    id: m.id, name: m.name, photoUrl: m.photoUrl, createdAt: m.createdAt,
    until: m.archivedAt ?? (m.active ? null : (offAt.get(m.id) ?? new Date(0))),
  }));
  return demoWinners({ members, gifts: catalogue, now, anchor, seed: new Date(anchor).toISOString() });
}

/** { enabled, winners } for the affiliate Rewards page (newest first, at most MAX_WINNERS). */
export async function getRecentWinners({ db = prisma, now = new Date(), useCache = true } = {}) {
  const nowMs = new Date(now).getTime();
  if (useCache && cache && nowMs - cache.at >= 0 && nowMs - cache.at < RECENT_WINNERS_CACHE_MS) return cache.value;
  const config = await getRewardsConfig(db);
  let value;
  if (!config.enabled) {
    value = { enabled: false, winners: [] };
  } else {
    const [real, demo] = await Promise.all([listRealWinners(db), listDemoWinners(db, now)]);
    value = { enabled: true, winners: mergeWinners(real, demo, MAX_WINNERS) };
  }
  if (useCache) cache = { at: nowMs, value };
  return value;
}

// ── Route body (GET /api/affiliate/rewards/winners) ──────────────────────────

/**
 * Handler (req, ctx, decoded) for withAffiliateAuth: same rule as the other affiliate Rewards
 * endpoints — the token's affiliate must exist and be active (else 403 AFFILIATE_INACTIVE).
 * Nothing from the request is used; the answer is identical for every affiliate.
 */
export function recentWinnersHandler(deps = {}) {
  const { db = prisma, now = () => new Date(), useCache = true } = deps;
  return async (_req, _ctx, decoded) => {
    try {
      const id = decoded?.affiliateId;
      const acc = typeof id === 'string' && id
        ? await db.affiliate.findUnique({ where: { id }, select: { isActive: true } })
        : null;
      if (!acc?.isActive) throw Object.assign(new Error('Compte inactif'), { code: 'AFFILIATE_INACTIVE' });
      const data = await getRecentWinners({ db, now: now(), useCache });
      return Response.json(data, { status: 200, headers: { 'Cache-Control': 'private, no-store' } });
    } catch (e) {
      return rewardsErrorResponse(e);
    }
  };
}
