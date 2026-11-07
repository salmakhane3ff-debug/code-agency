/**
 * src/lib/recruiterRewardAdminHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the ADMIN side of the recruiter rewards (Affiliate Recruiter System,
 * Phase 5). Routes wrap them with withAdminAuth (role ADMIN); every change is audited in
 * recruiter_audit_log by the services. Errors: fixed French text per code, never a message.
 *
 *   overview     GET  → current settings + history (both reward types), ledger rows, balances per recruiter
 *   saveSettings POST { enabled, rewardAmountMad, minDeliveredSales,                       (Reward A)
 *                      groupEnabled, groupRewardAmountMad, groupSize, groupMinDeliveredSales } (Reward B, Phase 7)
 *                     → next version (400 INVALID_INPUT with per-field errors otherwise), then
 *                     runs the FIRST reconcile batch (future awards only — history unchanged)
 *   reconcile    POST { action: 'reconcile', cursor? } → ONE bounded batch (Phase 6 part 5d):
 *                     { reconcile: { checked, awarded, reversed, unchanged, candidates, cursor,
 *                     hasMore, groupChecked, groupAwarded, groupReversed } }; repeat with `cursor`
 *                     while hasMore (Phase 7: the group pass runs in the call that exhausts the
 *                     batches); 409 RECONCILE_BUSY when another full batch is running
 *   payoutAction (used by /api/admin/affiliate-payouts for RECRUITER rows) pay | reject
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import {
  adminSaveRecruiterSettings, getCurrentRecruiterSettingsWithGroup, listRecruiterSettingsVersions, reconcileRecruiterRewards,
} from './services/recruiterRewardService.js';
import { adminListRecruiterLedger, adminProcessRecruiterPayout, adminRecruiterBalances } from './services/recruiterWalletService.js';

const noStore = { 'Cache-Control': 'no-store' };
const json = (body, status = 200) => Response.json(body, { status, headers: noStore });
const ADMIN_ERRORS = {
  INVALID_INPUT: [400, 'Données invalides.'],
  UNAUTHORIZED: [401, 'Non autorisé.'],
  NOT_FOUND: [404, 'Retrait introuvable.'],
  INVALID_STATE: [409, 'Ce retrait a déjà été traité.'],
  // Phase 6 part 5d: another full reconcile batch is running right now (platform-wide try-lock).
  RECONCILE_BUSY: [409, 'Une vérification des récompenses est déjà en cours. Réessayez dans un instant.'],
  // Phase 6 part 3b: paying would exceed the recruiter's net earned (a reward was reversed).
  INSUFFICIENT_BALANCE: [409, 'Paiement refusé : le solde net du recruteur (récompenses moins annulations) ne couvre pas ce retrait. Rejetez la demande pour la libérer.'],
  // Phase 6 part 3c: the recruiter's identity (CIN) must be APPROVED at payment time.
  RECRUITER_IDENTITY_NOT_APPROVED: [409, "Paiement refusé : l'identité (CIN) du recruteur n'est pas approuvée. Le retrait reste en attente ; vous pouvez le rejeter pour libérer les fonds."],
};
function adminError(e) {
  const known = ADMIN_ERRORS[e?.code];
  if (!known) {
    console.error('[admin recruiter rewards]', e?.code ?? 'ERROR');
    return json({ code: 'SERVER_ERROR', error: 'Erreur serveur.' }, 500);
  }
  return json({ code: e.code, error: known[1], ...(e.errors ? { errors: e.errors } : {}) }, known[0]);
}
const actorOf = (user) => (user?.userId ? String(user.userId) : user?.email ? String(user.email) : user?.id ? String(user.id) : null);

export function recruiterRewardAdminHandlers(deps = {}) {
  const { db = prisma, now = () => new Date() } = deps;
  const safe = (fn) => async (req, ctx, user) => { try { return await fn(req, ctx, user); } catch (e) { return adminError(e); } };
  // Phase 6 part 5d: ONE bounded batch per HTTP request (keyset cursor); the client repeats with
  // `cursor` while `hasMore`. Repeating or retrying a batch is safe (each sync is idempotent).
  const reconcileBatch = (cursor = null) => reconcileRecruiterRewards({ db, now: now(), after: cursor, maxBatches: 1 });
  const reconcileAll = async () => {
    try { return await reconcileBatch(); } catch (e) { console.error('[recruiter-rewards] reconcile failed:', e?.code ?? 'ERROR'); return null; }
  };
  return {
    overview: safe(async () => {
      const [settings, history, ledger, balances] = await Promise.all([
        getCurrentRecruiterSettingsWithGroup({ db }), listRecruiterSettingsVersions({ db }), adminListRecruiterLedger({ db }), adminRecruiterBalances({ db }),
      ]);
      return json({ settings, history, ledger, balances });
    }),
    saveSettings: safe(async (req, _ctx, user) => {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
      const settings = await adminSaveRecruiterSettings(body, { db, actorId: actorOf(user), now: now() });
      return json({ settings, reconcile: await reconcileAll() }, 201);
    }),
    reconcile: safe(async (req) => {
      const body = await req.json().catch(() => null);
      if (body?.action !== 'reconcile') throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
      const cursor = body.cursor ?? null;
      if (cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(cursor))) throw Object.assign(new Error('INVALID_INPUT'), { code: 'INVALID_INPUT' });
      const result = await reconcileBatch(cursor);
      if (result?.busy === true) throw Object.assign(new Error('RECONCILE_BUSY'), { code: 'RECONCILE_BUSY' });
      return json({ reconcile: result });
    }),
    /** For the existing payouts route: process a RECRUITER row (caller checked the owner). */
    payoutAction: async (id, action, user, reason) => {
      try {
        return json(await adminProcessRecruiterPayout(id, action, { db, actorId: actorOf(user), reason, now: now() }));
      } catch (e) {
        return adminError(e);
      }
    },
  };
}
