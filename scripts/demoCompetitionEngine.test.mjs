/**
 * scripts/demoCompetitionEngine.test.mjs — the PURE Demo Competition engine.
 * Determinism, daily min/max enforcement, 1..3 orders per event, realistic spread,
 * Africa/Casablanca day boundaries (incl. clock changes), settings versions and
 * immutable snapshots, earnings formula, validation, rolling windows, ranking.
 * Run: node scripts/demoCompetitionEngine.test.mjs
 */
import * as E from '../src/lib/demoCompetition/engine.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`); }
};
const V = (over = {}) => ({ id: 'v1', effectiveFrom: 0, active: true, minDailyOrders: 5, maxDailyOrders: 50, priceCents: 30000, allocationBps: 3000,
  networkAffiliates: 0, networkMinDailyOrders: 0, networkMaxDailyOrders: 0, networkPriceCents: null, networkAllocationBps: null, ...over });

console.log('\n1. Constants and defaults');
ok('targets: exactly 21 members and 20 brands', E.MAX_MEMBERS === 21 && E.MAX_BRANDS === 20);
ok('defaults: 300 DH, member 30 % (= 90 DH), brand 70 % (= 210 DH)',
  E.DEFAULTS.priceCents === 30000 && E.DEFAULTS.memberBps === 3000 && E.DEFAULTS.brandBps === 7000
  && E.earningsCents(1, 30000, 3000) === 9000 && E.earningsCents(1, 30000, 7000) === 21000);
ok('example: 15 demo orders → 1 350 DH (member) and 3 150 DH (brand)', E.earningsCents(15, 30000, 3000) === 135000 && E.earningsCents(15, 30000, 7000) === 315000);
ok('windows are exact hours: 24 h, 168 h, 720 h; ranking window = 30 d', E.WINDOWS.h24 === 24 * 3.6e6 && E.WINDOWS.d7 === 168 * 3.6e6 && E.WINDOWS.d30 === 720 * 3.6e6 && E.RANKING_WINDOW === 'd30');

console.log('\n2. Africa/Casablanca days');
const b = E.dayBounds('2026-11-09');
ok('2026-11-09 starts at 23:00 UTC the day before (UTC+1) and lasts 24 h', new Date(b.start).toISOString() === '2026-11-08T23:00:00.000Z' && b.end - b.start === 24 * 3.6e6);
ok('dayKeyOf respects the Casablanca offset (23:30 UTC → next local day)', E.dayKeyOf(Date.parse('2026-11-08T23:30:00Z')) === '2026-11-09' && E.dayKeyOf(Date.parse('2026-11-08T22:30:00Z')) === '2026-11-08');
const lengths = ['2026-02-15', '2026-03-22'].map((k) => { const x = E.dayBounds(k); return (x.end - x.start) / 3.6e6; });
ok('clock-change days (Ramadan 2026) are 25 h and 23 h long; consecutive days chain without gap', lengths[0] === 25 && lengths[1] === 23
  && E.dayKeysBetween('2026-02-10', '2026-03-30').every((k, i, a) => i === 0 || E.dayBounds(a[i - 1]).end === E.dayBounds(k).start));
ok('dayKeysBetween / addDays are calendar-correct across months and years', E.dayKeysBetween('2026-12-30', '2027-01-02').join() === '2026-12-30,2026-12-31,2027-01-01,2027-01-02' && E.addDays('2026-03-01', -1) === '2026-02-28');
ok('backfillStart = Casablanca midnight 30 days before today', E.dayKeyOf(E.backfillStart(Date.parse('2026-11-09T10:00:00Z'))) === '2026-10-10'
  && E.backfillStart(Date.parse('2026-11-09T10:00:00Z')) === E.dayBounds('2026-10-10').start);

