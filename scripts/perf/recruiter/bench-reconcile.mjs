/**
 * scripts/perf/recruiter/bench-reconcile.mjs — RECONCILIATION HARNESS of the Phase 6 Part 5a
 * recruiter performance baseline. It OBSERVES the current implementation and changes nothing in
 * the application (no file under src/ or prisma/, no setting, no financial behaviour).
 *
 * Target code (unchanged)
 *   • reconcileRecruiterRewards({ db, recruiterId }) of src/lib/services/recruiterRewardService.js
 *     and, through it, syncRecruiterReward: one interactive transaction per change, per-affiliate
 *     advisory lock 'recruit:<id>' (the ledger cycle-guard trigger takes the same key), the money
 *     lock 'recruiter-money:<recruiterId>' in the reversal branch, ledger + audit INSERTs.
 *   • the wallet GET route body of src/lib/recruiterWalletRouteHandlers.js:
 *     recruiterWalletHandlers({ db, rateLimit: () => false }).wallet(req, {}, decoded) with
 *     decoded = { type: 'recruiter', recruiterId, tv: <the recruiter's tokenVersion> } — auth query,
 *     reconcile scoped to the recruiter, getRecruiterWallet, projection, Response.json; the body is
 *     read (arrayBuffer) inside the timed window and its byte length recorded.
 *   Every request runs through lib.connect(): a PrismaClient built like production
 *   (new PrismaPg(pool), pg default pool size 10) plus the lib's recording proxy (every Prisma call)
 *   and its driver-level SQL log (every statement incl. BEGIN / COMMIT, backend pid, ms).
 *
 * Variants (--scenario takes a scenario or a variant name; default n in brackets)
 *   steady_scoped.warm   reconcile rec_mixed only (the wallet scope), steady-state clone, expect 0
 *                        changes [10]
 *   steady_scoped.cold   the same request after a PostgreSQL restart, in a fresh process [3]
 *   steady_all.warm      reconcile all recruiters (admin recheck / settings-save scope) [5]
 *   wallet_get.warm      the real wallet GET handler for rec_mixed at steady state [20]
 *   pending_small        FRESH clone per rep: approve 10 P_AWARD identities and cancel the listed real
 *                        delivered order of 5 P_REVERSE members, scoped reconcile → exactly 10 / 5 [3]
 *   pending_1000.scoped  FRESH clone per rep: 800 + 200 flips (at 1k only the pools exist, 40 + 20:
 *                        recorded as poolLimited), scoped reconcile [3]
 *   pending_1000.all     the same flips, all-recruiters reconcile [1]
 *   concurrent_dup       FRESH clone per rep with the pending_1000 flips: TWO scoped reconciles
 *                        started together, each through its own lib.connect() client (own pool and
 *                        recorder, so every statement is attributed to its run) [3]
 *
 * Protocol
 *   • One CHILD process (node --expose-gc) per warm series, per cold sample and per fresh-clone rep,
 *     under a watchdog. Warm: >= 3 discarded warm-ups in the same process (warm-up 0 also records
 *     approximate result bytes), then n measured requests. Fresh-clone reps: >= 3 discarded
 *     steady-state warm-ups of the same scope in the same process, THEN the flips (separate admin
 *     connection, outside the timed window), then ONE measured request: the read path is warm, the
 *     write path (sync transactions, triggers) is not — warming it would consume the flips. Cold:
 *     the cluster is restarted (lib.restartPg; the OS page cache is NOT dropped) only when no other
 *     client is connected; a fresh child imports the modules, $connect + pool warm-up are timed
 *     separately, then ONE request.
 *   • Per measured request: explicit gc() → baseline heap; wall ms; result; client SQL by kind
 *     (SELECT / INSERT / advisoryLock / rowLock / BEGIN / COMMIT / …) and per statement text; the
 *     sync transactions (rebuilt from the SQL log per backend pid, matched to the recorded
 *     $transaction calls, outcome inferred from the calls inside); lock wait = client ms of the
 *     pg_advisory_xact_lock statements (1st of a transaction = affiliate lock, 2nd = money lock)
 *     and of row-lock statements, plus the log_lock_waits lines of the run's backends (PostgreSQL
 *     log); server side: pg_stat_statements DELTAS of the clone's database (counters snapshotted
 *     right before and right after the request, no reset; toplevel and nested / trigger statements
 *     reported separately; evicted / decreasing entries flagged); rows per table counted before /
 *     after; peak heap sampled at every call boundary (afterGcMinusBaseline = heapUsed after the
 *     request's records were released and gc ran, minus the pre-request baseline); checks.
 *   • Fresh-clone reps also verify: the exact new ledger rows (affiliate, type, cycle, amount,
 *     version, key), audit rows written = ledger rows written (1:1), the global ledger invariants
 *     (no two rewards / reversals per affiliate and cycle, every reversal = −its reward with the same
 *     recruiter and version, no cycle gaps, one open cycle at most and only the latest — validation
 *     query with session-local enable_nestloop = off) and a follow-up reconcile that changes nothing.
 *   • Output: SCRATCH/results/reconcile-<scale>.jsonl (environment header, then `run`, `clone`,
 *     `sample` (every request incl. warm-ups), `series`, `sql-texts`, `child`, `event`, `summary`,
 *     `run-end` lines). Resumable: a warm variant with a complete series and cold / fresh-clone
 *     variants with enough samples for the same protocol and dataset build are skipped (only the
 *     missing reps run) unless --force. Child stderr: SCRATCH/logs/reconcile-<runId>.log.
 *
 * SAFETY GUARD
 *   • Refuses to run unless lib.mjs points at /tmp/p5a-pg/sock on port 55510 and every connection
 *     string (the process DATABASE_URL, each clone URL) passes lib.assertDisposableUrl. It creates,
 *     connects to and drops ONLY its own clones rec_<scale>_steady / rec_<scale>_fresh (lib.cloneDb:
 *     prefix check, <= 2 clones cluster-wide, >= 4 GiB of disk left); templates are never touched.
 *   • Writes data only on its own clones: the flips (identity_verifications.status and
 *     affiliate_orders.status of the listed pool members) and what the measured service writes.
 *   • pg_stat_statements: the counters of every EXISTING database are only read, never reset; the
 *     only reset is housekeeping of orphaned entries of databases that no longer exist (dropped
 *     clones), so the 5000-entry table does not overflow and evict live entries mid-request. A
 *     restart happens only when no other client is connected; one instance at a time (lock file in
 *     SCRATCH/work).
 *   • Never reads .env; never writes into the repository (--out only takes a file name, which goes
 *     to SCRATCH/results).
 *
 * Usage
 *   node --expose-gc scripts/perf/recruiter/bench-reconcile.mjs --scale 1k|10k|100k
 *     [--scenario <scenario|variant>[,…]] [--reps N] [--cold-samples N] [--warmups N] [--no-cold]
 *     [--timeout-s S] [--idle-wait-s S] [--clone-wait-s S] [--out <name.jsonl>] [--label text]
 *     [--force] [--list]
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  LOGS_DIR, MAX_CLONES, PG_LOG, PG_PORT, PG_SOCK, REPO, RESULTS_DIR, TEMPLATES, WORK_DIR,
  appendResult, assertDisposableUrl, cloneDb, clusterReady, connect, dbUrl, dropDb, freeDiskBytes, gc, heapUsed,
  importService, listClones, loadManifest, now, pgQuery, requireGc, restartPg, scaleKey, summarize,
} from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const HARNESS = 'bench-reconcile';
// Part of every protocolKey (resume never mixes versions). v1 (first 1k functional check only): the
// database's pg_stat_statements entries were reset before each request. v2: per-request DELTAS
// instead. v3: + housekeeping of orphaned entries of dropped databases before each measured request
// (a v2 pair sample had an entry evicted by the full 5000-entry table and was flagged incomplete).
const PROTOCOL_VERSION = 3;
const RESULT_MARK = 'P5A-REC-RESULT ';
const ADMIN_TAG = '/* p5a-rec-admin */'; // tags every harness-side (unmeasured) statement
const ADMIN_APP = 'p5a-rec-admin';
const CLONE_PREFIX = 'rec_';
const EXPECTED_SOCK = '/tmp/p5a-pg/sock';
const EXPECTED_PORT = 55510;
const DEFAULTS = Object.freeze({ warmups: 3, timeoutS: 600, idleWaitS: 300, cloneWaitS: 900 });
const FLIPS = Object.freeze({ pending_small: Object.freeze({ awards: 10, reversals: 5 }), pending_1000: Object.freeze({ awards: 800, reversals: 200 }) });
const COUNT_TABLES = Object.freeze(['recruiter_reward_ledger', 'recruiter_audit_log', 'affiliate_orders', 'identity_verifications', 'affiliates',
  'recruiter_affiliate_links', 'affiliate_payouts', 'recruiters', 'recruiter_settings_versions', 'recruiter_identity_verifications']);
const WRITABLE_TABLES = Object.freeze(['recruiter_reward_ledger', 'recruiter_audit_log']); // the only tables reconcile can write
const KINDS = Object.freeze(['SELECT', 'INSERT', 'advisoryLock', 'rowLock', 'BEGIN', 'COMMIT']);
const TX_COLUMNS = Object.freeze(['k', 'pid', 'outcome', 'startMs', 'wallMs', 'statements', 'sqlMs', 'affiliateLockMs', 'moneyLockMs', 'insertMs', 'commitMs', 'callMs']);
const BATCH_COLUMNS = Object.freeze(['startMs', 'ms', 'rows', 'kind', 'table', 'h', 'queued']);
const WRITE_OUTCOMES = Object.freeze(['AWARDED', 'REVERSED']);
const TEXT_MAX = 4000;
const LOG_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const PGSS_DB = '(SELECT oid FROM pg_database WHERE datname = current_database())';
const LOCK_WAIT_DEFINITION = 'client-observed ms of the pg_advisory_xact_lock statements (1st of a transaction = affiliate lock recruit:<id>, 2nd = money lock recruiter-money:<recruiterId> — the order of syncRecruiterReward) and of row-lock statements (FOR [NO KEY] UPDATE / [KEY] SHARE); includes the round trip, so an uncontended lock costs one round trip';
const OUT_RE = /^[A-Za-z0-9._-]{1,120}\.jsonl$/;

const VARIANTS = Object.freeze([
  { name: 'steady_scoped.warm', scenario: 'steady_scoped', kind: 'reconcile', scope: 'mixed', mode: 'warm', reps: 10, clone: 'steady', flips: null },
  { name: 'steady_all.warm', scenario: 'steady_all', kind: 'reconcile', scope: 'all', mode: 'warm', reps: 5, clone: 'steady', flips: null },
  { name: 'wallet_get.warm', scenario: 'wallet_get', kind: 'wallet', scope: 'mixed', mode: 'warm', reps: 20, clone: 'steady', flips: null },
  { name: 'steady_scoped.cold', scenario: 'steady_scoped', kind: 'reconcile', scope: 'mixed', mode: 'cold', reps: 3, clone: 'steady', flips: null },
  { name: 'pending_small', scenario: 'pending_small', kind: 'reconcile', scope: 'mixed', mode: 'pending', reps: 3, clone: 'fresh', flips: 'pending_small' },
  { name: 'pending_1000.scoped', scenario: 'pending_1000', kind: 'reconcile', scope: 'mixed', mode: 'pending', reps: 3, clone: 'fresh', flips: 'pending_1000' },
  { name: 'pending_1000.all', scenario: 'pending_1000', kind: 'reconcile', scope: 'all', mode: 'pending', reps: 1, clone: 'fresh', flips: 'pending_1000' },
  { name: 'concurrent_dup', scenario: 'concurrent_dup', kind: 'reconcile', scope: 'mixed', mode: 'pair', reps: 3, clone: 'fresh', flips: 'pending_1000' },
].map((v) => Object.freeze(v)));
const SCENARIOS = Object.freeze([...new Set(VARIANTS.map((v) => v.scenario))]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...xs) => process.stderr.write(`[${HARNESS} ${new Date().toISOString()}] ${xs.join(' ')}\n`);
const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const sum = (xs) => xs.reduce((a, b) => a + (typeof b === 'number' && Number.isFinite(b) ? b : 0), 0);
const hashText = (t) => createHash('sha1').update(String(t)).digest('hex').slice(0, 16);
const errInfo = (e) => (e ? { name: e.name ?? null, code: e.code ?? null, message: String(e.message ?? e).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 600) } : null);
const summ = (xs) => { const s = summarize(xs); return { n: s.n, min: r3(s.min), p50: r3(s.p50), p95: r3(s.p95), max: r3(s.max), mean: r3(s.mean) }; };
const pidsOf = (sl) => [...new Set(sl.sql.map((s) => s.pid).filter((p) => p !== null && p !== undefined))];
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ── guard ────────────────────────────────────────────────────────────────────
/** The URL of `db` on the disposable cluster — throws unless it is /tmp/p5a-pg/sock, port 55510. */
function guardUrl(db) {
  if (PG_SOCK !== EXPECTED_SOCK || PG_PORT !== EXPECTED_PORT) throw new Error(`${HARNESS}: REFUSED — lib.mjs does not point at ${EXPECTED_SOCK} on port ${EXPECTED_PORT}`);
  if (process.env.DATABASE_URL) assertDisposableUrl(process.env.DATABASE_URL);
  const url = dbUrl(db);
  assertDisposableUrl(url);
  const u = new URL(url);
  if (u.port !== String(EXPECTED_PORT) || u.searchParams.get('host') !== EXPECTED_SOCK) throw new Error(`${HARNESS}: REFUSED connection string of ${db}`);
  return url;
}

/** Only this harness's own clones (rec_…) are ever created, connected to or dropped. */
function guardClone(db) {
  if (typeof db !== 'string' || !db.startsWith(CLONE_PREFIX)) throw new Error(`${HARNESS}: REFUSED — only its own ${CLONE_PREFIX}* clones are used (got ${db})`);
  return guardUrl(db);
}

// ── harness-side admin connection (NOT the measured path) ───────────────────
class Admin {
  constructor(db) { this.db = db; this.client = null; }
  async ensure() {
    if (this.client) return this.client;
    const c = new pg.Client({ connectionString: guardClone(this.db), application_name: ADMIN_APP });
    await c.connect();
    await c.query(`${ADMIN_TAG} SET statement_timeout = '600s'`);
    this.client = c;
    return c;
  }
  async q(sql, params = []) { return (await (await this.ensure()).query(`${ADMIN_TAG} ${sql}`, params)).rows; }
  /** One query with session-local planner settings (validation only), in its own transaction. */
  async qWith(settings, sql, params = []) {
    const c = await this.ensure();
    await c.query(`${ADMIN_TAG} BEGIN`);
    try {
      for (const [k, v] of Object.entries(settings)) {
        if (!/^[a-z_]{1,63}$/.test(k) || !/^[A-Za-z0-9_]{1,32}$/.test(String(v))) throw new Error(`invalid setting ${k}`);
        await c.query(`${ADMIN_TAG} SET LOCAL ${k} = '${v}'`);
      }
      const rows = (await c.query(`${ADMIN_TAG} ${sql}`, params)).rows;
      await c.query(`${ADMIN_TAG} COMMIT`);
      return rows;
    } catch (e) {
      await c.query(`${ADMIN_TAG} ROLLBACK`).catch(() => null);
      throw e;
    }
  }
  async close() { const c = this.client; this.client = null; if (c) await c.end().catch(() => null); }
}

