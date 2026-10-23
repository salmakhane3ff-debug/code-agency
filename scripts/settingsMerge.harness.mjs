#!/usr/bin/env node
/**
 * scripts/settingsMerge.harness.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 0 settings integrity — REAL-PostgreSQL harness. Proves what the fake in
 * affiliateSettingsGoals.test.mjs cannot: the merge / counter SQL itself and
 * that concurrent writers on separate connections never lose an update.
 *
 * NOT part of the zero-dependency suite (*.harness.mjs, not *.test.mjs).
 *
 * ── SAFETY (it refuses to run unless ALL hold) ────────────────────────────────
 *   • SETTINGS_HARNESS_DATABASE_URL is set and differs from DATABASE_URL.
 *   • host is local (localhost / 127.0.0.1 / ::1 / unix socket).
 *   • the database name contains "harness", "scratch" or "test".
 *   • it only creates/uses a "settings" table in that throwaway database.
 * Exit 0 = all passed, 1 = a check failed, 2 = refused / not configured.
 *
 * Disposable server (see rewardsDb.harness.mjs for the same recipe):
 *   PGBIN=/usr/lib/postgresql/16/bin; D=$(mktemp -d)
 *   $PGBIN/initdb -D "$D/data" -U harness --auth=trust >/dev/null
 *   $PGBIN/pg_ctl -D "$D/data" -o "-k $D -p 55433 -c listen_addresses=''" -l "$D/log" start
 *   $PGBIN/createdb -h "$D" -p 55433 -U harness settings_harness
 *   SETTINGS_HARNESS_DATABASE_URL="postgresql://harness@localhost/settings_harness?host=$D&port=55433" \
 *     node scripts/settingsMerge.harness.mjs
 *   $PGBIN/pg_ctl -D "$D/data" stop && rm -rf "$D"
 * ─────────────────────────────────────────────────────────────────────────────
 */

const url = process.env.SETTINGS_HARNESS_DATABASE_URL;
const refuse = (m) => { console.error(`REFUSED: ${m}`); process.exit(2); };
if (!url) refuse("SETTINGS_HARNESS_DATABASE_URL is not set");
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) refuse("harness URL equals DATABASE_URL");
let parsed; try { parsed = new URL(url); } catch { refuse("unparseable URL"); }
const host = parsed.searchParams.get("host") || parsed.hostname;
if (!(["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) && (host.startsWith("/") || ["localhost", "127.0.0.1", "::1"].includes(host)))) refuse(`non-local host ${host}`);
if (!/harness|scratch|test/.test(parsed.pathname)) refuse("database name must contain harness/scratch/test");

// The modules under test use the shared client from src/lib/prisma.js; point it
// at the throwaway database for THIS process only (the original is never read).
process.env.DATABASE_URL = url;

const { PrismaClient } = await import("../src/generated/prisma/index.js");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { mergeSettings, incrementSettingsCounter } = await import("../src/lib/settingsMerge.js");
const { saveTeamBonusConfig, getTeamBonusConfig } = await import("../src/lib/services/affiliateSystemService.js");
const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");
const { saveAffiliateDashboardConfig, getAffiliateDashboardConfig } = await import("../src/lib/services/affiliateDashboardConfigService.js");
const shared = (await import("../src/lib/prisma.js")).default;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

// Wide pool so concurrent statements really run on separate connections.
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 12 }) });
const read = async (id) => (await db.setting.findUnique({ where: { id } }))?.data;
const post = (type, body) => upsertSettingsHandler(new Request(`http://h/api/setting?type=${type}`, { method: "POST", body: JSON.stringify(body) }));

