/**
 * scripts/perf/recruiter/bench-network.mjs — NETWORK HARNESS of the Phase 6 Part 5a recruiter
 * performance baseline. It measures the CURRENT implementation and changes nothing in the app.
 *
 * What is measured
 *   • The REAL route bodies of src/lib/recruiterNetworkRouteHandlers.js (`stats`, `nodes`), built
 *     with recruiterNetworkHandlers({ db: <lib's recording PrismaPg proxy>, rateLimit: () => false })
 *     and called with a decoded recruiter token { type: 'recruiter', recruiterId, tv: tokenVersion }:
 *     the auth query (requireActiveRecruiter), the service (src/lib/services/
 *     recruiterNetworkService.js), the recruiterVisibility projection and Response.json are inside
 *     the timed window, and the body is read (arrayBuffer) for the status and the BYTES.
 *   • Breakdown series: `<shape>.tree` = loadNetworkTree alone (SQL ms vs JS build + sort ms). For
 *     every endpoint sample: JS ms = total − sum of SQL statement ms (also the overlap-free variant
 *     total − union of SQL intervals, and the time outside any Prisma call).
 *   • `deep.probe.pathlookup.d<depth>`: an ISOLATED PROBE (labelled as such, not an endpoint) of the
 *     handler's breadcrumb lookup affiliate.findMany({ where: { id: { in: page ids + path ids } } })
 *     with the same ids, so the bind-parameter behaviour of very long paths is known even where the
 *     full request times out.
 *   `--list` prints every variant of a scale with its parameters and the expectations (from the
 *   manifest) used by the plausibility checks.
 *
 * Protocol
 *   Every variant runs in its own CHILD process (node --expose-gc) under a watchdog. Warm: >= 3
 *   discarded warm-ups (only warm-up 0 computes approximate JSON bytes per call), then n measured
 *   requests (default 30 at 1k / 10k, 20 at 100k; 5 once a request took > 10 s; clamp(floor(240 s /
 *   slowest), 1, 3) once one took > 60 s). Before each request: recorder reset + explicit gc (heap
 *   baseline); peak = max heapUsed sampled at every Prisma call boundary and after the body read;
 *   retained = heapUsed after the response is dropped and gc ran, minus the baseline. A request that
 *   exceeds --timeout-s (default 300) is recorded as a timeout, its statements are cancelled
 *   (pg_cancel_backend) and the variant stops. canViewOrders=false series: pg_stat_statements is
 *   reset for the clone's database only before the first warm-up; afterwards both pg_stat_statements
 *   and the client SQL log must show zero statements touching affiliate_orders.
 *   Cold (--cold): PostgreSQL restart (lib.restartPg — the OS page cache is NOT dropped), a fresh
 *   child, $connect and the pool warm-up timed separately, then ONE timed request.
 *   Output: SCRATCH/results/network-<scale>.jsonl (header line, one `sample` line per request incl.
 *   warm-ups, `summary` per variant, `sql-texts`, `run` / `child` / `event` lines). Resumable: a
 *   variant with a complete summary for an equal or stronger protocol is skipped unless --force.
 *
 * SAFETY GUARD
 *   • Refuses to run unless lib.mjs still points at /tmp/p5a-pg/sock on port 55510 and every
 *     connection string (the process DATABASE_URL, the clone URL) passes lib.assertDisposableUrl.
 *   • Uses ONLY its own clone net_<scale> (lib.cloneDb: prefix check, <= 2 clones, >= 4 GiB of disk
 *     left) and drops it at the end (unless --keep-clone). Templates are never connected to.
 *   • The only data it writes is recruiters."canViewOrders" of the benchmark recruiters on that clone
 *     (restored to true and verified after every child). pg_stat_statements is reset for the clone's
 *     database only, never cluster-wide.
 *   • A cold sample restarts the cluster only when no other client is connected to it.
 *   • Never reads .env, never writes into the repository (results and logs go to the scratch dir).
 *
 * Usage
 *   node --expose-gc scripts/perf/recruiter/bench-network.mjs --scale 1k|10k|100k [--shape mixed|wide|deep]
 *     [--variant <name|prefix*>[,…]] [--reps N] [--warmups N] [--cold] [--cold-samples N] [--timeout-s S]
 *     [--force] [--out <file.jsonl>] [--keep-clone] [--clone-wait-s S] [--idle-wait-s S] [--list]
 *   Long runs (e.g. --scale 10k --shape deep, --scale 100k): start detached and wait in chunks —
 *     setsid -w nohup node --expose-gc scripts/perf/recruiter/bench-network.mjs --scale 100k > "$SCRATCH/logs/network-100k.out" 2>&1 < /dev/null &
 *     timeout 540 tail --pid=$! -f /dev/null      # repeat until it exits (-w keeps $! alive as long as node)
 *   Exit code: 0 when every variant ran and passed its plausibility checks / orders evidence; 1 otherwise
 *   (a timed-out variant has no checked result, so it makes the exit code 1; see the summary lines).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOGS_DIR, PG_PORT, PG_SOCK, REPO, RESULTS_DIR, SCALES, TEMPLATES,
  appendResult, assertDisposableUrl, cloneDb, clusterReady, connect, dbUrl, dropDb, freeDiskBytes, gc, heapUsed,
  listClones, loadManifest, now, pgQuery, requireGc, restartPg, scaleKey, summarize,
} from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const RESULT_MARK = 'P5A-NET-RESULT ';
const PAGE = 50; // the UI's page size (src/app/recruiter/network/page.jsx sends limit=50&cursor=N)
const DEFAULTS = Object.freeze({ reps: Object.freeze({ '1k': 30, '10k': 30, '100k': 20 }), warmups: 3, timeoutS: 300, coldSamples: 5, cloneWaitS: 600, idleWaitS: 300 });
const ADAPTIVE = Object.freeze({ slowMs: 10_000, slowReps: 5, verySlowMs: 60_000, verySlowBudgetMs: 240_000, verySlowMaxReps: 3 });
const ADMIN = '/* p5a-net-admin */'; // tags every harness-side (unmeasured) statement
const ORDERS_TABLE = 'affiliate_orders';
const SHAPES = Object.freeze(['mixed', 'wide', 'deep']);
const COLD_VARIANTS = Object.freeze(['mixed.stats.root.on', 'deep.stats.root.on', 'mixed.nodes.roots.p1.on', 'wide.nodes.children.first.on']);
const DEEP_BRANCH_DEPTHS = Object.freeze([10, 100, 1000, 10000]); // plus S-1, where they exist
const MAX_PARSE_BYTES = 256 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...xs) => process.stderr.write(`[bench-network ${new Date().toISOString()}] ${xs.join(' ')}\n`);
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

// ── guard ────────────────────────────────────────────────────────────────────
function assertSafeEnvironment() {
  if (PG_SOCK !== '/tmp/p5a-pg/sock' || PG_PORT !== 55510) throw new Error('bench-network: REFUSED — lib.mjs does not point at /tmp/p5a-pg/sock:55510');
  assertDisposableUrl(process.env.DATABASE_URL); // lib set or checked it on import
}

/** The clone's URL, refused unless it is a net_ clone on /tmp/p5a-pg/sock:55510. */
function cloneUrl(clone) {
  if (typeof clone !== 'string' || !/^net_[a-z0-9_]{1,40}$/.test(clone)) throw new Error(`bench-network: REFUSED — ${clone} is not a net_ clone`);
  const url = dbUrl(clone);
  assertDisposableUrl(url);
  const u = new URL(url);
  if (u.port !== '55510' || u.searchParams.get('host') !== '/tmp/p5a-pg/sock') throw new Error('bench-network: REFUSED — not the disposable cluster');
  return url;
}

function resultPath(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.jsonl$/.test(name)) throw new Error('bench-network: --out must be a plain file name ending in .jsonl (written under SCRATCH/results)');
  return join(RESULTS_DIR, name);
}
function assertResultPath(p) {
  const abs = resolve(p);
  if (!abs.startsWith(`${RESULTS_DIR}/`) || !abs.endsWith('.jsonl')) throw new Error(`bench-network: REFUSED — result file outside ${RESULTS_DIR}`);
  return abs;
}

// ── small utilities ──────────────────────────────────────────────────────────
function errorInfo(e) {
  if (!e) return null;
  const meta = e.meta && typeof e.meta === 'object' ? JSON.stringify(e.meta).slice(0, 400) : undefined;
  return {
    name: e.name ?? null, code: e.code ?? null,
    message: String(e.message ?? e).split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 800),
    ...(meta ? { meta } : {}), ...(e.cause?.code ? { causeCode: e.cause.code } : {}),
  };
}

/** Total length of the union of [start, end] intervals (end null → fallbackEnd). */
function unionMs(intervals, fallbackEnd) {
  const xs = intervals.map((x) => [x.start, x.end ?? fallbackEnd]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e)).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cs = null;
  let ce = null;
  for (const [s, e] of xs) {
    if (cs === null) { cs = s; ce = e; } else if (s > ce) { total += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e;
  }
  return cs === null ? 0 : total + (ce - cs);
}

const sumOf = (xs, f) => xs.reduce((a, x) => { const v = f(x); return a + (typeof v === 'number' && Number.isFinite(v) ? v : 0); }, 0);
const countBy = (xs, f) => { const o = {}; for (const x of xs) { const k = String(f(x)); o[k] = (o[k] ?? 0) + 1; } return o; };
const qs = (params) => {
  const p = new URLSearchParams(Object.entries(params ?? {}).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, String(x)])).toString();
  return p ? `?${p}` : '';
};
const poolState = (pool) => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });

