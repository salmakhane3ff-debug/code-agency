/**
 * src/lib/services/demoService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All business logic for the Demo Competition system.
 * Demo data is completely isolated from real affiliate data.
 *
 * Cycle + identity rules (Phase 3A):
 *   • 30-day Casablanca cycles (src/lib/demoCompetitionCycle.js). The cycle rolls
 *     over by itself on the first read/tick after its end — no admin click — and
 *     the next one starts exactly at the previous end.
 *   • Every rollover (automatic or the admin "Nouveau cycle") ARCHIVES the final
 *     standings in a `demo-competition-cycle:<n>` settings row and keeps the
 *     earnings history; only clearCompetitionHistory() deletes history.
 *   • Rollover runs in ONE transaction holding a row lock on the competition row,
 *     so concurrent requests/workers can never create duplicate cycles.
 *   • Demo profiles are permanent rows (stable ids); generation reuses them and
 *     never replaces the set. Ranking uses the single compareStanding rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { saveMedia, destroyByUrl } from '../cloudinary.js';
import { processDemoAvatar, DEMO_AVATAR_FOLDER, DEMO_AVATAR_GENDERS } from '../demoAvatarImage.js';
import { businessDateKey } from '../ugcTime.js';
import {
  CYCLE_ARCHIVE_PREFIX, cycleWindow, isCycleDue, nextCycleWindow,
  cycleDaysLeft, rankStandings,
} from '../demoCompetitionCycle.js';

// All demo DB access goes through `_db` (the real Prisma client in production).
// Tests swap in an in-memory fake via __setDemoDb — proving isolation without a DB.
let _db = prisma;
export function __setDemoDb(db) { _db = db || prisma; }
/** The demo DB seam, for the other demo services (profile management). */
export function getDemoDb() { return _db; }

// ── Name pools (Moroccan market), split by gender for men/women/mixed modes ─────
const MALE_NAMES = [
  'Youssef','Hamza','Omar','Amine','Karim','Mehdi','Rachid','Samir','Nabil','Khalid',
  'Tariq','Hassan','Mouad','Bilal','Hicham','Soufiane','Adil','Zakaria','Ismail','Younes',
  'Ayoub','Ilyass','Walid','Ayman','Othmane','Driss','Morad','Reda','Tarik','Jawad',
];
const FEMALE_NAMES = [
  'Sara','Nadia','Fatima','Samira','Leila','Meryem','Houda','Zineb','Hajar','Imane',
  'Chaimae','Doha','Yasmina','Sanaa','Karima','Siham','Widad','Asmaa','Nawal','Btissam',
];
const FIRST_NAMES = [...MALE_NAMES, ...FEMALE_NAMES]; // kept for any legacy reference
const LAST_NAMES = [
  'Benaissa','El Amrani','Chaabi','Benali','Ouarrach','Akhtar','Bennis','Filali',
  'Berrada','Essaidi','Lazrak','Mrani','Tahiri','Ziani','Bennani','Alaoui','Skali',
  'Chraibi','Benkirane','Tazi','Hajji','Bouazzaoui','Fassi','Mansouri','Sentissi',
];
const AVATAR_COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6',
  '#ef4444','#14b8a6','#f97316','#84cc16','#06b6d4','#a855f7',
];

// ── Growth parameters ─────────────────────────────────────────────────────────
export const GROWTH = {
  aggressive: { ordersRange: [4, 12], revenuePerOrder: [200, 500], teamGrowthChance: 0.4, cancelRate: 0.05 },
  consistent: { ordersRange: [2, 5],  revenuePerOrder: [120, 320], teamGrowthChance: 0.2, cancelRate: 0.10 },
  slow:       { ordersRange: [0, 2],  revenuePerOrder: [80,  200], teamGrowthChance: 0.1, cancelRate: 0.15 },
};

const SPEED_MULT = { slow: 0.4, medium: 1, fast: 2.8 };

