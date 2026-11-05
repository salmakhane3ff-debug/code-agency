#!/usr/bin/env node
/**
 * scripts/recruiterWithdrawalProtection.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 6 part 3b: negative balance & withdrawal protection.
 * In-memory fake database only (scripts/lib/recruiterFakeDb.mjs, phase5 mode: transactions with
 * read-committed visibility, the recruiter row lock FOR NO KEY UPDATE, the per-affiliate advisory
 * lock and the ledger cycle guard of migration 20261110) — never a real database.
 * Proves:
 *   • available = Σ ledger (reversals included) − reserved; a request is refused when it is ≤ 0
 *     or below the amount (nothing written); == available is accepted
 *   • a reversed reward can be neither requested nor PAID: the admin 'pay' re-checks the ledger
 *     under the recruiter lock (paid + row ≤ earned) → 409 INSUFFICIENT_BALANCE, French text;
 *     'reject' stays possible and releases the row
 *   • concurrency: 20 parallel requests never reserve above available; 2 parallel payments that
 *     together exceed the net earned → exactly one paid; a reversal racing a request / a payment
 *     at every interleaving point ends in a serial outcome (never paid above the earned it read)
 *   • idempotent replay still answers when the balance is now negative
 *   • history preserved (withdrawal rows only change status pending → paid / rejected; the ledger
 *     is append-only); HTTP bodies; static scope checks
 * Run: node scripts/recruiterWithdrawalProtection.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-withdrawal-protection-test-secret-not-real';

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const RS = await import('../src/lib/services/recruiterRewardService.js');
const WS = await import('../src/lib/services/recruiterWalletService.js');
const HK = await import('../src/lib/recruiterRewardHooks.js');
const { recruiterWalletHandlers } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const { recruiterRewardAdminHandlers } = await import('../src/lib/recruiterRewardAdminHandlers.js');
const V = await import('../src/lib/recruiterVisibility.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const big = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }); } catch (e) { return `git error ${e.status}`; } };
// The parent of the Phase 6 part 3a / 3b commit: scope checks compare against this fixed commit
// (never against HEAD), so they give the same answer before and after that commit.
const PART3_BASE = '3607da30969b2303e6cac1b2d6b8dd5fcf9949c0';

const T0 = new Date('2026-11-12T10:00:00.000Z');
const now = () => new Date(T0);
const noLimit = () => null;
const V1 = { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 };
const FR_REFUSED = 'Paiement refusé : le solde net du recruteur (récompenses moins annulations) ne couvre pas ce retrait. Rejetez la demande pour la libérer.';
const INSUFFICIENT = ['INSUFFICIENT', 'BALANCE'].join('_');

let uniq = 0;
/** Recruiter A (bank details complete) and B; settings V1; nothing earned yet. */
function setup({ settings = V1, bank = true } = {}) {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ phase5: true, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
  const A = db._seed.recruiter({ username: 'rec.a', name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: 'rec.b', name: 'Recruteur B' });
  if (settings) db._seed.settings(settings);
  if (bank) Object.assign(db._tables.recruiter.find((r) => r.id === A.id), { bankName: 'CIH Bank', accountName: 'Recruteur A', rib: '011780000012345678901234' });
  return { db, A, B, hookBox };
}
/** A qualified affiliate of `rec` (10 real delivered orders + approved identity). */
function qualified(db, rec) {
  const a = db._seed.affiliate({ username: `wp${++uniq}`, name: `Affilié ${uniq}`, isActive: true });
  db._seed.link({ affiliateId: a.id, recruiterId: rec.id });
  const os = [];
  for (let i = 0; i < 10; i++) os.push(db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: false, commissionAmount: 25 }));
  db._seed.identity({ affiliateId: a.id, status: 'APPROVED' });
  return { a, os };
}
/** Earn one real reward (cycle 1, 150 MAD) through the Part 3a engine. */
async function earn(E, rec = E.A) {
  const q = qualified(E.db, rec);
  const r = await RS.syncRecruiterReward(q.a.id, { db: E.db, now: T0 });
  if (r.action !== 'AWARDED') throw new Error(`setup: expected AWARDED, got ${r.action}`);
  return q;
}
/** The admin cancels one delivered order → the post-commit hook reverses the open reward. */
async function reverse(E, q) {
  const o = E.db._tables.affiliateOrder.find((x) => x.affiliateId === q.a.id && x.status === 'delivered');
  o.status = 'cancelled';
  return HK.onRecruiterOrderStatusCommitted(o.id, { db: E.db });
}
const request = (E, amountMad, requestId = randomUUID(), rec = E.A) => WS.requestRecruiterWithdrawal(rec.id, { amountMad, requestId }, { db: E.db, now: T0 })
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e?.code ?? String(e) }));
const pay = (E, id, action = 'pay', actorId = 'admin-1') => WS.adminProcessRecruiterPayout(id, action, { db: E.db, actorId, now: T0 })
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e?.code ?? String(e) }));
const totals = async (E, rec = E.A) => (await WS.getRecruiterWallet(rec.id, { db: E.db })).totals;
const payouts = (E, rec = E.A) => E.db._tables.affiliatePayout.filter((p) => p.recruiterId === rec.id);
const audits = (E, action) => E.db._tables.recruiterAuditLog.filter((r) => r.action === action);
const ledgerSum = (E, rec = E.A) => E.db._tables.recruiterRewardLedger.filter((r) => r.recruiterId === rec.id).reduce((t, r) => t + r.amountCents, 0);
const cents = (p) => Math.round(Number(p.amount) * 100);
const paidCents = (E, rec = E.A) => payouts(E, rec).filter((p) => p.status === 'paid').reduce((t, p) => t + cents(p), 0);
const snap = (E) => ({ p: E.db._tables.affiliatePayout.length, a: E.db._tables.recruiterAuditLog.length, l: E.db._tables.recruiterRewardLedger.length });

