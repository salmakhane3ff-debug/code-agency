#!/usr/bin/env node
/**
 * scripts/paymentProofPublishNow.test.mjs — "Publier maintenant" for payment proofs.
 *
 * The admin chooses, per batch, "Programmer la publication" (unchanged) or "Publier maintenant";
 * a SCHEDULED proof can also be published before its time. Both go through the ONE publication
 * pipeline (paymentProofPublisher.publishOnePaymentProof); publishedAt is always the server time of
 * the successful publication, and the 72-hour window starts there.
 *
 *   1. Immediate publication at creation: published + visible at once (publishedAt = server time then)
 *   2. A proof scheduled for later published now by the admin
 *   3. 72 h visibility from the ACTUAL publishedAt (not the planned time)
 *   4. The worker never publishes an already published proof again
 *   5. Concurrency: admin vs worker, admin vs admin, admin vs cancel → exactly one outcome
 *   6. A failed immediate publication is FAILED (never shown as "Publiée")
 *   7. Scheduled publication unchanged (worker, retry, late tick)
 *   8. Routes, admin labels (FR), affiliate slider labels (AR / FR), Casablanca date / time display
 *
 * Run: node scripts/paymentProofPublishNow.test.mjs
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'payment-proofs-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { makePaymentProofFakeDb, makeProofMemStorage, makeFakeLock, pngBytes } from './lib/paymentProofFakeDb.mjs';

const P = await import('../src/lib/paymentProofs.js');
const S = await import('../src/lib/services/paymentProofService.js');
const W = await import('../src/lib/services/paymentProofPublisher.js');
const T = await import('../src/lib/casablancaTime.js');
const { adminPaymentProofHandlers } = await import('../src/lib/paymentProofRouteHandlers.js');
const { withAdminAuth } = await import('../src/lib/middleware/withAdminAuth.js');
const { signToken } = await import('../src/lib/services/authService.js');
const { AFFILIATE_TABS_TEXT } = await import('../src/lib/affiliateTabsI18n.js').catch(() => ({}));

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const H = P.HOUR_MS, MIN = 60_000, DAY = 24 * H;
const T0 = new Date('2026-11-11T02:22:00.000Z'); // 02:22 in Casablanca (UTC+0 since 2026-09-20)
const at = (d) => new Date(T0.getTime() + d);
const ADMIN = 'admin-1';
const input = (i, over = {}) => ({
  displayName: `Client ${i}`, amount: '1500', clientRef: `ref-now-${i}-abcdef`, privacyConfirmed: true, authenticityConfirmed: true, ...over,
});
const fileOf = (tag) => { const b = pngBytes(tag); return { buffer: b, mime: 'image/png', size: b.length }; };
const visibleNames = async (db, now) => (await S.listVisiblePaymentProofs({ db, now })).proofs.map((x) => x.name);
const events = (db, id, action) => db._tables.paymentProofEvent.filter((e) => e.proofId === id && (!action || e.action === action));
const fresh = () => ({ db: makePaymentProofFakeDb({ affiliates: [{ id: 'a1' }] }), storage: makeProofMemStorage() });
/** A proof scheduled for tomorrow 10:00 Casablanca (2026-11-12T10:00Z). */
const scheduled = async (db, storage, i = 0, time = '10:00') =>
  (await S.createPaymentProof(input(i, { date: '2026-11-12', time }), fileOf(`s${i}-${time}`), { db, storage, now: T0, actorId: ADMIN })).proof;

