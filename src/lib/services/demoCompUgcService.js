/**
 * src/lib/services/demoCompUgcService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition — UGC Videos: persistence, generation, stats, admin + public
 * route handlers (factories with injectable deps, like ../demoCompetition/routeHandlers.js).
 *
 * SIMULATION ONLY. This service reads demo_comp_members (the owner of a video: name /
 * photo / archive state, READ ONLY) and reads/writes ONLY the demo_comp_ugc_* tables:
 * never the real UGC tables, orders, affiliates, affiliate orders, wallets, balance
 * providers, payouts or reward ledgers, and never the member / brand demo stats
 * (demo_comp_events / demo_comp_daily_plans). Amounts are simulated reporting values
 * in centimes (MAD × 100).
 *
 * Generation (pure rules in ../demoCompUgc.js) follows the Top Members / Top Brands engine:
 *   • materializeVideo(): under a per-video transaction advisory lock, create the missing
 *     daily plans and the due events with createMany({ skipDuplicates }) — INSERT … ON
 *     CONFLICT DO NOTHING on the unique keys (videoId, dayKey) / idempotencyKey — so two
 *     runs, or two processes at once, never duplicate a row.
 *   • A new video gets its 30-day history at creation (module ON or OFF; OFF after having
 *     run → only up to the moment it was switched OFF). Live generation only while the
 *     module is ON; the OFF period is never caught up (resumedAt), like the main engine.
 *   • Entry points: the throttled read-path catch-up of the public leaderboard and of the
 *     admin state, the admin "run now", and runDemoCompUgcTick() for a worker. It is a
 *     SEPARATE entry point: the Top Members / Top Brands engine is not modified.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto';
import defaultPrisma from '../prisma.js';
import {
  WINDOWS, DAY_MS, BACKFILL_DAYS, UGC_LIMITS, UGC_DEFAULTS, UGC_MEDIA, UGC_MEDIA_NAMESPACE,
  backfillStart, dayKeyOf, dayKeysBetween, addDays, buildUgcPlan, dueUgcEvents, rankVideos, isListable,
  validateVideoSettings, validateModuleSettings, normalizeTitle, placeholderVideo, checkUgcUpload, uploadErrorCode, extOf,
} from '../demoCompUgc.js';
import { DemoCompError, nextEffectiveFrom } from './demoCompetitionService.js';
import { errorResponse, PUBLIC_CACHE } from '../demoCompetition/routeHandlers.js';
import { validateVideo, validateImage } from '../uploadSecurity.js';

export { DemoCompError };

/** Days of missed history one materialisation may generate (≥ the 30-day backfill + today). */
export const UGC_CATCH_UP_DAYS = BACKFILL_DAYS + 2;
/** Minimum spacing of read-triggered catch-ups (per process and per settings row). */
export const UGC_READ_CATCH_UP_MS = 5_000;
/** In-process cache of public reads (keeps polling cheap). */
export const UGC_READ_CACHE_MS = 2_000;
/** Session advisory-lock key for an optional worker ("DCUG"; distinct from DCMP and every other engine). */
export const DEMO_COMP_UGC_ENGINE_LOCK_KEY = 0x44435547;

const SETTINGS_ID = 'ugc';
const TX_OPTS = { timeout: 60_000, maxWait: 20_000 };
const CREATE_LOCK = 'demo-comp-ugc:create';
const lockKey = (videoId) => `demo-comp-ugc:${videoId}`;
const nowOf = (deps) => (typeof deps?.now === 'function' ? deps.now() : Date.now());
const dbOf = (deps) => deps?.db ?? defaultPrisma;

