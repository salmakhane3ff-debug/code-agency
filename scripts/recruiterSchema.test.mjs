#!/usr/bin/env node
/**
 * scripts/recruiterSchema.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Recruiter System — Phase 1 (schema + settings rules). No database,
 * no I/O beyond reading repository files and `git show <base>:…` / `git diff <base>` (base = ef79c6b, the commit before the recruiter system).
 * Proves:
 *   • recruiterSettings.js: MAD only (cents), parseMadToCents, defaults (rewards OFF,
 *     10 orders), admin input validation (amount required when enabled, 1–100000
 *     orders, default 10), normalization (missing / invalid threshold → 10)
 *   • THE RULE: a reward is due when the affiliate created by the recruiter has BOTH
 *     ≥ minDeliveredSales real delivered orders AND IdentityVerification.status ===
 *     'APPROVED' — full matrix (sales 0..12 × every CIN status × thresholds 1, 10, 12);
 *     nothing else counts (no UGC, no activation, no bank details)
 *   • the data sources: DELIVERED_ORDER_STATUS 'delivered' + isFake = false (docs,
 *     schema), deliveredOrdersCount NOT used; APPROVED is set in src ONLY by
 *     adminApproveIdentity (admin route, withAdminAuth) — never by a login or a
 *     submission; identity / UGC code unchanged versus the base
 *   • the UGC / timing removal is REAL: no UGC, video, release, jitter, hmac or delay
 *     identifier in recruiterSettings.js, the migration or the recruiter schema section
 *   • the migration only CREATEs its 5 new tables (no ALTER / DROP / UPDATE / DELETE /
 *     INSERT on any existing table; "affiliates" only referenced by 2 FOREIGN KEYs …
 *     ON DELETE RESTRICT and read by the link guard; no default settings row); the
 *     settings table is exactly version, enabled, rewardAmountCents, minDeliveredSales,
 *     createdBy, createdAt with CHECK minDeliveredSales 1–100000 and enabled ⇒ amount
 *   • the Prisma schema: every existing model / enum unchanged except the two
 *     back-relation fields added to Affiliate; "verified" still appears exactly once
 * Run: node scripts/recruiterSchema.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const R = await import('../src/lib/recruiterSettings.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const git = (args) => execFileSync('git', args, { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
/** Words of the removed designs (UGC condition, release delay / jitter / keyed hash). */
const REMOVED = /ugc|video|vid[eé]o|release|jitter|hmac|delay|casablanca|minApproved/i;

// ── 1. Settings rules ─────────────────────────────────────────────────────────
console.log('\n1a. Exports, MAD only, parseMadToCents');
{
  ok('exports are exactly the documented settings API (no UGC / release / unit / bank export left)',
    eq(Object.keys(R).sort(), ['AUDIT_ACTOR_TYPES', 'CURRENCY', 'DEFAULT_MIN_DELIVERED_SALES', 'DEFAULT_RECRUITER_SETTINGS', 'DELIVERED_ORDER_STATUS',
      'IDENTITY_APPROVED_STATUS', 'MAX_REWARD_CENTS', 'MIN_SALES_RANGE', 'REWARD_TYPES', 'evaluateRecruitQualification', 'normalizeRecruiterSettings',
      'parseMadToCents', 'recruitRewardKey', 'reversalKey', 'validateRecruiterSettingsInput']), Object.keys(R).sort().join(','));
  ok('CURRENCY is MAD; MAX_REWARD_CENTS 100,000,000; MIN_SALES_RANGE {1, 100000} frozen; DEFAULT_MIN_DELIVERED_SALES 10',
    R.CURRENCY === 'MAD' && R.MAX_REWARD_CENTS === 100_000_000 && eq(R.MIN_SALES_RANGE, { min: 1, max: 100_000 }) && Object.isFrozen(R.MIN_SALES_RANGE)
    && R.DEFAULT_MIN_DELIVERED_SALES === 10);
  ok('removed constants are really gone: UGC_APPROVED_STATUSES, MAX_MIN_UGC_VIDEOS, MAX_MIN_DELIVERED_SALES, REWARD_UNITS, LINK_SOURCES',
    ['UGC_APPROVED_STATUSES', 'MAX_MIN_UGC_VIDEOS', 'MAX_MIN_DELIVERED_SALES', 'REWARD_UNITS', 'LINK_SOURCES'].every((k) => !(k in R))
    && !JSON.stringify(Object.values(R).filter((v) => typeof v !== 'function')).includes('POINTS'));
  const P = R.parseMadToCents;
  ok('valid MAD → cents: "150" 15000, "150.5" 15050, "150,50" 15050, 15.5 1550, " 7 " 700, "0" 0, "0.01" 1, 0 0',
    P('150') === 15000 && P('150.5') === 15050 && P('150,50') === 15050 && P(15.5) === 1550 && P(' 7 ') === 700 && P('0') === 0 && P('0.01') === 1 && P(0) === 0);
  ok('max "1000000" → 100,000,000 cents; "1000000.01" and "9999999" → NaN',
    P('1000000') === 100_000_000 && P(1_000_000) === 100_000_000 && Number.isNaN(P('1000000.01')) && Number.isNaN(P('9999999')));
  ok('invalid → NaN: negative, 3 decimals, letters, empty, spaces only, exponent, NaN, Infinity, null, undefined, object, boolean',
    ['-1', '1.234', '12abc', 'abc', '', '   ', '1e3', -5, NaN, Infinity, null, undefined, {}, true, '1.', '.5', '1,2,3'].every((v) => Number.isNaN(P(v))));
}

