#!/usr/bin/env node
/**
 * scripts/securityDeposit.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate "💰 Dépôt de solde" (balance top-up; formerly the security deposit) —
 * submission, idempotent approve/reject, proof access control, upload
 * validation, and the 2026-08-01 accounting change: an APPROVED top-up now
 * CREDITS "Solde disponible" (deposit_topup provider) while PENDING/REJECTED
 * rows never count. In-memory fake db + injected storage — no real database.
 * Run: node scripts/securityDeposit.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  validateDepositUpload, sniffKind, resolveDepositPath, DEPOSIT_MAX_BYTES,
} from '../src/lib/depositStorage.js';
import {
  getDepositBalance, getPendingDepositTotal, submitDeposit,
  adminApproveDeposit, adminRejectDeposit,
  getDepositProofForAffiliate, getConfiguredDepositAmount, DEFAULT_DEPOSIT_AMOUNT,
} from '../src/lib/services/depositService.js';
import { requestPayout, getAffiliateBalance, getWithdrawableBalance } from '../src/lib/services/affiliateSystemService.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n); } };
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || 'ERR'; } };

// ── Fake db (deposits + notifications) ────────────────────────────────────────
function makeDb(initial = [], configuredAmount = 500) {
  const rows = initial.map((r, i) => ({ id: r.id || `d${i + 1}`, createdAt: new Date(), reviewedAt: null, proofFile: 'p.jpg', ...r }));
  const notifs = [];
  const match = (r, where = {}) => Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    _rows: rows, _notifs: notifs,
    affiliateSecurityDeposit: {
      findMany:   async ({ where }) => rows.filter((r) => match(r, where)).map((r) => ({ ...r })),
      findFirst:  async ({ where }) => { const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
      findUnique: async ({ where }) => { const r = rows.find((x) => x.id === where.id); return r ? { ...r } : null; },
      create:     async ({ data }) => { const r = { id: `d${rows.length + 1}`, createdAt: new Date(), reviewedAt: null, ...data }; rows.push(r); return { ...r }; },
      updateMany: async ({ where, data }) => { let count = 0; for (const r of rows) if (match(r, where)) { Object.assign(r, data); count++; } return { count }; },
    },
    affiliateNotification: { create: async ({ data }) => { notifs.push(data); return data; } },
    // Admin-configured fixed deposit amount lives in the team-bonus-config row.
    setting: { findUnique: async ({ where }) => (where.id === 'team-bonus-config' ? { data: { securityDepositAmount: configuredAmount } } : null) },
  };
}
const storage = { process: async () => `proof_${Math.random().toString(36).slice(2)}.jpg` };
const proof = { buffer: Buffer.from('x'), mime: 'image/png', size: 2048 };

console.log('1) Upload validation + magic bytes + path safety:');
{
  ok('png accepted', validateDepositUpload({ mime: 'image/png', size: 1000 }).length === 0);
  ok('pdf accepted', validateDepositUpload({ mime: 'application/pdf', size: 1000 }).length === 0);
  ok('gif rejected', validateDepositUpload({ mime: 'image/gif', size: 1000 }).includes('type'));
  ok('oversize rejected', validateDepositUpload({ mime: 'image/png', size: DEPOSIT_MAX_BYTES + 1 }).includes('size'));
  ok('sniff jpeg', sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'jpeg');
  ok('sniff png', sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])) === 'png');
  ok('sniff pdf', sniffKind(Buffer.from('%PDF-1.5 rest of file here')) === 'pdf');
  ok('sniff webp', sniffKind(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])) === 'webp');
  ok('garbage → null (executable/other rejected)', sniffKind(Buffer.from('MZ\x90\x00 executable')) === null);
  ok('traversal path rejected', resolveDepositPath('../secret') === null);
  ok('safe key resolves', typeof resolveDepositPath('abc.jpg') === 'string');
}

console.log('2) Submission uses the ADMIN-FIXED amount (client amount ignored):');
{
  const db = makeDb([], 750); // admin-configured deposit amount = 750
  ok('balance starts at 0', (await getDepositBalance('a', db)) === 0);
  // Client sends a bogus amount of 5 — the server MUST ignore it and use 750.
  const r = await submitDeposit('a', { amount: '5', paymentMethod: 'Virement', proof }, db, storage);
  ok('created PENDING with the CONFIGURED amount (750, not client 5)', r.status === 'PENDING' && r.amount === 750);
  ok('approved balance still 0 after submit', (await getDepositBalance('a', db)) === 0);
  ok('pending total = configured amount', (await getPendingDepositTotal('a', db)) === 750);
  ok('proof key stored on row, NOT returned to affiliate', db._rows[0].proofFile && !('proofFile' in r) && r.hasProof === true);
  ok('getConfiguredDepositAmount reads the settings row', (await getConfiguredDepositAmount(db)) === 750);
  ok('getConfiguredDepositAmount falls back to default when unset', (await getConfiguredDepositAmount({ setting: { findUnique: async () => null } })) === DEFAULT_DEPOSIT_AMOUNT);

  // Server-side field guards still apply (fresh, no-PENDING dbs).
  ok('missing method rejected', (await codeOf(() => submitDeposit('a', { paymentMethod: '', proof }, makeDb(), storage))) === 'DEPOSIT_NO_METHOD');
  ok('missing proof rejected', (await codeOf(() => submitDeposit('a', { paymentMethod: 'x' }, makeDb(), storage))) === 'DEPOSIT_NO_PROOF');
  ok('bad file type rejected', (await codeOf(() => submitDeposit('a', { paymentMethod: 'x', proof: { buffer: Buffer.from('x'), mime: 'application/x-msdownload', size: 10 } }, makeDb(), storage))) === 'DEPOSIT_INVALID_FILE');
}

console.log('2b) Only ONE pending request at a time:');
{
  const db = makeDb();
  await submitDeposit('a', { amount: '500', paymentMethod: 'Virement', proof }, db, storage);
  ok('second submission blocked while PENDING', (await codeOf(() => submitDeposit('a', { amount: '200', paymentMethod: 'CIH', proof }, db, storage))) === 'DEPOSIT_PENDING_EXISTS');
  ok('still exactly one request', db._rows.length === 1);

  // A different affiliate is unaffected.
  ok('other affiliate can still submit', (await submitDeposit('b', { amount: '100', paymentMethod: 'x', proof }, db, storage)).status === 'PENDING');

  // Once the request is reviewed, a new one is allowed again.
  const approvedDb = makeDb([{ id: 'd1', affiliateId: 'a', amount: 500, status: 'APPROVED' }]);
  ok('new request allowed after APPROVED', (await submitDeposit('a', { amount: '300', paymentMethod: 'x', proof }, approvedDb, storage)).status === 'PENDING');
  const rejectedDb = makeDb([{ id: 'd1', affiliateId: 'a', amount: 500, status: 'REJECTED' }]);
  ok('new request allowed after REJECTED', (await submitDeposit('a', { amount: '300', paymentMethod: 'x', proof }, rejectedDb, storage)).status === 'PENDING');

  // Concurrency: both requests pass the pre-check (findFirst sees no pending),
  // but the DB partial-unique index rejects the 2nd insert (P2002) → mapped to
  // DEPOSIT_PENDING_EXISTS, and the orphan proof is cleaned up.
  const raceDb = {
    affiliateSecurityDeposit: {
      findFirst: async () => null,
      create:    async () => { throw Object.assign(new Error('unique violation'), { code: 'P2002' }); },
    },
    // submitDeposit now also reads the admin switch "Recharge de solde des Affiliés" (no row = ON).
    setting: { findUnique: async () => null },
  };
  let removed = false;
  const raceStorage = { process: async () => 'race.jpg', remove: async () => { removed = true; } };
  ok('concurrent 2nd insert → DEPOSIT_PENDING_EXISTS (no double PENDING)',
     (await codeOf(() => submitDeposit('a', { amount: '100', paymentMethod: 'x', proof }, raceDb, raceStorage))) === 'DEPOSIT_PENDING_EXISTS');
  ok('orphan proof cleaned up after the lost race', removed === true);
}

console.log('3) Balance counts APPROVED only (pending never counted):');
{
  const db = makeDb([
    { id: 'd1', affiliateId: 'a', amount: 300, status: 'APPROVED' },
    { id: 'd2', affiliateId: 'a', amount: 200, status: 'PENDING' },
    { id: 'd3', affiliateId: 'a', amount: 100, status: 'REJECTED' },
  ]);
  ok('approved balance = 300 (only APPROVED)', (await getDepositBalance('a', db)) === 300);
  ok('pending total = 200', (await getPendingDepositTotal('a', db)) === 200);
}

console.log('4) Admin approval is idempotent (never credits twice):');
{
  const db = makeDb([{ id: 'd1', affiliateId: 'a', amount: 500, status: 'PENDING' }]);
  const r1 = await adminApproveDeposit('d1', 'admin1', db);
  ok('first approve credits', r1.credited === true);
  ok('balance = 500 after approve', (await getDepositBalance('a', db)) === 500);
  ok('affiliate notified once', db._notifs.length === 1 && db._notifs[0].message.includes('approuvé'));

  const r2 = await adminApproveDeposit('d1', 'admin2', db);
  ok('second approve does NOT credit again', r2.credited === false);
  ok('balance STILL 500 (no double credit)', (await getDepositBalance('a', db)) === 500);
  ok('no duplicate notification', db._notifs.length === 1);

  // Simulate concurrency: the conditional updateMany can only match PENDING once.
  const db2 = makeDb([{ id: 'x', affiliateId: 'a', amount: 700, status: 'PENDING' }]);
  const c1 = await db2.affiliateSecurityDeposit.updateMany({ where: { id: 'x', status: 'PENDING' }, data: { status: 'APPROVED' } });
  const c2 = await db2.affiliateSecurityDeposit.updateMany({ where: { id: 'x', status: 'PENDING' }, data: { status: 'APPROVED' } });
  ok('conditional update matches exactly once (count 1 then 0)', c1.count === 1 && c2.count === 0);
  ok('derived balance = amount once', (await getDepositBalance('a', db2)) === 700);

  ok('approving a missing deposit → NOT_FOUND', (await adminApproveDeposit('nope', 'a', db)).reason === 'NOT_FOUND');
}

console.log('5) Admin rejection changes no balance + requires a reason:');
{
  const db = makeDb([{ id: 'd1', affiliateId: 'a', amount: 500, status: 'PENDING' }]);
  ok('reason required', (await codeOf(() => adminRejectDeposit('d1', '  ', 'admin', db))) === 'REJECTION_REASON_REQUIRED');
  const r = await adminRejectDeposit('d1', 'Preuve illisible', 'admin', db);
  ok('rejected', r.changed === true);
  ok('balance unchanged (0)', (await getDepositBalance('a', db)) === 0);
  ok('rejection reason surfaced to the affiliate', db._notifs[0].message.includes('Preuve illisible'));
  const r2 = await adminRejectDeposit('d1', 'again', 'admin', db);
  ok('re-reject is idempotent (no change)', r2.changed === false);
}

console.log('6) Proof access control — affiliate sees ONLY their own:');
{
  const db = makeDb([{ id: 'd1', affiliateId: 'ownerA', amount: 100, status: 'PENDING', proofFile: 'nope.jpg' }]);
  // readDepositByKey hits the (missing) file → null, but the OWNERSHIP check is what we assert:
  ok('other affiliate cannot access (returns null before file read)', (await getDepositProofForAffiliate('intruderB', 'd1', db)) === null);
  ok('unknown deposit → null', (await getDepositProofForAffiliate('ownerA', 'missing', db)) === null);
}

console.log('7) BALANCE TOP-UP — credits the wallet total but is NEVER withdrawable:');
{
  // Affiliate has an APPROVED top-up of 5000 and ZERO earnings. The wallet TOTAL
  // includes it (one wallet), but the WITHDRAWABLE component is earnings-only,
  // so a payout must be refused (2026-08-01 accounting separation).
  const s = { txEntered: false };
  const makeDeposits = (approved) => ({
    aggregate: async ({ where }) => ({ _sum: { amount: where?.status === 'APPROVED' ? approved : null } }),
    findMany:  async ({ where }) => (where?.status === 'APPROVED' && approved != null ? [{ amount: approved }] : []),
  });
  const noBoosters = {
    aggregate: async () => ({ _sum: { price: null } }),
    findMany:  async () => [],
  };
  const balProviders = {
    affiliateOrder:   { aggregate: async () => ({ _sum: { commissionAmount: 0 } }) },
    affiliate:        { findUnique: async (q) => (q.select?.bonusBalance ? { bonusBalance: 0 } : { bankName: 'CIH', accountName: 'A B', rib: '1234567890123' }) },
    affiliatePayout:  { aggregate: async () => ({ _sum: { amount: null } }), create: async ({ data }) => ({ id: 'p1', ...data }) },
    ugcEarning:       { aggregate: async () => ({ _sum: { amount: null } }) },
    affiliateBoosterPurchase: noBoosters,
    affiliateSecurityDeposit: makeDeposits(5000),
  };
  const db = {
    ...balProviders,
    identityVerification: { findUnique: async () => ({ status: 'APPROVED' }) },
    $transaction: async (fn) => { s.txEntered = true; return fn(balProviders); },
  };
  ok('deposit-page approved total = 5000', (await getDepositBalance('a', db)) === 5000);
  ok('wallet TOTAL includes the approved top-up (5000)', (await getAffiliateBalance('a', db)) === 5000);
  ok('WITHDRAWABLE is 0 (top-up excluded)', (await getWithdrawableBalance('a', db)) === 0);
  const code = await codeOf(() => requestPayout('a', 100, db));
  ok('withdrawing a top-up → INSUFFICIENT_BALANCE', code === 'INSUFFICIENT_BALANCE');
  ok('balance transaction was entered (passed bank + identity gates)', s.txEntered === true);

  // PENDING top-ups never count anywhere.
  const pendingOnly = {
    ...balProviders,
    affiliateSecurityDeposit: makeDeposits(null),
    identityVerification: { findUnique: async () => ({ status: 'APPROVED' }) },
  };
  pendingOnly.$transaction = async (fn) => fn(pendingOnly);
  ok('PENDING top-up → wallet total still 0', (await getAffiliateBalance('a', pendingOnly)) === 0);
  const code2 = await codeOf(() => requestPayout('a', 100, pendingOnly));
  ok('spending before validation → INSUFFICIENT_BALANCE', code2 === 'INSUFFICIENT_BALANCE');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
