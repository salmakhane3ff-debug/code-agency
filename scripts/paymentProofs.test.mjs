#!/usr/bin/env node
/**
 * scripts/paymentProofs.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Payment Proofs — the admin-managed DISPLAY feed of the affiliate-dashboard
 * slider. Runs entirely in memory (scripts/lib/paymentProofFakeDb.mjs): no
 * database, no file written into the repository, no server.
 * Proves:
 *   • visibility: PUBLISHED and publishedAt in (now − 72 h, now] only, from the
 *     ACTUAL publishedAt; scheduled / cancelled / failed / expired hidden
 *   • ONE global feed: identical for every active affiliate, cursor-paginated with
 *     no cap (every eligible proof exactly once), public fields only
 *   • manual scheduling (count per day + exact time), review, edit, cancel, DST,
 *     batch partial failure and idempotent retry
 *   • mandatory privacy + authenticity declarations and the append-only audit trail
 *   • publisher worker: advisory lock, atomic conditional publication, retries,
 *     restarts, concurrent workers, missing receipt → FAILED
 *   • security (admin only for every change, active affiliates only, 404 for
 *     anything not visible, upload validation) and isolation from every
 *     financial table
 * Run: node scripts/paymentProofs.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'payment-proofs-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { makePaymentProofFakeDb, makeProofMemStorage, makeFakeLock, pngBytes } from './lib/paymentProofFakeDb.mjs';

const P = await import('../src/lib/paymentProofs.js');
const S = await import('../src/lib/services/paymentProofService.js');
const W = await import('../src/lib/services/paymentProofPublisher.js');
const { adminPaymentProofHandlers, affiliatePaymentProofHandlers } = await import('../src/lib/paymentProofRouteHandlers.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { withAffiliateAuth } = await import('../src/lib/middleware/withAffiliateAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const { defaultPaymentProofStorage } = await import('../src/lib/paymentProofStorage.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const H = P.HOUR_MS, DAY = 24 * H;
const T0 = new Date('2026-11-04T09:00:00.000Z'); // 10:00 in Casablanca (UTC+1)
const at = (msFromT0) => new Date(T0.getTime() + msFromT0);
const ADMIN = 'admin-1';
const tok = () => randomBytes(16).toString('hex');
const ALL_RESPONSE_TEXT = []; // every API body seen, to prove no storage key / fingerprint leaks

/** Direct insert of a proof row (for visibility / feed scenarios). */
function seed(db, over = {}) {
  const row = {
    id: `p-${tok().slice(0, 12)}`, displayName: 'Amina K.', displayAmountCents: 150000, fileKey: `${crypto.randomUUID()}.jpg`,
    fingerprint: tok() + tok(), publicToken: tok(), status: 'PUBLISHED', scheduledAt: at(-80 * H), publishedAt: at(-1 * H),
    cancelledAt: null, failedAt: null, failureReason: null, publishAttempts: 1, batchId: null, clientRef: `seed-${tok()}`,
    privacyConfirmedAt: at(-90 * H), privacyConfirmedBy: ADMIN, authenticityConfirmedAt: at(-90 * H), authenticityConfirmedBy: ADMIN,
    createdBy: ADMIN, updatedBy: ADMIN, createdAt: at(-90 * H), updatedAt: at(-90 * H), ...over,
  };
  db._tables.paymentProof.push(row);
  return row;
}
const input = (i, over = {}) => ({
  displayName: `Client ${i}`, amount: '1500', date: '2026-11-05', time: '10:00', clientRef: `ref-${i}-abcdef`,
  privacyConfirmed: true, authenticityConfirmed: true, ...over,
});
const fileOf = (tag, mime = 'image/png', buf = pngBytes(tag)) => ({ buffer: buf, mime, size: buf.length });

// tokens + request helpers
const adminToken = signToken({ userId: ADMIN, email: 'admin@example.test', role: 'ADMIN' });
const userToken = signToken({ userId: 'u-9', email: 'user@example.test', role: 'USER' });
const affToken = (id) => signToken({ affiliateId: id, username: id, type: 'affiliate' });
const req = (url, { method = 'GET', cookie, bearer, body, json } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://x${url}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
};
const ctx = (params) => ({ params: Promise.resolve(params) });
async function bodyOf(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { const t = await res.text(); ALL_RESPONSE_TEXT.push(t); return JSON.parse(t); }
  return null;
}
function wire(db, storage, { clock = () => T0, rateLimit = () => null } = {}) {
  const a = adminPaymentProofHandlers({ db, storage, now: () => clock() });
  const f = affiliatePaymentProofHandlers({ db, storage, now: () => clock(), rateLimit });
  return {
    admin: Object.fromEntries(Object.entries(a).map(([k, h]) => [k, withAdminAuth(h)])),
    // Phase 6 part 2: the REAL withAffiliateAuth reads the account (active + tokenVersion) per
    // request — the same fake db is injected.
    aff: Object.fromEntries(Object.entries(f).map(([k, h]) => [k, withAffiliateAuth(h, { db })])),
    rawAff: f,
  };
}
const multipart = (fields, file) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, String(v));
  if (file) fd.append('receipt', new File([file.buffer], 'receipt', { type: file.mime }));
  return fd;
};

// ── 1. Visibility ────────────────────────────────────────────────────────────
console.log('\n1. Visibility: published proofs of the last 72 h only (from the actual publishedAt)');
{
  const db = makePaymentProofFakeDb({ affiliates: [{ id: 'a1' }] });
  const v71 = seed(db, { publishedAt: at(-71 * H), displayName: 'Visible 71h' });
  const v72 = seed(db, { publishedAt: at(-72 * H), displayName: 'Exactly 72h' });
  const v73 = seed(db, { publishedAt: at(-73 * H), displayName: 'Old 73h' });
  const sch = seed(db, { status: 'SCHEDULED', publishedAt: null, scheduledAt: at(-2 * H), displayName: 'Scheduled' });
  const can = seed(db, { status: 'CANCELLED', publishedAt: null, cancelledAt: at(-3 * H), displayName: 'Cancelled' });
  const fai = seed(db, { status: 'FAILED', publishedAt: null, failedAt: at(-3 * H), failureReason: 'RECEIPT_MISSING', displayName: 'Failed' });
  const fut = seed(db, { publishedAt: at(+1 * H), displayName: 'Future publishedAt' });
  const late = seed(db, { publishedAt: at(-10 * H), scheduledAt: at(-9 * DAY), createdAt: at(-10 * DAY), displayName: 'Late publication' });
  const feed = await S.listVisiblePaymentProofs({ db, now: T0 });
  const names = feed.proofs.map((p) => p.name);
  ok('published 71 h ago: visible', names.includes(v71.displayName));
  ok('published exactly 72 h ago: NOT visible', !names.includes(v72.displayName));
  ok('published 73 h ago: NOT visible', !names.includes(v73.displayName));
  ok('SCHEDULED: hidden', !names.includes(sch.displayName));
  ok('CANCELLED: hidden', !names.includes(can.displayName));
  ok('FAILED: hidden', !names.includes(fai.displayName));
  ok('future publishedAt: hidden', !names.includes(fut.displayName));
  ok('window counts from publishedAt, not scheduledAt / createdAt (scheduled 9 days ago, published 10 h ago → visible)', names.includes(late.displayName));
  ok('exactly the 2 eligible proofs, total = 2', feed.proofs.length === 2 && feed.total === 2 && feed.nextCursor === null, JSON.stringify(feed));
  ok('pure rule isVisibleAt agrees at the boundaries (now − 72 h excluded, now included)',
    !P.isVisibleAt({ status: 'PUBLISHED', publishedAt: at(-72 * H) }, T0.getTime()) && P.isVisibleAt({ status: 'PUBLISHED', publishedAt: T0 }, T0.getTime())
    && P.isVisibleAt({ status: 'PUBLISHED', publishedAt: new Date(T0.getTime() - 72 * H + 1) }, T0.getTime()));
  // the same rule through the affiliate handler
  const w = wire(db, makeProofMemStorage());
  const res = await w.aff.list(req('/api/affiliate/payment-proofs', { bearer: affToken('a1') }), ctx({}));
  const body = await bodyOf(res);
  ok('affiliate handler: 200 and the same 2 proofs', res.status === 200 && body.proofs.length === 2 && body.proofs.every((p) => [v71.displayName, late.displayName].includes(p.name)));
  // later: the 71 h proof expires 1 h later
  const later = await S.listVisiblePaymentProofs({ db, now: at(+1 * H) });
  ok('one hour later the 71 h proof has expired (exactly 72 h); the later ones remain / appear on time',
    !later.proofs.some((p) => p.name === v71.displayName) && later.proofs.some((p) => p.name === late.displayName) && later.proofs.some((p) => p.name === fut.displayName));
}

