/**
 * src/lib/liveActivityTime.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Time rules of the SIMULATED Live Activity feed, all in Africa/Casablanca
 * (Morocco is UTC+1, UTC+0 during Ramadan — resolved by the runtime's tz data,
 * never a fixed offset). Pure: no DB, no clock reads (callers pass `now`).
 *
 *   • business day   — Casablanca-local midnight to midnight (counters reset)
 *   • delivery hours — delivery-related demo events only at 08:00 ≤ local < 20:00
 *   • labels         — relative age from the event's TRUE timestamp + the
 *                      Casablanca wall-clock time ("HH:MM")
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { businessDateKey } from './ugcTime.js';
import { relTime } from './recruitmentCta.js';

export const LIVE_ACTIVITY_TIMEZONE = 'Africa/Casablanca';

/** Shown on every Live Activity card and returned by the API (simulated feed). */
export const LIVE_ACTIVITY_DISCLOSURE =
  'أنشطة تجريبية (محاكاة) للعرض فقط — ماشي طلبات ولا أرباح حقيقية ديال زبناء أو مسوقات.';

export const DELIVERY_START_HOUR = 8;  // inclusive (08:00)
export const DELIVERY_END_HOUR   = 20; // exclusive (19:59 yes, 20:00 no)

/**
 * Event types that stand for a delivery: "تم تسليم طلب" and "عمولة جديدة"
 * (an order commission is credited only when the order is delivered).
 */
export const DELIVERY_RELATED_TYPES = Object.freeze(['delivered', 'commission']);

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LIVE_ACTIVITY_TIMEZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});

/** Casablanca-local { hour, minute } of an instant (ms). */
export function casablancaClock(atMs) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(atMs))) p[type] = value;
  return { hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** "HH:MM" in Casablanca. */
export function casablancaClockLabel(atMs) {
  const { hour, minute } = casablancaClock(atMs);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** True when a delivery-related demo event may carry this timestamp. */
export function isDeliveryHour(atMs) {
  const { hour } = casablancaClock(atMs);
  return hour >= DELIVERY_START_HOUR && hour < DELIVERY_END_HOUR;
}

/** Probabilities allowed at `atMs`: delivery-related types zeroed outside hours. */
export function probabilitiesAt(probabilities, atMs) {
  if (isDeliveryHour(atMs)) return probabilities;
  const out = { ...probabilities };
  for (const t of DELIVERY_RELATED_TYPES) out[t] = 0;
  return out;
}

/** "YYYY-MM-DD" Casablanca business day of an instant (ms). */
export function liveActivityDayKey(atMs) {
  return businessDateKey(new Date(atMs), LIVE_ACTIVITY_TIMEZONE);
}

/**
 * UTC ms of Casablanca-local midnight for the day containing `atMs`: the first
 * instant whose local date is that day (binary search on the date, exact on
 * clock-change days — Morocco switches at 02:00/03:00, so an offset sampled at
 * noon would be an hour off; ugcTime.startOfBusinessDay is not used here).
 */
export function liveActivityDayStart(atMs) {
  const day = liveActivityDayKey(atMs);
  let lo = atMs - 27 * 3600000; // surely the previous local day
  let hi = atMs;                // already `day`
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (liveActivityDayKey(mid) === day) hi = mid; else lo = mid;
  }
  return hi;
}

/** Relative label of an event, from its true timestamp (future → "1 s"). */
export function eventTimeLabel(atMs, nowMs) {
  return relTime(Math.max(0, nowMs - atMs));
}
