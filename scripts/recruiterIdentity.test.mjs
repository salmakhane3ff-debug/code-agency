#!/usr/bin/env node
/**
 * scripts/recruiterIdentity.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 6 part 3c: recruiter identity verification (KYC).
 * In-memory fake database only (scripts/lib/recruiterFakeDb.mjs, phase5 mode: read-committed
 * transactions, the recruiter row lock, the per-recruiter money lock, the KYC row with the
 * migration 20261111 CHECK + guard) and an in-memory CIN storage — never a real database, never
 * the private_uploads directory.
 * Proves:
 *   1. state machine: NOT_SUBMITTED → PENDING → APPROVED / REJECTED, APPROVED → REJECTED
 *      (revocation), REJECTED → PENDING only through a new upload (submission + 1); no direct
 *      approval of a REJECTED submission; stale decisions refused; concurrent decisions → one wins;
 *      a decision racing a resubmission never overwrites the newer submission
 *   2. withdrawals: only APPROVED permits a request (403 RECRUITER_IDENTITY_NOT_APPROVED otherwise);
 *      a pending withdrawal (incl. one requested before the KYC existed) is paid only with APPROVED
 *      at payment time (409, French text); reject always works and releases the funds; races
 *      (100 rejection-vs-payment with timing variation, approval-vs-payment, request-vs-revocation,
 *      mixed stress with reward reversals) are strictly serialised by the money lock
 *   3. privacy: own KYC only, exact response keys (never a file key / path / reviewer / image),
 *      admin-only image route with private headers, file signatures, size / body caps, audit rows
 *      without file data, superseded files removed only after the commit
 *   4. compatibility: affiliate KYC + payouts byte-identical, rewards still accrue while REJECTED,
 *      lock order (decision: money → KYC row; payment: row → money → KYC read → balance; request:
 *      row → KYC read, never the money lock; upload: never the money lock)
 * Run: node scripts/recruiterIdentity.test.mjs
 * ────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'recruiter-identity-test-secret-not-real';

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeRecruiterFakeDb } from './lib/recruiterFakeDb.mjs';

const KS = await import('../src/lib/services/recruiterIdentityService.js');
const RS = await import('../src/lib/services/recruiterRewardService.js');
const WS = await import('../src/lib/services/recruiterWalletService.js');
const HK = await import('../src/lib/recruiterRewardHooks.js');
const V = await import('../src/lib/recruiterVisibility.js');
const { recruiterIdentityHandlers, RECRUITER_IDENTITY_BODY_LIMIT, RECRUITER_IDENTITY_RATE } = await import('../src/lib/recruiterIdentityRouteHandlers.js');
const { recruiterIdentityAdminHandlers } = await import('../src/lib/recruiterIdentityAdminHandlers.js');
const { recruiterWalletHandlers } = await import('../src/lib/recruiterWalletRouteHandlers.js');
const { recruiterRewardAdminHandlers } = await import('../src/lib/recruiterRewardAdminHandlers.js');
const { withRecruiterAuth } = await import('../src/lib/middleware/withRecruiterAuth.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
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
// The parent of Part 3c (the Part 3a/3b commit): affiliate files must be byte-identical to it.
const PART3C_BASE = '11b9bf3f9ec159c2adb808302a5a483bc9a37224';

const T0 = new Date('2026-11-13T10:00:00.000Z');
const now = () => new Date(T0);
const noLimit = () => null;
const V1 = { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 };
const NOT_APPROVED = 'RECRUITER_IDENTITY_NOT_APPROVED';
const FR_KYC = "Paiement refusé : l'identité (CIN) du recruteur n'est pas approuvée. Le retrait reste en attente ; vous pouvez le rejeter pour libérer les fonds.";
const MB = 1024 * 1024;
const KEY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg/;

// ── image buffers (magic bytes + padding) ─────────────────────────────────────
const pad = (head, n = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, n - head.length), 7)]);
const IMG = {
  jpeg: () => pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  png: () => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  webp: () => pad([...Buffer.from('RIFF'), 0x24, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]),
  gif: () => pad([...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0]),
  pdf: () => pad([...Buffer.from('%PDF-1.4\n%abc')]),
  svg: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
};
const file = (kind = 'jpeg', mime = `image/${kind}`) => ({ buffer: IMG[kind](), mime });
const pair = () => ({ front: file('jpeg'), back: file('png') });

/** In-memory CIN storage (the service's injectable { store, remove } + the admin `read`). */
function mkStorage(E) {
  const files = new Map();
  const removed = [];
  const removedWhileTxOpen = [];
  return {
    files, removed, removedWhileTxOpen,
    store: async (buf) => { const k = `${randomUUID()}.jpg`; files.set(k, Buffer.from(buf)); return k; },
    remove: async (k) => { if (E?.db?._openTx?.size) removedWhileTxOpen.push(k); removed.push(k); return files.delete(k); },
    read: async (k) => (files.has(k) ? { buffer: files.get(k), contentType: 'image/jpeg' } : null),
  };
}

