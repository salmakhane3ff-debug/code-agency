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
 *   • Image/audio steps are deferred to Phase 3C-3 (no asset upload yet).
 *   • Nothing here assigns journeys to profiles or enables the chat: both gates
 *     (env + protected setting) stay off — see demoChatGate.js.
 * All access goes through the demo DB seam (getDemoDb) and touches only the
 * demo_chat_* tables and the reserved "demo-chat-config" settings row (read).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import { getDemoDb } from './demoService.js';
import { httpError as err, toHttpError } from '../demoChatErrors.js';
import { readDemoChatGates } from '../demoChatGate.js';
import { LIVE_ACTIVITY_TIMEZONE } from '../liveActivityTime.js';
import {
  isValidChatId, validateJourneyInput, validateStepInput, validateReorderInput,
  readExpectedUpdatedAt, canonicalSteps, validateForPublish, renderPreviewText,
  PREVIEW_SAMPLE, JOURNEY_DAYS, MAX_STEPS,
} from '../demoChatValidation.js';

export const ACTIONS = Object.freeze({
  JOURNEY_CREATE: 'JOURNEY_CREATE', JOURNEY_UPDATE: 'JOURNEY_UPDATE',
  JOURNEY_ARCHIVE: 'JOURNEY_ARCHIVE', JOURNEY_UNARCHIVE: 'JOURNEY_UNARCHIVE', JOURNEY_DELETE: 'JOURNEY_DELETE',
  STEP_CREATE: 'STEP_CREATE', STEP_UPDATE: 'STEP_UPDATE', STEP_DELETE: 'STEP_DELETE', STEPS_REORDER: 'STEPS_REORDER',
  VERSION_PUBLISH: 'VERSION_PUBLISH',
});
export const PREVIEW_DISCLOSURE = 'Simulation — aperçu administrateur. Les valeurs de gains affichées sont des exemples, pas des données réelles ni démo.';

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const stepView = (s) => ({
  id: s.id, day: s.day, time: s.time, position: s.position, type: s.type, text: s.text,
  earningsPeriod: s.earningsPeriod, metric: s.metric, updatedAt: s.updatedAt ? iso(s.updatedAt) : null,
});
const orderSteps = (a, b) => a.day - b.day || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) || a.position - b.position;
export const hashSteps = (canonical) => createHash('sha256').update(JSON.stringify(canonical)).digest('hex');

/** Insert-only audit write — the ONLY way this module touches the audit table. */
async function writeAudit(tx, { action, entityType, entityId, actorId, before = null, after = null, reason = null, at }) {
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
    let step;
    try {
      step = await tx.demoChatJourneyStep.create({ data: { journeyId, ...v.value, assetId: null, createdAt: new Date(now), updatedAt: new Date(now) } });
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
    const merged = { day: cur.day, time: cur.time, position: cur.position, type: cur.type, text: cur.text, earningsPeriod: cur.earningsPeriod, metric: cur.metric, ...patch };
    if (merged.type === 'text') { if (!('earningsPeriod' in patch)) merged.earningsPeriod = null; if (!('metric' in patch)) merged.metric = null; }
    const v = validateStepInput(merged);
    if (!v.ok) throw err(400, 'VALIDATION', v.error, v.field);
    const before = {}; const after = {};
    for (const [k, val] of Object.entries(v.value)) if (cur[k] !== val) { before[k] = cur[k]; after[k] = val; }
    if (!Object.keys(after).length) throw err(409, 'NO_CHANGES', 'Aucune modification.');
    await assertSlotFree(tx, journeyId, v.value, stepId);
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
    const assetIds = [...new Set(canonical.map((s) => s.assetId).filter(Boolean))]; // always empty until 3C-3
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
  const days = Array.from({ length: JOURNEY_DAYS }, (_, i) => ({
    day: i + 1,
    messages: ordered.filter((s) => s.day === i + 1).map((s) => ({
      id: s.id, time: s.time, type: s.type, metric: s.metric ?? null, earningsPeriod: s.earningsPeriod ?? null,
      text: renderPreviewText(s), usesSampleValues: s.type === 'earnings',
    })),
  }));
  return { source, timezone: LIVE_ACTIVITY_TIMEZONE, disclosure: PREVIEW_DISCLOSURE, sampleValues: PREVIEW_SAMPLE, simulated: true, days };
}

// ── Audit (read-only) & status ────────────────────────────────────────────────

export async function listAudit({ entityType, entityId, before, limit = 50 } = {}) {
  const db = getDemoDb();
  const take = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const where = {};
  if (entityType) { if (!['journey', 'step', 'version'].includes(entityType)) throw err(400, 'VALIDATION', 'entityType invalide.', 'entityType'); where.entityType = entityType; }
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
  const gates = await readDemoChatGates(getDemoDb());
  return { ...gates, phase: '3C-2', note: "Création de parcours uniquement : aucune attribution aux profils ni activation dans cette phase." };
}