// ── 1. Immediate publication at creation ─────────────────────────────────────
console.log('\n1. "Publier maintenant" at creation');
{
  const { db, storage } = fresh();
  const pubAt = at(3_000); // the server time when publication actually happens (after the upload / creation)
  const out = await S.createPaymentProof(input(1, { publishMode: 'now' }), fileOf('n1'), { db, storage, now: T0, clock: () => pubAt, actorId: ADMIN });
  const row = db._tables.paymentProof[0];
  ok('no date / time needed; created and published at once', out.existing === false && out.publication?.status === 'PUBLISHED' && out.proof.status === 'PUBLISHED' && row.status === 'PUBLISHED');
  ok('publishedAt = the server time of the publication (not the request / form time)', +row.publishedAt === +pubAt && out.publication.publishedAt === pubAt.toISOString() && +row.scheduledAt === +T0);
  ok('visible in the affiliate slider immediately (same feed for every affiliate)', (await visibleNames(db, at(3_001))).includes('Client 1'));
  const ev = events(db, row.id).map((e) => e.action);
  ok('audit: CREATE (publishMode NOW) + both declarations + PUBLISH (immediate, by the admin)',
    JSON.stringify(ev) === JSON.stringify(['CREATE', 'CONFIRM_PRIVACY', 'CONFIRM_AUTHENTICITY', 'PUBLISH'])
    && events(db, row.id, 'CREATE')[0].details.publishMode === 'NOW'
    && events(db, row.id, 'PUBLISH')[0].actor === ADMIN && events(db, row.id, 'PUBLISH')[0].details.mode === 'IMMEDIATE');
  const retry = await S.createPaymentProof(input(1, { publishMode: 'now' }), fileOf('n1'), { db, storage, now: at(5 * MIN), clock: () => at(5 * MIN), actorId: ADMIN });
  ok('a retry (same clientRef) publishes nothing twice: existing, same publishedAt, one PUBLISH event',
    retry.existing === true && retry.publication.status === 'PUBLISHED' && +db._tables.paymentProof[0].publishedAt === +pubAt
    && events(db, row.id, 'PUBLISH').length === 1 && db._tables.paymentProof.length === 1);
  const bad = await rejects(S.createPaymentProof(input(2, { publishMode: 'later' }), fileOf('n2'), { db, storage, now: T0, actorId: ADMIN }));
  ok('an unknown publication mode is refused (INVALID_PUBLISH_MODE)', bad?.code === 'INVALID_INPUT' && bad.errors.publishMode === 'INVALID_PUBLISH_MODE');
  const noTime = P.validateProofInput(input(3, { publishMode: 'now', date: '', time: '' }), { nowMs: +T0 });
  ok('"now" ignores date / time entirely; "schedule" keeps requiring them', !noTime.errors.scheduledAt && +noTime.value.scheduledAt === +T0
    && P.validateProofInput(input(3, { date: '', time: '' }), { nowMs: +T0 }).errors.scheduledAt === 'INVALID_DATETIME');
  const review = await S.validatePaymentProofBatch([input(4, { publishMode: 'now' }), input(5, { date: '2026-11-12', time: '09:00' })], { db, now: T0 });
  ok('batch review: the "now" item needs no time and is flagged publishNow; the scheduled one is unchanged', review.ok
    && review.items[0].publishNow === true && review.items[1].publishNow === false && review.items[1].scheduledAt === '2026-11-12T09:00:00.000Z'
    && db._tables.paymentProof.length === 1);
}

