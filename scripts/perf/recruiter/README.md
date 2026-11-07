# Recruiter performance baseline — infrastructure (Phase 6 Part 5a)

Reproducible, disposable infrastructure for measuring the **current** Affiliate Recruiter System
implementation (network tree, statistics, rewards reconcile, wallet, audit lookups) on realistic
data at three scales. Nothing here optimises or changes application code, the Prisma schema or a
migration: it only builds a throwaway PostgreSQL cluster, loads deterministic datasets into
template databases, and gives benchmark harnesses one shared, instrumented way to talk to them.

| File | What it is |
| --- | --- |
| `pg.sh` | lifecycle of the disposable cluster (`init`, `start`, `stop`, `restart`, `status`, `settings [file]`, `destroy`, `psql …`) |
| `schema.sh` | builds the schema-only database `p5a_base` and proves zero drift against `prisma/schema.prisma` |
| `sql/*.sql` | the dataset generator, one file per step (pure SQL, deterministic) |
| `generate.mjs` | driver: `build`, `check-build`, `validate`, `reconcile`, `drift`, `selftest` |
| `lib.mjs` | shared library for every harness (guard, instrumented PrismaPg client, helpers) |

Scratch outputs (never in the repository) live under
`/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5a/`
(`SCRATCH` below): `results/` (raw JSONL), `logs/`, `manifests/`, `work/`.

## Safety rules (enforced, not just documented)

* **One cluster, one place.** Data `/tmp/p5a-pg/data`, socket `/tmp/p5a-pg/sock`, logs
  `/tmp/p5a-pg/log`, port **55510**, `listen_addresses = ''` (Unix socket only), directories owned by
  `postgres`, mode 700, trust authentication on that socket. `pg.sh` touches nothing else.
* **One URL shape.** Every connection goes through `lib.assertDisposableUrl()`:
  `postgresql://postgres@localhost:55510/<db>?host=/tmp/p5a-pg/sock` — the port must be in the
  authority (a `?port=` parameter made Prisma fall back to 5432 in an earlier run), no password, no
  other parameter. Anything else throws **before** connecting.
