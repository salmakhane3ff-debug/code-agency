/**
 * src/lib/casablancaTime.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Africa/Casablanca wall-clock time ⇄ UTC instants, from ONE explicit rule table
 * shared by the server and the browser (pure: no Node API, no I/O).
 *
 * Why not just Intl: the result of Intl.DateTimeFormat({ timeZone: 'Africa/Casablanca' })
 * depends on the time-zone data compiled into each runtime. Morocco changed its rules
 * (permanent +00 from 2026-09-20, IANA tzdata 2026c); a runtime with older data
 * (e.g. Node 22's bundled ICU, tz 2025b) still applies +01, so the server and an
 * up-to-date browser disagree by one hour for the same wall-clock time. With this
 * table both sides always compute the same absolute instant.
 *
 * Source: IANA tzdata 2026c, zone Africa/Casablanca. Instants before the first entry
 * fall back to Intl (all tzdata versions agree there). When Morocco changes its rules
 * again, add the new transitions here (scripts/paymentProofSchedule.test.mjs compares
 * the table with the system zoneinfo when it is available).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const CASABLANCA_TZ = 'Africa/Casablanca';
export const CASABLANCA_TZDATA_VERSION = '2026c';

const MIN = 60_000;
const u = (y, mo, d, h = 2) => Date.UTC(y, mo - 1, d, h);

/**
 * [UTC instant of the change, UTC offset in minutes from then on], ascending.
 * +01 since 2018-06-17, +00 during each Ramadan (2019–2026), +00 permanently from
 * 2026-09-20 02:00 local (01:00 UTC).
 */
export const CASABLANCA_TRANSITIONS = Object.freeze([
  [u(2018, 6, 17), 60],
  [u(2019, 5, 5), 0], [u(2019, 6, 9), 60],
  [u(2020, 4, 19), 0], [u(2020, 5, 31), 60],
  [u(2021, 4, 11), 0], [u(2021, 5, 16), 60],
  [u(2022, 3, 27), 0], [u(2022, 5, 8), 60],
  [u(2023, 3, 19), 0], [u(2023, 4, 23), 60],
  [u(2024, 3, 10), 0], [u(2024, 4, 14), 60],
  [u(2025, 2, 23), 0], [u(2025, 4, 6), 60],
  [u(2026, 2, 15), 0], [u(2026, 3, 22), 60],
  [u(2026, 9, 20, 1), 0],
].map(Object.freeze));

const TABLE_START = CASABLANCA_TRANSITIONS[0][0];
const OFFSETS = [...new Set(CASABLANCA_TRANSITIONS.map(([, o]) => o))];

let fallbackFmt = null;
function intlParts(ms) {
  fallbackFmt ||= new Intl.DateTimeFormat('en-US', {
    timeZone: CASABLANCA_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const { type, value } of fallbackFmt.formatToParts(new Date(ms))) if (type !== 'literal') p[type] = Number(value);
  if (p.hour === 24) p.hour = 0;
  return p;
}

/** UTC offset of Casablanca at instant `ms`, in minutes (null before the table: use Intl). */
export function casablancaOffsetMinutes(ms) {
  if (!(ms >= TABLE_START)) return null;
  let off = CASABLANCA_TRANSITIONS[0][1];
  for (const [at, o] of CASABLANCA_TRANSITIONS) { if (at <= ms) off = o; else break; }
  return off;
}

/** Casablanca wall-clock parts of an instant: { year, month, day, hour, minute }. */
export function casablancaParts(ms) {
  const off = casablancaOffsetMinutes(ms);
  if (off === null) return intlParts(ms);
  const d = new Date(Math.floor(ms / MIN) * MIN + off * MIN); // minute precision, like the inputs
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

const z = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" and "HH:MM" of an instant in Casablanca. */
export function casablancaLocal(ms) {
  const p = casablancaParts(ms);
  return { date: `${p.year}-${z(p.month)}-${z(p.day)}`, time: `${z(p.hour)}:${z(p.minute)}` };
}

/** Today's date in Casablanca ("YYYY-MM-DD") at instant `ms` (default: now). */
export const casablancaToday = (ms = Date.now()) => casablancaLocal(ms).date;

/** "DD/MM/YYYY HH:MM" of an instant in Casablanca (French numeric format). */
export function formatCasablanca(ms) {
  const p = casablancaParts(ms);
  return `${z(p.day)}/${z(p.month)}/${p.year} ${z(p.hour)}:${z(p.minute)}`;
}

/**
 * Every UTC instant at which Casablanca shows `date` ("YYYY-MM-DD") `time` ("HH:MM", or
 * "HH:MM:00" as some browsers send it), ascending:
 *   • 1 instant normally;
 *   • 2 instants for a time repeated when clocks go back;
 *   • 0 instants (error NONEXISTENT_LOCAL_TIME) for a time skipped when clocks go forward.
 * Returns { candidates } or { error: 'INVALID_DATETIME' | 'NONEXISTENT_LOCAL_TIME' }.
 */
export function casablancaCandidates(date, time) {
  const dm = typeof date === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = typeof time === 'string' && /^(\d{2}):(\d{2})(?::00)?$/.exec(time);
  if (!dm || !tm) return { error: 'INVALID_DATETIME' };
  const [y, mo, d, h, mi] = [dm[1], dm[2], dm[3], tm[1], tm[2]].map(Number);
  if (h > 23 || mi > 59) return { error: 'INVALID_DATETIME' };
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return { error: 'INVALID_DATETIME' };
  const found = new Set();
  // Table offsets, plus a −1 h … +2 h sweep for instants before the table (Intl fallback).
  const tries = [...OFFSETS];
  for (let o = -60; o <= 120; o += 15) if (!tries.includes(o)) tries.push(o);
  for (const o of tries) {
    const t = wall - o * MIN;
    const p = casablancaParts(t);
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) found.add(t);
  }
  if (!found.size) return { error: 'NONEXISTENT_LOCAL_TIME' };
  return { candidates: [...found].sort((a, b) => a - b) };
}