// ── 2. One global feed, no cap ───────────────────────────────────────────────
console.log('\n2. One global feed: identical for every active affiliate, paginated, nothing omitted');
{
  const db = makePaymentProofFakeDb({ affiliates: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'off', isActive: false }] });
  const N = 237;
  for (let i = 0; i < N; i++) seed(db, { displayName: `Proof ${i}`, displayAmountCents: 1000 + i, publishedAt: at(-(Math.floor(i / 10) + 1) * 60_000 * 7) }); // groups of 10 share a publishedAt
  seed(db, { publishedAt: at(-73 * H), displayName: 'expired' });
  seed(db, { status: 'SCHEDULED', publishedAt: null, scheduledAt: at(+H), displayName: 'scheduled' });
  const limiterCalls = [];
  const w = wire(db, makeProofMemStorage(), { rateLimit: (_r, key) => { limiterCalls.push(key); return null; } });
  const walk = async (aff) => {
    const pages = [], raw = [];
    let cursor = null;
    for (let guard = 0; guard < 50; guard++) {
      const res = await w.aff.list(req(`/api/affiliate/payment-proofs${cursor ? `?cursor=${cursor}` : ''}`, { bearer: affToken(aff) }), ctx({}));
      const text = await res.clone().text();
      raw.push(text);
      const b = await bodyOf(res);
      pages.push(b);
      if (!b.nextCursor) break;
      cursor = b.nextCursor;
    }
    return { pages, raw, items: pages.flatMap((p) => p.proofs) };
  };
  const r1 = await walk('a1'), r2 = await walk('a2'), r3 = await walk('a3');
  ok('three different active affiliates receive byte-identical responses (same proofs, order, totals, cursors)',
    JSON.stringify(r1.raw) === JSON.stringify(r2.raw) && JSON.stringify(r2.raw) === JSON.stringify(r3.raw));
  const tokens = r1.items.map((p) => p.token);
  ok(`no cap: following nextCursor returns all ${N} eligible proofs exactly once (no duplicate, none omitted)`,
    tokens.length === N && new Set(tokens).size === N, `${tokens.length} / unique ${new Set(tokens).size}`);
  ok(`total === ${N} on every page; ${Math.ceil(N / P.PROOF_LIMITS.FEED_PAGE_SIZE)} pages of ≤ ${P.PROOF_LIMITS.FEED_PAGE_SIZE}`,
    r1.pages.every((p) => p.total === N) && r1.pages.length === Math.ceil(N / P.PROOF_LIMITS.FEED_PAGE_SIZE) && r1.pages.every((p) => p.proofs.length <= P.PROOF_LIMITS.FEED_PAGE_SIZE));
  const expected = db._tables.paymentProof.filter((r) => P.isVisibleAt(r, T0.getTime()))
    .sort((a, b) => (b.publishedAt - a.publishedAt) || (a.publicToken < b.publicToken ? -1 : 1)).map((r) => r.publicToken);
  ok('order: publishedAt DESC then token ASC (deterministic with many identical publishedAt)', JSON.stringify(tokens) === JSON.stringify(expected));
  ok('expired and scheduled proofs are not in the global feed', !r1.items.some((p) => p.name === 'expired' || p.name === 'scheduled'));
  const keys = new Set(r1.items.flatMap((p) => Object.keys(p)));
  ok('feed items expose ONLY token, name, amount, publishedAt', JSON.stringify([...keys].sort()) === JSON.stringify(['amount', 'name', 'publishedAt', 'token']));
  ok('no internal field in any feed response (id, fileKey, fingerprint, clientRef, batchId, status, scheduledAt, confirmations)',
    !/"(id|fileKey|fingerprint|clientRef|batchId|status|scheduledAt|privacyConfirmed\w*|authenticityConfirmed\w*|createdBy|updatedBy)"/.test(r1.raw.join('')));
  ok('amount is the display amount (cents / 100)', r1.items.find((p) => p.name === 'Proof 5')?.amount === 10.05);
  const bad = await w.aff.list(req('/api/affiliate/payment-proofs?cursor=not!valid', { bearer: affToken('a1') }), ctx({}));
  const forged = await w.aff.list(req(`/api/affiliate/payment-proofs?cursor=${Buffer.from('123.zz').toString('base64url')}`, { bearer: affToken('a1') }), ctx({}));
  ok('invalid / forged cursor → 400 INVALID_INPUT', bad.status === 400 && (await bodyOf(bad)).code === 'INVALID_INPUT' && forged.status === 400);
  // Phase 6 part 2 (D4): the auth layer itself refuses an inactive or missing account (401);
  // the handler's own guard (403) is still proven with the middleware bypassed (rawAff).
  const inactive = await w.aff.list(req('/api/affiliate/payment-proofs', { bearer: affToken('off') }), ctx({}));
  ok('inactive affiliate → 401 at the auth layer', inactive.status === 401);
  const inactiveRaw = await w.rawAff.list(req('/api/affiliate/payment-proofs'), ctx({}), { affiliateId: 'off', type: 'affiliate' });
  ok('inactive affiliate, handler alone → 403 AFFILIATE_INACTIVE', inactiveRaw.status === 403 && (await bodyOf(inactiveRaw)).code === 'AFFILIATE_INACTIVE');
  const unknown = await w.aff.list(req('/api/affiliate/payment-proofs', { bearer: affToken('ghost') }), ctx({}));
  ok('unknown affiliate id (deleted account, valid token) → 401 at the auth layer', unknown.status === 401);
  const unknownRaw = await w.rawAff.list(req('/api/affiliate/payment-proofs'), ctx({}), { affiliateId: 'ghost', type: 'affiliate' });
  ok('unknown affiliate id, handler alone → 403', unknownRaw.status === 403);
  ok('the rate limiter is consulted on every feed request', limiterCalls.length >= r1.pages.length * 3 && limiterCalls.every((k) => k === 'payment_proofs_feed'));
  const limited = wire(db, makeProofMemStorage(), { rateLimit: () => Response.json({ error: 'Too many' }, { status: 429 }) });
  const lr = await limited.aff.list(req('/api/affiliate/payment-proofs', { bearer: affToken('a1') }), ctx({}));
  const li = await limited.aff.image(req(`/api/affiliate/payment-proofs/${tokens[0]}/image`, { bearer: affToken('a1') }), ctx({ token: tokens[0] }));
  ok('a limited caller gets the limiter’s 429 (feed and image)', lr.status === 429 && li.status === 429);
  ok('the feed never filters by affiliate: the service query has no affiliate condition',
    db._log.filter((l) => l.model === 'paymentProof' && l.op === 'findMany').every((l) => !/affiliate/i.test(JSON.stringify(l.where))));
}