console.log('\n1b. Defaults, normalization (threshold default 10)');
{
  const d = R.DEFAULT_RECRUITER_SETTINGS;
  ok('defaults: { version 0, enabled false, 0 cents, minDeliveredSales 10 } — and nothing else', eq(d, { version: 0, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10 }));
  ok('defaults are frozen', Object.isFrozen(d));
  ok('normalizeRecruiterSettings(null / undefined) = defaults (a fresh copy)',
    eq(R.normalizeRecruiterSettings(null), { ...d }) && eq(R.normalizeRecruiterSettings(undefined), { ...d }) && R.normalizeRecruiterSettings(null) !== d);
  const row = { version: 3, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 12 };
  ok('normalize a stored row (all 4 fields kept, exactly 4 keys)', eq(R.normalizeRecruiterSettings(row), row));
  let missingOk = true;
  for (const bad of [undefined, null, 0, -1, -10, 100_001, 1e9, 1.5, 9.99, '12', '10', NaN, Infinity, true, {}, []]) {
    const n = R.normalizeRecruiterSettings({ ...row, minDeliveredSales: bad });
    if (n.minDeliveredSales !== 10) { missingOk = false; console.log('    threshold', bad, n.minDeliveredSales); }
  }
  ok('a missing or invalid stored threshold (undefined, null, 0, −1, 100001, 1.5, "12", NaN, Infinity, true, {}, []) normalizes to 10', missingOk);
  ok('a row without the threshold column at all → 10', R.normalizeRecruiterSettings({ version: 2, enabled: true, rewardAmountCents: 100 }).minDeliveredSales === 10);
  ok('the bounds 1 and 100000 are kept as they are', R.normalizeRecruiterSettings({ ...row, minDeliveredSales: 1 }).minDeliveredSales === 1
    && R.normalizeRecruiterSettings({ ...row, minDeliveredSales: 100_000 }).minDeliveredSales === 100_000);
  ok('normalize a corrupt row fails safe (enabled only when strictly true, bad cents → 0, bad threshold → 10)',
    eq(R.normalizeRecruiterSettings({ version: 'x', enabled: 'true', rewardAmountCents: 1.5, minDeliveredSales: -3 }), { version: 0, enabled: false, rewardAmountCents: 0, minDeliveredSales: 10 })
    && R.normalizeRecruiterSettings({ ...row, rewardAmountCents: 100_000_001 }).rewardAmountCents === 0 && R.normalizeRecruiterSettings({ ...row, rewardAmountCents: 100_000_000 }).rewardAmountCents === 100_000_000);
  ok('legacy / foreign stored fields are dropped (minApprovedUgcVideos, unit, requireAccountActive, bank)',
    eq(Object.keys(R.normalizeRecruiterSettings({ ...row, minApprovedUgcVideos: 2, unit: 'POINTS', requireAccountActive: true, requireBankDetails: true })).sort(),
      ['enabled', 'minDeliveredSales', 'rewardAmountCents', 'version']));
}

console.log('\n1c. validateRecruiterSettingsInput');
{
  const V = R.validateRecruiterSettingsInput;
  const good = V({ enabled: true, rewardAmountMad: '150.50', minDeliveredSales: 12 });
  ok('valid input → value in cents with exactly { enabled, rewardAmountCents, minDeliveredSales }', !good.errors && eq(good.value, { enabled: true, rewardAmountCents: 15050, minDeliveredSales: 12 }));
  ok('minDeliveredSales defaults to 10 when omitted / null / undefined (enabled or not)',
    V({}).value?.minDeliveredSales === 10 && V({ enabled: true, rewardAmountMad: '5' }).value?.minDeliveredSales === 10
    && V({ minDeliveredSales: null }).value?.minDeliveredSales === 10 && V({ minDeliveredSales: undefined }).value?.minDeliveredSales === 10);
  ok('minDeliveredSales bounds: 1 and 100000 accepted; " 42 " → 42', V({ minDeliveredSales: 1 }).value?.minDeliveredSales === 1
    && V({ minDeliveredSales: 100_000 }).value?.minDeliveredSales === 100_000 && V({ minDeliveredSales: ' 42 ' }).value?.minDeliveredSales === 42 && V({ minDeliveredSales: '1' }).value?.minDeliveredSales === 1);
  ok('minDeliveredSales out of 1–100000 or not an integer → INVALID_COUNT (0, −1, 100001, 1.5, "x", "-3", "1.0", "", {}, true), enabled or not',
    [0, '0', -1, 100_001, '100001', 1.5, 'x', '-3', '1.0', '', {}, true, NaN, Infinity].every((v) => V({ minDeliveredSales: v }).errors?.minDeliveredSales === 'INVALID_COUNT'
      && V({ enabled: true, rewardAmountMad: '10', minDeliveredSales: v }).errors?.minDeliveredSales === 'INVALID_COUNT'));
  ok('no MIN_ONE_WHEN_ENABLED code any more (0 is simply invalid)', V({ enabled: true, rewardAmountMad: '10', minDeliveredSales: 0 }).errors?.minDeliveredSales === 'INVALID_COUNT');
  ok('disabled with amount 0 / missing → accepted (0 cents)', V({ enabled: false, rewardAmountMad: '0' }).value?.rewardAmountCents === 0 && V({ enabled: false }).value?.rewardAmountCents === 0);
  ok('amount REQUIRED when enabled: 0 / "0.00" / missing / null / undefined → AMOUNT_REQUIRED_WHEN_ENABLED',
    [{ rewardAmountMad: '0' }, { rewardAmountMad: '0.00' }, {}, { rewardAmountMad: null }, { rewardAmountMad: undefined }, { rewardAmountMad: 0 }]
      .every((x) => V({ enabled: true, ...x }).errors?.rewardAmountMad === 'AMOUNT_REQUIRED_WHEN_ENABLED' && V({ enabled: 'true', ...x }).errors?.rewardAmountMad === 'AMOUNT_REQUIRED_WHEN_ENABLED'));
  ok('MAD parsing in the input: "150" → 15000, "150,5" → 15050, 0.01 → 1, "1000000" → 100000000 cents',
    V({ enabled: true, rewardAmountMad: '150' }).value?.rewardAmountCents === 15000 && V({ enabled: true, rewardAmountMad: '150,5' }).value?.rewardAmountCents === 15050
    && V({ enabled: true, rewardAmountMad: 0.01 }).value?.rewardAmountCents === 1 && V({ enabled: true, rewardAmountMad: '1000000' }).value?.rewardAmountCents === 100_000_000);
  ok('invalid amount → INVALID_AMOUNT (negative, 3 decimals, over max, junk, NaN, object, boolean)',
    ['-1', '1.234', '1000000.01', '12abc', NaN, {}, true].every((a) => V({ enabled: false, rewardAmountMad: a }).errors?.rewardAmountMad === 'INVALID_AMOUNT'));
  ok('a legacy rewardAmount (cents) field is NOT read: the MAD field is the only source',
    V({ enabled: true, rewardAmount: 1500 }).errors?.rewardAmountMad === 'AMOUNT_REQUIRED_WHEN_ENABLED');
  ok('legacy / foreign input fields are ignored and never returned (minApprovedUgcVideos, unit, requireIdentityApproved, requireBankDetails)',
    (() => { const x = V({ enabled: true, rewardAmountMad: '10', minApprovedUgcVideos: 9999, unit: 'POINTS', requireIdentityApproved: false, requireBankDetails: true }).value;
      return x && eq(Object.keys(x).sort(), ['enabled', 'minDeliveredSales', 'rewardAmountCents']); })());
  ok('several errors are reported together', (() => { const e = V({ enabled: true, rewardAmountMad: 'x', minDeliveredSales: -1 }).errors; return e && e.rewardAmountMad === 'INVALID_AMOUNT' && e.minDeliveredSales === 'INVALID_COUNT'; })());
  ok('enabled only by true / "true" (1, "yes" → false; "false" → false)', V({ enabled: 'true', rewardAmountMad: '100' }).value?.enabled === true
    && V({ enabled: 'false' }).value?.enabled === false && V({ enabled: 1 }).value?.enabled === false && V({ enabled: 'yes' }).value?.enabled === false);
  ok('non-object input → defaults-based value, never throws', (() => { try { return [null, 'x', 42, undefined].every((i) => eq(V(i).value, { enabled: false, rewardAmountCents: 0, minDeliveredSales: 10 })); } catch { return false; } })());
}

