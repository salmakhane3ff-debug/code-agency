/**
 * src/lib/services/demoChatAssignmentService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin assignment workflow of the DEMO Mini Chat (Phase 3C-9B): which
 * published journey version a demo profile plays, from which Casablanca day 1,
 * whether that conversation is enabled — and the global protected switch.
 * Simulation only; demo tables + the reserved "demo-chat-config" row only.
 *
 * Rules
 *   • One assignment per demo profile (unique demoAffiliateId). Created
 *     DISABLED. Every write: one transaction, row locks, one audit row
 *     (writeAudit, insert-only). Unchanged requests write nothing.
 *   • Optimistic concurrency: the caller sends the assignment's
 *     `expectedUpdatedAt` (absent when none exists yet) → 409 STALE otherwise.
 *   • Assign / reassign: profile active, version exists, its journey not
 *     archived, anchor = Casablanca date within today − 365 … today + 60.
 *     A reassignment (other version or anchor) bumps `revision`, DISABLES the
 *     assignment and clears `enabledAt`: earlier messages stay stored but are
 *     hidden (the feed shows the current revision only).
 *   • Lock order (deadlock-free, shared with journey archiving and the
 *     materializer): demo profile FOR SHARE → journey FOR SHARE → assignment
 *     FOR UPDATE. Archiving locks the journey FOR UPDATE and refuses while an
 *     enabled assignment uses it; the materializer holds the assignment FOR SHARE.
 *   • Global switch: this module is the ONLY writer of "demo-chat-config"
 *     (the generic /api/setting refuses it). Enabling needs the server env
 *     DEMO_CHAT_ENABLED === 'true' AND the typed confirmation "ACTIVER";
 *     disabling is always allowed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getDemoDb } from './demoService.js';
import { writeAudit, ACTIONS } from './demoChatService.js';
import { httpError as err, toHttpError } from '../demoChatErrors.js';
import { readDemoChatGates, DEMO_CHAT_SETTING_ID } from '../demoChatGate.js';
import { isValidChatId, readExpectedUpdatedAt } from '../demoChatValidation.js';
import { CHAT_TIMEZONE, isDateKey, addDays, localDateKey } from '../demoChatTime.js';

export const ANCHOR_MIN_DAYS_BACK = 365;
export const ANCHOR_MAX_DAYS_AHEAD = 60;
export const ENABLE_CONFIRMATION = 'ACTIVER';
const MAX_PROFILES = 500;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const anchorKey = (d) => new Date(d).toISOString().slice(0, 10); // @db.Date → 'YYYY-MM-DD'
const anchorDateValue = (key) => new Date(`${key}T00:00:00.000Z`);

/** Casablanca "today" and the accepted anchor range. */
export function anchorRange(now = Date.now()) {
  const today = localDateKey(now, CHAT_TIMEZONE);
  return { today, min: addDays(today, -ANCHOR_MIN_DAYS_BACK), max: addDays(today, ANCHOR_MAX_DAYS_AHEAD) };
}

function requireProfileId(id) {
  if (!isValidChatId(id)) throw err(404, 'NOT_FOUND', 'Profil démo introuvable.');
}

async function inTx(db, ctx, fn) {
  try {
    return await db.$transaction(fn);
  } catch (e) {
    throw toHttpError(e, ctx);
  }
}

function assignmentView(a) {
  if (!a) return null;
  return {
    id: a.id, versionId: a.versionId, anchorDate: anchorKey(a.anchorDate), revision: a.revision,
    enabled: a.enabled, enabledAt: iso(a.enabledAt), updatedBy: a.updatedBy ?? null,
    createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt),
    version: a.version ? {
      id: a.version.id, version: a.version.version,
      journeyId: a.version.journey?.id ?? a.version.journeyId, journeyName: a.version.journey?.name ?? null,
      journeyStatus: a.version.journey?.status ?? null,
    } : null,
  };
}