let uniq = 0;
function setup({ settings = V1, kyc = null } = {}) {
  const hookBox = { fn: null };
  const db = makeRecruiterFakeDb({ phase5: true, hooks: { before: (m, o, a) => (hookBox.fn ? hookBox.fn(m, o, a) : undefined) } });
  const A = db._seed.recruiter({ username: `rec.a${++uniq}`, name: 'Recruteur A' });
  const B = db._seed.recruiter({ username: `rec.b${uniq}`, name: 'Recruteur B' });
  if (settings) db._seed.settings(settings);
  for (const r of [A, B]) Object.assign(db._tables.recruiter.find((x) => x.id === r.id), { bankName: 'CIH Bank', accountName: 'Recruteur', rib: '011780000012345678901234' });
  const E = { db, A, B, hookBox };
  E.storage = mkStorage(E);
  if (kyc) db._seed.recruiterIdentity({ recruiterId: A.id, status: kyc });
  return E;
}
const settled = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e?.code ?? String(e), fields: e?.fields ?? null }));
const submit = (E, rec = E.A, files = pair()) => settled(KS.submitRecruiterIdentity(rec.id, files, { db: E.db, now: T0, storage: E.storage }));
const decide = (E, id, input, actorId = 'admin-1') => settled(KS.adminDecideRecruiterIdentity(id, input, { db: E.db, actorId, now: T0 }));
const kycRow = (E, rec = E.A) => E.db._tables.recruiterIdentityVerification.find((r) => r.recruiterId === rec.id);
const approve = (E, rec = E.A, extra = {}) => { const r = kycRow(E, rec); return decide(E, r.id, { action: 'approve', expectedStatus: r.status, submission: r.submission, ...extra }); };
const reject = (E, rec = E.A, reason = 'CIN illisible', extra = {}) => { const r = kycRow(E, rec); return decide(E, r.id, { action: 'reject', expectedStatus: r.status, submission: r.submission, reason, ...extra }); };
const audits = (E, action) => E.db._tables.recruiterAuditLog.filter((r) => (action ? r.action === action : true));
function qualified(db, rec) {
  const a = db._seed.affiliate({ username: `kyc${++uniq}`, name: `Affilié ${uniq}`, isActive: true });
  db._seed.link({ affiliateId: a.id, recruiterId: rec.id });
  for (let i = 0; i < 10; i++) db._seed.order({ affiliateId: a.id, status: 'delivered', isFake: false, commissionAmount: 25 });
  db._seed.identity({ affiliateId: a.id, status: 'APPROVED' });
  return { a };
}
async function earn(E, rec = E.A) {
  const q = qualified(E.db, rec);
  const r = await RS.syncRecruiterReward(q.a.id, { db: E.db, now: T0 });
  if (r.action !== 'AWARDED') throw new Error(`setup: expected AWARDED, got ${r.action}`);
  return q;
}
async function reverse(E, q) {
  const o = E.db._tables.affiliateOrder.find((x) => x.affiliateId === q.a.id && x.status === 'delivered');
  o.status = 'cancelled';
  return HK.onRecruiterOrderStatusCommitted(o.id, { db: E.db });
}
const request = (E, amountMad, rec = E.A, requestId = randomUUID()) => settled(WS.requestRecruiterWithdrawal(rec.id, { amountMad, requestId }, { db: E.db, now: T0 }));
const pay = (E, id, action = 'pay') => settled(WS.adminProcessRecruiterPayout(id, action, { db: E.db, actorId: 'admin-1', now: T0 }));
const totals = async (E, rec = E.A) => (await WS.getRecruiterWallet(rec.id, { db: E.db })).totals;
const payouts = (E, rec = E.A) => E.db._tables.affiliatePayout.filter((p) => p.recruiterId === rec.id);
const MONEY = (rec) => `__advisory__:recruiter-money:${rec.id}`;
const holdsMoney = (E, rec = E.A) => E.db._locks.has(MONEY(rec));
const jitter = async () => { const n = Math.floor(Math.random() * 6); for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); if (Math.random() < 0.3) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3))); };
const withTimeout = (p, ms = 5000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT (possible deadlock)')), ms))]);
/** Every PAID audit lies inside an APPROVED interval of the KYC decision timeline (audit seq order). */
function paidOnlyWhileApproved(E, rec = E.A) {
  const evs = E.db._tables.recruiterAuditLog.filter((r) => r.recruiterId === rec.id).sort((a, b) => (a.seq < b.seq ? -1 : 1));
  let st = kycSeededStatus(E, rec);
  for (const e of evs) {
    if (e.action === 'RECRUITER_IDENTITY_SUBMITTED') st = 'PENDING';
    else if (e.action === 'RECRUITER_IDENTITY_APPROVED') st = 'APPROVED';
    else if (e.action === 'RECRUITER_IDENTITY_REJECTED') st = 'REJECTED';
    else if (e.action === 'RECRUITER_WITHDRAWAL_PAID' && st !== 'APPROVED') return false;
  }
  return true;
}
const seededKyc = new WeakMap();
const kycSeededStatus = (E, rec) => seededKyc.get(E)?.[rec.id] ?? 'NOT_SUBMITTED';

// ═════ 1. state machine and submissions ════════════════════════════════════════
console.log('\n1. State machine: NOT_SUBMITTED → PENDING → APPROVED / REJECTED; revocation; resubmission; stale decisions');
{
  const E = setup();
  const g0 = await KS.getRecruiterIdentity(E.A.id, { db: E.db });
  ok('no row → NOT_SUBMITTED (view: canSubmit, no dates)', g0.status === 'NOT_SUBMITTED' && eq(V.toRecruiterIdentityView(g0), { status: 'NOT_SUBMITTED', rejectionReason: null, submittedAt: null, reviewedAt: null, canSubmit: true }));
  const s1 = await submit(E);
  const r1 = kycRow(E);
  ok('NOT_SUBMITTED → PENDING (submission 1, two new <uuid>.jpg keys, front ≠ back)', s1.ok && s1.r.status === 'PENDING' && s1.r.submission === 1 && r1.status === 'PENDING' && r1.submission === 1
    && KEY_RE.test(r1.cinFrontFile) && KEY_RE.test(r1.cinBackFile) && r1.cinFrontFile !== r1.cinBackFile, big(s1));
  ok('audit RECRUITER_IDENTITY_SUBMITTED by the RECRUITER: { submission: 1, from: NOT_SUBMITTED, to: PENDING }',
    audits(E, 'RECRUITER_IDENTITY_SUBMITTED').length === 1 && eq(audits(E, 'RECRUITER_IDENTITY_SUBMITTED')[0].details, { submission: 1, from: 'NOT_SUBMITTED', to: 'PENDING' })
    && audits(E, 'RECRUITER_IDENTITY_SUBMITTED')[0].actorType === 'RECRUITER' && audits(E, 'RECRUITER_IDENTITY_SUBMITTED')[0].actorId === E.A.id);
  const storedBefore = E.storage.files.size;
  const again = await submit(E);
  ok('PENDING → a new upload is refused (IDENTITY_SUBMISSION_NOT_ALLOWED) before any file is written', !again.ok && again.code === 'IDENTITY_SUBMISSION_NOT_ALLOWED' && E.storage.files.size === storedBefore, big(again));

  const stale = await decide(E, r1.id, { action: 'approve', expectedStatus: 'PENDING', submission: 2 });
  ok('a decision naming another submission → STALE_DECISION, nothing changed', !stale.ok && stale.code === 'STALE_DECISION' && kycRow(E).status === 'PENDING', big(stale));
  const wrongFrom = await decide(E, r1.id, { action: 'approve', expectedStatus: 'APPROVED', submission: 1 });
  ok('approve with expectedStatus APPROVED → INVALID_STATE', !wrongFrom.ok && wrongFrom.code === 'INVALID_STATE', big(wrongFrom));
  const badStatus = await decide(E, r1.id, { action: 'approve', expectedStatus: 'WHATEVER', submission: 1 });
  const badAction = await decide(E, r1.id, { action: 'delete', expectedStatus: 'PENDING', submission: 1 });
  const badSub = await decide(E, r1.id, { action: 'approve', expectedStatus: 'PENDING', submission: 0 });
  ok('unknown expectedStatus / action, submission < 1 → INVALID_INPUT', [badStatus, badAction, badSub].every((x) => !x.ok && x.code === 'INVALID_INPUT'), big([badStatus, badAction, badSub]));
  const noActor = await settled(KS.adminDecideRecruiterIdentity(r1.id, { action: 'approve', expectedStatus: 'PENDING', submission: 1 }, { db: E.db, now: T0 }));
  ok('a decision without an admin actor → UNAUTHORIZED', !noActor.ok && noActor.code === 'UNAUTHORIZED');
  const unknownRow = await decide(E, 'no-such-row', { action: 'approve', expectedStatus: 'PENDING', submission: 1 });
  ok('unknown verification id → NOT_FOUND', !unknownRow.ok && unknownRow.code === 'NOT_FOUND');

  const ap = await approve(E);
  const r2 = kycRow(E);
  ok('PENDING → APPROVED (reviewer = the admin id, reviewedAt, approvedAt; same submission and files)', ap.ok && r2.status === 'APPROVED' && r2.reviewedBy === 'admin-1' && r2.approvedAt && r2.reviewedAt
    && r2.submission === 1 && r2.cinFrontFile === r1.cinFrontFile, big(r2));
  ok('audit RECRUITER_IDENTITY_APPROVED by the ADMIN: { submission: 1, from: PENDING, to: APPROVED }',
    eq(audits(E, 'RECRUITER_IDENTITY_APPROVED').map((a) => [a.actorType, a.actorId, a.details]), [['ADMIN', 'admin-1', { submission: 1, from: 'PENDING', to: 'APPROVED' }]]));
  const upApproved = await submit(E);
  ok('APPROVED → a new upload is refused (IDENTITY_SUBMISSION_NOT_ALLOWED)', !upApproved.ok && upApproved.code === 'IDENTITY_SUBMISSION_NOT_ALLOWED');

  const noReason = await reject(E, E.A, '   ');
  const longReason = await reject(E, E.A, 'x'.repeat(501));
  ok('reject needs a reason of 1–500 characters (blank / 501 → INVALID_INPUT, nothing changed)', !noReason.ok && noReason.code === 'INVALID_INPUT' && !longReason.ok && longReason.code === 'INVALID_INPUT' && kycRow(E).status === 'APPROVED');
  const rv = await reject(E, E.A, '  Document   expiré  ');
  const r3 = kycRow(E);
  ok('APPROVED → REJECTED (revocation): reason trimmed, approvedAt cleared, same submission', rv.ok && r3.status === 'REJECTED' && r3.rejectionReason === 'Document expiré' && r3.approvedAt === null && r3.submission === 1, big(r3));
  ok('audit RECRUITER_IDENTITY_REJECTED: { submission: 1, from: APPROVED, to: REJECTED, reason }',
    eq(audits(E, 'RECRUITER_IDENTITY_REJECTED').map((a) => a.details), [{ submission: 1, from: 'APPROVED', to: 'REJECTED', reason: 'Document expiré' }]));

  const directApprove = await decide(E, r3.id, { action: 'approve', expectedStatus: 'REJECTED', submission: 1 });
  const rejectRejected = await decide(E, r3.id, { action: 'reject', expectedStatus: 'REJECTED', submission: 1, reason: 'encore' });
  ok('a REJECTED submission can never be approved (or re-decided) directly → INVALID_STATE, nothing changed',
    !directApprove.ok && directApprove.code === 'INVALID_STATE' && !rejectRejected.ok && rejectRejected.code === 'INVALID_STATE' && kycRow(E).status === 'REJECTED', big([directApprove, rejectRejected]));
  const fakeStale = await decide(E, r3.id, { action: 'approve', expectedStatus: 'PENDING', submission: 1 });
  ok('…and an old screen still showing PENDING submission 1 → STALE_DECISION', !fakeStale.ok && fakeStale.code === 'STALE_DECISION' && kycRow(E).status === 'REJECTED');

  const oldKeys = [r3.cinFrontFile, r3.cinBackFile];
  const s2 = await submit(E);
  const r4 = kycRow(E);
  ok('REJECTED → PENDING only through a new upload: submission 2, two NEW keys, review columns and reason cleared',
    s2.ok && r4.status === 'PENDING' && r4.submission === 2 && !oldKeys.includes(r4.cinFrontFile) && !oldKeys.includes(r4.cinBackFile)
    && r4.rejectionReason === null && r4.reviewedBy === null && r4.reviewedAt === null && r4.approvedAt === null, big(r4));
  ok('the superseded (rejected) files are deleted, after the commit; the new ones are kept',
    oldKeys.every((k) => E.storage.removed.includes(k) && !E.storage.files.has(k)) && E.storage.files.has(r4.cinFrontFile) && E.storage.files.has(r4.cinBackFile)
    && E.storage.removedWhileTxOpen.length === 0);
  const staleOld = await decide(E, r4.id, { action: 'reject', expectedStatus: 'PENDING', submission: 1, reason: 'vieux' });
  ok('a decision on the OLD submission (1) after the resubmission → STALE_DECISION; submission 2 untouched', !staleOld.ok && staleOld.code === 'STALE_DECISION' && kycRow(E).status === 'PENDING' && kycRow(E).submission === 2);
  const rj = await reject(E, E.A, 'Photo floue');
  ok('PENDING → REJECTED (submission 2)', rj.ok && kycRow(E).status === 'REJECTED' && kycRow(E).submission === 2);
  const s3 = await submit(E);
  const ap3 = await approve(E);
  ok('…new upload → PENDING submission 3 → APPROVED', s3.ok && ap3.ok && kycRow(E).status === 'APPROVED' && kycRow(E).submission === 3);
  ok('exactly one KYC row per recruiter; the history is in the audit log (3 submissions, 2 approvals, 2 rejections)',
    E.db._tables.recruiterIdentityVerification.filter((r) => r.recruiterId === E.A.id).length === 1 && audits(E, 'RECRUITER_IDENTITY_SUBMITTED').length === 3
    && audits(E, 'RECRUITER_IDENTITY_APPROVED').length === 2 && audits(E, 'RECRUITER_IDENTITY_REJECTED').length === 2);

  // DB guard / CHECK (fake = migration semantics) — direct writes bypassing the service.
  const row = kycRow(E);
  const tryWrite = (where, data) => E.db.recruiterIdentityVerification.updateMany({ where, data }).then(() => 'ok', (e) => e?.meta?.code ?? e?.code ?? String(e));
  E.db._seed.recruiterIdentity({ recruiterId: E.B.id, status: 'REJECTED', rejectionReason: 'x' });
  const rowB = kycRow(E, E.B);
  const g1 = await tryWrite({ id: rowB.id }, { status: 'APPROVED', reviewedBy: 'a', reviewedAt: T0, approvedAt: T0, rejectionReason: null });
  const g2 = await tryWrite({ id: row.id }, { status: 'PENDING', reviewedBy: null, reviewedAt: null, approvedAt: null });
  const g3 = await tryWrite({ id: rowB.id }, { status: 'PENDING', submission: rowB.submission + 1, cinFrontFile: rowB.cinFrontFile, cinBackFile: `${randomUUID()}.jpg`, rejectionReason: null, reviewedBy: null, reviewedAt: null });
  const g4 = await tryWrite({ id: row.id }, { recruiterId: E.B.id });
  const g5 = await tryWrite({ id: row.id }, { status: 'REJECTED', rejectionReason: 'x', approvedAt: null, submission: row.submission + 1 });
  const g6 = await E.db.recruiterIdentityVerification.delete({ where: { id: row.id } }).then(() => 'ok', (e) => e?.meta?.code ?? String(e));
  ok('DB guard: REJECTED → APPROVED, APPROVED → PENDING, a resubmission reusing a file, a recruiterId change, a decision changing the submission, a delete — all refused (check_violation)',
    [g1, g2, g3, g4, g5, g6].every((x) => x === '23514'), big([g1, g2, g3, g4, g5, g6]));
  const c1 = await E.db.recruiterIdentityVerification.create({ data: { recruiterId: E.B.id, status: 'PENDING', submission: 1, cinFrontFile: `${randomUUID()}.jpg`, cinBackFile: `${randomUUID()}.jpg`, submittedAt: T0 } }).then(() => 'ok', (e) => e?.code);
  const C = setup();
  const c2 = await C.db.recruiterIdentityVerification.create({ data: { recruiterId: C.A.id, status: 'APPROVED', submission: 1, cinFrontFile: `${randomUUID()}.jpg`, cinBackFile: `${randomUUID()}.jpg`, submittedAt: T0, reviewedBy: 'a', reviewedAt: T0, approvedAt: T0 } }).then(() => 'ok', (e) => e?.meta?.code ?? e?.code);
  const k = `${randomUUID()}.jpg`;
  const c3 = await C.db.recruiterIdentityVerification.create({ data: { recruiterId: C.A.id, status: 'PENDING', submission: 1, cinFrontFile: k, cinBackFile: k, submittedAt: T0 } }).then(() => 'ok', (e) => e?.code);
  const c4 = await C.db.recruiterIdentityVerification.create({ data: { recruiterId: C.A.id, status: 'PENDING', submission: 1, cinFrontFile: 'secret/front.jpg', cinBackFile: `${randomUUID()}.jpg`, submittedAt: T0 } }).then(() => 'ok', (e) => e?.code);
  ok('DB: one row per recruiter (P2002); an insert must be PENDING submission 1; front ≠ back; keys must be <uuid>.jpg (CHECK)',
    c1 === 'P2002' && c2 === '23514' && c3 === 'P2004' && c4 === 'P2004', big([c1, c2, c3, c4]));
}

console.log('\n1b. Concurrency of decisions and uploads');
{
  let oneWins = 0, overwrote = 0;
  for (let i = 0; i < 20; i++) {
    const E = setup();
    await submit(E);
    const r = kycRow(E);
    const [a, b] = await Promise.all([
      (async () => { await jitter(); return decide(E, r.id, { action: 'approve', expectedStatus: 'PENDING', submission: 1 }, 'admin-1'); })(),
      (async () => { await jitter(); return decide(E, r.id, { action: 'reject', expectedStatus: 'PENDING', submission: 1, reason: 'non' }, 'admin-2'); })(),
    ]);
    const winners = [a, b].filter((x) => x.ok).length;
    const loser = [a, b].find((x) => !x.ok);
    const decisions = audits(E, 'RECRUITER_IDENTITY_APPROVED').length + audits(E, 'RECRUITER_IDENTITY_REJECTED').length;
    const final = kycRow(E).status;
    if (winners === 1 && loser?.code === 'STALE_DECISION' && decisions === 1 && final === (a.ok ? 'APPROVED' : 'REJECTED')) oneWins += 1;
    else overwrote += 1;
  }
  ok('20× concurrent approve + reject of the SAME submission → exactly one wins, the other STALE_DECISION, one decision audit, final = the winner', oneWins === 20 && overwrote === 0, `${oneWins}/${overwrote}`);

  let firstOk = 0;
  for (let i = 0; i < 10; i++) {
    const E = setup();
    const [a, b] = await Promise.all([(async () => { await jitter(); return submit(E); })(), (async () => { await jitter(); return submit(E); })()]);
    const refusedLoser = [a, b].find((x) => !x.ok);
    if ([a, b].filter((x) => x.ok).length === 1 && refusedLoser?.code === 'IDENTITY_SUBMISSION_NOT_ALLOWED' && E.db._tables.recruiterIdentityVerification.length === 1
      && E.storage.files.size === 2 && audits(E, 'RECRUITER_IDENTITY_SUBMITTED').length === 1) firstOk += 1;
  }
  ok('10× two concurrent FIRST uploads → one row, one audit, the loser refused and its new files removed (2 files kept)', firstOk === 10, String(firstOk));

  let safe = 0;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const E = setup();
    await submit(E);
    await reject(E);
    const id = kycRow(E).id;
    // An old admin screen still showing "PENDING, submission 1" decides while the recruiter re-uploads.
    const [up, dec] = await Promise.all([
      (async () => { await jitter(); return submit(E); })(),
      (async () => { await jitter(); return decide(E, id, { action: i % 2 ? 'approve' : 'reject', expectedStatus: 'PENDING', submission: 1, reason: 'vieux écran' }); })(),
    ]);
    const r = kycRow(E);
    seen.add(dec.code);
    if (up.ok && !dec.ok && ['STALE_DECISION'].includes(dec.code) && r.status === 'PENDING' && r.submission === 2) safe += 1;
  }
  ok('20× an outdated decision racing a resubmission → never applied (STALE_DECISION): the newer submission 2 stays PENDING', safe === 20, `${safe} ${[...seen]}`);
}