console.log('\n1d. evaluateRecruitQualification — real delivered orders AND approved CIN');
{
  const E = R.evaluateRecruitQualification;
  const on = (min) => ({ version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: min });
  const okFacts = { linked: true, affiliateExists: true, identityStatus: 'APPROVED', deliveredSales: 10 };
  ok('qualified with 10 sales + APPROVED at the default threshold: { qualified: true, reason: null, unmet: [] }', eq(E(okFacts, on(10)), { qualified: true, reason: null, unmet: [] }));
  ok('gate 1: REWARDS_DISABLED (first, even with no facts); null settings → REWARDS_DISABLED',
    eq(E({}, { ...on(10), enabled: false }), { qualified: false, reason: 'REWARDS_DISABLED', unmet: ['REWARDS_DISABLED'] }) && E(okFacts, null).reason === 'REWARDS_DISABLED');
  ok('gate 2: NO_AMOUNT (0 cents with enabled)', eq(E(okFacts, { ...on(10), rewardAmountCents: 0 }), { qualified: false, reason: 'NO_AMOUNT', unmet: ['NO_AMOUNT'] }));
  ok('gate 3: NOT_LINKED (before the affiliate check)', eq(E({ ...okFacts, linked: false }, on(10)), { qualified: false, reason: 'NOT_LINKED', unmet: ['NOT_LINKED'] }));
  ok('gate 4: AFFILIATE_NOT_FOUND (affiliateExists must be strictly true)',
    [false, undefined, null, 'true', 1].every((x) => eq(E({ ...okFacts, affiliateExists: x }, on(10)), { qualified: false, reason: 'AFFILIATE_NOT_FOUND', unmet: ['AFFILIATE_NOT_FOUND'] })));
  ok('gates also stop with null / non-object facts', E(null, on(10)).reason === 'NOT_LINKED' && E('x', on(10)).reason === 'NOT_LINKED');

  // full matrix: sales 0..12 × every CIN status × thresholds 1, 10, 12
  const STATUSES = ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', undefined, 'approved'];
  let cases = 0, matrixOk = true, qualifiedCount = 0;
  for (const min of [1, 10, 12]) for (let sales = 0; sales <= 12; sales++) for (const st of STATUSES) {
    const r = E({ linked: true, affiliateExists: true, identityStatus: st, deliveredSales: sales }, on(min));
    const want = [...(sales >= min ? [] : ['NOT_ENOUGH_SALES']), ...(st === 'APPROVED' ? [] : ['CIN_NOT_APPROVED'])];
    const shouldQualify = sales >= min && st === 'APPROVED';
    cases++; if (r.qualified) qualifiedCount++;
    if (r.qualified !== shouldQualify || !eq(r.unmet, want) || r.reason !== (want[0] ?? null) || !eq(Object.keys(r).sort(), ['qualified', 'reason', 'unmet'])) {
      matrixOk = false; console.log('    matrix', min, sales, st, JSON.stringify(r));
    }
  }
  ok(`matrix (${cases} cases: thresholds 1/10/12 × sales 0..12 × NOT_SUBMITTED/PENDING/APPROVED/REJECTED/undefined/'approved'): qualifies ⇔ sales ≥ threshold AND status === 'APPROVED' exactly; unmet in order NOT_ENOUGH_SALES, CIN_NOT_APPROVED`,
    matrixOk && cases === 3 * 13 * 6 && qualifiedCount === (12 + 3 + 1), `qualified=${qualifiedCount}`);
  ok('both unmet → reason NOT_ENOUGH_SALES, unmet [NOT_ENOUGH_SALES, CIN_NOT_APPROVED]',
    eq(E({ linked: true, affiliateExists: true, identityStatus: 'REJECTED', deliveredSales: 0 }, on(10)), { qualified: false, reason: 'NOT_ENOUGH_SALES', unmet: ['NOT_ENOUGH_SALES', 'CIN_NOT_APPROVED'] }));
  ok("CIN must be exactly 'APPROVED' (null, 'Approved', ' APPROVED', 'APPROVED ', true, 1, {} → CIN_NOT_APPROVED)",
    [null, 'Approved', ' APPROVED', 'APPROVED ', true, 1, {}].every((st) => eq(E({ ...okFacts, identityStatus: st }, on(10)).unmet, ['CIN_NOT_APPROVED'])));
  ok('9 sales < default 10 → NOT_ENOUGH_SALES; 10 → qualified (default threshold via null threshold in settings)',
    eq(E({ ...okFacts, deliveredSales: 9 }, { ...on(10), minDeliveredSales: null }).unmet, ['NOT_ENOUGH_SALES']) && E(okFacts, { ...on(10), minDeliveredSales: undefined }).qualified === true);
  ok('a corrupt stored threshold (0 / −4 / 100001) counts as 10, never as "no orders needed"',
    [0, -4, 100_001].every((m) => eq(E({ ...okFacts, deliveredSales: 9 }, { ...on(10), minDeliveredSales: m }).unmet, ['NOT_ENOUGH_SALES']) && E(okFacts, { ...on(10), minDeliveredSales: m }).qualified));
  ok('threshold 100000: 99999 sales not enough, 100000 qualifies', eq(E({ ...okFacts, deliveredSales: 99_999 }, on(100_000)).unmet, ['NOT_ENOUGH_SALES']) && E({ ...okFacts, deliveredSales: 100_000 }, on(100_000)).qualified);
  ok('invalid sales counts are treated as 0 (negative, float, string, null, NaN, undefined, Infinity)',
    [-1, 2.5, '12', null, NaN, undefined, Infinity].every((c) => eq(E({ ...okFacts, deliveredSales: c }, on(1)).unmet, ['NOT_ENOUGH_SALES'])));
  ok('ONLY the two conditions count: UGC facts, an inactive account, missing bank details or legacy switches change nothing',
    eq(E({ ...okFacts, approvedUgcVideos: 0, affiliate: { isActive: false }, isActive: false, bankDetailsComplete: false }, { ...on(10), minApprovedUgcVideos: 5, requireAccountActive: true, requireBankDetails: true }),
      { qualified: true, reason: null, unmet: [] }));
  ok('no reason code of a removed condition can ever appear (worst facts)',
    (() => { const u = E({ linked: true, affiliateExists: true, identityStatus: 'X', deliveredSales: 0, approvedUgcVideos: 0, affiliate: { isActive: false } }, on(10)).unmet;
      return eq(u, ['NOT_ENOUGH_SALES', 'CIN_NOT_APPROVED']) && !u.some((x) => /UGC|ACTIVE|BANK|IDENTITY_NOT/.test(x)); })());
  ok('recruitRewardKey / reversalKey', R.recruitRewardKey('a1') === 'recruit:a1' && R.reversalKey('a1') === 'reverse:a1');
  ok('enums: reward types and audit actors', eq(Object.values(R.REWARD_TYPES), ['RECRUIT_REWARD', 'REVERSAL', 'ADMIN_ADJUSTMENT']) && eq([...R.AUDIT_ACTOR_TYPES], ['RECRUITER', 'ADMIN', 'SYSTEM']));
}

