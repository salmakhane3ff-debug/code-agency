#!/usr/bin/env node
/**
 * scripts/perf/recruiter/bench-ancestry.mjs — ANCESTRY HARNESS of the Phase 6 Part 5a recruiter
 * performance baseline. It measures the CURRENT implementation only: no optimisation, no logic change,
 * no repository write (raw JSONL goes to SCRATCH/results).
 *
 * TARGET (unchanged, called for real): recruiterCreateAffiliate(recruiterId, input, { db }) in
 * src/lib/services/recruiterAffiliateService.js. Its non-exported assertAncestryInNetwork walks the
 * parent chain with two queries per ancestor (link findUnique + affiliate findUnique) inside the
 * creation transaction, which holds the recruiter row lock (SELECT … FOR NO KEY UPDATE, its first
 * statement) until COMMIT / ROLLBACK. RECRUITER_AFFILIATE_LIMITS.ANCESTRY_MAX (read from the module,
 * 10000) caps the walk: a parent at depth 10000 is the deepest the code accepts, depth 10001 is refused
 * (PARENT_NOT_IN_NETWORK) after 10000 nodes. The unusable password is bcrypt-hashed BEFORE the
 * transaction. The walk is neither copied nor re-implemented here: every number comes from the real
 * service call made through lib.connect()'s recording proxy (PrismaPg adapter over a pg.Pool whose
 * Client records every statement, BEGIN / COMMIT / ROLLBACK included). The service runs with Prisma's
 * default interactive-transaction options (maxWait 2000 ms, timeout 5000 ms): it passes none, and
 * neither src/lib/prisma.js nor lib.connect() sets transactionOptions. A transaction that outlives them
 * fails (P2028); that is recorded as the result, never retried or hidden.
 *
 * RECORDS (JSONL, SCRATCH/results/ancestry-<scale>.jsonl, environment header first; every creation is
 * written as soon as it ends):
 *   run-start   options, clone (created / reused), connect timings, row counts (template / now), the
 *               resolved plan (every parent re-verified in SQL: depth, all ancestors linked, reaches a
 *               root or is a cycle) with its expected result and ancestry statement count.
 *   sample      one creation (phase warmup | measured): result (created / error code), createdId,
 *               totalMs, preTxMs (validation + bcrypt hash + id: service start → $transaction call),
 *               txMs ($transaction call), connAcquireMs, lock { stmtMs, heldMs (lock statement start →
 *               COMMIT/ROLLBACK end), heldAfterAcquireMs }, sql { inTx, ancestry, ancestryByText,
 *               fixedOverhead, … }, roles (calls / statements / ms per step of the creation), ancestry
 *               { nodes, walkMs, perNodeMs, sqlMs, callMs, engineOverheadMsSum, progressMs }, heap,
 *               checks + outcome (as-expected | differs), stmts (role, offset, ms) when ≤ 64 statements.
 *   contention  one probe: a rec_deep creation under a deep parent (holder) runs; as soon as its row
 *               lock is held, a shallow creation for the SAME recruiter (waiter) starts. Records the
 *               waiter's lock-statement wait (waitedMs), the holder's remaining hold (expectedWaitMs),
 *               a pg_stat_activity snapshot of the blocked waiter (wait event, blocking pids) and both
 *               creations' timings. Both run in this one Node process through the same client / pool
 *               (pool pre-warmed to 2 connections), so the waiter's bcrypt hash (bcryptjs, main thread)
 *               interleaves with the holder's walk — as two requests on one server instance would.
 *   verify      per variant: every created affiliate exists with the expected parent, inactive, linked
 *               to the right recruiter, one AFFILIATE_CREATED audit row with its requestId, one
 *               activation code; failed creations (refusal, P2028, harness timeout) left no row.
 *   adapted     a variant stopped early: a sample (warm-up included) exceeded --sample-limit-ms (default
 *               5 min) or had to be stopped (its backends terminated → result HARNESS_TIMEOUT).
 *   rows        row counts after each variant. run-end: rows added (this invocation / vs template),
 *               consistency (4 rows per created affiliate), clone size, clone drop.
 *   summary     per variant and result, over every measured sample of this run label in the file
 *               (resumed invocations included): nearest-rank n / min / p50 / p95 / max / mean. Appended
 *               at the end of every invocation: the latest summary of a variant covers all its samples.
 *
 * VARIANTS (parents from SCRATCH/manifests/<scale>.json, re-verified on the clone before measuring;
 * depth 1 = a root, the walk visits `depth` nodes = 2 × depth statements):
 *   shallow_d1, shallow_d3   rec_mixed, first node at depth 1 / 3                       20 reps
 *   mixed_maxdepth           rec_mixed, manifest deepestNode (13 / 16 / 20)              20 reps
 *   wide_root, wide_child    rec_wide, the wide root (depth 1) / its first child (2)     20 reps
 *   deep_d100, deep_d1000    rec_deep chain node at that depth                            10 reps
 *   deep_d5000, deep_d10000  (10k, 100k)                                                   5 reps
 *   deep_d10001              (100k) — refusal at the limit after 10000 nodes               3 reps
 *   contention               rec_deep: holder parent depth --holder-depth (default 1000),
 *                            waiter parent = the chain root (depth 1)                      3 probes
 *   default = all of the above that exist at the scale, in that order. Extras (only when named):
 *   noparent (rec_mixed, no parent: no walk), mixed_cycle (rec_mixed unplaced 2-cycle member: refused
 *   after 2 nodes), deep_d<N> for any 1 ≤ N ≤ chain length (10 reps ≤ 1000, 5 ≤ 10000, else 3).
 *   Warm-up: --warmup (default 3) discarded creations (probes for contention) per variant in the same
 *   process before its measured reps. GC (node --expose-gc) is forced before every sample.
 *
 * USAGE
 *   node --expose-gc scripts/perf/recruiter/bench-ancestry.mjs --scale 1k|10k|100k
 *        [--variant a,b,…] [--reps N] [--contention-reps N] [--warmup N] [--holder-depth N]
 *        [--run LABEL] [--out ancestry-<name>.jsonl] [--mode instrumented|bare] [--keep-clone]
 *        [--sample-limit-ms N] [--clone-wait-s N]
 *   node scripts/perf/recruiter/bench-ancestry.mjs --scale 100k --list      variants at a scale (no DB)
 *   node scripts/perf/recruiter/bench-ancestry.mjs --scale 10k --cleanup    drop anc_<scale> and exit
 *   --reps overrides every selected creation variant (and contention unless --contention-reps is set).
 *   --mode bare: the raw PrismaPg client with no SQL trace / call proxy (only total ms, result, heap):
 *   calibrates the instrumentation overhead; contention needs the trace and is skipped in bare mode.
 *
 * CLONE & GROWTH: ONE clone anc_<scale> (lib.cloneDb: prefix, ≤ 2 clones, ≥ 4 GiB must remain) serves
 * every sample of an invocation. Each creation appends 4 rows (affiliate, link, activation code, audit
 * row; all append-only by design) — the growth is recorded (rows / run-end). The clone is dropped at
 * the end of a completed invocation unless --keep-clone. RESUMABLE: measured samples already in the
 * output file for the same --run label, scale and mode are counted and only the missing reps run (an
 * existing anc_<scale> from an interrupted invocation is reused and its growth recorded); an adapted
 * variant counts as complete. Use a distinct --run / --out for checks so they never mix with baseline
 * samples.
 *
 * TIMING NOTES: instrumented mode records every SQL statement and Prisma call (lib), with bytes off and
 * the heap tracked cheaply: lib's per-call process.memoryUsage() (≈ 4.5 µs, 2 per call) would add
 * ≈ 0.18 s at depth 10000 inside the 5 s transaction budget, so this harness turns lib heap sampling
 * off and overrides Recorder.sampleHeap on its own instance with v8.getHeapStatistics().used_heap_size
 * (same counter, ≈ 0.3 µs, running peak / min, no array) at every call start / end, plus every 10 ms
 * and at sample start / end. The heap includes the recorder's own per-statement records. The OS page
 * cache is never dropped. Warm only (cold is out of scope here). Run timed passes only while nothing
 * else runs on the machine (the orchestrator serializes them). stdout carries only this harness's JSON
 * result: the client keeps the production log: ['error'], whose "prisma:error …" lines Prisma prints
 * with console.log — routed to stderr here; progress lines also go to stderr.
 *
 * SAFETY GUARD: refuses to run unless every connection string is the disposable cluster
 * (lib.assertDisposableUrl: postgresql://postgres@localhost:55510/<db>?host=/tmp/p5a-pg/sock); a
 * DATABASE_URL in the environment that is not disposable makes the lib import throw. It only creates,
 * writes to and drops its own clone anc_<scale> (never a template), reads the manifest, and appends to
 * SCRATCH/results/ancestry-*.jsonl. .env is never read; nothing in the repository is written.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import {
  PG_PORT, PG_SOCK, RESULTS_DIR, TEMPLATES, appendResult, assertDisposableUrl, cloneDb, clusterReady, connect, databaseSize,
  dbUrl, dropDb, environment, freeDiskBytes, gc, guardProcessEnv, importService, listClones, listDatabases, loadManifest, now,
  pgQuery, requireGc, scaleKey, summarize,
} from './lib.mjs';

// ── constants ────────────────────────────────────────────────────────────────
const HARNESS = 'bench-ancestry';
const RECORD_VERSION = 1;
const DEFAULT_ORDER = ['shallow_d1', 'shallow_d3', 'mixed_maxdepth', 'wide_root', 'wide_child', 'deep_d100', 'deep_d1000',
  'deep_d5000', 'deep_d10000', 'deep_d10001', 'contention'];
const EXTRAS = ['noparent', 'mixed_cycle'];
const DEFAULT_HOLDER_DEPTH = 1000;
const DEFAULT_WARMUP = 3;
const SAMPLE_LIMIT_MS = 5 * 60 * 1000;
const HEAP_INTERVAL_MS = 10;
const SETTLE_TIMEOUT_MS = 30000;
const STMT_DETAIL_MAX = 64;
// Validation-only planner settings for the setup walks (session-local; see README "Observation").
const PLAN_SETTINGS = { enable_mergejoin: 'off', enable_hashjoin: 'off' };
const COUNTED_TABLES = ['affiliates', 'recruiter_affiliate_links', 'affiliate_activation_codes', 'recruiter_audit_log'];

const BEGIN_RE = /^\s*BEGIN\b/i;
const TX_END_RE = /^\s*(COMMIT|ROLLBACK)\b/i;
const CONTROL_RE = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;
const LOCK_RE = /FROM\s+"recruiters"[\s\S]*FOR\s+NO\s+KEY\s+UPDATE/i;
// Prisma call (op:model) → step of recruiterCreateAffiliate (non-replay path; requestIds are unique).
const ROLE_OF_CALL = Object.freeze({
  '$queryRaw:': 'lock',
  'findFirst:recruiterAuditLog': 'idempotency',
  'findUnique:recruiterAffiliateLink': 'ancestryLink',
  'findUnique:affiliate': 'ancestryNode',
  'findFirst:affiliate': 'uniqueness',
  'create:affiliate': 'insertAffiliate',
  'create:recruiterAffiliateLink': 'insertLink',
  '$executeRaw:': 'activationLock',
  'updateMany:affiliateActivationCode': 'activationInvalidate',
  'create:affiliateActivationCode': 'activationInsert',
  'create:recruiterAuditLog': 'auditInsert',
  'findMany:recruiterAffiliateLink': 'networkIdSet',
});
const roleOf = (c) => ROLE_OF_CALL[`${c.op}:${c.model ?? ''}`] ?? `${c.op}:${c.model ?? ''}`;
const isAncestryRole = (role) => role === 'ancestryLink' || role === 'ancestryNode';

// ── small helpers ────────────────────────────────────────────────────────────
const log = (...xs) => console.error(new Date().toISOString().slice(11, 19), '[ancestry]', ...xs);
/** This harness's own stdout (JSON only; see the console.log note in main). */
const printJson = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
const errInfo = (e) => (e ? { name: e.name ?? null, code: e.code ?? null, message: String(e.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 500) } : null);
// A sample the harness had to stop (--sample-limit-ms: its backends were terminated) is HARNESS_TIMEOUT, whatever error that caused.
const resultOf = (res, err, guard = null) => (guard?.harnessTimeout ? 'HARNESS_TIMEOUT' : err ? String(err.code ?? err.name ?? 'ERROR') : res?.replayed ? 'replayed' : 'created');
const summ = (xs) => { const s = summarize(xs); return { n: s.n, min: r3(s.min), p50: r3(s.p50), p95: r3(s.p95), max: r3(s.max), mean: r3(s.mean) }; };
const sumOf = (xs) => xs.reduce((a, x) => a + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0);

