/**
 * src/lib/services/brandSimSettingsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — append-only SIMULATION SETTINGS VERSIONS
 * (brand_sim_settings_versions). Every configuration save that changes the
 * enabled flag or a versioned setting (daily volume, outcome split, display
 * delays) appends a version effective at the save time, linked to its
 * CONFIG_UPDATE audit row. Generated history uses the version in force at the
 * time, so a later change never alters earlier results.
 *
 * Reconstruction (first use, when no version exists yet) rebuilds the timeline
 * ONLY from what the CONFIG_UPDATE audit snapshots prove:
 *   • no settings row at all → never configured: disabled since the beginning
 *     (verified)
 *   • a settings row but no audit row → history unprovable: unverified until
 *     now, then the current state from now (verified)
 *   • the first audit's `before` is the state before any audited change:
 *     verified only when the simulation was disabled
 *   • each audit's `after` takes effect at its createdAt; when an audit's
 *     `before` differs from the previous `after` (changed outside the audited
 *     service), the period in between is marked unverified
 *   • a stored config different from the last `after` → unverified since that
 *     audit, then the current state from now (verified)
 * Unverified periods are never generated and are reported as incomplete.
 * Versions are never updated or deleted (DB trigger).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { BRAND_SETTING_ID, normalizeBrandConfig } from '../brandProgram.js';
import { versionedSettings, sameSimState, toTimeline } from '../brandSimTimeline.js';

export const SETTINGS_LOCK_KEY = 'brand-sim-settings';
const EPOCH = new Date(0);

/** Advisory-lock key serialising everything that touches one access's simulated history. */
export const accessLockKey = (accessId) => `brand-sim:${accessId}`;

/** Per-key PostgreSQL transaction advisory lock (no-op on clients without raw SQL, e.g. unit-test fakes). */
export async function advisoryXactLock(tx, key) {
  if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${String(key)}::text))`;
}

/** Shared variant: holders run concurrently, but never alongside an exclusive holder of the same key. */
export async function advisoryXactLockShared(tx, key) {
  if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${String(key)}::text))`;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const simOf = (raw) => normalizeBrandConfig(isObj(raw) ? raw : {}).simulation;
const hasSim = (raw) => isObj(raw) && isObj(raw.simulation);
const at = (d) => new Date(d);

/**
 * PURE plan of the versions to insert. `audits` = CONFIG_UPDATE rows
 * ({ id, createdAt, before, after }); `currentRaw` = stored config data or null
 * when no settings row exists.
 */
export function planReconstruction(audits, currentRaw, nowMs) {
  const rows = [...(audits || [])].sort((a, b) => at(a.createdAt) - at(b.createdAt));
  const plan = [];
  const version = (effectiveFrom, sim, source, proven, auditId = null) => ({
    effectiveFrom: at(effectiveFrom), enabled: !!sim.enabled, proven, settings: versionedSettings(sim), source, auditId,
  });
  const current = simOf(currentRaw);

  if (!rows.length) {
    if (currentRaw === null || currentRaw === undefined) {
      plan.push(version(EPOCH, simOf(null), 'INITIAL_STATE', true));
      return plan;
    }
    plan.push(version(EPOCH, current, 'INITIAL_STATE', false));
    plan.push(version(nowMs, current, 'CURRENT_AT_RECONSTRUCTION', true));
    return plan;
  }

  const initial = simOf(rows[0].before);
  plan.push(version(EPOCH, initial, 'INITIAL_STATE', hasSim(rows[0].before) ? !initial.enabled : true));
  let prevAfter = initial;
  for (const a of rows) {
    const before = simOf(a.before);
    const readable = hasSim(a.after);
    const after = simOf(a.after);
    const broken = !sameSimState(before, prevAfter);
    if (broken) plan[plan.length - 1].proven = false;
    if (broken || !readable || !sameSimState(after, before)) {
      plan.push(version(a.createdAt, after, 'RECONSTRUCTED', readable, a.id));
    }
    prevAfter = after;
  }
  if (!sameSimState(current, prevAfter)) {
    plan[plan.length - 1].proven = false;
    plan.push(version(nowMs, current, 'CURRENT_AT_RECONSTRUCTION', true));
  }
  return plan;
}

/**
 * Make sure the timeline exists (reconstructing it once if empty). Runs inside
 * the caller's transaction under the settings advisory lock.
 */
export async function ensureSettingsTimeline(tx, { now = new Date() } = {}) {
  if ((await tx.brandSimSettingsVersion.count()) > 0) return { reconstructed: false };
  await advisoryXactLock(tx, SETTINGS_LOCK_KEY);
  if ((await tx.brandSimSettingsVersion.count()) > 0) return { reconstructed: false };
  const [setting, audits] = await Promise.all([
    tx.setting.findUnique({ where: { id: BRAND_SETTING_ID } }),
    tx.brandAuditLog.findMany({ where: { action: 'CONFIG_UPDATE' }, orderBy: { createdAt: 'asc' } }),
  ]);
  const plan = planReconstruction(audits, setting ? setting.data : null, new Date(now).getTime());
  for (const v of plan) await tx.brandSimSettingsVersion.create({ data: v });
  return { reconstructed: true, versions: plan.length };
}

/** Append a version when a save changes the versioned simulation state. */
export async function appendSettingsVersion(tx, { beforeSim, afterSim, auditId, at: when }) {
  if (sameSimState(beforeSim, afterSim)) return null;
  return tx.brandSimSettingsVersion.create({
    data: { effectiveFrom: new Date(when), enabled: !!afterSim.enabled, proven: true, settings: versionedSettings(afterSim), source: 'CONFIG_UPDATE', auditId },
  });
}

/** The settings timeline (sorted), reconstructing it once if needed. */
export async function getSettingsTimeline(db = prisma, { now = new Date() } = {}) {
  if ((await db.brandSimSettingsVersion.count()) === 0) {
    await db.$transaction((tx) => ensureSettingsTimeline(tx, { now }));
  }
  return toTimeline(await db.brandSimSettingsVersion.findMany({ orderBy: { effectiveFrom: 'asc' } }));
}
