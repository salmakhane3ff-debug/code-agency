/**
 * /api/admin/demo/profiles/:id/history — 90-day DEMO earnings history (admin only)
 * POST  { action: 'backfill' }               → fill MISSING days once (deterministic)
 * PATCH { historyId, orders, revenue }       → edit one entry (commission recalculated)
 * Demo tables only — never balances, commissions, payouts or orders.
 */
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
import { backfillHistory, editHistoryEntry } from '@/lib/services/demoProfileService';

export const dynamic = 'force-dynamic';

const fail = (e, where) => {
  if (e?.status) return Response.json({ error: e.message, code: e.code, field: e.field ?? null }, { status: e.status });
  console.error(`admin/demo/profiles/[id]/history ${where} error:`, e);
  return Response.json({ error: 'Erreur serveur' }, { status: 500 });
};

export const POST = withAdminAuth(async (req, ctx) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    if (body?.action !== 'backfill') return Response.json({ error: 'Action inconnue' }, { status: 400 });
    return Response.json(await backfillHistory(id));
  } catch (e) { return fail(e, 'POST'); }
});

export const PATCH = withAdminAuth(async (req, ctx) => {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return Response.json(await editHistoryEntry(id, body));
  } catch (e) { return fail(e, 'PATCH'); }
});