/** Poll fn() until it returns a truthy value (→ that value) or timeoutMs elapses (→ null). */
async function waitFor(fn, timeoutMs, pollMs = 1) {
  const t0 = now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

/** Running heap peak / min from v8.getHeapStatistics().used_heap_size (= process.memoryUsage().heapUsed). */
function heapTracker() {
  const st = { peak: 0, min: Number.POSITIVE_INFINITY, n: 0, last: 0 };
  const sample = () => {
    const h = v8.getHeapStatistics().used_heap_size;
    st.n += 1;
    st.last = h;
    if (h > st.peak) st.peak = h;
    if (h < st.min) st.min = h;
    return h;
  };
  return {
    sample,
    reset() { st.peak = 0; st.min = Number.POSITIVE_INFINITY; st.n = 0; return sample(); },
    read() { return { peak: st.peak, min: st.min === Number.POSITIVE_INFINITY ? null : st.min, samples: st.n, last: st.last }; },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const VALUE_OPTS = new Set(['scale', 'variant', 'reps', 'contention-reps', 'warmup', 'holder-depth', 'run', 'out', 'mode', 'sample-limit-ms', 'clone-wait-s']);
const FLAG_OPTS = new Set(['keep-clone', 'list', 'cleanup', 'help']);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (VALUE_OPTS.has(k)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
      o[k] = v;
      i += 1;
    } else if (FLAG_OPTS.has(k)) o[k] = true;
    else throw new Error(`unknown option --${k}`);
  }
  return o;
}

function intOpt(o, k, dflt, min = 0) {
  if (o[k] === undefined) return dflt;
  const n = Number(o[k]);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${k} must be an integer >= ${min}`);
  return n;
}

function defaultReps(name) {
  if (name === 'contention') return 3;
  const d = /^deep_d(\d+)$/.exec(name);
  if (d) { const n = Number(d[1]); return n <= 1000 ? 10 : n <= 10000 ? 5 : 3; }
  return 20;
}

// ── variant catalog (manifest only, no DB) ───────────────────────────────────
/** Anchors of the deep chain known from the template manifest: depth → id (chain samples and their only child). */
function deepAnchors(m) {
  const deep = m.shapes.deep;
  const anchors = new Map([[1, deep.firstRootId]]);
  for (const [k, s] of Object.entries(deep.chainSamples ?? {})) {
    anchors.set(Number(k), s.id);
    if (s.firstChildId) anchors.set(Number(k) + 1, s.firstChildId); // the manifest is taken on the template: the chain child
  }
  return anchors;
}

/** A parent at depth n of the deep chain: { anchorId, anchorDepth, steps (walk up), expectDepth } or null. */
function deepParent(m, n) {
  if (!Number.isInteger(n) || n < 1 || n > m.shapes.deep.maxDepth) return null;
  let best = null;
  for (const [d, id] of deepAnchors(m)) if (d >= n && (!best || d < best.anchorDepth)) best = { anchorDepth: d, anchorId: id };
  return best ? { ...best, steps: best.anchorDepth - n, expectDepth: n, kind: 'chain' } : null;
}

/** Variant definition at this scale, or { unavailable: reason }. */
function variantDef(name, m, { holderDepth }) {
  const r = m.recruiters;
  const mixed = m.shapes.mixed;
  const wide = m.shapes.wide;
  const chain = m.shapes.deep.maxDepth;
  const create = (recruiter, shape, parent) => ({ name, type: 'create', recruiter, recruiterId: r[recruiter].id, shape, parent, reps: defaultReps(name) });
  const at = (id, expectDepth, kind = 'chain') => ({ anchorId: id, anchorDepth: expectDepth, steps: 0, expectDepth, kind });
  switch (name) {
    case 'noparent': return create('mixed', 'mixed', null);
    case 'shallow_d1': return mixed.firstNodeAtDepth?.['1'] ? create('mixed', 'mixed', at(mixed.firstNodeAtDepth['1'], 1)) : { unavailable: 'no depth-1 node in mixed' };
    case 'shallow_d3': return mixed.firstNodeAtDepth?.['3'] ? create('mixed', 'mixed', at(mixed.firstNodeAtDepth['3'], 3)) : { unavailable: 'no depth-3 node in mixed' };
    case 'mixed_maxdepth': return create('mixed', 'mixed', at(mixed.deepestNode.id, mixed.deepestNode.depth));
    case 'mixed_cycle': return mixed.unplacedIds?.length ? create('mixed', 'mixed', at(mixed.unplacedIds[0], null, 'cycle')) : { unavailable: 'no unplaced member' };
    case 'wide_root': return create('wide', 'wide', at(wide.wideRoot.id, 1));
    case 'wide_child': return wide.wideRoot.firstChildId ? create('wide', 'wide', at(wide.wideRoot.firstChildId, 2)) : { unavailable: 'wide root has no child' };
    case 'contention': {
      if (chain < 2) return { unavailable: 'chain too short' };
      const holder = deepParent(m, holderDepth);
      if (!holder) return { unavailable: `holder depth ${holderDepth} > chain length ${chain}` };
      return { name, type: 'contention', recruiter: 'deep', recruiterId: r.deep.id, shape: 'deep', holderDepth, holder, waiter: at(m.shapes.deep.firstRootId, 1), reps: defaultReps(name) };
    }
    default: {
      const d = /^deep_d([1-9][0-9]*)$/.exec(name);
      if (!d) return { unavailable: 'unknown variant' };
      const p = deepParent(m, Number(d[1]));
      return p ? create('deep', 'deep', p) : { unavailable: `chain length ${chain} < ${d[1]}` };
    }
  }
}

// ── SQL helpers (setup / verification only — never the measured path) ───────
const UP_WALK_SQL = `WITH RECURSIVE up AS (
    SELECT a.id, a."parentId", 0 AS k FROM affiliates a WHERE a.id = $1
    UNION ALL
    SELECT a.id, a."parentId", up.k + 1 FROM up JOIN affiliates a ON a.id = up."parentId" WHERE up.k < $2
  ) SELECT id FROM up WHERE k = $2`;
const UP_PATH_SQL = `WITH RECURSIVE up AS (
    SELECT a.id, a."parentId", 1 AS k FROM affiliates a WHERE a.id = $1
    UNION ALL
    SELECT a.id, a."parentId", up.k + 1 FROM up JOIN affiliates a ON a.id = up."parentId" WHERE up.k < $2
  )
  SELECT count(*)::int AS nodes, count(DISTINCT up.id)::int AS distinct_nodes,
         count(*) FILTER (WHERE l."recruiterId" = $3)::int AS linked, coalesce(bool_or(up."parentId" IS NULL), false) AS reaches_root
  FROM up LEFT JOIN recruiter_affiliate_links l ON l."affiliateId" = up.id`;

/** Resolve a parent spec to an id and verify its whole upward path in SQL. */
async function resolveAndVerify(clone, recruiterId, p, ancestryMax) {
  const t0 = now();
  let id = p.anchorId;
  if (p.steps > 0) {
    const rows = await pgQuery(clone, UP_WALK_SQL, [p.anchorId, p.steps], { settings: PLAN_SETTINGS });
    id = rows[0]?.id ?? null;
    if (!id) throw new Error(`p5a ancestry: could not walk ${p.steps} steps up from ${p.anchorId}`);
  }
  const cap = p.kind === 'cycle' ? 10 : p.expectDepth + 2;
  const [path] = await pgQuery(clone, UP_PATH_SQL, [id, cap, recruiterId], { settings: PLAN_SETTINGS });
  const chainOk = path.reaches_root && path.distinct_nodes === path.nodes && path.linked === path.nodes;
  const cycleOk = !path.reaches_root && path.distinct_nodes < path.nodes && path.linked === path.nodes;
  let expected;
  let problem = null;
  if (p.kind === 'cycle') {
    if (!cycleOk) problem = `expected a cycle, got ${JSON.stringify(path)}`;
    const c = Math.min(path.distinct_nodes, ancestryMax);
    expected = { result: 'PARENT_NOT_IN_NETWORK', ancestryNodes: c, ancestryStatements: 2 * c, parentDepth: null, cycleLength: path.distinct_nodes };
  } else {
    if (!chainOk || path.nodes !== p.expectDepth) problem = `expected depth ${p.expectDepth} fully linked to a root, got ${JSON.stringify(path)}`;
    const d = path.nodes;
    expected = d <= ancestryMax
      ? { result: 'created', ancestryNodes: d, ancestryStatements: 2 * d, parentDepth: d }
      : { result: 'PARENT_NOT_IN_NETWORK', ancestryNodes: ancestryMax, ancestryStatements: 2 * ancestryMax, parentDepth: d };
  }
  return { parentId: id, expected, verify: { ...path, cap, ok: !problem, problem, ms: r3(now() - t0), anchorDepth: p.anchorDepth, stepsUp: p.steps } };
}

async function rowCounts(db) {
  const [r] = await pgQuery(db, `SELECT ${COUNTED_TABLES.map((t) => `(SELECT count(*) FROM ${t})::int AS ${t}`).join(', ')}`);
  return r;
}
const diffCounts = (a, b) => (a && b ? Object.fromEntries(COUNTED_TABLES.map((t) => [t, (a[t] ?? 0) - (b[t] ?? 0)])) : null);

async function terminateCloneBackends(clone) {
  const rows = await pgQuery('postgres', 'SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()) t', [clone]);
  return rows[0]?.n ?? 0;
}

/** Created affiliates exist as expected; creations that failed (refusal, expiry, timeout) left no row. */
async function verifyCreated(ctx, variant, items) {
  const created = items.filter((x) => x.createdId);
  const notCreated = items.filter((x) => !x.createdId).map((x) => x.username);
  const problems = [];
  let rows = [];
  if (created.length) {
    rows = await pgQuery(ctx.clone, `SELECT a.id, a."parentId", a."isActive", a.username, l."recruiterId",
        (SELECT count(*)::int FROM recruiter_audit_log g WHERE g."entityType" = 'affiliate' AND g."entityId" = a.id AND g.action = 'AFFILIATE_CREATED') AS audit_rows,
        (SELECT g.details->>'requestId' FROM recruiter_audit_log g WHERE g."entityType" = 'affiliate' AND g."entityId" = a.id AND g.action = 'AFFILIATE_CREATED' LIMIT 1) AS request_id,
        (SELECT count(*)::int FROM affiliate_activation_codes c WHERE c."affiliateId" = a.id) AS codes
      FROM affiliates a LEFT JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id WHERE a.id = ANY($1::text[])`, [created.map((x) => x.createdId)]);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const x of created) {
    const r = byId.get(x.createdId);
    const bad = [];
    if (!r) bad.push('missing');
    else {
      if ((r.parentId ?? null) !== (x.parentId ?? null)) bad.push(`parent ${r.parentId} != ${x.parentId}`);
      if (r.isActive !== false) bad.push('active');
      if (r.recruiterId !== x.recruiterId) bad.push(`linked to ${r.recruiterId}`);
      if (r.username !== x.username) bad.push('username');
      if (r.audit_rows !== 1 || r.request_id !== x.requestId) bad.push(`audit ${r.audit_rows} / ${r.request_id}`);
      if (r.codes !== 1) bad.push(`codes ${r.codes}`);
    }
    if (bad.length) problems.push({ id: x.createdId, bad });
  }
  let leftRows = 0;
  if (notCreated.length) leftRows = (await pgQuery(ctx.clone, 'SELECT count(*)::int AS n FROM affiliates WHERE username = ANY($1::text[])', [notCreated]))[0].n;
  if (leftRows) problems.push({ notCreatedLeftRows: leftRows });
  return { kind: 'verify', variant, created: created.length, underExpectedParent: created.length - problems.filter((p) => p.id).length, notCreated: notCreated.length, notCreatedLeftRows: leftRows, ok: problems.length === 0, problems: problems.slice(0, 20) };
}

// ── analysis of one transaction's recorded calls + statements ────────────────
function analyzeTx(s, txCall, t0) {
  const calls = s.calls.filter((c) => c.txId === txCall.txId && c.op !== '$transaction').sort((a, b) => a.start - b.start);
  const inWindow = (q, c) => q.start >= c.start && (c.end === null || q.start <= c.end);
  const lockCall = calls.find((c) => c.op === '$queryRaw') ?? null;
  const lockSql = lockCall ? (s.sql.find((q) => LOCK_RE.test(q.text) && inWindow(q, lockCall)) ?? null) : null;
  let pid = lockSql?.pid ?? null;
  if (pid === null) pid = s.sql.find((q) => BEGIN_RE.test(q.text) && q.start >= txCall.start)?.pid ?? null;
  const onPid = pid === null ? [] : s.sql.filter((q) => q.pid === pid && q.start >= txCall.start);
  const bi = onPid.findIndex((q) => BEGIN_RE.test(q.text));
  const ei = bi < 0 ? -1 : onPid.findIndex((q, i) => i > bi && TX_END_RE.test(q.text));
  const txSql = bi < 0 ? [] : onPid.slice(bi, ei < 0 ? undefined : ei + 1);
  const begin = txSql[0] ?? null;
  const end = ei < 0 ? null : onPid[ei];

  const roles = {};
  const role = (name) => { roles[name] ??= { calls: 0, sql: 0, callMs: 0, sqlMs: 0 }; return roles[name]; };
  for (const c of calls) { const x = role(roleOf(c)); x.calls += 1; x.callMs += c.ms ?? 0; }
  const stmts = [];
  const ancSql = [];
  const ancTextIds = new Set();
  let unattributed = 0;
  let queued = 0;
  let ci = 0;
  for (const q of txSql) {
    let name = 'control';
    if (!CONTROL_RE.test(q.text)) {
      while (ci < calls.length && calls[ci].end !== null && calls[ci].end < q.start) ci += 1;
      const c = calls[ci];
      name = c && inWindow(q, c) ? roleOf(c) : 'unattributed';
      if (name === 'unattributed') unattributed += 1;
    }
    const x = role(name);
    x.sql += 1;
    x.sqlMs += q.ms ?? 0;
    if (q.queued) queued += 1;
    if (isAncestryRole(name)) { ancSql.push(q); ancTextIds.add(q.textId); }
    stmts.push([name, r3(q.start - t0), r3(q.ms)]);
  }
  for (const x of Object.values(roles)) { x.callMs = r3(x.callMs); x.sqlMs = r3(x.sqlMs); }

  const ancCalls = calls.filter((c) => isAncestryRole(roleOf(c)));
  const nodeCalls = ancCalls.filter((c) => roleOf(c) === 'ancestryNode');
  const linkCalls = ancCalls.filter((c) => roleOf(c) === 'ancestryLink');
  const walkStart = ancCalls[0]?.start ?? null;
  const walkEndCall = ancCalls.length ? ancCalls[ancCalls.length - 1] : null;
  const walkMs = walkStart !== null && walkEndCall?.end != null ? walkEndCall.end - walkStart : null;
  let progressMs = null;
  if (nodeCalls.length >= 100) {
    progressMs = [];
    for (let k = 1; k <= 10; k += 1) progressMs.push(r3(nodeCalls[Math.ceil((k * nodeCalls.length) / 10) - 1].end - walkStart));
  }
  const ancSqlMs = ancSql.map((q) => q.ms);
  const ancCallMs = ancCalls.map((c) => c.ms);
  return {
    pid, calls, txCall, begin, end, lockSql, txSql, stmts, roles, unattributed, queued,
    endedWith: end ? (/^\s*COMMIT/i.test(end.text) ? 'COMMIT' : 'ROLLBACK') : null,
    ancestry: {
      nodes: linkCalls.length, calls: ancCalls.length, sql: ancSql.length,
      sqlByText: txSql.filter((q) => ancTextIds.has(q.textId)).length,
      walkMs: r3(walkMs), perNodeMs: walkMs !== null && linkCalls.length ? r3(walkMs / linkCalls.length) : null,
      sqlMs: { sum: r3(sumOf(ancSqlMs)), ...summ(ancSqlMs) }, callMs: { sum: r3(sumOf(ancCallMs)), ...summ(ancCallMs) },
      engineOverheadMsSum: r3(sumOf(ancCallMs) - sumOf(ancSqlMs)), progressMs,
    },
  };
}

/** Wait until every statement recorded since `from` has ended and every BEGIN has its COMMIT / ROLLBACK. */
async function settle(rec, from) {
  const t0 = now();
  const ok = await waitFor(() => {
    const open = new Set();
    for (let i = from; i < rec.sql.length; i += 1) {
      const q = rec.sql[i];
      if (q.end === null) return null;
      const t = rec.texts[q.textId];
      if (BEGIN_RE.test(t)) open.add(q.pid);
      else if (TX_END_RE.test(t)) open.delete(q.pid);
    }
    return open.size === 0;
  }, SETTLE_TIMEOUT_MS, 2);
  return { settled: !!ok, waitedMs: r3(now() - t0) };
}

// ── one creation ─────────────────────────────────────────────────────────────
function makeInput(ctx, parentId) {
  ctx.seq += 1;
  const seq = ctx.seq;
  return { seq, input: { username: `${ctx.userPrefix}${String(seq).padStart(5, '0')}`, name: `Perf Ancestry ${seq}`, requestId: randomUUID(), ...(parentId ? { parentId } : {}) } };
}

/** Start one real service call; the returned object fills in as it settles. */
function startCreation(ctx, recruiterId, parentId) {
  const { seq, input } = makeInput(ctx, parentId);
  const run = { seq, input, recruiterId, parentId: parentId ?? null, t0: now(), t1: null, res: null, err: null, done: false };
  run.promise = ctx.service.recruiterCreateAffiliate(recruiterId, input, { db: ctx.db }).then(
    (res) => { run.t1 = now(); run.res = res; run.done = true; },
    (err) => { run.t1 = now(); run.err = err; run.done = true; },
  );
  return run;
}

/** Await a run with the per-sample limit; on expiry terminate the clone's backends (records the timeout). */
async function awaitRun(ctx, promise) {
  let timer = null;
  const expired = new Promise((res) => { timer = setTimeout(() => res('timeout'), ctx.sampleLimitMs); });
  const r = await Promise.race([promise.then(() => 'done'), expired]);
  clearTimeout(timer);
  if (r === 'done') return { harnessTimeout: false };
  log(`sample exceeded ${ctx.sampleLimitMs} ms: terminating the backends of ${ctx.clone}`);
  const terminated = await terminateCloneBackends(ctx.clone);
  let late = null;
  const settledLater = await Promise.race([promise.then(() => true), new Promise((res) => { late = setTimeout(() => res(false), 30000); })]);
  clearTimeout(late);
  return { harnessTimeout: true, terminatedBackends: terminated, settledAfterTerminate: settledLater };
}

const common = (ctx) => ({ harness: HARNESS, v: RECORD_VERSION, run: ctx.run, scale: ctx.scale, mode: ctx.mode, at: new Date().toISOString() });

function sideOf(run, a, expected, guard) {
  const result = resultOf(run.res, run.err, guard);
  return {
    seq: run.seq, username: run.input.username, parentId: run.parentId, result, error: errInfo(run.err), createdId: run.res?.row?.id ?? null,
    expectedResult: expected?.result ?? null,
    totalMs: r3(run.t1 - run.t0),
    preTxMs: a ? r3(a.txCall.start - run.t0) : null,
    txMs: a ? r3(a.txCall.ms) : null,
    pid: a?.pid ?? null,
    lockStmtMs: a?.lockSql ? r3(a.lockSql.ms) : null,
    lockHeldMs: a?.lockSql && a.end ? r3(a.end.end - a.lockSql.start) : null,
    sqlInTx: a ? a.txSql.length : null,
    ancestrySql: a ? a.ancestry.sql : null,
    walkMs: a ? a.ancestry.walkMs : null,
    endedWith: a?.endedWith ?? null,
  };
}

async function sample(ctx, v, phase, rep) {
  const { conn } = ctx;
  if (ctx.instrumented) conn.rec.reset();
  gc();
  const heapStart = ctx.heap.reset();
  const ticker = setInterval(ctx.heap.sample, HEAP_INTERVAL_MS);
  const mk = ctx.instrumented ? conn.mark(`${v.name}:${phase}:${rep}`) : null;
  const run = startCreation(ctx, v.recruiterId, v.parentId);
  const guard = await awaitRun(ctx, run.promise);
  const settled = ctx.instrumented ? await settle(conn.rec, mk.sql) : null;
  clearInterval(ticker);
  const heap = { start: heapStart, ...ctx.heap.read(), rssEnd: process.memoryUsage.rss() };
  const result = resultOf(run.res, run.err, guard);
  const rec = {
    ...common(ctx), kind: 'sample', variant: v.name, phase, rep, seq: run.seq, recruiter: v.recruiter, shape: v.shape,
    parentId: v.parentId, parentDepth: v.expected.parentDepth, expected: v.expected,
    result, error: errInfo(run.err), createdId: run.res?.row?.id ?? null, replayed: run.res?.replayed ?? null,
    activationReturned: run.res ? Boolean(run.res.activation?.code && run.res.activation?.expiresAt) : null,
    username: run.input.username, requestId: run.input.requestId,
    totalMs: run.t1 !== null ? r3(run.t1 - run.t0) : null,
    guard, settle: settled,
  };
  if (ctx.instrumented) {
    const s = conn.slice(mk);
    const txCalls = s.calls.filter((c) => c.op === '$transaction');
    const a = txCalls.length ? analyzeTx(s, txCalls[0], run.t0) : null;
    if (a) {
      Object.assign(rec, {
        preTxMs: r3(a.txCall.start - run.t0), txMs: r3(a.txCall.ms), postTxMs: a.txCall.end !== null && run.t1 !== null ? r3(run.t1 - a.txCall.end) : null,
        connAcquireMs: a.begin ? r3(a.begin.start - a.txCall.start) : null,
        tx: { pid: a.pid, statements: a.txSql.length, endedWith: a.endedWith, spanMs: a.begin && a.end ? r3(a.end.end - a.begin.start) : null, queuedStatements: a.queued, txCallError: a.txCall.error },
        lock: a.lockSql ? { stmtMs: r3(a.lockSql.ms), heldMs: a.end ? r3(a.end.end - a.lockSql.start) : null, heldAfterAcquireMs: a.end ? r3(a.end.end - a.lockSql.end) : null } : null,
        sql: {
          total: s.sql.length, inTx: a.txSql.length, outsideTx: s.sql.length - a.txSql.length, ancestry: a.ancestry.sql, ancestryByText: a.ancestry.sqlByText,
          fixedOverhead: a.txSql.length - a.ancestry.sql, unattributed: a.unattributed, calls: s.summary.calls, callErrors: s.summary.errors,
        },
        roles: a.roles,
        ancestry: a.ancestry,
        ...(a.txSql.length <= STMT_DETAIL_MAX ? { stmts: a.stmts } : {}),
      });
    }
    const checks = {
      resultAsExpected: result === v.expected.result,
      ancestryCallsAsExpected: a ? a.ancestry.calls === v.expected.ancestryStatements : v.expected.ancestryStatements === 0,
      ancestrySqlAsExpected: a ? a.ancestry.sql === v.expected.ancestryStatements : v.expected.ancestryStatements === 0,
      ancestryTextCountMatches: a ? a.ancestry.sqlByText === a.ancestry.sql : true,
      oneTransaction: txCalls.length === 1 && s.summary.sqlBegin === 1,
      txEndObserved: Boolean(a?.end),
      noStatementOutsideTx: a ? s.sql.length === a.txSql.length : s.sql.length === 0,
      settled: settled.settled,
    };
    rec.checks = checks;
    rec.outcome = checks.resultAsExpected && checks.ancestryCallsAsExpected && checks.ancestrySqlAsExpected ? 'as-expected' : 'differs';
    rec.instrumentationOk = checks.ancestryTextCountMatches && checks.oneTransaction && checks.txEndObserved && checks.noStatementOutsideTx && checks.settled;
  } else {
    rec.checks = { resultAsExpected: result === v.expected.result };
    rec.outcome = rec.checks.resultAsExpected ? 'as-expected' : 'differs';
  }
  rec.heap = heap;
  await appendResult(ctx.out, rec);
  if (ctx.instrumented) conn.rec.reset();
  ctx.items.push({ variant: v.name, createdId: rec.createdId, parentId: v.parentId, recruiterId: v.recruiterId, username: run.input.username, requestId: run.input.requestId });
  if (rec.createdId) ctx.createdAll.push(rec.createdId);
  log(`${v.name} ${phase} #${rep}: ${result} total=${rec.totalMs}ms`
    + (ctx.instrumented ? ` tx=${rec.txMs}ms lockHeld=${rec.lock?.heldMs}ms anc=${rec.sql?.ancestry}/${v.expected.ancestryStatements} inTx=${rec.sql?.inTx}` : '')
    + ` heapPeak=${(heap.peak / 1048576).toFixed(1)}MB${rec.outcome === 'as-expected' ? '' : ' [DIFFERS]'}${rec.instrumentationOk === false ? ' [INSTRUMENTATION CHECK FAILED]' : ''}`);
  return rec;
}

