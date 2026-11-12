#!/usr/bin/env node
/**
 * scripts/adminDisplayNames.test.mjs — admin display names in the audit / history views of
 * Dashboard Admin Controls (payment-proof history, "Supprimée par", the display-duration history,
 * the "Recharge de solde des Affiliés" switch).
 *
 *   1. resolveAdminNames: id → name, e-mail actor → name, worker label, fallbacks, one batched
 *      read selecting only id / email / name, lookup error → fallbacks, control characters cleaned
 *   2. Payment-proof history (listPaymentProofEvents + the admin route): actorName per event,
 *      stored events unchanged, no e-mail in the response
 *   3. "Supprimer": removedByName in the remove result and in the admin list
 *   4. Display-duration setting: updatedByName / history[].byName (+ conflict view); stored row unchanged
 *   5. Recharge switch: the same
 *   6. Admin UI (static): names shown, never the raw id
 *
 * In-memory fakes only — never a real database. Run: node scripts/adminDisplayNames.test.mjs
 */
process.env.JWT_SECRET = process.env.JWT_SECRET_TEST_ONLY || 'admin-names-test-secret-not-real';

import { readFileSync } from 'node:fs';
import { makePaymentProofFakeDb, makeProofMemStorage, makeFakeLock, pngBytes } from './lib/paymentProofFakeDb.mjs';