/** SQL text → { key, tables, touchesOrders, command, bindParams }, cached per recorder textId. */
function makeTextInfo(tables) {
  const known = new Set(tables);
  const byId = new Map();
  const registry = {};
  return {
    registry,
    get(textId, text) {
      let info = byId.get(textId);
      if (info) return info;
      const t = String(text ?? '');
      const found = new Set();
      for (const m of t.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) if (known.has(m[1])) found.add(m[1]);
      let bindParams = 0;
      for (const m of t.matchAll(/\$(\d+)/g)) bindParams = Math.max(bindParams, Number(m[1]));
      const command = (t.replace(/^\s*(\/\*[\s\S]*?\*\/\s*)*/, '').match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
      info = { key: createHash('sha1').update(t).digest('hex').slice(0, 12), tables: [...found].sort(), touchesOrders: t.toLowerCase().includes(ORDERS_TABLE), command, bindParams };
      byId.set(textId, info);
      if (!registry[info.key]) registry[info.key] = { length: t.length, command, tables: info.tables, touchesOrders: info.touchesOrders, bindParams, head: t.slice(0, 600) };
      return info;
    },
  };
}

// ── variants ─────────────────────────────────────────────────────────────────
const onOff = (on) => (on ? 'on' : 'off');
const pageLen = (total, cursor) => Math.max(0, Math.min(PAGE, total - cursor));
const nextCur = (total, cursor) => (cursor + PAGE < total ? cursor + PAGE : null);
const lastCursor = (total) => (total > 0 ? Math.floor((total - 1) / PAGE) * PAGE : 0);
const pageParams = (cursor, extra = {}) => ({ ...extra, limit: String(PAGE), cursor: String(cursor) });
const histogramOf = (h) => Object.entries(h ?? {}).map(([k, n]) => [Number(k), n]).sort((a, b) => a[0] - b[0]);

/** Every variant of a scale, with request parameters and manifest-derived expectations. */
function buildPlan(scale, m) {
  const S = SCALES[scale];
  const out = [];
  const add = (v) => out.push({ params: {}, ordersOn: null, expect: {}, note: null, ...v, cold: COLD_VARIANTS.includes(v.name) });
  const rootPage = (roots, cursor, firstRootId) => ({ total: roots, nodes: pageLen(roots, cursor), nextCursor: nextCur(roots, cursor), nodeLevel: 1, pathLength: 0,
    parentId: null, parentLevel: null, ...(cursor === 0 && firstRootId ? { firstNodeId: firstRootId } : {}) });
  const childPage = (node, cursor) => ({ total: node.childrenCount, nodes: pageLen(node.childrenCount, cursor), nextCursor: nextCur(node.childrenCount, cursor),
    nodeLevel: node.depth + 1, pathLength: node.depth, parentId: node.id, parentLevel: node.depth, ...(cursor === 0 && node.firstChildId ? { firstNodeId: node.firstChildId } : {}) });

  // mixed
  const mx = m.shapes.mixed;
  add({ name: 'mixed.tree', shape: 'mixed', endpoint: 'tree', expect: { nodes: mx.placed, roots: mx.roots, unplaced: mx.unplaced, maxDepth: mx.maxDepth, members: mx.members } });
  for (const on of [true, false]) {
    add({ name: `mixed.stats.root.${onOff(on)}`, shape: 'mixed', endpoint: 'stats', ordersOn: on,
      expect: { rootId: null, affiliates: mx.placed, direct: mx.roots, maxLevel: mx.maxDepth, unplaced: mx.unplaced, levels: mx.maxDepth, levelHistogram: mx.depthHistogram, truth: true } });
  }
  const sub = mx.largestSubtreeRoot;
  for (const on of [true, false]) {
    add({ name: `mixed.stats.subtree.${onOff(on)}`, shape: 'mixed', endpoint: 'stats', ordersOn: on, params: { rootId: sub.id },
      expect: { rootId: sub.id, affiliates: sub.descendantsCount, direct: sub.childrenCount, unplaced: 0 },
      note: `rootId = manifest largestSubtreeRoot (depth ${sub.depth}, ${sub.childrenCount} children, ${sub.descendantsCount} descendants)` });
  }
  for (const on of [true, false]) {
    add({ name: `mixed.nodes.roots.p1.${onOff(on)}`, shape: 'mixed', endpoint: 'nodes', ordersOn: on, params: pageParams(0), expect: rootPage(mx.roots, 0, mx.firstRootId) });
  }
  add({ name: 'mixed.nodes.roots.p2.on', shape: 'mixed', endpoint: 'nodes', ordersOn: true, params: pageParams(PAGE), expect: rootPage(mx.roots, PAGE),
    note: mx.roots <= PAGE ? `only ${mx.roots} roots at this scale: cursor ${PAGE} is past the end (empty page)` : `cursor ${PAGE} of ${mx.roots} roots` });
  const lastRoots = lastCursor(mx.roots);
  add({ name: 'mixed.nodes.roots.last.on', shape: 'mixed', endpoint: 'nodes', ordersOn: true, params: pageParams(lastRoots), expect: rootPage(mx.roots, lastRoots, mx.firstRootId),
    note: `last page: cursor ${lastRoots} of ${mx.roots} roots` });
  const br = mx.branchNode;
  for (const on of [true, false]) {
    add({ name: `mixed.nodes.branch.${onOff(on)}`, shape: 'mixed', endpoint: 'nodes', ordersOn: on, params: pageParams(0, { parentId: br.id }), expect: childPage(br, 0),
      note: `parentId = manifest branchNode (depth ${br.depth}, ${br.childrenCount} children)` });
  }
  add({ name: 'mixed.nodes.unplaced.on', shape: 'mixed', endpoint: 'nodes', ordersOn: true, params: pageParams(0, { view: 'unplaced' }),
    expect: { total: mx.unplaced, nodes: pageLen(mx.unplaced, 0), nextCursor: nextCur(mx.unplaced, 0), nodeLevel: null, pathLength: 0, parentId: null, parentLevel: null, unplacedIds: mx.unplacedIds } });

  // wide
  const wd = m.shapes.wide;
  const wr = wd.wideRoot;
  add({ name: 'wide.tree', shape: 'wide', endpoint: 'tree', expect: { nodes: wd.placed, roots: wd.roots, unplaced: wd.unplaced, maxDepth: wd.maxDepth, members: wd.members } });
  for (const on of [true, false]) {
    add({ name: `wide.stats.root.${onOff(on)}`, shape: 'wide', endpoint: 'stats', ordersOn: on,
      expect: { rootId: null, affiliates: wd.placed, direct: wd.roots, maxLevel: wd.maxDepth, unplaced: wd.unplaced, levels: wd.maxDepth, levelHistogram: { 1: 1, 2: wd.placed - 1 }, truth: true } });
  }
  add({ name: 'wide.nodes.roots.p1.on', shape: 'wide', endpoint: 'nodes', ordersOn: true, params: pageParams(0), expect: rootPage(wd.roots, 0, wd.firstRootId) });
  for (const on of [true, false]) {
    add({ name: `wide.nodes.children.first.${onOff(on)}`, shape: 'wide', endpoint: 'nodes', ordersOn: on, params: pageParams(0, { parentId: wr.id }), expect: childPage(wr, 0),
      note: `children of the wide root (${wr.childrenCount}): first page` });
  }
  const mid = Math.floor(wr.childrenCount / 2 / PAGE) * PAGE;
  add({ name: 'wide.nodes.children.middle.on', shape: 'wide', endpoint: 'nodes', ordersOn: true, params: pageParams(mid, { parentId: wr.id }), expect: childPage(wr, mid),
    note: `children of the wide root: cursor ${mid} of ${wr.childrenCount}` });
  const lastKids = lastCursor(wr.childrenCount);
  add({ name: 'wide.nodes.children.last.on', shape: 'wide', endpoint: 'nodes', ordersOn: true, params: pageParams(lastKids, { parentId: wr.id }), expect: childPage(wr, lastKids),
    note: `children of the wide root: last page, cursor ${lastKids} of ${wr.childrenCount}` });

  // deep
  const dp = m.shapes.deep;
  add({ name: 'deep.tree', shape: 'deep', endpoint: 'tree', expect: { nodes: dp.placed, roots: dp.roots, unplaced: dp.unplaced, maxDepth: dp.maxDepth, members: dp.members } });
  for (const on of [true, false]) {
    add({ name: `deep.stats.root.${onOff(on)}`, shape: 'deep', endpoint: 'stats', ordersOn: on,
      expect: { rootId: null, affiliates: dp.placed, direct: dp.roots, maxLevel: dp.maxDepth, unplaced: dp.unplaced, levels: dp.maxDepth, levelsAllOne: true, truth: true } });
  }
  const half = dp.branchNode;
  add({ name: 'deep.stats.subtree.on', shape: 'deep', endpoint: 'stats', ordersOn: true, params: { rootId: half.id },
    expect: { rootId: half.id, affiliates: half.descendantsCount, direct: half.childrenCount, maxLevel: half.descendantsCount, unplaced: 0, levels: half.descendantsCount, levelsAllOne: true },
    note: `rootId = chain node at depth ${half.depth} (about half depth; ${half.descendantsCount} descendants)` });
  add({ name: 'deep.nodes.roots.p1.on', shape: 'deep', endpoint: 'nodes', ordersOn: true, params: pageParams(0), expect: rootPage(dp.roots, 0, dp.firstRootId) });
  const depths = [...new Set([...DEEP_BRANCH_DEPTHS, S - 1])].filter((d) => dp.chainSamples?.[String(d)]).sort((a, b) => a - b);
  for (const d of depths) {
    const node = dp.chainSamples[String(d)];
    add({ name: `deep.nodes.branch.d${d}.on`, shape: 'deep', endpoint: 'nodes', ordersOn: true, params: pageParams(0, { parentId: node.id }), expect: childPage(node, 0),
      note: `chain node at depth ${node.depth}: breadcrumb path of ${node.depth} entries, lookup of ${node.depth + pageLen(node.childrenCount, 0)} ids` });
  }
  for (const d of depths) {
    const node = dp.chainSamples[String(d)];
    add({ name: `deep.probe.pathlookup.d${d}`, shape: 'deep', endpoint: 'probe', params: { nodeId: node.id, depth: node.depth },
      expect: { pathLength: node.depth, lookupIds: node.depth + pageLen(node.childrenCount, 0) },
      note: 'ISOLATED PROBE, not an endpoint: the nodes handler\'s breadcrumb lookup affiliate.findMany({ where: { id: { in: [page ids, path ids] } }, select: { id, username, name } }) with the same ids; the path is computed by SQL outside the timed window' });
  }
  return out;
}

function selectPlan(plan, a) {
  let sel = plan;
  if (a.shapes) sel = sel.filter((v) => a.shapes.includes(v.shape));
  if (a.variants) {
    for (const p of a.variants) {
      const hit = plan.some((v) => (p.endsWith('*') ? v.name.startsWith(p.slice(0, -1)) : v.name === p));
      if (!hit) throw new Error(`bench-network: --variant ${p} matches no variant (see --list)`);
    }
    sel = sel.filter((v) => a.variants.some((p) => (p.endsWith('*') ? v.name.startsWith(p.slice(0, -1)) : v.name === p)));
  }
  if (a.cold) sel = sel.filter((v) => v.cold);
  return sel;
}

/** Complete summaries already in the result file → Map('<mode>:<variant>' → [summary]). */
function completedSummaries(file) {
  const done = new Map();
  if (!existsSync(file)) return done;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"type":"summary"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== 'summary' || o.complete !== true) continue;
    const k = `${o.mode}:${o.variant}`;
    if (!done.has(k)) done.set(k, []);
    done.get(k).push(o);
  }
  return done;
}
function alreadyDone(done, a, reps, v) {
  const list = done.get(`${a.cold ? 'cold' : 'warm'}:${v.name}`) ?? [];
  return list.some((s) => {
    const p = s.protocol ?? {};
    const timeoutOk = !(s.timeouts > 0) || (p.timeoutS ?? 0) >= a.timeoutS;
    if (a.cold) return (p.coldSamples ?? 0) >= a.coldSamples && timeoutOk;
    return (p.requestedReps ?? 0) >= reps && (p.warmups ?? 0) >= a.warmups && timeoutOk;
  });
}

