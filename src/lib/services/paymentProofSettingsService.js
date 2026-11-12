/**
 * src/lib/services/paymentProofSettingsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Payment Proofs — the global "Durée d'affichage des preuves de paiement" setting
 * (settings row PROOF_DISPLAY_SETTING_ID, existing admin settings table).
 *
 *   • 72 h (3 days) by default — also when the row is missing or invalid;
 *   • presets 72 h / 7 days / 30 days, or a custom whole number of hours (1 … 8760);
 *   • read by the publication pipeline INSIDE its transaction, at the actual publication:
 *     the value is then captured on the proof (visibleHours / visibleUntil). Changing the
 *     setting therefore only affects proofs published AFTER the change — never a proof
 *     already published, and a scheduled proof takes the value in force when it is published.
 *
 * Saves are conflict-safe: every save carries the REVISION the admin page loaded; under an
 * advisory transaction lock the stored row is re-read, and a stale revision is refused with
 * SETTINGS_CONFLICT (nothing written). Each change is appended to the row's bounded history
 * (who / when / from → to). The generic POST /api/setting refuses this type (reserved).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import prisma from '../prisma.js';
import { resolveAdminNames, nameOf } from './adminNameService.js';
import {
  PROOF_DISPLAY_SETTING_ID, DEFAULT_DISPLAY_HOURS, MIN_DISPLAY_HOURS, MAX_DISPLAY_HOURS, DISPLAY_DURATION_PRESETS,
  parseDisplayHours, displayHoursOf, displayPresetOf, describeDisplayHours, proofError as err,
} from '../paymentProofs.js';

const LOCK = 'payment-proof-display-setting';
export const DISPLAY_HISTORY_MAX = 50;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const displaySettingRevision = (data) => createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 32);

async function readRow(db) {
  const row = await db.setting.findUnique({ where: { id: PROOF_DISPLAY_SETTING_ID } });
  return row ? row.data : null;
}

/** The duration (hours) in force now — what the publication pipeline captures. */
export async function readPaymentProofDisplayHours({ db = prisma } = {}) {
  return displayHoursOf(await readRow(db));
}

function view(data) {
  const hours = displayHoursOf(data);
  const stored = isPlainObject(data) ? parseDisplayHours(data.hours) : null;
  return {
    hours,
    preset: displayPresetOf(hours),
    label: describeDisplayHours(hours),
    isDefault: stored === null,
    defaultHours: DEFAULT_DISPLAY_HOURS,
    minHours: MIN_DISPLAY_HOURS,
    maxHours: MAX_DISPLAY_HOURS,
    presets: DISPLAY_DURATION_PRESETS.map((p) => ({ ...p, label: describeDisplayHours(p.hours) })),
    updatedAt: isPlainObject(data) ? data.updatedAt ?? null : null,
    updatedBy: isPlainObject(data) ? data.updatedBy ?? null : null,
    history: isPlainObject(data) && Array.isArray(data.history) ? data.history : [],
    revision: displaySettingRevision(data),
  };
}

/** + display names of the admins (updatedByName, history[].byName); the stored row is unchanged. */
async function withNames(v, db) {
  const names = await resolveAdminNames([v.updatedBy, ...v.history.map((h) => h?.by)], { db });
  return { ...v, updatedByName: nameOf(names, v.updatedBy), history: v.history.map((h) => ({ ...h, byName: nameOf(names, h?.by) })) };
}

/** Admin read: current duration, label, presets, history and the revision to send back on save. */
export async function getPaymentProofDisplaySettings({ db = prisma } = {}) {
  return withNames(view(await readRow(db)), db);
}

/**
 * Save the global duration. `hours` = whole hours 1 … 8760 (a preset or a custom value);
 * `revision` = the one returned by the last read.
 * @throws INVALID_DURATION (400) | SETTINGS_CONFLICT (409, with `current`) | UNAUTHORIZED
 */
export async function savePaymentProofDisplaySettings({ hours, revision } = {}, { db = prisma, now = new Date(), actorId = null } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw err('UNAUTHORIZED', 'Administrateur non identifié.');
  const h = parseDisplayHours(hours);
  if (h === null) {
    throw err('INVALID_DURATION', `Durée invalide : saisissez un nombre entier d'heures entre ${MIN_DISPLAY_HOURS} et ${MAX_DISPLAY_HOURS}.`, { errors: { hours: 'INVALID_DURATION' } });
  }
  if (typeof revision !== 'string' || !revision) throw err('INVALID_INPUT', 'Révision manquante.');
  const saved = await db.$transaction(async (tx) => {
    if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}::text))`;
    const current = await readRow(tx);
    if (displaySettingRevision(current) !== revision) {
      throw err('SETTINGS_CONFLICT', 'Ce réglage a été modifié entre-temps : rechargez la page.', { current: view(current) });
    }
    const before = displayHoursOf(current);
    const at = new Date(now).toISOString();
    const history = [
      { at, by: actorId, fromHours: before, toHours: h },
      ...(isPlainObject(current) && Array.isArray(current.history) ? current.history : []),
    ].slice(0, DISPLAY_HISTORY_MAX);
    const data = { hours: h, updatedAt: at, updatedBy: actorId, history };
    const saved = await tx.setting.upsert({
      where: { id: PROOF_DISPLAY_SETTING_ID }, update: { data }, create: { id: PROOF_DISPLAY_SETTING_ID, data },
    });
    return view(saved.data);
  }).catch(async (e) => {
    if (e?.code === 'SETTINGS_CONFLICT' && e.current) e.current = await withNames(e.current, db); // names on the conflict view too
    throw e;
  });
  return withNames(saved, db);
}