// ── 1. balance from the authoritative ledger ────────────────────────────────────
console.log('\n1. Available = Σ ledger (reversals included) − reserved');
{
  const E = setup();
  const q1 = await earn(E);
  await earn(E);
  E.db._seed.ledger({ recruiterId: E.A.id, type: 'ADMIN_ADJUSTMENT', amountCents: -2500, actorType: 'ADMIN', actorId: 'admin-1', idempotencyKey: `adj:${randomUUID()}` });
  const t0 = await totals(E);
  ok('earned = Σ of every ledger row of the recruiter (2 rewards + a −25 MAD adjustment = 275 MAD)', t0.earnedCents === ledgerSum(E) && t0.earnedCents === 27500, big(t0));
  await reverse(E, q1);
  const t1 = await totals(E);
  ok('a reversal lowers earned at once (275 − 150 = 125 MAD), still = Σ ledger', t1.earnedCents === 12500 && t1.earnedCents === ledgerSum(E), big(t1));
  const w = await request(E, '100');
  const t2 = await totals(E);
  ok('available = earned − reserved after a 100 MAD request (125 − 100 = 25 MAD)', w.ok && t2.availableCents === 2500 && t2.availableCents === t2.earnedCents - t2.pendingCents - t2.paidCents, big(t2));
  ok('the recruiter of B is untouched (0 earned, 0 available)', eq(await totals(E, E.B), { earnedCents: 0, reservedCents: 0, paidCents: 0, pendingCents: 0, availableCents: 0 }));
}

// ── 2. request gates ──────────────────────────────────────────────────────────
console.log('\n2. Request refused when available ≤ 0 or below the amount (nothing written)');
{
  const Z = setup();
  const s0 = snap(Z);
  const zero = await request(Z, '0.01');
  ok('available 0 (nothing earned) → INSUFFICIENT_BALANCE, nothing written', !zero.ok && zero.code === INSUFFICIENT && eq(snap(Z), s0), big(zero));

  const N = setup();
  const q = await earn(N);
  const w = await request(N, '150');
  await reverse(N, q);
  const tn = await totals(N);
  ok('reward → 150 MAD pending → reversal: available is NEGATIVE (−150 MAD)', w.ok && tn.availableCents === -15000 && tn.earnedCents === 0, big(tn));
  const s1 = snap(N);
  const neg = await request(N, '0.01');
  ok('negative available → any request (even 0.01 MAD) → INSUFFICIENT_BALANCE, nothing written', !neg.ok && neg.code === INSUFFICIENT && eq(snap(N), s1), big(neg));
  const wv = V.toRecruiterWalletView(await WS.getRecruiterWallet(N.A.id, { db: N.db }));
  ok('the wallet view keeps the negative available (not clamped to 0) so the page can explain it', wv.totals.availableCents === -15000);

  const X = setup();
  await earn(X);
  const s2 = snap(X);
  const over = await request(X, '150.01');
  ok('amount above available (150.01 > 150.00) → INSUFFICIENT_BALANCE, nothing written', !over.ok && over.code === INSUFFICIENT && eq(snap(X), s2));
  const exact = await request(X, '150.00');
  ok('amount == available (150.00) → accepted, pending; available then 0', exact.ok && exact.r.withdrawal.status === 'pending' && (await totals(X)).availableCents === 0);
  const after = await request(X, '0.01');
  ok('…then available 0 → the next request is refused', !after.ok && after.code === INSUFFICIENT);
}

// ── 3. reversed rewards can never be withdrawn ────────────────────────────────
console.log('\n3. A reversed reward can be neither requested nor paid');
{
  const R = setup();
  const q = await earn(R);
  await reverse(R, q);
  const r = await request(R, '150');
  ok('reward then reversal → a request for it → INSUFFICIENT_BALANCE (no row)', !r.ok && r.code === INSUFFICIENT && payouts(R).length === 0);

  const P = setup();
  const qp = await earn(P);
  const w = await request(P, '150');
  await reverse(P, qp);
  const admin = recruiterRewardAdminHandlers({ db: P.db, now });
  const res = await admin.payoutAction(w.r.withdrawal.id, 'pay', { userId: 'admin-1', role: 'ADMIN' });
  const body = await res.json();
  ok('reward → request pending → reversal → admin pay → 409 INSUFFICIENT_BALANCE with the fixed French text',
    res.status === 409 && eq(body, { code: INSUFFICIENT, error: FR_REFUSED }), `${res.status} ${big(body)}`);
  ok('…the withdrawal stays pending, no RECRUITER_WITHDRAWAL_PAID audit, paid stays 0',
    payouts(P)[0].status === 'pending' && audits(P, 'RECRUITER_WITHDRAWAL_PAID').length === 0 && paidCents(P) === 0);
  const rej = await admin.payoutAction(w.r.withdrawal.id, 'reject', { userId: 'admin-1' }, 'récompense annulée');
  const tp = await totals(P);
  ok('…reject is still possible → rejected (audited), the reservation is released: available back to 0',
    rej.status === 200 && payouts(P)[0].status === 'rejected' && audits(P, 'RECRUITER_WITHDRAWAL_REJECTED').length === 1 && tp.availableCents === 0 && tp.pendingCents === 0, big(tp));
  const again = await pay(P, w.r.withdrawal.id);
  ok('…a rejected row can no longer be paid (INVALID_STATE)', !again.ok && again.code === 'INVALID_STATE');

  const C = setup();
  await earn(C);
  const wc = await request(C, '100');
  const pc = await pay(C, wc.r.withdrawal.id);
  ok('covered (earned 150, paid 0 + 100 ≤ 150) → paid, audited RECRUITER_WITHDRAWAL_PAID', pc.ok && pc.r.status === 'paid' && audits(C, 'RECRUITER_WITHDRAWAL_PAID').length === 1);

  // two pending rows after a partial reversal: only the ones fitting paid + row ≤ earned
  const T = setup();
  const t1 = await earn(T);
  await earn(T);
  const big200 = await request(T, '200');
  const small100 = await request(T, '100');
  await reverse(T, t1); // earned 300 → 150, reserved 300 → available −150
  const p200 = await pay(T, big200.r.withdrawal.id);
  const p100 = await pay(T, small100.r.withdrawal.id);
  const p200b = await pay(T, big200.r.withdrawal.id);
  ok('earned 150 after a partial reversal: pay 200 → refused; pay 100 → paid; pay 200 again → still refused',
    !p200.ok && p200.code === INSUFFICIENT && p100.ok && !p200b.ok && p200b.code === INSUFFICIENT, big({ p200, p100, p200b }));
  const r200 = await pay(T, big200.r.withdrawal.id, 'reject');
  const tt = await totals(T);
  ok('…rejecting the 200 releases it: earned 150, paid 100, available 50 — never paid above earned',
    r200.ok && tt.earnedCents === 15000 && tt.paidCents === 10000 && tt.availableCents === 5000 && paidCents(T) <= ledgerSum(T), big(tt));
}

