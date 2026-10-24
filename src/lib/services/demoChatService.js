/**
 * src/lib/services/demoChatService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin authoring of scripted DEMO chat journeys (Phase 3C-2): draft journeys
 * and steps, immutable published versions, a no-write preview and the
 * append-only audit trail. Simulation only — no AI, no WhatsApp/SMS, never a
 * real affiliate balance, order, commission, payout or notification.
 *
 * Rules
 *   • Every write runs in ONE transaction with exactly one audit row
 *     (insert-only; the audit table rejects UPDATE/DELETE/TRUNCATE).
 *   • Journey-scoped writes lock the journey row (FOR UPDATE) and require the
 *     caller's `expectedUpdatedAt` (optimistic concurrency → 409 STALE).
 *   • Archived journeys are read-only; steps are editable on drafts only.
 *   • Publishing freezes the canonical steps as version N+1 (sha256 hash);
 *     versions have no update/delete path. A journey with versions is archived,
 *     never deleted (FK RESTRICT is the backstop).
 *   • Media (Phase 3C-3): image/audio steps reference an uploaded asset of the
 *     same kind. Uploads are validated from their actual bytes (demoChatMedia),
 *     stored through the shared storage facade (R2 / local, generated keys)
 *     and recorded with an audit row; a database failure removes the stored
 *     object again. Assets used by any step, version or message are never
 *     deleted.
 *   • Nothing here assigns journeys to profiles or enables the chat: that is
 *     demoChatAssignmentService.js (Phase 3C-9B), the only writer of the
 *     protected "demo-chat-config" row. Both gates ship off — see demoChatGate.js.
 *   • A journey used by an ENABLED assignment cannot be archived (409 IN_USE).
 * All access goes through the demo DB seam (getDemoDb) and touches only the
 * demo_chat_* tables and the reserved "demo-chat-config" settings row (read).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDemoDb } from './demoService.js';
import { saveMedia } from '../cloudinary.js';
import { destroyDemoChatMedia } from '../demoChatStorage.js';
import { processChatImage, processVoiceNote } from '../demoChatMedia.js';
import { httpError as err, toHttpError } from '../demoChatErrors.js';
import { readDemoChatGates } from '../demoChatGate.js';
import { LIVE_ACTIVITY_TIMEZONE } from '../liveActivityTime.js';
import { CHAT_TIMEZONE, isDateKey, addDays, localParts, utcDayStart, zonedTimeToUtc } from '../demoChatTime.js';
import { visibleMessages } from '../demoChatSchedule.js';
import { buildEarningsContext, resolvePeriod, renderEarningsText, LABELS as EARNINGS_LABELS } from '../demoChatEarnings.js';
import { PROFILE_META_PREFIX } from '../demoProfileValidation.js';
import { SIM_PARTICIPANTS_PREFIX } from '../demoSimCoverage.js';
import {
  isValidChatId, validateJourneyInput, validateStepInput, validateReorderInput,
  readExpectedUpdatedAt, canonicalSteps, validateForPublish, renderPreviewText,
  PREVIEW_SAMPLE, JOURNEY_DAYS, MAX_STEPS, MEDIA_STEP_TYPES, ASSET_KINDS,
} from '../demoChatValidation.js';

// Storage + ffprobe seams: the real facade in production, fakes in tests.
// destroyDemoChatMedia = shared destroyByUrl + cleanup of demo-chat-owned LOCAL files.
const DEFAULT_STORAGE = { save: saveMedia, destroy: destroyDemoChatMedia };
let _storage = DEFAULT_STORAGE;
let _audioDeps;
export function __setDemoChatStorage(storage) { _storage = storage || DEFAULT_STORAGE; }
export function __setDemoChatAudioDeps(deps) { _audioDeps = deps || undefined; }

export const ASSET_STORAGE = Object.freeze({
  image: { folder: 'demo/chat/images', category: 'demo-chat-images' },
  audio: { folder: 'demo/chat/audio', category: 'demo-chat-audio' },
});

export const ACTIONS = Object.freeze({
  JOURNEY_CREATE: 'JOURNEY_CREATE', JOURNEY_UPDATE: 'JOURNEY_UPDATE',
  JOURNEY_ARCHIVE: 'JOURNEY_ARCHIVE', JOURNEY_UNARCHIVE: 'JOURNEY_UNARCHIVE', JOURNEY_DELETE: 'JOURNEY_DELETE',
  STEP_CREATE: 'STEP_CREATE', STEP_UPDATE: 'STEP_UPDATE', STEP_DELETE: 'STEP_DELETE', STEPS_REORDER: 'STEPS_REORDER',
  VERSION_PUBLISH: 'VERSION_PUBLISH',
  ASSET_UPLOAD: 'ASSET_UPLOAD', ASSET_DELETE: 'ASSET_DELETE',
  // Phase 3C-9B — demoChatAssignmentService.js
  ASSIGNMENT_CREATE: 'ASSIGNMENT_CREATE', ASSIGNMENT_UPDATE: 'ASSIGNMENT_UPDATE',
  ASSIGNMENT_ENABLE: 'ASSIGNMENT_ENABLE', ASSIGNMENT_DISABLE: 'ASSIGNMENT_DISABLE',
  CHAT_ENABLE: 'CHAT_ENABLE', CHAT_DISABLE: 'CHAT_DISABLE',
});
export const PREVIEW_DISCLOSURE = 'Simulation — aperçu administrateur. Les valeurs de gains affichées sont des exemples, pas des données réelles ni démo.';

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const stepView = (s) => ({
  id: s.id, day: s.day, time: s.time, position: s.position, type: s.type, text: s.text,
  earningsPeriod: s.earningsPeriod, metric: s.metric, assetId: s.assetId ?? null, updatedAt: s.updatedAt ? iso(s.updatedAt) : null,
});
const assetView = (a) => ({
  id: a.id, kind: a.kind, url: a.url, mimeType: a.mimeType, formatDetected: a.formatDetected, bytes: a.bytes,
  width: a.width ?? null, height: a.height ?? null, durationSec: a.durationSec ?? null, createdAt: a.createdAt ? iso(a.createdAt) : null,
});

/** Assets by id (only the ids asked for). */
async function assetsById(db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const rows = await Promise.all(unique.map((id) => db.demoChatAsset.findUnique({ where: { id } })));
  return Object.fromEntries(rows.filter(Boolean).map((a) => [a.id, assetView(a)]));
}