// ── 3. Manual scheduling, review, edit, cancel, DST, batch ──────────────────
console.log('\n3. Manual scheduling (admin controls count per day and exact times)');
{
  const db = makePaymentProofFakeDb();
  const storage = makeProofMemStorage();
  const opts = { db, storage, now: T0, actorId: ADMIN };
  // day 1: three proofs at 09:15, 13:40, 22:05; day 2: none; day 3: one at 08:00
  const plan = [['2026-11-05', '09:15'], ['2026-11-05', '13:40'], ['2026-11-05', '22:05'], ['2026-11-07', '08:00']];
  const created = [];
  for (const [i, [date, time]] of plan.entries()) created.push((await S.createPaymentProof(input(i, { date, time }), fileOf(`s${i}`), opts)).proof);
  ok('several proofs on the same Casablanca day, each at its exact manual time (UTC+1)',
    created[0].scheduledAt === '2026-11-05T08:15:00.000Z' && created[1].scheduledAt === '2026-11-05T12:40:00.000Z' && created[2].scheduledAt === '2026-11-05T21:05:00.000Z'
    && created.every((c) => c.status === 'SCHEDULED') && created[2].scheduledLocal.date === '2026-11-05' && created[2].scheduledLocal.time === '22:05');

  // review (nothing written)
  const before = db._tables.paymentProof.length;
  const logStart = db._log.length;
  const items = [
    input(10, { date: '2026-11-05', time: '09:00' }), input(11, { date: '2026-11-05', time: '11:30' }), input(12, { date: '2026-11-06', time: '10:00' }),
    input(10, { date: '2026-11-05', time: '09:00' }),                                   // 3: same clientRef as 0
    input(13, { displayName: 'Client 10', date: '2026-11-05', time: '09:00' }),         // 4: same slot as 0 (name|amount|time)
    input(0, { date: '2026-11-08', time: '10:00' }),                                     // 5: clientRef already created
    input(14, { amount: '0' }), input(15, { amount: '-5' }), input(16, { amount: 'abc' }), input(17, { amount: '1000000.01' }),
    input(18, { displayName: 'x' }), input(19, { displayName: '<b>bold</b>' }),
    input(20, { date: '2026-11-04', time: '09:00' }),                                    // past
    input(21, { date: '2027-12-01', time: '10:00' }),                                    // > 366 days
    input(22, { privacyConfirmed: false }), input(23, { authenticityConfirmed: undefined }),
  ];
  const review = await S.validatePaymentProofBatch(items, { db, now: T0 });
  const e = (i) => review.items[i].errors;
  ok('review groups the schedule by Casablanca day (manual count per day kept)', JSON.stringify(review.days['2026-11-05']?.slice(0, 2)) === '[0,1]' && review.days['2026-11-06']?.includes(2));
  ok('review: valid rows ok, overall not ok', review.items[0].ok && review.items[1].ok && review.items[2].ok && review.ok === false);
  ok('review flags DUPLICATE_IN_BATCH, duplicate slot (duplicateOf) and ALREADY_CREATED', e(3).clientRef === 'DUPLICATE_IN_BATCH' && e(4).duplicateOf === 0 && e(5).clientRef === 'ALREADY_CREATED');
  ok('review flags invalid amounts 0 / -5 / abc / over max', [6, 7, 8, 9].every((i) => e(i).amount === 'INVALID_AMOUNT'));
  ok('review flags invalid names (too short, markup)', e(10).displayName === 'INVALID_ALIAS' && e(11).displayName === 'INVALID_ALIAS');
  ok('review flags past time and > 366 days', e(12).scheduledAt === 'SCHEDULE_IN_PAST' && e(13).scheduledAt === 'SCHEDULE_TOO_FAR');
  ok('review flags missing privacy / authenticity confirmation', e(14).privacyConfirmed === 'PRIVACY_CONFIRMATION_REQUIRED' && e(15).authenticityConfirmed === 'AUTHENTICITY_CONFIRMATION_REQUIRED');
  const reviewLog = db._log.slice(logStart);
  ok('review writes nothing and uses ONE query for all clientRefs (no N+1)',
    db._tables.paymentProof.length === before && reviewLog.filter((l) => l.model === 'paymentProof').length === 1 && reviewLog[0].op === 'findMany'
    && !reviewLog.some((l) => ['create', 'updateMany'].includes(l.op)));
  ok('review refuses an empty batch and more than MAX_BATCH_ITEMS', (await rejects(S.validatePaymentProofBatch([], { db, now: T0 })))?.code === 'INVALID_INPUT'
    && (await rejects(S.validatePaymentProofBatch(Array.from({ length: P.PROOF_LIMITS.MAX_BATCH_ITEMS + 1 }, (_, i) => input(100 + i)), { db, now: T0 })))?.code === 'INVALID_INPUT');

  // edit before publication: both confirmations again, recorded anew
  const id = created[1].id;
  const noConf = await rejects(S.updatePaymentProofSchedule(id, { date: '2026-11-06', time: '15:30', displayName: 'Nouveau nom', amount: '2500' }, { ...opts, actorId: 'admin-2', now: at(H) }));
  ok('edit without re-confirming privacy + authenticity → INVALID_INPUT', noConf?.code === 'INVALID_INPUT' && noConf.errors.privacyConfirmed && noConf.errors.authenticityConfirmed);
  const edited = await S.updatePaymentProofSchedule(id, { date: '2026-11-06', time: '15:30', displayName: 'Nouveau nom', amount: '2500', privacyConfirmed: true, authenticityConfirmed: true }, { ...opts, actorId: 'admin-2', now: at(H) });
  ok('edit before publication: new time, name and amount', edited.scheduledAt === '2026-11-06T14:30:00.000Z' && edited.displayName === 'Nouveau nom' && edited.amount === 2500 && edited.status === 'SCHEDULED');
  ok('edit records the new confirming admin and time', edited.privacyConfirmedBy === 'admin-2' && edited.authenticityConfirmedBy === 'admin-2' && edited.privacyConfirmedAt === at(H).toISOString());
  const evs = (await S.listPaymentProofEvents(id, { db })).events;
  const editEv = evs.find((x) => x.action === 'EDIT');
  ok('EDIT event with before/after values, then fresh CONFIRM_PRIVACY + CONFIRM_AUTHENTICITY',
    editEv && editEv.actor === 'admin-2' && editEv.details.before.displayName === 'Client 1' && editEv.details.after.displayName === 'Nouveau nom'
    && evs.filter((x) => x.action === 'CONFIRM_PRIVACY').length === 2 && evs.filter((x) => x.action === 'CONFIRM_AUTHENTICITY').length === 2);

  // cancel before publication
  const c1 = await S.cancelPaymentProof(created[3].id, opts);
  const c2 = await S.cancelPaymentProof(created[3].id, opts);
  const row = db._tables.paymentProof.find((r) => r.id === created[3].id);
  ok('cancel before publication keeps the record (CANCELLED + cancelledAt)', c1.proof.status === 'CANCELLED' && row && row.cancelledAt instanceof Date && !c1.alreadyCancelled);
  ok('cancel twice is idempotent (no second CANCEL event)', c2.alreadyCancelled === true
    && db._tables.paymentProofEvent.filter((x) => x.proofId === created[3].id && x.action === 'CANCEL').length === 1);

  // publish one, then edit / cancel must be refused
  const lock = makeFakeLock();
  await W.runPaymentProofPublishTick({ db, storage, lock, now: () => at(DAY + 2 * H) }); // 2026-11-05 11:00Z: 08:15Z due
  ok('publisher published the due proof', db._tables.paymentProof.find((r) => r.id === created[0].id).status === 'PUBLISHED');
  const ed = await rejects(S.updatePaymentProofSchedule(created[0].id, { date: '2026-11-09', time: '10:00', privacyConfirmed: true, authenticityConfirmed: true }, { ...opts, now: at(DAY + 3 * H) }));
  const cn = await rejects(S.cancelPaymentProof(created[0].id, { ...opts, now: at(DAY + 3 * H) }));
  ok('edit after publication → NOT_EDITABLE (409)', ed?.code === 'NOT_EDITABLE');
  ok('cancel after publication → NOT_CANCELLABLE (409), still PUBLISHED', cn?.code === 'NOT_CANCELLABLE' && db._tables.paymentProof.find((r) => r.id === created[0].id).status === 'PUBLISHED');

  // FAILED → edit → SCHEDULED
  const lostRow = db._tables.paymentProof.find((r) => r.id === created[2].id);
  const keep = storage.files.get(lostRow.fileKey);
  storage.lose(lostRow.fileKey);
  await W.runPaymentProofPublishTick({ db, storage, lock, now: () => at(DAY + 13 * H) }); // 22:00Z ≥ 21:05Z
  ok('missing receipt at publication → FAILED (RECEIPT_MISSING)', lostRow.status === 'FAILED' && lostRow.failureReason === 'RECEIPT_MISSING');
  const stillMissing = await rejects(S.updatePaymentProofSchedule(created[2].id, { date: '2026-11-09', time: '10:00', privacyConfirmed: true, authenticityConfirmed: true }, { ...opts, now: at(DAY + 14 * H) }));
  ok('a FAILED proof whose receipt is still missing cannot be rescheduled (RECEIPT_MISSING)', stillMissing?.code === 'RECEIPT_MISSING');
  storage.files.set(lostRow.fileKey, keep);
  const back = await S.updatePaymentProofSchedule(created[2].id, { date: '2026-11-09', time: '10:00', privacyConfirmed: true, authenticityConfirmed: true }, { ...opts, now: at(DAY + 14 * H) });
  ok('FAILED → edit → SCHEDULED again (failure cleared)', back.status === 'SCHEDULED' && back.failureReason === null && back.failedAt === null);
}
{
  // DST (Morocco: clocks back on 2026-02-15 03:00 → 02:00, forward on 2026-03-22 02:00 → 03:00)
  const db = makePaymentProofFakeDb(), storage = makeProofMemStorage();
  const opts = { db, storage, now: new Date('2026-02-01T00:00:00Z'), actorId: ADMIN };
  const gap = await rejects(S.createPaymentProof(input(1, { date: '2026-03-22', time: '02:30' }), fileOf('d1'), opts));
  ok('DST: 2026-03-22 02:30 (skipped hour) → NONEXISTENT_LOCAL_TIME', gap?.code === 'INVALID_INPUT' && gap.errors.scheduledAt === 'NONEXISTENT_LOCAL_TIME');
  const amb = (await S.createPaymentProof(input(2, { date: '2026-02-15', time: '02:30' }), fileOf('d2'), opts)).proof;
  ok('DST: 2026-02-15 02:30 (repeated hour) → the earlier instant 01:30Z', amb.scheduledAt === '2026-02-15T01:30:00.000Z');
  const normal = (await S.createPaymentProof(input(3, { date: '2026-02-10', time: '10:00' }), fileOf('d3'), opts)).proof;
  const ramadan = (await S.createPaymentProof(input(4, { date: '2026-03-01', time: '10:00' }), fileOf('d4'), opts)).proof;
  ok('normal day 10:00 → 09:00Z (UTC+1); during Ramadan 10:00 → 10:00Z (UTC+0)', normal.scheduledAt === '2026-02-10T09:00:00.000Z' && ramadan.scheduledAt === '2026-03-01T10:00:00.000Z');
  ok('invalid calendar date / time → INVALID_DATETIME', P.casablancaToUtc('2026-02-30', '10:00').error === 'INVALID_DATETIME' && P.casablancaToUtc('2026-11-04', '24:00').error === 'INVALID_DATETIME');
}
{
  // batch partial failure + idempotent retry (through the real admin handler, multipart)
  const db = makePaymentProofFakeDb(), storage = makeProofMemStorage();
  const w = wire(db, storage);
  const batchId = 'batch-0001-abcdef';
  const rows = [0, 1, 2, 3, 4].map((i) => ({ fields: { ...input(i, { time: `1${i}:00` }), batchId }, file: fileOf(`b${i}`) }));
  rows[1].file = fileOf('bad', 'image/png', Buffer.from('this is not an image at all'));
  const send = (r) => w.admin.create(req('/api/admin/payment-proofs', { method: 'POST', cookie: `auth_token=${adminToken}`, body: multipart(r.fields, r.file) }), ctx({}));
  const first = [];
  for (const [i, r] of rows.entries()) {
    if (i === 3) storage.failStore = 1;          // the 4th upload hits a storage failure
    const res = await send(r);
    first.push({ status: res.status, body: await bodyOf(res) });
  }
  ok('partial failure: 3 created (201), the bad file → 400 INVALID_FILE, the storage failure → 500, reported per item',
    [0, 2, 4].every((i) => first[i].status === 201) && first[1].status === 400 && first[1].body.code === 'INVALID_FILE' && first[3].status === 500);
  ok('nothing lost or orphaned: 3 rows, exactly 3 stored receipts', db._tables.paymentProof.length === 3 && storage.files.size === 3);
  rows[1].file = fileOf('b1');
  const second = [];
  for (const r of rows) { const res = await send(r); second.push({ status: res.status, body: await bodyOf(res) }); }
  ok('retry with the SAME clientRefs: the 3 created ones return existing (200), the 2 failed ones are created (201)',
    [0, 2, 4].every((i) => second[i].status === 200 && second[i].body.existing === true) && [1, 3].every((i) => second[i].status === 201));
  ok('no duplicate: 5 rows, 5 receipts, one CREATE event per proof, all in the batch',
    db._tables.paymentProof.length === 5 && storage.files.size === 5 && db._tables.paymentProofEvent.filter((x) => x.action === 'CREATE').length === 5
    && db._tables.paymentProof.every((r) => r.batchId === batchId));
  const list = await w.admin.list(req(`/api/admin/payment-proofs?batchId=${batchId}`, { cookie: `auth_token=${adminToken}` }), ctx({}));
  const lb = await bodyOf(list);
  ok('admin list filters the batch and reports status counts', list.status === 200 && lb.total === 5 && lb.counts.SCHEDULED === 5 && lb.items.length === 5);
  // a DB failure after the receipt was stored → the receipt is removed (no orphan)
  db.failNext('paymentProof', 'create');
  const orphan = await send({ fields: input(9, { time: '19:00' }), file: fileOf('b9') });
  ok('a database failure after storing the receipt leaves no orphan file and no row', orphan.status === 500 && storage.files.size === 5 && db._tables.paymentProof.length === 5);
}

