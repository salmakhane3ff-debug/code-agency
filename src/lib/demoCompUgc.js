/**
 * src/lib/demoCompUgc.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition — UGC Videos: the PURE rules of the simulated video leaderboard.
 * No database, no React, no I/O, no Math.random. It reuses the calendar, PRNG and
 * schedule of the Top Members / Top Brands engine (./demoCompetition/engine.js) with
 * its own stream name ("UGC"), so the same inputs always give the same plans/events.
 *
 * SIMULATION ONLY. A demo UGC video is owned by a demo member (demo_comp_members) and
 * competes on its own: per video, per Africa/Casablanca day, ONE plan whose target number
 * of simulated sales is drawn in [minDailySales, maxDailySales] of the settings version
 * in force at the day start, split into events of 1..3 sales spread over the day. Each
 * event snapshots the reward per sale (5, 6 or 7 MAD) of the version in force at its
 * scheduled time: rewardCents = quantity × rewardPerSaleMad × 100. Nothing here is a
 * real UGC submission, order, commission, wallet, payout or reward.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  WINDOWS, DAY_MS, HOUR_MS, BACKFILL_DAYS, dayBounds, dayKeyOf, dayKeysBetween, addDays, backfillStart,
  versionAt, planTarget, daySchedule, normalizeName,
} from './demoCompetition/engine.js';

export { WINDOWS, DAY_MS, HOUR_MS, BACKFILL_DAYS, dayBounds, dayKeyOf, dayKeysBetween, addDays, backfillStart, versionAt };

/** Stream name of the UGC engine (seeds + idempotency keys; distinct from PERSONAL / NETWORK / BRAND). */
export const UGC_STREAM = 'UGC';
/** Ranking window: rolling 30 days (720 h), exactly like the member / brand leaderboards. */
export const UGC_RANKING_WINDOW_MS = WINDOWS.d30;

/** The only reward choices (whole MAD per simulated sale). Mirrored by CHECK ... IN (5, 6, 7). */
export const REWARD_CHOICES = Object.freeze([5, 6, 7]);

/** Validation limits (mirrored by the CHECK constraints of migration 20261116_demo_comp_ugc_videos). */
export const UGC_LIMITS = Object.freeze({
  titleMax: 120,
  salesMax: 1000,          // simulated sales per video per day (same cap as the demo orders)
  maxVideos: 100,          // non-archived videos
  targetMin: 1,
  targetMax: 100,
  sortOrderMax: 1_000_000,
  urlMax: 2048,
});

export const UGC_DEFAULTS = Object.freeze({
  minDailySales: 3,
  maxDailySales: 15,
  rewardPerSaleMad: 5,
  targetVideoCount: 20,
});

// ── Media namespace (dedicated; never the real UGC folder) ────────────────────

/**
 * Where demo UGC media is stored through saveMedia: R2 key category, Cloudinary folder and local
 * sub-folder are all the single segment "demo-competition-ugc" (the real UGC videos use
 * folder/subdir "ugc" and R2 category "videos"). Every stored URL therefore contains
 * "/demo-competition-ugc/<file>", which is what isDemoUgcMediaUrl() accepts.
 */
export const UGC_MEDIA_NAMESPACE = 'demo-competition-ugc';
export const UGC_MEDIA = Object.freeze({
  video: Object.freeze({ maxBytes: 50 * 1024 * 1024, exts: Object.freeze(['.mp4', '.webm', '.mov']), resourceType: 'video' }),
  thumbnail: Object.freeze({ maxBytes: 5 * 1024 * 1024, exts: Object.freeze(['.jpg', '.jpeg', '.png', '.webp']), resourceType: 'image' }),
});
const MEDIA_URL_EXTS = { video: /\.(mp4|webm|mov)$/i, thumbnail: /\.(webp|jpe?g|png)$/i };
const FILE_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * True when `url` points into the dedicated demo UGC namespace (local "/uploads/demo-competition-ugc/<file>"
 * or an https URL whose last folder is "demo-competition-ugc"), with the extension of its kind.
 */
export function isDemoUgcMediaUrl(url, kind) {
  if (typeof url !== 'string' || !url || url.length > UGC_LIMITS.urlMax || /\s|\\|\.\.|%2e%2e/i.test(url)) return false;
  let segments;
  if (url.startsWith('/')) {
    if (!url.startsWith(`/uploads/${UGC_MEDIA_NAMESPACE}/`)) return false;
    segments = url.split('/').filter(Boolean);
  } else {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return false;
    segments = u.pathname.split('/').filter(Boolean);
  }
  if (segments.length < 2) return false;
  const file = segments[segments.length - 1];
  if (segments[segments.length - 2] !== UGC_MEDIA_NAMESPACE || !FILE_SEGMENT.test(file)) return false;
  return kind ? MEDIA_URL_EXTS[kind]?.test(file) === true : true;
}

