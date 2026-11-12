#!/usr/bin/env node
/**
 * scripts/paymentProofDisplayControls.test.mjs — Payment Proofs display controls:
 * the global "Durée d'affichage" setting (captured per proof at its ACTUAL publication)
 * and the admin removal "Supprimer" (hidden at once, nothing deleted).
 *
 *    1. Pure rules: parseDisplayHours, describeDisplayHours, displayHoursOf, displayPresetOf, …
 *    2. Setting service + routes: default 72 h, presets / custom, history, INVALID_DURATION,
 *       SETTINGS_CONFLICT (stale + concurrent), UNAUTHORIZED, 200 / 400 / 409 shapes
 *    3. Duration captured at publication (worker tick, "Publier maintenant", publishMode 'now')
 *    4. Countdown from the actual publishedAt (late tick)
 *    5. A later setting change never moves a published proof; a scheduled proof takes the value
 *       in force when it is published
 *    6. Legacy published rows (no visibleHours / visibleUntil) keep the 72 h rule
 *    7. Removal ("Supprimer"): PUBLISHED / SCHEDULED / FAILED / expired, idempotent, errors, route
 *    8. Removal is separate from expiration; nothing is ever deleted
 *    9. The worker can never publish a removed proof (service check + trigger emulation)
 *   10. Concurrency: remove vs worker, remove vs "Publier maintenant", remove vs remove
 *   11. Static checks on the migration SQL (additive only)
 *
 * In-memory fake db only (scripts/lib/paymentProofFakeDb.mjs) — never a real database.
 * Run: node scripts/paymentProofDisplayControls.test.mjs
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'payment-proofs-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makePaymentProofFakeDb, makeProofMemStorage, makeFakeLock, pngBytes } from './lib/paymentProofFakeDb.mjs';

const P = await import('../src/lib/paymentProofs.js');
const S = await import('../src/lib/services/paymentProofService.js');
const W = await import('../src/lib/services/paymentProofPublisher.js');
const ST = await import('../src/lib/services/paymentProofSettingsService.js');
const { adminPaymentProofHandlers, affiliatePaymentProofHandlers } = await import('../src/lib/paymentProofRouteHandlers.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const H = P.HOUR_MS, MIN = 60_000, DAY = 24 * H;
const T0 = new Date('2026-11-11T09:00:00.000Z'); // 09:00 in Casablanca (UTC+0 since 2026-09-20)
const at = (d) => new Date(T0.getTime() + d);
const TS = new Date('2026-11-12T10:00:00.000Z'); // planned time of the scheduled proofs below (Casablanca 10:00)
const ADMIN = 'admin-1', ADMIN2 = 'admin-2';
const SETTING = P.PROOF_DISPLAY_SETTING_ID;

const input = (i, over = {}) => ({
  displayName: `Client ${i}`, amount: '1500', clientRef: `ref-dc-${i}-abcdef`, privacyConfirmed: true, authenticityConfirmed: true, ...over,
});
const fileOf = (tag) => { const b = pngBytes(tag); return { buffer: b, mime: 'image/png', size: b.length }; };
const fresh = (opts = {}) => ({ db: makePaymentProofFakeDb({ affiliates: [{ id: 'a1' }, { id: 'a2' }], ...opts }), storage: makeProofMemStorage() });
const events = (db, id, action) => db._tables.paymentProofEvent.filter((e) => e.proofId === id && (!action || e.action === action));
const rowOf = (db, id) => db._tables.paymentProof.find((r) => r.id === id);
const feedNames = async (db, now) => (await S.listVisiblePaymentProofs({ db, now })).proofs.map((x) => x.name);
/** 'OK' when the affiliate image is served, else the error code. */
const imageAt = async (db, storage, token, now) => {
  try { const f = await S.readVisiblePaymentProofImage(token, { db, storage, now }); return f?.buffer ? 'OK' : 'EMPTY'; } catch (e) { return e.code || String(e); }
};
/** A proof scheduled for TS (2026-11-12 10:00 Casablanca), created at T0. */
const scheduled = async (db, storage, i, { date = '2026-11-12', time = '10:00', now = T0 } = {}) =>
  (await S.createPaymentProof(input(i, { date, time }), fileOf(`s${i}-${date}-${time}`), { db, storage, now, actorId: ADMIN })).proof;
/** Save the global duration with the current revision. */
async function setHours(db, hours, { actorId = ADMIN, now = T0 } = {}) {
  const cur = await ST.getPaymentProofDisplaySettings({ db });
  return ST.savePaymentProofDisplaySettings({ hours, revision: cur.revision }, { db, now, actorId });
}
const tickAt = (db, storage, when) => W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => when });