* **DATABASE_URL.** Importing `lib.mjs` throws if the environment already holds a `DATABASE_URL`
  that is not such a URL; when none is set it sets one (in that process only) pointing at a sentinel
  database on the disposable cluster, so the app's default client (`src/lib/prisma.js`, created when a
  service module is imported) can never reach anything else. `.env` files are never read:
  `schema.sh` and `generate.mjs drift` refuse to run the Prisma CLI if one exists and run it from the
  scratch work directory (the repo's `prisma.config.ts`, which imports `dotenv`, is never loaded).
* **Templates are read-only and locked.** `p5a_1k`, `p5a_10k`, `p5a_100k` are created by `build` and
  then set `IS_TEMPLATE true, ALLOW_CONNECTIONS false`: nobody can connect to them (by design) and
  `DROP DATABASE` refuses them. Work on clones only.
* **Clones.** `lib.cloneDb()` only creates names starting with `net_`, `anc_`, `rec_`, `exp_`,
  `val_`, refuses when **2 clones** are already alive, and refuses when less than **4 GiB** of disk
  would remain after the copy. `lib.dropDb()` only drops such clones (never a template). Drop clones
  as soon as they are no longer needed.
* **No repository writes.** Results, logs and manifests go to `SCRATCH`; nothing here commits,
  pushes, or edits an existing file.

## Running every step

```bash
cd /home/user/code-agency
bash scripts/perf/recruiter/pg.sh init        # once: initdb + p5a.conf (settings below)
bash scripts/perf/recruiter/pg.sh start
bash scripts/perf/recruiter/pg.sh settings "$SCRATCH/manifests/pg_settings.csv"   # pg_settings snapshot
bash scripts/perf/recruiter/schema.sh         # p5a_base: base SQL + 7 migrations + drift check → manifests/schema.json

node scripts/perf/recruiter/generate.mjs build --scale 1k      # [--force] rebuilds an existing template
node scripts/perf/recruiter/generate.mjs build --scale 10k
# 100k runs for several minutes: start it detached and wait for the pid
setsid nohup node scripts/perf/recruiter/generate.mjs build --scale 100k > "$SCRATCH/logs/generate-100k.out" 2>&1 &
timeout 540 tail --pid=<pid> -f /dev/null      # repeat until it exits

node scripts/perf/recruiter/generate.mjs check-build --scale 100k       # read-only re-validation of a loaded, NOT finalized build
node scripts/perf/recruiter/generate.mjs validate  --scale 10k          # re-check a template on a val_ clone
node scripts/perf/recruiter/generate.mjs reconcile --scale 1k --flip    # REAL reconcileRecruiterRewards on a val_ clone
node --expose-gc scripts/perf/recruiter/lib.mjs --self-test --db val_1k # instrumentation self-test
node scripts/perf/recruiter/generate.mjs drift --db <clone>             # prisma migrate diff vs prisma/schema.prisma
npx eslint scripts/perf/recruiter/*.mjs
bash scripts/perf/recruiter/pg.sh status       # versions + database sizes
```

`pg.sh restart` is a fast shutdown + start (used for cold measurements; the OS page cache is **not**
dropped). `pg.sh destroy` stops the server and removes `/tmp/p5a-pg`.

`generate.mjs` prints progress on stderr and only its JSON result on stdout. Importing a service
module prints Node's `MODULE_TYPELESS_PACKAGE_JSON` warning on stderr (the app's `.js` files use ESM
syntax without `"type": "module"`); it is harmless and `package.json` must not be changed.
`p5a_base` (schema only) stays a normal, unlocked database: `schema.sh` drops and recreates it.

### Cluster settings

PostgreSQL 16 defaults (as written by `initdb`: `shared_buffers = 128MB`, `max_connections = 100`,
`work_mem = 4MB`, `jit = on`, `TimeZone = Etc/UTC`, …) **except** (in `data/p5a.conf`):
`shared_preload_libraries = 'pg_stat_statements'`, `pg_stat_statements.track = all`,
`track_io_timing = on`, `log_lock_waits = on`, `deadlock_timeout = 100ms`, `logging_collector = on`,
plus the location settings `listen_addresses = ''`, `port = 55510`,
`unix_socket_directories = '/tmp/p5a-pg/sock'`, `log_directory = '/tmp/p5a-pg/log'`.
`initdb --encoding=UTF8 --locale=C.UTF-8` (this container offers no other UTF-8 locale and the
default would be SQL_ASCII) — a production database with e.g. `en_US.UTF-8` collation compares text
more slowly. The full snapshot is `SCRATCH/manifests/pg_settings.csv`.

### Schema (`schema.sh`)

1. `git show 3607da3:prisma/schema.prisma` → `prisma migrate diff --from-empty --to-schema-datamodel
   … --script` → `SCRATCH/work/base-3607da3.sql` (regenerated every run; byte-identical to the
   earlier verified `old-schema.sql`, same sha256).
2. Applied to a fresh `p5a_base`, then the 7 recruiter migrations `20261105 … 20261111` in order
   (they are re-runnable; the 3607da3 datamodel already contains the recruiter tables of
   20261105–20261109, hence the "already exists, skipping" notices in the per-migration logs).
3. `prisma migrate diff --from-url <p5a_base> --to-schema-datamodel prisma/schema.prisma --script
   --exit-code` must print `-- This is an empty migration.` → `SCRATCH/manifests/schema.json`
   (`driftEmpty: true`). Every template is drift-checked again after its load (`manifest.drift`).

