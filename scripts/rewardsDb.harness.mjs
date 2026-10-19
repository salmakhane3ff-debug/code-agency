#!/usr/bin/env node
/**
 * scripts/rewardsDb.harness.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewards & Gifts — REAL-PostgreSQL harness (Phase 6). Proves what the in-memory
 * fake cannot: Postgres row/table locks, isolation, CHECK constraints, the
 * append-only triggers and real Prisma/adapter error shapes.
 *
 * Schema setup: the repo's migration chain cannot build a fresh database
 * (pre-existing: 24 schema tables, e.g. affiliate_orders and gifts, are created
 * by no migration — production was partly built with `prisma db push` — and
 * "20260316214921_phase1…" sorts before "20260316_init"). Both are probed and
 * reported as INFO. The baseline is therefore Prisma's from-empty SQL for the
 * schema WITHOUT the Reward* models (generated offline), i.e. an existing
 * database before rewards; the rewards migration is applied on top, twice, and
 * compared with Prisma's own SQL for the full schema on real Postgres.
 *
 * NOT part of the zero-dependency suite (*.harness.mjs, not *.test.mjs).
 *
 * ── SAFETY (it refuses to run unless ALL hold) ────────────────────────────────
 *   • REWARDS_HARNESS_DATABASE_URL is set. DATABASE_URL is NEVER read, and the
 *     harness refuses if the two are equal.
 *   • host is local: localhost / 127.0.0.1 / ::1 / a unix-socket path.
 *   • the database name contains "harness", "scratch" or "test".
 *   • everything happens inside a fresh schema rewards_harness_<pid>_<time>,
 *     dropped at the end (REWARDS_HARNESS_KEEP=1 keeps it for inspection).
 * Exit 0 = all passed, 1 = a check failed, 2 = refused / not configured.
 *
 * ── DISPOSABLE SERVER (run only with approval) ────────────────────────────────
 * Postgres 16 binaries exist in this container; a throwaway cluster that never
 * touches any other server (unix socket + private port, data in a temp dir):
 *
 *   PGBIN=/usr/lib/postgresql/16/bin; D=$(mktemp -d)
 *   $PGBIN/initdb -D "$D/data" -U harness --auth=trust >/dev/null
 *   $PGBIN/pg_ctl -D "$D/data" -o "-k $D -p 55432 -c listen_addresses=''" -l "$D/log" start
 *   $PGBIN/createdb -h "$D" -p 55432 -U harness rewards_harness
 *   REWARDS_HARNESS_DATABASE_URL="postgresql://harness@localhost/rewards_harness?host=$D&port=55432" \
 *     node scripts/rewardsDb.harness.mjs
 *   $PGBIN/pg_ctl -D "$D/data" stop && rm -rf "$D"
 *
 * (Lock-timeout scenario waits ~15 s by design — BASELINE_LOCK_TIMEOUT.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const URL_ENV = 'REWARDS_HARNESS_DATABASE_URL';

// ── Guard ─────────────────────────────────────────────────────────────────────
export function checkHarnessTarget(env = process.env) {
  const raw = env[URL_ENV];
  if (!raw) return { ok: false, reason: `${URL_ENV} is not set` };
  if (env.DATABASE_URL && raw.trim() === env.DATABASE_URL.trim()) {
    return { ok: false, reason: `${URL_ENV} must not equal DATABASE_URL` };
  }
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: `${URL_ENV} is not a valid URL` }; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { ok: false, reason: 'not a postgres:// URL' };
  const socketHost = u.searchParams.get('host');
  const host = (socketHost || u.hostname || '').replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host) || host.startsWith('/');
  if (!local) return { ok: false, reason: `host "${host}" is not local` };
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/(harness|scratch|test)/i.test(dbName)) {
    return { ok: false, reason: `database "${dbName}" must contain "harness", "scratch" or "test"` };
  }
  return { ok: true, url: raw, dbName };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();

async function main() {
  const target = checkHarnessTarget();
  if (!target.ok) {
    console.error(`[harness] refused: ${target.reason}. See the header for a disposable setup.`);
    process.exit(2);
  }
  // Belt and braces: the app's default Prisma client (src/lib/prisma.js) is
  // imported transitively; make sure it can never point at a real database.
  delete process.env.DATABASE_URL;

  const { default: pg } = await import('pg');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('../src/generated/prisma/index.js');
  const rewards = await import('../src/lib/services/rewardsService.js');
  const redeem = await import('../src/lib/services/rewardRedemptionService.js');
  const { deleteAffiliateSafely, AFFILIATE_HAS_HISTORY } = await import('../src/lib/affiliateDeletion.js');
  // Phase 2–4 layers driven end-to-end (handlers + hooks + auth), on real Postgres.
  process.env.JWT_SECRET ||= 'harness-only-secret';           // signs local test tokens only
  const { adminRewardsHandlers, affiliateRewardsHandlers } = await import('../src/lib/rewardsRouteHandlers.js');
  const { withAffiliateAuth } = await import('../src/lib/middleware/withAffiliateAuth.js');
  const { signToken } = await import('../src/lib/services/authService.js');
  const affSvc = await import('../src/lib/services/affiliateSystemService.js');

  const schema = `rewards_harness_${process.pid}_${Date.now()}`;
  const options = `-c search_path=${schema}`;
  const admin = new pg.Client({ connectionString: target.url });
  await admin.connect();
  // Every schema created is registered here and dropped in `finally`, so an
  // aborted run cannot leave anything behind.
  const created = [];
  const createSchema = async (name) => { created.push(name); await admin.query(`CREATE SCHEMA "${name}"`); };
  await createSchema(schema);
  const sqlClient = () => new pg.Client({ connectionString: target.url, options });
  // `schema` makes Prisma qualify its table names; search_path covers raw SQL
  // (LOCK TABLE "affiliate_orders", the migration files) on the same schema.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.url, options }, { schema }) });

  let pass = 0, fail = 0;
  const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
  const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let reqSeq = 0; const rid = () => `req-${String(++reqSeq).padStart(8, '0')}`;
  const recipient = { fullName: 'Harness Test', phone: '+212612345678', city: 'Casablanca', address: '12 rue des Tests' };

  try {
    // ── 1. Migration chain on a clean schema, then the rewards migration again ──
    console.log(`\n1. Migrations (schema ${schema})`);
    const dir = new URL('../prisma/migrations/', import.meta.url).pathname;
    const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

    // 1a. PRE-EXISTING ordering check (informational, not a rewards result):
    // Prisma applies folders in byte order, where "20260316214921_phase1…"
    // sorts BEFORE "20260316_init" ('2' < '_') although it depends on it.
    // Probed in its own throwaway schema; each file is one implicit
    // transaction, so a failing file leaves nothing behind.
    const probeSchema = `${schema}_prisma_order`;
    await createSchema(probeSchema);
    const probe = new pg.Client({ connectionString: target.url, options: `-c search_path=${probeSchema}` });
    await probe.connect();
    let probeFailure = null;
    for (const m of [...names].sort()) {
      const e = await caught(() => probe.query(readFileSync(join(dir, m, 'migration.sql'), 'utf8')));
      if (e) { probeFailure = `${m}: ${e.message}`; break; }
    }
    await probe.end();
    await admin.query(`DROP SCHEMA "${probeSchema}" CASCADE`);
    console.log(probeFailure
      ? `  INFO  pre-existing: Prisma byte-order chain fails on a FRESH database at ${probeFailure}`
      : '  INFO  Prisma byte-order chain applies on a fresh database');

    // 1b. PRE-EXISTING completeness check (informational): chronological order.
    // Several tables (affiliate_orders, gifts, …) are created by NO migration —
    // production was partly built with `prisma db push` — so the chain alone
    // cannot build a fresh database. Probed in its own throwaway schema.
    const chrono = (n) => n.replace(/^(\d{8})_/, '$1000000_');
    const ordered = [...names].sort((x, y) => (chrono(x) < chrono(y) ? -1 : chrono(x) > chrono(y) ? 1 : 0));
    const chronoSchema = `${schema}_chrono`;
    await createSchema(chronoSchema);
    const chronoClient = new pg.Client({ connectionString: target.url, options: `-c search_path=${chronoSchema}` });
    await chronoClient.connect();
    let applied = 0; let chronoFailure = null;
    for (const m of ordered) {
      const e = await caught(() => chronoClient.query(readFileSync(join(dir, m, 'migration.sql'), 'utf8')));
      if (e) { chronoFailure = `${m}: ${e.message}`; break; }
      applied++;
    }
    await chronoClient.end();
    await admin.query(`DROP SCHEMA "${chronoSchema}" CASCADE`);
    console.log(chronoFailure
      ? `  INFO  pre-existing: chronological chain applies ${applied}/${ordered.length}, then fails at ${chronoFailure}`
      : `  INFO  chronological chain applies ${applied}/${ordered.length}`);

    // 1c. Baseline = what an existing (db-push-built) database holds before
    // rewards: Prisma's from-empty SQL for the schema WITHOUT the Reward*
    // models, generated OFFLINE (migrate diff never connects).
    const schemaText = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const preRewards = schemaText
      .replace(/(\/\/\/[^\n]*\n)*model Reward\w+ \{[\s\S]*?\n\}\n?/g, '')
      .split('\n').filter((l) => !/^\s+reward\w+\s+Reward\w+/.test(l)).join('\n');
    const baselineSql = prismaFromEmpty(preRewards);
    const runner = sqlClient(); await runner.connect();
    const base = await caught(() => runner.query(baselineSql));
    ok('baseline (pre-rewards schema, Prisma from-empty SQL) applies', !base, base?.message);
    if (base) throw new Error('baseline failed');
    const countTables = async (like) => (await runner.query(
      `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE $2`, [schema, like])).rows[0].n;
    ok('baseline has affiliate_orders and no reward_* tables',
      (await countTables('affiliate_orders')) === 1 && (await countTables('reward\\_%')) === 0);

    // 1d. The rewards migration on top, then again (idempotent).
    const rewardsSql = readFileSync(join(dir, '20261019_affiliate_rewards', 'migration.sql'), 'utf8');
    const first = await caught(() => runner.query(rewardsSql));
    ok('rewards migration applies on the existing schema', !first, first?.message);
    if (first) throw new Error('rewards migration failed');
    ok('…creates the 7 reward_* tables', (await countTables('reward\\_%')) === 7);
    const again = await caught(() => runner.query(rewardsSql));
    ok('rewards migration is idempotent (second run succeeds)', !again, again?.message);

    // 1e. Drift: migration result vs Prisma's own SQL for the full schema.
    const targetSchema = `${schema}_target`;
    await createSchema(targetSchema);
    const tgt = new pg.Client({ connectionString: target.url, options: `-c search_path=${targetSchema}` });
    await tgt.connect();
    await tgt.query(prismaFromEmpty(schemaText));
    const [mine, theirs] = await Promise.all([describeRewards(runner, schema), describeRewards(tgt, targetSchema)]);
    await tgt.end();
    await admin.query(`DROP SCHEMA "${targetSchema}" CASCADE`);
    for (const k of ['columns', 'indexes', 'foreignKeys', 'uniques']) {
      const missing = theirs[k].filter((x) => !mine[k].includes(x));
      const extra = mine[k].filter((x) => !theirs[k].includes(x));
      ok(`real-PG drift check: ${k} identical (${mine[k].length})`, !missing.length && !extra.length,
        JSON.stringify({ missing, extra }).slice(0, 600));
    }
    ok('only additions vs Prisma: 5 CHECK constraints', mine.checks.length === 5 && theirs.checks.length === 0, JSON.stringify(mine.checks));
    ok('only additions vs Prisma: 2 append-only triggers', mine.triggers.length === 2 && theirs.triggers.length === 0, JSON.stringify(mine.triggers));
    const { rows: ver } = await runner.query('SHOW server_version');
    console.log(`     server_version ${ver[0].server_version}`);

    // ── 2. Constraints & append-only triggers ──────────────────────────────────
    console.log('\n2. Constraints & triggers');
    const aff = (id, extra = {}) => prisma.affiliate.create({ data: { id, username: id.toLowerCase(), isActive: true, ...extra } });
    await aff('A'); await aff('B'); await aff('C'); await aff('FREE'); await aff('ORDERS');
    const badStock = await caught(() => runner.query(`INSERT INTO reward_gifts (id,name,"pointsCost",stock,"updatedAt") VALUES ('x','x',1,-1,now())`));
    ok('CHECK rejects negative stock (23514)', badStock?.code === '23514');
    const badDelta = await caught(() => runner.query(`INSERT INTO reward_points_ledger (id,"affiliateId",delta,type,"sourceType","idempotencyKey","balanceAfter") VALUES ('l0','A',0,'SIGNUP_BONUS','affiliate','k0',0)`));
    ok('CHECK rejects delta = 0', badDelta?.code === '23514');
    await runner.query(`INSERT INTO reward_points_accounts ("affiliateId",balance,"updatedAt") VALUES ('C',5,now())`);
    await runner.query(`INSERT INTO reward_points_ledger (id,"affiliateId",delta,type,"sourceType","idempotencyKey","balanceAfter") VALUES ('l1','C',5,'ADMIN_ADJUSTMENT','admin','k1',5)`);
    const upd = await caught(() => runner.query(`UPDATE reward_points_ledger SET delta = 6 WHERE id = 'l1'`));
    const del = await caught(() => runner.query(`DELETE FROM reward_points_ledger WHERE id = 'l1'`));
    ok('ledger UPDATE rejected (append-only)', /append-only/.test(upd?.message || ''));
    ok('ledger DELETE rejected (append-only)', /append-only/.test(del?.message || ''));

    // ── 3. Config + baseline under real locks ──────────────────────────────────
    console.log('\n3. Launch baseline locking');
    const order = (id, affiliateId) => prisma.order.create({ data: { id, customerName: 'c', shippingAddress: {}, affiliateId } });
    await order('o1', 'A'); await order('o2', 'A'); await order('o3', 'A'); await order('oB', 'B');
    const ao = (id, affiliateId, orderId, status = 'pending') => prisma.affiliateOrder.create({ data: { id, affiliateId, orderId, status } });
    await ao('ao-pre', 'A', null, 'delivered'); await ao('ao1', 'A', 'o1'); await ao('ao2', 'A', 'o2'); await ao('ao3', 'A', 'o3'); await ao('aoB', 'B', 'oB');
    await ao('ao-orders', 'ORDERS', null);

    // 3a. Lock timeout: an open writer holds affiliate_orders past lock_timeout.
    const blocker = sqlClient(); await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query(`UPDATE affiliate_orders SET status = 'confirmed' WHERE id = 'ao3'`);
    const t0 = Date.now();
    const timeout = await caught(() => rewards.saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db: prisma, actorId: 'harness' }));
    ok('enable behind a long writer → BASELINE_LOCK_TIMEOUT (real 55P03 mapped)', timeout?.code === 'BASELINE_LOCK_TIMEOUT', `${timeout?.code} ${timeout?.message}`);
    ok('…after ~15 s', Date.now() - t0 >= 14_000);
    ok('…config unchanged, nothing excluded', !(await rewards.getRewardsConfig(prisma)).enabled && (await prisma.rewardOrderAward.count()) === 0);
    await blocker.query('ROLLBACK');

    // 3b. A writer committed just before the lock is excluded; enable waits for it.
    await blocker.query('BEGIN');
    await blocker.query(`UPDATE affiliate_orders SET status = 'delivered' WHERE id = 'ao1'`);
    let enabled = false;
    const enabling = rewards.saveRewardsConfig({ enabled: true, pointsPerDeliveredOrder: 10 }, { db: prisma, actorId: 'harness' })
      .then((r) => { enabled = true; return r; });
    await sleep(700);
    ok('enable waits while a writer holds affiliate_orders', !enabled);
    await blocker.query('COMMIT');
    const res = await enabling;
    ok('…then runs; the just-committed delivery is EXCLUDED', res.baselineExcluded === 2
      && (await prisma.rewardOrderAward.findUnique({ where: { affiliateOrderId: 'ao1' } }))?.state === 'EXCLUDED');

    // 3c. A writer arriving DURING the baseline waits until rewards are ON.
    await rewards.saveRewardsConfig({ enabled: false }, { db: prisma });
    let releaseBaseline; const baselineReached = new Promise((r) => { releaseBaseline = r; });
    let resumeBaseline; const resume = new Promise((r) => { resumeBaseline = r; });
    const pausing = pauseAfterBaselineRead(prisma, async () => { releaseBaseline(); await resume; });
    const reenable = rewards.saveRewardsConfig({ enabled: true }, { db: pausing, actorId: 'harness' });
    await baselineReached;
    let writerDone = false;
    const writer = (async () => {
      const w = sqlClient(); await w.connect();
      await w.query(`UPDATE affiliate_orders SET status = 'delivered' WHERE id = 'ao2'`);
      writerDone = true; await w.end();
    })();
    await sleep(700);
    ok('writer during the baseline is blocked (SHARE lock)', !writerDone);
    resumeBaseline(); await reenable; await writer;
    ok('…lands after the switch, not excluded', !(await prisma.rewardOrderAward.findUnique({ where: { affiliateOrderId: 'ao2' } })));
    ok('…and earns as a post-launch delivery', (await rewards.syncOrderRewards('ao2', { db: prisma })).action === 'awarded');
    await blocker.end();

    // ── 4. Concurrency with real row locks ─────────────────────────────────────
    console.log('\n4. Concurrency');
    await prisma.affiliateOrder.update({ where: { id: 'aoB' }, data: { status: 'delivered' } });
    const syncs = await Promise.all(Array.from({ length: 20 }, () => rewards.syncOrderRewards('aoB', { db: prisma })));
    ok('20 concurrent syncs → exactly one award', syncs.filter((s) => s.action === 'awarded').length === 1
      && (await prisma.rewardPointsLedger.count({ where: { sourceId: 'aoB' } })) === 1);
    // Delivery award in flight, cancellation commits before it: the cancel hook
    // must wait on the account lock, then see the award and reverse it.
    await prisma.order.create({ data: { id: 'oR', customerName: 'c', shippingAddress: {}, affiliateId: 'B' } });
    await prisma.affiliateOrder.create({ data: { id: 'aoR', affiliateId: 'B', orderId: 'oR', status: 'delivered' } });
    let releaseAward; const awardGate = new Promise((r) => { releaseAward = r; });
    let awardReached; const awardPaused = new Promise((r) => { awardReached = r; });
    const pausingAward = pauseBeforeTxCall(prisma, 'rewardPointsLedger', 'create', async () => { awardReached(); await awardGate; });
    const inFlight = rewards.syncOrderRewards('aoR', { db: pausingAward });
    await awardPaused;                                                   // award row written, NOT committed
    await prisma.affiliateOrder.update({ where: { id: 'aoR' }, data: { status: 'cancelled' } });
    let cancelSynced = false;
    const cancelHook = rewards.syncOrderRewards('aoR', { db: prisma }).then((r) => { cancelSynced = true; return r; });
    await sleep(700);
    ok('cancel hook waits on the account lock while the award is in flight', !cancelSynced);
    releaseAward();
    const [inFlightRes, cancelRes] = await Promise.all([inFlight, cancelHook]);
    ok('…award commits, then the cancel reverses it', inFlightRes.action === 'awarded' && cancelRes.action === 'reversed');
    ok('…no active award left for the cancelled order',
      (await prisma.rewardOrderAward.findUnique({ where: { affiliateOrderId: 'aoR' } })).state === 'REVERSED'
      && (await prisma.rewardPointsLedger.aggregate({ where: { sourceId: 'aoR' }, _sum: { delta: true } }))._sum.delta === 0);

    // Circular reconcile on real Postgres: cursor persisted, every missed award reached.
    for (const i of [1, 2, 3]) {
      await prisma.order.create({ data: { id: `oC${i}`, customerName: 'c', shippingAddress: {}, affiliateId: 'B' } });
      await prisma.affiliateOrder.create({ data: { id: `aoC${i}`, affiliateId: 'B', orderId: `oC${i}`, status: 'delivered' } }); // hooks missed
    }
    let recRuns = 0, sawCursor = false;
    for (; recRuns < 20; recRuns++) {
      const r = await rewards.reconcileOrderRewards({ db: prisma, maxPerRun: 1 });
      const st = (await prisma.setting.findUnique({ where: { id: 'rewards-reconcile-state' } }))?.data;
      if (st?.orders?.id) sawCursor = true;
      if (!r.truncated) break;
    }
    ok('capped reconcile (1 per run) resumes from its stored cursor until complete', sawCursor && recRuns < 20);
    ok('…all three missed awards applied exactly once', (await prisma.rewardPointsLedger.count({ where: { sourceId: { in: ['aoC1', 'aoC2', 'aoC3'] } } })) === 3);

    // One reconcile at a time: advisory lock, released on COMMIT / ROLLBACK / error.
    const cursorNow = async () => JSON.stringify((await prisma.setting.findUnique({ where: { id: 'rewards-reconcile-state' } }))?.data ?? null);
    const holder = sqlClient(); await holder.connect();
    await holder.query('BEGIN');
    const held = (await holder.query('SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS locked', [0x52574453, 1])).rows[0].locked;
    const before = await cursorNow();
    const busyErr = await caught(() => rewards.reconcileOrderRewards({ db: prisma }));
    ok('lock held by another session → RECONCILE_IN_PROGRESS, cursor untouched',
      held === true && busyErr?.code === 'RECONCILE_IN_PROGRESS' && (await cursorNow()) === before);
    await holder.query('COMMIT');
    ok('…released on COMMIT: reconcile runs', !(await caught(() => rewards.reconcileOrderRewards({ db: prisma }))));
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [0x52574453, 1]);
    await holder.query('ROLLBACK');
    ok('…released on ROLLBACK: reconcile runs', !(await caught(() => rewards.reconcileOrderRewards({ db: prisma }))));
    await holder.end();

    let releaseFirst; const firstGate = new Promise((r) => { releaseFirst = r; });
    let firstReached; const firstPaused = new Promise((r) => { firstReached = r; });
    const slowDb = pauseTopLevelCall(prisma, 'rewardOrderAward', 'findMany', async () => { firstReached(); await firstGate; });
    const firstRun = rewards.reconcileOrderRewards({ db: slowDb });
    await firstPaused;                                                 // run 1 holds the lock, mid-scan
    const cursorDuring = await cursorNow();
    const secondErr = await caught(() => rewards.reconcileOrderRewards({ db: prisma }));
    ok('two concurrent reconciles → the 2nd gets RECONCILE_IN_PROGRESS and changes no cursor',
      secondErr?.code === 'RECONCILE_IN_PROGRESS' && (await cursorNow()) === cursorDuring);
    releaseFirst();
    const firstRes = await firstRun;
    ok('…the 1st completes normally', firstRes && typeof firstRes.truncated === 'boolean');

    const failingDb = pauseTopLevelCall(prisma, 'rewardOrderAward', 'findMany', async () => { throw new Error('harness: scan failed'); });
    ok('a failing run rejects with its error', (await caught(() => rewards.reconcileOrderRewards({ db: failingDb })))?.message === 'harness: scan failed');
    ok('…and the lock is released (next run proceeds)', !(await caught(() => rewards.reconcileOrderRewards({ db: prisma }))));
    await prisma.rewardGift.create({ data: { id: 'g', name: 'Casque', pointsCost: 30, stock: 50, isActive: true } });
    await prisma.rewardGift.create({ data: { id: 'g-last', name: 'Montre', pointsCost: 1, stock: 2, isActive: true } });
    await rewards.saveRewardsConfig({ maxOpenRedemptions: 50 }, { db: prisma });
    for (const a of ['A', 'B', 'C']) await rewards.adjustPoints({ affiliateId: a, delta: 100, reason: 'Harness seed', clientRequestId: rid(), actorId: 'harness' }, { db: prisma });
    const balA = (await rewards.getPointsSummary('A', { db: prisma })).balance;
    const many = await Promise.allSettled(Array.from({ length: 20 }, () =>
      redeem.requestRedemption({ affiliateId: 'A', giftId: 'g', recipient, clientRequestId: rid() }, { db: prisma })));
    const wins = many.filter((r) => r.status === 'fulfilled').length;
    ok(`20 concurrent requests → exactly floor(${balA}/30) succeed`, wins === Math.floor(balA / 30), `wins=${wins}`);
    ok('…balance never negative', (await rewards.getPointsSummary('A', { db: prisma })).balance >= 0);
    const race = await Promise.allSettled(['A', 'B', 'C'].map((a) =>
      redeem.requestRedemption({ affiliateId: a, giftId: 'g-last', recipient, clientRequestId: rid() }, { db: prisma })));
    ok('3 affiliates, 2 units → exactly 2 succeed, stock 0',
      race.filter((r) => r.status === 'fulfilled').length === 2 && (await prisma.rewardGift.findUnique({ where: { id: 'g-last' } })).stock === 0);
    const poorStock = (await prisma.rewardGift.findUnique({ where: { id: 'g' } })).stock;
    await caught(() => redeem.requestRedemption({ affiliateId: 'C', giftId: 'g', recipient, clientRequestId: rid() }, { db: prisma }));
    await caught(() => redeem.requestRedemption({ affiliateId: 'C', giftId: 'g', recipient, clientRequestId: rid() }, { db: prisma }));
    await caught(() => redeem.requestRedemption({ affiliateId: 'C', giftId: 'g', recipient, clientRequestId: rid() }, { db: prisma }));
    const short = await caught(() => redeem.requestRedemption({ affiliateId: 'C', giftId: 'g', recipient, clientRequestId: rid() }, { db: prisma }));
    ok('insufficient points → rolled back, stock consistent', short?.code === 'INSUFFICIENT_POINTS'
      && (await prisma.rewardGift.findUnique({ where: { id: 'g' } })).stock === poorStock - 3);
    for (const a of ['A', 'B', 'C']) ok(`ledger sum == balance (${a})`, (await rewards.verifyAccountBalance(a, { db: prisma })).ok);
    const hUpd = await caught(() => runner.query(`UPDATE reward_redemption_history SET note = 'x'`));
    const hDel = await caught(() => runner.query(`DELETE FROM reward_redemption_history`));
    ok('redemption history UPDATE/DELETE rejected (append-only)',
      /append-only/.test(hUpd?.message || '') && /append-only/.test(hDel?.message || '')
      && (await prisma.rewardRedemptionHistory.count()) > 0);

    // ── 5. Deletion against real FK errors ─────────────────────────────────────
    console.log('\n5. Affiliate deletion');
    ok('history (ledger) → AFFILIATE_HAS_HISTORY', (await caught(() => deleteAffiliateSafely(prisma, 'A')))?.code === AFFILIATE_HAS_HISTORY);
    const silence = console.error; console.error = () => {};
    const fk = await caught(() => deleteAffiliateSafely(prisma, 'ORDERS'));
    console.error = silence;
    ok('orders reference → real FK error mapped to AFFILIATE_HAS_HISTORY', fk?.code === AFFILIATE_HAS_HISTORY, fk?.message);
    await prisma.rewardPointsAccount.create({ data: { affiliateId: 'FREE' } });
    ok('empty points account does not block deletion', (await deleteAffiliateSafely(prisma, 'FREE')) === true);

    // ── 6. End-to-end lifecycle through the real handlers (Phases 2–4) ──────
    console.log('\n6. End-to-end lifecycle (admin + affiliate APIs, hooks, auth)');
    const ADMIN = { userId: 'harness-admin', role: 'ADMIN' };
    const A = adminRewardsHandlers({ db: prisma });
    const F = affiliateRewardsHandlers({ db: prisma, rateLimit: () => null });
    const reqOf = (method, body) => new Request('http://harness/x', {
      method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const run = async (fn, { method = 'GET', body, params = {}, user = ADMIN } = {}) => {
      const res = await fn(reqOf(method, body), { params: Promise.resolve(params) }, user);
      return { status: res.status, body: await res.json() };
    };
    const as = (affiliateId) => ({ affiliateId, type: 'affiliate' });
    const shipTo = { fullName: 'Harness Client', phone: '+212612345678', city: 'Rabat', address: '1 avenue des Tests' };

    // Settings through the admin API: points per order + signup bonus.
    const st = await run(A.putSettings, { method: 'PUT', body: { pointsPerDeliveredOrder: 50, signupBonusEnabled: true, signupBonusPoints: 20, maxOpenRedemptions: 10 } });
    ok('admin PUT settings (real PG)', st.status === 200 && st.body.config.signupBonusEnabled === true);

    // New affiliate → first admin activation → signup bonus (Phase 3 hook).
    await prisma.affiliate.create({ data: { id: 'E2E', username: 'e2e', isActive: false } });
    await affSvc.adminUpdateAffiliate('E2E', { isActive: true }, { db: prisma });
    ok('first activation pays the signup bonus once', (await rewards.getPointsSummary('E2E', { db: prisma })).balance === 20);
    await affSvc.adminUpdateAffiliate('E2E', { isActive: false }, { db: prisma });
    await affSvc.adminUpdateAffiliate('E2E', { isActive: true }, { db: prisma });
    ok('…reactivation pays nothing more', (await rewards.getPointsSummary('E2E', { db: prisma })).balance === 20);

    // Order delivered via the real admin status flow → points (hook, post-commit).
    await prisma.order.create({ data: { id: 'oE', customerName: 'c', shippingAddress: {}, affiliateId: 'E2E' } });
    await prisma.affiliateOrder.create({ data: { id: 'aoE', affiliateId: 'E2E', orderId: 'oE', status: 'pending', total: 300, commissionAmount: 150 } });
    const commissionBefore = await affSvc.getReferralCommissionComponent('E2E', prisma);
    await affSvc.adminUpdateAffiliateOrderStatus('aoE', 'delivered', { db: prisma });
    await affSvc.adminUpdateAffiliateOrderStatus('aoE', 'delivered', { db: prisma });
    ok('delivered (saved twice) → +50 once', (await rewards.getPointsSummary('E2E', { db: prisma })).balance === 70
      && (await prisma.rewardPointsLedger.count({ where: { sourceId: 'aoE' } })) === 1);
    ok('commission moves exactly as before (+150 MAD), unaffected by points',
      (await affSvc.getReferralCommissionComponent('E2E', prisma)) - commissionBefore === 150
      && (await prisma.affiliateOrder.findUnique({ where: { id: 'aoE' } })).commissionAmount === 150);

    // Catalog via the admin API (audit JSON with Dates on real PG) + carrier.
    const gift = await run(A.createGift, { method: 'POST', body: { name: 'Écouteurs E2E', pointsCost: 20, stock: 3, isActive: true, images: ['/uploads/e2e.webp'] } });
    ok('admin creates a gift (201) and it is audited', gift.status === 201
      && (await prisma.rewardAuditLog.count({ where: { action: 'GIFT_CREATE', entityId: gift.body.id } })) === 1);
    const giftId = gift.body.id;
    const stockOf = async () => (await prisma.rewardGift.findUnique({ where: { id: giftId } })).stock;
    await prisma.shippingCompany.create({ data: { id: 'sc-e2e', name: 'Amana Express' } });

    // Affiliate API behind the REAL withAffiliateAuth.
    const overview = withAffiliateAuth(F.overview);
    const anon = await overview(new Request('http://harness/x'), {});
    ok('affiliate API without token → 401', anon.status === 401);
    const ov = await overview(new Request('http://harness/x', { headers: { authorization: `Bearer ${signToken({ affiliateId: 'E2E', type: 'affiliate' })}` } }), {});
    const ovBody = await ov.json();
    ok('affiliate overview: 70 spendable, gift redeemable', ov.status === 200 && ovBody.points.spendable === 70
      && ovBody.gifts.find((g) => g.id === giftId)?.canRedeem === true);

    const r1 = await run(F.requestRedemption, { method: 'POST', user: as('E2E'), body: { giftId, clientRequestId: 'e2e-req-0001', ...shipTo, affiliateId: 'A', pointsCost: 1 } });
    ok('affiliate requests the gift (201): own id, DB cost, stock reserved', r1.status === 201
      && r1.body.redemption.affiliateId === 'E2E' && r1.body.redemption.pointsCost === 20 && (await stockOf()) === 2);
    const id1 = r1.body.redemption.id;
    await run(A.patchRedemption, { method: 'PATCH', params: { id: id1 }, body: { toStatus: 'APPROVED', internalNotes: 'note interne E2E' } });
    await run(A.patchRedemption, { method: 'PATCH', params: { id: id1 }, body: { toStatus: 'PREPARING' } });
    const shipped = await run(A.patchRedemption, { method: 'PATCH', params: { id: id1 }, body: { toStatus: 'SHIPPED', carrierId: 'sc-e2e', carrierName: 'Fake', trackingNumber: 'AE-123' } });
    ok('admin ships with the carrier name from Shipping Companies', shipped.status === 200 && shipped.body.carrierName === 'Amana Express');
    const myReqs = await run(F.redemptions, { user: as('E2E') });
    const seen = myReqs.body.find((r) => r.id === id1);
    ok('affiliate sees status, carrier, tracking and history',
      seen.status === 'SHIPPED' && seen.carrierName === 'Amana Express' && seen.trackingNumber === 'AE-123'
      && seen.history.map((h) => h.toStatus).join() === 'PENDING_REVIEW,APPROVED,PREPARING,SHIPPED');
    ok('…and no internal note / admin id leaks', !JSON.stringify(myReqs.body).includes('note interne') && !JSON.stringify(myReqs.body).includes('harness-admin'));
    await run(A.patchRedemption, { method: 'PATCH', params: { id: id1 }, body: { toStatus: 'DELIVERED' } });

    // Cancellation by the affiliate (PENDING_REVIEW) → refund + stock restored.
    const r2 = (await run(F.requestRedemption, { method: 'POST', user: as('E2E'), body: { giftId, clientRequestId: 'e2e-req-0002', ...shipTo } })).body.redemption;
    const beforeCancel = (await rewards.getPointsSummary('E2E', { db: prisma })).balance;
    const c = await run(F.cancelRedemption, { method: 'POST', user: as('E2E'), params: { id: r2.id } });
    ok('affiliate cancel → refund + stock restored', c.status === 200
      && (await rewards.getPointsSummary('E2E', { db: prisma })).balance === beforeCancel + 20 && (await stockOf()) === 2);
    ok('cancel again → 409; another affiliate → 404',
      (await run(F.cancelRedemption, { method: 'POST', user: as('E2E'), params: { id: r2.id } })).status === 409
      && (await run(F.cancelRedemption, { method: 'POST', user: as('B'), params: { id: id1 } })).status === 404);

    // Admin rejection → refund + restock; RETURNED with explicit choices.
    const r3 = (await run(F.requestRedemption, { method: 'POST', user: as('E2E'), body: { giftId, clientRequestId: 'e2e-req-0003', ...shipTo } })).body.redemption;
    const rej = await run(A.patchRedemption, { method: 'PATCH', params: { id: r3.id }, body: { toStatus: 'REJECTED', reason: 'Adresse incomplète' } });
    ok('admin reject → refund + restock', rej.body.status === 'REJECTED' && rej.body.pointsRefundedAt && (await stockOf()) === 2);
    const r4 = (await run(F.requestRedemption, { method: 'POST', user: as('E2E'), body: { giftId, clientRequestId: 'e2e-req-0004', ...shipTo } })).body.redemption;
    for (const toStatus of ['APPROVED', 'PREPARING']) await run(A.patchRedemption, { method: 'PATCH', params: { id: r4.id }, body: { toStatus } });
    await run(A.patchRedemption, { method: 'PATCH', params: { id: r4.id }, body: { toStatus: 'SHIPPED', carrierName: 'Coursier' } });
    const ret = await run(A.patchRedemption, { method: 'PATCH', params: { id: r4.id }, body: { toStatus: 'RETURNED', refundPoints: true, restock: true } });
    ok('RETURNED with refund + restock', ret.body.status === 'RETURNED' && ret.body.pointsRefundedAt && ret.body.restockedAt && (await stockOf()) === 2);

    // Concurrency on real PG: requests racing an admin stock adjustment.
    await prisma.affiliate.create({ data: { id: 'E2F', username: 'e2f', isActive: true } });
    await rewards.adjustPoints({ affiliateId: 'E2F', delta: 100, reason: 'Harness seed', clientRequestId: 'e2f-seed-01', actorId: 'harness' }, { db: prisma });
    const stockRace = await Promise.allSettled([
      run(F.requestRedemption, { method: 'POST', user: as('E2F'), body: { giftId, clientRequestId: 'e2f-req-0001', ...shipTo } }),
      run(A.adjustStock, { method: 'POST', params: { id: giftId }, body: { delta: 5, reason: 'Réassort harness' } }),
      run(F.requestRedemption, { method: 'POST', user: as('E2F'), body: { giftId, clientRequestId: 'e2f-req-0002', ...shipTo } }),
      run(F.requestRedemption, { method: 'POST', user: as('E2F'), body: { giftId, clientRequestId: 'e2f-req-0003', ...shipTo } }),
    ]);
    ok('requests racing a stock adjustment: 2 + 5 − 3 = 4 (nothing lost)',
      stockRace.every((r) => r.status === 'fulfilled' && [200, 201].includes(r.value.status)) && (await stockOf()) === 4);

    // Order reversal after spending → debt → blocked; reconcile; books.
    // E2E: 20 bonus + 50 order − 20 (delivered gift) = 50; spend 20 more → 30.
    ok('balance before reversal is 50', (await rewards.getPointsSummary('E2E', { db: prisma })).balance === 50);
    await run(F.requestRedemption, { method: 'POST', user: as('E2E'), body: { giftId, clientRequestId: 'e2e-req-0005', ...shipTo } });
    await affSvc.adminUpdateAffiliateOrderStatus('aoE', 'cancelled', { db: prisma });
    const sumE = await rewards.getPointsSummary('E2E', { db: prisma });
    ok('order cancelled after spending → −50 reversal: balance −20, debt 20 (D3)', sumE.balance === -20 && sumE.debt === 20 && sumE.spendable === 0);
    const blocked = await run(F.requestRedemption, { method: 'POST', user: as('E2E'), body: { giftId, clientRequestId: 'e2e-req-0009', ...shipTo } });
    ok('…and a new request is refused (409 INSUFFICIENT_POINTS)', blocked.status === 409 && blocked.body.code === 'INSUFFICIENT_POINTS');
    const rec = await run(A.reconcile, { method: 'POST' });
    ok('admin reconcile endpoint runs on real PG (nothing to repair)', rec.status === 200 && rec.body.orders.errors === 0 && rec.body.signupBonuses.errors === 0);
    const acct = await run(A.getAccount, { params: { affiliateId: 'E2E' } });
    ok('admin account view: books balanced', acct.status === 200 && acct.body.booksBalanced === true);
    for (const id of ['E2E', 'E2F']) ok(`ledger sum == balance (${id})`, (await rewards.verifyAccountBalance(id, { db: prisma })).ok);
    ok('affiliate with rewards history cannot be deleted', (await caught(() => deleteAffiliateSafely(prisma, 'E2E')))?.code === AFFILIATE_HAS_HISTORY);
    ok('audit trail written (gift, stock, fulfilment, settings)',
      (await prisma.rewardAuditLog.count({ where: { action: { in: ['GIFT_CREATE', 'GIFT_STOCK_ADJUST', 'REDEMPTION_FULFILLMENT_UPDATE', 'CONFIG_UPDATE'] } } })) >= 4);
  } catch (e) {
    fail++; console.log('  FAIL  harness aborted:', e?.message ?? e);
  } finally {
    await prisma.$disconnect().catch(() => {});
    if (process.env.REWARDS_HARNESS_KEEP === '1') console.log(`\n(kept schema ${schema})`);
    else {
      for (const name of created.reverse()) {
        await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`).catch((e) => console.log('cleanup failed:', name, e.message));
      }
      const left = await admin.query(`SELECT count(*)::int n FROM pg_namespace WHERE nspname = ANY($1)`, [created]).catch(() => null);
      console.log(left ? `\n(cleanup: ${left.rows[0].n} harness schema(s) left)` : '\n(cleanup check failed)');
    }
    await admin.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/**
 * A db proxy whose interactive transactions call `onPause` right after the
 * first affiliateOrder.findMany (= the baseline read, made under the lock).
 */