// ── 2–4. Early publication of a scheduled proof; 72 h from the actual time; no second publication ─
console.log('\n2. A scheduled proof published now; 3. 72 h from the actual publication; 4. the worker does not publish it again');
{
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 0);
  ok('the proof is SCHEDULED for tomorrow 10:00 (Casablanca) and not visible yet', p.status === 'SCHEDULED' && p.scheduledAt === '2026-11-12T10:00:00.000Z' && (await visibleNames(db, at(MIN))).length === 0);
  const pubAt = at(10 * MIN);
  const out = await S.publishPaymentProofNow(p.id, { db, storage, clock: () => pubAt, actorId: ADMIN });
  const row = db._tables.paymentProof[0];
  ok('"Publier maintenant": PUBLISHED at the server time, before the planned time', out.proof.status === 'PUBLISHED' && +row.publishedAt === +pubAt && +row.scheduledAt === Date.parse('2026-11-12T10:00:00Z'));
  ok('…visible immediately', (await visibleNames(db, at(10 * MIN + 1))).includes('Client 0'));
  ok('…the admin view gives the actual publication time; Casablanca display "11/11/2026 02:32"',
    out.publication.publishedAt === pubAt.toISOString() && T.formatCasablanca(+row.publishedAt) === '11/11/2026 02:32');
  // 3. The 72 h start at the ACTUAL publication (02:32Z), never at the planned 2026-11-12T10:00Z.
  ok('72 h window: visible until just before publishedAt + 72 h', (await visibleNames(db, new Date(+pubAt + 72 * H - 1))).includes('Client 0'));
  ok('…and gone at exactly publishedAt + 72 h, although the planned time + 72 h is a day later',
    !(await visibleNames(db, new Date(+pubAt + 72 * H))).includes('Client 0') && Date.parse('2026-11-12T10:00:00Z') + 72 * H > +pubAt + 72 * H);
  ok('…and stays in the admin history after the 72 h (status PUBLISHED, record kept)',
    (await S.listPaymentProofsAdmin({ db, status: 'PUBLISHED' })).items.some((x) => x.id === p.id));
  // 4. The scheduled time comes: the worker must not publish it again.
  const lock = makeFakeLock();
  const tick = await W.runPaymentProofPublishTick({ db, storage, lock, now: () => new Date('2026-11-12T10:01:00Z') });
  ok('the worker at the planned time finds nothing to publish (no second publication, publishedAt unchanged)',
    tick.ticked && tick.published === 0 && tick.due === 0 && +db._tables.paymentProof[0].publishedAt === +pubAt && events(db, p.id, 'PUBLISH').length === 1);
  ok('publishOnePaymentProof on it (worker or immediate) is skipped and writes nothing',
    (await W.publishOnePaymentProof(p.id, { db, storage, now: new Date('2026-11-12T10:01:00Z') })) === 'skipped'
    && (await W.publishOnePaymentProof(p.id, { db, storage, now: at(20 * MIN), immediate: true, actor: ADMIN })) === 'skipped'
    && events(db, p.id, 'PUBLISH').length === 1);
  const again = await S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(30 * MIN), actorId: ADMIN });
  ok('a second "Publier maintenant" (double click) publishes nothing: alreadyPublished, same publishedAt',
    again.alreadyPublished === true && again.publication.publishedAt === pubAt.toISOString() && events(db, p.id, 'PUBLISH').length === 1);
  ok('a published proof can no longer be edited or cancelled (unchanged rules)',
    (await rejects(S.updatePaymentProofSchedule(p.id, input(0, { date: '2026-11-13', time: '10:00' }), { db, storage, now: at(H), actorId: ADMIN })))?.code === 'NOT_EDITABLE'
    && (await rejects(S.cancelPaymentProof(p.id, { db, now: at(H), actorId: ADMIN })))?.code === 'NOT_CANCELLABLE');
  const c = await scheduled(db, storage, 7, '11:00');
  await S.cancelPaymentProof(c.id, { db, now: at(MIN), actorId: ADMIN });
  ok('a cancelled proof cannot be published now (NOT_PUBLISHABLE) and stays CANCELLED',
    (await rejects(S.publishPaymentProofNow(c.id, { db, storage, clock: () => at(2 * MIN), actorId: ADMIN })))?.code === 'NOT_PUBLISHABLE'
    && db._tables.paymentProof.find((r) => r.id === c.id).status === 'CANCELLED');
  ok('unknown id → NOT_FOUND; no admin → UNAUTHORIZED', (await rejects(S.publishPaymentProofNow('nope', { db, storage, actorId: ADMIN })))?.code === 'NOT_FOUND'
    && (await rejects(S.publishPaymentProofNow(c.id, { db, storage })))?.code === 'UNAUTHORIZED');
}

