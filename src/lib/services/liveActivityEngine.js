/**
 * src/lib/services/liveActivityEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The single, SERVER-SIDE Live Activity engine shared by BOTH the landing page
 * (/tsajlim3ana) and the affiliate dashboard. There is exactly one source of
 * truth: a stored rolling feed + four running counters advanced over time on the
 * server. All clients poll /api/live-activity and therefore see the SAME events —
 * no localStorage, no client-generated feed, no duplicated engine.
 *
 * Demo/presentation only — never real users or PII. PEOPLE in the feed come from
 * the SHARED demo identity pool (getDemoIdentityPool — the exact same dataset as
 * the 🏆 Monthly Competition), so a person always keeps the same id / name /
 * username / avatar in the leaderboard AND in Live Activity. Only the activity
 * details are generated around the person. UGC earnings are ALWAYS computed as
 *   generatedSales × commissionPerSale   (the real UGC admin setting)
 * at serve time, so changing the commission instantly updates every UGC activity.
 *
 * State is kept in the `live-activity-state` settings row (durable across
 * restarts) plus a short in-memory cache to bound reads/writes. Counters reset at
 * the business-day boundary and whenever the admin bumps the reset token.
 *
 * SIMULATED feed — every served payload and event carries `simulated: true` and
 * the UI shows a permanent disclosure. Time rules (src/lib/liveActivityTime.js):
 *   • Africa/Casablanca for the business day, delivery hours and clock labels
 *   • delivery-related events only at 08:00 ≤ Casablanca time < 20:00
 *   • every event keeps its TRUE timestamp (catch-up ticks are back-dated to the
 *     tick they stand for, never stamped "now")
 * Concurrency: one generation at a time — a single-flight promise per process
 * and a transaction-scoped Postgres advisory lock across processes; a worker
 * that cannot take the lock serves the stored state without generating.
 * A failed read never writes: the last good snapshot (or nothing) is served.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import prisma from '../prisma.js';
import { getSettings } from './settingsService.js';
import { getDemoIdentityPool } from './demoService.js';
import { getBoosterLiveFacts } from './boosterSimulationService.js';
import { normalizeUgcSettings } from '../ugcSettings.js';
import {
  normalizeLiveActivity, pickActivityType, applyActivityToStats, driftOnline,
} from '../recruitmentCta.js';
import {
  LIVE_ACTIVITY_TIMEZONE, LIVE_ACTIVITY_DISCLOSURE, probabilitiesAt, liveActivityDayKey,
  liveActivityDayStart, eventTimeLabel, casablancaClockLabel,
} from '../liveActivityTime.js';

export const STATE_KEY = 'live-activity-state';
const CACHE_MS    = 3000;   // serve the same snapshot for up to 3s
const MAX_EVENTS  = 40;     // rolling feed length kept in state
const MAX_CATCHUP = 3;      // never add more than this per advance → no huge jumps
// pg_try_advisory_xact_lock keys ("LIVE", 1) — distinct from the rewards keys.
export const LIVE_ACTIVITY_LOCK_KEYS = [0x4c495645, 1];

let _cache = { at: 0, view: null }; // last loaded view, reused for CACHE_MS
let _inflight = null;               // single-flight: one load per process at a time
let _lastGood = null;               // last successfully loaded view (read-failure fallback)

/** Test hook: forget the per-process cache / single-flight / last good view. */
export function resetLiveActivityCacheForTests() {
  _cache = { at: 0, view: null }; _inflight = null; _lastGood = null;
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function getUgcCommissionPerSale() {
  try {
    const s = normalizeUgcSettings(await getSettings('ugc'));
    const v = Number(s.commissionPerSale);
    return Number.isFinite(v) && v >= 0 ? v : 4;
  } catch { return 4; }
}

// Build ONE stored event around a person from the SHARED identity pool: the
// person's stable id/name/username/avatar are COPIED verbatim (never re-rolled),
// only the activity details are generated. Exported for tests. UGC events store
// videos+sales only — earnings are computed live at serve time.
export function buildEvent(type, cfg, now, pool, rnd = Math.random) {
  const person = pool && pool.length ? pool[Math.floor(rnd() * pool.length)] : null;
  const city = pick(cfg.cities) || '';
  const base = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`, type, at: now,
    personId:  person?.id || null,
    name:      person?.name || 'مسوقة',
    username:  person?.username || null,
    avatarUrl: person?.avatarUrl || null,
    color:     person?.avatarColor || '#f43f5e',
  };

  if (type === 'ugc') {
    const videos = randInt(1, cfg.ugcMaxVideos);
    const sales  = videos * randInt(cfg.ugcSalesPerVideoMin, cfg.ugcSalesPerVideoMax);
    return { ...base, icon: '🎥', videos, sales };           // NO city, NO views, NO product
  }
  if (type === 'delivered')  return { ...base, icon: '🚚', city, activity: 'تم تسليم طلب', amount: randInt(cfg.commissionMin, cfg.commissionMax) };
  if (type === 'commission') return { ...base, icon: '💰', activity: 'عمولة جديدة',        amount: randInt(cfg.commissionMin, cfg.commissionMax) };
  if (type === 'newOrder')   return { ...base, icon: '📦', city, activity: 'طلب جديد' };
  if (type === 'newAffiliate') return { ...base, icon: '👤', city, activity: 'انضمت للمنصة' };
  if (type === 'booster') {
    // Booster events come from the SIMULATION engine's real facts (passed in as
    // cfg.boosterFacts) — one source of truth, no second generator. The persona
    // is still a demo identity, so no affiliate is ever identified publicly.
    const fact = pick(cfg.boosterFacts || []);
    if (fact?.kind === 'milestone') {
      return { ...base, icon: '🚀', activity: 'وصلت', detail: `${fact.sales} / ${fact.target}` };
    }
    if (fact?.kind === 'sales') {
      const n = Math.max(1, fact.count);
      return { ...base, icon: '🚀', activity: 'Starter Booster', detail: `+${n} ${n === 1 ? 'مبيعة' : 'مبيعات'}`, boosterSales: n };
    }
    return null; // no simulation activity yet → caller picks another type
  }
  return { ...base, icon: '🏆', activity: 'دخلات المنافسة ديال هاد الشهر' }; // competition
}

// Counter delta for an event (UGC earnings depend on the CURRENT commission).
function counterAmount(ev, commissionPerSale) {
  if (ev.type === 'ugc') return Math.round(ev.sales * commissionPerSale);
  if (ev.type === 'delivered' || ev.type === 'commission') return ev.amount || 0;
  if (ev.type === 'booster') return ev.boosterSales || 0; // sales, not money
  return 0;
}

function freshState(cfg, dayKey, now) {
  return { dayKey, resetToken: cfg.resetToken || '', counters: { ...cfg.stats }, events: [], lastTickAt: now };
}

const COUNTER_KEYS = ['todayOrders', 'todayDelivered', 'todayCommissions', 'affiliatesOnline'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Usable part of a stored state, or null when there is nothing to keep (no row,
 * or no valid counters). Malformed events are dropped one by one; valid
 * counters and events are always preserved.
 */
export function salvageState(stored) {
  if (!isObj(stored) || !isObj(stored.counters)) return null;
  if (!COUNTER_KEYS.every((k) => Number.isFinite(Number(stored.counters[k])))) return null;
  const events = Array.isArray(stored.events)
    ? stored.events.filter((e) => isObj(e) && typeof e.type === 'string' && Number.isFinite(e.at))
    : [];
  return {
    dayKey:     typeof stored.dayKey === 'string' ? stored.dayKey : null,
    resetToken: typeof stored.resetToken === 'string' ? stored.resetToken : '',
    counters:   Object.fromEntries(COUNTER_KEYS.map((k) => [k, Number(stored.counters[k])])),
    events,
    lastTickAt: Number.isFinite(stored.lastTickAt) ? stored.lastTickAt : null,
  };
}

// One generated event at its TRUE timestamp `at` (type allowed at that
// Casablanca time), applied to the counters.
function generateAt(state, cfg, at, commissionPerSale, pool, rnd) {
  const type = pickActivityType(probabilitiesAt(cfg.probabilities, at), rnd);
  const ev = buildEvent(type, cfg, at, pool, rnd) || buildEvent('newOrder', cfg, at, pool, rnd);
  state.counters = applyActivityToStats(state.counters, ev.type, counterAmount(ev, commissionPerSale));
  if (rnd() < 0.15) state.counters.affiliatesOnline = driftOnline(state.counters.affiliatesOnline); // slow fluctuation
  return ev;
}

const BOOTSTRAP_COUNT = 15; // events generated up-front so the feed is NEVER empty

// Seed an initial batch of activities with staggered past timestamps so the very
// first page load already shows a full, natural-looking feed. Never before
// today's Casablanca midnight (the feed is a per-day feed).
function bootstrapFeed(state, cfg, commissionPerSale, now, avgMs, pool, rnd) {
  const dayStart = liveActivityDayStart(now);
  const batch = [];
  for (let i = 0; i < BOOTSTRAP_COUNT; i++) {
    const at = Math.max(dayStart, now - (BOOTSTRAP_COUNT - i) * avgMs); // i=0 oldest … newest ≈ now-avgMs
    batch.push(generateAt(state, cfg, at, commissionPerSale, pool, rnd));
  }
  state.events = batch.reverse().slice(0, MAX_EVENTS); // newest first
}

/**
 * Pure state transition: the stored state advanced to `now`.
 * Returns { state, dirty } — dirty = something must be written.
 */
export function nextState(stored, cfg, { pool, commissionPerSale, now, rnd = Math.random }) {
  const today = liveActivityDayKey(now);
  const avgMs = ((cfg.intervalMinSec + cfg.intervalMaxSec) / 2) * 1000;
  let dirty = false;

  let state = salvageState(stored);
  // Day rollover (Casablanca midnight) and admin reset start a new day, as before.
  if (!state || state.dayKey !== today || state.resetToken !== (cfg.resetToken || '')) {
    state = freshState(cfg, today, now);
  } else if (state.lastTickAt === null) {
    state.lastTickAt = now;
    dirty = true;
  }

  // Bootstrap: the feed must NEVER be empty. On a brand-new/rolled-over/reset
  // state, seed an initial batch so the first page load shows several activities.
  if (!state.events.length) {
    bootstrapFeed(state, cfg, commissionPerSale, now, avgMs, pool, rnd);
    state.lastTickAt = now;
    dirty = true;
  }

  // Advance the shared feed by whole ticks since we last advanced (capped). Each
  // event is stamped with the tick it stands for — the last `add` tick slots up
  // to now — so a catch-up never claims an old tick happened "just now".
  const elapsedTicks = Math.floor((now - state.lastTickAt) / avgMs);
  if (elapsedTicks > 0) {
    const add = Math.min(elapsedTicks, MAX_CATCHUP);
    const batch = [];
    for (let k = 0; k < add; k++) {
      const at = state.lastTickAt + (elapsedTicks - add + k + 1) * avgMs;
      batch.push(generateAt(state, cfg, at, commissionPerSale, pool, rnd));
    }
    // A large idle backlog is skipped (only `add` events), so counters never leap.
    state.events = [...batch.reverse(), ...state.events]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_EVENTS);
    state.lastTickAt += elapsedTicks * avgMs;
    dirty = true;
  }

  return { state, dirty };
}

/**
 * Advance the stored state under a transaction-scoped advisory lock. Only the
 * lock holder generates and writes; anyone else reads the stored state as is.
 * A read error propagates (the transaction rolls back) — nothing is written.
 * @returns {Promise<{ state: object|null, generated: boolean }>}
 */
export async function advanceLiveActivity({ db = prisma, cfg, pool, commissionPerSale, now, rnd = Math.random }) {
  return db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${LIVE_ACTIVITY_LOCK_KEYS[0]}::int, ${LIVE_ACTIVITY_LOCK_KEYS[1]}::int) AS locked`;
    const row = await tx.setting.findUnique({ where: { id: STATE_KEY } });
    if (!lock?.locked) {
      const current = salvageState(row?.data);
      // The lock holder may be rolling the day over: never serve yesterday's feed.
      return { state: current && current.dayKey === liveActivityDayKey(now) ? current : null, generated: false };
    }
    if (row && !salvageState(row.data)) {
      console.warn('live-activity: stored state unusable (no valid counters) — starting a new one');
    }
    const { state, dirty } = nextState(row?.data ?? null, cfg, { pool, commissionPerSale, now, rnd });
    if (dirty) {
      await tx.setting.upsert({
        where:  { id: STATE_KEY },
        update: { data: state },
        create: { id: STATE_KEY, data: state },
      });
    }
    return { state, generated: dirty };
  });
}