try {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "settings" ("id" TEXT NOT NULL, "data" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "settings_pkey" PRIMARY KEY ("id"))`);
  await db.$executeRawUnsafe(`TRUNCATE "settings"`);

  console.log("\n1. mergeSettings SQL");
  const created = await mergeSettings("t1", { a: 1, _id: "x", updatedAt: "y" }, { db });
  ok("missing row created, meta keys stripped", JSON.stringify(created) === '{"a":1}' && JSON.stringify(await read("t1")) === '{"a":1}');
  const merged = await mergeSettings("t1", { b: { c: 2 }, arr: [1, 2] }, { db });
  ok("existing keys kept, new keys added", merged.a === 1 && merged.b.c === 2 && merged.arr.length === 2);
  await mergeSettings("t1", { arr: [9] }, { db });
  ok("sent key replaced as a whole", JSON.stringify((await read("t1")).arr) === "[9]");
  await db.$executeRawUnsafe(`INSERT INTO "settings" VALUES ('t2', '[1,2]'::jsonb, NOW())`);
  ok("non-object stored data → replaced by an object", JSON.stringify(await mergeSettings("t2", { k: true }, { db })) === '{"k":true}');
  const before = (await db.setting.findUnique({ where: { id: "t1" } })).updatedAt;
  await new Promise((r) => setTimeout(r, 15));
  await mergeSettings("t1", { z: 1 }, { db });
  ok("updatedAt bumped", (await db.setting.findUnique({ where: { id: "t1" } })).updatedAt > before);

  console.log("\n2. Concurrency (separate connections)");
  await Promise.all(Array.from({ length: 60 }, (_, i) => mergeSettings("conc", { [`k${i}`]: i }, { db })));
  const conc = await read("conc");
  ok("60 concurrent partial merges → all 60 keys kept", Object.keys(conc).length === 60 && conc.k59 === 59);
  await Promise.all(Array.from({ length: 100 }, (_, i) => incrementSettingsCounter("cnt", "stats", i % 2 ? "login" : "view", { db })));
  const cnt = await read("cnt");
  ok("100 concurrent increments → exact totals (50 + 50)", cnt.stats.login === 50 && cnt.stats.view === 50);
  await mergeSettings("rl", { enabled: true, hero: { title: "A" }, stats: { login: 3 } }, { db });
  await Promise.all([
    ...Array.from({ length: 30 }, () => incrementSettingsCounter("rl", "stats", "login", { db })),
    mergeSettings("rl", { hero: { title: "B" }, liveFeed: { enabled: true } }, { db }),
  ]);
  const rl = await read("rl");
  ok("admin merge racing 30 counter hits: config AND counters kept", rl.hero.title === "B" && rl.liveFeed.enabled === true && rl.stats.login === 33 && rl.enabled === true);
  await db.$executeRawUnsafe(`INSERT INTO "settings" VALUES ('bad', '{"stats":{"login":"x"},"keep":1}'::jsonb, NOW())`);
  await incrementSettingsCounter("bad", "stats", "login", { db });
  ok("non-numeric counter restarts at 1, other keys kept", (await read("bad")).stats.login === 1 && (await read("bad")).keep === 1);

  console.log("\n3. team-bonus-config");
  await db.setting.create({ data: { id: "team-bonus-config", data: { requiredActiveAffiliates: 10, bonusAmount: 2000, commissionTiers: [{ minDelivered: 0, maxDelivered: null, commissionPct: 5 }], ugcGoal: 3, securityDepositAmount: 750, other: "keep" } } });
  await saveTeamBonusConfig({ requiredActiveAffiliates: 4, bonusAmount: 1500, commissionTiers: [{ minDelivered: 0, maxDelivered: null, commissionPct: 6 }] }, { db });
  const tb = await read("team-bonus-config");
  ok("admin save keeps ugcGoal, securityDepositAmount, unknown keys", tb.requiredActiveAffiliates === 4 && tb.ugcGoal === 3 && tb.securityDepositAmount === 750 && tb.other === "keep");
  await saveTeamBonusConfig({ requiredActiveAffiliates: 4, bonusAmount: 1500, commissionTiers: tb.commissionTiers, ugcGoal: 0 }, { db });
  ok("ugcGoal 0 persisted and read back as 0 (hidden)", (await getTeamBonusConfig({ db })).ugcGoal === 0);

  console.log("\n4. /api/setting controller (shared client)");
  await shared.setting.create({ data: { id: "booster-packages", data: { enabled: true, allowStacking: true, packages: [{ id: "p1" }], simulation: { enabled: false }, extra: 1 } } });
  let res = await post("booster-packages", { packages: [{ id: "p2" }] });
  const bp = await read("booster-packages");
  ok("booster-packages partial POST merges (enabled/allowStacking/simulation/extra kept)", res.status === 200 && bp.enabled === true && bp.allowStacking === true && bp.simulation.enabled === false && bp.extra === 1 && bp.packages[0].id === "p2");
  res = await post("recruitment-landing", { hero: { title: "C" } });
  const rl2 = await read("recruitment-landing");
  ok("recruitment-landing POST merges (created when missing)", res.status === 200 && rl2.hero.title === "C");
  await shared.setting.create({ data: { id: "store", data: { name: "S", currencySymbol: "MAD" } } });
  await post("store", { name: "S2" });
  ok("other generic types keep the existing whole-row replace", JSON.stringify(await read("store")) === '{"name":"S2"}');
  for (const t of ["team-bonus-config", "affiliate-dashboard"]) {
    const before2 = JSON.stringify(await read(t));
    res = await post(t, { requiredActiveAffiliates: -1, depositBarEnabled: "x" });
    ok(`generic POST ${t} refused, row unchanged`, res.status === 400 && JSON.stringify(await read(t)) === before2);
  }

  console.log("\n5. affiliate-dashboard toggles");
  ok("defaults without a row", JSON.stringify(await getAffiliateDashboardConfig({ db })) === '{"depositBarEnabled":true,"boosterBarEnabled":true}');
  await Promise.all([
    saveAffiliateDashboardConfig({ depositBarEnabled: false }, { db }),
    saveAffiliateDashboardConfig({ boosterBarEnabled: false }, { db }),
  ]);
  ok("two concurrent independent toggle saves both persist", JSON.stringify(await getAffiliateDashboardConfig({ db })) === '{"depositBarEnabled":false,"boosterBarEnabled":false}');
} catch (e) {
  fail++; console.error("  ERROR", e);
} finally {
  await db.$disconnect().catch(() => {});
  await shared.$disconnect().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
