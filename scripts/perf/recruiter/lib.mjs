/**
 * scripts/perf/recruiter/lib.mjs — SHARED LIBRARY of the Phase 6 Part 5a recruiter performance
 * baseline (infra phase). Harnesses import it; they must NOT modify it (extra helpers go in their
 * own file). See scripts/perf/recruiter/README.md for the full API.
 *
 * What it provides
 *   • path constants (repo, scratch result/log/manifest dirs, the disposable cluster);
 *   • the disposable-URL guard (dbUrl / assertDisposableUrl / guardProcessEnv);
 *   • connect(db) → a PrismaClient built EXACTLY like src/lib/prisma.js in production
 *     (new PrismaPg(...) adapter, pg default pool size) over a pg.Pool whose Client class records
 *     every SQL statement (driver level: text, ms, rows, backend pid, BEGIN/COMMIT included), plus
 *     an instrumented PROXY of that client that records every model / $queryRaw / $executeRaw /
 *     $transaction call (op, model, start/end, ms, result rows, approximate JSON bytes, error) and
 *     samples process.memoryUsage().heapUsed at every call boundary; mark/slice/measure per request;
 *   • summarize(samples) → { n, min, p50, p95, max, mean } (nearest-rank);
 *   • psql / clone / drop / restart / pg_stat_statements reset + snapshot helpers;
 *   • loadManifest(scale); appendResult(file, obj) (JSONL, environment header first);
 *   • a self-test: node scripts/perf/recruiter/lib.mjs --self-test [--db val_1k].
 *
 * SAFETY GUARD — every connection this module opens is checked by assertDisposableUrl(): the URL
 * must be postgresql://postgres@localhost:55510/<db>?host=/tmp/p5a-pg/sock (port in the authority,
 * the Unix socket /tmp/p5a-pg/sock, no password, no other parameter), anything else throws before
 * connecting. On import, a DATABASE_URL already present in the environment that is not such a URL
 * makes the import throw; when absent it is set (in this process only) to a sentinel database on
 * the disposable cluster, so an accidental use of the app's default client (src/lib/prisma.js)
 * can only ever reach the disposable cluster. .env files are never read. Clones are restricted to
 * the prefixes net_ / anc_ / rec_ / exp_ / val_, at most MAX_CLONES at once, and refused when less
 * than 4 GiB of disk would remain; templates are never dropped.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/generated/prisma/index.js';

// ── paths & constants ────────────────────────────────────────────────────────
export const REPO = '/home/user/code-agency';
export const PERF_DIR = join(REPO, 'scripts/perf/recruiter');
export const SCRATCH = '/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5a';
export const RESULTS_DIR = join(SCRATCH, 'results');
export const LOGS_DIR = join(SCRATCH, 'logs');
export const MANIFESTS_DIR = join(SCRATCH, 'manifests');
export const WORK_DIR = join(SCRATCH, 'work');
export const PG_BIN = '/usr/lib/postgresql/16/bin';
export const PG_ROOT = '/tmp/p5a-pg';
export const PG_DATA = join(PG_ROOT, 'data');
export const PG_SOCK = join(PG_ROOT, 'sock');
export const PG_LOG = join(PG_ROOT, 'log');
export const PG_PORT = 55510;
export const PG_SH = join(PERF_DIR, 'pg.sh');
export const SCALES = Object.freeze({ '1k': 1000, '10k': 10000, '100k': 100000 });
export const TEMPLATES = Object.freeze({ '1k': 'p5a_1k', '10k': 'p5a_10k', '100k': 'p5a_100k' });
export const BASE_DB = 'p5a_base';
export const CLONE_PREFIXES = Object.freeze(['net_', 'anc_', 'rec_', 'exp_', 'val_']);
export const MAX_CLONES = 2;
export const MIN_FREE_DISK_BYTES = 4 * 1024 ** 3;

const DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const CLONE_RE = /^(net|anc|rec|exp|val)_[a-z0-9_]{1,50}$/;

// ── guard ────────────────────────────────────────────────────────────────────
/** The disposable connection string of database `db` (validated name). */
export function dbUrl(db) {
  if (typeof db !== 'string' || !DB_NAME_RE.test(db)) throw new Error(`p5a guard: invalid database name ${JSON.stringify(db)}`);
  return `postgresql://postgres@localhost:${PG_PORT}/${db}?host=${PG_SOCK}`;
}