// ── 4. Idempotent creation ──────────────────────────────────────────────────
console.log('\n4. Idempotent creation and duplicate receipts');
{
  const db = makePaymentProofFakeDb(), storage = makeProofMemStorage();
  const opts = { db, storage, now: T0, actorId: ADMIN };
  const a = await S.createPaymentProof(input(1), fileOf('i1'), opts);
  const b = await S.createPaymentProof(input(1), fileOf('i1'), opts);
  ok('sequential retry with the same clientRef → existing, one row, one receipt', !a.existing && b.existing && b.proof.id === a.proof.id && db._tables.paymentProof.length === 1 && storage.files.size === 1);
  const [c, d] = await Promise.all([S.createPaymentProof(input(2), fileOf('i2'), opts), S.createPaymentProof(input(2), fileOf('i2'), opts)]);
  ok('concurrent retry with the same clientRef → one row, one stored receipt (the loser’s file removed)',
    db._tables.paymentProof.filter((r) => r.clientRef === input(2).clientRef).length === 1 && storage.files.size === 2 && [c.existing, d.existing].filter(Boolean).length === 1);
  const conflict = await rejects(S.createPaymentProof(input(1, { amount: '999' }), fileOf('i1'), opts));
  ok('same clientRef with different content → CLIENT_REF_CONFLICT', conflict?.code === 'CLIENT_REF_CONFLICT');
  const dup = await rejects(S.createPaymentProof(input(3), fileOf('i1'), opts));
  ok('same receipt bytes under another clientRef → DUPLICATE_RECEIPT, nothing left behind', dup?.code === 'DUPLICATE_RECEIPT' && storage.files.size === 2 && db._tables.paymentProof.length === 2);
  await S.cancelPaymentProof(a.proof.id, opts);
  const again = await S.createPaymentProof(input(4), fileOf('i1'), opts);
  ok('the same receipt is accepted again once the first proof is CANCELLED', again.proof.status === 'SCHEDULED');
}