const DISABLED = Object.freeze({ enabled: false, counters: null, events: [], config: null });

// When nothing could be loaded: the last good view (marked stale), else hidden.
function fallbackView() {
  return _lastGood ? { ..._lastGood, stale: true } : { enabled: false, degraded: true };
}

async function loadView(deps, now) {
  const d = {
    db: prisma,
    loadConfig: () => getSettings('recruitment-landing'),
    loadCommission: getUgcCommissionPerSale,
    loadPool: () => getDemoIdentityPool(), // shared with the Monthly Competition
    loadBoosterFacts: () => getBoosterLiveFacts(), // the SIMULATION engine — never a second generator
    rnd: Math.random,
    ...deps,
  };

  // A config read failure must not run the engine on defaults: a default
  // resetToken would wipe the stored state. Serve what we have instead.
  let rawConfig;
  try { rawConfig = await d.loadConfig(); } catch (err) {
    console.error('live-activity: config read failed — serving the last good snapshot', err);
    return fallbackView();
  }
  const cfg = normalizeLiveActivity(rawConfig?.liveActivity);
  if (!cfg.enabled) return { enabled: false };

  const commissionPerSale = await d.loadCommission();
  const pool = await d.loadPool();
  cfg.boosterFacts = await d.loadBoosterFacts().catch(() => []);

  let result;
  try {
    result = await advanceLiveActivity({ db: d.db, cfg, pool, commissionPerSale, now, rnd: d.rnd });
  } catch (err) {
    console.error('live-activity: state read/advance failed — nothing written, serving the last good snapshot', err);
    return fallbackView();
  }
  if (!result.state) return fallbackView(); // another worker is creating the first state

  const view = {
    enabled: true,
    state: result.state,
    commissionPerSale,
    pool,
    config: { intervalMinSec: cfg.intervalMinSec, intervalMaxSec: cfg.intervalMaxSec },
  };
  _lastGood = view;
  return view;
}