/** Wrap `prisma` so the first TOP-LEVEL <model>.<method>() call awaits onPause() first (transactions pass through). */
function pauseTopLevelCall(prisma, modelName, methodName, onPause) {
  let paused = false;
  return new Proxy(prisma, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (key !== modelName) return typeof v === 'function' ? v.bind(target) : v;
      return new Proxy(v, {
        get(model, method) {
          const fn = Reflect.get(model, method);
          if (method !== methodName) return typeof fn === 'function' ? fn.bind(model) : fn;
          return async (...args) => {
            if (!paused) { paused = true; await onPause(); }
            return fn.apply(model, args);
          };
        },
      });
    },
  });
}

/** Wrap `prisma` so the first tx.<model>.<method>() call inside a transaction awaits onPause() first. */
function pauseBeforeTxCall(prisma, modelName, methodName, onPause) {
  let paused = false;
  const wrapTx = (tx) => new Proxy(tx, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (key !== modelName) return typeof v === 'function' ? v.bind(target) : v;
      return new Proxy(v, {
        get(model, method) {
          const fn = Reflect.get(model, method);
          if (method !== methodName) return typeof fn === 'function' ? fn.bind(model) : fn;
          return async (...args) => {
            if (!paused) { paused = true; await onPause(); }
            return fn.apply(model, args);
          };
        },
      });
    },
  });
  return new Proxy(prisma, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (key === '$transaction') return (fn, opts) => target.$transaction((tx) => fn(wrapTx(tx)), opts);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function pauseAfterBaselineRead(prisma, onPause) {
  let paused = false;
  const wrapTx = (tx) => new Proxy(tx, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (key !== 'affiliateOrder') return typeof v === 'function' ? v.bind(target) : v;
      return new Proxy(v, {
        get(model, method) {
          const fn = Reflect.get(model, method);
          if (method !== 'findMany') return typeof fn === 'function' ? fn.bind(model) : fn;
          return async (...args) => {
            const out = await fn.apply(model, args);
            if (!paused) { paused = true; await onPause(); }
            return out;
          };
        },
      });
    },
  });
  return new Proxy(prisma, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (key === '$transaction') return (fn, opts) => target.$transaction((tx) => fn(wrapTx(tx)), opts);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** Prisma's from-empty SQL for a schema text — offline (no DB connection). */
function prismaFromEmpty(schemaText) {
  const dir = mkdtempSync(join(tmpdir(), 'rewards-harness-schema-'));
  try {
    const file = join(dir, 'schema.prisma');
    writeFileSync(file, schemaText);
    const bin = new URL('../node_modules/.bin/prisma', import.meta.url).pathname;
    return execFileSync(bin, ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', file, '--script'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      // prisma.config.ts needs some URL to load; diff never connects. Never the real one.
      env: { ...process.env, DATABASE_URL: 'postgresql://offline@127.0.0.1:1/none' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Structural description of the reward_* tables in one schema. */
async function describeRewards(client, schema) {
  const q = async (sql) => (await client.query(sql, [schema])).rows.map((r) => r.d).sort();
  const own = `conrelid::regclass::text LIKE '%reward\\_%'`;
  return {
    columns: await q(`SELECT table_name||'.'||column_name||' '||data_type||coalesce('('||datetime_precision||')','')||' null='||is_nullable||' default='||coalesce(column_default,'') d
                      FROM information_schema.columns WHERE table_schema = $1 AND table_name LIKE 'reward\\_%'`),
    indexes: await q(`SELECT replace(indexdef, ' '||schemaname||'.', ' ') d FROM pg_indexes WHERE schemaname = $1 AND tablename LIKE 'reward\\_%'`),
    foreignKeys: await q(`SELECT conname||' '||replace(pg_get_constraintdef(c.oid), $1||'.', '') d FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                          WHERE n.nspname = $1 AND c.contype = 'f' AND ${own}`),
    uniques: await q(`SELECT conname||' '||contype::text d FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                      WHERE n.nspname = $1 AND c.contype IN ('p','u') AND ${own}`),
    checks: await q(`SELECT conname d FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                     WHERE n.nspname = $1 AND c.contype = 'c' AND ${own}`),
    triggers: await q(`SELECT tgname d FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
                       WHERE n.nspname = $1 AND NOT t.tgisinternal AND r.relname LIKE 'reward\\_%'`),
  };
}