// HTTP helpers (raw handlers: the admin `user` / affiliate `decoded` are passed directly)
const jreq = (url, method, body) => new Request(`http://x${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
const greq = (url) => new Request(`http://x${url}`);
const ctx = (params) => ({ params: Promise.resolve(params) });
const bodyOf = async (res) => ((res.headers.get('content-type') || '').includes('json') ? res.json() : null);
const handlers = (db, storage, clock) => ({
  admin: adminPaymentProofHandlers({ db, storage, now: () => clock() }),
  aff: affiliatePaymentProofHandlers({ db, storage, now: () => clock(), rateLimit: () => null }),
});

const yieldN = (n) => new Promise((r) => { let i = 0; const f = () => (i++ >= n ? r() : setImmediate(f)); f(); });
const late = (k, fn) => yieldN(k % 7).then(fn); // start `fn` after k % 7 event-loop turns

/**
 * Emulates the pg_advisory_xact_lock the settings service takes through tx.$executeRaw (the fake
 * db has no $executeRaw, so without this wrapper the lock step is skipped). The lock is held until
 * the wrapped transaction ends (commit or rollback), like a transaction-scoped advisory lock.
 */
function withAdvisoryXactLock(db) {
  let chain = Promise.resolve();
  const calls = [];
  return {
    ...db,
    lockCalls: calls,
    async $transaction(fn) {
      let release = null;
      try {
        return await db.$transaction(async (tx) => {
          tx.$executeRaw = async (strings, ...vals) => {
            calls.push({ sql: strings.join('?'), vals });
            const prev = chain;
            chain = new Promise((r) => { release = r; });
            await prev;
          };
          return fn(tx);
        });
      } finally { release?.(); }
    },
  };
}

// ── 1. Pure rules ─────────────────────────────────────────────────────────────
console.log('\n1. Pure rules');
{
  ok('constants: DEFAULT 72, MIN 1, MAX 8760, presets 72h / 7d=168 / 30d=720, setting id "payment-proof-display"',
    P.DEFAULT_DISPLAY_HOURS === 72 && P.MIN_DISPLAY_HOURS === 1 && P.MAX_DISPLAY_HOURS === 8760 && SETTING === 'payment-proof-display'
    && JSON.stringify(P.DISPLAY_DURATION_PRESETS) === JSON.stringify([{ key: '72h', hours: 72 }, { key: '7d', hours: 168 }, { key: '30d', hours: 720 }]));
  const accepts = [[1, 1], [72, 72], [168, 168], [720, 720], [8760, 8760], ['36', 36], [' 48 ', 48]];
  const badAcc = accepts.filter(([v, want]) => P.parseDisplayHours(v) !== want);
  ok('parseDisplayHours accepts 1, 72, 168, 720, 8760, "36", " 48 " (→ whole hours)', badAcc.length === 0, JSON.stringify(badAcc));
  const rejected = [0, -1, '-3', 1.5, '1.5', 'abc', '', null, undefined, 8761, '8761', NaN, Infinity, -Infinity, '1e3', '0x10', true, {}, [72]];
  const badRej = rejected.filter((v) => P.parseDisplayHours(v) !== null);
  ok('parseDisplayHours rejects 0, -1, "-3", 1.5, "1.5", "abc", "", null, undefined, 8761, NaN, ±Infinity, "1e3", "0x10", true, {}, [72] (→ null)',
    badRej.length === 0, badRej.map(String).join(','));
  ok('describeDisplayHours(72) contains "72 heures" and "3 jours"', P.describeDisplayHours(72).includes('72 heures') && P.describeDisplayHours(72).includes('3 jours'), P.describeDisplayHours(72));
  ok('describeDisplayHours(168) contains "7 jours"; (720) contains "30 jours"', P.describeDisplayHours(168).includes('7 jours') && P.describeDisplayHours(720).includes('30 jours'));
  ok('describeDisplayHours(36) contains "1 jour et 12 heures"; (5) = "5 heures"; (1) = "1 heure"; (24) = "24 heures (1 jour)"',
    P.describeDisplayHours(36).includes('1 jour et 12 heures') && P.describeDisplayHours(5) === '5 heures' && P.describeDisplayHours(1) === '1 heure'
    && P.describeDisplayHours(24) === '24 heures (1 jour)', `${P.describeDisplayHours(36)} | ${P.describeDisplayHours(5)}`);
  ok('describeDisplayHours of an invalid value is empty', P.describeDisplayHours(0) === '' && P.describeDisplayHours(-5) === '' && P.describeDisplayHours(1.5) === '');
  const missing = [null, undefined, {}, 'x', 72, { hours: 0 }, { hours: -1 }, { hours: 'abc' }, { hours: 9000 }, { hours: 1.5 }, { hours: null }];
  ok('displayHoursOf(missing / invalid data) = 72', missing.every((d) => P.displayHoursOf(d) === 72));
  ok('displayHoursOf(valid data) = its hours ({hours:168} → 168, {hours:"36"} → 36, {hours:5} → 5)',
    P.displayHoursOf({ hours: 168 }) === 168 && P.displayHoursOf({ hours: '36' }) === 36 && P.displayHoursOf({ hours: 5 }) === 5);
  ok('displayPresetOf: 72 → "72h", 168 → "7d", 720 → "30d", 36 / 5 / 8760 → "custom"',
    P.displayPresetOf(72) === '72h' && P.displayPresetOf(168) === '7d' && P.displayPresetOf(720) === '30d'
    && ['custom', 'custom', 'custom'].every((c, i) => P.displayPresetOf([36, 5, 8760][i]) === c));
  const pub = +T0;
  ok('visibleUntilOf(publishedAt, h) = publishedAt + h hours', +P.visibleUntilOf(pub, 5) === pub + 5 * H && +P.visibleUntilOf(pub, 720) === pub + 720 * H);
  const captured = { status: 'PUBLISHED', publishedAt: T0, visibleHours: 5, visibleUntil: new Date(pub + 5 * H) };
  const legacy = { status: 'PUBLISHED', publishedAt: T0 };
  ok('displayEndMs: captured visibleUntil, else legacy publishedAt + 72 h, null when unpublished',
    P.displayEndMs(captured) === pub + 5 * H && P.displayEndMs(legacy) === pub + 72 * H && P.displayEndMs({ status: 'SCHEDULED' }) === null);
  ok('isVisibleAt (captured 5 h): visible at publishedAt and end − 1 ms; not at end, not before publishedAt',
    P.isVisibleAt(captured, pub) && P.isVisibleAt(captured, pub + 5 * H - 1) && !P.isVisibleAt(captured, pub + 5 * H) && !P.isVisibleAt(captured, pub - 1));
  ok('isVisibleAt (legacy, no visibleUntil): publishedAt + 72 h rule',
    P.isVisibleAt(legacy, pub + 72 * H - 1) && !P.isVisibleAt(legacy, pub + 72 * H));
  ok('isVisibleAt: removed / removedAt → never visible; non-PUBLISHED → never visible',
    !P.isVisibleAt({ ...captured, removed: true }, pub + 1) && !P.isVisibleAt({ ...captured, removedAt: T0 }, pub + 1)
    && !P.isVisibleAt({ ...captured, status: 'CANCELLED' }, pub + 1));
  const w = P.visibleFeedWhere(T0);
  ok('visibleFeedWhere: PUBLISHED, publishedAt <= now, visibleUntil > now OR (legacy) publishedAt > now − 72 h, no REMOVE event',
    w.status === 'PUBLISHED' && +w.publishedAt.lte === pub && JSON.stringify(w.events) === JSON.stringify({ none: { action: 'REMOVE' } })
    && +w.OR[0].visibleUntil.gt === pub && w.OR[1].visibleUntil === null && +w.OR[1].publishedAt.gt === pub - 72 * H);
  const base = { id: 'p1', displayName: 'X Y', displayAmountCents: 100, clientRef: 'r', scheduledAt: T0, createdAt: T0, updatedAt: T0 };
  const ap = P.adminProof({ ...base, ...captured }, { removal: { at: at(H), by: ADMIN2 }, nowMs: pub + 1 });
  ok('adminProof: visibleHours / visibleUntil, removed / removedAt / removedBy, onSlider=false when removed',
    ap.visibleHours === 5 && ap.visibleUntil === new Date(pub + 5 * H).toISOString() && ap.removed === true
    && ap.removedAt === at(H).toISOString() && ap.removedBy === ADMIN2 && ap.onSlider === false);
  const al = P.adminProof({ ...base, ...legacy }, { nowMs: pub + 1 });
  ok('adminProof (legacy row): visibleHours 72, visibleUntil = publishedAt + 72 h, removed=false, onSlider=true',
    al.visibleHours === 72 && al.visibleUntil === new Date(pub + 72 * H).toISOString() && al.removed === false && al.removedBy === null && al.onSlider === true);
  const as = P.adminProof({ ...base, status: 'SCHEDULED', publishedAt: null });
  ok('adminProof (unpublished): visibleHours / visibleUntil null, no onSlider without nowMs', as.visibleHours === null && as.visibleUntil === null && !('onSlider' in as));
}

// ── 2. Setting service + routes ──────────────────────────────────────────────
console.log('\n2. Display-duration setting: service and routes');
{
  const { db } = fresh();
  const d = await ST.getPaymentProofDisplaySettings({ db });
  ok('default: 72 h, isDefault, preset "72h", empty history, a revision (no row)',
    d.hours === 72 && d.isDefault === true && d.preset === '72h' && d.history.length === 0 && typeof d.revision === 'string' && d.revision.length > 0
    && d.label.includes('72 heures') && d.minHours === 1 && d.maxHours === 8760 && d.presets.length === 3 && db._tables.settings.length === 0);
  ok('readPaymentProofDisplayHours = 72 by default', (await ST.readPaymentProofDisplayHours({ db })) === 72);

  const s1 = await ST.savePaymentProofDisplaySettings({ hours: 168, revision: d.revision }, { db, now: at(MIN), actorId: ADMIN });
  const row1 = db._tables.settings.find((x) => x.id === SETTING);
  ok('save 168 (7 jours): returned view + stored row', s1.hours === 168 && s1.preset === '7d' && s1.isDefault === false && s1.label.includes('7 jours')
    && row1?.data?.hours === 168 && s1.revision !== d.revision && (await ST.readPaymentProofDisplayHours({ db })) === 168);
  // Final fixes: the response adds the admin's display name (byName); the STORED history entry is unchanged (no name stored).
  ok('history records who, when, from → to (72 → 168)', s1.history.length === 1
    && JSON.stringify(s1.history[0]) === JSON.stringify({ at: at(MIN).toISOString(), by: ADMIN, fromHours: 72, toHours: 168, byName: 'Administrateur' })
    && JSON.stringify(row1.data.history[0]) === JSON.stringify({ at: at(MIN).toISOString(), by: ADMIN, fromHours: 72, toHours: 168 })
    && s1.updatedBy === ADMIN && s1.updatedAt === at(MIN).toISOString());
  const s2 = await ST.savePaymentProofDisplaySettings({ hours: 720, revision: s1.revision }, { db, now: at(2 * MIN), actorId: ADMIN2 });
  ok('save 720 (30 jours) by another admin: history newest first (168 → 720 by admin-2, then 72 → 168)',
    s2.hours === 720 && s2.preset === '30d' && s2.history.length === 2 && s2.history[0].by === ADMIN2 && s2.history[0].fromHours === 168
    && s2.history[0].toHours === 720 && s2.history[1].toHours === 168);
  const s3 = await ST.savePaymentProofDisplaySettings({ hours: '36', revision: s2.revision }, { db, now: at(3 * MIN), actorId: ADMIN });
  ok('save a custom value "36": 36 h, preset "custom", label "1 jour et 12 heures", history 720 → 36',
    s3.hours === 36 && s3.preset === 'custom' && s3.label.includes('1 jour et 12 heures') && s3.history.length === 3 && s3.history[0].fromHours === 720 && s3.history[0].toHours === 36);

  const snap = JSON.stringify(db._tables.settings, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  const upserts = () => db._log.filter((l) => l.model === 'setting' && l.op === 'upsert').length;
  const u0 = upserts();
  const invalid = [0, -1, -168, 1.5, '1.5', 'abc', '', null, 8761, NaN, '-3'];
  let invBad = [];
  for (const v of invalid) {
    const e = await rejects(ST.savePaymentProofDisplaySettings({ hours: v, revision: s3.revision }, { db, now: at(4 * MIN), actorId: ADMIN }));
    if (e?.code !== 'INVALID_DURATION' || e.errors?.hours !== 'INVALID_DURATION') invBad.push(String(v));
  }
  ok('invalid / negative / zero / non-integer / too long → INVALID_DURATION (errors.hours)', invBad.length === 0, invBad.join(','));
  const eInvStale = await rejects(ST.savePaymentProofDisplaySettings({ hours: 0, revision: 'stale' }, { db, actorId: ADMIN }));
  ok('…validation comes first (invalid hours + stale revision → INVALID_DURATION)', eInvStale?.code === 'INVALID_DURATION');
  ok('…nothing written (row identical, no upsert)', JSON.stringify(db._tables.settings, (k, v) => (typeof v === 'bigint' ? String(v) : v)) === snap && upserts() === u0);

  const stale = await rejects(ST.savePaymentProofDisplaySettings({ hours: 72, revision: s1.revision }, { db, now: at(5 * MIN), actorId: ADMIN2 }));
  ok('stale revision → SETTINGS_CONFLICT with `current` (36 h, current revision)', stale?.code === 'SETTINGS_CONFLICT'
    && stale.current?.hours === 36 && stale.current?.revision === s3.revision && stale.current?.history?.length === 3);
  ok('…nothing written', JSON.stringify(db._tables.settings) === snap && upserts() === u0 && (await ST.readPaymentProofDisplayHours({ db })) === 36);
  const noRev = await rejects(ST.savePaymentProofDisplaySettings({ hours: 72 }, { db, actorId: ADMIN }));
  ok('missing revision → refused (INVALID_INPUT), nothing written', noRev?.code === 'INVALID_INPUT' && JSON.stringify(db._tables.settings) === snap);
  const noActor = await rejects(ST.savePaymentProofDisplaySettings({ hours: 72, revision: s3.revision }, { db }));
  const emptyActor = await rejects(ST.savePaymentProofDisplaySettings({ hours: 72, revision: s3.revision }, { db, actorId: '' }));
  ok('missing actor → UNAUTHORIZED, nothing written', noActor?.code === 'UNAUTHORIZED' && emptyActor?.code === 'UNAUTHORIZED' && JSON.stringify(db._tables.settings) === snap);

  // invalid stored row → default 72 (missing / invalid row = default)
  const { db: dbBad } = fresh({ settings: [{ id: SETTING, data: { hours: -5 } }] });
  const vb = await ST.getPaymentProofDisplaySettings({ db: dbBad });
  ok('an invalid stored row reads as the 72 h default (isDefault)', vb.hours === 72 && vb.isDefault === true && (await ST.readPaymentProofDisplayHours({ db: dbBad })) === 72);

  // history bounded to DISPLAY_HISTORY_MAX (50)
  const { db: dbH } = fresh();
  for (let i = 0; i < 55; i++) await setHours(dbH, 1 + i, { now: at(i * MIN) });
  const vh = await ST.getPaymentProofDisplaySettings({ db: dbH });
  ok('history is bounded to 50 entries, newest first', ST.DISPLAY_HISTORY_MAX === 50 && vh.history.length === 50 && vh.history[0].toHours === 55 && vh.history[49].toHours === 6);
}
{
  // Two concurrent saves with the same revision: exactly one wins (advisory xact lock emulated).
  let bad = 0, firstWins = 0, secondWins = 0, lockUsed = true;
  for (let k = 0; k < 14; k++) {
    const { db: raw } = fresh();
    const db = withAdvisoryXactLock(raw);
    const rev = (await ST.getPaymentProofDisplaySettings({ db })).revision;
    const a = () => ST.savePaymentProofDisplaySettings({ hours: 168, revision: rev }, { db, now: at(MIN), actorId: ADMIN }).catch((e) => e);
    const b = () => ST.savePaymentProofDisplaySettings({ hours: 720, revision: rev }, { db, now: at(MIN), actorId: ADMIN2 }).catch((e) => e);
    const [ra, rb] = k % 2 ? await Promise.all([late(k, a), b()]) : await Promise.all([a(), late(k, b)]);
    const wins = [ra, rb].filter((r) => r && !(r instanceof Error));
    const conflicts = [ra, rb].filter((r) => r?.code === 'SETTINGS_CONFLICT');
    const stored = raw._tables.settings.find((x) => x.id === SETTING)?.data;
    const fine = wins.length === 1 && conflicts.length === 1 && stored?.hours === wins[0].hours && stored.history.length === 1
      && conflicts[0].current?.hours === wins[0].hours;
    if (!db.lockCalls.length || !db.lockCalls.every((c) => /pg_advisory_xact_lock/.test(c.sql))) lockUsed = false;
    if (!fine) bad++; else if (wins[0].hours === 168) firstWins++; else secondWins++;
  }
  ok(`two concurrent saves with the same revision: exactly one succeeds, the other SETTINGS_CONFLICT, one history entry (168 won ${firstWins}, 720 won ${secondWins} of 14)`,
    bad === 0 && firstWins > 0 && secondWins > 0, String(bad));
  ok('…the save serializes on pg_advisory_xact_lock taken inside its transaction', lockUsed);
}
{
  // Routes: GET / PUT settings
  const { db, storage } = fresh();
  const h = handlers(db, storage, () => at(MIN)).admin;
  const g = await h.getSettings(greq('/api/admin/payment-proofs/settings'), ctx({}), { userId: ADMIN });
  const gb = await bodyOf(g);
  ok('route getSettings → 200 { hours: 72, preset, label, presets, history, revision }', g.status === 200 && gb.hours === 72 && gb.preset === '72h'
    && typeof gb.revision === 'string' && Array.isArray(gb.presets) && Array.isArray(gb.history) && g.headers.get('cache-control') === 'no-store');
  const put = await h.saveSettings(jreq('/api/admin/payment-proofs/settings', 'PUT', { hours: 168, revision: gb.revision }), ctx({}), { userId: ADMIN });
  const pb = await bodyOf(put);
  ok('route saveSettings PUT {hours:168, revision} → 200 with the new view (history by the admin)', put.status === 200 && pb.hours === 168 && pb.preset === '7d' && pb.history[0].by === ADMIN);
  const inv = await h.saveSettings(jreq('/x', 'PUT', { hours: 0, revision: pb.revision }), ctx({}), { userId: ADMIN });
  const ib = await bodyOf(inv);
  ok('route saveSettings invalid hours → 400 { code: INVALID_DURATION, errors.hours }', inv.status === 400 && ib.code === 'INVALID_DURATION' && ib.errors?.hours === 'INVALID_DURATION');
  const conf = await h.saveSettings(jreq('/x', 'PUT', { hours: 720, revision: gb.revision }), ctx({}), { userId: ADMIN2 });
  const cb = await bodyOf(conf);
  ok('route saveSettings stale revision → 409 { code: SETTINGS_CONFLICT, current: { hours: 168, revision } }', conf.status === 409 && cb.code === 'SETTINGS_CONFLICT'
    && cb.current?.hours === 168 && cb.current?.revision === pb.revision);
  const unauth = await h.saveSettings(jreq('/x', 'PUT', { hours: 720, revision: pb.revision }), ctx({}), null);
  ok('route saveSettings without an admin identity → 401 UNAUTHORIZED', unauth.status === 401 && (await bodyOf(unauth)).code === 'UNAUTHORIZED');
  const badJson = await h.saveSettings(jreq('/x', 'PUT', 'not json'), ctx({}), { userId: ADMIN });
  ok('route saveSettings with a non-JSON body → 400 INVALID_INPUT', badJson.status === 400 && (await bodyOf(badJson)).code === 'INVALID_INPUT');
  ok('…only the valid PUT was stored (168)', (await ST.readPaymentProofDisplayHours({ db })) === 168 && db._tables.settings[0].data.history.length === 1);
}

// ── 3. Duration captured at the ACTUAL publication ───────────────────────────
console.log('\n3. The duration in force at publication is captured on the proof');
for (const hours of [72, 168, 720, 5]) {
  const { db, storage } = fresh();
  if (hours !== 72) await setHours(db, hours);
  // (a) worker tick at the planned time
  const pw = await scheduled(db, storage, 1);
  const tick = await tickAt(db, storage, TS);
  // (b) "Publier maintenant" on a scheduled proof
  const pn = await scheduled(db, storage, 2, { time: '11:00' });
  const nowAt = at(30 * MIN);
  const outNow = await S.publishPaymentProofNow(pn.id, { db, storage, clock: () => nowAt, actorId: ADMIN });
  // (c) createPaymentProof publishMode 'now'
  const createAt = at(45 * MIN);
  const outCreate = await S.createPaymentProof(input(3, { publishMode: 'now' }), fileOf('c3'), { db, storage, now: at(44 * MIN), clock: () => createAt, actorId: ADMIN });
  const cases = [['worker tick', pw.id, TS], ['"Publier maintenant"', pn.id, nowAt], ['create publishMode "now"', outCreate.proof.id, createAt]];
  ok(`[${hours} h] all three publications succeeded`, tick.published === 1 && outNow.publication.status === 'PUBLISHED' && outCreate.publication?.status === 'PUBLISHED');
  for (const [label, id, pubAt] of cases) {
    const r = rowOf(db, id);
    const end = +pubAt + hours * H;
    const ev = events(db, id, 'PUBLISH')[0];
    ok(`[${hours} h] ${label}: visibleHours = ${hours}, visibleUntil = publishedAt + ${hours} h, PUBLISH event records them`,
      r.status === 'PUBLISHED' && +r.publishedAt === +pubAt && r.visibleHours === hours && +r.visibleUntil === end
      && ev?.details?.visibleHours === hours && ev.details.visibleUntil === new Date(end).toISOString(),
      JSON.stringify({ vh: r.visibleHours, vu: r.visibleUntil, pa: r.publishedAt }));
    const name = r.displayName;
    const before = await feedNames(db, new Date(end - 1));
    const after = await feedNames(db, new Date(end));
    ok(`[${hours} h] ${label}: in the feed at publishedAt + ${hours} h − 1 ms, NOT at publishedAt + ${hours} h`, before.includes(name) && !after.includes(name));
    ok(`[${hours} h] ${label}: affiliate image served at end − 1 ms, NOT_FOUND at end`,
      (await imageAt(db, storage, r.publicToken, new Date(end - 1))) === 'OK' && (await imageAt(db, storage, r.publicToken, new Date(end))) === 'NOT_FOUND');
  }
  const adm = await S.listPaymentProofsAdmin({ db, now: at(H) });
  ok(`[${hours} h] admin list shows visibleHours / visibleUntil per proof`, cases.every(([, id, pubAt]) => {
    const it = adm.items.find((x) => x.id === id);
    return it && it.visibleHours === hours && it.visibleUntil === new Date(+pubAt + hours * H).toISOString();
  }));
  ok(`[${hours} h] returned admin proofs (publish now / create now) carry the captured duration`,
    outNow.proof.visibleHours === hours && outCreate.proof.visibleHours === hours && outCreate.proof.visibleUntil === new Date(+createAt + hours * H).toISOString());
}

// ── 4. Countdown from the actual publishedAt ─────────────────────────────────
console.log('\n4. The countdown starts at the actual publication (late tick)');
{
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 1);
  const lateTick = new Date(+TS + 3 * H); // the worker was down for 3 h
  const t0 = await tickAt(db, storage, new Date(+TS - 1));
  ok('not published one ms before its planned time', t0.published === 0 && rowOf(db, p.id).status === 'SCHEDULED');
  const t = await tickAt(db, storage, lateTick);
  const r = rowOf(db, p.id);
  ok('late tick (T + 3 h): publishedAt = T + 3 h, visibleUntil = (T + 3 h) + 72 h (not T + 72 h)',
    t.published === 1 && +r.publishedAt === +lateTick && +r.visibleUntil === +lateTick + 72 * H && r.visibleHours === 72 && +r.scheduledAt === +TS);
  ok('still visible at T + 74 h (after the planned window would have ended), gone at T + 75 h',
    (await feedNames(db, new Date(+TS + 74 * H))).includes('Client 1') && !(await feedNames(db, new Date(+TS + 75 * H))).includes('Client 1'));
  const { db: db2, storage: st2 } = fresh();
  await setHours(db2, 5);
  const p2 = await scheduled(db2, st2, 2);
  await tickAt(db2, st2, lateTick);
  const r2 = rowOf(db2, p2.id);
  ok('same with a 5 h setting: visibleUntil = (T + 3 h) + 5 h', +r2.visibleUntil === +lateTick + 5 * H && r2.visibleHours === 5
    && (await feedNames(db2, new Date(+TS + 8 * H - 1))).length === 1 && (await feedNames(db2, new Date(+TS + 8 * H))).length === 0);
}

// ── 5. A setting change never moves an already-published proof ───────────────
console.log('\n5. Setting changes affect only later publications');
{
  const { db, storage } = fresh();
  // A: published now while the setting is 72 h
  const outA = await S.createPaymentProof(input('A', { publishMode: 'now' }), fileOf('A'), { db, storage, now: T0, clock: () => T0, actorId: ADMIN });
  const idA = outA.proof.id;
  // B: scheduled while the setting is 72 h (for TS)
  const pB = await scheduled(db, storage, 'B');
  const snapA = JSON.stringify(rowOf(db, idA));
  // the admin switches to 7 days, then to 30 days
  await setHours(db, 168, { now: at(10 * MIN) });
  ok('after switching to 7 d: proof A (published at 72 h) unchanged: visibleHours 72, visibleUntil T0 + 72 h, row identical',
    JSON.stringify(rowOf(db, idA)) === snapA && rowOf(db, idA).visibleHours === 72 && +rowOf(db, idA).visibleUntil === +T0 + 72 * H);
  const tick = await tickAt(db, storage, TS);
  const rB = rowOf(db, pB.id);
  ok('scheduled proof B (created under 72 h) published after the switch → 168 h', tick.published === 1 && rB.visibleHours === 168 && +rB.visibleUntil === +TS + 168 * H);
  await setHours(db, 720, { now: at(DAY + 2 * H), actorId: ADMIN2 });
  await setHours(db, 5, { now: at(DAY + 3 * H), actorId: ADMIN2 });
  ok('later switches (30 d, then 5 h) change neither A nor B', JSON.stringify(rowOf(db, idA)) === snapA && rowOf(db, pB.id).visibleHours === 168 && +rowOf(db, pB.id).visibleUntil === +TS + 168 * H);
  ok('feed: A gone at T0 + 72 h despite the 30 d / 5 h settings; B visible at TS + 168 h − 1 ms and gone at TS + 168 h',
    !(await feedNames(db, new Date(+T0 + 72 * H))).includes('Client A') && (await feedNames(db, new Date(+T0 + 72 * H - 1))).includes('Client A')
    && (await feedNames(db, new Date(+TS + 168 * H - 1))).includes('Client B') && !(await feedNames(db, new Date(+TS + 168 * H))).includes('Client B'));
  ok('B is still visible after 5 h (the current 5 h setting is not applied retroactively)', (await feedNames(db, new Date(+TS + 6 * H))).includes('Client B'));
  ok('the publisher reads the setting inside its transaction (setting.findUnique logged between $transaction begin and the PUBLISH update)', (() => {
    const L = db._log; const iUpd = L.findIndex((l, i) => l.model === 'paymentProof' && l.op === 'updateMany' && L.slice(0, i).some((x) => x.model === 'setting' && x.op === 'findUnique'));
    return iUpd > 0;
  })());
}

// ── 6. Legacy published proofs keep the 72 h rule ───────────────────────────
console.log('\n6. Legacy proofs (published before the migration) keep publishedAt + 72 h');
{
  const { db, storage } = fresh({ settings: [{ id: SETTING, data: { hours: 720 } }] });
  ok('the setting is 30 d', (await ST.readPaymentProofDisplayHours({ db })) === 720);
  const key = (await storage.store(pngBytes('legacy'))).key;
  const pub = at(-H);
  const legacy = {
    id: `p-legacy-${randomUUID().slice(0, 8)}`, displayName: 'Legacy One', displayAmountCents: 150000, fileKey: key,
    fingerprint: 'f'.repeat(64), publicToken: 'a'.repeat(32), status: 'PUBLISHED', scheduledAt: at(-2 * H), publishedAt: pub,
    cancelledAt: null, failedAt: null, failureReason: null, publishAttempts: 1, batchId: null, clientRef: 'legacy-ref-0001',
    privacyConfirmedAt: at(-3 * H), privacyConfirmedBy: ADMIN, authenticityConfirmedAt: at(-3 * H), authenticityConfirmedBy: ADMIN,
    createdBy: ADMIN, updatedBy: ADMIN, createdAt: at(-3 * H), updatedAt: at(-3 * H),
  }; // NO visibleHours / visibleUntil keys at all (pre-migration row)
  db._tables.paymentProof.push(legacy);
  const legacyNull = { ...structuredClone(legacy), id: 'p-legacy-null', fingerprint: 'e'.repeat(64), publicToken: 'b'.repeat(32), clientRef: 'legacy-ref-0002', displayName: 'Legacy Null', visibleHours: null, visibleUntil: null };
  db._tables.paymentProof.push(legacyNull);
  const end = +pub + 72 * H;
  ok('legacy row (no columns): in the feed at publishedAt + 72 h − 1 ms, NOT at + 72 h, although the setting is 30 d',
    (await feedNames(db, new Date(end - 1))).includes('Legacy One') && !(await feedNames(db, new Date(end))).includes('Legacy One')
    && !(await feedNames(db, new Date(+pub + 100 * H))).includes('Legacy One'));
  ok('legacy row with explicit NULLs: same 72 h rule', (await feedNames(db, new Date(end - 1))).includes('Legacy Null') && !(await feedNames(db, new Date(end))).includes('Legacy Null'));
  ok('legacy image: served at + 72 h − 1 ms, NOT_FOUND at + 72 h', (await imageAt(db, storage, legacy.publicToken, new Date(end - 1))) === 'OK'
    && (await imageAt(db, storage, legacy.publicToken, new Date(end))) === 'NOT_FOUND');
  const adm = await S.listPaymentProofsAdmin({ db, now: T0 });
  const it = adm.items.find((x) => x.id === legacy.id);
  ok('admin list: legacy proof shows visibleHours 72, visibleUntil = publishedAt + 72 h, onSlider', it?.visibleHours === 72 && it.visibleUntil === new Date(end).toISOString() && it.onSlider === true);
  const t = await tickAt(db, storage, at(2 * H));
  ok('the worker never touches it (not backfilled)', t.due === 0 && !('visibleHours' in rowOf(db, legacy.id)) && rowOf(db, legacy.id).publishAttempts === 1);
}

// ── 7. Removal ("Supprimer") ─────────────────────────────────────────────────
console.log('\n7. "Supprimer": hidden at once from every affiliate, nothing deleted');
{
  const { db, storage } = fresh();
  await setHours(db, 168);
  const kept = await S.createPaymentProof(input('K', { publishMode: 'now' }), fileOf('K'), { db, storage, now: T0, clock: () => at(1_000), actorId: ADMIN });
  const gone = await S.createPaymentProof(input('R', { publishMode: 'now' }), fileOf('R'), { db, storage, now: T0, clock: () => at(2_000), actorId: ADMIN });
  const id = gone.proof.id, token = rowOf(db, id).publicToken;
  const R = at(2 * H);
  const { aff } = handlers(db, storage, () => R);
  const feedOf = async (affiliateId) => bodyOf(await aff.list(greq('/api/affiliate/payment-proofs'), ctx({}), { affiliateId }));
  const pre = await feedOf('a1');
  ok('before removal: both proofs in the affiliate feed', pre.proofs.length === 2 && pre.proofs.some((x) => x.name === 'Client R'));
  const rowsBefore = db._tables.paymentProof.length;
  const snapBefore = structuredClone(rowOf(db, id));
  const out = await S.removePaymentProof(id, { db, now: R, actorId: ADMIN2 });
  ok('remove a PUBLISHED visible proof → { alreadyRemoved: false, proof.removed, removedBy, onSlider: false }',
    out.alreadyRemoved === false && out.proof.removed === true && out.proof.removedBy === ADMIN2 && out.proof.removedAt === R.toISOString() && out.proof.onSlider === false);
  const f1 = await feedOf('a1'), f2 = await feedOf('a2');
  ok('immediately absent from the feed; two different affiliates get identical feeds', !f1.proofs.some((x) => x.name === 'Client R')
    && f1.proofs.length === 1 && f1.total === 1 && JSON.stringify(f1) === JSON.stringify(f2));
  const stillHidden = [];
  for (const d of [3 * H, 100 * H, 168 * H]) stillHidden.push(!(await feedNames(db, new Date(+at(2_000) + d - 1))).includes('Client R'));
  ok('…long before its 168 h expiry (still absent at publishedAt + 3 h, + 100 h, + 168 h − 1 ms)', stillHidden.every(Boolean));
  const imgRes = await aff.image(greq(`/api/affiliate/payment-proofs/image/${token}`), ctx({ token }), { affiliateId: 'a2' });
  ok('its image → NOT_FOUND (service) and 404 (affiliate route)', (await imageAt(db, storage, token, R)) === 'NOT_FOUND' && imgRes.status === 404);
  const keptToken = rowOf(db, kept.proof.id).publicToken;
  ok('the other proof\'s image is still served', (await imageAt(db, storage, keptToken, R)) === 'OK');
  const r = rowOf(db, id);
  ok('the row is still there, unchanged (status PUBLISHED, publishedAt / visibleUntil, receipt file kept)',
    db._tables.paymentProof.length === rowsBefore && JSON.stringify(r) === JSON.stringify(snapBefore) && storage.files.has(r.fileKey));
  const evs = await S.listPaymentProofEvents(id, { db });
  const rem = evs.events.filter((e) => e.action === 'REMOVE');
  ok('REMOVE event in the history with actor / at / details {previousStatus PUBLISHED, cancelled false, wasVisible true}',
    rem.length === 1 && rem[0].actor === ADMIN2 && rem[0].at === R.toISOString()
    && JSON.stringify(rem[0].details) === JSON.stringify({ previousStatus: 'PUBLISHED', cancelled: false, wasVisible: true })
    && evs.events.map((e) => e.action).join() === 'CREATE,CONFIRM_PRIVACY,CONFIRM_AUTHENTICITY,PUBLISH,REMOVE');
  const adm = await S.listPaymentProofsAdmin({ db, now: R });
  const it = adm.items.find((x) => x.id === id);
  ok('admin list still shows it: status PUBLISHED, removed=true, removedBy, onSlider=false; counts.REMOVED = 1',
    it?.status === 'PUBLISHED' && it.removed === true && it.removedBy === ADMIN2 && it.removedAt === R.toISOString() && it.onSlider === false
    && adm.counts.REMOVED === 1 && adm.counts.PUBLISHED === 2 && adm.items.find((x) => x.id === kept.proof.id)?.removed === false);
  // idempotent
  const again = await S.removePaymentProof(id, { db, now: at(3 * H), actorId: ADMIN });
  ok('second removal → alreadyRemoved: true, still exactly one REMOVE event, first remover kept',
    again.alreadyRemoved === true && events(db, id, 'REMOVE').length === 1 && again.proof.removedBy === ADMIN2 && again.proof.removedAt === R.toISOString());
  // a published + removed proof can no longer be edited / cancelled / published
  ok('a removed published proof: edit → NOT_EDITABLE, cancel → NOT_CANCELLABLE, publish now → alreadyPublished (nothing written)',
    (await rejects(S.updatePaymentProofSchedule(id, input('R', { date: '2026-11-13', time: '10:00' }), { db, storage, now: R, actorId: ADMIN })))?.code === 'NOT_EDITABLE'
    && (await rejects(S.cancelPaymentProof(id, { db, now: R, actorId: ADMIN })))?.code === 'NOT_CANCELLABLE'
    && (await S.publishPaymentProofNow(id, { db, storage, clock: () => R, actorId: ADMIN })).alreadyPublished === true
    && events(db, id, 'PUBLISH').length === 1);
}
{
  // SCHEDULED → CANCELLED + REMOVE; never published afterwards
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 1);
  const R = at(H);
  const out = await S.removePaymentProof(p.id, { db, now: R, actorId: ADMIN });
  const r = rowOf(db, p.id);
  const ev = events(db, p.id, 'REMOVE');
  ok('remove SCHEDULED → CANCELLED (cancelledAt = now, updatedBy) + REMOVE {previousStatus SCHEDULED, cancelled true, wasVisible false}',
    out.alreadyRemoved === false && r.status === 'CANCELLED' && +r.cancelledAt === +R && r.updatedBy === ADMIN && ev.length === 1
    && JSON.stringify(ev[0].details) === JSON.stringify({ previousStatus: 'SCHEDULED', cancelled: true, wasVisible: false })
    && out.proof.status === 'CANCELLED' && out.proof.removed === true && events(db, p.id, 'CANCEL').length === 0);
  const t1 = await tickAt(db, storage, TS);
  const t2 = await tickAt(db, storage, new Date(+TS + DAY));
  ok('the worker at / after its planned time does NOT publish it', t1.published === 0 && t1.due === 0 && t2.published === 0 && r.status === 'CANCELLED'
    && rowOf(db, p.id).status === 'CANCELLED' && events(db, p.id, 'PUBLISH').length === 0);
  ok('publishOnePaymentProof (worker / immediate) → skipped', (await W.publishOnePaymentProof(p.id, { db, storage, now: TS })) === 'skipped'
    && (await W.publishOnePaymentProof(p.id, { db, storage, now: TS, immediate: true, actor: ADMIN })) === 'skipped');
  const pn = await rejects(S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(2 * H), actorId: ADMIN }));
  ok('"Publier maintenant" → NOT_PUBLISHABLE (status CANCELLED)', pn?.code === 'NOT_PUBLISHABLE' && pn.status === 'CANCELLED');
  const ed = await rejects(S.updatePaymentProofSchedule(p.id, input(1, { date: '2026-11-13', time: '10:00' }), { db, storage, now: at(2 * H), actorId: ADMIN }));
  ok('edit → NOT_EDITABLE', ed?.code === 'NOT_EDITABLE');
  const adm = await S.listPaymentProofsAdmin({ db, now: at(2 * H) });
  ok('admin list: CANCELLED, removed=true, onSlider=false; counts.REMOVED 1, CANCELLED 1', adm.items[0]?.status === 'CANCELLED' && adm.items[0].removed === true
    && adm.items[0].onSlider === false && adm.counts.REMOVED === 1 && adm.counts.CANCELLED === 1);
  const again = await S.removePaymentProof(p.id, { db, now: at(3 * H), actorId: ADMIN2 });
  ok('idempotent: second removal → alreadyRemoved, one REMOVE event', again.alreadyRemoved === true && events(db, p.id, 'REMOVE').length === 1 && again.proof.removedBy === ADMIN);
}
{
  // FAILED → CANCELLED + REMOVE
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 1);
  storage.lose(rowOf(db, p.id).fileKey);
  const t = await tickAt(db, storage, TS);
  ok('setup: the proof failed at publication (receipt missing)', t.failed === 1 && rowOf(db, p.id).status === 'FAILED');
  const out = await S.removePaymentProof(p.id, { db, now: at(DAY + H), actorId: ADMIN });
  const ev = events(db, p.id, 'REMOVE');
  ok('remove FAILED → CANCELLED + REMOVE {previousStatus FAILED, cancelled true}', out.alreadyRemoved === false && rowOf(db, p.id).status === 'CANCELLED'
    && ev.length === 1 && ev[0].details.previousStatus === 'FAILED' && ev[0].details.cancelled === true && events(db, p.id, 'FAIL').length === 1);
}
{
  // Expired proof removal
  const { db, storage } = fresh();
  const outP = await S.createPaymentProof(input(1, { publishMode: 'now' }), fileOf('e1'), { db, storage, now: T0, clock: () => T0, actorId: ADMIN });
  const id = outP.proof.id;
  const R = at(80 * H); // > 72 h: expired
  ok('setup: proof expired (not in the feed)', !(await feedNames(db, R)).includes('Client 1'));
  const out = await S.removePaymentProof(id, { db, now: R, actorId: ADMIN });
  const ev = events(db, id, 'REMOVE');
  ok('removing an expired proof works: REMOVE {previousStatus PUBLISHED, cancelled false, wasVisible false}', out.alreadyRemoved === false && ev.length === 1
    && JSON.stringify(ev[0].details) === JSON.stringify({ previousStatus: 'PUBLISHED', cancelled: false, wasVisible: false }));
  const evs = await S.listPaymentProofEvents(id, { db });
  const adm = await S.listPaymentProofsAdmin({ db, now: R });
  ok('…and it stays in the history (full event list, admin list removed=true, status PUBLISHED)',
    evs.events.map((e) => e.action).join() === 'CREATE,CONFIRM_PRIVACY,CONFIRM_AUTHENTICITY,PUBLISH,REMOVE'
    && adm.items[0]?.id === id && adm.items[0].removed === true && adm.items[0].status === 'PUBLISHED');
}
{
  // Errors
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 1);
  const nEv = db._tables.paymentProofEvent.length;
  const e1 = await rejects(S.removePaymentProof('p-unknown-123', { db, now: T0, actorId: ADMIN }));
  const e2 = await rejects(S.removePaymentProof('../etc/passwd', { db, now: T0, actorId: ADMIN }));
  const e3 = await rejects(S.removePaymentProof(p.id, { db, now: T0 }));
  const e4 = await rejects(S.removePaymentProof(p.id, { db, now: T0, actorId: '' }));
  ok('unknown id → NOT_FOUND; malformed id → NOT_FOUND', e1?.code === 'NOT_FOUND' && e2?.code === 'NOT_FOUND');
  ok('missing actor → UNAUTHORIZED', e3?.code === 'UNAUTHORIZED' && e4?.code === 'UNAUTHORIZED');
  ok('…nothing written (no event, proof still SCHEDULED)', db._tables.paymentProofEvent.length === nEv && rowOf(db, p.id).status === 'SCHEDULED');
  // Route act
  const h = handlers(db, storage, () => at(H)).admin;
  const act = (id, body, user = { userId: ADMIN }) => h.act(jreq(`/api/admin/payment-proofs/${id}`, 'POST', body), ctx({ id }), user);
  const r1 = await act(p.id, { action: 'remove' });
  const b1 = await bodyOf(r1);
  ok('route act {action:"remove"} → 200 { proof.removed, alreadyRemoved: false }', r1.status === 200 && b1.alreadyRemoved === false && b1.proof?.removed === true
    && b1.proof.removedBy === ADMIN && b1.proof.status === 'CANCELLED');
  const r2 = await act(p.id, { action: 'remove' });
  ok('route act remove again → 200 { alreadyRemoved: true }', r2.status === 200 && (await bodyOf(r2)).alreadyRemoved === true && events(db, p.id, 'REMOVE').length === 1);
  const r3 = await act(p.id, { action: 'bogus' });
  ok('route act unknown action → 400 INVALID_INPUT', r3.status === 400 && (await bodyOf(r3)).code === 'INVALID_INPUT');
  const r4 = await act('p-unknown-123', { action: 'remove' });
  ok('route act remove unknown id → 404 NOT_FOUND', r4.status === 404 && (await bodyOf(r4)).code === 'NOT_FOUND');
  const r5 = await act(p.id, { action: 'remove' }, null);
  ok('route act remove without an admin identity → 401', r5.status === 401);
}