const countSql = (tables) => `SELECT ${tables.map((t) => `(SELECT count(*) FROM "${t}")::bigint AS "${t}"`).join(', ')}`;
const SEQ_SQL = 'SELECT (SELECT coalesce(max(seq), 0) FROM recruiter_reward_ledger)::text AS ledger, (SELECT coalesce(max(seq), 0) FROM recruiter_audit_log)::text AS audit';
const DEALLOC_SQL = 'SELECT dealloc::bigint::text AS dealloc FROM pg_stat_statements_info';

async function tableCounts(admin, tables = COUNT_TABLES) {
  const [r] = await admin.q(countSql(tables));
  return Object.fromEntries(tables.map((t) => [t, Number(r[t])]));
}
const diffCounts = (b, a) => Object.fromEntries(Object.keys(a).map((t) => [t, { before: b?.[t] ?? null, after: a[t], delta: b && Number.isFinite(b[t]) ? a[t] - b[t] : null }]));

/** pg_stat_statements counters of the CURRENT database (text only when asked: the before-snapshot skips it). */
function pgssSnapshotSql(withText) {
  return `SELECT userid::text AS userid, queryid::text AS queryid, toplevel, calls::text AS calls, total_exec_time, max_exec_time, rows::text AS rows,
      shared_blks_hit::text AS shared_blks_hit, shared_blks_read::text AS shared_blks_read, shared_blks_dirtied::text AS shared_blks_dirtied,
      shared_blks_written::text AS shared_blks_written, temp_blks_read::text AS temp_blks_read, temp_blks_written::text AS temp_blks_written,
      blk_read_time, blk_write_time, wal_records::text AS wal_records, wal_bytes::text AS wal_bytes${withText ? ', query' : ''}
    FROM pg_stat_statements(${withText ? 'true' : 'false'}) WHERE dbid = ${PGSS_DB}`;
}
/**
 * Housekeeping: drop the pg_stat_statements entries of databases that NO LONGER EXIST (every clone
 * has a new database OID, so dropped clones leave orphaned entries behind until the 5000-entry
 * table (pg_stat_statements.max) is full and new entries start evicting old ones — observed: 3644
 * of 4754 entries belonged to 59 dropped databases, and an entry of a measured run was evicted).
 * Entries of every existing database are never touched. `q(sql, params)` runs one statement.
 */
async function pgssDropStale(q) {
  const stale = await q('SELECT s.dbid::text AS dbid, count(*)::int AS n FROM pg_stat_statements(false) s WHERE NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.oid = s.dbid) GROUP BY 1');
  for (const r of stale) await q('SELECT pg_stat_statements_reset(0, $1::oid, 0)', [r.dbid]);
  const [t] = await q('SELECT count(*)::int AS n FROM pg_stat_statements(false)');
  return { droppedDatabases: stale.length, entriesRemoved: sum(stale.map((r) => r.n)), entriesAfter: t.n,
    what: 'pg_stat_statements_reset(0, <oid>, 0) for databases that no longer exist only' };
}
const PGSS_NUM = Object.freeze(['calls', 'total_exec_time', 'rows', 'shared_blks_hit', 'shared_blks_read', 'shared_blks_dirtied', 'shared_blks_written',
  'temp_blks_read', 'temp_blks_written', 'blk_read_time', 'blk_write_time', 'wal_records', 'wal_bytes']);
const pgssKey = (r) => `${r.userid}|${r.queryid}|${r.toplevel}`;

/**
 * Per-statement DELTA of the counters between a snapshot taken right before and one taken right
 * after the request (no reset). Harness statements (tagged p5a-rec-admin) are dropped; an entry
 * that disappeared or whose counters went down (eviction / a reset by someone else) is counted
 * as inconsistent. max_exec_time is only meaningful for entries created inside the window.
 */
function pgssDelta(before, after) {
  const prev = new Map((before ?? []).map((r) => [pgssKey(r), r]));
  const rows = [];
  let inconsistent = 0;
  let adminEntries = 0;
  for (const r of after) {
    if (String(r.query ?? '').includes('p5a-rec-admin')) { adminEntries += 1; continue; }
    const p = prev.get(pgssKey(r)) ?? null;
    const d = Object.fromEntries(PGSS_NUM.map((f) => [f, (Number(r[f]) || 0) - (p ? Number(p[f]) || 0 : 0)]));
    if (d.calls < 0) { inconsistent += 1; continue; }
    if (d.calls === 0) continue;
    rows.push({ ...d, queryid: r.queryid, toplevel: r.toplevel, query: r.query, isNew: !p, max_exec_time: p ? null : r.max_exec_time });
  }
  const afterKeys = new Set(after.map(pgssKey));
  const missingAfter = [...prev.keys()].filter((k) => !afterKeys.has(k)).length;
  return { rows, inconsistent, missingAfter, adminEntries };
}

async function cancelBackends(clone) {
  return pgQuery('postgres', `${ADMIN_TAG} SELECT pid, pg_cancel_backend(pid) AS done, state, left(query, 160) AS query FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid() AND coalesce(application_name, '') <> $2 AND state <> 'idle'`, [clone, ADMIN_APP]);
}

/** The measured client's backends of the clone (never the harness admin connection). */
async function terminateAppBackends(clone) {
  return pgQuery('postgres', `${ADMIN_TAG} SELECT pid, pg_terminate_backend(pid) AS done, state, left(query, 160) AS query FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid() AND coalesce(application_name, '') <> $2`, [clone, ADMIN_APP]);
}

/**
 * Per-request timeout. A reconcile is a long series of SHORT statements, so a single
 * pg_cancel_backend usually lands while the backend is idle (in transaction) and does nothing
 * (observed in the timeout test). On expiry the guard therefore re-sends the cancel every 500 ms
 * until it interrupts a running statement, and after 5 s escalates to terminating the measured
 * client's backends of the clone. Every attempt is recorded (the first 20).
 */
function timeoutGuard(clone, timeoutMs) {
  const state = { timedOut: false, attempts: [] };
  let interval = null;
  let firedAt = null;
  const tick = async () => {
    const atMs = Date.now() - firedAt;
    const action = atMs > 5000 ? 'terminate' : 'cancel';
    try {
      const rows = action === 'terminate' ? await terminateAppBackends(clone) : await cancelBackends(clone);
      if (state.attempts.length < 20) state.attempts.push({ atMs, action, backends: rows.map((r) => ({ pid: r.pid, done: r.done, state: r.state, query: r.query })) });
    } catch (e) {
      if (state.attempts.length < 20) state.attempts.push({ atMs, action, error: e.message });
    }
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    firedAt = Date.now();
    tick();
    interval = setInterval(tick, 500);
  }, timeoutMs);
  return { state, stop() { clearTimeout(timer); if (interval) clearInterval(interval); } };
}