Caveats of this schema (state them in reports): the datamodel-generated base carries **no** trigger,
CHECK or partial index of the pre-recruiter migrations (brand / reward-points tables — none of them
touch the tables used here). It contains **every index declared in `schema.prisma`**, including
`affiliates(parentId)` and `affiliate_orders(affiliateId)`; **no committed migration creates the
`affiliate_orders` table or `affiliates.parentId` / its index**, so a production database may differ
— the index phase measures both variants.

## Dataset (sql/00 … 90)

Deterministic: every pseudo-random choice is `md5(<fixed seed>)` of an id or index (helpers
`p5a_gen.h32 / u01 / uuid4 / person`); no `random()`, no `now()` in a stored value. Two consecutive
builds produce identical data — `manifest.contentChecksums` (count + order-independent sum of row
hashes, every column) is the proof. All user triggers (18) stay **enabled** during the whole load.

Per scale S ∈ {1000, 10000, 100000}:

* **Recruiters** `rec_mixed`, `rec_wide`, `rec_deep`, `rec_empty`: active, `canViewOrders`,
  `canCreateAffiliates`, complete bank details; KYC inserted PENDING (submission 1, two `<uuid>.jpg`
  keys) then updated to APPROVED with reviewer / reviewedAt / approvedAt (the only path the guard
  accepts).
* **Networks**: `mixed` = S members, ~5 % roots, every other node attaches to an earlier node
  `1 + floor((n−1)·u²)` (bias toward older nodes) + `max(2, S/1000)` **unplaced** members in 2-cycles
  (parentIds pointing at each other, both linked); `wide` = 1 root + S−1 children; `deep` = one chain
  of S (depth S). `rec_empty` has no member.
* **Affiliates + links** (`sql/30`): one transaction, each affiliate inserted INACTIVE with
  `createdAt` = the transaction's UTC time (inside the link trigger's window), then its link — the
  link trigger `recruiter_link_new_affiliate_only` checks every row. `sql/31` then sets `isActive`
  (~70 %), a deterministic, strictly increasing `createdAt` (so `ORDER BY "createdAt", id` is stable;
  links carry the same time) and `updatedAt`, and `VACUUM FULL affiliates` compacts the table.
* **identity_verifications**: 40 % APPROVED / 15 % PENDING / 10 % REJECTED / 35 % none (the draw of
  the free members compensates the forced ones, so the totals hit the target at every scale).
* **affiliate_orders**: 80 % of members 0–7 orders, 20 % "active sellers" 5–15; statuses delivered,
  pending, confirmed, shipped, cancelled, canceled, returned, refused, `Delivered` (case variant) and
  the unknown `on_hold`; ~10 % `isFake`; distinct uuid `orderId`s except 25 % of fake rows that reuse
  the orderId of the member's (real) row 1 — orderIds shared by a fake and a real row.
* **recruiter_settings_versions**: v1 (enabled, 5000 cents, threshold 3, 2024-12-15) and v2 (enabled,
  7000 cents, threshold 5, 2025-04-01) = current.
* **recruiter_reward_ledger** (`sql/60`): cycles per migration 20261110 — one open cycle, closed
  cycles (reward + reversal) followed by an open cycle, or only closed cycles; a reward's version is
  the one current at its time; reversals = −reward with the reward's version; keys
  `recruit:<id>:v<n>` / `reverse:<id>:v<n>`, plus legacy `recruit:<id>` / `reverse:<id>` cycle-1 rows
  dated before the cycles migration. Inserted one row at a time in time order with every trigger
  enabled (cycle guard, link guard, append-only, CHECKs), committing every 2000 rows (the cycle guard
  takes one advisory lock per row; the default lock table holds ~6400).
* **STEADY STATE** for the current rules, by construction and verified twice (SQL emulation in
  `build`, the real `reconcileRecruiterRewards` in `reconcile`): an open reward of version v has
  ≥ threshold(v) real delivered orders (open v1 rewards with 3–4 deliveries stay open — the D2 rule);
  no member without an open reward has identity APPROVED and ≥ 5 real delivered orders.
