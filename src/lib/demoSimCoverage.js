/**
 * src/lib/demoSimCoverage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Evidence that the DEDICATED demo simulation really ran (Phase 3C-5), so the
 * demo chat may say "0" for a day only when that is proven. Demo tables only:
 * `demo_sim_day_coverage` + reserved settings rows `demo-sim-participants:<day>`.
 * Never real affiliates, orders, payouts, deposits, rewards or notifications.
 *
 * Recorded once per SUCCESSFUL simulateTick(), after its history writes, in ONE
 * transaction:
 *   • coverage (per UTC day = the earnings-history bucket):
 *       firstTickAt = min, lastTickAt = max, tickCount + 1, and maxGapSec grows
 *       by the distance whenever a tick EXTENDS the covered range (later than
 *       the last tick, or earlier than the first). A tick inside the range
 *       never shrinks the gap. → duplicates, retries and late/out-of-order
 *       ticks can only make a day look LESS covered, never more.
 *   • participants (per UTC day): the ids of the profiles that were eligible
 *       (active + stats) in EVERY recorded tick — an intersection, so a profile
 *       activated or deactivated during the day drops out. Order-independent and
 *       idempotent.
 * Time-zone guard: history rows are bucketed at SERVER-LOCAL midnight; coverage
 * is keyed by UTC day. Nothing is recorded unless that local midnight IS UTC
 * midnight (otherwise buckets would disagree and a zero could be mis-proven).
 * The server time zone is never changed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const SIM_PARTICIPANTS_PREFIX = 'demo-sim-participants:';
const DAY_MS = 86_400_000; // UTC days: exactly 24 h

export const participantsKey = (day) => `${SIM_PARTICIPANTS_PREFIX}${day}`;
export const coverageDayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Server-local midnight of the tick's day — the history bucket simulateTick writes to. */
export function localMidnightOf(tickAtMs) {
  const d = new Date(tickAtMs); d.setHours(0, 0, 0, 0); return d;
}

/** True when the tick's history bucket (server-local midnight) is a UTC midnight. */
export const bucketsAlignWithUtc = (tickAtMs) => localMidnightOf(tickAtMs).getTime() % DAY_MS === 0;

// ── Pure mirrors of the SQL below (documentation + tests) ─────────────────────

/** Coverage after one more tick at `tickMs` (null = no row yet). */
export function mergeCoverage(existing, tickMs) {
  if (!existing) return { firstTickAt: tickMs, lastTickAt: tickMs, tickCount: 1, maxGapSec: 0 };
  const later = tickMs > existing.lastTickAt ? Math.ceil((tickMs - existing.lastTickAt) / 1000) : 0;
  const earlier = tickMs < existing.firstTickAt ? Math.ceil((existing.firstTickAt - tickMs) / 1000) : 0;
  return {
    firstTickAt: Math.min(existing.firstTickAt, tickMs),
    lastTickAt: Math.max(existing.lastTickAt, tickMs),
    tickCount: existing.tickCount + 1,
    maxGapSec: Math.max(existing.maxGapSec, later, earlier),
  };
}

/** Participant ids after one more tick (null = no row yet). Sorted, unique. */
export function intersectParticipants(existingIds, tickIds) {
  const tick = [...new Set(tickIds)].sort();
  if (existingIds == null) return tick;
  const keep = new Set(tick);
  return [...new Set(existingIds)].filter((id) => keep.has(id)).sort();
}

// ── Recorder ──────────────────────────────────────────────────────────────────

/**
 * Record one simulation tick. `db` = the demo Prisma seam. Throws on database
 * errors (the caller logs and continues — a missing record is conservative).
 * → { recorded: true, day } | { recorded: false, reason }
 */
export async function recordSimCoverage(db, { tickAtMs, participantIds = [] }) {
  if (!Number.isFinite(tickAtMs)) return { recorded: false, reason: 'invalid_tick_time' };
  if (!bucketsAlignWithUtc(tickAtMs)) return { recorded: false, reason: 'timezone_mismatch' };
  const day = coverageDayKey(tickAtMs);
  const at = new Date(tickAtMs).toISOString();
  const ids = JSON.stringify([...new Set(participantIds.filter((x) => typeof x === 'string' && x))].sort());
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "demo_sim_day_coverage" AS c ("day", "firstTickAt", "lastTickAt", "tickCount", "maxGapSec", "updatedAt")
      VALUES (${day}::date, (${at}::timestamptz AT TIME ZONE 'UTC'), (${at}::timestamptz AT TIME ZONE 'UTC'), 1, 0, (NOW() AT TIME ZONE 'UTC'))
      ON CONFLICT ("day") DO UPDATE SET
        "maxGapSec" = GREATEST(
          c."maxGapSec",
          CASE WHEN EXCLUDED."lastTickAt" > c."lastTickAt" THEN CEIL(EXTRACT(EPOCH FROM (EXCLUDED."lastTickAt" - c."lastTickAt")))::int ELSE 0 END,
          CASE WHEN EXCLUDED."firstTickAt" < c."firstTickAt" THEN CEIL(EXTRACT(EPOCH FROM (c."firstTickAt" - EXCLUDED."firstTickAt")))::int ELSE 0 END
        ),
        "firstTickAt" = LEAST(c."firstTickAt", EXCLUDED."firstTickAt"),
        "lastTickAt" = GREATEST(c."lastTickAt", EXCLUDED."lastTickAt"),
        "tickCount" = c."tickCount" + 1,
        "updatedAt" = (NOW() AT TIME ZONE 'UTC')`;
    await tx.$executeRaw`
      INSERT INTO "settings" AS s ("id", "data", "updatedAt")
      VALUES (${participantsKey(day)}, jsonb_build_object('ids', ${ids}::jsonb), (NOW() AT TIME ZONE 'UTC'))
      ON CONFLICT ("id") DO UPDATE SET
        "data" = jsonb_build_object('ids', COALESCE((
          SELECT jsonb_agg(x ORDER BY x)
            FROM jsonb_array_elements_text(COALESCE(s."data"->'ids', '[]'::jsonb)) AS x
           WHERE x IN (SELECT jsonb_array_elements_text(EXCLUDED."data"->'ids'))
        ), '[]'::jsonb)),
        "updatedAt" = (NOW() AT TIME ZONE 'UTC')`;
  });
  return { recorded: true, day };
}
