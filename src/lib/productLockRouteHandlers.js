/**
 * src/lib/productLockRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bodies of the admin product-lock routes as dependency-injected handlers (same
 * pattern as rewardsRouteHandlers.js). Route files only wire withAdminAuth.
 *
 *   GET   /api/admin/products/locks       → { lockedIds }
 *   PATCH /api/admin/products/[id]/lock   { locked: boolean } → { id, isLocked }
 * ─────────────────────────────────────────────────────────────────────────────
 */
import prisma from './prisma.js';
import { listLockedProductIds, setProductLock } from './services/productLockService.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const json = (data, status = 200) => Response.json(data, { status, headers: NO_STORE });
const STATUS = { INVALID_JSON: 400, INVALID_INPUT: 400, NOT_FOUND: 404 };

function errorResponse(e) {
  const status = STATUS[e?.code];
  if (!status) {
    console.error('[product-lock] unexpected error:', e?.message ?? e);
    return json({ error: 'Erreur serveur', code: 'SERVER_ERROR' }, 500);
  }
  return json({ error: e.message, code: e.code }, status);
}

export function productLockHandlers({ db = prisma } = {}) {
  const safe = (fn) => async (req, ctx, user) => {
    try { return await fn(req, ctx, user); } catch (e) { return errorResponse(e); }
  };
  return {
    listLocks: safe(async () => json({ lockedIds: await listLockedProductIds({ db }) })),
    setLock: safe(async (req, ctx) => {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw Object.assign(new Error('Requête invalide'), { code: 'INVALID_JSON' });
      }
      const id = (await ctx?.params)?.id;
      return json(await setProductLock(id, body.locked, { db }));
    }),
  };
}