/** Optimistic concurrency against the locked row (null = none exists yet). */
function checkExpected(row, body) {
  const expected = readExpectedUpdatedAt(body);
  const current = row ? iso(row.updatedAt) : null;
  if (row && !expected) throw err(409, 'STALE', 'Une attribution existe déjà pour ce profil : rechargez la page.', 'expectedUpdatedAt');
  if (!row && body?.expectedUpdatedAt != null) throw err(409, 'STALE', "L'attribution a changé entre-temps : rechargez la page.", 'expectedUpdatedAt');
  if (row && expected !== current) throw err(409, 'STALE', "L'attribution a été modifiée entre-temps : rechargez la page.", 'expectedUpdatedAt');
}

async function lockProfile(tx, profileId) {
  const [p] = await tx.$queryRaw`SELECT "id", "isActive" FROM "demo_affiliates" WHERE "id" = ${profileId} FOR SHARE`;
  if (!p) throw err(404, 'NOT_FOUND', 'Profil démo introuvable.');
  return p;
}

async function lockVersionJourney(tx, versionId) {
  const version = await tx.demoChatJourneyVersion.findUnique({ where: { id: versionId }, select: { id: true, version: true, journeyId: true } });
  if (!version) throw err(404, 'NOT_FOUND', 'Version publiée introuvable.', 'versionId');
  const [journey] = await tx.$queryRaw`SELECT "id", "name", "status" FROM "demo_chat_journeys" WHERE "id" = ${version.journeyId} FOR SHARE`;
  if (!journey) throw err(404, 'NOT_FOUND', 'Parcours introuvable.', 'versionId');
  return { version, journey };
}

async function lockAssignment(tx, profileId) {
  const [row] = await tx.$queryRaw`SELECT "id", "demoAffiliateId", "versionId", "anchorDate", "revision", "enabled", "enabledAt", "updatedAt" FROM "demo_chat_assignments" WHERE "demoAffiliateId" = ${profileId} FOR UPDATE`;
  return row || null;
}

async function freshAssignment(db, profileId) {
  return assignmentView(await db.demoChatAssignment.findUnique({
    where: { demoAffiliateId: profileId },
    include: { version: { select: { id: true, version: true, journeyId: true, journey: { select: { id: true, name: true, status: true } } } } },
  }));
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Profiles (+ current assignment), assignable versions, gates, anchor range. */
export async function listAssignmentOverview({ q = '', status = 'all', now = Date.now(), env = process.env } = {}) {
  const db = getDemoDb();
  const term = String(q || '').trim().slice(0, 80);
  const where = {};
  if (status === 'active') where.isActive = true;
  else if (status !== 'all') throw err(400, 'VALIDATION', 'Filtre : active ou all.', 'status');
  if (term) where.OR = [{ name: { contains: term, mode: 'insensitive' } }, { username: { contains: term, mode: 'insensitive' } }];

  const profiles = await db.demoAffiliate.findMany({
    where, orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }], take: MAX_PROFILES,
    select: { id: true, name: true, username: true, avatarUrl: true, avatarColor: true, isActive: true },
  });
  const ids = profiles.map((p) => p.id);
  const [assignments, versions, gates] = await Promise.all([
    ids.length ? db.demoChatAssignment.findMany({
      where: { demoAffiliateId: { in: ids } },
      include: { version: { select: { id: true, version: true, journeyId: true, journey: { select: { id: true, name: true, status: true } } } } },
    }) : [],
    db.demoChatJourneyVersion.findMany({
      where: { journey: { status: 'draft' } },
      select: { id: true, version: true, publishedAt: true, steps: true, journey: { select: { id: true, name: true } } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    }),
    readDemoChatGates(db, env),
  ]);
  const byProfile = new Map(assignments.map((a) => [a.demoAffiliateId, a]));
  return {
    simulated: true,
    profiles: profiles.map((p) => ({ ...p, assignment: assignmentView(byProfile.get(p.id)) })),
    truncated: profiles.length === MAX_PROFILES,
    versions: versions.map((v) => ({
      id: v.id, version: v.version, publishedAt: iso(v.publishedAt), journeyId: v.journey.id, journeyName: v.journey.name,
      stepCount: Array.isArray(v.steps) ? v.steps.length : 0,
    })),
    gates,
    anchor: anchorRange(now),
    confirmation: ENABLE_CONFIRMATION,
  };
}

// ── Assign / reassign ─────────────────────────────────────────────────────────

