#!/usr/bin/env node
/**
 * scripts/liveActivity.harness.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 Live Activity — REAL-PostgreSQL harness. Proves what the fake in
 * liveActivity.test.mjs cannot: pg_try_advisory_xact_lock across separate
 * connections/clients (= separate workers), the interactive transaction, and
 * that a failed read leaves the stored row untouched.
 *
 * NOT part of the zero-dependency suite (*.harness.mjs, not *.test.mjs).
 *
 * ── SAFETY (it refuses to run unless ALL hold) ────────────────────────────────
 *   • LIVE_HARNESS_DATABASE_URL is set and differs from DATABASE_URL.
 *   • host is local (localhost / 127.0.0.1 / ::1 / unix socket).
 *   • the database name contains "harness", "scratch" or "test".
 *   • it only creates/uses a "settings" table in that throwaway database.
 * Exit 0 = all passed, 1 = a check failed, 2 = refused / not configured.
 *
 * Disposable server (same recipe as settingsMerge.harness.mjs):
 *   PGBIN=/usr/lib/postgresql/16/bin; D=$(mktemp -d)
 *   $PGBIN/initdb -D "$D/data" -U harness --auth=trust >/dev/null
 *   $PGBIN/pg_ctl -D "$D/data" -o "-k $D -p 55435 -c listen_addresses=''" -l "$D/log" start
 *   $PGBIN/createdb -h "$D" -p 55435 -U harness live_harness
 *   LIVE_HARNESS_DATABASE_URL="postgresql://harness@localhost/live_harness?host=$D&port=55435" \
 *     node scripts/liveActivity.harness.mjs
 *   $PGBIN/pg_ctl -D "$D/data" stop && rm -rf "$D"
 * ─────────────────────────────────────────────────────────────────────────────
 */

const url = process.env.LIVE_HARNESS_DATABASE_URL;
const refuse = (m) => { console.error(`REFUSED: ${m}`); process.exit(2); };
if (!url) refuse("LIVE_HARNESS_DATABASE_URL is not set");
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) refuse("harness URL equals DATABASE_URL");
let parsed; try { parsed = new URL(url); } catch { refuse("unparseable URL"); }
const host = parsed.searchParams.get("host") || parsed.hostname;
if (!(["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) && (host.startsWith("/") || ["localhost", "127.0.0.1", "::1"].includes(host)))) refuse(`non-local host ${host}`);
if (!/harness|scratch|test/.test(parsed.pathname)) refuse("database name must contain harness/scratch/test");

// The engine imports the shared client; point it at the throwaway DB for THIS
// process only (the original value is never read).
process.env.DATABASE_URL = url;

const { PrismaClient } = await import("../src/generated/prisma/index.js");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { advanceLiveActivity, STATE_KEY } = await import("../src/lib/services/liveActivityEngine.js");
const { normalizeLiveActivity } = await import("../src/lib/recruitmentCta.js");
const shared = (await import("../src/lib/prisma.js")).default;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

// 8 independent clients = 8 "workers" with their own pools.
const workers = Array.from({ length: 8 }, () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }) }));
const db = workers[0];
const POOL = [{ id: "p1", name: "A", username: "a", avatarUrl: null, avatarColor: "#111" }];
const cfg = normalizeLiveActivity({ intervalMinSec: 2, intervalMaxSec: 6 });
const AVG = 4000;
const NOW = Date.UTC(2026, 5, 15, 11, 0); // 12:00 Casablanca
const read = async () => (await db.setting.findUnique({ where: { id: STATE_KEY } }))?.data;

try {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "settings" ("id" TEXT NOT NULL, "data" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "settings_pkey" PRIMARY KEY ("id"))`);
  await db.$executeRawUnsafe(`TRUNCATE "settings"`);

  console.log("\n1. Advisory lock across workers");
  const [{ locked }] = await db.$transaction((tx) => tx.$queryRaw`SELECT pg_try_advisory_xact_lock(1::int, 2::int) AS locked`);
  ok("pg_try_advisory_xact_lock returns a real boolean through Prisma", locked === true);

  const runs = await Promise.all(workers.map((w, i) => advanceLiveActivity({ db: w, cfg, pool: POOL, commissionPerSale: 4, now: NOW, rnd: () => (i + 1) / 10 })));
  const st = await read();
  ok("8 concurrent workers on a fresh DB → at most one generates", runs.filter((r) => r.generated).length === 1);
  ok("stored feed = exactly one bootstrap (15 unique events)", st.events.length === 15 && new Set(st.events.map((e) => e.id)).size === 15);

  for (let round = 1; round <= 5; round++) {
    await Promise.all(workers.map((w) => advanceLiveActivity({ db: w, cfg, pool: POOL, commissionPerSale: 4, now: NOW + round * 2 * AVG, rnd: Math.random })));
  }
  const st2 = await read();
  ok("5 rounds × 8 overlapping workers, 2 ticks per round → exactly 10 new events (no duplicates)",
    st2.events.length === 25 && new Set(st2.events.map((e) => e.id)).size === 25);
  ok("tick grid advanced exactly 10 ticks", st2.lastTickAt === NOW + 10 * AVG);
  const ats = st2.events.map((e) => e.at);
  ok("every catch-up timestamp is its own tick slot (no two events share one)", new Set(ats.slice(0, 10)).size === 10);

  console.log("\n2. A held lock means: serve, never generate");
  let release;
  // pg_advisory_xact_lock returns void → $executeRaw (not $queryRaw).
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x4c495645}::int, ${1}::int)`;
    await new Promise((r) => { release = r; });
  }, { timeout: 20000 }).catch((e) => { fail++; console.error("  ERROR holder", e.message); });
  await new Promise((r) => setTimeout(r, 200));
  const blocked = await advanceLiveActivity({ db: workers[1], cfg, pool: POOL, commissionPerSale: 4, now: NOW + 20 * AVG, rnd: Math.random });
  ok("while another worker holds the lock → no generation, stored state served", blocked.generated === false && blocked.state?.events.length === 25);
  release(); await holder;
  ok("…and nothing was written meanwhile", (await read()).events.length === 25);

  console.log("\n3. Read failure writes nothing");
  const before = JSON.stringify(await read());
  const broken = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });
  const failing = new Proxy(broken, { get(t, k) {
    if (k !== "$transaction") return t[k];
    return (fn, o) => t.$transaction((tx) => fn(new Proxy(tx, { get(tt, kk) {
      if (kk !== "setting") return tt[kk];
      return { ...tt.setting, findUnique: async () => { throw new Error("simulated read failure"); }, upsert: tt.setting.upsert.bind(tt.setting) };
    } })), o);
  } });
  const err = await advanceLiveActivity({ db: failing, cfg, pool: POOL, commissionPerSale: 4, now: NOW + 40 * AVG, rnd: Math.random }).then(() => null, (e) => e);
  ok("advance with a failing read rejects", err?.message === "simulated read failure");
  ok("stored row byte-identical afterwards", JSON.stringify(await read()) === before);
  await broken.$disconnect();
} catch (e) {
  fail++; console.error("  ERROR", e);
} finally {
  await Promise.all(workers.map((w) => w.$disconnect().catch(() => {})));
  await shared.$disconnect().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