/** Throws unless `url` is the disposable cluster's Unix socket on port 55510. → { db } */
export function assertDisposableUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('p5a guard: REFUSED — not a URL'); }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const params = [...u.searchParams.keys()];
  const problems = [];
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') problems.push('protocol');
  if (u.username !== 'postgres' || u.password) problems.push('credentials');
  if (u.hostname !== 'localhost') problems.push('host');
  if (u.port !== String(PG_PORT)) problems.push('port (must be 55510 in the authority)');
  if (u.searchParams.get('host') !== PG_SOCK || params.some((k) => k !== 'host') || params.length !== 1) problems.push('socket (?host=/tmp/p5a-pg/sock only)');
  if (!DB_NAME_RE.test(db)) problems.push('database name');
  if (problems.length) throw new Error(`p5a guard: REFUSED connection string (${problems.join(', ')}) — only the disposable cluster /tmp/p5a-pg/sock:55510 is allowed`);
  return { db };
}

/**
 * Process-env guard (run on import): a DATABASE_URL that is not disposable → throw; none → set to a
 * sentinel database on the disposable cluster (this process only).
 */
export function guardProcessEnv(env = process.env) {
  if (env.DATABASE_URL) assertDisposableUrl(env.DATABASE_URL);
  else env.DATABASE_URL = dbUrl('p5a_default_client_unused');
  return env.DATABASE_URL;
}
guardProcessEnv();

// ── small utilities ──────────────────────────────────────────────────────────
export const now = () => performance.now();
export const heapUsed = () => process.memoryUsage().heapUsed;
/** Explicit GC (needs node --expose-gc). → true when it ran. */
export function gc() {
  if (typeof globalThis.gc === 'function') { globalThis.gc(); return true; }
  return false;
}
export function requireGc() {
  if (typeof globalThis.gc !== 'function') throw new Error('p5a: run node with --expose-gc');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nearest-rank summary of numeric samples → { n, min, p50, p95, max, mean } (nulls when n = 0). */
export function summarize(samples) {
  const xs = (Array.isArray(samples) ? samples : []).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0, min: null, p50: null, p95: null, max: null, mean: null };
  const rank = (q) => xs[Math.min(n, Math.max(1, Math.ceil(q * n))) - 1];
  return { n, min: xs[0], p50: rank(0.5), p95: rank(0.95), max: xs[n - 1], mean: xs.reduce((a, b) => a + b, 0) / n };
}

/**
 * Approximate JSON size of a value in bytes, WITHOUT building the string (no large allocation):
 * strings count their length + quotes (escapes ignored), numbers their decimal form, BigInt as a
 * quoted string, Date as an ISO string, Decimal-like objects via toJSON/toString.
 */
export function approxJsonBytes(value) {
  let bytes = 0;
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || v === undefined) { bytes += 4; continue; }
    switch (typeof v) {
      case 'string': bytes += Buffer.byteLength(v) + 2; continue;
      case 'number': bytes += String(v).length; continue;
      case 'boolean': bytes += v ? 4 : 5; continue;
      case 'bigint': bytes += String(v).length + 2; continue;
      case 'object': break;
      default: bytes += 4; continue;
    }
    if (v instanceof Date) { bytes += 26; continue; }
    if (Buffer.isBuffer(v)) { bytes += v.length * 2 + 2; continue; }
    if (Array.isArray(v)) { bytes += 2 + Math.max(0, v.length - 1); for (let i = v.length - 1; i >= 0; i -= 1) stack.push(v[i]); continue; }
    if (typeof v.toJSON === 'function' && v.constructor !== Object) { stack.push(v.toJSON()); continue; }
    const keys = Object.keys(v);
    bytes += 2 + Math.max(0, keys.length - 1);
    for (const k of keys) { bytes += Buffer.byteLength(k) + 3; stack.push(v[k]); }
  }
  return bytes;
}

const errInfo = (e) => (e ? { name: e.name ?? null, code: e.code ?? null, message: String(e.message ?? e).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 600) } : null);
const resultShape = (v) => {
  if (Array.isArray(v)) return { resultType: 'array', rows: v.length, value: null };
  if (v === null || v === undefined) return { resultType: 'null', rows: 0, value: null };
  if (typeof v === 'number' || typeof v === 'bigint') return { resultType: 'number', rows: null, value: Number(v) };
  return { resultType: 'object', rows: 1, value: null };
};

// ── recorder ─────────────────────────────────────────────────────────────────
/**
 * Collects calls (Prisma level), SQL statements (driver level), Prisma query events and heap
 * samples. Times are performance.now() milliseconds of this process. SQL texts are interned
 * (textId → recorder.texts[textId]) so repeated statements cost no memory.
 */
