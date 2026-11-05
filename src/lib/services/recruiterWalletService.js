/**
 * src/lib/services/recruiterWalletService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 5: the recruiter's MONEY (earned rewards, withdrawals).
 * (db injected, so tests run on an in-memory fake or an isolated local database.)
 *
 * The existing withdrawal workflow is REUSED, not duplicated:
 *   • storage: the existing withdrawal table affiliate_payouts — a recruiter row has
 *     recruiterId set and affiliateId NULL (DB CHECK: exactly one owner). Every query here is
 *     scoped by `recruiterId`; affiliate balances read that table by affiliateId, so the two
 *     never mix;
 *   • rules: the same bank-details gate (validateBankInfo) and the same reservation rule
 *     (PAYOUT_RELEASING_STATUSES: rejected / cancelled release, every other status reserves);
 *   • admin: the same list and the same "approve & mark paid" action (plus reject for
 *     recruiter rows), see adminProcessRecruiterPayout.
 *
 * Accounting (MAD, integer cents — never an affiliate balance, commission or point):
 *   earned    = Σ recruiter_reward_ledger.amountCents of the recruiter
 *   reserved  = Σ their withdrawal rows whose status is not releasing (pending, paid, …)
 *   paid      = Σ their rows with status 'paid';  pending = reserved − paid
 *   available = earned − reserved
 * A request is checked against `available` inside a transaction that first locks the
 * recruiter row (FOR NO KEY UPDATE): two concurrent requests are serialised, the second
 * sees the first one reserved — the same funds can never be reserved twice.
 *
 * Phase 6 part 3b — negative balance & withdrawal protection:
 *   • `earned` is the authoritative ledger sum, so a REVERSAL (Phase 6 part 3a) lowers it at
 *     once; `available` may become NEGATIVE (a reward reversed after it was reserved / paid).
 *   • a request is refused (INSUFFICIENT_BALANCE) when `available` ≤ 0 or below the amount;
 *   • paying a pending withdrawal re-checks the ledger under the SAME recruiter lock: the
 *     total paid may never exceed the net earned (paid + this row ≤ earned). A withdrawal
 *     whose reward was reversed in the meantime is refused (INSUFFICIENT_BALANCE) — the admin
 *     rejects it, which releases it. Reversed rewards therefore can never be paid out.
 *   • a payment and a reward reversal share the per-recruiter money lock
 *     (lockRecruiterMoney): the payment's balance re-check and decision are strictly
 *     serialised against reversals — a reversal committed first makes the payment see it; a
 *     payment holding the lock makes the reversal wait until it has committed.
 *   • a REQUEST does not take that lock: it reserves nothing a reversal reads, and any
 *     request/reversal interleaving equals "request first, then reversal" — covered by the
 *     payment re-check.
 *
 * Phase 6 part 3c — recruiter KYC gate (recruiter_identity_verifications):
 *   • a request needs the recruiter's KYC APPROVED, read inside the request transaction under
 *     the recruiter row lock (RECRUITER_IDENTITY_NOT_APPROVED otherwise);
 *   • a payment needs it APPROVED at PAYMENT time, read after the money lock — this also
 *     covers withdrawals requested before the KYC existed. An admin KYC decision takes the
 *     same money lock, so a payment and a rejection / revocation are strictly serialised.
 *   • a reject never checks the KYC: a pending withdrawal can always be rejected (released).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from '../prisma.js';
import { parseMadToCents, normalizeRecruiterSettings } from '../recruiterSettings.js';
import { lockRecruiterMoney } from './recruiterRewardService.js';
import { PAYOUT_RELEASING_STATUSES, validateBankInfo } from './affiliateSystemService.js';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEXT_MAX = 80;
export const RECRUITER_WITHDRAWAL_LIMITS = Object.freeze({ MIN_CENTS: 1, MAX_CENTS: 100_000_000, HISTORY: 200 });
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const toCents = (amount) => Math.round(Number(amount || 0) * 100);
const releasing = (status) => PAYOUT_RELEASING_STATUSES.includes(status);
/** The recruiter's KYC is APPROVED (Phase 6 part 3c) — read in the caller's transaction. */
const identityApproved = async (tx, recruiterId) => (
  await tx.recruiterIdentityVerification.findUnique({ where: { recruiterId }, select: { status: true } })
)?.status === 'APPROVED';