* **Scenario pools** (rec_mixed, placed members, listed in pool order in the manifest; S = 1k: 40/20,
  10k and 100k: 1100/500): `P_AWARD` = identity PENDING, exactly 5 real delivered orders, no open
  reward (~25 % after closed cycles) — approving the identity creates exactly one pending award each;
  `P_REVERSE` = identity APPROVED, exactly 5 real delivered orders, open **v2** reward (~30 % after
  closed cycles) — cancelling the listed real delivered order (`P_REVERSE_cancelOrderId`) creates
  exactly one pending reversal each.
* **recruiter_audit_log**: AFFILIATE_CREATED per member (actor RECRUITER, details `{ requestId (uuid
  v4), username, parentId, activationCodeId: null }`), RECRUIT_REWARD_EARNED / _REVERSED per ledger
  row, RECRUITER_WITHDRAWAL_REQUESTED per withdrawal (+ _PAID / _REJECTED for the processed ones),
  recruiter creation / KYC / bank rows and the two settings rows — inserted in time order (seq follows
  `createdAt`).
* **affiliate_payouts**: `max(20, S/50)` withdrawals per recruiter **with earnings** (paid 55 % /
  pending 25 % / rejected 20 %, whole MAD; reserved ≈ 60 % of earned, so `available > 0`) — `rec_empty`
  has no earnings and therefore no withdrawal (a request needs a positive balance); plus 1–3 affiliate
  payouts for ~5 % of the members.
* **Finalize** (`sql/90`): drop the helper schema `p5a_gen`, `CREATE EXTENSION pg_stat_statements`,
  `VACUUM (ANALYZE)`; then the drift check and the template lock. No connection is left open.

### The built templates

From the final builds (`buildId` `p5a_1k@2026-11-05T17:41:46.668Z`, `p5a_10k@2026-11-05T17:41:56.567Z`,
`p5a_100k@2026-11-05T17:42:42.050Z`; every number below is copied from `SCRATCH/manifests/<scale>.json`
or `SCRATCH/results/infra-reconcile.jsonl`). The reconcile rows are single **validation** runs with the
instrumentation on — not baseline measurements (no warm-up protocol, n = 1).

| | 1k | 10k | 100k |
| --- | ---: | ---: | ---: |
| `affiliates` rows | 3,002 | 30,010 | 300,100 |
| `recruiter_affiliate_links` rows | 3,002 | 30,010 | 300,100 |
| `identity_verifications` rows | 1,942 | 19,513 | 195,289 |
| `affiliate_orders` rows | 15,602 | 159,710 | 1,565,786 |
| `recruiter_reward_ledger` rows | 2,257 | 22,702 | 222,559 |
| `recruiter_audit_log` rows | 5,383 | 53,782 | 533,211 |
| `affiliate_payouts` rows | 336 | 3,607 | 36,059 |
| mixed roots / max depth / unplaced | 39 / 13 / 2 | 485 / 16 / 10 | 4962 / 20 / 100 |
| deep max depth | 1,000 | 10,000 | 100,000 |
| open rewards (v1 / v2) | 717 (284 / 433) | 7,282 (2655 / 4627) | 71,925 (27799 / 44126) |
| P_AWARD / P_REVERSE | 40 / 20 | 1100 / 500 | 1100 / 500 |
| database size (bytes) | 29,375,511 | 170,146,839 | 1,556,790,295 |
| generation total (s) | 9.322 | 35.866 | 328.969 |
| SQL steady-state check: pending awards / reversals | 0 / 0 | 0 / 0 | 0 / 0 |
| real `reconcileRecruiterRewards` steady state: checked / awarded / reversed (wall ms) | 3,002 / 0 / 0 (156) | 30,010 / 0 / 0 (1239) | 300,100 / 0 / 0 (20557) |
| after flipping 3 P_AWARD + 2 P_REVERSE: awarded / reversed, then again | 3 / 2, then 0 / 0 | 3 / 2, then 0 / 0 | 3 / 2, then 0 / 0 |