// ── 8. Removal vs expiration; nothing deleted ────────────────────────────────
console.log('\n8. Removal is separate from expiration; nothing is ever deleted');
{
  const { db, storage } = fresh();
  const mk = async (tag, pubAt) => (await S.createPaymentProof(input(tag, { publishMode: 'now' }), fileOf(tag), { db, storage, now: pubAt, clock: () => pubAt, actorId: ADMIN })).proof.id;
  const idE = await mk('E', at(-100 * H)); // expired (72 h)
  const idR = await mk('R', at(-H));       // will be removed (not expired)
  const idV = await mk('V', at(-H));       // visible
  const now = T0;
  const nRows = db._tables.paymentProof.length;
  const nEv = db._tables.paymentProofEvent.length;
  await S.removePaymentProof(idR, { db, now, actorId: ADMIN });
  const feed = await feedNames(db, now);
  ok('feed: removed-but-not-expired hidden, expired-not-removed hidden, the other visible', JSON.stringify(feed) === JSON.stringify(['Client V']));
  const adm = await S.listPaymentProofsAdmin({ db, now });
  const by = (id) => adm.items.find((x) => x.id === id);
  ok('admin: removed (not expired) → removed=true onSlider=false; expired (not removed) → removed=false onSlider=false; visible → onSlider=true',
    by(idR).removed === true && by(idR).onSlider === false && by(idE).removed === false && by(idE).onSlider === false && by(idE).removedAt === null
    && by(idV).removed === false && by(idV).onSlider === true);
  ok('expired proof keeps its own visibleUntil (publishedAt + 72 h) and status PUBLISHED', by(idE).status === 'PUBLISHED' && by(idE).visibleUntil === new Date(+at(-100 * H) + 72 * H).toISOString());
  ok('no row deleted; events only appended (+1 REMOVE)', db._tables.paymentProof.length === nRows && db._tables.paymentProofEvent.length === nEv + 1);
  const del = await rejects(db.paymentProof.delete({ where: { id: idR } }));
  const delM = await rejects(db.paymentProof.deleteMany({ where: {} }));
  const evDel = await rejects(db.paymentProofEvent.deleteMany({ where: {} }));
  ok('the fake db refuses deletes (payment_proofs / payment_proof_events), rows intact', !!del && !!delM && !!evDel && db._tables.paymentProof.length === nRows);
  ok('removePaymentProof never calls a delete (no paymentProof / paymentProofEvent delete in the db log)',
    !db._log.some((l) => /delete/i.test(l.op || '')));
  const src = read('../src/lib/services/paymentProofService.js');
  const body = src.slice(src.indexOf('export async function removePaymentProof'), src.indexOf('export async function listVisiblePaymentProofs'));
  ok('static: removePaymentProof source has no delete / deleteMany / storage.remove call', body.length > 100 && !/\.delete(Many)?\s*\(/.test(body) && !/storage\./.test(body));
}

// ── 9. The worker can never publish a removed proof ──────────────────────────
console.log('\n9. A removed proof is never published (service check + trigger emulation)');
{
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 1);
  // emulate a bug: a REMOVE event exists but the proof was left SCHEDULED
  db._tables.paymentProofEvent.push({ id: randomUUID(), seq: 999n, proofId: p.id, action: 'REMOVE', actor: ADMIN, at: T0, details: null });
  ok('publishOnePaymentProof (worker, due) → "skipped", proof still SCHEDULED', (await W.publishOnePaymentProof(p.id, { db, storage, now: TS })) === 'skipped'
    && rowOf(db, p.id).status === 'SCHEDULED');
  ok('publishOnePaymentProof (immediate) → "skipped"', (await W.publishOnePaymentProof(p.id, { db, storage, now: at(MIN), immediate: true, actor: ADMIN })) === 'skipped');
  const t = await tickAt(db, storage, TS);
  ok('worker tick at its time: due 1, published 0', t.due === 1 && t.published === 0 && t.raced === 1 && events(db, p.id, 'PUBLISH').length === 0);
  const pn = await rejects(S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(MIN), actorId: ADMIN }));
  ok('"Publier maintenant" → NOT_PUBLISHABLE', pn?.code === 'NOT_PUBLISHABLE');
  const direct = await rejects(db.paymentProof.updateMany({ where: { id: p.id, status: 'SCHEDULED' }, data: { status: 'PUBLISHED', publishedAt: TS } }));
  ok('a direct UPDATE to PUBLISHED throws payment_proofs_no_publish_removed (trigger emulation)', direct?.meta?.constraint === 'payment_proofs_no_publish_removed'
    && rowOf(db, p.id).status === 'SCHEDULED' && rowOf(db, p.id).publishedAt === null);
  ok('not in the feed', (await feedNames(db, new Date(+TS + H))).length === 0);
}
{
  // REMOVE appears AFTER the publisher's own check but BEFORE its UPDATE → the trigger refuses, the tx rolls back.
  const { db, storage } = fresh();
  const p = await scheduled(db, storage, 1);
  const sneaky = { ...storage, exists: async (k) => {
    if (!events(db, p.id, 'REMOVE').length) db._tables.paymentProofEvent.push({ id: randomUUID(), seq: 998n, proofId: p.id, action: 'REMOVE', actor: ADMIN, at: T0, details: null });
    return storage.exists(k);
  } };
  const e = await rejects(W.publishOnePaymentProof(p.id, { db, storage: sneaky, now: TS }));
  ok('REMOVE written between the publisher check and its UPDATE → the trigger refuses, nothing published (rollback)',
    e?.meta?.constraint === 'payment_proofs_no_publish_removed' && rowOf(db, p.id).status === 'SCHEDULED' && events(db, p.id, 'PUBLISH').length === 0);
}