// ── contention probe ─────────────────────────────────────────────────────────
async function probe(ctx, v, phase, rep) {
  const { conn } = ctx;
  const rec = conn.rec;
  // two warm pool connections (unmeasured): the holder and the waiter each hold one for their transaction
  const clients = await Promise.all([conn.pool.connect(), conn.pool.connect()]);
  for (const c of clients) c.release();
  rec.reset();
  gc();
  const heapStart = ctx.heap.reset();
  const ticker = setInterval(ctx.heap.sample, HEAP_INTERVAL_MS);
  const mk = conn.mark(`contention:${phase}:${rep}`);
  let scanAt = mk.sql;
  const nextLock = () => {
    while (scanAt < rec.sql.length) { const q = rec.sql[scanAt]; scanAt += 1; if (LOCK_RE.test(rec.texts[q.textId])) return q; }
    return null;
  };
  const p0 = now();
  const holder = startCreation(ctx, v.recruiterId, v.holderParentId);
  const hl = await waitFor(() => nextLock() || (holder.done ? 'settled' : null), ctx.sampleLimitMs);
  const holderLock = hl && typeof hl === 'object' ? hl : null;
  if (holderLock) await waitFor(() => holderLock.end !== null || holder.done, ctx.sampleLimitMs);
  let waiter = null;
  let waiterLock = null;
  let evidence = null;
  let waiterStartAt = null;
  if (holderLock && holderLock.end !== null && !holderLock.error) {
    waiterStartAt = now();
    waiter = startCreation(ctx, v.recruiterId, v.waiterParentId);
    const wl = await waitFor(() => nextLock() || (waiter.done ? 'settled' : null), ctx.sampleLimitMs);
    waiterLock = wl && typeof wl === 'object' ? wl : null;
    if (waiterLock) {
      await sleep(50);
      if (waiterLock.end === null) {
        const at = now();
        try {
          const rows = await pgQuery(ctx.clone, `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
              round((extract(epoch FROM clock_timestamp() - state_change) * 1000)::numeric, 3)::float8 AS state_ms, left(query, 100) AS query
            FROM pg_stat_activity WHERE pid = $1`, [waiterLock.pid]);
          evidence = { atMs: r3(at - p0), row: rows[0] ?? null, waiterStillWaitingAfterQuery: waiterLock.end === null };
        } catch (e) { evidence = { atMs: r3(at - p0), error: errInfo(e) }; }
      } else evidence = { atMs: null, note: 'the waiter lock was granted within 50 ms (no snapshot taken)' };
    }
  }
  const guardH = await awaitRun(ctx, holder.promise);
  const guardW = waiter ? await awaitRun(ctx, waiter.promise) : null;
  const settled = await settle(rec, mk.sql);
  clearInterval(ticker);
  const heap = { start: heapStart, ...ctx.heap.read(), rssEnd: process.memoryUsage.rss() };
  const s = conn.slice(mk);
  const analyses = s.calls.filter((c) => c.op === '$transaction').map((c) => analyzeTx(s, c, p0));
  const ha = holderLock ? (analyses.find((a) => a.pid === holderLock.pid) ?? null) : (analyses[0] ?? null);
  const wa = waiterLock ? (analyses.find((a) => a.pid === waiterLock.pid) ?? null) : null;
  const holderSide = sideOf(holder, ha, v.holderExpected, guardH);
  const waiterSide = waiter ? sideOf(waiter, wa, v.waiterExpected, guardW) : null;
  const rel = (t) => (typeof t === 'number' ? r3(t - p0) : null);
  const holderEnd = ha?.end?.end ?? null;
  const timeline = {
    holderStart: rel(holder.t0), holderTxStart: rel(ha?.txCall.start), holderLockStart: rel(holderLock?.start), holderLockAcquired: rel(holderLock?.end),
    waiterStart: rel(waiterStartAt), waiterTxStart: rel(wa?.txCall.start), waiterLockStart: rel(waiterLock?.start),
    holderTxEnd: rel(holderEnd), waiterLockGranted: rel(waiterLock?.end), waiterTxEnd: rel(wa?.end?.end), holderDone: rel(holder.t1), waiterDone: rel(waiter?.t1),
  };
  const blockedBy = Array.isArray(evidence?.row?.blocked_by) ? evidence.row.blocked_by.map(Number) : [];
  const out = {
    ...common(ctx), kind: 'contention', variant: v.name, phase, rep, recruiter: 'deep', holderDepth: v.holderDepth,
    holder: holderSide, waiter: waiterSide, timeline,
    waitedMs: waiterLock ? r3(waiterLock.ms) : null,
    expectedWaitMs: waiterLock && holderEnd !== null ? r3(holderEnd - waiterLock.start) : null,
    lockGrantedAfterHolderEndMs: waiterLock?.end != null && holderEnd !== null ? r3(waiterLock.end - holderEnd) : null,
    evidence,
    checks: {
      waiterIssuedWhileHolderHeld: waiterLock && holderEnd !== null ? waiterLock.start < holderEnd : false,
      waiterBlockedByHolderSeen: Boolean(holderLock && blockedBy.includes(holderLock.pid) && evidence?.row?.wait_event_type === 'Lock'),
      waiterGrantedAfterHolderEnd: waiterLock?.end != null && holderEnd !== null ? waiterLock.end >= holderEnd : false,
      holderResultAsExpected: holderSide.result === v.holderExpected.result,
      waiterResultAsExpected: waiterSide ? waiterSide.result === v.waiterExpected.result : false,
      settled: settled.settled,
    },
    guard: { holder: guardH, waiter: guardW }, settle: settled, heap,
    note: 'one Node process, one PrismaPg client / pool (2 warm connections); the waiter starts when the holder\'s row-lock statement has returned; its bcrypt hash shares the event loop with the holder\'s walk',
  };
  await appendResult(ctx.out, out);
  rec.reset();
  for (const [side, x] of [[holder, v.holderParentId], [waiter, v.waiterParentId]]) {
    if (!side) continue;
    ctx.items.push({ variant: v.name, createdId: side.res?.row?.id ?? null, parentId: x, recruiterId: v.recruiterId, username: side.input.username, requestId: side.input.requestId });
    if (side.res?.row?.id) ctx.createdAll.push(side.res.row.id);
  }
  log(`contention ${phase} #${rep}: holder(d${v.holderDepth}) ${holderSide.result} lockHeld=${holderSide.lockHeldMs}ms; waiter ${waiterSide?.result ?? 'not started'} waited=${out.waitedMs}ms (expected ≈ ${out.expectedWaitMs}ms) blockedBySeen=${out.checks.waiterBlockedByHolderSeen}`);
  return out;
}

