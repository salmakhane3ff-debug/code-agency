/**
 * src/lib/services/demoChatMessageService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Idempotent materialization of DEMO chat messages (Phase 3C-6) and the stored
 * message view. Demo tables only (demo_chat_*, demo history/coverage reads via
 * the Phase 3C-4 loader) — never real affiliates, orders, money, notifications,
 * WhatsApp, UGC, rewards or fake orders. No AI.
 *
 * Materialization (materializeAssignment / materializeDue)
 *   • Runs only when BOTH gates are on (env DEMO_CHAT_ENABLED + protected
 *     setting) and the assignment itself is enabled — everything ships off.
 *   • Steps come from the assignment's PUBLISHED version snapshot (immutable),
 *     scheduled by the Phase 3C-4 scheduler: current cycle only, each at its
 *     original Casablanca wall time, never a future message. Late joiners get
 *     day 1 … now of the current cycle; earlier cycles are never back-filled.
 *   • One message per (assignment, revision, cycle, step) — the database
 *     unique key. Inserts use createMany({ skipDuplicates }) = INSERT … ON
 *     CONFLICT DO NOTHING: concurrent requests, retries and restarts can never
 *     duplicate a message, and an existing row (and its snapshot) is never
 *     overwritten. The assignment row is locked FOR SHARE meanwhile, so its
 *     version / anchor / revision cannot change under the insert. `revision`
 *     stands for (version, anchor): an assignment changes either only by
 *     bumping it; a stored row whose version disagrees is reported as a
 *     conflict and left untouched.
 *   • Earnings messages: the Phase 3C-4 resolver is evaluated ONCE, at
 *     materialization, and its result is stored as `earningsSnapshot`. It is
 *     the source of truth when the message is shown — later days never change
 *     it.
 *     A "today" summary is only resolved when materialized within 15 minutes
 *     of its scheduled time; later it is stored as unavailable (the day's
 *     history keeps growing, so the value at send time is unknowable).
 *     Unavailable/incomplete data is stored as such — never as zero.
 *   • Stored rows are never deleted here: old-cycle messages stay until the
 *     agreed retention cleanup and are simply not returned by the view.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getDemoDb } from './demoService.js';
import { loadEarningsContext } from './demoChatService.js';
import { httpError as err, toHttpError } from '../demoChatErrors.js';
import { readDemoChatGates } from '../demoChatGate.js';
import { isValidChatId } from '../demoChatValidation.js';
import { CHAT_TIMEZONE, localParts } from '../demoChatTime.js';
import { visibleMessages, cyclePosition } from '../demoChatSchedule.js';
import { resolvePeriod, renderEarningsText, STATUS } from '../demoChatEarnings.js';

export const SNAPSHOT_VERSION = 1;
export const TODAY_SNAPSHOT_MAX_LAG_MS = 15 * 60_000;

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const anchorKey = (d) => new Date(d).toISOString().slice(0, 10); // @db.Date → 'YYYY-MM-DD'
const msgKey = (loopIndex, stepId) => `${loopIndex}|${stepId}`;

/** The snapshot stored with an earnings message (pure). */
export function buildEarningsSnapshot(resolution, { nowMs, scheduledAtMs, metric }) {
  let res = resolution;
  if (res.period === 'today' && nowMs - scheduledAtMs > TODAY_SNAPSHOT_MAX_LAG_MS && [STATUS.COMPLETE, STATUS.PROVISIONAL].includes(res.status)) {
    res = { period: 'today', status: STATUS.UNAVAILABLE, reason: 'materialized_too_late', day: res.day };
  }
  const { period, status, reason, orders, revenue, commission, ...rest } = res;
  const values = [STATUS.COMPLETE, STATUS.PROVISIONAL].includes(status) ? { orders, revenue, commission } : null;
  return { v: SNAPSHOT_VERSION, resolvedAt: iso(nowMs), metric, period, status, reason, values, ...rest };
}

