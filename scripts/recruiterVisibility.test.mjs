#!/usr/bin/env node
/**
 * scripts/recruiterVisibility.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — the recruiter-facing shapes (src/lib/recruiterVisibility.js).
 * Pure: no database, no I/O beyond reading repository files. Proves:
 *   • IMMEDIATE visibility: EARNED as soon as a RECRUIT_REWARD row exists (not
 *     reversed); a ledger view carries the row's exact createdAt (ISO, ms precision);
 *     totals include a row recorded this very millisecond — no delay, no release day,
 *     no jitter; the projections take no clock argument and ignore one if passed
 *   • the reward service semantics: (internal evaluation qualifies ⇒ row written) ⇒
 *     EARNED at once, over the full qualification matrix
 *   • settings views: rewards on/off, amount (MAD), required delivered orders (default 10)
 *   • ledger / totals / audit / error projections are allowlists with exact key sets,
 *     even with hostile input (prototype pollution, extra keys, wrong types)
 *   • the removal of the UGC condition and of the timing is REAL (exports, code)
 *   • CONTRACT (Phase 2+): every recruiter route / page / lib file must use these
 *     projections and never return raw recruiter rows, read UGC data, expose CIN files,
 *     balances or earnings, change an affiliate's parent or verification, or send an
 *     error message (vacuous until Phase 2 adds such files)
 * Run: node scripts/recruiterVisibility.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const V = await import('../src/lib/recruiterVisibility.js');
const R = await import('../src/lib/recruiterSettings.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : null);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const H = 3_600_000, D = 24 * H;
const REMOVED = /ugc|video|vid[eé]o|release|jitter|hmac|delay|casablanca|minApproved/i;

const ON = { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 };
const T0 = Date.parse('2026-11-04T10:00:00.123Z');
const rewardRow = (affiliateId, createdAt, amountCents = 15000) => ({ id: `g-${affiliateId}`, type: 'RECRUIT_REWARD', affiliateId, amountCents, createdAt: new Date(createdAt), recruiterId: 'r1', idempotencyKey: `recruit:${affiliateId}`, actorType: 'SYSTEM', settingsVersion: 1 });
const reversalRow = (affiliateId, createdAt, amountCents = -15000) => ({ type: 'REVERSAL', affiliateId, amountCents, createdAt: new Date(createdAt), recruiterId: 'r1' });
const view = (reward, s = ON, reversal = null) => V.toRecruiterQualificationView({ reward, reversal }, s);

// ── 0. the removal is real ────────────────────────────────────────────────────
console.log('\n0. Removed features are gone (exports and code)');
{
  ok('exports are exactly the 21 projections / allowlists (Phase 3 adds RECRUITER_FIELD_ERROR_CODES and toRecruiterNetworkAffiliateView; Phase 4 adds toRecruiterNetworkNodeView, toRecruiterNetworkPathView and toRecruiterNetworkStatsView; Phase 5 adds RECRUITER_WITHDRAWAL_STATUS, toRecruiterWithdrawalView, toRecruiterRewardHistoryView, toRecruiterBankView and toRecruiterWalletView; Phase 6 part 1 adds toRecruiterActivationCodeView and toRecruiterPendingActivationView; the recruiter profile view lives in recruiterProfileView.js; no rewardReleaseDay, isRewardReleased, RELEASE_BASE_DAYS, RELEASE_JITTER_DAYS)',
    eq(Object.keys(V).sort(), ['RECRUITER_ERROR_CODES', 'RECRUITER_FIELD_ERROR_CODES', 'RECRUITER_REWARD_STATUS', 'RECRUITER_VISIBLE_AUDIT_ACTIONS', 'RECRUITER_WITHDRAWAL_STATUS', 'toRecruiterActivationCodeView', 'toRecruiterAuditView',
      'toRecruiterBankView', 'toRecruiterError',
      'toRecruiterNetworkAffiliateView', 'toRecruiterNetworkNodeView', 'toRecruiterNetworkPathView', 'toRecruiterNetworkStatsView',
      'toRecruiterPendingActivationView', 'toRecruiterQualificationView', 'toRecruiterRewardHistoryView', 'toRecruiterRewardTotals', 'toRecruiterRewardView', 'toRecruiterSettingsView',
      'toRecruiterWalletView', 'toRecruiterWithdrawalView']), Object.keys(V).sort().join(','));
  ok('no exported name of either module mentions release / jitter / delay / hmac / UGC / video',
    [...Object.keys(V), ...Object.keys(R)].every((k) => !REMOVED.test(k)));
  const code = stripJs(read('src/lib/recruiterVisibility.js'));
  ok('recruiterVisibility.js CODE: no ugc / video / release / jitter / hmac / delay / Casablanca / minApproved identifier', !REMOVED.test(code), (REMOVED.exec(code) || [])[0]);
  ok('recruiterVisibility.js CODE: no clock, time zone, hash or randomness (Date.now, Intl, timeZone, crypto, Math.random, nowMs)',
    !/Date\.now|Intl\.|timeZone|crypto|Math\.random|nowMs|getTimezoneOffset|toLocale/.test(code));
  ok('the projections take no clock parameter (toRecruiterRewardView / toRecruiterRewardTotals have 1 parameter; settings view 1)',
    V.toRecruiterRewardView.length === 1 && V.toRecruiterRewardTotals.length === 1 && V.toRecruiterSettingsView.length === 1);
}

// ── 1. immediate visibility ──────────────────────────────────────────────────
console.log('\n1. Immediate visibility — EARNED, exact time and totals at once');
{
  const now = Date.now();
  const fresh = rewardRow('aff-now', now);
  ok('a reward recorded THIS millisecond → EARNED at once', eq(view(fresh), { rewardStatus: 'EARNED' }));
  ok('a reward recorded THIS millisecond → its ledger view shows exactly that instant (ISO, ms precision)',
    V.toRecruiterRewardView(fresh).createdAt === new Date(now).toISOString());
  ok('a reward recorded THIS millisecond is included in the totals at once', eq(V.toRecruiterRewardTotals([fresh]), { earnedCents: 15000, currency: 'MAD' }));
  let exactOk = true, n = 0;
  const instants = [T0, T0 + 1, Date.parse('2026-11-04T23:59:59.999Z'), Date.parse('2026-11-05T00:00:00.000Z'), Date.parse('2026-02-15T01:59:59.500Z'),
    Date.parse('2026-03-22T02:00:00.001Z'), Date.parse('2026-12-31T23:30:00Z'), Date.parse('2027-02-28T23:30:00Z'), 0, 1, Date.parse('2099-01-01T00:00:00Z')];
  for (const t of instants) for (const form of [(x) => new Date(x), (x) => new Date(x).toISOString(), (x) => x]) {
    if (t === 0 && form(t) === 0) continue; // numeric epoch 0 is falsy: the module treats it as "no date" (Prisma always returns Date objects)
    const row = { ...rewardRow(`aff-${n}`, t), createdAt: form(t) };
    const v = V.toRecruiterRewardView(row);
    n++;
    if (v.createdAt !== new Date(t).toISOString() || v.type !== 'RECRUIT_REWARD' || v.amountCents !== 15000) { exactOk = false; console.log('    exact', t, JSON.stringify(v)); }
  }
  ok(`a reward view at T shows exactly T (${n} cases: 11 instants incl. midnight, DST / Ramadan changes, epoch, far future × Date / ISO string / epoch ms, minus numeric 0)`, exactOk && n === 32);
  ok('EARNED regardless of the row date (epoch, yesterday, now, next year) — there is no release day',
    [0, now - D, now, now + 365 * D].every((t) => view(rewardRow('aff-t', t)).rewardStatus === 'EARNED'));
  ok('totals include every recorded row immediately, whatever its date (past, now, future)',
    V.toRecruiterRewardTotals([rewardRow('a', now - 3 * D), rewardRow('b', now), rewardRow('c', now + D, 500)]).earnedCents === 30500);
  ok('an extra clock argument (past or future) is ignored: views, ledger and totals are identical',
    [-1, 0, T0 - 10 * D, now + 30 * D].every((t) => eq(V.toRecruiterQualificationView({ reward: fresh }, ON, t), view(fresh))
      && eq(V.toRecruiterRewardView(fresh, t), V.toRecruiterRewardView(fresh)) && eq(V.toRecruiterRewardTotals([fresh], t), V.toRecruiterRewardTotals([fresh]))));
  ok('a reversal cancels EARNED at once (PENDING while rewards are on, UNAVAILABLE when off); the totals net it at once',
    view(fresh, ON, reversalRow('aff-now', now)).rewardStatus === 'PENDING' && view(fresh, { ...ON, enabled: false }, reversalRow('aff-now', now)).rewardStatus === 'UNAVAILABLE'
    && V.toRecruiterRewardTotals([fresh, reversalRow('aff-now', now)]).earnedCents === 0);
}

// ── 2. qualification views ────────────────────────────────────────────────────
console.log('\n2. Qualification views (service semantics: qualified ⇒ row ⇒ EARNED at once)');
{
  const STATUSES = ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', undefined, 'approved'];
  let cases = 0, matrixOk = true;
  for (const min of [1, 10, 12]) for (let sales = 0; sales <= 12; sales++) for (const st of STATUSES) {
    const s = { ...ON, minDeliveredSales: min };
    const internal = R.evaluateRecruitQualification({ linked: true, affiliateExists: true, identityStatus: st, deliveredSales: sales }, s);
    const row = internal.qualified ? rewardRow('aff-m', T0) : null; // the reward service writes the row immediately
    const v = view(row, s);
    cases++;
    if (v.rewardStatus !== (sales >= min && st === 'APPROVED' ? 'EARNED' : 'PENDING') || !eq(keys(v), ['rewardStatus'])) { matrixOk = false; console.log('    view', min, sales, st, JSON.stringify(v)); }
  }
  ok(`matrix (${cases} cases): EARNED at once ⇔ sales ≥ threshold AND CIN === 'APPROVED'; otherwise PENDING; exactly { rewardStatus }`, matrixOk && cases === 234);
  const rw = rewardRow('aff-e', T0);
  ok('EARNED is kept when rewards are later disabled or the amount set to 0 (a recorded, non-reversed reward stays earned)',
    view(rw, { ...ON, enabled: false }).rewardStatus === 'EARNED' && view(rw, { ...ON, rewardAmountCents: 0 }).rewardStatus === 'EARNED' && view(rw, null).rewardStatus === 'EARNED');
  ok('no reward: PENDING when rewards are on; UNAVAILABLE when disabled / no amount / no settings',
    eq(view(null), { rewardStatus: 'PENDING' }) && eq(view(null, { ...ON, enabled: false }), { rewardStatus: 'UNAVAILABLE' })
    && eq(view(null, { ...ON, rewardAmountCents: 0 }), { rewardStatus: 'UNAVAILABLE' }) && eq(V.toRecruiterQualificationView({}, null), { rewardStatus: 'UNAVAILABLE' })
    && eq(V.toRecruiterQualificationView(undefined, ON), { rewardStatus: 'PENDING' }));
  ok('the view carries no reason / unmet / threshold / sales / CIN detail, even if the internal result is passed in',
    (() => { const internal = R.evaluateRecruitQualification({ linked: true, affiliateExists: true, identityStatus: 'PENDING', deliveredSales: 3 }, ON);
      const v = V.toRecruiterQualificationView({ reward: null, reversal: null, ...internal, rewarded: true, deliveredSales: 3 }, ON);
      return eq(v, { rewardStatus: 'PENDING' }); })());
  ok('the old { rewarded, reversed } signature does not grant EARNED (only a RECRUIT_REWARD row does)', V.toRecruiterQualificationView({ rewarded: true, reversed: false }, ON).rewardStatus === 'PENDING');
  ok('a row of the wrong type is not a reward (REVERSAL / ADMIN_ADJUSTMENT / lowercase as "reward" → never EARNED)',
    ['REVERSAL', 'ADMIN_ADJUSTMENT', 'recruit_reward', undefined].every((t) => view({ ...rw, type: t }).rewardStatus === 'PENDING'));
  ok('a "reversal" of the wrong type does not cancel EARNED', view(rw, ON, { ...reversalRow('aff-e', T0), type: 'ADMIN_ADJUSTMENT' }).rewardStatus === 'EARNED');
  ok('rewardStatus values are only EARNED / PENDING / UNAVAILABLE (frozen)', eq(Object.values(V.RECRUITER_REWARD_STATUS).sort(), ['EARNED', 'PENDING', 'UNAVAILABLE']) && Object.isFrozen(V.RECRUITER_REWARD_STATUS));
}

// ── 3. settings views ─────────────────────────────────────────────────────────
console.log('\n3. Settings views — on/off, amount (MAD), required delivered orders');
{
  const S = V.toRecruiterSettingsView;
  ok('enabled → { rewardsEnabled: true, rewardAmountCents, currency: "MAD", requiredDeliveredOrders } exactly',
    eq(S(ON), { rewardsEnabled: true, rewardAmountCents: 15000, currency: 'MAD', requiredDeliveredOrders: 10 }));
  ok('requiredDeliveredOrders = the admin threshold (1, 12, 100000)', [1, 12, 100_000].every((m) => S({ ...ON, minDeliveredSales: m }).requiredDeliveredOrders === m));
  ok('no settings / missing / invalid threshold → requiredDeliveredOrders 10 (the default)',
    S(null).requiredDeliveredOrders === 10 && [undefined, null, 0, -1, 100_001, 1.5, '12'].every((m) => S({ ...ON, minDeliveredSales: m }).requiredDeliveredOrders === 10));
  ok('disabled or no amount → rewardsEnabled false and amount hidden (0); threshold still shown',
    eq(S({ ...ON, enabled: false }), { rewardsEnabled: false, rewardAmountCents: 0, currency: 'MAD', requiredDeliveredOrders: 10 })
    && eq(S({ ...ON, rewardAmountCents: 0 }), { rewardsEnabled: false, rewardAmountCents: 0, currency: 'MAD', requiredDeliveredOrders: 10 })
    && eq(S(null), { rewardsEnabled: false, rewardAmountCents: 0, currency: 'MAD', requiredDeliveredOrders: 10 }));
  ok('foreign settings fields never reach the view (version, createdBy, createdAt, minApprovedUgcVideos)',
    eq(keys(S({ ...ON, createdBy: 'u-admin', createdAt: new Date(), minApprovedUgcVideos: 3 })), ['currency', 'requiredDeliveredOrders', 'rewardAmountCents', 'rewardsEnabled']));
}

// ── 4. ledger rows and totals ─────────────────────────────────────────────────
console.log('\n4. Ledger rows and totals — exactly 5 keys, exact time, no internal field');
{
  const hostile = [
    { id: 'g1', seq: 1n, recruiterId: 'r1', affiliateId: 'n1', type: 'RECRUIT_REWARD', amountCents: 15000, idempotencyKey: 'recruit:n1', reason: 'internal note', actorType: 'SYSTEM', actorId: 'worker', settingsVersion: 3, details: { deliveredSales: 10 }, createdAt: '2026-11-04T10:00:00.123Z' },
    { id: 'g2', recruiterId: 'r1', affiliateId: 'n1', type: 'REVERSAL', amountCents: -15000, idempotencyKey: 'reverse:n1', reason: 'fraud', actorType: 'ADMIN', actorId: 'u-admin', createdAt: new Date('2026-11-05T00:00:00Z') },
    { id: 'g3', recruiterId: 'r1', affiliateId: null, type: 'ADMIN_ADJUSTMENT', amountCents: -300, idempotencyKey: 'adj:1', reason: 'correction', actorType: 'ADMIN', actorId: 'u-admin', createdAt: '2026-11-06T00:00:00Z', balance: 999 },
    JSON.parse('{"__proto__":{"polluted":true},"type":"RECRUIT_REWARD","amountCents":10,"affiliateId":"n2","reason":"x","createdAt":"2026-11-07T00:00:00Z","cinFrontFile":"k.jpg"}'),
    { type: 'BONUS', amountCents: '15', affiliateId: { id: 1 }, createdAt: 'not a date' },
  ];
  const views = hostile.map((r) => V.toRecruiterRewardView(r));
  ok('every ledger view has exactly { type, amountCents, currency, affiliateId, createdAt }',
    views.every((v) => eq(keys(v), ['affiliateId', 'amountCents', 'createdAt', 'currency', 'type'])), JSON.stringify(views));
  ok('values carried exactly (type, cents, MAD, affiliate id, the row createdAt as ISO)',
    eq(views[0], { type: 'RECRUIT_REWARD', amountCents: 15000, currency: 'MAD', affiliateId: 'n1', createdAt: '2026-11-04T10:00:00.123Z' })
    && eq(views[1], { type: 'REVERSAL', amountCents: -15000, currency: 'MAD', affiliateId: 'n1', createdAt: '2026-11-05T00:00:00.000Z' })
    && eq(views[2], { type: 'ADMIN_ADJUSTMENT', amountCents: -300, currency: 'MAD', affiliateId: null, createdAt: '2026-11-06T00:00:00.000Z' }));
  ok('internal fields never reach the view (id, seq, recruiterId, idempotencyKey, reason, actor, settingsVersion, details, balance, cinFrontFile, polluted)',
    views.every((v) => ['id', 'seq', 'recruiterId', 'idempotencyKey', 'reason', 'actorType', 'actorId', 'settingsVersion', 'details', 'balance', 'cinFrontFile', 'polluted'].every((k) => !(k in v))));
  ok('unknown type / non-integer amount / non-string affiliate / invalid date are neutralised (null, 0, null, null)',
    eq(views[4], { type: null, amountCents: 0, currency: 'MAD', affiliateId: null, createdAt: null }));
  ok('null / undefined row → the neutral shape (never throws, nothing invented)',
    [null, undefined, {}].every((r) => eq(V.toRecruiterRewardView(r), { type: null, amountCents: 0, currency: 'MAD', affiliateId: null, createdAt: null })));
  const T = V.toRecruiterRewardTotals;
  ok('totals: sum of every recorded row with a known type and integer cents (reward − reversal − adjustment)',
    eq(T(hostile), { earnedCents: 15000 - 15000 - 300 + 10, currency: 'MAD' }));
  ok('totals ignore unknown types and non-integer amounts; non-array / empty input → 0 MAD',
    T([{ type: 'BONUS', amountCents: 5 }, { type: 'RECRUIT_REWARD', amountCents: 1.5 }, { type: 'RECRUIT_REWARD', amountCents: '5' }, null]).earnedCents === 0
    && [null, undefined, 'x', {}, []].every((x) => eq(T(x), { earnedCents: 0, currency: 'MAD' })));
  ok('amounts are carried unchanged (123456 cents in the view and in the totals)',
    V.toRecruiterRewardView(rewardRow('amt', T0, 123456)).amountCents === 123456 && T([rewardRow('amt', T0, 123456)]).earnedCents === 123456);
}

// ── 5. audit entries ──────────────────────────────────────────────────────────
console.log('\n5. Audit entries — own allowlisted actions only, never details');
{
  const A = V.toRecruiterAuditView;
  const base = { recruiterId: 'r1', actorType: 'RECRUITER', actorId: 'r1', entityType: 'affiliate', entityId: 'n1', createdAt: '2026-11-04T10:00:00Z' };
  const secret = { cinFrontFile: 'k.jpg', balance: 500, note: 'internal' };
  ok('SYSTEM entries → null', A({ ...base, actorType: 'SYSTEM', actorId: 'system', action: 'REWARD_RECORDED', details: secret }, 'r1') === null
    && A({ ...base, actorType: 'SYSTEM', actorId: 'r1', action: 'AFFILIATE_CREATED', details: secret }, 'r1') === null);
  ok('ADMIN entries → null', A({ ...base, actorType: 'ADMIN', actorId: 'u-admin', action: 'IDENTITY_APPROVED', details: secret }, 'r1') === null
    && A({ ...base, actorType: 'ADMIN', actorId: 'r1', action: 'RECRUITER_LOGIN' }, 'r1') === null);
  ok("another recruiter's entry → null (recruiterId or actorId mismatch)", A({ ...base, action: 'AFFILIATE_CREATED' }, 'r2') === null
    && A({ ...base, recruiterId: 'r2', action: 'AFFILIATE_CREATED' }, 'r1') === null && A({ ...base, actorId: 'r2', action: 'AFFILIATE_CREATED' }, 'r1') === null);
  ok('a non-allowlisted own action → null (REWARD_EVALUATED, SETTINGS_CHANGED, lowercase, empty)', ['REWARD_EVALUATED', 'SETTINGS_CHANGED', 'affiliate_created', ''].every((a) => A({ ...base, action: a, details: secret }, 'r1') === null));
  const allow = V.RECRUITER_VISIBLE_AUDIT_ACTIONS.map((a) => A({ ...base, action: a, details: secret, balance: 3, __extra: 'x' }, 'r1'));
  ok('every allowlisted own action → exactly { action, entityId, createdAt }, never details',
    allow.every((v) => v && eq(keys(v), ['action', 'createdAt', 'entityId']) && !('details' in v) && !('balance' in v)), JSON.stringify(allow));
  ok('entityId only for AFFILIATE_CREATED (null for login / logout / password); createdAt exact ISO',
    allow.every((v) => (v.action === 'AFFILIATE_CREATED' ? v.entityId === 'n1' : v.entityId === null) && v.createdAt === '2026-11-04T10:00:00.000Z'));
  ok('allowlist is exactly the 4 own actions (frozen)', eq([...V.RECRUITER_VISIBLE_AUDIT_ACTIONS].sort(), ['AFFILIATE_CREATED', 'RECRUITER_LOGIN', 'RECRUITER_LOGOUT', 'RECRUITER_PASSWORD_CHANGED']) && Object.isFrozen(V.RECRUITER_VISIBLE_AUDIT_ACTIONS));
  ok('null entry / missing recruiter id → null', A(null, 'r1') === null && A({ ...base, action: 'RECRUITER_LOGIN' }, undefined) === null);
}

// ── 6. errors ─────────────────────────────────────────────────────────────────
console.log('\n6. Errors — code only, never the message');
{
  const E = V.toRecruiterError;
  const errs = [
    Object.assign(new Error('NOT_ENOUGH_SALES: 3/10'), { code: 'NOT_ENOUGH_SALES' }),
    Object.assign(new Error('Prisma P2002 on recruiter_reward_ledger'), { code: 'P2002' }),
    Object.assign(new Error('Nom invalide'), { code: 'INVALID_INPUT', details: { field: 'name' } }),
    Object.assign(new Error('secret'), { code: 'FORBIDDEN', stack: 'at x.js:1' }),
    { code: 'RATE_LIMITED', message: 'too many requests from 1.2.3.4', stack: 'at y.js:1' },
    new Error('boom'), null, undefined, 'string error', 42,
  ];
  const outs = errs.map(E);
  ok('unknown / internal codes → { code: "SERVER_ERROR" }', eq(outs[0], { code: 'SERVER_ERROR' }) && eq(outs[1], { code: 'SERVER_ERROR' }));
  ok('allowlisted codes pass but NEVER the message, details, stack or extra keys', eq(outs[2], { code: 'INVALID_INPUT' }) && eq(outs[3], { code: 'FORBIDDEN' }) && eq(outs[4], { code: 'RATE_LIMITED' }));
  ok('every error output is exactly { code } (incl. plain Error, null, undefined, string, number)', outs.every((o) => eq(keys(o), ['code'])) && eq(outs[5], { code: 'SERVER_ERROR' }) && eq(outs[8], { code: 'SERVER_ERROR' }));
  ok('error allowlist is exactly these 14 codes (Phase 2 adds INVALID_CREDENTIALS for the login, Phase 3 IDEMPOTENCY_CONFLICT, Phase 5 INSUFFICIENT_BALANCE and INCOMPLETE_BANK_INFO, Phase 6 ACTIVATION_NOT_AVAILABLE), frozen',
    eq([...V.RECRUITER_ERROR_CODES], ['UNAUTHORIZED', 'RECRUITER_DISABLED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'USERNAME_TAKEN', 'PHONE_TAKEN', 'PARENT_NOT_IN_NETWORK', 'RATE_LIMITED', 'INVALID_CREDENTIALS', 'IDEMPOTENCY_CONFLICT',
      'INSUFFICIENT_BALANCE', 'INCOMPLETE_BANK_INFO', 'ACTIVATION_NOT_AVAILABLE']) && Object.isFrozen(V.RECRUITER_ERROR_CODES));
  ok('no internal gate / unmet reason is a recruiter error code',
    ['REWARDS_DISABLED', 'NO_AMOUNT', 'NOT_LINKED', 'AFFILIATE_NOT_FOUND', 'NOT_ENOUGH_SALES', 'CIN_NOT_APPROVED', 'INVALID_COUNT', 'INVALID_AMOUNT'].every((c) => !V.RECRUITER_ERROR_CODES.includes(c) && eq(E({ code: c }), { code: 'SERVER_ERROR' })));
}

// ── 7. exact key sets with hostile input ──────────────────────────────────────
console.log('\n7. Exact allowlisted key sets (hostile input)');
{
  const evil = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"x":"y"}},"details":{"a":1},"balance":5,"cinFrontFile":"k","rewarded":true,"enabled":true,"rewardAmountCents":100,"minDeliveredSales":3,"type":"RECRUIT_REWARD","amountCents":100,"affiliateId":"n9","createdAt":"2026-11-04T00:00:00Z","action":"AFFILIATE_CREATED","actorType":"RECRUITER","actorId":"r1","recruiterId":"r1","entityId":"n9","code":"FORBIDDEN","message":"m"}');
  const evilWrapped = JSON.parse('{"__proto__":{"polluted":"yes"},"reward":' + JSON.stringify(evil) + ',"reversal":null,"balance":3}');
  const shapes = [
    ['qualification', V.toRecruiterQualificationView(evilWrapped, evil), ['rewardStatus']],
    ['settings', V.toRecruiterSettingsView(evil), ['currency', 'requiredDeliveredOrders', 'rewardAmountCents', 'rewardsEnabled']],
    ['reward', V.toRecruiterRewardView(evil), ['affiliateId', 'amountCents', 'createdAt', 'currency', 'type']],
    ['totals', V.toRecruiterRewardTotals([evil, evil]), ['currency', 'earnedCents']],
    ['audit', V.toRecruiterAuditView(evil, 'r1'), ['action', 'createdAt', 'entityId']],
    ['error', V.toRecruiterError(evil), ['code']],
  ];
  for (const [name, out, want] of shapes) {
    ok(`${name}: exactly ${want.join(', ')}; plain object; no __proto__ / details / balance / cinFrontFile / message / polluted`,
      eq(keys(out), want) && Object.getPrototypeOf(out) === Object.prototype && !Object.prototype.hasOwnProperty.call(out, '__proto__')
      && ['details', 'balance', 'cinFrontFile', 'message', 'polluted', 'constructor'].every((k) => !Object.prototype.hasOwnProperty.call(out, k)) && !('polluted' in out), JSON.stringify(out));
  }
  ok('values from hostile input: EARNED, 100 cents, MAD, n9, exact ISO, threshold 3, totals 200', V.toRecruiterQualificationView(evilWrapped, evil).rewardStatus === 'EARNED'
    && eq(V.toRecruiterRewardView(evil), { type: 'RECRUIT_REWARD', amountCents: 100, currency: 'MAD', affiliateId: 'n9', createdAt: '2026-11-04T00:00:00.000Z' })
    && V.toRecruiterSettingsView(evil).requiredDeliveredOrders === 3 && V.toRecruiterRewardTotals([evil, evil]).earnedCents === 200);
  ok('no global prototype pollution after all projections', !('polluted' in {}) && !('x' in {}));
}

// ── 7b. Phase 3: field errors and the network affiliate view ─────────────────
console.log('\n7b. Phase 3 — allowlisted field errors and the network affiliate view');
{
  const E = V.toRecruiterError;
  const F = V.RECRUITER_FIELD_ERROR_CODES;
  ok('field-code allowlist: exactly 11 fields with their codes (Phase 5 adds amountMad, bankName, rib, accountName), deeply frozen',
    eq(Object.keys(F).sort(), ['accountName', 'amountMad', 'bankName', 'body', 'name', 'parentId', 'password', 'phone', 'requestId', 'rib', 'username'])
    && eq(F.amountMad, ['INVALID_AMOUNT']) && eq(F.bankName, ['INVALID_BANK_NAME']) && eq(F.rib, ['INVALID_RIB']) && eq(F.accountName, ['INVALID_ACCOUNT_NAME'])
    && eq(F.username, ['INVALID_USERNAME']) && eq(F.name, ['INVALID_NAME']) && eq(F.password, ['INVALID_PASSWORD']) && eq(F.phone, ['INVALID_PHONE'])
    && eq(F.parentId, ['INVALID_PARENT']) && eq(F.requestId, ['INVALID_REQUEST_ID']) && eq(F.body, ['UNKNOWN_FIELD'])
    && Object.isFrozen(F) && Object.values(F).every(Object.isFrozen));
  const inv = (fields) => Object.assign(new Error('x'), { code: 'INVALID_INPUT', fields });
  ok('INVALID_INPUT with allowlisted fields → { code, fields } with exactly those fields',
    eq(E(inv({ username: 'INVALID_USERNAME', password: 'INVALID_PASSWORD' })), { code: 'INVALID_INPUT', fields: { username: 'INVALID_USERNAME', password: 'INVALID_PASSWORD' } }));
  ok('unknown fields and codes are dropped (wrong code for a field, foreign field, non-string value)',
    eq(E(inv({ username: 'INVALID_NAME', email: 'INVALID_EMAIL', isActive: 'UNKNOWN_FIELD', name: 42, phone: ['INVALID_PHONE'], parentId: 'INVALID_PARENT' })), { code: 'INVALID_INPUT', fields: { parentId: 'INVALID_PARENT' } }));
  ok('INVALID_INPUT whose fields are all dropped (or not an object) → exactly { code }',
    eq(E(inv({ x: 'y' })), { code: 'INVALID_INPUT' }) && eq(E(inv('INVALID_NAME')), { code: 'INVALID_INPUT' }) && eq(E(inv(null)), { code: 'INVALID_INPUT' }) && eq(E(inv({})), { code: 'INVALID_INPUT' }));
  ok('any other code never carries fields (USERNAME_TAKEN / PARENT_NOT_IN_NETWORK / unknown)',
    eq(E({ code: 'USERNAME_TAKEN', fields: { username: 'INVALID_USERNAME' } }), { code: 'USERNAME_TAKEN' })
    && eq(E({ code: 'PARENT_NOT_IN_NETWORK', fields: { parentId: 'INVALID_PARENT' } }), { code: 'PARENT_NOT_IN_NETWORK' })
    && eq(E({ code: 'P2002', fields: { username: 'INVALID_USERNAME' } }), { code: 'SERVER_ERROR' }) && eq(E({ code: 'IDEMPOTENCY_CONFLICT' }), { code: 'IDEMPOTENCY_CONFLICT' }));
  const evilFields = JSON.parse('{"code":"INVALID_INPUT","message":"m","fields":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"x":"y"}},"username":"INVALID_USERNAME","toString":"INVALID_NAME"}}');
  const ef = E(evilFields);
  ok('hostile fields (__proto__ / constructor / toString): only the allowlisted field passes; plain objects; no pollution',
    eq(ef, { code: 'INVALID_INPUT', fields: { username: 'INVALID_USERNAME' } }) && Object.getPrototypeOf(ef.fields) === Object.prototype
    && !('polluted' in ef.fields) && !('polluted' in {}) && !('x' in {}) && !Object.prototype.hasOwnProperty.call(ef, 'message'), JSON.stringify(ef));
  const inheritedOnly = Object.assign(new Error('x'), { code: 'INVALID_INPUT', fields: Object.create({ username: 'INVALID_USERNAME' }) });
  ok('an inherited (prototype) field is never read — own properties only', eq(E(inheritedOnly), { code: 'INVALID_INPUT' }));

  const N = V.toRecruiterNetworkAffiliateView;
  const row = { id: 'a1', username: 'amina', name: 'Amina', parentId: 'p1', createdAt: new Date('2026-11-05T10:00:00.000Z'),
    password: '$2a$12$hash', phone: '+212600000000', isActive: false, commissionRate: 0.5, bankName: 'b', rib: 'r', totalCommission: 9, bonusBalance: 3 };
  const v1 = N(row, new Set(['p1', 'a1']));
  ok('network view: exactly id, username, name, parentId, createdAt (ISO)',
    eq(keys(v1), ['createdAt', 'id', 'name', 'parentId', 'username']) && eq(v1, { id: 'a1', username: 'amina', name: 'Amina', parentId: 'p1', createdAt: '2026-11-05T10:00:00.000Z' }), JSON.stringify(v1));
  ok('network view: a parentId outside the network ids → null (never another network\'s id)',
    N(row, new Set(['a1'])).parentId === null && N(row, new Set()).parentId === null && N(row, undefined).parentId === null && N(row, ['p1']).parentId === null && N(row, { has: () => true }).parentId === null);
  ok('network view: root (no parent) → parentId null', N({ ...row, parentId: null }, new Set([null, 'a1'])).parentId === null);
  const evilRow = JSON.parse('{"__proto__":{"polluted":"yes"},"id":7,"username":["x"],"name":{"a":1},"parentId":"p1","createdAt":"not a date","password":"h","isActive":true,"constructor":{"prototype":{"x":"y"}}}');
  const v2 = N(evilRow, new Set(['p1']));
  ok('network view with hostile input: non-strings → null, bad date → null, exactly 5 keys, no pollution',
    eq(v2, { id: null, username: null, name: null, parentId: 'p1', createdAt: null }) && Object.getPrototypeOf(v2) === Object.prototype && !('polluted' in {}) && !('x' in {}), JSON.stringify(v2));
  ok('network view of null / undefined → all-null 5 keys', eq(N(null, new Set()), { id: null, username: null, name: null, parentId: null, createdAt: null }) && eq(keys(N(undefined)), ['createdAt', 'id', 'name', 'parentId', 'username']));
  ok('network view never contains password / phone / isActive / any amount, for any input',
    [v1, v2, N(row, new Set(['p1']))].every((o) => ['password', 'phone', 'isActive', 'commissionRate', 'bankName', 'rib', 'totalCommission', 'bonusBalance'].every((k) => !Object.prototype.hasOwnProperty.call(o, k))));
  ok('network view takes (row, networkIds) only — 2 parameters, pure', N.length === 2);
}

// ── 7c. Phase 4 network projections (counts only) ───────────────────────────────
console.log('\n7c. Phase 4 network projections');
{
  const node = V.toRecruiterNetworkNodeView({ id: 'a1', username: 'u', name: 'N', level: 2, status: 'ACTIVE', identityStatus: 'PENDING', childrenCount: 1, descendantsCount: 3,
    orders: { real: { delivered: 2, total: 2 }, fake: { delivered: 5, total: 5 } }, password: 'h', phone: '+2126', cinFrontFile: 'k', clientName: 'c', total: 99.5 });
  ok('node view: exactly 9 keys, real and fake order counts kept apart, no password / phone / CIN / customer / amount',
    eq(Object.keys(node).sort(), ['childrenCount', 'descendantsCount', 'id', 'identityStatus', 'level', 'name', 'orders', 'status', 'username'])
    && node.orders.real.delivered === 2 && node.orders.fake.delivered === 5 && !/password|phone|cinFront|clientName|99\.5/.test(JSON.stringify(node)));
  ok('node view: status only ACTIVE / INACTIVE (else null), identity only APPROVED / PENDING / REJECTED / NONE (else NONE)',
    V.toRecruiterNetworkNodeView({ status: 'active' }).status === null && V.toRecruiterNetworkNodeView({ status: 'INACTIVE' }).status === 'INACTIVE'
    && V.toRecruiterNetworkNodeView({ identityStatus: 'approved' }).identityStatus === 'NONE' && V.toRecruiterNetworkNodeView({ identityStatus: 'REJECTED' }).identityStatus === 'REJECTED');
  const st = V.toRecruiterNetworkStatsView({ rootId: null, totals: { affiliates: 3, direct: 1, active: 2, inactive: 1, maxLevel: 2, unplaced: 0, balance: 9 }, identity: { APPROVED: 1 },
    orders: { real: { delivered: 1, total: 1 }, fake: { delivered: 1, total: 1 } }, levels: [{ level: 1, affiliates: 1 }], commission: 5 });
  ok('stats view: exact keys, unknown keys (balance / commission) dropped', eq(Object.keys(st).sort(), ['identity', 'levels', 'orders', 'rootId', 'totals'])
    && eq(Object.keys(st.totals).sort(), ['active', 'affiliates', 'direct', 'inactive', 'maxLevel', 'unplaced']) && !/balance|commission/.test(JSON.stringify(st)));
  ok('path view: exactly id / username / name / level', eq(Object.keys(V.toRecruiterNetworkPathView({ id: 'a', username: 'u', name: 'n', level: 1, password: 'x' })).sort(), ['id', 'level', 'name', 'username']));
}

// ── 7d. Phase 5 wallet projections (the recruiter's own money, MAD cents) ─────────
console.log('\n7d. Phase 5 wallet projections');
{
  const evil = JSON.parse('{"__proto__":{"polluted":"yes"},"id":7,"amountCents":"500","status":"paid","createdAt":"nope","affiliateId":"x","recruiterId":"r","amount":5,"constructor":{"prototype":{"x":"y"}}}');
  const wv = V.toRecruiterWithdrawalView(evil);
  ok('withdrawal view: exactly id / amountCents / currency / status / createdAt; hostile types → null / 0; no owner ids, no raw amount',
    eq(keys(wv), ['amountCents', 'createdAt', 'currency', 'id', 'status']) && wv.id === null && wv.amountCents === 0 && wv.currency === 'MAD' && wv.status === 'PAID' && wv.createdAt === null && !('polluted' in {}));
  ok('withdrawal status: paid → PAID; rejected / cancelled / canceled / refused → REJECTED; pending and ANY unknown status → PENDING (still reserved); already-projected PAID / REJECTED / PENDING are kept (idempotent)',
    ['rejected', 'cancelled', 'canceled', 'refused', 'REJECTED'].every((s) => V.toRecruiterWithdrawalView({ status: s }).status === 'REJECTED')
    && ['paid', 'PAID'].every((s) => V.toRecruiterWithdrawalView({ status: s }).status === 'PAID')
    && ['pending', 'PENDING', 'processing', 'approved', 'Paid', 'paid ', 'Rejected', undefined, 42].every((s) => V.toRecruiterWithdrawalView({ status: s }).status === 'PENDING')
    && eq(Object.values(V.RECRUITER_WITHDRAWAL_STATUS), ['PENDING', 'PAID', 'REJECTED']) && Object.isFrozen(V.RECRUITER_WITHDRAWAL_STATUS));
  const rh = V.toRecruiterRewardHistoryView({ type: 'RECRUIT_REWARD', amountCents: 15000, affiliate: { id: 'a1', username: 'u', name: 'N', phone: '+2126', password: 'h', isActive: true }, requiredDeliveredOrders: 10, createdAt: '2026-11-06T10:00:00.000Z', reason: '<script>', recruiterId: 'r', settingsVersion: 3 });
  ok('reward history view: exact keys; the affiliate is id / username / name only; reason is the fixed code; threshold kept',
    eq(keys(rh), ['affiliate', 'amountCents', 'createdAt', 'currency', 'reason', 'requiredDeliveredOrders', 'type']) && eq(rh.affiliate, { id: 'a1', username: 'u', name: 'N' })
    && rh.reason === 'REAL_DELIVERED_AND_CIN_APPROVED' && rh.requiredDeliveredOrders === 10 && !/phone|password|isActive|script|settingsVersion|recruiterId/.test(JSON.stringify(rh)));
  ok('reward history view: unknown type → null and no reason / threshold; non-integer amount → 0; adjustment rows keep a signed amount',
    eq(V.toRecruiterRewardHistoryView({ type: 'BONUS', amountCents: 5, requiredDeliveredOrders: 3 }), { type: null, amountCents: 5, currency: 'MAD', affiliate: null, reason: null, requiredDeliveredOrders: null, createdAt: null })
    && V.toRecruiterRewardHistoryView({ type: 'RECRUIT_REWARD', amountCents: 1.5 }).amountCents === 0 && V.toRecruiterRewardHistoryView({ type: 'REVERSAL', amountCents: -500 }).amountCents === -500);
  const bv = V.toRecruiterBankView({ bankName: 'CIH', rib: '0117', accountName: 'A', complete: 'yes', password: 'x' });
  ok('bank view: exactly bankName / rib / accountName / complete (strict boolean)', eq(keys(bv), ['accountName', 'bankName', 'complete', 'rib']) && bv.complete === false && V.toRecruiterBankView({ complete: true }).complete === true);
  const w = V.toRecruiterWalletView({
    settings: { version: 2, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 7 },
    totals: { earnedCents: 30000, availableCents: -100, pendingCents: -5, paidCents: 1.5, reservedCents: 9, balance: 1 },
    rewards: 'nope', withdrawals: [{ id: 'w', amountCents: 100, status: 'pending', recruiterId: 'r' }], bank: null, commission: 5,
  });
  ok('wallet view: exact keys; totals exactly earned / available / pending / paid / currency (negative available kept, invalid pending / paid → 0); settings via toRecruiterSettingsView',
    eq(keys(w), ['bank', 'rewards', 'settings', 'totals', 'withdrawals']) && eq(w.totals, { earnedCents: 30000, availableCents: -100, pendingCents: 0, paidCents: 0, currency: 'MAD' })
    && eq(w.settings, { rewardsEnabled: true, rewardAmountCents: 15000, currency: 'MAD', requiredDeliveredOrders: 7 }) && eq(w.rewards, []) && eq(keys(w.withdrawals[0]), ['amountCents', 'createdAt', 'currency', 'id', 'status'])
    && eq(w.bank, { bankName: null, rib: null, accountName: null, complete: false }) && !/commission|balance|reservedCents|recruiterId/.test(JSON.stringify(w)));
  ok('no global prototype pollution after the wallet projections', !('polluted' in {}) && !('x' in {}));
}

// ── 7e. Phase 5: the wallet projection is idempotent (a client may re-project a server view) ──
console.log('\n7e. Wallet projection is idempotent');
{
  const raw = {
    settings: { version: 2, enabled: true, rewardAmountCents: 20000, minDeliveredSales: 3 },
    totals: { earnedCents: 35055, availableCents: 14055, pendingCents: 11000, paidCents: 10000 },
    rewards: [{ type: 'RECRUIT_REWARD', amountCents: 15055, affiliate: { id: 'a1', username: 'u1', name: 'N1' }, requiredDeliveredOrders: 3, createdAt: new Date('2026-11-06T10:00:00Z') }],
    withdrawals: [
      { id: 'w1', amountCents: 10000, status: 'paid', createdAt: new Date('2026-11-06T11:00:00Z') },
      { id: 'w2', amountCents: 10000, status: 'rejected', createdAt: new Date('2026-11-06T11:00:00Z') },
      { id: 'w3', amountCents: 1000, status: 'pending', createdAt: new Date('2026-11-06T11:00:00Z') },
    ],
    bank: { bankName: 'CIH', rib: '1234567890', accountName: 'X', complete: true },
  };
  const once = V.toRecruiterWalletView(raw);
  const twice = V.toRecruiterWalletView(JSON.parse(JSON.stringify(once)));
  ok('re-projecting a projected wallet changes nothing (settings stay enabled 200 MAD / 3; PAID / REJECTED / PENDING kept)',
    eq(twice, once) && once.settings.rewardsEnabled === true && once.settings.rewardAmountCents === 20000 && once.settings.requiredDeliveredOrders === 3
    && eq(once.withdrawals.map((w) => w.status), ['PAID', 'REJECTED', 'PENDING']), JSON.stringify(twice));
  const forged = V.toRecruiterWalletView({ settings: { rewardsEnabled: true, rewardAmountCents: -5, requiredDeliveredOrders: 0 } }).settings;
  ok('an already-projected settings view with bad values is still sanitised (no negative amount, threshold back to the default)',
    forged.rewardsEnabled === false && forged.rewardAmountCents === 0 && forged.requiredDeliveredOrders === 10, JSON.stringify(forged));
  ok('an unknown withdrawal status (raw or projected) is still PENDING (reserved)', V.toRecruiterWithdrawalView({ status: 'processing' }).status === 'PENDING' && V.toRecruiterWithdrawalView({ status: 'PAID ' }).status === 'PENDING');
}

// ── 7f. Phase 6 part 1: activation-code projections ───────────────────────────
console.log('\n7f. Activation-code projections (the code once; pending list: state only)');
{
  const GOOD = 'AbCdEfGhIjKlMnOp.' + 'q'.repeat(43);
  const a1 = V.toRecruiterActivationCodeView({ code: GOOD, expiresAt: new Date('2026-11-06T09:00:00Z'), verifierHash: 'f'.repeat(64), selector: 'x', id: 'id1', password: '$2a$12$h' });
  ok('activation view: exactly { code, expiresAt }, the code as given, ISO expiry; never the hash / selector / id / password',
    eq(keys(a1), ['code', 'expiresAt']) && a1.code === GOOD && a1.expiresAt === '2026-11-06T09:00:00.000Z' && !/verifierHash|selector|password|\$2a/.test(JSON.stringify(a1)));
  const bad = ['short.code', GOOD + 'x', 'AbCdEfGhIjKlMnO!.' + 'q'.repeat(43), GOOD.replace('.', ':'), 42, null, undefined, ['x'], { code: GOOD }];
  ok('a malformed code (wrong lengths / characters / separator / type) → code null AND expiresAt null',
    bad.every((c) => eq(V.toRecruiterActivationCodeView({ code: c, expiresAt: new Date() }), { code: null, expiresAt: null })) && eq(V.toRecruiterActivationCodeView(null), { code: null, expiresAt: null }));
  const evilA = JSON.parse('{"__proto__":{"polluted":"yes"},"code":"' + GOOD + '","expiresAt":"not a date"}');
  ok('hostile input: prototype pollution ignored, invalid date → null', eq(V.toRecruiterActivationCodeView(evilA), { code: GOOD, expiresAt: null }) && !('polluted' in {}));
  const p1 = V.toRecruiterPendingActivationView({ affiliate: { id: 'a1', username: 'u1', name: 'N1', createdAt: '2026-11-05T09:00:00Z', password: '$2a$12$x', phone: '0612', isActive: true }, state: 'EXPIRED', expiresAt: '2026-11-06T09:00:00Z', code: GOOD, verifierHash: 'f'.repeat(64) });
  ok('pending view: exactly { affiliate: { id, username, name, createdAt }, state, expiresAt } — never a code / hash / password / phone',
    eq(keys(p1), ['affiliate', 'expiresAt', 'state']) && eq(keys(p1.affiliate), ['createdAt', 'id', 'name', 'username']) && p1.state === 'EXPIRED'
    && !JSON.stringify(p1).includes(GOOD) && !/password|phone|verifierHash|\$2a|isActive/.test(JSON.stringify(p1)));
  ok('pending state allowlist: ACTIVE / EXPIRED / INVALIDATED kept; anything else (USED, lower case, objects) → null',
    ['ACTIVE', 'EXPIRED', 'INVALIDATED'].every((st) => V.toRecruiterPendingActivationView({ state: st }).state === st)
    && ['USED', 'active', '', null, 42, { s: 'ACTIVE' }].every((st) => V.toRecruiterPendingActivationView({ state: st }).state === null));
  ok('pending view of hostile / empty input: nulls only, no throw', eq(V.toRecruiterPendingActivationView(null), { affiliate: { id: null, username: null, name: null, createdAt: null }, state: null, expiresAt: null })
    && eq(V.toRecruiterPendingActivationView({ affiliate: { id: 7, username: ['x'], name: {}, createdAt: 'nope' } }).affiliate, { id: null, username: null, name: null, createdAt: null }));
  ok('ACTIVATION_NOT_AVAILABLE passes the error projection as { code } only', eq(V.toRecruiterError({ code: 'ACTIVATION_NOT_AVAILABLE', message: 'secret', fields: { x: 1 } }), { code: 'ACTIVATION_NOT_AVAILABLE' }));
}

// ── 8. static checks ──────────────────────────────────────────────────────────
console.log('\n8. Static checks of recruiterVisibility.js');
{
  const code = stripJs(read('src/lib/recruiterVisibility.js'));
  ok('never references evaluateRecruitQualification or its unmet / reason fields in code', !/evaluateRecruitQualification|\bunmet\b|\.reason\b/.test(code));
  ok('imports only normalizeRecruiterSettings and REWARD_TYPES from recruiterSettings.js',
    eq([...code.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gm)].map((m) => [m[1].split(',').map((x) => x.trim()).sort(), m[2]]), [[['REWARD_TYPES', 'normalizeRecruiterSettings'], './recruiterSettings.js']]));
  ok('no spread / Object.assign / Object.entries / JSON passthrough of an input object in code', !/\.\.\.|Object\.assign|Object\.entries|Object\.fromEntries|JSON\.parse|structuredClone/.test(code));
  ok('every exported projection returns an object literal or null (no returned input variable)',
    !/return\s+(row|entry|settings|err|s|reward|reversal|rows)\s*;/.test(code) && (code.match(/return\s*\{/g) || []).length >= 6);
  ok('no database, network or file access in the module (no prisma, fetch, fs, import of services)', !/prisma|fetch\(|node:fs|services\//.test(code));
}

// ── 9. contract test (Phase 2+) ───────────────────────────────────────────────
console.log('\n9. CONTRACT: recruiter-facing files must use the projections only');
{
  const ALLOWED = new Set(['src/lib/recruiterSettings.js', 'src/lib/recruiterVisibility.js']);
  const walk = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir), { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(join(ROOT, f)).isFile()) : []);
  const norm = (f) => f.split(sep).join('/');
  const CODE_EXT = /\.(m?[jt]sx?|cjs)$/;
  const files = [...new Set([
    ...walk('src/app/api/recruiter'), ...walk('src/app/recruiter'),
    ...walk('src/lib').filter((f) => /recruiter/i.test(f.split(sep).pop())),
  ].map(norm))].filter((f) => CODE_EXT.test(f) && !ALLOWED.has(f)).sort();
  const isRouteFile = (f) => /^src\/app\/(api\/)?recruiter\//.test(f);
  // [label, regex, applies to: 'all' | 'route']
  const RULES = [
    ['returns / reads raw recruiter rows directly in a route or page (recruiterSettingsVersion / recruiterRewardLedger / recruiterAuditLog / their tables / raw SQL)',
      /recruiterSettingsVersion|recruiterRewardLedger|recruiterAuditLog|recruiter_settings_versions|recruiter_reward_ledger|recruiter_audit_log|\$queryRaw|\$executeRaw/, 'route'],
    ['reads UGC data (ugc / Ugc / UGC / ugcVideoSubmission / ugc_video)', /ugc/i, 'all'],
    ['touches CIN documents or file keys (cinFrontFile / cinBackFile / getCinFileForAdmin / identityStorage)', /cinFrontFile|cinBackFile|getCinFileForAdmin|identityStorage|cin_front|cin_back/i, 'all'],
    ['reads an affiliate balance, earnings, commissions, points or payouts', /balance|earning|commission|rewardPoint|reward_point|payout|withdraw/i, 'nonMoney'],
    // Phase 5 money files (docs/recruiter-system.md §6): the recruiter's OWN rewards / withdrawals may be named,
    // but affiliate money sources stay forbidden.
    ['money file reads an affiliate money source (commission / reward points / affiliate balance functions / balance providers / bonus)',
      /commission|rewardPoint|reward_point|getAffiliateBalance|getWithdrawableBalance|getAffiliateBalanceBreakdown|computeRegisteredBalance|providerRegistry|registerBalanceProvider|bonusBalance|totalCommission/i, 'money'],
    ["changes an affiliate's verification (identity writes / admin identity functions / submitIdentity)",
      /identityVerification\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|adminApproveIdentity|adminRejectIdentity|adminResetIdentity|submitIdentity|identity_verifications/, 'all'],
    ["changes an existing affiliate's parent or activation (affiliate update / upsert, parent connect, raw UPDATE)",
      /\baffiliate\.(update|updateMany|upsert)\b|parent:\s*\{\s*(connect|disconnect|set)|UPDATE\s+"?affiliates"?/i, 'all'],
    ['sends an error .message', /\.message\b/, 'all'],
  ];
  const MONEY_FILES = new Set(['src/lib/services/recruiterWalletService.js', 'src/lib/recruiterWalletRouteHandlers.js', 'src/lib/recruiterRewardAdminHandlers.js']);
  const isMoney = (f) => MONEY_FILES.has(f) || /^src\/app\/api\/recruiter\/wallet\//.test(f) || /^src\/app\/recruiter\/wallet\//.test(f);
  // Every affiliatePayout call in a money file names recruiterId inside the same call expression,
  // and no payout call ever carries an affiliateId (recruiter rows are owned by the recruiter only).
  const payoutCalls = (code) => {
    const out = [];
    for (const m of code.matchAll(/affiliatePayout\s*\.\s*(\w+)\s*\(/g)) {
      let depth = 0, i = m.index + m[0].length - 1, end = -1;
      for (; i < code.length; i++) { if (code[i] === '(') depth++; else if (code[i] === ')') { depth--; if (depth === 0) { end = i; break; } } }
      out.push({ op: m[1], text: code.slice(m.index, end + 1) });
    }
    return out;
  };
  const violations = [];
  for (const f of files) {
    const code = stripJs(read(f));
    for (const [label, re, scope] of RULES) {
      const applies = scope === 'all' || (scope === 'route' && isRouteFile(f)) || (scope === 'nonMoney' && !isMoney(f)) || (scope === 'money' && isMoney(f));
      if (applies && re.test(code)) violations.push(`${f}: ${label}`);
    }
    for (const c of payoutCalls(code)) {
      if (!isMoney(f)) violations.push(`${f}: affiliatePayout used outside the Phase 5 money files`);
      else if (!/recruiterId/.test(c.text)) violations.push(`${f}: affiliatePayout.${c.op} not scoped by recruiterId`);
      else if (/affiliateId/.test(c.text)) violations.push(`${f}: affiliatePayout.${c.op} mentions affiliateId`);
    }
    const isRoute = isRouteFile(f) && /\/(route|page)\.(m?[jt]sx?)$/.test(f);
    if (isRoute && !/from\s+['"](@\/lib\/|(\.\.\/)+(lib\/)?)recruiterVisibility(\.js)?['"]/.test(code)) violations.push(`${f}: does not import recruiterVisibility`);
  }
  const roots = ['src/app/api/recruiter/**', 'src/app/recruiter/**', 'src/lib/**/*recruiter* (any case)'];
  console.log(`    contract scan: ${files.length} file(s) under ${roots.join(', ')} (excluding ${[...ALLOWED].join(', ')})${files.length ? '\n      ' + files.join('\n      ') : ''}`);
  ok(`contract scan ran: ${files.length} recruiter-facing file(s) found${files.length === 0 ? ' — vacuous until Phase 2 adds recruiter routes / pages / services' : ''}`, Array.isArray(files) && typeof files.length === 'number');
  ok('contract: no raw recruiter rows in routes, no UGC read, no CIN file, no balance / earnings outside the Phase 5 money files (and no affiliate money source in them), no parent / verification change, no error message; every route / page imports recruiterVisibility',
    violations.length === 0, violations.join(' | '));
  const moneyScanned = files.filter(isMoney);
  ok(`Phase 5 money files are scanned under the money rules (${moneyScanned.length}: ${moneyScanned.join(', ')}) and every affiliatePayout call in them is scoped by recruiterId`,
    ['src/lib/services/recruiterWalletService.js', 'src/lib/recruiterWalletRouteHandlers.js', 'src/lib/recruiterRewardAdminHandlers.js'].every((f) => moneyScanned.includes(f))
    && payoutCalls(stripJs(read('src/lib/services/recruiterWalletService.js'))).length >= 8);
  ok('the money rule itself works: a sample with commission / getAffiliateBalance / an unscoped payout call is caught; the old rule still catches "withdraw" in a non-money file',
    RULES.find((r) => r[2] === 'money')[1].test('x.commissionRate') && RULES.find((r) => r[2] === 'money')[1].test('getAffiliateBalance(id)')
    && payoutCalls('db.affiliatePayout.findMany({ where: { status } })').every((c) => !/recruiterId/.test(c.text)) && RULES.find((r) => r[2] === 'nonMoney')[1].test('withdrawals'));
  const doc = read('docs/recruiter-system.md');
  ok('docs/recruiter-system.md states the mandatory-projection contract (all 6 functions in the table)',
    /Every recruiter-facing endpoint, page payload, statistic and error MUST be built only with\s+`src\/lib\/recruiterVisibility\.js`/.test(doc)
    && ['toRecruiterQualificationView', 'toRecruiterSettingsView', 'toRecruiterRewardView', 'toRecruiterRewardTotals', 'toRecruiterAuditView', 'toRecruiterError'].every((fn) => new RegExp(`\\| [^|]+ \\| \`${fn}\` \\|`).test(doc)));
  ok('docs/recruiter-system.md lists the forbidden items (raw rows of the 3 tables, UGC, CIN files, balance / earnings, parent / verification changes, error messages)',
    /Forbidden in recruiter-facing code/.test(doc) && /`recruiter_settings_versions`/.test(doc) && /`recruiter_reward_ledger`/.test(doc) && /`recruiter_audit_log`/.test(doc)
    && /reading any UGC table or field/.test(doc) && /CIN documents or file keys/.test(doc) && /balance or earnings/.test(doc)
    && /changing an\s+affiliate's parent or verification status/.test(doc) && /error messages \(codes only\)/.test(doc));
  ok('docs/recruiter-system.md documents immediate visibility (no delay, no jitter, real time)',
    /No delay, no jitter, no hidden reward/.test(doc) && /with its real time/.test(doc) && !/release day|2–4 Casablanca/.test(doc));
}

// ── Final decision: an earned reward stays visible whatever isActive becomes ──
console.log('\nisActive never hides or cancels an earned reward');
{
  const V2 = await import('../src/lib/recruiterVisibility.js');
  const on = { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 };
  const reward = { type: 'RECRUIT_REWARD', amountCents: 15000, affiliateId: 'a1', createdAt: new Date('2026-11-04T10:00:00Z') };
  const views = [
    V2.toRecruiterQualificationView({ reward }, on),
    V2.toRecruiterQualificationView({ reward, affiliate: { isActive: false } }, on),
    V2.toRecruiterQualificationView({ reward, isActive: false }, on),
  ].map((v) => JSON.stringify(v));
  ok('an affiliate disabled after the reward still shows EARNED (isActive is never read)',
    views.every((v) => v === JSON.stringify({ rewardStatus: 'EARNED' })), views.join(' | '));
  ok('the earned row stays in the recruiter total after a later deactivation',
    V2.toRecruiterRewardTotals([reward, { ...reward, isActive: false }].slice(0, 1)).earnedCents === 15000
    && JSON.stringify(V2.toRecruiterRewardView({ ...reward, isActive: false })) === JSON.stringify(V2.toRecruiterRewardView(reward)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