/** A media step's asset must exist and match the step type. */
async function assertStepAsset(tx, step) {
  if (!MEDIA_STEP_TYPES.includes(step.type)) return;
  const asset = await tx.demoChatAsset.findUnique({ where: { id: step.assetId } });
  if (!asset) throw err(404, 'ASSET_NOT_FOUND', 'Média introuvable dans la bibliothèque.', 'assetId');
  if (asset.kind !== step.type) throw err(400, 'ASSET_KIND', step.type === 'image' ? 'Ce média n’est pas une image.' : 'Ce média n’est pas une note vocale.', 'assetId');
}
const orderSteps = (a, b) => a.day - b.day || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) || a.position - b.position;
export const hashSteps = (canonical) => createHash('sha256').update(JSON.stringify(canonical)).digest('hex');

/** Insert-only audit write — the ONLY way the demo-chat services touch the audit table. */
export async function writeAudit(tx, { action, entityType, entityId, actorId, before = null, after = null, reason = null, at }) {
  await tx.demoChatAuditLog.create({
    data: { action, entityType, entityId, actorType: 'ADMIN', actorId: actorId ?? null, before, after, reason, createdAt: new Date(at) },
  });
}

/** Run fn(tx) in a transaction; database errors become safe httpErrors. */
async function inTx(db, ctx, fn) {
  try {
    return await db.$transaction(fn);
  } catch (e) {
    throw toHttpError(e, ctx);
  }
}

/** Lock the journey row and check existence, concurrency token and (optionally) draft status. */
async function lockJourney(tx, id, expected, { requireDraft = true } = {}) {
  const rows = await tx.$queryRaw`SELECT "id", "status", "updatedAt" FROM "demo_chat_journeys" WHERE "id" = ${id} FOR UPDATE`;
  const row = rows?.[0];
  if (!row) throw err(404, 'NOT_FOUND', 'Parcours introuvable.');
  if (iso(row.updatedAt) !== expected) throw err(409, 'STALE', 'Parcours modifié entre-temps : rechargez la page.');
  if (requireDraft && row.status !== 'draft') throw err(409, 'ARCHIVED', 'Parcours archivé : lecture seule.');
  return row;
}

const touch = (tx, id, at) => tx.demoChatJourney.update({ where: { id }, data: { updatedAt: new Date(at) } });

function requireId(id, what = 'Parcours') {
  if (!isValidChatId(id)) throw err(404, 'NOT_FOUND', `${what} introuvable.`);
}

function requireExpected(body) {
  const expected = readExpectedUpdatedAt(body);
  if (!expected) throw err(400, 'VALIDATION', 'expectedUpdatedAt manquant : rechargez la page.', 'expectedUpdatedAt');
  return expected;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listJourneys() {
  const db = getDemoDb();
  const [journeys, steps, versions] = await Promise.all([
    db.demoChatJourney.findMany({ orderBy: { updatedAt: 'desc' } }),
    db.demoChatJourneyStep.findMany({ select: { journeyId: true } }),
    db.demoChatJourneyVersion.findMany({ select: { journeyId: true, version: true, publishedAt: true } }),
  ]);
  return {
    journeys: journeys.map((j) => {
      const vs = versions.filter((v) => v.journeyId === j.id);
      const latest = vs.reduce((m, v) => (!m || v.version > m.version ? v : m), null);
      return {
        id: j.id, name: j.name, description: j.description, status: j.status,
        stepCount: steps.filter((s) => s.journeyId === j.id).length,
        versionCount: vs.length,
        latestVersion: latest ? { version: latest.version, publishedAt: iso(latest.publishedAt) } : null,
        createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt),
      };
    }),
  };
}