const N = await import('../src/lib/services/adminNameService.js');
const S = await import('../src/lib/services/paymentProofService.js');
const W = await import('../src/lib/services/paymentProofPublisher.js');
const ST = await import('../src/lib/services/paymentProofSettingsService.js');
const R = await import('../src/lib/services/rechargeFeatureService.js');
const { adminPaymentProofHandlers } = await import('../src/lib/paymentProofRouteHandlers.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const T0 = new Date('2026-11-11T09:00:00.000Z');
const USERS = [
  { id: 'adm-1', email: 'salma@example.test', name: 'Salma Admin', role: 'ADMIN', password: 'hash-never-read' },
  { id: 'adm-2', email: 'karim@example.test', name: '  Karim \u0007 B. ', role: 'ADMIN', password: 'hash-never-read' },
  { id: 'adm-3', email: 'noname@example.test', name: '   ', role: 'ADMIN', password: 'hash-never-read' },
];
const fresh = () => ({ db: makePaymentProofFakeDb({ affiliates: [{ id: 'a1' }], users: USERS }), storage: makeProofMemStorage() });
const input = (i, over = {}) => ({ displayName: `Client ${i}`, amount: '1500', clientRef: `ref-an-${i}-abcdef`, privacyConfirmed: true, authenticityConfirmed: true, ...over });
const fileOf = (tag) => { const b = pngBytes(tag); return { buffer: b, mime: 'image/png', size: b.length }; };
const noEmail = (v) => !/@example\.test/.test(JSON.stringify(v));

// ── 1. resolveAdminNames ──────────────────────────────────────────────────────
console.log('1. resolveAdminNames');
{
  const calls = [];
  const db = { user: { async findMany(args) { calls.push(args); return USERS.filter((u) => args.where.OR.some((c) => (c.id && c.id.in.includes(u.id)) || (c.email && c.email.in.includes(u.email)))).map((u) => ({ id: u.id, email: u.email, name: u.name })); } } };
  const m = await N.resolveAdminNames(['adm-1', 'adm-1', 'karim@example.test', 'adm-3', 'ghost-id', 'worker:payment-proofs-publisher', null, '', undefined], { db });
  ok('id → the account name', m.get('adm-1') === 'Salma Admin');
  ok('e-mail actor (old tokens) → the account name, never the e-mail', m.get('karim@example.test') === 'Karim B.');
  ok('control characters / extra spaces cleaned', m.get('karim@example.test') === 'Karim B.');
  ok('empty name → "Administrateur"', m.get('adm-3') === N.ADMIN_NAME_FALLBACK && N.ADMIN_NAME_FALLBACK === 'Administrateur');
  ok('unknown / deleted account → "Administrateur"', m.get('ghost-id') === 'Administrateur');
  ok('publication worker → "Publication automatique" (no lookup for it)', m.get('worker:payment-proofs-publisher') === 'Publication automatique');
  ok('null / empty actors ignored; one label per distinct actor', m.size === 5 && !m.has('') && !m.has(null));
  ok('ONE batched read, selecting only id / email / name (never password, role, …)',
    calls.length === 1 && JSON.stringify(calls[0].select) === JSON.stringify({ id: true, email: true, name: true }));
  ok('the lookup excludes the worker tag', !JSON.stringify(calls[0].where).includes('worker:'));
  ok('no labels contain an e-mail', noEmail([...m.values()]));
  const broken = await N.resolveAdminNames(['adm-1'], { db: { user: { findMany: async () => { throw new Error('db down'); } } } });
  ok('lookup error → fallback, never throws', broken.get('adm-1') === 'Administrateur');
  const noModel = await N.resolveAdminNames(['adm-1'], { db: {} });
  ok('no user model available → fallback', noModel.get('adm-1') === 'Administrateur');
  const none = await N.resolveAdminNames([], { db: { user: { findMany: async () => { throw new Error('must not be called'); } } } });
  ok('nothing to resolve → no query', none.size === 0);
  ok('nameOf: null actor → null; unknown → fallback', N.nameOf(m, null) === null && N.nameOf(new Map(), 'x') === 'Administrateur');
  const long = await N.resolveAdminNames(['l'], { db: { user: { findMany: async () => [{ id: 'l', email: 'l@x.y', name: 'A'.repeat(300) }] } } });
  ok('very long names are capped (80 chars)', long.get('l').length === 80);
}

// ── 2. Payment-proof history ──────────────────────────────────────────────────
console.log('\n2. Payment-proof history: actorName per event');
{
  const { db, storage } = fresh();
  const p = (await S.createPaymentProof(input(1, { date: '2026-11-12', time: '10:00' }), fileOf('h1'), { db, storage, now: T0, actorId: 'adm-1' })).proof;
  await S.updatePaymentProofSchedule(p.id, { date: '2026-11-12', time: '11:00', privacyConfirmed: true, authenticityConfirmed: true }, { db, storage, now: T0, actorId: 'karim@example.test' });
  await W.runPaymentProofPublishTick({ db, storage, lock: makeFakeLock(), now: () => new Date('2026-11-12T11:00:00Z') });
  const before = JSON.stringify(db._tables.paymentProofEvent, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  const { events } = await S.listPaymentProofEvents(p.id, { db });
  const byAction = (a) => events.filter((e) => e.action === a);
  ok('CREATE by the admin id → her name', byAction('CREATE')[0].actorName === 'Salma Admin' && byAction('CREATE')[0].actor === 'adm-1');
  ok('EDIT by an e-mail actor → the name (stored actor kept as is)', byAction('EDIT')[0].actorName === 'Karim B.' && byAction('EDIT')[0].actor === 'karim@example.test');
  ok('PUBLISH by the worker → "Publication automatique"', byAction('PUBLISH')[0].actorName === 'Publication automatique');
  ok('every event has a label', events.every((e) => typeof e.actorName === 'string' && e.actorName.length > 0));
  ok('stored events unchanged by reading the history', JSON.stringify(db._tables.paymentProofEvent, (k, v) => (typeof v === 'bigint' ? String(v) : v)) === before);
  ok('one users read for the whole history', db._log.filter((l) => l.model === 'user').length === 1);
  const h = adminPaymentProofHandlers({ db, storage, now: () => T0 });
  const res = await h.events(new Request('http://x/api/admin/payment-proofs/x/events'), { params: Promise.resolve({ id: p.id }) }, { userId: 'adm-1', role: 'ADMIN' });
  const body = await res.json();
  ok('admin route: 200 with actorName on each event', res.status === 200 && body.events.length === events.length && body.events.every((e) => e.actorName));
  ok('admin route adds no e-mail of any account (only the stored actor value itself)',
    !JSON.stringify(body.events.map(({ actor, ...rest }) => rest)).includes('@example.test'));
}

// ── 3. "Supprimer": removedByName ────────────────────────────────────────────
console.log('\n3. Removal: removedByName');
{
  const { db, storage } = fresh();
  const p = (await S.createPaymentProof(input(2, { publishMode: 'now' }), fileOf('r1'), { db, storage, now: T0, clock: () => T0, actorId: 'adm-1' })).proof;
  const out = await S.removePaymentProof(p.id, { db, now: T0, actorId: 'adm-1' });
  ok('remove result: removedBy = stored id, removedByName = the name', out.proof.removedBy === 'adm-1' && out.proof.removedByName === 'Salma Admin');
  const list = await S.listPaymentProofsAdmin({ db, now: T0 });
  const item = list.items.find((x) => x.id === p.id);
  ok('admin list: removedByName for the removed proof', item.removed === true && item.removedByName === 'Salma Admin');
  const q = (await S.createPaymentProof(input(3, { publishMode: 'now' }), fileOf('r2'), { db, storage, now: T0, clock: () => T0, actorId: 'adm-1' })).proof;
  await S.removePaymentProof(q.id, { db, now: T0, actorId: 'ghost-admin' });
  const list2 = await S.listPaymentProofsAdmin({ db, now: T0 });
  ok('removed by a deleted account → "Administrateur"', list2.items.find((x) => x.id === q.id).removedByName === 'Administrateur');
  ok('not removed → removedByName null', list2.items.filter((x) => !x.removed).every((x) => x.removedByName === null));
  ok('admin list: one users read per page', db._log.filter((l) => l.model === 'user' && l.op === 'findMany').length >= 1 && noEmail(list2.items));
}

// ── 4. Display-duration setting ───────────────────────────────────────────────
console.log('\n4. Display-duration setting: updatedByName / history[].byName');
{
  const { db } = fresh();
  const d0 = await ST.getPaymentProofDisplaySettings({ db });
  ok('never changed → updatedByName null, empty history', d0.updatedByName === null && d0.history.length === 0);
  const s1 = await ST.savePaymentProofDisplaySettings({ hours: 168, revision: d0.revision }, { db, now: T0, actorId: 'adm-1' });
  const s2 = await ST.savePaymentProofDisplaySettings({ hours: 36, revision: s1.revision }, { db, now: T0, actorId: 'adm-3' });
  ok('save → updatedByName of the saving admin', s1.updatedByName === 'Salma Admin' && s2.updatedByName === 'Administrateur');
  const g = await ST.getPaymentProofDisplaySettings({ db });
  ok('history[].byName (newest first) + stored ids kept', g.history[0].byName === 'Administrateur' && g.history[1].byName === 'Salma Admin' && g.history[1].by === 'adm-1');
  const stored = db._tables.settings.find((x) => x.id === 'payment-proof-display').data;
  ok('stored row holds NO names (unchanged format)', !('updatedByName' in stored) && stored.history.every((h) => !('byName' in h)));
  ok('revision unaffected by the names (save with the GET revision works)', !!(await ST.savePaymentProofDisplaySettings({ hours: 72, revision: g.revision }, { db, now: T0, actorId: 'adm-1' })));
  const e = await rejects(ST.savePaymentProofDisplaySettings({ hours: 168, revision: g.revision }, { db, now: T0, actorId: 'adm-2' }));
  ok('conflict view carries names too', e?.code === 'SETTINGS_CONFLICT' && e.current.updatedByName === 'Salma Admin' && e.current.history.every((h) => h.byName));
  ok('no e-mail in any settings response', noEmail([g, e.current]));
}

// ── 5. Recharge switch ────────────────────────────────────────────────────────
console.log('\n5. Recharge switch: updatedByName / history[].byName');
{
  const rows = new Map();
  const userFind = async (args) => USERS.filter((u) => args.where.OR.some((c) => (c.id && c.id.in.includes(u.id)) || (c.email && c.email.in.includes(u.email)))).map((u) => ({ id: u.id, email: u.email, name: u.name }));
  const setting = {
    findUnique: async ({ where }) => (rows.has(where.id) ? { id: where.id, data: structuredClone(rows.get(where.id)) } : null),
    upsert: async ({ where, update, create }) => { rows.set(where.id, structuredClone(rows.has(where.id) ? update.data : create.data)); return { id: where.id, data: structuredClone(rows.get(where.id)) }; },
  };
  const db = { setting, user: { findMany: userFind }, $transaction: async (fn) => fn({ setting }) };
  const g0 = await R.getRechargeSetting({ db });
  const off = await R.saveRechargeSetting({ enabled: false, revision: g0.revision }, { db, now: T0, actorId: 'adm-1' });
  ok('OFF by Salma → updatedByName "Salma Admin"', off.enabled === false && off.updatedByName === 'Salma Admin' && off.history[0].byName === 'Salma Admin');
  const on = await R.saveRechargeSetting({ enabled: true, revision: off.revision }, { db, now: T0, actorId: 'ghost' });
  ok('ON by a deleted account → "Administrateur"', on.updatedByName === 'Administrateur' && on.history[0].byName === 'Administrateur' && on.history[1].byName === 'Salma Admin');
  const stored = rows.get(R.RECHARGE_SETTING_ID);
  ok('stored switch row holds NO names', !('updatedByName' in stored) && stored.history.every((h) => !('byName' in h)));
  const h = R.rechargeSettingHandlers({ db, now: () => T0 });
  const res = await h.get();
  const body = await res.json();
  ok('admin GET: updatedByName present, no e-mail', res.status === 200 && body.updatedByName === 'Administrateur' && noEmail(body));
}

// ── 6. Admin UI (static) ──────────────────────────────────────────────────────
console.log('\n6. Admin UI shows names, never the raw id');
{
  const list = read('../src/app/admin/payment-proofs/ProofsList.jsx');
  const settings = read('../src/app/admin/payment-proofs/DisplaySettings.jsx');
  const deposits = read('../src/app/admin/deposits/page.jsx');
  ok('history entry shows e.actorName (fallback "Administrateur"), not e.actor', /\{e\.actorName \|\| "Administrateur"\}/.test(list) && !/\{e\.actor\}/.test(list));
  ok('"Supprimée … par" shows removedByName', /par \{p\.removedByName \|\| "Administrateur"\}/.test(list) && !/\{p\.removedBy \|\|/.test(list));
  ok('display-duration card: updatedByName + history byName', /\{settings\.updatedByName \|\| "Administrateur"\}/.test(settings) && /\{h\.byName \|\| "Administrateur"\}/.test(settings)
    && !/\{settings\.updatedBy \|\|/.test(settings) && !/\{h\.by \|\|/.test(settings));
  ok('recharge card: updatedByName, no raw-id monospace span', /\{setting\.updatedByName \|\| "Administrateur"\}/.test(deposits) && !/font-mono">\{setting\.updatedBy\}/.test(deposits));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
