/**
 * src/lib/services/homepageLayoutService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Conflict-safe writes of the homepage layout (settings row "homepage_layout").
 *
 * Two admin pages edit that one row: the Homepage Builder (whole layout) and
 * Demo Competition → Homepage Settings (its two sections). A blind "save the
 * whole layout" from a page opened earlier would silently undo a save made from
 * the other page. Every save therefore carries the REVISION the page loaded
 * (a hash of the stored layout): if the row changed in between, the save is
 * refused with LAYOUT_CONFLICT and the current layout + revision, and nothing
 * is written. The check and the write run in one transaction under an advisory
 * lock, so two saves can never interleave.
 *
 * The generic POST /api/setting?type=homepage_layout is refused (reserved type),
 * so this is the only write path. The public homepage still READS the layout
 * through GET /api/setting?type=homepage_layout (unchanged).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';
import defaultPrisma from '../prisma.js';

export const LAYOUT_SETTING_ID = 'homepage_layout';
const LAYOUT_LOCK = 'homepage-layout';
export const LAYOUT_LIMITS = Object.freeze({ maxSections: 100, maxBytes: 256 * 1024, idMax: 100, typeMax: 60 });

export class LayoutError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const dbOf = (deps) => deps.db ?? defaultPrisma;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Revision of a stored layout (the row's data; null when the row does not exist). */
export function layoutRevision(data) {
  return createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 32);
}

/** The sections of a stored layout, or null when no custom layout was ever saved. */
export const sectionsOf = (data) => (isPlainObject(data) && Array.isArray(data.sections) ? data.sections : null);

/** Shape check only (the builder owns each section's content): returns true when the list is acceptable. */
export function validSections(sections) {
  if (!Array.isArray(sections) || sections.length > LAYOUT_LIMITS.maxSections) return false;
  const ids = new Set();
  for (const s of sections) {
    if (!isPlainObject(s)) return false;
    if (typeof s.id !== 'string' || !s.id || s.id.length > LAYOUT_LIMITS.idMax || ids.has(s.id)) return false;
    if (typeof s.type !== 'string' || !/^[a-z0-9_-]{1,60}$/i.test(s.type)) return false;
    if (s.visible !== undefined && typeof s.visible !== 'boolean') return false;
    if (s.data !== undefined && !isPlainObject(s.data)) return false;
    ids.add(s.id);
  }
  return Buffer.byteLength(JSON.stringify(sections), 'utf8') <= LAYOUT_LIMITS.maxBytes;
}

async function readRow(db) {
  const row = await db.setting.findUnique({ where: { id: LAYOUT_SETTING_ID } });
  return row ? row.data : null;
}

/** → { sections: Array|null, revision } */
export async function getHomepageLayout(deps = {}) {
  const data = await readRow(dbOf(deps));
  return { sections: sectionsOf(data), revision: layoutRevision(data) };
}

/**
 * Save `sections` only if the stored layout still has `revision`.
 * → { sections, revision } (the new revision) · throws LayoutError INVALID_LAYOUT (400) / LAYOUT_CONFLICT (409,
 * extra = the current { sections, revision }). Other keys of the row (if any) are kept.
 */
export async function saveHomepageLayout(deps = {}, { sections, revision } = {}) {
  if (!validSections(sections) || typeof revision !== 'string' || !revision) throw new LayoutError('INVALID_LAYOUT', 400);
  const db = dbOf(deps);
  return db.$transaction(async (tx) => {
    if (typeof tx.$executeRaw === 'function') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LAYOUT_LOCK}::text))`;
    const current = await readRow(tx);
    const currentRevision = layoutRevision(current);
    if (currentRevision !== revision) {
      throw new LayoutError('LAYOUT_CONFLICT', 409, { sections: sectionsOf(current), revision: currentRevision });
    }
    const data = { ...(isPlainObject(current) ? current : {}), sections };
    const saved = await tx.setting.upsert({ where: { id: LAYOUT_SETTING_ID }, update: { data }, create: { id: LAYOUT_SETTING_ID, data } });
    return { sections: sectionsOf(saved.data), revision: layoutRevision(saved.data) };
  });
}

/** Route handlers (injectable deps for the unit tests). */
export function homepageLayoutHandlers(deps = {}) {
  const noStore = { 'Cache-Control': 'no-store' };
  const fail = (err) => {
    if (err instanceof LayoutError) return Response.json({ code: err.code, ...err.extra }, { status: err.status, headers: noStore });
    console.error('[homepage-layout]', err);
    return Response.json({ code: 'SERVER_ERROR' }, { status: 500, headers: noStore });
  };
  return {
    get: async () => {
      try { return Response.json(await getHomepageLayout(deps), { headers: noStore }); } catch (err) { return fail(err); }
    },
    put: async (req) => {
      let body;
      try { body = await req.json(); } catch { return fail(new LayoutError('INVALID_LAYOUT', 400)); }
      if (!isPlainObject(body)) return fail(new LayoutError('INVALID_LAYOUT', 400));
      try { return Response.json(await saveHomepageLayout(deps, body), { headers: noStore }); } catch (err) { return fail(err); }
    },
  };
}