async function terminateBackends(clone) {
  return pgQuery('postgres', `${ADMIN_TAG} SELECT pid, pg_terminate_backend(pid) AS terminated, state FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [clone]);
}

// ── SQL classification ───────────────────────────────────────────────────────
/** Statement kind: SELECT | INSERT | UPDATE | DELETE | advisoryLock | rowLock | BEGIN | COMMIT | ROLLBACK | utility | expression. */
function sqlKind(text) {
  const t = String(text ?? '').replace(/^(\s|\/\*[\s\S]*?\*\/)+/, '');
  if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(t)) return 'BEGIN';
  if (/^(COMMIT|END)\b/i.test(t)) return 'COMMIT';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/pg_advisory(_xact)?_lock/i.test(t)) return 'advisoryLock';
  if (/\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i.test(t)) return 'rowLock';
  if (/^(SELECT|WITH|VALUES|TABLE)\b/i.test(t)) return 'SELECT';
  if (/^INSERT\b/i.test(t)) return 'INSERT';
  if (/^UPDATE\b/i.test(t)) return 'UPDATE';
  if (/^DELETE\b/i.test(t)) return 'DELETE';
  if (/^(SET|SHOW|RESET|DEALLOCATE|DISCARD)\b/i.test(t)) return 'utility';
  return 'expression'; // e.g. a PL/pgSQL IF condition evaluated inside a trigger (pg_stat_statements, nested)
}
function rowLockMode(text) {
  const m = /\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i.exec(String(text ?? ''));
  return m ? m[1].replace(/\s+/g, ' ').toUpperCase() : null;
}
function sqlTable(text) {
  const m = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(String(text ?? ''));
  return m ? m[1] : null;
}

function unionMs(stmts) {
  const iv = stmts.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).map((s) => [s.start, s.end]).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = null;
  let ce = null;
  for (const [s, e] of iv) {
    if (cs === null) { cs = s; ce = e; } else if (s <= ce) ce = Math.max(ce, e); else { total += ce - cs; cs = s; ce = e; }
  }
  if (cs !== null) total += ce - cs;
  return total;
}

function lockAgg(xs) {
  const s = summarize(xs);
  return { n: xs.length, msSum: r3(sum(xs)), msMax: r3(s.max), p50: r3(s.p50), p95: r3(s.p95),
    over1ms: xs.filter((x) => x > 1).length, over10ms: xs.filter((x) => x > 10).length, over100ms: xs.filter((x) => x > 100).length };
}

/** Outcome of one syncRecruiterReward transaction, from the Prisma calls recorded inside it. */
function txOutcome(inside, call, tx) {
  if (!call) return 'UNMATCHED';
  if (call.error || tx?.end === 'ROLLBACK') return 'ERROR';
  const has = (op, model = null) => inside.some((c) => c.op === op && (model === null || c.model === model));
  if (!has('$executeRaw')) return 'NOT_LINKED';
  const created = has('create', 'recruiterRewardLedger');
  const threshold = has('findUnique', 'recruiterSettingsVersion'); // only the open-reward (reversal) branch reads it
  if (created) return threshold ? 'REVERSED' : 'AWARDED';
  if (threshold) return 'NO_CHANGE';
  return has('findFirst', 'recruiterSettingsVersion') ? 'NOT_QUALIFIED' : 'UNKNOWN';
}

/**
 * Client-side analysis of one measured slice: statements by kind and by text, transactions rebuilt
 * from the driver log (per backend pid: BEGIN … COMMIT/ROLLBACK), matched in order to the recorded
 * interactive $transaction calls (sequential within one recorder), lock statements, batched reads.
 * → { out (written to the sample), txInfo (internal), locks (internal raw lists) }
 */
function analyzeClient(ctx, sl, seenPids = null) {
  const t0 = sl.start;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { n: 0, ms: 0, msMax: 0, rows: 0 }]));
  const byText = new Map();
  const rowLockModes = {};
  const pids = new Set();
  const newPids = [];
  const open = new Map();
  const txs = [];
  const auto = [];
  let queued = 0;
  let sqlErrors = 0;
  for (const s of sl.sql) {
    const kind = sqlKind(s.text);
    s.kind = kind;
    const ms = Number.isFinite(s.ms) ? s.ms : 0;
    const rows = Number.isFinite(s.rows) ? s.rows : 0;
    const k = byKind[kind] ?? (byKind[kind] = { n: 0, ms: 0, msMax: 0, rows: 0 });
    k.n += 1; k.ms += ms; k.msMax = Math.max(k.msMax, ms); k.rows += rows;
    const h = ctx.textHash(s.text);
    const t = byText.get(h) ?? { h, kind, table: sqlTable(s.text), n: 0, ms: 0, msMax: 0, rows: 0, errors: 0 };
    t.n += 1; t.ms += ms; t.msMax = Math.max(t.msMax, ms); t.rows += rows;
    if (s.error) { t.errors += 1; sqlErrors += 1; }
    byText.set(h, t);
    if (kind === 'rowLock') { const mode = rowLockMode(s.text); rowLockModes[mode] = (rowLockModes[mode] ?? 0) + 1; }
    if (s.queued) queued += 1;
    if (s.pid !== null && s.pid !== undefined) {
      pids.add(s.pid);
      if (seenPids && !seenPids.has(s.pid)) { seenPids.add(s.pid); newPids.push(s.pid); }
    }
    if (kind === 'BEGIN') { const tx = { pid: s.pid, stmts: [s], end: null }; open.set(s.pid, tx); txs.push(tx); continue; }
    const tx = open.get(s.pid);
    if (tx) {
      tx.stmts.push(s);
      if (kind === 'COMMIT' || kind === 'ROLLBACK') { tx.end = kind; open.delete(s.pid); }
    } else auto.push(s);
  }
  const txCalls = sl.calls.filter((c) => c.op === '$transaction' && c.kind === 'interactive');
  const inside = new Map();
  for (const c of sl.calls) {
    if (c.op === '$transaction' || c.txId === null || c.txId === undefined) continue;
    const l = inside.get(c.txId) ?? [];
    l.push(c);
    inside.set(c.txId, l);
  }
  const byOutcome = {};
  const txRows = [];
  const txInfo = [];
  const locks = { affiliate: [], money: [], otherAdvisory: [], rowLock: [] };
  txs.forEach((tx, k) => {
    const call = txCalls[k] ?? null;
    const outcome = txOutcome(call ? inside.get(call.txId) ?? [] : [], call, tx);
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
    const adv = tx.stmts.filter((s) => s.kind === 'advisoryLock');
    if (adv[0]) locks.affiliate.push(adv[0].ms);
    if (adv[1]) locks.money.push(adv[1].ms);
    for (const s of adv.slice(2)) locks.otherAdvisory.push(s.ms);
    const sqlMs = sum(tx.stmts.map((s) => s.ms));
    const first = tx.stmts[0];
    const last = tx.stmts[tx.stmts.length - 1];
    const ins = tx.stmts.filter((s) => s.kind === 'INSERT');
    const commit = tx.stmts.find((s) => s.kind === 'COMMIT' || s.kind === 'ROLLBACK');
    const kinds = {};
    for (const s of tx.stmts) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    txInfo.push({ outcome, statements: tx.stmts.length, sqlMs, kinds });
    txRows.push([k, tx.pid, outcome, r3(first.start - t0), r3((last.end ?? last.start) - first.start), tx.stmts.length, r3(sqlMs),
      adv[0] ? r3(adv[0].ms) : null, adv[1] ? r3(adv[1].ms) : null, ins.length ? r3(sum(ins.map((s) => s.ms))) : null, commit ? r3(commit.ms) : null, call ? r3(call.ms) : null]);
  });
  for (const s of auto) if (s.kind === 'advisoryLock') locks.otherAdvisory.push(s.ms);
  for (const s of sl.sql) if (s.kind === 'rowLock') locks.rowLock.push(s.ms);
  const union = unionMs(sl.sql);
  const roundAgg = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, ms: r3(v.ms), msMax: r3(v.msMax) }]));
  const out = {
    calls: sl.summary.calls, callMsSum: r3(sl.summary.callMsSum), callErrors: sl.summary.errors, interactiveTransactions: txCalls.length,
    sqlStatements: sl.sql.length, sqlMsSum: r3(sl.summary.sqlMsSum), sqlMsMax: r3(sl.summary.sqlMsMax), sqlUnionMs: r3(union),
    outsideSqlMs: r3(sl.wallMs - union), sqlErrors, queuedStatements: queued,
    byKind: roundAgg(byKind), rowLockModes,
    byText: [...byText.values()].map((t) => ({ ...t, ms: r3(t.ms), msMax: r3(t.msMax) })).sort((x, y) => y.ms - x.ms),
    transactions: { sql: txs.length, calls: txCalls.length, matched: txs.length === txCalls.length, unclosed: open.size, byOutcome,
      statements: sum(txInfo.map((t) => t.statements)), sqlMs: r3(sum(txInfo.map((t) => t.sqlMs))), columns: TX_COLUMNS, rows: txRows },
    batchedReads: { statements: auto.length, sqlMs: r3(sum(auto.map((s) => s.ms))), rows: sum(auto.map((s) => s.rows ?? 0)), columns: BATCH_COLUMNS,
      list: auto.map((s) => [r3(s.start - t0), r3(s.ms), s.rows ?? null, s.kind, sqlTable(s.text), ctx.textHash(s.text), s.queued ?? 0]) },
    lockWait: { definition: LOCK_WAIT_DEFINITION, affiliateLock: lockAgg(locks.affiliate), moneyLock: lockAgg(locks.money),
      otherAdvisory: lockAgg(locks.otherAdvisory), rowLock: lockAgg(locks.rowLock),
      clientLockMs: r3(sum(locks.affiliate) + sum(locks.money) + sum(locks.otherAdvisory) + sum(locks.rowLock)) },
    pids: [...pids], newBackendsSincePreviousRequests: seenPids ? newPids.length : null,
  };
  return { out, txInfo, locks };
}

/** Duplicated work of two concurrent runs: minimal = ONE run's batched reads + the writing transactions. */
function duplication(A, B) {
  const writing = { n: 0, statements: 0, sqlMs: 0 };
  const wasted = { n: 0, statements: 0, sqlMs: 0, byOutcome: {}, byKind: {} };
  for (const r of [A, B]) {
    for (const t of r.txInfo) {
      const w = WRITE_OUTCOMES.includes(t.outcome);
      const g = w ? writing : wasted;
      g.n += 1; g.statements += t.statements; g.sqlMs += t.sqlMs;
      if (!w) {
        wasted.byOutcome[t.outcome] = (wasted.byOutcome[t.outcome] ?? 0) + 1;
        for (const [k, n] of Object.entries(t.kinds)) wasted.byKind[k] = (wasted.byKind[k] ?? 0) + n;
      }
    }
  }
  const batches = [A, B].map((r) => ({ statements: r.out.batchedReads.statements, sqlMs: r.out.batchedReads.sqlMs ?? 0, rows: r.out.batchedReads.rows }));
  const lo = batches[0].statements <= batches[1].statements ? 0 : 1;
  const total = { statements: A.out.sqlStatements + B.out.sqlStatements, sqlMs: (A.out.sqlMsSum ?? 0) + (B.out.sqlMsSum ?? 0) };
  const minimal = { statements: batches[lo].statements + writing.statements, sqlMs: batches[lo].sqlMs + writing.sqlMs };
  return {
    definition: "minimal = one run's batched reads + the transactions that wrote (what ONE uncontended run does); duplicated = both runs' statements − minimal = the other run's batched reads + every transaction that ended without a write",
    total: { statements: total.statements, sqlMs: r3(total.sqlMs) },
    minimal: { statements: minimal.statements, sqlMs: r3(minimal.sqlMs) },
    duplicated: { statements: total.statements - minimal.statements, sqlMs: r3(total.sqlMs - minimal.sqlMs),
      statementRatio: minimal.statements ? r3(total.statements / minimal.statements) : null },
    batchedReadsPerRun: batches.map((b) => ({ ...b, sqlMs: r3(b.sqlMs) })),
    writingTransactions: { n: writing.n, statements: writing.statements, sqlMs: r3(writing.sqlMs) },
    wastedTransactions: { n: wasted.n, statements: wasted.statements, sqlMs: r3(wasted.sqlMs), byOutcome: wasted.byOutcome, byKind: wasted.byKind },
  };
}

// ── server side: pg_stat_statements + PostgreSQL log ─────────────────────────
/** Toplevel (client) vs nested (inside triggers / functions, track = all) counts of the delta rows. */
function pgssSummary(ctx, delta, { excludeConnectProbe = false } = {}) {
  const agg = () => ({ calls: 0, totalExecMs: 0, rows: 0, sharedBlksHit: 0, sharedBlksRead: 0, sharedBlksDirtied: 0, sharedBlksWritten: 0,
    tempBlksRead: 0, tempBlksWritten: 0, blkReadMs: 0, walRecords: 0, walBytes: 0, byKind: {}, rowLockModes: {} });
  const out = { method: 'delta of pg_stat_statements counters between snapshots taken right before and right after the request (no reset); this database only',
    toplevel: agg(), nested: agg(), excluded: [], statements: [], inconsistentEntries: delta.inconsistent, entriesMissingAfter: delta.missingAfter,
    complete: delta.inconsistent === 0 && delta.missingAfter === 0 };
  for (const r of delta.rows) {
    const text = String(r.query ?? '');
    if (excludeConnectProbe && r.toplevel && /^\s*SELECT \$1\s*$/i.test(text)) {
      out.excluded.push({ reason: "connect() pool warm-up probe ('SELECT 1'), before the timed request", calls: r.calls, h: ctx.textHash(text) });
      continue;
    }
    const kind = sqlKind(text);
    const g = r.toplevel ? out.toplevel : out.nested;
    const k = g.byKind[kind] ?? (g.byKind[kind] = { calls: 0, totalExecMs: 0, maxExecMsOfNewEntries: null, rows: 0 });
    k.calls += r.calls; k.totalExecMs += r.total_exec_time; k.rows += r.rows;
    if (Number.isFinite(r.max_exec_time)) k.maxExecMsOfNewEntries = Math.max(k.maxExecMsOfNewEntries ?? 0, r.max_exec_time);
    if (kind === 'rowLock') { const mode = rowLockMode(text); g.rowLockModes[mode] = (g.rowLockModes[mode] ?? 0) + r.calls; }
    g.calls += r.calls; g.totalExecMs += r.total_exec_time; g.rows += r.rows;
    g.sharedBlksHit += r.shared_blks_hit; g.sharedBlksRead += r.shared_blks_read; g.sharedBlksDirtied += r.shared_blks_dirtied; g.sharedBlksWritten += r.shared_blks_written;
    g.tempBlksRead += r.temp_blks_read; g.tempBlksWritten += r.temp_blks_written; g.blkReadMs += r.blk_read_time; g.walRecords += r.wal_records; g.walBytes += r.wal_bytes;
    out.statements.push({ h: ctx.textHash(text), queryid: r.queryid, toplevel: r.toplevel, kind, table: sqlTable(text), isNew: r.isNew, calls: r.calls,
      totalExecMs: r3(r.total_exec_time), maxExecMs: r3(r.max_exec_time), rows: r.rows, sharedBlksHit: r.shared_blks_hit, sharedBlksRead: r.shared_blks_read,
      sharedBlksDirtied: r.shared_blks_dirtied, sharedBlksWritten: r.shared_blks_written, tempBlksWritten: r.temp_blks_written, blkReadMs: r3(r.blk_read_time), walBytes: r.wal_bytes });
  }
  for (const g of [out.toplevel, out.nested]) {
    g.totalExecMs = r3(g.totalExecMs);
    g.blkReadMs = r3(g.blkReadMs);
    for (const k of Object.values(g.byKind)) { k.totalExecMs = r3(k.totalExecMs); k.maxExecMsOfNewEntries = r3(k.maxExecMsOfNewEntries); }
  }
  out.statements.sort((x, y) => (y.totalExecMs ?? 0) - (x.totalExecMs ?? 0));
  return out;
}

/** Sizes of the PostgreSQL log files (logging_collector), to read only what a run appended. */
function logSnapshot() {
  try {
    return { files: Object.fromEntries(readdirSync(PG_LOG).filter((f) => f.endsWith('.log')).map((f) => [f, statSync(join(PG_LOG, f)).size])) };
  } catch (e) { return { error: String(e.message) }; }
}

/** log_lock_waits / deadlock lines appended since `snap` that belong to the backends `pids`. */
function logScan(snap, pids) {
  if (!snap || snap.error) return { error: snap?.error ?? 'no log snapshot' };
  const pidSet = new Set(pids.map(Number));
  const out = { entries: [], stillWaiting: 0, acquired: 0, deadlocks: 0, maxReportedWaitMs: null, bytesScanned: 0, truncated: false, pidsWatched: pids.length };
  let files;
  try { files = readdirSync(PG_LOG).filter((f) => f.endsWith('.log')).sort(); } catch (e) { return { error: String(e.message) }; }
  const LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? \S+) \[(\d+)\] ([A-Z]+):\s+(.*)$/;
  const WAIT = /^process (\d+) (still waiting for|acquired|avoided deadlock for|detected deadlock while waiting for) (.*?) after ([\d.]+) ms/;
  for (const f of files) {
    const path = join(PG_LOG, f);
    let size;
    try { size = statSync(path).size; } catch { continue; }
    const from = snap.files[f] ?? 0;
    if (size <= from) continue;
    const len = Math.min(size - from, LOG_SCAN_MAX_BYTES - out.bytesScanned);
    if (len <= 0) { out.truncated = true; break; }
    const buf = Buffer.alloc(len);
    try {
      const fd = openSync(path, 'r');
      try { readSync(fd, buf, 0, len, from); } finally { closeSync(fd); }
    } catch (e) { return { ...out, error: String(e.message) }; }
    out.bytesScanned += len;
    let last = null;
    for (const line of buf.toString('utf8').split('\n')) {
      const m = LINE.exec(line);
      if (!m) continue;
      const pid = Number(m[2]);
      if (!pidSet.has(pid)) { last = null; continue; }
      if (m[3] === 'DETAIL' && last) { last.detail = m[4].slice(0, 300); continue; }
      last = null;
      const w = WAIT.exec(m[4]);
      if (w) {
        const ms = Number(w[4]);
        last = { file: f, ts: m[1], pid, level: m[3], event: w[2], lock: w[3].slice(0, 200), afterMs: ms };
        out.entries.push(last);
        if (w[2] === 'still waiting for') out.stillWaiting += 1;
        if (w[2] === 'acquired') out.acquired += 1;
        out.maxReportedWaitMs = Math.max(out.maxReportedWaitMs ?? 0, ms);
      } else if (/deadlock detected/i.test(m[4])) {
        out.deadlocks += 1;
        last = { file: f, ts: m[1], pid, level: m[3], event: 'deadlock detected', message: m[4].slice(0, 300) };
        out.entries.push(last);
      }
    }
  }
  out.entries = out.entries.slice(0, 200);
  return out;
}

// ── dataset expectations, flips, verification ───────────────────────────────
function flipPlan(m, name) {
  if (!name) return null;
  const want = FLIPS[name];
  const awards = m.pools.P_AWARD.slice(0, want.awards);
  const reversals = m.pools.P_REVERSE.slice(0, want.reversals);
  const cancelOrderIds = reversals.map((id) => m.pools.P_REVERSE_cancelOrderId[id]);
  if (cancelOrderIds.some((x) => typeof x !== 'string')) throw new Error('manifest: P_REVERSE_cancelOrderId is incomplete');
  return { name, requested: { ...want }, awards, reversals, cancelOrderIds, poolLimited: awards.length < want.awards || reversals.length < want.reversals,
    poolSizes: { P_AWARD: m.pools.P_AWARD.length, P_REVERSE: m.pools.P_REVERSE.length } };
}

function expectations(m, v) {
  const f = flipPlan(m, v.flips);
  return { checked: v.scope === 'all' ? m.rowCounts.recruiter_affiliate_links : m.shapes.mixed.members, awarded: f ? f.awards.length : 0, reversed: f ? f.reversals.length : 0 };
}

async function scopeLinkCount(admin, recruiterId) {
  const [r] = await admin.q('SELECT count(*)::int AS n FROM recruiter_affiliate_links WHERE $1::text IS NULL OR "recruiterId" = $1', [recruiterId]);
  return r.n;
}

async function currentSettings(admin) {
  const [r] = await admin.q('SELECT version, enabled, "rewardAmountCents", "minDeliveredSales" FROM recruiter_settings_versions ORDER BY version DESC LIMIT 1');
  return r ?? null;
}

/** State of the pool members BEFORE the flips (identity, real delivered orders, link, ledger rows). */
async function poolPrecheck(admin, plan, mixedId) {
  const ids = [...plan.awards, ...plan.reversals];
  const members = await admin.q(`SELECT a.id, i.status AS identity, l."recruiterId" AS recruiter,
      (SELECT count(*)::int FROM affiliate_orders o WHERE o."affiliateId" = a.id AND o.status = 'delivered' AND NOT o."isFake") AS delivered
    FROM affiliates a LEFT JOIN identity_verifications i ON i."affiliateId" = a.id LEFT JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id
    WHERE a.id = ANY($1::text[])`, [ids]);
  const orders = await admin.q('SELECT id, "affiliateId", status, "isFake" FROM affiliate_orders WHERE id = ANY($1::text[])', [plan.cancelOrderIds]);
  const ledgerBefore = await admin.q(`SELECT "affiliateId", type, cycle, "amountCents", "settingsVersion", "recruiterId" FROM recruiter_reward_ledger
    WHERE "affiliateId" = ANY($1::text[]) AND type IN ('RECRUIT_REWARD', 'REVERSAL')`, [ids]);
  const byId = new Map(members.map((r) => [r.id, r]));
  const problems = [];
  for (const id of plan.awards) {
    const r = byId.get(id);
    if (!r || r.identity !== 'PENDING' || r.delivered !== 5 || r.recruiter !== mixedId) problems.push({ id, pool: 'P_AWARD', state: r ?? null });
  }
  for (const id of plan.reversals) {
    const r = byId.get(id);
    if (!r || r.identity !== 'APPROVED' || r.delivered !== 5 || r.recruiter !== mixedId) problems.push({ id, pool: 'P_REVERSE', state: r ?? null });
  }
  const ordById = new Map(orders.map((o) => [o.id, o]));
  plan.reversals.forEach((id, k) => {
    const o = ordById.get(plan.cancelOrderIds[k]);
    if (!o || o.affiliateId !== id || o.status !== 'delivered' || o.isFake) problems.push({ id, pool: 'P_REVERSE_cancelOrderId', order: o ?? null });
  });
  return { members: members.length, problemCount: problems.length, problems: problems.slice(0, 20), ledgerBefore };
}

/** The ledger rows the reconcile must write for these flips (computed from the pre-flip ledger). */
function expectedLedgerRows(plan, ledgerBefore, settings, mixedId) {
  const st = new Map();
  for (const r of ledgerBefore) {
    const s = st.get(r.affiliateId) ?? { maxReward: 0, reward: null, maxReversal: 0 };
    if (r.type === 'RECRUIT_REWARD' && r.cycle > s.maxReward) { s.maxReward = r.cycle; s.reward = r; }
    if (r.type === 'REVERSAL' && r.cycle > s.maxReversal) s.maxReversal = r.cycle;
    st.set(r.affiliateId, s);
  }
  const rows = [];
  const problems = [];
  for (const id of plan.awards) {
    const s = st.get(id) ?? { maxReward: 0, reward: null, maxReversal: 0 };
    if (s.reward && s.maxReward > s.maxReversal) problems.push({ id, problem: 'P_AWARD member already has an open reward' });
    const cycle = s.maxReward + 1;
    rows.push({ affiliateId: id, type: 'RECRUIT_REWARD', recruiterId: mixedId, amountCents: settings.rewardAmountCents, cycle, settingsVersion: settings.version, idempotencyKey: `recruit:${id}:v${cycle}` });
  }
  for (const id of plan.reversals) {
    const s = st.get(id);
    const open = s && s.reward && s.maxReward > s.maxReversal ? s.reward : null;
    if (!open) { problems.push({ id, problem: 'P_REVERSE member has no open reward' }); continue; }
    rows.push({ affiliateId: id, type: 'REVERSAL', recruiterId: open.recruiterId, amountCents: -open.amountCents, cycle: open.cycle,
      settingsVersion: open.settingsVersion, idempotencyKey: `reverse:${id}:v${open.cycle}` });
  }
  return { rows, problems };
}

async function applyFlips(admin, plan) {
  const t0 = now();
  const a = await admin.q(`UPDATE identity_verifications SET status = 'APPROVED', "approvedAt" = (now() AT TIME ZONE 'UTC'), "approvedBy" = 'p5a-bench-reconcile',
      "rejectionReason" = NULL, "updatedAt" = (now() AT TIME ZONE 'UTC') WHERE "affiliateId" = ANY($1::text[]) AND status = 'PENDING' RETURNING "affiliateId"`, [plan.awards]);
  const r = await admin.q(`UPDATE affiliate_orders SET status = 'cancelled' WHERE id = ANY($1::text[]) AND status = 'delivered' AND NOT "isFake" RETURNING id`, [plan.cancelOrderIds]);
  return {
    approvedIdentities: a.length, cancelledOrders: r.length, ms: r3(now() - t0), ok: a.length === plan.awards.length && r.length === plan.reversals.length,
    how: "identity_verifications PENDING → APPROVED (approvedAt, approvedBy, updatedAt set, rejectionReason cleared — the columns adminApproveIdentity sets; its post-commit reward hook is deliberately NOT run); affiliate_orders.status 'delivered' → 'cancelled' for the listed P_REVERSE_cancelOrderId rows",
  };
}

const AUDIT_ACTION = Object.freeze({ RECRUIT_REWARD: 'RECRUIT_REWARD_EARNED', REVERSAL: 'RECRUIT_REWARD_REVERSED' });

/** New ledger + audit rows (seq above the pre-run marks) against the expected rows. */
async function verifyNewRows(admin, seqBefore, expectedRows) {
  const ledger = await admin.q(`SELECT seq::text AS seq, "affiliateId", "recruiterId", type, "amountCents", cycle, "settingsVersion", "idempotencyKey", "actorType", reason
    FROM recruiter_reward_ledger WHERE seq > $1::bigint ORDER BY seq`, [seqBefore.ledger]);
  const audit = await admin.q(`SELECT seq::text AS seq, action, "entityType", "entityId", "recruiterId", "actorType", details
    FROM recruiter_audit_log WHERE seq > $1::bigint ORDER BY seq`, [seqBefore.audit]);
  const want = new Map(expectedRows.map((e) => [`${e.affiliateId}|${e.type}`, e]));
  const seen = new Set();
  const mismatches = [];
  let matched = 0;
  for (const r of ledger) {
    const key = `${r.affiliateId}|${r.type}`;
    const e = want.get(key);
    if (!e) { mismatches.push({ unexpected: r }); continue; }
    if (seen.has(key)) { mismatches.push({ duplicate: r }); continue; }
    seen.add(key);
    const bad = ['recruiterId', 'amountCents', 'cycle', 'settingsVersion', 'idempotencyKey'].filter((f) => r[f] !== e[f]);
    if (r.actorType !== 'SYSTEM') bad.push('actorType');
    if (bad.length) mismatches.push({ fields: bad, row: r, expected: e }); else matched += 1;
  }
  const missing = expectedRows.filter((e) => !seen.has(`${e.affiliateId}|${e.type}`)).length;
  const auditByKey = new Map();
  let auditDuplicates = 0;
  for (const a of audit) {
    const key = `${a.entityId}|${a.action}`;
    if (auditByKey.has(key)) auditDuplicates += 1;
    auditByKey.set(key, a);
  }
  const auditMismatches = [];
  let auditMatched = 0;
  for (const r of ledger) {
    const a = auditByKey.get(`${r.affiliateId}|${AUDIT_ACTION[r.type]}`);
    if (!a) { auditMismatches.push({ missingFor: { affiliateId: r.affiliateId, type: r.type } }); continue; }
    const d = a.details ?? {};
    const bad = [];
    if (a.recruiterId !== r.recruiterId) bad.push('recruiterId');
    if (a.entityType !== 'affiliate') bad.push('entityType');
    if (a.actorType !== 'SYSTEM') bad.push('actorType');
    if (Number(d.cycle) !== r.cycle) bad.push('details.cycle');
    if (Number(d.amountCents) !== r.amountCents) bad.push('details.amountCents');
    if (Number(d.settingsVersion) !== r.settingsVersion) bad.push('details.settingsVersion');
    if (bad.length) auditMismatches.push({ fields: bad, affiliateId: r.affiliateId, type: r.type }); else auditMatched += 1;
  }
  const auditOther = audit.filter((a) => !Object.values(AUDIT_ACTION).includes(a.action)).length;
  const newRewards = ledger.filter((r) => r.type === 'RECRUIT_REWARD').length;
  const newReversals = ledger.filter((r) => r.type === 'REVERSAL').length;
  return {
    expectedRows: expectedRows.length, newLedgerRows: ledger.length, newRewards, newReversals, matched, missing, mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 20),
    newAuditRows: audit.length, auditMatched, auditDuplicates, auditOther, auditMismatchCount: auditMismatches.length, auditMismatches: auditMismatches.slice(0, 20),
    ledgerExact: matched === expectedRows.length && missing === 0 && mismatches.length === 0 && ledger.length === expectedRows.length,
    auditEqualsLedger: audit.length === ledger.length && auditMatched === ledger.length && auditDuplicates === 0 && auditOther === 0,
  };
}

const INVARIANT_SQL = `WITH c AS (
    SELECT "affiliateId" AS a, cycle,
      count(*) FILTER (WHERE type = 'RECRUIT_REWARD')::int AS n_rw, count(*) FILTER (WHERE type = 'REVERSAL')::int AS n_rv,
      min("amountCents") FILTER (WHERE type = 'RECRUIT_REWARD') AS rw_amt, min("amountCents") FILTER (WHERE type = 'REVERSAL') AS rv_amt,
      min("recruiterId") FILTER (WHERE type = 'RECRUIT_REWARD') AS rw_rec, min("recruiterId") FILTER (WHERE type = 'REVERSAL') AS rv_rec,
      min("settingsVersion") FILTER (WHERE type = 'RECRUIT_REWARD') AS rw_ver, min("settingsVersion") FILTER (WHERE type = 'REVERSAL') AS rv_ver
    FROM recruiter_reward_ledger WHERE type IN ('RECRUIT_REWARD', 'REVERSAL') GROUP BY 1, 2
  ), a AS (
    SELECT a, max(cycle) FILTER (WHERE n_rw > 0) AS max_rw, count(*) FILTER (WHERE n_rw > 0)::int AS n_rw_cycles,
      count(*) FILTER (WHERE n_rw > 0 AND n_rv = 0)::int AS open_cycles
    FROM c GROUP BY 1
  )
  SELECT
    (SELECT count(*) FROM c WHERE n_rw > 1)::int AS dup_rewards,
    (SELECT count(*) FROM c WHERE n_rv > 1)::int AS dup_reversals,
    (SELECT count(*) FROM c WHERE n_rv > 0 AND n_rw = 0)::int AS reversal_without_reward,
    (SELECT count(*) FROM c WHERE n_rv > 0 AND n_rw > 0 AND rv_amt <> -rw_amt)::int AS reversal_amount_mismatch,
    (SELECT count(*) FROM c WHERE n_rv > 0 AND n_rw > 0 AND rv_rec <> rw_rec)::int AS reversal_recruiter_mismatch,
    (SELECT count(*) FROM c WHERE n_rv > 0 AND n_rw > 0 AND rv_ver IS DISTINCT FROM rw_ver)::int AS reversal_version_mismatch,
    (SELECT count(*) FROM a WHERE n_rw_cycles <> coalesce(max_rw, 0))::int AS reward_cycle_gaps,
    (SELECT count(*) FROM a WHERE open_cycles > 1)::int AS multiple_open_cycles,
    (SELECT count(*) FROM c JOIN a USING (a) WHERE c.n_rw > 0 AND c.n_rv = 0 AND c.cycle <> a.max_rw)::int AS open_cycle_not_latest,
    (SELECT count(*) FROM c)::int AS cycles, (SELECT count(*) FROM a)::int AS affiliates,
    (SELECT coalesce(sum(open_cycles), 0) FROM a)::int AS open_cycles, (SELECT count(*) FROM recruiter_reward_ledger)::int AS ledger_rows`;
const INVARIANT_ZERO = Object.freeze(['dup_rewards', 'dup_reversals', 'reversal_without_reward', 'reversal_amount_mismatch', 'reversal_recruiter_mismatch',
  'reversal_version_mismatch', 'reward_cycle_gaps', 'multiple_open_cycles', 'open_cycle_not_latest']);

/** Global ledger invariants (validation query; session-local enable_nestloop = off, never the measured path). */
async function ledgerInvariants(admin) {
  const t0 = now();
  const [r] = await admin.qWith({ enable_nestloop: 'off' }, INVARIANT_SQL);
  return { ...r, ok: INVARIANT_ZERO.every((k) => r[k] === 0), ms: r3(now() - t0), settings: 'enable_nestloop = off (session-local, validation only)' };
}

// ── child: shared pieces ─────────────────────────────────────────────────────
function makeCtx(spec) {
  const m = loadManifest(spec.scale);
  const v = VARIANTS.find((x) => x.name === spec.variant);
  if (!v) throw new Error(`unknown variant ${spec.variant}`);
  const seenTexts = new Set();
  let pendingTexts = [];
  return {
    spec, m, v, out: spec.out, svc: null, walletMod: null, importMs: null, heapCost: null,
    textHash(t) {
      const s = String(t ?? '');
      const h = hashText(s);
      if (!seenTexts.has(h)) { seenTexts.add(h); pendingTexts.push({ h, length: s.length, truncated: s.length > TEXT_MAX, text: s.slice(0, TEXT_MAX) }); }
      return h;
    },
    async flushTexts() {
      if (!pendingTexts.length) return;
      const texts = pendingTexts;
      pendingTexts = [];
      await appendResult(spec.out, { type: 'sql-texts', runId: spec.runId, childId: spec.childId, texts });
    },
    base() {
      return { harness: HARNESS, protocolVersion: PROTOCOL_VERSION, protocolKey: spec.protocolKey, runId: spec.runId, childId: spec.childId, scale: spec.scale,
        buildId: m.buildId, variant: v.name, scenario: v.scenario, scope: v.scope === 'all' ? 'all recruiters' : 'rec_mixed', clone: spec.clone, label: spec.label ?? null };
    },
  };
}

function calibrateHeapCost(n = 20000) {
  const t = now();
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += process.memoryUsage().heapUsed;
  return { usPerSample: r3(((now() - t) / n) * 1000), calibrationSamples: n, meanHeapUsed: Math.round(acc / n) };
}

/**
 * lib.connect() + an 'error' listener on its pg.Pool: a backend terminated by the timeout guard
 * makes an IDLE pool client emit 'error', which would crash the process without a listener.
 */
async function connectMeasured(clone) {
  const conn = await connect(clone, { bytes: false });
  conn.pool.on('error', (e) => log(`pool error on ${clone} (expected only after a timeout): ${e?.message ?? e}`));
  return conn;
}

/** One measured request: explicit gc → baseline; on timeout the guard interrupts the request (see timeoutGuard). */
async function measureOnce(ctx, conn, label, fn) {
  gc();
  const baseline = heapUsed();
  const startedAt = new Date().toISOString();
  const guard = timeoutGuard(ctx.spec.clone, ctx.spec.timeoutS * 1000);
  let sl;
  try { sl = await conn.measure(label, fn); } finally { guard.stop(); }
  return { sl, baseline, startedAt, timedOut: guard.state.timedOut, cancel: guard.state.timedOut ? guard.state.attempts : null };
}

function heapBlock(ctx, sl, baseline) {
  const peak = sl.summary.heapPeak;
  return { baselineAfterGc: baseline, start: sl.summary.heapStart, peak, end: sl.summary.heapEnd, peakMinusBaseline: Number.isFinite(peak) ? peak - baseline : null,
    samples: sl.heap.length, afterGcMinusBaseline: null,
    samplingCostEstimateMs: r3((sl.heap.length * (ctx.heapCost?.usPerSample ?? 0)) / 1000) };
}

/** Release the request's records, measure what stays (after gc), write the texts, then the sample. */
async function emit(ctx, conns, sample, baseline) {
  for (const c of conns) c.rec.reset();
  gc();
  if (sample.heap && Number.isFinite(baseline)) sample.heap.afterGcMinusBaseline = heapUsed() - baseline;
  await ctx.flushTexts();
  await appendResult(ctx.out, sample);
}

async function preMeasure(admin, tables) {
  const counts = await tableCounts(admin, tables);
  const [seq] = await admin.q(SEQ_SQL);
  const pgssHousekeeping = await pgssDropStale((sql, params) => admin.q(sql, params));
  const [d] = await admin.q(DEALLOC_SQL);
  const pgssBefore = await admin.q(pgssSnapshotSql(false));
  return { counts, seq, pgssDeallocBefore: Number(d.dealloc), pgssBefore, pgssHousekeeping, logOffsets: logSnapshot() };
}

async function postMeasure(ctx, admin, pre, pids, tables, { excludeConnectProbe = false, sameServerLifetime = true } = {}) {
  const after = await admin.q(pgssSnapshotSql(true));
  const [d] = await admin.q(DEALLOC_SQL);
  const counts = await tableCounts(admin, tables);
  const pgss = pgssSummary(ctx, pgssDelta(pre.pgssBefore, after), { excludeConnectProbe });
  pgss.housekeeping = pre.pgssHousekeeping ?? null;
  pgss.deallocBefore = pre.pgssDeallocBefore;
  pgss.deallocAfter = Number(d.dealloc);
  pgss.deallocDuringRun = sameServerLifetime && Number.isFinite(pre.pgssDeallocBefore) ? Number(d.dealloc) - pre.pgssDeallocBefore : null;
  if (!sameServerLifetime) pgss.note = 'before-snapshot taken before the PostgreSQL restart (pg_stat_statements.save = on keeps the counters across it); the dealloc counter is not compared across the restart';
  return { pgss, counts, rowsWritten: diffCounts(pre.counts, counts), lockLog: logScan(pre.logOffsets, pids) };
}

/** Steady-state reconcile checks (no change expected). */
function steadyChecks(sl, timedOut, exp, scopeLinks, client, rowsWritten) {
  const res = sl.result ?? null;
  return {
    noError: !sl.error && !timedOut,
    scopeMatchesManifest: scopeLinks === exp.checked,
    checkedEqualsScope: res?.checked === exp.checked,
    awardedZero: res?.awarded === 0,
    reversedZero: res?.reversed === 0,
    unchangedZero: res?.unchanged === 0,
    noTransactions: client.transactions.sql === 0 && client.interactiveTransactions === 0,
    noRowsWritten: rowsWritten ? Object.values(rowsWritten).every((w) => w.delta === 0) : null,
  };
}

const allTrue = (checks) => Object.values(checks).every((x) => x === true || x === null);

// ── child: warm series ───────────────────────────────────────────────────────
async function childWarm(ctx) {
  const { spec, m, v } = ctx;
  const recruiterId = v.scope === 'all' ? null : m.recruiters.mixed.id;
  const exp = expectations(m, v);
  const admin = new Admin(spec.clone);
  const conn = await connectMeasured(spec.clone);
  const seen = new Set();
  const res = { ok: true, measured: 0, measuredOk: 0, errors: 0, timedOut: false, warmupsOk: true };
  try {
    const scopeLinks = await scopeLinkCount(admin, recruiterId);
    const wallet = v.kind === 'wallet' ? await walletSetup(ctx, admin, recruiterId, conn) : null;
    const fn = wallet ? wallet.fn : (db) => ctx.svc.reconcileRecruiterRewards({ db, recruiterId });
    const seriesBefore = await tableCounts(admin);
    const total = spec.warmups + spec.reps;
    for (let i = 0; i < total; i += 1) {
      const warmup = i < spec.warmups;
      conn.rec.opts.bytes = i === 0; // approximate JSON bytes per call: warm-up 0 only (sizing costs time)
      const pre = warmup ? { counts: await tableCounts(admin, WRITABLE_TABLES) } : await preMeasure(admin, WRITABLE_TABLES);
      const mo = await measureOnce(ctx, conn, `${v.name}#${i}`, fn);
      const pids = pidsOf(mo.sl);
      const post = warmup ? { counts: await tableCounts(admin, WRITABLE_TABLES) } : await postMeasure(ctx, admin, pre, pids, WRITABLE_TABLES);
      const rowsWritten = post.rowsWritten ?? diffCounts(pre.counts, post.counts);
      const a = analyzeClient(ctx, mo.sl, seen);
      const sample = {
        type: 'sample', ...ctx.base(), mode: warmup ? 'warmup' : 'warm', i, rep: warmup ? null : i - spec.warmups, warmup,
        startedAt: mo.startedAt, wallMs: r3(mo.sl.wallMs), timedOut: mo.timedOut, cancel: mo.cancel, error: mo.sl.error,
        expected: { ...exp, unchanged: 0 }, scopeLinks, approxBytesRecorded: i === 0,
      };
      if (wallet) Object.assign(sample, walletSampleParts(ctx, mo.sl, wallet, a.out, rowsWritten));
      else {
        sample.result = mo.sl.result ?? null;
        sample.checks = steadyChecks(mo.sl, mo.timedOut, exp, scopeLinks, a.out, rowsWritten);
      }
      sample.ok = allTrue(sample.checks);
      sample.client = a.out;
      if (i === 0) sample.client.approxResultBytes = mo.sl.calls.filter((c) => c.op !== '$transaction').map((c) => ({ op: c.op, model: c.model, rows: c.rows, bytes: c.bytes }));
      sample.server = warmup ? { pgss: null, note: 'warm-up: no pg_stat_statements reset / snapshot' } : { pgss: post.pgss, logLockWaits: post.lockLog };
      sample.rowsWritten = rowsWritten;
      sample.heap = heapBlock(ctx, mo.sl, mo.baseline);
      sample.instrumentation = { heapSampleCostUs: ctx.heapCost.usPerSample, callRecords: mo.sl.calls.length, sqlRecords: mo.sl.sql.length };
      await emit(ctx, [conn], sample, mo.baseline);
      if (warmup && !sample.ok) res.warmupsOk = false;
      if (!warmup) { res.measured += 1; if (sample.ok) res.measuredOk += 1; }
      if (sample.error) res.errors += 1;
      log(`${v.name} ${warmup ? 'warm-up' : 'rep'} ${warmup ? i : i - spec.warmups}: ${r3(mo.sl.wallMs)} ms ok=${sample.ok}`);
      if (mo.timedOut) { res.timedOut = true; break; }
    }
    const seriesAfter = await tableCounts(admin);
    const invariants = await ledgerInvariants(admin);
    const seriesRows = diffCounts(seriesBefore, seriesAfter);
    const complete = res.measured === spec.reps && !res.timedOut && res.warmupsOk;
    await appendResult(spec.out, { type: 'series', ...ctx.base(), mode: 'warm', warmups: spec.warmups, reps: spec.reps, measured: res.measured, measuredOk: res.measuredOk,
      complete, warmupsOk: res.warmupsOk, timedOut: res.timedOut, connect: conn.timings, importMs: r3(ctx.importMs), heapCost: ctx.heapCost,
      seriesRowsWritten: seriesRows, seriesNoRowsWritten: Object.values(seriesRows).every((w) => w.delta === 0), invariants,
      wallet: wallet ? { tokenVersion: wallet.tokenVersion, ledgerRows: wallet.ledgerRows, payoutRows: wallet.payoutRows } : null });
    res.complete = complete;
    res.ok = complete && res.measuredOk === res.measured && invariants.ok && Object.values(seriesRows).every((w) => w.delta === 0);
  } finally {
    await conn.close();
    await admin.close();
  }
  return res;
}

