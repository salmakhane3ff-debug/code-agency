/**
 * src/lib/services/brandProgramService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" (training simulator) — configuration, refund terms
 * and the audit trail.
 *
 * Two settings rows, both refused by the generic /api/setting route
 * (settingsController reserves them):
 *   • brand-program-config — packages, branding options, simulation settings.
 *     Saved only by saveBrandConfig: strict validation, a saved package can
 *     never disappear (only be deactivated), simulation.activeSince stamped on
 *     every off→on switch, and every change of the simulation state appends a
 *     settings version (brand_sim_settings_versions) linked to its audit row.
 *   • brand-refund-terms — the draft an admin writes and the version an admin
 *     approved and published. Affiliates only ever see the published version.
 * Every write appends a brand_audit_log row in the same transaction.
 *
 * No purchase, payment, wallet, order, commission or Rewards write happens here.
 * DB is injectable for unit tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import {
  BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID,
  normalizeBrandConfig, validateBrandConfig, removedPackageIds,
  normalizeRefundTerms, validateTermsDraft,
  CATALOG_PRODUCT_SELECT, eligibleCatalog, isEligibleProduct, catalogProductView,
} from '../brandProgram.js';
import { ensureSettingsTimeline, appendSettingsVersion, advisoryXactLock } from './brandSimSettingsService.js';
import { termsTextSha256, TERMS_LOCK_KEY } from './brandConsentService.js';

export const BRAND_ACTOR = Object.freeze({ SYSTEM: 'SYSTEM', ADMIN: 'ADMIN', AFFILIATE: 'AFFILIATE' });

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** Append one audit row (inside the caller's transaction). */
export function writeBrandAudit(tx, { action, entityType, entityId = null, actorType = BRAND_ACTOR.ADMIN, actorId = null, before = null, after = null, reason = null }) {
  return tx.brandAuditLog.create({
    data: {
      action, entityType, entityId, actorType,
      actorId: actorId ? String(actorId) : null,
      before: before ?? undefined, after: after ?? undefined, reason,
    },
  });
}

/** Lock a settings row for the rest of the transaction (upsert touch) and return its data. */
async function lockSettingRow(tx, id, at) {
  const row = await tx.setting.upsert({ where: { id }, create: { id, data: {} }, update: { updatedAt: at } });
  return row?.data;
}

// ── Configuration ─────────────────────────────────────────────────────────────

// ── Catalogue (store products are READ only — never written) ─────────────────

/** Catalogue rows for these ids (id, title, images, status, isActive, isLocked only). */
export async function readCatalogProducts(ids, db = prisma) {
  if (!ids?.length) return [];
  return db.product.findMany({ where: { id: { in: [...ids] } }, select: CATALOG_PRODUCT_SELECT });
}

/** The catalogue an affiliate may pick from right now (eligible products, admin order). */
export async function getEligibleCatalog(config, db = prisma) {
  return eligibleCatalog(config, await readCatalogProducts(config.catalogProductIds, db));
}

/** Admin picker: every store product (newest first) with its eligibility and catalogue flag. */
export async function listCatalogCandidates({ db = prisma, take = 500 } = {}) {
  const [config, rows] = await Promise.all([
    getBrandConfig(db),
    db.product.findMany({ select: CATALOG_PRODUCT_SELECT, orderBy: { createdAt: 'desc' }, take }),
  ]);
  const inCatalog = new Set(config.catalogProductIds);
  return rows.map((p) => ({
    ...catalogProductView(p),
    status: p.status, isActive: p.isActive === true, isLocked: p.isLocked === true,
    eligible: isEligibleProduct(p), inCatalog: inCatalog.has(p.id),
  }));
}

export async function getBrandConfig(db = prisma) {
  const row = await db.setting.findUnique({ where: { id: BRAND_SETTING_ID } }).catch(() => null);
  return normalizeBrandConfig(row?.data);
}

/**
 * Save the whole config submitted by the admin. One transaction: the settings
 * row is locked first and the current config is read UNDER that lock, so two
 * admins saving at once are serialised and the checks run on the latest state.
 *
 * @throws INVALID_INPUT (with `errors`: path → code) | PACKAGE_REMOVED
 */
