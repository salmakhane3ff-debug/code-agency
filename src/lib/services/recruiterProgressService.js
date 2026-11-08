/**
 * src/lib/services/recruiterProgressService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 7 Stage B: PROGRESS of the recruiter's network (READ-ONLY;
 * db injected, so tests run on an in-memory fake or an isolated local database).
 *
 *   • Phase 7 Stage E → F: visibility, progress AND money use the same network N(R) = every affiliate
 *     whose owner (Stage F: the TOPMOST linked affiliate of its chain) is the recruiter
 *     (recruiterNetworkService.js, recruiterRewardService.js) — nothing here awards, reverses or pays anything.
 *   • Per node (every member of N(R)): realDelivered = the node's OWN orders with status exactly
 *     'delivered' AND isFake false (never summed from descendants; taken from the page's order
 *     counts, real.delivered — orderBucket's exact rule), individualThreshold / groupThreshold = the
 *     CURRENT settings (minDeliveredSales / groupMinDeliveredSales), identityApproved (status
 *     APPROVED), qualifiedIndividual / qualifiedGroup = realDelivered ≥ threshold AND identity
 *     APPROVED. Every node (Stage E: every member is reward-eligible) also carries rewardState = the
 *     latest individual cycle of the recruiter's ledger for it ('NONE' | 'AWARDED' | 'REVERSED',
 *     cycle) — already visible in the recruiter's wallet.
 *   • canViewOrders off (includeOrders false): realDelivered, qualifiedIndividual and qualifiedGroup
 *     are null (no other field reveals a delivered count) and nothing here reads orders; rewardState
 *     stays (ledger only).
 *   • Summary (GET /api/recruiter/progress): linked (directly recruited — Stage F: R's links INSIDE N(R);
 *     a legacy link of R inside another recruiter's network is not counted) / network (|N(R)|, field
 *     downlineAffiliates) counts, the group progress (qualifiedForGroup = members of N(R) with real
 *     delivered ≥ groupMinDeliveredSales AND identity APPROVED — the group reward's count; progressTowardNextGroup = qualified − active × size,
 *     clamped to [0, size]), the switches and thresholds, and the recruiter's own ledger counts and
 *     amounts (cents) by type. Aggregates only: no per-affiliate delivered count.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { IDENTITY_APPROVED_STATUS, REWARD_TYPES, groupRewardsOn } from '../recruiterSettings.js';
import { getCurrentRecruiterSettingsWithGroup } from './recruiterRewardService.js';
import { NETWORK_LIMITS, countNetwork, networkIdsWithRealDelivered } from './recruiterNetworkService.js';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const fail = (code) => Object.assign(new Error(code), { code });
/** Affiliate ids per identity count statement (the same chunk as the group reward's). */
export const PROGRESS_QUALIFIED_CHUNK = 5000;
export const REWARD_STATES = Object.freeze({ NONE: 'NONE', AWARDED: 'AWARDED', REVERSED: 'REVERSED' });

/** The current thresholds and switches of both reward types (one settings read). */
export async function getProgressSettings({ db = prisma } = {}) {
  const s = await getCurrentRecruiterSettingsWithGroup({ db });
  return {
    individualThreshold: s.minDeliveredSales,
    groupThreshold: s.groupMinDeliveredSales,
    groupSize: s.groupSize,
    individualEnabled: s.enabled === true && s.rewardAmountCents > 0,
    groupEnabled: groupRewardsOn(s),
  };
}

/**
 * Progress of ONE node from its page data ({ orders, identityStatus }) — pure.
 * includeOrders false → every delivered-derived value is null.
 */
export function nodeProgress(node, settings, includeOrders) {
  const approved = node?.identityStatus === IDENTITY_APPROVED_STATUS;
  const d = node?.orders?.real?.delivered;
  const delivered = includeOrders === true && Number.isInteger(d) && d >= 0 ? d : null;
  return {
    realDelivered: delivered,
    individualThreshold: settings.individualThreshold,
    groupThreshold: settings.groupThreshold,
    identityApproved: approved,
    qualifiedIndividual: delivered === null ? null : delivered >= settings.individualThreshold && approved,
    qualifiedGroup: delivered === null ? null : delivered >= settings.groupThreshold && approved,
  };
}

/**
 * The latest individual reward cycle of each affiliate in `ids` (members of N(R)) for this recruiter (ledger
 * rows of type RECRUIT_REWARD / REVERSAL — type and cycle only). → Map(id → { state, cycle })
 */