Determinism: the 1k and 100k templates were each built more than once; the content checksums of
every table were identical between builds (`SCRATCH/work/1k-build-a.json`,
`SCRATCH/work/100k-build-previous.json` vs the final manifests). All three manifests record the same
generator file hashes.

### Manifest (`SCRATCH/manifests/<1k|10k|100k>.json`)

`recruiters.{mixed,wide,deep,empty}.{id,username}`; `shapes.<shape>`: `members`, `placed`, `unplaced`,
`unplacedIds`, `roots`, `maxDepth`, `pageCursors` (page sizes 50 / 100, roots count and pages),
`firstRootId`, `branchNode` (most children at the depth nearest to maxDepth/2), `largestSubtreeRoot`,
`largestSubtreeNonRoot`, `topFanOutNode`, `deepestNode` (each `{ id, depth, childrenCount,
descendantsCount, childPages50, firstChildId }`), mixed: `depthHistogram`, `firstNodeAtDepth`,
`fanOut`; deep: `chainSamples` keyed by depth (10, 100, 1000, 10000, S−1, S where they exist); wide:
`wideRoot`. `pools.P_AWARD`, `pools.P_REVERSE`, `pools.P_REVERSE_cancelOrderId`; `settings`;
`rowCounts`; `contentChecksums`; `historyClasses`; `validation` (every check with its detail, steady
state, wallet totals per recruiter, distributions); `drift`; `generationSeconds` per step;
`databaseSizeBytes`; `generator` (sha256 of every generator file); `environment`; `buildId`.

## lib.mjs API

All exports (ES module, `import { … } from './lib.mjs'`):

**Constants** — `REPO`, `PERF_DIR`, `SCRATCH`, `RESULTS_DIR`, `LOGS_DIR`, `MANIFESTS_DIR`, `WORK_DIR`,
`PG_BIN`, `PG_ROOT`, `PG_DATA`, `PG_SOCK`, `PG_LOG`, `PG_PORT` (55510), `PG_SH`, `SCALES`
(`{ '1k': 1000, '10k': 10000, '100k': 100000 }`), `TEMPLATES` (`{ '1k': 'p5a_1k', … }`), `BASE_DB`,
`CLONE_PREFIXES`, `MAX_CLONES` (2), `MIN_FREE_DISK_BYTES` (4 GiB).

**Guard** — `dbUrl(db) → string` · `assertDisposableUrl(url) → { db }` (throws `p5a guard: REFUSED …`)
· `guardProcessEnv(env = process.env) → url` (runs on import).