// ── 5. Mandatory declarations + audit trail ─────────────────────────────────
console.log('\n5. Mandatory privacy + authenticity declarations, append-only audit');
{
  const db = makePaymentProofFakeDb(), storage = makeProofMemStorage();
  const opts = { db, storage, now: T0, actorId: ADMIN };
  const np = await rejects(S.createPaymentProof(input(1, { privacyConfirmed: false }), fileOf('c1'), opts));
  const na = await rejects(S.createPaymentProof(input(2, { authenticityConfirmed: 'no' }), fileOf('c2'), opts));
  ok('without privacy confirmation → INVALID_INPUT / PRIVACY_CONFIRMATION_REQUIRED, nothing stored', np?.errors?.privacyConfirmed === 'PRIVACY_CONFIRMATION_REQUIRED' && storage.stored === 0);
  ok('without authenticity attestation → INVALID_INPUT / AUTHENTICITY_CONFIRMATION_REQUIRED, nothing stored', na?.errors?.authenticityConfirmed === 'AUTHENTICITY_CONFIRMATION_REQUIRED' && storage.stored === 0 && db._tables.paymentProof.length === 0);
  const noActor = await rejects(S.createPaymentProof(input(3), fileOf('c3'), { ...opts, actorId: null }));
  ok('no admin identity → refused (UNAUTHORIZED), nothing stored', noActor?.code === 'UNAUTHORIZED' && storage.stored === 0);
  // through the handler: actor = the admin token's userId
  const w = wire(db, storage);
  const res = await w.admin.create(req('/api/admin/payment-proofs', { method: 'POST', cookie: `auth_token=${adminToken}`, body: multipart(input(4), fileOf('c4')) }), ctx({}));
  const created = (await bodyOf(res)).proof;
  const row = db._tables.paymentProof.find((r) => r.id === created.id);
  ok('created row records privacyConfirmedAt/By and authenticityConfirmedAt/By = admin token userId + clock',
    row.privacyConfirmedBy === ADMIN && row.authenticityConfirmedBy === ADMIN && row.privacyConfirmedAt.getTime() === T0.getTime() && row.authenticityConfirmedAt.getTime() === T0.getTime() && row.createdBy === ADMIN);
  const form = multipart(input(5, { privacyConfirmed: undefined }), fileOf('c5'));
  const r400 = await w.admin.create(req('/api/admin/payment-proofs', { method: 'POST', cookie: `auth_token=${adminToken}`, body: form }), ctx({}));
  ok('handler: missing checkbox → 400 with the field error', r400.status === 400 && (await bodyOf(r400)).errors.privacyConfirmed === 'PRIVACY_CONFIRMATION_REQUIRED');
  // transaction: an event write failure rolls back the change
  db.failNext('paymentProofEvent', 'create');
  const rolled = await rejects(S.createPaymentProof(input(6), fileOf('c6'), opts));
  ok('event write failure inside the create transaction → neither the proof nor any event persists, receipt removed',
    rolled?.code === 'INJECTED' && !db._tables.paymentProof.some((r) => r.clientRef === input(6).clientRef) && storage.files.size === 1);
  db.failNext('paymentProofEvent', 'create');
  const rc = await rejects(S.cancelPaymentProof(created.id, opts));
  ok('event write failure inside cancel → the proof stays SCHEDULED (no change without its audit event)', rc?.code === 'INJECTED' && row.status === 'SCHEDULED');
  db.failNext('paymentProofEvent', 'create');
  await rejects(S.updatePaymentProofSchedule(created.id, { date: '2026-11-08', time: '10:00', privacyConfirmed: true, authenticityConfirmed: true }, opts));
  ok('event write failure inside edit → the edit is rolled back', row.scheduledAt.getTime() === new Date('2026-11-05T09:00:00Z').getTime());
  await S.cancelPaymentProof(created.id, { ...opts, now: at(H), actorId: 'admin-3' });
  const evRes = await w.admin.events(req(`/api/admin/payment-proofs/${created.id}/events`, { cookie: `auth_token=${adminToken}` }), ctx({ id: created.id }));
  const evs = (await bodyOf(evRes)).events;
  ok('events endpoint: oldest first, the right actions and actors (CREATE + 2 confirmations by the admin, CANCEL by admin-3 last)',
    evRes.status === 200 && evs.length === 4 && evs.every((x, i) => i === 0 || evs[i - 1].at <= x.at)
    && JSON.stringify(evs.slice(0, 3).map((x) => x.action).sort()) === JSON.stringify(['CONFIRM_AUTHENTICITY', 'CONFIRM_PRIVACY', 'CREATE'])
    && evs.slice(0, 3).every((x) => x.actor === ADMIN) && evs[3].action === 'CANCEL' && evs[3].actor === 'admin-3');
  // the audit history must keep the insertion order of events written at the same instant (one transaction)
  const order = [];
  for (let i = 0; i < 5; i++) {
    const p = (await S.createPaymentProof(input(70 + i), fileOf(`ord${i}`), { db, storage, now: T0, actorId: ADMIN })).proof;
    order.push((await S.listPaymentProofEvents(p.id, { db })).events.map((x) => x.action).join(','));
  }
  ok('audit history keeps insertion order for same-instant events (CREATE, CONFIRM_PRIVACY, CONFIRM_AUTHENTICITY) — 5 proofs',
    order.every((o) => o === 'CREATE,CONFIRM_PRIVACY,CONFIRM_AUTHENTICITY'), order.join(' | '));
  ok('the audit table is append-only (update/delete refused)', (await rejects(db.paymentProofEvent.update({}))) !== null && (await rejects(db.paymentProofEvent.deleteMany({}))) !== null);
  ok('proofs are never deleted', (await rejects(db.paymentProof.delete({ where: { id: created.id } }))) !== null && db._tables.paymentProof.some((r) => r.id === created.id));
}