export async function getJourney(id) {
  requireId(id);
  const db = getDemoDb();
  const j = await db.demoChatJourney.findUnique({ where: { id } });
  if (!j) throw err(404, 'NOT_FOUND', 'Parcours introuvable.');
  const [steps, versions] = await Promise.all([
    db.demoChatJourneyStep.findMany({ where: { journeyId: id } }),
    db.demoChatJourneyVersion.findMany({ where: { journeyId: id }, orderBy: { version: 'desc' } }),
  ]);
  const ordered = [...steps].sort(orderSteps);
  const assets = await assetsById(db, ordered.map((s) => s.assetId));
  const latest = versions[0] || null;
  const draftHash = ordered.length ? hashSteps(canonicalSteps(ordered)) : null;
  return {
    journey: {
      id: j.id, name: j.name, description: j.description, status: j.status, createdBy: j.createdBy,
      createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt),
    },
    steps: ordered.map(stepView),
    versions: versions.map((v) => ({
      id: v.id, version: v.version, publishedAt: iso(v.publishedAt), publishedBy: v.publishedBy,
      stepsHash: v.stepsHash, stepCount: Array.isArray(v.steps) ? v.steps.length : 0,
    })),
    assets,
    hasUnpublishedChanges: !!draftHash && (!latest || latest.stepsHash !== draftHash),
    limits: { maxSteps: MAX_STEPS, days: JOURNEY_DAYS },
  };
}

export async function listVersions(journeyId) {
  return { versions: (await getJourney(journeyId)).versions };
}

export async function getVersion(journeyId, versionId) {
  requireId(journeyId); requireId(versionId, 'Version');
  const db = getDemoDb();
  const v = await db.demoChatJourneyVersion.findUnique({ where: { id: versionId } });
  if (!v || v.journeyId !== journeyId) throw err(404, 'NOT_FOUND', 'Version introuvable.');
  return {
    version: {
      id: v.id, journeyId: v.journeyId, version: v.version, steps: v.steps, stepsHash: v.stepsHash,
      publishedAt: iso(v.publishedAt), publishedBy: v.publishedBy,
    },
  };
}

// ── Journey writes ────────────────────────────────────────────────────────────

export async function createJourney(input, { actorId = null, now = Date.now() } = {}) {
  const v = validateJourneyInput(input);
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  const db = getDemoDb();
  const j = await inTx(db, 'demo-chat create', async (tx) => {
    const created = await tx.demoChatJourney.create({
      data: { name: v.value.name, description: v.value.description ?? '', status: 'draft', createdBy: actorId, createdAt: new Date(now), updatedAt: new Date(now) },
    });
    await writeAudit(tx, { action: ACTIONS.JOURNEY_CREATE, entityType: 'journey', entityId: created.id, actorId, after: { name: created.name, description: created.description }, at: now });
    return created;
  });
  return getJourney(j.id);
}

/**
 * PATCH a journey: { expectedUpdatedAt, action: 'archive' | 'unarchive' }
 * or { expectedUpdatedAt, name?, description? } (drafts only).
 */
export async function updateJourney(id, body, { actorId = null, now = Date.now() } = {}) {
  requireId(id);
  const expected = requireExpected(body);
  const { expectedUpdatedAt, action, ...fields } = body || {};
  const db = getDemoDb();

  if (action !== undefined) {
    if (!['archive', 'unarchive'].includes(action) || Object.keys(fields).length) throw err(400, 'VALIDATION', 'Action inconnue.', 'action');
    await inTx(db, 'demo-chat archive', async (tx) => {
      const row = await lockJourney(tx, id, expected, { requireDraft: false });
      const target = action === 'archive' ? 'archived' : 'draft';
      if (row.status === target) throw err(409, 'NO_CHANGES', action === 'archive' ? 'Déjà archivé.' : 'Déjà actif.');
      if (action === 'archive') {
        // Assignment writes lock the journey FOR SHARE, so this count cannot race an enable.
        const inUse = await tx.demoChatAssignment.count({ where: { enabled: true, version: { journeyId: id } } });
        if (inUse > 0) throw err(409, 'IN_USE', `Parcours utilisé par ${inUse} attribution(s) active(s) : désactivez-les avant d'archiver.`);
      }
      await tx.demoChatJourney.update({ where: { id }, data: { status: target, updatedAt: new Date(now) } });
      await writeAudit(tx, { action: action === 'archive' ? ACTIONS.JOURNEY_ARCHIVE : ACTIONS.JOURNEY_UNARCHIVE, entityType: 'journey', entityId: id, actorId, before: { status: row.status }, after: { status: target }, at: now });
    });
    return getJourney(id);
  }

  const v = validateJourneyInput(fields, { partial: true });
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  await inTx(db, 'demo-chat update', async (tx) => {
    await lockJourney(tx, id, expected);
    const cur = await tx.demoChatJourney.findUnique({ where: { id } });
    const before = {}; const after = {};
    for (const [k, val] of Object.entries(v.value)) if (cur[k] !== val) { before[k] = cur[k]; after[k] = val; }
    if (!Object.keys(after).length) throw err(409, 'NO_CHANGES', 'Aucune modification.');
    await tx.demoChatJourney.update({ where: { id }, data: { ...after, updatedAt: new Date(now) } });
    await writeAudit(tx, { action: ACTIONS.JOURNEY_UPDATE, entityType: 'journey', entityId: id, actorId, before, after, at: now });
  });
  return getJourney(id);
}