// ── 4. concurrency ────────────────────────────────────────────────────────────
console.log('\n4. Concurrency: parallel requests and payments');
{
  const E = setup();
  E.db._seed.ledger({ recruiterId: E.A.id, type: 'ADMIN_ADJUSTMENT', amountCents: 20000, actorType: 'ADMIN', actorId: 'admin-1', idempotencyKey: `adj:${randomUUID()}` });
  const par = await Promise.all(Array.from({ length: 20 }, () => request(E, '30')));
  const reserved = payouts(E).reduce((t, p) => t + cents(p), 0);
  ok('20 concurrent 30 MAD requests (distinct requestIds) with 200 MAD available → exactly floor(200/30) = 6 created, 14 INSUFFICIENT_BALANCE',
    par.filter((r) => r.ok).length === 6 && par.filter((r) => r.code === INSUFFICIENT).length === 14, par.map((r) => (r.ok ? 'ok' : r.code)).join(','));
  ok('…reserved 180 MAD ≤ 200 available; available never negative', reserved === 18000 && (await totals(E)).availableCents === 2000);

  const D = setup();
  const d1 = await earn(D);
  await earn(D);
  const wa = await request(D, '150');
  const wb = await request(D, '150');
  await reverse(D, d1); // earned 300 → 150 with 300 reserved
  const both = await Promise.all([pay(D, wa.r.withdrawal.id, 'pay', 'admin-1'), pay(D, wb.r.withdrawal.id, 'pay', 'admin-2')]);
  ok('2 concurrent payments of 150 + 150 with a net earned of 150 → exactly one paid, the other INSUFFICIENT_BALANCE',
    both.filter((r) => r.ok).length === 1 && both.filter((r) => r.code === INSUFFICIENT).length === 1 && paidCents(D) === 15000 && paidCents(D) <= ledgerSum(D), big(both));

  const S = setup();
  await earn(S);
  const ws = await request(S, '100');
  const five = await Promise.all(Array.from({ length: 5 }, (_v, i) => pay(S, ws.r.withdrawal.id, 'pay', `admin-${i}`)));
  ok('5 concurrent payments of the SAME row → 1 paid, 4 INVALID_STATE, one audit', five.filter((r) => r.ok).length === 1 && five.filter((r) => r.code === 'INVALID_STATE').length === 4 && audits(S, 'RECRUITER_WITHDRAWAL_PAID').length === 1);

  // requests racing a reversal: whatever the order, everything paid afterwards stays ≤ earned
  const M = setup();
  const m1 = await earn(M);
  await earn(M); // earned 300
  const mixed = await Promise.all([...Array.from({ length: 10 }, () => request(M, '40')), reverse(M, m1)]);
  for (const p of payouts(M).filter((x) => x.status === 'pending')) await pay(M, p.id);
  ok('10 concurrent 40 MAD requests racing a reversal (300 → 150): at most 7 created, then paying every pending row pays only ≤ 150 MAD',
    mixed.slice(0, 10).filter((r) => r.ok).length <= 7 && paidCents(M) <= ledgerSum(M) && ledgerSum(M) === 15000, big({ created: mixed.slice(0, 10).filter((r) => r.ok).length, paid: paidCents(M) }));
}

// ── 5. reversal vs withdrawal at every interleaving point ─────────────────────
console.log('\n5. A reversal racing a request / a payment — every interleaving point (shared money lock)');
const MONEY = (rec) => `__advisory__:recruiter-money:${rec.id}`;
const holdsMoney = (E, rec = E.A) => E.db._locks.has(MONEY(rec));
const rawLedgerSum = (E, rec = E.A) => E.db._tables.recruiterRewardLedger.filter((r) => r.recruiterId === rec.id).reduce((t, r) => t + r.amountCents, 0);
const settle = (p, ms) => Promise.race([p.then(() => 'done', () => 'done'), new Promise((r) => setTimeout(() => r('blocked'), ms))]);
/**
 * Run `main` and, at its k-th database step, pause it and START `inject` (its own transaction, from
 * the TEST context). The injected call either completes, or BLOCKS on a lock `main` holds (it is then
 * given 30 ms to prove it waits); `main` is then resumed and both are awaited.
 * → { paused, heldAtPause, blocked, mainOut, injOut } — heldAtPause: main held the money lock.
 */
