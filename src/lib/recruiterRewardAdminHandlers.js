/**
 * src/lib/recruiterRewardAdminHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the ADMIN side of the recruiter rewards (Affiliate Recruiter System,
 * Phase 5). Routes wrap them with withAdminAuth (role ADMIN); every change is audited in
 * recruiter_audit_log by the services. Errors: fixed French text per code, never a message.
 *
 *   overview     GET  → current settings + history, ledger rows, balances per recruiter
 *   saveSettings POST { enabled, rewardAmountMad, minDeliveredSales } → next version, then
 *                     awards every reward now due (future awards only — history unchanged)
 *   reconcile    POST { action: 'reconcile' } → awards every reward now due
 *   payoutAction (used by /api/admin/affiliate-payouts for RECRUITER rows) pay | reject
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import {
  adminSaveRecruiterSettings, getCurrentRecruiterSettings, listRecruiterSettingsVersions, reconcileRecruiterRewards,
} from './services/recruiterRewardService.js';
import { adminListRecruiterLedger, adminProcessRecruiterPayout, adminRecruiterBalances } from './services/recruiterWalletService.js';

const noStore = { 'Cache-Control': 'no-store' };
const json = (body, status = 200) => Response.json(body, { status, headers: noStore });
const ADMIN_ERRORS = {
  INVALID_INPUT: [400, 'Données invalides.'],
  UNAUTHORIZED: [401, 'Non autorisé.'],
  NOT_FOUND: [404, 'Retrait introuvable.'],
  INVALID_STATE: [409, 'Ce retrait a déjà été traité.'],
  // Phase 6 part 3b: paying would exceed the recruiter's net earned (a reward was reversed).
  INSUFFICIENT_BALANCE: [409, 'Paiement refusé : le solde net du recruteur (récompenses moins annulations) ne couvre pas ce retrait. Rejetez la demande pour la libérer.'],
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
  const reconcileAll = async () => {
    try { return await reconcileRecruiterRewards({ db, now: now() }); } catch (e) { console.error('[recruiter-rewards] reconcile failed:', e?.code ?? 'ERROR'); return null; }
  };
  return {
    overview: safe(async () => {
      const [settings, history, ledger, balances] = await Promise.all([
        getCurrentRecruiterSettings({ db }), listRecruiterSettingsVersions({ db }), adminListRecruiterLedger({ db }), adminRecruiterBalances({ db }),
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
      const result = await reconcileRecruiterRewards({ db, now: now() });
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