/** Delete a journey that was never published (its draft steps cascade). */
export async function deleteJourney(id, body, { actorId = null, now = Date.now() } = {}) {
  requireId(id);
  const expected = requireExpected(body);
  const db = getDemoDb();
  await inTx(db, 'demo-chat delete', async (tx) => {
    await lockJourney(tx, id, expected, { requireDraft: false });
    const versions = await tx.demoChatJourneyVersion.count({ where: { journeyId: id } });
    if (versions > 0) throw err(409, 'REFERENCED', 'Ce parcours a des versions publiées : archivez-le au lieu de le supprimer.');
    const j = await tx.demoChatJourney.findUnique({ where: { id } });
    const stepCount = await tx.demoChatJourneyStep.count({ where: { journeyId: id } });
    await tx.demoChatJourney.delete({ where: { id } });
    await writeAudit(tx, { action: ACTIONS.JOURNEY_DELETE, entityType: 'journey', entityId: id, actorId, before: { name: j.name, status: j.status, stepCount }, at: now });
  });
  return { deleted: true, id };
}

// ── Step writes (drafts only) ─────────────────────────────────────────────────

const SLOT_TAKEN = () => err(409, 'SLOT_TAKEN', 'Une étape existe déjà à ce jour, cette heure et cet ordre.', 'time');

async function assertSlotFree(tx, journeyId, { day, time, position }, exceptId = null) {
  const clash = await tx.demoChatJourneyStep.findFirst({ where: { journeyId, day, time, position } });
  if (clash && clash.id !== exceptId) throw SLOT_TAKEN();
}

export async function createStep(journeyId, body, { actorId = null, now = Date.now() } = {}) {
  requireId(journeyId);
  const expected = requireExpected(body);
  const { expectedUpdatedAt, ...input } = body || {};
  const v = validateStepInput(input);
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  const db = getDemoDb();
  await inTx(db, 'demo-chat step create', async (tx) => {
    await lockJourney(tx, journeyId, expected);
    if ((await tx.demoChatJourneyStep.count({ where: { journeyId } })) >= MAX_STEPS) throw err(409, 'LIMIT', `${MAX_STEPS} étapes maximum.`);
    await assertSlotFree(tx, journeyId, v.value);
    await assertStepAsset(tx, v.value);
    let step;
    try {
      step = await tx.demoChatJourneyStep.create({ data: { journeyId, ...v.value, createdAt: new Date(now), updatedAt: new Date(now) } });
    } catch (e) { if (e?.code === 'P2002') throw SLOT_TAKEN(); throw e; }
    await touch(tx, journeyId, now);
    await writeAudit(tx, { action: ACTIONS.STEP_CREATE, entityType: 'step', entityId: step.id, actorId, after: { journeyId, ...v.value }, at: now });
  });
  return getJourney(journeyId);
}

export async function updateStep(journeyId, stepId, body, { actorId = null, now = Date.now() } = {}) {
  requireId(journeyId); requireId(stepId, 'Étape');
  const expected = requireExpected(body);
  const { expectedUpdatedAt, ...patch } = body || {};
  if (!Object.keys(patch).length) throw err(400, 'VALIDATION', 'Aucun champ à modifier.');
  const db = getDemoDb();
  await inTx(db, 'demo-chat step update', async (tx) => {
    await lockJourney(tx, journeyId, expected);
    const cur = await tx.demoChatJourneyStep.findUnique({ where: { id: stepId } });
    if (!cur || cur.journeyId !== journeyId) throw err(404, 'NOT_FOUND', 'Étape introuvable.');
    const merged = { day: cur.day, time: cur.time, position: cur.position, type: cur.type, text: cur.text, earningsPeriod: cur.earningsPeriod, metric: cur.metric, assetId: cur.assetId ?? null, ...patch };
    // Switching type drops the fields the new type cannot carry (unless sent explicitly).
    if (merged.type !== 'earnings') { if (!('earningsPeriod' in patch)) merged.earningsPeriod = null; if (!('metric' in patch)) merged.metric = null; }
    if (!MEDIA_STEP_TYPES.includes(merged.type) && !('assetId' in patch)) merged.assetId = null;
    const v = validateStepInput(merged);
    if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
    const before = {}; const after = {};
    for (const [k, val] of Object.entries(v.value)) if (cur[k] !== val) { before[k] = cur[k]; after[k] = val; }
    if (!Object.keys(after).length) throw err(409, 'NO_CHANGES', 'Aucune modification.');
    await assertSlotFree(tx, journeyId, v.value, stepId);
    await assertStepAsset(tx, v.value);
    try {
      await tx.demoChatJourneyStep.update({ where: { id: stepId }, data: { ...after, updatedAt: new Date(now) } });
    } catch (e) { if (e?.code === 'P2002') throw SLOT_TAKEN(); throw e; }
    await touch(tx, journeyId, now);
    await writeAudit(tx, { action: ACTIONS.STEP_UPDATE, entityType: 'step', entityId: stepId, actorId, before, after, at: now });
  });
  return getJourney(journeyId);
}

export async function deleteStep(journeyId, stepId, body, { actorId = null, now = Date.now() } = {}) {
  requireId(journeyId); requireId(stepId, 'Étape');
  const expected = requireExpected(body);
  const db = getDemoDb();
  await inTx(db, 'demo-chat step delete', async (tx) => {
    await lockJourney(tx, journeyId, expected);
    const cur = await tx.demoChatJourneyStep.findUnique({ where: { id: stepId } });
    if (!cur || cur.journeyId !== journeyId) throw err(404, 'NOT_FOUND', 'Étape introuvable.');
    await tx.demoChatJourneyStep.delete({ where: { id: stepId } });
    await touch(tx, journeyId, now);
    await writeAudit(tx, { action: ACTIONS.STEP_DELETE, entityType: 'step', entityId: stepId, actorId, before: stepView(cur), at: now });
  });
  return getJourney(journeyId);
}