/** Totals of one recruiter, in cents. Read inside or outside a transaction. */
async function walletTotals(db, recruiterId) {
  const [ledger, payouts] = await Promise.all([
    db.recruiterRewardLedger.aggregate({ where: { recruiterId }, _sum: { amountCents: true } }),
    db.affiliatePayout.findMany({ where: { recruiterId }, select: { amount: true, status: true } }),
  ]);
  const earnedCents = Number(ledger?._sum?.amountCents ?? 0);
  let reservedCents = 0;
  let paidCents = 0;
  for (const p of payouts) {
    if (releasing(p.status)) continue;
    const c = toCents(p.amount);
    reservedCents += c;
    if (p.status === 'paid') paidCents += c;
  }
  return { earnedCents, reservedCents, paidCents, pendingCents: reservedCents - paidCents, availableCents: earnedCents - reservedCents };
}

const bankOf = (r) => {
  const bank = { bankName: r?.bankName ?? null, rib: r?.rib ?? null, accountName: r?.accountName ?? null };
  return { ...bank, complete: validateBankInfo(bank).length === 0 };
};

/**
 * Everything the recruiter's wallet page shows: settings (amount + threshold), totals,
 * reward history (which affiliate, and the threshold of the settings version used), their
 * withdrawals and their bank details.
 */
export async function getRecruiterWallet(recruiterId, { db = prisma } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  const [me, settingsRow, totals, ledger, payouts] = await Promise.all([
    db.recruiter.findUnique({ where: { id: recruiterId }, select: { bankName: true, rib: true, accountName: true } }),
    db.recruiterSettingsVersion.findFirst({ orderBy: { version: 'desc' } }),
    walletTotals(db, recruiterId),
    db.recruiterRewardLedger.findMany({
      where: { recruiterId }, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], take: RECRUITER_WITHDRAWAL_LIMITS.HISTORY,
      select: { type: true, amountCents: true, affiliateId: true, settingsVersion: true, cycle: true, createdAt: true },
    }),
    db.affiliatePayout.findMany({
      where: { recruiterId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: RECRUITER_WITHDRAWAL_LIMITS.HISTORY,
      select: { id: true, amount: true, status: true, createdAt: true },
    }),
  ]);
  if (!me) throw fail('UNAUTHORIZED');
  const affIds = [...new Set(ledger.map((l) => l.affiliateId).filter((x) => typeof x === 'string'))];
  const versions = [...new Set(ledger.map((l) => l.settingsVersion).filter((v) => Number.isInteger(v)))];
  const [affs, vers] = await Promise.all([
    affIds.length ? db.affiliate.findMany({ where: { id: { in: affIds } }, select: { id: true, username: true, name: true } }) : [],
    versions.length ? db.recruiterSettingsVersion.findMany({ where: { version: { in: versions } }, select: { version: true, minDeliveredSales: true } }) : [],
  ]);
  const affById = new Map(affs.map((a) => [a.id, a]));
  const thresholdByVersion = new Map(vers.map((v) => [v.version, v.minDeliveredSales]));
  return {
    settings: normalizeRecruiterSettings(settingsRow),
    totals,
    rewards: ledger.map((l) => ({
      type: l.type, amountCents: l.amountCents, createdAt: l.createdAt, cycle: l.cycle ?? null,
      affiliate: l.affiliateId ? affById.get(l.affiliateId) ?? { id: l.affiliateId, username: null, name: null } : null,
      requiredDeliveredOrders: Number.isInteger(l.settingsVersion) ? thresholdByVersion.get(l.settingsVersion) ?? null : null,
    })),
    withdrawals: payouts.map((p) => ({ id: p.id, amountCents: toCents(p.amount), status: p.status, createdAt: p.createdAt })),
    bank: bankOf(me),
  };
}