console.log('\n1e. Data sources: real delivered orders (isFake = false) and the admin-only CIN approval');
{
  const schema = read('prisma/schema.prisma');
  const docs = read('docs/recruiter-system.md');
  const settingsSrc = read('src/lib/recruiterSettings.js');
  ok("DELIVERED_ORDER_STATUS === 'delivered' (the status the existing order code counts as delivered)",
    R.DELIVERED_ORDER_STATUS === 'delivered' && /status: 'delivered'/.test(read('src/lib/services/affiliateSystemService.js')));
  const orderModel = (/^model AffiliateOrder \{[\s\S]*?^\}/m.exec(schema) || [''])[0];
  ok('AffiliateOrder has status String @default("pending") and isFake Boolean @default(false) (the two columns the reward count uses)',
    /^\s+status\s+String\s+@default\("pending"\)/m.test(orderModel) && /^\s+isFake\s+Boolean\s+@default\(false\)/m.test(orderModel));
  ok("docs state the exact order rule: status === 'delivered' AND isFake === false; cancelled / pending / confirmed / shipped / fake never count",
    /`AffiliateOrder\.status === 'delivered'` \*\*and\*\* `isFake === false`/.test(docs) && /Cancelled, pending, confirmed, shipped and fake orders never count/.test(docs));
  ok('docs exclude affiliates.deliveredOrdersCount (it does not exclude fake orders)', /`affiliates\.deliveredOrdersCount` is NOT used: it does not exclude fake orders/.test(docs));
  ok('recruiterSettings.js documents isFake === false and never reads deliveredOrdersCount',
    /isFake === false/.test(settingsSrc) && /isFake = false/.test(settingsSrc) && !/deliveredOrdersCount/.test(settingsSrc));
  ok('docs: default 10, admin threshold 1–100000, MAD amount, immediate visibility, UGC not part of the reward',
    /default \*\*10\*\*/.test(docs) && /1–100000, default 10/.test(docs) && /\*\*recorded immediately and visible to the recruiter at once\*\*/.test(docs) && /\*\*UGC is not part of the recruiter reward\.\*\*/.test(docs));

  const { IDENTITY_STATUS } = await import('../src/lib/services/identityService.js');
  ok('IDENTITY_APPROVED_STATUS === identityService IDENTITY_STATUS.APPROVED ("APPROVED")', R.IDENTITY_APPROVED_STATUS === IDENTITY_STATUS.APPROVED && R.IDENTITY_APPROVED_STATUS === 'APPROVED');
  const idSvc = read('src/lib/services/identityService.js');
  ok('isIdentityApproved() compares status === "APPROVED" (same rule as the withdrawal gate)', /return row\?\.status === 'APPROVED';/.test(idSvc));
  const fnBody = (code, name) => { const i = code.indexOf(`export async function ${name}(`); if (i < 0) return ''; const j = code.indexOf('\n}\n', i); return code.slice(i, j + 2); };
  // every write of a status 'APPROVED' in src (excluding the generated Prisma client)
  const walk = (dir) => git(['ls-files', '--cached', '--others', '--exclude-standard', dir]).split('\n').filter((f) => /\.(m?[jt]sx?|cjs)$/.test(f) && !f.startsWith('src/generated/'));
  const srcFiles = walk('src');
  const idWriters = srcFiles.filter((f) => /identityVerification\.(create|createMany|update|updateMany|upsert)\b|identity_verifications/.test(stripJs(read(f))));
  ok('only identityService.js writes identity verifications in src (no other create / update / upsert / raw SQL)', eq(idWriters, ['src/lib/services/identityService.js']), idWriters.join(','));
  const approveBody = fnBody(idSvc, 'adminApproveIdentity');
  const approvedSetters = [...stripJs(idSvc).matchAll(/status:\s*'APPROVED'/g)].length;
  ok("in identityService.js the ONLY status: 'APPROVED' assignment is inside adminApproveIdentity",
    approvedSetters === 1 && /status: 'APPROVED'/.test(approveBody) && /db\.identityVerification\.update\(/.test(approveBody));
  const submitBody = fnBody(idSvc, 'submitIdentity');
  ok("submitIdentity never sets APPROVED: its writes set status 'PENDING' only (and it refuses an already APPROVED row)",
    submitBody.length > 500 && !/status:\s*'APPROVED'/.test(submitBody) && eq([...new Set([...submitBody.matchAll(/status:\s*'(\w+)'/g)].map((m) => m[1]))], ['PENDING'])
    && /db\.identityVerification\.upsert\(/.test(submitBody) && /existing\?\.status === 'APPROVED'/.test(submitBody));
  const adminRoute = read('src/app/api/admin/identity/route.js');
  ok('adminApproveIdentity is called only from PUT /api/admin/identity (action "approve"), wrapped in withAdminAuth',
    srcFiles.filter((f) => f !== 'src/lib/services/identityService.js' && /adminApproveIdentity\(/.test(stripJs(read(f)))).join() === 'src/app/api/admin/identity/route.js'
    && /export const PUT = withAdminAuth\(/.test(adminRoute) && /if \(action === 'approve'\) \{[\s\S]{0,200}?adminApproveIdentity\(/.test(adminRoute));
  const authRoute = read('src/app/api/affiliate/auth/route.js');
  const loginBody = fnBody(read('src/lib/services/affiliateSystemService.js'), 'loginAffiliate');
  ok('the affiliate login (POST /api/affiliate/auth → loginAffiliate) never touches identity verification or APPROVED',
    loginBody.length > 200 && !/identity|APPROVED/i.test(stripJs(loginBody)) && !/identity|APPROVED/i.test(stripJs(authRoute)) && /loginAffiliate\(/.test(authRoute));
  ok('the affiliate identity route only reads the status / submits (getIdentityStatus, submitIdentity — no admin function)',
    (() => { const r = stripJs(read('src/app/api/affiliate/identity/route.js')); return /submitIdentity/.test(r) && !/adminApproveIdentity|adminRejectIdentity|adminResetIdentity|status:\s*'APPROVED'/.test(r); })());
  // Phase 6 part 2 (documented allowance, docs/recruiter-system.md §8): the affiliate login route
  // (trusted-proxy limiter) and affiliateSystemService (session version, password-before-state
  // login, audited admin reset) changed by EXACTLY their pinned Part 2 diff; everything else is unchanged.
  const { checkUnchangedExceptPart2 } = await import('./lib/phase6Part2Allowance.mjs');
  const p2 = checkUnchangedExceptPart2('ef79c6bb1e445c964f915effe558e817844db9f0', ['src/lib/services/identityService.js', 'src/app/api/affiliate/identity/route.js',
    'src/app/api/affiliate/auth/route.js', 'src/lib/services/affiliateSystemService.js', 'src/lib/services/ugcService.js', 'src/lib/ugcStatus.js']);
  ok('identityService.js, the affiliate identity route, ugcService.js and ugcStatus.js are unchanged versus the base ef79c6b; the affiliate login route and affiliateSystemService.js differ ONLY by the exact pinned Phase 6 part 2 diff',
    p2.ok && JSON.stringify(p2.allowed) === JSON.stringify(['src/app/api/affiliate/auth/route.js', 'src/lib/services/affiliateSystemService.js']), JSON.stringify(p2));
  // Phase 5 (documented allowance, docs/recruiter-system.md §6): the admin identity route only
  // gained the post-commit recruiter reward hook around the UNCHANGED adminApproveIdentity call.
  const idDiff = git(['diff', 'ef79c6bb1e445c964f915effe558e817844db9f0', '--', 'src/app/api/admin/identity/route.js'])
    .split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  ok('the admin identity route differs from the base ONLY by the Phase 5 recruiter hook (import + approve branch: same adminApproveIdentity call, then the post-commit hook)',
    JSON.stringify(idDiff) === JSON.stringify([
      "+import { onRecruiterIdentityApprovedCommitted } from '@/lib/recruiterRewardHooks';",
      '-      return Response.json(await adminApproveIdentity(id, adminId));',
      '+      const approved = await adminApproveIdentity(id, adminId);',
      "+      // Recruiter reward (post-commit, never throws): the affiliate's CIN is now APPROVED.",
      '+      await onRecruiterIdentityApprovedCommitted(String(id));',
      '+      return Response.json(approved);',
    ]), JSON.stringify(idDiff));
  ok('recruiterSettings.js has no bank logic (no requireBankDetails / bankName / accountName / rib / bank)', !/requireBankDetails|bankName|accountName|\brib\b|bank/i.test(settingsSrc));
}

console.log('\n1f. The UGC condition and the release timing are really removed');
{
  const settingsSrc = read('src/lib/recruiterSettings.js');
  const visSrc = read('src/lib/recruiterVisibility.js');
  ok('recruiterSettings.js CODE has no ugc / video / release / jitter / hmac / delay / Casablanca / minApproved identifier', !REMOVED.test(stripJs(settingsSrc)), (REMOVED.exec(stripJs(settingsSrc)) || [])[0]);
  ok('recruiterVisibility.js CODE has no ugc / video / release / jitter / hmac / delay / Casablanca / minApproved identifier', !REMOVED.test(stripJs(visSrc)), (REMOVED.exec(stripJs(visSrc)) || [])[0]);
  ok('neither module reads the clock, a time zone, a hash or randomness (no Date.now, Intl, timeZone, crypto, Math.random, createHmac)',
    ![settingsSrc, visSrc].some((s) => /Date\.now|Intl\.|timeZone|crypto|Math\.random|createHmac|nowMs/.test(stripJs(s))));
  ok('the only comment mentions are the explicit negations ("no UGC data of any kind", "no delay, no hidden reward")',
    (settingsSrc.match(REMOVED) || []).length === 1 && /no UGC data of any kind/.test(settingsSrc) && (visSrc.match(/ugc|release|jitter|hmac|delay/gi) || []).length === 1 && /no delay, no hidden reward/.test(visSrc));
}

// ── 2. Migration (static) ─────────────────────────────────────────────────────
console.log('\n2. Migration 20261105_affiliate_recruiter_system (static)');
const NEW_TABLES = ['recruiters', 'recruiter_affiliate_links', 'recruiter_reward_ledger', 'recruiter_audit_log', 'recruiter_settings_versions'];
{
  const sql = read('prisma/migrations/20261105_affiliate_recruiter_system/migration.sql');
  const code = sql.replace(/--.*$/gm, ''); // comments removed
  const created = [...code.matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g)].map((m) => m[1]);
  ok('creates exactly the 5 new tables', eq(created.sort(), [...NEW_TABLES].sort()), created.join(','));
  const altered = [...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
  ok('every ALTER TABLE targets a new table', altered.length > 0 && altered.every((t) => NEW_TABLES.includes(t)), [...new Set(altered)].join(','));
  const indexed = [...code.matchAll(/INDEX IF NOT EXISTS "[^"]+"\s+ON "([a-z_]+)"/g)].map((m) => m[1]);
  ok('every index is on a new table', indexed.length > 0 && indexed.every((t) => NEW_TABLES.includes(t)), [...new Set(indexed)].join(','));
  const triggers = [...code.matchAll(/CREATE TRIGGER "[^"]+"[^;]*? ON "([a-z_]+)"/g)].map((m) => m[1]);
  ok('every trigger is on a new table (incl. the BEFORE INSERT link guard)', triggers.length > 0 && triggers.every((t) => NEW_TABLES.includes(t))
    && /CREATE TRIGGER "recruiter_affiliate_links_new_only" BEFORE INSERT ON "recruiter_affiliate_links"/.test(code), triggers.join(','));
  const dropped = [...code.matchAll(/DROP TRIGGER IF EXISTS "[^"]+" ON "([a-z_]+)"/g)].map((m) => m[1]);
  ok('the only DROP statements are DROP TRIGGER IF EXISTS on new tables', dropped.every((t) => NEW_TABLES.includes(t))
    && (code.match(/\bDROP\b/g) || []).length === dropped.length);
  ok('no INSERT / UPDATE / DELETE / TRUNCATE statement (no data change, no default settings row)',
    !/\bINSERT\s+INTO\b/i.test(code) && !/^\s*UPDATE\s/im.test(code) && !/^\s*DELETE\s+FROM\b/im.test(code) && !/^\s*TRUNCATE\b/im.test(code));
  const affRefs = [...code.matchAll(/"affiliates"/g)].length;
  const affFks = [...code.matchAll(/REFERENCES "affiliates"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/g)].length;
  const affReads = [...code.matchAll(/FROM "affiliates" WHERE "id" = NEW\."affiliateId"/g)].length;
  ok('"affiliates" is referenced only by the 2 FOREIGN KEYs … ON DELETE RESTRICT and 1 read-only SELECT in the link guard',
    affRefs === 3 && affFks === 2 && affReads === 1, `${affRefs} refs, ${affFks} fks, ${affReads} reads`);
  ok('nothing writes to "affiliates" (no INSERT INTO / UPDATE / DELETE FROM / ALTER TABLE "affiliates")',
    !/(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|TRUNCATE)\s+"affiliates"/i.test(code));
  const existing = ['users', 'affiliate_orders', 'affiliate_payouts', 'identity_verifications', 'reward_points_accounts', 'reward_points_ledger', 'settings', 'payment_proofs', 'brand_accesses', 'ugc_video_submissions'];
  ok('no other existing table is named anywhere (incl. identity_verifications, affiliate_orders, UGC)', existing.every((t) => !code.includes(`"${t}"`)));
  ok('no explicit transaction statements', !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(code));
  ok('re-runnable: every CREATE TABLE / INDEX uses IF NOT EXISTS; every ADD CONSTRAINT is guarded by duplicate_object',
    (code.match(/CREATE TABLE /g) || []).length === (code.match(/CREATE TABLE IF NOT EXISTS/g) || []).length
    && (code.match(/CREATE (UNIQUE )?INDEX /g) || []).length === (code.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) || []).length
    && (code.match(/ADD CONSTRAINT/g) || []).length === (code.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || []).length);
  ok('append-only guards on links, ledger, audit log and settings (UPDATE/DELETE + TRUNCATE)',
    ['recruiter_affiliate_links', 'recruiter_reward_ledger', 'recruiter_audit_log', 'recruiter_settings_versions'].every((t) =>
      new RegExp(`BEFORE UPDATE OR DELETE ON "${t}"`).test(code) && new RegExp(`BEFORE TRUNCATE ON "${t}"`).test(code)));
  ok('partial unique indexes: one RECRUIT_REWARD and one REVERSAL per affiliate',
    /ON "recruiter_reward_ledger"\("affiliateId"\) WHERE "type" = 'RECRUIT_REWARD'/.test(code) && /ON "recruiter_reward_ledger"\("affiliateId"\) WHERE "type" = 'REVERSAL'/.test(code));
  ok('MAD only: "amountCents" / "rewardAmountCents" columns; no POINTS, unit, rewardUnit, MAD_CENTS, "amount" or "rewardAmount" column',
    /"amountCents"\s+INTEGER\s+NOT NULL/.test(code) && /"rewardAmountCents"\s+INTEGER\s+NOT NULL/.test(code)
    && !/POINTS|MAD_CENTS|"unit"|"rewardUnit"|"amount"\s|"rewardAmount"\s/.test(code));
  ok('no assignment of existing affiliates: no ASSIGNED_BY_ADMIN, CREATED_BY_RECRUITER or "source" column', !/ASSIGNED_BY_ADMIN|CREATED_BY_RECRUITER|"source"/.test(code));
  ok('no VERIFIED_RECRUIT anywhere in the migration (comments included)', !/VERIFIED_RECRUIT/.test(sql));
  ok('the UGC / timing removal is real in the migration: no ugc / video / release / jitter / hmac / delay / minApproved word (comments included)', !REMOVED.test(sql), (REMOVED.exec(sql) || [])[0]);
  const guard = (/CREATE OR REPLACE FUNCTION recruiter_link_new_affiliate_only\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/.exec(code) || [''])[0];
  ok('link guard: same transaction (xmin = txid_current()) and still inactive',
    /xmin::text = \(txid_current\(\) % 4294967296\)::text/.test(guard) && /OR a\."isActive"/.test(guard) && /NOT a\.in_this_tx/.test(guard));
  ok('link guard: createdAt compared in UTC — lower bound (now() AT TIME ZONE \'UTC\') − 2 minutes',
    /a\."createdAt" < \(\(now\(\) AT TIME ZONE 'UTC'\) - interval '2 minutes'\)/.test(guard));
  ok('link guard: future bound — createdAt > (now() AT TIME ZONE \'UTC\') + 1 minute is rejected',
    /a\."createdAt" > \(\(now\(\) AT TIME ZONE 'UTC'\) \+ interval '1 minute'\)/.test(guard));
  ok('link guard: no 10-minute window left and no session-timezone-dependent now() comparison',
    !/10 minutes/.test(guard) && (guard.match(/now\(\)/g) || []).length === 2 && (guard.match(/now\(\) AT TIME ZONE 'UTC'/g) || []).length === 2);
  ok('link guard: the known limits are documented in the migration comment (createdAt rewrite, < 2-minute touch, SAVEPOINT fail-closed)',
    /rewrites an existing affiliate's "createdAt"/.test(sql) && /touches a < 2-minute-old affiliate/.test(sql) && /SAVEPOINT/.test(sql) && /fail closed/.test(sql));
  const check = (/ADD CONSTRAINT "recruiter_settings_versions_check"([\s\S]*?)EXCEPTION/.exec(code) || ['', ''])[1];
  ok('settings CHECK: version ≥ 1, cents 0–100,000,000, minDeliveredSales BETWEEN 1 AND 100000, enabled ⇒ cents > 0, createdBy non-empty',
    /"version" >= 1/.test(check) && /"rewardAmountCents" >= 0 AND "rewardAmountCents" <= 100000000/.test(check)
    && /"minDeliveredSales" BETWEEN 1 AND 100000/.test(check) && /\(NOT "enabled" OR "rewardAmountCents" > 0\)/.test(check) && /char_length\("createdBy"\) > 0/.test(check)
    && !/BETWEEN 0 AND/.test(check), check.replace(/\s+/g, ' '));
  ok('settings table columns are exactly version, enabled, rewardAmountCents, minDeliveredSales, createdBy, createdAt (no DB default for the threshold)',
    (() => { const t = /CREATE TABLE IF NOT EXISTS "recruiter_settings_versions" \(([\s\S]*?)CONSTRAINT/.exec(code); const cols = t ? [...t[1].matchAll(/^\s*"(\w+)"/gm)].map((m) => m[1]) : [];
      return eq(cols, ['version', 'enabled', 'rewardAmountCents', 'minDeliveredSales', 'createdBy', 'createdAt']) && /"minDeliveredSales" INTEGER\s+NOT NULL,/.test(t[1]); })());
  ok('no requireBankDetails / requireAccountActive / requireIdentityApproved / bank / rib / bankName / accountName in the migration (comments included)',
    !/requireBankDetails|requireAccountActive|requireIdentityApproved|bankName|accountName|\brib\b|bank/i.test(sql));
}

// ── 3. Prisma schema vs the pre-recruiter base (ef79c6b) ─────────────────────
console.log('\n3. Prisma schema (vs pre-recruiter base ef79c6b)');
{
  const now = read('prisma/schema.prisma');
  const head = git(['show', 'ef79c6bb1e445c964f915effe558e817844db9f0:prisma/schema.prisma']);
  const blocks = (s) => {
    const out = new Map();
    for (const m of s.matchAll(/^(model|enum)\s+(\w+)\s*\{[\s\S]*?^\}/gm)) out.set(`${m[1]} ${m[2]}`, m[0]);
    return out;
  };
  const H = blocks(head), N = blocks(now);
  const NEW_MODELS = ['Recruiter', 'RecruiterAffiliateLink', 'RecruiterRewardLedger', 'RecruiterAuditLog', 'RecruiterSettingsVersion'].map((m) => `model ${m}`);
  const added = [...N.keys()].filter((k) => !H.has(k));
  const removed = [...H.keys()].filter((k) => !N.has(k));
  // Phase 6 part 1 (documented in docs/recruiter-system.md): + model AffiliateActivationCode (migration 20261107)
  // and + model AffiliateActivationRecovery (admin activation recovery, migration 20261108).
  const P6_MODELS = ['model AffiliateActivationCode', 'model AffiliateActivationRecovery'];
  ok('exactly the 5 recruiter models (+ the Phase 6 AffiliateActivationCode and AffiliateActivationRecovery) were added; no model / enum removed', eq(added.sort(), [...NEW_MODELS, ...P6_MODELS].sort()) && removed.length === 0, `added=${added} removed=${removed}`);
  ok('Phase 6 recovery: AffiliateActivationRecovery stores no code (only the FK activationCodeId), FKs RESTRICT, mapped to affiliate_activation_recoveries; the code model only gains its back-relation + the ADMIN_RECOVERY comment',
    /activationCodeId\s+String\?/.test(N.get('model AffiliateActivationRecovery')) && !/\b(code|plain|secret|password|selector|verifierHash)\s+String/i.test(N.get('model AffiliateActivationRecovery'))
    && (N.get('model AffiliateActivationRecovery').match(/onDelete: Restrict/g) || []).length === 2 && /@@map\("affiliate_activation_recoveries"\)/.test(N.get('model AffiliateActivationRecovery'))
    && /recoveries\s+AffiliateActivationRecovery\[\]/.test(N.get('model AffiliateActivationCode')) && /ADMIN_RECOVERY/.test(N.get('model AffiliateActivationCode')));
  ok('Phase 6: AffiliateActivationCode stores a hash + selector only (no code / plaintext column), FK RESTRICT, mapped to affiliate_activation_codes',
    /verifierHash\s+String\b/.test(N.get('model AffiliateActivationCode')) && /selector\s+String\s+@unique/.test(N.get('model AffiliateActivationCode'))
    && !/\b(code|plain|secret|password)\s+String/i.test(N.get('model AffiliateActivationCode')) && /onDelete: Restrict/.test(N.get('model AffiliateActivationCode'))
    && /@@map\("affiliate_activation_codes"\)/.test(N.get('model AffiliateActivationCode')));
  const changed = [...H.keys()].filter((k) => N.has(k) && N.get(k) !== H.get(k));
  ok('the only changed existing blocks are model Affiliate and (Phase 5, documented) model AffiliatePayout — AffiliateOrder, IdentityVerification, UgcVideoSubmission untouched',
    eq(changed.sort(), ['model Affiliate', 'model AffiliatePayout']), changed.join(','));
  {
    // Phase 5 allowance (docs/recruiter-system.md §6, migration 20261106): recruiter withdrawals reuse
    // affiliate_payouts — affiliateId optional, recruiterId + its relation + index, the existing
    // affiliate FK kept explicit (onDelete: Restrict = the existing FK), 3 comment lines. Nothing else.
    const norm = (b) => b.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
    const nowLines = norm(N.get('model AffiliatePayout'));
    const comments = nowLines.filter((l) => l.startsWith('//'));
    const code = nowLines.filter((l) => !l.startsWith('//'));
    ok('model AffiliatePayout changed EXACTLY as documented (affiliateId?, affiliate relation with onDelete: Restrict, recruiterId?, recruiter relation, @@index([recruiterId]), 3 comment lines)',
      eq(code, [
        'model AffiliatePayout {', 'id String @id @default(uuid())', 'affiliateId String?', 'amount Float', 'status String @default("pending")', 'createdAt DateTime @default(now())',
        'affiliate Affiliate? @relation(fields: [affiliateId], references: [id], onDelete: Restrict) // = the existing FK (unchanged)',
        'recruiterId String?', 'recruiter Recruiter? @relation(fields: [recruiterId], references: [id], onDelete: Restrict)', '',
        '@@index([affiliateId])', '@@index([status])', '@@index([recruiterId])', '@@map("affiliate_payouts")', '}',
      ]) && comments.length === 3 && comments[0].startsWith('// Owner: EXACTLY ONE of affiliateId / recruiterId'), JSON.stringify(code));
    const base = norm(H.get('model AffiliatePayout'));
    ok('…every base AffiliatePayout field keeps its type except affiliateId (now optional) and the affiliate relation (now optional, same FK)',
      ['id String @id @default(uuid())', 'amount Float', 'status String @default("pending")', 'createdAt DateTime @default(now())', '@@index([affiliateId])', '@@index([status])', '@@map("affiliate_payouts")']
        .every((l) => base.includes(l) && code.includes(l)) && base.includes('affiliateId String') && base.includes('affiliate Affiliate @relation(fields: [affiliateId], references: [id])'));
  }
  const hl = H.get('model Affiliate').split('\n'), nl = N.get('model Affiliate').split('\n');
  const extra = nl.filter((l) => !hl.includes(l));
  const missing = hl.filter((l) => !nl.includes(l));
  ok('Affiliate gained only the 2 back-relation fields (+ their comment), the Phase 6 activationCodes / activationRecoveries back-relations and the Phase 6 part 2 tokenVersion field (+ its 2-line comment); no line removed or altered',
    missing.length === 0 && extra.length === 8
    && extra.includes('  // Session version (Phase 6 part 2): every token carries it; bumped on disable / enable /')
    && extra.includes('  // password change / admin reset, so older tokens are rejected (a token without it = 0).')
    && extra.includes('  tokenVersion         Int                     @default(0)')
    && extra.includes('  activationCodes      AffiliateActivationCode[]')
    && extra.includes('  activationRecoveries AffiliateActivationRecovery[]')
    && extra.some((l) => /^\s+recruiterLink\s+RecruiterAffiliateLink\?\s*$/.test(l))
    && extra.some((l) => /^\s+recruiterRewards\s+RecruiterRewardLedger\[\]\s*$/.test(l))
    && extra.some((l) => /^\s+\/\/ Affiliate Recruiter System/.test(l)), JSON.stringify({ extra, missing }));
  ok('enum Role unchanged (ADMIN, AFFILIATE, CUSTOMER — no RECRUITER)', N.get('enum Role') === H.get('enum Role') && !/RECRUITER/.test(N.get('enum Role')));
  ok('the text outside every model / enum block is unchanged except the appended recruiter section header',
    (() => {
      const strip = (s) => s.replace(/^(model|enum)\s+(\w+)\s*\{[\s\S]*?^\}/gm, '').replace(/\n{2,}/g, '\n').trim();
      const sh = strip(head), sn = strip(now);
      return sn.startsWith(sh) && /Affiliate Recruiter System/.test(sn.slice(sh.length));
    })());
  const rec = N.get('model RecruiterAffiliateLink');
  ok('link: affiliateId is the primary key (one recruiter per affiliate), RESTRICT on both relations, no source field',
    /affiliateId String\s+@id/.test(rec) && (rec.match(/onDelete: Restrict/g) || []).length === 2 && !/\bsource\b/.test(rec));
  ok('every recruiter relation uses onDelete: Restrict', NEW_MODELS.every((m) => (N.get(m).match(/@relation\(/g) || []).length === (N.get(m).match(/onDelete: Restrict/g) || []).length));
  ok('@@map names = the 5 migration tables', NEW_MODELS.map((m) => /@@map\("([a-z_]+)"\)/.exec(N.get(m))[1]).sort().join() === [...NEW_TABLES].sort().join());
  const section = now.slice(now.indexOf('// ── Affiliate Recruiter System'));
  ok('the recruiter section has no POINTS / unit / rewardUnit / MAD_CENTS / ASSIGNED_BY_ADMIN / source',
    section.length > 0 && !/POINTS|\bunit\b|rewardUnit|MAD_CENTS|ASSIGNED_BY_ADMIN|CREATED_BY_RECRUITER|\bsource\b/.test(section));
  ok('the UGC / timing removal is real in the recruiter schema section (and the 3 Affiliate back-relation lines): no ugc / video / release / jitter / hmac / delay / minApproved',
    section.length > 1000 && !REMOVED.test(section) && !extra.some((l) => REMOVED.test(l)), (REMOVED.exec(section) || [])[0]);
  ok('ledger amountCents Int; settings model fields exactly version, enabled, rewardAmountCents, minDeliveredSales, createdBy, createdAt',
    /amountCents\s+Int\b/.test(N.get('model RecruiterRewardLedger'))
    && eq([...N.get('model RecruiterSettingsVersion').matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]), ['version', 'enabled', 'rewardAmountCents', 'minDeliveredSales', 'createdBy', 'createdAt']));
  // Phase 5 allowance: the Recruiter model carries its OWN bank details for withdrawals (exactly
  // these 4 lines). The reward rule, settings and ledger still never reference bank / active / identity requirements.
  const BANK_LINES = ['// Bank details for withdrawals (Phase 5) — same fields and rules as the affiliate ones.', 'bankName String?', 'rib String?', 'accountName String?'];
  const recLines = N.get('model Recruiter').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  ok('model Recruiter has exactly the 4 documented Phase 5 bank lines (all optional) and the payouts back-relation',
    BANK_LINES.every((l) => recLines.filter((x) => x === l).length === 1) && recLines.filter((x) => /bank|\brib\b|accountName/i.test(x)).length === 4 && recLines.includes('payouts AffiliatePayout[]'));
  const sectionNoBank = section.split('\n').filter((l) => !BANK_LINES.includes(l.replace(/\s+/g, ' ').trim())).join('\n');
  ok('apart from those Recruiter bank lines, the recruiter schema section has no requireBankDetails / requireAccountActive / requireIdentityApproved / bank / rib / bankName / accountName',
    !/requireBankDetails|requireAccountActive|requireIdentityApproved|bankName|accountName|\brib\b|bank/i.test(sectionNoBank));
  ok('the reward models (ledger, settings versions) have no bank / active / identity requirement field',
    ['model RecruiterRewardLedger', 'model RecruiterSettingsVersion'].every((m) => !/bank|\brib\b|accountName|isActive|requireIdentity|identity/i.test(N.get(m))));
  ok('"verified" (any case) still appears exactly once in schema.prisma (feedbackCarouselInteraction rule)', (now.match(/verified/gi) || []).length === 1);
}

// ── Final decision: isActive is NOT a condition (only real delivered orders + APPROVED CIN) ──
console.log('\nisActive is not a recruiter-reward condition');
{
  const R2 = await import('../src/lib/recruiterSettings.js');
  const on = { version: 1, enabled: true, rewardAmountCents: 15000, minDeliveredSales: 10 };
  const met = { linked: true, affiliateExists: true, identityStatus: 'APPROVED', deliveredSales: 10 };
  const variants = [
    met,
    { ...met, isActive: false }, { ...met, isActive: true }, { ...met, isActive: undefined },
    { ...met, affiliate: { isActive: false } }, { ...met, accountActive: false },
  ];
  const results = variants.map((f) => JSON.stringify(R2.evaluateRecruitQualification(f, on)));
  ok('with 10 real delivered orders + APPROVED CIN the reward is due whatever isActive is (true / false / missing / nested)',
    results.every((r) => r === JSON.stringify({ qualified: true, reason: null, unmet: [] })), results.join(' | '));
  ok('a disabled affiliate (isActive false) that meets both conditions still qualifies — deactivation never blocks or cancels it',
    R2.evaluateRecruitQualification({ ...met, isActive: false, affiliate: { isActive: false } }, on).qualified === true);
  ok('isActive false never ADDS an unmet reason: unmet lists only NOT_ENOUGH_SALES / CIN_NOT_APPROVED',
    eq(R2.evaluateRecruitQualification({ ...met, deliveredSales: 9, identityStatus: 'PENDING', isActive: false }, on).unmet, ['NOT_ENOUGH_SALES', 'CIN_NOT_APPROVED']));
  ok('the only two conditions: 9 orders → NOT_ENOUGH_SALES only; non-APPROVED CIN → CIN_NOT_APPROVED only',
    eq(R2.evaluateRecruitQualification({ ...met, deliveredSales: 9 }, on).unmet, ['NOT_ENOUGH_SALES'])
    && eq(R2.evaluateRecruitQualification({ ...met, identityStatus: 'REJECTED' }, on).unmet, ['CIN_NOT_APPROVED']));
  const src = read('src/lib/recruiterSettings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('recruiterSettings.js code never reads isActive (or any activation flag)', !/isActive|accountActive|requireAccountActive/.test(src));
  const vis = read('src/lib/recruiterVisibility.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('recruiterVisibility.js code never reads isActive', !/isActive/.test(vis));
  const doc = read('docs/recruiter-system.md');
  ok('docs state: only two conditions, isActive is not a condition and a later deactivation does not cancel an earned reward',
    /ONLY two conditions/.test(doc) && /`affiliates\.isActive`[^.]*\*\*not\*\* a condition/.test(doc) && /earned reward is \*\*not\*\* cancelled because of `isActive`/.test(doc));
  ok('docs state: fake orders never count; returns / later CIN changes are a manual admin step in a later phase',
    /Fake orders never count/.test(doc) && /handled manually by an admin in a later phase/.test(doc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