/**
 * Reorder steps that share a slot: { expectedUpdatedAt, steps: [{ id, position }] }.
 * Two passes (park at position+100, then final) so the unique
 * (journeyId, day, time, position) index never sees a transient duplicate.
 */
export async function reorderSteps(journeyId, body, { actorId = null, now = Date.now() } = {}) {
  requireId(journeyId);
  const expected = requireExpected(body);
  const v = validateReorderInput(body);
  if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
  const db = getDemoDb();
  await inTx(db, 'demo-chat reorder', async (tx) => {
    await lockJourney(tx, journeyId, expected);
    const all = await tx.demoChatJourneyStep.findMany({ where: { journeyId } });
    const byId = new Map(all.map((s) => [s.id, s]));
    if (v.value.some((it) => !byId.has(it.id))) throw err(404, 'NOT_FOUND', 'Étape introuvable dans ce parcours.');
    const moved = new Map(v.value.map((it) => [it.id, it.position]));
    const finalSlots = new Set();
    for (const s of all) {
      const k = `${s.day}|${s.time}|${moved.has(s.id) ? moved.get(s.id) : s.position}`;
      if (finalSlots.has(k)) throw SLOT_TAKEN();
      finalSlots.add(k);
    }
    const changed = v.value.filter((it) => byId.get(it.id).position !== it.position);
    if (!changed.length) throw err(409, 'NO_CHANGES', 'Aucune modification.');
    for (const it of changed) await tx.demoChatJourneyStep.update({ where: { id: it.id }, data: { position: it.position + 100 } });
    for (const it of changed) await tx.demoChatJourneyStep.update({ where: { id: it.id }, data: { position: it.position, updatedAt: new Date(now) } });
    await touch(tx, journeyId, now);
    await writeAudit(tx, {
      action: ACTIONS.STEPS_REORDER, entityType: 'journey', entityId: journeyId, actorId,
      before: changed.map((it) => ({ id: it.id, position: byId.get(it.id).position })),
      after: changed.map((it) => ({ id: it.id, position: it.position })), at: now,
    });
  });
  return getJourney(journeyId);
}

// ── Publish ───────────────────────────────────────────────────────────────────

/** Freeze the current draft as version N+1. Body: { expectedUpdatedAt }. */
export async function publishJourney(journeyId, body, { actorId = null, now = Date.now() } = {}) {
  requireId(journeyId);
  const expected = requireExpected(body);
  const db = getDemoDb();
  const version = await inTx(db, 'demo-chat publish', async (tx) => {
    await lockJourney(tx, journeyId, expected);
    const steps = await tx.demoChatJourneyStep.findMany({ where: { journeyId } });
    const check = validateForPublish(steps);
    if (!check.ok) throw err(400, 'VALIDATION', check.error, check.field);
    for (const s of steps) await assertStepAsset(tx, s);
    const canonical = canonicalSteps(steps);
    const stepsHash = hashSteps(canonical);
    const latest = await tx.demoChatJourneyVersion.findFirst({ where: { journeyId }, orderBy: { version: 'desc' } });
    if (latest && latest.stepsHash === stepsHash) throw err(409, 'NO_CHANGES', `Aucun changement depuis la version ${latest.version}.`);
    let created;
    try {
      created = await tx.demoChatJourneyVersion.create({
        data: { journeyId, version: (latest?.version ?? 0) + 1, steps: canonical, stepsHash, publishedAt: new Date(now), publishedBy: actorId },
      });
    } catch (e) {
      if (e?.code === 'P2002') throw err(409, 'CONFLICT', 'Publication concurrente : rechargez la page.');
      throw e;
    }
    const assetIds = [...new Set(canonical.map((s) => s.assetId).filter(Boolean))];
    for (const assetId of assetIds) await tx.demoChatVersionAsset.create({ data: { versionId: created.id, assetId } });
    await writeAudit(tx, {
      action: ACTIONS.VERSION_PUBLISH, entityType: 'version', entityId: created.id, actorId,
      after: { journeyId, version: created.version, stepsHash, stepCount: canonical.length }, at: now,
    });
    return created;
  });
  return { version: { id: version.id, version: version.version, stepsHash: version.stepsHash, publishedAt: iso(version.publishedAt) }, ...(await getJourney(journeyId)) };
}

// ── Preview (no writes) ───────────────────────────────────────────────────────

