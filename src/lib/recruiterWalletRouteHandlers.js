/**
 * src/lib/recruiterWalletRouteHandlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP bodies of the Affiliate Recruiter System, Phase 5 — the recruiter's OWN wallet.
 * Routes wrap them with withRecruiterAuth; tests inject a fake db, clock and rate limiter.
 *
 *   wallet    GET  → settings (amount + threshold), totals, reward history, withdrawals, bank
 *                    (first awards any reward now due in their network — idempotent)
 *   bank      PUT  { bankName, rib, accountName }
 *   withdraw  POST { amountMad, requestId } → 201 { withdrawal, replayed:false } | 200 replay
 * Every request re-checks the account (active). Responses: recruiterVisibility only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from './prisma.js';
import { rateLimit as defaultRateLimit } from './rateLimit.js';
import { requireActiveRecruiter } from './services/recruiterService.js';
import { reconcileRecruiterRewards } from './services/recruiterRewardService.js';
import { getRecruiterWallet, requestRecruiterWithdrawal, saveRecruiterBank } from './services/recruiterWalletService.js';
import { toRecruiterBankView, toRecruiterError as defaultToRecruiterError, toRecruiterWalletView, toRecruiterWithdrawalView } from './recruiterVisibility.js';
import { json, recruiterErrorResponse } from './recruiterRouteHandlers.js';

export const RECRUITER_WALLET_RATE = Object.freeze({ read: { max: 60, windowMs: 60_000 }, write: { max: 10, windowMs: 60_000 } });
/** HTTP status of the wallet's own allowlisted codes (a refused request, never a server error). */
export const RECRUITER_WALLET_STATUS = Object.freeze({ INSUFFICIENT_BALANCE: 400, INCOMPLETE_BANK_INFO: 400 });

export function recruiterWalletHandlers(deps = {}) {
  const { db = prisma, now = () => new Date(), rateLimit = defaultRateLimit, toRecruiterError = defaultToRecruiterError } = deps;
  const safe = (kind, fn) => async (req, _ctx, decoded) => {
    try {
      const rid = typeof decoded?.recruiterId === 'string' ? decoded.recruiterId : '-';
      if (rateLimit(req, `recruiter-wallet-${kind}:${rid}`, RECRUITER_WALLET_RATE[kind])) return json({ code: 'RATE_LIMITED' }, 429);
      const me = await requireActiveRecruiter(decoded, { db });
      return await fn(req, me);
    } catch (e) {
      return recruiterErrorResponse(e, toRecruiterError, RECRUITER_WALLET_STATUS);
    }
  };
  return {
    wallet: safe('read', async (_req, me) => {
      try { await reconcileRecruiterRewards({ db, recruiterId: me.id, now: now() }); } catch (e) { console.error('[recruiter-rewards] reconcile on wallet read failed:', e?.code ?? 'ERROR'); }
      return json({ wallet: toRecruiterWalletView(await getRecruiterWallet(me.id, { db })) });
    }),
    bank: safe('write', async (req, me) => {
      const body = await req.json().catch(() => undefined);
      return json({ bank: toRecruiterBankView(await saveRecruiterBank(me.id, body, { db, now: now() })) });
    }),
    withdraw: safe('write', async (req, me) => {
      const body = await req.json().catch(() => undefined);
      const { withdrawal, replayed } = await requestRecruiterWithdrawal(me.id, body, { db, now: now() });
      return json({ withdrawal: toRecruiterWithdrawalView(withdrawal), replayed }, replayed ? 200 : 201);
    }),
  };
}