async function walletSetup(ctx, admin, recruiterId, conn) {
  const [rr] = await admin.q('SELECT "tokenVersion" AS tv, "isActive" AS active FROM recruiters WHERE id = $1', [recruiterId]);
  const [cnt] = await admin.q(`SELECT (SELECT count(*) FROM recruiter_reward_ledger WHERE "recruiterId" = $1)::int AS ledger,
      (SELECT count(*) FROM affiliate_payouts WHERE "recruiterId" = $1)::int AS payouts`, [recruiterId]);
  const handlers = ctx.walletMod.recruiterWalletHandlers({ db: conn.db, rateLimit: () => false });
  const decoded = { type: 'recruiter', recruiterId, tv: rr.tv };
  const fn = async () => {
    const res = await handlers.wallet(new Request('http://localhost/api/recruiter/wallet', { method: 'GET' }), {}, decoded);
    const buf = await res.arrayBuffer();
    return { status: res.status, bytes: buf.byteLength, contentType: res.headers.get('content-type'), buf };
  };
  const mw = (ctx.m.validation?.wallet ?? []).find((w) => w.username === 'rec_mixed') ?? null;
  return { fn, tokenVersion: rr.tv, active: rr.active, ledgerRows: cnt.ledger, payoutRows: cnt.payouts,
    expectedHistory: { rewards: Math.min(200, cnt.ledger), withdrawals: Math.min(200, cnt.payouts) }, manifestWallet: mw };
}