export async function saveBrandConfig(input, { actorId = null, db = prisma, now = new Date() } = {}) {
  const v = validateBrandConfig(input);
  if (!v.ok) throw err('INVALID_INPUT', 'Configuration invalide', { errors: v.errors });
  const at = new Date(now);

  return db.$transaction(async (tx) => {
    // Timeline first (reconstructed once from earlier audits, before this save's row exists).
    await ensureSettingsTimeline(tx, { now: at });
    const current = normalizeBrandConfig(await lockSettingRow(tx, BRAND_SETTING_ID, at));
    const removed = removedPackageIds(current, v.value);
    if (removed.length) {
      throw err('PACKAGE_REMOVED', 'Un pack enregistré ne peut pas être supprimé : désactivez-le.', {
        errors: { packages: 'PACKAGE_REMOVED' }, removed,
      });
    }
    const turningOn = !current.simulation.enabled && v.value.simulation.enabled;
    const next = {
      ...v.value,
      simulation: { ...v.value.simulation, activeSince: turningOn ? at.toISOString() : current.simulation.activeSince },
      updatedAt: at.toISOString(),
      updatedBy: actorId ? String(actorId) : null,
    };
    await tx.setting.update({ where: { id: BRAND_SETTING_ID }, data: { data: next } });
    const audit = await writeBrandAudit(tx, {
      action: 'CONFIG_UPDATE', entityType: 'brand_config', entityId: BRAND_SETTING_ID, actorId,
      before: current, after: next,
      reason: turningOn ? 'simulation switched on' : null,
    });
    await appendSettingsVersion(tx, { beforeSim: current.simulation, afterSim: next.simulation, auditId: audit.id, at });
    return normalizeBrandConfig(next);
  });
}

// ── Refund terms ──────────────────────────────────────────────────────────────

export async function getRefundTerms(db = prisma) {
  const row = await db.setting.findUnique({ where: { id: BRAND_TERMS_SETTING_ID } }).catch(() => null);
  return normalizeRefundTerms(row?.data);
}

/** Save the DRAFT (never visible to affiliates). @throws INVALID_INPUT */
export async function saveRefundTermsDraft(input, { actorId = null, db = prisma, now = new Date() } = {}) {
  const v = validateTermsDraft(input);
  if (!v.ok) throw err('INVALID_INPUT', 'Texte invalide', { errors: v.errors });
  const at = new Date(now);
  return db.$transaction(async (tx) => {
    const current = normalizeRefundTerms(await lockSettingRow(tx, BRAND_TERMS_SETTING_ID, at));
    const next = { ...current, draft: { text: v.value.text, updatedAt: at.toISOString(), updatedBy: actorId ? String(actorId) : null } };
    await tx.setting.update({ where: { id: BRAND_TERMS_SETTING_ID }, data: { data: next } });
    await writeBrandAudit(tx, {
      action: 'TERMS_DRAFT_UPDATE', entityType: 'brand_terms', entityId: BRAND_TERMS_SETTING_ID, actorId,
      before: { draft: current.draft.text }, after: { draft: next.draft.text },
    });
    return normalizeRefundTerms(next);
  });
}

/**
 * An administrator approves the current draft and publishes it as a new version.
 * One transaction: the settings, the TERMS_PUBLISHED audit row and the immutable
 * brand_terms_versions row (exact text + SHA-256) — all or nothing. Requests keep
 * the version (and text) their participant accepted.
 * Lock order: terms lock (exclusive) → terms settings row.
 * @throws TERMS_EMPTY | TERMS_UNCHANGED
 */
export async function publishRefundTerms({ actorId = null, db = prisma, now = new Date() } = {}) {
  const at = new Date(now);
  return db.$transaction(async (tx) => {
    await advisoryXactLock(tx, TERMS_LOCK_KEY);
    const current = normalizeRefundTerms(await lockSettingRow(tx, BRAND_TERMS_SETTING_ID, at));
    if (!current.draft.text) throw err('TERMS_EMPTY', 'Rédigez les conditions avant de les publier.');
    if (current.published && current.published.text === current.draft.text) {
      throw err('TERMS_UNCHANGED', 'Cette version est déjà publiée.');
    }
    const version = (current.published?.version || 0) + 1;
    const next = {
      ...current,
      published: { version, text: current.draft.text, publishedAt: at.toISOString(), publishedBy: actorId ? String(actorId) : null },
    };
    const textSha256 = termsTextSha256(next.published.text);
    await tx.setting.update({ where: { id: BRAND_TERMS_SETTING_ID }, data: { data: next } });
    const audit = await writeBrandAudit(tx, {
      action: 'TERMS_PUBLISHED', entityType: 'brand_terms', entityId: BRAND_TERMS_SETTING_ID, actorId,
      before: current.published ? { version: current.published.version } : null,
      after: { version, text: next.published.text, textSha256 },
    });
    await tx.brandTermsVersion.create({
      data: {
        version, text: next.published.text, textSha256, publishedAt: at,
        publishedBy: actorId ? String(actorId) : null, publishAuditId: audit.id, source: 'PUBLISH',
      },
    });
    return normalizeRefundTerms(next);
  });
}

/** Latest audit rows (most recent first). */
/** Audit rows, newest first; optionally only those of one entity (e.g. one request id). */
export async function listBrandAudit({ db = prisma, take = 100, entityId = null } = {}) {
  const where = typeof entityId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(entityId) ? { entityId } : {};
  return db.brandAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(1, take), 200) });
}