// ── 5. Concurrency ───────────────────────────────────────────────────────────
console.log('\n5. Concurrent requests never duplicate a publication');
// Each race staggers one side by 0–6 event-loop turns (alternating sides) so BOTH orders really happen;
// every race below requires both outcomes at least once — otherwise it would test only one ordering.
const yieldN = (n) => new Promise((r) => { let i = 0; const f = () => (i++ >= n ? r() : setImmediate(f)); f(); });
const late = (k, fn) => yieldN(k % 7).then(fn); // start `fn` after k % 7 turns
{
  let adminWins = 0, workerWins = 0, bad = 0;
  for (let k = 0; k < 20; k++) {
    const { db, storage } = fresh();
    const p = await scheduled(db, storage, k, '02:30'); // due at 2026-11-12T02:30Z
    const due = new Date('2026-11-12T02:31:00Z');
    const adminAt = new Date(+due + 1_000);
    const worker = () => W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => due });
    const adminCall = () => S.publishPaymentProofNow(p.id, { db, storage, clock: () => adminAt, actorId: ADMIN }).catch((e) => e);
    const [tick, admin] = k % 2 ? await Promise.all([late(k, worker), adminCall()]) : await Promise.all([worker(), late(k, adminCall)]);
    const row = db._tables.paymentProof[0];
    const pubs = events(db, p.id, 'PUBLISH');
    const fine = row.status === 'PUBLISHED' && pubs.length === 1 && admin?.publication?.status === 'PUBLISHED'
      && ((tick.published === 1 && admin.alreadyPublished === true && +row.publishedAt === +due && pubs[0].actor === W.PUBLISHER_ACTOR)
        || (tick.published === 0 && !admin.alreadyPublished && +row.publishedAt === +adminAt && pubs[0].actor === ADMIN));
    if (!fine) bad++; else if (pubs[0].actor === ADMIN) adminWins++; else workerWins++;
  }
  ok(`admin "Publier maintenant" racing the worker: exactly one publication every time, both orders seen (admin ${adminWins}, worker ${workerWins} of 20)`,
    bad === 0 && adminWins + workerWins === 20 && adminWins > 0 && workerWins > 0, String(bad));
  let dupBad = 0;
  for (let k = 0; k < 20; k++) {
    const { db, storage } = fresh();
    const p = await scheduled(db, storage, k);
    const r = await Promise.all([1, 2, 3].map((n) => late(k + n, () => S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(n * 1_000), actorId: `admin-${n}` }))));
    const pubs = events(db, p.id, 'PUBLISH');
    if (!(pubs.length === 1 && r.filter((x) => !x.alreadyPublished).length === 1 && r.every((x) => x.publication.publishedAt === new Date(db._tables.paymentProof[0].publishedAt).toISOString()))) dupBad++;
  }
  ok('three simultaneous admin requests: one publication, the others see it as already published (20 runs)', dupBad === 0, String(dupBad));
  let cancelBad = 0, pubWin = 0, canWin = 0;
  for (let k = 0; k < 20; k++) {
    const { db, storage } = fresh();
    const p = await scheduled(db, storage, k);
    const pubCall = () => S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(MIN), actorId: ADMIN }).catch((e) => e);
    const canCall = () => S.cancelPaymentProof(p.id, { db, now: at(MIN), actorId: 'admin-2' }).catch((e) => e);
    const [pub, can] = k % 2 ? await Promise.all([late(k, pubCall), canCall()]) : await Promise.all([pubCall(), late(k, canCall)]);
    const row = db._tables.paymentProof[0];
    const decisive = events(db, p.id).filter((e) => e.action === 'PUBLISH' || e.action === 'CANCEL');
    const okRun = decisive.length === 1 && ((row.status === 'PUBLISHED' && pub?.publication && can?.code === 'NOT_CANCELLABLE')
      || (row.status === 'CANCELLED' && pub?.code === 'NOT_PUBLISHABLE' && can?.proof));
    if (!okRun) cancelBad++; else if (row.status === 'PUBLISHED') pubWin++; else canWin++;
  }
  ok(`"Publier maintenant" racing a cancel: exactly one wins, both orders seen (published ${pubWin}, cancelled ${canWin} of 20)`, cancelBad === 0 && pubWin > 0 && canWin > 0, String(cancelBad));
  // An edit racing the immediate publication: either the edit applies (still SCHEDULED) then the publish, or the publish wins and the edit is refused.
  let editBad = 0, editFirst = 0, pubFirst = 0;
  for (let k = 0; k < 20; k++) {
    const { db, storage } = fresh();
    const p = await scheduled(db, storage, k);
    const pubCall = () => S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(MIN), actorId: ADMIN }).catch((e) => e);
    const edCall = () => S.updatePaymentProofSchedule(p.id, input(k, { date: '2026-11-13', time: '09:00' }), { db, storage, now: at(MIN), actorId: 'admin-2' }).catch((e) => e);
    const [pub, ed] = k % 2 ? await Promise.all([late(k, pubCall), edCall()]) : await Promise.all([pubCall(), late(k, edCall)]);
    const row = db._tables.paymentProof[0];
    // Two valid orders: (a) the publish wins → the edit is refused and nothing of it is stored; (b) the edit is
    // applied first → its EDIT event precedes the single PUBLISH, and the EDITED proof is what got published. (The
    // fake DB has no row locks between transactions, so in (b) the edit's own read-back may already see PUBLISHED;
    // in PostgreSQL the publication's UPDATE waits for the edit transaction to commit.)
    const acts = events(db, p.id).map((e) => e.action);
    const single = row.status === 'PUBLISHED' && acts.filter((x) => x === 'PUBLISH').length === 1 && pub?.publication;
    const refused = ed?.code === 'NOT_EDITABLE' && !acts.includes('EDIT') && +row.scheduledAt === Date.parse('2026-11-12T10:00:00Z');
    const editedThenPublished = !ed?.code && acts.indexOf('EDIT') !== -1 && acts.indexOf('EDIT') < acts.indexOf('PUBLISH') && +row.scheduledAt === Date.parse('2026-11-13T09:00:00Z');
    if (!(single && (refused || editedThenPublished))) editBad++;
    else if (refused) pubFirst++; else editFirst++;
  }
  ok(`"Publier maintenant" racing an edit: published exactly once; the edit applied before it or was refused, both orders seen (edit first ${editFirst}, publish first ${pubFirst} of 20)`,
    editBad === 0 && editFirst > 0 && pubFirst > 0, String(editBad));
}

