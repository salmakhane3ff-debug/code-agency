# Recruiter performance baseline — Phase 6 Part 5a (closed with partial coverage)

**Status: closed early.** The run was stopped on request (2026-11-05) and is closed from the evidence already saved:
nothing was re-run, PostgreSQL was not restarted, no dataset was regenerated. Only the results marked **BASELINE** are
baseline measurements; everything marked **functional** or **diagnostic** is n ≤ 2 evidence, not a baseline. Every
missing measurement is listed in §6. No application code, schema or migration was changed; only a disposable local
PostgreSQL cluster was used (no shared, Preview or Production database).

Code under test: `7e111e10df7c2413820f34a52fe200aebdefa72e` (unchanged). Raw data (not committed):
`/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5a/` (see §8).

## 1. Environment

| Item | Value |
|---|---|
| Host | 4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, Linux 6.18 |
| PostgreSQL | 16.15, disposable cluster `/tmp/p5a-pg` (Unix socket only, port 55510), locale C.UTF-8 |
| Settings | defaults except `shared_preload_libraries=pg_stat_statements`, `pg_stat_statements.track=all`, `track_io_timing=on`, `log_lock_waits=on`, `deadlock_timeout=100ms`; `shared_buffers` 128 MB, `jit` on |
| Node / ORM | Node v22.22.0; Prisma 6.19.3 with `@prisma/adapter-pg` 7.5.0 (same construction as `src/lib/prisma.js`); `pg` 8.20.0 |
| Warm | after 3 discarded warm-ups in the same process; p50/p95 nearest-rank over n samples |
| Cold | first request after a PostgreSQL restart, fresh Node process, timed after `connect`; the OS page cache is **not** dropped |

The disposable schema contains every index declared in `prisma/schema.prisma`, including `affiliates(parentId)` and
`affiliate_orders(affiliateId)`. **No committed migration creates them**, so the production database may differ; all
numbers below assume they exist (see §7).

## 2. Synthetic datasets (generated in SQL, deterministic)

| Template | Affiliates | Orders | Identity rows | Ledger rows | Audit rows | Payouts | Size | Build |
|---|---|---|---|---|---|---|---|---|
| `p5a_1k` | 3,002 | 15,602 | 1,942 | 2,257 | 5,383 | 336 | 29 MB | 9 s |
| `p5a_10k` | 30,010 | 159,710 | 19,513 | 22,702 | 53,782 | 3,607 | 170 MB | 36 s |
| `p5a_100k` | 300,100 | 1,565,786 | 195,289 | 222,559 | 533,211 | 36,059 | 1.56 GB | 329 s |

- Per scale S, three recruiters' networks:
  - **mixed**: S members, about 5% roots. Max depth 13 / 16 / 20; unplaced 2-cycles: 2 / 10 / 100.
  - **wide**: 1 root and S−1 children.
  - **deep**: one chain of S.
- Other content:
  - Real and fake orders over 10 status spellings.
  - Identities APPROVED, PENDING, REJECTED and none.
  - Reward and reversal cycles (settings v1 / v2).
  - Recruiter withdrawals and audit volume.
- All triggers were enabled during the load. Schema drift against `prisma/schema.prisma` is zero.
- Steady state was verified with the **real** `reconcileRecruiterRewards` (awarded 0 / reversed 0). These are single validation runs, not a baseline:
  - All recruiters: 156 ms (1k), 1,239 ms (10k), 20,557 ms (100k).
  - A 3-award / 2-reversal flip at 100k: 19,494 ms.

## 3. Network baseline (BASELINE: 1k all shapes; 10k mixed + wide)

Real handlers (`recruiterNetworkHandlers` → `stats` / `nodes`): session check, view projection and response body
included. Warm n = 30, errors 0, timeouts 0 for every row below. Times in ms (p50 / p95). Read with the caveats at
the end of §7.

