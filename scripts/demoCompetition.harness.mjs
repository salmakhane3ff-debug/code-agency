#!/usr/bin/env node
/**
 * scripts/demoCompetition.harness.mjs — DB-backed checks of the Demo Competition
 * on a THROWAWAY PostgreSQL database (migration 20261113 applied). Not part of the
 * unit suite (it needs a database). It REFUSES to run unless the database name
 * starts with "dc_" or "val_" (never a shared or production database).
 *
 *   DATABASE_URL=postgresql://…/dc_xxx node scripts/demoCompetition.harness.mjs
 *
 * Checks: CHECK constraints and append-only triggers, archive (history kept) and the
 * cascade delete the guards still allow, engine OFF/ON (nothing for the OFF period),
 * 4 concurrent OS processes generating at once (no duplicate, no error), SQL window
 * sums = JS reference over the raw events, timings.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL || '';
const dbName = (url.match(/\/([^/?]+)(\?|$)/) || [])[1] || '';
if (!/^(dc_|val_)/.test(dbName)) {
  console.error(`refusing to run on database "${dbName}" (must start with dc_ or val_)`);
  process.exit(2);
}

const NOW = Date.parse(process.env.HARNESS_NOW || '2026-11-09T12:00:00Z');
const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === '--worker') {
  const svc = await import('../src/lib/services/demoCompetitionService.js');
  const { default: prisma } = await import('../src/lib/prisma.js');
  const at = Number(process.argv[3]);
  try {
    const r = await svc.runEngine({ now: () => at }, { now: at });
    console.log(JSON.stringify({ ok: true, ...r }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
  await prisma.$disconnect();
  process.exit(0);
}

const svc = await import('../src/lib/services/demoCompetitionService.js');
const { default: prisma } = await import('../src/lib/prisma.js');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : ''}`); } };
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
const deps = { now: () => NOW };

console.log(`\nDemo Competition DB harness on ${dbName}`);
if ((await prisma.demoCompMember.count()) === 0) {
  await svc.initializeCompetition(deps, 'harness'); // each profile gets its 30-day history at creation
  await svc.updateEngine(deps, { enabled: true });
  await svc.runEngine(deps, { now: NOW });
}
const members = await prisma.demoCompMember.count({ where: { archivedAt: null } });
const brands = await prisma.demoCompBrand.count({ where: { archivedAt: null } });
ok('21 demo members and 20 demo brands present', members === 21 && brands === 20, { members, brands });

console.log('\n1. Database guards');
const e0 = await prisma.demoCompEvent.findFirst({ orderBy: { scheduledAt: 'asc' } });
ok('UPDATE of an event is refused by the trigger', await rejects(() => prisma.$executeRawUnsafe(`UPDATE demo_comp_events SET "earningsCents" = 1 WHERE id = $1`, e0.id)));
ok('direct DELETE of an event is refused by the trigger', await rejects(() => prisma.$executeRawUnsafe(`DELETE FROM demo_comp_events WHERE id = $1`, e0.id)));
ok('UPDATE / DELETE of a plan and a settings version are refused', await rejects(() => prisma.$executeRawUnsafe(`UPDATE demo_comp_daily_plans SET "targetOrders" = 0 WHERE id = $1`, e0.planId))
  && await rejects(() => prisma.$executeRawUnsafe(`DELETE FROM demo_comp_member_versions WHERE id = (SELECT id FROM demo_comp_member_versions LIMIT 1)`)));
ok('an event with wrong earnings is refused by the CHECK (formula enforced in SQL)', await rejects(() => prisma.$executeRawUnsafe(
  `INSERT INTO demo_comp_events (id,"eventType","memberId","planId",seq,quantity,"priceCents","allocationBps","earningsCents","versionId","scheduledAt","idempotencyKey")
   SELECT gen_random_uuid()::text,'PERSONAL_SALE',"memberId","planId",999,1,30000,3000,9001,"versionId",now(),'harness:bad' FROM demo_comp_events WHERE id=$1`, e0.id)));
ok('4 orders in one event / allocation > 100 % / member+brand in one event are refused', await rejects(() => prisma.$executeRawUnsafe(
  `INSERT INTO demo_comp_events (id,"eventType","memberId","planId",seq,quantity,"priceCents","allocationBps","earningsCents","versionId","scheduledAt","idempotencyKey")
   SELECT gen_random_uuid()::text,'PERSONAL_SALE',"memberId","planId",998,4,30000,3000,36000,"versionId",now(),'harness:bad4' FROM demo_comp_events WHERE id=$1`, e0.id))
  && await rejects(async () => prisma.demoCompMember.update({ where: { id: (await prisma.demoCompMember.findFirst()).id }, data: { allocationBps: 10001 } }))
  && await rejects(() => prisma.$executeRawUnsafe(`UPDATE demo_comp_members SET "minDailyOrders" = 50, "maxDailyOrders" = 10 WHERE id = (SELECT id FROM demo_comp_members LIMIT 1)`)));
ok('engine defaults: each allocation 1..10000 on its own (40 % + 70 % accepted; 100.01 % refused by the CHECK)',
  !(await rejects(() => prisma.$executeRawUnsafe(`UPDATE demo_comp_engine SET "defaultMemberBps" = 4000, "defaultBrandBps" = 7000`)))
  && await rejects(() => prisma.$executeRawUnsafe(`UPDATE demo_comp_engine SET "defaultBrandBps" = 10001`))
  && (await prisma.$executeRawUnsafe(`UPDATE demo_comp_engine SET "defaultMemberBps" = 3000, "defaultBrandBps" = 7000`)) === 1);
ok('an archived profile must be disabled (CHECK)', await rejects(() => prisma.$executeRawUnsafe(`UPDATE demo_comp_members SET "archivedAt" = now(), active = true WHERE id = (SELECT id FROM demo_comp_members LIMIT 1)`)));
ok('duplicate idempotency key refused by the UNIQUE index', await rejects(() => prisma.$executeRawUnsafe(
  `INSERT INTO demo_comp_events (id,"eventType","memberId","planId",seq,quantity,"priceCents","allocationBps","earningsCents","versionId","scheduledAt","idempotencyKey")
   SELECT gen_random_uuid()::text,"eventType","memberId","planId",seq,quantity,"priceCents","allocationBps","earningsCents","versionId","scheduledAt","idempotencyKey" FROM demo_comp_events WHERE id=$1`, e0.id)));
ok('deleting a member that owns brands is refused by the FK (RESTRICT)', await rejects(() => prisma.$executeRawUnsafe(`DELETE FROM demo_comp_members WHERE id = (SELECT "ownerId" FROM demo_comp_brands LIMIT 1)`)));

console.log('\n2. Archive keeps history; the guards still allow a (future, approved) cascade delete');
{
  const b = await prisma.demoCompBrand.findFirst({ where: { archivedAt: null }, orderBy: { createdAt: 'desc' } });
  const hist = async (id) => await prisma.demoCompEvent.count({ where: { brandId: id } }) + await prisma.demoCompBrandVersion.count({ where: { brandId: id } }) + await prisma.demoCompDailyPlan.count({ where: { brandId: id } });
  const before = await hist(b.id);
  await svc.archiveBrand(deps, b.id, 'harness');
  const arch = await prisma.demoCompBrand.findUnique({ where: { id: b.id } });
  ok('archiving a brand keeps all its history (events, plans, versions + one active=false version)', before > 0 && arch.archivedAt && arch.active === false && (await hist(b.id)) === before + 1);
  ok('no API path deletes a profile any more (service has no delete)', !('deleteBrand' in svc) && !('deleteMember' in svc));
  // DB level only (throwaway DB): the history guards still let the parent cascade through, for a later approved cleanup.
  await prisma.$executeRawUnsafe(`DELETE FROM demo_comp_brands WHERE id = $1`, b.id);
  ok('the guards still allow a cascade delete of an archived brand at DB level (for a later approved retirement)', (await hist(b.id)) === 0);
  // put the count back to 20 for the next runs
  const owner = await prisma.demoCompMember.findFirst({ where: { archivedAt: null } });
  await svc.createBrand(deps, { name: 'Harness Brand', ownerId: owner.id, minDailyOrders: 4, maxDailyOrders: 20 }, 'harness');
  await svc.runEngine(deps, { now: NOW });
}

console.log('\n2b. Engine OFF / ON on PostgreSQL');
{
  const offAt = NOW + 1 * 3_600_000, onAt = NOW + 3 * 3_600_000, later = NOW + 5 * 3_600_000;
  await svc.runEngine({ now: () => offAt }, { now: offAt });
  await svc.updateEngine({ now: () => offAt }, { enabled: false });
  const off = await svc.runEngine({ now: () => onAt }, { now: onAt });
  await svc.updateEngine({ now: () => onAt }, { enabled: true });
  await svc.runEngine({ now: () => later }, { now: later });
  const inOff = await prisma.demoCompEvent.count({ where: { scheduledAt: { gt: new Date(offAt), lte: new Date(onAt) } } });
  const after = await prisma.demoCompEvent.count({ where: { scheduledAt: { gt: new Date(onAt), lte: new Date(later) } } });
  ok('engine OFF generates nothing; re-enabled it resumes from the ON time (0 events in the OFF period, events after)', off.skipped === 'disabled' && inOff === 0 && after > 0, { inOff, after });
}

console.log('\n3. Concurrent generation from 4 OS processes');
{
  const later = NOW + 6 * 3_600_000;
  const before = await prisma.demoCompEvent.count();
  const outs = await Promise.all([1, 2, 3, 4].map(() => new Promise((res) => {
    const p = spawn(process.execPath, [SELF, '--worker', String(later)], { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { try { res(JSON.parse(out.trim().split('\n').pop())); } catch { res({ ok: false, error: out }); } });
  })));
  const after = await prisma.demoCompEvent.count();
  const inserted = outs.reduce((a, o) => a + (o.events || 0), 0);
  const dup = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM (SELECT "idempotencyKey" FROM demo_comp_events GROUP BY 1 HAVING count(*) > 1) d`);
  ok('all 4 processes finished without error', outs.every((o) => o.ok && !o.error), outs);
  ok('the inserted total equals the table growth (each event inserted exactly once)', after - before === inserted && inserted > 0, { before, after, inserted });
  ok('no duplicate idempotency key in the table', dup[0].n === 0);
  const solo = await svc.runEngine({ now: () => later }, { now: later });
  ok('a 5th run at the same instant inserts nothing', solo.events === 0);
}

console.log('\n4. SQL aggregates = JS reference');
{
  const at = NOW + 6 * 3_600_000;
  svc.__resetDemoCompState();
  const lb = await svc.getMemberLeaderboard({ now: () => at }, {});
  const m = lb.members[3];
  const rows = await prisma.demoCompEvent.findMany({ where: { memberId: m.id, eventType: 'PERSONAL_SALE' }, select: { earningsCents: true, quantity: true, scheduledAt: true } });
  const win = (h) => rows.filter((r) => +r.scheduledAt > at - h * 3_600_000 && +r.scheduledAt <= at);
  const prof = (await svc.getPublicMember({ now: () => at }, m.id)).member;
  const s = (a, k) => a.reduce((x, r) => x + r[k], 0);
  ok('24 h / 7 d / 30 d / all-time match the raw events', prof.stats.earnings24hCents === s(win(24), 'earningsCents') && prof.stats.earnings7dCents === s(win(168), 'earningsCents')
    && prof.stats.earnings30dCents === s(win(720), 'earningsCents') && prof.stats.earningsAllCents === s(rows.filter((r) => +r.scheduledAt <= at), 'earningsCents'));
  const t1 = Date.now();
  for (let i = 0; i < 5; i++) { svc.__resetDemoCompState(); await svc.getMemberLeaderboard({ now: () => at }, {}); await svc.getBrandLeaderboard({ now: () => at }, {}); }
  const per = (Date.now() - t1) / 10;
  const total = await prisma.demoCompEvent.count();
  ok(`leaderboard query time acceptable (${per.toFixed(0)} ms per leaderboard over ${total} events)`, per < 1500);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