// ── 6. Failed immediate publication ──────────────────────────────────────────
console.log('\n6. A failed immediate publication is never shown as published');
{
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 0);
  storage.lose(db._tables.paymentProof[0].fileKey);
  const e = await rejects(S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(MIN), actorId: ADMIN }));
  const row = db._tables.paymentProof[0];
  ok('receipt missing → PUBLISH_FAILED with the reason; the proof is FAILED (not PUBLISHED, no publishedAt)',
    e?.code === 'PUBLISH_FAILED' && e.reason === 'RECEIPT_MISSING' && row.status === 'FAILED' && row.publishedAt == null && e.proof?.status === 'FAILED');
  ok('…never visible; FAIL event (immediate, by the admin); no PUBLISH event',
    (await visibleNames(db, at(2 * MIN))).length === 0 && events(db, p.id, 'FAIL')[0]?.details?.mode === 'IMMEDIATE' && events(db, p.id, 'FAIL')[0].actor === ADMIN && events(db, p.id, 'PUBLISH').length === 0);
  ok('…cannot be "published now" again (NOT_PUBLISHABLE); the existing edit → SCHEDULED path stays the way back',
    (await rejects(S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(3 * MIN), actorId: ADMIN })))?.code === 'NOT_PUBLISHABLE');
  // At creation: a storage whose receipt check fails right after the upload.
  const { db: db2, storage: st2 } = fresh();
  const flaky = { ...st2, exists: async () => false };
  const out = await S.createPaymentProof(input(9, { publishMode: 'now' }), fileOf('f9'), { db: db2, storage: flaky, now: T0, clock: () => at(1_000), actorId: ADMIN });
  ok('"Publier maintenant" at creation that fails: the response says FAILED (with reason), the proof is FAILED and invisible',
    out.publication.status === 'FAILED' && out.publication.reason === 'RECEIPT_MISSING' && out.proof.status === 'FAILED' && db2._tables.paymentProof[0].publishedAt == null
    && (await visibleNames(db2, at(2_000))).length === 0);
  const h = adminPaymentProofHandlers({ db, storage, now: () => at(4 * MIN) });
  const res = await h.act(new Request('http://x/api/admin/payment-proofs/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'publish_now' }) }), { params: Promise.resolve({ id: p.id }) }, { userId: ADMIN });
  const body = await res.json();
  ok('route: a FAILED proof → 409 NOT_PUBLISHABLE with its status (no false success)', res.status === 409 && body.code === 'NOT_PUBLISHABLE' && body.status === 'FAILED');
}

// ── 7. Scheduled publication unchanged ───────────────────────────────────────
console.log('\n7. Scheduled publication works exactly as before');
{
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 0); // 2026-11-12T10:00Z
  const lock = makeFakeLock();
  const early = await W.runPaymentProofPublishTick({ db, storage, lock, now: () => new Date('2026-11-12T09:59:00Z') });
  ok('the worker never publishes before the scheduled time', early.published === 0 && db._tables.paymentProof[0].status === 'SCHEDULED');
  const late = new Date('2026-11-12T12:15:00Z'); // the worker was down: a late tick
  const t = await W.runPaymentProofPublishTick({ db, storage, lock, now: () => late });
  const row = db._tables.paymentProof[0];
  const ev = events(db, p.id, 'PUBLISH')[0];
  ok('at / after its time the worker publishes it; publishedAt = the actual (late) tick, actor = the worker, details unchanged',
    // 20261114: the PUBLISH event also records the display duration captured at that publication (72 h default).
    t.published === 1 && +row.publishedAt === +late && ev.actor === W.PUBLISHER_ACTOR
    && JSON.stringify(ev.details) === JSON.stringify({ publishedAt: late.toISOString(), visibleHours: 72, visibleUntil: new Date(+late + 72 * H).toISOString() }));
  ok('72 h from the actual (late) publication, not from the planned time', (await visibleNames(db, new Date(+late + 72 * H - 1))).length === 1
    && (await visibleNames(db, new Date(+late + 72 * H))).length === 0);
  const { db: d2, storage: s2 } = fresh();
  const p2 = await scheduled(d2, s2, 1);
  s2.lose(d2._tables.paymentProof[0].fileKey);
  await W.runPaymentProofPublishTick({ db: d2, storage: s2, lock: makeFakeLock(), now: () => new Date('2026-11-12T10:01:00Z') });
  ok('worker failure path unchanged: FAILED with reason, FAIL event by the worker (no immediate mode)',
    d2._tables.paymentProof[0].status === 'FAILED' && events(d2, p2.id, 'FAIL')[0].actor === W.PUBLISHER_ACTOR && !('mode' in events(d2, p2.id, 'FAIL')[0].details));
}