/** Phase split of one wallet request by call boundaries (approximate; the wallet phase starts with its ledger aggregate). */
function walletPhases(sl) {
  const calls = sl.calls.filter((c) => c.op !== '$transaction');
  if (!calls.length) return null;
  const wi = calls.findIndex((c) => c.op === 'aggregate' && c.model === 'recruiterRewardLedger');
  const lastEnd = Math.max(...calls.map((c) => c.end ?? c.start));
  if (wi < 1) return { note: 'wallet phase not found (no ledger aggregate call)', renderMs: r3(sl.end - lastEnd) };
  const walletStart = Math.min(...calls.slice(wi).map((c) => c.start));
  return {
    definition: 'auth = start → end of call 0 (requireActiveRecruiter); reconcile = end of call 0 → first wallet call (getRecruiterWallet starts with its ledger aggregate); walletQueries = first wallet call → last call end; render = last call end → body read (projection + Response.json + arrayBuffer)',
    authMs: r3(calls[0].end - sl.start), reconcileMs: r3(walletStart - calls[0].end), walletQueriesMs: r3(lastEnd - walletStart), renderMs: r3(sl.end - lastEnd),
    reconcileCalls: wi - 1, walletCalls: calls.length - wi,
  };
}

function walletSampleParts(ctx, sl, wallet, client, rowsWritten) {
  const r = sl.result ?? null;
  let body = null;
  let parseError = null;
  if (r?.buf) {
    try { body = JSON.parse(Buffer.from(r.buf).toString('utf8')); } catch (e) { parseError = e.message; }
  }
  const t = body?.wallet?.totals ?? null;
  const mw = wallet.manifestWallet;
  const checks = {
    noError: !sl.error,
    status200: r?.status === 200,
    bodyParsed: !!body && !parseError,
    noCallErrors: sl.summary.errors === 0, // the handler swallows a failed reconcile: a call error is the only trace
    noTransactions: client.transactions.sql === 0,
    noCreateCalls: !sl.calls.some((c) => c.op === 'create'),
    earnedMatchesManifest: mw ? t?.earnedCents === mw.earned : null,
    paidMatchesManifest: mw ? t?.paidCents === mw.paid : null,
    availableMatchesManifest: mw ? t?.availableCents === mw.available : null,
    pendingMatchesManifest: mw ? t?.pendingCents === mw.reserved - mw.paid : null,
    rewardsHistoryLength: body?.wallet?.rewards?.length === wallet.expectedHistory.rewards,
    withdrawalsHistoryLength: body?.wallet?.withdrawals?.length === wallet.expectedHistory.withdrawals,
    noRowsWritten: rowsWritten ? Object.values(rowsWritten).every((w) => w.delta === 0) : null,
  };
  return {
    result: { status: r?.status ?? null, responseBytes: r?.bytes ?? null, contentType: r?.contentType ?? null, parseError,
      totals: t, rewards: body?.wallet?.rewards?.length ?? null, withdrawals: body?.wallet?.withdrawals?.length ?? null },
    responseBytes: r?.bytes ?? null,
    phases: walletPhases(sl),
    expectedWallet: { manifest: mw, history: wallet.expectedHistory },
    checks,
  };
}

// ── child: cold sample ───────────────────────────────────────────────────────
async function childCold(ctx) {
  const { spec, m, v } = ctx;
  const recruiterId = m.recruiters.mixed.id;
  const exp = expectations(m, v);
  const t0 = now();
  const conn = await connectMeasured(spec.clone); // the process's first contact with the restarted cluster
  const connectWallMs = now() - t0;
  const admin = new Admin(spec.clone);
  try {
    const requestEpochMs = Date.now();
    const uptimeMs = process.uptime() * 1000;
    const mo = await measureOnce(ctx, conn, `${v.name}#${spec.rep}`, (db) => ctx.svc.reconcileRecruiterRewards({ db, recruiterId }));
    const pids = pidsOf(mo.sl);
    const before = JSON.parse(readFileSync(spec.cold.stateFile, 'utf8')); // written by the parent BEFORE the restart
    const pre = { counts: before.counts, seq: before.seq, pgssDeallocBefore: before.pgssDeallocBefore, pgssBefore: before.pgssBefore,
      pgssHousekeeping: before.pgssHousekeeping, logOffsets: spec.cold.logOffsets };
    const post = await postMeasure(ctx, admin, pre, pids, COUNT_TABLES, { excludeConnectProbe: true, sameServerLifetime: false });
    const scopeLinks = await scopeLinkCount(admin, recruiterId);
    const a = analyzeClient(ctx, mo.sl, null);
    const checks = steadyChecks(mo.sl, mo.timedOut, exp, scopeLinks, a.out, post.rowsWritten);
    checks.connectProbeOnly = post.pgss.excluded.every((x) => x.calls === conn.timings.warmConnections);
    const sample = {
      type: 'sample', ...ctx.base(), mode: 'cold', i: 0, rep: spec.rep, warmup: false, startedAt: mo.startedAt, wallMs: r3(mo.sl.wallMs),
      timedOut: mo.timedOut, cancel: mo.cancel, error: mo.sl.error, result: mo.sl.result ?? null, expected: { ...exp, unchanged: 0 }, scopeLinks,
      checks, ok: allTrue(checks),
      coldStart: {
        definition: 'PostgreSQL restarted (lib.restartPg: fast shutdown + start; OS page cache NOT dropped) → fresh child process → module import → $connect + pool warm-up (timed separately) → ONE timed request; rows counted and pg_stat_statements snapshotted BEFORE the restart',
        restartMs: r3(spec.cold.restartMs), waitedForIdleMs: spec.cold.waitedForIdleMs, sampleIndex: spec.rep, importMs: r3(ctx.importMs),
        connectMs: r3(conn.timings.connectMs), poolWarmMs: r3(conn.timings.poolWarmMs), warmConnections: conn.timings.warmConnections, connectWallMs: r3(connectWallMs),
        processUptimeAtRequestMs: r3(uptimeMs), restartToRequestMs: spec.cold.restartDoneEpochMs ? requestEpochMs - spec.cold.restartDoneEpochMs : null,
      },
      client: a.out, server: { pgss: post.pgss, logLockWaits: post.lockLog }, rowsWritten: post.rowsWritten,
      heap: heapBlock(ctx, mo.sl, mo.baseline), instrumentation: { heapSampleCostUs: ctx.heapCost.usPerSample, callRecords: mo.sl.calls.length, sqlRecords: mo.sl.sql.length },
    };
    await emit(ctx, [conn], sample, mo.baseline);
    log(`${v.name} cold sample ${spec.rep}: ${sample.wallMs} ms ok=${sample.ok}`);
    return { ok: sample.ok, measured: 1, measuredOk: sample.ok ? 1 : 0, timedOut: mo.timedOut, errors: sample.error ? 1 : 0, wallMs: sample.wallMs };
  } finally {
    await conn.close();
    await admin.close();
  }
}