/** Resolution object for the renderer, from a stored snapshot (pure). */
export function resolutionFromSnapshot(snap) {
  if (!snap || snap.v !== SNAPSHOT_VERSION) return { status: STATUS.UNAVAILABLE, reason: 'snapshot_missing' };
  if (!snap.values) return { period: snap.period, status: snap.status === STATUS.INCOMPLETE ? STATUS.INCOMPLETE : STATUS.UNAVAILABLE, reason: snap.reason };
  const sane = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (![STATUS.COMPLETE, STATUS.PROVISIONAL].includes(snap.status)
    || !['orders', 'revenue', 'commission'].every((f) => sane(snap.values[f]))) {
    return { period: snap.period, status: STATUS.UNAVAILABLE, reason: 'snapshot_corrupt' };
  }
  return { period: snap.period, status: snap.status, reason: snap.reason, ...snap.values };
}

/**
 * Materialize every due message of one assignment at `now`.
 * → { assignmentId, skipped? , created, existing, conflicts, cycle }
 */
export async function materializeAssignment(assignmentId, { now = Date.now(), env = process.env, db = getDemoDb() } = {}) {
  if (!isValidChatId(assignmentId)) throw err(404, 'NOT_FOUND', 'Attribution introuvable.');
  const gates = await readDemoChatGates(db, env);
  if (!gates.enabled) return { assignmentId, skipped: 'feature_disabled', created: 0 };

  const assignment = await db.demoChatAssignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) throw err(404, 'NOT_FOUND', 'Attribution introuvable.');
  if (!assignment.enabled) return { assignmentId, skipped: 'assignment_disabled', created: 0 };

  const version = await db.demoChatJourneyVersion.findUnique({ where: { id: assignment.versionId } });
  if (!version || !Array.isArray(version.steps)) throw err(409, 'VERSION_MISSING', 'Version publiée introuvable.');
  const profile = await db.demoAffiliate.findUnique({ where: { id: assignment.demoAffiliateId } });
  if (!profile) throw err(409, 'PROFILE_MISSING', 'Profil démo introuvable.');

  const anchor = anchorKey(assignment.anchorDate);
  const { position, messages: due } = visibleMessages({ steps: version.steps, anchorDate: anchor, nowMs: now, tz: CHAT_TIMEZONE });
  const cycle = position.started ? { loopIndex: position.loopIndex, day: position.day } : { started: false };
  if (!due.length) return { assignmentId, created: 0, existing: 0, conflicts: 0, cycle };

  // Rows already stored for this revision and cycle: skip them (never recompute or overwrite).
  const stored = await db.demoChatMessage.findMany({
    where: { assignmentId, revision: assignment.revision, loopIndex: position.loopIndex },
    select: { stepId: true, loopIndex: true, versionId: true },
  });
  const storedKeys = new Map(stored.map((m) => [msgKey(m.loopIndex, m.stepId), m]));
  const conflicts = stored.filter((m) => m.versionId !== assignment.versionId).length;
  const missing = due.filter((m) => !storedKeys.has(msgKey(m.loopIndex, m.stepId)));
  if (conflicts) console.error('[demo-chat materialize] stored messages disagree with the assignment version — left untouched:', { assignmentId, conflicts });
  if (!missing.length) return { assignmentId, created: 0, existing: stored.length, conflicts, cycle };

  const earnings = missing.filter((m) => m.type === 'earnings');
  const ctx = earnings.length ? await loadEarningsContext(db, profile, earnings.map((m) => m.date), now) : null;
  const rows = missing.map((m) => ({
    assignmentId, demoAffiliateId: assignment.demoAffiliateId, versionId: assignment.versionId,
    revision: assignment.revision, loopIndex: m.loopIndex, day: m.day, stepId: m.stepId, position: m.position ?? 0,
    scheduledAt: new Date(m.scheduledAtMs), type: m.type, text: m.text ?? null, assetId: m.assetId ?? null,
    earningsPeriod: m.type === 'earnings' ? m.earningsPeriod : null, metric: m.type === 'earnings' ? m.metric : null,
    earningsSnapshot: m.type === 'earnings'
      ? buildEarningsSnapshot(resolvePeriod(ctx, m.earningsPeriod, m.date), { nowMs: now, scheduledAtMs: m.scheduledAtMs, metric: m.metric })
      : undefined,
    createdAt: new Date(now),
  }));

  let created = 0;
  try {
    created = await db.$transaction(async (tx) => {
      // Lock the assignment against a concurrent version / anchor / revision change.
      const [locked] = await tx.$queryRaw`SELECT "versionId", "revision", "anchorDate", "enabled" FROM "demo_chat_assignments" WHERE "id" = ${assignmentId} FOR SHARE`;
      if (!locked || !locked.enabled || locked.versionId !== assignment.versionId || locked.revision !== assignment.revision
        || anchorKey(locked.anchorDate) !== anchor) return 0; // changed meanwhile → the next run uses the new state
      const res = await tx.demoChatMessage.createMany({ data: rows, skipDuplicates: true });
      if (res.count > 0) {
        await tx.demoChatAuditLog.create({
          data: {
            action: 'MESSAGES_MATERIALIZE', entityType: 'assignment', entityId: assignmentId, actorType: 'SYSTEM', actorId: null,
            after: { revision: assignment.revision, versionId: assignment.versionId, loopIndex: position.loopIndex, created: res.count, attempted: rows.length },
            createdAt: new Date(now),
          },
        });
      }
      return res.count;
    });
  } catch (e) {
    throw toHttpError(e, 'demo-chat materialize');
  }
  return { assignmentId, created, existing: stored.length + (rows.length - created), conflicts, cycle };
}