/** Recruiter: save their bank details (same fields and rules as the affiliate ones). */
export async function saveRecruiterBank(recruiterId, input, { db = prisma, now = new Date() } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['bankName', 'rib', 'accountName'].includes(k))) {
    throw fail('INVALID_INPUT', { fields: { body: 'UNKNOWN_FIELD' } });
  }
  const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const bank = { bankName: clean(input.bankName), rib: clean(input.rib).replace(/\s/g, ''), accountName: clean(input.accountName) };
  const fields = {};
  const problems = validateBankInfo(bank);
  if (problems.includes('bankName') || bank.bankName.length > TEXT_MAX || /[<>]/.test(bank.bankName)) fields.bankName = 'INVALID_BANK_NAME';
  if (problems.includes('accountName') || bank.accountName.length > TEXT_MAX || /[<>]/.test(bank.accountName)) fields.accountName = 'INVALID_ACCOUNT_NAME';
  if (problems.includes('rib') || problems.includes('ribLength') || !/^[A-Za-z0-9]+$/.test(bank.rib)) fields.rib = 'INVALID_RIB';
  if (Object.keys(fields).length) throw fail('INVALID_INPUT', { fields });
  return db.$transaction(async (tx) => {
    const row = await tx.recruiter.update({ where: { id: recruiterId }, data: bank, select: { bankName: true, rib: true, accountName: true } });
    await tx.recruiterAuditLog.create({
      data: { recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'RECRUITER_BANK_UPDATED', entityType: 'recruiter', entityId: recruiterId, createdAt: now },
    });
    return bankOf(row);
  });
}

/**
 * Recruiter: request a withdrawal { amountMad, requestId }. Same gates as the affiliate
 * request (amount, complete bank details, available funds re-checked inside the transaction).
 * The same requestId replays the first result (double submit / retry).
 * → { withdrawal: { id, amountCents, status, createdAt }, replayed }
 */
export async function requestRecruiterWithdrawal(recruiterId, input, { db = prisma, now = new Date() } = {}) {
  if (typeof recruiterId !== 'string' || !ID_RE.test(recruiterId)) throw fail('UNAUTHORIZED');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['amountMad', 'requestId'].includes(k))) {
    throw fail('INVALID_INPUT', { fields: { body: 'UNKNOWN_FIELD' } });
  }
  const fields = {};
  const cents = parseMadToCents(input.amountMad);
  if (!Number.isInteger(cents) || cents < RECRUITER_WITHDRAWAL_LIMITS.MIN_CENTS || cents > RECRUITER_WITHDRAWAL_LIMITS.MAX_CENTS) fields.amountMad = 'INVALID_AMOUNT';
  const requestId = typeof input.requestId === 'string' ? input.requestId.toLowerCase() : '';
  if (!REQUEST_ID_RE.test(requestId)) fields.requestId = 'INVALID_REQUEST_ID';
  if (Object.keys(fields).length) throw fail('INVALID_INPUT', { fields });

  return db.$transaction(async (tx) => {
    // 1. Serialise this recruiter's money operations and re-check the account.
    const locked = await tx.$queryRaw`SELECT "isActive", "bankName", "rib", "accountName" FROM "recruiters" WHERE "id" = ${recruiterId} FOR NO KEY UPDATE`;
    const me = Array.isArray(locked) ? locked[0] : null;
    if (!me) throw fail('UNAUTHORIZED');
    if (me.isActive !== true) throw fail('RECRUITER_DISABLED');
    // 2. Idempotent replay of the same request.
    const previous = await tx.recruiterAuditLog.findFirst({
      where: { recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'RECRUITER_WITHDRAWAL_REQUESTED', details: { path: ['requestId'], equals: requestId } },
      select: { entityId: true },
    });
    if (previous) {
      const row = previous.entityId ? await tx.affiliatePayout.findFirst({ where: { id: previous.entityId, recruiterId }, select: { id: true, amount: true, status: true, createdAt: true } }) : null;
      if (!row || toCents(row.amount) !== cents) throw fail('IDEMPOTENCY_CONFLICT');
      return { withdrawal: { id: row.id, amountCents: toCents(row.amount), status: row.status, createdAt: row.createdAt }, replayed: true };
    }
    // 3. Recruiter KYC APPROVED (Phase 6 part 3c), then the affiliate-workflow gates: bank
    //    details, then available funds.
    if (!(await identityApproved(tx, recruiterId))) throw fail('RECRUITER_IDENTITY_NOT_APPROVED');
    if (validateBankInfo(me).length > 0) throw fail('INCOMPLETE_BANK_INFO');
    const totals = await walletTotals(tx, recruiterId);
    if (totals.availableCents <= 0 || cents > totals.availableCents) throw fail('INSUFFICIENT_BALANCE');
    const row = await tx.affiliatePayout.create({
      data: { recruiterId, amount: cents / 100, status: 'pending', createdAt: now },
      select: { id: true, amount: true, status: true, createdAt: true },
    });
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId, actorType: 'RECRUITER', actorId: recruiterId, action: 'RECRUITER_WITHDRAWAL_REQUESTED', entityType: 'withdrawal', entityId: row.id,
        details: { requestId, amountCents: cents }, createdAt: now,
      },
    });
    return { withdrawal: { id: row.id, amountCents: toCents(row.amount), status: row.status, createdAt: row.createdAt }, replayed: false };
  });
}

