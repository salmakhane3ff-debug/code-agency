#!/usr/bin/env node
/**
 * scripts/rechargeFeatureFlag.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin ON/OFF switch "Recharge de solde des Affiliés" (settings row 'affiliate-recharge').
 * Proves:
 *   • default ON (no row / malformed row); OFF only for data.enabled === false
 *   • admin save: revisioned + advisory lock, history (who / when / from → to), input
 *     validation, conflicts (stale revision, two concurrent saves), actor required;
 *     GET / PUT handler status codes and JSON shape
 *   • submitDeposit: OFF → DEPOSIT_DISABLED before anything is stored; ON → as before;
 *     switch flipped OFF between the two checks → refused, stored file removed, no row
 *   • POST /api/affiliate/deposits maps DEPOSIT_DISABLED → 403 featureDisabled (static: the
 *     route imports '@/lib/...' aliases, not resolvable by plain node)
 *   • balances, history and admin approve / reject unchanged while OFF; reactivation restores
 *   • Create Your Own Brand request + payment proof unaffected while OFF (real services and
 *     route handlers on the brand fake db), and no brand module imports the switch
 *   • affiliate dashboard / BoosterTab gating (static), FR + AR texts, reserved setting type
 * In-memory fakes only — no real database, no network.
 * Run: node scripts/rechargeFeatureFlag.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  RECHARGE_SETTING_ID, RECHARGE_HISTORY_MAX, rechargeEnabledOf, rechargeRevision, isRechargeEnabled, isRechargeEnabledForDisplay,
  getRechargeSetting, saveRechargeSetting, rechargeSettingHandlers,
} from '../src/lib/services/rechargeFeatureService.js';
import {
  submitDeposit, getDepositSummary, getAffiliateDeposits, getDepositBalance, getPendingDepositTotal,
  adminApproveDeposit, adminRejectDeposit, adminListDeposits,
} from '../src/lib/services/depositService.js';
import { requestBrandAccess } from '../src/lib/services/brandAccessService.js';
import { submitPaymentProof } from '../src/lib/services/brandPaymentService.js';
import { affiliateBrandHandlers } from '../src/lib/brandRouteHandlers.js';
import { BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID } from '../src/lib/brandProgram.js';
import { SERVER_CODES, localizeServerError } from '../src/lib/serverText/affiliateServerText.js';
import { AFFILIATE_DASHBOARD_TEXT } from '../src/lib/affiliateDashboardI18n.js';
import { makeBrandFakeDb } from './lib/brandFakeDb.mjs';
import { makeProofStorage, proofInput, pngBytes } from './lib/brandProofKit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const clone = (v) => (v == null ? v : structuredClone(v));
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

const NOW = new Date('2026-11-12T09:00:00Z');
const LATER = new Date('2026-11-12T10:30:00Z');

// ── Fake db: settings (with $transaction + advisory lock) + deposits + notifications ──
/**
 * `$transaction` is NOT serialized by itself: only the advisory lock taken through
 * tx.$executeRaw (pg_advisory_xact_lock) makes concurrent saves wait for each other,
 * released when the transaction ends — as in Postgres.
 */
