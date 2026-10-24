/**
 * src/lib/demoChatEarnings.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure DEMO chat earnings resolver (Phase 3C-4). Reads nothing itself: the
 * caller passes the profile's demo_earnings_history rows, the
 * demo_sim_day_coverage rows and the admin markers. Never touches real orders,
 * commissions, balances or payouts, and never invents an amount.
 *
 * Buckets. A history row's day is its UTC calendar date: rows are written at
 * server-local midnight and every stored row is 00:00:00.000 UTC (Phase 3C-0
 * diagnostic). A Casablanca calendar date D is mapped to the bucket labelled D
 * (the bucket runs 00:00–24:00 UTC, i.e. 01:00–01:00 Casablanca at UTC+1).
 * Rows not at exact UTC midnight, or two rows for one day, make that day
 * UNAVAILABLE (fail-closed) instead of guessing.
 *
 * Day status
 *   complete    · row present and admin-curated (edited / backfilled), or
 *               · row present and the profile was OBSERVED for the whole bucket:
 *                 the simulation demonstrably covered it (coverage row: first
 *                 tick ≤ start + 5 min, last tick ≥ end − 5 min, largest gap
 *                 ≤ 5 min), the profile took part in EVERY tick of that day
 *                 (settings `demo-sim-participants:<day>`, Phase 3C-5) and it
 *                 existed before the day started, or
 *               · NO row, with that same proof → zero.
 *   incomplete  · row present but coverage not proven (value may be partial).
 *   unavailable · no row and no proof, bucket not finished yet, profile created
 *                 mid-day, ambiguous rows…
 * Periods (relative to the MESSAGE's Casablanca date D, not "now"):
 *   yesterday → bucket D−1 (must be finished at `now`).
 *   week      → buckets D−7 … D−1 (the 7 days before D); ALL must be
 *               complete, else unavailable.
 *   today     → bucket D, only when D is today and it is ≥ 12:00 Casablanca;
 *               always PROVISIONAL. For a past D the value at send time is not
 *               recorded (no snapshot before persistence) → unavailable.
 * Rendering: only complete / provisional values are rendered; incomplete and
 * unavailable become a "data unavailable" notice — never a zero.
 * Earnings = commission (5 % of the profile's own demo revenue, as in the
 * demo history); revenue and orders stay separately labelled.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { CHAT_TIMEZONE, addDays, localParts, utcDayStart } from './demoChatTime.js';
import { PLACEHOLDERS, TODAY_SUMMARY_FROM } from './demoChatValidation.js';

export const COVERAGE_EDGE_SLACK_SEC = 300;
export const COVERAGE_MAX_GAP_SEC = 300;
const DAY_MS = 86_400_000; // UTC buckets have no DST: exactly 24 h

export const STATUS = Object.freeze({ COMPLETE: 'complete', PROVISIONAL: 'provisional', INCOMPLETE: 'incomplete', UNAVAILABLE: 'unavailable' });

const isMidnightUtc = (d) => d instanceof Date && !Number.isNaN(d.getTime()) && d.getTime() % DAY_MS === 0;
const utcKey = (d) => d.toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;
const unavailable = (reason, extra = {}) => ({ status: STATUS.UNAVAILABLE, reason, ...extra });

/** Coverage proves continuous simulation over [fromMs, toMs]. */
export function coverageProves(cov, fromMs, toMs) {
  if (!cov || !(cov.tickCount > 0)) return false;
  const first = new Date(cov.firstTickAt).getTime(); const last = new Date(cov.lastTickAt).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  return first <= fromMs + COVERAGE_EDGE_SLACK_SEC * 1000 && last >= toMs - COVERAGE_EDGE_SLACK_SEC * 1000 && cov.maxGapSec <= COVERAGE_MAX_GAP_SEC;
}

/**
 * Index the raw inputs once. history: [{ id, date, orders, revenue, commission }],
 * coverage: [{ day, firstTickAt, lastTickAt, tickCount, maxGapSec }],
 * markers: { historyEdits: { [rowId]: … }, backfilledDays: { [YYYY-MM-DD]: true } }.
 */
