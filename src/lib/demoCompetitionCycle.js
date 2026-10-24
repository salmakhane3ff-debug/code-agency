/**
 * src/lib/demoCompetitionCycle.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure rules of the DEMO competition (presentation-only, never real money):
 *
 *   • cycle      — 30 Casablanca calendar days: starts at local midnight, ends
 *                  (exclusive) at local midnight 30 days later. Africa/Casablanca
 *                  via the runtime's tz data (UTC+1, UTC+0 during Ramadan), so a
 *                  cycle spanning a clock change is 720 h ± 1 h — never a fixed
 *                  ms offset, never the server's local time.
 *   • rollover   — the next cycle starts exactly where the previous one ended
 *                  (no drift); a long idle period skips whole 30-day steps.
 *   • standings  — ONE ranking rule for the leaderboard, the profile and the
 *                  archived results: totalOrders ↓, totalRevenue ↓, id ↑.
 * No DB, no clock reads (callers pass `now`).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { businessDateKey } from './ugcTime.js';

export const COMPETITION_TIMEZONE = 'Africa/Casablanca';
export const CYCLE_DAYS = 30;
export const CYCLE_ARCHIVE_PREFIX = 'demo-competition-cycle:';

const dayKey = (ms) => businessDateKey(new Date(ms), COMPETITION_TIMEZONE);

/** UTC ms of the first instant of the Casablanca date containing `ms`. */
export function competitionDayStart(ms) {
  const day = dayKey(ms);
  let lo = ms - 27 * 3600000; // surely the previous local day
  let hi = ms;                // already `day`
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid) === day) hi = mid; else lo = mid;
  }
  return hi;
}

/** Local midnight `days` Casablanca calendar days after the day of `startMs`. */
export function addCompetitionDays(startMs, days) {
  const [y, m, d] = dayKey(startMs).split('-').map(Number);
  return competitionDayStart(Date.UTC(y, m - 1, d + days, 12)); // noon of the target date
}

/** The 30-day window starting on the Casablanca day of `startMs`. */
export function cycleWindow(startMs) {
  const start = competitionDayStart(startMs);
  return { start, end: addCompetitionDays(start, CYCLE_DAYS) };
}

/** True once `nowMs` reached the (exclusive) end of the cycle. */
export function isCycleDue(endMs, nowMs) {
  return Number.isFinite(endMs) && nowMs >= endMs;
}

/**
 * Window of the cycle following one that ended at `endMs`, as seen at `nowMs`:
 * starts exactly at `endMs`, skipping whole 30-day steps while still in the past.
 */
export function nextCycleWindow(endMs, nowMs) {
  let start = endMs;
  let end = addCompetitionDays(start, CYCLE_DAYS);
  let skipped = 0;
  while (nowMs >= end) { start = end; end = addCompetitionDays(start, CYCLE_DAYS); skipped++; }
  return { start, end, skipped };
}

/** Whole days left (rounded up, never negative). */
export function cycleDaysLeft(endMs, nowMs) {
  return Math.max(0, Math.ceil((endMs - nowMs) / 86_400_000));
}

/** The single ranking rule (totalOrders ↓, totalRevenue ↓, id ↑). */
export function compareStanding(a, b) {
  return (Number(b.totalOrders) || 0) - (Number(a.totalOrders) || 0)
    || (Number(b.totalRevenue) || 0) - (Number(a.totalRevenue) || 0)
    || String(a.id).localeCompare(String(b.id));
}

/** Rows ({ id, totalOrders, totalRevenue, … }) sorted and ranked 1..n. */
export function rankStandings(rows) {
  return [...rows].sort(compareStanding).map((r, i) => ({ ...r, rank: i + 1 }));
}
