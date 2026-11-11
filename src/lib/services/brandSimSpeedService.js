/**
 * src/lib/services/brandSimSpeedService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — PER-BRAND simulation speed (admin). Rules: src/lib/brandSimSpeed.js.
 *
 * Storage: the `brand-sim-speed` settings row (reserved: written only here),
 * { accesses: { [accessId]: [versions] } }. Versions are append-only and take effect
 * at the next full hour; every save is also written to the append-only audit log.
 * A save runs in one transaction under the access's simulation lock (the same lock
 * the generator holds), so no hour is generated while its brand's settings change.
 *
 * Only this settings row and the audit log are written. No order, payment, wallet,
 * commission, reward or real statistic is involved.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  BRAND_SIM_SPEED_SETTING_ID, validateSpeedInput, normalizeSpeedConfig, appendSpeedVersion, speedVersionAt, effectiveDayRange,
} from '../brandSimSpeed.js';
import { advisoryXactLock, accessLockKey } from './brandSimSettingsService.js';
import { getBrandConfig, writeBrandAudit, BRAND_ACTOR } from './brandProgramService.js';
import { ACCESS_STATUS } from './brandAccessService.js';

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const ms = (d) => new Date(d).getTime();

/** Brands whose speed may be set: requested (applies once active) or active. A closed brand never runs again as is. */
export const SPEED_EDITABLE_STATUSES = Object.freeze([ACCESS_STATUS.PENDING_PAYMENT, ACCESS_STATUS.ACTIVE]);

/** The stored per-brand speed config (normalized). */
export async function getSpeedConfig(db = prisma) {
  const row = await db.setting.findUnique({ where: { id: BRAND_SIM_SPEED_SETTING_ID } }).catch(() => null);
  return normalizeSpeedConfig(row?.data);
}

/** Speed versions of one access (sorted; [] = global behaviour). */
export async function getAccessSpeedVersions(db, accessId) {
  return (await getSpeedConfig(db)).accesses[accessId] || [];
}

/** Admin view of one access's speed: current / pending version, history, global defaults. */
function speedView(access, versions, sim, nowMs) {
  const current = speedVersionAt(versions, nowMs);
  const pending = versions.find((v) => ms(v.effectiveFrom) > nowMs) || null;
  const shape = (v) => (v ? { ...v, effective: v.limits ? effectiveDayRange(v.limits) : null } : null);
  return {
    accessId: access.id,
    status: access.status,
    editable: SPEED_EDITABLE_STATUSES.includes(access.status),
    current: shape(current),
    pending: shape(pending),
    history: versions.map(shape),
    global: { enabled: !!sim?.enabled, dailyVolumeMin: sim?.dailyVolumeMin ?? null, dailyVolumeMax: sim?.dailyVolumeMax ?? null },
  };
}

/** @throws ACCESS_NOT_FOUND */
export async function getAccessSpeed(accessId, { db = prisma, now = new Date() } = {}) {
  const access = await db.brandAccess.findUnique({ where: { id: String(accessId || '') } });
  if (!access) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
  const [versions, config] = await Promise.all([getAccessSpeedVersions(db, access.id), getBrandConfig(db)]);
  return speedView(access, versions, config.simulation, ms(now));
}

/**
 * Save one access's speed: { enabled, custom, hourMin, hourMax, dayMin, dayMax }.
 * `custom: false` = the global behaviour (optionally paused for this brand only).
 * Conflicting limits are refused with explicit codes (see validateSpeedInput).
 * @throws INVALID_INPUT (errors) | ACCESS_NOT_FOUND | ACCESS_NOT_EDITABLE
 */
export async function saveAccessSpeed(accessId, input, { db = prisma, now = new Date(), actorId = null } = {}) {
  const { ok, errors, value } = validateSpeedInput(input);
  if (!ok) throw err('INVALID_INPUT', 'Réglages de vitesse invalides.', { errors });
  const nowMs = ms(now);
  const id = String(accessId || '');
  await db.$transaction(async (tx) => {
    await advisoryXactLock(tx, accessLockKey(id));                 // same lock as the generator of this brand
    await advisoryXactLock(tx, BRAND_SIM_SPEED_SETTING_ID);        // one writer of the settings row at a time
    const access = await tx.brandAccess.findUnique({ where: { id } });
    if (!access) throw err('ACCESS_NOT_FOUND', 'Demande introuvable.');
    if (!SPEED_EDITABLE_STATUSES.includes(access.status)) throw err('ACCESS_NOT_EDITABLE', 'La vitesse ne peut être réglée que pour une marque demandée ou active.');
    const row = await tx.setting.findUnique({ where: { id: BRAND_SIM_SPEED_SETTING_ID } });
    const cfg = normalizeSpeedConfig(row?.data);
    const before = cfg.accesses[id] || [];
    const after = appendSpeedVersion(before, value, { nowMs, actorId: actorId ? String(actorId) : null });
    const data = { accesses: { ...cfg.accesses, [id]: after } };
    await tx.setting.upsert({ where: { id: BRAND_SIM_SPEED_SETTING_ID }, create: { id: BRAND_SIM_SPEED_SETTING_ID, data }, update: { data } });
    await writeBrandAudit(tx, {
      action: 'SIM_SPEED_UPDATED', entityType: 'brand_access', entityId: id, actorType: BRAND_ACTOR.ADMIN, actorId,
      before: { current: speedVersionAt(before, nowMs) || null }, after: after[after.length - 1],
    });
  });
  return getAccessSpeed(id, { db, now });
}
