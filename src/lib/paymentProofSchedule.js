/**
 * src/lib/paymentProofSchedule.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONE scheduling rule for payment proofs, used by the server (validateProofInput)
 * and by the admin browser (immediate feedback) — pure, no I/O. The admin types a
 * Casablanca date + time; both sides turn it into the same UTC instant
 * (src/lib/casablancaTime.js) and compare it with "now" (an absolute instant, so the
 * device / server time zone never matters). The server remains the authority.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { casablancaCandidates } from './casablancaTime.js';

export const SCHEDULE_MIN_LEAD_MS = 60_000;   // a new / edited schedule must be ≥ 1 min in the future
export const SCHEDULE_MAX_AHEAD_DAYS = 366;

/**
 * Casablanca `date` + `time` → { ms } (the UTC instant to store) or { error }:
 * INVALID_DATETIME | NONEXISTENT_LOCAL_TIME | SCHEDULE_IN_PAST | SCHEDULE_TOO_FAR.
 * A time repeated when clocks go back resolves to its earliest instant that is still
 * in the future (so a valid future time is never refused because its first occurrence
 * has passed).
 */
export function checkProofSchedule(date, time, nowMs) {
  const local = casablancaCandidates(date, time);
  if (local.error) return { error: local.error };
  const ms = local.candidates.find((t) => t >= nowMs + SCHEDULE_MIN_LEAD_MS);
  if (ms === undefined) return { error: 'SCHEDULE_IN_PAST' };
  if (ms > nowMs + SCHEDULE_MAX_AHEAD_DAYS * 24 * 3_600_000) return { error: 'SCHEDULE_TOO_FAR' };
  return { ms };
}