export class Recorder {
  constructor({ bytes = true, heap = true, sql = true } = {}) {
    this.opts = { bytes, heap, sql };
    this.calls = [];
    this.sql = [];
    this.prismaQueries = [];
    this.heap = [];
    this.texts = [];
    this.textIds = new Map();
    this.txSeq = 0;
  }
  textId(text) {
    const t = typeof text === 'string' ? text : String(text);
    let id = this.textIds.get(t);
    if (id === undefined) { id = this.texts.length; this.texts.push(t); this.textIds.set(t, id); }
    return id;
  }
  sampleHeap(label, callIndex = null) {
    if (!this.opts.heap) return null;
    const h = heapUsed();
    this.heap.push({ t: now(), heapUsed: h, label, call: callIndex });
    return h;
  }
  beginCall(info) {
    const c = { i: this.calls.length, op: info.op, model: info.model ?? null, kind: info.kind ?? null, txId: info.txId ?? null, parentTxId: info.parentTxId ?? null,
      start: now(), end: null, ms: null, rows: null, resultType: null, value: null, bytes: null, sizeMs: null, error: null, heapStart: null, heapEnd: null };
    this.calls.push(c);
    c.heapStart = this.sampleHeap('call-start', c.i);
    return c;
  }
  endCall(c, result, error) {
    c.end = now();
    c.ms = c.end - c.start;
    if (error) c.error = errInfo(error);
    else {
      Object.assign(c, resultShape(result));
      if (this.opts.bytes) { const t = now(); c.bytes = approxJsonBytes(result); c.sizeMs = now() - t; }
    }
    c.heapEnd = this.sampleHeap('call-end', c.i);
  }
  beginSql(text, pid, queued) {
    if (!this.opts.sql) return null;
    const s = { i: this.sql.length, textId: this.textId(text), start: now(), end: null, ms: null, rows: null, command: null, pid: pid ?? null, queued, error: null };
    this.sql.push(s);
    return s;
  }
  endSql(s, error, res) {
    if (!s) return;
    s.end = now();
    s.ms = s.end - s.start;
    if (error) s.error = errInfo(error);
    else { s.rows = res?.rowCount ?? (Array.isArray(res?.rows) ? res.rows.length : null); s.command = res?.command ?? null; }
  }
  prismaQuery(e) {
    this.prismaQueries.push({ i: this.prismaQueries.length, textId: this.textId(e?.query ?? ''), durationMs: Number(e?.duration ?? NaN), t: now(),
      ts: e?.timestamp instanceof Date ? e.timestamp.getTime() : null, paramsBytes: typeof e?.params === 'string' ? e.params.length : null });
  }
  /** A position in every stream. */
  mark(label = null) {
    return { label, t: now(), calls: this.calls.length, sql: this.sql.length, prismaQueries: this.prismaQueries.length, heap: this.heap.length, heapUsed: this.sampleHeap('mark') };
  }
  /** Everything recorded since `m`, with SQL texts resolved and a summary. */
  slice(m) {
    const end = now();
    const endHeap = this.sampleHeap('slice');
    const calls = this.calls.slice(m.calls);
    const sql = this.sql.slice(m.sql).map((s) => ({ ...s, text: this.texts[s.textId] }));
    const prismaQueries = this.prismaQueries.slice(m.prismaQueries).map((q) => ({ ...q, text: this.texts[q.textId] }));
    const heap = this.heap.slice(m.heap);
    let heapPeak = null;
    let heapMin = null;
    for (const h of heap) {
      if (heapPeak === null || h.heapUsed > heapPeak) heapPeak = h.heapUsed;
      if (heapMin === null || h.heapUsed < heapMin) heapMin = h.heapUsed;
    }
    const sumOf = (xs, k) => xs.reduce((a, x) => a + (typeof x[k] === 'number' && Number.isFinite(x[k]) ? x[k] : 0), 0);
    const leafCalls = calls.filter((c) => c.op !== '$transaction');
    return {
      label: m.label, start: m.t, end, wallMs: end - m.t, calls, sql, prismaQueries, heap,
      summary: {
        calls: leafCalls.length, transactions: calls.length - leafCalls.length,
        callMsSum: sumOf(leafCalls, 'ms'), rows: sumOf(leafCalls, 'rows'), bytes: sumOf(leafCalls, 'bytes'), sizeMs: sumOf(leafCalls, 'sizeMs'),
        errors: calls.filter((c) => c.error).length,
        sqlStatements: sql.length, sqlMsSum: sumOf(sql, 'ms'), sqlMsMax: sql.reduce((a, s) => Math.max(a, s.ms ?? 0), 0),
        sqlErrors: sql.filter((s) => s.error).length,
        sqlBegin: sql.filter((s) => /^\s*BEGIN/i.test(s.text)).length, sqlCommit: sql.filter((s) => /^\s*COMMIT/i.test(s.text)).length,
        sqlRollback: sql.filter((s) => /^\s*ROLLBACK/i.test(s.text)).length,
        prismaQueryEvents: prismaQueries.length, prismaQueryMsSum: sumOf(prismaQueries, 'durationMs'),
        heapStart: m.heapUsed, heapEnd: endHeap, heapPeak, heapMin,
      },
    };
  }
  reset() { this.calls = []; this.sql = []; this.prismaQueries = []; this.heap = []; }
}

