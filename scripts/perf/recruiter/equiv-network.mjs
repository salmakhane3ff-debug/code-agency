/**
 * scripts/perf/recruiter/equiv-network.mjs — Phase 6 Part 5b VERIFICATION harness (not a benchmark).
 * It changes nothing in the app: it compares the rewritten network service with the previous one
 * on clones of the Part 5a datasets (disposable cluster only) and writes raw JSONL results.
 *
 * Subcommands
 *   equiv --scale 1k|10k [--clone val_5b_1k] [--fixture] [--keep-clone] [--reuse]
 *     A. old (HEAD copy, db injected) vs new (src/lib/services/recruiterNetworkService.js) for
 *        rec_mixed / rec_wide / rec_deep / rec_empty, orders on AND off: service outputs and the
 *        response projections of src/lib/recruiterVisibility.js (as the route handlers build them)
 *        must be JSON-identical; errors must match by code. Every new call is also compared with
 *        an independent in-memory reference built from flat SQL rows (no recursion in SQL), and
 *        its driver-level SQL is checked: no statement mentions affiliate_orders when orders are
 *        off; exactly one when they are on (stats with members, non-empty nodes page).
 *        10k rec_deep: the OLD implementation is NOT called (≈ 2 min per call); the new results
 *        are validated against the chain order walked from parentId in JS + explicit assertions.
 *     B. --fixture (1k): a NEW recruiter `rec_p5b_edge` (+ a 3-member neighbour `rec_p5b_nbr`)
 *        with malformed / unusual data (ties, cycles, rho, foreign / unlinked parents, unusual
 *        statuses, a 60-level chain, a 230-child fan); full matrix on it; the generated networks
 *        are re-checked afterwards (isolation: identical to their pre-fixture outputs).
 *   log-proof [--clone val_5b_log]
 *     C. canViewOrders=false with SQL statement logging on a dedicated 1k clone:
 *        ALTER DATABASE <clone> SET log_statement = 'all' (that clone only), marker statements
 *        around an "off" window and an "on" window, the PostgreSQL log scanned between the markers,
 *        pg_stat_statements of that database per window, the driver-level client log, and the
 *        real route bodies (recruiterNetworkHandlers) with canViewOrders false / true.
 *
 * SAFETY: imports lib.mjs FIRST (its env guard runs on import); every connection goes through
 * lib (disposable cluster /tmp/p5a-pg/sock:55510 only); clones val_* / exp_* only (lib.cloneDb:
 * at most 2 alive), dropped at the end unless --keep-clone; templates are never connected to.
 * Results: SCRATCH_P5B/results/*.jsonl; never writes under the Part 5a scratch directory.
 */

import {
  PG_LOG, REPO, appendResult, cloneDb, connect, dropDb, importService, listClones, listDatabases, pgQuery, pgssReset, pgssSnapshot,
} from './lib.mjs';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// ── paths & guards ───────────────────────────────────────────────────────────
const P5B = '/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5b';
const RESULTS = join(P5B, 'results');
const OLD_MODULE = join(P5B, 'old/recruiterNetworkService.old.mjs');
const SERVICE_FILE = join(REPO, 'src/lib/services/recruiterNetworkService.js');
const OWN_CLONE_RE = /^(val|exp)_5b_[a-z0-9_]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const PAGE_DEFAULT = 50;
const NONEXISTENT_ID = '00000000-0000-4000-8000-00000000beef';
const MALFORMED_ID = 'bad id!';
const GENERATED = Object.freeze(['rec_mixed', 'rec_wide', 'rec_deep', 'rec_empty']);
const TAGS = Object.freeze(['recruiter-network-path', 'recruiter-network-page', 'recruiter-network-unplaced', 'recruiter-network-stats', 'recruiter-network-stats-orders']);