| Variant | 1k p50 / p95 | 1k stmts | 10k p50 / p95 | 10k stmts | 10k SQL / JS p50 | 10k resp. bytes |
|---|---|---|---|---|---|---|
| mixed tree load only (`loadNetworkTree`) | 30.0 / 41.1 | 2 | 344.5 / 398.3 | 2 | 282.4 / 53.7 | — |
| mixed stats, orders on | 74.4 / 96.4 | 5 | 773.8 / 852.8 | 7 | 462.5 / 303.9 | 6,367 |
| mixed stats, orders off | 45.3 / 56.6 | 4 | 453.8 / 521.5 | 5 | 305.3 / 146.1 | 2,386 |
| mixed stats subtree, on / off | 66.7 / 81.9 · 48.2 / 59.2 | 5 · 4 | 733.8 / 855.2 · 454.0 / 524.0 | 7 · 5 | — | 6,003 · 2,275 |
| mixed nodes roots page 1, on | 37.6 / 48.3 | 6 | 349.5 / 411.0 | 6 | 286.4 / 61.3 | 20,678 |
| mixed nodes roots page 1, off | 40.4 / 50.5 | 5 | 348.1 / 401.8 | 5 | — | 10,026 |
| mixed nodes roots page 2 / last | 32.2 / 38.6 · 36.7 / 49.5 ¹ | 3 · 6 | 357.1 / 440.3 · 349.1 / 397.8 | 6 · 6 | — | 20,672 · 14,486 |
| mixed nodes branch expansion, on / off | 37.0 / 48.0 · 35.2 / 45.2 | 6 · 5 | 336.5 / 394.2 · 337.6 / 374.8 | 6 · 5 | 276.4 / 57.0 | 7,163 · 3,965 |
| mixed nodes `view=unplaced` | 42.1 / 53.0 | 7 | 368.7 / 401.7 | 7 | — | 4,172 |
| wide tree load only | 19.6 / 25.7 | 2 | 163.0 / 211.0 | 2 | — | — |
| wide stats, on / off | 59.7 / 69.6 · 37.6 / 44.0 | 5 · 4 | 548.8 / 626.2 · 273.5 / 322.7 | 7 · 5 | 255.3 / 296.3 (on) | 1,217 · 490 |
| wide nodes roots page 1 | 24.8 / 30.2 | 6 | 167.7 / 201.3 | 6 | — | 478 |
| wide children first page, on / off | 27.6 / 34.8 · 27.5 / 33.9 | 6 · 5 | 166.3 / 186.5 · 165.3 / 187.5 | 6 · 5 | 108.1 / 56.8 (on) | 20,862 · 10,205 |
| wide children middle / last page | 29.9 / 35.3 · 26.5 / 32.6 | 6 · 6 | 170.5 / 192.0 · 168.6 / 198.1 | 6 · 6 | — | 20,851 · 20,451 |

¹ At 1k the mixed network has only 39 roots: page 2 is empty and "last" is page 1.

**Deep chain** (BASELINE at 1k, n = 30; the chain is 1,000 long):
- Every endpoint takes about 1.0–1.1 s p50:
  - tree load 1,003.5 / 1,118.2;
  - stats on 1,060.1 / 1,139.7 (340,441 B response);
  - stats off 1,052.1 / 1,225.7;
  - nodes roots page 1 1,048.5 / 1,146.6;
  - branch expansion at depth 999: 1,032.7 / 1,081.0 (103,148 B; the breadcrumb lookup alone is 17.2 / 21.4).
- **10k (chain of 10,000): tree load only, n = 1: 121,034.8 ms** (SQL 120,962.6 ms). Every other 10k deep variant and all of 100k: not measured (§6).

**Cold** (BASELINE at 1k, n = 5; p50 / max):

| Variant | p50 / max |
|---|---|
| mixed stats on | 100.3 / 109.3 |
| mixed nodes roots page 1 | 59.5 / 70.7 |
| wide children first page | 47.6 / 57.3 |
| deep stats on | 1,080.3 / 1,125.8 |

**`canViewOrders=false`**:
- Every "off" variant (7 at 1k, 6 at 10k) returned 30/30 HTTP 200 with `orders: null` everywhere.
- **Zero `affiliate_orders` statements** in the driver-level client log and zero matching `pg_stat_statements` entries.
- The "on" variants show the order query (for example 60 order statements in 30 requests at 10k = 2 chunks of 5,000 ids).

**Memory** (10k, V8 heap peak above the per-request baseline, p50; max RSS per process):

| Request | Heap peak | Max RSS |
|---|---|---|
| mixed stats on | +34.1 MB | 307 MB |
| mixed stats off | +16.8 MB | 214 MB |
| wide stats on | +35.2 MB | 303 MB |
| nodes pages | +12.6 to +17.8 MB | 160–173 MB |

**What the numbers show (measured):**
1. **Every `nodes` request costs about one full tree load:**
   - 10k mixed: page 1 349.5 ms vs tree load 344.5 ms;
   - wide children: 166.3 vs 163.0 ms.

   This repeats for every page, branch expansion and breadcrumb.