function makeDb({ settings = {}, deposits = [], amount = 500 } = {}) {
  const S = new Map(Object.entries({ 'team-bonus-config': { securityDepositAmount: amount }, ...settings }).map(([k, v]) => [k, clone(v)]));
  const rows = deposits.map((r, i) => ({ id: r.id || `d${i + 1}`, createdAt: new Date(NOW.getTime() - (i + 1) * 1000), reviewedAt: null, proofFile: 'p.jpg', ...r }));
  const notifs = [];
  const log = [];
  const settingReads = [];
  const match = (r, where = {}) => Object.entries(where).every(([k, v]) => r[k] === v);
  let lockTail = Promise.resolve();
  const setting = {
    findUnique: async ({ where }) => { settingReads.push(where.id); await null; return S.has(where.id) ? { id: where.id, data: clone(S.get(where.id)) } : null; },
    upsert: async ({ where, update, create }) => {
      await null;
      S.set(where.id, clone(S.has(where.id) ? update.data : create.data));
      log.push(`setting.upsert:${where.id}`);
      return { id: where.id, data: clone(S.get(where.id)) };
    },
  };
  const affiliateSecurityDeposit = {
    findMany:   async ({ where } = {}) => { log.push('deposit.findMany'); return rows.filter((r) => match(r, where)).map((r) => ({ ...r })); },
    findFirst:  async ({ where }) => { log.push('deposit.findFirst'); const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
    findUnique: async ({ where }) => { log.push('deposit.findUnique'); const r = rows.find((x) => x.id === where.id); return r ? { ...r } : null; },
    create:     async ({ data }) => { log.push('deposit.create'); const r = { id: `d${rows.length + 1}`, createdAt: new Date(), reviewedAt: null, ...data }; rows.push(r); return { ...r }; },
    updateMany: async ({ where, data }) => { log.push('deposit.updateMany'); let count = 0; for (const r of rows) if (match(r, where)) { Object.assign(r, data); count++; } return { count }; },
  };
  const affiliateNotification = { create: async ({ data }) => { notifs.push(data); return data; } };
  const db = {
    _settings: S, _rows: rows, _notifs: notifs, _log: log, _settingReads: settingReads, _locks: [],
    setting, affiliateSecurityDeposit, affiliateNotification,
    async $transaction(fn) {
      let release = null;
      const tx = {
        setting, affiliateSecurityDeposit, affiliateNotification,
        async $executeRaw(strings, ...values) {
          db._locks.push(`${strings.join('?')}|${values.join(',')}`);
          const prev = lockTail;
          lockTail = new Promise((r) => { release = r; });
          await prev;
          return 1;
        },
      };
      try { return await fn(tx); } finally { release?.(); }
    },
  };
  return db;
}
const OFF = { [RECHARGE_SETTING_ID]: { enabled: false } };
const proof = { buffer: Buffer.from('x'), mime: 'image/png', size: 2048 };
const makeStorage = () => {
  const s = { processed: 0, removed: [], keys: [] };
  s.process = async () => { s.processed++; const k = `proof_${s.processed}.jpg`; s.keys.push(k); return k; };
  s.remove = async (k) => { s.removed.push(k); return true; };
  return s;
};
const input = (extra = {}) => ({ amount: '5', paymentMethod: 'Virement', transferReference: 'REF-1', proof, ...extra });

// ── 1. Default ON, OFF only for enabled === false ─────────────────────────────
console.log('1) rechargeEnabledOf / default ON:');
{
  ok('setting id is "affiliate-recharge"', RECHARGE_SETTING_ID === 'affiliate-recharge');
  ok('no row (null / undefined) → ON', rechargeEnabledOf(null) === true && rechargeEnabledOf(undefined) === true);
  ok('malformed rows → ON ("x", 42, [], [false], {})', ['x', 42, [], [false], {}].every((d) => rechargeEnabledOf(d) === true));
  ok('non-boolean enabled → ON ("false", 0, null, "off")', [{ enabled: 'false' }, { enabled: 0 }, { enabled: null }, { enabled: 'off' }].every((d) => rechargeEnabledOf(d) === true));
  ok('{enabled:true} → ON', rechargeEnabledOf({ enabled: true }) === true);
  ok('{enabled:false} → OFF (the only OFF)', rechargeEnabledOf({ enabled: false }) === false && rechargeEnabledOf({ enabled: false, history: [] }) === false);

  ok('isRechargeEnabled: no row → true', (await isRechargeEnabled(makeDb())) === true);
  ok('isRechargeEnabled: malformed row → true', (await isRechargeEnabled(makeDb({ settings: { [RECHARGE_SETTING_ID]: 'garbage' } }))) === true);
  ok('isRechargeEnabled: {enabled:false} → false', (await isRechargeEnabled(makeDb({ settings: OFF }))) === false);
  const broken = { setting: { findUnique: async () => { throw new Error('db down'); } } };
  ok('isRechargeEnabled (enforcement) propagates read errors', (await rejects(isRechargeEnabled(broken)))?.message === 'db down');
  ok('isRechargeEnabledForDisplay: read error → true (default shown)', (await isRechargeEnabledForDisplay(broken)) === true);
  ok('isRechargeEnabledForDisplay: OFF row → false', (await isRechargeEnabledForDisplay(makeDb({ settings: OFF }))) === false);

  const view = await getRechargeSetting({ db: makeDb() });
  ok('getRechargeSetting default view: enabled, isDefault, no history, revision of null',
    view.enabled === true && view.isDefault === true && view.updatedAt === null && view.updatedBy === null
    && Array.isArray(view.history) && view.history.length === 0 && view.revision === rechargeRevision(null));
  const mal = await getRechargeSetting({ db: makeDb({ settings: { [RECHARGE_SETTING_ID]: { enabled: 'false' } } }) });
  ok('malformed stored row → view ON + isDefault', mal.enabled === true && mal.isDefault === true);
}

// ── 2. saveRechargeSetting ────────────────────────────────────────────────────
console.log('2) saveRechargeSetting (history, validation, conflicts, actor):');
{
  const db = makeDb();
  const v0 = await getRechargeSetting({ db });
  const off = await saveRechargeSetting({ enabled: false, revision: v0.revision }, { db, now: NOW, actorId: 'admin-1' });
  ok('OFF saved: enabled false, not default, updatedAt / updatedBy set',
    off.enabled === false && off.isDefault === false && off.updatedAt === NOW.toISOString() && off.updatedBy === 'admin-1');
  // Final fixes: the response adds the admin's display name (byName; this fake db has no users → fallback); the stored entry has none.
  ok('history[0] = { at, by, from:true, to:false } (+ byName in the response only)', off.history.length === 1
    && JSON.stringify(off.history[0]) === JSON.stringify({ at: NOW.toISOString(), by: 'admin-1', from: true, to: false, byName: 'Administrateur' })
    && JSON.stringify(db._settings.get(RECHARGE_SETTING_ID).history[0]) === JSON.stringify({ at: NOW.toISOString(), by: 'admin-1', from: true, to: false }));
  ok('stored row is {enabled:false,…} → enforcement reads OFF', db._settings.get(RECHARGE_SETTING_ID).enabled === false && (await isRechargeEnabled(db)) === false);
  ok('the save took the advisory transaction lock', db._locks.length === 1 && db._locks[0].includes('pg_advisory_xact_lock') && db._locks[0].includes('affiliate-recharge-setting'));
  ok('revision changed', off.revision !== v0.revision && off.revision === (await getRechargeSetting({ db })).revision);

  const on = await saveRechargeSetting({ enabled: true, revision: off.revision }, { db, now: LATER, actorId: 'admin-2' });
  ok('ON again: enabled, updatedBy admin-2', on.enabled === true && on.updatedBy === 'admin-2' && on.updatedAt === LATER.toISOString());
  ok('history newest first: [admin-2 false→true, admin-1 true→false]', on.history.length === 2
    && on.history[0].by === 'admin-2' && on.history[0].from === false && on.history[0].to === true && on.history[0].at === LATER.toISOString()
    && on.history[1].by === 'admin-1' && on.history[1].from === true && on.history[1].to === false);

  for (const [label, bad] of [['string "false"', 'false'], ['0', 0], ['null', null], ['undefined', undefined], ['"true"', 'true']]) {
    const e = await rejects(saveRechargeSetting({ enabled: bad, revision: on.revision }, { db, now: NOW, actorId: 'admin-1' }));
    ok(`enabled ${label} → INVALID_INPUT`, e?.code === 'INVALID_INPUT');
  }
  ok('missing revision → INVALID_INPUT', (await rejects(saveRechargeSetting({ enabled: false }, { db, now: NOW, actorId: 'admin-1' })))?.code === 'INVALID_INPUT');
  ok('invalid inputs wrote nothing', (await getRechargeSetting({ db })).revision === on.revision);

  const stale = await rejects(saveRechargeSetting({ enabled: false, revision: off.revision }, { db, now: NOW, actorId: 'admin-1' }));
  ok('stale revision → SETTINGS_CONFLICT with current view', stale?.code === 'SETTINGS_CONFLICT' && stale.current?.enabled === true && stale.current?.revision === on.revision);
  ok('conflict wrote nothing', (await getRechargeSetting({ db })).history.length === 2);

  ok('missing actor → UNAUTHORIZED', (await rejects(saveRechargeSetting({ enabled: false, revision: on.revision }, { db, now: NOW })))?.code === 'UNAUTHORIZED');
  ok('empty actor → UNAUTHORIZED', (await rejects(saveRechargeSetting({ enabled: false, revision: on.revision }, { db, now: NOW, actorId: '' })))?.code === 'UNAUTHORIZED');

  // Two concurrent saves from the same revision: the lock serializes them → one wins, the other conflicts.
  const db2 = makeDb();
  const rev = (await getRechargeSetting({ db: db2 })).revision;
  const results = await Promise.allSettled([
    saveRechargeSetting({ enabled: false, revision: rev }, { db: db2, now: NOW, actorId: 'admin-A' }),
    saveRechargeSetting({ enabled: true, revision: rev }, { db: db2, now: NOW, actorId: 'admin-B' }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  ok('concurrent saves: exactly one wins', won.length === 1 && lost.length === 1);
  ok('the other gets SETTINGS_CONFLICT with the winner as current', lost[0]?.reason?.code === 'SETTINGS_CONFLICT'
    && lost[0].reason.current?.revision === won[0]?.value?.revision);
  ok('one history entry only', (await getRechargeSetting({ db: db2 })).history.length === 1);

  // History bounded.
  const db3 = makeDb();
  let r = (await getRechargeSetting({ db: db3 })).revision;
  for (let i = 0; i < RECHARGE_HISTORY_MAX + 5; i++) {
    r = (await saveRechargeSetting({ enabled: i % 2 === 1, revision: r }, { db: db3, now: new Date(NOW.getTime() + i * 1000), actorId: `adm-${i}` })).revision;
  }
  const h = (await getRechargeSetting({ db: db3 })).history;
  ok(`history capped at ${RECHARGE_HISTORY_MAX}, newest kept`, h.length === RECHARGE_HISTORY_MAX && h[0].by === `adm-${RECHARGE_HISTORY_MAX + 4}`);
}

// ── 3. Admin route handlers ──────────────────────────────────────────────────
console.log('3) rechargeSettingHandlers GET / PUT:');
{
  const db = makeDb();
  const h = rechargeSettingHandlers({ db, now: () => NOW });
  const put = (body, raw = false) => new Request('http://x/api/admin/affiliate-recharge', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body),
  });
  const g = await h.get(new Request('http://x/api/admin/affiliate-recharge'));
  const gb = await g.json();
  ok('GET → 200, no-store', g.status === 200 && g.headers.get('cache-control') === 'no-store');
  // Final fixes: + updatedByName (admin display name, never the e-mail).
  ok('GET JSON shape { enabled, isDefault, updatedAt, updatedBy, updatedByName, history, revision }',
    JSON.stringify(Object.keys(gb).sort()) === JSON.stringify(['enabled', 'history', 'isDefault', 'revision', 'updatedAt', 'updatedBy', 'updatedByName'])
    && gb.enabled === true && typeof gb.revision === 'string');

  const p = await h.put(put({ enabled: false, revision: gb.revision }), {}, { userId: 'u-admin', email: 'a@x.ma', role: 'ADMIN' });
  const pb = await p.json();
  ok('PUT OFF → 200 with the new view, actor = userId', p.status === 200 && pb.enabled === false && pb.updatedBy === 'u-admin' && pb.history[0].by === 'u-admin');
  const p2 = await h.put(put({ enabled: true, revision: pb.revision }), {}, { email: 'a@x.ma', role: 'ADMIN' });
  ok('PUT with email-only token → actor = email', p2.status === 200 && (await p2.json()).updatedBy === 'a@x.ma');

  const stale = await h.put(put({ enabled: false, revision: pb.revision }), {}, { userId: 'u-admin' });
  const sb = await stale.json();
  ok('PUT stale revision → 409 SETTINGS_CONFLICT + current', stale.status === 409 && sb.code === 'SETTINGS_CONFLICT' && sb.current?.enabled === true && typeof sb.error === 'string');
  const cur = (await (await h.get()).json()).revision;
  const bad = await h.put(put({ enabled: 'false', revision: cur }), {}, { userId: 'u-admin' });
  ok('PUT enabled "false" → 400 INVALID_INPUT', bad.status === 400 && (await bad.json()).code === 'INVALID_INPUT');
  const notJson = await h.put(put('{not json', true), {}, { userId: 'u-admin' });
  ok('PUT invalid JSON → 400 INVALID_INPUT', notJson.status === 400 && (await notJson.json()).code === 'INVALID_INPUT');
  const arr = await h.put(put([true]), {}, { userId: 'u-admin' });
  ok('PUT array body → 400', arr.status === 400);
  const noUser = await h.put(put({ enabled: false, revision: cur }), {}, undefined);
  ok('PUT without an identified admin → 401 UNAUTHORIZED', noUser.status === 401 && (await noUser.json()).code === 'UNAUTHORIZED');
  ok('rejected PUTs wrote nothing', (await (await h.get()).json()).revision === cur);

  const broken = rechargeSettingHandlers({ db: { setting: { findUnique: async () => { throw new Error('db down'); } } } });
  const e = await quiet(() => broken.get());
  ok('GET on a db error → 500 SERVER_ERROR (no internal detail)', e.status === 500 && (await e.json()).code === 'SERVER_ERROR');

  const route = read('src/app/api/admin/affiliate-recharge/route.js');
  ok('route: GET and PUT both wrapped in withAdminAuth', /export const GET = withAdminAuth\(h\.get\)/.test(route) && /export const PUT = withAdminAuth\(h\.put\)/.test(route));
}

// ── 4. submitDeposit vs the switch ───────────────────────────────────────────
console.log('4) submitDeposit with the switch OFF / ON / flipped:');
{
  const db = makeDb({ settings: OFF });
  const st = makeStorage();
  const e = await rejects(submitDeposit('a', input(), db, st));
  ok('OFF → DEPOSIT_DISABLED', e?.code === 'DEPOSIT_DISABLED');
  ok('OFF → storage.process NEVER called', st.processed === 0 && st.removed.length === 0);
  ok('OFF → no row created and no deposit query at all', db._rows.length === 0 && !db._log.some((l) => l.startsWith('deposit.')));

  const dbOn = makeDb({ settings: { [RECHARGE_SETTING_ID]: { enabled: true } } });
  const stOn = makeStorage();
  const r = await submitDeposit('a', input(), dbOn, stOn);
  ok('ON → PENDING request created with the configured amount', r.status === 'PENDING' && r.amount === 500 && dbOn._rows.length === 1);
  ok('ON → file stored once, nothing removed', stOn.processed === 1 && stOn.removed.length === 0 && dbOn._rows[0].proofFile === stOn.keys[0]);
  ok('ON → switch read twice (before storing + before insert)', dbOn._settingReads.filter((id) => id === RECHARGE_SETTING_ID).length === 2);
  ok('no row (default ON) → works as before', (await submitDeposit('a', input(), makeDb(), makeStorage())).status === 'PENDING');
  ok('ON → other rules unchanged (one PENDING at a time)', (await rejects(submitDeposit('a', input(), dbOn, makeStorage())))?.code === 'DEPOSIT_PENDING_EXISTS');

  // Flipped OFF between the two checks.
  const flip = makeDb();
  let n = 0;
  const realFind = flip.setting.findUnique;
  flip.setting.findUnique = async (q) => {
    if (q.where.id === RECHARGE_SETTING_ID) { n++; return n === 1 ? null : { id: RECHARGE_SETTING_ID, data: { enabled: false } }; }
    return realFind(q);
  };
  const stF = makeStorage();
  const eF = await rejects(submitDeposit('a', input(), flip, stF));
  ok('switched OFF during the upload → DEPOSIT_DISABLED', eF?.code === 'DEPOSIT_DISABLED' && n === 2);
  ok('stored file removed, no row', stF.processed === 1 && stF.removed.length === 1 && stF.removed[0] === stF.keys[0] && flip._rows.length === 0);

  // Second read failing → treated as OFF (file removed, no row).
  const flakey = makeDb();
  let m = 0;
  const realFind2 = flakey.setting.findUnique;
  flakey.setting.findUnique = async (q) => {
    if (q.where.id === RECHARGE_SETTING_ID && ++m === 2) throw new Error('db blip');
    return realFind2(q);
  };
  const stK = makeStorage();
  ok('second switch read failing → DEPOSIT_DISABLED, file removed, no row',
    (await rejects(submitDeposit('a', input(), flakey, stK)))?.code === 'DEPOSIT_DISABLED' && stK.removed.length === 1 && flakey._rows.length === 0);

  // First read failing → refused, nothing stored (error propagates, route answers 500).
  const down = makeDb();
  down.setting.findUnique = async () => { throw new Error('db down'); };
  const stD = makeStorage();
  const eD = await rejects(submitDeposit('a', input(), down, stD));
  ok('unreadable switch → refused before storing anything', eD?.message === 'db down' && stD.processed === 0 && down._rows.length === 0);

  ok('DEPOSIT_DISABLED message is a FR sentence', /désactivée/.test(e.message));
}

// ── 5. Route mapping (static) ────────────────────────────────────────────────
console.log('5) POST /api/affiliate/deposits → 403 DEPOSIT_DISABLED (static check):');
{
  const rel = 'src/app/api/affiliate/deposits/route.js';
  let importable = false;
  try { await import(path.join(ROOT, rel)); importable = true; } catch { importable = false; }
  console.log(`  (route module importable by plain node: ${importable ? 'yes' : "no — '@/lib/...' aliases; static source check"})`);
  const src = read(rel);
  const post = src.slice(src.indexOf('async function postHandler'), src.indexOf('export const GET'));
  const m = post.match(/if \(err\.code === 'DEPOSIT_DISABLED'\) \{\s*return Response\.json\(\{([^}]*)\}, \{ status: (\d+) \}\);/);
  ok('DEPOSIT_DISABLED branch present in postHandler', Boolean(m));
  ok('→ status 403', m?.[2] === '403');
  ok('→ body { error, code, featureDisabled: true }', /\berror: err\.message\b/.test(m?.[1] || '') && /\bcode: err\.code\b/.test(m?.[1] || '') && /featureDisabled: true/.test(m?.[1] || ''));
  ok('mapped before the generic 400 / 500 handling', post.indexOf("'DEPOSIT_DISABLED'") < post.indexOf('clientCodes') && post.indexOf("'DEPOSIT_DISABLED'") < post.indexOf('status: 500'));
  ok('DEPOSIT_DISABLED is not in the 400 client codes', !/clientCodes = new Set\(\[[^\]]*DEPOSIT_DISABLED/.test(post));
  const get = src.slice(src.indexOf('async function getHandler'), src.indexOf('async function postHandler'));
  ok('GET (history) does not check the switch', !/isRechargeEnabled|DEPOSIT_DISABLED/.test(get));
  ok('server text: DEPOSIT_DISABLED code has FR + AR', Boolean(SERVER_CODES.DEPOSIT_DISABLED?.fr) && Boolean(SERVER_CODES.DEPOSIT_DISABLED?.ar)
    && localizeServerError({ code: 'DEPOSIT_DISABLED' }, 'ar') === SERVER_CODES.DEPOSIT_DISABLED.ar);
  ok('server text: the service message is recognised in AR', localizeServerError({ error: 'La recharge de solde est désactivée pour le moment.', code: 'DEPOSIT_DISABLED' }, 'ar') === SERVER_CODES.DEPOSIT_DISABLED.ar);
}

// ── 6. Balances, history, admin review while OFF ─────────────────────────────
console.log('6) Balances / history / admin review unchanged while OFF:');
{
  const seed = [
    { id: 'd1', affiliateId: 'a', amount: 300, status: 'APPROVED' },
    { id: 'd2', affiliateId: 'a', amount: 200, status: 'PENDING' },
    { id: 'd3', affiliateId: 'a', amount: 100, status: 'REJECTED', rejectionReason: 'illisible' },
    { id: 'd4', affiliateId: 'b', amount: 400, status: 'PENDING' },
  ];
  const sOn = await getDepositSummary('a', makeDb({ deposits: seed }));
  const sOff = await getDepositSummary('a', makeDb({ deposits: seed, settings: OFF }));
  ok('ON summary = { approvedBalance 300, pendingTotal 200, rechargeEnabled true }', sOn.approvedBalance === 300 && sOn.pendingTotal === 200 && sOn.rechargeEnabled === true);
  ok('OFF summary: same balances, rechargeEnabled false', sOff.approvedBalance === 300 && sOff.pendingTotal === 200 && sOff.rechargeEnabled === false);
  ok('summary keys unchanged', JSON.stringify(Object.keys(sOff).sort()) === JSON.stringify(['approvedBalance', 'pendingTotal', 'rechargeEnabled']));
  const dbBroken = makeDb({ deposits: seed });
  const realFind = dbBroken.setting.findUnique;
  dbBroken.setting.findUnique = async (q) => { if (q.where.id === RECHARGE_SETTING_ID) throw new Error('down'); return realFind(q); };
  const sBroken = await getDepositSummary('a', dbBroken);
  ok('unreadable switch → summary still returned, rechargeEnabled true (display default)', sBroken.approvedBalance === 300 && sBroken.rechargeEnabled === true);

  const db = makeDb({ deposits: seed, settings: OFF });
  const list = await getAffiliateDeposits('a', db);
  ok('OFF: affiliate history still lists every record', list.length === 3 && list.map((d) => d.id).sort().join() === 'd1,d2,d3'
    && list.find((d) => d.id === 'd3').rejectionReason === 'illisible' && list.every((d) => d.hasProof === true));
  ok('OFF: admin list still shows every request', (await adminListDeposits(undefined, db)).length === 4 && (await adminListDeposits('PENDING', db)).length === 2);

  const ap = await adminApproveDeposit('d2', 'admin-1', db);
  ok('OFF: admin approves an earlier PENDING request', ap.ok === true && ap.credited === true);
  ok('OFF: approved balance 300 → 500, pending 200 → 0', (await getDepositBalance('a', db)) === 500 && (await getPendingDepositTotal('a', db)) === 0);
  ok('OFF: approval notification sent', db._notifs.length === 1 && db._notifs[0].affiliateId === 'a');
  const rj = await adminRejectDeposit('d4', 'Preuve illisible', 'admin-1', db);
  ok('OFF: admin rejects an earlier PENDING request', rj.ok === true && rj.changed === true && db._rows.find((r) => r.id === 'd4').status === 'REJECTED');
  ok('OFF: rejection changes no balance', (await getDepositBalance('b', db)) === 0 && (await getPendingDepositTotal('b', db)) === 0);
  ok('OFF: the switch itself was never written by these', db._settings.get(RECHARGE_SETTING_ID).enabled === false && !db._log.some((l) => l.startsWith('setting.upsert')));
}

// ── 7. Reactivation ─────────────────────────────────────────────────────────
console.log('7) OFF → ON restores everything:');
{
  const db = makeDb({ deposits: [{ id: 'd1', affiliateId: 'a', amount: 500, status: 'APPROVED' }, { id: 'd2', affiliateId: 'a', amount: 500, status: 'REJECTED', rejectionReason: 'x' }] });
  const before = clone(db._rows);
  const r0 = (await getRechargeSetting({ db })).revision;
  const off = await saveRechargeSetting({ enabled: false, revision: r0 }, { db, now: NOW, actorId: 'admin-1' });
  ok('OFF: new request refused', (await rejects(submitDeposit('a', input(), db, makeStorage())))?.code === 'DEPOSIT_DISABLED');
  ok('OFF: earlier records untouched', JSON.stringify(db._rows) === JSON.stringify(before));
  await saveRechargeSetting({ enabled: true, revision: off.revision }, { db, now: LATER, actorId: 'admin-1' });
  const st = makeStorage();
  const r = await submitDeposit('a', input(), db, st);
  ok('ON again: submitDeposit works', r.status === 'PENDING' && st.processed === 1 && db._rows.length === 3);
  ok('ON again: earlier records untouched', JSON.stringify(db._rows.slice(0, 2)) === JSON.stringify(before));
  const s = await getDepositSummary('a', db);
  ok('ON again: balances as before + new pending', s.approvedBalance === 500 && s.pendingTotal === 500 && s.rechargeEnabled === true);
}

// ── 8. Create Your Own Brand is not gated ─────────────────────────────────────
console.log('8) Create Your Own Brand unaffected while OFF:');
{
  const PRICING = { deliveryCost: 40, logisticsCost: 10, vatPercent: 20, productCount: 3, productIds: ['prod-1', 'prod-2', 'prod-3'],
    percentages: { confirmation: { value: 60, base: 'SIMULATED_ORDERS' }, advertising: { value: 10, base: 'PACKAGE_PRICE' }, companyShare: { value: 30, base: 'SUBTOTAL' } } };
  const SIM = { enabled: true, startDelayHours: 1, dailyVolumeMin: 2, dailyVolumeMax: 4, confirmationDelayHours: 1, deliveryDelayHours: 24,
    distribution: { delivered: 50, refused: 10, returned: 5, noResponse: 20, cancelled: 15 } };
  const CONFIG = { enabled: true, packages: [{ id: 'p1', name: 'Formation', price: 1000, active: true, features: [], ...PRICING }], brandingOptions: [], simulation: SIM,
    catalogProductIds: ['prod-1', 'prod-2', 'prod-3'] };
  const TERMS = { draft: { text: 'T' }, published: { version: 1, text: 'Conditions', publishedAt: '2026-10-01T00:00:00Z' } };
  const BNOW = new Date('2026-10-28T10:00:00Z');
  const newBrandDb = (recharge) => {
    const settings = { [BRAND_SETTING_ID]: CONFIG, [BRAND_TERMS_SETTING_ID]: TERMS };
    if (recharge !== undefined) settings[RECHARGE_SETTING_ID] = recharge;
    const db = makeBrandFakeDb({
      affiliates: [{ id: 'a1', username: 'amina', isActive: true }, { id: 'a2', username: 'badr', isActive: true }],
      products: ['prod-1', 'prod-2', 'prod-3'].map((id) => ({ id, title: `Produit ${id}` })),
      deposits: [{ id: 'dep-1', affiliateId: 'a2', transferReference: 'vir 2026/001', status: 'APPROVED', amount: '200.00' }],
      settings,
    });
    const reads = [];
    const realFind = db.setting.findUnique;
    db.setting.findUnique = async (q) => { reads.push(q?.where?.id); return realFind(q); };
    return { db, reads };
  };
  const body = (n) => ({ productIds: ['prod-1', 'prod-2', 'prod-3'], packageId: 'p1', brandName: 'Ma Marque', termsVersion: 1, acceptTerms: true, clientRequestId: `req-${String(n).padStart(8, '0')}` });

  // Services.
  const runServices = async (recharge) => {
    const { db, reads } = newBrandDb(recharge);
    const storage = makeProofStorage();
    const acc = await requestBrandAccess('a1', body(1), { db, now: BNOW });
    const pr = await submitPaymentProof('a1', acc.id, proofInput('S1'), { db, storage });
    return { db, reads, storage, acc, pr };
  };
  const on = await runServices(undefined);
  const off = await runServices({ enabled: false });
  ok('OFF: brand access request created (PENDING_PAYMENT)', off.acc?.status === 'PENDING_PAYMENT');
  ok('OFF: payment proof SUBMITTED and stored', off.pr?.status === 'SUBMITTED' && off.storage.files.size === 1 && off.db._tables.brandPaymentProof.length === 1);
  const shape = (x) => JSON.stringify({ acc: { status: x.acc.status, amount: x.acc.amount, keys: Object.keys(x.acc).sort() }, pr: { status: x.pr.status, keys: Object.keys(x.pr).sort() } });
  ok('OFF result identical to ON (status, amount, fields)', shape(on) === shape(off));
  ok('same rows written ON and OFF', ['brandAccess', 'brandPaymentProof', 'brandAuditLog', 'affiliateNotification']
    .every((t) => on.db._tables[t].length === off.db._tables[t].length));
  ok('the brand flow never reads the recharge switch', !off.reads.includes(RECHARGE_SETTING_ID) && !on.reads.includes(RECHARGE_SETTING_ID));
  ok('deposit table not written by the brand flow', !off.db._stats.log.some((l) => /^affiliateSecurityDeposit\.(create|update)/.test(l)));

  // Route handlers (request + multipart proof upload).
  const runRoutes = async (recharge) => {
    const { db } = newBrandDb(recharge);
    const storage = makeProofStorage();
    const aff = affiliateBrandHandlers({ db, now: () => BNOW, storage, rateLimit: () => null });
    const reqRes = await aff.requestAccess(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(2)) }), {}, { affiliateId: 'a1' });
    const acc = await reqRes.json();
    const fd = new FormData();
    fd.set('paymentMethod', 'Virement bancaire');
    fd.set('transferReference', 'VIR-R1');
    fd.set('proof', new File([pngBytes('R1')], 'preuve.png', { type: 'image/png' }));
    const upRes = await aff.submitProof(new Request('http://x', { method: 'POST', body: fd }), { params: Promise.resolve({ id: acc.id }) }, { affiliateId: 'a1' });
    return { reqStatus: reqRes.status, upStatus: upRes.status, up: await upRes.json(), acc };
  };
  const rOn = await runRoutes(undefined);
  const rOff = await runRoutes({ enabled: false });
  ok('OFF: POST brand request route → 201', rOff.reqStatus === 201 && rOff.acc.status === 'PENDING_PAYMENT', JSON.stringify(rOff.acc).slice(0, 200));
  ok('OFF: POST brand payment proof route → 201 SUBMITTED', rOff.upStatus === 201 && rOff.up.status === 'SUBMITTED', JSON.stringify(rOff.up).slice(0, 200));
  ok('routes: OFF statuses identical to ON', rOn.reqStatus === rOff.reqStatus && rOn.upStatus === rOff.upStatus && rOn.up.status === rOff.up.status);

  // Static: no brand module imports the switch or the deposit service; storage is not gated.
  const brandFiles = readdirSync(path.join(ROOT, 'src/lib/services')).filter((f) => /^brand.*\.js$/.test(f)).map((f) => `src/lib/services/${f}`);
  brandFiles.push('src/lib/brandRouteHandlers.js');
  const offenders = brandFiles.filter((f) => /from\s+['"][^'"]*(rechargeFeatureService|depositService)(\.js)?['"]/.test(read(f)) || /import\(\s*['"][^'"]*(rechargeFeatureService|depositService)/.test(read(f)));
  ok(`no brand module (${brandFiles.length} files) imports rechargeFeatureService or depositService`, brandFiles.length >= 2 && offenders.length === 0, offenders.join(', '));
  const storageSrc = read('src/lib/depositStorage.js');
  ok('depositStorage.js does not import rechargeFeatureService (shared storage not gated)', !/rechargeFeature/.test(storageSrc));
  const brandRoutes = [];
  const walk = (dir) => { for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) brandRoutes.push(p); } };
  walk('src/app/api/affiliate/brand');
  ok(`brand API routes (${brandRoutes.length}) do not reference the switch`, brandRoutes.length > 0 && brandRoutes.every((f) => !/rechargeFeature|DEPOSIT_DISABLED|isRechargeEnabled/.test(read(f))));
}

// ── 9. Affiliate dashboard gating (static) ────────────────────────────────────
console.log('9) Affiliate dashboard / BoosterTab gating (static):');
{
  const page = read('src/app/affiliate/dashboard/page.jsx');
  const booster = read('src/app/affiliate/dashboard/BoosterTab.jsx');
  ok('rechargeEnabled = deposit.rechargeEnabled !== false', /const rechargeEnabled = deposit\.rechargeEnabled !== false;/.test(page));
  ok('goToDeposit = rechargeEnabled ? … : null', /const goToDeposit = rechargeEnabled \? \(\) => setActiveTab\("deposit"\) : null;/.test(page));
  ok('overview widget wrapped in `rechargeEnabled &&`', /\{rechargeEnabled && <button onClick=\{goToDeposit\}/.test(page));
  ok('desktop tabs filtered (deposit hidden when OFF)', /tabs\.filter\(\(tb\) => tb\.id !== "deposit" \|\| rechargeEnabled\)\.map/.test(page));
  ok('mobile More-sheet filtered', /moreItems\.filter\(\(m\) => m\.tab !== "deposit" \|\| rechargeEnabled\)\.map/.test(page)
    && /function MobileBottomNav\([^)]*rechargeEnabled = true/.test(page) && /rechargeEnabled=\{rechargeEnabled\}/.test(page));
  const depTab = page.slice(page.indexOf('activeTab === "deposit" && ('), page.indexOf('activeTab === "deposit" && (') + 700);
  ok('deposit tab: DepositTab only when ON, else the notice', /activeTab === "deposit" && \(rechargeEnabled \? \(\s*<DepositTab/.test(depTab)
    && /data-recharge-disabled/.test(depTab) && /t\("deposit_disabled_title"\)/.test(depTab) && /t\("deposit_disabled_body"\)/.test(depTab));
  ok('DepositTab rendered nowhere else', (page.match(/<DepositTab\b/g) || []).length === 1);
  ok('BoosterTab gets onRecharge={goToDeposit}', /<BoosterTab onRecharge=\{goToDeposit\} \/>/.test(page));
  const rechargeBtns = booster.match(/onClick=\{onRecharge\}/g) || [];
  const guarded = booster.match(/\{onRecharge && <button[^>]*?onClick=\{onRecharge\}/gs) || [];
  ok(`BoosterTab: every "Recharger" button conditional on onRecharge (${rechargeBtns.length})`, rechargeBtns.length >= 1 && guarded.length === rechargeBtns.length);
  const goToDepositUses = page.match(/goToDeposit/g) || [];
  ok('goToDeposit only used in guarded places (definition, widget, BoosterTab)', goToDepositUses.length === 3, `found ${goToDepositUses.length}`);
  for (const L of ['fr', 'ar']) {
    const T = AFFILIATE_DASHBOARD_TEXT[L];
    ok(`${L.toUpperCase()}: deposit_disabled_title / deposit_disabled_body present`, typeof T.deposit_disabled_title === 'string' && T.deposit_disabled_title.trim().length > 0
      && typeof T.deposit_disabled_body === 'string' && T.deposit_disabled_body.trim().length > 0);
  }
  ok('AR texts are Arabic', /[؀-ۿ]/.test(AFFILIATE_DASHBOARD_TEXT.ar.deposit_disabled_body));
}

// ── 10. Generic settings API refuses the switch ──────────────────────────────
console.log('10) Generic POST /api/setting refuses type=affiliate-recharge:');
{
  const ctl = read('src/lib/controllers/settingsController.js');
  ok('RESERVED_SETTING_TYPES contains RECHARGE_SETTING_ID (static)', /RESERVED_SETTING_TYPES = new Set\(\[[^\]]*\bRECHARGE_SETTING_ID\b[^\]]*\]\)/.test(ctl));
  const { upsertSettingsHandler } = await import('../src/lib/controllers/settingsController.js');
  const res = await upsertSettingsHandler(new Request('http://x/api/setting?type=affiliate-recharge', { method: 'POST', body: JSON.stringify({ enabled: false }) }));
  ok('upsertSettingsHandler(type=affiliate-recharge) → 400 before any write', res.status === 400);
}

// ── 11. Admin deposits page (static) ─────────────────────────────────────────
console.log('11) Admin deposits page — switch card (static):');
{
  const admin = read('src/app/admin/deposits/page.jsx');
  ok('card title "Recharge de solde des Affiliés"', /Recharge de solde des Affiliés/.test(admin));
  ok('role="switch" with aria-checked', /role="switch" aria-checked=\{enabled\}/.test(admin));
  ok('state text Activée / Désactivée', /"Activée"/.test(admin) && /"Désactivée"/.test(admin));
  ok('loads via GET and saves via PUT {enabled, revision}', /fetch\("\/api\/admin\/affiliate-recharge"/.test(admin) && /method: "PUT"/.test(admin) && /JSON\.stringify\(\{ enabled, revision: setting\.revision \}\)/.test(admin));
  ok('handles 409 SETTINGS_CONFLICT using `current`', /res\.status === 409 && d\?\.code === "SETTINGS_CONFLICT"/.test(admin) && /setSetting\(d\.current\)/.test(admin));
  ok('turning OFF asks for confirmation first', /if \(enabled\) setAskOff\(true\); else save\(true\);/.test(admin) && /onClick=\{\(\) => save\(false\)\}/.test(admin));
  ok('existing request list / review still on the page', /fetch\("\/api\/admin\/deposits"\)/.test(admin) && /act\(confirm\.id, confirm\.action, reason\)/.test(admin));
  ok('explains: existing requests reviewable, balances / Brand / commissions / rewards / withdrawals unaffected',
    /peuvent toujours être validées ou refusées/.test(admin) && /Create Your Own Brand/.test(admin) && /commissions/.test(admin) && /récompenses/.test(admin) && /retraits/.test(admin) && /rien n&apos;est perdu/.test(admin));
}

// ── 12. The route refuses EVERY new request while OFF, before reading the upload ──
console.log('\n12) Route: switch checked first (even a request without a file gets 403 DEPOSIT_DISABLED)');
{
  const { ensureRechargeEnabled } = await import('../src/lib/services/depositService.js');
  const offDb = { setting: { findUnique: async ({ where }) => (where.id === 'affiliate-recharge' ? { id: where.id, data: { enabled: false } } : null) } };
  const onDb = { setting: { findUnique: async () => null } };
  let code = null; try { await ensureRechargeEnabled(offDb); } catch (e) { code = e.code; }
  ok('ensureRechargeEnabled: OFF → DEPOSIT_DISABLED', code === 'DEPOSIT_DISABLED');
  let threw = false; try { await ensureRechargeEnabled(onDb); } catch { threw = true; }
  ok('ensureRechargeEnabled: no row (ON) → passes', !threw);
  const route = readFileSync(new URL('../src/app/api/affiliate/deposits/route.js', import.meta.url), 'utf8');
  const post = route.slice(route.indexOf('async function postHandler'));
  ok('POST: ensureRechargeEnabled() runs before req.formData() and before the missing-file 400',
    post.indexOf('await ensureRechargeEnabled()') > 0 && post.indexOf('await ensureRechargeEnabled()') < post.indexOf('req.formData()')
    && post.indexOf('await ensureRechargeEnabled()') < post.indexOf("'DEPOSIT_NO_PROOF'"));
  const get = route.slice(route.indexOf('async function getHandler'), route.indexOf('async function postHandler'));
  ok('GET (history / balances) does not check the switch', !/ensureRechargeEnabled|isRechargeEnabled/.test(get));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