// Serve a view at `now`: relative time + Casablanca clock from each event's TRUE
// timestamp, live UGC earnings (current commission) and a fresh identity
// resolve by personId, so if a person's avatar/username changes in the shared
// pool, every stored event follows — one identity everywhere.
function serve(view, now) {
  if (!view?.enabled) return { ...DISABLED, ...(view?.degraded ? { degraded: true } : {}) };
  const byId = new Map((view.pool || []).map((p) => [p.id, p]));
  const events = view.state.events.map((e) => {
    const p = e.personId ? byId.get(e.personId) : null;
    const identity = p
      ? { name: p.name, username: p.username, avatarUrl: p.avatarUrl ?? null, color: p.avatarColor }
      : {};
    const timing = { time: eventTimeLabel(e.at, now), clock: casablancaClockLabel(e.at) };
    const out = { ...e, ...identity, ...timing, simulated: true };
    if (e.type === 'ugc') out.earnings = Math.round(e.sales * view.commissionPerSale);
    return out;
  });
  return {
    enabled: true,
    simulated: true,
    disclosure: LIVE_ACTIVITY_DISCLOSURE,
    timezone: LIVE_ACTIVITY_TIMEZONE,
    serverNow: now,
    ...(view.stale ? { stale: true } : {}),
    counters: view.state.counters,
    events,
    config: view.config,
  };
}

/**
 * Return the current live-activity snapshot, advancing the shared server state.
 * Concurrent calls in one process share a single load (single-flight).
 * `deps` (db, now, rnd, loaders) is for tests; production calls it bare.
 * @returns {Promise<{enabled:boolean, counters:object|null, events:Array, config:object|null}>}
 */
export async function getLiveActivitySnapshot(deps = {}) {
  const now = deps.now ?? Date.now();
  if (!(_cache.view && now - _cache.at < CACHE_MS)) {
    if (!_inflight) {
      _inflight = loadView(deps, now)
        .then((view) => { _cache = { at: now, view }; return view; })
        .finally(() => { _inflight = null; });
    }
    await _inflight;
  }
  return serve(_cache.view, now);
}