**Connection + instrumentation**
* `connect(db, { max, sqlTrace = true, prismaQueryEvents = false, bytes = true, heap = true,
  warmConnections = 1, log = ['error'] } = {}) → Promise<{ db, prisma, pool, rec, url, database,
  timings: { connectMs, poolWarmMs, warmConnections }, mark(label), slice(mark), measure(label, fn),
  sampleHeap(label), close() }>`
  * The client is built like production `src/lib/prisma.js`: `new PrismaClient({ adapter: new
    PrismaPg(pool), log: ['error'] })`; the `pg.Pool` gets `{ connectionString }` only, so its size is
    the pg default (**10**) unless `max` is given (the app's non-production branch uses `max: 2`).
  * `db` is the **recording proxy** — pass it as `{ db: conn.db }` to services. `prisma` is the raw
    client (unrecorded). `connectMs` = `$connect()` (includes loading the query engine in a fresh
    process); `poolWarmMs` = opening `warmConnections` pool connections (`SELECT 1` each), both
    reported separately from any request; the recorder is reset afterwards.
  * `measure(label, fn)` → `{ label, start, end, wallMs, calls, sql, prismaQueries, heap, summary,
    result, error }`; `fn` receives the proxy. `mark(label)` + `slice(mark)` do the same around any
    code. `summary` = `{ calls, transactions, callMsSum, rows, bytes, sizeMs, errors, sqlStatements,
    sqlMsSum, sqlMsMax, sqlErrors, sqlBegin, sqlCommit, sqlRollback, prismaQueryEvents,
    prismaQueryMsSum, heapStart, heapEnd, heapPeak, heapMin }`.
  * Call records: `{ i, op, model, kind, txId, parentTxId, start, end, ms, rows, resultType, value,
    bytes, sizeMs, error, heapStart, heapEnd }` — every model operation, `$queryRaw`,
    `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe` and `$transaction` (interactive: calls inside
    carry its `txId`; batch: recorded as one call). Prisma's laziness is preserved: a call starts and
    is timed at its first `then`. `bytes` = approximate JSON size computed after `end` without building
    a string (its cost is `sizeMs`, outside `ms`); pass `bytes: false` for pure timing.
  * SQL records (driver level): `{ i, textId, text (in slices), start, end, ms, rows, command, pid,
    queued, error }`. `ms` runs from `client.query()` to its result, so it includes client-side
    queueing when several queries share one connection (`queued` = queries already active/waiting on
    it, e.g. a `Promise.all` inside an interactive transaction).
  * Heap: `process.memoryUsage().heapUsed` sampled at every call start and end, at `mark` and `slice`.
  * `conn.rec.reset()` empties the recorder (do it between requests in long runs: the records
    themselves use memory). `conn.rec.texts[textId]` resolves an SQL text.
* `instrumentClient(client, rec, ctx = { txId: null })`, `class Recorder({ bytes, heap, sql })` — the
  building blocks, exported for special cases.
* `importService(name) → module` — `import()` of `src/lib/services/<name>.js`.

**Which SQL mechanism is used** (verified by the self-test, `results/lib-selftest.jsonl`): the
installed `@prisma/adapter-pg` 7.5.0 accepts an existing `pg.Pool` (`new PrismaPg(pool)`), so the lib
hands it a pool whose `Client` class times every `query()`. This is the primary mechanism: it sees
**every** statement including `BEGIN`, `COMMIT` and `ROLLBACK`, with sub-millisecond timings.
Prisma `$on('query')` events **do** fire with the adapter (opt in with `prismaQueryEvents: true`):
they include the statements and `COMMIT` but **not** `BEGIN` (issued by the adapter itself), and
their `duration` is whole milliseconds.

**Utilities** — `now()` (performance.now ms) · `heapUsed()` · `gc() → boolean` (needs `node
--expose-gc`) · `requireGc()` · `summarize(samples) → { n, min, p50, p95, max, mean }` (nearest-rank:
the ⌈q·n⌉-th smallest; nulls when n = 0) · `approxJsonBytes(value)`.

**Database helpers** — `psql(db, sql, { timeoutMs }) → stdout` · `psqlFile(db, file, { vars,
logFile, timeoutMs })` · `pgQuery(db, sql, params = [], { settings } = {}) → rows` (short-lived plain
`pg.Client`, NOT the measured path; `settings` = session-local GUCs such as `{ enable_mergejoin:
'off' }`) · `clusterReady() → boolean` · `freeDiskBytes(path = PG_ROOT)` · `databaseSize(db)` ·
`listDatabases()` · `listClones()` · `cloneDb(template, clone, { strategy = 'FILE_COPY' }) → {
clone, template, strategy, ms, templateBytes, freeBytesBefore, freeBytesAfter }` · `dropDb(clone) → {
clone, ms }` · `restartPg() → { ms }` · `pgssReset(db)` (`pg_stat_statements_reset()`, cluster-wide)
· `pgssSnapshot(db, { limit = 500, orderBy = 'total_exec_time' }) → rows` (that database's
statements incl. nested ones; PG16 columns `blk_read_time` / `blk_write_time`).

**Manifests + results** — `scaleKey(scale)` (`'1k' | 1000 → '1k'`) · `loadManifest(scale)` ·
`environment()` (cached header: PostgreSQL version + key settings, Node, Prisma client / CLI,
adapter-pg, pg, git HEAD, host CPUs / memory, `osPageCacheDropped: false`, pid, argv, start time) ·
`appendResult(file, obj)` (relative → `RESULTS_DIR`; a new or empty file first gets the header line;
BigInt serialised as string) · `runSelfTest({ db = 'val_1k', template = 'p5a_1k', keep = false })`.

Minimal harness:

```js
import { cloneDb, dropDb, connect, importService, loadManifest, appendResult, summarize } from './lib.mjs';
const m = loadManifest('10k');
await cloneDb('p5a_10k', 'net_10k_a');
const conn = await connect('net_10k_a');
const { getNetworkStats } = await importService('recruiterNetworkService');
const samples = [];
for (let i = 0; i < 23; i += 1) {
  const r = await conn.measure('stats', (db) => getNetworkStats(m.recruiters.mixed.id, { db }));
  if (i >= 3) { samples.push(r.wallMs); await appendResult('net-stats-10k.jsonl', { i, wallMs: r.wallMs, summary: r.summary }); }
  conn.rec.reset();
}
await appendResult('net-stats-10k.jsonl', { kind: 'summary', ...summarize(samples) });
await conn.close();
await dropDb('net_10k_a');
```

## Measurement conventions

* p50 / p95 by nearest rank over the recorded samples (`summarize`), always with `n`.
* **Warm** = measured after ≥ 3 discarded warm-up requests in the same process. **Cold** = the first
  request after `pg.sh restart` / `restartPg()` in a fresh Node process, timed **after** `connect()`
  (whose `connectMs` / `poolWarmMs` are reported separately). The OS page cache is **not** dropped.
* Timed runs only while nothing else runs on the machine; every raw sample goes to a JSONL file whose
  first line is the environment header (PostgreSQL and Node versions included).

## Results layout

`SCRATCH/results/*.jsonl` — one JSON object per line, first line `{ "type": "header", … }`. Written
by this phase: `infra-generate.jsonl` (seconds per build step, `buildId`, summary), `infra-validate.jsonl`,
`infra-reconcile.jsonl` (real reconcile runs), `lib-selftest.jsonl`, `infra-lib-checks.jsonl`,
`infra-observations.jsonl`. `SCRATCH/logs/` — psql logs per generator step, schema logs, the 100k
build log, EXPLAIN plans. `SCRATCH/manifests/` — `schema.json`, `pg_settings.csv`, `<scale>.json`.

## Observation for the benchmark phases (recorded, not acted upon)

The service's own recursive network query (`loadNetworkTree`, run verbatim with bind parameters on a
`p5a_10k` clone) gets a **merge-join plan that rescans and re-sorts the affiliates table on every
recursion step** with the default planner settings: `rec_deep` (10 000-deep chain) took **168.3 s**
(EXPLAIN ANALYZE), versus 0.16 s with `enable_mergejoin/enable_hashjoin = off` in that session;
`rec_mixed` 0.38 s and `rec_wide` 0.13 s at 10k with the default plan. Raw:
`results/infra-observations.jsonl`, plans in `logs/infra-observation-tree-plan-10k-*.txt`. It was
**not** run at 100k. Estimate only (not measured): the work per recursion step grows with the table
and the number of steps with the chain, so the deep network at 100k should be orders of magnitude
slower than the 168 s at 10k — harnesses need statement / request timeouts there. The generator's own
validation runs its recursive checks with those two settings off (session-local) for that reason, and
its large CTE-joining aggregate checks with `enable_nestloop = off` (a nested loop over a 215k-row CTE
scan ran > 5 minutes at 100k before that change).
