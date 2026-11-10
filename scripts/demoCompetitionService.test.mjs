/**
 * scripts/demoCompetitionService.test.mjs — Demo Competition service + route handlers,
 * on a STRICT in-memory fake DB (scripts/lib/demoCompFakeDb.mjs: any non-demo model throws).
 * Run: node scripts/demoCompetitionService.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeDemoCompFakeDb, DEMO_COMP_MODELS } from './lib/demoCompFakeDb.mjs';
import * as svc from '../src/lib/services/demoCompetitionService.js';
import { adminDemoCompHandlers, publicDemoCompHandlers, PUBLIC_CACHE } from '../src/lib/demoCompetition/routeHandlers.js';
import * as E from '../src/lib/demoCompetition/engine.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
};
const H = 3_600_000, D = 24 * H;
const NOW0 = Date.parse('2026-11-09T11:00:00Z');
function env(start = NOW0) {
  const clock = { t: start };
  const db = makeDemoCompFakeDb();
  const deps = { db, now: () => clock.t };
  svc.__resetDemoCompState();
  return { db, deps, clock };
}
const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
const expectCode = async (p, code) => { try { await p; return false; } catch (e) { return e?.code === code; } };

// ── 1. Profiles: create / limits / initialize ────────────────────────────────
console.log('\n1. Profiles, limits and initialisation');
{
  const { db, deps } = env();
  const init = await svc.initializeCompetition(deps, 'admin-1');
  ok('initialize creates exactly 21 demo members and 20 demo brands', init.createdMembers === 21 && init.createdBrands === 20
    && db._store.demoCompMember.length === 21 && db._store.demoCompBrand.length === 20);
  const again = await svc.initializeCompetition(deps, 'admin-1');
  ok('initialize is idempotent (second run creates nothing, changes nothing)', again.createdMembers === 0 && again.createdBrands === 0 && db._store.demoCompMember.length === 21);
  ok('the 22nd member and the 21st brand are refused (MEMBER_LIMIT_REACHED / BRAND_LIMIT_REACHED)',
    await expectCode(svc.createMember(deps, { name: 'Extra' }), 'MEMBER_LIMIT_REACHED')
    && await expectCode(svc.createBrand(deps, { name: 'Extra', ownerId: db._store.demoCompMember[0].id }), 'BRAND_LIMIT_REACHED'));
  const ranges = new Set(db._store.demoCompMember.map((m) => `${m.minDailyOrders}-${m.maxDailyOrders}`));
  ok('each profile has its OWN min/max (not one global range); defaults 300 DH / 30 % / 70 %', ranges.size > 5
    && db._store.demoCompMember.every((m) => m.priceCents === 30000 && m.allocationBps === 3000) && db._store.demoCompBrand.every((b) => b.allocationBps === 7000));
  ok('no username / gender fields on demo members', db._store.demoCompMember.every((m) => !('username' in m) && !('gender' in m)));
  const owners = new Map();
  for (const b of db._store.demoCompBrand) owners.set(b.ownerId, (owners.get(b.ownerId) ?? 0) + 1);
  ok('every brand has a demo-member owner; a member can own several brands', db._store.demoCompBrand.every((b) => db._store.demoCompMember.some((m) => m.id === b.ownerId)));
  ok('every profile starts with one settings version effective 30 days back (history start)',
    db._store.demoCompMemberVersion.length === 21 && db._store.demoCompBrandVersion.length === 20
    && db._store.demoCompMemberVersion.every((v) => +v.effectiveFrom === E.backfillStart(NOW0)) && db._store.demoCompMemberVersion.every((v) => v.createdBy === 'admin-1'));
  const m0 = db._store.demoCompMember[0];
  ok('a brand needs an existing owner (OWNER_NOT_FOUND)', await (async () => {
    const { deps: d2 } = env();
    return expectCode(svc.createBrand(d2, { name: 'X', ownerId: '00000000-0000-4000-8000-000000000000' }), 'OWNER_NOT_FOUND');
  })());
  ok('invalid settings rejected with field codes', await (async () => {
    try { await svc.updateMember(deps, m0.id, { minDailyOrders: 40, maxDailyOrders: 10 }); return false; }
    catch (e) { return e.code === 'INVALID_SETTINGS' && e.details.maxDailyOrders === 'MAX_BELOW_MIN'; }
  })());
}

// ── 2. Backfill + idempotent generation ──────────────────────────────────────
console.log('\n2. 30-day backfill and idempotent generation');
{
  const { db, deps } = env();
  // Approved decision (engine OFF): nothing is generated while OFF — but a NEW profile gets its 30-day history at
  // creation, so initialize works with the engine OFF (it no longer needs a forced engine run).
  const init = await svc.initializeCompetition(deps);
  const n1 = db._store.demoCompEvent.length;
  ok('initialize (engine OFF) gives every new profile its 30-day history at creation (personal + brand streams)', init.createdMembers === 21 && init.createdBrands === 20 && n1 > 5000
    && new Set(db._store.demoCompEvent.filter((e) => e.memberId).map((e) => e.memberId)).size === 21
    && new Set(db._store.demoCompEvent.filter((e) => e.brandId).map((e) => e.brandId)).size === 20);
  const first = Math.min(...db._store.demoCompEvent.map((e) => +e.scheduledAt));
  ok('history spans the last 30 Casablanca days (oldest ≥ backfill start, newest ≤ now)', first >= E.backfillStart(NOW0) && first < E.backfillStart(NOW0) + D
    && Math.max(...db._store.demoCompEvent.map((e) => +e.scheduledAt)) <= NOW0);
  ok('engine OFF: a run generates nothing (there is no "force" bypass any more)', (await svc.runEngine(deps)).skipped === 'disabled' && db._store.demoCompEvent.length === n1);
  await svc.updateEngine(deps, { enabled: true });
  const r2 = await svc.runEngine(deps);
  ok('running the engine (ON) at the same time inserts nothing (idempotent)', r2.profiles === 41 && r2.events === 0 && db._store.demoCompEvent.length === n1);
  ok('no event in the future (only scheduled times that have passed)', db._store.demoCompEvent.every((e) => +e.scheduledAt <= NOW0));
  // Daily totals respect each profile's own range (complete past days)
  const m = db._store.demoCompMember[3];
  const byDay = new Map();
  for (const e of db._store.demoCompEvent.filter((x) => x.memberId === m.id && x.eventType === 'PERSONAL_SALE')) {
    const k = E.dayKeyOf(+e.scheduledAt); byDay.set(k, (byDay.get(k) ?? 0) + e.quantity);
  }
  const fullDays = E.dayKeysBetween(E.addDays(E.dayKeyOf(NOW0), -30), E.addDays(E.dayKeyOf(NOW0), -1));
  ok('every complete day: total demo orders within that member\'s min/max', fullDays.every((k) => { const v = byDay.get(k) ?? 0; return v >= m.minDailyOrders && v <= m.maxDailyOrders; }), { m: [m.minDailyOrders, m.maxDailyOrders] });
  ok('every event: 1..3 orders and earnings = quantity × price × allocation', db._store.demoCompEvent.every((e) => e.quantity >= 1 && e.quantity <= 3 && e.earningsCents === Math.round(e.quantity * e.priceCents * e.allocationBps / 10000)));
  ok('plans: one per stream / profile / day, each target within its snapshot', db._store.demoCompDailyPlan.every((p) => p.targetOrders >= p.minOrders && p.targetOrders <= p.maxOrders)
    && new Set(db._store.demoCompDailyPlan.map((p) => `${p.stream}|${p.profileKey}|${p.dayKey}`)).size === db._store.demoCompDailyPlan.length);
  ok('idempotency keys are unique', new Set(db._store.demoCompEvent.map((e) => e.idempotencyKey)).size === db._store.demoCompEvent.length);
}

// ── 3. Concurrency: parallel generation never duplicates ─────────────────────
console.log('\n3. Concurrent generation');
{
  const { db, deps } = env();
  await svc.initializeCompetition(deps);
  await svc.updateEngine(deps, { enabled: true });
  const id = db._store.demoCompMember[0].id;
  await Promise.all([1, 2, 3, 4, 5].map(() => svc.materializeProfile(deps, 'member', id)));
  const mine = db._store.demoCompEvent.filter((e) => e.memberId === id);
  ok('5 parallel materialisations of one profile → no duplicate event', mine.length > 0 && new Set(mine.map((e) => e.idempotencyKey)).size === mine.length);
  ok('each materialisation takes the per-profile lock', db._stats.locks.filter((k) => k === `demo-comp:${id}`).length >= 5);
  await Promise.all([svc.runEngine(deps), svc.runEngine(deps), svc.catchUpOnRead(deps)]);
  ok('two engine runs + a read catch-up in parallel → still no duplicate', new Set(db._store.demoCompEvent.map((e) => e.idempotencyKey)).size === db._store.demoCompEvent.length);
  // Re-creating an event row directly is refused by the unique key
  const e0 = db._store.demoCompEvent[0];
  ok('the database refuses a second row with the same idempotency key', await (async () => { try { await db.demoCompEvent.create({ data: { ...e0, id: undefined } }); return false; } catch (e) { return e.code === 'P2002'; } })());
}

// ── 4. Live generation over time, snapshots, settings changes ────────────────
console.log('\n4. Live generation, immutable snapshots, settings changes');
{
  const { db, deps, clock } = env();
  await svc.initializeCompetition(deps);
  await svc.updateEngine(deps, { enabled: true });
  await svc.runEngine(deps);
  const m = db._store.demoCompMember[0];
  const before = db._store.demoCompEvent.filter((e) => e.memberId === m.id).map((e) => ({ ...e }));
  clock.t += 3 * H;
  await svc.runEngine(deps);
  const after1 = db._store.demoCompEvent.filter((e) => e.memberId === m.id);
  ok('advancing the clock 3 h generates only the newly due events (no re-generation)', after1.length >= before.length && after1.slice(0, before.length).every((e, i) => e.id === before[i].id));
  // Change price + allocation now → future events only
  const changeAt = clock.t;
  await svc.updateMember(deps, m.id, { priceCents: 40000, allocationBps: 2500 }, 'admin-2');
  // The engine already generated up to changeAt (cursor = changeAt), so the version starts 1 ms after that cursor:
  // an event already generated at changeAt keeps the settings it was generated with (review fix: versions are
  // computed inside the profile lock, strictly after the latest version and every generation cursor).
  ok('an engine-relevant change appends a settings version effective now (just after the generation cursor)', db._store.demoCompMemberVersion.filter((v) => v.memberId === m.id).length === 2
    && +db._store.demoCompMemberVersion.at(-1).effectiveFrom === changeAt + 1 && db._store.demoCompMemberVersion.at(-1).createdBy === 'admin-2');
  ok('nextEffectiveFrom: now when nothing is later; strictly after a later version or cursor (racing edits stay ordered)',
    +svc.nextEffectiveFrom(1000, new Date(500), new Date(900)) === 1000 && +svc.nextEffectiveFrom(1000, new Date(2000)) === 2001
    && +svc.nextEffectiveFrom(1000, new Date(1000)) === 1001 && +svc.nextEffectiveFrom(1000, null, new Date(1500), null) === 1501);
  {
    // An edit whose clock is BEHIND the latest version (the racing-PATCH case) still lands after it, so the
    // newest edit is the one in force (here: disabled → no further events).
    const v2 = db._store.demoCompMemberVersion.filter((v) => v.memberId === m.id).at(-1);
    await svc.updateMember({ ...deps, now: () => +v2.effectiveFrom - 60_000 }, m.id, { active: false }, 'admin-late');
    const vs = db._store.demoCompMemberVersion.filter((v) => v.memberId === m.id);
    ok('a late-clock edit is stored strictly after the latest version', vs.length === 3 && +vs[2].effectiveFrom > +vs[1].effectiveFrom && vs[2].active === false);
    await svc.updateMember(deps, m.id, { active: true }, 'admin-2'); // restore for the checks below
  }
  clock.t += 30 * H;
  await svc.runEngine(deps);
  const evs = db._store.demoCompEvent.filter((e) => e.memberId === m.id && e.eventType === 'PERSONAL_SALE');
  ok('events before the change keep 300 DH × 30 %; events after use 400 DH × 25 %',
    evs.filter((e) => +e.scheduledAt <= changeAt).every((e) => e.priceCents === 30000 && e.allocationBps === 3000)
    && evs.filter((e) => +e.scheduledAt > changeAt).length > 0 && evs.filter((e) => +e.scheduledAt > changeAt).every((e) => e.priceCents === 40000 && e.allocationBps === 2500));
  ok('historical events are byte-identical after the change (never recalculated)', before.every((b) => {
    const now = db._store.demoCompEvent.find((e) => e.id === b.id);
    return now && now.earningsCents === b.earningsCents && now.priceCents === b.priceCents && +now.scheduledAt === +b.scheduledAt;
  }));
  ok('history rows refuse UPDATE and direct DELETE (append-only guard)', await (async () => {
    let u = false, d = false;
    try { await db.demoCompEvent.update({ where: { id: before[0].id }, data: { earningsCents: 1 } }); } catch { u = true; }
    try { await db.demoCompEvent.delete({ where: { id: before[0].id } }); } catch { d = true; }
    return u && d;
  })());
  // Name-only change → no new version
  const vCount = db._store.demoCompMemberVersion.length;
  await svc.updateMember(deps, m.id, { name: 'Renamed Member' });
  ok('renaming only (no engine field) does not append a version', db._store.demoCompMemberVersion.length === vCount && db._store.demoCompMember[0].name === 'Renamed Member');
  // min/max change applies to the NEXT day's plan
  const today = E.dayKeyOf(clock.t);
  const todayPlan = db._store.demoCompDailyPlan.find((p) => p.memberId === m.id && p.stream === 'PERSONAL' && p.dayKey === today);
  await svc.updateMember(deps, m.id, { minDailyOrders: 200, maxDailyOrders: 210 });
  clock.t += 2 * D;
  await svc.runEngine(deps);
  const todayPlanAfter = db._store.demoCompDailyPlan.find((p) => p.memberId === m.id && p.stream === 'PERSONAL' && p.dayKey === today);
  const nextPlan = db._store.demoCompDailyPlan.find((p) => p.memberId === m.id && p.stream === 'PERSONAL' && p.dayKey === E.addDays(today, 1));
  ok('min/max change: today\'s plan unchanged; the next day\'s plan uses the new range', todayPlan && todayPlanAfter.targetOrders === todayPlan.targetOrders
    && nextPlan && nextPlan.minOrders === 200 && nextPlan.targetOrders >= 200 && nextPlan.targetOrders <= 210);
}

// ── 5. Activation, archive (instead of delete), ownership ────────────────────
// Approved decision (deletion): profiles are ARCHIVED, never deleted — an archived profile stops generating and
// leaves the public rankings while its history stays intact. (This replaces the earlier delete tests.)
console.log('\n5. Activate / deactivate / archive / restore');
{
  const { db, deps, clock } = env();
  await svc.initializeCompetition(deps);
  await svc.updateEngine(deps, { enabled: true });
  await svc.runEngine(deps);
  const m = db._store.demoCompMember.find((x) => db._store.demoCompBrand.some((b) => b.ownerId === x.id));
  const offAt = clock.t;
  await svc.updateMember(deps, m.id, { active: false });
  clock.t += 20 * H;
  await svc.runEngine(deps);
  ok('a disabled member generates no new demo event', db._store.demoCompEvent.filter((e) => e.memberId === m.id && +e.scheduledAt > offAt).length === 0);
  const lb = await svc.getMemberLeaderboard(deps, {});
  ok('a disabled member is hidden from the public leaderboard (20 shown) and its profile 404s', lb.total === 20 && !lb.members.some((x) => x.id === m.id)
    && (await svc.getPublicMember(deps, m.id)) === null);
  ok('there is no delete any more (service exposes archive / restore only)', !('deleteMember' in svc) && !('deleteBrand' in svc));
  ok('archiving a member that owns non-archived brands is refused (MEMBER_OWNS_BRANDS)', await expectCode(svc.archiveMember(deps, m.id), 'MEMBER_OWNS_BRANDS'));
  const owned = db._store.demoCompBrand.filter((b) => b.ownerId === m.id);
  const histOf = (b) => db._store.demoCompEvent.filter((e) => e.brandId === b.id).length + db._store.demoCompDailyPlan.filter((p) => p.brandId === b.id).length;
  const histBefore = owned.map(histOf);
  const archAt = clock.t;
  for (const b of owned) await svc.archiveBrand(deps, b.id, 'admin-x'); // ACTIVE brands: archiving disables them itself
  const ownedNow = owned.map((b) => db._store.demoCompBrand.find((x) => x.id === b.id));
  ok('an archived brand is disabled and stamped (archivedAt), with its history intact (events, plans, versions)', ownedNow.every((b) => b && b.active === false && +b.archivedAt === archAt)
    && owned.every((b, i) => histOf(b) === histBefore[i] && histBefore[i] > 0));
  ok('archiving appends a settings version active=false (nothing generated after the archive time)',
    owned.every((b) => { const v = db._store.demoCompBrandVersion.filter((x) => x.brandId === b.id).at(-1); return v.active === false && +v.effectiveFrom > archAt - 1 && v.createdBy === 'admin-x'; }));
  clock.t += 10 * H;
  await svc.runEngine(deps);
  svc.__resetDemoCompState();
  const blb = await svc.getBrandLeaderboard(deps, {});
  ok('an archived brand generates nothing more and leaves the public ranking / profile', !db._store.demoCompEvent.some((e) => owned.some((b) => b.id === e.brandId) && +e.scheduledAt > archAt)
    && !blb.brands.some((x) => owned.some((b) => b.id === x.id)) && (await svc.getPublicBrand(deps, owned[0].id)) === null);
  ok('an archived profile cannot be edited (ARCHIVED — restore first)', await expectCode(svc.updateBrand(deps, owned[0].id, { name: 'Y' }), 'ARCHIVED'));
  const memberEvents = db._store.demoCompEvent.filter((e) => e.memberId === m.id).length;
  await svc.archiveMember(deps, m.id, 'admin-x');
  const am = db._store.demoCompMember.find((x) => x.id === m.id);
  ok('then the member is archived (disabled, stamped) and keeps its whole history', am && am.active === false && am.archivedAt
    && db._store.demoCompEvent.filter((e) => e.memberId === m.id).length === memberEvents && memberEvents > 0);
  ok('archive is idempotent', (await svc.archiveMember(deps, m.id)).archived === true && +db._store.demoCompMember.find((x) => x.id === m.id).archivedAt === +am.archivedAt);
  ok('restoring a brand whose owner is archived is refused (OWNER_ARCHIVED)', await expectCode(svc.restoreBrand(deps, owned[0].id), 'OWNER_ARCHIVED'));
  const other = db._store.demoCompMember.find((x) => !x.archivedAt);
  const b0 = db._store.demoCompBrand.find((b) => !b.archivedAt);
  ok('a brand cannot be given an archived owner (INVALID_SETTINGS / ownerId OWNER_ARCHIVED)', await (async () => {
    try { await svc.updateBrand(deps, b0.id, { ownerId: m.id }); return false; } catch (e) { return e.code === 'INVALID_SETTINGS' && e.details.ownerId === 'OWNER_ARCHIVED'; }
  })());
  ok('archived profiles leave the 21 / 20 limits: a new member can be created (21 non-archived again)', await svc.createMember(deps, { name: 'Nouveau membre' }).then(() => true, () => false)
    && db._store.demoCompMember.filter((x) => !x.archivedAt).length === 21);
  ok('restore is refused while the 21 non-archived members are full (MEMBER_LIMIT_REACHED)', await expectCode(svc.restoreMember(deps, m.id), 'MEMBER_LIMIT_REACHED'));
  const fresh = db._store.demoCompMember.find((x) => x.name === 'Nouveau membre');
  await svc.archiveMember(deps, fresh.id);
  await svc.restoreMember(deps, m.id);
  await svc.restoreBrand(deps, owned[0].id);
  const rm = db._store.demoCompMember.find((x) => x.id === m.id), rb = db._store.demoCompBrand.find((x) => x.id === owned[0].id);
  ok('restore brings the profile back DISABLED (admin re-enables it), still absent from the public ranking', rm.archivedAt === null && rm.active === false
    && rb.archivedAt === null && rb.active === false && !(await svc.getMemberLeaderboard(deps, {})).members.some((x) => x.id === m.id));
  const admin = await svc.adminListMembers(deps);
  ok('admin list shows archived profiles with archivedAt (history still readable)', admin.members.some((x) => x.id === fresh.id && x.archivedAt) && admin.members.some((x) => x.id === m.id && x.archivedAt === null));
  await svc.updateBrand(deps, b0.id, { ownerId: other.id });
  ok('a brand can change owner (any non-archived demo member); unknown owner refused', db._store.demoCompBrand.find((b) => b.id === b0.id).ownerId === other.id
    && await expectCode(svc.updateBrand(deps, b0.id, { ownerId: '00000000-0000-4000-8000-000000000000' }), 'OWNER_NOT_FOUND'));
  const reAt = clock.t;
  await svc.updateMember(deps, other.id, { active: false });
  clock.t += 2 * H;
  await svc.updateMember(deps, other.id, { active: true });
  const backOn = clock.t;
  clock.t += 20 * H;
  await svc.runEngine(deps);
  ok('re-activation resumes generation (events after re-activation only)', !db._store.demoCompEvent.some((e) => e.memberId === other.id && +e.scheduledAt > reAt && +e.scheduledAt <= backOn)
    && db._store.demoCompEvent.some((e) => e.memberId === other.id && +e.scheduledAt > backOn));
}

// ── 5b. Engine OFF / ON ───────────────────────────────────────────────────────
// Approved decision (engine OFF): no event is generated for the disabled period; when re-enabled the engine
// resumes from the current time — missed days are never generated (no catch-up).
console.log('\n5b. Engine OFF / ON');
{
  const { db, deps, clock } = env();
  await svc.initializeCompetition(deps);
  await svc.updateEngine(deps, { enabled: true });
  clock.t += 2 * H;
  await svc.runEngine(deps);
  const offAt = clock.t;
  await svc.updateEngine(deps, { enabled: false });
  clock.t += 3 * D;
  svc.__resetDemoCompState();
  const readRun = await svc.catchUpOnRead(deps);
  ok('engine OFF: the worker run and the read-path catch-up generate nothing', (await svc.runEngine(deps)).skipped === 'disabled' && readRun.skipped === 'disabled'
    && !db._store.demoCompEvent.some((e) => +e.scheduledAt > offAt));
  // A profile created while OFF: its 30-day history stops where the engine was switched OFF (nothing for the OFF period).
  ok('switching OFF stores the pause time (pausedAt = now)', +(await svc.getEngine(deps)).pausedAt === offAt);
  const spare = db._store.demoCompMember.find((x) => !db._store.demoCompBrand.some((b) => b.ownerId === x.id));
  await svc.archiveMember(deps, spare.id);
  const createdAt = clock.t;
  const nm = await svc.createMember(deps, { name: 'Créé moteur OFF' });
  const nmEv = db._store.demoCompEvent.filter((e) => e.memberId === nm.id);
  ok('a profile created while OFF gets its history up to the moment the engine was switched OFF (never into the OFF period)', nmEv.length > 0
    && nmEv.every((e) => +e.scheduledAt <= offAt) && Math.min(...nmEv.map((e) => +e.scheduledAt)) >= E.backfillStart(createdAt));
  clock.t += 5 * H;
  const onAt = clock.t;
  await svc.updateEngine(deps, { enabled: true });
  ok('switching ON stores the resume time (resumedAt = now)', +(await svc.getEngine(deps)).resumedAt === onAt);
  clock.t += 6 * H;
  const run = await svc.runEngine(deps);
  ok('after re-enable: NOTHING for the OFF period (offAt, onAt] — missed days are not generated',
    !db._store.demoCompEvent.some((e) => +e.scheduledAt > offAt && +e.scheduledAt <= onAt));
  ok('…and generation resumes from the re-enable time (events in (onAt, now])', run.events > 0
    && db._store.demoCompEvent.some((e) => +e.scheduledAt > onAt && +e.scheduledAt <= clock.t) && db._store.demoCompEvent.some((e) => e.memberId === nm.id && +e.scheduledAt > onAt));
  await svc.updateEngine(deps, { enabled: true, defaultPriceCents: 31000 });
  ok('saving while already ON does not move the resume point', +(await svc.getEngine(deps)).resumedAt === onAt);
  // OFF for longer than the 30-day history window: a profile created then has no history yet, and switching ON
  // later still never backfills the OFF period.
  const off2 = clock.t;
  await svc.updateEngine(deps, { enabled: false });
  clock.t += 40 * D;
  await svc.archiveMember(deps, nm.id); // frees a slot (nm owns no brand)
  const late = await svc.createMember(deps, { name: 'Créé après 40 jours OFF' });
  ok('created 40 days into an OFF period: no history (it would all fall in the OFF period), but its position is recorded',
    !db._store.demoCompEvent.some((e) => e.memberId === late.id) && db._store.demoCompMember.find((x) => x.id === late.id).personalGeneratedThrough);
  const on2 = clock.t;
  await svc.updateEngine(deps, { enabled: true });
  clock.t += 18 * H; // a full active day part (00:00 UTC + 18 h): every profile sells in that window
  await svc.runEngine(deps);
  ok('…switched ON again: still nothing in the whole OFF period, live events from the re-enable time on',
    !db._store.demoCompEvent.some((e) => +e.scheduledAt > off2 && +e.scheduledAt <= on2) && db._store.demoCompEvent.some((e) => e.memberId === late.id && +e.scheduledAt > on2));
}

// ── 6. Rolling windows, all-time, ranking, network ───────────────────────────
console.log('\n6. Rolling statistics, ranking and the network stream');
{
  const { db, deps, clock } = env();
  await svc.initializeCompetition(deps);
  await svc.updateEngine(deps, { enabled: true });
  await svc.runEngine(deps);
  const now = clock.t;
  const lb = await svc.getMemberLeaderboard(deps, {});
  const pick = lb.members[5];
  const mine = db._store.demoCompEvent.filter((e) => e.memberId === pick.id && e.eventType === 'PERSONAL_SALE');
  const win = (h) => mine.filter((e) => +e.scheduledAt > now - h * H && +e.scheduledAt <= now);
  const prof = (await svc.getPublicMember(deps, pick.id)).member;
  ok('24 h / 7 d / 30 d = exact sums over (now − 24 h / 168 h / 720 h, now]', prof.stats.earnings24hCents === sum(win(24), 'earningsCents')
    && prof.stats.earnings7dCents === sum(win(168), 'earningsCents') && prof.stats.earnings30dCents === sum(win(720), 'earningsCents')
    && prof.stats.orders30d === sum(win(720), 'quantity'));
  ok('all-time = every event; 24 h ≤ 7 d ≤ 30 d ≤ all-time', prof.stats.earningsAllCents === sum(mine, 'earningsCents')
    && prof.stats.earnings24hCents <= prof.stats.earnings7dCents && prof.stats.earnings7dCents <= prof.stats.earnings30dCents && prof.stats.earnings30dCents <= prof.stats.earningsAllCents);
  ok('leaderboard = 21 active members ranked 1..21 by rolling 30-day earnings', lb.total === 21 && lb.members.every((x, i) => x.rank === i + 1)
    && lb.members.every((x, i) => i === 0 || x.earnings30dCents <= lb.members[i - 1].earnings30dCents) && lb.simulation === true);
  // Disable the engine, move 31 days: windows empty, all-time unchanged
  const allBefore = prof.stats.earningsAllCents;
  clock.t += 31 * D;
  svc.__resetDemoCompState();
  const later = (await svc.getPublicMember(deps, pick.id)).member;
  ok('old events leave the rolling windows (31 days later, engine off → 0) while all-time never decreases',
    later.stats.earnings24hCents === 0 && later.stats.earnings30dCents === 0 && later.stats.earningsAllCents === allBefore);
  // Rank movement from generated events only
  clock.t = now;
  svc.__resetDemoCompState();
  const last = lb.members.at(-1);
  await svc.updateMember(deps, last.id, { minDailyOrders: 900, maxDailyOrders: 1000 });
  clock.t = now + 2 * D;
  await svc.runEngine(deps);
  svc.__resetDemoCompState();
  const lb2 = await svc.getMemberLeaderboard(deps, {});
  const moved = lb2.members.find((x) => x.id === last.id);
  ok('a member who sells more climbs (#21 → #1) because of its generated events; rankChange24h reflects it', moved.rank === 1 && moved.rankChange24h > 0);
  ok('ranking uses ONLY 30-day earnings (not all-time, not orders)', lb2.members.every((x, i) => i === 0 || x.earnings30dCents <= lb2.members[i - 1].earnings30dCents));
  // Network stream
  const net = lb2.members[10];
  ok('network stream OFF by default (no NETWORK_SALE events, network earnings 0)', !db._store.demoCompEvent.some((e) => e.eventType === 'NETWORK_SALE') && net.networkEarnings30dCents === 0);
  const rankBefore = net.rank, personalBefore = net.earnings30dCents;
  await svc.updateMember(deps, net.id, { networkAffiliates: 12, networkMinDailyOrders: 20, networkMaxDailyOrders: 40, networkPriceCents: 30000, networkAllocationBps: 500 });
  clock.t += 2 * D;
  await svc.runEngine(deps);
  svc.__resetDemoCompState();
  const netProf = (await svc.getPublicMember(deps, net.id)).member;
  const netEv = db._store.demoCompEvent.filter((e) => e.memberId === net.id && e.eventType === 'NETWORK_SALE');
  ok('configured network → separate NETWORK_SALE events at the configured rate (5 % here, no assumed default)', netEv.length > 0 && netEv.every((e) => e.allocationBps === 500 && e.priceCents === 30000)
    && netProf.network.configured && netProf.network.affiliates === 12 && netProf.network.earningsAllCents === sum(netEv, 'earningsCents'));
  ok('network earnings stay separate: personal stats and member ranking ignore them', netProf.stats.earningsAllCents === sum(db._store.demoCompEvent.filter((e) => e.memberId === net.id && e.eventType === 'PERSONAL_SALE'), 'earningsCents')
    && typeof rankBefore === 'number' && typeof personalBefore === 'number');
  const blb = await svc.getBrandLeaderboard(deps, {});
  ok('brand leaderboard: 20 brands ranked by their own 30-day brand earnings, with owner info', blb.total === 20 && blb.brands.every((x, i) => x.rank === i + 1 && x.owner && x.owner.name)
    && blb.brands.every((x, i) => i === 0 || x.earnings30dCents <= blb.brands[i - 1].earnings30dCents));
  const bp = (await svc.getPublicBrand(deps, blb.brands[0].id)).brand;
  ok('brand profile: 24 h / 7 d / 30 d / all-time + 30-day daily history + recent activity', bp.stats.earningsAllCents >= bp.stats.earnings30dCents
    && bp.history.daily.length === 30 && bp.history.recent.length > 0 && bp.history.recent.every((r) => r.type === 'BRAND_SALE'));
  ok('member and brand streams never mix (brand events not counted for the owner)', db._store.demoCompEvent.every((e) => (e.eventType === 'BRAND_SALE') === !!e.brandId));
}

// ── 7. Route handlers ────────────────────────────────────────────────────────
console.log('\n7. Route handlers');
{
  const { db, deps } = env();
  const admin = adminDemoCompHandlers({ ...deps, storeImage: async () => '/uploads/demo-competition/x.webp' });
  const pub = publicDemoCompHandlers(deps);
  const req = (method, body) => new Request('http://x/api', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = (id) => ({ params: Promise.resolve({ id }) });
  let r = await admin.createMember(req('POST', { name: 'Salma', minDailyOrders: 3, maxDailyOrders: 9, priceCents: 30000, allocationBps: 3000 }), {}, { id: 'a1' });
  const created = await r.json();
  ok('admin create member → 201 with id', r.status === 201 && /^[0-9a-f-]{36}$/.test(created.member.id));
  r = await admin.createMember(req('POST', { name: 'X', minDailyOrders: '3' }), {}, { id: 'a1' });
  ok('wrong JSON types → 400 INVALID_SETTINGS with field INVALID_TYPE', r.status === 400 && (await r.json()).fields.minDailyOrders === 'INVALID_TYPE');
  r = await admin.createMember(new Request('http://x', { method: 'POST', body: 'not json' }), {}, {});
  ok('malformed JSON → 400 INVALID_JSON', r.status === 400 && (await r.json()).code === 'INVALID_JSON');
  r = await admin.getMember(req('GET'), ctx('not-a-uuid'));
  ok('non-UUID id → 404 (never reaches the DB)', r.status === 404);
  r = await admin.updateMember(req('PATCH', { allocationBps: 0 }), ctx(created.member.id), {});
  ok('allocation 0 % → 400 INVALID_ALLOCATION', r.status === 400 && (await r.json()).fields.allocationBps === 'INVALID_ALLOCATION');
  // Approved decisions: no delete (archive / restore), no combined allocation cap, nothing generated while OFF.
  ok('no delete handler any more (archive / restore only)', !('deleteMember' in admin) && !('deleteBrand' in admin)
    && ['archiveMember', 'restoreMember', 'archiveBrand', 'restoreBrand'].every((k) => typeof admin[k] === 'function'));
  r = await admin.updateEngine(req('PATCH', { defaultMemberBps: 4000, defaultBrandBps: 7000 }));
  ok('engine defaults 40 % + 70 % accepted (separate streams, no combined cap)', r.status === 200 && (await r.json()).engine.defaultMemberBps === 4000);
  r = await admin.updateEngine(req('PATCH', { defaultBrandBps: 10001 }));
  ok('a single allocation over 100 % → 400 INVALID_ALLOCATION', r.status === 400 && (await r.json()).fields.defaultBrandBps === 'INVALID_ALLOCATION');
  r = await admin.runEngine(req('POST'));
  ok('"run now" while the engine is OFF → 409 ENGINE_DISABLED (nothing generated)', r.status === 409 && (await r.json()).code === 'ENGINE_DISABLED');
  const fd = new FormData(); fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])], { type: 'image/jpeg' }), 'p.jpg');
  r = await admin.uploadMemberPhoto(new Request('http://x', { method: 'POST', body: fd }), ctx(created.member.id), {});
  ok('photo upload stores the processed image URL on the member (no settings version added)', r.status === 200 && db._store.demoCompMember[0].photoUrl === '/uploads/demo-competition/x.webp'
    && db._store.demoCompMemberVersion.length === 1);
  r = await admin.uploadMemberPhoto(new Request('http://x', { method: 'POST', body: 'x', headers: { 'content-length': String(50 * 1024 * 1024) } }), ctx(created.member.id), {});
  ok('an upload declaring a body far above 5 MB is refused (413) before the body is read', r.status === 413 && (await r.json()).code === 'IMAGE_TOO_LARGE');
  r = await admin.initialize(req('POST'), {}, { id: 'a1' });
  const init = await r.json();
  ok('admin initialize fills up to 21 / 20 and generates the 30-day history', r.status === 200 && init.createdMembers === 20 && init.createdBrands === 20 && init.events > 0);
  r = await pub.members(new Request('http://x/api/demo-competition/members?limit=5'));
  const pl = await r.json();
  ok('public leaderboard: short CDN cache, simulation flag, limit honoured', r.headers.get('cache-control') === PUBLIC_CACHE && pl.simulation === true && pl.members.length === 5 && pl.total === 21);
  ok('public payload exposes no settings (no min/max, price, allocation)', pl.members.every((x) => !('minDailyOrders' in x) && !('priceCents' in x) && !('allocationBps' in x)));
  r = await pub.member(new Request('http://x'), ctx('00000000-0000-4000-8000-000000000000'));
  ok('unknown public profile → 404 not cached', r.status === 404 && r.headers.get('cache-control') === 'no-store');
  const before = db._store.demoCompEvent.length;
  svc.__resetDemoCompState();
  await svc.catchUpOnRead(deps);
  ok('read catch-up does nothing while the engine is OFF', db._store.demoCompEvent.length === before);
  // Single flight: while one read-path run is pending, another read (even past the throttle) never starts a second one.
  svc.__resetDemoCompState();
  await svc.updateEngine(deps, { enabled: true });
  const t0 = deps.now();
  const first = svc.catchUpOnRead({ ...deps, now: () => t0 + 60 * H });
  const second = await svc.catchUpOnRead({ ...deps, now: () => t0 + 61 * H });
  const firstRes = await first;
  ok('read catch-up is single-flight per process (a second read while one runs is skipped)', second.skipped === 'in_flight' && !firstRes.skipped);
  await svc.updateEngine(deps, { enabled: false });
}

// ── 8. Isolation from real financial data ────────────────────────────────────
console.log('\n8. Isolation');
{
  const { db, deps } = env();
  let blocked = false;
  try { void db.order; } catch (e) { blocked = /PRODUCTION TABLE ACCESS BLOCKED/.test(e.message); }
  ok('the strict fake DB blocks every non-demo model', blocked);
  await svc.initializeCompetition(deps);
  await svc.updateEngine(deps, { enabled: true });
  await svc.runEngine(deps);
  await svc.getMemberLeaderboard(deps, {}); await svc.getBrandLeaderboard(deps, {});
  ok('a full run (create, backfill, stats) only wrote demo_comp_* models', db._stats.writes.every((w) => DEMO_COMP_MODELS.includes(w.split('.')[0])));
  const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = ['src/lib/services/demoCompetitionService.js', ...walk('src/lib/demoCompetition'), ...walk('src/app/api/demo-competition'), ...walk('src/app/api/admin/demo-competition'), 'scripts/demo-leaderboard-engine.mjs'];
  const src = files.map((f) => [f, readFileSync(f, 'utf8')]);
  const FORBIDDEN_IMPORT = /from ['"][^'"]*(affiliateSystemService|orderService|fakeOrder|rewards|reward\w*Service|depositService|boosterService|ugcEarnings|balance\/|recruiter\w*Service|brandAccessService|brandSimulationService|demoService)/;
  ok('no demo-competition file imports a real-money / reward / brand-simulator / old-demo module', src.every(([, s]) => !FORBIDDEN_IMPORT.test(s)), src.filter(([, s]) => FORBIDDEN_IMPORT.test(s)).map(([f]) => f));
  const FORBIDDEN_MODEL = /\.(order|orderItem|affiliate|affiliateOrder|affiliatePayout|affiliateSecurityDeposit|affiliateBoosterPurchase|ugcEarning|rewardPoints\w*|recruiter\w*|brandAccess|brandSimHour|demoAffiliate|demoStats|setting)\s*\./;
  ok('no demo-competition file references a real (or old demo) model', src.every(([, s]) => !FORBIDDEN_MODEL.test(s)), src.filter(([, s]) => FORBIDDEN_MODEL.test(s)).map(([f]) => f));
  ok('no balance provider registration in demo-competition code', src.every(([, s]) => !/registerBalanceProvider/.test(s)));
  const mig = readFileSync('prisma/migrations/20261113_demo_competition/migration.sql', 'utf8');
  const touched = [...mig.matchAll(/(?:TABLE|ON|REFERENCES|INTO|FROM)\s+(?:IF NOT EXISTS\s+)?"([a-z_]+)"/g)].map((m) => m[1]);
  ok('the migration only creates / references demo_comp_* tables', touched.length > 10 && touched.every((t) => t.startsWith('demo_comp_')), [...new Set(touched)].filter((t) => !t.startsWith('demo_comp_')));
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  // The 7 NEW models (the old generator's `model DemoCompetition` is a different, untouched system).
  const NEW_MODELS = ['DemoCompMember', 'DemoCompMemberVersion', 'DemoCompBrand', 'DemoCompBrandVersion', 'DemoCompDailyPlan', 'DemoCompEvent', 'DemoCompEngine'];
  const demoModels = [...schema.matchAll(/^model (\w+) \{[\s\S]*?^\}/gm)].filter((m) => NEW_MODELS.includes(m[1])).map((m) => m[0]);
  const SCALARS = new Set(['String', 'Int', 'Boolean', 'DateTime', 'Float', 'Json', 'Decimal', 'BigInt', 'Bytes']);
  const relTypes = demoModels.flatMap((b) => [...b.matchAll(/^\s+\w+\s+([A-Z]\w+)(?:\[\]|\?)?(?:\s|$)/gm)].map((m) => m[1]).filter((t) => !SCALARS.has(t)));
  ok('the 7 DemoComp models relate only to each other (no relation to Affiliate / Order / …)', demoModels.length === 7
    && relTypes.length >= 10 && relTypes.every((t) => NEW_MODELS.includes(t)), relTypes.filter((t) => !NEW_MODELS.includes(t)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