export function buildEarningsContext({ history = [], coverage = [], participants = {}, profileId = null, markers = {}, profileCreatedAt = null, nowMs, tz = CHAT_TIMEZONE }) {
  const byDay = new Map(); const ambiguous = new Set();
  for (const r of history) {
    const d = new Date(r.date);
    if (Number.isNaN(d.getTime())) continue;
    if (!isMidnightUtc(d)) { ambiguous.add(utcKey(d)); ambiguous.add(utcKey(new Date(d.getTime() + DAY_MS))); continue; }
    const k = utcKey(d);
    byDay.set(k, [...(byDay.get(k) || []), r]);
  }
  const cov = new Map(coverage.map((c) => [utcKey(new Date(c.day)), c]));
  // participants: { 'YYYY-MM-DD': [profileId…] } — profiles present in every tick that day.
  const tookPart = new Set(Object.entries(participants || {})
    .filter(([, ids]) => profileId && Array.isArray(ids) && ids.includes(profileId)).map(([day]) => day));
  return {
    byDay, ambiguous, cov, nowMs, tz, tookPart,
    edits: markers.historyEdits && typeof markers.historyEdits === 'object' ? markers.historyEdits : {},
    backfilled: markers.backfilledDays && typeof markers.backfilledDays === 'object' ? markers.backfilledDays : {},
    createdAtMs: profileCreatedAt ? new Date(profileCreatedAt).getTime() : null,
  };
}

/** Status + values of one finished UTC bucket. */
export function classifyDay(ctx, key) {
  const start = utcDayStart(key); const end = start + DAY_MS;
  if (end > ctx.nowMs) return unavailable('period_not_finished', { day: key });
  if (ctx.ambiguous.has(key)) return unavailable('ambiguous_history_rows', { day: key });
  const rows = ctx.byDay.get(key) || [];
  if (rows.length > 1) return unavailable('duplicate_history_rows', { day: key });
  const existed = ctx.createdAtMs === null || ctx.createdAtMs <= start;
  const observed = existed && ctx.tookPart.has(key);
  const proven = observed && coverageProves(ctx.cov.get(key), start, end);
  if (rows.length === 1) {
    const r = rows[0];
    const values = { orders: Number(r.orders) || 0, revenue: Number(r.revenue) || 0, commission: Number(r.commission) || 0 };
    if (ctx.edits[r.id]) return { status: STATUS.COMPLETE, reason: 'admin_edited', day: key, ...values };
    if (ctx.backfilled[key]) return { status: STATUS.COMPLETE, reason: 'admin_backfilled', day: key, ...values };
    if (proven) return { status: STATUS.COMPLETE, reason: 'observed', day: key, ...values };
    return { status: STATUS.INCOMPLETE, reason: 'coverage_not_proven', day: key, ...values };
  }
  if (proven) return { status: STATUS.COMPLETE, reason: 'observed_zero', day: key, orders: 0, revenue: 0, commission: 0 };
  if (!existed) return unavailable('profile_created_after_day_start', { day: key });
  if (!coverageProves(ctx.cov.get(key), start, end)) return unavailable('no_row_coverage_not_proven', { day: key });
  return unavailable('profile_participation_not_proven', { day: key });
}

/** Today's provisional figures (bucket D, from its start until now). */
function classifyToday(ctx, key) {
  const lp = localParts(ctx.nowMs, ctx.tz);
  if (lp.date !== key) return unavailable('historical_snapshot_required', { day: key });
  if (lp.time < TODAY_SUMMARY_FROM) return unavailable('before_noon', { day: key });
  if (utcKey(new Date(ctx.nowMs)) !== key) return unavailable('bucket_mismatch', { day: key });
  if (ctx.ambiguous.has(key)) return unavailable('ambiguous_history_rows', { day: key });
  const rows = ctx.byDay.get(key) || [];
  if (rows.length > 1) return unavailable('duplicate_history_rows', { day: key });
  const start = utcDayStart(key);
  if (rows.length === 1) {
    const r = rows[0];
    return { status: STATUS.PROVISIONAL, reason: 'today_so_far', day: key, orders: Number(r.orders) || 0, revenue: Number(r.revenue) || 0, commission: Number(r.commission) || 0 };
  }
  const observed = (ctx.createdAtMs === null || ctx.createdAtMs <= start) && ctx.tookPart.has(key);
  if (observed && coverageProves(ctx.cov.get(key), start, ctx.nowMs)) return { status: STATUS.PROVISIONAL, reason: 'today_so_far_zero', day: key, orders: 0, revenue: 0, commission: 0 };
  return unavailable('no_row_coverage_not_proven', { day: key });
}

