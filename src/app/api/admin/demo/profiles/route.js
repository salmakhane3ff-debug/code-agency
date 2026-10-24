/**
 * /api/admin/demo/profiles — DEMO competition profiles (fake personas, admin only)
 * GET  ?q=&status=all|active|inactive  → list with live rank + current-cycle stats
 * POST { action: 'create', profile }                       → add one profile
 * POST { action: 'generate', count, mode, strategy }       → batch (target | add);
 *      existing profiles and ids are always reused, never replaced
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { listProfiles, createProfile, generateProfiles } from '@/lib/services/demoProfileService';

export const dynamic = 'force-dynamic';

const fail = (e, where) => {
  if (e?.status) return Response.json({ error: e.message, code: e.code, field: e.field ?? null }, { status: e.status });
  console.error(`admin/demo/profiles ${where} error:`, e);
  return Response.json({ error: 'Erreur serveur' }, { status: 500 });
};

export const GET = withAdminAuth(async (req) => {
  try {
    const { searchParams } = new URL(req.url);
    const status = ['active', 'inactive'].includes(searchParams.get('status')) ? searchParams.get('status') : 'all';
    return Response.json(await listProfiles({ q: searchParams.get('q') || '', status }));
  } catch (e) { return fail(e, 'GET'); }
});

export const POST = withAdminAuth(async (req) => {
  try {
    const body = await req.json().catch(() => null);
    if (body?.action === 'create') return Response.json(await createProfile(body.profile), { status: 201 });
    if (body?.action === 'generate') return Response.json(await generateProfiles(body));
    return Response.json({ error: 'Action inconnue' }, { status: 400 });
  } catch (e) { return fail(e, 'POST'); }
});