// ── results file (resume + summaries) ────────────────────────────────────────
function readRecords(path) {
  if (!existsSync(path)) return { records: [], corrupt: 0 };
  const records = [];
  let corrupt = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { corrupt += 1; }
  }
  return { records, corrupt };
}

const mine = (ctx) => (r) => r.harness === HARNESS && r.run === ctx.run && r.scale === ctx.scale && r.mode === ctx.mode;

/** Measured samples of this variant already in the file for this run label (an "adapted" record completes the variant). */
function doneCount(ctx, records, v) {
  const own = records.filter(mine(ctx));
  const sameVariant = (r) => r.variant === v.name && (v.type !== 'contention' || r.holderDepth === v.holderDepth);
  if (own.some((r) => r.kind === 'adapted' && sameVariant(r))) return Number.POSITIVE_INFINITY;
  return own.filter((r) => r.phase === 'measured' && (v.type === 'contention' ? r.kind === 'contention' : r.kind === 'sample') && sameVariant(r)).length;
}

function summaries(ctx, records, plan) {
  const out = [];
  const own = records.filter(mine(ctx)).filter((r) => r.phase === 'measured');
  for (const v of plan) {
    if (v.type === 'contention') {
      const xs = own.filter((r) => r.kind === 'contention' && r.holderDepth === v.holderDepth);
      if (!xs.length) continue;
      out.push({
        ...common(ctx), kind: 'summary', variant: v.name, holderDepth: v.holderDepth, n: xs.length,
        holderResults: countBy(xs.map((r) => r.holder?.result)), waiterResults: countBy(xs.map((r) => r.waiter?.result ?? 'not-started')),
        waitedMs: summ(xs.map((r) => r.waitedMs)), expectedWaitMs: summ(xs.map((r) => r.expectedWaitMs)),
        lockGrantedAfterHolderEndMs: summ(xs.map((r) => r.lockGrantedAfterHolderEndMs)),
        holderLockHeldMs: summ(xs.map((r) => r.holder?.lockHeldMs)), holderTotalMs: summ(xs.map((r) => r.holder?.totalMs)),
        waiterTotalMs: summ(xs.map((r) => r.waiter?.totalMs)), waiterTxMs: summ(xs.map((r) => r.waiter?.txMs)),
        blockedBySeen: xs.filter((r) => r.checks?.waiterBlockedByHolderSeen).length,
      });
      continue;
    }
    const xs = own.filter((r) => r.kind === 'sample' && r.variant === v.name);
    for (const [result, group] of Object.entries(groupBy(xs, (r) => r.result))) {
      out.push({
        ...common(ctx), kind: 'summary', variant: v.name, result, n: group.length, parentDepth: group[0].parentDepth,
        expected: group[0].expected, outcomes: countBy(group.map((r) => r.outcome)),
        totalMs: summ(group.map((r) => r.totalMs)), preTxMs: summ(group.map((r) => r.preTxMs)), txMs: summ(group.map((r) => r.txMs)),
        lockHeldMs: summ(group.map((r) => r.lock?.heldMs)), lockStmtMs: summ(group.map((r) => r.lock?.stmtMs)),
        walkMs: summ(group.map((r) => r.ancestry?.walkMs)), perNodeMs: summ(group.map((r) => r.ancestry?.perNodeMs)),
        ancestrySql: summ(group.map((r) => r.sql?.ancestry)), sqlInTx: summ(group.map((r) => r.sql?.inTx)),
        fixedOverheadValues: [...new Set(group.map((r) => r.sql?.fixedOverhead).filter((x) => x !== undefined))],
        idempotencySqlMs: summ(group.map((r) => r.roles?.idempotency?.sqlMs)),
        heapPeakBytes: summ(group.map((r) => r.heap?.peak)),
      });
    }
  }
  return out;
}
function countBy(xs) { const o = {}; for (const x of xs) o[String(x)] = (o[String(x)] ?? 0) + 1; return o; }
function groupBy(xs, f) { const o = {}; for (const x of xs) (o[f(x)] ??= []).push(x); return o; }