async function interleave(E, k, main, inject, { onInject = null } = {}) {
  let count = 0;
  let reachedRes; const reached = new Promise((r) => { reachedRes = r; });
  let resumeRes; const resume = new Promise((r) => { resumeRes = r; });
  let paused = null;
  let heldAtPause = false;
  E.hookBox.fn = async (m, o) => { count += 1; if (count === k) { paused = `${m}.${o}`; heldAtPause = holdsMoney(E); reachedRes('reached'); await resume; } };
  const mainP = main();
  const first = await Promise.race([reached, mainP.then(() => 'done')]);
  E.hookBox.fn = onInject;
  const injP = inject();
  const blocked = (await settle(injP, 30)) === 'blocked';
  resumeRes();
  const [mainOut, injOut] = await Promise.all([mainP, injP]);
  E.hookBox.fn = null;
  return { paused: first === 'reached' ? paused : null, heldAtPause, blocked, mainOut, injOut };
}
/** The hook-visible database steps of an uninterrupted call, with "money lock held" per step. */
async function stepsOf(E, fn) {
  const steps = [];
  E.hookBox.fn = (m, o) => { steps.push({ step: `${m}.${o}`, money: holdsMoney(E), rowLock: E.db._locks.has(E.A.id) }); };
  await fn();
  E.hookBox.fn = null;
  return steps;
}
{
  // ── lock order, observed at run time ──
  const probe = setup();
  const pq = await earn(probe);
  const pw = await request(probe, '150');
  const reqSteps0 = await stepsOf(probe, () => request(probe, '0.01'));
  const paySteps = await stepsOf(probe, () => pay(probe, pw.r.withdrawal.id));
  const at = (steps, s, from = 0) => steps.findIndex((x, i) => i >= from && x.step === s);
  const pRow = at(paySteps, '$queryRaw.query');
  const pStatus = at(paySteps, 'affiliatePayout.findFirst', pRow + 1);
  const pAgg = at(paySteps, 'recruiterRewardLedger.aggregate');
  const pUpd = at(paySteps, 'affiliatePayout.updateMany');
  ok('pay lock order: row lookup (no lock) → recruiter row FOR NO KEY UPDATE → money lock → status re-read → ledger re-check → conditional update',
    pRow > 0 && !paySteps[pRow].money && pStatus > pRow && paySteps[pStatus].money && paySteps[pStatus].rowLock
    && pAgg > pStatus && paySteps[pAgg].money && pUpd > pAgg && paySteps[pUpd].money && paySteps.slice(0, pRow + 1).every((x) => !x.money),
    big(paySteps));
  ok('request does NOT take the money lock (row lock only), and still reads the ledger under the row lock',
    reqSteps0.every((x) => !x.money) && reqSteps0.some((x) => x.step === 'recruiterRewardLedger.aggregate' && x.rowLock), big(reqSteps0));
  const rprobe = setup();
  const rq = await earn(rprobe);
  await request(rprobe, '150');
  const o = rprobe.db._tables.affiliateOrder.find((x) => x.affiliateId === rq.a.id && x.status === 'delivered');
  o.status = 'cancelled';
  const affKey = `__advisory__:recruit:${rq.a.id}`;
  const revSteps = [];
  rprobe.hookBox.fn = (m, op, a) => { revSteps.push({ step: `${m}.${op}`, type: a?.data?.type ?? null, aff: rprobe.db._locks.has(affKey), money: holdsMoney(rprobe), owner: rprobe.db._locks.get(MONEY(rprobe.A))?.tx ?? null, affOwner: rprobe.db._locks.get(affKey)?.tx ?? null }); };
  const rr = await RS.syncRecruiterReward(rq.a.id, { db: rprobe.db, now: T0 });
  rprobe.hookBox.fn = null;
  const ins = revSteps.findIndex((x) => x.step === 'recruiterRewardLedger.create');
  const cnt = revSteps.findIndex((x) => x.step === 'affiliateOrder.count');
  ok('reversal lock order: affiliate lock → (count, threshold) → money lock → REVERSAL insert, both locks held by the SAME transaction',
    rr.action === 'REVERSED' && ins > 0 && revSteps[ins].type === 'REVERSAL' && revSteps[ins].aff && revSteps[ins].money && revSteps[ins].owner === revSteps[ins].affOwner
    && cnt >= 0 && cnt < ins && revSteps[cnt].aff && !revSteps[cnt].money, big(revSteps));
  const nprobe = setup();
  const nq = await earn(nprobe);
  void nq;
  const nSteps = [];
  nprobe.hookBox.fn = () => { nSteps.push(holdsMoney(nprobe)); };
  const nc = await RS.syncRecruiterReward(nq.a.id, { db: nprobe.db, now: T0 });
  nprobe.hookBox.fn = null;
  ok('a sync that does NOT reverse (NO_CHANGE) never takes the money lock', nc.action === 'NO_CHANGE' && nSteps.every((x) => !x), big({ nc, nSteps }));
  void pq;

  // a) pay (main) vs reversal (injected)
  const aOut = [];
  let aGood = true;
  for (let k = 1; k <= paySteps.length + 1; k++) {
    const E = setup();
    const q = await earn(E);
    const w = await request(E, '150');
    let atInsert = null;
    const onInject = (m, op, a) => { if (m === 'recruiterRewardLedger' && op === 'create' && a?.data?.type === 'REVERSAL') atInsert = { paidAudit: audits(E, 'RECRUITER_WITHDRAWAL_PAID').length, open: E.db._openTx.size, payStatus: payouts(E)[0].status }; };
    const { paused, heldAtPause, blocked, mainOut, injOut } = await interleave(E, k, () => pay(E, w.r.withdrawal.id), () => reverse(E, q), { onInject });
    let g = injOut.action === 'REVERSED' && ledgerSum(E) === 0 && atInsert !== null;
    if (paused !== null && heldAtPause) {
      // the pay holds the money lock: the reversal WAITS, the pay commits first, then the reversal inserts
      g = g && blocked && mainOut.ok && paidCents(E) === 15000 && atInsert.paidAudit === 1 && atInsert.open === 1 && atInsert.payStatus === 'paid';
    } else if (paused !== null) {
      // paused before the money lock: the reversal commits first → the pay's re-check sees it → refused
      g = g && !blocked && !mainOut.ok && mainOut.code === INSUFFICIENT && payouts(E)[0].status === 'pending' && paidCents(E) === 0 && atInsert.paidAudit === 0;
    } else {
      g = g && mainOut.ok && paidCents(E) === 15000 && atInsert.paidAudit === 1 && atInsert.open === 1;
    }
    if (!g) aGood = false;
    aOut.push(`${k}:${paused ?? 'done'}:${heldAtPause ? 'L' : '-'}:${blocked ? 'waited' : 'ran'}:${mainOut.ok ? 'paid' : mainOut.code}`);
  }
  ok('pay racing a reversal at EVERY step: pay holding the money lock → the reversal WAITS and inserts only after the pay committed; before the lock → reversal first, pay refused',
    aGood, aOut.join(' | '));
  ok('…both outcomes occur, and the reversal actually waited at least once (the lock is real)',
    aOut.some((x) => x.endsWith(':paid')) && aOut.some((x) => x.endsWith(`:${INSUFFICIENT}`)) && aOut.some((x) => x.includes(':waited:')), aOut.join(' | '));

  // b) request (main) vs reversal (injected): no shared lock — never waits; a created row can never be paid
  const bprobe = setup();
  await earn(bprobe);
  const reqSteps = await stepsOf(bprobe, () => request(bprobe, '150'));
  const reqAggAt = reqSteps.findIndex((x) => x.step === 'recruiterRewardLedger.aggregate') + 1;
  const rOut = [];
  let rSerial = true;
  for (let k = 1; k <= reqSteps.length + 1; k++) {
    const E = setup();
    const q = await earn(E);
    const { paused, blocked, mainOut, injOut } = await interleave(E, k, () => request(E, '150'), () => reverse(E, q));
    const expectRefused = paused !== null && k <= reqAggAt;
    let good = !blocked && injOut.action === 'REVERSED'
      && (expectRefused ? (!mainOut.ok && mainOut.code === INSUFFICIENT && payouts(E).length === 0) : (mainOut.ok && payouts(E).length === 1));
    if (mainOut.ok) {
      const p = await pay(E, mainOut.r.withdrawal.id);
      good = good && !p.ok && p.code === INSUFFICIENT && paidCents(E) === 0;
    }
    if (!good || paidCents(E) > ledgerSum(E)) rSerial = false;
    rOut.push(`${k}:${paused ?? 'done'}:${blocked ? 'waited' : 'ran'}:${mainOut.ok ? 'created' : mainOut.code}`);
  }
  ok('request racing a reversal at EVERY step: the reversal never waits (no shared lock); refused when the reversal is visible, else created — and a created one can then NEVER be paid',
    rSerial && rOut.some((o2) => o2.endsWith(':created')) && rOut.some((o2) => o2.endsWith(`:${INSUFFICIENT}`)), rOut.join(' | '));

  // c) reversal (main) vs pay (injected)
  const cprobe = setup();
  const cq = await earn(cprobe);
  await request(cprobe, '150');
  const cSteps = await stepsOf(cprobe, () => reverse(cprobe, cq));
  const cOut = [];
  let cGood = true;
  for (let k = 1; k <= cSteps.length + 1; k++) {
    const E = setup();
    const q = await earn(E);
    const w = await request(E, '150');
    const { paused, heldAtPause, blocked, mainOut, injOut } = await interleave(E, k, () => reverse(E, q), () => pay(E, w.r.withdrawal.id));
    let g = mainOut.action === 'REVERSED' && ledgerSum(E) === 0;
    if (paused !== null && heldAtPause) {
      // the reversal holds the money lock: the pay WAITS, then sees the committed reversal → refused
      g = g && blocked && !injOut.ok && injOut.code === INSUFFICIENT && payouts(E)[0].status === 'pending' && paidCents(E) === 0;
    } else if (paused !== null) {
      // paused before the money lock: the pay runs to its commit first → paid, then the reversal (debt)
      g = g && !blocked && injOut.ok && paidCents(E) === 15000;
    } else {
      g = g && !injOut.ok && injOut.code === INSUFFICIENT && paidCents(E) === 0;
    }
    if (!g) cGood = false;
    cOut.push(`${k}:${paused ?? 'done'}:${heldAtPause ? 'L' : '-'}:${blocked ? 'waited' : 'ran'}:${injOut.ok ? 'paid' : injOut.code}`);
  }
  ok('reversal racing a payment at EVERY step: reversal holding the money lock → the pay WAITS, then is refused; before the lock → pay commits first (paid, then reversed)',
    cGood && cOut.some((x) => x.includes(':L:waited:')), cOut.join(' | '));

  // d) 100 randomized-timing iterations: reversal vs payment (and request vs reversal)
  let seed = 0x5eed3b;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const jitter = () => (rnd() < 0.5 ? new Promise((r) => setTimeout(r, Math.floor(rnd() * 3))) : new Promise((r) => { let n = Math.floor(rnd() * 4); const go = () => (n-- > 0 ? setImmediate(go) : r()); go(); }));
  const guard = (p, ms, label) => Promise.race([p, new Promise((_r, j) => setTimeout(() => j(new Error(`HANG: ${label}`)), ms))]);
  const tally = { paidThenReversed: 0, reversedThenRefused: 0 };
  const violations = [];
  for (let i = 0; i < 100; i++) {
    const E = setup();
    const q = await earn(E);
    const w = await request(E, '150');
    const ev = [];
    E.hookBox.fn = async (m, op, a) => {
      if (m === 'recruiterAuditLog' && op === 'create' && a?.data?.action === 'RECRUITER_WITHDRAWAL_PAID') {
        // the pay's last write before its commit: no reversal row may exist (committed or not), paid ≤ earned
        if (rawLedgerSum(E) < 15000 || paidCents(E) > rawLedgerSum(E)) violations.push(`${i}: pay committing with ledger ${rawLedgerSum(E)}`);
        ev.push('pay-final-write');
      }
      if (m === 'recruiterRewardLedger' && op === 'create' && a?.data?.type === 'REVERSAL') {
        if (audits(E, 'RECRUITER_WITHDRAWAL_PAID').length && E.db._openTx.size !== 1) violations.push(`${i}: reversal inserting while the pay is still open`);
        ev.push('reversal-insert');
      }
      await jitter();
    };
    const d0 = jitter();
    const [pr, rv] = await guard(Promise.all([
      (rnd() < 0.5 ? d0 : Promise.resolve()).then(() => pay(E, w.r.withdrawal.id)),
      (rnd() < 0.5 ? Promise.resolve() : jitter()).then(() => reverse(E, q)),
    ]), 5000, `iteration ${i}`).catch((e) => { violations.push(e.message); return [{}, {}]; });
    E.hookBox.fn = null;
    const t = await totals(E);
    if (rv.action !== 'REVERSED' || ledgerSum(E) !== 0) violations.push(`${i}: reversal ${rv.action}`);
    if (pr.ok) {
      tally.paidThenReversed += 1;
      if (!(ev.indexOf('pay-final-write') >= 0 && ev.indexOf('pay-final-write') < ev.indexOf('reversal-insert')) || t.paidCents !== 15000 || t.availableCents !== -15000) violations.push(`${i}: paid but order ${ev.join('>')} / ${big(t)}`);
    } else {
      tally.reversedThenRefused += 1;
      if (pr.code !== INSUFFICIENT || payouts(E)[0].status !== 'pending' || t.paidCents !== 0 || t.availableCents !== -15000 || ev.includes('pay-final-write')) violations.push(`${i}: refused ${pr.code} ${big(t)}`);
    }
    if (audits(E, 'RECRUITER_WITHDRAWAL_PAID').length !== (pr.ok ? 1 : 0) || E.db._openTx.size !== 0 || E.db._locks.size !== 0) violations.push(`${i}: audit/lock leak`);
  }
  ok('100 randomized-timing reversal-vs-payment races: no hang, no deadlock, no lock leak; a paid row always committed BEFORE the reversal inserted; paid ≤ earned at every pay commit',
    violations.length === 0, violations.slice(0, 5).join(' | '));
  ok(`…both serial orders occurred across the 100 runs ${big(tally)}`, tally.paidThenReversed > 0 && tally.reversedThenRefused > 0 && tally.paidThenReversed + tally.reversedThenRefused === 100, big(tally));

  const rViol = [];
  const rTally = { created: 0, refused: 0 };
  for (let i = 0; i < 50; i++) {
    const E = setup();
    const q = await earn(E);
    E.hookBox.fn = async () => { await jitter(); };
    const [rq2, rv] = await guard(Promise.all([
      new Promise((r) => setTimeout(r, Math.floor(rnd() * 12))).then(() => request(E, '150')),
      (rnd() < 0.5 ? jitter() : Promise.resolve()).then(() => reverse(E, q)),
    ]), 5000, `request iteration ${i}`).catch((e) => { rViol.push(e.message); return [{}, {}]; });
    E.hookBox.fn = null;
    if (rq2.ok) {
      rTally.created += 1;
      const p = await pay(E, rq2.r.withdrawal.id);
      if (p.ok || p.code !== INSUFFICIENT) rViol.push(`${i}: created row was paid`);
    } else {
      rTally.refused += 1;
      if (rq2.code !== INSUFFICIENT || payouts(E).length !== 0) rViol.push(`${i}: refused ${rq2.code}`);
    }
    const t = await totals(E);
    if (rv.action !== 'REVERSED' || t.paidCents !== 0 || t.earnedCents !== 0 || t.availableCents !== -(rq2.ok ? 15000 : 0) || E.db._locks.size !== 0) rViol.push(`${i}: ${big(t)}`);
  }
  ok(`50 randomized-timing request-vs-reversal races: consistent totals, nothing ever paid, no hang / lock leak ${big(rTally)}`,
    rViol.length === 0 && rTally.created > 0 && rTally.refused > 0, `${rViol.slice(0, 5).join(' | ')} ${big(rTally)}`);

  const E2 = setup();
  const q2 = await earn(E2);
  const w2 = await request(E2, '150');
  await pay(E2, w2.r.withdrawal.id);
  await reverse(E2, q2);
  const t2 = await totals(E2);
  const n2 = await request(E2, '0.01');
  ok('paid BEFORE the reversal: available −150 (no clawback); every later request refused until new rewards offset it',
    t2.availableCents === -15000 && t2.paidCents === 15000 && !n2.ok && n2.code === INSUFFICIENT, big(t2));
  await earn(E2);
  await earn(E2);
  const t3 = await totals(E2);
  const n3 = await request(E2, '150.01');
  const y3 = await request(E2, '150');
  ok('…two new rewards (+300) offset the debt: available 150, a request above is refused, 150 accepted', t3.availableCents === 15000 && !n3.ok && y3.ok, big(t3));
}