// ── child: fresh clone (pending / concurrent) ────────────────────────────────
async function warmupSample(ctx, conn, admin, { i, label, fn, exp, scopeLinks, seen }) {
  conn.rec.opts.bytes = i === 0;
  const before = await tableCounts(admin, WRITABLE_TABLES);
  const mo = await measureOnce(ctx, conn, `${ctx.v.name}#warmup${i}${label ? `-${label}` : ''}`, fn);
  const after = await tableCounts(admin, WRITABLE_TABLES);
  const rowsWritten = diffCounts(before, after);
  const a = analyzeClient(ctx, mo.sl, seen);
  const checks = steadyChecks(mo.sl, mo.timedOut, exp, scopeLinks, a.out, rowsWritten);
  const sample = {
    type: 'sample', ...ctx.base(), mode: 'warmup', i, rep: ctx.spec.rep, run: label ?? null, warmup: true, startedAt: mo.startedAt, wallMs: r3(mo.sl.wallMs),
    timedOut: mo.timedOut, error: mo.sl.error, result: mo.sl.result ?? null, expected: { checked: exp.checked, awarded: 0, reversed: 0, unchanged: 0 },
    note: 'steady-state warm-up of the same scope BEFORE the flips (discarded)', checks, ok: allTrue(checks), client: a.out,
    server: { pgss: null, note: 'warm-up: no pg_stat_statements reset / snapshot' }, rowsWritten, heap: heapBlock(ctx, mo.sl, mo.baseline),
  };
  if (i === 0) sample.client.approxResultBytes = mo.sl.calls.filter((c) => c.op !== '$transaction').map((c) => ({ op: c.op, model: c.model, rows: c.rows, bytes: c.bytes }));
  await emit(ctx, [conn], sample, mo.baseline);
  conn.rec.opts.bytes = false;
  if (!sample.ok) throw new Error(`warm-up ${i}${label ? ` (${label})` : ''} was not a steady-state no-op: ${JSON.stringify(sample.result ?? sample.error)}`);
  return sample;
}

/** Common preparation of a fresh-clone rep: scope, settings, pool pre-check, expected rows. */
async function freshPrep(ctx, admin, recruiterId) {
  const { m, v } = ctx;
  const mixedId = m.recruiters.mixed.id;
  const plan = flipPlan(m, v.flips);
  const scopeLinks = await scopeLinkCount(admin, recruiterId);
  const settings = await currentSettings(admin);
  const pool = await poolPrecheck(admin, plan, mixedId);
  const expected = expectedLedgerRows(plan, pool.ledgerBefore, settings, mixedId);
  if (pool.problemCount || expected.problems.length) {
    throw new Error(`pool pre-check failed: ${JSON.stringify({ pool: pool.problems.slice(0, 3), expected: expected.problems.slice(0, 3) })}`);
  }
  return { plan, scopeLinks, settings, pool: { members: pool.members, problemCount: pool.problemCount }, expected };
}

function writeChecks(rowsWritten, total) {
  return Object.entries(rowsWritten).every(([t, w]) => w.delta === (WRITABLE_TABLES.includes(t) ? total : 0));
}

async function childPending(ctx) {
  const { spec, m, v } = ctx;
  const recruiterId = v.scope === 'all' ? null : m.recruiters.mixed.id;
  const exp = expectations(m, v);
  const admin = new Admin(spec.clone);
  const conn = await connectMeasured(spec.clone);
  const seen = new Set();
  const fn = (db) => ctx.svc.reconcileRecruiterRewards({ db, recruiterId });
  try {
    const prep = await freshPrep(ctx, admin, recruiterId);
    for (let i = 0; i < spec.warmups; i += 1) await warmupSample(ctx, conn, admin, { i, label: null, fn, exp, scopeLinks: prep.scopeLinks, seen });
    const flip = await applyFlips(admin, prep.plan);
    if (!flip.ok) throw new Error(`flips did not apply exactly: ${JSON.stringify(flip)}`);
    const pre = await preMeasure(admin, COUNT_TABLES);
    const mo = await measureOnce(ctx, conn, `${v.name}#${spec.rep}`, fn);
    const pids = pidsOf(mo.sl);
    const post = await postMeasure(ctx, admin, pre, pids, COUNT_TABLES);
    const a = analyzeClient(ctx, mo.sl, seen);
    const rows = await verifyNewRows(admin, pre.seq, prep.expected.rows);
    const invariants = await ledgerInvariants(admin);
    const fu = mo.timedOut ? null : await conn.measure(`${v.name}#${spec.rep}-follow-up`, fn); // not after a timeout: it would be as slow
    const res = mo.sl.result ?? null;
    const total = exp.awarded + exp.reversed;
    const checks = {
      noError: !mo.sl.error && !mo.timedOut,
      scopeMatchesManifest: prep.scopeLinks === exp.checked,
      checkedEqualsScope: res?.checked === exp.checked,
      awardedExact: res?.awarded === exp.awarded,
      reversedExact: res?.reversed === exp.reversed,
      unchangedZero: res?.unchanged === 0,
      oneTransactionPerChange: a.out.transactions.sql === total && a.out.transactions.matched,
      outcomesMatch: (a.out.transactions.byOutcome.AWARDED ?? 0) === exp.awarded && (a.out.transactions.byOutcome.REVERSED ?? 0) === exp.reversed,
      rowsWrittenExact: writeChecks(post.rowsWritten, total),
      ledgerRowsExact: rows.ledgerExact,
      auditRowsEqualLedgerRows: rows.auditEqualsLedger,
      ledgerInvariants: invariants.ok,
      followUpNoChange: !!fu && !fu.error && fu.result?.awarded === 0 && fu.result?.reversed === 0 && fu.result?.unchanged === 0,
    };
    const sample = {
      type: 'sample', ...ctx.base(), mode: 'pending', i: spec.warmups, rep: spec.rep, warmup: false, startedAt: mo.startedAt, wallMs: r3(mo.sl.wallMs),
      timedOut: mo.timedOut, cancel: mo.cancel, error: mo.sl.error, result: res, expected: { ...exp, unchanged: 0 }, scopeLinks: prep.scopeLinks,
      flips: { name: prep.plan.name, requested: prep.plan.requested, awards: prep.plan.awards.length, reversals: prep.plan.reversals.length,
        poolLimited: prep.plan.poolLimited, poolSizes: prep.plan.poolSizes, applied: flip, settings: prep.settings,
        note: prep.plan.poolLimited ? `POOL-LIMITED: the ${spec.scale} manifest only has ${prep.plan.poolSizes.P_AWARD} / ${prep.plan.poolSizes.P_REVERSE} pool members, all used` : null },
      protocol: `${spec.warmups} steady-state warm-ups of the same scope in this process, then the flips (admin connection), then ONE measured request (write path not warmed)`,
      checks, ok: allTrue(checks),
      client: a.out, server: { pgss: post.pgss, logLockWaits: post.lockLog }, rowsWritten: post.rowsWritten,
      ledger: rows, invariants,
      followUp: fu ? { wallMs: r3(fu.wallMs), result: fu.result ?? null, error: fu.error } : { skipped: 'the measured request timed out' },
      heap: heapBlock(ctx, mo.sl, mo.baseline), instrumentation: { heapSampleCostUs: ctx.heapCost.usPerSample, callRecords: mo.sl.calls.length, sqlRecords: mo.sl.sql.length },
    };
    await emit(ctx, [conn], sample, mo.baseline);
    log(`${v.name} rep ${spec.rep}: ${sample.wallMs} ms result=${JSON.stringify(res)} ok=${sample.ok}`);
    return { ok: sample.ok, measured: 1, measuredOk: sample.ok ? 1 : 0, timedOut: mo.timedOut, errors: sample.error ? 1 : 0, wallMs: sample.wallMs, result: res };
  } finally {
    await conn.close();
    await admin.close();
  }
}

async function childConcurrent(ctx) {
  const { spec, m, v } = ctx;
  const recruiterId = m.recruiters.mixed.id;
  const exp = expectations(m, v);
  const admin = new Admin(spec.clone);
  const connA = await connectMeasured(spec.clone);
  const connB = await connectMeasured(spec.clone);
  const seenA = new Set();
  const seenB = new Set();
  const fn = (db) => ctx.svc.reconcileRecruiterRewards({ db, recruiterId });
  try {
    const prep = await freshPrep(ctx, admin, recruiterId);
    for (let i = 0; i < spec.warmups; i += 1) {
      await warmupSample(ctx, connA, admin, { i, label: 'A', fn, exp, scopeLinks: prep.scopeLinks, seen: seenA });
      await warmupSample(ctx, connB, admin, { i, label: 'B', fn, exp, scopeLinks: prep.scopeLinks, seen: seenB });
    }
    const flip = await applyFlips(admin, prep.plan);
    if (!flip.ok) throw new Error(`flips did not apply exactly: ${JSON.stringify(flip)}`);
    const pre = await preMeasure(admin, COUNT_TABLES);
    gc();
    const baseline = heapUsed();
    const startedAt = new Date().toISOString();
    const guard = timeoutGuard(spec.clone, spec.timeoutS * 1000);
    const t0 = now();
    let ra;
    let rb;
    try {
      [ra, rb] = await Promise.all([connA.measure(`${v.name}#${spec.rep}-A`, fn), connB.measure(`${v.name}#${spec.rep}-B`, fn)]);
    } finally { guard.stop(); }
    const pairWallMs = now() - t0;
    const timedOut = guard.state.timedOut;
    const cancel = timedOut ? guard.state.attempts : null;
    const pids = [...new Set([...pidsOf(ra), ...pidsOf(rb)])];
    const post = await postMeasure(ctx, admin, pre, pids, COUNT_TABLES);
    const A = analyzeClient(ctx, ra, seenA);
    const B = analyzeClient(ctx, rb, seenB);
    const rows = await verifyNewRows(admin, pre.seq, prep.expected.rows);
    const invariants = await ledgerInvariants(admin);
    const fu = timedOut ? null : await connA.measure(`${v.name}#${spec.rep}-follow-up`, fn); // not after a timeout: it would be as slow
    const resA = ra.result ?? null;
    const resB = rb.result ?? null;
    const total = exp.awarded + exp.reversed;
    const merged = (k) => [...A.locks[k], ...B.locks[k]];
    const outcomes = {};
    for (const r of [A, B]) for (const [k, n] of Object.entries(r.out.transactions.byOutcome)) outcomes[k] = (outcomes[k] ?? 0) + n;
    const txOk = (r, an) => !!r && an.out.transactions.matched && an.out.transactions.sql === r.awarded + r.reversed + r.unchanged;
    const checks = {
      noError: !ra.error && !rb.error && !timedOut,
      scopeMatchesManifest: prep.scopeLinks === exp.checked,
      checkedEach: resA?.checked === exp.checked && resB?.checked === exp.checked,
      awardedTotalExact: (resA?.awarded ?? NaN) + (resB?.awarded ?? NaN) === exp.awarded,
      reversedTotalExact: (resA?.reversed ?? NaN) + (resB?.reversed ?? NaN) === exp.reversed,
      oneTransactionPerAttempt: txOk(resA, A) && txOk(resB, B),
      writingTransactionsExact: (outcomes.AWARDED ?? 0) === exp.awarded && (outcomes.REVERSED ?? 0) === exp.reversed,
      rowsWrittenExact: writeChecks(post.rowsWritten, total),
      noDuplicateRewardsOrReversals: rows.ledgerExact && invariants.dup_rewards === 0 && invariants.dup_reversals === 0,
      auditRowsEqualLedgerRows: rows.auditEqualsLedger,
      ledgerInvariants: invariants.ok,
      followUpNoChange: !!fu && !fu.error && fu.result?.awarded === 0 && fu.result?.reversed === 0 && fu.result?.unchanged === 0,
    };
    const runDetail = (label, sl, an, r) => ({ label, startOffsetMs: r3(sl.start - t0), endOffsetMs: r3(sl.end - t0), wallMs: r3(sl.wallMs), result: r, error: sl.error,
      client: an.out, heap: { start: sl.summary.heapStart, peak: sl.summary.heapPeak, end: sl.summary.heapEnd, samples: sl.heap.length } });
    const sample = {
      type: 'sample', ...ctx.base(), mode: 'pair', i: spec.warmups, rep: spec.rep, warmup: false, startedAt, wallMs: r3(pairWallMs), pairWallMs: r3(pairWallMs),
      startSkewMs: r3(rb.start - ra.start), timedOut, cancel, error: ra.error ?? rb.error ?? null,
      result: { A: resA, B: resB, total: resA && resB ? { checked: resA.checked + resB.checked, awarded: resA.awarded + resB.awarded, reversed: resA.reversed + resB.reversed, unchanged: resA.unchanged + resB.unchanged } : null },
      expected: { checkedEach: exp.checked, awardedTotal: exp.awarded, reversedTotal: exp.reversed },
      scopeLinks: prep.scopeLinks,
      flips: { name: prep.plan.name, requested: prep.plan.requested, awards: prep.plan.awards.length, reversals: prep.plan.reversals.length,
        poolLimited: prep.plan.poolLimited, poolSizes: prep.plan.poolSizes, applied: flip, settings: prep.settings,
        note: prep.plan.poolLimited ? `POOL-LIMITED: the ${spec.scale} manifest only has ${prep.plan.poolSizes.P_AWARD} / ${prep.plan.poolSizes.P_REVERSE} pool members, all used` : null },
      protocol: `two lib.connect() clients (own PrismaPg pool + recorder each) in ONE process; ${spec.warmups} steady-state warm-ups on each, then the flips, then both scoped reconciles started in the same tick (Promise.all)`,
      checks, ok: allTrue(checks),
      runs: [runDetail('A', ra, A, resA), runDetail('B', rb, B, resB)],
      combined: {
        syncTransactions: A.out.transactions.sql + B.out.transactions.sql, byOutcome: outcomes,
        statements: A.out.sqlStatements + B.out.sqlStatements, sqlMsSum: r3((A.out.sqlMsSum ?? 0) + (B.out.sqlMsSum ?? 0)),
        lockWait: { definition: LOCK_WAIT_DEFINITION, affiliateLock: lockAgg(merged('affiliate')), moneyLock: lockAgg(merged('money')),
          otherAdvisory: lockAgg(merged('otherAdvisory')), rowLock: lockAgg(merged('rowLock')),
          clientLockMs: r3(sum(merged('affiliate')) + sum(merged('money')) + sum(merged('otherAdvisory')) + sum(merged('rowLock'))) },
        duplication: duplication(A, B),
      },
      server: { pgss: post.pgss, logLockWaits: post.lockLog, note: 'pg_stat_statements and the log cover BOTH runs (one reset before the pair)' },
      rowsWritten: post.rowsWritten, ledger: rows, invariants,
      followUp: fu ? { wallMs: r3(fu.wallMs), result: fu.result ?? null, error: fu.error } : { skipped: 'the measured pair timed out' },
      heap: { baselineAfterGc: baseline, peak: Math.max(ra.summary.heapPeak ?? 0, rb.summary.heapPeak ?? 0),
        peakMinusBaseline: Math.max(ra.summary.heapPeak ?? 0, rb.summary.heapPeak ?? 0) - baseline, afterGcMinusBaseline: null,
        note: 'both runs share one process heap: peak = max of both recorders’ call-boundary samples',
        samplingCostEstimateMs: r3(((ra.heap.length + rb.heap.length) * ctx.heapCost.usPerSample) / 1000) },
      instrumentation: { heapSampleCostUs: ctx.heapCost.usPerSample, callRecords: ra.calls.length + rb.calls.length, sqlRecords: ra.sql.length + rb.sql.length },
    };
    await emit(ctx, [connA, connB], sample, baseline);
    log(`${v.name} rep ${spec.rep}: pair ${sample.pairWallMs} ms A=${JSON.stringify(resA)} B=${JSON.stringify(resB)} ok=${sample.ok}`);
    return { ok: sample.ok, measured: 1, measuredOk: sample.ok ? 1 : 0, timedOut, errors: sample.error ? 1 : 0, wallMs: sample.pairWallMs, result: sample.result.total };
  } finally {
    await connA.close();
    await connB.close();
    await admin.close();
  }
}