// ── driver-level SQL capture (pg.Client subclass handed to the pool) ─────────
function instrumentedClientClass(rec) {
  return class InstrumentedClient extends pg.Client {
    query(config, values, callback) {
      if (config === null || config === undefined || typeof config.submit === 'function') return super.query(config, values, callback);
      const text = typeof config === 'string' ? config : config.text;
      // pg 8.20 internals (the public activeQuery / queryQueue getters are deprecated): how many
      // queries were already active or waiting on THIS connection when this one was issued.
      const queued = (this._activeQuery ? 1 : 0) + (Array.isArray(this._queryQueue) ? this._queryQueue.length : 0);
      const s = rec.beginSql(text, this.processID, queued);
      let cb = callback;
      let vals = values;
      if (typeof vals === 'function') { cb = vals; vals = undefined; }
      if (typeof cb === 'function') return super.query(config, vals, (err, res) => { rec.endSql(s, err, res); cb(err, res); });
      return super.query(config, vals).then((res) => { rec.endSql(s, null, res); return res; }, (err) => { rec.endSql(s, err); throw err; });
    }
  };
}

// ── Prisma-level proxy ───────────────────────────────────────────────────────
const MODEL_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create', 'createMany',
  'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', 'aggregate', 'groupBy', 'count']);
const RAW_OPS = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']);
const UNDERLYING = Symbol('p5a.underlyingPrismaPromise');

/** Keeps Prisma's laziness: the call starts (and is timed) on the first then/catch/finally. */
function lazyCall(rec, pp, info) {
  let run = null;
  const start = () => {
    if (!run) {
      const c = rec.beginCall(info);
      run = pp.then((v) => { rec.endCall(c, v); return v; }, (e) => { rec.endCall(c, undefined, e); throw e; });
    }
    return run;
  };
  return {
    then: (f, r) => start().then(f, r),
    catch: (r) => start().catch(r),
    finally: (f) => start().finally(f),
    [Symbol.toStringTag]: 'PrismaPromise',
    [UNDERLYING]: pp,
  };
}