/** Per-key transaction advisory lock (same mechanism as the main engine; no-op on fakes without raw SQL). */
async function xactLock(tx, key) {
  if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${String(key)}::text))`;
}

const ENGINE_FIELDS = ['active', 'minDailySales', 'maxDailySales', 'rewardPerSaleMad'];
const EDITABLE = ['title', 'memberId', 'active', 'minDailySales', 'maxDailySales', 'rewardPerSaleMad', 'sortOrder', 'videoUrl', 'thumbnailUrl'];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
const differs = (a, b, keys) => keys.some((k) => (a[k] ?? null) !== (b[k] ?? null));
const OWNER_SELECT = { select: { id: true, name: true, photoUrl: true, active: true, archivedAt: true } };

// ── Module settings ───────────────────────────────────────────────────────────

export async function getUgcSettings(deps = {}) {
  const db = dbOf(deps);
  const row = await db.demoCompUgcSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (row) return row;
  return db.demoCompUgcSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
}

/** Admin: switch the module on / off and change the target video count. OFF → ON resumes from NOW (no catch-up). */
export async function updateUgcSettings(deps = {}, patch = {}) {
  const db = dbOf(deps);
  const cur = await getUgcSettings(deps);
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled,
    targetVideoCount: patch.targetVideoCount === undefined ? cur.targetVideoCount : patch.targetVideoCount,
  };
  const v = validateModuleSettings(next);
  if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
  const at = new Date(nowOf(deps));
  const data = next.enabled && !cur.enabled ? { ...next, resumedAt: at }
    : !next.enabled && cur.enabled ? { ...next, pausedAt: at } : next;
  const saved = await db.demoCompUgcSettings.update({ where: { id: SETTINGS_ID }, data });
  invalidateReadCache();
  return saved;
}

// ── Generation ────────────────────────────────────────────────────────────────

/**
 * Create the missing plans and due events of one video up to `now` (bounded catch-up). Safe to call
 * concurrently and repeatedly. Returns { events } (newly inserted).
 * opts.resumedAt: when the module was last switched ON — the OFF period is skipped for a video already generated.
 * A video whose owner is archived generates nothing after the owner's archive time (and that gap is skipped).
 */
export async function materializeVideo(deps, videoId, opts = {}) {
  const db = dbOf(deps);
  const now = opts.now ?? nowOf(deps);
  const maxDays = opts.maxDays ?? UGC_CATCH_UP_DAYS;
  return db.$transaction(async (tx) => {
    await xactLock(tx, lockKey(videoId));
    const video = await tx.demoCompUgcVideo.findUnique({ where: { id: videoId }, include: { member: { select: { id: true, archivedAt: true } } } });
    if (!video || video.archivedAt) return { events: 0 };
    const versions = await tx.demoCompUgcVideoVersion.findMany({ where: { videoId }, orderBy: { effectiveFrom: 'asc' } });
    if (!versions.length) return { events: 0 };
    const historyStart = +new Date(versions[0].effectiveFrom);
    const cursor = video.generatedThrough ? +new Date(video.generatedThrough) : null;
    const ownerArchivedAt = video.member?.archivedAt ? +new Date(video.member.archivedAt) : null;

    const from = cursor !== null ? Math.max(cursor, opts.resumedAt ? +new Date(opts.resumedAt) : -Infinity) : historyStart - 1;
    const limit = ownerArchivedAt !== null ? Math.min(now, ownerArchivedAt) : now;
    const to = Math.min(limit, from + maxDays * DAY_MS);

    let inserted = 0;
    let nextCursor = null;
    if (to > from) {
      const keys = dayKeysBetween(dayKeyOf(Math.max(from + 1, historyStart)), dayKeyOf(to));
      const built = keys.map((k) => buildUgcPlan(videoId, k, versions)).filter(Boolean);
      if (built.length) {
        await tx.demoCompUgcDailyPlan.createMany({
          data: built.map((p) => ({
            videoId, dayKey: p.dayKey, dayStart: new Date(p.dayStart), dayEnd: new Date(p.dayEnd),
            targetSales: p.targetSales, minSales: p.minSales, maxSales: p.maxSales, versionId: p.versionId,
          })),
          skipDuplicates: true,
        });
        // The STORED plans are authoritative (a plan is never rewritten once created).
        const stored = await tx.demoCompUgcDailyPlan.findMany({ where: { videoId, dayKey: { in: built.map((p) => p.dayKey) } } });
        const events = [];
        for (const sp of stored) {
          const plan = { videoId, dayKey: sp.dayKey, dayStart: +new Date(sp.dayStart), dayEnd: +new Date(sp.dayEnd), targetSales: sp.targetSales };
          for (const e of dueUgcEvents(plan, versions, from, to)) events.push({ ...e, videoId, planId: sp.id, scheduledAt: new Date(e.scheduledAt) });
        }
        if (events.length) {
          const res = await tx.demoCompUgcEvent.createMany({ data: events, skipDuplicates: true });
          inserted += res?.count ?? 0;
        }
      }
      nextCursor = to;
    } else if (cursor === null) {
      nextCursor = to; // nothing to generate yet: record how far, so the OFF period is never backfilled later
    }
    // Owner archived: everything up to its archive time is generated; the archived gap is skipped, not caught up.
    if (ownerArchivedAt !== null && to >= limit) nextCursor = Math.max(now, cursor ?? -Infinity, nextCursor ?? -Infinity);
    if (nextCursor !== null && nextCursor !== cursor) {
      await tx.demoCompUgcVideo.update({ where: { id: videoId }, data: { generatedThrough: new Date(nextCursor) } });
    }
    return { events: inserted };
  }, TX_OPTS);
}

/** Materialise every non-archived video. Nothing is generated while the module is OFF. */
export async function runUgcEngine(deps = {}, opts = {}) {
  const db = dbOf(deps);
  const settings = await getUgcSettings(deps);
  if (!settings.enabled) return { skipped: 'disabled' };
  const now = opts.now ?? nowOf(deps);
  let events = 0, videos = 0, lastError = null;
  const list = await db.demoCompUgcVideo.findMany({ where: { archivedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  for (const { id } of list) {
    try {
      const r = await materializeVideo(deps, id, { now, resumedAt: settings.resumedAt });
      events += r.events;
      videos += 1;
    } catch (err) {
      lastError = `video ${id}: ${String(err?.code || err?.message || err).slice(0, 200)}`;
    }
  }
  await db.demoCompUgcSettings.update({ where: { id: SETTINGS_ID }, data: { lastRunAt: new Date(now), lastRunEvents: events, lastError } }).catch(() => {});
  invalidateReadCache();
  return { events, videos, error: lastError };
}

/** One worker tick (optional): only the holder of the session lock runs the UGC engine (no-op when disabled). */
export async function runDemoCompUgcTick({ lock, ...deps } = {}) {
  if (lock) {
    const held = await lock.acquire();
    if (!held) return { skipped: 'no_lock' };
  }
  try {
    return await runUgcEngine(deps);
  } finally {
    if (lock) await lock.release();
  }
}

let lastReadCatchUp = 0;
let readCatchUpInFlight = null;
/** Read-path catch-up (throttled, single-flight per process, never throws into the read). */
export async function catchUpUgcOnRead(deps = {}) {
  const now = nowOf(deps);
  if (readCatchUpInFlight) return { skipped: 'in_flight' };
  if (now - lastReadCatchUp < UGC_READ_CATCH_UP_MS) return { skipped: 'throttled' };
  lastReadCatchUp = now;
  readCatchUpInFlight = (async () => {
    try {
      const settings = await getUgcSettings(deps);
      if (!settings.enabled) return { skipped: 'disabled' };
      if (settings.lastRunAt && now - +new Date(settings.lastRunAt) < UGC_READ_CATCH_UP_MS) return { skipped: 'fresh' };
      return await runUgcEngine(deps, { now });
    } catch (err) {
      return { skipped: 'error', error: String(err?.message || err) };
    }
  })();
  try { return await readCatchUpInFlight; } finally { readCatchUpInFlight = null; }
}

/** Test helper: reset the per-process throttles and caches. */
export function __resetDemoCompUgcState() { lastReadCatchUp = 0; readCatchUpInFlight = null; invalidateReadCache(); }

// ── Stats ─────────────────────────────────────────────────────────────────────

async function sumsByVideo(db, from, to) {
  const where = { scheduledAt: { lte: new Date(to) } };
  if (from !== null) where.scheduledAt.gt = new Date(from);
  const rows = await db.demoCompUgcEvent.groupBy({ by: ['videoId'], where, _sum: { quantity: true, rewardCents: true }, _max: { scheduledAt: true } });
  return new Map(rows.map((r) => [r.videoId, { sales: r._sum?.quantity ?? 0, rewardCents: r._sum?.rewardCents ?? 0, last: r._max?.scheduledAt ?? null }]));
}
const ZERO = { sales: 0, rewardCents: 0, last: null };

/**
 * Stats of the videos: rolling 24 h / 7 d / 30 d (scheduledAt ∈ (now − window, now]) and all-time.
 * rank = rank among the publicly listable videos (rolling 30-day reward), null for the others.
 */
async function computeVideoStats(db, now, { includeUnlisted = false } = {}) {
  const videos = await db.demoCompUgcVideo.findMany({
    where: includeUnlisted ? {} : { active: true, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { member: OWNER_SELECT },
  });
  const [h24, d7, d30, all] = await Promise.all([
    sumsByVideo(db, now - WINDOWS.h24, now), sumsByVideo(db, now - WINDOWS.d7, now), sumsByVideo(db, now - WINDOWS.d30, now), sumsByVideo(db, null, now),
  ]);
  const rows = videos.map((v) => ({
    video: v, id: v.id, createdAt: v.createdAt, sortOrder: v.sortOrder,
    sales24h: (h24.get(v.id) ?? ZERO).sales, reward24hCents: (h24.get(v.id) ?? ZERO).rewardCents,
    sales7d: (d7.get(v.id) ?? ZERO).sales, reward7dCents: (d7.get(v.id) ?? ZERO).rewardCents,
    sales30d: (d30.get(v.id) ?? ZERO).sales, reward30dCents: (d30.get(v.id) ?? ZERO).rewardCents,
    salesAll: (all.get(v.id) ?? ZERO).sales, rewardAllCents: (all.get(v.id) ?? ZERO).rewardCents,
    lastSaleAt: (all.get(v.id) ?? ZERO).last,
  }));
  const ranks = new Map(rankVideos(rows.filter((r) => isListable(r.video))).map((r) => [r.id, r.rank]));
  return rows.map((r) => ({ ...r, rank: ranks.get(r.id) ?? null }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (a.sortOrder - b.sortOrder) || (+new Date(a.createdAt) - +new Date(b.createdAt)));
}

const cache = new Map();
function invalidateReadCache() { cache.clear(); }
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  const t = Date.now();
  if (hit && t - hit.at < ttl) return hit.value;
  const value = await fn();
  if (ttl > 0) { if (cache.size > 50) cache.clear(); cache.set(key, { at: t, value }); }
  return value;
}

const owner = (m) => (m ? { id: m.id, name: m.name, avatarUrl: m.photoUrl ?? null, public: m.active === true && !m.archivedAt } : null);

const publicVideo = (r) => ({
  rank: r.rank, videoId: r.id, title: r.video.title, thumbnailUrl: r.video.thumbnailUrl ?? null, videoUrl: r.video.videoUrl,
  owner: owner(r.video.member),
  sales: r.sales30d, rewardPerSale: r.video.rewardPerSaleMad,
  totalReward: r.reward30dCents / 100, totalRewardCents: r.reward30dCents,
  lastSaleAt: r.lastSaleAt, simulated: true,
});

/**
 * Public leaderboard of the listable videos (active, not archived, with a video file, owner not archived),
 * ranked by rolling 30-day simulated reward. Module OFF → { enabled:false, videos: [] }.
 */
export async function getUgcLeaderboard(deps = {}, { limit = UGC_LIMITS.maxVideos } = {}) {
  const lim = Math.max(1, Math.min(UGC_LIMITS.maxVideos, Number(limit) || UGC_LIMITS.maxVideos));
  return cached(`ugc:${lim}`, deps.db ? 0 : UGC_READ_CACHE_MS, async () => {
    const now = nowOf(deps);
    const settings = await getUgcSettings(deps);
    const base = { asOf: new Date(now).toISOString(), simulation: true, windowHours: WINDOWS.d30 / 3_600_000, currency: 'MAD' };
    if (!settings.enabled) return { ...base, enabled: false, total: 0, videos: [] };
    const rows = (await computeVideoStats(dbOf(deps), now)).filter((r) => r.rank !== null);
    return { ...base, enabled: true, total: rows.length, videos: rows.slice(0, lim).map(publicVideo) };
  });
}

// ── Admin: state / detail ─────────────────────────────────────────────────────

const videoSettings = (v) => pick(v, EDITABLE);
const settingsOut = (s) => ({
  enabled: s.enabled, targetVideoCount: s.targetVideoCount, initializedAt: s.initializedAt ?? null, resumedAt: s.resumedAt ?? null,
  pausedAt: s.pausedAt ?? null, lastRunAt: s.lastRunAt ?? null, lastRunEvents: s.lastRunEvents ?? 0, lastError: s.lastError ?? null,
});
const statsOut = (r) => ({
  sales24h: r.sales24h, sales7d: r.sales7d, sales30d: r.sales30d, salesAll: r.salesAll,
  reward24hCents: r.reward24hCents, reward7dCents: r.reward7dCents, reward30dCents: r.reward30dCents, rewardAllCents: r.rewardAllCents,
});
const adminRow = (r, enabled) => ({
  id: r.id, ...videoSettings(r.video), createdAt: r.video.createdAt, updatedAt: r.video.updatedAt, archivedAt: r.video.archivedAt ?? null,
  owner: r.video.member ? { ...owner(r.video.member), archivedAt: r.video.member.archivedAt ?? null } : null,
  rank: r.rank, listed: enabled && r.rank !== null, lastSaleAt: r.lastSaleAt, stats: statsOut(r),
});

/** Admin: module settings + every video (archived included) with owner, rolling stats, rank and reward. */
export async function adminGetUgcState(deps = {}) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const settings = await getUgcSettings(deps);
  const rows = await computeVideoStats(db, now, { includeUnlisted: true });
  const members = await db.demoCompMember.findMany({ where: { archivedAt: null }, select: { id: true, name: true, photoUrl: true, active: true }, orderBy: { createdAt: 'asc' } });
  const live = rows.filter((r) => !r.video.archivedAt);
  return {
    asOf: new Date(now).toISOString(), simulation: true, currency: 'MAD',
    settings: settingsOut(settings),
    limits: { maxVideos: UGC_LIMITS.maxVideos, salesMax: UGC_LIMITS.salesMax, titleMax: UGC_LIMITS.titleMax, rewardChoices: [5, 6, 7], targetMin: UGC_LIMITS.targetMin, targetMax: UGC_LIMITS.targetMax },
    uploads: uploadLimits(),
    counts: { videos: live.length, active: live.filter((r) => r.video.active).length, listed: rows.filter((r) => r.rank !== null).length, archived: rows.length - live.length },
    members: members.map((m) => ({ id: m.id, name: m.name, avatarUrl: m.photoUrl ?? null, active: m.active })),
    videos: rows.map((r) => adminRow(r, settings.enabled)),
  };
}

/** Admin detail of one video: settings, owner, stats, settings history and the 30-day daily history. */
export async function adminGetUgcVideo(deps = {}, id) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const settings = await getUgcSettings(deps);
  const rows = await computeVideoStats(db, now, { includeUnlisted: true });
  const r = rows.find((x) => x.id === id);
  if (!r) throw new DemoCompError('NOT_FOUND', 404);
  const versions = await db.demoCompUgcVideoVersion.findMany({ where: { videoId: id }, orderBy: { effectiveFrom: 'desc' }, take: 50 });
  const firstDay = addDays(dayKeyOf(now), -(BACKFILL_DAYS - 1));
  const events = await db.demoCompUgcEvent.findMany({
    where: { videoId: id, scheduledAt: { gt: new Date(now - (BACKFILL_DAYS + 1) * DAY_MS), lte: new Date(now) } },
    select: { quantity: true, rewardCents: true, scheduledAt: true }, orderBy: { scheduledAt: 'asc' },
  });
  const days = new Map(dayKeysBetween(firstDay, dayKeyOf(now)).map((k) => [k, { day: k, sales: 0, rewardCents: 0 }]));
  for (const e of events) {
    const d = days.get(dayKeyOf(+new Date(e.scheduledAt)));
    if (d) { d.sales += e.quantity; d.rewardCents += e.rewardCents; }
  }
  return {
    asOf: new Date(now).toISOString(), simulation: true,
    video: {
      ...adminRow(r, settings.enabled),
      versions: versions.map((v) => ({ id: v.id, effectiveFrom: v.effectiveFrom, active: v.active, minDailySales: v.minDailySales, maxDailySales: v.maxDailySales, rewardPerSaleMad: v.rewardPerSaleMad, createdBy: v.createdBy ?? null })),
      history: { daily: [...days.values()] },
    },
  };
}

// ── Admin: create / update / archive / restore / generate ─────────────────────

function videoInput(input, base) {
  const s = { ...base };
  for (const k of EDITABLE) if (input[k] !== undefined) s[k] = input[k];
  s.title = normalizeTitle(s.title);
  if (s.videoUrl === '') s.videoUrl = null;
  if (s.thumbnailUrl === '') s.thumbnailUrl = null;
  return s;
}

/** The owner must be an existing, NON-archived demo member (read only). */
async function assertMember(tx, memberId) {
  const m = await tx.demoCompMember.findUnique({ where: { id: memberId }, select: { id: true, archivedAt: true } });
  if (!m) throw new DemoCompError('MEMBER_NOT_FOUND', 400, { memberId: 'MEMBER_NOT_FOUND' });
  if (m.archivedAt) throw new DemoCompError('INVALID_SETTINGS', 400, { memberId: 'MEMBER_ARCHIVED' });
}

/** History at creation (module ON, or never switched ON yet → up to now; OFF after having run → up to pausedAt). */
async function backfillAtCreation(deps, id, now) {
  try {
    const settings = await getUgcSettings(deps);
    const until = !settings.enabled && settings.pausedAt ? Math.min(now, +new Date(settings.pausedAt)) : now;
    await materializeVideo(deps, id, { now: until });
  } catch (err) {
    await dbOf(deps).demoCompUgcSettings.update({ where: { id: SETTINGS_ID }, data: { lastError: `backfill video ${id}: ${String(err?.code || err?.message || err).slice(0, 200)}` } }).catch(() => {});
  }
}

/** Create a demo UGC video (≤ UGC_LIMITS.maxVideos non-archived). Its history starts BACKFILL_DAYS days back. */
export async function createUgcVideo(deps = {}, input = {}, actor = null) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const s = videoInput(input, {
    title: '', memberId: '', active: true, minDailySales: UGC_DEFAULTS.minDailySales, maxDailySales: UGC_DEFAULTS.maxDailySales,
    rewardPerSaleMad: UGC_DEFAULTS.rewardPerSaleMad, sortOrder: 0, videoUrl: null, thumbnailUrl: null,
  });
  const v = validateVideoSettings(s);
  if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
  const created = await db.$transaction(async (tx) => {
    await xactLock(tx, CREATE_LOCK);
    if (await tx.demoCompUgcVideo.count({ where: { archivedAt: null } }) >= UGC_LIMITS.maxVideos) throw new DemoCompError('VIDEO_LIMIT_REACHED', 409);
    await assertMember(tx, s.memberId);
    if (input.sortOrder === undefined) {
      const [last] = await tx.demoCompUgcVideo.findMany({ orderBy: { sortOrder: 'desc' }, take: 1, select: { sortOrder: true } });
      s.sortOrder = last ? Math.min(UGC_LIMITS.sortOrderMax, last.sortOrder + 1) : 0;
    }
    const row = await tx.demoCompUgcVideo.create({ data: s });
    await tx.demoCompUgcVideoVersion.create({ data: { videoId: row.id, effectiveFrom: new Date(backfillStart(now)), ...pick(s, ENGINE_FIELDS), createdBy: actor } });
    return row;
  }, TX_OPTS);
  await backfillAtCreation(deps, created.id, now);
  invalidateReadCache();
  return created;
}

/** Update a video. Engine-relevant changes (active, min / max, reward) append a version effective NOW: history never changes. */
export async function updateUgcVideo(deps = {}, id, input = {}, actor = null) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const updated = await db.$transaction(async (tx) => {
    await xactLock(tx, lockKey(id));
    const cur = await tx.demoCompUgcVideo.findUnique({ where: { id } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (cur.archivedAt) throw new DemoCompError('ARCHIVED', 409);
    const s = videoInput(input, videoSettings(cur));
    const v = validateVideoSettings(s);
    if (!v.ok) throw new DemoCompError('INVALID_SETTINGS', 400, v.errors);
    if (s.memberId !== cur.memberId) await assertMember(tx, s.memberId);
    const row = await tx.demoCompUgcVideo.update({ where: { id }, data: s });
    if (differs(cur, s, ENGINE_FIELDS)) {
      const [last] = await tx.demoCompUgcVideoVersion.findMany({ where: { videoId: id }, orderBy: { effectiveFrom: 'desc' }, take: 1 });
      const effectiveFrom = nextEffectiveFrom(now, last?.effectiveFrom, cur.generatedThrough);
      await tx.demoCompUgcVideoVersion.create({ data: { videoId: id, effectiveFrom, ...pick(s, ENGINE_FIELDS), createdBy: actor } });
    }
    return row;
  }, TX_OPTS);
  invalidateReadCache();
  return updated;
}

/** Archive instead of delete: disabled from now (active=false version), leaves the leaderboard and the limit; history kept. Idempotent. */
export async function archiveUgcVideo(deps = {}, id, actor = null) {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const res = await db.$transaction(async (tx) => {
    await xactLock(tx, lockKey(id));
    const cur = await tx.demoCompUgcVideo.findUnique({ where: { id } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (cur.archivedAt) return { archived: true, archivedAt: cur.archivedAt };
    if (cur.active) {
      const [last] = await tx.demoCompUgcVideoVersion.findMany({ where: { videoId: id }, orderBy: { effectiveFrom: 'desc' }, take: 1 });
      const effectiveFrom = nextEffectiveFrom(now, last?.effectiveFrom, cur.generatedThrough);
      await tx.demoCompUgcVideoVersion.create({ data: { videoId: id, effectiveFrom, ...pick({ ...cur, active: false }, ENGINE_FIELDS), createdBy: actor } });
    }
    const archivedAt = new Date(now);
    await tx.demoCompUgcVideo.update({ where: { id }, data: { active: false, archivedAt } });
    return { archived: true, archivedAt };
  }, TX_OPTS);
  invalidateReadCache();
  return res;
}

/** Restore an archived video (within the limit; owner not archived). It comes back DISABLED. */
export async function restoreUgcVideo(deps = {}, id) {
  const db = dbOf(deps);
  const res = await db.$transaction(async (tx) => {
    await xactLock(tx, CREATE_LOCK);
    await xactLock(tx, lockKey(id));
    const cur = await tx.demoCompUgcVideo.findUnique({ where: { id } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (!cur.archivedAt) return { restored: true };
    if (await tx.demoCompUgcVideo.count({ where: { archivedAt: null } }) >= UGC_LIMITS.maxVideos) throw new DemoCompError('VIDEO_LIMIT_REACHED', 409);
    const m = await tx.demoCompMember.findUnique({ where: { id: cur.memberId }, select: { id: true, archivedAt: true } });
    if (!m || m.archivedAt) throw new DemoCompError('MEMBER_ARCHIVED', 409);
    await tx.demoCompUgcVideo.update({ where: { id }, data: { archivedAt: null } });
    return { restored: true };
  }, TX_OPTS);
  invalidateReadCache();
  return res;
}

/**
 * Create deterministic placeholder videos up to the target count (non-archived videos count; archived do not),
 * owners assigned round-robin over the non-archived demo members. Idempotent: at the target it creates nothing.
 * Placeholders have no video file yet (not listed publicly until one is uploaded).
 */
export async function generateUgcVideos(deps = {}, actor = null) {
  const db = dbOf(deps);
  const settings = await getUgcSettings(deps);
  const members = await db.demoCompMember.findMany({ where: { archivedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  if (!members.length) throw new DemoCompError('NO_MEMBERS', 409);
  const have = await db.demoCompUgcVideo.count({ where: { archivedAt: null } });
  let created = 0;
  for (let i = have; i < Math.min(settings.targetVideoCount, UGC_LIMITS.maxVideos); i++) {
    try {
      await createUgcVideo(deps, { ...placeholderVideo(i), memberId: members[i % members.length].id }, actor);
      created += 1;
    } catch (err) { if (err?.code !== 'VIDEO_LIMIT_REACHED') throw err; break; }
  }
  if (!settings.initializedAt) await db.demoCompUgcSettings.update({ where: { id: SETTINGS_ID }, data: { initializedAt: new Date(nowOf(deps)) } });
  return { created, target: settings.targetVideoCount };
}

// ── Media (dedicated demo namespace; never the real UGC folder) ──────────────

export const UGC_MEDIA_STORE = Object.freeze({ category: UGC_MEDIA_NAMESPACE, folder: UGC_MEDIA_NAMESPACE, subdir: UGC_MEDIA_NAMESPACE });

export function uploadLimits() {
  return {
    field: 'file',
    video: { maxBytes: UGC_MEDIA.video.maxBytes, extensions: [...UGC_MEDIA.video.exts], accept: 'video/mp4,video/webm,video/quicktime' },
    thumbnail: { maxBytes: UGC_MEDIA.thumbnail.maxBytes, extensions: [...UGC_MEDIA.thumbnail.exts], accept: 'image/jpeg,image/png,image/webp' },
  };
}

/** Re-encode a thumbnail to WebP (EXIF-rotated, ≤ 720×1280, the original is never stored). */
async function processThumbnail(buffer) {
  const { default: sharp } = await import('sharp');
  try {
    return await sharp(buffer, { limitInputPixels: 40_000_000 }).rotate()
      .resize(720, 1280, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new DemoCompError('INVALID_FILE_TYPE', 415);
  }
}

/**
 * Validate and store one demo UGC media file; returns { url, kind, bytes }.
 * Video: extension allow-list + 50 MB cap + uploadSecurity.validateVideo (magic bytes), stored as is.
 * Thumbnail: allow-list + 5 MB cap + uploadSecurity.validateImage (magic bytes, script scan), re-encoded to WebP.
 * Stored through saveMedia with the dedicated namespace (R2 category / folder / subdir "demo-competition-ugc").
 */
export async function storeUgcMedia(file, kind, deps = {}) {
  const spec = UGC_MEDIA[kind];
  if (!spec) throw new DemoCompError('INVALID_INPUT', 400);
  const name = typeof file?.name === 'string' ? file.name : '';
  const pre = checkUgcUpload(kind, { name, size: Number(file?.size) || 0 });
  if (!pre.ok) throw new DemoCompError(pre.code, pre.status);
  const buffer = Buffer.from(await file.arrayBuffer());
  const again = checkUgcUpload(kind, { name, size: buffer.length });
  if (!again.ok) throw new DemoCompError(again.code, again.status);
  const ext = extOf(name);
  const check = kind === 'video' ? validateVideo(buffer, name) : validateImage(buffer, name);
  if (!check.ok) throw new DemoCompError(uploadErrorCode(check), check.status || 415);
  const out = kind === 'video' ? buffer : await (deps.processThumbnail ?? processThumbnail)(buffer);
  const filename = kind === 'video' ? `ugc-video-${randomUUID()}${ext === '.jpeg' ? '.jpg' : ext}` : `ugc-thumb-${randomUUID()}.webp`;
  const save = deps.saveMedia ?? (await import('../cloudinary.js')).saveMedia;
  const res = await save(out, { filename, ...UGC_MEDIA_STORE, resourceType: spec.resourceType });
  return { url: res.url, kind, bytes: out.length };
}

// ── Route handlers ────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safe = (fn) => async (...args) => { try { return await fn(...args); } catch (err) { return errorResponse(err); } };
const actorOf = (user) => (user?.id ? String(user.id) : user?.email ? String(user.email) : 'admin');

async function readJsonObject(req) {
  let body;
  try { body = await req.json(); } catch { throw new DemoCompError('INVALID_JSON', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DemoCompError('INVALID_JSON', 400);
  return body;
}
async function idParam(ctx) {
  const id = (await ctx?.params)?.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new DemoCompError('NOT_FOUND', 404);
  return id;
}

export const VIDEO_FIELDS = Object.freeze({
  title: 'string', memberId: 'string', active: 'boolean', minDailySales: 'int', maxDailySales: 'int', rewardPerSaleMad: 'int',
  sortOrder: 'int', videoUrl: 'stringOrNull', thumbnailUrl: 'stringOrNull',
});
export const SETTINGS_FIELDS = Object.freeze({ enabled: 'boolean', targetVideoCount: 'int' });

/** Keep only the known fields with the right primitive types (validation does the ranges). */
function pickTyped(body, spec) {
  const out = {}, errors = {};
  for (const [k, t] of Object.entries(spec)) {
    if (body[k] === undefined) continue;
    const v = body[k];
    const ok = t === 'string' ? typeof v === 'string' : t === 'boolean' ? typeof v === 'boolean' : t === 'int' ? Number.isInteger(v) : (v === null || typeof v === 'string');
    if (ok) out[k] = v; else errors[k] = 'INVALID_TYPE';
  }
  if (Object.keys(errors).length) throw new DemoCompError('INVALID_SETTINGS', 400, errors);
  return out;
}

/** Multipart overhead allowed on top of the file before the body is even read. */
const FORM_OVERHEAD_BYTES = 64 * 1024;
async function readFile(req, kind) {
  const spec = UGC_MEDIA[kind];
  const declared = Number(req.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > spec.maxBytes + FORM_OVERHEAD_BYTES) throw new DemoCompError('FILE_TOO_LARGE', 413);
  let form;
  try { form = await req.formData(); } catch { throw new DemoCompError('INVALID_INPUT', 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') throw new DemoCompError('INVALID_INPUT', 400);
  return file;
}

/** Admin handlers — the exported routes wrap each with withAdminAuth (role ADMIN). */
export function adminUgcHandlers(deps = {}) {
  const kick = () => { catchUpUgcOnRead(deps).catch(() => {}); };
  const uploadTo = (kind, field) => safe(async (req, ctx, user) => {
    const id = await idParam(ctx);
    const cur = await dbOf(deps).demoCompUgcVideo.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
    if (!cur) throw new DemoCompError('NOT_FOUND', 404);
    if (cur.archivedAt) throw new DemoCompError('ARCHIVED', 409);
    const stored = await storeUgcMedia(await readFile(req, kind), kind, deps);
    await updateUgcVideo(deps, id, { [field]: stored.url }, actorOf(user));
    return Response.json({ ...stored, video: (await adminGetUgcVideo(deps, id)).video });
  });
  return {
    getState: safe(async () => { kick(); return Response.json(await adminGetUgcState(deps)); }),
    updateSettings: safe(async (req) => {
      await updateUgcSettings(deps, pickTyped(await readJsonObject(req), SETTINGS_FIELDS));
      return Response.json({ settings: settingsOut(await getUgcSettings(deps)) });
    }),
    createVideo: safe(async (req, _ctx, user) => {
      const v = await createUgcVideo(deps, pickTyped(await readJsonObject(req), VIDEO_FIELDS), actorOf(user));
      return Response.json(await adminGetUgcVideo(deps, v.id), { status: 201 });
    }),
    getVideo: safe(async (_req, ctx) => Response.json(await adminGetUgcVideo(deps, await idParam(ctx)))),
    updateVideo: safe(async (req, ctx, user) => {
      const id = await idParam(ctx);
      await updateUgcVideo(deps, id, pickTyped(await readJsonObject(req), VIDEO_FIELDS), actorOf(user));
      return Response.json(await adminGetUgcVideo(deps, id));
    }),
    // Videos are archived, never deleted (history kept; no DELETE route) — same convention as members / brands.
    archiveVideo: safe(async (_req, ctx, user) => Response.json(await archiveUgcVideo(deps, await idParam(ctx), actorOf(user)))),
    restoreVideo: safe(async (_req, ctx) => Response.json(await restoreUgcVideo(deps, await idParam(ctx)))),
    uploadVideoFile: uploadTo('video', 'videoUrl'),
    uploadThumbnailFile: uploadTo('thumbnail', 'thumbnailUrl'),
    // Standalone uploads (e.g. before creating the video): return the URL to send as videoUrl / thumbnailUrl.
    uploadVideo: safe(async (req) => Response.json(await storeUgcMedia(await readFile(req, 'video'), 'video', deps), { status: 201 })),
    uploadThumbnail: safe(async (req) => Response.json(await storeUgcMedia(await readFile(req, 'thumbnail'), 'thumbnail', deps), { status: 201 })),
    run: safe(async () => {
      const r = await runUgcEngine(deps);
      if (r.skipped === 'disabled') throw new DemoCompError('UGC_DISABLED', 409);
      return Response.json(r);
    }),
    generate: safe(async (_req, _ctx, user) => {
      const db = dbOf(deps);
      const before = await db.demoCompUgcEvent.count();
      const r = await generateUgcVideos(deps, actorOf(user));
      return Response.json({ ...r, events: (await db.demoCompUgcEvent.count()) - before });
    }),
  };
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': status === 200 ? PUBLIC_CACHE : 'no-store' } });

/** Public, read-only, simulation-labelled leaderboard (same caching / catch-up as /api/demo-competition/members). */
export function publicUgcHandlers(deps = {}) {
  const kick = () => { catchUpUgcOnRead(deps).catch(() => {}); };
  return {
    leaderboard: safe(async (req) => {
      kick();
      const v = new URL(req.url).searchParams.get('limit');
      return json(await getUgcLeaderboard(deps, { limit: v ? Number.parseInt(v, 10) : undefined }));
    }),
  };
}

/** Exposed for tests / tooling. */
export const __internals = { lockKey, computeVideoStats, CREATE_LOCK };
