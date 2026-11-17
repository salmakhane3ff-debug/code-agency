/**
 * scripts/demoCompUgc.test.mjs — Demo Competition: UGC Videos (SIMULATION ONLY).
 * Pure rules (src/lib/demoCompUgc.js), service + route handlers (src/lib/services/demoCompUgcService.js)
 * on a STRICT in-memory fake DB (scripts/lib/demoCompUgcFakeDb.mjs: any non-demo model throws), the
 * dedicated media namespace (fake store), and static isolation proofs (files, migration, schema).
 * Run: node scripts/demoCompUgc.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeUgcFakeDb, UGC_MODELS } from './lib/demoCompUgcFakeDb.mjs';
import * as U from '../src/lib/demoCompUgc.js';
import * as svc from '../src/lib/services/demoCompUgcService.js';
import { PUBLIC_CACHE } from '../src/lib/demoCompetition/routeHandlers.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
};
const H = 3_600_000, D = 24 * H;
const NOW0 = Date.parse('2026-11-09T11:00:00Z');
const URL_V = (n) => `/uploads/demo-competition-ugc/video-${n}.mp4`;

function env(start = NOW0) {
  const clock = { t: start };
  const db = makeUgcFakeDb();
  const deps = { db, now: () => clock.t };
  svc.__resetDemoCompUgcState();
  return { db, deps, clock };
}
const expectCode = async (p, code) => { try { await p; return false; } catch (e) { return e?.code === code; } };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const evOf = (db, id) => db._store.demoCompUgcEvent.filter((e) => e.videoId === id);
const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
const keySet = (rows) => rows.map((e) => e.idempotencyKey).sort().join(',');
const jsonReq = (body, method = 'POST') => new Request('http://x/api', { method, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ctxOf = (id) => ({ params: Promise.resolve({ id }) });
const ADMIN = { id: 'admin-1', role: 'ADMIN' };

// ── 1. Pure rules ─────────────────────────────────────────────────────────────
console.log('\n1. Pure rules (reward, ranges, determinism, windows, ranking, media URLs)');
{
  ok('reward 5 / 6 / 7 MAD per sale → quantity × rate × 100 centimes',
    U.ugcRewardCents(3, 5) === 1500 && U.ugcRewardCents(2, 6) === 1200 && U.ugcRewardCents(1, 7) === 700 && U.ugcRewardCents(0, 7) === 0);
  ok('any other rate is refused by the reward math (4, 8, 5.5, "5", null)', [4, 8, 5.5, '5', null].every((r) => { try { U.ugcRewardCents(1, r); return false; } catch (e) { return e.code === 'INVALID_REWARD'; } }));
  const good = { title: 'Vidéo', memberId: 'm', active: true, minDailySales: 2, maxDailySales: 9, rewardPerSaleMad: 6, sortOrder: 0, videoUrl: null, thumbnailUrl: null };
  ok('valid settings pass', U.validateVideoSettings(good).ok);
  const codes = (patch) => U.validateVideoSettings({ ...good, ...patch }).errors;
  ok('validation codes: INVALID_REWARD / MAX_BELOW_MIN / INVALID_MIN_SALES / INVALID_MAX_SALES / INVALID_TITLE / MEMBER_REQUIRED / INVALID_ACTIVE / INVALID_SORT_ORDER',
    codes({ rewardPerSaleMad: 4 }).rewardPerSaleMad === 'INVALID_REWARD' && codes({ rewardPerSaleMad: 8 }).rewardPerSaleMad === 'INVALID_REWARD'
    && codes({ minDailySales: 9, maxDailySales: 2 }).maxDailySales === 'MAX_BELOW_MIN' && codes({ minDailySales: -1 }).minDailySales === 'INVALID_MIN_SALES'
    && codes({ maxDailySales: 1001 }).maxDailySales === 'INVALID_MAX_SALES' && codes({ minDailySales: 1.5 }).minDailySales === 'INVALID_MIN_SALES'
    && codes({ title: '  ' }).title === 'INVALID_TITLE' && codes({ title: 'x'.repeat(121) }).title === 'INVALID_TITLE' && codes({ title: '<b>' }).title === 'INVALID_TITLE'
    && codes({ memberId: '' }).memberId === 'MEMBER_REQUIRED' && codes({ active: 'yes' }).active === 'INVALID_ACTIVE' && codes({ sortOrder: -1 }).sortOrder === 'INVALID_SORT_ORDER');
  ok('0 ≤ min ≤ max ≤ 1000 accepted at the edges (0/0, 1000/1000)', U.validateVideoSettings({ ...good, minDailySales: 0, maxDailySales: 0 }).ok && U.validateVideoSettings({ ...good, minDailySales: 1000, maxDailySales: 1000 }).ok);
  ok('module settings: enabled boolean, target 1..100', U.validateModuleSettings({ enabled: true, targetVideoCount: 20 }).ok
    && U.validateModuleSettings({ enabled: 'y', targetVideoCount: 0 }).errors.enabled === 'INVALID_ENABLED'
    && U.validateModuleSettings({ enabled: true, targetVideoCount: 101 }).errors.targetVideoCount === 'INVALID_TARGET_COUNT');

  // Every generated day respects [min, max] (pure generation over 30 days, many ranges).
  let allDaysOk = true, checkedDays = 0;
  for (let i = 0; i < 25; i++) {
    const min = (i * 7) % 12, max = min + ((i * 5) % 30);
    const versions = [{ id: `v${i}`, effectiveFrom: new Date(U.backfillStart(NOW0)), active: true, minDailySales: min, maxDailySales: max, rewardPerSaleMad: U.REWARD_CHOICES[i % 3] }];
    const g = U.generateUgcRange(`video-${i}`, versions, +versions[0].effectiveFrom - 1, NOW0 + 3 * D);
    for (const p of g.plans) {
      if (p.dayEnd > NOW0 + 3 * D) continue; // only complete days
      const total = sum(g.events.filter((e) => e.dayKey === p.dayKey), 'quantity');
      checkedDays++;
      if (!(total === p.targetSales && total >= min && total <= max)) allDaysOk = false;
    }
    if (!g.events.every((e) => e.quantity >= 1 && e.quantity <= 3 && e.rewardCents === e.quantity * e.rewardPerSaleMad * 100)) allDaysOk = false;
  }
  ok(`min / max respected for every generated day (${checkedDays} complete days, 25 ranges incl. 0/0): day total = target ∈ [min, max]`, allDaysOk && checkedDays > 700);

  const vers = [{ id: 'v1', effectiveFrom: new Date(U.backfillStart(NOW0)), active: true, minDailySales: 4, maxDailySales: 20, rewardPerSaleMad: 6 }];
  const a = U.generateUgcRange('vid-a', vers, +vers[0].effectiveFrom - 1, NOW0);
  const b = U.generateUgcRange('vid-a', structuredClone(vers), +vers[0].effectiveFrom - 1, NOW0);
  const c = U.generateUgcRange('vid-b', vers, +vers[0].effectiveFrom - 1, NOW0);
  ok('deterministic: same inputs → identical plans and events; another video id → a different series', JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a.events) !== JSON.stringify(c.events));
  const split = [...U.generateUgcRange('vid-a', vers, +vers[0].effectiveFrom - 1, NOW0 - 5 * D).events, ...U.generateUgcRange('vid-a', vers, NOW0 - 5 * D, NOW0).events];
  ok('generation in two slices = generation in one (no gap, no overlap)', keySet(split) === keySet(a.events) && split.length === a.events.length);
  ok('idempotency keys are UGC:<videoId>:<day>:<seq> and unique', a.events.every((e) => e.idempotencyKey === `UGC:vid-a:${e.dayKey}:${e.seq}`) && new Set(a.events.map((e) => e.idempotencyKey)).size === a.events.length);

  const W = U.UGC_RANKING_WINDOW_MS;
  ok('ranking window = rolling 720 h, (now − 720 h, now]', W === 720 * H && !U.inWindow(NOW0 - W, NOW0) && U.inWindow(NOW0 - W + 1, NOW0) && U.inWindow(NOW0, NOW0) && !U.inWindow(NOW0 + 1, NOW0));
  const evs = [
    { videoId: 'x', quantity: 2, rewardCents: 1000, scheduledAt: new Date(NOW0 - W) },      // excluded (lower bound open)
    { videoId: 'x', quantity: 1, rewardCents: 500, scheduledAt: new Date(NOW0 - W + 1) },   // included
    { videoId: 'x', quantity: 3, rewardCents: 1500, scheduledAt: new Date(NOW0) },          // included (upper bound closed)
    { videoId: 'x', quantity: 3, rewardCents: 1500, scheduledAt: new Date(NOW0 + 1) },      // future: excluded
  ];
  const wt = U.windowTotals(evs, NOW0).get('x');
  ok('window totals at the exact boundaries (open below, closed above)', wt.sales === 4 && wt.rewardCents === 2000);

  const ranked = U.rankVideos([
    { id: 'b', createdAt: new Date(2), sortOrder: 1, reward30dCents: 500, sales30d: 1 },
    { id: 'a', createdAt: new Date(1), sortOrder: 2, reward30dCents: 500, sales30d: 1 },
    { id: 'c', createdAt: new Date(3), sortOrder: 0, reward30dCents: 700, sales30d: 1 },
    { id: 'd', createdAt: new Date(4), sortOrder: 9, reward30dCents: 500, sales30d: 2 },
  ]);
  ok('ranking: reward desc, then sales desc, then sortOrder, creation, id', ranked.map((r) => r.id).join('') === 'cdba' && ranked.map((r) => r.rank).join('') === '1234');

  ok('media URL namespace: only demo-competition-ugc (local or https), right extension, no traversal / query',
    U.isDemoUgcMediaUrl('/uploads/demo-competition-ugc/a-1.mp4', 'video') && U.isDemoUgcMediaUrl('https://cdn.example.com/pfx/demo-competition-ugc/ugc-video-1-ab12.webm', 'video')
    && U.isDemoUgcMediaUrl('https://res.cloudinary.com/x/image/upload/v1/demo-competition-ugc/t.webp', 'thumbnail')
    && !U.isDemoUgcMediaUrl('/uploads/ugc/a.mp4', 'video') && !U.isDemoUgcMediaUrl('https://cdn.example.com/pfx/videos/a.mp4', 'video')
    && !U.isDemoUgcMediaUrl('http://cdn.example.com/demo-competition-ugc/a.mp4', 'video') && !U.isDemoUgcMediaUrl('/uploads/demo-competition-ugc/../ugc/a.mp4', 'video')
    && !U.isDemoUgcMediaUrl('/uploads/demo-competition-ugc/a.mp4', 'thumbnail') && !U.isDemoUgcMediaUrl('https://x.com/demo-competition-ugc/a.mp4?x=1', 'video')
    && !U.isDemoUgcMediaUrl('javascript:alert(1)//demo-competition-ugc/a.mp4', 'video'));
  ok('placeholders are deterministic, valid and use the 3 reward choices', JSON.stringify(U.placeholderVideo(3)) === JSON.stringify(U.placeholderVideo(3))
    && Array.from({ length: 40 }, (_, i) => U.placeholderVideo(i)).every((p) => U.validateVideoSettings({ ...p, memberId: 'm', active: true, sortOrder: 0 }).ok)
    && new Set(Array.from({ length: 6 }, (_, i) => U.placeholderVideo(i).rewardPerSaleMad)).size === 3 && new Set(Array.from({ length: 40 }, (_, i) => U.placeholderVideo(i).title)).size === 40);
}

// ── 2. Multiple videos per member, independent ranking, deterministic backfill ──
console.log('\n2. Videos, owners, independent ranking and the 30-day backfill');
{
  const { db, deps, clock } = env();
  const m1 = db._seedMember({ name: 'Salma B.', photoUrl: '/uploads/demo-competition/s.webp' });
  const m2 = db._seedMember({ name: 'Omar T.' });
  const v1 = await svc.createUgcVideo(deps, { title: 'Routine', memberId: m1.id, videoUrl: URL_V(1), rewardPerSaleMad: 5, minDailySales: 10, maxDailySales: 20 }, 'admin-1');
  const v2 = await svc.createUgcVideo(deps, { title: 'Unboxing', memberId: m1.id, videoUrl: URL_V(2), rewardPerSaleMad: 7, minDailySales: 10, maxDailySales: 20 }, 'admin-1');
  const v3 = await svc.createUgcVideo(deps, { title: 'Avis', memberId: m1.id, videoUrl: URL_V(3), rewardPerSaleMad: 6, minDailySales: 0, maxDailySales: 1 }, 'admin-1');
  const v4 = await svc.createUgcVideo(deps, { title: 'Look', memberId: m2.id, videoUrl: URL_V(4), rewardPerSaleMad: 6, minDailySales: 30, maxDailySales: 40 }, 'admin-1');
  ok('one member owns three videos; every video has its own events (no shared series)', [v1, v2, v3].every((v) => v.memberId === m1.id)
    && evOf(db, v1.id).length > 0 && evOf(db, v2.id).length > 0 && evOf(db, v4.id).length > 0
    && db._store.demoCompUgcEvent.every((e) => e.idempotencyKey.startsWith(`UGC:${e.videoId}:`)));
  ok('a new video gets its 30-day history at creation (module OFF, never switched ON): one version effective 30 days back',
    db._store.demoCompUgcVideoVersion.length === 4 && db._store.demoCompUgcVideoVersion.every((v) => +v.effectiveFrom === U.backfillStart(NOW0) && v.createdBy === 'admin-1')
    && Math.min(...db._store.demoCompUgcEvent.map((e) => +e.scheduledAt)) >= U.backfillStart(NOW0) && Math.max(...db._store.demoCompUgcEvent.map((e) => +e.scheduledAt)) <= NOW0);
  // Deterministic backfill: the stored rows equal the pure function of (video id, versions).
  let same = true;
  for (const v of [v1, v2, v3, v4]) {
    const vers = db._store.demoCompUgcVideoVersion.filter((x) => x.videoId === v.id);
    const g = U.generateUgcRange(v.id, vers, +vers[0].effectiveFrom - 1, NOW0);
    const stored = evOf(db, v.id);
    if (keySet(g.events) !== keySet(stored) || sum(g.events, 'quantity') !== sum(stored, 'quantity') || sum(g.events, 'rewardCents') !== sum(stored, 'rewardCents')) same = false;
    if (!stored.every((e) => g.events.some((x) => x.idempotencyKey === e.idempotencyKey && x.scheduledAt === +e.scheduledAt && x.quantity === e.quantity))) same = false;
  }
  ok('deterministic backfill: stored plans / events = the pure generation from the same inputs', same);
  const n0 = db._store.demoCompUgcEvent.length, p0 = db._store.demoCompUgcDailyPlan.length;
  const re = await Promise.all([v1, v2, v3, v4].map((v) => svc.materializeVideo(deps, v.id, { now: NOW0 })));
  ok('re-running the materialisation at the same time inserts no row', re.every((r) => r.events === 0) && db._store.demoCompUgcEvent.length === n0 && db._store.demoCompUgcDailyPlan.length === p0);
  ok('every stored plan respects its min / max and each complete day totals its target', db._store.demoCompUgcDailyPlan.every((p) => {
    const t = sum(db._store.demoCompUgcEvent.filter((e) => e.planId === p.id), 'quantity');
    return p.targetSales >= p.minSales && p.targetSales <= p.maxSales && (+p.dayEnd > NOW0 || t === p.targetSales);
  }));
  ok('per-video transaction advisory lock taken (demo-comp-ugc:<videoId>)', db._stats.locks.includes(`demo-comp-ugc:${v1.id}`) && db._stats.locks.includes('demo-comp-ugc:create'));

  await svc.updateUgcSettings(deps, { enabled: true });
  const lb = await svc.getUgcLeaderboard(deps);
  const exp = (v) => U.windowTotals(db._store.demoCompUgcEvent, NOW0).get(v.id) ?? { sales: 0, rewardCents: 0 };
  ok('leaderboard: each video ranked on its own rolling-30-day reward (4 entries, 3 of them by the same owner)',
    lb.enabled === true && lb.total === 4 && lb.videos.every((r, i) => r.rank === i + 1)
    && lb.videos.filter((r) => r.owner.id === m1.id).length === 3
    && lb.videos.every((r, i) => i === 0 || lb.videos[i - 1].totalRewardCents >= r.totalRewardCents)
    && lb.videos.every((r) => { const v = [v1, v2, v3, v4].find((x) => x.id === r.videoId); return r.sales === exp(v).sales && r.totalRewardCents === exp(v).rewardCents; }));
  const row = lb.videos.find((r) => r.videoId === v2.id);
  ok('public row shape: rank, videoId, title, thumbnailUrl, videoUrl, owner{name, avatarUrl}, sales, rewardPerSale, totalReward(+Cents), simulated',
    row.title === 'Unboxing' && row.videoUrl === URL_V(2) && row.thumbnailUrl === null && row.owner.name === 'Salma B.' && row.owner.avatarUrl === '/uploads/demo-competition/s.webp'
    && row.rewardPerSale === 7 && row.totalReward * 100 === row.totalRewardCents && row.totalRewardCents === row.sales * 700 && row.simulated === true
    && lb.simulation === true && lb.windowHours === 720 && lb.currency === 'MAD');
  ok('the top video is the 30–40 sales/day one (independent of its owner\'s other videos)', lb.videos[0].videoId === v4.id);

  // Rolling window boundaries through the service: at several "now" values the totals equal the pure window sums.
  let winOk = true;
  for (const off of [0, 3 * H, 26 * H, 5 * D + 7 * H]) {
    clock.t = NOW0 + off;
    await svc.runUgcEngine(deps);
    const lbx = await svc.getUgcLeaderboard(deps);
    const tot = U.windowTotals(db._store.demoCompUgcEvent, clock.t);
    if (!lbx.videos.every((r) => r.sales === (tot.get(r.videoId)?.sales ?? 0) && r.totalRewardCents === (tot.get(r.videoId)?.rewardCents ?? 0))) winOk = false;
  }
  ok('rolling 720 h totals follow the clock (old days leave the window, new events enter)', winOk);
  const oldest = Math.min(...db._store.demoCompUgcEvent.map((e) => +e.scheduledAt));
  ok('history older than the window stays stored (all-time) but is not ranked', oldest < clock.t - U.UGC_RANKING_WINDOW_MS);
}

// ── 3. Duplicate prevention + concurrency ─────────────────────────────────────
console.log('\n3. Duplicate prevention and concurrent runs');
{
  const { db, deps, clock } = env();
  const m = db._seedMember({ name: 'Imane' });
  const vids = [];
  for (let i = 0; i < 3; i++) vids.push(await svc.createUgcVideo(deps, { title: `V${i}`, memberId: m.id, videoUrl: URL_V(i), minDailySales: 5, maxDailySales: 25 }));
  await svc.updateUgcSettings(deps, { enabled: true });
  clock.t = NOW0 + 2 * D + 5 * H;
  const beforeRuns = db._store.demoCompUgcEvent.length;
  const [r1, r2] = await Promise.all([svc.runUgcEngine(deps), svc.runUgcEngine(deps)]);
  const keys = db._store.demoCompUgcEvent.map((e) => e.idempotencyKey);
  ok('two concurrent runs: no duplicate idempotency key; together they inserted each new event exactly once', new Set(keys).size === keys.length
    && r1.events + r2.events === db._store.demoCompUgcEvent.length - beforeRuns && r1.events + r2.events > 0);
  let exact = true;
  for (const v of vids) {
    const vers = db._store.demoCompUgcVideoVersion.filter((x) => x.videoId === v.id);
    const g = U.generateUgcRange(v.id, vers, +vers[0].effectiveFrom - 1, clock.t);
    if (keySet(g.events) !== keySet(evOf(db, v.id))) exact = false;
  }
  ok('after the concurrent runs every video holds exactly the deterministic series (nothing lost, nothing doubled)', exact);
  const plans = db._store.demoCompUgcDailyPlan.map((p) => `${p.videoId}:${p.dayKey}`);
  ok('one plan per (video, day) (unique key)', new Set(plans).size === plans.length);
  const before = db._store.demoCompUgcEvent.length;
  const again = await svc.runUgcEngine(deps);
  ok('a third run at the same time inserts nothing', again.events === 0 && db._store.demoCompUgcEvent.length === before);
  const dupe = await errOf(db.demoCompUgcEvent.createMany({ data: [{ ...db._store.demoCompUgcEvent[0], id: undefined }] }));
  ok('the unique key itself refuses a duplicate insert without skipDuplicates (P2002)', dupe?.code === 'P2002');
}

// ── 4. Settings versioning keeps history ──────────────────────────────────────
console.log('\n4. Settings versions: changes apply from their effective time only');
{
  const { db, deps, clock } = env();
  const m = db._seedMember({ name: 'Hamza' });
  const v = await svc.createUgcVideo(deps, { title: 'Test', memberId: m.id, videoUrl: URL_V(9), rewardPerSaleMad: 5, minDailySales: 5, maxDailySales: 10 });
  await svc.updateUgcSettings(deps, { enabled: true });
  const snapshot = structuredClone(evOf(db, v.id));
  const plansBefore = structuredClone(db._store.demoCompUgcDailyPlan);
  clock.t = NOW0 + 1000;
  await svc.updateUgcVideo(deps, v.id, { rewardPerSaleMad: 7, minDailySales: 40, maxDailySales: 50 }, 'admin-2');
  const versions = db._store.demoCompUgcVideoVersion.filter((x) => x.videoId === v.id).sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  ok('the change appended a version effective now (after the generation cursor); the first version is untouched',
    versions.length === 2 && +versions[1].effectiveFrom === NOW0 + 1000 && versions[1].rewardPerSaleMad === 7 && versions[1].createdBy === 'admin-2' && versions[0].rewardPerSaleMad === 5);
  clock.t = NOW0 + 3 * D;
  await svc.runUgcEngine(deps);
  const after = evOf(db, v.id);
  ok('history unchanged: every earlier event keeps its reward snapshot (5 MAD) and time', snapshot.every((e) => after.some((x) => x.id === e.id && x.rewardPerSaleMad === 5 && +x.scheduledAt === +e.scheduledAt && x.rewardCents === e.rewardCents)));
  const newer = after.filter((e) => +e.scheduledAt > NOW0 + 1000);
  ok('events after the change use the new reward (7 MAD)', newer.length > 0 && newer.every((e) => e.rewardPerSaleMad === 7 && e.rewardCents === e.quantity * 700));
  ok('plans already drawn are never rewritten; days starting after the change use the new min / max',
    plansBefore.every((p) => db._store.demoCompUgcDailyPlan.some((x) => x.id === p.id && x.targetSales === p.targetSales && x.maxSales === p.maxSales))
    && db._store.demoCompUgcDailyPlan.filter((p) => +p.dayStart > NOW0 + 1000).every((p) => p.minSales === 40 && p.maxSales === 50 && p.targetSales >= 40));
  const vers2 = db._store.demoCompUgcVideoVersion.length;
  await svc.updateUgcVideo(deps, v.id, { title: 'Nouveau titre', thumbnailUrl: '/uploads/demo-competition-ugc/t.webp' });
  ok('a title / media change does not create a version (no engine impact)', db._store.demoCompUgcVideoVersion.length === vers2);
  ok('the database refuses UPDATE of history rows (append-only guard)', await expectCode(db.demoCompUgcEvent.update({ where: { id: after[0].id }, data: { quantity: 1 } }), 'P2010')
    && await expectCode(db.demoCompUgcVideoVersion.update({ where: { id: versions[0].id }, data: { rewardPerSaleMad: 6 } }), 'P2010'));
}

// ── 5. Module / video disabled ────────────────────────────────────────────────
console.log('\n5. Disabled module / disabled video');
{
  const { db, deps, clock } = env();
  const m = db._seedMember({ name: 'Khadija' });
  const v1 = await svc.createUgcVideo(deps, { title: 'One', memberId: m.id, videoUrl: URL_V(1), minDailySales: 20, maxDailySales: 30 });
  const v2 = await svc.createUgcVideo(deps, { title: 'Two', memberId: m.id, videoUrl: URL_V(2), minDailySales: 20, maxDailySales: 30 });
  const n0 = db._store.demoCompUgcEvent.length;
  clock.t = NOW0 + D;
  ok('module OFF (default): a run generates nothing', (await svc.runUgcEngine(deps)).skipped === 'disabled' && db._store.demoCompUgcEvent.length === n0);
  const lbOff = await svc.getUgcLeaderboard(deps);
  ok('module OFF: the public leaderboard is empty and says enabled:false', lbOff.enabled === false && lbOff.videos.length === 0 && lbOff.simulation === true);
  const h = svc.adminUgcHandlers(deps);
  const runOff = await h.run(new Request('http://x', { method: 'POST' }), {}, ADMIN);
  ok('admin "run now" while OFF → 409 UGC_DISABLED', runOff.status === 409 && (await runOff.json()).code === 'UGC_DISABLED');
  const settingsRes = await h.updateSettings(jsonReq({ enabled: true }, 'PATCH'), {}, ADMIN);
  const sb = await settingsRes.json();
  ok('PATCH settings enables the module (resumedAt = now)', settingsRes.status === 200 && sb.settings.enabled === true && +new Date(sb.settings.resumedAt) === NOW0 + D);
  clock.t = NOW0 + 2 * D;
  await svc.runUgcEngine(deps);
  const gap = db._store.demoCompUgcEvent.filter((e) => +e.scheduledAt > NOW0 && +e.scheduledAt <= NOW0 + D);
  ok('switched back ON: generation resumes from that moment — the OFF period is never caught up', gap.length === 0 && db._store.demoCompUgcEvent.some((e) => +e.scheduledAt > NOW0 + D));
  await svc.updateUgcVideo(deps, v2.id, { active: false });
  const v2Count = evOf(db, v2.id).length;
  clock.t = NOW0 + 4 * D;
  await svc.runUgcEngine(deps);
  ok('disabled video: no new events after the change, the other video keeps generating', evOf(db, v2.id).length === v2Count && evOf(db, v1.id).some((e) => +e.scheduledAt > NOW0 + 2 * D));
  const lb = await svc.getUgcLeaderboard(deps);
  const st = await svc.adminGetUgcState(deps);
  const a2 = st.videos.find((x) => x.id === v2.id);
  ok('disabled video: excluded from the public leaderboard, still listed in the admin (rank null, listed false, history kept)',
    lb.total === 1 && lb.videos[0].videoId === v1.id && a2.rank === null && a2.listed === false && a2.stats.salesAll === sum(evOf(db, v2.id), 'quantity'));
  await svc.updateUgcSettings(deps, { enabled: false });
  const nOff = db._store.demoCompUgcEvent.length;
  clock.t = NOW0 + 5 * D;
  ok('module switched OFF again: nothing more is generated', (await svc.runUgcEngine(deps)).skipped === 'disabled' && db._store.demoCompUgcEvent.length === nOff);
  const v3 = await svc.createUgcVideo(deps, { title: 'Three', memberId: m.id, videoUrl: URL_V(3) });
  ok('a video created while OFF (after having run) gets history only up to the moment it was switched OFF', evOf(db, v3.id).length > 0 && evOf(db, v3.id).every((e) => +e.scheduledAt <= NOW0 + 4 * D));
  const noUrl = await svc.createUgcVideo(deps, { title: 'Sans fichier', memberId: m.id });
  await svc.updateUgcSettings(deps, { enabled: true });
  const lb2 = await svc.getUgcLeaderboard(deps);
  ok('a video without a video file is not listed publicly (admin sees it, rank null)', !lb2.videos.some((r) => r.videoId === noUrl.id)
    && (await svc.adminGetUgcState(deps)).videos.find((x) => x.id === noUrl.id).rank === null);
}

// ── 6. Archive keeps history ──────────────────────────────────────────────────
console.log('\n6. Archive (no delete), restore, owner archived');
{
  const { db, deps, clock } = env();
  const m = db._seedMember({ name: 'Nadia' });
  const m2 = db._seedMember({ name: 'Mehdi' });
  const v = await svc.createUgcVideo(deps, { title: 'Arch', memberId: m.id, videoUrl: URL_V(1) });
  const w = await svc.createUgcVideo(deps, { title: 'Owner arch', memberId: m2.id, videoUrl: URL_V(2), minDailySales: 10, maxDailySales: 20 });
  await svc.updateUgcSettings(deps, { enabled: true });
  const n = evOf(db, v.id).length;
  clock.t = NOW0 + 1000;
  const h = svc.adminUgcHandlers(deps);
  const ar = await h.archiveVideo(new Request('http://x', { method: 'POST' }), ctxOf(v.id), ADMIN);
  const ab = await ar.json();
  const row = db._store.demoCompUgcVideo.find((x) => x.id === v.id);
  ok('archive: 200, the video is disabled + archivedAt, an active=false version is appended, history kept',
    ar.status === 200 && ab.archived === true && row.active === false && row.archivedAt && evOf(db, v.id).length === n
    && db._store.demoCompUgcVideoVersion.filter((x) => x.videoId === v.id).some((x) => x.active === false));
  ok('archive is idempotent', (await svc.archiveUgcVideo(deps, v.id)).archived === true);
  clock.t = NOW0 + 2 * D;
  await svc.runUgcEngine(deps);
  ok('an archived video never generates again and leaves the leaderboard', evOf(db, v.id).length === n && !(await svc.getUgcLeaderboard(deps)).videos.some((r) => r.videoId === v.id));
  ok('an archived video cannot be edited (409 ARCHIVED)', await expectCode(svc.updateUgcVideo(deps, v.id, { title: 'x' }), 'ARCHIVED'));
  const adm = (await svc.adminGetUgcVideo(deps, v.id)).video;
  ok('archived video still readable in the admin with its whole history', adm.archivedAt && adm.stats.salesAll === sum(evOf(db, v.id), 'quantity') && adm.versions.length === 2);
  const rs = await h.restoreVideo(new Request('http://x', { method: 'POST' }), ctxOf(v.id), ADMIN);
  const restored = db._store.demoCompUgcVideo.find((x) => x.id === v.id);
  ok('restore brings it back DISABLED (re-enable in the editor)', rs.status === 200 && restored.archivedAt === null && restored.active === false);
  ok('there is no DELETE route for videos (archive convention)', !readdirSync('src/app/api/admin/demo-competition/ugc-videos', { recursive: true })
    .filter((f) => String(f).endsWith('route.js')).some((f) => /export const DELETE/.test(readFileSync(`src/app/api/admin/demo-competition/ugc-videos/${f}`, 'utf8'))));
  // Owner archived (through the main admin; simulated here): generation stops at the archive time, not listed.
  const wCount = evOf(db, w.id).length;
  db._setMember(m2.id, { archivedAt: new Date(NOW0 + 2 * D + 1000), active: false });
  clock.t = NOW0 + 4 * D;
  await svc.runUgcEngine(deps);
  const wEv = evOf(db, w.id);
  ok('owner archived: the video generates nothing after the owner\'s archive time and leaves the public leaderboard',
    wEv.length >= wCount && wEv.every((e) => +e.scheduledAt <= NOW0 + 2 * D + 1000) && !(await svc.getUgcLeaderboard(deps)).videos.some((r) => r.videoId === w.id));
  ok('restore of a video whose owner is archived → 409 MEMBER_ARCHIVED', await (async () => {
    await svc.archiveUgcVideo(deps, w.id);
    return expectCode(svc.restoreUgcVideo(deps, w.id), 'MEMBER_ARCHIVED');
  })());
}

// ── 7. Admin API validation ───────────────────────────────────────────────────
console.log('\n7. Admin API (handlers) and validation errors');
{
  const { db, deps } = env();
  const m = db._seedMember({ name: 'Sara' });
  const archived = db._seedMember({ name: 'Old', active: false, archivedAt: new Date(NOW0 - D) });
  const h = svc.adminUgcHandlers(deps);
  const call = async (fn, req, ctx = {}) => { const r = await fn(req, ctx, ADMIN); return { status: r.status, body: await r.json() }; };
  const created = await call(h.createVideo, jsonReq({ title: '  Mon   avis ', memberId: m.id, minDailySales: 2, maxDailySales: 8, rewardPerSaleMad: 6, videoUrl: URL_V(1) }));
  ok('POST /videos → 201 with the admin detail (normalised title, owner, stats, versions, 30-day daily history)', created.status === 201
    && created.body.video.title === 'Mon avis' && created.body.video.owner.name === 'Sara' && created.body.video.rewardPerSaleMad === 6
    && created.body.video.versions.length === 1 && created.body.video.history.daily.length === 30 && typeof created.body.video.stats.sales30d === 'number');
  const id = created.body.video.id;
  const cases = [
    ['invalid JSON', h.createVideo, new Request('http://x', { method: 'POST', body: '{bad' }), 400, (b) => b.code === 'INVALID_JSON'],
    ['array body', h.createVideo, jsonReq([1]), 400, (b) => b.code === 'INVALID_JSON'],
    ['wrong types', h.createVideo, jsonReq({ title: 1, memberId: m.id, minDailySales: '2', active: 'yes' }), 400, (b) => b.code === 'INVALID_SETTINGS' && b.fields.title === 'INVALID_TYPE' && b.fields.minDailySales === 'INVALID_TYPE' && b.fields.active === 'INVALID_TYPE'],
    ['min > max', h.createVideo, jsonReq({ title: 'x', memberId: m.id, minDailySales: 9, maxDailySales: 3 }), 400, (b) => b.fields.maxDailySales === 'MAX_BELOW_MIN'],
    ['max above the cap', h.createVideo, jsonReq({ title: 'x', memberId: m.id, maxDailySales: 5000 }), 400, (b) => b.fields.maxDailySales === 'INVALID_MAX_SALES'],
    ['reward 4', h.createVideo, jsonReq({ title: 'x', memberId: m.id, rewardPerSaleMad: 4 }), 400, (b) => b.fields.rewardPerSaleMad === 'INVALID_REWARD'],
    ['reward 10', h.updateVideo, jsonReq({ rewardPerSaleMad: 10 }, 'PATCH'), 400, (b) => b.fields.rewardPerSaleMad === 'INVALID_REWARD'],
    ['empty title', h.createVideo, jsonReq({ title: ' ', memberId: m.id }), 400, (b) => b.fields.title === 'INVALID_TITLE'],
    ['missing member', h.createVideo, jsonReq({ title: 'x' }), 400, (b) => b.fields.memberId === 'MEMBER_REQUIRED'],
    ['unknown member', h.createVideo, jsonReq({ title: 'x', memberId: '00000000-0000-4000-8000-000000000000' }), 400, (b) => b.code === 'MEMBER_NOT_FOUND' && b.fields.memberId === 'MEMBER_NOT_FOUND'],
    ['archived member', h.createVideo, jsonReq({ title: 'x', memberId: archived.id }), 400, (b) => b.code === 'INVALID_SETTINGS' && b.fields.memberId === 'MEMBER_ARCHIVED'],
    ['re-owning to an archived member', h.updateVideo, jsonReq({ memberId: archived.id }, 'PATCH'), 400, (b) => b.fields.memberId === 'MEMBER_ARCHIVED'],
    ['real UGC video URL', h.updateVideo, jsonReq({ videoUrl: '/uploads/ugc/real.mp4' }, 'PATCH'), 400, (b) => b.fields.videoUrl === 'INVALID_MEDIA_URL'],
    ['external thumbnail URL', h.updateVideo, jsonReq({ thumbnailUrl: 'https://evil.example.com/x.png' }, 'PATCH'), 400, (b) => b.fields.thumbnailUrl === 'INVALID_MEDIA_URL'],
    ['unknown id', h.getVideo, new Request('http://x'), 404, (b) => b.code === 'NOT_FOUND', '00000000-0000-4000-8000-000000000000'],
    ['malformed id', h.getVideo, new Request('http://x'), 404, (b) => b.code === 'NOT_FOUND', 'not-a-uuid'],
    ['settings: bad target', h.updateSettings, jsonReq({ targetVideoCount: 0 }, 'PATCH'), 400, (b) => b.fields.targetVideoCount === 'INVALID_TARGET_COUNT'],
    ['settings: bad enabled type', h.updateSettings, jsonReq({ enabled: 'on' }, 'PATCH'), 400, (b) => b.fields.enabled === 'INVALID_TYPE'],
  ];
  for (const [name, fn, req, status, check, cid] of cases) {
    const r = await call(fn, req, ctxOf(cid ?? id));
    ok(`validation: ${name} → ${status} ${JSON.stringify(r.body)}`, r.status === status && check(r.body), r);
  }
  const nVideos = db._store.demoCompUgcVideo.length;
  ok('refused requests created / changed nothing', nVideos === 1 && db._store.demoCompUgcVideo[0].rewardPerSaleMad === 6 && db._store.demoCompUgcVideo[0].videoUrl === URL_V(1));
  const up = await call(h.updateVideo, jsonReq({ minDailySales: 1, maxDailySales: 4, active: false, sortOrder: 7, videoUrl: null }, 'PATCH'), ctxOf(id));
  ok('PATCH /videos/:id → 200 with the updated detail (null clears a URL)', up.status === 200 && up.body.video.maxDailySales === 4 && up.body.video.active === false && up.body.video.sortOrder === 7 && up.body.video.videoUrl === null);
  const st = await call(h.getState, new Request('http://x'));
  ok('GET state: settings, limits, uploads, counts, eligible owners (non-archived only), videos with owner + stats + rank',
    st.status === 200 && st.body.settings.targetVideoCount === 20 && st.body.settings.enabled === false && st.body.limits.rewardChoices.join() === '5,6,7'
    && st.body.uploads.field === 'file' && st.body.members.length === 1 && st.body.members[0].id === m.id && st.body.videos.length === 1
    && st.body.videos[0].owner.name === 'Sara' && 'reward30dCents' in st.body.videos[0].stats && st.body.counts.videos === 1);
  const ps = await call(h.updateSettings, jsonReq({ targetVideoCount: 5 }, 'PATCH'));
  ok('PATCH settings target count → 200', ps.status === 200 && ps.body.settings.targetVideoCount === 5 && ps.body.settings.enabled === false);
  const gen = await call(h.generate, new Request('http://x', { method: 'POST' }));
  const live = db._store.demoCompUgcVideo.filter((x) => !x.archivedAt);
  ok('generate fills up to the target with deterministic placeholders (owners = non-archived members), each with history', gen.status === 200
    && gen.body.created === 4 && live.length === 5 && live.every((x) => x.memberId === m.id) && gen.body.events > 0
    && live.slice(1).every((x, i) => x.title === U.placeholderVideo(i + 1).title));
  const gen2 = await call(h.generate, new Request('http://x', { method: 'POST' }));
  ok('generate again creates nothing (idempotent)', gen2.body.created === 0 && db._store.demoCompUgcVideo.length === 5);
  const { db: db2, deps: deps2 } = env();
  void db2;
  const noMem = await call(svc.adminUgcHandlers(deps2).generate, new Request('http://x', { method: 'POST' }));
  ok('generate with no demo member → 409 NO_MEMBERS', noMem.status === 409 && noMem.body.code === 'NO_MEMBERS');
  ok('video limit (100 non-archived) enforced → VIDEO_LIMIT_REACHED', await (async () => {
    const { db: d3, deps: dp3 } = env();
    const mm = d3._seedMember({ name: 'Z' });
    for (let i = 0; i < 100; i++) d3._store.demoCompUgcVideo.push({ id: `fake-${i}`, memberId: mm.id, title: 't', archivedAt: null, active: false, sortOrder: i, createdAt: new Date(), minDailySales: 0, maxDailySales: 0, rewardPerSaleMad: 5 });
    return expectCode(svc.createUgcVideo(dp3, { title: 'x', memberId: mm.id }), 'VIDEO_LIMIT_REACHED');
  })());
}

// ── 8. Uploads: validation + dedicated namespace ──────────────────────────────
console.log('\n8. Uploads (validateVideo / validateImage, caps, dedicated namespace)');
{
  const { db, deps } = env();
  const saved = [];
  const fakeSave = async (buf, opts) => { saved.push({ bytes: buf.length, ...opts }); return { url: `/uploads/${opts.subdir}/${opts.filename}` }; };
  let processed = 0;
  const udeps = { ...deps, saveMedia: fakeSave, processThumbnail: async (b) => { processed++; return Buffer.concat([Buffer.from('RIFF0000WEBP'), b.subarray(0, 8)]); } };
  const h = svc.adminUgcHandlers(udeps);
  const m = db._seedMember({ name: 'Ayoub' });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 1)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
  const form = (name, buf, type, field = 'file') => { const f = new FormData(); f.append(field, new File([buf], name, { type })); return new Request('http://x', { method: 'POST', body: f }); };
  const call = async (fn, req, ctx = {}) => { const r = await fn(req, ctx, ADMIN); return { status: r.status, body: await r.json() }; };

  const okVid = await call(h.uploadVideo, form('clip.mp4', mp4, 'video/mp4'));
  ok('valid .mp4 → 201 { url, kind:"video", bytes }, stored as is', okVid.status === 201 && okVid.body.kind === 'video' && okVid.body.bytes === mp4.length && saved.at(-1).bytes === mp4.length);
  const s0 = saved.at(-1);
  ok('stored through saveMedia in the DEDICATED namespace (category / folder / subdir "demo-competition-ugc", resourceType video), never the real UGC folder',
    s0.category === 'demo-competition-ugc' && s0.folder === 'demo-competition-ugc' && s0.subdir === 'demo-competition-ugc' && s0.resourceType === 'video'
    && s0.folder !== 'ugc' && s0.category !== 'videos' && /^ugc-video-[0-9a-f-]{36}\.mp4$/.test(s0.filename));
  ok('the returned URL is accepted as videoUrl', U.isDemoUgcMediaUrl(okVid.body.url, 'video'));
  const okThumb = await call(h.uploadThumbnail, form('t.png', png, 'image/png'));
  const s1 = saved.at(-1);
  ok('valid .png thumbnail → 201, re-encoded (processThumbnail) to .webp, resourceType image, same dedicated namespace',
    okThumb.status === 201 && processed === 1 && /^ugc-thumb-[0-9a-f-]{36}\.webp$/.test(s1.filename) && s1.resourceType === 'image' && s1.category === 'demo-competition-ugc'
    && U.isDemoUgcMediaUrl(okThumb.body.url, 'thumbnail'));
  const nSaved = saved.length;
  const bad = [
    ['video: .avi refused', h.uploadVideo, form('a.avi', mp4, 'video/x-msvideo'), 415, 'INVALID_FILE_TYPE'],
    ['video: .ogg refused (not in the demo allow-list)', h.uploadVideo, form('a.ogg', Buffer.from('OggS0000'), 'video/ogg'), 415, 'INVALID_FILE_TYPE'],
    ['video: .mp4 whose bytes are not a video (magic bytes)', h.uploadVideo, form('a.mp4', Buffer.from('<html><script>x</script></html>'), 'video/mp4'), 415, 'INVALID_FILE_TYPE'],
    ['video: an image sent as .mp4', h.uploadVideo, form('a.mp4', png, 'video/mp4'), 415, 'INVALID_FILE_TYPE'],
    ['video: empty file', h.uploadVideo, form('a.mp4', Buffer.alloc(0), 'video/mp4'), 400, 'EMPTY_FILE'],
    ['video: no "file" field', h.uploadVideo, form('a.mp4', mp4, 'video/mp4', 'video'), 400, 'INVALID_INPUT'],
    ['video: not multipart', h.uploadVideo, jsonReq({ file: 'x' }), 400, 'INVALID_INPUT'],
    ['video: declared size above 50 MB refused before reading', h.uploadVideo, new Request('http://x', { method: 'POST', headers: { 'content-length': String(60 * 1024 * 1024) }, body: 'x' }), 413, 'FILE_TOO_LARGE'],
    ['thumbnail: .svg refused', h.uploadThumbnail, form('a.svg', Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml'), 415, 'INVALID_FILE_TYPE'],
    ['thumbnail: .gif refused', h.uploadThumbnail, form('a.gif', Buffer.from('GIF89a000000'), 'image/gif'), 415, 'INVALID_FILE_TYPE'],
    ['thumbnail: a video sent as .png', h.uploadThumbnail, form('a.png', mp4, 'image/png'), 415, 'INVALID_FILE_TYPE'],
    ['thumbnail: png polyglot with a script', h.uploadThumbnail, form('a.png', Buffer.concat([png.subarray(0, 8), Buffer.from('<script>alert(1)</script>')]), 'image/png'), 415, 'INVALID_FILE_TYPE'],
    ['thumbnail: declared size above 5 MB', h.uploadThumbnail, new Request('http://x', { method: 'POST', headers: { 'content-length': String(6 * 1024 * 1024) }, body: 'x' }), 413, 'FILE_TOO_LARGE'],
  ];
  for (const [name, fn, req, status, code] of bad) {
    const r = await call(fn, req);
    ok(`upload refused: ${name} → ${status} ${code}`, r.status === status && r.body.code === code, r);
  }
  ok('refused uploads stored nothing', saved.length === nSaved);
  let readAttempted = false;
  const huge = { name: 'big.mp4', size: 60 * 1024 * 1024, arrayBuffer: async () => { readAttempted = true; return new ArrayBuffer(0); } };
  ok('a real file above the cap (60 MB) is refused FILE_TOO_LARGE without being read', await expectCode(svc.storeUgcMedia(huge, 'video', udeps), 'FILE_TOO_LARGE') && !readAttempted);
  const bigThumb = { name: 'big.png', size: 5 * 1024 * 1024 + 1, arrayBuffer: async () => { readAttempted = true; return new ArrayBuffer(0); } };
  ok('a thumbnail of 5 MB + 1 byte is refused FILE_TOO_LARGE', await expectCode(svc.storeUgcMedia(bigThumb, 'thumbnail', udeps), 'FILE_TOO_LARGE') && !readAttempted);

  const v = await svc.createUgcVideo(udeps, { title: 'Upload', memberId: m.id });
  const perId = await call(h.uploadVideoFile, form('c.webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(50, 3)]), 'video/webm'), ctxOf(v.id));
  ok('POST /videos/:id/video stores the file and sets videoUrl (response: url + updated video)', perId.status === 200 && perId.body.video.videoUrl === perId.body.url
    && db._store.demoCompUgcVideo.find((x) => x.id === v.id).videoUrl === perId.body.url && /\.webm$/.test(perId.body.url));
  const perIdT = await call(h.uploadThumbnailFile, form('c.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 4)]), 'image/jpeg'), ctxOf(v.id));
  ok('POST /videos/:id/thumbnail sets thumbnailUrl', perIdT.status === 200 && perIdT.body.video.thumbnailUrl === perIdT.body.url);
  await svc.archiveUgcVideo(udeps, v.id);
  const before = saved.length;
  const arch = await call(h.uploadVideoFile, form('c.mp4', mp4, 'video/mp4'), ctxOf(v.id));
  ok('upload to an archived video → 409 ARCHIVED, nothing stored', arch.status === 409 && arch.body.code === 'ARCHIVED' && saved.length === before);
}

// ── 9. Public route handler ───────────────────────────────────────────────────
console.log('\n9. Public leaderboard route');
{
  const { db, deps } = env();
  const m = db._seedMember({ name: 'Bilal', photoUrl: '/uploads/demo-competition/b.webp' });
  for (let i = 0; i < 4; i++) await svc.createUgcVideo(deps, { title: `P${i}`, memberId: m.id, videoUrl: URL_V(i), rewardPerSaleMad: U.REWARD_CHOICES[i % 3] });
  await svc.updateUgcSettings(deps, { enabled: true });
  const h = svc.publicUgcHandlers(deps);
  const r = await h.leaderboard(new Request('http://x/api/demo-competition/ugc-videos?limit=3'));
  const b = await r.json();
  ok('GET /api/demo-competition/ugc-videos → 200, short public cache, simulation flag, limit honoured', r.status === 200 && r.headers.get('cache-control') === PUBLIC_CACHE
    && b.simulation === true && b.enabled === true && b.total === 4 && b.videos.length === 3 && b.videos[0].rank === 1);
  ok('public payload carries nothing from real tables (only the documented keys)', b.videos.every((v) => Object.keys(v).sort().join() === 'lastSaleAt,owner,rank,rewardPerSale,sales,simulated,thumbnailUrl,title,totalReward,totalRewardCents,videoId,videoUrl'
    && Object.keys(v.owner).sort().join() === 'avatarUrl,id,name,public'));
  await new Promise((res) => setTimeout(res, 20)); // let the read-path catch-up settle
}

// ── 10. Isolation ─────────────────────────────────────────────────────────────
console.log('\n10. Isolation from real data and from the member / brand demo stats');
{
  const { db, deps, clock } = env();
  for (const model of ['order', 'affiliate', 'affiliateOrder', 'ugcSubmission', 'ugcVideo', 'ugcEarning', 'wallet', 'affiliatePayout', 'demoCompEvent', 'demoCompDailyPlan', 'demoCompBrand', 'demoCompMemberVersion', 'demoCompEngine']) {
    let blocked = false;
    try { void db[model]; } catch (e) { blocked = /PRODUCTION TABLE ACCESS BLOCKED/.test(e.message); }
    if (!blocked) ok(`the strict fake DB blocks ${model}`, false);
  }
  ok('the strict fake DB blocks real tables (orders, affiliates, UGC, wallets, payouts) and the member / brand demo stats', true);
  const m = db._seedMember({ name: 'Ghita' });
  const h = svc.adminUgcHandlers({ ...deps, saveMedia: async (_b, o) => ({ url: `/uploads/${o.subdir}/${o.filename}` }), processThumbnail: async (x) => x });
  await svc.createUgcVideo(deps, { title: 'Iso', memberId: m.id, videoUrl: URL_V(1) });
  await svc.updateUgcSettings(deps, { enabled: true });
  clock.t = NOW0 + 2 * D;
  await svc.runUgcEngine(deps);
  await svc.getUgcLeaderboard(deps); await svc.adminGetUgcState(deps); await svc.generateUgcVideos(deps);
  await h.getState(new Request('http://x'), {}, ADMIN);
  await new Promise((res) => setTimeout(res, 20));
  ok('a full run (create, backfill, engine, stats, generate, admin) wrote ONLY demo_comp_ugc_* models', db._stats.writes.length > 5 && db._stats.writes.every((w) => UGC_MODELS.includes(w.split('.')[0])), db._stats.writes.filter((w) => !UGC_MODELS.includes(w.split('.')[0])));
  ok('demo members are only READ (owner name / photo / archive state), never written', db._stats.reads.some((r) => r.startsWith('demoCompMember.')) && !db._stats.writes.some((w) => w.startsWith('demoCompMember.')));

  const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = ['src/lib/demoCompUgc.js', 'src/lib/services/demoCompUgcService.js', ...walk('src/app/api/admin/demo-competition/ugc-videos'), ...walk('src/app/api/demo-competition/ugc-videos')];
  const src = files.map((f) => [f, readFileSync(f, 'utf8')]);
  const FORBIDDEN_IMPORT = /from ['"][^'"]*(affiliateSystemService|orderService|fakeOrder|rewards|reward\w*Service|depositService|boosterService|ugcService|ugcEarnings|ugcStatus|balance\/|recruiter\w*Service|brandAccessService|brandSimulationService|demoService|walletService|payout\w*Service)/;
  ok('no UGC-demo file imports a real UGC / money / reward / old-demo module', src.every(([, s]) => !FORBIDDEN_IMPORT.test(s)), src.filter(([, s]) => FORBIDDEN_IMPORT.test(s)).map(([f]) => f));
  const FORBIDDEN_MODEL = /\.(order|orderItem|affiliate\w*|ugc(?!Videos\b)\w*|wallet\w*|payout\w*|reward\w*|recruiter\w*|brandAccess|brandSimHour|demoAffiliate|demoStats|setting|demoCompEvent|demoCompDailyPlan|demoCompBrand\w*|demoCompMemberVersion|demoCompEngine)\s*\.\s*(find|create|update|upsert|delete|count|group|aggregate)/;
  ok('no UGC-demo file queries a real model or the member / brand demo stats', src.every(([, s]) => !FORBIDDEN_MODEL.test(s)), src.filter(([, s]) => FORBIDDEN_MODEL.test(s)).map(([f]) => f));
  const svcSrc = readFileSync('src/lib/services/demoCompUgcService.js', 'utf8');
  const usedModels = [...new Set([...svcSrc.matchAll(/\b(?:db|tx)\.(\w+)\.(?:find|create|update|upsert|delete|count|groupBy)/g)].map((x) => x[1]))].sort();
  ok('the service queries exactly: demoCompMember (read) + the 5 demo_comp_ugc_* models', usedModels.join() === ['demoCompMember', 'demoCompUgcDailyPlan', 'demoCompUgcEvent', 'demoCompUgcSettings', 'demoCompUgcVideo', 'demoCompUgcVideoVersion'].join(), usedModels);
  ok('demoCompMember is never written by the service', !/\b(?:db|tx)\.demoCompMember\.(create|update|upsert|delete)/.test(svcSrc));
  ok('no balance provider registration / no real UGC media folder in UGC-demo code', src.every(([, s]) => !/registerBalanceProvider/.test(s) && !/folder:\s*['"]ugc['"]|subdir:\s*['"]ugc['"]/.test(s)));
  const mig = readFileSync('prisma/migrations/20261116_demo_comp_ugc_videos/migration.sql', 'utf8');
  const code = mig.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const touched = [...code.matchAll(/(?:TABLE|ON|REFERENCES|INTO|FROM)\s+(?:IF NOT EXISTS\s+)?"([a-z_]+)"/g)].map((x) => x[1]);
  ok('the migration only creates / references demo_comp_ugc_* tables (+ the owner FK to demo_comp_members)', touched.length > 10
    && touched.every((t) => t.startsWith('demo_comp_ugc_') || t === 'demo_comp_members'), [...new Set(touched)]);
  ok('the migration never alters / drops an existing table, and never cascades into demo_comp_members',
    !/ALTER TABLE "(?!demo_comp_ugc_)/.test(code) && !/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE "/.test(code)
    && /REFERENCES "demo_comp_members"\("id"\) ON DELETE RESTRICT/.test(code) && code.match(/REFERENCES "demo_comp_members"/g).length === 1);
  ok('the migration is re-runnable (IF NOT EXISTS / duplicate_object / CREATE OR REPLACE / DROP TRIGGER IF EXISTS / ON CONFLICT DO NOTHING)',
    !/CREATE (UNIQUE )?(TABLE|INDEX) "/.test(code) && (code.match(/EXCEPTION WHEN duplicate_object/g) || []).length >= 11
    && /CREATE OR REPLACE FUNCTION/.test(code) && (code.match(/DROP TRIGGER IF EXISTS/g) || []).length === 3 && /ON CONFLICT \("id"\) DO NOTHING/.test(code));
  ok('CHECKs: reward IN (5, 6, 7), 0 ≤ min ≤ max ≤ 1000, reward formula, archived ⇒ disabled; unique (videoId, dayKey) and idempotencyKey',
    (code.match(/"rewardPerSaleMad" IN \(5, 6, 7\)/g) || []).length === 3 && /"maxDailySales" BETWEEN "minDailySales" AND 1000/.test(code)
    && /"rewardCents" = "quantity" \* "rewardPerSaleMad" \* 100/.test(code) && /"archivedAt" IS NULL OR "active" = false/.test(code)
    && /UNIQUE INDEX IF NOT EXISTS "demo_comp_ugc_daily_plans_videoId_dayKey_key"/.test(code) && /UNIQUE INDEX IF NOT EXISTS "demo_comp_ugc_events_idempotencyKey_key"/.test(code));
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const UGC = ['DemoCompUgcVideo', 'DemoCompUgcVideoVersion', 'DemoCompUgcDailyPlan', 'DemoCompUgcEvent', 'DemoCompUgcSettings'];
  const blocks = [...schema.matchAll(/^model (\w+) \{[\s\S]*?^\}/gm)].filter((x) => UGC.includes(x[1])).map((x) => x[0]);
  const SCALARS = new Set(['String', 'Int', 'Boolean', 'DateTime', 'Float', 'Json', 'Decimal', 'BigInt', 'Bytes']);
  const relTypes = blocks.flatMap((b) => [...b.matchAll(/^\s+\w+\s+([A-Z]\w+)(?:\[\]|\?)?(?:\s|$)/gm)].map((x) => x[1]).filter((t) => !SCALARS.has(t)));
  ok('the 5 UGC models are separate blocks relating only to each other and to DemoCompMember', blocks.length === 5 && relTypes.length >= 6
    && relTypes.every((t) => UGC.includes(t) || t === 'DemoCompMember'), relTypes);
  const memberBlock = schema.match(/^model DemoCompMember \{[\s\S]*?^\}/m)[0];
  ok('the only edit of an existing model is the DemoCompMember back-relation line (ugcVideos DemoCompUgcVideo[])', /^\s+ugcVideos\s+DemoCompUgcVideo\[\]$/m.test(memberBlock));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