/** 30-day timeline of a draft (journeyId) or a published version (versionId). */
export async function previewTimeline({ journeyId, versionId } = {}) {
  let steps; let source;
  if (versionId) {
    if (!journeyId) throw err(400, 'VALIDATION', 'journeyId requis.', 'journeyId');
    const { version } = await getVersion(journeyId, versionId);
    steps = Array.isArray(version.steps) ? version.steps : [];
    source = { kind: 'version', journeyId, versionId, version: version.version };
  } else {
    const { steps: draft } = await getJourney(journeyId);
    steps = draft;
    source = { kind: 'draft', journeyId };
  }
  const ordered = [...steps].sort(orderSteps);
  const assets = await assetsById(getDemoDb(), ordered.map((s) => s.assetId));
  const days = Array.from({ length: JOURNEY_DAYS }, (_, i) => ({
    day: i + 1,
    messages: ordered.filter((s) => s.day === i + 1).map((s) => ({
      id: s.id, time: s.time, type: s.type, metric: s.metric ?? null, earningsPeriod: s.earningsPeriod ?? null,
      text: renderPreviewText(s), usesSampleValues: s.type === 'earnings',
      asset: s.assetId ? (assets[s.assetId] || null) : null,
    })),
  }));
  return { source, timezone: LIVE_ACTIVITY_TIMEZONE, disclosure: PREVIEW_DISCLOSURE, sampleValues: PREVIEW_SAMPLE, simulated: true, days };
}

// ── Schedule preview (Phase 3C-4, no writes) ─────────────────────────────────

export const SCHEDULE_PREVIEW_DISCLOSURE = 'Simulation — aperçu administrateur. Messages visibles à la date choisie (heure de Casablanca), gains lus dans l’historique DÉMO du profil — jamais de données réelles. Rien n’est enregistré.';
const DAY_MS = 86_400_000;

/** Steps of a draft (journeyId) or a published version (versionId). */
async function previewSteps(journeyId, versionId) {
  if (versionId) {
    const { version } = await getVersion(journeyId, versionId);
    return { steps: Array.isArray(version.steps) ? version.steps : [], source: { kind: 'version', journeyId, versionId, version: version.version } };
  }
  const { steps } = await getJourney(journeyId);
  return { steps, source: { kind: 'draft', journeyId } };
}

/** Read-only demo earnings inputs for the given message dates (history, coverage, participation, admin markers). */
export async function loadEarningsContext(db, profile, dates, nowMs) {
  const sorted = [...dates].sort();
  const firstDay = addDays(sorted[0], -9); const lastDay = addDays(sorted[sorted.length - 1], 2);
  const from = utcDayStart(addDays(sorted[0], -8)) - DAY_MS; // week + neighbours (ambiguity check)
  const to = utcDayStart(addDays(sorted[sorted.length - 1], 1)) + DAY_MS;
  const dayKeys = []; for (let k = firstDay; k <= lastDay; k = addDays(k, 1)) dayKeys.push(k);
  const [history, coverage, meta, participantRows] = await Promise.all([
    db.demoEarningsHistory.findMany({
      where: { demoAffiliateId: profile.id, date: { gte: new Date(from), lt: new Date(to) } },
      select: { id: true, date: true, orders: true, revenue: true, commission: true },
    }),
    db.demoSimDayCoverage.findMany({ where: { day: { gte: new Date(from), lt: new Date(to) } } }),
    db.setting.findUnique({ where: { id: `${PROFILE_META_PREFIX}${profile.id}` } }),
    db.setting.findMany({ where: { id: { in: dayKeys.map((k) => `${SIM_PARTICIPANTS_PREFIX}${k}`) } } }),
  ]);
  const participants = Object.fromEntries(participantRows.map((r) => [r.id.slice(SIM_PARTICIPANTS_PREFIX.length), Array.isArray(r.data?.ids) ? r.data.ids : []]));
  return buildEarningsContext({ history, coverage, participants, profileId: profile.id, markers: meta?.data || {}, profileCreatedAt: profile.createdAt, nowMs, tz: CHAT_TIMEZONE });
}

/**
 * What a demo profile's chat would show at a given moment, for a hypothetical
 * assignment starting on `anchorDate` (Casablanca day 1). Pure read: creates
 * no assignment or message and never writes earnings history.
 * Input: { journeyId, versionId?, demoAffiliateId, anchorDate: 'YYYY-MM-DD',
 *          at?: ISO instant | { atDate, atTime } (Casablanca wall time), locale?: 'ar' | 'fr' }
 */