// ── 6. idempotent replay and history ──────────────────────────────────────────
console.log('\n6. Replay with a negative balance; history preserved; append-only ledger');
{
  const E = setup();
  const q = await earn(E);
  const rid = randomUUID();
  const first = await request(E, '150', rid);
  await reverse(E, q);
  const replay = await request(E, '150', rid);
  ok('the same requestId after the balance went negative → the first result replayed (same id, replayed:true), no new row',
    first.ok && replay.ok && replay.r.replayed === true && replay.r.withdrawal.id === first.r.withdrawal.id && payouts(E).length === 1, big(replay));
  const conflict = await request(E, '100', rid);
  ok('…the same requestId with another amount → IDEMPOTENCY_CONFLICT', !conflict.ok && conflict.code === 'IDEMPOTENCY_CONFLICT');

  const H = setup();
  const h1 = await earn(H);
  await earn(H);
  const a = await request(H, '100');
  const b = await request(H, '120');
  const c = await request(H, '50');
  const ledgerBefore = big(H.db._tables.recruiterRewardLedger);
  const payoutsBefore = H.db._tables.affiliatePayout.map((p) => ({ ...p }));
  await reverse(H, h1);
  await pay(H, a.r.withdrawal.id);
  await pay(H, b.r.withdrawal.id); // refused (100 + 120 > 150)
  await pay(H, c.r.withdrawal.id, 'reject');
  const ledgerAfter = JSON.parse(big(H.db._tables.recruiterRewardLedger));
  ok('the ledger is only appended to: every earlier row identical, the reversal added after them',
    big(ledgerAfter.slice(0, JSON.parse(ledgerBefore).length)) === ledgerBefore && ledgerAfter.length === JSON.parse(ledgerBefore).length + 1 && ledgerAfter.at(-1).type === 'REVERSAL');
  const changed = H.db._tables.affiliatePayout.map((p) => {
    const was = payoutsBefore.find((x) => x.id === p.id);
    return { id: p.id, same: big({ ...p, status: null }) === big({ ...was, status: null }), from: was.status, to: p.status };
  });
  ok('withdrawal rows: none added, none removed; only the status changed (pending → paid / pending / rejected), nothing else rewritten',
    H.db._tables.affiliatePayout.length === payoutsBefore.length && changed.every((x) => x.same && x.from === 'pending')
    && eq(changed.map((x) => x.to), ['paid', 'pending', 'rejected']), big(changed));
  ok('payout writes are only status updateMany calls conditioned on status pending', H.db._payoutCalls.filter((x) => !['create', 'findMany', 'findFirst', 'findUnique', 'aggregate'].includes(x.op)).every((x) => x.op === 'updateMany' && x.where?.status === 'pending' && eq(keys(x.data), ['status'])));
  let upd = null, del = null;
  try { await H.db.recruiterRewardLedger.update({ where: { id: ledgerAfter[0].id }, data: { amountCents: 1 } }); } catch (e) { upd = e; }
  try { await H.db.recruiterRewardLedger.delete({ where: { id: ledgerAfter[0].id } }); } catch (e) { del = e; }
  ok('the ledger stays append-only (update / delete rejected by the guard)', !!upd && !!del && /append-only/.test(String(upd?.message)) && /append-only/.test(String(del?.message)));
  ok('history: the wallet still lists every reward, the reversal and the 3 withdrawals with their statuses',
    await WS.getRecruiterWallet(H.A.id, { db: H.db }).then((w) => w.rewards.length === 3 && w.withdrawals.length === 3 && eq(w.withdrawals.map((x) => x.status).sort(), ['paid', 'pending', 'rejected'])));
}

