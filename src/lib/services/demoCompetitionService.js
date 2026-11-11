/**
 * src/lib/services/demoCompetitionService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition (Top Members / Top Brands) — persistence, generation and stats.
 *
 * SIMULATION ONLY. This service touches the demo_comp_* tables and NOTHING else:
 * no order, affiliate, payout, wallet, deposit, booster, UGC, reward, recruiter or
 * Create-Your-Own-Brand table, and it registers no balance provider. Every amount
 * is a simulated reporting value (centimes), never money.
 *
 * Generation (see ../demoCompetition/engine.js for the pure rules)
 *   • materializeProfile(): under a per-profile transaction advisory lock, create
 *     the missing daily plans and the events whose scheduled time has passed,
 *     with createMany({ skipDuplicates }) on the unique idempotency key — running
 *     it twice, or from two processes at once, never duplicates an event.
 *   • A per-stream cursor (…GeneratedThrough) only avoids re-reading old days;
 *     correctness never depends on it (the unique keys do).
 *   • Catch-up is bounded (CATCH_UP_DAYS) so a long outage cannot block a request.
 *
 * Stats: rolling windows are SQL sums over demo_comp_events with
 * scheduledAt ∈ (now − window, now]; all-time = every event ≤ now.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import defaultPrisma from '../prisma.js';
import {
  STREAMS, EVENT_TYPES, WINDOWS, DAY_MS, HOUR_MS, MAX_MEMBERS, MAX_BRANDS, DEFAULTS, BACKFILL_DAYS,
  backfillStart, dayKeyOf, dayKeysBetween, addDays, buildPlan, dueEvents, rankProfiles, rankChange, isLive,
  validateMemberSettings, validateBrandSettings, validateDefaults, normalizeName,
} from '../demoCompetition/engine.js';

/** Days of missed history one materialisation may generate (≥ the 30-day backfill + today). */
export const CATCH_UP_DAYS = BACKFILL_DAYS + 2;
/** Minimum spacing of read-triggered catch-ups (per process and per engine row). */
export const READ_CATCH_UP_MS = 5_000;
/** In-process cache of public reads (keeps polling cheap; well under the 5 s poll). */
export const READ_CACHE_MS = 2_000;

const ENGINE_ID = 'engine';
const MEMBER = 'member';
const BRAND = 'brand';