// ═════ 2. withdrawals and payments ════════════════════════════════════════════
console.log('\n2. Withdrawals: only APPROVED requests; payment needs APPROVED at payment time; reject always works');
{
  for (const kyc of [null, 'PENDING', 'REJECTED']) {
    const E = setup({ kyc });
    await earn(E);
    const before = { p: E.db._tables.affiliatePayout.length, a: E.db._tables.recruiterAuditLog.length };
    const r = await request(E, '50');
    ok(`KYC ${kyc ?? 'NOT_SUBMITTED'} → request refused (RECRUITER_IDENTITY_NOT_APPROVED), nothing written`,
      !r.ok && r.code === NOT_APPROVED && E.db._tables.affiliatePayout.length === before.p && E.db._tables.recruiterAuditLog.length === before.a, big(r));
  }
  {
    const E = setup({ kyc: 'APPROVED' });
    await earn(E);
    const r = await request(E, '50');
    ok('KYC APPROVED → request accepted (pending)', r.ok && r.r.withdrawal.status === 'pending');
    const over = await request(E, '101');
    ok('APPROVED does not bypass Part 3b: 101 MAD with 100 available → INSUFFICIENT_BALANCE', !over.ok && over.code === ['INSUFFICIENT', 'BALANCE'].join('_'));
  }
  {
    // HTTP: 403 with exactly { code }.
    const E = setup({ kyc: 'PENDING' });
    await earn(E);
    const h = recruiterWalletHandlers({ db: E.db, now, rateLimit: noLimit });
    const res = await withRecruiterAuth(h.withdraw)(new Request('http://localhost/api/recruiter/wallet/withdrawals', {
      method: 'POST', headers: { cookie: `recruiter_token=${signToken({ recruiterId: E.A.id, username: E.A.username, type: 'recruiter' })}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amountMad: '10', requestId: randomUUID() }),
    }), {});
    const body = await res.json();
    ok('HTTP withdrawal request without APPROVED KYC → 403 { code: RECRUITER_IDENTITY_NOT_APPROVED } (nothing else)', res.status === 403 && eq(body, { code: NOT_APPROVED }), `${res.status} ${JSON.stringify(body)}`);
  }
  {
    // A withdrawal requested BEFORE the recruiter KYC existed (seeded pending row, no KYC row).
    const E = setup();
    await earn(E);
    const pre = E.db._seed.payout({ recruiterId: E.A.id, amount: 100, status: 'pending' });
    const p1 = await pay(E, pre.id);
    ok('pre-KYC pending withdrawal + no KYC → pay refused (RECRUITER_IDENTITY_NOT_APPROVED); still pending; no PAID audit',
      !p1.ok && p1.code === NOT_APPROVED && payouts(E)[0].status === 'pending' && audits(E, 'RECRUITER_WITHDRAWAL_PAID').length === 0, big(p1));
    const ah = recruiterRewardAdminHandlers({ db: E.db, now });
    const res = await ah.payoutAction(pre.id, 'pay', { userId: 'admin-1', role: 'ADMIN' }, null);
    const body = await res.json();
    ok('admin HTTP pay → 409 { code, error } with the fixed French text, no-store', res.status === 409 && eq(body, { code: NOT_APPROVED, error: FR_KYC }) && res.headers.get('cache-control') === 'no-store', `${res.status} ${JSON.stringify(body)}`);
    await submit(E);
    const p2 = await pay(E, pre.id);
    ok('…KYC PENDING → still refused', !p2.ok && p2.code === NOT_APPROVED);
    const t0 = await totals(E);
    const rj = await pay(E, pre.id, 'reject');
    const t1 = await totals(E);
    ok('admin can ALWAYS reject it (KYC never checked on reject): rejected, the reserved 100 MAD released', rj.ok && payouts(E)[0].status === 'rejected' && t1.availableCents === t0.availableCents + 10000, big([t0, t1]));
  }
  {
    // Revocation blocks the payment of an already pending withdrawal; re-approval allows it again.
    const E = setup();
    await earn(E);
    await submit(E);
    await approve(E);
    const w = await request(E, '100');
    await reject(E, E.A, 'Revocation');
    const p = await pay(E, w.r.withdrawal.id);
    ok('APPROVED → request pending → revoked (REJECTED) → pay refused; still pending; not auto-rejected', w.ok && !p.ok && p.code === NOT_APPROVED && payouts(E)[0].status === 'pending', big(p));
    const nr = await request(E, '10');
    ok('…and a new request is refused while REJECTED', !nr.ok && nr.code === NOT_APPROVED);
    await submit(E);
    await approve(E);
    const p2 = await pay(E, w.r.withdrawal.id);
    ok('…new upload + approval → the same pending withdrawal can be paid', p2.ok && payouts(E)[0].status === 'paid');
  }
}

console.log('\n2b. Races (strict serialisation by the per-recruiter money lock)');
{
  // 100 rejection (revocation) vs payment races with timing variation.
  let paidFirst = 0, refused = 0, violations = 0, lockMiss = 0, hang = 0;
  for (let i = 0; i < 100; i++) {
    const E = setup();
    await earn(E);
    await submit(E);
    await approve(E);
    seededKyc.set(E, {});
    const w = await request(E, '150');
    const ev = [];
    E.hookBox.fn = (m, o, a) => {
      if (m === 'recruiterIdentityVerification' && o === 'updateMany') { ev.push('kycWrite'); if (!holdsMoney(E)) lockMiss += 1; }
      if (m === 'recruiterIdentityVerification' && o === 'findUnique' && a?.where?.recruiterId) { ev.push('payKycRead'); if (!holdsMoney(E)) lockMiss += 1; }
      if (m === 'affiliatePayout' && o === 'updateMany') ev.push('payWrite');
    };
    const id = kycRow(E).id;
    const legs = [
      async () => { await jitter(); return pay(E, w.r.withdrawal.id); },
      async () => { await jitter(); return decide(E, id, { action: 'reject', expectedStatus: 'APPROVED', submission: 1, reason: 'révoquée' }); },
    ];
    if (i % 2) legs.reverse();
    let out;
    try { out = await withTimeout(Promise.all(legs.map((f) => f()))); } catch { hang += 1; continue; }
    E.hookBox.fn = null;
    const p = i % 2 ? out[1] : out[0];
    const d = i % 2 ? out[0] : out[1];
    const iRead = ev.indexOf('payKycRead'), iWrite = ev.indexOf('kycWrite');
    if (!d.ok) { violations += 1; continue; }
    if (p.ok) {
      paidFirst += 1;
      if (!(iRead < iWrite && ev.indexOf('payWrite') < iWrite) || payouts(E)[0].status !== 'paid' || !paidOnlyWhileApproved(E)) violations += 1;
    } else {
      refused += 1;
      if (p.code !== NOT_APPROVED || !(iWrite < iRead) || payouts(E)[0].status !== 'pending' || audits(E, 'RECRUITER_WITHDRAWAL_PAID').length) violations += 1;
    }
  }
  ok(`100 rejection-vs-payment races (timing variation): never a payment after a committed rejection — paid-first ${paidFirst}, refused ${refused}; no hang; money lock held at every KYC read / write`,
    violations === 0 && hang === 0 && lockMiss === 0 && paidFirst + refused === 100 && paidFirst > 0 && refused > 0, big({ paidFirst, refused, violations, hang, lockMiss }));

  // Approval vs payment of a pre-KYC pending withdrawal.
  let aPaid = 0, aRefused = 0, aBad = 0;
  for (let i = 0; i < 40; i++) {
    const E = setup();
    await earn(E);
    const pre = E.db._seed.payout({ recruiterId: E.A.id, amount: 100, status: 'pending' });
    await submit(E);
    const ev = [];
    E.hookBox.fn = (m, o, a) => {
      if (m === 'recruiterIdentityVerification' && o === 'updateMany') ev.push('kycWrite');
      if (m === 'recruiterIdentityVerification' && o === 'findUnique' && a?.where?.recruiterId) ev.push('payKycRead');
    };
    const id = kycRow(E).id;
    const [p, d] = await withTimeout(Promise.all([
      (async () => { await jitter(); return pay(E, pre.id); })(),
      (async () => { await jitter(); return decide(E, id, { action: 'approve', expectedStatus: 'PENDING', submission: 1 }); })(),
    ]));
    E.hookBox.fn = null;
    const iRead = ev.indexOf('payKycRead'), iWrite = ev.indexOf('kycWrite');
    if (!d.ok) aBad += 1;
    else if (p.ok) { aPaid += 1; if (!(iWrite < iRead)) aBad += 1; }
    else { aRefused += 1; if (p.code !== NOT_APPROVED || !(iRead < iWrite) || payouts(E)[0].status !== 'pending') aBad += 1; }
  }
  ok(`40 approval-vs-payment races: paid only when the approval committed first (paid ${aPaid}, refused ${aRefused})`, aBad === 0 && aPaid + aRefused === 40 && aPaid > 0 && aRefused > 0, big({ aPaid, aRefused, aBad }));

  // Request vs revocation: whatever the order, nothing is ever paid while REJECTED.
  let rCreated = 0, rRefused = 0, rBad = 0;
  for (let i = 0; i < 40; i++) {
    const E = setup();
    await earn(E);
    await submit(E);
    await approve(E);
    const id = kycRow(E).id;
    const [r, d] = await withTimeout(Promise.all([
      (async () => { await jitter(); return request(E, '100'); })(),
      (async () => { await jitter(); return decide(E, id, { action: 'reject', expectedStatus: 'APPROVED', submission: 1, reason: 'révoquée' }); })(),
    ]));
    if (!d.ok) { rBad += 1; continue; }
    if (r.ok) {
      rCreated += 1;
      const p = await pay(E, r.r.withdrawal.id);
      if (p.ok || p.code !== NOT_APPROVED || payouts(E)[0].status !== 'pending') rBad += 1;
    } else { rRefused += 1; if (r.code !== NOT_APPROVED || payouts(E).length) rBad += 1; }
  }
  ok(`40 request-vs-revocation races: a request may land (${rCreated}) or be refused (${rRefused}) — it is never paid while REJECTED`, rBad === 0 && rCreated + rRefused === 40, big({ rCreated, rRefused, rBad }));

  // Mixed stress: reversals, payments, requests and KYC decisions, all at once.
  let mBad = 0, mHang = 0, mPaid = 0;
  for (let round = 0; round < 25; round++) {
    const E = setup();
    const q1 = await earn(E);
    await earn(E);
    await submit(E);
    await approve(E);
    const w1 = await request(E, '100');
    const w2 = await request(E, '120');
    const id = kycRow(E).id;
    const ops = [
      async () => { await jitter(); return reverse(E, q1); },
      async () => { await jitter(); return pay(E, w1.r.withdrawal.id); },
      async () => { await jitter(); return pay(E, w2.r.withdrawal.id); },
      async () => { await jitter(); return request(E, '30'); },
      async () => { await jitter(); return decide(E, id, { action: 'reject', expectedStatus: 'APPROVED', submission: 1, reason: 'contrôle' }); },
      async () => { await jitter(); const r = await submit(E); return r.ok ? approve(E) : r; },
    ].sort(() => Math.random() - 0.5);
    let res;
    try { res = await withTimeout(Promise.all(ops.map((f) => f()))); } catch { mHang += 1; continue; }
    void res;
    mPaid += audits(E, 'RECRUITER_WITHDRAWAL_PAID').length;
    const t = await totals(E);
    const paid = payouts(E).filter((p) => p.status === 'paid').reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0);
    if (!paidOnlyWhileApproved(E) || t.paidCents !== paid || E.db._openTx.size !== 0 || E.db._locks.size !== 0) mBad += 1;
  }
  ok(`mixed stress (25 rounds: reversal + 2 payments + request + revocation + resubmission/approval): no hang / lock left, every payment inside an APPROVED interval, totals consistent (${mPaid} paid)`,
    mBad === 0 && mHang === 0, big({ mBad, mHang, mPaid }));
}

// ═════ 3. privacy, uploads, HTTP ════════════════════════════════════════════════
console.log('\n3. Privacy: own KYC only, exact responses, admin-only private images, file checks, caps, audit content, file cleanup');
{
  const VIEW_KEYS = ['canSubmit', 'rejectionReason', 'reviewedAt', 'status', 'submittedAt'];
  const E = setup();
  E.db._seed.recruiterIdentity({ recruiterId: E.B.id, status: 'REJECTED', rejectionReason: 'secret-of-B' });
  const calls = [];
  const rl = (_req, key, opts) => { calls.push({ key, opts }); return null; };
  const h = recruiterIdentityHandlers({ db: E.db, now, rateLimit: rl, storage: E.storage });
  const cookieA = `recruiter_token=${signToken({ recruiterId: E.A.id, username: E.A.username, type: 'recruiter' })}`;
  const GET = withRecruiterAuth(h.identity);
  const POST = withRecruiterAuth(h.submit);
  const get = async (cookie = cookieA, url = '/api/recruiter/identity') => { const r = await GET(new Request(`http://localhost${url}`, { headers: cookie ? { cookie } : {} }), {}); return { status: r.status, body: await r.json() }; };
  const fd = (parts) => { const f = new FormData(); for (const [k, v] of Object.entries(parts)) f.append(k, v); return f; };
  const fileOf = (kind, mime = `image/${kind}`, name = `${kind}.bin`) => new File([IMG[kind]()], name, { type: mime });
  const post = async (body, { cookie = cookieA, headers = {} } = {}) => {
    const r = await POST(new Request('http://localhost/api/recruiter/identity', { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...headers }, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }), {});
    return { status: r.status, body: await r.json() };
  };

  const g0 = await get(null);
  ok('no session → 401 (identity GET)', g0.status === 401);
  const g1 = await get(cookieA, `/api/recruiter/identity?recruiterId=${E.B.id}`);
  ok('GET = the SESSION recruiter only (a query recruiterId is ignored): NOT_SUBMITTED, never B\'s reason', g1.status === 200 && g1.body.identity.status === 'NOT_SUBMITTED' && !JSON.stringify(g1.body).includes('secret-of-B'), JSON.stringify(g1.body));
  ok('GET body: exactly { identity: { canSubmit, rejectionReason, reviewedAt, status, submittedAt } }', eq(keys(g1.body), ['identity']) && eq(keys(g1.body.identity), VIEW_KEYS));

  const p1 = await post(fd({ front: fileOf('jpeg'), back: fileOf('png'), recruiterId: E.B.id }));
  ok('POST multipart (front jpeg + back png, a body recruiterId ignored) → 201, the SESSION recruiter\'s KYC is PENDING; B untouched',
    p1.status === 201 && p1.body.identity.status === 'PENDING' && kycRow(E).recruiterId === E.A.id && kycRow(E, E.B).status === 'REJECTED', JSON.stringify(p1.body));
  ok('POST body: exactly the 5 view keys; no file key, path, reviewer or image anywhere', eq(keys(p1.body.identity), VIEW_KEYS) && !KEY_RE.test(JSON.stringify(p1.body))
    && !/cin|\.jpg|private_uploads|reviewedBy|admin-1|buffer/i.test(JSON.stringify(p1.body)), JSON.stringify(p1.body));
  ok('rate limit: key recruiter-identity-write:<id> (5 / 15 min) for POST, recruiter-identity-read:<id> (60 / min) for GET',
    calls.some((c) => c.key === `recruiter-identity-write:${E.A.id}` && eq(c.opts, { max: 5, windowMs: 15 * 60_000 })) && calls.some((c) => c.key === `recruiter-identity-read:${E.A.id}` && eq(c.opts, { max: 60, windowMs: 60_000 }))
    && eq(RECRUITER_IDENTITY_RATE.write, { max: 5, windowMs: 900_000 }));
  const limited = recruiterIdentityHandlers({ db: E.db, now, rateLimit: () => true, storage: E.storage });
  const lr = await withRecruiterAuth(limited.submit)(new Request('http://localhost/api/recruiter/identity', { method: 'POST', headers: { cookie: cookieA }, body: fd({ front: fileOf('jpeg'), back: fileOf('png') }) }), {});
  ok('rate-limited upload → 429 { code: RATE_LIMITED }', lr.status === 429 && eq(await lr.json(), { code: 'RATE_LIMITED' }));

  // B (REJECTED) re-uploads through HTTP; then admin views.
  const cookieB = `recruiter_token=${signToken({ recruiterId: E.B.id, username: E.B.username, type: 'recruiter' })}`;
  const gb = await get(cookieB);
  ok('B sees their own REJECTED reason (and canSubmit) — but no reviewer / key', gb.body.identity.status === 'REJECTED' && gb.body.identity.rejectionReason === 'secret-of-B' && gb.body.identity.canSubmit === true
    && !/admin-seed|\.jpg/.test(JSON.stringify(gb.body)));

  // File checks (service level) and HTTP mismatch.
  const C = KS.checkCinFile;
  ok('signatures: jpeg / png / webp (+ image/jpg alias) accepted', C(file('jpeg')) === null && C(file('png')) === null && C(file('webp')) === null && C({ buffer: IMG.jpeg(), mime: 'image/jpg' }) === null);
  ok('gif, pdf, svg / text → INVALID_FILE (whatever MIME is declared)', C(file('gif')) === 'INVALID_FILE' && C({ buffer: IMG.gif(), mime: 'image/png' }) === 'INVALID_FILE'
    && C({ buffer: IMG.pdf(), mime: 'image/jpeg' }) === 'INVALID_FILE' && C({ buffer: IMG.svg(), mime: 'image/png' }) === 'INVALID_FILE' && C({ buffer: IMG.svg(), mime: 'image/svg+xml' }) === 'INVALID_FILE');
  ok('MIME mismatch (declared png, jpeg bytes / declared webp, png bytes) → INVALID_FILE', C({ buffer: IMG.jpeg(), mime: 'image/png' }) === 'INVALID_FILE' && C({ buffer: IMG.png(), mime: 'image/webp' }) === 'INVALID_FILE');
  ok('empty / missing → FILE_REQUIRED; > 5 MB → FILE_TOO_LARGE; exactly 5 MB accepted',
    C(null) === 'FILE_REQUIRED' && C({ buffer: Buffer.alloc(0), mime: 'image/jpeg' }) === 'FILE_REQUIRED'
    && C({ buffer: pad([0xff, 0xd8, 0xff, 0xe0], 5 * MB + 1), mime: 'image/jpeg' }) === 'FILE_TOO_LARGE' && C({ buffer: pad([0xff, 0xd8, 0xff, 0xe0], 5 * MB), mime: 'image/jpeg' }) === null);
  const F = setup();
  const hF = recruiterIdentityHandlers({ db: F.db, now, rateLimit: noLimit, storage: F.storage });
  const cookieF = `recruiter_token=${signToken({ recruiterId: F.A.id, username: F.A.username, type: 'recruiter' })}`;
  const postF = async (body, headers = {}) => { const r = await withRecruiterAuth(hF.submit)(new Request('http://localhost/api/recruiter/identity', { method: 'POST', headers: { cookie: cookieF, ...headers }, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }), {}); return { status: r.status, body: await r.json() }; };
  const mm = await postF(fd({ front: new File([IMG.jpeg()], 'a.png', { type: 'image/png' }), back: fileOf('gif', 'image/png') }));
  ok('HTTP: declared png with jpeg bytes + a gif named png → 400 INVALID_INPUT { front: INVALID_FILE, back: INVALID_FILE }, nothing stored',
    mm.status === 400 && eq(mm.body, { code: 'INVALID_INPUT', fields: { front: 'INVALID_FILE', back: 'INVALID_FILE' } }) && F.storage.files.size === 0 && !kycRow(F), JSON.stringify(mm.body));
  const missing = await postF(fd({ front: fileOf('jpeg') }));
  ok('HTTP: back missing → 400 { back: FILE_REQUIRED }', missing.status === 400 && eq(missing.body, { code: 'INVALID_INPUT', fields: { back: 'FILE_REQUIRED' } }), JSON.stringify(missing.body));
  const bigFile = await postF(fd({ front: new File([pad([0xff, 0xd8, 0xff, 0xe0], 5 * MB + 10)], 'big.jpg', { type: 'image/jpeg' }), back: fileOf('png') }));
  ok('HTTP: a 5 MB + 10 B front (body under the cap) → 400 { front: FILE_TOO_LARGE }', bigFile.status === 400 && eq(bigFile.body, { code: 'INVALID_INPUT', fields: { front: 'FILE_TOO_LARGE' } }), JSON.stringify(bigFile.body));
  const declared = await postF(fd({ front: fileOf('jpeg'), back: fileOf('png') }), { 'content-length': String(RECRUITER_IDENTITY_BODY_LIMIT + 1) });
  ok(`body cap: Content-Length > ${RECRUITER_IDENTITY_BODY_LIMIT} (2 × 5 MB + 64 KiB) → 400 { body: TOO_LARGE } before reading`,
    RECRUITER_IDENTITY_BODY_LIMIT === 2 * 5 * MB + 64 * 1024 && declared.status === 400 && eq(declared.body, { code: 'INVALID_INPUT', fields: { body: 'TOO_LARGE' } }), JSON.stringify(declared.body));
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { if (pulled >= 20) { c.close(); return; } pulled += 1; c.enqueue(new Uint8Array(MB)); } });
  const streamed = await postF(stream, { 'content-type': 'multipart/form-data; boundary=x' });
  ok('body cap while streaming (no Content-Length, 20 MB sent): 400 { body: TOO_LARGE }, the stream cancelled early (≤ 12 MB pulled)',
    streamed.status === 400 && eq(streamed.body, { code: 'INVALID_INPUT', fields: { body: 'TOO_LARGE' } }) && pulled <= 12, `${JSON.stringify(streamed.body)} pulled=${pulled}`);
  const notMultipart = await postF(JSON.stringify({ front: 'x' }), { 'content-type': 'application/json' });
  ok('non-multipart body → 400 { front, back: FILE_REQUIRED }', notMultipart.status === 400 && eq(notMultipart.body, { code: 'INVALID_INPUT', fields: { front: 'FILE_REQUIRED', back: 'FILE_REQUIRED' } }), JSON.stringify(notMultipart.body));

  // Admin side.
  const ah = recruiterIdentityAdminHandlers({ db: E.db, now, read: E.storage.read });
  const admin = { userId: 'admin-1', email: 'admin@example.test', role: 'ADMIN' };
  const lres = await ah.list(new Request('http://localhost/api/admin/recruiter-identity'), {}, admin);
  const list = await lres.json();
  const rowA = list.verifications.find((v) => v.recruiterId === E.A.id);
  ok('admin list: metadata + history only — never a file key (no cinFrontFile / cinBackFile / <uuid>.jpg anywhere)', lres.status === 200 && rowA?.status === 'PENDING' && rowA.submission === 1
    && !/cinFrontFile|cinBackFile/.test(JSON.stringify(list)) && !KEY_RE.test(JSON.stringify(list)) && lres.headers.get('cache-control') === 'no-store', JSON.stringify(rowA));
  const img = await ah.image(new Request('http://localhost/x'), { params: Promise.resolve({ id: rowA.id, side: 'front' }) });
  const imgBytes = Buffer.from(await img.arrayBuffer());
  ok('admin image: 200, exactly image/jpeg + no-store, private + nosniff + inline; the stored bytes',
    img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && img.headers.get('cache-control') === 'no-store, private' && img.headers.get('x-content-type-options') === 'nosniff'
    && img.headers.get('content-disposition') === 'inline' && imgBytes.equals(E.storage.files.get(kycRow(E).cinFrontFile)));
  const badSide = await ah.image(new Request('http://localhost/x'), { params: Promise.resolve({ id: rowA.id, side: 'selfie' }) });
  const badId = await ah.image(new Request('http://localhost/x'), { params: Promise.resolve({ id: 'nope', side: 'back' }) });
  ok('admin image: unknown side / id → 404 (no-store, private, nosniff)', badSide.status === 404 && badId.status === 404 && badSide.headers.get('cache-control') === 'no-store, private' && badSide.headers.get('x-content-type-options') === 'nosniff');
  const putReq = (body) => new Request('http://localhost/api/admin/recruiter-identity', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const dres = await ah.decide(putReq({ id: rowA.id, action: 'reject', expectedStatus: 'PENDING', submission: 1, reason: 'x'.repeat(501) }), {}, admin);
  const dbody = await dres.json();
  ok('admin PUT: a 501-character reason → 400 { code, error } (French text, no internal message)', dres.status === 400 && dbody.code === 'INVALID_INPUT' && /1 à 500 caractères/.test(dbody.error) && eq(keys(dbody), ['code', 'error']));
  const sres = await ah.decide(putReq({ id: rowA.id, action: 'approve', expectedStatus: 'PENDING', submission: 9 }), {}, admin);
  ok('admin PUT: stale submission → 409 STALE_DECISION (French text)', sres.status === 409 && (await sres.json()).code === 'STALE_DECISION');
  const xres = await ah.decide(putReq({ id: kycRow(E, E.B).id, action: 'approve', expectedStatus: 'REJECTED', submission: 1 }), {}, admin);
  ok('admin PUT: approve a REJECTED submission → 409 INVALID_STATE', xres.status === 409 && (await xres.json()).code === 'INVALID_STATE');
  const okres = await ah.decide(putReq({ id: rowA.id, action: 'approve', expectedStatus: 'PENDING', submission: 1 }), {}, admin);
  ok('admin PUT approve → 200, reviewer = the admin user id', okres.status === 200 && kycRow(E).reviewedBy === 'admin-1' && kycRow(E).status === 'APPROVED');

  // withAdminAuth: non-admins never reach the image / decisions.
  const wrapped = withAdminAuth(ah.image);
  const anon = await wrapped(new Request('http://localhost/x'), { params: Promise.resolve({ id: rowA.id, side: 'front' }) });
  const asUser = await wrapped(new Request('http://localhost/x', { headers: { cookie: `auth_token=${signToken({ userId: 'u1', email: 'u@x.test', role: 'USER' })}` } }), { params: Promise.resolve({ id: rowA.id, side: 'front' }) });
  const asRecruiter = await wrapped(new Request('http://localhost/x', { headers: { cookie: cookieA } }), { params: Promise.resolve({ id: rowA.id, side: 'front' }) });
  ok('admin image route: no session → 401, a non-admin user → 403, a recruiter session → 401 (no image bytes)', anon.status === 401 && asUser.status === 403 && asRecruiter.status === 401
    && !(await asUser.text()).includes('JFIF'));
  const routeFiles = ['src/app/api/admin/recruiter-identity/route.js', 'src/app/api/admin/recruiter-identity/[id]/[side]/route.js'];
  ok('every export of the admin recruiter-identity routes is wrapped in withAdminAuth (GET / PUT / image GET)',
    routeFiles.every((f) => { const s = stripJs(read(f)); const ex = [...s.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*([^;]+);/g)]; return ex.length > 0 && ex.every((m) => /^withAdminAuth\(/.test(m[2].trim())); })
    && /export const GET = withAdminAuth\(h\.list\)/.test(read(routeFiles[0])) && /export const PUT = withAdminAuth\(h\.decide\)/.test(read(routeFiles[0])) && /export const GET = withAdminAuth\(h\.image\)/.test(read(routeFiles[1])));
  const rr = stripJs(read('src/app/api/recruiter/identity/route.js'));
  ok('the recruiter identity route wraps GET and POST in withRecruiterAuth only', /export const GET = withRecruiterAuth\(h\.identity\)/.test(rr) && /export const POST = withRecruiterAuth\(h\.submit\)/.test(rr) && !/withAdminAuth/.test(rr));

  // Audit rows: never a key, an image, a path or file content.
  const allAudits = E.db._tables.recruiterAuditLog.filter((a) => a.action.startsWith('RECRUITER_IDENTITY'));
  ok(`audit rows of the KYC (${allAudits.length}) contain no file key, image, path or buffer — details ⊆ { submission, from, to, reason }`,
    allAudits.length >= 2 && allAudits.every((a) => !KEY_RE.test(big(a)) && !/cin|private_uploads|buffer|JFIF|base64/i.test(big(a.details))
      && Object.keys(a.details || {}).every((k) => ['submission', 'from', 'to', 'reason'].includes(k))));

  // Superseded files: deleted only after the commit; a failed transaction keeps the old files.
  const G = setup();
  await submit(G);
  await reject(G);
  const old = [kycRow(G).cinFrontFile, kycRow(G).cinBackFile];
  G.db._state.failOnce['recruiterAuditLog.create'] = new Error('audit insert failed (injected)');
  const failed = await submit(G);
  const afterFail = kycRow(G);
  const newKeysOfFailed = [...G.storage.files.keys()].filter((k) => !old.includes(k));
  ok('resubmission whose audit insert fails → error, the row is unchanged (REJECTED, submission 1, old keys), the OLD files are kept and the NEW files removed',
    !failed.ok && afterFail.status === 'REJECTED' && afterFail.submission === 1 && afterFail.cinFrontFile === old[0] && old.every((k) => G.storage.files.has(k))
    && newKeysOfFailed.length === 0 && G.storage.removed.length === 2 && G.storage.removedWhileTxOpen.length === 0, big({ failed, afterFail, removed: G.storage.removed }));
  const okNow = await submit(G);
  ok('…the same resubmission succeeding → old files deleted after the commit (never while a transaction is open)', okNow.ok && old.every((k) => !G.storage.files.has(k)) && G.storage.removedWhileTxOpen.length === 0);
}

// ═════ 4. compatibility and lock order ═══════════════════════════════════════
console.log('\n4. Compatibility: affiliate KYC / payouts unchanged, rewards accrue while REJECTED, lock order');
{
  const AFF_KYC = ['src/lib/services/identityService.js', 'src/lib/identityStorage.js', 'src/app/api/affiliate/identity/route.js',
    'src/app/api/admin/identity/route.js', 'src/app/api/admin/identity/[id]/[side]/route.js', 'src/app/admin/identity/page.jsx'];
  ok('affiliate KYC files byte-identical to the Part 3c base commit (service, storage, affiliate route, admin routes, admin page)',
    AFF_KYC.every((f) => git(['show', `${PART3C_BASE}:${f}`]) === read(f)));
  const adminIdDir = join(ROOT, 'src/app/api/admin/identity');
  const listDir = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : []);
  ok('no file added under src/app/api/admin/identity (the affiliate admin identity routes)', eq(listDir(adminIdDir), git(['ls-tree', '-r', '--name-only', PART3C_BASE, 'src/app/api/admin/identity']).trim().split('\n').map((p) => p.replace('src/app/api/admin/identity/', '')).concat(['[id]', '[id]/[side]']).sort()));
  ok('affiliate payout code byte-identical (affiliateSystemService.js, /api/affiliate/payout, /api/admin/affiliate-payouts route + page)',
    ['src/lib/services/affiliateSystemService.js', 'src/app/api/affiliate/payout/route.js', 'src/app/api/admin/affiliate-payouts/route.js', 'src/app/admin/affiliate-payouts/page.jsx']
      .every((f) => git(['show', `${PART3C_BASE}:${f}`]) === read(f)));
  ok('prisma: the affiliate IdentityVerification model block is unchanged', (() => {
    const blk = (s) => s.slice(s.indexOf('model IdentityVerification {'), s.indexOf('}', s.indexOf('model IdentityVerification {')) + 1);
    return blk(read('prisma/schema.prisma')) === blk(git(['show', `${PART3C_BASE}:prisma/schema.prisma`]));
  })());

  {
    const E = setup({ kyc: 'REJECTED' });
    const q = qualified(E.db, E.A);
    const r = await RS.syncRecruiterReward(q.a.id, { db: E.db, now: T0 });
    ok('recruiter KYC REJECTED → the recruiter still earns (syncRecruiterReward AWARDED, ledger row written)', r.action === 'AWARDED' && E.db._tables.recruiterRewardLedger.some((l) => l.recruiterId === E.A.id && l.type === 'RECRUIT_REWARD'));
    const t = await totals(E);
    ok('…and the reward is in the wallet totals (earned 150 MAD) while withdrawals stay blocked', t.earnedCents === 15000 && (await request(E, '10')).code === NOT_APPROVED);
  }
  const rewardSrc = stripJs(read('src/lib/services/recruiterRewardService.js')) + stripJs(read('src/lib/recruiterRewardHooks.js'));
  ok('the reward service / hooks never read the recruiter KYC (no recruiterIdentityVerification / recruiterIdentityService)', !/recruiterIdentityVerification|recruiterIdentityService|recruiter_identity/.test(rewardSrc));

  // Lock order — static.
  const ks = stripJs(read('src/lib/services/recruiterIdentityService.js'));
  const decideBody = ks.slice(ks.indexOf('export async function adminDecideRecruiterIdentity'), ks.indexOf('export async function adminRecruiterCinFile'));
  ok('decision: findUnique(id) → lockRecruiterMoney → conditional updateMany (status + submission) → audit, in one transaction',
    /db\.\$transaction/.test(decideBody) && decideBody.indexOf('lockRecruiterMoney(tx, row.recruiterId)') > decideBody.indexOf('recruiterIdentityVerification.findUnique')
    && decideBody.indexOf('recruiterIdentityVerification.updateMany') > decideBody.indexOf('lockRecruiterMoney(')
    && /where: \{ id, recruiterId: row\.recruiterId, status: expectedStatus, submission \}/.test(decideBody)
    && decideBody.indexOf('recruiterAuditLog.create') > decideBody.indexOf('updateMany'));
  const submitBody = ks.slice(ks.indexOf('export async function submitRecruiterIdentity'), ks.indexOf('const historyView'));
  ok('upload never takes the money lock; files are written before the transaction and superseded ones deleted after it',
    !/lockRecruiterMoney|\$executeRaw|\$queryRaw/.test(submitBody) && submitBody.indexOf('storage.store') < submitBody.indexOf('db.$transaction')
    && submitBody.lastIndexOf('for (const k of superseded) await storage.remove(k)') > submitBody.indexOf('db.$transaction'));
  const ws = stripJs(read('src/lib/services/recruiterWalletService.js'));
  const reqBody = ws.slice(ws.indexOf('export async function requestRecruiterWithdrawal'), ws.indexOf('export async function recruiterPayoutOwner'));
  const payBody = ws.slice(ws.indexOf('export async function adminProcessRecruiterPayout'), ws.indexOf('export async function adminRecruiterBalances'));
  ok('request: row lock → replay → KYC (identityApproved) → bank → balance; never the money lock',
    reqBody.indexOf('FOR NO KEY UPDATE') < reqBody.indexOf('RECRUITER_WITHDRAWAL_REQUESTED') && reqBody.indexOf("identityApproved(tx, recruiterId)") > reqBody.indexOf('IDEMPOTENCY_CONFLICT')
    && reqBody.indexOf("identityApproved(tx, recruiterId)") < reqBody.indexOf('validateBankInfo(me)') && reqBody.indexOf('validateBankInfo(me)') < reqBody.indexOf('walletTotals(tx')
    && !/lockRecruiterMoney/.test(reqBody));
  ok('payment: row lock → money lock → status re-read → KYC → balance → conditional update; reject skips the KYC (inside the pay branch only)',
    payBody.indexOf('FOR NO KEY UPDATE') < payBody.indexOf('lockRecruiterMoney(tx, row.recruiterId)') && payBody.indexOf('lockRecruiterMoney(') < payBody.indexOf("current?.status !== 'pending'")
    && payBody.indexOf("current?.status !== 'pending'") < payBody.indexOf('identityApproved(tx, row.recruiterId)') && payBody.indexOf('identityApproved(tx, row.recruiterId)') < payBody.indexOf('walletTotals(tx')
    && payBody.indexOf('walletTotals(tx') < payBody.indexOf('affiliatePayout.updateMany') && /if \(action === 'pay'\) \{[\s\S]*identityApproved\(tx, row\.recruiterId\)[\s\S]*\n {4}\}/.test(payBody));
  ok('wallet service KYC read = status only, by recruiterId (no file key), and no import of the KYC service / storage',
    /recruiterIdentityVerification\.findUnique\(\{ where: \{ recruiterId \}, select: \{ status: true \} \}\)/.test(ws) && !/identityStorage|recruiterIdentityService|cinFrontFile/.test(ws));

  // Lock order — runtime.
  const E = setup();
  await earn(E);
  await submit(E);
  await approve(E);
  const w = await request(E, '50');
  const seen = [];
  E.hookBox.fn = (m, o, a) => { if (m === 'recruiterIdentityVerification') seen.push({ op: `${o}:${a?.where?.recruiterId ? 'byRecruiter' : 'byId'}`, money: holdsMoney(E), row: E.db._locks.has(E.A.id) }); };
  await pay(E, w.r.withdrawal.id);
  const payRead = seen.find((s) => s.op === 'findUnique:byRecruiter');
  seen.length = 0;
  await request(E, '10');
  const reqRead = seen.find((s) => s.op === 'findUnique:byRecruiter');
  seen.length = 0;
  await reject(E);
  const decWrite = seen.find((s) => s.op.startsWith('updateMany'));
  seen.length = 0;
  await submit(E);
  const upWrite = seen.find((s) => s.op.startsWith('updateMany'));
  E.hookBox.fn = null;
  ok('runtime: payment reads the KYC holding the row lock AND the money lock; request holds the row lock but NOT the money lock',
    payRead?.money === true && payRead?.row === true && reqRead?.money === false && reqRead?.row === true, big({ payRead, reqRead }));
  ok('runtime: a decision writes the KYC holding the money lock; an upload writes it without the money lock; no lock left afterwards',
    decWrite?.money === true && upWrite?.money === false && E.db._locks.size === 0 && E.db._openTx.size === 0, big({ decWrite, upWrite }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
