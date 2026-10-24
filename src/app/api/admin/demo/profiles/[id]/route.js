/**
 * /api/admin/demo/profiles/:id — one DEMO profile (admin only)
 * GET    → identity, current-cycle rank/stats, 90-day demo history, archived cycles
 * PATCH  → edit name, username, avatar, colour, gender, growth type, city, active
 * DELETE → permanent deletion only if nothing references it (else 409: deactivate)
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { getProfileDetail, updateProfile, deleteProfile } from '@/lib/services/demoProfileService';

export const dynamic = 'force-dynamic';

const fail = (e, where) => {
  if (e?.status) return Response.json({ error: e.message, code: e.code, field: e.field ?? null }, { status: e.status });
  console.error(`admin/demo/profiles/[id] ${where} error:`, e);
  return Response.json({ error: 'Erreur serveur' }, { status: 500 });
};

export const GET = withAdminAuth(async (req, ctx) => {
  try {
    const { id } = await ctx.params;
    return Response.json(await getProfileDetail(id));
  } catch (e) { return fail(e, 'GET'); }
});

export const PATCH = withAdminAuth(async (req, ctx) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await updateProfile(id, body));
  } catch (e) { return fail(e, 'PATCH'); }
});

export const DELETE = withAdminAuth(async (req, ctx) => {
  try {
    const { id } = await ctx.params;
    return Response.json(await deleteProfile(id));
  } catch (e) { return fail(e, 'DELETE'); }
});