/** PUT { versionId, anchorDate?, expectedUpdatedAt? } → create (201) or reassign. */
export async function assignVersion(profileId, body, { actorId = null, now = Date.now() } = {}) {
  requireProfileId(profileId);
  const versionId = body?.versionId;
  if (!isValidChatId(versionId)) throw err(400, 'VALIDATION', 'Choisissez une version publiée.', 'versionId');
  const range = anchorRange(now);
  const anchor = body?.anchorDate === undefined || body?.anchorDate === null || body?.anchorDate === '' ? range.today : body.anchorDate;
  if (!isDateKey(anchor)) throw err(400, 'VALIDATION', 'Date du jour 1 invalide (AAAA-MM-JJ, calendrier de Casablanca).', 'anchorDate');
  if (anchor < range.min || anchor > range.max) {
    throw err(400, 'VALIDATION', `Date du jour 1 hors limites : entre ${range.min} et ${range.max} (Casablanca).`, 'anchorDate');
  }

  const db = getDemoDb();
  const created = await inTx(db, 'demo-chat assign', async (tx) => {
    const profile = await lockProfile(tx, profileId);
    if (!profile.isActive) throw err(409, 'PROFILE_INACTIVE', 'Profil démo masqué (inactif) : réactivez-le avant de lui attribuer un parcours.');
    const { version, journey } = await lockVersionJourney(tx, versionId);
    if (journey.status !== 'draft') throw err(409, 'JOURNEY_ARCHIVED', 'Parcours archivé : choisissez une version d’un parcours actif.', 'versionId');
    const row = await lockAssignment(tx, profileId);
    checkExpected(row, body);
    const at = new Date(now);

    if (!row) {
      let a;
      try {
        a = await tx.demoChatAssignment.create({
          data: {
            demoAffiliateId: profileId, versionId, anchorDate: anchorDateValue(anchor), revision: 1,
            enabled: false, enabledAt: null, updatedBy: actorId, createdAt: at, updatedAt: at,
          },
        });
      } catch (e) {
        if (e?.code === 'P2002') throw err(409, 'CONFLICT', 'Attribution créée en parallèle : rechargez la page.');
        throw e;
      }
      await writeAudit(tx, {
        action: ACTIONS.ASSIGNMENT_CREATE, entityType: 'assignment', entityId: a.id, actorId,
        after: { demoAffiliateId: profileId, versionId, journeyId: journey.id, version: version.version, anchorDate: anchor, revision: 1, enabled: false },
        at: now,
      });
      return true;
    }

    const before = { versionId: row.versionId, anchorDate: anchorKey(row.anchorDate), revision: row.revision, enabled: row.enabled };
    if (row.versionId === versionId && before.anchorDate === anchor) throw err(409, 'NO_CHANGES', 'Aucun changement : même version et même jour 1.');
    const revision = row.revision + 1;
    await tx.demoChatAssignment.update({
      where: { id: row.id },
      data: { versionId, anchorDate: anchorDateValue(anchor), revision, enabled: false, enabledAt: null, updatedBy: actorId, updatedAt: at },
    });
    await writeAudit(tx, {
      action: ACTIONS.ASSIGNMENT_UPDATE, entityType: 'assignment', entityId: row.id, actorId, before,
      after: { versionId, journeyId: journey.id, version: version.version, anchorDate: anchor, revision, enabled: false },
      reason: 'reassignment: revision bumped, assignment disabled, earlier messages hidden', at: now,
    });
    return false;
  });
  return { created, assignment: await freshAssignment(db, profileId) };
}

// ── Enable / disable one assignment ───────────────────────────────────────────