// ── admin SQL (short-lived lib.pgQuery connections, never the measured path) ──
async function setCanViewOrders(clone, recruiterId, value) {
  const [before] = await pgQuery(clone, `${ADMIN} SELECT "canViewOrders" AS v FROM recruiters WHERE id = $1`, [recruiterId]);
  const rows = await pgQuery(clone, `${ADMIN} UPDATE recruiters SET "canViewOrders" = $2 WHERE id = $1 RETURNING "canViewOrders" AS v`, [recruiterId, value]);
  if (rows.length !== 1 || rows[0].v !== value) throw new Error(`bench-network: could not set canViewOrders=${value} for ${recruiterId}`);
  return { recruiterId, before: before?.v ?? null, after: rows[0].v, at: new Date().toISOString() };
}

async function restoreFlags(clone, ids) {
  const changed = await pgQuery(clone, `${ADMIN} UPDATE recruiters SET "canViewOrders" = true WHERE id = ANY($1::text[]) AND "canViewOrders" IS DISTINCT FROM true RETURNING id`, [ids]);
  const rows = await pgQuery(clone, `${ADMIN} SELECT id, "canViewOrders" AS v FROM recruiters WHERE id = ANY($1::text[])`, [ids]);
  return { restored: changed.map((r) => r.id), allTrue: rows.length === ids.length && rows.every((r) => r.v === true) };
}

/** pg_stat_statements reset for THIS database only (other databases' counters are untouched). */
async function pgssResetDb(clone) {
  await pgQuery(clone, `${ADMIN} SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = current_database()), 0)`);
  return new Date().toISOString();
}

/** This database's statements, harness statements (tagged ADMIN) excluded. */
async function pgssDb(clone) {
  return pgQuery(clone, `${ADMIN} SELECT queryid::text AS queryid, toplevel, calls::bigint AS calls, total_exec_time, mean_exec_time, min_exec_time, max_exec_time,
      rows::bigint AS rows, shared_blks_hit::bigint AS shared_blks_hit, shared_blks_read::bigint AS shared_blks_read,
      temp_blks_read::bigint AS temp_blks_read, temp_blks_written::bigint AS temp_blks_written, blk_read_time,
      (query ILIKE $1) AS touches_orders, length(query) AS query_length, left(query, 400) AS query
    FROM pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT LIKE $2
    ORDER BY total_exec_time DESC`, [`%${ORDERS_TABLE}%`, '%p5a-net-admin%']);
}

async function cancelActive(clone) {
  return pgQuery('postgres', `${ADMIN} SELECT pid, pg_cancel_backend(pid) AS cancelled, state,
      (extract(epoch FROM clock_timestamp() - query_start) * 1000)::float8 AS running_ms, left(query, 160) AS query
    FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() AND state <> 'idle'`, [clone]);
}