async function childMain(arg) {
  const spec = JSON.parse(Buffer.from(arg, 'base64url').toString('utf8'));
  guardClone(spec.clone);
  requireGc();
  const ctx = makeCtx(spec);
  ctx.heapCost = calibrateHeapCost();
  const t0 = now();
  ctx.svc = await importService('recruiterRewardService');
  if (ctx.v.kind === 'wallet') ctx.walletMod = await import(join(REPO, 'src/lib/recruiterWalletRouteHandlers.js'));
  ctx.importMs = now() - t0;
  let out;
  try {
    if (spec.role === 'warm') out = await childWarm(ctx);
    else if (spec.role === 'cold') out = await childCold(ctx);
    else if (spec.role === 'pending') out = await childPending(ctx);
    else if (spec.role === 'concurrent') out = await childConcurrent(ctx);
    else throw new Error(`unknown role ${spec.role}`);
  } catch (e) {
    out = { ok: false, error: errInfo(e) };
    log(`child error: ${e?.stack ?? e}`);
    await appendResult(spec.out, { type: 'event', ...ctx.base(), event: 'child-error', role: spec.role, rep: spec.rep ?? null, error: errInfo(e),
      stack: String(e?.stack ?? '').split('\n').slice(0, 8) });
  }
  await ctx.flushTexts();
  process.stdout.write(`${RESULT_MARK}${JSON.stringify(out)}\n`);
}