// ── 7. HTTP ───────────────────────────────────────────────────────────────────
console.log('\n7. HTTP bodies: recruiter 400 { code } only; admin 409 French text');
{
  const E = setup();
  const q = await earn(E);
  const h = recruiterWalletHandlers({ db: E.db, now, rateLimit: noLimit });
  const withdraw = withRecruiterAuth(h.withdraw);
  const wallet = withRecruiterAuth(h.wallet);
  const cookie = `recruiter_token=${signToken({ recruiterId: E.A.id, username: E.A.username, type: 'recruiter' })}`;
  const post = async (amountMad) => {
    const res = await withdraw(new Request('http://localhost/api/recruiter/wallet/withdrawals', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ amountMad, requestId: randomUUID() }) }), {});
    return { status: res.status, body: await res.json() };
  };
  const created = await post('150');
  await reverse(E, q);
  const refused = await post('1');
  ok('recruiter POST /withdrawals with a negative balance → 400 exactly { code: "INSUFFICIENT_BALANCE" } (no balance, message or error field)',
    created.status === 201 && refused.status === 400 && eq(refused.body, { code: INSUFFICIENT }), big({ created, refused }));
  const wres = await wallet(new Request('http://localhost/api/recruiter/wallet', { headers: { cookie } }), {});
  const wbody = await wres.json();
  ok('recruiter GET /wallet → availableCents −15000 (the page shows the negative banner), the reversal listed as a negative entry',
    wres.status === 200 && wbody.wallet.totals.availableCents === -15000 && wbody.wallet.rewards.some((r) => r.type === 'REVERSAL' && r.amountCents === -15000), big(wbody.wallet?.totals));
  const admin = recruiterRewardAdminHandlers({ db: E.db, now });
  const res = await admin.payoutAction(created.body.withdrawal.id, 'pay', { userId: 'admin-1', role: 'ADMIN' });
  const body = await res.json();
  ok('admin pay (payoutAction, used by PUT /api/admin/affiliate-payouts) → 409 { code, error: fixed French text } with no-store',
    res.status === 409 && eq(keys(body), ['code', 'error']) && body.code === INSUFFICIENT && body.error === FR_REFUSED && res.headers.get('cache-control') === 'no-store');
  ok('INSUFFICIENT_BALANCE stays an allowlisted recruiter error code', V.RECRUITER_ERROR_CODES.includes(INSUFFICIENT));
}