async function terminateClients(clone) {
  return pgQuery('postgres', `${ADMIN} SELECT pid, pg_terminate_backend(pid) AS terminated, state FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [clone]);
}

async function otherClients() {
  return pgQuery('postgres', `${ADMIN} SELECT pid, datname, state, application_name FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`);
}

async function waitClusterIdle(waitS) {
  const t0 = Date.now();
  for (;;) {
    const others = await otherClients();
    if (!others.length) return { ok: true, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 >= waitS * 1000) return { ok: false, waitedMs: Date.now() - t0, others: others.map((o) => `${o.datname}:${o.pid}:${o.state}`) };
    await sleep(2000);
  }
}

/** Independent SQL truth for whole-network stats: identity buckets and order counts of the placed members. */
async function rootTruth(clone, m, shape) {
  const rid = m.recruiters[shape].id;
  const s = m.shapes[shape];
  const unplaced = s.unplacedIds ?? [];
  if (unplaced.length !== s.unplaced) return { skipped: `manifest lists ${unplaced.length} of ${s.unplaced} unplaced ids` };
  const settings = { statement_timeout: '300000' };
  const [o] = await pgQuery(clone, `${ADMIN} SELECT count(*)::bigint AS total, count(*) FILTER (WHERE NOT o."isFake")::bigint AS real,
      count(*) FILTER (WHERE o."isFake")::bigint AS fake, count(*) FILTER (WHERE NOT o."isFake" AND o.status = 'delivered')::bigint AS real_delivered
    FROM affiliate_orders o JOIN recruiter_affiliate_links l ON l."affiliateId" = o."affiliateId"
    WHERE l."recruiterId" = $1 AND NOT (o."affiliateId" = ANY($2::text[]))`, [rid, unplaced], { settings });
  const idRows = await pgQuery(clone, `${ADMIN} SELECT iv.status, count(*)::int AS n FROM recruiter_affiliate_links l
      LEFT JOIN identity_verifications iv ON iv."affiliateId" = l."affiliateId"
    WHERE l."recruiterId" = $1 AND NOT (l."affiliateId" = ANY($2::text[])) GROUP BY 1`, [rid, unplaced], { settings });
  const identity = { APPROVED: 0, PENDING: 0, REJECTED: 0, NONE: 0 };
  for (const r of idRows) identity[['APPROVED', 'PENDING', 'REJECTED'].includes(r.status) ? r.status : 'NONE'] += r.n;
  return { source: 'independent SQL over the recruiter\'s linked members minus the manifest unplacedIds', identity,
    orders: { realTotal: Number(o.real), fakeTotal: Number(o.fake), realDelivered: Number(o.real_delivered), total: Number(o.total) } };
}

/** The ids the nodes handler looks up for parentId = nodeId: first page of children + the path root → node. */
async function probeLookup(clone, recruiterId, v) {
  const settings = { enable_mergejoin: 'off', enable_hashjoin: 'off', statement_timeout: '300000' };
  const up = await pgQuery(clone, `${ADMIN} WITH RECURSIVE up AS (
        SELECT a.id, a."parentId", 1 AS n FROM affiliates a WHERE a.id = $1
        UNION ALL
        SELECT p.id, p."parentId", up.n + 1 FROM up JOIN affiliates p ON p.id = up."parentId"
          JOIN recruiter_affiliate_links pl ON pl."affiliateId" = p.id AND pl."recruiterId" = $2
        WHERE up.n < $3
      ) SELECT id FROM up ORDER BY n DESC`, [v.params.nodeId, recruiterId, v.params.depth + 5], { settings });
  const kids = await pgQuery(clone, `${ADMIN} SELECT a.id FROM affiliates a JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id AND l."recruiterId" = $2
      WHERE a."parentId" = $1 ORDER BY a."createdAt", a.id LIMIT ${PAGE}`, [v.params.nodeId, recruiterId], { settings });
  const path = up.map((r) => r.id);
  return { lookup: [...new Set([...kids.map((r) => r.id), ...path])], pathLength: path.length, pageIds: kids.length };
}

// ── response facts & plausibility checks ─────────────────────────────────────
function statsFacts(body) {
  const s = body?.stats;
  if (!s || typeof s !== 'object') return { code: body?.code ?? null };
  const lv = Array.isArray(s.levels) ? s.levels : [];
  return {
    rootId: s.rootId ?? null, affiliates: s.totals?.affiliates, direct: s.totals?.direct, active: s.totals?.active, inactive: s.totals?.inactive,
    maxLevel: s.totals?.maxLevel, unplaced: s.totals?.unplaced, levels: lv.length,
    levelAffiliatesSum: sumOf(lv, (l) => l?.affiliates), levelsAllOne: lv.every((l) => l?.affiliates === 1),
    levelHistogram: lv.length <= 5000 ? lv.map((l) => [l?.level, l?.affiliates]) : null,
    identity: s.identity ?? null, identitySum: sumOf(Object.values(s.identity ?? {}), (x) => x),
    ordersNull: s.orders === null && lv.every((l) => l?.orders === null),
    ordersAllObjects: !!s.orders && typeof s.orders === 'object' && lv.every((l) => l?.orders && typeof l.orders === 'object'),
    orders: s.orders ? { realTotal: s.orders.real?.total, fakeTotal: s.orders.fake?.total, realDelivered: s.orders.real?.delivered } : null,
  };
}
function nodesFacts(body) {
  if (!Array.isArray(body?.nodes)) return { code: body?.code ?? null };
  const nodes = body.nodes;
  const path = Array.isArray(body.path) ? body.path : [];
  return {
    total: body.total, nodes: nodes.length, nextCursor: body.nextCursor, pathLength: path.length,
    pathLevelsOk: path.every((p, i) => p?.level === i + 1), pathUsernamesOk: path.every((p) => typeof p?.username === 'string'),
    parentId: body.parent?.id ?? null, parentLevel: body.parent?.level ?? null,
    nodeLevels: [...new Set(nodes.map((n) => n?.level ?? null))], firstNodeId: nodes[0]?.id ?? null, nodeIds: nodes.map((n) => n?.id ?? null),
    usernamesOk: nodes.every((n) => typeof n?.username === 'string'),
    ordersNull: nodes.every((n) => n?.orders === null), ordersAllObjects: nodes.every((n) => n?.orders && typeof n.orders === 'object'),
  };
}
function treeFacts(tree) {
  let maxDepth = 0;
  for (const n of tree.nodes.values()) if (n.depth > maxDepth) maxDepth = n.depth;
  return { nodes: tree.nodes.size, roots: tree.roots.length, members: tree.members, unplaced: tree.unplaced, maxDepth };
}
/** Compact facts kept in the sample line. */
function compactFacts(endpoint, f) {
  if (!f) return null;
  if (f.code !== undefined && Object.keys(f).length === 1) return f;
  if (endpoint === 'stats') {
    return { affiliates: f.affiliates, direct: f.direct, maxLevel: f.maxLevel, unplaced: f.unplaced, levels: f.levels, ordersNull: f.ordersNull, identity: f.identity, orders: f.orders };
  }
  if (endpoint === 'nodes') return { total: f.total, nodes: f.nodes, nextCursor: f.nextCursor, pathLength: f.pathLength, parentLevel: f.parentLevel, ordersNull: f.nodes > 0 ? f.ordersNull : null };
  return f;
}

function responseChecks(v, f, status, truth) {
  const c = {};
  const e = v.expect ?? {};
  const eq = (name, actual, expected) => { if (expected !== undefined) c[name] = { ok: actual === expected, actual, expected }; };
  if (!f) { c.response = { ok: false, actual: null, expected: 'a response' }; return c; }
  if (v.endpoint === 'stats') {
    eq('status', status, 200);
    eq('stats.rootId', f.rootId, e.rootId);
    eq('totals.affiliates', f.affiliates, e.affiliates);
    eq('totals.direct', f.direct, e.direct);
    eq('totals.maxLevel', f.maxLevel, e.maxLevel);
    eq('totals.unplaced', f.unplaced, e.unplaced);
    eq('levels.length', f.levels, e.levels);
    eq('levels.affiliates.sum', f.levelAffiliatesSum, e.affiliates);
    eq('identity.sum', f.identitySum, e.affiliates);
    if (e.levelsAllOne) eq('levels.eachOneAffiliate', f.levelsAllOne, true);
    if (e.levelHistogram && f.levelHistogram) eq('levels.histogram=manifest', JSON.stringify(f.levelHistogram), JSON.stringify(histogramOf(e.levelHistogram)));
    if (v.ordersOn) eq('orders.presentEverywhere', f.ordersAllObjects, true); else eq('orders.nullEverywhere', f.ordersNull, true);
    if (e.truth && truth && !truth.skipped) {
      eq('identity=sql', JSON.stringify(f.identity), JSON.stringify(truth.identity));
      if (v.ordersOn && f.orders) {
        eq('orders.real.total=sql', f.orders.realTotal, truth.orders.realTotal);
        eq('orders.fake.total=sql', f.orders.fakeTotal, truth.orders.fakeTotal);
        eq('orders.real.delivered=sql', f.orders.realDelivered, truth.orders.realDelivered);
      }
    }
  } else if (v.endpoint === 'nodes') {
    eq('status', status, 200);
    eq('total', f.total, e.total);
    eq('nodes.length', f.nodes, e.nodes);
    eq('nextCursor', f.nextCursor, e.nextCursor);
    eq('path.length', f.pathLength, e.pathLength);
    eq('parent.id', f.parentId, e.parentId);
    eq('parent.level', f.parentLevel, e.parentLevel);
    if (f.pathLength > 0) { eq('path.levels1..n', f.pathLevelsOk, true); eq('path.usernames', f.pathUsernamesOk, true); }
    if (f.nodes > 0) {
      if (e.nodeLevel !== undefined) eq('nodes.level', JSON.stringify(f.nodeLevels), JSON.stringify([e.nodeLevel]));
      eq('nodes.usernames', f.usernamesOk, true);
      if (v.ordersOn) eq('orders.presentEverywhere', f.ordersAllObjects, true); else eq('orders.nullEverywhere', f.ordersNull, true);
    }
    if (e.firstNodeId) eq('nodes[0].id=manifest', f.firstNodeId, e.firstNodeId);
    if (e.unplacedIds) eq('nodes⊆manifest.unplacedIds', f.nodeIds.every((id) => e.unplacedIds.includes(id)), true);
  } else if (v.endpoint === 'tree') {
    eq('tree.nodes', f.nodes, e.nodes);
    eq('tree.roots', f.roots, e.roots);
    eq('tree.members', f.members, e.members);
    eq('tree.unplaced', f.unplaced, e.unplaced);
    eq('tree.maxDepth', f.maxDepth, e.maxDepth);
  } else if (v.endpoint === 'probe') {
    eq('probe.pathLength', f.pathLength, e.pathLength);
    eq('probe.lookupIds', f.lookupIds, e.lookupIds);
    eq('probe.rows=lookupIds', f.rows, f.lookupIds);
  }
  return c;
}
const checksOk = (c) => Object.values(c ?? {}).every((x) => x.ok);
const failing = (c) => Object.fromEntries(Object.entries(c ?? {}).filter(([, x]) => !x.ok));

function adaptiveReps(requested, durations) {
  const xs = durations.filter((x) => typeof x === 'number' && Number.isFinite(x));
  const slowest = xs.length ? Math.max(...xs) : 0;
  if (slowest > ADAPTIVE.verySlowMs) {
    const n = Math.max(1, Math.min(ADAPTIVE.verySlowMaxReps, Math.floor(ADAPTIVE.verySlowBudgetMs / slowest)));
    return { reps: Math.min(requested, n), slowestMs: slowest, rule: 'a request took > 60 s: n = clamp(floor(240 s / slowest request), 1, 3)' };
  }
  if (slowest > ADAPTIVE.slowMs) return { reps: Math.min(requested, ADAPTIVE.slowReps), slowestMs: slowest, rule: 'a request took > 10 s: n = 5' };
  return { reps: requested, slowestMs: slowest, rule: null };
}

// ── child process: one variant ───────────────────────────────────────────────
async function childMain(spec) {
  const bootMs = now(); // ms since this process started (performance time origin)
  process.on('unhandledRejection', (e) => log('unhandledRejection (recorded, ignored):', e?.message ?? e));
  requireGc();
  assertSafeEnvironment();
  cloneUrl(spec.clone);
  const out = assertResultPath(spec.out);
  const v = spec.variant;
  const base = { runId: spec.runId, scale: spec.scale, shape: v.shape, variant: v.name, endpoint: v.endpoint, mode: spec.role };

  const tImport = now();
  const { recruiterNetworkHandlers } = await import(join(REPO, 'src/lib/recruiterNetworkRouteHandlers.js'));
  const { loadNetworkTree } = await import(join(REPO, 'src/lib/services/recruiterNetworkService.js'));
  const importMs = now() - tImport;
  const tConnect = now();
  const conn = await connect(spec.clone, { warmConnections: 3, bytes: false, heap: true, sqlTrace: true });
  const connectWallMs = now() - tConnect;
  const proc = { bootMs, importMs, connectMs: conn.timings.connectMs, poolWarmMs: conn.timings.poolWarmMs, warmConnections: conn.timings.warmConnections, connectWallMs };

  const textInfo = makeTextInfo(spec.tables);
  const decoded = { type: 'recruiter', recruiterId: spec.recruiterId, tv: spec.tokenVersion };
  const handlers = recruiterNetworkHandlers({ db: conn.db, rateLimit: () => false });
  const http = v.endpoint === 'stats' || v.endpoint === 'nodes';
  const url = http ? `http://local/api/recruiter/network/${v.endpoint}${qs(v.params)}` : null;
  const probe = v.endpoint === 'probe' ? await probeLookup(spec.clone, spec.recruiterId, v) : null;
  const exec = async (req) => {
    if (http) {
      const res = await handlers[v.endpoint](req, {}, decoded);
      const buf = await res.arrayBuffer();
      return { status: res.status, buf };
    }
    if (v.endpoint === 'tree') return { status: null, tree: await loadNetworkTree(spec.recruiterId, { db: conn.db }) };
    return { status: null, rows: await conn.db.affiliate.findMany({ where: { id: { in: probe.lookup } }, select: { id: true, username: true, name: true } }) };
  };

  const samples = [];
  const runOnce = async (phase, i, sizing) => {
    conn.rec.reset();
    conn.rec.opts.bytes = sizing; // approximate JSON bytes per call: only when sizing (cost outside call ms, inside wall)
    const req = http ? new Request(url) : null;
    gc(); gc();
    const heapBase = heapUsed();
    const rssBefore = process.memoryUsage.rss();
    const poolBefore = poolState(conn.pool);
    const startedAt = new Date().toISOString();
    const startEpochMs = Date.now();
    const mk = conn.mark(`${v.name}:${phase}:${i}`);
    const t0 = now();
    let tEnd = null;
    let res = null;
    let err = null;
    const work = exec(req).then((r) => { tEnd = now(); res = r; }, (e) => { tEnd = now(); err = e; });
    let timer = null;
    const winner = await Promise.race([work.then(() => 'done'), new Promise((r) => { timer = setTimeout(() => r('timeout'), spec.timeoutS * 1000); })]);
    clearTimeout(timer);
    let timeout = null;
    if (winner === 'timeout') {
      const at = now();
      let cancelled;
      try { cancelled = await cancelActive(spec.clone); } catch (e) { cancelled = [{ error: errorInfo(e) }]; }
      const settled = await Promise.race([work.then(() => true), sleep(60_000).then(() => false)]);
      timeout = { timeoutS: spec.timeoutS, elapsedAtTimeoutMs: at - t0, cancelled, settledAfterCancel: settled, settleMs: settled ? now() - at : null, afterCancel: err ? errorInfo(err) : (res ? { status: res.status } : null) };
    }
    const wallMs = timeout ? null : tEnd - t0;
    conn.sampleHeap('response-read');
    let sl = conn.slice(mk);
    let calls = sl.calls.filter((c) => c.op !== '$transaction');
    const stmts = [];
    const byTable = {};
    let ordersStatements = 0;
    for (const q of sl.sql) {
      const info = textInfo.get(q.textId, q.text);
      for (const t of info.tables) byTable[t] = (byTable[t] ?? 0) + 1;
      if (info.touchesOrders) ordersStatements += 1;
      stmts.push({ k: info.key, ms: q.ms, rows: q.rows, q: q.queued, pid: q.pid, ...(q.error ? { error: q.error } : {}), ...(q.end === null ? { unfinished: true } : {}) });
    }
    const sqlMsSum = sumOf(sl.sql, (q) => q.ms);
    const sqlWallMs = unionMs(sl.sql, sl.end);
    const callMsSum = sumOf(calls, (c) => c.ms);
    const callWallMs = unionMs(calls, sl.end);
    const lastCallEnd = calls.reduce((a, c) => Math.max(a, c.end ?? 0), 0);
    const firstCallStart = calls.reduce((a, c) => Math.min(a, c.start ?? Infinity), Infinity);
    const tWin = wallMs === null ? null : t0 + wallMs;
    let status = res?.status ?? null;
    let responseBytes = null;
    let bodySha1 = null;
    let facts = null;
    if (res?.buf) {
      const b = Buffer.from(res.buf);
      responseBytes = b.length;
      bodySha1 = sha1(b);
      if (b.length <= MAX_PARSE_BYTES) {
        try { const body = JSON.parse(b.toString('utf8')); facts = v.endpoint === 'stats' ? statsFacts(body) : nodesFacts(body); } catch (e) { facts = { parseError: errorInfo(e) }; }
      }
    } else if (res?.tree) facts = treeFacts(res.tree);
    else if (res?.rows) facts = { rows: res.rows.length, lookupIds: probe.lookup.length, pathLength: probe.pathLength, pageIds: probe.pageIds };
    if (!http) status = null;
    res = null;
    const ok = !timeout && !err && (http ? status === 200 : true);
    const checks = ok || facts ? responseChecks(v, facts, status, spec.truth) : null;
    const underlying = [
      ...calls.filter((c) => c.error).map((c) => ({ level: 'prisma-call', op: c.op, model: c.model, error: c.error })),
      ...sl.sql.filter((q) => q.error).map((q) => ({ level: 'sql', k: textInfo.get(q.textId, q.text).key, error: q.error })),
    ];
    const line = {
      type: 'sample', ...base, phase, i, startedAt,
      ok, status, wallMs, timeout, error: errorInfo(err), underlyingErrors: underlying.length ? underlying : undefined,
      responseBytes, bodySha1, resp: compactFacts(v.endpoint, facts), checksOk: checks ? checksOk(checks) : null, checkFailures: checks && !checksOk(checks) ? failing(checks) : undefined,
      calls: calls.map((c) => ({ op: c.op, model: c.model, ms: c.ms, rows: c.rows, ...(c.bytes !== null ? { bytes: c.bytes, sizeMs: c.sizeMs } : {}), ...(c.error ? { error: c.error } : {}) })),
      callCount: calls.length, callMsSum, callWallMs,
      sql: stmts, sqlCount: stmts.length, sqlMsSum, sqlMsMax: stmts.reduce((a, q) => Math.max(a, q.ms ?? 0), 0), sqlWallMs, sqlErrors: stmts.filter((q) => q.error).length,
      sqlByTable: byTable, ordersStatements, pids: [...new Set(stmts.map((q) => q.pid))],
      jsMs: wallMs === null ? null : wallMs - sqlMsSum,
      jsMsUnion: wallMs === null ? null : wallMs - sqlWallMs,
      outsideCallsMs: wallMs === null ? null : wallMs - callWallMs,
      beforeFirstCallMs: wallMs === null || !calls.length ? null : firstCallStart - t0,
      afterLastCallMs: wallMs === null || !calls.length ? null : tWin - lastCallEnd,
      heap: { baseline: heapBase, peak: sl.summary.heapPeak, peakDelta: sl.summary.heapPeak - heapBase, samples: sl.heap.length, rssBefore, rssAfter: process.memoryUsage.rss() },
      pool: { before: poolBefore, after: poolState(conn.pool) },
      sizing,
      ...(spec.role === 'cold' ? { coldStart: { ...proc, ...spec.cold, requestStartEpochMs: startEpochMs, restartToRequestMs: spec.cold?.restartDoneEpochMs ? startEpochMs - spec.cold.restartDoneEpochMs : null } } : {}),
    };
    const keep = { phase, i, ok, status, wallMs, timeout: !!timeout, responseBytes, bodySha1, sqlCount: line.sqlCount, sqlMsSum, sqlWallMs, callMsSum, callWallMs,
      jsMs: line.jsMs, jsMsUnion: line.jsMsUnion, outsideCallsMs: line.outsideCallsMs, afterLastCallMs: line.afterLastCallMs, beforeFirstCallMs: line.beforeFirstCallMs,
      ordersStatements, orderModelCalls: calls.filter((c) => c.model === 'affiliateOrder').length, callCount: calls.length, byTable,
      heapPeakDelta: line.heap.peakDelta, heapRetainedDelta: null, heapBaseline: heapBase, heapPeak: line.heap.peak,
      checks, resp: line.resp, error: line.error, underlying: line.underlyingErrors,
      callsDetail: sizing ? line.calls : null, stmts: phase === 'measured' && i === 0 ? stmts : null };
    // retained: drop everything of this request except the compact records above (a few KB), then gc
    sl = null;
    calls = null;
    facts = null;
    conn.rec.reset();
    gc(); gc();
    const retained = heapUsed();
    line.heap.retained = retained;
    line.heap.retainedDelta = retained - heapBase;
    keep.heapRetainedDelta = line.heap.retainedDelta;
    await appendResult(out, line);
    samples.push(keep);
    return keep;
  };

  let flag = null;
  let pgssResetAt = null;
  let stopped = null;
  let adaptive = { reps: spec.reps, slowestMs: 0, rule: null };
  let fatal = null;
  try {
    if (spec.role === 'warm') {
      if (v.ordersOn === false) flag = await setCanViewOrders(spec.clone, spec.recruiterId, false);
      pgssResetAt = await pgssResetDb(spec.clone);
      const durations = []; // a timed-out request counts with its lower bound (the timeout)
      for (let i = 0; i < spec.warmups && !stopped; i += 1) {
        const s = await runOnce('warmup', i, i === 0);
        durations.push(s.timeout ? spec.timeoutS * 1000 : s.wallMs);
        if (s.timeout) stopped = `warm-up ${i} timed out (> ${spec.timeoutS} s): variant stopped`;
      }
      adaptive = stopped ? { reps: 0, slowestMs: Math.max(...durations), rule: 'not applied: the variant stopped after a timeout' } : adaptiveReps(spec.reps, durations);
      for (let i = 0; i < adaptive.reps && !stopped; i += 1) {
        const s = await runOnce('measured', i, false);
        durations.push(s.timeout ? spec.timeoutS * 1000 : s.wallMs);
        if (s.timeout) stopped = `measured request ${i} timed out (> ${spec.timeoutS} s): variant stopped`;
        else adaptive = adaptiveReps(spec.reps, durations);
      }
    } else {
      await runOnce('cold', 0, false);
    }
  } catch (e) {
    fatal = errorInfo(e);
    log('child fatal:', e?.stack ?? e);
  } finally {
    if (flag) {
      try { flag.restored = await setCanViewOrders(spec.clone, spec.recruiterId, true); } catch (e) { flag.restoreError = errorInfo(e); }
    }
  }

  let pgss = null;
  if (spec.role === 'warm' && !fatal) {
    try { pgss = await pgssDb(spec.clone); } catch (e) { pgss = { error: errorInfo(e) }; }
  }
  await appendResult(out, { type: 'sql-texts', ...base, texts: textInfo.registry });

  const measured = samples.filter((s) => s.phase === 'measured');
  const okM = measured.filter((s) => s.ok);
  const num = (f) => summarize(okM.map(f));
  const firstChecked = okM.find((s) => s.checks) ?? samples.find((s) => s.checks) ?? null;
  const allChecked = samples.filter((s) => s.checks);
  let ordersEvidence = null;
  if (spec.role === 'warm' && !fatal) {
    const pgRows = Array.isArray(pgss) ? pgss : [];
    const pgOrders = pgRows.filter((r) => r.touches_orders);
    const clientOrders = sumOf(samples, (s) => s.ordersStatements);
    const orderCalls = sumOf(samples, (s) => s.orderModelCalls);
    const pgss1 = { resetAt: pgssResetAt, scope: 'this database only (dbid), reset before the first warm-up, read after the last measured request; harness statements excluded',
      statements: pgRows.length, calls: sumOf(pgRows, (r) => Number(r.calls)), ordersStatements: pgOrders.length, ordersCalls: sumOf(pgOrders, (r) => Number(r.calls)),
      treeStatementSeen: pgRows.some((r) => String(r.query).includes('recruiter-network-tree')),
      // non-vacuity guard (Part 5b): pg_stat_statements must show at least one tagged network-service statement
      // (the full-tree query before 5b; path / page / unplaced / stats after) — otherwise the zero-orders reading proves nothing
      networkStatementSeen: pgRows.some((r) => /\/\* recruiter-network-[a-z-]+ \*\//.test(String(r.query))), ordersTexts: pgOrders.map((r) => String(r.query).slice(0, 200)) };
    const client = { requests: samples.length, statements: sumOf(samples, (s) => s.sqlCount), ordersStatements: clientOrders, affiliateOrderCalls: orderCalls };
    if (v.ordersOn === false) {
      const okAll = samples.filter((s) => s.ok);
      const nullEverywhere = okAll.every((s) => s.resp?.ordersNull === true || s.resp?.ordersNull === null);
      ordersEvidence = { kind: 'canViewOrders=false proof', flag, pgss: pgss1, client, responses: { checked: okAll.length, ordersNullInEveryResponse: nullEverywhere },
        ok: Array.isArray(pgss) && pgOrders.length === 0 && clientOrders === 0 && orderCalls === 0 && pgss1.networkStatementSeen && nullEverywhere && samples.length > 0 && !stopped };
    } else if (v.ordersOn === true) {
      // positive control: an order query is expected whenever the response has members to count
      const expected = v.endpoint === 'stats' ? (v.expect?.affiliates ?? 1) > 0 : (v.expect?.nodes ?? 0) > 0;
      ordersEvidence = { kind: 'canViewOrders=true (positive control)', expectedOrderQueries: expected, pgss: pgss1, client,
        ok: expected ? clientOrders > 0 && pgOrders.length > 0 : clientOrders === 0 };
    }
  }

  const result = { variant: v.name, mode: spec.role, fatal, stopped, samples: samples.length, measured: measured.length, ok: okM.length };
  if (spec.role === 'warm') {
    const summary = {
      type: 'summary', ...base, ordersOn: v.ordersOn, params: v.params, note: v.note,
      complete: !fatal, outcome: fatal ? 'child-error' : stopped ? 'stopped-after-timeout' : okM.length === measured.length ? 'ok' : 'with-errors',
      fatal, stopped,
      protocol: { warmups: spec.warmups, warmDefinitionMet: spec.warmups >= 3, requestedReps: spec.reps, reps: measured.length, adaptive, timeoutS: spec.timeoutS,
        gcBeforeAndAfterEachRequest: true, callBytesFrom: 'warm-up 0 only (sizing off for the measured requests)',
        timedWindow: http ? 'handler call → Response body read (arrayBuffer); Request built before, JSON parse + checks after' : v.endpoint === 'tree' ? 'loadNetworkTree() call' : 'one affiliate.findMany call' },
      n: okM.length, errors: measured.filter((s) => !s.ok && !s.timeout).length, timeouts: samples.filter((s) => s.timeout).length,
      warmupTimeouts: samples.filter((s) => s.phase === 'warmup' && s.timeout).length, statuses: countBy(measured, (s) => s.status),
      errorDetails: measured.filter((s) => !s.ok).slice(0, 3).map((s) => ({ i: s.i, status: s.status, timeout: s.timeout, error: s.error, underlying: s.underlying })),
      latencyMs: num((s) => s.wallMs),
      breakdownMs: {
        sqlMsSum: num((s) => s.sqlMsSum), sqlWallMs: num((s) => s.sqlWallMs), callMsSum: num((s) => s.callMsSum), callWallMs: num((s) => s.callWallMs),
        jsMs_totalMinusSqlSum: num((s) => s.jsMs), jsMs_totalMinusSqlUnion: num((s) => s.jsMsUnion), outsideCallsMs: num((s) => s.outsideCallsMs),
        beforeFirstCallMs: num((s) => s.beforeFirstCallMs), afterLastCallMs: num((s) => s.afterLastCallMs),
        ...(v.endpoint === 'tree' ? { treeJsBuildSortMs: num((s) => s.afterLastCallMs), treeSqlMs: num((s) => s.sqlMsSum) } : {}),
      },
      sql: { statementsPerRequest: num((s) => s.sqlCount), byTableFirstMeasured: okM[0]?.byTable ?? null, ordersStatementsMeasured: sumOf(measured, (s) => s.ordersStatements),
        statementsFirstMeasured: okM[0]?.stmts ?? null },
      calls: { perRequest: num((s) => s.callCount), detailWarmup0: samples.find((s) => s.callsDetail)?.callsDetail ?? null },
      response: { bytes: num((s) => s.responseBytes), distinctBytes: [...new Set(samples.filter((s) => s.ok).map((s) => s.responseBytes))], distinctSha1: new Set(samples.filter((s) => s.ok).map((s) => s.bodySha1)).size },
      heap: { baselineBytes: num((s) => s.heapBaseline), peakBytes: num((s) => s.heapPeak), peakDeltaBytes: num((s) => s.heapPeakDelta), retainedDeltaBytes: num((s) => s.heapRetainedDelta),
        maxRssKb: process.resourceUsage().maxRSS, note: 'V8 heapUsed only (the Prisma query engine allocates outside it); retained = after gc minus the pre-request baseline' },
      pgss: Array.isArray(pgss) ? { window: 'warm-ups + measured requests', resetAt: pgssResetAt, statements: pgss.length, top: pgss.slice(0, 20) } : pgss,
      orders: ordersEvidence,
      checks: firstChecked?.checks ?? null, checksOk: firstChecked ? checksOk(firstChecked.checks) : false,
      allSamplesChecksOk: allChecked.length > 0 && allChecked.every((s) => checksOk(s.checks)),
      truth: spec.truth ?? null, process: proc,
      rawSamples: { file: out, select: { type: 'sample', runId: spec.runId, variant: v.name } },
    };
    await appendResult(out, summary);
    Object.assign(result, { complete: summary.complete, outcome: summary.outcome, n: summary.n, errors: summary.errors, timeouts: summary.timeouts,
      checksOk: summary.checksOk, allSamplesChecksOk: summary.allSamplesChecksOk, ordersProofOk: v.ordersOn === false ? ordersEvidence?.ok ?? false : undefined,
      ordersControlOk: v.ordersOn === true ? ordersEvidence?.ok ?? false : undefined,
      latencyMs: summary.latencyMs, adaptive });
  } else {
    const s = samples[0] ?? null;
    Object.assign(result, { sample: s ? { ok: s.ok, status: s.status, wallMs: s.wallMs, timeout: s.timeout, responseBytes: s.responseBytes, bodySha1: s.bodySha1, sqlCount: s.sqlCount,
      sqlMsSum: s.sqlMsSum, sqlWallMs: s.sqlWallMs, jsMs: s.jsMs, jsMsUnion: s.jsMsUnion, outsideCallsMs: s.outsideCallsMs, heapPeakDelta: s.heapPeakDelta,
      heapRetainedDelta: s.heapRetainedDelta, ordersStatements: s.ordersStatements, checks: s.checks, error: s.error, underlying: s.underlying } : null, process: proc });
  }
  // a statement that ignored the cancel would keep pool.end() waiting: bound it (the parent terminates leftovers)
  const closed = await Promise.race([conn.close().then(() => true, () => false), sleep(30_000).then(() => false)]);
  if (!closed) log('connection close did not finish within 30 s (left to the parent)');
  return result;
}

// ── parent: orchestration ────────────────────────────────────────────────────
function runChild(spec, budgetMs, ctx) {
  return new Promise((done) => {
    const arg = Buffer.from(JSON.stringify(spec)).toString('base64');
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--expose-gc', SELF, '--child', arg], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    ctx.child = child;
    let stdout = '';
    let stderrTail = '';
    appendFileSync(ctx.logFile, `\n===== ${new Date().toISOString()} child ${spec.role} ${spec.variant.name} pid ${child.pid} =====\n`);
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-4_000_000); });
    child.stderr.on('data', (d) => { appendFileSync(ctx.logFile, d); stderrTail = (stderrTail + d).slice(-3000); });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, budgetMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ctx.child = null;
      const line = stdout.split('\n').reverse().find((l) => l.startsWith(RESULT_MARK));
      let result = null;
      try { result = line ? JSON.parse(line.slice(RESULT_MARK.length)) : null; } catch { result = null; }
      done({ pid: child.pid, code, signal, killed, budgetMs, ms: Date.now() - t0, result, stderrTail });
    });
  });
}