// ── 10. Concurrency ──────────────────────────────────────────────────────────
console.log('\n10. Concurrency: removal racing publication / another removal');
/** Invariants after any race involving a removal. Returns a list of violations. */
async function checkRemovedInvariants(db, storage, id) {
  const v = [];
  const r = rowOf(db, id);
  const rem = events(db, id, 'REMOVE'), pubs = events(db, id, 'PUBLISH');
  if (rem.length !== 1) v.push(`REMOVE events ${rem.length}`);
  if (pubs.length > 1) v.push(`PUBLISH events ${pubs.length}`);
  if (r.status === 'PUBLISHED') {
    if (pubs.length !== 1) v.push('PUBLISHED without PUBLISH');
    if (rem[0]?.details?.cancelled !== false || rem[0]?.details?.previousStatus !== 'PUBLISHED') v.push('bad REMOVE details (published)');
    const probe = [new Date(+r.publishedAt), new Date(+r.publishedAt + H), new Date(+r.visibleUntil - 1)];
    for (const t of probe) {
      if ((await feedNames(db, t)).length) v.push(`visible at ${t.toISOString()}`);
      if ((await imageAt(db, storage, r.publicToken, t)) !== 'NOT_FOUND') v.push(`image at ${t.toISOString()}`);
    }
  } else if (r.status === 'CANCELLED') {
    if (pubs.length !== 0) v.push('CANCELLED with PUBLISH');
    if (rem[0]?.details?.cancelled !== true) v.push('bad REMOVE details (cancelled)');
  } else v.push(`status ${r.status}`);
  return v;
}
{
  // remove vs worker tick
  let bad = [], pubThenRemoved = 0, cancelled = 0;
  for (let k = 0; k < 20; k++) {
    const { db, storage } = fresh();
    const p = await scheduled(db, storage, k);
    const due = new Date(+TS + MIN);
    const worker = () => tickAt(db, storage, due).catch((e) => e);
    const remover = () => S.removePaymentProof(p.id, { db, now: new Date(+due + 1_000), actorId: ADMIN }).catch((e) => e);
    const [tick, rem] = k % 2 ? await Promise.all([late(k, worker), remover()]) : await Promise.all([worker(), late(k, remover)]);
    const v = await checkRemovedInvariants(db, storage, p.id);
    if (tick instanceof Error || tick.errors !== 0) v.push(`tick error ${tick?.message ?? tick.errors}`);
    if (rem instanceof Error) v.push(`remove threw ${rem.code || rem.message}`);
    else if (rem.alreadyRemoved !== false || rem.proof.removed !== true || rem.proof.onSlider !== false) v.push('bad remove result');
    if (v.length) bad.push(`k${k}: ${v.join('; ')}`); else if (rowOf(db, p.id).status === 'PUBLISHED') pubThenRemoved++; else cancelled++;
  }
  ok(`remove vs worker tick: always consistent, both orders seen (published-then-removed ${pubThenRemoved}, cancelled ${cancelled} of 20)`,
    bad.length === 0 && pubThenRemoved > 0 && cancelled > 0, bad.join(' | '));
}
{
  // remove vs "Publier maintenant"
  let bad = [], pubThenRemoved = 0, cancelled = 0;
  for (let k = 0; k < 20; k++) {
    const { db, storage } = fresh();
    const p = await scheduled(db, storage, k);
    const pubCall = () => S.publishPaymentProofNow(p.id, { db, storage, clock: () => at(MIN), actorId: ADMIN }).catch((e) => e);
    const remCall = () => S.removePaymentProof(p.id, { db, now: at(MIN + 1_000), actorId: ADMIN2 }).catch((e) => e);
    const [pub, rem] = k % 2 ? await Promise.all([late(k, pubCall), remCall()]) : await Promise.all([pubCall(), late(k, remCall)]);
    const v = await checkRemovedInvariants(db, storage, p.id);
    const st = rowOf(db, p.id).status;
    if (rem instanceof Error) v.push(`remove threw ${rem.code || rem.message}`);
    if (st === 'PUBLISHED' && !(pub?.publication?.status === 'PUBLISHED')) v.push(`publish result ${pub?.code ?? JSON.stringify(pub?.publication)}`);
    if (st === 'CANCELLED' && pub?.code !== 'NOT_PUBLISHABLE') v.push(`publish should be NOT_PUBLISHABLE, got ${pub?.code ?? 'success'}`);
    if (v.length) bad.push(`k${k}: ${v.join('; ')}`); else if (st === 'PUBLISHED') pubThenRemoved++; else cancelled++;
  }
  ok(`remove vs "Publier maintenant": always consistent, both orders seen (published-then-removed ${pubThenRemoved}, cancelled ${cancelled} of 20)`,
    bad.length === 0 && pubThenRemoved > 0 && cancelled > 0, bad.join(' | '));
}
{
  // remove vs remove (two admins), on a PUBLISHED proof and on a SCHEDULED proof
  for (const kind of ['PUBLISHED', 'SCHEDULED']) {
    let bad = [], w1 = 0, w2 = 0;
    for (let k = 0; k < 14; k++) {
      const { db, storage } = fresh();
      const id = kind === 'PUBLISHED'
        ? (await S.createPaymentProof(input(k, { publishMode: 'now' }), fileOf(`rr${k}`), { db, storage, now: T0, clock: () => T0, actorId: ADMIN })).proof.id
        : (await scheduled(db, storage, k)).id;
      const a = () => S.removePaymentProof(id, { db, now: at(H), actorId: ADMIN }).catch((e) => e);
      const b = () => S.removePaymentProof(id, { db, now: at(H + 1_000), actorId: ADMIN2 }).catch((e) => e);
      const [ra, rb] = k % 2 ? await Promise.all([late(k, a), b()]) : await Promise.all([a(), late(k, b)]);
      const v = await checkRemovedInvariants(db, storage, id);
      if (ra instanceof Error || rb instanceof Error) v.push(`threw ${(ra instanceof Error ? ra : rb).code || (ra instanceof Error ? ra : rb).message}`);
      else {
        const winners = [ra, rb].filter((x) => x.alreadyRemoved === false);
        if (winners.length !== 1) v.push(`winners ${winners.length}`);
        const by = events(db, id, 'REMOVE')[0]?.actor;
        if (ra.proof.removedBy !== by || rb.proof.removedBy !== by) v.push('removedBy differs from the stored REMOVE');
        if (by === ADMIN) w1++; else w2++;
      }
      if (rowOf(db, id).status !== (kind === 'PUBLISHED' ? 'PUBLISHED' : 'CANCELLED')) v.push(`status ${rowOf(db, id).status}`);
      if (v.length) bad.push(`k${k}: ${v.join('; ')}`);
    }
    ok(`remove vs remove (two admins) on a ${kind} proof: one REMOVE, one winner, the other alreadyRemoved, no error (admin-1 ${w1}, admin-2 ${w2} of 14)`,
      bad.length === 0 && w1 > 0 && w2 > 0, bad.join(' | '));
  }
}
{
  // three-way: worker + "Publier maintenant" + remove
  let bad = [];
  for (let k = 0; k < 14; k++) {
    const { db, storage } = fresh();
    const p = await scheduled(db, storage, k);
    const calls = [
      () => tickAt(db, storage, TS).catch((e) => e),
      () => S.publishPaymentProofNow(p.id, { db, storage, clock: () => new Date(+TS + 500), actorId: ADMIN }).catch((e) => e),
      () => S.removePaymentProof(p.id, { db, now: new Date(+TS + 1_000), actorId: ADMIN2 }).catch((e) => e),
    ];
    const res = await Promise.all(calls.map((fn, i) => late(k + 2 * i, fn)));
    const v = await checkRemovedInvariants(db, storage, p.id);
    if (res[0] instanceof Error || res[0].errors) v.push('tick error');
    if (res[2] instanceof Error) v.push(`remove threw ${res[2].code}`);
    if (res[1] instanceof Error && !['NOT_PUBLISHABLE'].includes(res[1].code)) v.push(`publish now threw ${res[1].code || res[1].message}`);
    if (v.length) bad.push(`k${k}: ${v.join('; ')}`);
  }
  ok('worker + "Publier maintenant" + remove at once: consistent end state, at most one PUBLISH, one REMOVE, only well-defined errors', bad.length === 0, bad.join(' | '));
}