console.log('\n3. Daily plan: deterministic, within each profile\'s own min/max');
const ranges = [[5, 50], [10, 35], [20, 100], [0, 0], [7, 7]];
let inRange = true, deterministic = true, hitsMin = false, hitsMax = false;
for (const [mn, mx] of ranges) {
  for (const k of E.dayKeysBetween('2026-01-01', '2026-06-30')) {
    const t = E.planTarget('PERSONAL', `m-${mn}-${mx}`, k, mn, mx);
    if (t < mn || t > mx) inRange = false;
    if (t !== E.planTarget('PERSONAL', `m-${mn}-${mx}`, k, mn, mx)) deterministic = false;
    if (mn === 5 && t === 5) hitsMin = true;
    if (mn === 5 && t === 50) hitsMax = true;
  }
}
ok('181 days × 5 ranges: every target ∈ [min, max]; the bounds themselves are reachable', inRange && hitsMin && hitsMax);
ok('same (stream, profile, day) → same target', deterministic);
ok('different profiles / streams / days get different draws', new Set(['a', 'b', 'c', 'd', 'e'].map((p) => E.planTarget('PERSONAL', p, '2026-05-01', 0, 1000))).size > 3
  && E.planTarget('PERSONAL', 'x', '2026-05-01', 0, 1000) !== E.planTarget('BRAND', 'x', '2026-05-01', 0, 1000));

console.log('\n4. Schedule: 1..3 orders per event, spread over the day');
let sumsOk = true, qtyOk = true, insideOk = true, increasing = true, events = 0, orders = 0;
const hours = new Array(24).fill(0);
for (const k of E.dayKeysBetween('2026-04-01', '2026-06-30')) {
  const { start, end } = E.dayBounds(k);
  const target = E.planTarget('BRAND', 'b1', k, 10, 80);
  const s = E.daySchedule('BRAND', 'b1', k, target, start, end);
  if (s.reduce((a, x) => a + x.quantity, 0) !== target) sumsOk = false;
  if (!s.every((x) => x.quantity >= 1 && x.quantity <= 3)) qtyOk = false;
  if (!s.every((x) => x.at >= start && x.at < end)) insideOk = false;
  if (!s.every((x, i) => i === 0 || x.at > s[i - 1].at) || !s.every((x, i) => x.seq === i)) increasing = false;
  events += s.length; orders += target;
  for (const x of s) hours[Math.floor((x.at - start) / 3.6e6) % 24] += x.quantity;
}
ok('events sum exactly to the day\'s target (never all at once)', sumsOk && events > orders / 3 && events < orders);
ok('every event holds 1..3 demo orders', qtyOk);
ok('every event falls inside its Casablanca day; times strictly increasing; seq = 0..n-1', insideOk && increasing);
ok('busy evening (19–22 h) > quiet night (2–5 h) by a wide margin', hours.slice(19, 23).reduce((a, x) => a + x, 0) > 8 * hours.slice(2, 6).reduce((a, x) => a + x, 0));
ok('schedule is deterministic', JSON.stringify(E.daySchedule('BRAND', 'b1', '2026-05-05', 40, 0, 86400000)) === JSON.stringify(E.daySchedule('BRAND', 'b1', '2026-05-05', 40, 0, 86400000)));
ok('target 0 → no event', E.daySchedule('PERSONAL', 'm', '2026-05-05', 0, 0, 86400000).length === 0);

console.log('\n5. Versions, snapshots and due events');
const t0 = E.dayBounds('2026-05-01').start;
const versions = [V({ id: 'v1', effectiveFrom: new Date(t0 - 86400000) }), V({ id: 'v2', effectiveFrom: new Date(t0 + 12 * 3.6e6), priceCents: 40000, allocationBps: 2500 })];
const plan = E.buildPlan('PERSONAL', 'm1', '2026-05-01', versions);
ok('plan uses the version in force at the day start (min/max snapshot + versionId)', plan.versionId === 'v1' && plan.minOrders === 5 && plan.maxOrders === 50);
const due = E.dueEvents(plan, versions, -Infinity, plan.dayEnd);
ok('price / allocation change at noon: events before keep v1 (90 DH/order), after use v2 (100 DH/order)', due.length > 0
  && due.every((e) => (e.scheduledAt < t0 + 12 * 3.6e6 ? e.versionId === 'v1' && e.earningsCents === e.quantity * 9000 : e.versionId === 'v2' && e.earningsCents === e.quantity * 10000)));
