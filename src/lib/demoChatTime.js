/**
 * src/lib/demoChatTime.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure calendar / time-zone helpers for the DEMO chat (Phase 3C-4).
 * Journey scheduling and earnings periods use Africa/Casablanca; the process
 * time zone is never read or changed.
 *
 *   • Calendar dates are 'YYYY-MM-DD' keys. Day arithmetic is done on the
 *     calendar (Date.UTC on y/m/d — no time zone involved), never by adding
 *     24-hour milliseconds to an instant, so local days of 23 or 25 hours
 *     (offset changes, e.g. Morocco's Ramadan switch) are handled.
 *   • Instant ↔ local wall time goes through Intl time-zone data only (no fixed
 *     offsets), so a future change of Casablanca's rules is picked up from the
 *     runtime's tz database.
 *   • A wall time that does not exist (spring-forward gap) resolves to the
 *     first valid instant after the gap; an ambiguous wall time (fall-back
 *     overlap) resolves to the EARLIER instant. Both are reported.
 * No clock reads: callers pass `now`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const CHAT_TIMEZONE = 'Africa/Casablanca';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n) => String(n).padStart(2, '0');

/** Strict 'YYYY-MM-DD' calendar date check (rejects 2026-02-30). */
export function isDateKey(s) {
  const m = typeof s === 'string' && DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function ymd(key) {
  if (!isDateKey(key)) throw new Error(`invalid date key: ${key}`);
  const [, y, m, d] = DATE_RE.exec(key);
  return [+y, +m, +d];
}

/** Calendar arithmetic: key + n days. */
export function addDays(key, n) {
  const [y, m, d] = ymd(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a, b) {
  const [ya, ma, da] = ymd(a); const [yb, mb, db] = ymd(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

/** Local wall-clock parts of an instant in `tz`. */
export function localParts(ms, tz = CHAT_TIMEZONE) {
  if (!Number.isFinite(ms)) throw new Error('invalid instant');
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, seconds: +p.second, hour: +hour, minute: +p.minute };
}

export const localDateKey = (ms, tz = CHAT_TIMEZONE) => localParts(ms, tz).date;

/** UTC offset (minutes, local − UTC) of `tz` at instant `ms`. */
export function offsetMinutes(ms, tz = CHAT_TIMEZONE) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((local - (ms - (ms % 1000 + 1000) % 1000)) / 60_000);
}

/**
 * Instant of local wall time `date` + `time` ('HH:MM') in `tz`.
 * Returns { ms, adjustment: null | 'gap' | 'overlap' }.
 */
export function zonedTimeToUtc(date, time, tz = CHAT_TIMEZONE) {
  const [y, m, d] = ymd(date);
  const tm = typeof time === 'string' && TIME_RE.exec(time);
  if (!tm) throw new Error(`invalid time: ${time}`);
  const wall = Date.UTC(y, m - 1, d, +tm[1], +tm[2]);
  // Every offset in effect within ±1 day of the wall time is a candidate.
  const offsets = [...new Set([-36, -12, 0, 12, 36].map((h) => offsetMinutes(wall + h * 3_600_000, tz)))];
  const matches = offsets
    .map((o) => wall - o * 60_000)
    .filter((t) => { const lp = localParts(t, tz); return lp.date === date && lp.time === time; })
    .sort((a, b) => a - b);
  if (matches.length) return { ms: matches[0], adjustment: matches.length > 1 ? 'overlap' : null };
  // Gap: the wall time is skipped. Use the first instant whose local time is past it.
  const before = Math.min(...offsets.map((o) => wall - o * 60_000));
  for (let t = before; t <= before + 4 * 3_600_000; t += 60_000) {
    const lp = localParts(t, tz);
    if (lp.date > date || (lp.date === date && lp.time > time)) return { ms: t, adjustment: 'gap' };
  }
  throw new Error(`cannot resolve ${date} ${time} in ${tz}`);
}

/** Instant of local midnight starting `date` in `tz` (gap-safe). */
export const localDayStart = (date, tz = CHAT_TIMEZONE) => zonedTimeToUtc(date, '00:00', tz).ms;

/** Midnight UTC of a calendar date key (the earnings-history bucket boundary). */
export function utcDayStart(key) {
  const [y, m, d] = ymd(key);
  return Date.UTC(y, m - 1, d);
}