export async function latestRewardStates(recruiterId, ids, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string'))];
  const out = new Map();
  if (!list.length) return out;
  // a page of at most PAGE_MAX nodes + the scope's own card (the network details view) — never more
  if (list.length > NETWORK_LIMITS.PAGE_MAX + 1) throw fail('INVALID_INPUT');
  const rows = await db.recruiterRewardLedger.findMany({
    where: { recruiterId, affiliateId: { in: list }, type: { in: [REWARD_TYPES.RECRUIT_REWARD, REWARD_TYPES.REVERSAL] } },
    select: { affiliateId: true, type: true, cycle: true },
  });
  const latest = new Map(); // id → highest reward cycle
  const reversed = new Set(); // `${id}:${cycle}`
  for (const r of Array.isArray(rows) ? rows : []) {
    if (typeof r?.affiliateId !== 'string' || !Number.isInteger(r.cycle)) continue;
    if (r.type === REWARD_TYPES.RECRUIT_REWARD && r.cycle > (latest.get(r.affiliateId) ?? 0)) latest.set(r.affiliateId, r.cycle);
    if (r.type === REWARD_TYPES.REVERSAL) reversed.add(`${r.affiliateId}:${r.cycle}`);
  }
  for (const id of list) {
    const cycle = latest.get(id);
    out.set(id, cycle ? { state: reversed.has(`${id}:${cycle}`) ? REWARD_STATES.REVERSED : REWARD_STATES.AWARDED, cycle } : { state: REWARD_STATES.NONE, cycle: null });
  }
  return out;
}

/**
 * Adds `progress` and `rewardState` to page nodes (members of N(R)) that carry { id, identityStatus,
 * orders }. Two reads: the settings and the recruiter's ledger rows of those nodes (Phase 7 Stage E:
 * every member, linked to the recruiter or not). Never reads orders.
 */
export async function withProgress(recruiterId, nodes, { db = prisma, includeOrders = true } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return [];
  const settings = await getProgressSettings({ db });
  const states = await latestRewardStates(recruiterId, list.map((n) => n?.id), { db });
  return list.map((n) => ({
    ...n,
    progress: nodeProgress(n, settings, includeOrders),
    rewardState: states.get(n?.id) ?? { state: REWARD_STATES.NONE, cycle: null },
  }));
}

/** Count and amount (cents) of the recruiter's own ledger rows by type (one grouped read). */
async function ledgerByType(db, recruiterId) {
  const groups = await db.recruiterRewardLedger.groupBy({ by: ['type'], where: { recruiterId }, _count: { _all: true }, _sum: { amountCents: true } });
  const out = new Map();
  for (const g of Array.isArray(groups) ? groups : []) {
    out.set(g?.type, { count: Number(g?._count?._all ?? 0) || 0, cents: Number(g?._sum?.amountCents ?? 0) || 0 });
  }
  const of = (type) => out.get(type) ?? { count: 0, cents: 0 };
  return {
    individualAwarded: of(REWARD_TYPES.RECRUIT_REWARD), individualReversed: of(REWARD_TYPES.REVERSAL),
    groupAwarded: of(REWARD_TYPES.GROUP_REWARD), groupReversed: of(REWARD_TYPES.GROUP_REVERSAL),
  };
}

/**
 * The recruiter's progress summary. Statements: links count, settings, |N(R)| + its linked members (one walk), the
 * members of N(R) with ≥ groupThreshold real delivered orders (one statement) + their APPROVED
 * identity count (chunked), the ledger grouped by type. Amounts are positive cents (a reversal row is
 * negative in the ledger; reversedCents is its absolute total). Visible with canViewOrders off: the only
 * order-derived value is the aggregate qualifiedForGroup.
 */
export async function getRecruiterProgressSummary(recruiterId, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const links = await db.recruiterAffiliateLink.count({ where: { recruiterId } });
  const settings = await getProgressSettings({ db });
  let linkedAffiliates = 0;
  let downlineAffiliates = 0;
  let qualifiedForGroup = 0;
  if (links > 0) {
    // Stage F: one statement gives |N(R)| and R's links inside it (never a legacy link owned by another recruiter)
    ({ members: downlineAffiliates, linked: linkedAffiliates } = await countNetwork(recruiterId, { db }));
    const ids = await networkIdsWithRealDelivered(recruiterId, settings.groupThreshold, { db });
    for (let i = 0; i < ids.length; i += PROGRESS_QUALIFIED_CHUNK) {
      qualifiedForGroup += await db.identityVerification.count({ where: { affiliateId: { in: ids.slice(i, i + PROGRESS_QUALIFIED_CHUNK) }, status: IDENTITY_APPROVED_STATUS } });
    }
  }
  const ledger = await ledgerByType(db, recruiterId);
  const activeGroupRewards = Math.max(0, ledger.groupAwarded.count - ledger.groupReversed.count);
  const size = settings.groupSize;
  return {
    linkedAffiliates,
    downlineAffiliates,
    qualifiedForGroup,
    groupSize: size,
    activeGroupRewards,
    progressTowardNextGroup: Math.min(size, Math.max(0, qualifiedForGroup - activeGroupRewards * size)),
    groupEnabled: settings.groupEnabled,
    individualEnabled: settings.individualEnabled,
    individualThreshold: settings.individualThreshold,
    groupThreshold: settings.groupThreshold,
    rewards: {
      individual: {
        awarded: ledger.individualAwarded.count, awardedCents: ledger.individualAwarded.cents,
        reversed: ledger.individualReversed.count, reversedCents: -ledger.individualReversed.cents,
      },
      group: {
        awarded: ledger.groupAwarded.count, awardedCents: ledger.groupAwarded.cents,
        reversed: ledger.groupReversed.count, reversedCents: -ledger.groupReversed.cents,
      },
    },
  };
}
