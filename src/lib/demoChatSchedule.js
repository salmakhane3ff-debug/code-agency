/**
 * src/lib/demoChatSchedule.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, deterministic DEMO chat scheduling (Phase 3C-4). No DB, no clock
 * reads — `now` is always passed in.
 *
 *   • A journey runs in 30-day cycles from the assignment's anchor date (the
 *     Casablanca calendar date of day 1). Cycle n (loopIndex n ≥ 0) covers the
 *     calendar days anchor + 30n … anchor + 30n + 29.
 *   • Step (day, "HH:MM") of cycle n is scheduled at that Casablanca wall time
 *     on calendar date anchor + 30n + (day − 1) → an absolute instant
 *     (gap/overlap handled by demoChatTime.zonedTimeToUtc).
 *   • Visible now = the CURRENT cycle's messages whose instant is ≤ now. A late
 *     joiner therefore sees day 1 … the current moment, each with its original
 *     timestamp. Future messages are never returned.
 *   • Earlier cycles are not returned (hidden after rollover); nothing here
 *     deletes anything — retention stays with the existing cleanup.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { CHAT_TIMEZONE, isDateKey, addDays, daysBetween, localParts, zonedTimeToUtc } from './demoChatTime.js';

export const CYCLE_DAYS = 30;

/**
 * Where `now` falls relative to an anchor date.
 * → { started: false, startsOn } before day 1, else
 *   { started: true, loopIndex, day, cycleStart, cycleEnd, today, previousCycles }
 */
export function cyclePosition(anchorDate, nowMs, tz = CHAT_TIMEZONE) {
  if (!isDateKey(anchorDate)) throw new Error('invalid anchor date');
  const today = localParts(nowMs, tz).date;
  const elapsed = daysBetween(anchorDate, today);
  if (elapsed < 0) return { started: false, startsOn: anchorDate, today };
  const loopIndex = Math.floor(elapsed / CYCLE_DAYS);
  const cycleStart = addDays(anchorDate, loopIndex * CYCLE_DAYS);
  return {
    started: true, loopIndex, day: (elapsed % CYCLE_DAYS) + 1,
    cycleStart, cycleEnd: addDays(cycleStart, CYCLE_DAYS - 1), today, previousCycles: loopIndex,
  };
}

/** Calendar date of journey `day` in cycle `loopIndex`. */
export function messageDate(anchorDate, loopIndex, day) {
  if (!Number.isInteger(day) || day < 1 || day > CYCLE_DAYS) throw new Error('invalid day');
  if (!Number.isInteger(loopIndex) || loopIndex < 0) throw new Error('invalid loop');
  return addDays(anchorDate, loopIndex * CYCLE_DAYS + (day - 1));
}

/** Scheduled instant of one step in one cycle. */
export function scheduleStep(step, anchorDate, loopIndex, tz = CHAT_TIMEZONE) {
  const date = messageDate(anchorDate, loopIndex, step.day);
  const { ms, adjustment } = zonedTimeToUtc(date, step.time, tz);
  return { date, scheduledAtMs: ms, timeAdjustment: adjustment };
}

/**
 * Messages visible at `now` for an assignment anchored on `anchorDate`.
 * steps: [{ id, day, time, position, … }] (draft rows or version snapshot).
 * Returns { position, messages: [{ ...step, stepId, loopIndex, date, scheduledAtMs, timeAdjustment }] }
 * ordered by instant, then day, time, position, id — deterministic.
 */
export function visibleMessages({ steps, anchorDate, nowMs, tz = CHAT_TIMEZONE }) {
  const position = cyclePosition(anchorDate, nowMs, tz);
  if (!position.started) return { position, messages: [] };
  const messages = [];
  for (const s of steps || []) {
    if (s.day > position.day) continue; // later days of this cycle are in the future
    const sched = scheduleStep(s, anchorDate, position.loopIndex, tz);
    if (sched.scheduledAtMs > nowMs) continue; // later today: not yet
    messages.push({ ...s, stepId: s.id, loopIndex: position.loopIndex, ...sched });
  }
  messages.sort((a, b) => a.scheduledAtMs - b.scheduledAtMs || a.day - b.day
    || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) || (a.position ?? 0) - (b.position ?? 0)
    || (a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0));
  return { position, messages };
}