// ── 8. static scope checks ────────────────────────────────────────────────────
console.log('\n8. Static: UI texts, service shape, scope');
{
  const ws = stripJs(read('src/lib/services/recruiterWalletService.js'));
  ok('request: refused when available ≤ 0 or below the amount, after the recruiter lock',
    /if \(totals\.availableCents <= 0 \|\| cents > totals\.availableCents\) throw fail\('INSUFFICIENT_BALANCE'\)/.test(ws)
    && ws.indexOf('FOR NO KEY UPDATE') < ws.indexOf('totals.availableCents <= 0'));
  const payFn = ws.slice(ws.indexOf('export async function adminProcessRecruiterPayout'), ws.indexOf('export async function adminRecruiterBalances'));
  ok('pay: recruiter row lock → money lock → status re-read → walletTotals → paid + row ≤ earned, all before the conditional updateMany',
    /SELECT "isActive" FROM "recruiters" WHERE "id" = \$\{row\.recruiterId\} FOR NO KEY UPDATE/.test(payFn)
    && /await lockRecruiterMoney\(tx, row\.recruiterId\);/.test(payFn)
    && /if \(totals\.paidCents \+ toCents\(row\.amount\) > totals\.earnedCents\) throw fail\('INSUFFICIENT_BALANCE'\)/.test(payFn)
    && payFn.indexOf('FOR NO KEY UPDATE') < payFn.indexOf('lockRecruiterMoney(') && payFn.indexOf('lockRecruiterMoney(') < payFn.indexOf("select: { status: true }")
    && payFn.indexOf("select: { status: true }") < payFn.indexOf('walletTotals') && payFn.indexOf('walletTotals') < payFn.indexOf('updateMany'));
  const reqFn = ws.slice(ws.indexOf('export async function requestRecruiterWithdrawal'), ws.indexOf('export async function recruiterPayoutOwner'));
  ok('request does NOT take the money lock; the wallet service gets it ONLY from the reward service (one shared helper, one key)',
    reqFn.length > 100 && !reqFn.includes('lockRecruiterMoney') && (ws.match(/lockRecruiterMoney\(/g) || []).length === 1
    && /import \{ lockRecruiterMoney \} from '\.\/recruiterRewardService\.js';/.test(ws) && !/pg_advisory/.test(ws));
  const rsrc = stripJs(read('src/lib/services/recruiterRewardService.js'));
  const syncFn = rsrc.slice(rsrc.indexOf('export async function syncRecruiterReward'), rsrc.indexOf('export async function awardRecruiterRewardIfQualified'));
  const revAt = syncFn.indexOf('await lockRecruiterMoney(tx, open.recruiterId);');
  ok('reward service: lockRecruiterMoney = pg_advisory_xact_lock(hashtext(\'recruiter-money:\' + recruiterId)), taken ONLY in the reversal branch — after the affiliate lock and the threshold check, before the REVERSAL insert',
    /export async function lockRecruiterMoney\(tx, recruiterId\) \{\s*await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{'recruiter-money:' \+ recruiterId\}\)\)`;\s*\}/.test(rsrc)
    && (syncFn.match(/lockRecruiterMoney\(/g) || []).length === 1 && (rsrc.match(/lockRecruiterMoney\(/g) || []).length === 2
    && syncFn.indexOf('await lockAffiliateReward(tx, affiliateId);') < revAt && syncFn.indexOf("return { action: 'NO_CHANGE', cycle: open.cycle };") < revAt
    && revAt < syncFn.indexOf('type: REWARD_TYPES.REVERSAL') && revAt > syncFn.indexOf('if (open) {') && revAt < syncFn.indexOf('const settings = await getCurrentRecruiterSettings'));
  const page = read('src/app/recruiter/wallet/page.jsx');
  ok('recruiter wallet page: a data-negative-balance banner (available < 0) in Arabic; data-nothing-available only when available === 0',
    /\{available < 0 && \(/.test(page) && page.includes('data-negative-balance') && page.includes('رصيدك المتاح سالب')
    && /\{bankComplete && available === 0 && \(\s*<p[^>]*data-nothing-available/.test(page) && /const canRequest = bankComplete && available > 0;/.test(page));
  const labels = read('src/app/recruiter/errorLabels.js');
  ok('errorLabels: the Arabic INSUFFICIENT_BALANCE text explains that reversed rewards do not count (code still built from parts)',
    labels.includes('رصيدك المتاح غير كافٍ لهذا المبلغ (المكافآت المسحوبة بعد إلغاء أو إرجاع طلبيات لا تُحتسب)') && !labels.includes(INSUFFICIENT));
  const adminPage = read('src/app/admin/recruiter-rewards/page.jsx');
  ok('admin recruiter-rewards page: negative available marked (data-balance-available, "solde négatif")', adminPage.includes('data-balance-available') && adminPage.includes('solde négatif (annulations)'));
  const handlers = read('src/lib/recruiterRewardAdminHandlers.js');
  ok('admin handlers: INSUFFICIENT_BALANCE → 409 with the French refusal text', handlers.includes(`INSUFFICIENT_BALANCE: [409, '${FR_REFUSED}']`));
  for (const f of ['src/lib/services/affiliateSystemService.js', 'src/app/api/affiliate/payout/route.js', 'src/app/api/admin/affiliate-payouts/route.js', 'src/lib/recruiterWalletRouteHandlers.js']) {
    ok(`${f} is byte-identical to the part 3 base commit`, git(['show', `${PART3_BASE}:${f}`]) === read(f));
  }
  // Since the base commit: an existing migration edited / removed (status ≠ A) vs a new one — new = added in a later
  // commit (status A) or still untracked; the same exact expectation holds before and after the commit.
  const migStatus = git(['diff', '--name-status', PART3_BASE, '--', 'prisma/migrations']).split('\n').filter(Boolean).map((l) => l.split('\t'));
  const migChanged = migStatus.filter(([st]) => st !== 'A').map(([, p]) => p);
  const migNew = [...new Set([
    ...migStatus.filter(([st]) => st === 'A').map(([, p]) => p),
    ...git(['ls-files', '--others', '--exclude-standard', '--', 'prisma/migrations']).split('\n').filter(Boolean),
  ])].sort();
  const migDirs = readdirSync(join(ROOT, 'prisma/migrations')).filter((d) => /^\d/.test(d)).sort();
  ok('no new migration besides 20261110_recruiter_reward_cycles (Part 3a); no existing migration edited',
    migChanged.length === 0 && eq(migNew, ['prisma/migrations/20261110_recruiter_reward_cycles/migration.sql']) && migDirs.at(-1) === '20261110_recruiter_reward_cycles', big({ migChanged, migNew, last: migDirs.at(-1) }));
  const schemaDiff = git(['diff', PART3_BASE, '--', 'prisma/schema.prisma']).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  ok('prisma/schema.prisma differs from the part 3 base commit only by the Part 3a `cycle Int` column (+ its 3 comment lines)', schemaDiff.length === 4 && schemaDiff.every((l) => l.startsWith('+')) && schemaDiff.at(-1).trim() === '+  cycle           Int'.trim(), big(schemaDiff));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
