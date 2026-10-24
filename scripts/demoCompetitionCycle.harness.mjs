#!/usr/bin/env node
/**
 * scripts/demoCompetitionCycle.harness.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3A — REAL-PostgreSQL harness for the demo competition rollover. Proves
 * what the fake in demoCompetitionCycle.test.mjs cannot: the FOR UPDATE row lock
 * across separate connections/clients (= separate workers), the interactive
 * transaction, Prisma's raw timestamp types and rollback on failure.
 *
 * NOT part of the zero-dependency suite (*.harness.mjs, not *.test.mjs).
 *
 * ── SAFETY (it refuses to run unless ALL hold) ────────────────────────────────
 *   • DEMO_HARNESS_DATABASE_URL is set and differs from DATABASE_URL.
 *   • host is local (localhost / 127.0.0.1 / ::1 / unix socket).
 *   • the database name contains "harness", "scratch" or "test".
 *   • it only creates/uses demo_* tables and "settings" in that throwaway DB.
 * Exit 0 = all passed, 1 = a check failed, 2 = refused / not configured.
 *
 * Disposable server (same recipe as settingsMerge.harness.mjs):
 *   PGBIN=/usr/lib/postgresql/16/bin; D=$(mktemp -d)
 *   $PGBIN/initdb -D "$D/data" -U harness --auth=trust >/dev/null
 *   $PGBIN/pg_ctl -D "$D/data" -o "-k $D -p 55436 -c listen_addresses=''" -l "$D/log" start
 *   $PGBIN/createdb -h "$D" -p 55436 -U harness demo_harness
 *   DEMO_HARNESS_DATABASE_URL="postgresql://harness@localhost/demo_harness?host=$D&port=55436" \
 *     node scripts/demoCompetitionCycle.harness.mjs
 *   $PGBIN/pg_ctl -D "$D/data" stop && rm -rf "$D"
 * ─────────────────────────────────────────────────────────────────────────────
 */