/** Lower-case extension (".mp4") of a file name, '' when none. */
export function extOf(name) {
  const s = typeof name === 'string' ? name : '';
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

/**
 * Pre-check of an upload BEFORE the shared validators (uploadSecurity validateVideo / validateImage):
 * kind, extension allow-list and the demo size cap. { ok } or { ok:false, code, status }.
 */
export function checkUgcUpload(kind, { name, size }) {
  const spec = UGC_MEDIA[kind];
  if (!spec) return { ok: false, code: 'INVALID_INPUT', status: 400 };
  if (!spec.exts.includes(extOf(name))) return { ok: false, code: 'INVALID_FILE_TYPE', status: 415 };
  if (!(size > 0)) return { ok: false, code: 'EMPTY_FILE', status: 400 };
  if (size > spec.maxBytes) return { ok: false, code: 'FILE_TOO_LARGE', status: 413 };
  return { ok: true };
}

/** Map a { ok:false, status } result of uploadSecurity.validateVideo / validateImage to a stable code. */
export function uploadErrorCode(result) {
  if (result?.status === 413) return 'FILE_TOO_LARGE';
  if (result?.status === 400) return 'EMPTY_FILE';
  return 'INVALID_FILE_TYPE';
}

// ── Validation ────────────────────────────────────────────────────────────────

const isInt = (v) => Number.isInteger(v);
const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;

export const isValidReward = (v) => REWARD_CHOICES.includes(v);

export function normalizeTitle(title) {
  return normalizeName(title);
}

/**
 * Validate a complete video settings object. Returns { ok, errors: { field: CODE } }.
 * The owner's existence / archive state is checked by the service (database).
 */
export function validateVideoSettings(s) {
  const errors = {};
  const title = normalizeTitle(s?.title);
  if (!title || title.length > UGC_LIMITS.titleMax || /[<>]/.test(title)) errors.title = 'INVALID_TITLE';
  if (typeof s?.memberId !== 'string' || !s.memberId) errors.memberId = 'MEMBER_REQUIRED';
  if (!inRange(s?.minDailySales, 0, UGC_LIMITS.salesMax)) errors.minDailySales = 'INVALID_MIN_SALES';
  if (!inRange(s?.maxDailySales, 0, UGC_LIMITS.salesMax)) errors.maxDailySales = 'INVALID_MAX_SALES';
  else if (inRange(s?.minDailySales, 0, UGC_LIMITS.salesMax) && s.maxDailySales < s.minDailySales) errors.maxDailySales = 'MAX_BELOW_MIN';
  if (!isValidReward(s?.rewardPerSaleMad)) errors.rewardPerSaleMad = 'INVALID_REWARD';
  if (typeof s?.active !== 'boolean') errors.active = 'INVALID_ACTIVE';
  if (!inRange(s?.sortOrder, 0, UGC_LIMITS.sortOrderMax)) errors.sortOrder = 'INVALID_SORT_ORDER';
  if (s?.videoUrl != null && !isDemoUgcMediaUrl(s.videoUrl, 'video')) errors.videoUrl = 'INVALID_MEDIA_URL';
  if (s?.thumbnailUrl != null && !isDemoUgcMediaUrl(s.thumbnailUrl, 'thumbnail')) errors.thumbnailUrl = 'INVALID_MEDIA_URL';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Validate the module settings ({ enabled, targetVideoCount }). */
export function validateModuleSettings(s) {
  const errors = {};
  if (typeof s?.enabled !== 'boolean') errors.enabled = 'INVALID_ENABLED';
  if (!inRange(s?.targetVideoCount, UGC_LIMITS.targetMin, UGC_LIMITS.targetMax)) errors.targetVideoCount = 'INVALID_TARGET_COUNT';
  return { ok: Object.keys(errors).length === 0, errors };
}

// ── Reward ────────────────────────────────────────────────────────────────────

/** Simulated reward (centimes) of `quantity` sales at `rewardPerSaleMad` (5, 6 or 7 MAD). Throws on another rate. */
export function ugcRewardCents(quantity, rewardPerSaleMad) {
  if (!isValidReward(rewardPerSaleMad)) throw Object.assign(new Error('INVALID_REWARD'), { code: 'INVALID_REWARD' });
  if (!isInt(quantity) || quantity < 0) throw Object.assign(new Error('INVALID_QUANTITY'), { code: 'INVALID_QUANTITY' });
  return quantity * rewardPerSaleMad * 100;
}

// ── Plans + events ────────────────────────────────────────────────────────────

/** Idempotency key of one event (UNIQUE in demo_comp_ugc_events). */
export const ugcEventKey = (videoId, dayKey, seq) => `${UGC_STREAM}:${videoId}:${dayKey}:${seq}`;

/**
 * The plan of one video / Casablanca day from its versions (ascending effectiveFrom); null before the
 * video's history begins. The target is drawn in [min, max] of the version in force at the day start.
 */
export function buildUgcPlan(videoId, dayKey, versions) {
  const { start, end } = dayBounds(dayKey);
  const v = versionAt(versions, start);
  if (!v) return null;
  const min = v.minDailySales, max = v.maxDailySales;
  return {
    videoId, dayKey, dayStart: start, dayEnd: end, minSales: min, maxSales: max, versionId: v.id,
    targetSales: planTarget(UGC_STREAM, videoId, dayKey, min, max),
  };
}

/** The day's schedule of a plan: [{ seq, quantity (1..3), at }], deterministic, ascending. */
export const ugcDaySchedule = (plan) => daySchedule(UGC_STREAM, plan.videoId, plan.dayKey, plan.targetSales, plan.dayStart, plan.dayEnd);

/**
 * The events of one plan due in (fromMs, toMs]: each with the reward of the version in force at its time.
 * Events falling while the video is inactive (per its versions) are skipped — deterministically.
 */
export function dueUgcEvents(plan, versions, fromMs, toMs) {
  const out = [];
  for (const s of ugcDaySchedule(plan)) {
    if (s.at <= fromMs || s.at > toMs) continue;
    const v = versionAt(versions, s.at);
    if (!v || !v.active) continue;
    out.push({
      seq: s.seq,
      quantity: s.quantity,
      rewardPerSaleMad: v.rewardPerSaleMad,
      rewardCents: ugcRewardCents(s.quantity, v.rewardPerSaleMad),
      versionId: v.id,
      scheduledAt: s.at,
      idempotencyKey: ugcEventKey(plan.videoId, plan.dayKey, s.seq),
    });
  }
  return out;
}

/**
 * Everything one video generates in (fromMs, toMs] (pure; used by the tests and mirrored by the service):
 * { plans, events } for the Casablanca days touching the interval, never before the first version.
 */
export function generateUgcRange(videoId, versions, fromMs, toMs) {
  if (!versions?.length || !(toMs > fromMs)) return { plans: [], events: [] };
  const historyStart = +new Date(versions[0].effectiveFrom);
  const keys = dayKeysBetween(dayKeyOf(Math.max(fromMs + 1, historyStart)), dayKeyOf(toMs));
  const plans = keys.map((k) => buildUgcPlan(videoId, k, versions)).filter(Boolean);
  const events = plans.flatMap((p) => dueUgcEvents(p, versions, fromMs, toMs).map((e) => ({ ...e, dayKey: p.dayKey })));
  return { plans, events };
}

// ── Windows + ranking ─────────────────────────────────────────────────────────

/** Rolling window membership: scheduledAt ∈ (now − window, now] (same convention as the member / brand stats). */
export const inWindow = (atMs, nowMs, windowMs = UGC_RANKING_WINDOW_MS) => atMs > nowMs - windowMs && atMs <= nowMs;

/** Sum the events of each video inside the rolling window → Map(videoId → { sales, rewardCents, last }). */
export function windowTotals(events, nowMs, windowMs = UGC_RANKING_WINDOW_MS) {
  const out = new Map();
  for (const e of events) {
    const at = +new Date(e.scheduledAt);
    if (!inWindow(at, nowMs, windowMs)) continue;
    const t = out.get(e.videoId) ?? { sales: 0, rewardCents: 0, last: null };
    t.sales += e.quantity;
    t.rewardCents += e.rewardCents;
    if (t.last === null || at > t.last) t.last = at;
    out.set(e.videoId, t);
  }
  return out;
}

/**
 * Rank videos by rolling 30-day simulated reward (desc) — the same rule as the member / brand rankings
 * (rankProfiles). Deterministic tie-break: 30-day sales (desc), sortOrder (asc), creation time (oldest
 * first), then id. rows: [{ id, createdAt, sortOrder, reward30dCents, sales30d }] → same rows + rank (1..n).
 */
export function rankVideos(rows) {
  return [...rows]
    .sort((a, b) => (b.reward30dCents - a.reward30dCents)
      || (b.sales30d - a.sales30d)
      || ((a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      || (+new Date(a.createdAt) - +new Date(b.createdAt))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Public eligibility: an active, non-archived video with a video file whose owner is not archived. */
export const isListable = (video) => !!video && video.active === true && !video.archivedAt && !!video.videoUrl && !video.member?.archivedAt;

// ── Deterministic placeholders ("generate N videos") ─────────────────────────

export const PLACEHOLDER_TITLES = Object.freeze([
  'Routine soin visage', 'Unboxing coffret argan', 'Avant / après sérum', 'Test crème mains', 'Mon avis sur le parfum',
  'Look du jour', 'Astuce cuisine express', 'Démaquillage en 1 minute', 'Coiffure facile', 'Accessoires téléphone',
  'Gourde isotherme au quotidien', 'Rangement maison', 'Soin cheveux bouclés', 'Montre connectée', 'Sac de voyage',
  'Lampe LED chambre', 'Tapis de yoga', 'Écouteurs sans fil', 'Huile de nigelle', 'Kit barbe',
]);

/** The i-th (0-based) placeholder video: deterministic title, range and reward. */
export function placeholderVideo(i) {
  const n = PLACEHOLDER_TITLES.length;
  const base = PLACEHOLDER_TITLES[i % n];
  const lo = 1 + ((i * 7 + 3) % 8);                 // 1..8
  return {
    title: i < n ? base : `${base} ${Math.floor(i / n) + 1}`,
    minDailySales: lo,
    maxDailySales: lo + 4 + ((i * 11 + 5) % 17),     // +4..+20
    rewardPerSaleMad: REWARD_CHOICES[i % REWARD_CHOICES.length],
  };
}