/** Resolve one earnings period for a message dated `messageDate` (Casablanca). */
export function resolvePeriod(ctx, period, messageDate) {
  if (period === 'today') return { period, ...classifyToday(ctx, messageDate) };
  if (period === 'yesterday') return { period, ...classifyDay(ctx, addDays(messageDate, -1)) };
  if (period === 'week') {
    const days = Array.from({ length: 7 }, (_, i) => addDays(messageDate, i - 7));
    const parts = days.map((k) => classifyDay(ctx, k));
    const bad = parts.filter((p) => p.status !== STATUS.COMPLETE);
    if (bad.length) return { period, ...unavailable('week_incomplete', { from: days[0], to: days[6], missingDays: bad.map((b) => ({ day: b.day, status: b.status, reason: b.reason })) }) };
    const sum = (f) => parts.reduce((s, p) => s + p[f], 0);
    return { period, status: STATUS.COMPLETE, reason: 'week_complete', from: days[0], to: days[6], orders: sum('orders'), revenue: round2(sum('revenue')), commission: round2(sum('commission')) };
  }
  return { period, ...unavailable('unknown_period') };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export const LABELS = Object.freeze({
  ar: { currency: 'درهم', today: 'اليوم', yesterday: 'البارح', week: 'آخر 7 أيام', provisional: 'مؤقت', unavailable: 'المعطيات ديال هاد الفترة ماشي متوفرة دابا.' },
  fr: { currency: 'MAD', today: "aujourd'hui", yesterday: 'hier', week: 'les 7 derniers jours', provisional: 'provisoire', unavailable: 'Données indisponibles pour cette période.' },
});
export const METRIC_LABELS = Object.freeze({
  ar: { commission: 'العمولة', revenue: 'رقم المعاملات', orders: 'الطلبات' },
  fr: { commission: 'commission', revenue: "chiffre d'affaires", orders: 'commandes' },
});

const money = (n, locale) => `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${LABELS[locale].currency}`;

/**
 * Render an earnings message. Only {amount} {orders} {period} are replaced;
 * {amount} = revenue when metric is "revenue", else commission (earnings).
 * → { state: 'ok' | 'provisional' | 'unavailable' | 'invalid', text, reason? }
 */
export function renderEarningsText({ text, metric, resolution, locale = 'ar' }) {
  const L = LABELS[locale] ? locale : 'ar';
  const tokens = String(text || '').match(/\{[^{}]*\}/g) || [];
  if (tokens.some((t) => !PLACEHOLDERS.includes(t)) || /[{}]/.test(String(text || '').replace(/\{[^{}]*\}/g, ''))) {
    return { state: 'invalid', text: LABELS[L].unavailable, reason: 'invalid_placeholder' };
  }
  if (!resolution || ![STATUS.COMPLETE, STATUS.PROVISIONAL].includes(resolution.status)) {
    return { state: 'unavailable', text: LABELS[L].unavailable, reason: resolution?.reason || 'unresolved' };
  }
  const provisional = resolution.status === STATUS.PROVISIONAL;
  const amount = metric === 'revenue' ? resolution.revenue : resolution.commission;
  const out = String(text)
    .replaceAll('{amount}', money(amount, L))
    .replaceAll('{orders}', new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(resolution.orders))
    .replaceAll('{period}', LABELS[L][resolution.period]);
  return {
    state: provisional ? 'provisional' : 'ok',
    text: provisional ? `${out} (${LABELS[L].provisional})` : out,
    metricLabel: METRIC_LABELS[L][metric],
  };
}