export const COMMISSION_RATE = 0.05; // 5% parent earns from team
const DEMO_UGC_COMMISSION = 5; // MAD per simulated UGC sale (demo-only, never a real rate)

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randF(min, max) { return +(Math.random() * (max - min) + min).toFixed(2); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Seed demo UGC stats for a freshly generated affiliate (presentation-only).
function seedDemoUgc() {
  const todaySales = rand(0, 30);
  const totalSales = rand(10, 500);
  return {
    ugcTodaySales:    todaySales,
    ugcTotalSales:    totalSales,
    ugcTodayEarnings: +(todaySales * DEMO_UGC_COMMISSION).toFixed(2),
    ugcTotalEarnings: +(totalSales * DEMO_UGC_COMMISSION).toFixed(2),
  };
}

// ── Demo avatar library (permanent — only an admin deletes) ────────────────────

export async function listDemoAvatars() {
  const rows = await _db.demoAvatar.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map((a) => ({ id: a.id, gender: a.gender, url: a.url, createdAt: a.createdAt }));
}

/**
 * Process (crop→256→webp q80) + store each buffer, then persist a DemoAvatar row.
 * @param {'men'|'women'} gender
 * @param {Buffer[]} buffers
 */
export async function addDemoAvatars(gender, buffers) {
  if (!DEMO_AVATAR_GENDERS.includes(gender)) {
    throw Object.assign(new Error('gender must be men or women'), { code: 'DEMO_AVATAR_BAD_GENDER' });
  }
  const created = [];
  for (const buffer of buffers) {
    const webp = await processDemoAvatar(buffer);
    const stored = await saveMedia(webp, { resourceType: 'image', folder: DEMO_AVATAR_FOLDER, subdir: DEMO_AVATAR_FOLDER });
    const row = await _db.demoAvatar.create({
      data: { gender, url: stored.url, storageKey: stored.publicId || stored.key || null },
    });
    created.push({ id: row.id, gender: row.gender, url: row.url });
  }
  return created;
}

/** Delete one avatar from the library + its stored object. Assigned copies stay
 *  on affiliate rows (avatarUrl) until the next generation → never a broken image. */
export async function deleteDemoAvatar(id) {
  const row = await _db.demoAvatar.findUnique({ where: { id } });
  if (!row) return { deleted: false };
  await _db.demoAvatar.delete({ where: { id } });
  if (row.url) await destroyByUrl(row.url).catch(() => {});
  return { deleted: true };
}

// ── Leaderboard in-memory cache ───────────────────────────────────────────────
let _leaderboardCache = null;
let _leaderboardTs    = 0;
const LEADERBOARD_TTL = 60_000; // 60 s

export function invalidateDemoCache() {
  _leaderboardCache = null;
  _identityCache = { at: 0, data: null };
}

// ── Shared demo identity pool (single source of truth for demo people) ────────
// The Monthly Competition (leaderboard) and the Live Activity feed both read
// THIS pool, so a demo person always keeps the same id / name / username /
// avatar everywhere. When the competition has fewer than IDENTITY_MIN active
// demo affiliates, the pool is topped up with DETERMINISTIC supplemental
// profiles (index-based, no randomness) so identities stay stable permanently
// across requests, restarts and instances — without inserting rows or touching
// competition scores/ranking.
const IDENTITY_MIN = 300;
const IDENTITY_TTL = 60_000;
let _identityCache = { at: 0, data: null };

function supplementalIdentity(i) {
  const first = FEMALE_NAMES[i % FEMALE_NAMES.length];
  const last  = LAST_NAMES[Math.floor(i / FEMALE_NAMES.length) % LAST_NAMES.length];
  return {
    id:          `demo-extra-${String(i + 1).padStart(3, '0')}`,
    name:        `${first} ${last}`,
    username:    `${first.toLowerCase()}${101 + (i * 7) % 899}`, // stable per index
    avatarUrl:   null,                                            // initials fallback
    avatarColor: AVATAR_COLORS[i % AVATAR_COLORS.length],
    gender:      'women',
  };
}

export async function getDemoIdentityPool(minSize = IDENTITY_MIN) {
  if (_identityCache.data && Date.now() - _identityCache.at < IDENTITY_TTL) return _identityCache.data;
  let base = [];
  try {
    const rows = await _db.demoAffiliate.findMany({ where: { isActive: true } });
    base = rows.map((a) => ({
      id: a.id, name: a.name, username: a.username,
      avatarUrl: a.avatarUrl ?? null, avatarColor: a.avatarColor, gender: a.gender ?? 'women',
    }));
  } catch (err) {
    console.error('[demo] identity pool error:', err?.message ?? err);
  }
  const pool = [...base];
  for (let i = 0; pool.length < minSize; i++) pool.push(supplementalIdentity(i));
  _identityCache = { at: Date.now(), data: pool };
  return pool;
}

// ── Generate demo affiliates ──────────────────────────────────────────────────

/**
 * Ensure `count` ACTIVE demo profiles. Existing profiles are permanent: they keep
 * their id, name, username and avatar (and their stats/history). Missing ones
 * are filled by reactivating deactivated profiles first, then by creating new
 * ones; surplus profiles are deactivated (hidden), never deleted.
 */
export async function generateDemoAffiliates(count = 60, mode = 'mixed') {
  const genderMode = ['men', 'women', 'mixed'].includes(mode) ? mode : 'mixed';

  const existing = await _db.demoAffiliate.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const active   = existing.filter((a) => a.isActive);
  const inactive = existing.filter((a) => !a.isActive);

  let reactivated = 0, deactivated = 0;
  if (active.length > count) {
    // Keep the oldest profiles; hide the most recent surplus.
    for (const a of active.slice(count)) {
      await _db.demoAffiliate.update({ where: { id: a.id }, data: { isActive: false } });
      deactivated++;
    }
  }
  let missing = Math.max(0, count - active.length);
  for (const a of inactive) {
    if (!missing) break;
    await _db.demoAffiliate.update({ where: { id: a.id }, data: { isActive: true } });
    reactivated++; missing--;
  }

  // Load the avatar library once; assign one avatar per NEW profile, reused
  // cyclically when there are fewer avatars than profiles. Empty → initials.
  const avatars = await _db.demoAvatar.findMany({ select: { gender: true, url: true } });
  const byGender = {
    men:   avatars.filter((a) => a.gender === 'men'),
    women: avatars.filter((a) => a.gender === 'women'),
  };
  const cursor = { men: 0, women: 0 };
  const nextAvatarUrl = (gender) => {
    const pool = byGender[gender];
    if (!pool || pool.length === 0) return null;                 // → initials fallback
    const url = pool[cursor[gender] % pool.length].url;
    cursor[gender] += 1;
    return url;
  };

  const usedUsernames = new Set(existing.map((a) => a.username));
  const types  = ['aggressive', 'consistent', 'consistent', 'slow']; // weighted
  const created = [];

  for (let i = 0; i < missing; i++) {
    const gender = genderMode === 'mixed' ? pick(['men', 'women']) : genderMode;
    const first  = pick(gender === 'men' ? MALE_NAMES : FEMALE_NAMES);
    const last   = pick(LAST_NAMES);
    const name   = `${first} ${last}`;
    let username;
    do { username = `demo_${first.toLowerCase()}${rand(10, 9999)}`; } while (usedUsernames.has(username));
    usedUsernames.add(username);

    const affiliate = await _db.demoAffiliate.create({
      data: {
        name,
        username,
        gender,
        avatarUrl:   nextAvatarUrl(gender),      // persisted — never re-randomized
        avatarColor: pick(AVATAR_COLORS),        // initials fallback colour
        growthType:  pick(types),
        stats: {
          create: {
            totalOrders:     rand(0, 30),
            totalRevenue:    randF(0, 9000),
            confirmedOrders: rand(0, 25),
            cancelledOrders: rand(0, 5),
            teamSize:        rand(0, 8),
            teamOrders:      rand(0, 20),
            teamRevenue:     randF(0, 5000),
            teamCommission:  0,
            todayOrders:     rand(0, 3),
            todayRevenue:    randF(0, 800),
            ...seedDemoUgc(),
          },
        },
      },
    });
    created.push(affiliate.id);
  }

  // Seed 7 days of history for each NEW profile (existing history is kept).
  const now = new Date();
  for (const demoId of created) {
    const affiliate = await _db.demoAffiliate.findUnique({
      where: { id: demoId },
      select: { growthType: true },
    });
    const g = GROWTH[affiliate.growthType];

    for (let d = 6; d >= 0; d--) {
      const date    = new Date(now);
      date.setDate(date.getDate() - d);
      date.setHours(0, 0, 0, 0);
      const orders   = rand(...g.ordersRange);
      const revenue  = orders > 0 ? orders * randF(...g.revenuePerOrder) : 0;
      const commission = +(revenue * COMMISSION_RATE).toFixed(2);
      await _db.demoEarningsHistory.create({
        data: { demoAffiliateId: demoId, date, orders, revenue: +revenue.toFixed(2), commission },
      });
    }
  }

  // Recalculate teamCommission and ranks
  await recomputeRanks();

  // Ensure competition row exists
  await ensureCompetition();

  // Mark settings as generated
  await _db.demoSettings.upsert({
    where:  { id: 'settings' },
    update: { autoGenerated: true },
    create: { id: 'settings', isEnabled: true, simulationSpeed: 'medium', autoGenerated: true },
  });

  invalidateDemoCache();
  return { generated: count, created: created.length, reactivated, deactivated };
}

// ── Ensure competition row ────────────────────────────────────────────────────

export async function ensureCompetition({ db = _db, now = Date.now() } = {}) {
  const existing = await db.demoCompetition.findUnique({ where: { id: 'current' } });
  if (existing) return existing;

  // First cycle: today's Casablanca midnight → +30 local days.
  const { start, end } = cycleWindow(now);
  try {
    return await db.demoCompetition.create({
      data: { id: 'current', startDate: new Date(start), endDate: new Date(end), isActive: true, cycleNum: 1 },
    });
  } catch (err) {
    if (err?.code !== 'P2002') throw err; // another request created it first
    return db.demoCompetition.findUnique({ where: { id: 'current' } });
  }
}

// ── Recalculate ranks ─────────────────────────────────────────────────────────

// Current standings of the ACTIVE profiles under the single ranking rule.
export async function currentStandings(db = _db) {
  const rows = await db.demoAffiliate.findMany({ where: { isActive: true }, include: { stats: true } });
  return rankStandings(rows.filter((a) => a.stats).map((a) => ({
    id: a.id, affiliate: a, stats: a.stats,
    totalOrders: a.stats.totalOrders ?? 0, totalRevenue: a.stats.totalRevenue ?? 0,
  })));
}

async function recomputeRanks() {
  const standings = await currentStandings();
  const ranked = new Map(standings.map((r) => [r.stats.id, r.rank]));
  const stats = await _db.demoStats.findMany({ select: { id: true, totalRevenue: true } });
  for (const st of stats) {
    await _db.demoStats.update({
      where: { id: st.id },
      data:  {
        teamCommission: +((st.totalRevenue || 0) * COMMISSION_RATE).toFixed(2),
        rank: ranked.get(st.id) ?? 0, // deactivated profiles are unranked
      },
    });
  }
}

// ── Realistic order allocation ────────────────────────────────────────────────
// A tick adds only a handful of orders (never more than 4), not one batch per
// affiliate — so the competition grows believably instead of jumping 30–50/tick.

/** Orders created by a single tick: 70% → 1, 20% → 2, 8% → 3, 2% → 4. */
export function pickTickOrderCount() {
  const r = Math.random();
  if (r < 0.70) return 1;
  if (r < 0.90) return 2; // 0.70–0.90 → 20%
  if (r < 0.98) return 3; // 0.90–0.98 → 8%
  return 4;               // 0.98–1.00 → 2%
}

/**
 * Pick which affiliate gets an order. Favors the top of the board (linear
 * decreasing weight), but ~25% of the time picks a fully random affiliate so
 * lower-ranked members still occasionally score — keeping the ranking dynamic.
 * @param {Array} sorted affiliates ordered by totalOrders desc (index 0 = leader)
 */
export function pickWeightedRecipient(sorted) {
  const n = sorted.length;
  if (n <= 1) return sorted[0];
  if (Math.random() < 0.25) return sorted[Math.floor(Math.random() * n)];
  let r = Math.random() * (n * (n + 1) / 2);
  for (let i = 0; i < n; i++) {
    const w = n - i; // leader = n, runner-up = n-1, …, last = 1
    if (r < w) return sorted[i];
    r -= w;
  }
  return sorted[0];
}

// ── Simulate one tick ─────────────────────────────────────────────────────────

export async function simulateTick() {
  const settings = await getDemoSettings();
  if (!settings.isEnabled) return { skipped: true };

  // New business day → roll the "today" buckets (boutique + demo UGC) back to 0.
  // Totals accumulate; only the daily figures reset. Uses the same TZ-aware day
  // boundary as the real UGC engine (Africa/Casablanca default) so demo "today"
  // flips over at the same instant the dashboard's day does.
  if (settings.lastSimAt &&
      businessDateKey(new Date(settings.lastSimAt)) !== businessDateKey(new Date())) {
    await _db.demoStats.updateMany({
      data: { todayOrders: 0, todayRevenue: 0, ugcTodaySales: 0, ugcTodayEarnings: 0 },
    });
  }

  const affiliates = await _db.demoAffiliate.findMany({
    where:   { isActive: true },
    include: { stats: true },
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const eligible = affiliates.filter((a) => a.stats);
  let ordersThisTick = 0;
  const assigned = new Map(); // affiliateId → orders received this tick

  if (eligible.length) {
    // 1) How many orders does THIS tick create? Weighted + capped at 4.
    ordersThisTick = pickTickOrderCount();

    // 2) Assign each order to a weighted-random affiliate (top-favored, but the
    //    ranking stays dynamic). Current standing = totalOrders desc.
    const sorted = [...eligible].sort((a, b) => (b.stats.totalOrders || 0) - (a.stats.totalOrders || 0));
    for (let i = 0; i < ordersThisTick; i++) {
      const aff = pickWeightedRecipient(sorted);
      assigned.set(aff.id, (assigned.get(aff.id) || 0) + 1);
    }

    // 3) Apply growth ONLY to the chosen affiliates. Earnings calculation is
    //    preserved exactly: revenue = orders × per-order price (by growthType),
    //    commission = revenue × 5%. Team/UGC deltas are scoped to recipients and
    //    the small order counts, so nothing balloons.
    for (const aff of eligible) {
      const orders = assigned.get(aff.id) || 0;
      if (!orders) continue;

      const g         = GROWTH[aff.growthType];
      const revenue   = +(orders * randF(...g.revenuePerOrder)).toFixed(2);
      const cancelled = Math.round(orders * g.cancelRate);
      const confirmed = orders - cancelled;

      // Team growth (probabilistic, modest).
      const teamDelta        = Math.random() < g.teamGrowthChance ? rand(0, 1) : 0;
      const teamOrdersDelta  = Math.round(orders * 0.3);
      const teamRevenueDelta = +(teamOrdersDelta * randF(100, 300)).toFixed(2);

      // Demo UGC growth (presentation-only — never writes to ugc_earnings/targets).
      const ugcSalesDelta = Math.random() < 0.3 ? rand(0, orders) : 0;
      const ugcEarnDelta  = +(ugcSalesDelta * DEMO_UGC_COMMISSION).toFixed(2);

      await _db.demoStats.update({
        where: { demoAffiliateId: aff.id },
        data: {
          totalOrders:     { increment: orders },
          totalRevenue:    { increment: revenue },
          confirmedOrders: { increment: confirmed },
          cancelledOrders: { increment: cancelled },
          todayOrders:     { increment: orders },
          todayRevenue:    { increment: revenue },
          teamSize:        { increment: teamDelta },
          teamOrders:      { increment: teamOrdersDelta },
          teamRevenue:     { increment: teamRevenueDelta },
          ugcTodaySales:    { increment: ugcSalesDelta },
          ugcTotalSales:    { increment: ugcSalesDelta },
          ugcTodayEarnings: { increment: ugcEarnDelta },
          ugcTotalEarnings: { increment: ugcEarnDelta },
        },
      });

      // Upsert today's history row
      const existing = await _db.demoEarningsHistory.findFirst({
        where: { demoAffiliateId: aff.id, date: today },
      });
      const commission = +(revenue * COMMISSION_RATE).toFixed(2);
      if (existing) {
        await _db.demoEarningsHistory.update({
          where: { id: existing.id },
          data: {
            orders:     { increment: orders },
            revenue:    { increment: revenue },
            commission: { increment: commission },
          },
        });
      } else {
        await _db.demoEarningsHistory.create({
          data: { demoAffiliateId: aff.id, date: today, orders, revenue, commission },
        });
      }
    }
  }

  // Recalculate ranks + update lastSimAt
  await recomputeRanks();
  await _db.demoSettings.upsert({
    where:  { id: 'settings' },
    update: { lastSimAt: new Date() },
    create: { id: 'settings', isEnabled: true, simulationSpeed: 'medium', lastSimAt: new Date() },
  });

  // 30-day cycle ended → automatic rollover (archives the standings first).
  await advanceCompetitionIfDue();

  invalidateDemoCache();
  return { simulated: assigned.size, orders: ordersThisTick };
}

// ── Background auto-simulation ────────────────────────────────────────────────
// Keeps the competition "alive" without manual clicks: a standalone PM2 worker
// (scripts/demo-competition-engine.mjs) calls runAutoSimTick() on a loop. Same
// advisory-lock pattern as the other engines — only ONE runner ticks at a time.
export const DEMO_SIM_LOCK_KEY      = 0x44454d43; // "DEMC" — distinct from UGC/fake-order locks
export const DEMO_SIM_MIN_INTERVAL  = 5;          // seconds
export const DEMO_SIM_MAX_INTERVAL  = 30;         // seconds
export const DEMO_SIM_DEFAULT_INTERVAL = 10;      // seconds

/** Clamp an auto-sim interval (seconds) into the allowed 5–30 s window. */
export function clampSimInterval(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEMO_SIM_DEFAULT_INTERVAL;
  return Math.min(DEMO_SIM_MAX_INTERVAL, Math.max(DEMO_SIM_MIN_INTERVAL, n));
}

/**
 * One auto-simulation decision + tick. Runs a real simulateTick() ONLY when the
 * demo competition is enabled AND auto-simulation is turned on. Always returns
 * the (clamped) interval so the runner can schedule the next tick and pick up
 * interval changes live, without a restart. The optional advisory lock ensures a
 * single ticking runner even if the process is duplicated.
 * @returns {Promise<{ticked:boolean, intervalMs:number, skipped?:string, result?:object}>}
 */
export async function runAutoSimTick(deps = {}) {
  const { lock } = deps;
  const settings   = await getDemoSettings();
  const intervalMs = clampSimInterval(settings.autoSimIntervalSec) * 1000;

  if (!settings.isEnabled || !settings.autoSimEnabled) {
    return { ticked: false, skipped: 'disabled', intervalMs };
  }

  let held = true;
  if (lock && typeof lock.acquire === 'function') {
    held = await lock.acquire();
    if (!held) return { ticked: false, skipped: 'no_lock', intervalMs };
  }
  try {
    const result = await simulateTick(); // identical logic to the manual button
    return { ticked: !result?.skipped, result, intervalMs };
  } finally {
    if (held && lock && typeof lock.release === 'function') {
      try { await lock.release(); } catch { /* release never masks the result */ }
    }
  }
}

// ── Cycle rollover / reset / history ──────────────────────────────────────────

const ARCHIVE_FIELDS = ['totalOrders', 'totalRevenue', 'confirmedOrders', 'cancelledOrders',
  'teamSize', 'teamCommission', 'ugcTotalSales', 'ugcTotalEarnings'];

/**
 * Close the current cycle and open the next one, atomically:
 *   lock the competition row → (auto: re-check it is still due) → archive the
 *   final standings → zero the demo stats → advance the cycle.
 * Everything runs in ONE transaction, so a crash leaves no half-rolled cycle
 * and concurrent callers serialize on the row lock (the losers see the new
 * cycle and do nothing). Earnings history is never deleted here.
 * @returns {Promise<null|{cycle:number, previous:number, reason:string, start:Date, end:Date}>}
 */
async function rollCycle({ reason, db = _db, now = Date.now() }) {
  await ensureCompetition({ db, now });
  const result = await db.$transaction(async (tx) => {
    const [comp] = await tx.$queryRaw`SELECT "cycleNum", "startDate", "endDate" FROM "demo_competition" WHERE "id" = 'current' FOR UPDATE`;
    if (!comp) return null;
    const endMs = new Date(comp.endDate).getTime();
    if (reason === 'auto' && !isCycleDue(endMs, now)) return null; // someone else already rolled it

    const standings = await currentStandings(tx);
    await tx.setting.create({
      data: {
        id: `${CYCLE_ARCHIVE_PREFIX}${comp.cycleNum}`,
        data: {
          cycleNum:  comp.cycleNum,
          startDate: new Date(comp.startDate).toISOString(),
          endDate:   new Date(comp.endDate).toISOString(),
          closedAt:  new Date(now).toISOString(),
          reason,                                 // 'auto' | 'manual'
          participants: standings.length,
          standings: standings.map((r) => ({
            demoAffiliateId: r.id,
            rank:        r.rank,
            name:        r.affiliate.name,
            username:    r.affiliate.username,
            avatarUrl:   r.affiliate.avatarUrl ?? null,
            avatarColor: r.affiliate.avatarColor,
            ...Object.fromEntries(ARCHIVE_FIELDS.map((k) => [k, r.stats[k] ?? 0])),
          })),
        },
      },
    });

    // Zero the scores (DEMO tables only — production data is never touched).
    await tx.demoStats.updateMany({
      data: {
        totalOrders: 0, totalRevenue: 0, confirmedOrders: 0, cancelledOrders: 0,
        todayOrders: 0, todayRevenue: 0, teamOrders: 0, teamRevenue: 0,
        teamCommission: 0, rank: 0,
        ugcTodayEarnings: 0, ugcTodaySales: 0, ugcTotalEarnings: 0, ugcTotalSales: 0,
      },
    });

    // Auto: continue the 30-day grid from the old end. Manual: restart today.
    const next = reason === 'auto' ? nextCycleWindow(endMs, now) : cycleWindow(now);
    await tx.demoCompetition.update({
      where: { id: 'current' },
      data:  { startDate: new Date(next.start), endDate: new Date(next.end), isActive: true, cycleNum: comp.cycleNum + 1 },
    });
    return { cycle: comp.cycleNum + 1, previous: comp.cycleNum, reason, start: new Date(next.start), end: new Date(next.end) };
  });
  if (result) invalidateDemoCache();
  return result;
}

/** Roll the cycle over if its 30 days are over (no-op otherwise). */
export async function advanceCompetitionIfDue({ db = _db, now = Date.now() } = {}) {
  const comp = await ensureCompetition({ db, now });
  if (!isCycleDue(new Date(comp.endDate).getTime(), now)) return null;
  return rollCycle({ reason: 'auto', db, now });
}

/**
 * Admin "Nouveau cycle": archive the current standings and start a fresh
 * 30-day cycle today. History is KEPT (only clearCompetitionHistory deletes).
 * A legacy boolean argument is accepted and ignored.
 */
export async function resetCompetition(opts = {}) {
  const { db = _db, now = Date.now() } = (opts && typeof opts === 'object') ? opts : {};
  const res = await rollCycle({ reason: 'manual', db, now });
  return { reset: true, cycle: res?.cycle ?? null, archived: res?.previous ?? null };
}

/** Archived cycles, newest first (summary + top 3). */
export async function listCompetitionHistory({ db = _db, limit = 12 } = {}) {
  const rows = await db.setting.findMany({ where: { id: { startsWith: CYCLE_ARCHIVE_PREFIX } } });
  return rows
    .map((r) => r.data)
    .filter((d) => d && Number.isFinite(d.cycleNum))
    .sort((a, b) => b.cycleNum - a.cycleNum)
    .slice(0, limit)
    .map((d) => ({
      cycleNum: d.cycleNum, startDate: d.startDate, endDate: d.endDate, closedAt: d.closedAt,
      reason: d.reason, participants: d.participants,
      top: (d.standings || []).slice(0, 3).map((x) => ({ rank: x.rank, name: x.name, totalOrders: x.totalOrders })),
    }));
}

/**
 * Explicit, separate admin action: delete the archived cycles and the demo
 * earnings history. Never called by a reset or a rollover.
 */
export async function clearCompetitionHistory({ db = _db } = {}) {
  const cycles  = await db.setting.deleteMany({ where: { id: { startsWith: CYCLE_ARCHIVE_PREFIX } } });
  const history = await db.demoEarningsHistory.deleteMany();
  invalidateDemoCache();
  return { deletedCycles: cycles.count, deletedHistoryRows: history.count };
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export async function getLeaderboard(limit = 20) {
  if (_leaderboardCache && Date.now() - _leaderboardTs < LEADERBOARD_TTL) {
    return _leaderboardCache.slice(0, limit);
  }

  // Same ranking rule as the profile view and the archived standings.
  const standings = await currentStandings();

  const data = standings.map(({ affiliate: a, rank }) => ({
    id:          a.id,
    name:        a.name,
    username:    a.username,
    avatarColor: a.avatarColor,
    avatarUrl:   a.avatarUrl ?? null,   // persisted; UI falls back to initials when null
    gender:      a.gender ?? null,
    growthType:  a.growthType,
    rank,
    totalOrders:     a.stats?.totalOrders     ?? 0,
    totalRevenue:    a.stats?.totalRevenue    ?? 0,
    confirmedOrders: a.stats?.confirmedOrders ?? 0,
    cancelledOrders: a.stats?.cancelledOrders ?? 0,
    todayOrders:     a.stats?.todayOrders     ?? 0,
    todayRevenue:    a.stats?.todayRevenue    ?? 0,
    teamSize:        a.stats?.teamSize        ?? 0,
  }));

  _leaderboardCache = data;
  _leaderboardTs    = Date.now();
  return data.slice(0, limit);
}

// ── Affiliate details (lazy) ──────────────────────────────────────────────────

export async function getDemoAffiliateDetails(id) {
  const aff = await _db.demoAffiliate.findUnique({
    where:   { id },
    include: {
      stats: true,
      earningsHistory: {
        orderBy: { date: 'asc' },
        take:    30,
      },
    },
  });
  if (!aff) return null;

  // Live rank under the SAME rule as the leaderboard (0 = deactivated/unranked).
  const standings = await currentStandings();
  const rank = standings.find((r) => r.id === aff.id)?.rank ?? 0;
  const comp = await ensureCompetition();

  const s = aff.stats;
  return {
    id:          aff.id,
    name:        aff.name,
    username:    aff.username,
    avatarColor: aff.avatarColor,
    avatarUrl:   aff.avatarUrl ?? null,
    gender:      aff.gender ?? null,
    growthType:  aff.growthType,
    rank,
    cycleNum:    comp.cycleNum,
    // Main stats
    totalOrders:     s?.totalOrders     ?? 0,
    totalRevenue:    s?.totalRevenue    ?? 0,
    confirmedOrders: s?.confirmedOrders ?? 0,
    cancelledOrders: s?.cancelledOrders ?? 0,
    // Today
    todayOrders:  s?.todayOrders  ?? 0,
    todayRevenue: s?.todayRevenue ?? 0,
    // Team
    teamSize:       s?.teamSize       ?? 0,
    teamOrders:     s?.teamOrders     ?? 0,
    teamRevenue:    s?.teamRevenue    ?? 0,
    teamCommission: s?.teamCommission ?? 0,
    // Demo UGC (presentation-only) — for the competition popup "Gains" tab
    ugcTodayEarnings: s?.ugcTodayEarnings ?? 0,
    ugcTodaySales:    s?.ugcTodaySales    ?? 0,
    ugcTotalEarnings: s?.ugcTotalEarnings ?? 0,
    ugcTotalSales:    s?.ugcTotalSales    ?? 0,
    // History (last 30 days)
    earningsHistory: aff.earningsHistory.map((h) => ({
      date:       h.date,
      orders:     h.orders,
      revenue:    h.revenue,
      commission: h.commission,
    })),
  };
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getDemoSettings() {
  const s = await _db.demoSettings.findUnique({ where: { id: 'settings' } });
  return s ?? {
    id: 'settings', isEnabled: true, simulationSpeed: 'medium', lastSimAt: null,
    autoGenerated: false, autoSimEnabled: false, autoSimIntervalSec: DEMO_SIM_DEFAULT_INTERVAL,
  };
}

export async function saveDemoSettings(data = {}) {
  // Only apply fields the caller actually sent, so a partial patch (e.g. just the
  // auto-sim toggle) never clobbers the other settings.
  const patch = {};
  if (data.isEnabled !== undefined)       patch.isEnabled = data.isEnabled === true;
  if (data.simulationSpeed !== undefined && SPEED_MULT[data.simulationSpeed] !== undefined) {
    patch.simulationSpeed = data.simulationSpeed;
  }
  if (data.autoSimEnabled !== undefined)  patch.autoSimEnabled = data.autoSimEnabled === true;
  if (data.autoSimIntervalSec !== undefined) patch.autoSimIntervalSec = clampSimInterval(data.autoSimIntervalSec);

  return _db.demoSettings.upsert({
    where:  { id: 'settings' },
    update: patch,
    create: { id: 'settings', isEnabled: true, simulationSpeed: 'medium', ...patch },
  });
}

// ── Competition info ──────────────────────────────────────────────────────────

export async function getCompetitionInfo({ now = Date.now() } = {}) {
  // A finished cycle rolls over here too, so it advances even with no worker.
  await advanceCompetitionIfDue({ now });
  const comp  = await ensureCompetition({ now });
  const total = await _db.demoAffiliate.count({ where: { isActive: true } });
  const daysLeft = cycleDaysLeft(new Date(comp.endDate).getTime(), now);

  return {
    startDate: comp.startDate,
    endDate:   comp.endDate,
    cycleNum:  comp.cycleNum,
    daysLeft,
    totalParticipants: total,
  };
}