export class DemoCompError extends Error {
  constructor(code, status = 400, details) {
    super(code);
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

const lockKey = (profileId) => `demo-comp:${profileId}`;
const INIT_LOCK = 'demo-comp:initialize';

/** Per-key transaction advisory lock (no-op on fake clients without raw SQL). */
async function xactLock(tx, key) {
  if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${String(key)}::text))`;
}

const TX_OPTS = { timeout: 60_000, maxWait: 20_000 };
const nowOf = (deps) => (typeof deps?.now === 'function' ? deps.now() : Date.now());
const dbOf = (deps) => deps?.db ?? defaultPrisma;

// ── Settings shapes ───────────────────────────────────────────────────────────

const MEMBER_ENGINE_FIELDS = ['active', 'minDailyOrders', 'maxDailyOrders', 'priceCents', 'allocationBps',
  'networkAffiliates', 'networkMinDailyOrders', 'networkMaxDailyOrders', 'networkPriceCents', 'networkAllocationBps'];
const BRAND_ENGINE_FIELDS = ['active', 'minDailyOrders', 'maxDailyOrders', 'priceCents', 'allocationBps'];

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
const differs = (a, b, keys) => keys.some((k) => (a[k] ?? null) !== (b[k] ?? null));

// ── Engine row ────────────────────────────────────────────────────────────────

export async function getEngine(deps = {}) {
  const db = dbOf(deps);
  const row = await db.demoCompEngine.findUnique({ where: { id: ENGINE_ID } });
  if (row) return row;
  return db.demoCompEngine.upsert({ where: { id: ENGINE_ID }, update: {}, create: { id: ENGINE_ID } });
}

/**
 * Admin: switch the engine on / off and change the default price / allocations for new profiles.
 * OFF = no event is generated for that period; switching back ON resumes from the current time.
 */
export async function updateEngine(deps = {}, patch = {}) {
  const db = dbOf(deps);
  const cur = await getEngine(deps);
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled,
    defaultPriceCents: patch.defaultPriceCents ?? cur.defaultPriceCents,
    defaultMemberBps: patch.defaultMemberBps ?? cur.defaultMemberBps,
    defaultBrandBps: patch.defaultBrandBps ?? cur.defaultBrandBps,
  };
  if (typeof next.enabled !== 'boolean') throw new DemoCompError('INVALID_INPUT', 400, { enabled: 'INVALID_ACTIVE' });
  const v = validateDefaults(next);
  if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
  // OFF → ON: generation resumes from NOW. The time the engine was off is never generated (no catch-up).
  // ON → OFF: remember when, so a profile created while OFF gets its history only up to that moment.
  const at = new Date(nowOf(deps));
  const data = next.enabled && !cur.enabled ? { ...next, resumedAt: at }
    : !next.enabled && cur.enabled ? { ...next, pausedAt: at } : next;
  const saved = await db.demoCompEngine.update({ where: { id: ENGINE_ID }, data });
  invalidateReadCache();
  return saved;
}

// ── Generation ────────────────────────────────────────────────────────────────

const STREAM_CURSOR = { PERSONAL: 'personalGeneratedThrough', NETWORK: 'networkGeneratedThrough', BRAND: 'generatedThrough' };

/**
 * Create the missing plans and due events of one profile up to `now` (bounded catch-up).
 * Safe to call concurrently and repeatedly. Returns { events } (newly inserted).
 * opts.resumedAt: when the engine was last switched ON — nothing is generated at or before it for a profile
 * that had already been generated (the OFF period is skipped).
 */
export async function materializeProfile(deps, kind, profileId, opts = {}) {
  const db = dbOf(deps);
  const now = opts.now ?? nowOf(deps);
  const maxDays = opts.maxDays ?? CATCH_UP_DAYS;
  return db.$transaction(async (tx) => {
    await xactLock(tx, lockKey(profileId));
    const isMember = kind === MEMBER;
    const profile = isMember
      ? await tx.demoCompMember.findUnique({ where: { id: profileId } })
      : await tx.demoCompBrand.findUnique({ where: { id: profileId } });
    if (!profile || profile.archivedAt) return { events: 0 }; // archived: never generates again
    const versions = isMember
      ? await tx.demoCompMemberVersion.findMany({ where: { memberId: profileId }, orderBy: { effectiveFrom: 'asc' } })
      : await tx.demoCompBrandVersion.findMany({ where: { brandId: profileId }, orderBy: { effectiveFrom: 'asc' } });
    if (!versions.length) return { events: 0 };
    const historyStart = +new Date(versions[0].effectiveFrom);

    let inserted = 0;
    const cursorUpdate = {};
    for (const stream of isMember ? [STREAMS.PERSONAL, STREAMS.NETWORK] : [STREAMS.BRAND]) {
      const field = STREAM_CURSOR[stream];
      // Never generated → the backfill from historyStart. Otherwise from the cursor, but never before the engine was
      // last switched ON (opts.resumedAt): the period the engine was OFF is skipped, not caught up.
      const from = profile[field]
        ? Math.max(+new Date(profile[field]), opts.resumedAt ? +new Date(opts.resumedAt) : -Infinity)
        : historyStart - 1;
      const to = Math.min(now, from + maxDays * DAY_MS);
      if (to <= from) {
        // Nothing to generate (e.g. a profile created long after the engine was switched OFF): still record how far
        // it was generated, so switching ON later resumes from then and never backfills the OFF period.
        if (!profile[field]) cursorUpdate[field] = new Date(to);
        continue;
      }
      const keys = dayKeysBetween(dayKeyOf(Math.max(from + 1, historyStart)), dayKeyOf(to));
      const built = keys.map((k) => buildPlan(stream, profileId, k, versions)).filter(Boolean);
      if (built.length) {
        await tx.demoCompDailyPlan.createMany({
          data: built.map((p) => ({
            stream, profileKey: profileId,
            memberId: isMember ? profileId : null, brandId: isMember ? null : profileId,
            dayKey: p.dayKey, dayStart: new Date(p.dayStart), dayEnd: new Date(p.dayEnd),
            targetOrders: p.targetOrders, minOrders: p.minOrders, maxOrders: p.maxOrders, versionId: p.versionId,
          })),
          skipDuplicates: true,
        });
        // The STORED plans are authoritative (a plan is never rewritten once created).
        const stored = await tx.demoCompDailyPlan.findMany({ where: { stream, profileKey: profileId, dayKey: { in: built.map((p) => p.dayKey) } } });
        const events = [];
        for (const sp of stored) {
          const plan = { stream, profileId, dayKey: sp.dayKey, dayStart: +new Date(sp.dayStart), dayEnd: +new Date(sp.dayEnd), targetOrders: sp.targetOrders };
          for (const e of dueEvents(plan, versions, from, to)) {
            events.push({
              ...e, scheduledAt: new Date(e.scheduledAt), planId: sp.id,
              memberId: isMember ? profileId : null, brandId: isMember ? null : profileId,
            });
          }
        }
        if (events.length) {
          const res = await tx.demoCompEvent.createMany({ data: events, skipDuplicates: true });
          inserted += res?.count ?? 0;
        }
      }
      cursorUpdate[field] = new Date(to);
    }
    if (Object.keys(cursorUpdate).length) {
      if (isMember) await tx.demoCompMember.update({ where: { id: profileId }, data: cursorUpdate });
      else await tx.demoCompBrand.update({ where: { id: profileId }, data: cursorUpdate });
    }
    return { events: inserted };
  }, TX_OPTS);
}

/**
 * Materialise every non-archived profile (members, then brands). Used by the worker, the read-path catch-up
 * and the admin "run now". While the engine is OFF nothing is generated at all.
 */
export async function runEngine(deps = {}, opts = {}) {
  const db = dbOf(deps);
  const engine = await getEngine(deps);
  if (!engine.enabled) return { skipped: 'disabled' };
  const now = opts.now ?? nowOf(deps);
  let events = 0, profiles = 0, lastError = null;
  const live = { where: { archivedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } };
  const members = await db.demoCompMember.findMany(live);
  const brands = await db.demoCompBrand.findMany(live);
  for (const [kind, list] of [[MEMBER, members], [BRAND, brands]]) {
    for (const { id } of list) {
      try {
        const r = await materializeProfile(deps, kind, id, { now, resumedAt: engine.resumedAt });
        events += r.events;
        profiles += 1;
      } catch (err) {
        lastError = `${kind} ${id}: ${String(err?.code || err?.message || err).slice(0, 200)}`;
      }
    }
  }
  await db.demoCompEngine.update({
    where: { id: ENGINE_ID },
    data: { lastRunAt: new Date(now), lastRunEvents: events, lastError },
  }).catch(() => {});
  invalidateReadCache();
  return { events, profiles, error: lastError };
}

/** Session advisory-lock key of the demo-leaderboard-engine worker ("DCMP"; distinct from every other engine). */
export const DEMO_COMP_ENGINE_LOCK_KEY = 0x44434d50;

/** One worker tick: only the holder of the session lock runs the engine (no-op when disabled). */
export async function runDemoCompTick({ lock, ...deps } = {}) {
  if (lock) {
    const held = await lock.acquire();
    if (!held) return { skipped: 'no_lock' };
  }
  try {
    return await runEngine(deps);
  } finally {
    if (lock) await lock.release();
  }
}

let lastReadCatchUp = 0;
let readCatchUpInFlight = null;
/**
 * Read-path catch-up: keeps the leaderboard alive even if the worker is not running.
 * Throttled per process and per engine row; never throws into the read.
 */
export async function catchUpOnRead(deps = {}) {
  const now = nowOf(deps);
  if (readCatchUpInFlight) return { skipped: 'in_flight' }; // one read-path run per process at a time
  if (now - lastReadCatchUp < READ_CATCH_UP_MS) return { skipped: 'throttled' };
  lastReadCatchUp = now;
  readCatchUpInFlight = (async () => {
    try {
      const engine = await getEngine(deps);
      if (!engine.enabled) return { skipped: 'disabled' };
      if (engine.lastRunAt && now - +new Date(engine.lastRunAt) < READ_CATCH_UP_MS) return { skipped: 'fresh' };
      return await runEngine(deps, { now });
    } catch (err) {
      return { skipped: 'error', error: String(err?.message || err) };
    }
  })();
  try { return await readCatchUpInFlight; } finally { readCatchUpInFlight = null; }
}

/** Test helper: reset the per-process throttles and caches. */
export function __resetDemoCompState() { lastReadCatchUp = 0; readCatchUpInFlight = null; invalidateReadCache(); }

// ── Stats ─────────────────────────────────────────────────────────────────────

const KEY = { [MEMBER]: 'memberId', [BRAND]: 'brandId' };

async function sumsBy(db, kind, eventType, from, to) {
  const where = { eventType, scheduledAt: { lte: new Date(to) } };
  if (from !== null) where.scheduledAt.gt = new Date(from);
  const rows = await db.demoCompEvent.groupBy({
    by: [KEY[kind]], where, _sum: { earningsCents: true, quantity: true }, _max: { scheduledAt: true },
  });
  const out = new Map();
  for (const r of rows) {
    out.set(r[KEY[kind]], {
      earnings: r._sum?.earningsCents ?? 0, orders: r._sum?.quantity ?? 0, last: r._max?.scheduledAt ?? null,
    });
  }
  return out;
}

const zero = { earnings: 0, orders: 0, last: null };

/**
 * Stats of every profile of one kind: rolling 24 h / 7 d / 30 d, all-time, network (members),
 * rank by rolling 30-day earnings, and the rank change vs. 24 hours earlier.
 */
async function computeStats(db, kind, now, { includeInactive = false } = {}) {
  const isMember = kind === MEMBER;
  const profiles = isMember
    ? await db.demoCompMember.findMany({ where: includeInactive ? {} : { active: true, archivedAt: null }, orderBy: { createdAt: 'asc' } })
    : await db.demoCompBrand.findMany({
      where: includeInactive ? {} : { active: true, archivedAt: null }, orderBy: { createdAt: 'asc' },
      include: { owner: { select: { id: true, name: true, photoUrl: true, active: true, archivedAt: true } } },
    });
  const type = isMember ? EVENT_TYPES.PERSONAL : EVENT_TYPES.BRAND;
  const [h24, d7, d30, prev30, all] = await Promise.all([
    sumsBy(db, kind, type, now - WINDOWS.h24, now),
    sumsBy(db, kind, type, now - WINDOWS.d7, now),
    sumsBy(db, kind, type, now - WINDOWS.d30, now),
    sumsBy(db, kind, type, now - WINDOWS.d30 - WINDOWS.h24, now - WINDOWS.h24),
    sumsBy(db, kind, type, null, now),
  ]);
  const [net30, netAll] = isMember
    ? await Promise.all([sumsBy(db, kind, EVENT_TYPES.NETWORK, now - WINDOWS.d30, now), sumsBy(db, kind, EVENT_TYPES.NETWORK, null, now)])
    : [new Map(), new Map()];

  const rows = profiles.map((p) => {
    const a = all.get(p.id) ?? zero;
    return {
      profile: p, id: p.id, createdAt: p.createdAt,
      earnings24hCents: (h24.get(p.id) ?? zero).earnings,
      earnings7dCents: (d7.get(p.id) ?? zero).earnings,
      earnings30dCents: (d30.get(p.id) ?? zero).earnings,
      orders24h: (h24.get(p.id) ?? zero).orders,
      orders7d: (d7.get(p.id) ?? zero).orders,
      orders30d: (d30.get(p.id) ?? zero).orders,
      earningsAllCents: a.earnings,
      ordersAll: a.orders,
      lastEventAt: a.last,
      networkEarnings30dCents: (net30.get(p.id) ?? zero).earnings,
      networkEarningsAllCents: (netAll.get(p.id) ?? zero).earnings,
      networkOrdersAll: (netAll.get(p.id) ?? zero).orders,
      prevEarnings30dCents: (prev30.get(p.id) ?? zero).earnings,
      prevOrders30d: (prev30.get(p.id) ?? zero).orders,
    };
  });
  const ranked = rankProfiles(rows);
  const prev = new Map(rankProfiles(rows.map((r) => ({ ...r, earnings30dCents: r.prevEarnings30dCents, orders30d: r.prevOrders30d })))
    .map((r) => [r.id, r.rank]));
  return ranked.map((r) => ({ ...r, rankChange24h: rankChange(prev.get(r.id), r.rank), live: isLive(r.lastEventAt, now) }));
}

const cache = new Map();
const CACHE_MAX_KEYS = 200; // bounded: arbitrary (unknown) profile ids cannot grow it without limit
function invalidateReadCache() { cache.clear(); }
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  const t = Date.now();
  if (hit && t - hit.at < ttl) return hit.value;
  const value = await fn();
  if (ttl > 0) {
    if (cache.size >= CACHE_MAX_KEYS && !cache.has(key)) cache.clear();
    cache.set(key, { at: t, value });
  }
  return value;
}
/** Stats of one kind, shared by the leaderboards and the public profiles (same short TTL). */
const statsOf = (deps, kind, now) => cached(`stats:${kind}`, deps.db ? 0 : READ_CACHE_MS, () => computeStats(dbOf(deps), kind, now));

const publicMember = (r) => ({
  id: r.id, name: r.profile.name, photoUrl: r.profile.photoUrl ?? null, rank: r.rank, rankChange24h: r.rankChange24h,
  earnings30dCents: r.earnings30dCents, orders30d: r.orders30d, ordersAll: r.ordersAll,
  networkEarnings30dCents: r.networkEarnings30dCents, networkAffiliates: r.profile.networkAffiliates,
  live: r.live, lastEventAt: r.lastEventAt,
});
const publicBrand = (r) => ({
  id: r.id, name: r.profile.name, imageUrl: r.profile.imageUrl ?? null, rank: r.rank, rankChange24h: r.rankChange24h,
  earnings30dCents: r.earnings30dCents, orders30d: r.orders30d, ordersAll: r.ordersAll,
  owner: r.profile.owner ? { id: r.profile.owner.id, name: r.profile.owner.name, photoUrl: r.profile.owner.photoUrl ?? null, public: r.profile.owner.active } : null,
  live: r.live, lastEventAt: r.lastEventAt,
});

/** Public leaderboard of active members (rank by rolling 30-day personal earnings). */
export async function getMemberLeaderboard(deps = {}, { limit = MAX_MEMBERS } = {}) {
  const lim = Math.max(1, Math.min(MAX_MEMBERS, Number(limit) || MAX_MEMBERS));
  return cached(`members:${lim}`, deps.db ? 0 : READ_CACHE_MS, async () => {
    const now = nowOf(deps);
    const rows = await statsOf(deps, MEMBER, now);
    return { asOf: new Date(now).toISOString(), simulation: true, total: rows.length, members: rows.slice(0, lim).map(publicMember) };
  });
}

/** Public leaderboard of active brands (rank by rolling 30-day brand earnings). */
export async function getBrandLeaderboard(deps = {}, { limit = MAX_BRANDS } = {}) {
  const lim = Math.max(1, Math.min(MAX_BRANDS, Number(limit) || MAX_BRANDS));
  return cached(`brands:${lim}`, deps.db ? 0 : READ_CACHE_MS, async () => {
    const now = nowOf(deps);
    const rows = await statsOf(deps, BRAND, now);
    return { asOf: new Date(now).toISOString(), simulation: true, total: rows.length, brands: rows.slice(0, lim).map(publicBrand) };
  });
}

/** Daily history (last 30 Casablanca days, oldest first) + the 10 latest events of one stream. */
async function historyOf(db, kind, id, eventTypes, now) {
  const firstDay = addDays(dayKeyOf(now), -(BACKFILL_DAYS - 1));
  const events = await db.demoCompEvent.findMany({
    where: { [KEY[kind]]: id, eventType: { in: eventTypes }, scheduledAt: { gt: new Date(now - (BACKFILL_DAYS + 1) * DAY_MS), lte: new Date(now) } },
    select: { eventType: true, quantity: true, earningsCents: true, scheduledAt: true },
    orderBy: { scheduledAt: 'asc' },
  });
  const days = new Map(dayKeysBetween(firstDay, dayKeyOf(now)).map((k) => [k, { day: k, orders: 0, earningsCents: 0, networkOrders: 0, networkEarningsCents: 0 }]));
  for (const e of events) {
    const d = days.get(dayKeyOf(+new Date(e.scheduledAt)));
    if (!d) continue;
    if (e.eventType === EVENT_TYPES.NETWORK) { d.networkOrders += e.quantity; d.networkEarningsCents += e.earningsCents; }
    else { d.orders += e.quantity; d.earningsCents += e.earningsCents; }
  }
  const recent = events.slice(-10).reverse().map((e) => ({
    type: e.eventType, quantity: e.quantity, earningsCents: e.earningsCents, at: e.scheduledAt,
  }));
  return { daily: [...days.values()], recent };
}

const windowStats = (r) => ({
  earnings24hCents: r.earnings24hCents, earnings7dCents: r.earnings7dCents, earnings30dCents: r.earnings30dCents,
  earningsAllCents: r.earningsAllCents, orders24h: r.orders24h, orders7d: r.orders7d, orders30d: r.orders30d, ordersAll: r.ordersAll,
});

/** Public profile of an ACTIVE member (null when unknown or disabled). Cached per id for READ_CACHE_MS. */
export async function getPublicMember(deps = {}, id) {
  return cached(`member:${id}`, deps.db ? 0 : READ_CACHE_MS, () => publicMemberProfile(deps, id));
}
async function publicMemberProfile(deps, id) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const rows = await statsOf(deps, MEMBER, now);
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  const netWin = await Promise.all([WINDOWS.h24, WINDOWS.d7].map((w) => sumsBy(db, MEMBER, EVENT_TYPES.NETWORK, now - w, now)));
  const brands = await db.demoCompBrand.findMany({ where: { ownerId: id, active: true }, select: { id: true, name: true, imageUrl: true }, orderBy: { createdAt: 'asc' } });
  const history = await historyOf(db, MEMBER, id, [EVENT_TYPES.PERSONAL, EVENT_TYPES.NETWORK], now);
  return {
    asOf: new Date(now).toISOString(), simulation: true,
    member: {
      ...publicMember(r), createdAt: r.profile.createdAt, total: rows.length,
      stats: windowStats(r),
      network: {
        affiliates: r.profile.networkAffiliates,
        configured: r.profile.networkPriceCents != null && r.profile.networkAllocationBps != null,
        earnings24hCents: (netWin[0].get(id) ?? zero).earnings, earnings7dCents: (netWin[1].get(id) ?? zero).earnings,
        earnings30dCents: r.networkEarnings30dCents, earningsAllCents: r.networkEarningsAllCents, ordersAll: r.networkOrdersAll,
      },
      brands,
      history,
    },
  };
}

/** Public profile of an ACTIVE brand (null when unknown or disabled). Cached per id for READ_CACHE_MS. */
export async function getPublicBrand(deps = {}, id) {
  return cached(`brand:${id}`, deps.db ? 0 : READ_CACHE_MS, () => publicBrandProfile(deps, id));
}
async function publicBrandProfile(deps, id) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const rows = await statsOf(deps, BRAND, now);
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  const history = await historyOf(db, BRAND, id, [EVENT_TYPES.BRAND], now);
  return {
    asOf: new Date(now).toISOString(), simulation: true,
    brand: { ...publicBrand(r), createdAt: r.profile.createdAt, total: rows.length, stats: windowStats(r), history },
  };
}

// ── Admin: lists ──────────────────────────────────────────────────────────────

const memberSettings = (p) => ({
  name: p.name, active: p.active, minDailyOrders: p.minDailyOrders, maxDailyOrders: p.maxDailyOrders,
  priceCents: p.priceCents, allocationBps: p.allocationBps, networkAffiliates: p.networkAffiliates,
  networkMinDailyOrders: p.networkMinDailyOrders, networkMaxDailyOrders: p.networkMaxDailyOrders,
  networkPriceCents: p.networkPriceCents, networkAllocationBps: p.networkAllocationBps,
});
const brandSettings = (p) => ({
  name: p.name, ownerId: p.ownerId, active: p.active, minDailyOrders: p.minDailyOrders, maxDailyOrders: p.maxDailyOrders,
  priceCents: p.priceCents, allocationBps: p.allocationBps,
});

export async function adminListMembers(deps = {}) {
  const now = nowOf(deps);
  const db = dbOf(deps);
  const rows = await computeStats(db, MEMBER, now, { includeInactive: true });
  const owned = await db.demoCompBrand.groupBy({ by: ['ownerId'], where: { archivedAt: null }, _count: { _all: true } });
  const brandsOf = new Map(owned.map((o) => [o.ownerId, o._count?._all ?? 0]));
  return {
    asOf: new Date(now).toISOString(), max: MAX_MEMBERS,
    members: rows.map((r) => ({
      id: r.id, photoUrl: r.profile.photoUrl ?? null, createdAt: r.profile.createdAt, archivedAt: r.profile.archivedAt ?? null, ...memberSettings(r.profile),
      rank: r.profile.active ? r.rank : null, brands: brandsOf.get(r.id) ?? 0, live: r.live, lastEventAt: r.lastEventAt,
      stats: windowStats(r),
      network: { earnings30dCents: r.networkEarnings30dCents, earningsAllCents: r.networkEarningsAllCents, ordersAll: r.networkOrdersAll },
    })),
  };
}

export async function adminListBrands(deps = {}) {
  const now = nowOf(deps);
  const rows = await computeStats(dbOf(deps), BRAND, now, { includeInactive: true });
  return {
    asOf: new Date(now).toISOString(), max: MAX_BRANDS,
    brands: rows.map((r) => ({
      id: r.id, imageUrl: r.profile.imageUrl ?? null, createdAt: r.profile.createdAt, archivedAt: r.profile.archivedAt ?? null, ...brandSettings(r.profile),
      owner: r.profile.owner ? { id: r.profile.owner.id, name: r.profile.owner.name, photoUrl: r.profile.owner.photoUrl ?? null, archivedAt: r.profile.owner.archivedAt ?? null } : null,
      rank: r.profile.active ? r.rank : null, live: r.live, lastEventAt: r.lastEventAt, stats: windowStats(r),
    })),
  };
}

/** Admin detail: settings, settings history, stats and the 30-day daily history. */
export async function adminGetMember(deps = {}, id) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const rows = await computeStats(db, MEMBER, now, { includeInactive: true });
  const r = rows.find((x) => x.id === id);
  if (!r) throw new DemoCompError('NOT_FOUND', 404);
  const versions = await db.demoCompMemberVersion.findMany({ where: { memberId: id }, orderBy: { effectiveFrom: 'desc' }, take: 50 });
  const brands = await db.demoCompBrand.findMany({ where: { ownerId: id }, select: { id: true, name: true, imageUrl: true, active: true, archivedAt: true }, orderBy: { createdAt: 'asc' } });
  return {
    asOf: new Date(now).toISOString(),
    member: {
      id, photoUrl: r.profile.photoUrl ?? null, createdAt: r.profile.createdAt, archivedAt: r.profile.archivedAt ?? null, ...memberSettings(r.profile),
      rank: r.profile.active ? r.rank : null, live: r.live, lastEventAt: r.lastEventAt, stats: windowStats(r),
      network: { earnings30dCents: r.networkEarnings30dCents, earningsAllCents: r.networkEarningsAllCents, ordersAll: r.networkOrdersAll },
      brands, versions, history: await historyOf(db, MEMBER, id, [EVENT_TYPES.PERSONAL, EVENT_TYPES.NETWORK], now),
    },
  };
}

export async function adminGetBrand(deps = {}, id) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const rows = await computeStats(db, BRAND, now, { includeInactive: true });
  const r = rows.find((x) => x.id === id);
  if (!r) throw new DemoCompError('NOT_FOUND', 404);
  const versions = await db.demoCompBrandVersion.findMany({ where: { brandId: id }, orderBy: { effectiveFrom: 'desc' }, take: 50 });
  return {
    asOf: new Date(now).toISOString(),
    brand: {
      id, imageUrl: r.profile.imageUrl ?? null, createdAt: r.profile.createdAt, archivedAt: r.profile.archivedAt ?? null, ...brandSettings(r.profile),
      owner: r.profile.owner ? { id: r.profile.owner.id, name: r.profile.owner.name, photoUrl: r.profile.owner.photoUrl ?? null, archivedAt: r.profile.owner.archivedAt ?? null } : null,
      rank: r.profile.active ? r.rank : null, live: r.live, lastEventAt: r.lastEventAt, stats: windowStats(r),
      versions, history: await historyOf(db, BRAND, id, [EVENT_TYPES.BRAND], now),
    },
  };
}

// ── Admin: create / update / archive ──────────────────────────────────────────

function memberInput(input, base) {
  const s = { ...base };
  for (const k of ['name', 'active', 'minDailyOrders', 'maxDailyOrders', 'priceCents', 'allocationBps', 'networkAffiliates',
    'networkMinDailyOrders', 'networkMaxDailyOrders', 'networkPriceCents', 'networkAllocationBps']) {
    if (input[k] !== undefined) s[k] = input[k];
  }
  s.name = normalizeName(s.name);
  return s;
}

function brandInput(input, base) {
  const s = { ...base };
  for (const k of ['name', 'ownerId', 'active', 'minDailyOrders', 'maxDailyOrders', 'priceCents', 'allocationBps']) {
    if (input[k] !== undefined) s[k] = input[k];
  }
  s.name = normalizeName(s.name);
  return s;
}

/**
 * A new profile gets its BACKFILL_DAYS-day history immediately: up to its creation time (engine ON, or never
 * switched ON yet), or up to the moment the engine was switched OFF (nothing is ever generated for an OFF
 * period). Live generation after that only happens while the engine is ON. A failure here is not fatal: the next
 * engine run (ON) completes the backfill.
 */
async function backfillAtCreation(deps, kind, id, now) {
  try {
    // Engine OFF after having run: the history stops where the engine was switched off (nothing for the OFF
    // period). Engine never switched ON yet (initial setup): the history runs up to now.
    const engine = await getEngine(deps);
    const until = !engine.enabled && engine.pausedAt ? Math.min(now, +new Date(engine.pausedAt)) : now;
    await materializeProfile(deps, kind, id, { now: until });
  } catch (err) {
    const db = dbOf(deps);
    await db.demoCompEngine.update({ where: { id: ENGINE_ID }, data: { lastError: `backfill ${kind} ${id}: ${String(err?.code || err?.message || err).slice(0, 200)}` } }).catch(() => {});
  }
}

/** The owner of a brand must exist and not be archived. */
async function assertOwner(tx, ownerId) {
  const owner = await tx.demoCompMember.findUnique({ where: { id: ownerId } });
  if (!owner) throw new DemoCompError('OWNER_NOT_FOUND', 400, { ownerId: 'OWNER_NOT_FOUND' });
  if (owner.archivedAt) throw new DemoCompError('INVALID_SETTINGS', 400, { ownerId: 'OWNER_ARCHIVED' });
}

/** Create a demo member (≤ MAX_MEMBERS non-archived). Its history starts BACKFILL_DAYS days back. */
export async function createMember(deps = {}, input = {}, actor = null) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const engine = await getEngine(deps);
  const s = memberInput(input, {
    name: '', active: true, minDailyOrders: DEFAULTS.minDailyOrders, maxDailyOrders: DEFAULTS.maxDailyOrders,
    priceCents: engine.defaultPriceCents, allocationBps: engine.defaultMemberBps, networkAffiliates: 0,
    networkMinDailyOrders: 0, networkMaxDailyOrders: 0, networkPriceCents: null, networkAllocationBps: null,
  });
  const v = validateMemberSettings(s);
  if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
  const created = await db.$transaction(async (tx) => {
    await xactLock(tx, INIT_LOCK);
    if (await tx.demoCompMember.count({ where: { archivedAt: null } }) >= MAX_MEMBERS) throw new DemoCompError('MEMBER_LIMIT_REACHED', 409);
    const m = await tx.demoCompMember.create({ data: { ...s, photoUrl: input.photoUrl ?? null } });
    await tx.demoCompMemberVersion.create({
      data: { memberId: m.id, effectiveFrom: new Date(backfillStart(now)), ...pick(s, MEMBER_ENGINE_FIELDS), createdBy: actor },
    });
    return m;
  }, TX_OPTS);
  await backfillAtCreation(deps, MEMBER, created.id, now);
  invalidateReadCache();
  return created;
}

/**
 * effectiveFrom of a new settings version, computed INSIDE the profile lock: now, but strictly after the latest
 * version (versions stay ordered even when two edits race or share a millisecond) and after every generation
 * cursor (events already generated keep the settings that were in force; history is never contradicted).
 */
export function nextEffectiveFrom(now, lastEffectiveFrom, ...cursors) {
  let t = now;
  for (const c of [lastEffectiveFrom, ...cursors]) if (c) t = Math.max(t, +new Date(c) + 1);
  return new Date(t);
}

/** Update a demo member. Engine-relevant changes append a version effective NOW (future events only). */
export async function updateMember(deps = {}, id, input = {}, actor = null) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const updated = await db.$transaction(async (tx) => {
    await xactLock(tx, lockKey(id));
    const cur = await tx.demoCompMember.findUnique({ where: { id } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (cur.archivedAt) throw new DemoCompError('ARCHIVED', 409);
    const s = memberInput(input, memberSettings(cur));
    const v = validateMemberSettings(s);
    if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
    const data = { ...s };
    if (input.photoUrl !== undefined) data.photoUrl = input.photoUrl;
    const m = await tx.demoCompMember.update({ where: { id }, data });
    if (differs(cur, s, MEMBER_ENGINE_FIELDS)) {
      const [last] = await tx.demoCompMemberVersion.findMany({ where: { memberId: id }, orderBy: { effectiveFrom: 'desc' }, take: 1 });
      const effectiveFrom = nextEffectiveFrom(now, last?.effectiveFrom, cur.personalGeneratedThrough, cur.networkGeneratedThrough);
      await tx.demoCompMemberVersion.create({ data: { memberId: id, effectiveFrom, ...pick(s, MEMBER_ENGINE_FIELDS), createdBy: actor } });
    }
    return m;
  }, TX_OPTS);
  invalidateReadCache();
  return updated;
}

/** Create a demo brand (≤ MAX_BRANDS) owned by an existing demo member. */
export async function createBrand(deps = {}, input = {}, actor = null) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const engine = await getEngine(deps);
  const s = brandInput(input, {
    name: '', ownerId: '', active: true, minDailyOrders: DEFAULTS.minDailyOrders, maxDailyOrders: DEFAULTS.maxDailyOrders,
    priceCents: engine.defaultPriceCents, allocationBps: engine.defaultBrandBps,
  });
  const v = validateBrandSettings(s);
  if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
  const created = await db.$transaction(async (tx) => {
    await xactLock(tx, INIT_LOCK);
    if (await tx.demoCompBrand.count({ where: { archivedAt: null } }) >= MAX_BRANDS) throw new DemoCompError('BRAND_LIMIT_REACHED', 409);
    await assertOwner(tx, s.ownerId);
    const b = await tx.demoCompBrand.create({ data: { ...s, imageUrl: input.imageUrl ?? null } });
    await tx.demoCompBrandVersion.create({
      data: { brandId: b.id, effectiveFrom: new Date(backfillStart(now)), ...pick(s, BRAND_ENGINE_FIELDS), createdBy: actor },
    });
    return b;
  }, TX_OPTS);
  await backfillAtCreation(deps, BRAND, created.id, now);
  invalidateReadCache();
  return created;
}

export async function updateBrand(deps = {}, id, input = {}, actor = null) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const updated = await db.$transaction(async (tx) => {
    await xactLock(tx, lockKey(id));
    const cur = await tx.demoCompBrand.findUnique({ where: { id } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (cur.archivedAt) throw new DemoCompError('ARCHIVED', 409);
    const s = brandInput(input, brandSettings(cur));
    const v = validateBrandSettings(s);
    if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
    if (s.ownerId !== cur.ownerId) await assertOwner(tx, s.ownerId);
    const data = { ...s };
    if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl;
    const b = await tx.demoCompBrand.update({ where: { id }, data });
    if (differs(cur, s, BRAND_ENGINE_FIELDS)) {
      const [last] = await tx.demoCompBrandVersion.findMany({ where: { brandId: id }, orderBy: { effectiveFrom: 'desc' }, take: 1 });
      const effectiveFrom = nextEffectiveFrom(now, last?.effectiveFrom, cur.generatedThrough);
      await tx.demoCompBrandVersion.create({ data: { brandId: id, effectiveFrom, ...pick(s, BRAND_ENGINE_FIELDS), createdBy: actor } });
    }
    return b;
  }, TX_OPTS);
  invalidateReadCache();
  return updated;
}

/**
 * Archive a demo profile instead of deleting it: it is disabled (a settings version active=false is appended, so
 * nothing is generated after this moment), leaves the public rankings and the 21 / 20 limits, and keeps its whole
 * history. Idempotent. A member that still owns non-archived brands cannot be archived (archive or reassign them).
 */
async function archiveProfile(deps, kind, id, actor) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const isMember = kind === MEMBER;
  const model = isMember ? 'demoCompMember' : 'demoCompBrand';
  const res = await db.$transaction(async (tx) => {
    await xactLock(tx, lockKey(id));
    const cur = await tx[model].findUnique({ where: { id } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (cur.archivedAt) return { archived: true, archivedAt: cur.archivedAt };
    if (isMember && await tx.demoCompBrand.count({ where: { ownerId: id, archivedAt: null } }) > 0) throw new DemoCompError('MEMBER_OWNS_BRANDS', 409);
    if (cur.active) {
      const vModel = isMember ? 'demoCompMemberVersion' : 'demoCompBrandVersion';
      const key = isMember ? 'memberId' : 'brandId';
      const [last] = await tx[vModel].findMany({ where: { [key]: id }, orderBy: { effectiveFrom: 'desc' }, take: 1 });
      const effectiveFrom = isMember
        ? nextEffectiveFrom(now, last?.effectiveFrom, cur.personalGeneratedThrough, cur.networkGeneratedThrough)
        : nextEffectiveFrom(now, last?.effectiveFrom, cur.generatedThrough);
      const settings = isMember ? memberSettings(cur) : brandSettings(cur);
      await tx[vModel].create({
        data: { [key]: id, effectiveFrom, ...pick({ ...settings, active: false }, isMember ? MEMBER_ENGINE_FIELDS : BRAND_ENGINE_FIELDS), createdBy: actor },
      });
    }
    const archivedAt = new Date(now);
    await tx[model].update({ where: { id }, data: { active: false, archivedAt } });
    return { archived: true, archivedAt };
  }, TX_OPTS);
  invalidateReadCache();
  return res;
}

/**
 * Restore an archived profile (within the 21 / 20 limits). It comes back DISABLED: the admin re-enables it in the
 * editor, which appends a settings version — generation then resumes from that moment (the archived period stays empty).
 */
async function restoreProfile(deps, kind, id) {
  const db = dbOf(deps);
  const isMember = kind === MEMBER;
  const model = isMember ? 'demoCompMember' : 'demoCompBrand';
  const res = await db.$transaction(async (tx) => {
    await xactLock(tx, INIT_LOCK); // same lock as create: the limit check cannot race
    await xactLock(tx, lockKey(id));
    const cur = await tx[model].findUnique({ where: { id } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (!cur.archivedAt) return { restored: true };
    if (await tx[model].count({ where: { archivedAt: null } }) >= (isMember ? MAX_MEMBERS : MAX_BRANDS)) {
      throw new DemoCompError(isMember ? 'MEMBER_LIMIT_REACHED' : 'BRAND_LIMIT_REACHED', 409);
    }
    if (!isMember) {
      const owner = await tx.demoCompMember.findUnique({ where: { id: cur.ownerId } });
      if (!owner || owner.archivedAt) throw new DemoCompError('OWNER_ARCHIVED', 409);
    }
    await tx[model].update({ where: { id }, data: { archivedAt: null } });
    return { restored: true };
  }, TX_OPTS);
  invalidateReadCache();
  return res;
}

export const archiveMember = (deps = {}, id, actor = null) => archiveProfile(deps, MEMBER, id, actor);
export const archiveBrand = (deps = {}, id, actor = null) => archiveProfile(deps, BRAND, id, actor);
export const restoreMember = (deps = {}, id) => restoreProfile(deps, MEMBER, id);
export const restoreBrand = (deps = {}, id) => restoreProfile(deps, BRAND, id);

// ── Initial setup: 21 members + 20 brands with 30 days of history ────────────

/** Editable placeholder names (the admin renames them and uploads the photos / product images). */
export const PLACEHOLDER_MEMBERS = Object.freeze([
  'Salma B.', 'Youssef A.', 'Imane K.', 'Hamza E.', 'Khadija R.', 'Omar T.', 'Nadia L.', 'Mehdi S.', 'Sara M.', 'Ayoub F.', 'Hajar N.',
  'Anas Z.', 'Meryem H.', 'Bilal C.', 'Ghita O.', 'Amine D.', 'Zineb J.', 'Reda Q.', 'Oumaima I.', 'Karim G.', 'Fatima Zahra P.',
]);
export const PLACEHOLDER_BRANDS = Object.freeze([
  'Atlas Glow', 'Sahara Silk', 'Medina Care', 'Argan Pure', 'Rif Fresh', 'Oasis Home', 'Casa Chic', 'Kasbah Kitchen', 'Marrakech Mood',
  'Tangier Tech', 'Fès Leather', 'Agadir Sun', 'Ifrane Cosy', 'Chefchaouen Blue', 'Essaouira Breeze', 'Zagora Fit', 'Rabat Style',
  'Ouarzazate Gold', 'Dakhla Wave', 'Meknès Garden',
]);

/** Varied, deterministic starting ranges (each profile still has its OWN settings, editable later). */
const startRange = (i, seed) => {
  const lo = 3 + ((i * 7 + seed) % 9);          // 3..11
  return { minDailyOrders: lo, maxDailyOrders: lo + 12 + ((i * 11 + seed) % 39) }; // +12..+50
};

/**
 * Create the missing demo members (up to 21) and brands (up to 20) — archived profiles do not count. Idempotent:
 * existing profiles are never changed; running it again creates nothing. Each new profile gets its 30-day history
 * at creation (same deterministic rules as live generation), whether the engine is ON or OFF.
 */
export async function initializeCompetition(deps = {}, actor = null) {
  const db = dbOf(deps);
  const engine = await getEngine(deps);
  const memberCount = await db.demoCompMember.count({ where: { archivedAt: null } });
  let createdMembers = 0, createdBrands = 0;
  for (let i = memberCount; i < MAX_MEMBERS; i++) {
    try {
      await createMember(deps, { name: PLACEHOLDER_MEMBERS[i], priceCents: engine.defaultPriceCents, allocationBps: engine.defaultMemberBps, ...startRange(i, 1) }, actor);
      createdMembers += 1;
    } catch (err) { if (err?.code !== 'MEMBER_LIMIT_REACHED') throw err; break; }
  }
  const members = await db.demoCompMember.findMany({ where: { archivedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  const brandCount = await db.demoCompBrand.count({ where: { archivedAt: null } });
  for (let i = brandCount; i < MAX_BRANDS && members.length; i++) {
    try {
      await createBrand(deps, {
        name: PLACEHOLDER_BRANDS[i], ownerId: members[i % members.length].id,
        priceCents: engine.defaultPriceCents, allocationBps: engine.defaultBrandBps, ...startRange(i, 5),
      }, actor);
      createdBrands += 1;
    } catch (err) { if (err?.code !== 'BRAND_LIMIT_REACHED') throw err; break; }
  }
  if (!engine.initializedAt) await db.demoCompEngine.update({ where: { id: ENGINE_ID }, data: { initializedAt: new Date(nowOf(deps)) } });
  return { createdMembers, createdBrands };
}

/** Exposed for tests / tooling. */
export const __internals = { lockKey, computeStats, HOUR_MS };