function instrumentDelegate(delegate, model, rec, ctx) {
  return new Proxy(delegate, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof prop === 'string' && MODEL_OPS.has(prop) && typeof v === 'function') {
        return (...args) => lazyCall(rec, v.apply(target, args), { op: prop, model, txId: ctx.txId });
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function runTransaction(target, rec, ctx, arg, options) {
  if (typeof arg === 'function') {
    rec.txSeq += 1;
    const txId = rec.txSeq;
    const c = rec.beginCall({ op: '$transaction', kind: 'interactive', txId, parentTxId: ctx.txId });
    try {
      const out = await target.$transaction((tx) => arg(instrumentClient(tx, rec, { txId })), options);
      rec.endCall(c, out);
      return out;
    } catch (e) { rec.endCall(c, undefined, e); throw e; }
  }
  const list = Array.isArray(arg) ? arg.map((p) => (p && p[UNDERLYING]) || p) : arg;
  rec.txSeq += 1;
  const c = rec.beginCall({ op: '$transaction', kind: 'batch', txId: rec.txSeq, parentTxId: ctx.txId });
  try {
    const out = await target.$transaction(list, options);
    rec.endCall(c, out);
    return out;
  } catch (e) { rec.endCall(c, undefined, e); throw e; }
}

/**
 * A recording proxy of a PrismaClient (or of an interactive-transaction client). Pass it wherever
 * the services take `{ db }`. Model delegates, $queryRaw / $queryRawUnsafe / $executeRaw /
 * $executeRawUnsafe and $transaction (interactive or batch) are recorded; everything else is the
 * original client's.
 */
export function instrumentClient(client, rec, ctx = { txId: null }) {
  const delegates = new Map();
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop !== 'string') return value;
      if (RAW_OPS.has(prop) && typeof value === 'function') return (...args) => lazyCall(rec, value.apply(target, args), { op: prop, txId: ctx.txId });
      if (prop === '$transaction') return (arg, options) => runTransaction(target, rec, ctx, arg, options);
      if (value && typeof value === 'object' && !prop.startsWith('$') && !prop.startsWith('_') && typeof value.findMany === 'function') {
        if (!delegates.has(prop)) delegates.set(prop, instrumentDelegate(value, prop, rec, ctx));
        return delegates.get(prop);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Connect to a disposable database.
 * opts: { max (pool size; default = the pg default, 10, like production), sqlTrace = true (driver-level
 *         SQL capture), prismaQueryEvents = false (also subscribe to $on('query')), bytes = true
 *         (approximate JSON bytes per call), heap = true, warmConnections = 1 (pool connections
 *         opened right after $connect, reported separately), log = ['error'] (production) }
 * → { db (recording proxy), prisma (raw client), pool, rec, url, timings: { connectMs, poolWarmMs,
 *     warmConnections }, mark(label), slice(mark), measure(label, fn), sampleHeap(label), close() }
 */
export async function connect(db, opts = {}) {
  const { max, sqlTrace = true, prismaQueryEvents = false, bytes = true, heap = true, warmConnections = 1, log = ['error'] } = opts;
  const url = dbUrl(db);
  assertDisposableUrl(url);
  const rec = new Recorder({ bytes, heap, sql: sqlTrace });
  const poolConfig = { connectionString: url, ...(Number.isInteger(max) ? { max } : {}) };
  const pool = new pg.Pool(sqlTrace ? { ...poolConfig, Client: instrumentedClientClass(rec) } : poolConfig);
  const adapter = new PrismaPg(pool);
  const logOpt = prismaQueryEvents ? [...log.filter((l) => l !== 'query'), { emit: 'event', level: 'query' }] : log;
  const prisma = new PrismaClient({ adapter, log: logOpt });
  if (prismaQueryEvents) prisma.$on('query', (e) => rec.prismaQuery(e));
  const t0 = now();
  await prisma.$connect();
  const connectMs = now() - t0;
  const t1 = now();
  const n = Math.max(0, Math.min(Number.isInteger(warmConnections) ? warmConnections : 0, Number.isInteger(max) ? max : 10));
  if (n > 0) {
    const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
    await Promise.all(clients.map((c) => c.query('SELECT 1')));
    for (const c of clients) c.release();
  }
  const poolWarmMs = now() - t1;
  rec.reset();
  const proxy = instrumentClient(prisma, rec);
  const mark = (label) => rec.mark(label);
  const slice = (m) => rec.slice(m);
  const measure = async (label, fn) => {
    const m = rec.mark(label);
    let result;
    let error = null;
    try { result = await fn(proxy); } catch (e) { error = e; }
    return { ...rec.slice(m), result, error: errInfo(error) };
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await prisma.$disconnect();
    await pool.end();
  };
  return { db: proxy, prisma, pool, rec, url, database: db, timings: { connectMs, poolWarmMs, warmConnections: n }, mark, slice, measure, sampleHeap: (l) => rec.sampleHeap(l), close };
}

/** Import a module of src/lib/services (after the env guard ran). */
export async function importService(name) {
  if (!/^[A-Za-z0-9]+$/.test(name)) throw new Error('p5a: invalid service name');
  return import(join(REPO, 'src/lib/services', `${name}.js`));
}

// ── psql / admin helpers ─────────────────────────────────────────────────────
const psqlArgs = (db) => ['-X', '-h', PG_SOCK, '-p', String(PG_PORT), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1'];

/** Run SQL with psql (-At) on `db`; returns trimmed stdout. */
export function psql(db, sql, { timeoutMs = 540000 } = {}) {
  assertDisposableUrl(dbUrl(db));
  return execFileSync(join(PG_BIN, 'psql'), [...psqlArgs(db), '-At', '-c', sql], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }).trim();
}

/** Run a SQL file with psql (-q) on `db` with psql variables; stdout+stderr go to `logFile` when given. */
export function psqlFile(db, file, { vars = {}, logFile = null, timeoutMs = 540000 } = {}) {
  assertDisposableUrl(dbUrl(db));
  const args = [...psqlArgs(db), '-q'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  args.push('-f', file);
  const out = execFileSync(join(PG_BIN, 'psql'), args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (logFile) appendFileSync(logFile, out);
  return out;
}

/**
 * One query through a short-lived plain pg.Client (NOT the measured path). → rows
 * settings: optional session-local GUCs set first, e.g. { enable_mergejoin: 'off' } (names and
 * values are validated; the cluster configuration is never changed).
 */
export async function pgQuery(db, sql, params = [], { settings = null } = {}) {
  const url = dbUrl(db);
  assertDisposableUrl(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const [k, v] of Object.entries(settings ?? {})) {
      if (!/^[a-z_]{1,63}$/.test(k) || !/^[A-Za-z0-9_.]{1,32}$/.test(String(v))) throw new Error(`p5a: invalid setting ${k}`);
      await c.query(`SET ${k} = '${v}'`);
    }
    return (await c.query(sql, params)).rows;
  } finally { await c.end(); }
}

/** True when the disposable cluster accepts connections. */
export function clusterReady() {
  try { execFileSync(join(PG_BIN, 'pg_isready'), ['-q', '-h', PG_SOCK, '-p', String(PG_PORT), '-U', 'postgres']); return true; } catch { return false; }
}

/** Free bytes on the filesystem holding the cluster. */
export function freeDiskBytes(path = PG_ROOT) {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

export async function databaseSize(db) {
  const [r] = await pgQuery('postgres', 'SELECT pg_database_size($1)::bigint AS b', [db]);
  return Number(r.b);
}

export async function listDatabases() {
  return (await pgQuery('postgres', 'SELECT datname FROM pg_database ORDER BY 1')).map((r) => r.datname);
}

export async function listClones() {
  return (await listDatabases()).filter((d) => CLONE_RE.test(d));
}

/**
 * CREATE DATABASE <clone> TEMPLATE <template>. Refuses: a clone name without an allowed prefix, a
 * template that is not p5a_base / p5a_1k / p5a_10k / p5a_100k, MAX_CLONES clones already alive, or
 * less than MIN_FREE_DISK_BYTES left after the copy. strategy: 'FILE_COPY' (default, fast) | 'WAL_LOG'.
 * → { clone, template, ms, templateBytes, freeBytesBefore, freeBytesAfter }
 */
export async function cloneDb(template, clone, { strategy = 'FILE_COPY' } = {}) {
  if (![BASE_DB, ...Object.values(TEMPLATES)].includes(template)) throw new Error(`p5a: ${template} is not a p5a template`);
  if (!CLONE_RE.test(clone)) throw new Error(`p5a: clone name must start with ${CLONE_PREFIXES.join(' / ')}`);
  if (!['FILE_COPY', 'WAL_LOG'].includes(strategy)) throw new Error('p5a: strategy must be FILE_COPY or WAL_LOG');
  const clones = await listClones();
  if (clones.includes(clone)) throw new Error(`p5a: ${clone} already exists (drop it first)`);
  if (clones.length >= MAX_CLONES) throw new Error(`p5a: ${clones.length} clones alive (${clones.join(', ')}) — at most ${MAX_CLONES}; drop one first`);
  const templateBytes = await databaseSize(template);
  const freeBytesBefore = freeDiskBytes();
  if (freeBytesBefore - templateBytes < MIN_FREE_DISK_BYTES) {
    throw new Error(`p5a: refusing to clone ${template} (${templateBytes} B): only ${freeBytesBefore} B free, < 4 GiB would remain`);
  }
  const t0 = now();
  await pgQuery('postgres', `CREATE DATABASE "${clone}" TEMPLATE "${template}" STRATEGY ${strategy}`);
  const ms = now() - t0;
  return { clone, template, strategy, ms, templateBytes, freeBytesBefore, freeBytesAfter: freeDiskBytes() };
}

/** DROP DATABASE IF EXISTS <clone> WITH (FORCE) — clones only (never a template). → { clone, ms } */
export async function dropDb(clone) {
  if (!CLONE_RE.test(clone)) throw new Error(`p5a: refusing to drop ${clone} (only ${CLONE_PREFIXES.join(' / ')} clones)`);
  const t0 = now();
  await pgQuery('postgres', `DROP DATABASE IF EXISTS "${clone}" WITH (FORCE)`);
  return { clone, ms: now() - t0 };
}

/** pg.sh restart (fast shutdown + start, waits until ready). The OS page cache is NOT dropped. → { ms } */
export async function restartPg() {
  const t0 = now();
  execFileSync('bash', [PG_SH, 'restart'], { encoding: 'utf8', timeout: 180000 });
  for (let i = 0; i < 120 && !clusterReady(); i += 1) await sleep(250);
  return { ms: now() - t0 };
}

/** SELECT pg_stat_statements_reset() (cluster-wide counters), run from `db`. */
export async function pgssReset(db) {
  await pgQuery(db, 'SELECT pg_stat_statements_reset()');
  return { resetAt: new Date().toISOString() };
}

/** pg_stat_statements rows of database `db` (all statements incl. nested ones, track = all). */
export async function pgssSnapshot(db, { limit = 500, orderBy = 'total_exec_time' } = {}) {
  if (!['total_exec_time', 'calls', 'mean_exec_time', 'shared_blks_read', 'rows'].includes(orderBy)) throw new Error('p5a: invalid orderBy');
  return pgQuery(db, `SELECT queryid::text AS queryid, toplevel, calls::bigint AS calls, total_exec_time, mean_exec_time, min_exec_time,
      max_exec_time, stddev_exec_time, rows::bigint AS rows, shared_blks_hit::bigint AS shared_blks_hit, shared_blks_read::bigint AS shared_blks_read,
      shared_blks_dirtied::bigint AS shared_blks_dirtied, shared_blks_written::bigint AS shared_blks_written,
      temp_blks_read::bigint AS temp_blks_read, temp_blks_written::bigint AS temp_blks_written, blk_read_time, blk_write_time,
      wal_bytes::bigint AS wal_bytes, query
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = $1)
    ORDER BY ${orderBy} DESC LIMIT $2`, [db, limit]);
}

// ── manifests & results ──────────────────────────────────────────────────────
export function scaleKey(scale) {
  const k = typeof scale === 'number' ? Object.keys(SCALES).find((x) => SCALES[x] === scale) : String(scale).toLowerCase();
  if (!k || !SCALES[k]) throw new Error(`p5a: unknown scale ${scale} (1k | 10k | 100k)`);
  return k;
}

/** The dataset manifest of a scale ('1k' | '10k' | '100k' or 1000 | 10000 | 100000). */
export function loadManifest(scale) {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${scaleKey(scale)}.json`), 'utf8'));
}

let envCache = null;
/** Environment header of every result file (versions, host, cluster settings). */
export async function environment() {
  if (envCache) return envCache;
  const ver = (p) => { try { return JSON.parse(readFileSync(join(REPO, 'node_modules', p, 'package.json'), 'utf8')).version; } catch { return null; } };
  let pgVersion = null;
  let settings = null;
  try {
    pgVersion = (await pgQuery('postgres', 'SELECT version() AS v'))[0].v;
    settings = Object.fromEntries((await pgQuery('postgres', `SELECT name, setting FROM pg_settings WHERE name IN ('shared_buffers','work_mem',
      'max_connections','effective_cache_size','random_page_cost','jit','shared_preload_libraries','pg_stat_statements.track','track_io_timing',
      'log_lock_waits','deadlock_timeout','max_parallel_workers_per_gather','server_version')`)).map((r) => [r.name, r.setting]));
  } catch (e) { pgVersion = `unavailable: ${e.message}`; }
  let gitHead = null;
  try { gitHead = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { gitHead = null; }
  const cpus = os.cpus();
  envCache = {
    type: 'header', pgVersion, nodeVersion: process.version, prismaClient: ver('@prisma/client'), prismaCli: ver('prisma'),
    adapterPg: ver('@prisma/adapter-pg'), pgDriver: ver('pg'), gitHead, host: { cpus: cpus.length, cpuModel: cpus[0]?.model ?? null, totalMemBytes: os.totalmem(), platform: `${os.platform()} ${os.release()}` },
    pgSettings: settings, osPageCacheDropped: false, pid: process.pid, argv: process.argv.slice(1), startedAt: new Date().toISOString(),
  };
  return envCache;
}

/** Append one JSON line to `file` (relative → RESULTS_DIR); a new/empty file first gets the environment header. */
export async function appendResult(file, obj) {
  const path = isAbsolute(file) ? file : join(RESULTS_DIR, file);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || statSync(path).size === 0) appendFileSync(path, `${JSON.stringify(await environment())}\n`);
  appendFileSync(path, `${JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
  return path;
}

// ── self-test ────────────────────────────────────────────────────────────────
/**
 * Exercises the instrumentation on a clone (default val_1k from p5a_1k; created when missing and
 * dropped at the end unless keep = true). Read-only on the data except one transaction that is
 * rolled back. → report object (also appended to results/lib-selftest.jsonl).
 */
export async function runSelfTest({ db = 'val_1k', template = TEMPLATES['1k'], keep = false } = {}) {
  const report = { kind: 'lib-selftest', db, template, checks: {}, at: new Date().toISOString() };
  const check = (name, ok, extra = undefined) => { report.checks[name] = { ok: !!ok, ...(extra === undefined ? {} : { extra }) }; };
  check('summarize-nearest-rank', JSON.stringify(summarize([5, 1, 4, 2, 3])) === JSON.stringify({ n: 5, min: 1, p50: 3, p95: 5, max: 5, mean: 3 })
    && summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p95 === 10 && summarize([]).n === 0);
  let refused = false;
  try { assertDisposableUrl('postgresql://postgres@localhost/x?host=/tmp/p5a-pg/sock&port=55510'); } catch { refused = true; }
  let refused2 = false;
  try { assertDisposableUrl('postgresql://u:p@db.example.com:5432/prod'); } catch { refused2 = true; }
  check('guard-refuses-port-as-param-and-remote', refused && refused2);
  const created = !(await listDatabases()).includes(db);
  if (created) report.clone = await cloneDb(template, db);
  const conn = await connect(db, { prismaQueryEvents: true });
  report.timings = conn.timings;
  try {
    const manifest = loadManifest(template.replace('p5a_', ''));
    const recruiterId = manifest.recruiters.mixed.id;
    const m1 = conn.mark('model+raw');
    const [n, links, raw] = await Promise.all([
      conn.db.affiliate.count(),
      conn.db.recruiterAffiliateLink.findMany({ where: { recruiterId }, take: 5, select: { affiliateId: true } }),
      conn.db.$queryRaw`SELECT count(*)::int AS c FROM recruiter_reward_ledger WHERE "recruiterId" = ${recruiterId}`,
    ]);
    const s1 = conn.slice(m1);
    check('model-calls-recorded', s1.summary.calls === 3 && s1.calls.every((c) => typeof c.ms === 'number' && c.ms > 0),
      s1.calls.map((c) => ({ op: c.op, model: c.model, ms: c.ms, rows: c.rows, bytes: c.bytes })));
    check('sql-recorded-with-timings', s1.summary.sqlStatements >= 3 && s1.sql.every((s) => typeof s.ms === 'number'),
      s1.sql.map((s) => ({ ms: s.ms, rows: s.rows, text: s.text.slice(0, 120) })));
    check('results-plausible', n > 3000 && links.length === 5 && raw[0].c > 0, { affiliates: n, ledgerRowsOfMixed: raw[0].c });
    // interactive transaction, rolled back on purpose
    const m2 = conn.mark('tx');
    let rolledBack = false;
    try {
      await conn.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('p5a-selftest'))`;
        await tx.recruiterSettingsVersion.findFirst({ orderBy: { version: 'desc' } });
        throw Object.assign(new Error('p5a-selftest-rollback'), { code: 'SELFTEST' });
      });
    } catch (e) { rolledBack = e.code === 'SELFTEST'; }
    const s2 = conn.slice(m2);
    report.transactionSql = s2.sql.map((s) => s.text.slice(0, 80));
    check('transaction-recorded', rolledBack && s2.summary.transactions === 1 && s2.calls.filter((c) => c.txId).length === 3);
    check('begin-visible-at-driver', s2.summary.sqlBegin >= 1, { begin: s2.summary.sqlBegin, commit: s2.summary.sqlCommit, rollback: s2.summary.sqlRollback });
    const m3 = conn.mark('commit');
    await conn.db.$transaction(async (tx) => tx.recruiter.findUnique({ where: { id: recruiterId }, select: { id: true } }));
    await sleep(50); // let the query events of that transaction arrive
    const s3 = conn.slice(m3);
    check('commit-visible-at-driver', s3.summary.sqlCommit >= 1, { begin: s3.summary.sqlBegin, commit: s3.summary.sqlCommit, sql: s3.sql.map((s) => s.text.slice(0, 60)) });
    report.mechanism = {
      primary: 'driver level: pg.Pool({ Client: InstrumentedClient }) handed to new PrismaPg(pool) — every statement incl. BEGIN / COMMIT / ROLLBACK, sub-ms timings',
      driverStatementsInTx: s3.sql.map((s) => s.text.slice(0, 40)),
      prismaQueryEventsInTx: s3.prismaQueries.map((q) => q.text.slice(0, 40)),
      prismaEventsSeeBegin: s3.prismaQueries.some((q) => /^\s*BEGIN/i.test(q.text)),
      prismaEventsSeeCommit: s3.prismaQueries.some((q) => /^\s*COMMIT/i.test(q.text)),
      prismaEventDurationsWholeMs: s3.prismaQueries.every((q) => Number.isInteger(q.durationMs)),
    };
    // a real service through the proxy
    const { getNetworkStats } = await importService('recruiterNetworkService');
    const m4 = conn.mark('service');
    const stats = await getNetworkStats(recruiterId, { db: conn.db });
    const s4 = conn.slice(m4);
    check('service-through-proxy', stats.totals.affiliates === manifest.shapes.mixed.placed && s4.summary.calls >= 3,
      { affiliates: stats.totals.affiliates, calls: s4.summary.calls, sql: s4.summary.sqlStatements, wallMs: s4.wallMs });
    report.prismaQueryEvents = { fired: conn.rec.prismaQueries.length > 0, count: conn.rec.prismaQueries.length,
      sample: conn.rec.prismaQueries.slice(0, 3).map((q) => ({ durationMs: q.durationMs, text: conn.rec.texts[q.textId].slice(0, 100) })) };
    check('heap-sampled', s4.heap.length >= 2 * s4.summary.calls && s4.summary.heapPeak > 0);
    check('gc-available', typeof globalThis.gc === 'function', { note: 'run with node --expose-gc to enable explicit GC' });
    // batch transaction keeps Prisma laziness
    const m5 = conn.mark('batch');
    const [c1, c2] = await conn.db.$transaction([conn.db.recruiter.count(), conn.db.recruiterSettingsVersion.count()]);
    const s5 = conn.slice(m5);
    check('batch-transaction', c1 === 4 && c2 === 2 && s5.summary.transactions === 1, { recruiters: c1, versions: c2 });
    report.pgss = { statements: (await pgssSnapshot(db, { limit: 5 })).length };
  } finally {
    await conn.close();
    if (created && !keep) report.drop = await dropDb(db);
  }
  report.ok = Object.values(report.checks).every((c) => c.ok || c === report.checks['gc-available']);
  report.resultFile = await appendResult('lib-selftest.jsonl', report);
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const i = process.argv.indexOf('--db');
  const db = i > 0 ? process.argv[i + 1] : 'val_1k';
  runSelfTest({ db, keep: process.argv.includes('--keep') }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }, (e) => { console.error(e); process.exit(1); });
}