2. **`stats` adds JavaScript aggregation and the order-count chunks on top of the tree:**
   - 10k mixed: on 773.8 vs off 453.8 ms;
   - JS share: 303.9 ms on, 146.1 ms off.
3. **Scaling from 1k to 10k:**
   - mixed tree ×11.5 and wide tree ×8.3 for ×10 members;
   - deep tree ×120.6 for ×10 depth, i.e. quadratic in depth (§4).

## 4. Recursive tree query plan (DIAGNOSTIC: single EXPLAIN ANALYZE runs at 10k, not a baseline)

| Shape | Default plan | Execution | Buffers |
|---|---|---|---|
| deep (10,000 levels) | Merge Join per level over a full `affiliates` seq scan (30,010 rows), hash join with all 10,000 links, sort | **168,296 ms** | 11.1 M shared hits |
| deep, `enable_mergejoin`/`enable_hashjoin` off | Index Scan `affiliates_parentId_idx` per node + memoized link PK lookup | **160.6 ms** (JIT ≈ 22 ms of it) | 160 k shared hits |
| mixed (16 levels) | same per-level full scan | 377.9 ms | — |
| wide (2 levels) | same | 134.8 ms | — |

The cost is (number of levels) × (size of `affiliates` + network). The query is the one in `loadNetworkTree`, run
verbatim with bind parameters (`scratchpad/p5a/logs/infra-observation-tree-plan-10k-*.txt`).

## 5. Functional / smoke evidence (NOT baseline; n ≤ 2, shown for direction only)

- **Ancestry (affiliate creation), 1k, n = 2 per depth:**
  - About 350–390 ms of password hashing happens before the transaction on every creation.
  - The recruiter row lock is then held for:
    - depth 1 ≈ 25 ms;
    - mixed max depth 13 ≈ 60 ms;
    - depth 100 ≈ 259–287 ms;
    - depth 1,000 ≈ 1.84–1.87 s (2,012 statements, i.e. 2 per ancestor).