// ── 6. Publisher worker ─────────────────────────────────────────────────────
console.log('\n6. Publisher worker: lock, atomic publication, retries, concurrency');
{
  const mkSet = async (n, { scheduledAt = '10:00' } = {}) => {
    const db = makePaymentProofFakeDb(), storage = makeProofMemStorage();
    for (let i = 0; i < n; i++) await S.createPaymentProof(input(i, { time: scheduledAt }), fileOf(`w${n}-${i}`), { db, storage, now: T0, actorId: ADMIN });
    return { db, storage };
  };
  const due = at(DAY + 2 * H); // 2026-11-05 11:00Z, every 10:00 Casablanca (09:00Z) proof is due
  const publishEvents = (db) => db._tables.paymentProofEvent.filter((x) => x.action === 'PUBLISH');
  {
    const { db, storage } = await mkSet(3);
    const r0 = await W.runPaymentProofPublishTick({ db, storage, now: () => due });
    const r1 = await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock({ held: false }, { failAcquire: true }), now: () => due });
    // a throwing acquire() is treated as "not acquired" (fail closed): the tick resolves without doing anything
    const r2 = await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock({ held: false }, { throwAcquire: true }), now: () => due });
    ok('no lock / lock not acquired / lock error → nothing published', !r0.ticked && !r1.ticked && r2.ticked === false && r2.skipped === 'lock_not_acquired'
      && [r0, r1, r2].every((r) => r.published === 0 && r.failed === 0) && db._tables.paymentProof.every((r) => r.status === 'SCHEDULED') && publishEvents(db).length === 0);
    const early = await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => at(DAY - H) });
    ok('before scheduledAt nothing is published', early.ticked && early.published === 0 && db._tables.paymentProof.every((r) => r.status === 'SCHEDULED'));
    const lock = makeFakeLock();
    const t1 = await W.runPaymentProofPublishTick({ db, storage, lock, now: () => due });
    const t2 = await W.runPaymentProofPublishTick({ db, storage, lock, now: () => at(DAY + 3 * H) });
    ok('tick → 3 published; second tick → 0 (idempotent)', t1.published === 3 && t2.published === 0 && t2.due === 0);
    ok('publishedAt = the actual tick time, set once and never changed by later ticks',
      db._tables.paymentProof.every((r) => r.status === 'PUBLISHED' && r.publishedAt.getTime() === due.getTime() && r.publishAttempts === 1));
    ok('exactly one PUBLISH event per proof, actor = the worker', publishEvents(db).length === 3 && publishEvents(db).every((x) => x.actor === W.PUBLISHER_ACTOR));
    ok('the lock is released after every tick', lock.releases === lock.acquires && !lock.shared.held);
    // restart: new handler/worker instances on the same db
    const t3 = await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => at(DAY + 4 * H) });
    ok('restart (new worker instance) publishes nothing twice', t3.published === 0 && publishEvents(db).length === 3);
  }
  {
    const { db, storage } = await mkSet(20);
    const shared = { held: false };
    const [a, b] = await Promise.all([
      W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(shared), now: () => due }),
      W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(shared), now: () => due }),
    ]);
    ok('two workers with the shared advisory lock: only one works', [a.ticked, b.ticked].filter(Boolean).length === 1 && (a.published || b.published) === 20 && !shared.held);
    ok('…each proof published exactly once', publishEvents(db).length === 20 && db._tables.paymentProof.every((r) => r.status === 'PUBLISHED' && r.publishAttempts === 1));
  }
  {
    const { db, storage } = await mkSet(20);
    const [a, b] = await Promise.all([
      W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => due }),
      W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => due }),
    ]);
    ok('two workers WITHOUT a common lock (row-level guarantee alone): both tick, 20 published in total, the rest raced',
      a.ticked && b.ticked && a.published + b.published === 20 && a.raced + b.raced === 20);
    ok('…still exactly one PUBLISH event and one attempt per proof', publishEvents(db).length === 20 && new Set(publishEvents(db).map((x) => x.proofId)).size === 20
      && db._tables.paymentProof.every((r) => r.publishAttempts === 1));
  }
  {
    const { db, storage } = await mkSet(7);
    const lock = makeFakeLock();
    const p1 = await W.runPaymentProofPublishTick({ db, storage, lock, now: () => due, limit: 3 });
    ok('interrupted / bounded pass: 3 published, "more" reported', p1.published === 3 && p1.more === true);
    const p2 = await W.runPaymentProofPublishTick({ db, storage, lock, now: () => at(DAY + 2 * H + 60_000) });
    ok('next tick publishes the remaining 4, none twice', p2.published === 4 && publishEvents(db).length === 7 && db._tables.paymentProof.every((r) => r.publishAttempts === 1));
  }
  {
    const { db, storage } = await mkSet(4);
    db.failNext('paymentProof', 'updateMany');
    const r = await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => due });
    const stuck = db._tables.paymentProof.filter((x) => x.status === 'SCHEDULED');
    ok('a throwing proof does not stop the others; it stays SCHEDULED (rolled back, no event)', r.errors === 1 && r.published === 3 && stuck.length === 1 && publishEvents(db).length === 3);
    const r2 = await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => at(DAY + 2 * H + 60_000) });
    ok('…and is published by the next tick', r2.published === 1 && stuck[0].status === 'PUBLISHED');
  }
  {
    const { db, storage } = await mkSet(3);
    const lost = db._tables.paymentProof[1];
    storage.lose(lost.fileKey);
    const r = await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => due });
    const failEv = db._tables.paymentProofEvent.find((x) => x.action === 'FAIL');
    ok('missing receipt → FAILED (RECEIPT_MISSING) with a FAIL event; others published', r.failed === 1 && r.published === 2 && lost.status === 'FAILED'
      && failEv?.proofId === lost.id && failEv.details.reason === 'RECEIPT_MISSING' && failEv.actor === W.PUBLISHER_ACTOR);
    const feed = await S.listVisiblePaymentProofs({ db, now: due });
    ok('a FAILED proof is never visible', feed.total === 2 && !feed.proofs.some((p) => p.token === lost.publicToken));
  }
  {
    const { db, storage } = await mkSet(1);
    const lock = makeFakeLock();
    db.failNext('paymentProof', 'findMany');
    const crash = await rejects(W.runPaymentProofPublishTick({ db, storage, lock, now: () => due }));
    ok('the lock is released even when the tick crashes', crash !== null && lock.releases === 1 && !lock.shared.held);
  }
  {
    // admin cancel racing the publisher
    let published = 0, cancelled = 0;
    for (let k = 0; k < 10; k++) {
      const { db, storage } = await mkSet(1);
      const id = db._tables.paymentProof[0].id;
      const [pub, can] = await Promise.all([
        W.publishOnePaymentProof(id, { db, storage, now: due }),
        S.cancelPaymentProof(id, { db, now: due, actorId: ADMIN }).catch((e) => e),
      ]);
      const row = db._tables.paymentProof[0];
      const evs = db._tables.paymentProofEvent.filter((x) => x.action === 'PUBLISH' || x.action === 'CANCEL');
      if (row.status === 'PUBLISHED') published++; else if (row.status === 'CANCELLED') cancelled++;
      if (!(evs.length === 1 && ((row.status === 'PUBLISHED' && pub === 'published' && can?.code === 'NOT_CANCELLABLE') || (row.status === 'CANCELLED' && pub === 'skipped' && can?.proof)))) {
        ok('admin cancel racing the publisher: exactly one wins', false, JSON.stringify({ status: row.status, pub, can: can?.code || 'ok', evs: evs.length }));
      }
    }
    ok(`admin cancel racing the publisher: exactly one wins every time (published ${published}, cancelled ${cancelled} of 10)`, published + cancelled === 10);
  }
  {
    const { db, storage } = await mkSet(1);
    const late = at(4 * DAY);
    await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => late });
    const row = db._tables.paymentProof[0];
    const visibleUntil = await S.listVisiblePaymentProofs({ db, now: new Date(late.getTime() + 71 * H) });
    const gone = await S.listVisiblePaymentProofs({ db, now: new Date(late.getTime() + 72 * H) });
    ok('delayed tick (3 days late) → publishedAt = the actual tick time, 72 h counted from it', row.publishedAt.getTime() === late.getTime() && visibleUntil.total === 1 && gone.total === 0);
  }
  const runner = read('./payment-proofs-publisher.mjs');
  const eco = read('../ecosystem.config.js');
  ok('the PM2 runner uses its own advisory lock key through the shared resilient adapter, with graceful shutdown',
    /createPgAdvisoryLock\(\{\s*key: PAYMENT_PROOF_PUBLISHER_LOCK_KEY/.test(runner) && /SIGTERM/.test(runner) && /--once/.test(runner) && W.PAYMENT_PROOF_PUBLISHER_LOCK_KEY === 0x50505046);
  const otherKeys = [0x55474345, 0x464b4f45, 0x44454d43, 0x42535449, 0x4252534d];
  ok('the lock key differs from every existing engine key', !otherKeys.includes(W.PAYMENT_PROOF_PUBLISHER_LOCK_KEY));
  ok('ecosystem.config.js: one new fork-mode entry, existing engines unchanged',
    /name:\s*'payment-proofs-publisher',\s*\n\s*script:\s*'scripts\/payment-proofs-publisher\.mjs',\s*\n\s*\.\.\.engineDefaults/.test(eco)
    && ['ugc-earnings-engine', 'fake-orders-engine', 'demo-competition-engine', 'brand-simulation-engine'].every((n) => eco.includes(`name:   '${n}'`)));
}

// ── 7. Security ─────────────────────────────────────────────────────────────
console.log('\n7. Security: admin-only changes, active affiliates only, nothing hidden leaks');
{
  const db = makePaymentProofFakeDb({ affiliates: [{ id: 'a1' }] });
  const storage = makeProofMemStorage();
  const w = wire(db, storage);
  const sched = (await S.createPaymentProof(input(1), fileOf('x1'), { db, storage, now: T0, actorId: ADMIN })).proof;
  const schedRow = db._tables.paymentProof.find((r) => r.id === sched.id);
  const visible = seed(db, { publishedAt: at(-2 * H) }); storage.files.set(visible.fileKey, pngBytes('vis'));
  const old = seed(db, { publishedAt: at(-73 * H) }); storage.files.set(old.fileKey, pngBytes('old'));
  const can = seed(db, { status: 'CANCELLED', publishedAt: null, cancelledAt: at(-H) }); storage.files.set(can.fileKey, pngBytes('can'));
  const fai = seed(db, { status: 'FAILED', publishedAt: null, failedAt: at(-H), failureReason: 'X' }); storage.files.set(fai.fileKey, pngBytes('fai'));
  const adminCalls = {
    list: () => w.admin.list(req('/api/admin/payment-proofs'), ctx({})),
    create: (o) => w.admin.create(req('/api/admin/payment-proofs', { method: 'POST', body: multipart(input(7), fileOf('x7')), ...o }), ctx({})),
    validateBatch: (o) => w.admin.validateBatch(req('/api/admin/payment-proofs/validate', { method: 'POST', json: { items: [input(8)] }, ...o }), ctx({})),
    update: (o) => w.admin.update(req(`/api/admin/payment-proofs/${sched.id}`, { method: 'PATCH', json: { date: '2026-11-09', time: '10:00', privacyConfirmed: true, authenticityConfirmed: true }, ...o }), ctx({ id: sched.id })),
    act: (o) => w.admin.act(req(`/api/admin/payment-proofs/${sched.id}`, { method: 'POST', json: { action: 'cancel' }, ...o }), ctx({ id: sched.id })),
    image: (o) => w.admin.image(req(`/api/admin/payment-proofs/${sched.id}/image`, o), ctx({ id: sched.id })),
    events: (o) => w.admin.events(req(`/api/admin/payment-proofs/${sched.id}/events`, o), ctx({ id: sched.id })),
  };
  const statusesFor = async (o) => {
    const out = {};
    for (const [k, fn] of Object.entries(adminCalls)) out[k] = (await (k === 'list' ? w.admin.list(req('/api/admin/payment-proofs', o), ctx({})) : fn(o))).status;
    return out;
  };
  const noTok = await statusesFor({});
  ok('no token → 401 on every admin endpoint', Object.values(noTok).every((s) => s === 401), JSON.stringify(noTok));
  const affBearer = await statusesFor({ bearer: affToken('a1') });
  ok('affiliate token (Bearer) on every admin endpoint → 401', Object.values(affBearer).every((s) => s === 401), JSON.stringify(affBearer));
  const affCookie = await statusesFor({ cookie: `auth_token=${affToken('a1')}` });
  ok('affiliate token placed in the admin cookie → 403 on every admin endpoint', Object.values(affCookie).every((s) => s === 403), JSON.stringify(affCookie));
  const user = await statusesFor({ cookie: `auth_token=${userToken}` });
  ok('non-ADMIN user role → 403 on every admin endpoint', Object.values(user).every((s) => s === 403), JSON.stringify(user));
  ok('the scheduled proof is untouched by all refused calls', schedRow.status === 'SCHEDULED' && db._tables.paymentProof.length === 5);
  const affNo = await w.aff.list(req('/api/affiliate/payment-proofs'), ctx({}));
  const affImgNo = await w.aff.image(req(`/api/affiliate/payment-proofs/${visible.publicToken}/image`), ctx({ token: visible.publicToken }));
  const adminOnAff = await w.aff.list(req('/api/affiliate/payment-proofs', { bearer: adminToken }), ctx({}));
  ok('no token → 401 on both affiliate endpoints; an admin token is not an affiliate token (401)', affNo.status === 401 && affImgNo.status === 401 && adminOnAff.status === 401);
  const routeFiles = ['../src/app/api/affiliate/payment-proofs/route.js', '../src/app/api/affiliate/payment-proofs/[token]/image/route.js'];
  const exported = routeFiles.map((f) => [...read(f).matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]));
  ok('affiliate route files export only GET (no way to create, schedule, edit, cancel or publish)', exported.every((x) => JSON.stringify(x) === '["GET"]'));
  const adminRouteFiles = ['../src/app/api/admin/payment-proofs/route.js', '../src/app/api/admin/payment-proofs/validate/route.js', '../src/app/api/admin/payment-proofs/[id]/route.js',
    '../src/app/api/admin/payment-proofs/[id]/image/route.js', '../src/app/api/admin/payment-proofs/[id]/events/route.js'];
  ok('every admin route method is wrapped by withAdminAuth', adminRouteFiles.every((f) => {
    const src = read(f); const methods = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (\w+)\(/g)];
    return methods.length > 0 && methods.every((m) => m[2] === 'withAdminAuth');
  }));
  const img = async (t) => w.aff.image(req(`/api/affiliate/payment-proofs/${t}/image`, { bearer: affToken('a1') }), ctx({ token: t }));
  const r404 = await Promise.all([schedRow.publicToken, can.publicToken, fai.publicToken, old.publicToken, tok(), 'not-a-token', '../../etc'].map(img));
  ok('affiliate image of SCHEDULED / CANCELLED / FAILED / > 72 h / unknown / malformed token → 404', r404.every((r) => r.status === 404), r404.map((r) => r.status).join(','));
  const vis = await img(visible.publicToken);
  ok('affiliate image of a visible proof → 200 image/jpeg, no-store, private, nosniff',
    vis.status === 200 && vis.headers.get('content-type') === 'image/jpeg' && /no-store/.test(vis.headers.get('cache-control')) && /private/.test(vis.headers.get('cache-control'))
    && vis.headers.get('x-content-type-options') === 'nosniff' && Buffer.from(await vis.arrayBuffer()).equals(pngBytes('vis')));
  const inactiveDb = makePaymentProofFakeDb({ affiliates: [{ id: 'off', isActive: false }] });
  const wi = wire(inactiveDb, storage);
  inactiveDb._tables.paymentProof.push({ ...visible });
  const ii = await wi.aff.image(req(`/api/affiliate/payment-proofs/${visible.publicToken}/image`, { bearer: affToken('off') }), ctx({ token: visible.publicToken }));
  ok('inactive affiliate cannot fetch a receipt either (401 at the auth layer)', ii.status === 401);
  const iiRaw = await wi.rawAff.image(req(`/api/affiliate/payment-proofs/${visible.publicToken}/image`), ctx({ token: visible.publicToken }), { affiliateId: 'off', type: 'affiliate' });
  ok('inactive affiliate, handler alone → 403 for a receipt too', iiRaw.status === 403);
  // invalid uploads
  const filesBefore = storage.files.size, rowsBefore = db._tables.paymentProof.length;
  const up = async (file, i) => w.admin.create(req('/api/admin/payment-proofs', { method: 'POST', cookie: `auth_token=${adminToken}`, body: multipart(input(50 + i), file) }), ctx({}));
  const bads = [
    fileOf('t', 'text/plain', Buffer.from('hello world')), fileOf('p', 'application/pdf', Buffer.from('%PDF-1.4 fake pdf')),
    fileOf('s', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), fileOf('n', 'image/png', Buffer.from('GIF89a not really a png...')),
  ];
  const badRes = [];
  for (const [i, f] of bads.entries()) badRes.push(await up(f, i));
  ok('invalid uploads (text/plain, PDF, SVG, PNG-declared non-image bytes) → 400 INVALID_FILE', badRes.every((r) => r.status === 400));
  const big = Buffer.alloc(9 * 1024 * 1024, 1); pngBytes('x').copy(big);
  const huge = await up(fileOf('big', 'image/png', big), 9);
  ok('> 8 MB body → 413 BODY_TOO_LARGE', huge.status === 413 && (await bodyOf(huge)).code === 'BODY_TOO_LARGE');
  const missing = await w.admin.create(req('/api/admin/payment-proofs', { method: 'POST', cookie: `auth_token=${adminToken}`, body: multipart(input(60)) }), ctx({}));
  ok('missing receipt file → 400', missing.status === 400);
  ok('nothing stored and no row created by any rejected upload', storage.files.size === filesBefore && db._tables.paymentProof.length === rowsBefore);
  // admin views never expose storage keys / fingerprints
  const al = await w.admin.list(req('/api/admin/payment-proofs?status=all', { cookie: `auth_token=${adminToken}` }), ctx({}));
  await bodyOf(al);
  const ai = await w.admin.image(req(`/api/admin/payment-proofs/${sched.id}/image`, { cookie: `auth_token=${adminToken}` }), ctx({ id: sched.id }));
  ok('admin receipt image → 200 image/jpeg no-store', ai.status === 200 && ai.headers.get('content-type') === 'image/jpeg' && /no-store/.test(ai.headers.get('cache-control')));
  const badStatus = await w.admin.list(req('/api/admin/payment-proofs?status=DELETED', { cookie: `auth_token=${adminToken}` }), ctx({}));
  ok('admin list rejects an unknown status filter (400)', badStatus.status === 400);
  // traversal-safe default storage (bad keys only — nothing is written into the repository)
  const badKeys = ['../package.json', '../../.env', '/etc/passwd', 'a.jpg', '..\\x.jpg', '00000000-0000-0000-0000-000000000000.png', ''];
  const ex = await Promise.all(badKeys.map((k) => defaultPaymentProofStorage.exists(k)));
  const rd = await Promise.all(badKeys.map((k) => defaultPaymentProofStorage.read(k)));
  ok('default disk storage refuses traversal / malformed keys (exists false, read null)', ex.every((x) => x === false) && rd.every((x) => x === null));
}