// ── Admin (inside the existing withdrawal management) ────────────────────────

/** The recruiter owner of a withdrawal row, or null (an affiliate row / unknown id). */
export async function recruiterPayoutOwner(id, { db = prisma } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const row = await db.affiliatePayout.findUnique({ where: { id }, select: { recruiterId: true } });
  return row?.recruiterId ?? null;
}

/** Recruiter withdrawal rows for the admin list (same shape as the affiliate rows + owner). */
export async function adminListRecruiterPayouts({ db = prisma } = {}) {
  const rows = await db.affiliatePayout.findMany({
    where: { recruiterId: { not: null } }, orderBy: { createdAt: 'desc' },
    include: { recruiter: { select: { username: true, name: true, bankName: true, rib: true, accountName: true } } },
  });
  return rows.map((p) => ({
    _id: p.id, id: p.id, ownerType: 'recruiter', recruiterId: p.recruiterId, affiliateId: null,
    amount: toCents(p.amount) / 100, status: p.status, createdAt: p.createdAt,
    recruiterUsername: p.recruiter?.username ?? null, recruiterName: p.recruiter?.name ?? null,
    bankName: p.recruiter?.bankName ?? null, rib: p.recruiter?.rib ?? null, accountName: p.recruiter?.accountName ?? null,
  }));
}

/**
 * Admin: process a RECRUITER withdrawal — 'pay' (approve & mark paid, the existing action)
 * or 'reject' (releases the reserved funds). Only a pending row changes (conditional write:
 * a double click or a concurrent admin cannot pay twice or pay a rejected row). Audited.
 * 'pay' (Phase 6 part 3b) locks the recruiter row (the same lock as a request) and re-reads
 * the ledger: refused with INSUFFICIENT_BALANCE when paid + this row would exceed the net
 * earned (a reward reversed after the request). 'reject' is always possible.
 */
export async function adminProcessRecruiterPayout(id, action, { db = prisma, actorId, reason = null, now = new Date() } = {}) {
  if (typeof actorId !== 'string' || !actorId) throw fail('UNAUTHORIZED');
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('NOT_FOUND');
  if (action !== 'pay' && action !== 'reject') throw fail('INVALID_INPUT');
  const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : null;
  return db.$transaction(async (tx) => {
    const row = await tx.affiliatePayout.findFirst({ where: { id, recruiterId: { not: null } }, select: { id: true, recruiterId: true, amount: true, status: true } });
    if (!row) throw fail('NOT_FOUND');
    const status = action === 'pay' ? 'paid' : 'rejected';
    if (action === 'pay') {
      // Serialise with this recruiter's requests / other payments, then re-check the ledger.
      await tx.$queryRaw`SELECT "isActive" FROM "recruiters" WHERE "id" = ${row.recruiterId} FOR NO KEY UPDATE`;
      await lockRecruiterMoney(tx, row.recruiterId); // serialised with reward reversals
      const current = await tx.affiliatePayout.findFirst({ where: { id, recruiterId: row.recruiterId }, select: { status: true } });
      if (current?.status !== 'pending') throw fail('INVALID_STATE');
      // KYC APPROVED at payment time (Phase 6 part 3c) — after the money lock, which an admin
      // KYC decision also takes: a rejection / revocation and a payment never interleave.
      if (!(await identityApproved(tx, row.recruiterId))) throw fail('RECRUITER_IDENTITY_NOT_APPROVED');
      const totals = await walletTotals(tx, row.recruiterId);
      if (totals.paidCents + toCents(row.amount) > totals.earnedCents) throw fail('INSUFFICIENT_BALANCE');
    }
    const res = await tx.affiliatePayout.updateMany({ where: { id, recruiterId: row.recruiterId, status: 'pending' }, data: { status } });
    if (res.count !== 1) throw fail('INVALID_STATE');
    await tx.recruiterAuditLog.create({
      data: {
        recruiterId: row.recruiterId, actorType: 'ADMIN', actorId, action: action === 'pay' ? 'RECRUITER_WITHDRAWAL_PAID' : 'RECRUITER_WITHDRAWAL_REJECTED',
        entityType: 'withdrawal', entityId: id, details: { amountCents: toCents(row.amount), from: 'pending', to: status, reason: cleanReason }, createdAt: now,
      },
    });
    return { _id: id, id, status, amount: toCents(row.amount) / 100 };
  });
}