/** PATCH { enabled, expectedUpdatedAt }. Unchanged → { unchanged: true }, no audit. */
export async function setAssignmentEnabled(profileId, body, { actorId = null, now = Date.now() } = {}) {
  requireProfileId(profileId);
  if (typeof body?.enabled !== 'boolean') throw err(400, 'VALIDATION', 'enabled doit être true ou false.', 'enabled');
  if (!readExpectedUpdatedAt(body)) throw err(400, 'VALIDATION', 'expectedUpdatedAt manquant : rechargez la page.', 'expectedUpdatedAt');
  const enabled = body.enabled;
  const db = getDemoDb();
  const unchanged = await inTx(db, 'demo-chat assignment toggle', async (tx) => {
    const profile = await lockProfile(tx, profileId);
    const pre = await tx.demoChatAssignment.findUnique({ where: { demoAffiliateId: profileId }, select: { versionId: true } });
    if (!pre) throw err(404, 'NOT_FOUND', 'Aucune attribution pour ce profil.');
    const { journey } = await lockVersionJourney(tx, pre.versionId);
    const row = await lockAssignment(tx, profileId);
    if (!row) throw err(404, 'NOT_FOUND', 'Aucune attribution pour ce profil.');
    checkExpected(row, body);
    if (row.versionId !== pre.versionId) throw err(409, 'STALE', "L'attribution a été modifiée entre-temps : rechargez la page.");
    if (row.enabled === enabled) return true;
    if (enabled) {
      if (!profile.isActive) throw err(409, 'PROFILE_INACTIVE', 'Profil démo masqué (inactif) : impossible d’activer sa conversation.');
      if (journey.status !== 'draft') throw err(409, 'JOURNEY_ARCHIVED', 'Parcours archivé : réattribuez une version d’un parcours actif.');
    }
    await tx.demoChatAssignment.update({
      where: { id: row.id },
      data: { enabled, enabledAt: enabled ? new Date(now) : null, updatedBy: actorId, updatedAt: new Date(now) },
    });
    await writeAudit(tx, {
      action: enabled ? ACTIONS.ASSIGNMENT_ENABLE : ACTIONS.ASSIGNMENT_DISABLE, entityType: 'assignment', entityId: row.id, actorId,
      before: { enabled: row.enabled, revision: row.revision }, after: { enabled, revision: row.revision }, at: now,
    });
    return false;
  });
  return { unchanged, assignment: await freshAssignment(db, profileId) };
}

// ── Global protected switch ───────────────────────────────────────────────────

export async function getChatConfig({ env = process.env } = {}) {
  const db = getDemoDb();
  const gates = await readDemoChatGates(db, env);
  return { ...gates, confirmation: ENABLE_CONFIRMATION };
}

/** PATCH { enabled, confirm? } — the ONLY writer of the "demo-chat-config" row. */
export async function setChatEnabled(body, { actorId = null, now = Date.now(), env = process.env } = {}) {
  if (typeof body?.enabled !== 'boolean') throw err(400, 'VALIDATION', 'enabled doit être true ou false.', 'enabled');
  const enabled = body.enabled;
  if (enabled) {
    if (env?.DEMO_CHAT_ENABLED !== 'true') {
      throw err(409, 'ENV_GATE_OFF', 'Variable serveur DEMO_CHAT_ENABLED ≠ true : activation impossible depuis l’administration.');
    }
    if (body?.confirm !== ENABLE_CONFIRMATION) throw err(400, 'CONFIRMATION_REQUIRED', `Tapez « ${ENABLE_CONFIRMATION} » pour confirmer l’activation.`, 'confirm');
  }
  const db = getDemoDb();
  const unchanged = await inTx(db, 'demo-chat config', async (tx) => {
    const [row] = await tx.$queryRaw`SELECT "id", "data" FROM "settings" WHERE "id" = ${DEMO_CHAT_SETTING_ID} FOR UPDATE`;
    const current = !!(row?.data && typeof row.data === 'object' && row.data.enabled === true);
    if (current === enabled) return true;
    const data = { enabled, updatedAt: new Date(now).toISOString(), updatedBy: actorId };
    await tx.setting.upsert({ where: { id: DEMO_CHAT_SETTING_ID }, update: { data }, create: { id: DEMO_CHAT_SETTING_ID, data } });
    await writeAudit(tx, {
      action: enabled ? ACTIONS.CHAT_ENABLE : ACTIONS.CHAT_DISABLE, entityType: 'config', entityId: DEMO_CHAT_SETTING_ID, actorId,
      before: { enabled: current }, after: { enabled, envGate: env?.DEMO_CHAT_ENABLED === 'true' }, at: now,
    });
    return false;
  });
  return { unchanged, ...(await getChatConfig({ env })) };
}
