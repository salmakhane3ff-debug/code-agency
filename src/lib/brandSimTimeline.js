/**
 * src/lib/brandSimTimeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — PURE rules that make simulated history PERMANENT and
 * DETERMINISTIC (no DB, no I/O). Shared by the generation service, the engine
 * and the dashboards.
 *
 * Inputs:
 *   • settings timeline — append-only versions { effectiveFrom, enabled,
 *     verified, settings } sorted by effectiveFrom (brand_sim_settings_versions)
 *   • access periods — { startedAt, endedAt|null } (brand_access_periods): one
 *     per activation / reopening; the end is the closure
 *
 * Rules (a result depends only on time, never on when anyone looked):
 *   • an hour [h, h+1h) is GENERATED only if it lies entirely inside an access
 *     period (the first one starting no earlier than the snapshotted simulation
 *     start) AND every settings version in force during that hour is enabled
 *     and verified
 *   • a business day (UTC) uses ONE set of parameters: the version in force at
 *     the day's start if it is runnable, otherwise the first runnable version
 *     taking effect during that day. A later configuration change therefore
 *     never changes an hour that was — or could have been — generated before it
 *   • hours inside a period where the settings are unverified (or unknown) are
 *     never generated and are reported as INCOMPLETE — nothing is fabricated
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isSimulationRunnable, SIM_OUTCOMES } from './brandProgram.js';
import { HOUR_MS, DAY_MS, floorHour, ceilHour, floorDay } from './brandSimulation.js';

/** Settings that influence generated history (counts) or its display (statuses). */
export const VERSIONED_SIM_FIELDS = Object.freeze(['dailyVolumeMin', 'dailyVolumeMax', 'confirmationDelayHours', 'deliveryDelayHours', 'distribution']);

const ms = (d) => (d === null || d === undefined ? null : new Date(d).getTime());

/** The versioned part of a (normalized) simulation config. */
export function versionedSettings(sim) {
  const s = sim || {};
  const out = {};
  for (const k of VERSIONED_SIM_FIELDS) {
    if (k === 'distribution') {
      out.distribution = Object.fromEntries(SIM_OUTCOMES.map((o) => [o, s.distribution?.[o] ?? null]));
    } else out[k] = s[k] ?? null;
  }
  return out;
}

/** Same versioned state (enabled flag + versioned settings)? */
export function sameSimState(simA, simB) {
  if (!!simA?.enabled !== !!simB?.enabled) return false;
  return JSON.stringify(versionedSettings(simA)) === JSON.stringify(versionedSettings(simB));
}

/** Normalize stored version rows → sorted timeline entries. */
export function toTimeline(rows) {
  return (rows || [])
    .map((r) => ({
      effectiveFrom: ms(r.effectiveFrom),
      enabled: r.enabled === true,
      proven: r.proven === true,
      settings: r.settings || {},
      id: r.id,
    }))
    .sort((a, b) => a.effectiveFrom - b.effectiveFrom);
}

/** Version in force at `t` (last with effectiveFrom ≤ t), or null when unknown. */
export function versionAt(timeline, t) {
  let found = null;
  for (const v of timeline) {
    if (v.effectiveFrom <= t) found = v; else break;
  }
  return found;
}

// The start delay is snapshotted per access at activation, not versioned: it plays no part here.
const runnable = (v) => !!v && v.enabled && v.proven && isSimulationRunnable({ ...v.settings, enabled: true, startDelayHours: 0 });

/** Versions taking effect strictly inside (from, to). */
function versionsInside(timeline, from, to) {
  return timeline.filter((v) => v.effectiveFrom > from && v.effectiveFrom < to);
}

/**
 * Parameters of a business day: the version at the day's start if runnable,
 * else the first runnable version taking effect during the day; null if none.
 */
export function dayParams(timeline, dayStartMs) {
  const day = floorDay(dayStartMs);
  const atStart = versionAt(timeline, day);
  if (runnable(atStart)) return atStart.settings;
  const first = versionsInside(timeline, day, day + DAY_MS).find(runnable);
  return first ? first.settings : null;
}

/** Every version in force during [h, h+1h) is enabled and verified. */
export function hourEnabled(timeline, h) {
  const v = versionAt(timeline, h);
  if (!v || !v.enabled || !v.proven) return false;
  return versionsInside(timeline, h, h + HOUR_MS).every((x) => x.enabled && x.proven);
}

/** Some version in force during [h, h+1h) is unverified (or the state is unknown). */
export function hourUnverified(timeline, h) {
  const v = versionAt(timeline, h);
  if (!v || !v.proven) return true;
  return versionsInside(timeline, h, h + HOUR_MS).some((x) => !x.proven);
}

/**
 * Generation windows of an access: its periods as [from, to) in ms, the first one
 * starting no earlier than the snapshotted simulation start; `endFallback` closes
 * the open period (now). Periods are sorted.
 */
export function accessWindows(periods, simulationStartsAt, endFallbackMs) {
  const start0 = ms(simulationStartsAt);
  const sorted = [...(periods || [])].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  return sorted.map((p, i) => {
    const from = i === 0 && start0 !== null ? Math.max(ms(p.startedAt), start0) : ms(p.startedAt);
    const to = p.endedAt ? ms(p.endedAt) : endFallbackMs;
    return { from, to: Math.max(from, to), open: !p.endedAt };
  });
}

/** The hour [h, h+1h) lies entirely inside one window. */
export function hourInWindows(windows, h) {
  return windows.some((w) => h >= ceilHour(w.from) && h + HOUR_MS <= w.to);
}

/** Hour starts to generate in [fromMs, toMs): inside a window, enabled + verified, day parameters known. */
export function generableHours(timeline, windows, fromMs, toMs) {
  const out = [];
  for (let h = floorHour(fromMs); h < toMs; h += HOUR_MS) {
    if (hourInWindows(windows, h) && hourEnabled(timeline, h) && dayParams(timeline, h)) out.push(h);
  }
  return out;
}

/** Merged [from, to) ranges of hours inside a window whose settings are unverified/unknown. */
export function incompleteRanges(timeline, windows, fromMs, toMs) {
  const ranges = [];
  for (let h = floorHour(fromMs); h < toMs; h += HOUR_MS) {
    if (!hourInWindows(windows, h) || !hourUnverified(timeline, h)) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.to === h) last.to = h + HOUR_MS; else ranges.push({ from: h, to: h + HOUR_MS });
  }
  return ranges.map((r) => ({ from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString() }));
}

/** Display delays (confirmation / final status) of the day an order was created. */
export function delaysForHour(timeline, h) {
  const p = dayParams(timeline, h);
  return p ? { confirmationDelayHours: p.confirmationDelayHours ?? 0, deliveryDelayHours: p.deliveryDelayHours ?? 0 } : { confirmationDelayHours: 0, deliveryDelayHours: 0 };
}