/** Admin: earned / reserved / paid / available of every recruiter (cents). */
export async function adminRecruiterBalances({ db = prisma } = {}) {
  const [recruiters, ledger, payouts] = await Promise.all([
    db.recruiter.findMany({ select: { id: true, username: true, name: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
    db.recruiterRewardLedger.groupBy({ by: ['recruiterId'], _sum: { amountCents: true } }),
    db.affiliatePayout.findMany({ where: { recruiterId: { not: null } }, select: { recruiterId: true, amount: true, status: true } }),
  ]);
  const earned = new Map(ledger.map((g) => [g.recruiterId, Number(g?._sum?.amountCents ?? 0)]));
  const reserved = new Map();
  const paid = new Map();
  for (const p of payouts) {
    if (releasing(p.status)) continue;
    reserved.set(p.recruiterId, (reserved.get(p.recruiterId) ?? 0) + toCents(p.amount));
    if (p.status === 'paid') paid.set(p.recruiterId, (paid.get(p.recruiterId) ?? 0) + toCents(p.amount));
  }
  return recruiters.map((r) => {
    const e = earned.get(r.id) ?? 0;
    const res = reserved.get(r.id) ?? 0;
    const pd = paid.get(r.id) ?? 0;
    return { recruiterId: r.id, username: r.username, name: r.name, earnedCents: e, reservedCents: res, paidCents: pd, pendingCents: res - pd, availableCents: e - res };
  });
}

/** Admin: the newest ledger rows with recruiter and affiliate usernames. */
export async function adminListRecruiterLedger({ db = prisma, take = 500 } = {}) {
  const rows = await db.recruiterRewardLedger.findMany({
    orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }], take,
    select: { id: true, recruiterId: true, affiliateId: true, type: true, amountCents: true, settingsVersion: true, cycle: true, reason: true, actorType: true, actorId: true, createdAt: true },
  });
  const rIds = [...new Set(rows.map((r) => r.recruiterId))];
  const aIds = [...new Set(rows.map((r) => r.affiliateId).filter(Boolean))];
  const [recs, affs] = await Promise.all([
    rIds.length ? db.recruiter.findMany({ where: { id: { in: rIds } }, select: { id: true, username: true } }) : [],
    aIds.length ? db.affiliate.findMany({ where: { id: { in: aIds } }, select: { id: true, username: true } }) : [],
  ]);
  const rU = new Map(recs.map((r) => [r.id, r.username]));
  const aU = new Map(affs.map((a) => [a.id, a.username]));
  return rows.map((r) => ({
    id: r.id, type: r.type, amountCents: r.amountCents, settingsVersion: r.settingsVersion ?? null, cycle: r.cycle ?? null, reason: r.reason ?? null,
    actorType: r.actorType, createdAt: r.createdAt,
    recruiterId: r.recruiterId, recruiterUsername: rU.get(r.recruiterId) ?? null,
    affiliateId: r.affiliateId ?? null, affiliateUsername: r.affiliateId ? aU.get(r.affiliateId) ?? null : null,
  }));
}