- **Ancestry 10k smoke, n = 1:** creating under a 10,000-deep parent failed with **P2028** (Prisma's 5 s interactive-transaction timeout) after 2,428 ancestors (4,854 statements). The lock was held 5,001 ms, then rolled back. The documented `ANCESTRY_MAX` of 10,000 is not reachable under this timeout.
- **Reconciliation, 1k, n = 1 per scenario (functional):** all correctness checks passed:
  - steady state 0/0;
  - exactly 10 awards + 5 reversals;
  - pool-limited 40/20 pending;
  - two concurrent runs wrote no duplicates.
- **EXPLAIN / index harness:** functional run at 1k only (V0, V1). No index comparison was produced.

## 6. Gaps (not measured — do not infer)

| Area | Missing |
|---|---|
| Network 10k | deep variants except the single tree-load sample; the whole 10k cold series |
| Network 100k | everything (mixed, wide, deep; warm and cold) |
| Ancestry | baseline at every scale (only the functional 1k and one 10k smoke sample exist) |
| Reconciliation | baseline at every scale and scenario (no eligible, small, 1,000 pending, concurrent, wallet GET); the duplicate-work numbers |
| EXPLAIN / indexes | the 10k / 100k plan set; migrations-only variant (no `parentId` / `affiliateId` indexes); proposed indexes V1–V4 read benefit and write cost |
| Production | real index state unknown; the read-only checklist has not been run (fix §7 B1/B2 first) |

## 7. Tooling review (22 untracked files)

- **Harnesses** (`bench-network`, `bench-ancestry`, `bench-reconcile`, `explain-indexes`): reviewed read-only.
  - **No blocking issue.** Every harness enforces the disposable-cluster guard before connecting and uses only prefixed clones.
  - `eslint` is clean on all six `.mjs` files.
  - Caveats to keep when quoting numbers:
    - p95 = max when n < 20;
    - heap is sampled at call boundaries (a lower bound);
    - EXPLAIN ANALYZE time is not comparable to client latency;
    - deep ancestry summaries are split by result, so always quote the counts per result.
- **`production-index-checklist.sql`**: strictly read-only on a direct connection. **Fix before handing it to an operator:**
  - **B1:** the session-level `SET statement_timeout / lock_timeout` run before `BEGIN`. Move them after `BEGIN TRANSACTION READ ONLY` as `SET LOCAL`, or require a direct, non-pooled connection, so they cannot leak into other sessions through a transaction pooler.
  - **B2:** on PostgreSQL 13–15, the `pg_stat_statements` section can print un-normalised literals (`EXPLAIN …`, `COPY (SELECT …)`, `DO` …). Keep only plain SELECT/WITH/DML texts and mask literals.
  - **Minor:** `current_setting('shared_preload_libraries')` errors for non-superusers; section 7.4 selects `"parentId"` without a column guard; there is no privilege pre-check.
- **Infrastructure** (`lib.mjs`, `pg.sh`, `schema.sh`, `generate.mjs`, `sql/*`): reviewed read-only. **No blocking issue; fit to keep (untracked).**
  - Safety is enforced in code:
    - the disposable-URL guard runs on import and before every connection;
    - `psql` always gets an explicit `-h` / `-p`;
    - `destroy` removes only the literal `/tmp/p5a-pg`;
    - nothing writes into the repository and no `.env` is read.
  - The generator is deterministic and matches the README spec and the real reconcile rules:
    - values are md5-based, ids and timestamps are explicit, and inserts are ordered;
    - the checked-out files hash to the generator hashes in all three manifests (all `ok: true`).
  - Recommended small fixes (not applied):
    - `schema.sh:108` runs `prisma --version` in the caller's directory, which loads `prisma.config.ts` (`dotenv/config`). Use `(cd "$WORK" && "$PRISMA" --version)`.
    - `generate.mjs:446` locks the template before `:456` computes `ok`, and cloning never checks `manifest.ok`.
    - `pg.sh settings` without a file argument exits 1.
    - `schema.sh` escapes only `"` in its JSON, and its `bc` output can be invalid JSON.
    - `pg.sh` should refuse a symlinked `/tmp/p5a-pg`, and its `psql` passthrough accepts `-h` / `-p` overrides.
    - psql stderr is discarded on success.
    - README: `$SCRATCH` is never defined, the file table omits the harnesses, and some quoted results come from scratch-only scripts.
  - **A rebuilt template is a new baseline.** After `UPDATE … FROM` + `VACUUM FULL` (`sql/31`), the physical row order of `affiliates` is not controlled, and `ANALYZE` samples differ between builds. Clones of one template are identical, but content checksums cannot detect a layout difference between rebuilds.
  - Synthetic history is not time-consistent: order dates are independent of reward dates, and cycle dates and members' identity states do not line up over time. Use the data for current-state queries, not for time-window or history benchmarks.
- **Hygiene:** `lib.mjs`, `schema.sh` and `README.md` hard-code the repository path and this session's scratch path. Make them configurable, and move run results out of the README, before committing the tooling.

**Caveats for quoting any number in this report:**
- **Service level only.** Times cover the handler bodies, with a Prisma client built like the production branch of `src/lib/prisma.js` (`PrismaPg` over `pg.Pool`, max 10). The pool is external and instrumented. No Next.js routing, middleware or HTTP layer is included.
- **Instrumentation is not calibrated.** Wall times include the harness's own instrumentation: V8 heap sampling at every Prisma call boundary and SQL capture (response-size measurement was off). Its overhead was not measured, so before/after comparisons are valid only with the same harness and settings.
- **SQL time and heap.** SQL `ms` is round trip + server + row parsing. Heap figures are lower bounds: V8 heap only, sampled at call boundaries.
- **Server settings.** `pg_stat_statements` (track = all) and `track_io_timing` were on throughout. pg-pool closes connections idle for more than 10 s.
- **Dataset.** Only 4 recruiters exist; their three measured networks make up all of `affiliates` and `affiliate_orders`. Tables are freshly compacted and all-visible. Table sizes, selectivity and plans can therefore differ from production.

## 8. Raw data and reproduction

- **Scratch results:**
  - `network-1k.jsonl`, `network-10k.jsonl` (baseline);
  - `infra-observations.jsonl` + `logs/infra-observation-tree-plan-10k-*.txt` (plans);
  - `ancestry-1k-fcheck.jsonl`, `ancestry-10k-smoke.jsonl`, `reconcile-1k-functional.jsonl`, `explain-1k.jsonl` (functional);
  - `infra-*.jsonl` (generation and validation);
  - `manifests/{1k,10k,100k}.json`.

  Files with `-dev`, `-functional`, `-timeout` or `-smoke` in their names are development or functional runs, not baseline.
- **Disposable cluster:** stopped, data directory kept (`/tmp/p5a-pg`, 2.1 GB, templates `p5a_1k/10k/100k`).
  - Restart: `bash scripts/perf/recruiter/pg.sh start` (never `destroy`).
  - Commands for every harness: `scripts/perf/recruiter/README.md`.