// ── main ─────────────────────────────────────────────────────────────────────
async function ensureClone(ctx, waitS) {
  if ((await listDatabases()).includes(ctx.clone)) return { reused: true, info: null };
  const t0 = now();
  for (;;) {
    try { return { reused: false, info: await cloneDb(ctx.template, ctx.clone) }; } catch (e) {
      if (/clones alive/.test(e.message) && (now() - t0) / 1000 < waitS) {
        log(`waiting for a clone slot (${e.message})`);
        await sleep(5000);
        continue;
      }
      throw e;
    }
  }
}

async function main() {
  // The client keeps the production log setting (log: ['error']); Prisma prints those events with
  // console.log (e.g. "prisma:error … Transaction not found" on P2028). Route console.log to stderr
  // so stdout carries only this harness's JSON (the write cost is of the same order).
  console.log = (...xs) => console.error(...xs);
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.scale) {
    console.error('usage: node --expose-gc scripts/perf/recruiter/bench-ancestry.mjs --scale 1k|10k|100k [--variant a,b] [--reps N] [--contention-reps N] [--warmup N] [--holder-depth N] [--run LABEL] [--out ancestry-<name>.jsonl] [--mode instrumented|bare] [--keep-clone] [--sample-limit-ms N] [--clone-wait-s N] | --list | --cleanup (see the header of this file)');
    process.exit(o.help ? 0 : 2);
  }
  const scale = scaleKey(o.scale);
  const manifest = loadManifest(scale);
  const holderDepth = intOpt(o, 'holder-depth', DEFAULT_HOLDER_DEPTH, 2);
  const names = o.variant ? o.variant.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_ORDER;
  const defs = names.map((n) => ({ n, d: variantDef(n, manifest, { holderDepth }) }));
  if (o.list) {
    const all = [...DEFAULT_ORDER, ...EXTRAS].map((n) => ({ n, d: variantDef(n, manifest, { holderDepth }) }));
    printJson(all.map(({ n, d }) => ({ variant: n, inDefaultSet: DEFAULT_ORDER.includes(n), available: !d.unavailable, reason: d.unavailable ?? null,
      recruiter: d.recruiter ?? null, depth: d.type === 'contention' ? { holder: d.holderDepth, waiter: 1 } : d.parent === null ? 0 : d.parent?.expectDepth ?? null,
      reps: d.reps ?? null })));
    return;
  }

  // safety guard: the disposable cluster only
  guardProcessEnv();
  const clone = `anc_${scale}`;
  const cloneUrl = dbUrl(clone);
  assertDisposableUrl(cloneUrl);
  if (!cloneUrl.includes(`localhost:${PG_PORT}/`) || !cloneUrl.endsWith(`?host=${PG_SOCK}`)) throw new Error('p5a ancestry: REFUSED — not the disposable cluster');
  if (!clusterReady()) throw new Error('p5a ancestry: the disposable cluster is not running (bash scripts/perf/recruiter/pg.sh start)');
  if (o.cleanup) {
    const existed = (await listDatabases()).includes(clone);
    const dropped = existed ? await dropDb(clone) : null;
    printJson({ ok: true, clone, existed, dropped });
    return;
  }
  requireGc();

  const mode = o.mode ?? 'instrumented';
  if (!['instrumented', 'bare'].includes(mode)) throw new Error('--mode must be instrumented or bare');
  const run = o.run ?? 'baseline';
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(run)) throw new Error('--run must match [a-z0-9][a-z0-9._-]{0,40}');
  const out = o.out ?? `ancestry-${scale}.jsonl`;
  if (!/^ancestry-[a-z0-9._-]+\.jsonl$/.test(out)) throw new Error('--out must be a file name ancestry-<name>.jsonl (written in SCRATCH/results)');
  const outPath = join(RESULTS_DIR, out);
  const warmup = intOpt(o, 'warmup', DEFAULT_WARMUP, 0);
  const repsOverride = o.reps !== undefined ? intOpt(o, 'reps', null, 1) : null;
  const contentionReps = o['contention-reps'] !== undefined ? intOpt(o, 'contention-reps', null, 1) : repsOverride;
  const ctx = {
    scale, run, mode, out, clone, template: TEMPLATES[scale], instrumented: mode === 'instrumented', seq: 0, items: [], createdAll: [],
    sampleLimitMs: intOpt(o, 'sample-limit-ms', SAMPLE_LIMIT_MS, 1000),
    userPrefix: `a${scale}.${Date.now().toString(36)}.`,
  };

  // the plan (from the manifest; unavailable variants are reported and skipped only when not named explicitly)
  const plan = [];
  const skipped = [];
  for (const { n, d } of defs) {
    if (d.unavailable) {
      if (o.variant) throw new Error(`variant ${n} is not available at ${scale}: ${d.unavailable}`);
      skipped.push({ variant: n, reason: d.unavailable });
      continue;
    }
    if (d.type === 'contention' && mode === 'bare') {
      if (o.variant) throw new Error('contention needs the SQL trace: not available in --mode bare');
      skipped.push({ variant: n, reason: 'bare mode (no SQL trace)' });
      continue;
    }
    plan.push({ ...d, target: d.type === 'contention' ? (contentionReps ?? d.reps) : (repsOverride ?? d.reps) });
  }
  const before = readRecords(outPath);
  for (const v of plan) v.done = doneCount(ctx, before.records, v);
  const todo = plan.filter((v) => v.done < v.target);
  log(`scale ${scale}, run "${run}", mode ${mode}, out ${outPath}; plan: ${plan.map((v) => `${v.name}${v.type === 'contention' ? `@d${v.holderDepth}` : ''} ${v.done === Number.POSITIVE_INFINITY ? 'adapted' : v.done}/${v.target}`).join(', ')}${skipped.length ? `; skipped: ${skipped.map((x) => x.variant).join(', ')}` : ''}`);

  if (!todo.length) {
    log('nothing left to measure for this run label');
    const existed = (await listDatabases()).includes(clone);
    if (existed) ctx.countsBeforeDrop = await rowCounts(clone);
    const dropped = existed && !o['keep-clone'] ? await dropDb(clone) : null;
    if (existed) {
      // a clone kept by an earlier invocation: record its final growth and its drop
      const templateCounts = Object.fromEntries(COUNTED_TABLES.map((t) => [t, manifest.rowCounts?.[t] ?? null]));
      const atEnd = ctx.countsBeforeDrop;
      await appendResult(out, { ...common(ctx), kind: 'run-end', ok: true, nothingToDo: true, rows: { atEnd, addedVsTemplate: diffCounts(atEnd, templateCounts) }, clone: { name: clone, dropped } });
    }
    const sums = summaries(ctx, before.records, plan);
    printJson({ ok: true, scale, run, mode, out: outPath, nothingToDo: true, cloneDropped: dropped, summaries: sums.map(brief) });
    return;
  }

  const freeBefore = freeDiskBytes();
  const cl = await ensureClone(ctx, intOpt(o, 'clone-wait-s', 0, 0));
  log(cl.reused ? `reusing the existing ${clone} (kept with --keep-clone or left by an interrupted invocation)` : `cloned ${ctx.template} → ${clone} in ${r3(cl.info.ms)} ms`);
  let conn = null;
  let fatal = null;
  const t0 = now();
  try {
    conn = await connect(clone, { heap: false, bytes: false, sqlTrace: ctx.instrumented, warmConnections: 2 });
    assertDisposableUrl(conn.url);
    ctx.conn = conn;
    ctx.heap = heapTracker();
    if (ctx.instrumented) conn.rec.sampleHeap = () => ctx.heap.sample(); // cheap per-call heap tracking (see TIMING NOTES)
    ctx.db = ctx.instrumented ? conn.db : conn.prisma;
    ctx.service = await importService('recruiterAffiliateService');
    const ancestryMax = ctx.service.RECRUITER_AFFILIATE_LIMITS.ANCESTRY_MAX;

    // resolve and verify every parent of the plan in SQL (setup, unmeasured)
    for (const v of todo) {
      if (v.type === 'contention') {
        const h = await resolveAndVerify(clone, v.recruiterId, v.holder, ancestryMax);
        const w = await resolveAndVerify(clone, v.recruiterId, v.waiter, ancestryMax);
        Object.assign(v, { holderParentId: h.parentId, holderExpected: h.expected, holderVerify: h.verify, waiterParentId: w.parentId, waiterExpected: w.expected, waiterVerify: w.verify });
        v.valid = h.verify.ok && w.verify.ok;
      } else if (v.parent) {
        const r = await resolveAndVerify(clone, v.recruiterId, v.parent, ancestryMax);
        Object.assign(v, { parentId: r.parentId, expected: r.expected, parentVerify: r.verify, valid: r.verify.ok });
      } else Object.assign(v, { parentId: null, expected: { result: 'created', ancestryNodes: 0, ancestryStatements: 0, parentDepth: 0 }, valid: true });
    }
    const env = await environment();
    const countsStart = await rowCounts(clone);
    const templateCounts = Object.fromEntries(COUNTED_TABLES.map((t) => [t, manifest.rowCounts?.[t] ?? null]));
    ctx.countsStart = countsStart;
    await appendResult(out, {
      ...common(ctx), kind: 'run-start', pid: process.pid,
      options: { variants: names, warmup, reps: repsOverride, contentionReps, holderDepth, sampleLimitMs: ctx.sampleLimitMs, keepClone: Boolean(o['keep-clone']) },
      env: { pgVersion: env.pgVersion, nodeVersion: env.nodeVersion, prismaClient: env.prismaClient, adapterPg: env.adapterPg, pgDriver: env.pgDriver, gitHead: env.gitHead },
      clone: { name: clone, template: ctx.template, reused: cl.reused, created: cl.info, sizeBytes: await databaseSize(clone), freeDiskBytesBefore: freeBefore },
      connect: conn.timings, ancestryMax, buildId: manifest.buildId,
      transactionOptions: 'Prisma defaults (maxWait 2000 ms, timeout 5000 ms): the service passes none; src/lib/prisma.js and lib.connect() set none',
      instrumentation: ctx.instrumented
        ? 'lib.connect({ sqlTrace: true, bytes: false, heap: false, warmConnections: 2 }) + Recorder.sampleHeap overridden on this instance (v8 used_heap_size at every call start/end) + 10 ms ticker; gc() before every sample'
        : 'bare: raw PrismaPg client, no SQL trace, no call proxy; heap by 10 ms ticker; gc() before every sample',
      rows: { template: templateCounts, atStart: countsStart, addedBeforeStartVsTemplate: diffCounts(countsStart, templateCounts) },
      plan: plan.map((v) => ({
        variant: v.name, type: v.type, recruiter: v.recruiter, recruiterId: v.recruiterId, target: v.target, doneBefore: v.done === Number.POSITIVE_INFINITY ? 'adapted' : v.done,
        ...(v.type === 'contention'
          ? { holderDepth: v.holderDepth, holderParentId: v.holderParentId ?? null, holderExpected: v.holderExpected ?? null, holderVerify: v.holderVerify ?? null,
            waiterParentId: v.waiterParentId ?? null, waiterExpected: v.waiterExpected ?? null, waiterVerify: v.waiterVerify ?? null }
          : { parentId: v.parentId ?? null, expected: v.expected ?? null, parentVerify: v.parentVerify ?? null }),
        valid: v.valid ?? null,
      })),
      skipped, corruptLinesBefore: before.corrupt,
    });
    const bad = todo.filter((v) => !v.valid);
    if (bad.length) throw new Error(`p5a ancestry: parent verification failed for ${bad.map((v) => v.name).join(', ')} (see run-start)`);

    for (const v of todo) {
      ctx.items = [];
      const isProbe = v.type === 'contention';
      log(`── ${v.name}${isProbe ? ` (holder depth ${v.holderDepth})` : ` (parent depth ${v.expected.parentDepth ?? 'cycle'}, expect ${v.expected.result}, ${v.expected.ancestryStatements} ancestry statements)`}: ${warmup} warm-up + ${v.target - v.done} measured`);
      // a sample (warm-up included) over --sample-limit-ms, or stopped by the harness, ends the variant ("adapted")
      const tooSlow = (r, phase, rep) => {
        const ms = isProbe ? Math.max(r.holder?.totalMs ?? 0, r.waiter?.totalMs ?? 0) : (r.totalMs ?? 0);
        const timedOut = isProbe ? Boolean(r.guard.holder?.harnessTimeout || r.guard.waiter?.harnessTimeout) : r.guard.harnessTimeout;
        return timedOut || ms > ctx.sampleLimitMs ? { phase, rep, ms, timedOut } : null;
      };
      let adapted = null;
      for (let w = 0; w < warmup && !adapted; w += 1) adapted = tooSlow(isProbe ? await probe(ctx, v, 'warmup', w) : await sample(ctx, v, 'warmup', w), 'warmup', w);
      let measured = v.done;
      for (let rep = v.done; rep < v.target && !adapted; rep += 1) {
        adapted = tooSlow(isProbe ? await probe(ctx, v, 'measured', rep) : await sample(ctx, v, 'measured', rep), 'measured', rep);
        measured = rep + 1;
      }
      if (adapted) {
        await appendResult(out, { ...common(ctx), kind: 'adapted', variant: v.name, ...(isProbe ? { holderDepth: v.holderDepth } : {}), stoppedAt: adapted, measured, target: v.target,
          reason: `a ${adapted.phase} sample took ${adapted.ms} ms (limit ${ctx.sampleLimitMs} ms${adapted.timedOut ? ', stopped by the harness' : ''}): the remaining reps were skipped; a resumed invocation with this --run label treats the variant as complete` });
        log(`${v.name}: adapted — remaining reps skipped (${adapted.phase} sample ${adapted.ms} ms)`);
      }
      await appendResult(out, { ...common(ctx), ...(await verifyCreated(ctx, v.name, ctx.items)) });
      await appendResult(out, { ...common(ctx), kind: 'rows', after: v.name, counts: await rowCounts(clone) });
    }
  } catch (e) {
    fatal = e;
  }

  // end of invocation: growth, clone, summaries
  const created = ctx.createdAll;
  let countsEnd = null;
  try { countsEnd = await rowCounts(clone); } catch (e) { log('row counts failed:', e.message); }
  if (conn) await conn.close();
  const templateCounts = Object.fromEntries(COUNTED_TABLES.map((t) => [t, manifest.rowCounts?.[t] ?? null]));
  const addedThis = diffCounts(countsEnd, ctx.countsStart);
  const endRec = {
    ...common(ctx), kind: 'run-end', ok: !fatal, error: errInfo(fatal), wallS: r3((now() - t0) / 1000),
    rows: {
      atEnd: countsEnd, addedThisInvocation: addedThis, addedVsTemplate: diffCounts(countsEnd, templateCounts),
      createdThisInvocation: created.length,
      consistent: addedThis ? COUNTED_TABLES.every((t) => addedThis[t] === created.length) : null,
      note: 'each created affiliate adds exactly 1 row to each of the 4 tables (refusals and expired transactions roll back)',
    },
    clone: { name: clone, sizeBytesEnd: countsEnd ? await databaseSize(clone).catch(() => null) : null, dropped: null },
  };
  if (!fatal && !o['keep-clone']) endRec.clone.dropped = await dropDb(clone);
  else if (fatal) log(`kept ${clone} for a resumed invocation (or drop it: --cleanup)`);
  await appendResult(out, endRec);
  const sums = summaries(ctx, readRecords(outPath).records, plan);
  for (const s of sums) await appendResult(out, s);
  printJson({ ok: !fatal, scale, run, mode, out: outPath, error: errInfo(fatal), rows: endRec.rows, clone: endRec.clone, clonesAlive: await listClones(), summaries: sums.map(brief) });
  if (fatal) { console.error(fatal); process.exitCode = 1; }
}

/** One line per summary for stdout. */
function brief(s) {
  if (s.holderDepth !== undefined) return { variant: s.variant, holderDepth: s.holderDepth, n: s.n, holderResults: s.holderResults, waiterResults: s.waiterResults, waitedMsP50: s.waitedMs.p50, waitedMsMax: s.waitedMs.max, blockedBySeen: s.blockedBySeen };
  return { variant: s.variant, result: s.result, n: s.n, parentDepth: s.parentDepth, outcomes: s.outcomes, totalMsP50: s.totalMs.p50, txMsP50: s.txMs.p50, lockHeldMsP50: s.lockHeldMs.p50, ancestrySql: s.ancestrySql.p50, fixedOverheadValues: s.fixedOverheadValues };
}

main().catch((e) => { console.error(e); process.exit(1); });