// ── parent: clones, children, cold samples ───────────────────────────────────
function acquireLock() {
  mkdirSync(WORK_DIR, { recursive: true });
  const file = join(WORK_DIR, `${HARNESS}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(2) }), { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let other = null;
      try { other = JSON.parse(readFileSync(file, 'utf8')); } catch { other = null; }
      if (other?.pid && other.pid !== process.pid && pidAlive(other.pid)) throw new Error(`${HARNESS}: another instance is running (pid ${other.pid}); one instance at a time`);
      unlinkSync(file);
    }
  }
  throw new Error(`${HARNESS}: could not take the lock ${file}`);
}

async function otherClients() {
  return pgQuery('postgres', `${ADMIN_TAG} SELECT pid, datname, state, application_name FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`);
}

async function waitClusterIdle(waitS) {
  const t0 = Date.now();
  for (;;) {
    const others = await otherClients();
    if (!others.length) return { ok: true, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 >= waitS * 1000) return { ok: false, waitedMs: Date.now() - t0, others: others.map((o) => `${o.datname}:${o.pid}:${o.state}:${o.application_name ?? ''}`) };
    await sleep(2000);
  }
}

async function ensureClone(ctx, clone, reason) {
  guardClone(clone);
  const template = TEMPLATES[ctx.a.scale];
  const t0 = Date.now();
  let attempts = 0;
  let lastError = null;
  for (;;) {
    if (ctx.stopping) throw new Error('stopping');
    attempts += 1;
    const alive = await listClones();
    if (alive.includes(clone)) {
      const d = await dropDb(clone);
      await appendResult(ctx.file, { type: 'clone', runId: ctx.runId, action: 'drop', reason: 'leftover of an earlier run of this harness', ...d });
      continue;
    }
    if (alive.length < MAX_CLONES) {
      try {
        const info = await cloneDb(template, clone);
        const rec = { type: 'clone', runId: ctx.runId, action: 'create', reason, ...info, waitedForSlotMs: Date.now() - t0, attempts, clonesAliveBefore: alive,
          note: 'clone time is setup, not part of any measurement' };
        await appendResult(ctx.file, rec);
        log(`clone ${clone} from ${template} in ${r3(info.ms)} ms (free after: ${(info.freeBytesAfter / 1024 ** 3).toFixed(2)} GiB)`);
        return info;
      } catch (e) {
        lastError = e.message;
        if (/refusing to clone|not a p5a template|clone name/.test(e.message)) throw e; // disk / guard refusal: stop
      }
    }
    if (Date.now() - t0 >= ctx.a.cloneWaitS * 1000) throw new Error(`no clone slot within ${ctx.a.cloneWaitS} s (alive: ${alive.join(', ') || '-'}; last error: ${lastError ?? '-'})`);
    if (attempts === 1 || attempts % 12 === 0) log(`waiting for a clone slot (alive: ${alive.join(', ')})`);
    await sleep(5000);
  }
}

async function dropClone(ctx, clone, reason) {
  guardClone(clone);
  const d = await dropDb(clone);
  await appendResult(ctx.file, { type: 'clone', runId: ctx.runId, action: 'drop', reason, ...d, freeBytesAfter: freeDiskBytes() });
  log(`dropped ${clone} (${reason})`);
  return d;
}

function runChild(ctx, spec, budgetMs) {
  return new Promise((done) => {
    const t0 = Date.now();
    const arg = Buffer.from(JSON.stringify(spec)).toString('base64url');
    const child = spawn(process.execPath, ['--expose-gc', SELF, '--child', arg], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    ctx.child = child;
    let stdout = '';
    let tail = '';
    let killed = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { appendFileSync(ctx.logFile, d); tail = (tail + d).slice(-6000); });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, budgetMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ctx.child = null;
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARK));
      let result = null;
      try { result = line ? JSON.parse(line.slice(RESULT_MARK.length)) : null; } catch { result = null; }
      const stderrTail = tail.split('\n').filter((l) => l && !/MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|To eliminate this warning|trace-warnings/.test(l)).slice(-10).join('\n');
      done({ pid: child.pid, code, signal, killed, budgetMs, ms: Date.now() - t0, result, stderrTail });
    });
  });
}

async function childRun(ctx, v, spec, requests) {
  const budgetMs = (requests + 2) * ctx.a.timeoutS * 1000 + 600_000;
  const childId = `${ctx.runId}/${v.name}/${spec.role === 'warm' ? 'series' : `rep${spec.rep}`}`;
  const full = { ...spec, variant: v.name, scale: ctx.a.scale, out: ctx.file, runId: ctx.runId, childId, warmups: ctx.a.warmups, timeoutS: ctx.a.timeoutS,
    protocolKey: ctx.keys[v.name], label: ctx.a.label };
  log(`child ${childId} (${spec.role}) on ${spec.clone} …`);
  const r = await runChild(ctx, full, budgetMs);
  let terminated = null;
  if (r.killed || r.code !== 0) terminated = await terminateBackends(spec.clone).catch((e) => ({ error: e.message }));
  await appendResult(ctx.file, { type: 'child', runId: ctx.runId, childId, variant: v.name, role: spec.role, rep: spec.rep ?? null, pid: r.pid, exitCode: r.code,
    signal: r.signal, killedByWatchdog: r.killed, budgetMs: r.budgetMs, ms: r.ms, result: r.result, stderrTail: r.result?.ok ? null : r.stderrTail, terminatedBackends: terminated });
  const ok = !!r.result?.ok && r.code === 0 && !r.killed;
  log(`child ${childId}: exit ${r.code}${r.killed ? ' (killed by watchdog)' : ''} ok=${ok} in ${(r.ms / 1000).toFixed(1)} s`);
  return { ...r, ok, childId };
}

async function steadyIntact(ctx, clone) {
  const [r] = await pgQuery(clone, `${ADMIN_TAG} SELECT (SELECT count(*) FROM recruiter_reward_ledger)::int AS ledger, (SELECT count(*) FROM recruiter_audit_log)::int AS audit,
      (SELECT count(*) FROM identity_verifications WHERE status = 'APPROVED')::int AS approved, (SELECT count(*) FROM affiliate_orders WHERE status = 'delivered')::int AS delivered`);
  const ok = r.ledger === ctx.m.rowCounts.recruiter_reward_ledger && r.audit === ctx.m.rowCounts.recruiter_audit_log;
  if (!ok) await appendResult(ctx.file, { type: 'event', runId: ctx.runId, event: 'steady-clone-changed', clone, counts: r, manifest: { ledger: ctx.m.rowCounts.recruiter_reward_ledger, audit: ctx.m.rowCounts.recruiter_audit_log } });
  return ok;
}

async function coldSample(ctx, v, clone, i) {
  const idle = await waitClusterIdle(ctx.a.idleWaitS);
  if (!idle.ok) {
    await appendResult(ctx.file, { type: 'event', runId: ctx.runId, event: 'cold-sample-skipped', variant: v.name, i, reason: 'cluster busy (other clients connected)', ...idle });
    log(`cold ${i}: skipped, cluster busy (${idle.others.join(', ')})`);
    return { skipped: true };
  }
  // Everything the sample compares against is taken BEFORE the restart, so nothing but the measured
  // child touches the clone between the restart and the timed request.
  const [c] = await pgQuery(clone, `${ADMIN_TAG} ${countSql(COUNT_TABLES)}`);
  const counts = Object.fromEntries(COUNT_TABLES.map((t) => [t, Number(c[t])]));
  const [seq] = await pgQuery(clone, `${ADMIN_TAG} ${SEQ_SQL}`);
  const pgssHousekeeping = await pgssDropStale((sql, params) => pgQuery(clone, `${ADMIN_TAG} ${sql}`, params));
  const [d] = await pgQuery(clone, `${ADMIN_TAG} ${DEALLOC_SQL}`);
  const pgssBefore = await pgQuery(clone, `${ADMIN_TAG} ${pgssSnapshotSql(false)}`);
  mkdirSync(WORK_DIR, { recursive: true });
  const stateFile = join(WORK_DIR, `${HARNESS}-cold-${ctx.runId}-${i}.json`);
  writeFileSync(stateFile, JSON.stringify({ counts, seq, pgssDeallocBefore: Number(d.dealloc), pgssBefore, pgssHousekeeping }));
  const logOffsets = logSnapshot();
  try {
    log(`cold ${i}: restarting PostgreSQL (no other client connected) …`);
    const restart = await restartPg();
    const restartDoneEpochMs = Date.now();
    await appendResult(ctx.file, { type: 'event', runId: ctx.runId, event: 'pg-restart', variant: v.name, i, restartMs: r3(restart.ms), waitedForIdleMs: idle.waitedMs, clusterReady: clusterReady() });
    const r = await childRun(ctx, v, { role: 'cold', clone, rep: i,
      cold: { stateFile, logOffsets, restartMs: restart.ms, restartDoneEpochMs, waitedForIdleMs: idle.waitedMs } }, 1);
    return { skipped: false, ...r };
  } finally {
    try { unlinkSync(stateFile); } catch { /* the child may already have removed it */ }
  }
}

// ── parent: plan, resume, summaries ──────────────────────────────────────────
function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a partially written line of a killed process */ }
  }
  return out;
}

function selectVariants(a) {
  let sel = VARIANTS;
  if (a.scenarios) {
    const want = new Set();
    for (const name of a.scenarios) {
      const hit = VARIANTS.filter((v) => v.name === name || v.scenario === name);
      if (!hit.length) throw new Error(`unknown scenario / variant "${name}" — valid: ${[...SCENARIOS, ...VARIANTS.map((v) => v.name)].join(', ')}`);
      for (const v of hit) want.add(v.name);
    }
    sel = VARIANTS.filter((v) => want.has(v.name));
  }
  return a.noCold ? sel.filter((v) => v.mode !== 'cold') : sel;
}

const repsFor = (a, v) => (v.mode === 'cold' ? a.coldSamples ?? a.reps ?? v.reps : a.reps ?? v.reps);
const protocolKey = (a, m, v) => `${HARNESS}/v${PROTOCOL_VERSION}/${m.buildId}/${v.name}/${v.mode === 'cold' ? 'cold' : `warmups${a.warmups}`}`;

function buildPlan(a, m, lines, keys) {
  return selectVariants(a).map((v) => {
    const reps = repsFor(a, v);
    const key = keys[v.name];
    const prior = a.force ? [] : lines;
    let done = 0;
    let reason = null;
    if (v.mode === 'warm') {
      const series = prior.filter((l) => l.type === 'series' && l.variant === v.name && l.protocolKey === key && l.complete && (l.measured ?? 0) >= reps);
      if (series.length) { done = reps; reason = `complete series ${series[series.length - 1].childId}`; }
    } else {
      done = prior.filter((l) => l.type === 'sample' && l.variant === v.name && l.protocolKey === key && l.mode !== 'warmup').length;
      if (done) reason = `${done} sample(s) already recorded`;
    }
    const f = flipPlan(m, v.flips);
    return { v, reps, key, done: Math.min(done, reps), todo: Math.max(0, reps - done), reason, expected: expectations(m, v),
      flips: f ? { name: f.name, requested: f.requested, awards: f.awards.length, reversals: f.reversals.length, poolLimited: f.poolLimited, poolSizes: f.poolSizes } : null };
  });
}

function variantSummary(ctx, p, lines) {
  const { v, key } = p;
  let samples = lines.filter((l) => l.type === 'sample' && l.variant === v.name && l.protocolKey === key && l.mode !== 'warmup');
  if (ctx.a.force) samples = samples.filter((l) => l.runId === ctx.runId);
  let series = null;
  if (v.mode === 'warm') {
    const all = lines.filter((l) => l.type === 'series' && l.variant === v.name && l.protocolKey === key && l.complete && (!ctx.a.force || l.runId === ctx.runId));
    series = all[all.length - 1] ?? null;
    samples = series ? samples.filter((s) => s.childId === series.childId) : [];
  }
  const ok = samples.filter((s) => s.ok);
  const pick = (f) => ok.map(f).filter((x) => typeof x === 'number' && Number.isFinite(x));
  const distinct = (f) => [...new Set(samples.map((s) => JSON.stringify(f(s) ?? null)))].map((x) => JSON.parse(x));
  const out = {
    type: 'summary', harness: HARNESS, protocolVersion: PROTOCOL_VERSION, protocolKey: key, runId: ctx.runId, scale: ctx.a.scale, buildId: ctx.m.buildId,
    variant: v.name, scenario: v.scenario, mode: v.mode, scope: v.scope === 'all' ? 'all recruiters' : 'rec_mixed', label: ctx.a.label ?? null,
    flips: p.flips, poolLimited: p.flips?.poolLimited ?? false, expected: p.expected,
    requestedN: p.reps, n: samples.length, nOk: ok.length, complete: samples.length >= p.reps,
    errors: samples.filter((s) => s.error).length, timeouts: samples.filter((s) => s.timedOut).length,
    checksOk: samples.length > 0 && ok.length === samples.length,
    checksFailed: samples.filter((s) => !s.ok).map((s) => ({ childId: s.childId, rep: s.rep, failed: Object.entries(s.checks ?? {}).filter(([, x]) => x === false).map(([k]) => k) })),
    series: series ? { childId: series.childId, measured: series.measured, invariantsOk: series.invariants?.ok ?? null, seriesNoRowsWritten: series.seriesNoRowsWritten } : null,
    wallMs: summ(pick((s) => s.wallMs)),
    results: distinct((s) => s.result && v.kind !== 'wallet' ? s.result : null),
    rowsWrittenLedgerAudit: distinct((s) => (s.rowsWritten ? { ledger: s.rowsWritten.recruiter_reward_ledger?.delta, audit: s.rowsWritten.recruiter_audit_log?.delta } : null)),
    samplesRef: { file: ctx.file, select: { type: 'sample', variant: v.name, protocolKey: key, childIds: [...new Set(samples.map((s) => s.childId))] } },
    note: 'p50 / p95 by nearest rank over the ok samples (lib.summarize); n reported',
  };
  if (v.mode === 'pair') {
    Object.assign(out, {
      pairWallMs: summ(pick((s) => s.pairWallMs)),
      runWallMs: summ(ok.flatMap((s) => s.runs.map((r) => r.wallMs))),
      statementsTotal: summ(pick((s) => s.combined.statements)),
      duplicatedStatements: summ(pick((s) => s.combined.duplication.duplicated.statements)),
      duplicatedSqlMs: summ(pick((s) => s.combined.duplication.duplicated.sqlMs)),
      duplicationStatementRatio: summ(pick((s) => s.combined.duplication.duplicated.statementRatio)),
      wastedTransactions: summ(pick((s) => s.combined.duplication.wastedTransactions.n)),
      affiliateLockMsSum: summ(pick((s) => s.combined.lockWait.affiliateLock.msSum)),
      moneyLockMsSum: summ(pick((s) => s.combined.lockWait.moneyLock.msSum)),
      clientLockMs: summ(pick((s) => s.combined.lockWait.clientLockMs)),
      logLockWaits: summ(pick((s) => s.server?.logLockWaits?.stillWaiting)),
      pgssToplevelCalls: summ(pick((s) => s.server?.pgss?.toplevel?.calls)),
      pgssNestedCalls: summ(pick((s) => s.server?.pgss?.nested?.calls)),
      heapPeakMinusBaseline: summ(pick((s) => s.heap?.peakMinusBaseline)),
    });
  } else {
    Object.assign(out, {
      sqlStatements: summ(pick((s) => s.client?.sqlStatements)),
      sqlMsSum: summ(pick((s) => s.client?.sqlMsSum)),
      outsideSqlMs: summ(pick((s) => s.client?.outsideSqlMs)),
      syncTransactions: summ(pick((s) => s.client?.transactions?.sql)),
      clientLockMs: summ(pick((s) => s.client?.lockWait?.clientLockMs)),
      pgssToplevelCalls: summ(pick((s) => s.server?.pgss?.toplevel?.calls)),
      pgssToplevelExecMs: summ(pick((s) => s.server?.pgss?.toplevel?.totalExecMs)),
      pgssNestedCalls: summ(pick((s) => s.server?.pgss?.nested?.calls)),
      heapPeakMinusBaseline: summ(pick((s) => s.heap?.peakMinusBaseline)),
      heapPeak: summ(pick((s) => s.heap?.peak)),
    });
  }
  if (v.kind === 'wallet') Object.assign(out, { responseBytes: summ(pick((s) => s.responseBytes)), statuses: distinct((s) => s.result?.status) });
  if (v.mode === 'cold') {
    Object.assign(out, {
      connectMs: summ(pick((s) => s.coldStart?.connectMs)), poolWarmMs: summ(pick((s) => s.coldStart?.poolWarmMs)), importMs: summ(pick((s) => s.coldStart?.importMs)),
      restartMs: summ(pick((s) => s.coldStart?.restartMs)), restartToRequestMs: summ(pick((s) => s.coldStart?.restartToRequestMs)),
      definition: 'cold = PostgreSQL restart (OS page cache NOT dropped) + fresh process; $connect + pool warm-up reported separately, then one request',
    });
  }
  return out;
}

// ── parent: main ─────────────────────────────────────────────────────────────
async function parentMain(a) {
  guardUrl('postgres');
  const m = loadManifest(a.scale);
  if (a.out && !OUT_RE.test(a.out)) throw new Error('--out takes a file name (letters, digits, . _ -, ending in .jsonl); it is written to SCRATCH/results');
  const file = join(RESULTS_DIR, a.out ?? `reconcile-${a.scale}.jsonl`);
  const keys = Object.fromEntries(VARIANTS.map((v) => [v.name, protocolKey(a, m, v)]));
  const lines = readJsonl(file);
  const plan = buildPlan(a, m, lines, keys);
  if (a.list) {
    return { ok: true, scale: a.scale, manifestBuildId: m.buildId, file, warmups: a.warmups,
      variants: plan.map((p) => ({ name: p.v.name, scenario: p.v.scenario, mode: p.v.mode, scope: p.v.scope, clone: p.v.clone, reps: p.reps, done: p.done, todo: p.todo,
        resume: p.reason, expected: p.expected, flips: p.flips })) };
  }
  requireGc();
  if (!clusterReady()) throw new Error('the disposable cluster is not running (bash scripts/perf/recruiter/pg.sh start)');
  const lock = acquireLock();
  const runId = `${a.scale}-${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)}-${process.pid}`;
  mkdirSync(LOGS_DIR, { recursive: true });
  const ctx = { a, m, file, keys, runId, logFile: join(LOGS_DIR, `reconcile-${runId}.log`), child: null, stopping: false };
  const onSignal = (sig) => {
    log(`${sig}: stopping after cleanup`);
    ctx.stopping = true;
    if (ctx.child) ctx.child.kill('SIGKILL');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const t0 = Date.now();
  const ran = [];
  const skipped = plan.filter((p) => !p.todo).map((p) => ({ variant: p.v.name, reason: p.reason }));
  let fatal = null;
  try {
    await appendResult(file, {
      type: 'run', harness: HARNESS, protocolVersion: PROTOCOL_VERSION, runId, scale: a.scale, buildId: m.buildId, label: a.label ?? null,
      args: { ...a, child: undefined }, logFile: ctx.logFile, startedAt: new Date().toISOString(),
      plan: plan.map((p) => ({ variant: p.v.name, reps: p.reps, done: p.done, todo: p.todo, resume: p.reason, protocolKey: p.key, expected: p.expected, flips: p.flips })),
      protocol: [
        'warm = >= 3 discarded warm-ups in the same child process, then n measured requests (gc before each; heap sampled at every call boundary)',
        'cold = PostgreSQL restart only when no other client is connected (OS page cache NOT dropped) + fresh child; $connect and pool warm-up reported separately; one request',
        'fresh-clone reps = new clone from the template, >= 3 steady-state warm-ups of the same scope, the flips (admin connection), ONE measured request, verification, drop',
        'pg_stat_statements: per-request DELTA of the clone database counters (snapshots right before and right after, never reset); harness statements are tagged /* p5a-rec-admin */ and excluded',
      ],
    });
    // leftovers of an earlier (killed) run of this harness — the lock guarantees no other instance is running
    for (const c of (await listClones()).filter((x) => x.startsWith(CLONE_PREFIX))) await dropClone(ctx, c, 'leftover of an earlier run of this harness');

    const steady = plan.filter((p) => p.v.clone === 'steady' && p.todo > 0);
    if (steady.length) {
      const clone = `${CLONE_PREFIX}${a.scale}_steady`;
      await ensureClone(ctx, clone, `steady-state clone for ${steady.map((p) => p.v.name).join(', ')}`);
      try {
        for (const p of steady.filter((x) => x.v.mode === 'warm')) {
          if (ctx.stopping) break;
          const r = await childRun(ctx, p.v, { role: 'warm', clone, reps: p.reps }, a.warmups + p.reps);
          ran.push({ variant: p.v.name, childId: r.childId, ok: r.ok, result: r.result });
          if (!(await steadyIntact(ctx, clone))) {
            await dropClone(ctx, clone, 'steady clone changed — recreated');
            await ensureClone(ctx, clone, 'recreated steady-state clone');
          }
        }
        const cold = steady.find((x) => x.v.mode === 'cold');
        if (cold && !ctx.stopping) {
          for (let i = cold.done; i < cold.reps && !ctx.stopping; i += 1) {
            const r = await coldSample(ctx, cold.v, clone, i);
            ran.push({ variant: cold.v.name, rep: i, skipped: r.skipped, ok: r.ok ?? false, childId: r.childId ?? null, result: r.result ?? null });
            if (!r.skipped && !(await steadyIntact(ctx, clone))) {
              await dropClone(ctx, clone, 'steady clone changed — recreated');
              await ensureClone(ctx, clone, 'recreated steady-state clone');
            }
          }
        }
      } finally {
        await dropClone(ctx, clone, 'steady-state variants done');
      }
    }

    for (const p of plan.filter((x) => x.v.clone === 'fresh' && x.todo > 0)) {
      for (let rep = p.done; rep < p.reps && !ctx.stopping; rep += 1) {
        const clone = `${CLONE_PREFIX}${a.scale}_fresh`;
        await ensureClone(ctx, clone, `fresh clone for ${p.v.name} rep ${rep}`);
        let r;
        try {
          r = await childRun(ctx, p.v, { role: p.v.mode === 'pair' ? 'concurrent' : 'pending', clone, rep },
            (p.v.mode === 'pair' ? 2 * a.warmups : a.warmups) + 2);
        } finally {
          await dropClone(ctx, clone, `${p.v.name} rep ${rep} done`);
        }
        ran.push({ variant: p.v.name, rep, childId: r.childId, ok: r.ok, result: r.result });
      }
    }
  } catch (e) {
    fatal = errInfo(e);
    log(`FATAL: ${e?.stack ?? e}`);
    await appendResult(file, { type: 'event', runId, event: 'fatal', error: fatal }).catch(() => null);
  } finally {
    const leftovers = (await listClones().catch(() => [])).filter((x) => x.startsWith(CLONE_PREFIX));
    for (const c of leftovers) await dropClone(ctx, c, 'cleanup at exit').catch(() => null);
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
  const after = readJsonl(file);
  const summaries = [];
  for (const p of plan) {
    if (!p.todo && !a.force) continue; // nothing new for this variant in this run
    const s = variantSummary(ctx, p, after);
    summaries.push(s);
    await appendResult(file, s);
  }
  const clonesAlive = await listClones().catch(() => null);
  const ok = !fatal && ran.every((r) => r.ok || r.skipped) && summaries.every((s) => s.checksOk && s.complete);
  await appendResult(file, { type: 'run-end', runId, ok, fatal, durationMs: Date.now() - t0, ran, skipped, clonesAlive, endedAt: new Date().toISOString() });
  return { ok, scale: a.scale, runId, file, logFile: ctx.logFile, fatal, ran, skipped, clonesAlive,
    summaries: summaries.map((s) => ({ variant: s.variant, n: s.n, nOk: s.nOk, complete: s.complete, checksOk: s.checksOk, checksFailed: s.checksFailed, poolLimited: s.poolLimited,
      results: s.results, wallMsP50: s.wallMs.p50 })) };
}

function usage() {
  return `usage: node --expose-gc scripts/perf/recruiter/bench-reconcile.mjs --scale 1k|10k|100k [options]
  --scenario a[,b]     scenario (${SCENARIOS.join(', ')}) or variant (${VARIANTS.map((v) => v.name).join(', ')}); default: all
  --reps N             measured requests per selected variant (warm) / reps (fresh clone) / cold samples (default per variant)
  --cold-samples N     cold samples of steady_scoped.cold (default 3, or --reps when given)
  --warmups N          discarded warm-ups (>= 3, default ${DEFAULTS.warmups})
  --no-cold            skip steady_scoped.cold (no PostgreSQL restart)
  --timeout-s S        per-request timeout: the clone's active statements are cancelled (default ${DEFAULTS.timeoutS})
  --idle-wait-s S      cold: wait up to S s for other clients to leave before a restart, else skip (default ${DEFAULTS.idleWaitS})
  --clone-wait-s S     wait up to S s for a free clone slot (default ${DEFAULTS.cloneWaitS})
  --out name.jsonl     results file name in SCRATCH/results (default reconcile-<scale>.jsonl)
  --label text         free-text label stored in every record of this run
  --force              ignore earlier samples (summaries then use this run only)
  --list               print the plan (with expectations and resume state) and exit`;
}

function parseArgs(argv) {
  const a = { scale: null, scenarios: null, reps: null, coldSamples: null, warmups: DEFAULTS.warmups, noCold: false, timeoutS: DEFAULTS.timeoutS,
    idleWaitS: DEFAULTS.idleWaitS, cloneWaitS: DEFAULTS.cloneWaitS, out: null, label: null, force: false, list: false, child: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const val = () => {
      const x = argv[i + 1];
      if (x === undefined || x.startsWith('--')) throw new Error(`${k} needs a value`);
      i += 1;
      return x;
    };
    const int = (x, min) => {
      const n = Number(x);
      if (!Number.isInteger(n) || n < min) throw new Error(`${k} must be an integer >= ${min}`);
      return n;
    };
    if (k === '--scale') a.scale = scaleKey(val());
    else if (k === '--scenario' || k === '--variant') a.scenarios = val().split(',').map((x) => x.trim()).filter(Boolean);
    else if (k === '--reps') a.reps = int(val(), 1);
    else if (k === '--cold-samples') a.coldSamples = int(val(), 1);
    else if (k === '--warmups') a.warmups = int(val(), 3);
    else if (k === '--no-cold') a.noCold = true;
    else if (k === '--timeout-s') a.timeoutS = int(val(), 1);
    else if (k === '--idle-wait-s') a.idleWaitS = int(val(), 0);
    else if (k === '--clone-wait-s') a.cloneWaitS = int(val(), 0);
    else if (k === '--out') a.out = val();
    else if (k === '--label') a.label = val().slice(0, 200);
    else if (k === '--force') a.force = true;
    else if (k === '--list') a.list = true;
    else if (k === '--child') a.child = val();
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** Pure helpers, exported for unit checks only (importing this file runs nothing). */
export { VARIANTS, analyzeClient, duplication, flipPlan, expectations, logScan, logSnapshot, pgssDelta, rowLockMode, sqlKind, sqlTable, txOutcome, unionMs };

const isMain = process.argv[1] && resolve(process.argv[1]) === SELF;
if (isMain) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${usage()}`); process.exit(2); }
  if (a.help) { console.log(usage()); process.exit(0); }
  if (a.child) {
    childMain(a.child).then(() => process.exit(0), (e) => { console.error(e?.stack ?? e); process.exit(1); });
  } else if (!a.scale) {
    console.error(usage());
    process.exit(2);
  } else {
    parentMain(a).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }, (e) => { console.error(e?.stack ?? e); process.exit(1); });
  }
}