ok('due window (from, to] filters by scheduled time; idempotency keys = stream:profile:day:seq',
  E.dueEvents(plan, versions, -Infinity, t0).length === 0 && due.every((e) => e.idempotencyKey === `PERSONAL:m1:2026-05-01:${e.seq}`));
const off = [V({ id: 'v1', effectiveFrom: new Date(t0 - 1) }), V({ id: 'v2', effectiveFrom: new Date(t0 + 6 * 3.6e6), active: false }), V({ id: 'v3', effectiveFrom: new Date(t0 + 18 * 3.6e6), active: true })];
const offEvents = E.dueEvents(E.buildPlan('PERSONAL', 'm1', '2026-05-01', off), off, -Infinity, Infinity);
ok('no event while the profile is disabled (06:00–18:00 here); generation resumes after re-activation',
  offEvents.every((e) => e.scheduledAt < t0 + 6 * 3.6e6 || e.scheduledAt >= t0 + 18 * 3.6e6) && offEvents.some((e) => e.scheduledAt >= t0 + 18 * 3.6e6));
ok('network stream OFF until both network price and allocation are set and affiliates > 0',
  E.streamParams('NETWORK', V({ networkAffiliates: 10, networkMaxDailyOrders: 10 })) === null
  && E.streamParams('NETWORK', V({ networkAffiliates: 0, networkPriceCents: 30000, networkAllocationBps: 1000, networkMaxDailyOrders: 10 })) === null
  && E.streamParams('NETWORK', V({ networkAffiliates: 5, networkPriceCents: 30000, networkAllocationBps: 1000, networkMinDailyOrders: 2, networkMaxDailyOrders: 10 })).allocationBps === 1000);
ok('no version before the profile\'s history → no plan', E.buildPlan('PERSONAL', 'm1', '2025-01-01', versions) === null);
ok('events carry the eventType of their stream', E.dueEvents(E.buildPlan('BRAND', 'b', '2026-05-01', versions), versions, -Infinity, Infinity).every((e) => e.eventType === 'BRAND_SALE'));

console.log('\n6. Validation');
const goodM = { name: 'Salma', active: true, minDailyOrders: 5, maxDailyOrders: 50, priceCents: 30000, allocationBps: 3000, networkAffiliates: 0, networkMinDailyOrders: 0, networkMaxDailyOrders: 0, networkPriceCents: null, networkAllocationBps: null };
const errs = (o) => E.validateMemberSettings({ ...goodM, ...o }).errors;
ok('valid member settings pass', E.validateMemberSettings(goodM).ok);
ok('min > max rejected (MAX_BELOW_MIN); negatives / > 1000 / non-integers rejected',
  errs({ minDailyOrders: 10, maxDailyOrders: 5 }).maxDailyOrders === 'MAX_BELOW_MIN' && errs({ minDailyOrders: -1 }).minDailyOrders && errs({ maxDailyOrders: 1001 }).maxDailyOrders && errs({ minDailyOrders: 2.5 }).minDailyOrders);
ok('allocation must be 0.01 %..100 % (1..10000 bps); price 0.01..100 000 DH',
  errs({ allocationBps: 0 }).allocationBps && errs({ allocationBps: 10001 }).allocationBps && errs({ priceCents: 0 }).priceCents && errs({ priceCents: 10_000_001 }).priceCents && !errs({ allocationBps: 10000 }).allocationBps);
ok('network rate: price and allocation set together or not at all (no assumed default rate)',
  errs({ networkPriceCents: 30000 }).networkAllocationBps === 'NETWORK_RATE_INCOMPLETE' && errs({ networkAllocationBps: 1000 }).networkAllocationBps === 'NETWORK_RATE_INCOMPLETE'
  && E.validateMemberSettings({ ...goodM, networkPriceCents: 30000, networkAllocationBps: 1000, networkAffiliates: 12, networkMinDailyOrders: 1, networkMaxDailyOrders: 9 }).ok);