const url = process.env.DEMO_HARNESS_DATABASE_URL;
const refuse = (m) => { console.error(`REFUSED: ${m}`); process.exit(2); };
if (!url) refuse("DEMO_HARNESS_DATABASE_URL is not set");
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) refuse("harness URL equals DATABASE_URL");
let parsed; try { parsed = new URL(url); } catch { refuse("unparseable URL"); }
const host = parsed.searchParams.get("host") || parsed.hostname;
if (!(["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) && (host.startsWith("/") || ["localhost", "127.0.0.1", "::1"].includes(host)))) refuse(`non-local host ${host}`);
if (!/harness|scratch|test/.test(parsed.pathname)) refuse("database name must contain harness/scratch/test");

// demoService uses the shared client; point it at the throwaway DB for THIS
// process only (the original value is never read).
process.env.DATABASE_URL = url;

const { PrismaClient } = await import("../src/generated/prisma/index.js");
const { PrismaPg } = await import("@prisma/adapter-pg");
const svc = await import("../src/lib/services/demoService.js");
const { CYCLE_ARCHIVE_PREFIX, addCompetitionDays } = await import("../src/lib/demoCompetitionCycle.js");
const shared = (await import("../src/lib/prisma.js")).default;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const workers = Array.from({ length: 8 }, () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }) }));
const db = workers[0];
const DDL = [
  `CREATE TABLE IF NOT EXISTS "settings" ("id" TEXT PRIMARY KEY, "data" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "demo_affiliates" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "username" TEXT NOT NULL UNIQUE, "avatarColor" TEXT NOT NULL DEFAULT '#6366f1', "avatarUrl" TEXT, "gender" TEXT, "growthType" TEXT NOT NULL DEFAULT 'consistent', "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS "demo_stats" ("id" TEXT PRIMARY KEY, "demoAffiliateId" TEXT NOT NULL UNIQUE REFERENCES "demo_affiliates"("id"), "totalOrders" INTEGER NOT NULL DEFAULT 0, "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0, "confirmedOrders" INTEGER NOT NULL DEFAULT 0, "cancelledOrders" INTEGER NOT NULL DEFAULT 0, "todayOrders" INTEGER NOT NULL DEFAULT 0, "todayRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0, "teamSize" INTEGER NOT NULL DEFAULT 0, "teamOrders" INTEGER NOT NULL DEFAULT 0, "teamRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0, "teamCommission" DOUBLE PRECISION NOT NULL DEFAULT 0, "rank" INTEGER NOT NULL DEFAULT 0, "ugcTodayEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0, "ugcTodaySales" INTEGER NOT NULL DEFAULT 0, "ugcTotalEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0, "ugcTotalSales" INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "demo_earnings_history" ("id" TEXT PRIMARY KEY, "demoAffiliateId" TEXT NOT NULL REFERENCES "demo_affiliates"("id"), "date" TIMESTAMP(3) NOT NULL, "orders" INTEGER NOT NULL DEFAULT 0, "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0, "commission" DOUBLE PRECISION NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS "demo_competition" ("id" TEXT PRIMARY KEY DEFAULT 'current', "startDate" TIMESTAMP(3) NOT NULL, "endDate" TIMESTAMP(3) NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "cycleNum" INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS "demo_settings" ("id" TEXT PRIMARY KEY DEFAULT 'settings', "isEnabled" BOOLEAN NOT NULL DEFAULT true, "simulationSpeed" TEXT NOT NULL DEFAULT 'medium', "lastSimAt" TIMESTAMP(3), "autoGenerated" BOOLEAN NOT NULL DEFAULT false, "autoSimEnabled" BOOLEAN NOT NULL DEFAULT false, "autoSimIntervalSec" INTEGER NOT NULL DEFAULT 10)`,
  `CREATE TABLE IF NOT EXISTS "demo_avatars" ("id" TEXT PRIMARY KEY, "gender" TEXT NOT NULL, "url" TEXT NOT NULL, "storageKey" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];
const archives = async () => (await db.setting.findMany({ where: { id: { startsWith: CYCLE_ARCHIVE_PREFIX } } })).map((r) => r.id).sort();
const comp = () => db.demoCompetition.findUnique({ where: { id: "current" } });

try {
  for (const q of DDL) await db.$executeRawUnsafe(q);

  console.log("\n1. Setup through the real service");
  await svc.generateDemoAffiliates(12, "mixed");
  const ids = (await db.demoAffiliate.findMany()).map((a) => a.id).sort();
  const c1 = await comp();
  ok("12 profiles + a first 30-day cycle created", ids.length === 12 && c1.cycleNum === 1 && c1.endDate.getTime() === addCompetitionDays(c1.startDate.getTime(), 30));
  const histRows = await db.demoEarningsHistory.count();

  console.log("\n2. Concurrent automatic rollover (8 workers, separate pools)");
  const end = c1.endDate.getTime();
  const res = await Promise.all(workers.map((w) => svc.advanceCompetitionIfDue({ db: w, now: end + 1000 })));
  const c2 = await comp();
  ok("exactly one worker rolled the cycle", res.filter(Boolean).length === 1 && c2.cycleNum === 2);
  ok("one archive (#1), no duplicate", JSON.stringify(await archives()) === JSON.stringify([`${CYCLE_ARCHIVE_PREFIX}1`]));
  ok("cycle #2 starts exactly at cycle #1's end", c2.startDate.getTime() === end);
  ok("history rows kept, profile ids unchanged", (await db.demoEarningsHistory.count()) === histRows && JSON.stringify((await db.demoAffiliate.findMany()).map((a) => a.id).sort()) === JSON.stringify(ids));
  ok("scores zeroed", (await db.demoStats.findMany()).every((s) => s.totalOrders === 0 && s.rank === 0));

  console.log("\n3. Concurrent manual resets serialize");
  const resets = await Promise.all(workers.slice(0, 4).map((w) => svc.resetCompetition({ db: w, now: end + 2 * 86400000 })));
  ok("4 concurrent resets → cycles 3..6, each archiving a distinct previous cycle",
    JSON.stringify(resets.map((r) => r.cycle).sort()) === "[3,4,5,6]" && (await archives()).length === 5 && (await comp()).cycleNum === 6);

  console.log("\n4. Rollback on failure");
  const before = { c: await comp(), a: await archives() };
  await db.setting.create({ data: { id: `${CYCLE_ARCHIVE_PREFIX}6`, data: { planted: true } } }); // forces a unique violation
  const err = await svc.resetCompetition({ db: workers[5], now: end + 3 * 86400000 }).then(() => null, (e) => e);
  const after = await comp();
  ok("a failing rollover leaves the cycle untouched (transaction rolled back)", err && after.cycleNum === before.c.cycleNum && after.startDate.getTime() === before.c.startDate.getTime());
  await db.setting.delete({ where: { id: `${CYCLE_ARCHIVE_PREFIX}6` } });

  console.log("\n5. History deletion is separate");
  const cleared = await svc.clearCompetitionHistory({ db });
  ok("explicit deletion removes archives + demo history, keeps profiles and cycle",
    cleared.deletedCycles === 5 && (await db.demoEarningsHistory.count()) === 0 && (await db.demoAffiliate.count()) === 12 && (await comp()).cycleNum === 6);
} catch (e) {
  fail++; console.error("  ERROR", e);
} finally {
  await Promise.all(workers.map((w) => w.$disconnect().catch(() => {})));
  await shared.$disconnect().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
