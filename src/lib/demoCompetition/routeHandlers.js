/**
 * src/lib/demoCompetition/routeHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Route handlers of the Demo Competition (factories with injectable deps, so the
 * unit tests call them directly with a fake database and a fixed clock).
 *
 *   adminDemoCompHandlers(deps) — exported routes wrap each with withAdminAuth
 *   (the existing admin authentication: auth_token cookie, role ADMIN).
 *   publicDemoCompHandlers(deps) — read-only, simulation-labelled public data.
 *
 * Amounts in the API are integers: centimes (…Cents) and basis points (…Bps).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as svc from '../services/demoCompetitionService.js';
import { storeDemoImage, IMAGE_MAX_BYTES } from './media.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PUBLIC_CACHE = 'public, s-maxage=3, stale-while-revalidate=2';

const STATUS = {
  INVALID_INPUT: 400, INVALID_SETTINGS: 400, INVALID_JSON: 400, INVALID_IMAGE_TYPE: 400, EMPTY_IMAGE: 400, IMAGE_TOO_LARGE: 413,
  OWNER_NOT_FOUND: 400, NOT_FOUND: 404, MEMBER_LIMIT_REACHED: 409, BRAND_LIMIT_REACHED: 409,
  MEMBER_OWNS_BRANDS: 409, ARCHIVED: 409, OWNER_ARCHIVED: 409, ENGINE_DISABLED: 409,
};

export function errorResponse(err) {
  const code = err?.code && (STATUS[err.code] || err.status) ? err.code : 'SERVER_ERROR';
  const status = STATUS[code] ?? err?.status ?? 500;
  if (code === 'SERVER_ERROR') console.error('[demo-competition]', err);
  return Response.json({ code, ...(err?.details ? { fields: err.details } : {}) }, { status });
}

const safe = (fn) => async (...args) => {
  try { return await fn(...args); } catch (err) { return errorResponse(err); }
};

async function readJsonObject(req) {
  let body;
  try { body = await req.json(); } catch { throw Object.assign(new Error('json'), { code: 'INVALID_JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('json'), { code: 'INVALID_JSON' });
  return body;
}

async function idParam(ctx) {
  const p = await ctx?.params;
  const id = p?.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw Object.assign(new Error('id'), { code: 'NOT_FOUND' });
  return id;
}

const actorOf = (user) => (user?.id ? String(user.id) : user?.email ? String(user.email) : 'admin');

/** Keep only the editable fields with the right primitive types (validation does the ranges). */
const MEMBER_FIELDS = { name: 'string', active: 'boolean', minDailyOrders: 'int', maxDailyOrders: 'int', priceCents: 'int', allocationBps: 'int',
  networkAffiliates: 'int', networkMinDailyOrders: 'int', networkMaxDailyOrders: 'int', networkPriceCents: 'intOrNull', networkAllocationBps: 'intOrNull' };
const BRAND_FIELDS = { name: 'string', ownerId: 'string', active: 'boolean', minDailyOrders: 'int', maxDailyOrders: 'int', priceCents: 'int', allocationBps: 'int' };
const ENGINE_FIELDS = { enabled: 'boolean', defaultPriceCents: 'int', defaultMemberBps: 'int', defaultBrandBps: 'int' };

function pickTyped(body, spec) {
  const out = {};
  const errors = {};
  for (const [k, t] of Object.entries(spec)) {
    if (body[k] === undefined) continue;
    const v = body[k];
    const ok = t === 'string' ? typeof v === 'string'
      : t === 'boolean' ? typeof v === 'boolean'
        : t === 'int' ? Number.isInteger(v)
          : v === null || Number.isInteger(v);
    if (ok) out[k] = v; else errors[k] = 'INVALID_TYPE';
  }
  if (Object.keys(errors).length) throw Object.assign(new Error('input'), { code: 'INVALID_SETTINGS', details: errors });
  return out;
}