async function ensureClone(scale, clone, waitS) {
  const template = TEMPLATES[scale];
  cloneUrl(clone);
  if ((await listClones()).includes(clone)) return { clone, template, reused: true, freeBytes: freeDiskBytes() };
  const t0 = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return { ...(await cloneDb(template, clone)), reused: false, attempts, waitedMs: Date.now() - t0 };
    } catch (e) {
      if (!/clones alive/.test(String(e.message)) || Date.now() - t0 >= waitS * 1000) throw e;
      log(`waiting for a free clone slot: ${e.message}`);
      await sleep(10_000);
    }
  }
}

async function prepareClone(clone, m, todo) {
  const ids = SHAPES.map((k) => m.recruiters[k].id);
  const flags = await restoreFlags(clone, ids);
  const rows = await pgQuery(clone, `${ADMIN} SELECT id, "isActive" AS active, "canViewOrders" AS cvo, "tokenVersion" AS tv FROM recruiters WHERE id = ANY($1::text[])`, [ids]);
  const members = await pgQuery(clone, `${ADMIN} SELECT "recruiterId" AS id, count(*)::int AS n FROM recruiter_affiliate_links WHERE "recruiterId" = ANY($1::text[]) GROUP BY 1`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memberCount = new Map(members.map((r) => [r.id, r.n]));
  const recruiters = {};
  for (const k of SHAPES) {
    const r = byId.get(m.recruiters[k].id);
    if (!r || r.active !== true) throw new Error(`bench-network: recruiter ${k} missing or inactive on ${clone}`);
    recruiters[k] = { id: r.id, tokenVersion: r.tv, canViewOrders: r.cvo, members: memberCount.get(r.id) ?? 0, manifestMembers: m.shapes[k].members };
    if (recruiters[k].members !== m.shapes[k].members) throw new Error(`bench-network: ${clone} does not match the manifest (${k}: ${recruiters[k].members} members, manifest ${m.shapes[k].members})`);
  }
  const tables = (await pgQuery(clone, `${ADMIN} SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.tablename);
  const truth = {};
  for (const shape of new Set(todo.filter((v) => v.expect?.truth && v.endpoint === 'stats').map((v) => v.shape))) truth[shape] = await rootTruth(clone, m, shape);
  return { recruiters, flags, tables, truth };
}

async function parentMain(a) {
  assertSafeEnvironment();
  if (!a.scale) throw new Error('bench-network: --scale 1k|10k|100k is required');
  for (const s of a.shapes ?? []) if (!SHAPES.includes(s)) throw new Error(`bench-network: unknown --shape ${s} (mixed | wide | deep)`);
  const m = loadManifest(a.scale);
  const plan = selectPlan(buildPlan(a.scale, m), a);
  const reps = a.reps ?? DEFAULTS.reps[a.scale];
  if (a.list) {
    return { ok: true, scale: a.scale, manifestBuildId: m.buildId, mode: a.cold ? 'cold' : 'warm', reps: a.cold ? null : reps, variants: plan.map((v) => ({
      name: v.name, shape: v.shape, endpoint: v.endpoint, ordersOn: v.ordersOn, params: v.params, cold: v.cold, note: v.note,
      expect: { ...v.expect, unplacedIds: v.expect.unplacedIds ? `${v.expect.unplacedIds.length} ids` : undefined, levelHistogram: v.expect.levelHistogram ? 'from manifest' : undefined } })) };
  }
  const file = resultPath(a.out ?? `network-${a.scale}.jsonl`);
  const done = a.force ? new Map() : completedSummaries(file);
  const todo = plan.filter((v) => !alreadyDone(done, a, reps, v));
  const skipped = plan.filter((v) => alreadyDone(done, a, reps, v)).map((v) => v.name);
  if (skipped.length) log(`skipping ${skipped.length} variant(s) already complete in ${file} (use --force to re-run): ${skipped.join(', ')}`);
  if (!todo.length) return { ok: true, scale: a.scale, mode: a.cold ? 'cold' : 'warm', file, ran: [], skipped };
  if (!clusterReady()) throw new Error('bench-network: the disposable cluster is not accepting connections (bash scripts/perf/recruiter/pg.sh start)');

  const runId = `${new Date().toISOString()}-${process.pid}`;
  mkdirSync(LOGS_DIR, { recursive: true });
  const ctx = { child: null, stop: false, logFile: join(LOGS_DIR, `network-${a.scale}-${runId.replace(/[:.]/g, '-')}.log`) };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { ctx.stop = true; if (ctx.child) ctx.child.kill('SIGKILL'); log(`${sig}: stopping after cleanup`); });
  }
  const clone = `net_${a.scale}`;
  cloneUrl(clone);
  await appendResult(file, { type: 'run', runId, scale: a.scale, mode: a.cold ? 'cold' : 'warm', args: { ...a, child: undefined }, reps: a.cold ? null : reps,
    coldSamples: a.cold ? a.coldSamples : null, clone, template: TEMPLATES[a.scale], manifestBuildId: m.buildId, planned: todo.map((v) => v.name), skipped, logFile: ctx.logFile,
    notes: ['every variant runs in its own child process (node --expose-gc)', 'OS page cache is never dropped', 'gc before and after every request (outside the timed window)',
      'cold = PostgreSQL restart + fresh child + $connect and pool warm-up (3 connections) timed separately, then one request'] });
  log(`run ${runId}: ${todo.length} variant(s), mode ${a.cold ? 'cold' : 'warm'}, results → ${file}, child logs → ${ctx.logFile}`);

  const cloneInfo = await ensureClone(a.scale, clone, a.cloneWaitS);
  await appendResult(file, { type: 'event', runId, event: cloneInfo.reused ? 'clone-reused' : 'clone-created', ...cloneInfo });
  const ran = [];
  const ids = SHAPES.map((k) => m.recruiters[k].id);
  try {
    const prep = await prepareClone(clone, m, todo);
    await appendResult(file, { type: 'event', runId, event: 'clone-prepared', recruiters: prep.recruiters, flags: prep.flags, truth: prep.truth });
    for (const v of todo) {
      if (ctx.stop) break;
      const baseSpec = { runId, scale: a.scale, clone, out: file, variant: v, recruiterId: prep.recruiters[v.shape].id, tokenVersion: prep.recruiters[v.shape].tokenVersion,
        tables: prep.tables, truth: prep.truth[v.shape] ?? null, timeoutS: a.timeoutS, warmups: a.warmups, reps };
      if (!a.cold) {
        log(`warm ${v.name} …`);
        const budgetMs = (a.warmups + reps) * a.timeoutS * 1000 + 300_000;
        const r = await runChild({ ...baseSpec, role: 'warm' }, budgetMs, ctx);
        const stray = await terminateClients(clone);
        const flags = await restoreFlags(clone, ids);
        await appendResult(file, { type: 'child', runId, variant: v.name, mode: 'warm', pid: r.pid, exitCode: r.code, signal: r.signal, killedByWatchdog: r.killed, budgetMs, ms: r.ms,
          strayBackendsTerminated: stray.length, flagsAfter: flags, result: r.result ? { ...r.result, latencyMs: undefined } : null, stderrTail: r.result && r.code === 0 ? undefined : r.stderrTail });
        if (!r.result || r.result.fatal) {
          await appendResult(file, { type: 'summary', runId, scale: a.scale, shape: v.shape, variant: v.name, endpoint: v.endpoint, mode: 'warm', complete: false,
            outcome: r.killed ? 'killed-by-watchdog' : r.result?.fatal ? 'child-error' : 'child-crashed', exitCode: r.code, signal: r.signal, fatal: r.result?.fatal ?? null,
            stderrTail: r.stderrTail, protocol: { warmups: a.warmups, requestedReps: reps, timeoutS: a.timeoutS } });
        }
        ran.push({ variant: v.name, mode: 'warm', outcome: r.result?.outcome ?? (r.killed ? 'killed-by-watchdog' : 'child-crashed'), n: r.result?.n ?? 0, errors: r.result?.errors ?? null,
          timeouts: r.result?.timeouts ?? null, checksOk: r.result?.checksOk ?? false, allSamplesChecksOk: r.result?.allSamplesChecksOk ?? false,
          ...(v.ordersOn === false ? { ordersProofOk: r.result?.ordersProofOk ?? false } : {}),
          ...(v.ordersOn === true ? { ordersControlOk: r.result?.ordersControlOk ?? false } : {}), adaptive: r.result?.adaptive?.rule ?? null });
        log(`warm ${v.name}: ${JSON.stringify(ran[ran.length - 1])}`);
      } else {
        ran.push(await runColdVariant(a, ctx, file, runId, clone, ids, v, baseSpec));
      }
    }
  } finally {
    try { await appendResult(file, { type: 'event', runId, event: 'flags-restored', ...(await restoreFlags(clone, ids)) }); } catch (e) { log('flag restore failed:', e.message); }
    if (!a.keepClone) {
      try { await terminateClients(clone); await appendResult(file, { type: 'event', runId, event: 'clone-dropped', ...(await dropDb(clone)) }); } catch (e) { log('drop failed:', e.message); }
    } else await appendResult(file, { type: 'event', runId, event: 'clone-kept', clone });
    await appendResult(file, { type: 'run-end', runId, stopped: ctx.stop, ran });
  }
  return { ok: ran.every((r) => r.checksOk && r.outcome !== 'child-crashed' && r.outcome !== 'killed-by-watchdog' && (r.ordersProofOk ?? true) && (r.ordersControlOk ?? true)), scale: a.scale, mode: a.cold ? 'cold' : 'warm', runId, file, logFile: ctx.logFile, ran, skipped, clone: { ...cloneInfo, dropped: !a.keepClone } };
}

async function runColdVariant(a, ctx, file, runId, clone, ids, v, baseSpec) {
  const samples = [];
  const skips = [];
  for (let i = 0; i < a.coldSamples && !ctx.stop; i += 1) {
    const idle = await waitClusterIdle(a.idleWaitS);
    if (!idle.ok) {
      skips.push({ i, reason: 'cluster busy: other clients connected, restart refused', ...idle });
      await appendResult(file, { type: 'event', runId, event: 'cold-sample-skipped', variant: v.name, i, reason: 'cluster busy', ...idle });
      continue;
    }
    log(`cold ${v.name} #${i}: restarting PostgreSQL …`);
    let restart;
    try { restart = await restartPg(); } catch (e) {
      await appendResult(file, { type: 'event', runId, event: 'restart-failed', variant: v.name, i, error: errorInfo(e), clusterReady: clusterReady() });
      throw e;
    }
    const restartDoneEpochMs = Date.now();
    const r = await runChild({ ...baseSpec, role: 'cold', cold: { sampleIndex: i, coldSamples: a.coldSamples, restartMs: restart.ms, restartDoneEpochMs, waitedForIdleMs: idle.waitedMs } },
      a.timeoutS * 1000 + 300_000, ctx);
    let postmaster = null;
    try { postmaster = (await pgQuery('postgres', `${ADMIN} SELECT pg_postmaster_start_time()::text AS t`))[0].t; } catch (e) { postmaster = `unavailable: ${e.message}`; }
    const stray = await terminateClients(clone);
    const flags = await restoreFlags(clone, ids);
    await appendResult(file, { type: 'child', runId, variant: v.name, mode: 'cold', i, pid: r.pid, exitCode: r.code, signal: r.signal, killedByWatchdog: r.killed, ms: r.ms,
      restartMs: restart.ms, postmasterStartTime: postmaster, strayBackendsTerminated: stray.length, flagsAfter: flags, result: r.result,
      stderrTail: r.result && r.code === 0 ? undefined : r.stderrTail });
    samples.push({ i, restartMs: restart.ms, postmaster, crashed: !r.result || !!r.result.fatal, killed: r.killed, ...(r.result?.sample ?? {}), process: r.result?.process ?? null });
    if (r.result?.sample?.timeout) {
      for (let j = i + 1; j < a.coldSamples; j += 1) skips.push({ i: j, reason: `cold sample ${i} timed out (> ${a.timeoutS} s): remaining cold samples of this variant skipped` });
      break;
    }
  }
  const ok = samples.filter((s) => s.ok);
  const num = (f) => summarize(ok.map(f));
  const first = ok.find((s) => s.checks) ?? samples.find((s) => s.checks) ?? null;
  // a sample skipped because the cluster was busy is retried by a later run (incomplete); a timeout skip is final
  const complete = samples.length + skips.length >= a.coldSamples && samples.every((s) => !s.crashed) && !skips.some((s) => s.reason.startsWith('cluster busy'));
  const summary = {
    type: 'summary', runId, scale: a.scale, shape: v.shape, variant: v.name, endpoint: v.endpoint, mode: 'cold', ordersOn: v.ordersOn, params: v.params, note: v.note,
    complete, outcome: !complete ? 'incomplete' : ok.length === a.coldSamples ? 'ok' : 'with-errors-or-skips',
    protocol: { coldSamples: a.coldSamples, timeoutS: a.timeoutS, definition: 'PostgreSQL restart (lib.restartPg, OS page cache NOT dropped) → fresh child process → module import, $connect and 3 pool connections (SELECT 1) timed separately → ONE timed request' },
    n: ok.length, errors: samples.filter((s) => !s.ok && !s.timeout).length, timeouts: samples.filter((s) => s.timeout).length, skipped: skips,
    latencyMs: num((s) => s.wallMs),
    breakdownMs: { sqlMsSum: num((s) => s.sqlMsSum), sqlWallMs: num((s) => s.sqlWallMs), jsMs_totalMinusSqlSum: num((s) => s.jsMs), jsMs_totalMinusSqlUnion: num((s) => s.jsMsUnion), outsideCallsMs: num((s) => s.outsideCallsMs) },
    connection: { restartMs: summarize(samples.map((s) => s.restartMs)), importMs: num((s) => s.process?.importMs), connectMs: num((s) => s.process?.connectMs), poolWarmMs: num((s) => s.process?.poolWarmMs) },
    response: { bytes: num((s) => s.responseBytes), distinctSha1: new Set(ok.map((s) => s.bodySha1)).size },
    heap: { peakDeltaBytes: num((s) => s.heapPeakDelta), retainedDeltaBytes: num((s) => s.heapRetainedDelta) },
    checks: first?.checks ?? null, checksOk: first ? checksOk(first.checks) : false, allSamplesChecksOk: samples.length > 0 && samples.every((s) => s.checks && checksOk(s.checks)),
    samples: samples.map((s) => ({ i: s.i, ok: s.ok, status: s.status, wallMs: s.wallMs, timeout: s.timeout, restartMs: s.restartMs, connectMs: s.process?.connectMs ?? null, postmaster: s.postmaster, crashed: s.crashed })),
    rawSamples: { file, select: { type: 'sample', runId, variant: v.name, mode: 'cold' } },
  };
  await appendResult(file, summary);
  const res = { variant: v.name, mode: 'cold', outcome: summary.outcome, n: summary.n, errors: summary.errors, timeouts: summary.timeouts, skipped: skips.length, checksOk: summary.checksOk, allSamplesChecksOk: summary.allSamplesChecksOk };
  log(`cold ${v.name}: ${JSON.stringify(res)}`);
  return res;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = `node --expose-gc scripts/perf/recruiter/bench-network.mjs --scale 1k|10k|100k [options]
  --shape mixed|wide|deep[,…]   only these shapes
  --variant <name|prefix*>[,…]  only these variants (see --list)
  --reps N                      measured requests per variant (default 30 at 1k/10k, 20 at 100k; adaptively reduced)
  --warmups N                   discarded warm-ups (default 3; < 3 is recorded as warmDefinitionMet=false)
  --cold                        run the COLD series (instead of warm) for the cold variants
  --cold-samples N              cold samples per variant (default 5)
  --timeout-s S                 per-request timeout (default 300)
  --force                       re-run variants already complete in the result file
  --out <file.jsonl>            result file under SCRATCH/results (default network-<scale>.jsonl)
  --keep-clone                  keep net_<scale> at the end (a later run reuses it)
  --clone-wait-s S              wait up to S s for a free clone slot (default 600)
  --idle-wait-s S               cold: wait up to S s for other clients to leave before a restart (default 300)
  --list                        print the variants (with parameters and expectations) and exit
Long runs: setsid -w nohup node --expose-gc <this file> --scale 100k > LOG 2>&1 < /dev/null &  then  timeout 540 tail --pid=$! -f /dev/null (repeat).
Exit code 0 only when every variant ran and passed its checks; a timeout or an error gives 1 (details in the summary lines).`;

function parseArgs(argv) {
  const a = { scale: null, shapes: null, variants: null, reps: null, warmups: DEFAULTS.warmups, cold: false, coldSamples: DEFAULTS.coldSamples, timeoutS: DEFAULTS.timeoutS,
    force: false, out: null, keepClone: false, list: false, cloneWaitS: DEFAULTS.cloneWaitS, idleWaitS: DEFAULTS.idleWaitS, child: null, help: false };
  const int = (k, x, min) => { const n = Number(x); if (!Number.isInteger(n) || n < min) throw new Error(`bench-network: ${k} must be an integer >= ${min}`); return n; };
  const list = (x) => x.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const val = () => { const x = argv[i + 1]; if (x === undefined || x.startsWith('--')) throw new Error(`bench-network: missing value for ${k}`); i += 1; return x; };
    if (k === '--scale') a.scale = scaleKey(val());
    else if (k === '--shape') a.shapes = list(val());
    else if (k === '--variant') a.variants = list(val());
    else if (k === '--reps') a.reps = int(k, val(), 1);
    else if (k === '--warmups') a.warmups = int(k, val(), 1);
    else if (k === '--cold') a.cold = true;
    else if (k === '--cold-samples') a.coldSamples = int(k, val(), 1);
    else if (k === '--timeout-s') a.timeoutS = int(k, val(), 1);
    else if (k === '--force') a.force = true;
    else if (k === '--out') a.out = val();
    else if (k === '--keep-clone') a.keepClone = true;
    else if (k === '--clone-wait-s') a.cloneWaitS = int(k, val(), 0);
    else if (k === '--idle-wait-s') a.idleWaitS = int(k, val(), 0);
    else if (k === '--list') a.list = true;
    else if (k === '--child') a.child = val();
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`bench-network: unknown argument ${k}\n${USAGE}`);
  }
  return a;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === SELF;
if (isMain) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  if (a.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
  if (a.child) {
    // child: one variant; rateLimit.js keeps a timer alive, so exit explicitly
    childMain(JSON.parse(Buffer.from(a.child, 'base64').toString('utf8'))).then(
      (r) => process.stdout.write(`${RESULT_MARK}${JSON.stringify(r)}\n`, () => process.exit(0)),
      (e) => { log('child failed:', e?.stack ?? e); process.stdout.write(`${RESULT_MARK}${JSON.stringify({ fatal: errorInfo(e) })}\n`, () => process.exit(1)); },
    );
  } else {
    parentMain(a).then(
      (r) => process.stdout.write(`${JSON.stringify(r, null, 2)}\n`, () => process.exit(r.ok ? 0 : 1)),
      (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); },
    );
  }
}