// ── 8. Isolation from every financial / affiliate table ─────────────────────
console.log('\n8. Isolation: only payment_proofs / payment_proof_events (+ the isActive check)');
{
  // one combined run touching every code path, then the call log
  const db = makePaymentProofFakeDb({ affiliates: [{ id: 'a1' }] });
  const storage = makeProofMemStorage();
  const w = wire(db, storage);
  const c = (await bodyOf(await w.admin.create(req('/api/admin/payment-proofs', { method: 'POST', cookie: `auth_token=${adminToken}`, body: multipart(input(1), fileOf('z1')) }), ctx({})))).proof;
  await w.admin.validateBatch(req('/api/admin/payment-proofs/validate', { method: 'POST', cookie: `auth_token=${adminToken}`, json: { items: [input(2)] } }), ctx({}));
  await w.admin.update(req(`/api/admin/payment-proofs/${c.id}`, { method: 'PATCH', cookie: `auth_token=${adminToken}`, json: { date: '2026-11-05', time: '11:00', privacyConfirmed: true, authenticityConfirmed: true } }), ctx({ id: c.id }));
  await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => at(DAY + 3 * H) });
  await w.admin.list(req('/api/admin/payment-proofs', { cookie: `auth_token=${adminToken}` }), ctx({}));
  await w.admin.events(req(`/api/admin/payment-proofs/${c.id}/events`, { cookie: `auth_token=${adminToken}` }), ctx({ id: c.id }));
  const w2 = wire(db, storage, { clock: () => at(DAY + 4 * H) });
  const feed = await bodyOf(await w2.aff.list(req('/api/affiliate/payment-proofs', { bearer: affToken('a1') }), ctx({})));
  await w2.aff.image(req(`/api/affiliate/payment-proofs/${feed.proofs[0].token}/image`, { bearer: affToken('a1') }), ctx({ token: feed.proofs[0].token }));
  const models = new Set(db._log.map((l) => l.model));
  ok('the whole flow touches only paymentProof, paymentProofEvent, affiliate and transactions',
    [...models].every((m) => ['paymentProof', 'paymentProofEvent', 'affiliate', '$transaction'].includes(m)), [...models].join(','));
  const affOps = db._log.filter((l) => l.model === 'affiliate');
  // Phase 6 part 2: the auth layer reads exactly isActive + tokenVersion; the handlers still read
  // only isActive. Both are findUnique by id; nothing else is ever selected or written.
  const affSelects = affOps.map((l) => JSON.stringify(l.select));
  ok('affiliate is only READ, by id: the handlers select only isActive, the auth layer only isActive + tokenVersion (never written, no other field)',
    affOps.length >= 4 && affOps.every((l) => l.op === 'findUnique')
    && affSelects.every((x) => x === '["isActive"]' || x === '["isActive","tokenVersion"]')
    && affSelects.includes('["isActive"]') && affSelects.includes('["isActive","tokenVersion"]'), affSelects.join(' '));
  ok('the published proof reached the global feed', feed.total === 1 && feed.proofs[0].name === 'Client 1');
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
  const code = ['../src/lib/services/paymentProofService.js', '../src/lib/services/paymentProofPublisher.js', '../src/lib/paymentProofRouteHandlers.js', '../src/lib/paymentProofs.js', './payment-proofs-publisher.mjs']
    .map((f) => [f, strip(read(f))]);
  const forbidden = /payout|commission|balance|wallet|reward|deposit|withdraw|\border\b|orders|affiliateOrder|ledger/i;
  ok('feature code references no payout / commission / balance / wallet / reward / deposit / order model', code.every(([, s]) => !forbidden.test(s)), code.filter(([, s]) => forbidden.test(s)).map(([f, s]) => `${f}: ${s.match(forbidden)[0]}`).join('; '));
  const modelRefs = new Set(code.flatMap(([, s]) => [...s.matchAll(/\b(?:db|tx|prisma)\.([$\w]+)(?=\s*[.(])/g)].map((m) => m[1])));
  ok('database models used by the feature: paymentProof, paymentProofEvent, affiliate (isActive check), $transaction only',
    [...modelRefs].every((m) => ['paymentProof', 'paymentProofEvent', 'affiliate', '$transaction', '$disconnect'].includes(m)), [...modelRefs].join(','));
  const schema = read('../prisma/schema.prisma');
  const model = schema.slice(schema.indexOf('model PaymentProof {'), schema.indexOf('model PaymentProofEvent {'));
  ok('Prisma model PaymentProof has no affiliate / user / payout field or relation', !/affiliate|userId|payout|Affiliate\b|User\b/.test(model) && /@@map\("payment_proofs"\)/.test(model));
  const mig = read('../prisma/migrations/20261104_payment_proofs/migration.sql');
  const fks = [...mig.matchAll(/REFERENCES\s+"(\w+)"/g)].map((m) => m[1]);
  ok('migration: the only foreign key is payment_proof_events → payment_proofs', JSON.stringify(fks) === '["payment_proofs"]');
  ok('migration creates only the two feature tables and alters no other table',
    JSON.stringify([...mig.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1])) === '["payment_proofs","payment_proof_events"]'
    && [...mig.matchAll(/ALTER TABLE "(\w+)"/g)].every((m) => ['payment_proofs', 'payment_proof_events'].includes(m[1])));
}

// ── 9. Nothing internal leaked by any response seen in this run ──────────────
console.log('\n9. No storage key or fingerprint in any API response');
{
  // collected from every JSON body read through bodyOf() above
  const all = ALL_RESPONSE_TEXT.join('\n');
  ok(`no fileKey / fingerprint field in any of ${ALL_RESPONSE_TEXT.length} JSON responses`, ALL_RESPONSE_TEXT.length > 20 && !/"fileKey"|"fingerprint"/.test(all) && !/[a-f0-9-]{36}\.jpg/.test(all));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