function resultPath(name) {
  const p = resolve(RESULTS, name);
  if (!p.startsWith(`${RESULTS}/`) || p.includes('/scratchpad/p5a/')) throw new Error(`p5b: refusing result path ${p}`);
  return p;
}
function assertOwnClone(name) {
  if (!OWN_CLONE_RE.test(name) || /^p5a_/.test(name)) throw new Error(`p5b: ${name} is not a val_5b_* / exp_5b_* clone`);
  return name;
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const now = () => performance.now();
const round = (x, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const given = (v) => v !== null && v !== undefined && v !== '';
const fail = (code) => Object.assign(new Error(code), { code });
const codeOf = (e) => (e ? (typeof e.code === 'string' ? e.code : `ERROR:${String(e.message ?? e).slice(0, 200)}`) : null);
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const touchesOrders = (text) => /affiliate_orders/i.test(String(text));
const tagOf = (text) => (String(text).match(/\/\* (recruiter-network-[a-z-]+) \*\//) ?? [])[1] ?? null;

/** First difference of two strings → { at, old, new } with ±160 chars of context. */
function firstDiff(a, b) {
  const x = String(a);
  const y = String(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  const from = Math.max(0, i - 160);
  return { at: i, lengths: [x.length, y.length], a: x.slice(from, i + 160), b: y.slice(from, i + 160) };
}

function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!s.length) return null;
  return s[Math.floor((s.length - 1) / 2)];
}
function stat(xs) {
  const s = xs.filter((x) => Number.isFinite(x));
  return { n: s.length, sumMs: round(s.reduce((a, b) => a + b, 0)), medianMs: round(median(s)), maxMs: round(s.length ? Math.max(...s) : null) };
}

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { cmd: argv[0] ?? null, scale: null, clone: null, fixture: false, keepClone: false, reuse: false };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--scale') a.scale = argv[(i += 1)];
    else if (k === '--clone') a.clone = argv[(i += 1)];
    else if (k === '--fixture') a.fixture = true;
    else if (k === '--keep-clone') a.keepClone = true;
    else if (k === '--reuse') a.reuse = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

// ── modules under test ───────────────────────────────────────────────────────
async function loadModules() {
  const NEW = await importService('recruiterNetworkService');
  const OLD = await import(OLD_MODULE);
  const VIS = await import(join(REPO, 'src/lib/recruiterVisibility.js'));
  const statsView = (s) => ({ stats: VIS.toRecruiterNetworkStatsView(s) });
  const nodesView = (page) => ({
    parent: page.parent ? VIS.toRecruiterNetworkPathView(page.parent) : null,
    path: page.path.map(VIS.toRecruiterNetworkPathView),
    nodes: page.nodes.map(VIS.toRecruiterNetworkNodeView),
    total: Number.isInteger(page.total) ? page.total : 0,
    nextCursor: Number.isInteger(page.nextCursor) ? page.nextCursor : null,
  });
  return { NEW, OLD, VIS, statsView, nodesView };
}

// ── independent reference (flat SQL rows → JS; no recursive SQL) ─────────────
async function loadFlat(db, recruiterId) {
  const members = await pgQuery(db, `/* p5b-ref */ SELECT a.id, a."parentId", a.username, a.name, a."isActive",
      to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "createdAt", to_char(l."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "linkedAt",
      iv.status AS "identityStatus"
    FROM recruiter_affiliate_links l JOIN affiliates a ON a.id = l."affiliateId"
    LEFT JOIN identity_verifications iv ON iv."affiliateId" = a.id
    WHERE l."recruiterId" = $1`, [recruiterId]);
  const orders = await pgQuery(db, `/* p5b-ref */ SELECT o."affiliateId", o.status, o."isFake", count(*)::int AS n
    FROM affiliate_orders o JOIN recruiter_affiliate_links l ON l."affiliateId" = o."affiliateId"
    WHERE l."recruiterId" = $1 GROUP BY 1, 2, 3`, [recruiterId]);
  return { members, orders };
}

function buildRef(flat, M) {
  const { orderBucket, identityBucket, ORDER_BUCKETS } = M;
  const emptyOrders = () => Object.fromEntries([...ORDER_BUCKETS, 'total'].map((k) => [k, 0]));
  const m = new Map(flat.members.map((r) => [r.id, r]));
  const children = new Map();
  const roots = [];
  for (const r of m.values()) {
    if (r.parentId !== null && m.has(r.parentId)) {
      if (!children.has(r.parentId)) children.set(r.parentId, []);
      children.get(r.parentId).push(r.id);
    } else roots.push(r.id);
  }
  const cmp = (a, b) => {
    const A = m.get(a).createdAt;
    const B = m.get(b).createdAt;
    if (A !== B) return A < B ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  roots.sort(cmp);
  for (const list of children.values()) list.sort(cmp);
  const depth = new Map();
  const bfs = [];
  let frontier = roots.slice();
  let d = 1;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (depth.has(id)) continue;
      depth.set(id, d);
      bfs.push(id);
      for (const c of children.get(id) ?? []) next.push(c);
    }
    frontier = next;
    d += 1;
  }
  const desc = new Map();
  for (let i = bfs.length - 1; i >= 0; i -= 1) {
    let c = 0;
    for (const ch of children.get(bfs[i]) ?? []) c += 1 + desc.get(ch);
    desc.set(bfs[i], c);
  }
  const unplaced = [...m.values()].filter((r) => !depth.has(r.id))
    .sort((a, b) => (a.linkedAt !== b.linkedAt ? (a.linkedAt < b.linkedAt ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => r.id);
  const orders = new Map();
  for (const g of flat.orders) {
    if (!orders.has(g.affiliateId)) orders.set(g.affiliateId, { real: emptyOrders(), fake: emptyOrders() });
    const o = orders.get(g.affiliateId)[g.isFake === true ? 'fake' : 'real'];
    o[orderBucket(g.status)] += Number(g.n);
    o.total += Number(g.n);
  }
  const ordersOf = (id) => orders.get(id) ?? { real: emptyOrders(), fake: emptyOrders() };
  const idOf = (id) => identityBucket(m.get(id)?.identityStatus ?? null);
  return { m, roots, children, depth, bfs, desc, unplaced, ordersOf, idOf, emptyOrders, members: m.size, M };
}

function refStats(ref, rootId, includeOrders) {
  const { IDENTITY_BUCKETS } = ref.M;
  const emptyIdentity = () => Object.fromEntries(IDENTITY_BUCKETS.map((k) => [k, 0]));
  const scoped = given(rootId);
  let scope;
  if (scoped) {
    if (typeof rootId !== 'string' || !ID_RE.test(rootId) || !ref.depth.has(rootId)) throw fail('NOT_FOUND');
    scope = [];
    let frontier = [...(ref.children.get(rootId) ?? [])];
    let level = 1;
    while (frontier.length) {
      const next = [];
      for (const id of frontier) { scope.push([id, level]); for (const c of ref.children.get(id) ?? []) next.push(c); }
      frontier = next;
      level += 1;
    }
  } else scope = ref.bfs.map((id) => [id, ref.depth.get(id)]);
  const withOrders = includeOrders === true;
  const add = (into, from) => { for (const k of Object.keys(into)) into[k] += from[k]; };
  const totals = { affiliates: scope.length, direct: 0, active: 0, inactive: 0, maxLevel: 0, unplaced: scoped ? 0 : ref.members - ref.depth.size };
  const identity = emptyIdentity();
  const orders = withOrders ? { real: ref.emptyOrders(), fake: ref.emptyOrders() } : null;
  const levels = new Map();
  for (const [id, level] of scope) {
    if (level === 1) totals.direct += 1;
    totals.maxLevel = Math.max(totals.maxLevel, level);
    if (!levels.has(level)) levels.set(level, { level, affiliates: 0, active: 0, inactive: 0, identity: emptyIdentity(), orders: withOrders ? { real: ref.emptyOrders(), fake: ref.emptyOrders() } : null });
    const L = levels.get(level);
    L.affiliates += 1;
    if (ref.m.get(id).isActive === true) { totals.active += 1; L.active += 1; } else { totals.inactive += 1; L.inactive += 1; }
    const s = ref.idOf(id);
    identity[s] += 1;
    L.identity[s] += 1;
    if (withOrders) {
      const o = ref.ordersOf(id);
      add(orders.real, o.real); add(orders.fake, o.fake); add(L.orders.real, o.real); add(L.orders.fake, o.fake);
    }
  }
  return { rootId: rootId || null, totals, identity, orders, levels: [...levels.values()].sort((a, b) => a.level - b.level) };
}

function refNodes(ref, { parentId = null, view = null, cursor = 0, limit = PAGE_DEFAULT, includeOrders = true } = {}) {
  const size = Math.min(Math.max(Number.isInteger(limit) ? limit : PAGE_DEFAULT, 1), 100);
  const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  let ids;
  let parent = null;
  const path = [];
  if (view === 'unplaced') ids = ref.unplaced;
  else if (given(parentId)) {
    if (typeof parentId !== 'string' || !ID_RE.test(parentId) || !ref.depth.has(parentId)) throw fail('NOT_FOUND');
    parent = parentId;
    ids = ref.children.get(parentId) ?? [];
    for (let id = parentId; id;) {
      path.unshift(id);
      if (ref.depth.get(id) === 1) break;
      id = ref.m.get(id).parentId;
    }
  } else ids = ref.roots;
  const entry = (id) => ({ id, username: ref.m.get(id)?.username ?? null, name: ref.m.get(id)?.name ?? null, level: ref.depth.get(id) ?? null });
  const nodeOf = (id) => {
    const placed = ref.depth.has(id);
    const r = ref.m.get(id);
    return {
      id, username: r?.username ?? null, name: r?.name ?? null,
      level: placed ? ref.depth.get(id) : null,
      status: placed ? (r.isActive === true ? 'ACTIVE' : 'INACTIVE') : null,
      identityStatus: ref.idOf(id),
      childrenCount: placed ? (ref.children.get(id)?.length ?? 0) : 0,
      descendantsCount: placed ? ref.desc.get(id) ?? 0 : 0,
      orders: includeOrders === true ? ref.ordersOf(id) : null,
    };
  };
  return {
    parent: parent ? entry(parent) : null,
    path: path.map(entry),
    nodes: ids.slice(start, start + size).map(nodeOf),
    total: ids.length,
    nextCursor: start + size < ids.length ? start + size : null,
  };
}

// ── one case: old vs new (+ reference), SQL of the new call ──────────────────
function makeRunner(ctx) {
  const { mods, connNew, oldDb } = ctx;
  const counters = { cases: 0, mismatches: 0, viewMismatches: 0, refCases: 0, refMismatches: 0, ordersChecks: 0, ordersFailures: 0, neverAppearFailures: 0 };
  const perRec = new Map();
  const timings = [];
  const stmtMax = {};
  const mismatchDetails = [];
  const recCount = (rec) => {
    if (!perRec.has(rec)) perRec.set(rec, { comparisons: 0, mismatches: 0, refComparisons: 0, refMismatches: 0, ordersFailures: 0 });
    return perRec.get(rec);
  };
  async function run(spec) {
    const { rec, recruiterId, ep, args = {}, inc, kind, old = true, ref = null, members = null, neverAppear = null } = spec;
    const fn = ep === 'stats' ? 'getNetworkStats' : 'getNetworkNodes';
    const opts = { ...args, includeOrders: inc };
    let o; let eo = null; let oldMs = null;
    if (old) {
      const t0 = now();
      try { o = await mods.OLD[fn](recruiterId, { db: oldDb, ...opts }); } catch (e) { eo = e; }
      oldMs = now() - t0;
    }
    connNew.rec.reset();
    const mk = connNew.mark(kind);
    const t1 = now();
    let n; let en = null;
    try { n = await mods.NEW[fn](recruiterId, { db: connNew.db, ...opts }); } catch (e) { en = e; }
    const newMs = now() - t1;
    const sl = connNew.slice(mk);
    const stmts = sl.sql.length;
    const ordersStmts = sl.sql.filter((s) => touchesOrders(s.text)).length;
    const tags = [...new Set(sl.sql.map((s) => tagOf(s.text)).filter(Boolean))];
    const view = ep === 'stats' ? mods.statsView : mods.nodesView;
    const row = { kind: 'case', ds: ctx.ds, rec, ep, caseKind: kind, args, inc, oldMs: round(oldMs, 2), newMs: round(newMs, 2), stmts, ordersStmts, tags };
    const rc = recCount(rec);
    if (old) {
      counters.cases += 1;
      rc.comparisons += 1;
      let ok;
      let okView = true;
      if (eo || en) ok = !!eo && !!en && codeOf(eo) === codeOf(en);
      else {
        const so = JSON.stringify(o); const sn = JSON.stringify(n);
        ok = so === sn;
        okView = JSON.stringify(view(o)) === JSON.stringify(view(n));
        if (!ok) row.diff = firstDiff(so, sn);
        else if (!okView) row.viewDiff = firstDiff(JSON.stringify(view(o)), JSON.stringify(view(n)));
      }
      row.ok = ok && okView;
      row.oldErr = codeOf(eo);
      if (!row.ok) {
        counters.mismatches += 1; rc.mismatches += 1;
        if (!okView) counters.viewMismatches += 1;
        if (mismatchDetails.length < 50) mismatchDetails.push({ ds: ctx.ds, rec, ep, args, inc, oldErr: codeOf(eo), newErr: codeOf(en), diff: row.diff ?? row.viewDiff ?? null });
      }
    }
    row.newErr = codeOf(en);
    if (ref) {
      let r; let er = null;
      try { r = ep === 'stats' ? refStats(ref, args.rootId ?? null, inc) : refNodes(ref, opts); } catch (e) { er = e; }
      let refOk;
      if (er || en) refOk = !!er && !!en && codeOf(er) === codeOf(en);
      else {
        const sr = JSON.stringify(r); const sn = JSON.stringify(n);
        refOk = sr === sn && JSON.stringify(view(r)) === JSON.stringify(view(n));
        if (!refOk) row.refDiff = firstDiff(sr, sn);
      }
      row.refOk = refOk;
      counters.refCases += 1; rc.refComparisons += 1;
      if (!refOk) {
        counters.refMismatches += 1; rc.refMismatches += 1;
        if (mismatchDetails.length < 50) mismatchDetails.push({ ds: ctx.ds, rec, ep, args, inc, vs: 'reference', refErr: codeOf(er), newErr: codeOf(en), diff: row.refDiff ?? null });
      }
    }
    // driver-level SQL: orders statements (C1, client side)
    let expected = 0;
    if (inc === true && !en) {
      if (ep === 'stats') expected = (members ?? 1) > 0 ? 1 : 0;
      else expected = n.nodes.length > 0 ? 1 : 0;
    }
    row.ordersExpected = expected;
    row.ordersOk = ordersStmts === expected;
    counters.ordersChecks += 1;
    if (!row.ordersOk) { counters.ordersFailures += 1; rc.ordersFailures += 1; }
    if (neverAppear && !en) {
      const s = JSON.stringify(n);
      const leaked = neverAppear.filter((id) => s.includes(`"${id}"`));
      if (leaked.length) { row.leaked = leaked; counters.neverAppearFailures += 1; }
    }
    const key = `${ep}${args.view === 'unplaced' ? ':unplaced' : args.parentId ? ':children' : args.rootId ? ':subtree' : ''}`;
    stmtMax[key] = Math.max(stmtMax[key] ?? 0, stmts);
    timings.push({ rec, kind, inc, oldMs, newMs, err: !!(en || eo) });
    if (n && !en) {
      if (ep === 'nodes') { row.nodes = n.nodes.length; row.total = n.total; row.nextCursor = n.nextCursor; } else row.affiliates = n.totals.affiliates;
    }
    await appendResult(ctx.file, row);
    return { n, o, en, eo };
  }
  return { run, counters, perRec, timings, stmtMax, mismatchDetails };
}

// ── matrix ───────────────────────────────────────────────────────────────────
const sizeOf = (l) => Math.min(Math.max(Number.isInteger(l) ? l : PAGE_DEFAULT, 1), 100);

async function walk(R, base, { limit, cap = Infinity, kind }) {
  let cursor = 0;
  let pages = 0;
  for (;;) {
    const args = { ...base.args, cursor, ...(limit === undefined ? {} : { limit }) };
    const r = await R.run({ ...base, args, kind });
    pages += 1;
    const next = r.n && !r.en ? r.n.nextCursor : null;
    if (next === null || next === undefined) return { pages, total: r.n?.total ?? null };
    if (pages >= cap) {
      const total = r.n.total;
      const size = sizeOf(limit);
      const lastStart = Math.floor((total - 1) / size) * size;
      for (const c of [lastStart - size, lastStart]) {
        if (c > cursor) { await R.run({ ...base, args: { ...base.args, cursor: c, ...(limit === undefined ? {} : { limit }) }, kind: `${kind}:tail` }); pages += 1; }
      }
      return { pages, total, capped: true };
    }
    cursor = next;
  }
}

async function edgeCursors(R, base, total, kind) {
  const variants = [
    { cursor: total }, { cursor: Math.max(0, total - 1) }, { cursor: total + 10 }, { cursor: 9999999 },
    { cursor: -1 }, { cursor: 2.5 }, { cursor: '3' }, { limit: '7' }, { limit: -5 }, { limit: 2.5 }, { limit: 0, cursor: 1 },
    { limit: 101, cursor: Math.max(0, total - 1) }, { limit: 1, cursor: Math.max(0, total - 1) },
  ];
  for (const v of variants) await R.run({ ...base, args: { ...base.args, ...v }, kind: `${kind}:edge` });
}

/** Sample nodes of a reference network. */
function samplesOf(ref, shape, scale) {
  const placed = ref.bfs;
  const maxDepth = placed.reduce((a, id) => Math.max(a, ref.depth.get(id)), 0);
  const mid = Math.max(1, Math.ceil(maxDepth / 2));
  const bySize = [...placed].sort((a, b) => ref.desc.get(b) - ref.desc.get(a) || (a < b ? -1 : 1));
  const byKids = [...placed].sort((a, b) => (ref.children.get(b)?.length ?? 0) - (ref.children.get(a)?.length ?? 0) || (a < b ? -1 : 1));
  const atDepth = (dd) => placed.find((id) => ref.depth.get(id) === dd) ?? null;
  const leaves = placed.filter((id) => ref.desc.get(id) === 0);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  if (!placed.length) return { subtree: [], parents: [], topParent: null, maxDepth: 0 };
  if (shape === 'deep') {
    const depths = scale === '1k' ? [1, 2, 500, 998, 999, 1000] : [1, 2, 5000, 9998, 9999, 10000];
    const ds = depths.filter((x) => x <= maxDepth).map(atDepth);
    return { subtree: uniq(ds), parents: uniq(ds), topParent: atDepth(1), maxDepth, depths };
  }
  if (shape === 'fixture') {
    return { subtree: placed.slice(), parents: placed.filter((id) => (ref.children.get(id)?.length ?? 0) > 0), topParent: byKids[0], maxDepth };
  }
  if (shape === 'wide') {
    const kids = ref.children.get(ref.roots[0]) ?? [];
    return { subtree: uniq([ref.roots[0], kids[0], kids[Math.floor(kids.length / 2)], kids.at(-1)]), parents: uniq([ref.roots[0], kids[0]]), topParent: ref.roots[0], maxDepth };
  }
  const nonRoot = bySize.filter((id) => ref.depth.get(id) > 1);
  const midNodes = placed.filter((id) => ref.depth.get(id) === mid);
  const midLeaf = leaves.find((id) => ref.depth.get(id) === mid);
  const rootLeaf = leaves.find((id) => ref.depth.get(id) === 1);
  const deepest = placed.reduce((a, id) => (ref.depth.get(id) > ref.depth.get(a) ? id : a), placed[0]);
  const midParent = midNodes.find((id) => (ref.children.get(id)?.length ?? 0) > 0);
  return {
    subtree: uniq([ref.roots[0], ref.roots.at(-1), ...bySize.slice(0, 3), ...nonRoot.slice(0, 2), ...midNodes.slice(0, 2), midLeaf, rootLeaf, deepest, placed.at(-1)]),
    parents: uniq([...byKids.slice(0, 5), midParent, leaves[0], deepest]),
    topParent: byKids[0],
    maxDepth,
  };
}

async function matrix(R, ctx, rec, opt) {
  const { recruiterId, ref, shape, old, invalid, neverAppear = null } = opt;
  const s = samplesOf(ref, shape, ctx.scale);
  const base = { rec, recruiterId, old, ref, members: ref.members, neverAppear };
  const big = ctx.scale !== '1k';
  const cap = big ? { rootsL1: 25, rootsL7: 40, kidsL1: 25, kidsL7: 40 } : { rootsL1: Infinity, rootsL7: Infinity, kidsL1: 60, kidsL7: 60 };
  const summary = { rec, shape, members: ref.members, placed: ref.depth.size, unplaced: ref.unplaced.length, roots: ref.roots.length, maxDepth: s.maxDepth, subtreeSamples: s.subtree.length, parentSamples: s.parents.length };
  for (const inc of [true, false]) {
    await R.run({ ...base, ep: 'stats', args: {}, inc, kind: 'stats-whole' });
    await R.run({ ...base, ep: 'stats', args: { rootId: '' }, inc, kind: 'stats-whole-empty-rootId' });
    for (const id of s.subtree) await R.run({ ...base, ep: 'stats', args: { rootId: id }, inc, kind: 'stats-subtree' });
    for (const bad of invalid) await R.run({ ...base, ep: 'stats', args: { rootId: bad.id }, inc, kind: `stats-invalid:${bad.why}` });
    // roots
    const nb = { ...base, ep: 'nodes', inc };
    await walk(R, { ...nb, args: {} }, { kind: 'roots:default' });
    await walk(R, { ...nb, args: {} }, { limit: 1, cap: cap.rootsL1, kind: 'roots:l1' });
    await walk(R, { ...nb, args: {} }, { limit: 7, cap: cap.rootsL7, kind: 'roots:l7' });
    await walk(R, { ...nb, args: {} }, { limit: 100, kind: 'roots:l100' });
    await walk(R, { ...nb, args: {} }, { limit: 0, cap: 3, kind: 'roots:l0' });
    await walk(R, { ...nb, args: {} }, { limit: 101, kind: 'roots:l101' });
    await edgeCursors(R, { ...nb, args: {} }, ref.roots.length, 'roots');
    await R.run({ ...nb, args: { parentId: '' }, kind: 'roots:empty-parentId' });
    // children
    for (const p of s.parents) {
      const wideRoot = shape === 'wide' && p === ref.roots[0];
      await walk(R, { ...nb, args: { parentId: p } }, { kind: 'children:default', cap: wideRoot && big ? 10 : Infinity });
      if (p === s.topParent || wideRoot) {
        await walk(R, { ...nb, args: { parentId: p } }, { limit: 100, kind: 'children:l100' });
        await walk(R, { ...nb, args: { parentId: p } }, { limit: 7, cap: cap.kidsL7, kind: 'children:l7' });
        await walk(R, { ...nb, args: { parentId: p } }, { limit: 1, cap: cap.kidsL1, kind: 'children:l1' });
        await edgeCursors(R, { ...nb, args: { parentId: p } }, ref.children.get(p)?.length ?? 0, 'children');
      }
    }
    for (const bad of invalid) await R.run({ ...nb, args: { parentId: bad.id }, kind: `children-invalid:${bad.why}` });
    // unplaced
    const ub = { ...nb, args: { view: 'unplaced' } };
    await walk(R, ub, { limit: 1, kind: 'unplaced:l1' });
    await walk(R, ub, { kind: 'unplaced:default' });
    await walk(R, ub, { limit: 7, kind: 'unplaced:l7' });
    await walk(R, ub, { limit: 100, kind: 'unplaced:l100' });
    await edgeCursors(R, ub, ref.unplaced.length, 'unplaced');
    await R.run({ ...nb, args: { view: 'unplaced', parentId: s.topParent ?? NONEXISTENT_ID }, kind: 'unplaced:with-parentId' });
    await R.run({ ...nb, args: { view: 'other', parentId: s.topParent ?? undefined }, kind: 'view-other' });
  }
  return summary;
}

// ── fixture (B) ──────────────────────────────────────────────────────────────
const ORDER_POOL = ['delivered', 'Delivered', ' delivered ', 'DELIVERED', 'pending', 'PENDING', 'confirmed', 'shipped', 'shipped ', 'Shipped',
  'cancelled', 'canceled', 'CANCELED', 'returned', 'refused', 'REFUSED', '', 'weird', 'on_hold', ' '];
const IDENTITY_POOL = ['APPROVED', 'PENDING', 'REJECTED', 'EXPIRED', null, 'approved', null, ' APPROVED'];
const ms = (base, k) => {
  const t = new Date(`${base}Z`).getTime() + k;
  return new Date(t).toISOString().replace('Z', '');
};

function fixturePlan(foreign) {
  const members = [];
  const add = (id, parent, createdAt, extra = {}) => members.push({ id, parent, createdAt, ...extra });
  const T0 = '2025-06-01T00:00:00.000';
  const tieRoots = ['p5bR-a', 'p5bR-A', 'p5bR_a', 'p5bR_A', 'p5bR-0', 'p5bR_0', 'p5bR0', 'p5bRa', 'p5bRA', 'p5bR-', 'p5bR_', 'p5bR9', 'P5bR-a', 'p5br-a', 'p5bR-1', 'p5bR-10', 'p5bR-2'];
  for (const id of tieRoots) {
    const parent = id === 'p5bR_A' ? foreign.mixedRoot : id === 'p5bR-10' ? foreign.wideRoot : id === 'p5bR0' ? 'p5bOutsider1' : null;
    add(id, parent, T0);
  }
  add('p5bR-early', null, ms(T0, -1));
  add('p5bR-late', null, ms(T0, 1));
  // siblings with createdAt ties
  add('p5bTieParent', null, '2025-06-01T00:00:01.000');
  const T2 = '2025-06-01T00:00:02.000';
  for (const id of ['p5bS-a', 'p5bS-A', 'p5bS_a', 'p5bS_A', 'p5bS-0', 'p5bS_0', 'p5bS0', 'p5bSa', 'p5bSA', 'p5bS-1', 'p5bS-10', 'p5bS-2', 'P5bS', 'p5bs']) add(id, 'p5bTieParent', T2);
  add('p5bS-z', 'p5bTieParent', ms(T2, -1));
  add('p5bS-0b', 'p5bTieParent', ms(T2, 1));
  add('p5bS-A-1', 'p5bS-A', '2025-06-01T00:00:03.000');
  add('p5bS-A-2', 'p5bS-A', '2025-06-01T00:00:03.000');
  add('p5bS-A-1-x', 'p5bS-A-1', '2025-06-01T00:00:04.000');
  // 60-level chain (+3 extra children of level 30, tied with level 31)
  for (let i = 1; i <= 60; i += 1) add(`p5bChain-${String(i).padStart(2, '0')}`, i === 1 ? null : `p5bChain-${String(i - 1).padStart(2, '0')}`, ms('2025-06-02T00:00:00.000', i * 1000));
  for (let k = 1; k <= 3; k += 1) add(`p5bChainX-${k}`, 'p5bChain-30', ms('2025-06-02T00:00:00.000', 31 * 1000));
  // 230-child fan (createdAt ties in groups of 10; ids not in insertion order)
  add('p5bFan', null, '2025-06-03T00:00:00.000');
  for (let i = 1; i <= 230; i += 1) add(`p5bFan-${i % 2 ? 'b' : 'B'}${String(231 - i).padStart(3, '0')}`, 'p5bFan', ms('2025-06-03T00:00:01.000', Math.floor((i - 1) / 10)));
  add('p5bFanKid-1', 'p5bFan-b226', '2025-06-03T00:00:02.000');
  add('p5bFanKid-2', 'p5bFan-b226', '2025-06-03T00:00:02.000');
  add('p5bFanKid-3', 'p5bFan-B111', '2025-06-03T00:00:02.000');
  add('p5bFanKid-4', 'p5bFanKid-3', '2025-06-03T00:00:03.000');
  add('p5bFanKid-5', 'p5bFanKid-4', '2025-06-03T00:00:04.000');
  add('p5bFanKid-6', 'p5bFan-B001', '2025-06-03T00:00:02.000');
  // cycles (unplaced): self-parent, 2-cycle, 3-cycle, rho, children of cycle members; link ties
  const L0 = '2025-06-04T12:00:00.000';
  const cyc = (id, parent, linkAt = L0) => add(id, parent, '2025-06-04T00:00:00.000', { linkAt });
  cyc('p5bSelf', 'p5bSelf');
  cyc('p5bCyc2-a', 'p5bCyc2-B');
  cyc('p5bCyc2-B', 'p5bCyc2-a');
  cyc('p5bCyc3-a', 'p5bCyc3-b');
  cyc('p5bCyc3-b', 'p5bCyc3-C');
  cyc('p5bCyc3-C', 'p5bCyc3-a');
  cyc('p5bRho-1', 'p5bRho-2', ms(L0, -5));
  cyc('p5bRho-2', 'p5bRho-3');
  cyc('p5bRho-3', 'p5bRho-4');
  cyc('p5bRho-4', 'p5bRho-5');
  cyc('p5bRho-5', 'p5bRho-3', ms(L0, 5));
  cyc('p5bCycKid', 'p5bCyc2-a');
  cyc('p5bSelfKid', 'p5bSelf');
  // a cycle through an affiliate linked to nobody: p5bOutCyc is a ROOT (its parent is not a member)
  add('p5bOutCyc', 'p5bOutsider2', '2025-06-05T00:00:00.000');
  add('p5bOutCycKid', 'p5bOutCyc', '2025-06-05T00:00:01.000');
  add('p5bOrphanKid', 'p5bOutsider1', '2025-06-05T00:00:02.000');
  add('p5bForeign-1', foreign.mixedRoot, '2025-06-05T00:00:03.000');
  add('p5bForeign-2', foreign.wideRoot, '2025-06-05T00:00:03.000');
  // deterministic attributes
  const names = ['Ünïcødé ☃', 'مسوق تجريبي', '', "O'Brien \"quoted\"", 'x'.repeat(100)];
  members.forEach((mm, i) => {
    mm.username = `p5bu_${String(i).padStart(4, '0')}`;
    mm.name = i % 9 === 0 ? names[(i / 9) % names.length] : `P5b member ${i}`;
    mm.active = i % 3 !== 1;
    mm.identity = IDENTITY_POOL[i % IDENTITY_POOL.length];
    mm.orders = [];
    if (i % 3 !== 0) {
      const count = 1 + (i % 5);
      for (let k = 0; k < count; k += 1) mm.orders.push([ORDER_POOL[(i * 7 + k) % ORDER_POOL.length], (i + k) % 4 === 0]);
    }
    if (!mm.linkAt) mm.linkAt = ms('2025-07-01T00:00:00.000', i);
  });
  // explicit coverage: the fan's first children carry every unusual status, real and fake
  const fan1 = members.find((x) => x.id === 'p5bFan-b230');
  fan1.orders = ORDER_POOL.flatMap((st) => [[st, false], [st, true]]);
  const root1 = members.find((x) => x.id === 'p5bR-a');
  root1.orders = ORDER_POOL.map((st, k) => [st, k % 2 === 0]);
  const zero = members.find((x) => x.id === 'p5bR-A');
  zero.orders = [];
  const outsiders = [
    { id: 'p5bOutsider1', parent: null }, { id: 'p5bOutsider2', parent: 'p5bOutCyc' },
    { id: 'p5bOutsiderChild', parent: 'p5bFan' }, { id: 'p5bOutsiderChild2', parent: 'p5bChain-60' },
  ];
  const neighbour = [
    { id: 'p5bNbr-1', parent: 'p5bFan', createdAt: '2025-06-06T00:00:00.000' },
    { id: 'p5bNbr-2', parent: 'p5bNbr-1', createdAt: '2025-06-06T00:00:01.000' },
    { id: 'p5bNbr-3', parent: 'p5bChain-10', createdAt: '2025-06-06T00:00:02.000' },
  ];
  return { members, outsiders, neighbour };
}

const FIXTURE_REC = { id: 'p5b-edge-rec-0001', username: 'rec_p5b_edge' };
const NEIGHBOUR_REC = { id: 'p5b-nbr-rec-0001', username: 'rec_p5b_nbr' };

async function createFixture(db, foreign) {
  const plan = fixturePlan(foreign);
  const all = [...plan.members.map((x) => ({ ...x, rec: FIXTURE_REC.id })), ...plan.neighbour.map((x, i) => ({ ...x, rec: NEIGHBOUR_REC.id, username: `p5bn_${i}`, name: `P5b neighbour ${i}`, active: true, identity: null, orders: [['delivered', false]], linkAt: ms('2025-07-02T00:00:00.000', i) }))];
  const outs = plan.outsiders.map((x, i) => ({ ...x, username: `p5bo_${i}`, name: `P5b outsider ${i}`, createdAt: '2025-06-07T00:00:00.000', active: true }));
  const hash = `(SELECT "passwordHash" FROM recruiters WHERE username = 'rec_empty')`;
  const rec = (r) => `(${lit(r.id)}, ${lit(r.username)}, ${lit(`P5b ${r.username}`)}, ${hash}, true, true, true, 'p5b-fixture', TIMESTAMP '2025-05-31 00:00:00', TIMESTAMP '2025-05-31 00:00:00', 0)`;
  const nowUtc = `(now() AT TIME ZONE 'UTC')::timestamp(3)`;
  const affRow = (x) => `(${lit(x.id)}, ${lit(x.username)}, ${lit(x.name)}, '', false, NULL, ${nowUtc}, ${nowUtc})`;
  // transaction 1: recruiters, affiliates (INACTIVE, createdAt = now UTC, no parent yet) and links — the link trigger's rule
  const tx1 = [
    'BEGIN;',
    `INSERT INTO recruiters (id, username, name, "passwordHash", "isActive", "canCreateAffiliates", "canViewOrders", "createdBy", "createdAt", "updatedAt", "tokenVersion") VALUES ${[FIXTURE_REC, NEIGHBOUR_REC].map(rec).join(', ')};`,
    `INSERT INTO affiliates (id, username, name, password, "isActive", "parentId", "createdAt", "updatedAt") VALUES ${[...all, ...outs].map(affRow).join(',\n')};`,
    `INSERT INTO recruiter_affiliate_links ("affiliateId", "recruiterId", "createdBy", "createdAt") VALUES ${all.map((x) => `(${lit(x.id)}, ${lit(x.rec)}, ${lit(x.rec)}, TIMESTAMP ${lit(x.linkAt.replace('T', ' '))})`).join(',\n')};`,
    'COMMIT;',
  ].join('\n');
  await pgQuery(db, tx1);
  // transaction 2: planned parents (cycles included), createdAt, isActive; identity rows; orders
  const upd = [...all, ...outs].map((x) => `(${lit(x.id)}, ${lit(x.parent)}, TIMESTAMP ${lit(x.createdAt.replace('T', ' '))}, ${x.active ? 'true' : 'false'})`).join(',\n');
  const ivRows = all.filter((x) => x.identity !== null).map((x, i) => `(${lit(`p5b-iv-${i}`)}, ${lit(x.id)}, ${lit(x.identity)}, TIMESTAMP '2025-06-10 00:00:00')`);
  let oi = 0;
  const orderRows = all.flatMap((x) => x.orders.map(([st, fake]) => { oi += 1; return `(${lit(`p5b-o-${oi}`)}, ${lit(x.id)}, ${lit(st)}, ${fake ? 'true' : 'false'})`; }));
  const tx2 = [
    'BEGIN;',
    `UPDATE affiliates a SET "parentId" = v.parent, "createdAt" = v.created, "updatedAt" = v.created, "isActive" = v.active
       FROM (VALUES ${upd}) AS v(id, parent, created, active) WHERE a.id = v.id;`,
    `INSERT INTO identity_verifications (id, "affiliateId", status, "updatedAt") VALUES ${ivRows.join(',\n')};`,
    `INSERT INTO affiliate_orders (id, "affiliateId", status, "isFake") VALUES ${orderRows.join(',\n')};`,
    'COMMIT;',
    'ANALYZE affiliates; ANALYZE recruiter_affiliate_links; ANALYZE identity_verifications; ANALYZE affiliate_orders;',
  ].join('\n');
  await pgQuery(db, tx2);
  const check = await pgQuery(db, `SELECT r.username, count(l.*)::int AS members FROM recruiters r LEFT JOIN recruiter_affiliate_links l ON l."recruiterId" = r.id
    WHERE r.id = ANY($1::text[]) GROUP BY 1 ORDER BY 1`, [[FIXTURE_REC.id, NEIGHBOUR_REC.id]]);
  return { plan, check, orders: oi, identityRows: ivRows.length, outsiders: outs.map((x) => x.id), neighbour: plan.neighbour.map((x) => x.id) };
}

const FIXTURE_CASES = [
  'createdAt ties among 17 roots whose ids differ only by case / "-" / "_" / digits (+ one root 1 ms earlier, one 1 ms later)',
  'createdAt ties among 14 siblings (case / "-" / "_" / digits, -1 < -10 < -2) + one sibling 1 ms earlier and one 1 ms later; a tied sibling with its own 2-level subtree',
  'self-parent member (p5bSelf) and its member child → unplaced',
  '2-cycle (p5bCyc2-a <-> p5bCyc2-B) and a member child of a cycle member → unplaced',
  '3-cycle (p5bCyc3-a -> b -> C -> a) → unplaced',
  'rho: chain p5bRho-1 -> 2 -> (3 -> 4 -> 5 -> 3) → all unplaced; unplaced link createdAt ties (9 members share one link time) plus one earlier / one later',
  'members whose parent belongs to ANOTHER recruiter (rec_mixed first root, rec_wide root) → roots here (two of them inside the tie group)',
  'members whose parent is an affiliate linked to nobody (p5bOutsider1) → roots',
  'cycle through an outsider: member p5bOutCyc -> unlinked p5bOutsider2 -> p5bOutCyc → p5bOutCyc is a root with a member child',
  'unlinked affiliates whose parentId is a member (p5bOutsiderChild under p5bFan, p5bOutsiderChild2 under the chain leaf) → never appear, never counted',
  'neighbour recruiter rec_p5b_nbr: its members p5bNbr-1/2/3 have parents inside rec_p5b_edge → never appear in rec_p5b_edge; roots in their own network',
  'identity rows APPROVED / PENDING / REJECTED / EXPIRED / approved (lower case) / " APPROVED" (leading space) / no row',
  'orders with statuses delivered, Delivered, " delivered ", DELIVERED, pending, PENDING, confirmed, shipped, "shipped ", Shipped, cancelled, canceled, CANCELED, returned, refused, REFUSED, "", weird, on_hold, " " — real and fake; members with zero orders; orders on unplaced members',
  'active and inactive members (1 in 3 inactive)',
  'names: unicode, Arabic, empty string, quotes, 100 characters',
  '60-level chain (3 extra children at level 31 tied with the chain node, an unlinked child under the leaf, a neighbour member under level 10)',
  '230-child fan (createdAt ties in groups of 10, ids not in insertion order; grandchildren and a 3-level sub-chain under fan children) — pages of 1 / 7 / 50 / 100 / 0 / 101 + edge cursors',
  'invalid rootId / parentId for the fixture: every unplaced member, every outsider, every neighbour member, another recruiter\'s affiliate, nonexistent, malformed → NOT_FOUND',
];

// ── equiv (A + B) ────────────────────────────────────────────────────────────
async function equiv(a) {
  if (!['1k', '10k'].includes(a.scale)) throw new Error('--scale 1k|10k (no 100k in Part 5b)');
  const clone = assertOwnClone(a.clone ?? `val_5b_${a.scale}`);
  const template = a.scale === '1k' ? 'p5a_1k' : 'p5a_10k';
  mkdirSync(RESULTS, { recursive: true });
  const file = resultPath(`equiv-${a.scale}.jsonl`);
  const serviceShaStart = sha256(SERVICE_FILE);
  const startedAt = new Date().toISOString();
  const existing = await listDatabases();
  let cloneInfo = null;
  if (existing.includes(clone)) {
    if (!a.reuse) throw new Error(`${clone} exists: pass --reuse or drop it`);
  } else cloneInfo = await cloneDb(template, clone);
  const mods = await loadModules();
  const connNew = await connect(clone, { sqlTrace: true, bytes: false, heap: false });
  const connOld = await connect(clone, { sqlTrace: false, bytes: false, heap: false });
  const ctx = { ds: `${a.scale}:${clone}`, scale: a.scale, file, mods, connNew, oldDb: connOld.prisma };
  const R = makeRunner(ctx);
  const out = { kind: 'run', scale: a.scale, clone, template, cloneInfo, serviceShaStart, oldModuleSha: sha256(OLD_MODULE), startedAt, recruiters: {}, notes: [] };
  await appendResult(file, { kind: 'start', ...out });
  let fixture = null;
  try {
    const recs = await pgQuery(clone, `SELECT id, username, "tokenVersion" FROM recruiters WHERE username = ANY($1::text[]) ORDER BY username`, [GENERATED]);
    const byName = Object.fromEntries(recs.map((r) => [r.username, r]));
    const refs = {};
    for (const name of GENERATED) refs[name] = buildRef(await loadFlat(clone, byName[name].id), mods.OLD);
    const otherOf = { rec_mixed: 'rec_wide', rec_wide: 'rec_mixed', rec_deep: 'rec_mixed', rec_empty: 'rec_mixed' };
    const mixedUnplaced = refs.rec_mixed.unplaced;
    const invalidFor = (name) => {
      const other = refs[otherOf[name]];
      const list = [{ id: MALFORMED_ID, why: 'malformed' }, { id: NONEXISTENT_ID, why: 'nonexistent' }, { id: other.roots[0], why: 'other-recruiter-affiliate' }];
      if (refs[name].unplaced.length) list.push({ id: refs[name].unplaced[0], why: 'own-unplaced-member' }, { id: refs[name].unplaced.at(-1), why: 'own-unplaced-member-last' });
      else if (mixedUnplaced.length) list.push({ id: mixedUnplaced[0], why: 'other-recruiter-unplaced-member' });
      return list;
    };
    // UNAUTHORIZED / nonexistent recruiter (once)
    for (const inc of [true, false]) {
      await R.run({ rec: 'malformed-recruiter', recruiterId: MALFORMED_ID, ep: 'stats', inc, kind: 'unauthorized' });
      await R.run({ rec: 'malformed-recruiter', recruiterId: MALFORMED_ID, ep: 'nodes', inc, kind: 'unauthorized' });
      await R.run({ rec: 'malformed-recruiter', recruiterId: 42, ep: 'nodes', inc, kind: 'unauthorized-non-string' });
      const none = { rec: 'nonexistent-recruiter', recruiterId: NONEXISTENT_ID, members: 0, inc };
      await R.run({ ...none, ep: 'stats', kind: 'no-members' });
      await R.run({ ...none, ep: 'nodes', kind: 'no-members' });
      await R.run({ ...none, ep: 'nodes', args: { view: 'unplaced' }, kind: 'no-members' });
      await R.run({ ...none, ep: 'stats', args: { rootId: refs.rec_mixed.roots[0] }, kind: 'no-members-scoped' });
      await R.run({ ...none, ep: 'nodes', args: { parentId: refs.rec_mixed.roots[0] }, kind: 'no-members-scoped' });
    }
    const preFixture = {};
    for (const name of GENERATED) {
      const shape = name.replace('rec_', '');
      const oldAllowed = !(a.scale === '10k' && name === 'rec_deep');
      const t0 = now();
      const summary = await matrix(R, ctx, name, { recruiterId: byName[name].id, ref: refs[name], shape, old: oldAllowed, invalid: invalidFor(name) });
      summary.oldCalled = oldAllowed;
      summary.wallMs = round(now() - t0);
      out.recruiters[name] = summary;
      await appendResult(file, { kind: 'matrix-summary', ...summary });
      process.stderr.write(`[equiv ${a.scale}] ${name}: ${JSON.stringify(R.counters)}\n`);
      if (a.fixture) {
        const id = byName[name].id;
        const snap = {};
        snap.stats = JSON.stringify(await mods.NEW.getNetworkStats(id, { db: connNew.prisma }));
        snap.roots = JSON.stringify(await mods.NEW.getNetworkNodes(id, { db: connNew.prisma }));
        if (refs[name].roots[0]) snap.children = JSON.stringify(await mods.NEW.getNetworkNodes(id, { db: connNew.prisma, parentId: refs[name].roots[0] }));
        snap.unplaced = JSON.stringify(await mods.NEW.getNetworkNodes(id, { db: connNew.prisma, view: 'unplaced' }));
        preFixture[name] = snap;
      }
    }
    if (a.scale === '10k') out.deep10k = await deep10k(ctx, R, byName.rec_deep.id, refs.rec_deep, mods);
    if (a.fixture) {
      if (a.scale !== '1k') throw new Error('--fixture is for the 1k clone');
      const foreign = { mixedRoot: refs.rec_mixed.roots[0], wideRoot: refs.rec_wide.roots[0] };
      fixture = await createFixture(clone, foreign);
      await appendResult(file, { kind: 'fixture-created', check: fixture.check, orders: fixture.orders, identityRows: fixture.identityRows, members: fixture.plan.members.length, outsiders: fixture.outsiders, neighbour: fixture.neighbour, foreign });
      const fxRef = buildRef(await loadFlat(clone, FIXTURE_REC.id), mods.OLD);
      const nbRef = buildRef(await loadFlat(clone, NEIGHBOUR_REC.id), mods.OLD);
      const neverAppear = [...fixture.outsiders, ...fixture.neighbour];
      const fxInvalid = [
        { id: MALFORMED_ID, why: 'malformed' }, { id: NONEXISTENT_ID, why: 'nonexistent' }, { id: foreign.mixedRoot, why: 'other-recruiter-affiliate' },
        ...fxRef.unplaced.map((id) => ({ id, why: `unplaced:${id}` })), ...fixture.outsiders.map((id) => ({ id, why: `outsider:${id}` })),
        ...fixture.neighbour.map((id) => ({ id, why: `neighbour-member:${id}` })),
      ];
      const t0 = now();
      const fxSummary = await matrix(R, ctx, 'rec_p5b_edge', { recruiterId: FIXTURE_REC.id, ref: fxRef, shape: 'fixture', old: true, invalid: fxInvalid, neverAppear });
      fxSummary.wallMs = round(now() - t0);
      fxSummary.expectations = {
        unplacedIds: fxRef.unplaced, rootsInOrder: fxRef.roots, tieSiblingsInOrder: fxRef.children.get('p5bTieParent'),
        fanFirst12: (fxRef.children.get('p5bFan') ?? []).slice(0, 12), fanChildren: fxRef.children.get('p5bFan')?.length ?? 0,
        chainMaxDepth: fxRef.depth.get('p5bChain-60'), outCycIsRoot: fxRef.roots.includes('p5bOutCyc'),
      };
      out.recruiters.rec_p5b_edge = fxSummary;
      await appendResult(file, { kind: 'matrix-summary', ...fxSummary });
      const nbSummary = await matrix(R, ctx, 'rec_p5b_nbr', { recruiterId: NEIGHBOUR_REC.id, ref: nbRef, shape: 'mixed', old: true, invalid: [{ id: 'p5bFan', why: 'other-recruiter-affiliate' }, { id: MALFORMED_ID, why: 'malformed' }] });
      out.recruiters.rec_p5b_nbr = nbSummary;
      await appendResult(file, { kind: 'matrix-summary', ...nbSummary });
      // isolation: the generated networks are unchanged by the fixture (old vs new too)
      const iso = [];
      for (const name of GENERATED) {
        const id = byName[name].id;
        const snap = preFixture[name];
        const nowStats = JSON.stringify(await mods.NEW.getNetworkStats(id, { db: connNew.prisma }));
        const nowRoots = JSON.stringify(await mods.NEW.getNetworkNodes(id, { db: connNew.prisma }));
        const nowChildren = refs[name].roots[0] ? JSON.stringify(await mods.NEW.getNetworkNodes(id, { db: connNew.prisma, parentId: refs[name].roots[0] })) : undefined;
        const nowUnplaced = JSON.stringify(await mods.NEW.getNetworkNodes(id, { db: connNew.prisma, view: 'unplaced' }));
        const same = snap.stats === nowStats && snap.roots === nowRoots && snap.children === nowChildren && snap.unplaced === nowUnplaced;
        iso.push({ rec: name, unchanged: same });
        for (const inc of [true, false]) {
          await R.run({ rec: name, recruiterId: id, ep: 'stats', inc, kind: 'post-fixture', ref: null, members: refs[name].members });
          if (refs[name].roots[0]) await R.run({ rec: name, recruiterId: id, ep: 'nodes', args: { parentId: refs[name].roots[0] }, inc, kind: 'post-fixture', ref: null, members: refs[name].members });
        }
      }
      out.isolation = iso;
      await appendResult(file, { kind: 'isolation', iso });
      out.fixtureCases = FIXTURE_CASES;
    }
    const ct = await pgQuery(clone, `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'affiliates'::regclass AND attname = 'createdAt'`);
    const isc = await pgQuery(clone, `SELECT data_type, datetime_precision FROM information_schema.columns WHERE table_name = 'affiliates' AND column_name = 'createdAt'`);
    out.createdAtType = { formatType: ct[0]?.t ?? null, informationSchema: isc[0] ?? null };
    out.collation = (await pgQuery(clone, 'SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()'))[0];
  } finally {
    await connNew.close();
    await connOld.close();
    if (!a.keepClone) out.drop = await dropDb(clone);
  }
  out.counters = R.counters;
  out.perRecruiter = Object.fromEntries(R.perRec);
  out.statementsMaxPerCall = R.stmtMax;
  out.mismatchDetails = R.mismatchDetails;
  // single-run timings (one call per case, not a benchmark): per recruiter × case family × orders
  const fam = (k) => k.split(':')[0].replace(/-(whole|empty-rootId).*$/, '-whole');
  const groups = new Map();
  for (const t of R.timings) {
    const key = `${t.rec}|${fam(t.kind)}|${t.inc ? 'on' : 'off'}`;
    if (!groups.has(key)) groups.set(key, { old: [], new: [] });
    if (t.oldMs !== null) groups.get(key).old.push(t.oldMs);
    groups.get(key).new.push(t.newMs);
  }
  out.singleRunTimings = [...groups].map(([k, v]) => ({ key: k, old: stat(v.old), new: stat(v.new) }));
  out.serviceShaEnd = sha256(SERVICE_FILE);
  out.serviceShaStable = out.serviceShaEnd === serviceShaStart;
  out.finishedAt = new Date().toISOString();
  out.clonesLeft = await listClones();
  await appendResult(file, { kind: 'summary', ...out });
  return out;
}

// ── 10k deep chain: new results vs the chain walked in JS (old NOT called) ───
async function deep10k(ctx, R, recruiterId, ref, mods) {
  const { NEW } = mods;
  const db = ctx.connNew.db;
  const checks = [];
  const check = (name, ok, detail = undefined) => checks.push({ name, ok: !!ok, ...(ok || detail === undefined ? {} : { detail }) });
  // chain order from parentId (JS walk of the flat rows: root = member whose parent is null / not a member)
  const chain = [];
  for (let id = ref.roots.length === 1 ? ref.roots[0] : null; id;) {
    chain.push(id);
    const kids = ref.children.get(id) ?? [];
    if (kids.length > 1) { check('chain-single-child', false, { id, kids: kids.length }); break; }
    id = kids[0] ?? null;
  }
  const N = chain.length;
  check('chain-length-10000', N === 10000, { N, roots: ref.roots.length });
  check('chain-no-unplaced', ref.unplaced.length === 0, ref.unplaced.length);
  const timings = {};
  const t = async (label, f) => {
    const t0 = now();
    const v = await f();
    timings[label] = round(now() - t0);
    return v;
  };
  const m = (id) => ref.m.get(id);
  for (const inc of [true, false]) {
    const tag = inc ? 'on' : 'off';
    const s = await t(`stats-whole-${tag}`, () => NEW.getNetworkStats(recruiterId, { db, includeOrders: inc }));
    check(`stats-${tag}-totals`, s.totals.affiliates === N && s.totals.direct === 1 && s.totals.maxLevel === N && s.totals.unplaced === 0
      && s.totals.active === chain.filter((id) => m(id).isActive === true).length && s.totals.active + s.totals.inactive === N, s.totals);
    check(`stats-${tag}-levels`, s.levels.length === N && s.levels.every((L, i) => L.level === i + 1 && L.affiliates === 1
      && L.active === (m(chain[i]).isActive === true ? 1 : 0) && L.identity[ref.idOf(chain[i])] === 1
      && (inc ? JSON.stringify(L.orders) === JSON.stringify(ref.ordersOf(chain[i])) : L.orders === null)));
    check(`stats-${tag}-orders-null`, inc ? s.orders !== null : s.orders === null);
    check(`stats-${tag}-equals-reference`, JSON.stringify(s) === JSON.stringify(refStats(ref, null, inc)));
    const roots = await t(`roots-${tag}`, () => NEW.getNetworkNodes(recruiterId, { db, includeOrders: inc }));
    check(`roots-${tag}`, roots.total === 1 && roots.nextCursor === null && roots.nodes.length === 1 && roots.nodes[0].id === chain[0]
      && roots.nodes[0].level === 1 && roots.nodes[0].childrenCount === 1 && roots.nodes[0].descendantsCount === N - 1, roots.nodes[0]);
    check(`roots-${tag}-equals-reference`, JSON.stringify(roots) === JSON.stringify(refNodes(ref, { includeOrders: inc })));
    for (const d of [1, 5000, 9999]) {
      const parentId = chain[d - 1];
      const page = await t(`children-depth-${d}-${tag}`, () => NEW.getNetworkNodes(recruiterId, { db, parentId, includeOrders: inc }));
      const child = page.nodes[0];
      check(`children-depth-${d}-${tag}`, page.total === 1 && page.nodes.length === 1 && child.id === chain[d] && child.level === d + 1
        && child.descendantsCount === N - d - 1 && child.childrenCount === (d + 1 < N ? 1 : 0)
        && page.parent.id === parentId && page.parent.level === d && page.path.length === d
        && page.path.every((p, i) => p.id === chain[i] && p.level === i + 1), { total: page.total, child, parent: page.parent, pathLength: page.path.length });
      check(`children-depth-${d}-${tag}-equals-reference`, JSON.stringify(page) === JSON.stringify(refNodes(ref, { parentId, includeOrders: inc })));
    }
    const sub = await t(`stats-subtree-depth-5000-${tag}`, () => NEW.getNetworkStats(recruiterId, { db, rootId: chain[4999], includeOrders: inc }));
    check(`stats-subtree-5000-${tag}`, sub.rootId === chain[4999] && sub.totals.affiliates === 5000 && sub.totals.direct === 1 && sub.totals.maxLevel === 5000
      && sub.totals.unplaced === 0 && sub.levels.length === 5000 && sub.levels.every((L, i) => L.level === i + 1 && L.affiliates === 1
      && L.active === (m(chain[5000 + i]).isActive === true ? 1 : 0)), sub.totals);
    check(`stats-subtree-5000-${tag}-equals-reference`, JSON.stringify(sub) === JSON.stringify(refStats(ref, chain[4999], inc)));
    const un = await t(`unplaced-${tag}`, () => NEW.getNetworkNodes(recruiterId, { db, view: 'unplaced', includeOrders: inc }));
    check(`unplaced-${tag}-empty`, un.total === 0 && un.nodes.length === 0 && un.nextCursor === null && un.parent === null && un.path.length === 0, un);
    const leaf = await t(`children-of-leaf-${tag}`, () => NEW.getNetworkNodes(recruiterId, { db, parentId: chain[N - 1], includeOrders: inc }));
    check(`children-of-leaf-${tag}`, leaf.total === 0 && leaf.nodes.length === 0 && leaf.path.length === N && leaf.parent.level === N, { total: leaf.total, pathLength: leaf.path.length });
  }
  const failed = checks.filter((c) => !c.ok);
  const res = { kind: 'deep10k', recruiterId, chainLength: N, checks: checks.length, failed: failed.length, failures: failed, singleRunTimingsMs: timings,
    note: 'OLD implementation not called for 10k rec_deep (instruction); new results validated against the chain walked from parentId in JS (flat SQL rows, no recursive SQL) and the in-memory reference' };
  await appendResult(ctx.file, res);
  return res;
}

// ── log-proof (C) ────────────────────────────────────────────────────────────
function readLogRange(files, startOffsets) {
  let text = '';
  for (const f of files) {
    const size = statSync(f).size;
    const from = startOffsets.get(f) ?? 0;
    if (size <= from) continue;
    const fd = openSync(f, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      text += buf.toString('utf8');
    } finally { closeSync(fd); }
  }
  return text;
}

function windowOf(text, startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  const e = s < 0 ? -1 : text.indexOf(endMarker, s);
  if (s < 0 || e < 0) return null;
  return text.slice(s, e);
}

async function logProof(a) {
  const clone = assertOwnClone(a.clone ?? 'val_5b_log');
  mkdirSync(RESULTS, { recursive: true });
  const file = resultPath('log-proof.jsonl');
  const serviceShaStart = sha256(SERVICE_FILE);
  if ((await listDatabases()).includes(clone)) throw new Error(`${clone} exists`);
  const cloneInfo = await cloneDb('p5a_1k', clone);
  const out = { kind: 'log-proof', clone, cloneInfo, serviceShaStart, startedAt: new Date().toISOString() };
  const mods = await loadModules();
  const { recruiterNetworkHandlers } = await import(join(REPO, 'src/lib/recruiterNetworkRouteHandlers.js'));
  let conn = null;
  try {
    await pgQuery('postgres', `ALTER DATABASE "${clone}" SET log_statement = 'all'`);
    const setting = await pgQuery(clone, `SELECT current_setting('log_statement') AS v, pg_current_logfile() AS f`);
    out.logStatementInClone = setting[0].v;
    out.logStatementInPostgresDb = (await pgQuery('postgres', `SELECT current_setting('log_statement') AS v`))[0].v;
    const logDir = PG_LOG;
    const filesBefore = existsSync(logDir) ? readdirSync(logDir).map((f) => join(logDir, f)) : [];
    const offsets = new Map(filesBefore.map((f) => [f, statSync(f).size]));
    out.logFileAtStart = setting[0].f;
    const recs = await pgQuery(clone, `SELECT id, username, "tokenVersion" FROM recruiters WHERE username = ANY($1::text[]) ORDER BY username`, [GENERATED]);
    const byName = Object.fromEntries(recs.map((r) => [r.username, r]));
    const refs = {};
    for (const name of GENERATED) refs[name] = buildRef(await loadFlat(clone, byName[name].id), mods.OLD);
    const mixed = byName.rec_mixed;
    const flag = async (v) => (await pgQuery(clone, `UPDATE recruiters SET "canViewOrders" = $2 WHERE id = $1 RETURNING "canViewOrders" AS v`, [mixed.id, v]))[0].v;
    out.flagOff = await flag(false);
    conn = await connect(clone, { sqlTrace: true, bytes: false, heap: false });
    const handlers = recruiterNetworkHandlers({ db: conn.db, rateLimit: () => false });
    const decoded = { type: 'recruiter', recruiterId: mixed.id, tv: mixed.tokenVersion };
    const sampleOf = (name) => {
      const ref = refs[name];
      const s = samplesOf(ref, name.replace('rec_', ''), '1k');
      return { node: s.subtree.find((id) => ref.depth.get(id) > 1) ?? ref.roots[0] ?? null, parent: s.topParent ?? null, unplaced: ref.unplaced[0] ?? null };
    };
    const serviceCalls = async (inc) => {
      const res = [];
      for (const name of GENERATED) {
        const id = byName[name].id;
        const s = sampleOf(name);
        const calls = [
          ['stats whole', () => mods.NEW.getNetworkStats(id, { db: conn.db, includeOrders: inc })],
          ['roots', () => mods.NEW.getNetworkNodes(id, { db: conn.db, includeOrders: inc })],
          ['unplaced', () => mods.NEW.getNetworkNodes(id, { db: conn.db, view: 'unplaced', includeOrders: inc })],
        ];
        if (s.node) calls.push(['stats subtree', () => mods.NEW.getNetworkStats(id, { db: conn.db, rootId: s.node, includeOrders: inc })]);
        if (s.parent) calls.push(['children', () => mods.NEW.getNetworkNodes(id, { db: conn.db, parentId: s.parent, includeOrders: inc })]);
        for (const [label, f] of calls) {
          conn.rec.reset();
          const mk = conn.mark(label);
          let v = null; let err = null;
          try { v = await f(); } catch (e) { err = codeOf(e); }
          const sl = conn.slice(mk);
          const ordersNull = v ? (label.startsWith('stats') ? v.orders === null && v.levels.every((L) => L.orders === null) : v.nodes.every((n) => n.orders === null)) : null;
          const expectedOrders = !inc || err || !v ? 0 : label.startsWith('stats') ? (refs[name].members > 0 ? 1 : 0) : (v.nodes.length > 0 ? 1 : 0);
          res.push({ rec: name, label, inc, err, statements: sl.sql.length, ordersStatements: sl.sql.filter((q) => touchesOrders(q.text)).length, expectedOrders,
            nonEmpty: v ? (label.startsWith('stats') ? v.totals.affiliates > 0 : v.nodes.length > 0) : false, ordersNull, tags: [...new Set(sl.sql.map((q) => tagOf(q.text)).filter(Boolean))] });
        }
      }
      return res;
    };
    const handlerCalls = async () => {
      const s = sampleOf('rec_mixed');
      const urls = [
        ['stats', '/api/recruiter/network/stats'], ['stats', `/api/recruiter/network/stats?rootId=${s.node}`],
        ['nodes', '/api/recruiter/network/nodes'], ['nodes', '/api/recruiter/network/nodes?cursor=0&limit=100'],
        ['nodes', `/api/recruiter/network/nodes?parentId=${s.parent}`], ['nodes', '/api/recruiter/network/nodes?view=unplaced'],
        ['nodes', `/api/recruiter/network/nodes?parentId=${s.unplaced}`],
      ];
      const res = [];
      for (const [ep, path] of urls) {
        conn.rec.reset();
        const mk = conn.mark(path);
        const r = await handlers[ep](new Request(`http://local${path}`), {}, decoded);
        const body = await r.json();
        const sl = conn.slice(mk);
        let ordersValues = [];
        if (ep === 'stats' && body.stats) ordersValues = [body.stats.orders, ...body.stats.levels.map((L) => L.orders)];
        if (ep === 'nodes' && Array.isArray(body.nodes)) ordersValues = body.nodes.map((n) => n.orders);
        res.push({ ep, path, status: r.status, code: body.code ?? null, ordersValues: ordersValues.length, ordersAllNull: ordersValues.every((x) => x === null), ordersAnyNonNull: ordersValues.some((x) => x !== null),
          statements: sl.sql.length, ordersStatements: sl.sql.filter((q) => touchesOrders(q.text)).length });
      }
      return res;
    };
    const marker = async (label) => conn.prisma.$queryRawUnsafe(`SELECT '${label}' AS marker`);
    // OFF window
    await pgssReset(clone);
    await marker('p5b-off-start');
    const offService = await serviceCalls(false);
    const offHandler = await handlerCalls();
    await marker('p5b-off-end');
    const pgssOff = await pgssSnapshot(clone, { limit: 500 });
    // ON window (positive control)
    out.flagOn = await flag(true);
    await pgssReset(clone);
    await marker('p5b-on-start');
    const onService = await serviceCalls(true);
    const onHandler = await handlerCalls();
    await marker('p5b-on-end');
    const pgssOn = await pgssSnapshot(clone, { limit: 500 });
    await conn.close();
    conn = null;
    await pgQuery('postgres', `ALTER DATABASE "${clone}" RESET log_statement`);
    // server log between the markers
    const filesAfter = readdirSync(logDir).map((f) => join(logDir, f)).filter((f) => !offsets.has(f) || statSync(f).size > offsets.get(f));
    const text = readLogRange(filesAfter, offsets);
    const offWin = windowOf(text, "'p5b-off-start'", "'p5b-off-end'");
    const onWin = windowOf(text, "'p5b-on-start'", "'p5b-on-end'");
    const scan = (w) => {
      if (w === null) return null;
      const lines = w.split('\n');
      const stmtLines = lines.filter((l) => /LOG: {2}(statement|execute [^:]*):/.test(l));
      return {
        lines: lines.length, loggedStatements: stmtLines.length, linesTouchingOrders: lines.filter((l) => touchesOrders(l)).length,
        tags: Object.fromEntries(TAGS.map((tg) => [tg, w.split(`/* ${tg} */`).length - 1])),
        sampleOrdersLine: (lines.find((l) => touchesOrders(l)) ?? null)?.slice(0, 240) ?? null,
      };
    };
    const pgssCount = (rows) => ({
      entries: rows.length, touchingOrders: rows.filter((r) => touchesOrders(r.query)).length,
      networkEntries: rows.filter((r) => /recruiter-network-/.test(r.query)).map((r) => ({ tag: tagOf(r.query), calls: Number(r.calls) })),
      ordersEntries: rows.filter((r) => touchesOrders(r.query)).map((r) => ({ calls: Number(r.calls), query: r.query.replace(/\s+/g, ' ').slice(0, 160) })),
    });
    out.serverLog = { files: filesAfter, off: scan(offWin), on: scan(onWin) };
    out.pgss = { off: pgssCount(pgssOff), on: pgssCount(pgssOn) };
    out.client = {
      off: { serviceCalls: offService.length, handlerCalls: offHandler.length, ordersStatements: [...offService, ...offHandler].reduce((x, r) => x + r.ordersStatements, 0),
        serviceOrdersAllNull: offService.every((r) => r.err || r.ordersNull === true) },
      on: { stats: onService.filter((r) => r.label.startsWith('stats') && !r.err).map((r) => ({ rec: r.rec, label: r.label, nonEmpty: r.nonEmpty, expectedOrders: r.expectedOrders, ordersStatements: r.ordersStatements })),
        nodes: onService.filter((r) => !r.label.startsWith('stats') && !r.err).map((r) => ({ rec: r.rec, label: r.label, nonEmpty: r.nonEmpty, expectedOrders: r.expectedOrders, ordersStatements: r.ordersStatements })) },
    };
    out.handler = { off: offHandler, on: onHandler };
    out.offService = offService;
    out.onService = onService;
    const okOffHandler = offHandler.every((r) => (r.path.includes(`parentId=${sampleOf('rec_mixed').unplaced}`) ? r.status === 404 : r.status === 200 && r.ordersAllNull) && r.ordersStatements === 0);
    const okOnHandler = onHandler.every((r) => (r.path.includes(`parentId=${sampleOf('rec_mixed').unplaced}`) ? r.status === 404 && r.ordersStatements === 0 : r.status === 200 && (r.ordersValues === 0 || r.ordersAnyNonNull)));
    out.verdict = {
      clientOffZero: out.client.off.ordersStatements === 0,
      serverLogOffZero: out.serverLog.off?.linesTouchingOrders === 0 && (out.serverLog.off?.loggedStatements ?? 0) > 0,
      serverLogOnPositive: (out.serverLog.on?.linesTouchingOrders ?? 0) > 0,
      pgssOffZero: out.pgss.off.touchingOrders === 0 && out.pgss.off.networkEntries.length > 0,
      pgssOnPositive: out.pgss.on.touchingOrders > 0,
      onStatsExactlyOne: out.client.on.stats.every((r) => r.ordersStatements === r.expectedOrders),
      onNodesExactlyOne: out.client.on.nodes.every((r) => r.ordersStatements === r.expectedOrders),
      handlerOff: okOffHandler, handlerOn: okOnHandler,
    };
    out.ok = Object.values(out.verdict).every(Boolean);
  } finally {
    if (conn) await conn.close();
    out.drop = await dropDb(clone);
  }
  out.serviceShaEnd = sha256(SERVICE_FILE);
  out.serviceShaStable = out.serviceShaEnd === serviceShaStart;
  out.clonesLeft = await listClones();
  out.finishedAt = new Date().toISOString();
  await appendResult(file, out);
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
try {
  const a = parseArgs(process.argv.slice(2));
  let result;
  if (a.cmd === 'equiv') result = await equiv(a);
  else if (a.cmd === 'log-proof') result = await logProof(a);
  else throw new Error('usage: equiv-network.mjs equiv --scale 1k|10k [--fixture] [--keep-clone] [--reuse] | log-proof');
  const brief = { ...result };
  delete brief.offService;
  delete brief.onService;
  process.stdout.write(`${JSON.stringify(brief, null, 1)}\n`);
  process.exit(0);
} catch (e) {
  process.stderr.write(`equiv-network FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
}
