/**
 * src/lib/services/brandSimulationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — PERMANENT simulated history: generation and
 * dashboards.
 *
 * Generation (deterministic, idempotent, never pruned):
 *   • hours are generated only inside the access's periods (activation /
 *     reopening → closure) and only while the settings version in force is
 *     enabled and verified (brandSimTimeline); a closed period is never filled in
 *   • each business day uses ONE settings version (dayParams), so a later
 *     configuration change never alters earlier history
 *   • work is done in bounded batches (SIM_BATCH_DAYS per transaction), each
 *     under a per-access PostgreSQL advisory transaction lock; progress is the
 *     access's `generatedThrough` (re-read under the lock), rows are inserted
 *     with ON CONFLICT DO NOTHING on (accessId, hourStart) — repeated runs,
 *     the engine and concurrent dashboard reads never duplicate or skip an hour
 *   • a dashboard read catches up at most SIM_MAX_CATCHUP_DAYS; the
 *     brand-simulation-engine (PM2) keeps every access up to date in background
 *
 * Dashboards: an ACTIVE access is shown up to now (live hour included); a
 * CLOSED access is READ-ONLY and anchored at its closure (windows and statuses
 * as of that instant). Periods whose settings cannot be verified are reported
 * as `incomplete` — never generated, never invented.
 *
 * The ONLY tables written here are brand_sim_hours and the progress column of
 * brand_accesses. Real orders, commissions, wallet, Rewards: never touched.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  buildHourRows, liveHourCounts, windowBuckets, simulatedOrders, ordersStats, deliveredInRows, simulatedBalanceOf, settledHoursBefore, simulatedListId,
  floorHour, ceilHour, DAY_MS,
} from '../brandSimulation.js';
import { accessWindows, generableHours, incompleteRanges, dayParams, hourEnabled } from '../brandSimTimeline.js';
import { getSettingsTimeline, advisoryXactLock, accessLockKey } from './brandSimSettingsService.js';
import { ACCESS_STATUS, getAffiliateAccessRow } from './brandAccessService.js';

export const SIM_BATCH_DAYS = 7;
export const SIM_MAX_CATCHUP_DAYS = 90;
export const BRAND_SIM_ENGINE_LOCK_KEY = 0x4252534d; // "BRSM" — distinct from the other engines

const err = (code, message) => Object.assign(new Error(message), { code });
const ms = (d) => (d ? new Date(d).getTime() : null);
const SIM_STATES = [ACCESS_STATUS.ACTIVE, ACCESS_STATUS.CLOSED];

/** Last hour start to process: the closure of a closed access, now otherwise (complete hours only). */
function generationTarget(access, periods, nowMs) {
  const last = periods[periods.length - 1];
  const end = access.status === ACCESS_STATUS.CLOSED ? (ms(last?.endedAt) ?? ms(access.closedAt) ?? nowMs) : nowMs;
  return floorHour(Math.min(end, nowMs));
}

/**
 * Generate the missing hours of one access, in batches. Returns
 * { inserted, pending (catch-up limit reached), through }.
 */
export async function materializeAccessSimulation(access, {
  db = prisma, now = new Date(), maxDays = SIM_MAX_CATCHUP_DAYS, batchDays = SIM_BATCH_DAYS, timeline = null,
} = {}) {
  if (!access || !SIM_STATES.includes(access.status) || !access.simulationStartsAt) return { inserted: 0, pending: false, through: null };
  const nowMs = ms(now);
  const tl = timeline || await getSettingsTimeline(db, { now });
  let inserted = 0, days = 0, through = null, pending = false;
  for (;;) {
    const step = await db.$transaction(async (tx) => {
      await advisoryXactLock(tx, accessLockKey(access.id));
      const fresh = await tx.brandAccess.findUnique({ where: { id: access.id } });
      const periods = await tx.brandAccessPeriod.findMany({ where: { accessId: access.id }, orderBy: { startedAt: 'asc' } });
      if (!fresh || !SIM_STATES.includes(fresh.status) || !periods.length) return { done: true, through: null };
      const windows = accessWindows(periods, fresh.simulationStartsAt, nowMs);
      const target = generationTarget(fresh, periods, nowMs);
      const cursor = fresh.generatedThrough ? ms(fresh.generatedThrough) : floorHour(windows[0].from);
      if (cursor >= target) return { done: true, through: cursor };
      const chunkEnd = Math.min(cursor + batchDays * DAY_MS, target);
      const hours = generableHours(tl, windows, cursor, chunkEnd);
      const count = hours.length
        ? (await tx.brandSimHour.createMany({ data: buildHourRows(access.id, access.id, hours, (d) => dayParams(tl, d)), skipDuplicates: true })).count
        : 0;
      await tx.brandAccess.updateMany({ where: { id: access.id }, data: { generatedThrough: new Date(chunkEnd) } });
      return { done: chunkEnd >= target, through: chunkEnd, count, days: (chunkEnd - cursor) / DAY_MS };
    });
    inserted += step.count || 0;
    if (step.through !== null && step.through !== undefined) through = step.through;
    if (step.done) break;
    days += step.days;
    if (days >= maxDays) { pending = true; break; }
  }
  return { inserted, pending, through: through === null ? null : new Date(through).toISOString() };
}

