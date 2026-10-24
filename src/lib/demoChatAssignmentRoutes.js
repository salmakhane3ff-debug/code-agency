/**
 * src/lib/demoChatAssignmentRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bodies of the /api/admin/demo-chat/assignments* and /config routes
 * (Phase 3C-9B). Route files only wire withAdminAuth + these handlers, so the
 * tests drive the real handlers behind the real withAdminAuth. `user` is the
 * verified admin token payload — the only source of the audit actor id.
 * Admin only: nothing here is reachable from affiliate or public routes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { errorResponse, actorIdOf } from './demoChatErrors.js';
import {
  listAssignmentOverview, assignVersion, setAssignmentEnabled, getChatConfig, setChatEnabled,
} from './services/demoChatAssignmentService.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const json = (data, status = 200) => Response.json(data, { status, headers: NO_STORE });
const body = (req) => req.json().catch(() => null);
const param = async (ctx, name) => (await ctx?.params)?.[name];

export function demoChatAssignmentHandlers(deps = {}) {
  const { env = process.env, now = Date.now } = deps;
  return {
    /** GET ?q=&status=active|all */
    list: async (req) => {
      try {
        const sp = new URL(req.url).searchParams;
        return json(await listAssignmentOverview({ q: sp.get('q') || '', status: sp.get('status') || 'all', now: now(), env }));
      } catch (e) { return errorResponse(e, 'admin/demo-chat/assignments GET'); }
    },
    /** PUT /[profileId] { versionId, anchorDate?, expectedUpdatedAt? } */
    assign: async (req, ctx, user) => {
      try {
        const r = await assignVersion(await param(ctx, 'profileId'), await body(req), { actorId: actorIdOf(user), now: now() });
        return json(r, r.created ? 201 : 200);
      } catch (e) { return errorResponse(e, 'admin/demo-chat/assignments PUT'); }
    },
    /** PATCH /[profileId] { enabled, expectedUpdatedAt } */
    toggle: async (req, ctx, user) => {
      try {
        return json(await setAssignmentEnabled(await param(ctx, 'profileId'), await body(req), { actorId: actorIdOf(user), now: now() }));
      } catch (e) { return errorResponse(e, 'admin/demo-chat/assignments PATCH'); }
    },
    /** GET /config */
    config: async () => {
      try { return json(await getChatConfig({ env })); } catch (e) { return errorResponse(e, 'admin/demo-chat/config GET'); }
    },
    /** PATCH /config { enabled, confirm? } */
    setConfig: async (req, _ctx, user) => {
      try {
        return json(await setChatEnabled(await body(req), { actorId: actorIdOf(user), now: now(), env }));
      } catch (e) { return errorResponse(e, 'admin/demo-chat/config PATCH'); }
    },
  };
}