/** Multipart overhead allowed on top of the image itself before the body is even read. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

async function readImage(req) {
  // Refuse an oversized body from its declared length BEFORE buffering it (media.js re-checks the real size).
  const declared = Number(req.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES + FORM_OVERHEAD_BYTES) throw Object.assign(new Error('size'), { code: 'IMAGE_TOO_LARGE' });
  let form;
  try { form = await req.formData(); } catch { throw Object.assign(new Error('form'), { code: 'INVALID_INPUT' }); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') throw Object.assign(new Error('file'), { code: 'INVALID_INPUT' });
  return file;
}

export function adminDemoCompHandlers(deps = {}) {
  const store = deps.storeImage ?? storeDemoImage;
  return {
    // ── Members ──
    listMembers: safe(async () => Response.json(await svc.adminListMembers(deps))),
    createMember: safe(async (req, _ctx, user) => {
      const m = await svc.createMember(deps, pickTyped(await readJsonObject(req), MEMBER_FIELDS), actorOf(user));
      return Response.json({ member: { id: m.id } }, { status: 201 });
    }),
    getMember: safe(async (_req, ctx) => Response.json(await svc.adminGetMember(deps, await idParam(ctx)))),
    updateMember: safe(async (req, ctx, user) => {
      const id = await idParam(ctx);
      await svc.updateMember(deps, id, pickTyped(await readJsonObject(req), MEMBER_FIELDS), actorOf(user));
      return Response.json(await svc.adminGetMember(deps, id));
    }),
    // Profiles are archived, never deleted (history kept; no DELETE route).
    archiveMember: safe(async (_req, ctx, user) => Response.json(await svc.archiveMember(deps, await idParam(ctx), actorOf(user)))),
    restoreMember: safe(async (_req, ctx) => Response.json(await svc.restoreMember(deps, await idParam(ctx)))),
    uploadMemberPhoto: safe(async (req, ctx, user) => {
      const id = await idParam(ctx);
      const cur = await svc.adminGetMember(deps, id); // 404 / archived refused before storing anything
      if (cur.member.archivedAt) throw Object.assign(new Error('archived'), { code: 'ARCHIVED' });
      const url = await store(await readImage(req), 'member');
      await svc.updateMember(deps, id, { photoUrl: url }, actorOf(user));
      return Response.json({ photoUrl: url });
    }),
    // ── Brands ──
    listBrands: safe(async () => Response.json(await svc.adminListBrands(deps))),
    createBrand: safe(async (req, _ctx, user) => {
      const b = await svc.createBrand(deps, pickTyped(await readJsonObject(req), BRAND_FIELDS), actorOf(user));
      return Response.json({ brand: { id: b.id } }, { status: 201 });
    }),
    getBrand: safe(async (_req, ctx) => Response.json(await svc.adminGetBrand(deps, await idParam(ctx)))),
    updateBrand: safe(async (req, ctx, user) => {
      const id = await idParam(ctx);
      await svc.updateBrand(deps, id, pickTyped(await readJsonObject(req), BRAND_FIELDS), actorOf(user));
      return Response.json(await svc.adminGetBrand(deps, id));
    }),
    archiveBrand: safe(async (_req, ctx, user) => Response.json(await svc.archiveBrand(deps, await idParam(ctx), actorOf(user)))),
    restoreBrand: safe(async (_req, ctx) => Response.json(await svc.restoreBrand(deps, await idParam(ctx)))),
    uploadBrandImage: safe(async (req, ctx, user) => {
      const id = await idParam(ctx);
      const cur = await svc.adminGetBrand(deps, id);
      if (cur.brand.archivedAt) throw Object.assign(new Error('archived'), { code: 'ARCHIVED' });
      const url = await store(await readImage(req), 'brand');
      await svc.updateBrand(deps, id, { imageUrl: url }, actorOf(user));
      return Response.json({ imageUrl: url });
    }),
    // ── Engine ──
    getEngine: safe(async () => {
      const db = deps.db ?? (await import('../prisma.js')).default;
      const engine = await svc.getEngine(deps);
      const live = { where: { archivedAt: null } }, archived = { where: { archivedAt: { not: null } } };
      const [members, brands, archivedMembers, archivedBrands, events] = await Promise.all([
        db.demoCompMember.count(live), db.demoCompBrand.count(live), db.demoCompMember.count(archived), db.demoCompBrand.count(archived), db.demoCompEvent.count(),
      ]);
      return Response.json({ engine, counts: { members, brands, archivedMembers, archivedBrands, events }, limits: { members: 21, brands: 20 } });
    }),
    updateEngine: safe(async (req) => Response.json({ engine: await svc.updateEngine(deps, pickTyped(await readJsonObject(req), ENGINE_FIELDS)) })),
    // Engine OFF = nothing is generated, "run now" included.
    runEngine: safe(async () => {
      const r = await svc.runEngine(deps);
      if (r.skipped === 'disabled') return Response.json({ code: 'ENGINE_DISABLED' }, { status: 409 });
      return Response.json(r);
    }),
    // Each created profile gets its 30-day history at creation (engine ON or OFF); `events` = events generated.
    initialize: safe(async (_req, _ctx, user) => {
      const db = deps.db ?? (await import('../prisma.js')).default;
      const before = await db.demoCompEvent.count();
      const created = await svc.initializeCompetition(deps, actorOf(user));
      return Response.json({ ...created, events: (await db.demoCompEvent.count()) - before });
    }),
  };
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': status === 200 ? PUBLIC_CACHE : 'no-store' } });

export function publicDemoCompHandlers(deps = {}) {
  const kick = () => { svc.catchUpOnRead(deps).catch(() => {}); };
  const limitOf = (req) => {
    const v = new URL(req.url).searchParams.get('limit');
    return v ? Number.parseInt(v, 10) : undefined;
  };
  return {
    members: safe(async (req) => { kick(); return json(await svc.getMemberLeaderboard(deps, { limit: limitOf(req) })); }),
    member: safe(async (_req, ctx) => {
      kick();
      const out = await svc.getPublicMember(deps, await idParam(ctx));
      return out ? json(out) : json({ code: 'NOT_FOUND' }, 404);
    }),
    brands: safe(async (req) => { kick(); return json(await svc.getBrandLeaderboard(deps, { limit: limitOf(req) })); }),
    brand: safe(async (_req, ctx) => {
      kick();
      const out = await svc.getPublicBrand(deps, await idParam(ctx));
      return out ? json(out) : json({ code: 'NOT_FOUND' }, 404);
    }),
  };
}