/**
 * Dashboard data for one access and one window ('24h' | '7d' | '30d').
 * Everything returned is SIMULATED training data (`simulated: true`).
 */
/** Simulated orders per page of the full list ("see all"). */
export const SIM_ORDERS_PAGE_SIZE = 20;

/** The pack's simulated selling price frozen in this access's request snapshot (null if absent → no figures). */
export function snapshotSimPrice(access) {
  const v = access?.packageSnapshot?.simulatedSellingPrice;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export async function getSimulationDashboard(access, { db = prisma, now = new Date(), window = '24h', page = 1, clock = now } = {}) {
  const at = ms(now);
  if (!windowBuckets(window, at)) throw err('INVALID_WINDOW', 'Période invalide.');
  // `now` = the instant the dashboard is computed for (a "see all" asOf may be up to 24 h old);
  // `clock` = the real current time: the one-time timeline reconstruction (persisted) is dated with it, never with an asOf.
  const timeline = await getSettingsTimeline(db, { now: clock });
  const gen = await materializeAccessSimulation(access, { db, now, timeline });

  const closed = access.status === ACCESS_STATUS.CLOSED;
  const anchor = closed ? Math.min(ms(access.closedAt) ?? at, at) : at;
  const periods = await db.brandAccessPeriod.findMany({ where: { accessId: access.id }, orderBy: { startedAt: 'asc' } });
  const windows = accessWindows(periods, access.simulationStartsAt, anchor);
  const b = windowBuckets(window, anchor);
  // Hours before `splitAt` are SETTLED at the anchor (their last minute is older than the longest
  // confirmation / delivery delay any settings version ever had), so their delivered orders are
  // exactly the stored `delivered` outcome counts: one SUM instead of reading every hour of history.
  // Later hours (the window + the still-moving ones before it) are read row by row.
  const maxDelayHours = timeline.reduce((m, v) => Math.max(m, Number(v.settings?.deliveryDelayHours) || 0, Number(v.settings?.confirmationDelayHours) || 0), 0);
  const splitAt = settledHoursBefore(anchor, b.from, maxDelayHours);
  const [settled, rows] = await Promise.all([
    db.brandSimHour.aggregate({ where: { accessId: access.id, hourStart: { lt: new Date(splitAt) } }, _sum: { delivered: true } }),
    db.brandSimHour.findMany({
      where: { accessId: access.id, hourStart: { gte: new Date(splitAt), lt: new Date(anchor) } },
      orderBy: { hourStart: 'asc' },
    }),
  ]);

  // Live (unfinished) hour: active access only, inside the open period, settings enabled + verified.
  const liveHour = floorHour(at);
  const open = windows.find((w) => w.open);
  const running = !closed && !!open && hourEnabled(timeline, liveHour);
  const liveParams = running && liveHour >= ceilHour(open.from) ? dayParams(timeline, liveHour) : null;
  const live = liveParams ? liveHourCounts(access.id, at, liveParams) : null;

  const products = Array.isArray(access.selectedProducts)
    ? access.selectedProducts.map((p) => ({ id: p.id, title: p.title || '', image: p.image || null }))
    : [];
  const counted = rows.filter((r) => r.created > 0).map((r) => ms(r.hourStart));

  // ONE dataset: the window's simulated orders. The list, the status counts, the
  // chart and the simulated revenue / profit are all derived from it.
  const price = snapshotSimPrice(access);
  const sim = (d) => dayParams(timeline, d);
  const liveAt = live?.created ? liveHour : null;
  const orders = simulatedOrders(access.id, { fromMs: b.from, nowMs: anchor, countedHours: counted, liveHour: liveAt, sim, products, price });
  const stats = ordersStats(orders, anchor, window, price);
  // Balance = every delivered order since the start: settled history (SUM) + orders created before the
  // window start (settled hour → stored count, else order by order; a clock hour straddling the start
  // only contributes its orders before it) + the window's delivered orders (the list).
  const delivered = (Number(settled?._sum?.delivered) || 0)
    + deliveredInRows(access.id, { rows: rows.filter((r) => ms(r.hourStart) < b.from), nowMs: anchor, sim, beforeMs: b.from })
    + stats.byStatus.delivered;
  const bal = simulatedBalanceOf(delivered, price);
  const pageNo = Math.max(1, Math.min(Number.isInteger(page) ? page : 1, Math.max(1, Math.ceil(orders.length / SIM_ORDERS_PAGE_SIZE))));
  const pub = ({ atMs: _atMs, ...o }) => o; // internal sort key, not part of the API
  // Identity of the WHOLE ordered list (window, bounds, snapshot price and products, every order's reference
  // and status): "see all" sends it back with each page; any difference means the list changed → refused.
  const listId = simulatedListId([access.id, window, b.from, anchor, price, products.map((p) => p.id)], orders);

  return {
    simulated: true,
    readOnly: closed,
    status: access.status,
    brandName: access.brandName,
    simulationStartsAt: access.simulationStartsAt ? new Date(access.simulationStartsAt).toISOString() : null,
    closedAt: closed && access.closedAt ? new Date(access.closedAt).toISOString() : null,
    anchor: new Date(anchor).toISOString(),
    started: access.simulationStartsAt ? anchor >= ms(access.simulationStartsAt) : false,
    running,
    stats,
    recent: orders.slice(0, 8).map(pub),
    orders: {
      // asOf: the instant this list was computed for; "see all" sends it back so every page uses the same period.
      asOf: new Date(at).toISOString(), window, listId,
      page: pageNo, pageSize: SIM_ORDERS_PAGE_SIZE, total: orders.length,
      items: orders.slice((pageNo - 1) * SIM_ORDERS_PAGE_SIZE, pageNo * SIM_ORDERS_PAGE_SIZE).map(pub),
    },
    // SIMULATED training figures (never a wallet, never withdrawable); null when the request snapshot has no simulated price.
    finance: price === null ? null : {
      simulated: true, price, revenue: stats.money.revenue, profit: stats.money.profit, balance: bal.balance,
    },
    incomplete: incompleteRanges(timeline, windows, b.from, anchor),
    catchUpPending: gen.pending,
  };
}

/** The participant's LATEST brand: ACTIVE, or CLOSED (read-only). @throws NO_ACTIVE_ACCESS | INVALID_WINDOW */
export async function getAffiliateSimulationDashboard(affiliateId, { db = prisma, now = new Date(), window = '24h', page = 1, clock = now } = {}) {
  const access = await getAffiliateAccessRow(affiliateId, db);
  if (!access || !SIM_STATES.includes(access.status)) throw err('NO_ACTIVE_ACCESS', 'Aucun accès actif.');
  return getSimulationDashboard(access, { db, now, window, page, clock });
}

/** Admin view of one access's simulated data (ACTIVE or CLOSED). @throws ACCESS_NOT_FOUND | NO_ACTIVE_ACCESS | INVALID_WINDOW */
export async function getAdminSimulationDashboard(accessId, { db = prisma, now = new Date(), window = '24h' } = {}) {
  const access = await db.brandAccess.findUnique({ where: { id: String(accessId || '') } });
  if (!access) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
  if (!SIM_STATES.includes(access.status)) throw err('NO_ACTIVE_ACCESS', 'Cet accès n’est pas actif.');
  return getSimulationDashboard(access, { db, now, window });
}

/**
 * One engine tick (brand-simulation-engine): bring every ACTIVE / CLOSED access
 * up to date, bounded per access. Idempotent; safe to run concurrently with
 * dashboard reads (same per-access lock and progress marker).
 */
export async function runBrandSimulationTick({ db = prisma, lock = null, now = new Date(), maxDaysPerAccess = 30 } = {}) {
  let held = true;
  if (lock && typeof lock.acquire === 'function') {
    held = await lock.acquire();
    if (!held) return { accesses: 0, inserted: 0, pending: 0, skipped: 'no_lock' };
  }
  try {
    const timeline = await getSettingsTimeline(db, { now });
    const accesses = await db.brandAccess.findMany({ where: { status: { in: SIM_STATES } }, orderBy: { createdAt: 'asc' } });
    let inserted = 0, pending = 0;
    for (const a of accesses) {
      const r = await materializeAccessSimulation(a, { db, now, timeline, maxDays: maxDaysPerAccess });
      inserted += r.inserted;
      if (r.pending) pending++;
    }
    return { accesses: accesses.length, inserted, pending };
  } finally {
    if (held && lock && typeof lock.release === 'function') {
      try { await lock.release(); } catch { /* release never masks the result */ }
    }
  }
}