export async function previewSchedule({ journeyId, versionId, demoAffiliateId, anchorDate, at, atDate, atTime, locale = 'ar' } = {}) {
  requireId(journeyId);
  if (versionId) requireId(versionId, 'Version');
  requireId(demoAffiliateId, 'Profil démo');
  if (!isDateKey(anchorDate)) throw err(400, 'VALIDATION', 'Date du jour 1 invalide (AAAA-MM-JJ, calendrier de Casablanca).', 'anchorDate');
  if (!Object.prototype.hasOwnProperty.call(EARNINGS_LABELS, locale)) throw err(400, 'VALIDATION', 'Langue : ar ou fr.', 'locale');
  let nowMs;
  if (atDate !== undefined || atTime !== undefined) {
    if (!isDateKey(atDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(atTime))) throw err(400, 'VALIDATION', 'Date/heure de Casablanca invalide.', 'atDate');
    nowMs = zonedTimeToUtc(atDate, atTime, CHAT_TIMEZONE).ms;
  } else if (at === undefined || at === null || at === '') {
    nowMs = Date.now();
  } else {
    nowMs = Date.parse(at);
    if (!Number.isFinite(nowMs)) throw err(400, 'VALIDATION', 'Instant invalide.', 'at');
  }

  const { steps, source } = await previewSteps(journeyId, versionId);
  const db = getDemoDb();
  const profile = await db.demoAffiliate.findUnique({ where: { id: demoAffiliateId } });
  if (!profile) throw err(404, 'NOT_FOUND', 'Profil démo introuvable.', 'demoAffiliateId');

  const { position, messages } = visibleMessages({ steps, anchorDate, nowMs, tz: CHAT_TIMEZONE });
  const earningDates = messages.filter((m) => m.type === 'earnings').map((m) => m.date);
  const ctx = earningDates.length ? await loadEarningsContext(db, profile, earningDates, nowMs) : null;
  const assets = await assetsById(db, messages.map((m) => m.assetId));

  return {
    source, timezone: CHAT_TIMEZONE, anchorDate, at: iso(nowMs), atLocal: localParts(nowMs, CHAT_TIMEZONE), locale,
    simulated: true, writes: 'none', disclosure: SCHEDULE_PREVIEW_DISCLOSURE,
    profile: { id: profile.id, name: profile.name, username: profile.username, isActive: profile.isActive },
    cycle: position.started
      ? { started: true, loopIndex: position.loopIndex, day: position.day, cycleStart: position.cycleStart, cycleEnd: position.cycleEnd, today: position.today, previousCyclesHidden: position.previousCycles }
      : { started: false, startsOn: position.startsOn, today: position.today },
    messages: messages.map((m) => {
      const base = {
        stepId: m.stepId, day: m.day, time: m.time, position: m.position ?? 0, loopIndex: m.loopIndex, date: m.date,
        scheduledAt: iso(m.scheduledAtMs), localTime: localParts(m.scheduledAtMs, CHAT_TIMEZONE).time, timeAdjustment: m.timeAdjustment, type: m.type,
      };
      if (m.type !== 'earnings') return { ...base, state: 'ok', text: m.text ?? null, asset: m.assetId ? (assets[m.assetId] || null) : null };
      const res = resolvePeriod(ctx, m.earningsPeriod, m.date);
      const rendered = renderEarningsText({ text: m.text, metric: m.metric, resolution: res, locale });
      const { status, reason, period, ...values } = res;
      return { ...base, metric: m.metric, earningsPeriod: m.earningsPeriod, metricLabel: rendered.metricLabel ?? null, state: rendered.state, text: rendered.text, earnings: { status, reason, ...values } };
    }),
  };
}

// ── Media assets (Phase 3C-3) ─────────────────────────────────────────────────

/** Remove a stored object after a failed database write; never throws. */
async function compensateStorage(stored, why) {
  try {
    const r = await _storage.destroy(stored.url);
    if (!r?.ok) console.error(`[demo-chat asset] ORPHANED OBJECT after ${why} — remove manually:`, { url: stored.url, key: stored.key ?? null, reason: r?.reason || r?.error || 'unknown' });
  } catch (e) {
    console.error(`[demo-chat asset] ORPHANED OBJECT after ${why} — remove manually:`, { url: stored.url, key: stored.key ?? null, error: e?.message });
  }
}

/**
 * Upload one image or voice note. The bytes are validated and normalised
 * first (nothing is stored on rejection); identical content returns the
 * existing asset. Storage key = <category>/<random uuid>.<detected ext> —
 * never derived from the client's filename.
 */
export async function uploadAsset(kind, buffer, { actorId = null, now = Date.now() } = {}) {
  if (!ASSET_KINDS.includes(kind)) throw err(400, 'VALIDATION', 'Type de média : image ou audio.', 'kind');
  let media;
  try {
    media = kind === 'image' ? await processChatImage(buffer) : await processVoiceNote(buffer, _audioDeps);
  } catch (e) {
    if (e?.mediaError) throw err(e.status, e.code, e.message, 'file');
    throw e;
  }
  const sha256 = createHash('sha256').update(media.buffer).digest('hex');
  const db = getDemoDb();
  const existing = await db.demoChatAsset.findUnique({ where: { sha256 } });
  if (existing) return { asset: assetView(existing), deduplicated: true };

  const cfg = ASSET_STORAGE[kind];
  let stored;
  try {
    stored = await _storage.save(media.buffer, {
      filename: `${randomUUID()}.${media.ext}`, folder: cfg.folder, subdir: cfg.folder, category: cfg.category,
      deterministic: true, resourceType: kind === 'image' ? 'image' : 'video', contentType: media.mimeType,
    });
  } catch (e) {
    console.error('[demo-chat asset] storage upload failed:', e?.message);
    throw err(502, 'STORAGE_FAILED', "Échec de l'enregistrement du fichier : réessayez.");
  }
  if (!stored?.url) throw err(502, 'STORAGE_FAILED', "Échec de l'enregistrement du fichier : réessayez.");

  const data = {
    kind, url: stored.url, storageKey: stored.key ?? stored.publicId ?? null, mimeType: media.mimeType,
    formatDetected: kind === 'image' ? media.inputFormat : `${media.inputFormat}/${media.inputCodec}→${media.format}/${media.codec}`,
    bytes: media.bytes, sha256, width: media.width ?? null, height: media.height ?? null,
    durationSec: media.durationSec ?? null, createdBy: actorId, createdAt: new Date(now),
  };
  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.demoChatAsset.create({ data });
      await writeAudit(tx, {
        action: ACTIONS.ASSET_UPLOAD, entityType: 'asset', entityId: created.id, actorId,
        after: { kind, mimeType: data.mimeType, formatDetected: data.formatDetected, bytes: data.bytes, width: data.width, height: data.height, durationSec: data.durationSec, sha256, storageKey: data.storageKey, validator: media.validator ?? 'sharp' },
        at: now,
      });
      return created;
    });
    return { asset: assetView(row), deduplicated: false };
  } catch (e) {
    await compensateStorage(stored, 'database failure');
    if (e?.code === 'P2002') {
      const winner = await db.demoChatAsset.findUnique({ where: { sha256 } });
      if (winner) return { asset: assetView(winner), deduplicated: true };
    }
    throw toHttpError(e, 'demo-chat asset upload');
  }
}