ok('network order errors use the real field names (networkMinDailyOrders / networkMaxDailyOrders)',
  (() => { const e = errs({ networkMinDailyOrders: 9, networkMaxDailyOrders: 3 }); const f = errs({ networkMinDailyOrders: -1 });
    return e.networkMaxDailyOrders === 'MAX_BELOW_MIN' && f.networkMinDailyOrders === 'INVALID_MIN_ORDERS' && !Object.keys({ ...e, ...f }).some((k) => /^network(min|max)/.test(k)); })());
ok('empty / too long / HTML names rejected; whitespace normalised', errs({ name: '  ' }).name && errs({ name: 'x'.repeat(81) }).name && errs({ name: '<b>x</b>' }).name && E.normalizeName('  Salma   B. ') === 'Salma B.');
ok('brand needs an owner; same numeric rules', E.validateBrandSettings({ ...goodM, ownerId: '' }).errors.ownerId === 'OWNER_REQUIRED' && E.validateBrandSettings({ ...goodM, ownerId: 'x', allocationBps: 7000 }).ok);
// Approved decision (allocation): member and brand allocations are SEPARATE demo sales streams — each validated on
// its own (0.01 %..100 %), no combined 100 % cap (this replaces the earlier "member + brand ≤ 100 %" rule).
ok('defaults: each allocation validated on its own (no combined cap: 30 % + 100 % is valid; 0 % / > 100 % refused)',
  E.validateDefaults({ defaultPriceCents: 30000, defaultMemberBps: 3000, defaultBrandBps: 7000 }).ok
  && E.validateDefaults({ defaultPriceCents: 30000, defaultMemberBps: 3001, defaultBrandBps: 10000 }).ok
  && E.validateDefaults({ defaultPriceCents: 30000, defaultMemberBps: 0, defaultBrandBps: 7000 }).errors.defaultMemberBps === 'INVALID_ALLOCATION'
  && E.validateDefaults({ defaultPriceCents: 30000, defaultMemberBps: 3000, defaultBrandBps: 10001 }).errors.defaultBrandBps === 'INVALID_ALLOCATION');
ok('DH / % parsing: exact centimes / basis points, invalid → null', E.dhToCents('300') === 30000 && E.dhToCents('12,5') === 1250 && E.dhToCents('1.005') === null && E.dhToCents('abc') === null
  && E.percentToBps('30') === 3000 && E.percentToBps(12.5) === 1250 && E.percentToBps('') === null);

console.log('\n7. Ranking');
const rows = [
  { id: 'a', createdAt: '2026-01-01', earnings30dCents: 500, orders30d: 5 },
  { id: 'b', createdAt: '2026-01-02', earnings30dCents: 900, orders30d: 3 },
  { id: 'c', createdAt: '2026-01-03', earnings30dCents: 500, orders30d: 7 },
  { id: 'd', createdAt: '2026-01-01', earnings30dCents: 500, orders30d: 5 },
];
ok('rank by 30-day earnings; ties → 30-day orders, then oldest, then id', E.rankProfiles(rows).map((r) => r.id).join('') === 'bcad');
ok('ranks are 1..n and the input is not mutated', E.rankProfiles(rows).map((r) => r.rank).join() === '1,2,3,4' && !('rank' in rows[0]));
ok('rank change: +up / −down / null for new', E.rankChange(3, 1) === 2 && E.rankChange(1, 2) === -1 && E.rankChange(undefined, 1) === null);
ok('live = demo event within the last 10 minutes', E.isLive(new Date(1000), 1000 + 9 * 60_000) && !E.isLive(new Date(1000), 1000 + 11 * 60_000) && !E.isLive(null, 1));

console.log('\n8. Purity');
const src = readFileSync(new URL('../src/lib/demoCompetition/engine.js', import.meta.url), 'utf8');
ok('engine.js: no Math.random, no Date.now, no I/O imports', !/Math\.random|Date\.now\(|^import /m.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