/** Materialize all enabled assignments (bounded, sequential). Gates checked first. */
export async function materializeDue({ now = Date.now(), env = process.env, db = getDemoDb(), limit = 500 } = {}) {
  const gates = await readDemoChatGates(db, env);
  if (!gates.enabled) return { skipped: 'feature_disabled', assignments: 0, created: 0 };
  const list = await db.demoChatAssignment.findMany({ where: { enabled: true }, select: { id: true }, orderBy: { id: 'asc' }, take: limit });
  let created = 0; const results = [];
  for (const a of list) {
    try {
      const r = await materializeAssignment(a.id, { now, env, db });
      created += r.created || 0; results.push(r);
    } catch (e) {
      results.push({ assignmentId: a.id, error: e?.code || 'ERROR' }); // one bad assignment never blocks the others
    }
  }
  return { assignments: list.length, created, results };
}

/**
 * The normal stored view: current revision, current cycle, scheduled ≤ now.
 * Earlier cycles stay stored but are not returned. Earnings text is rendered
 * from the stored snapshot only — never re-resolved.
 */
export async function listAssignmentMessages(assignmentId, { now = Date.now(), locale = 'ar', db = getDemoDb() } = {}) {
  if (!isValidChatId(assignmentId)) throw err(404, 'NOT_FOUND', 'Attribution introuvable.');
  const assignment = await db.demoChatAssignment.findUnique({ where: { id: assignmentId } });
  if (!assignment) throw err(404, 'NOT_FOUND', 'Attribution introuvable.');
  const position = cyclePosition(anchorKey(assignment.anchorDate), now, CHAT_TIMEZONE);
  if (!position.started) return { assignmentId, cycle: { started: false, startsOn: position.startsOn }, messages: [] };
  const rows = await db.demoChatMessage.findMany({
    where: { assignmentId, revision: assignment.revision, loopIndex: position.loopIndex },
    orderBy: [{ scheduledAt: 'asc' }, { day: 'asc' }, { position: 'asc' }, { stepId: 'asc' }],
  });
  const visible = rows.filter((m) => new Date(m.scheduledAt).getTime() <= now);
  return {
    assignmentId, simulated: true,
    cycle: { started: true, loopIndex: position.loopIndex, day: position.day, previousCyclesHidden: position.previousCycles },
    messages: visible.map((m) => {
      const base = {
        id: m.id, stepId: m.stepId, day: m.day, loopIndex: m.loopIndex, type: m.type,
        scheduledAt: iso(m.scheduledAt), localTime: localParts(new Date(m.scheduledAt).getTime(), CHAT_TIMEZONE).time,
        assetId: m.assetId ?? null,
      };
      if (m.type !== 'earnings') return { ...base, state: 'ok', text: m.text ?? null };
      const r = renderEarningsText({ text: m.text, metric: m.metric, resolution: resolutionFromSnapshot(m.earningsSnapshot), locale });
      return { ...base, metric: m.metric, earningsPeriod: m.earningsPeriod, state: r.state, text: r.text, metricLabel: r.metricLabel ?? null };
    }),
  };
}