// ── 11. Migration SQL ────────────────────────────────────────────────────────
console.log('\n11. Migration 20261114_payment_proof_display_controls: additive only');
{
  const raw = read('../prisma/migrations/20261114_payment_proof_display_controls/migration.sql');
  const sql = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n'); // comments stripped
  ok('no DROP TABLE / DROP COLUMN / DROP INDEX / TRUNCATE', !/DROP\s+TABLE/i.test(sql) && !/DROP\s+COLUMN/i.test(sql) && !/DROP\s+INDEX/i.test(sql) && !/TRUNCATE/i.test(sql));
  ok('no DELETE / UPDATE … SET / INSERT statements (no row touched)', !/\bDELETE\s+FROM\b/i.test(sql) && !/\bUPDATE\s+"?\w+"?\s+SET\b/i.test(sql) && !/\bINSERT\s+INTO\b/i.test(sql));
  ok('no ALTER COLUMN (existing columns unchanged); only ADD COLUMN IF NOT EXISTS for visibleHours / visibleUntil',
    !/ALTER\s+COLUMN/i.test(sql) && (sql.match(/ADD\s+COLUMN/gi) || []).length === 2
    && /ADD COLUMN IF NOT EXISTS "visibleHours" INTEGER/.test(sql) && /ADD COLUMN IF NOT EXISTS "visibleUntil" TIMESTAMP\(3\)/.test(sql));
  const drops = [...sql.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)];
  const addV2 = sql.search(/ADD\s+CONSTRAINT\s+"payment_proof_events_action_check_v2"/);
  ok('the only DROP CONSTRAINT is the old "payment_proof_events_action_check", AFTER the v2 ADD CONSTRAINT',
    drops.length === 1 && drops[0][1] === 'payment_proof_events_action_check' && addV2 >= 0 && drops[0].index > addV2);
  const dropTrig = [...sql.matchAll(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)].map((m) => m[1]);
  ok('DROP TRIGGER only for the new "payment_proofs_no_publish_removed"', dropTrig.length === 1 && dropTrig[0] === 'payment_proofs_no_publish_removed');
  ok('the existing payment_proofs_guard function / trigger is not redefined', !/payment_proofs_guard/i.test(sql));
  ok('the append-only events trigger is not touched (no trigger on payment_proof_events)', !/TRIGGER[^;]*ON\s+"payment_proof_events"/i.test(sql));
  const oldSql = read('../prisma/migrations/20261104_payment_proofs/migration.sql');
  const listOf = (s, name) => {
    const m = new RegExp(`"${name}"\\s*CHECK\\s*\\(\\s*"action"\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(s);
    return m ? [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]) : [];
  };
  const oldActions = listOf(oldSql, 'payment_proof_events_action_check');
  const newActions = listOf(sql, 'payment_proof_events_action_check_v2');
  ok('the v2 action CHECK is a superset: all 7 old actions + REMOVE (and nothing else)', oldActions.length === 7
    && oldActions.every((a) => newActions.includes(a)) && newActions.includes('REMOVE') && newActions.length === 8,
    JSON.stringify({ oldActions, newActions }));
  ok('…and matches the actions the code knows (PROOF_EVENT_ACTIONS)', JSON.stringify([...newActions].sort()) === JSON.stringify([...P.PROOF_EVENT_ACTIONS].sort()));
  ok('visibility CHECK: both-or-none, PUBLISHED only, 1..8760, visibleUntil = publishedAt + hours',
    /"payment_proofs_visibility_check"/.test(sql) && /BETWEEN 1 AND 8760/.test(sql) && /"visibleUntil" = "publishedAt" \+ make_interval\(hours => "visibleHours"\)/.test(sql)
    && /\("visibleHours" IS NULL\) = \("visibleUntil" IS NULL\)/.test(sql));
  ok('partial unique index: one REMOVE per proof', /CREATE UNIQUE INDEX IF NOT EXISTS "payment_proof_events_remove_once_key"\s+ON "payment_proof_events"\("proofId"\) WHERE "action" = 'REMOVE'/.test(sql));
  ok('trigger payment_proofs_no_publish_removed: BEFORE UPDATE ON payment_proofs, refuses → PUBLISHED when a REMOVE event exists',
    /CREATE TRIGGER "payment_proofs_no_publish_removed" BEFORE UPDATE ON "payment_proofs"/.test(sql)
    && /NEW\."status" = 'PUBLISHED'/.test(sql) && /e\."action" = 'REMOVE'/.test(sql) && /RAISE EXCEPTION/.test(sql));
  ok('re-runnable: IF NOT EXISTS / duplicate_object / CREATE OR REPLACE; no explicit transaction',
    (sql.match(/duplicate_object/g) || []).length === 2 && /CREATE OR REPLACE FUNCTION payment_proofs_no_publish_removed/.test(sql)
    && !/^\s*(BEGIN|COMMIT)\s*;/im.test(sql));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