// ── 8. Routes, labels, Casablanca display ────────────────────────────────────
console.log('\n8. Routes, admin labels, affiliate slider labels, Casablanca display');
{
  const { db, storage } = fresh();
  let clockMs = +T0;
  const h = adminPaymentProofHandlers({ db, storage, now: () => new Date(clockMs) });
  const adminCookie = `auth_token=${signToken({ userId: ADMIN, email: 'admin@example.test', role: 'ADMIN' })}`;
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...input(1), publishMode: 'now', privacyConfirmed: 'true', authenticityConfirmed: 'true' })) fd.append(k, String(v));
  fd.append('receipt', new File([pngBytes('route1')], 'r.png', { type: 'image/png' }));
  const created = await withAdminAuth(h.create)(new Request('http://x/api/admin/payment-proofs', { method: 'POST', headers: { cookie: adminCookie }, body: fd }), { params: Promise.resolve({}) });
  const cb = await created.json();
  ok('POST /api/admin/payment-proofs with publishMode=now → 201, publication PUBLISHED (no date / time sent)', created.status === 201 && cb.publication?.status === 'PUBLISHED' && cb.proof.status === 'PUBLISHED');
  const sch = await scheduled(db, storage, 2);
  clockMs = +at(20 * MIN);
  const res = await withAdminAuth(h.act)(new Request(`http://x/api/admin/payment-proofs/${sch.id}`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'publish_now' }) }), { params: Promise.resolve({ id: sch.id }) });
  const rb = await res.json();
  ok('POST /api/admin/payment-proofs/[id] { action: "publish_now" } → 200, publishedAt = the server time of the request', res.status === 200 && rb.publication.publishedAt === at(20 * MIN).toISOString());
  const noAuth = await withAdminAuth(h.act)(new Request(`http://x/api/admin/payment-proofs/${sch.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'publish_now' }) }), { params: Promise.resolve({ id: sch.id }) });
  ok('…admin only (no admin session → 401/403)', noAuth.status === 401 || noAuth.status === 403);
  ok('the [id] route still exposes POST through withAdminAuth (cancel + publish_now)', /export const POST = withAdminAuth\(h\.act\);/.test(read('../src/app/api/admin/payment-proofs/[id]/route.js')));

  const sb = read('../src/app/admin/payment-proofs/ScheduleBuilder.jsx');
  const pl = read('../src/app/admin/payment-proofs/ProofsList.jsx');
  const ui = read('../src/app/admin/payment-proofs/ui.jsx');
  ok('admin: the two modes "Programmer la publication" / "Publier maintenant"; "now" sends publishMode and no date / time',
    /label: "Programmer la publication"/.test(sb) && /label: "Publier maintenant"/.test(sb) && /\.\.\.\(nowMode \? \{ publishMode: "now" \} : \{ date: r\.date, time: r\.time \}\)/.test(sb)
    && /showTime=\{false\}/.test(sb));
  ok('admin: an explicit confirmation before publishing now (batch dialog + per-proof dialog)',
    /title="Publier maintenant \?"/.test(sb) && /onClick=\{submit\} data-publish-now-confirm-button/.test(sb) && /setConfirmNow\(true\)/.test(sb)
    && /function PublishNowDialog/.test(pl) && /action: "publish_now"/.test(pl));
  ok('admin: "Publier maintenant" is offered on SCHEDULED proofs only', /\{p\.status === "SCHEDULED" && \(\s*<button[\s\S]{0,200}?data-publish-now=\{p\.id\}/.test(pl));
  ok('admin: publication time shown in Casablanca time ("Publiée : … (heure du Maroc)", fmtInstant from the shared table)',
    /Publiée : <span data-published-at>\{fmtInstant\(p\.publishedAt\)\}<\/span> \(heure du Maroc\)/.test(pl) && /return Number\.isNaN\(ms\) \? "—" : formatCasablanca\(ms\);/.test(ui));
  ok('admin: failed immediate publication explained (FAILURE_TEXT reason), not shown as a success',
    /d\.code === "PUBLISH_FAILED"/.test(ui) && /state: "pubfailed"/.test(sb) && /pub\?\.status === "PUBLISHED"/.test(sb));
  ok('Casablanca display of UTC instants: before the 2026-09-20 change (UTC+1) and after (UTC+0)',
    T.formatCasablanca(Date.parse('2026-07-01T09:30:00Z')) === '01/07/2026 10:30' && T.formatCasablanca(Date.parse('2026-11-11T02:30:00Z')) === '11/11/2026 02:30');
  const tabs = read('../src/lib/affiliateTabsI18n.js');
  ok('affiliate slider: "published less than an hour ago" labels exist in French and Arabic (from the actual publishedAt)',
    /proofs_ago_lt1: "il y a moins d’une heure"/.test(tabs) && /proofs_ago_lt1: "منذ أقل من ساعة"/.test(tabs)
    && /hoursSince\(current\.publishedAt\)/.test(read('../src/components/affiliate/PaymentProofsSlider.jsx')));
  void AFFILIATE_TABS_TEXT;
}

// ── 9. Isolation ─────────────────────────────────────────────────────────────
console.log('\n9. Display-only: no financial code');
{
  const code = ['../src/lib/services/paymentProofService.js', '../src/lib/services/paymentProofPublisher.js', '../src/lib/paymentProofRouteHandlers.js']
    .map((p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');
  ok('no wallet / balance / commission / payout / reward / order code in the publication path', !/wallet|balance|commission|payout|reward|affiliateOrder|\.order\./i.test(code));
}

// ── 10. Admin list: immediate proofs show only their actual publication time ──
console.log('\n10. Admin list display of immediate publications');
{
  const { db, storage } = fresh();
  const created = (await S.createPaymentProof(input(1, { publishMode: 'now' }), fileOf('d1'), { db, storage, now: T0, clock: () => at(2_000), actorId: ADMIN })).proof;
  const early = await scheduled(db, storage, 2, '10:00');
  await S.publishPaymentProofNow(early.id, { db, storage, clock: () => at(5 * MIN), actorId: ADMIN });
  const byWorker = await scheduled(db, storage, 3, '03:00'); // due 2026-11-12T03:00Z
  await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => new Date('2026-11-12T03:05:00Z') });
  const pending = await scheduled(db, storage, 4, '18:00');
  const failing = await scheduled(db, storage, 5, '19:00');
  storage.lose(db._tables.paymentProof.find((r) => r.id === failing.id).fileKey);
  await rejects(S.publishPaymentProofNow(failing.id, { db, storage, clock: () => at(6 * MIN), actorId: ADMIN }));
  const list = await S.listPaymentProofsAdmin({ db });
  const flag = (id) => list.items.find((x) => x.id === id)?.publishedImmediately;
  ok('list: "Publier maintenant" at creation and early publication → publishedImmediately (only the actual time is relevant)',
    flag(created.id) === true && flag(early.id) === true);
  ok('list: worker publication, still-scheduled and failed proofs → not immediate (their planned time stays relevant)',
    flag(byWorker.id) === false && flag(pending.id) === false && flag(failing.id) === false
    && list.items.find((x) => x.id === byWorker.id).status === 'PUBLISHED' && list.items.find((x) => x.id === failing.id).status === 'FAILED');
  ok('the immediate proof keeps its actual publishedAt (Casablanca display) — scheduledAt is stored but no longer shown',
    list.items.find((x) => x.id === early.id).publishedAt === at(5 * MIN).toISOString() && T.formatCasablanca(+at(5 * MIN)) === '11/11/2026 02:27');
  const resp = await S.createPaymentProof(input(6, { publishMode: 'now' }), fileOf('d6'), { db, storage, now: T0, clock: () => at(7 * MIN), actorId: ADMIN });
  ok('API responses of "Publier maintenant" carry publishedImmediately = true', resp.proof.publishedImmediately === true);
  // 20261114: the same single page query now also returns REMOVE events ("Supprimer") — still one query, nothing per row.
  ok('…the list makes ONE extra query for the page (PUBLISH + REMOVE events of its proofs), nothing per row',
    /const evs = await db\.paymentProofEvent\.findMany\(\{\s*where: \{ proofId: \{ in: rows\.map\(\(r\) => r\.id\) \}, action: \{ in: \['PUBLISH', 'REMOVE'\] \} \}/.test(read('../src/lib/services/paymentProofService.js')));
  const pl = read('../src/app/admin/payment-proofs/ProofsList.jsx');
  ok('admin list UI: immediate → only "Publiée : … (heure du Maroc) · publication immédiate"; otherwise "Programmée : …" (+ "Publiée : …" once published)',
    /\{p\.publishedImmediately \? \(\s*\/\/[^\n]*\n\s*<span data-published-immediately>Publiée : <span data-published-at>\{fmtInstant\(p\.publishedAt\)\}<\/span> \(heure du Maroc\) · publication immédiate<\/span>\s*\) : \(/.test(pl)
    && /<span data-scheduled-at>Programmée : /.test(pl));
  ok('72 h window still from the actual publication of the early proof', (await visibleNames(db, new Date(+at(5 * MIN) + 72 * H - 1))).includes('Client 2')
    && !(await visibleNames(db, new Date(+at(5 * MIN) + 72 * H))).includes('Client 2'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