export async function listAssets({ kind } = {}) {
  if (kind !== undefined && !ASSET_KINDS.includes(kind)) throw err(400, 'VALIDATION', 'Type de média : image ou audio.', 'kind');
  const db = getDemoDb();
  const [rows, steps, links, messages] = await Promise.all([
    db.demoChatAsset.findMany({ where: kind ? { kind } : {}, orderBy: { createdAt: 'desc' } }),
    db.demoChatJourneyStep.findMany({ select: { assetId: true } }),
    db.demoChatVersionAsset.findMany({ select: { assetId: true } }),
    db.demoChatMessage.findMany({ select: { assetId: true } }),
  ]);
  const count = (list, id) => list.filter((x) => x.assetId === id).length;
  return {
    assets: rows.map((a) => {
      const usage = { steps: count(steps, a.id), versions: count(links, a.id), messages: count(messages, a.id) };
      return { ...assetView(a), usage, deletable: !usage.steps && !usage.versions && !usage.messages };
    }),
  };
}

/** Delete an asset nothing references (draft step, published version or message). */
export async function deleteAsset(id, { actorId = null, now = Date.now() } = {}) {
  requireId(id, 'Média');
  const db = getDemoDb();
  const removed = await inTx(db, 'demo-chat asset delete', async (tx) => {
    const rows = await tx.$queryRaw`SELECT "id" FROM "demo_chat_assets" WHERE "id" = ${id} FOR UPDATE`;
    if (!rows?.length) throw err(404, 'NOT_FOUND', 'Média introuvable.');
    const usage = {
      steps: await tx.demoChatJourneyStep.count({ where: { assetId: id } }),
      versions: await tx.demoChatVersionAsset.count({ where: { assetId: id } }),
      messages: await tx.demoChatMessage.count({ where: { assetId: id } }),
    };
    if (usage.steps || usage.versions || usage.messages) {
      throw err(409, 'ASSET_IN_USE', `Média utilisé (${usage.steps} étape(s) en brouillon, ${usage.versions} version(s) publiée(s), ${usage.messages} message(s)) : suppression impossible.`);
    }
    const asset = await tx.demoChatAsset.findUnique({ where: { id } });
    await tx.demoChatAsset.delete({ where: { id } });
    await writeAudit(tx, { action: ACTIONS.ASSET_DELETE, entityType: 'asset', entityId: id, actorId, before: { ...assetView(asset), sha256: asset.sha256, storageKey: asset.storageKey ?? null }, at: now });
    return asset;
  });
  // The row is gone first (no dangling reference); the object is then removed.
  let storage;
  try { storage = await _storage.destroy(removed.url); } catch (e) { storage = { ok: false, error: e?.message }; }
  if (!storage?.ok && !storage?.skipped) console.error('[demo-chat asset] stored object not removed — remove manually:', { url: removed.url, key: removed.storageKey ?? null, error: storage?.error });
  return { deleted: true, id, storage: { ok: !!storage?.ok, skipped: !!storage?.skipped, reason: storage?.reason ?? null } };
}

// ── Audit (read-only) & status ────────────────────────────────────────────────

export async function listAudit({ entityType, entityId, before, limit = 50 } = {}) {
  const db = getDemoDb();
  const take = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const where = {};
  if (entityType) { if (!['journey', 'step', 'version', 'asset', 'assignment', 'config'].includes(entityType)) throw err(400, 'VALIDATION', 'entityType invalide.', 'entityType'); where.entityType = entityType; }
  if (entityId) { requireId(entityId, 'Élément'); where.entityId = entityId; }
  if (before) { const d = Date.parse(before); if (Number.isNaN(d)) throw err(400, 'VALIDATION', 'Curseur invalide.', 'before'); where.createdAt = { lt: new Date(d) }; }
  const rows = await db.demoChatAuditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1 });
  const page = rows.slice(0, take);
  return {
    entries: page.map((r) => ({ id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, actorType: r.actorType, actorId: r.actorId, before: r.before, after: r.after, reason: r.reason, createdAt: iso(r.createdAt) })),
    nextBefore: rows.length > take ? iso(page[page.length - 1].createdAt) : null,
  };
}

export async function getChatStatus() {
  const db = getDemoDb();
  const gates = await readDemoChatGates(db);
  const [assignments, enabledAssignments] = await Promise.all([
    db.demoChatAssignment.count(),
    db.demoChatAssignment.count({ where: { enabled: true } }),
  ]);
  return {
    ...gates, assignments, enabledAssignments, phase: '3C-9B',
    note: "Attributions et interrupteur global : page « Attributions ». Le chat n'est visible que si la variable serveur ET le paramètre protégé sont activés.",
  };
}
