#!/usr/bin/env node
/**
 * scripts/perf/recruiter/ancestry-5c.mjs — VERIFICATION HARNESS of Phase 6 Part 5c: the recruiter
 * ancestry check (assertAncestryInNetwork in src/lib/services/recruiterAffiliateService.js) now runs
 * ONE tagged recursive statement (recruiter-ancestry) instead of 2 queries per ancestor.
 *
 * It drives the REAL public recruiterCreateAffiliate(recruiterId, input, { db }) of
 *   NEW = src/lib/services/recruiterAffiliateService.js (lib.importService)
 *   OLD = the HEAD version copied to P5C/old/recruiterAffiliateService.old.mjs (prisma import stubbed,
 *         the real affiliateActivationService imported by absolute path)
 * through lib.connect() (PrismaPg over a pg.Pool, same instrumentation settings as bench-ancestry:
 * sqlTrace on, bytes / heap off, 2 warm connections) on lib clones of the disposable cluster only.
 * On top of lib's recorder it wraps pg.Client.prototype.query (this process only, pool clients of
 * lib.connect only) to keep, per statement: text, bind values, backend pid, start / end and the first
 * result row — enough to rebuild every transaction (BEGIN … COMMIT / ROLLBACK), the recruiter row
 * lock (its statement and what it read) and the exact ancestry statement for EXPLAIN.
 *
 * Commands (each writes JSONL to P5C/results and plans to P5C/logs):
 *   equiv   --db anc_1k_a          OLD vs NEW verdict + created rows over a case catalog (builds the
 *                                  edge rows first: cycles, self-parent, rho, foreign / unlinked
 *                                  ancestors, dangling and '' parentIds — the last two need the
 *                                  parentId foreign key bypassed: session_replication_role = replica)
 *   explain --db <clone> --depth N EXPLAIN (ANALYZE, BUFFERS) of the captured statement, rec_deep chain
 *   latency --db <clone> --depths a,b --impl old,new [--reps 10] [--warmup 3]
 *   deep10k --db anc_10k_a         NEW only: create at depth 10000, extend, refuse at 10001, cycle
 *   race    --db <clone>           concurrency: same-recruiter parallel creations, permission and
 *                                  disable races driven by the real recruiterService functions
 *
 * SAFETY: lib's guard (disposable cluster only); writes only to its clone and P5C; never touches a
 * template; no repository write.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { appendResult, connect, gc, importService, loadManifest, now, pgQuery, psql, summarize } from './lib.mjs';

const P5C = '/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5c';
const RESULTS = join(P5C, 'results');
const LOGS = join(P5C, 'logs');
const OLD_MODULE = join(P5C, 'old/recruiterAffiliateService.old.mjs');
const PLAN_SETTINGS = { enable_mergejoin: 'off', enable_hashjoin: 'off' };
mkdirSync(RESULTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const log = (...xs) => console.error(new Date().toISOString().slice(11, 19), '[5c]', ...xs);
const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
const summ = (xs) => { const s = summarize(xs); return { n: s.n, min: r3(s.min), p50: r3(s.p50), p95: r3(s.p95), max: r3(s.max), mean: r3(s.mean) }; };
const out = (file, obj) => appendResult(join(RESULTS, file), { at: new Date().toISOString(), ...obj });
const codeOf = (err) => (err ? String(err.code ?? err.name ?? 'ERROR') : 'created');

// ── statement capture (pool clients of lib.connect only) ─────────────────────
const CAP = { on: false, rows: [] };
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function capturedQuery(config, values, callback) {
  if (!CAP.on || this.constructor === pg.Client || config === null || config === undefined || typeof config.submit === 'function') {
    return origQuery.call(this, config, values, callback);
  }
  const text = typeof config === 'string' ? config : config.text;
  const vals = Array.isArray(values) ? values : Array.isArray(config?.values) ? config.values : null;
  const r = { text, values: vals, pid: this.processID, start: now(), end: null, rowCount: null, row0: null, error: null };
  CAP.rows.push(r);
  const fin = (err, res) => {
    r.end = now();
    if (err) r.error = String(err.code ?? err.message);
    else { r.rowCount = res?.rowCount ?? null; r.row0 = res?.rows?.[0] ?? null; }
  };
  if (typeof values === 'function') return origQuery.call(this, config, (e, res) => { fin(e, res); values(e, res); });
  if (typeof callback === 'function') return origQuery.call(this, config, values, (e, res) => { fin(e, res); callback(e, res); });
  return origQuery.call(this, config, values).then((res) => { fin(null, res); return res; }, (e) => { fin(e); throw e; });
};

const BEGIN_RE = /^\s*BEGIN\b/i;
const END_RE = /^\s*(COMMIT|ROLLBACK)\b/i;
const CREATE_LOCK_RE = /SELECT "isActive", "canCreateAffiliates" FROM "recruiters"[\s\S]*FOR NO KEY UPDATE/;
const PERM_LOCK_RE = /SELECT "canViewOrders", "canCreateAffiliates" FROM "recruiters"[\s\S]*FOR NO KEY UPDATE/;
const UPDATE_RECRUITER_RE = /^\s*UPDATE "public"\."recruiters"|^\s*UPDATE "recruiters"/;
const ANCESTRY_TAG = '/* recruiter-ancestry */';
const INSERT_AFFILIATE_RE = /INSERT INTO "public"\."affiliates"/;

/** Transactions (BEGIN … COMMIT/ROLLBACK) per backend, in order. */
function transactions(caps) {
  const byPid = new Map();
  for (const q of caps) { if (!byPid.has(q.pid)) byPid.set(q.pid, []); byPid.get(q.pid).push(q); }
  const txs = [];
  for (const [pid, qs] of byPid) {
    let cur = null;
    for (const q of qs) {
      if (BEGIN_RE.test(q.text)) { cur = { pid, stmts: [q], begin: q, end: null }; txs.push(cur); } else if (cur) {
        cur.stmts.push(q);
        if (END_RE.test(q.text)) { cur.end = q; cur = null; }
      }
    }
  }
  for (const t of txs) {
    t.endedWith = t.end ? (/^\s*COMMIT/i.test(t.end.text) ? 'COMMIT' : 'ROLLBACK') : null;
    t.createLock = t.stmts.find((q) => CREATE_LOCK_RE.test(q.text)) ?? null;
    t.permLock = t.stmts.find((q) => PERM_LOCK_RE.test(q.text)) ?? null;
    t.recruiterUpdate = t.stmts.find((q) => UPDATE_RECRUITER_RE.test(q.text)) ?? null;
    t.insertsAffiliate = t.stmts.some((q) => INSERT_AFFILIATE_RE.test(q.text));
    if (t.createLock) {
      const r = t.createLock.row0;
      t.read = Array.isArray(r) ? { isActive: r[0], canCreateAffiliates: r[1] } : r ? { isActive: r.isActive, canCreateAffiliates: r.canCreateAffiliates } : null;
    }
  }
  return txs.sort((a, b) => a.begin.start - b.begin.start);
}

/** Metrics of one creation transaction. */
function creationMetrics(tx) {
  if (!tx) return null;
  const L = tx.stmts.indexOf(tx.createLock);
  const anc = [];
  if (L >= 0) {
    for (let i = L + 2; i < tx.stmts.length; i += 1) {
      const q = tx.stmts[i];
      if (END_RE.test(q.text) || q.text.includes('"username"')) break;
      anc.push(q);
    }
  }
  const sum = (xs) => xs.reduce((a, q) => a + (q.end - q.start), 0);
  return {
    pid: tx.pid,
    endedWith: tx.endedWith,
    stmtsInTx: tx.stmts.length,
    ancestryStmts: anc.length,
    ancestryTagged: anc.filter((q) => q.text.includes(ANCESTRY_TAG)).length,
    ancestryMs: r3(sum(anc)),
    lockStmtMs: tx.createLock ? r3(tx.createLock.end - tx.createLock.start) : null,
    lockHeldMs: tx.createLock && tx.end ? r3(tx.end.end - tx.createLock.start) : null,
    lockHeldAfterAcquireMs: tx.createLock && tx.end ? r3(tx.end.end - tx.createLock.end) : null,
    txWallMs: tx.end ? r3(tx.end.end - tx.begin.start) : null,
  };
}

async function settle(timeoutMs = 15000) {
  const t0 = now();
  for (;;) {
    const open = new Set();
    let pending = false;
    for (const q of CAP.rows) {
      if (q.end === null) pending = true;
      if (BEGIN_RE.test(q.text)) open.add(q.pid); else if (END_RE.test(q.text)) open.delete(q.pid);
    }
    if (!pending && open.size === 0) return true;
    if (now() - t0 > timeoutMs) return false;
    await sleep(2);
  }
}

// ── setup ────────────────────────────────────────────────────────────────────
const IMPLS = {};
async function loadImpls() {
  IMPLS.new = await importService('recruiterAffiliateService');
  IMPLS.old = await import(OLD_MODULE);
  for (const k of ['old', 'new']) if (IMPLS[k].RECRUITER_AFFILIATE_LIMITS.ANCESTRY_MAX !== 10000) throw new Error(`${k}: ANCESTRY_MAX changed`);
}

const RUN_TAG = Date.now().toString(36).slice(-5);
let SEQ = 0;
const nextUsername = () => { SEQ += 1; return `c5${RUN_TAG}.${String(SEQ).padStart(5, '0')}`; };

function makeInput(parentId, username) {
  const u = username ?? nextUsername();
  return { username: u, name: `Perf Ancestry 5c ${SEQ}`, requestId: randomUUID(), ...(parentId ? { parentId } : {}) };
}

/** One real creation, sequential (the capture window holds only it). */
async function createOne(conn, impl, recruiterId, parentId, { username } = {}) {
  conn.rec.reset();
  gc();
  const input = makeInput(parentId, username);
  CAP.rows = [];
  CAP.on = true;
  const t0 = now();
  let res = null;
  let err = null;
  try { res = await IMPLS[impl].recruiterCreateAffiliate(recruiterId, input, { db: conn.db }); } catch (e) { err = e; }
  const t1 = now();
  const settled = await settle();
  CAP.on = false;
  const caps = CAP.rows;
  CAP.rows = [];
  conn.rec.reset();
  const txs = transactions(caps);
  const tx = txs.find((t) => t.createLock) ?? null;
  return { impl, input, res, err, result: codeOf(err), totalMs: r3(t1 - t0), settled, stmtsTotal: caps.length, txCount: txs.length, m: creationMetrics(tx), caps, tx };
}

async function rowState(db, username) {
  const rows = await pgQuery(db, `SELECT a.id, a."parentId", a."isActive", a.username, a.name, l."recruiterId",
      (SELECT count(*)::int FROM recruiter_audit_log g WHERE g."entityType" = 'affiliate' AND g."entityId" = a.id AND g.action = 'AFFILIATE_CREATED') AS audit_rows,
      (SELECT g.details->>'requestId' FROM recruiter_audit_log g WHERE g."entityType" = 'affiliate' AND g."entityId" = a.id AND g.action = 'AFFILIATE_CREATED' LIMIT 1) AS request_id,
      (SELECT count(*)::int FROM affiliate_activation_codes c WHERE c."affiliateId" = a.id) AS codes
    FROM affiliates a LEFT JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id WHERE a.username = $1`, [username]);
  return rows[0] ?? null;
}

/** Compare the created state against the request; null row when refused. */
function rowCheck(c, row, recruiterId) {
  if (c.result !== 'created') return { ok: row === null, shape: row === null ? 'no-row' : 'ROW-LEFT-BEHIND' };
  const bad = [];
  if (!row) bad.push('missing');
  else {
    if ((row.parentId ?? null) !== (c.input.parentId ?? null)) bad.push('parent');
    if (row.isActive !== false) bad.push('active');
    if (row.recruiterId !== recruiterId) bad.push('link');
    if (row.audit_rows !== 1 || row.request_id !== c.input.requestId) bad.push('audit');
    if (row.codes !== 1) bad.push('codes');
    if (c.res?.row?.id !== row.id || (c.res?.row?.parentId ?? null) !== (row.parentId ?? null)) bad.push('returned-row');
  }
  const networkIds = c.res?.networkIds instanceof Set ? [...c.res.networkIds] : null;
  return { ok: bad.length === 0, bad, shape: { parentId: row?.parentId ?? null, isActive: row?.isActive, linkedTo: row?.recruiterId === recruiterId ? 'self' : row?.recruiterId, auditRows: row?.audit_rows, codes: row?.codes, returnedKeys: Object.keys(c.res?.row ?? {}).sort().join(','), networkIds, replayed: c.res?.replayed, activation: !!c.res?.activation?.code } };
}

async function recruiterIds(db) {
  const rows = await pgQuery(db, 'SELECT id, username FROM recruiters WHERE username IN ($1, $2, $3, $4)', ['rec_mixed', 'rec_wide', 'rec_deep', 'rec_empty']);
  return Object.fromEntries(rows.map((r) => [r.username.replace('rec_', ''), r.id]));
}

/** depth of every placed member (roots = depth 1), per recruiter, computed downward from the roots. */
async function depthTable(db) {
  return pgQuery(db, `WITH RECURSIVE d AS (
      SELECT a.id, 1 AS depth, l."recruiterId" AS rid FROM affiliates a JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id WHERE a."parentId" IS NULL
      UNION ALL
      SELECT a.id, d.depth + 1, d.rid FROM d JOIN affiliates a ON a."parentId" = d.id WHERE d.depth < 200000)
    SELECT d.id, d.depth, d.rid FROM d`, [], { settings: PLAN_SETTINGS });
}

// ── equivalence ──────────────────────────────────────────────────────────────
const EDGE = {
  // id: [recruiter key or null (unlinked), parentId set afterwards ('@self', an id, a template key, 'MISSING', 'EMPTY')]
  'e5c-self': ['mixed', '@self'],
  'e5c-c1': ['mixed', 'e5c-c2'], 'e5c-c2': ['mixed', 'e5c-c3'], 'e5c-c3': ['mixed', 'e5c-c1'],
  'e5c-r1': ['mixed', 'e5c-r2'], 'e5c-r2': ['mixed', 'e5c-c1'],
  'e5c-rs1': ['mixed', 'e5c-self'],
  'e5c-x1': ['mixed', 'e5c-x2'], 'e5c-x2': ['mixed', '#wideRoot'],
  'e5c-m1': ['mixed', 'e5c-wmid'], 'e5c-wmid': ['wide', '#mixedRoot'],
  'e5c-n0': [null, null], 'e5c-y1': ['mixed', 'e5c-y2'], 'e5c-y2': ['mixed', 'e5c-n0'],
  'e5c-y3': ['mixed', 'e5c-n1'], 'e5c-n1': [null, '#mixedRoot'],
  'e5c-d1': ['mixed', 'e5c-d2'], 'e5c-d2': ['mixed', 'MISSING'], 'e5c-d3': ['mixed', 'MISSING'],
  'e5c-z1': ['mixed', 'e5c-z2'], 'e5c-z2': ['mixed', 'EMPTY'], 'e5c-z3': ['mixed', 'EMPTY'],
  'e5c-zf': ['mixed', 'e5c-zw'], 'e5c-zw': ['wide', 'EMPTY'],
};
// A 25-node tail into the 3-cycle (rho with a longer stem).
for (let i = 1; i <= 25; i += 1) EDGE[`e5c-t${i}`] = ['mixed', i < 25 ? `e5c-t${i + 1}` : 'e5c-c2'];

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function setupEdges(db, R, mixedRoot, wideRoot) {
  const ts = "(now() AT TIME ZONE 'UTC')::timestamp(3)";
  const ids = Object.keys(EDGE);
  const affVals = ids.map((id) => `(${lit(id)}, ${lit(id.replace('e5c-', 'e5c.'))}, ${lit(`Edge ${id}`)}, NULL, 'x-not-a-hash', false, NULL, ${ts}, ${ts})`).join(',\n');
  const linkVals = ids.filter((id) => EDGE[id][0]).map((id) => `(${lit(id)}, ${lit(R[EDGE[id][0]])}, ${lit(R[EDGE[id][0]])}, ${ts})`).join(',\n');
  psql(db, `BEGIN;
INSERT INTO affiliates (id, username, name, phone, password, "isActive", "parentId", "createdAt", "updatedAt") VALUES ${affVals};
INSERT INTO recruiter_affiliate_links ("affiliateId", "recruiterId", "createdBy", "createdAt") VALUES ${linkVals};
COMMIT;`);
  const target = (id, p) => (p === '@self' ? id : p === '#wideRoot' ? wideRoot : p === '#mixedRoot' ? mixedRoot : p);
  const normal = ids.filter((id) => EDGE[id][1] && !['MISSING', 'EMPTY'].includes(EDGE[id][1]));
  psql(db, `BEGIN;\n${normal.map((id) => `UPDATE affiliates SET "parentId" = ${lit(target(id, EDGE[id][1]))} WHERE id = ${lit(id)};`).join('\n')}\nCOMMIT;`);
  // Dangling and '' parentIds cannot exist with affiliates_parentId_fkey (not deferrable): the foreign
  // key's RI triggers are skipped for these UPDATEs only (session_replication_role = replica, this
  // session, this clone). They model a database without that constraint (README caveat).
  const bypass = ids.filter((id) => ['MISSING', 'EMPTY'].includes(EDGE[id][1]));
  psql(db, `BEGIN;\nSET LOCAL session_replication_role = replica;\n${bypass.map((id) => `UPDATE affiliates SET "parentId" = ${EDGE[id][1] === 'MISSING' ? "'e5c-missing-node'" : "''"} WHERE id = ${lit(id)};`).join('\n')}\nCOMMIT;`);
  return pgQuery(db, `SELECT a.id, a."parentId", l."recruiterId" FROM affiliates a LEFT JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id WHERE a.id LIKE 'e5c-%' ORDER BY a.id`);
}

async function cmdEquiv(db) {
  const FILE = 'equiv-1k.jsonl';
  const R = await recruiterIds(db);
  const depths = await depthTable(db);
  const byRid = (rid) => depths.filter((d) => d.rid === rid);
  const mixed = byRid(R.mixed);
  const wide = byRid(R.wide);
  const deep = byRid(R.deep);
  const mixedRoot = mixed.filter((d) => d.depth === 1).sort((a, b) => (a.id < b.id ? -1 : 1))[0].id;
  const wideRoot = wide.find((d) => d.depth === 1).id;
  const placedMixed = new Set(mixed.map((d) => d.id));
  const unplaced = (await pgQuery(db, 'SELECT "affiliateId" AS id FROM recruiter_affiliate_links WHERE "recruiterId" = $1 ORDER BY 1', [R.mixed])).map((r) => r.id).filter((id) => !placedMixed.has(id));
  const edges = await setupEdges(db, R, mixedRoot, wideRoot);
  await out(FILE, { kind: 'edges', rows: edges, mixedRoot, wideRoot, unplaced, fkBypass: 'session_replication_role = replica for the MISSING / EMPTY parentId UPDATEs only' });

  const cases = [];
  const add = (group, name, recruiter, parentId, expect) => cases.push({ group, name, recruiter, parentId, expect });
  add('root', 'no parent', 'mixed', null, 'created');
  const firstAt = (rows, dep) => rows.filter((d) => d.depth === dep).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let k = 1; k <= 13; k += 1) for (const n of firstAt(mixed, k).slice(0, 2)) add('mixed', `mixed d${k}`, 'mixed', n.id, 'created');
  const sample = [...mixed].sort((a, b) => (a.id.split('').reverse().join('') < b.id.split('').reverse().join('') ? -1 : 1)).slice(0, 30);
  for (const n of sample) add('mixed', `mixed sample d${n.depth}`, 'mixed', n.id, 'created');
  add('wide', 'wide root d1', 'wide', wideRoot, 'created');
  for (const n of firstAt(wide, 2).slice(0, 6)) add('wide', 'wide child d2', 'wide', n.id, 'created');
  for (const k of [1, 2, 3, 5, 10, 25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950, 999, 1000]) add('deep', `deep d${k}`, 'deep', firstAt(deep, k)[0].id, 'created');
  for (const id of unplaced) add('cycle', 'mixed unplaced 2-cycle member', 'mixed', id, 'PARENT_NOT_IN_NETWORK');
  add('cycle', 'self-parent', 'mixed', 'e5c-self', 'PARENT_NOT_IN_NETWORK');
  add('cycle', 'rho into self-loop', 'mixed', 'e5c-rs1', 'PARENT_NOT_IN_NETWORK');
  add('cycle', '3-cycle member', 'mixed', 'e5c-c1', 'PARENT_NOT_IN_NETWORK');
  add('cycle', 'rho stem 2 into 3-cycle', 'mixed', 'e5c-r1', 'PARENT_NOT_IN_NETWORK');
  add('cycle', 'rho stem 25 into 3-cycle', 'mixed', 'e5c-t1', 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'top ancestor linked to rec_wide', 'mixed', 'e5c-x1', 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'middle ancestor linked to rec_wide', 'mixed', 'e5c-m1', 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'direct parent linked to rec_wide (wide child)', 'mixed', firstAt(wide, 2)[0].id, 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'rec_wide under a rec_mixed node d5', 'wide', firstAt(mixed, 5)[0].id, 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'rec_deep under the mixed root', 'deep', mixedRoot, 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'rec_mixed under deep d1000', 'mixed', firstAt(deep, 1000)[0].id, 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'rec_empty under deep d10', 'empty', firstAt(deep, 10)[0].id, 'PARENT_NOT_IN_NETWORK');
  add('foreign', 'rec_wide under its own node whose parent is rec_mixed root (e5c-wmid)', 'wide', 'e5c-wmid', 'PARENT_NOT_IN_NETWORK');
  add('unlinked', 'top ancestor linked to nobody', 'mixed', 'e5c-y1', 'PARENT_NOT_IN_NETWORK');
  add('unlinked', 'middle ancestor linked to nobody', 'mixed', 'e5c-y3', 'PARENT_NOT_IN_NETWORK');
  add('unlinked', 'direct parent linked to nobody (root)', 'mixed', 'e5c-n0', 'PARENT_NOT_IN_NETWORK');
  add('missing', 'parentId of no affiliate', 'mixed', 'e5c-no-such-affiliate', 'PARENT_NOT_IN_NETWORK');
  add('dangling', 'grandparent dangling parentId', 'mixed', 'e5c-d1', 'PARENT_NOT_IN_NETWORK');
  add('dangling', 'parent with dangling parentId', 'mixed', 'e5c-d3', 'PARENT_NOT_IN_NETWORK');
  add('empty', "ancestor with parentId '' (chain of 2)", 'mixed', 'e5c-z1', 'created');
  add('empty', "parent with parentId ''", 'mixed', 'e5c-z3', 'created');
  add('empty', "foreign-linked ancestor with parentId ''", 'mixed', 'e5c-zf', 'PARENT_NOT_IN_NETWORK');

  const conn = await connect(db, { heap: false, bytes: false, warmConnections: 2 });
  const tally = { cases: 0, agree: 0, matchExpected: 0, rowsOk: 0, discrepancies: [] };
  try {
    for (const c of cases) {
      const rid = R[c.recruiter];
      const side = {};
      for (const impl of ['old', 'new']) {
        const r = await createOne(conn, impl, rid, c.parentId);
        const row = await rowState(db, r.input.username);
        side[impl] = { result: r.result, totalMs: r.totalMs, stmtsTotal: r.stmtsTotal, ...r.m, check: rowCheck(r, row, rid), errMsg: r.err && !r.err.code ? String(r.err.message).slice(0, 200) : undefined };
      }
      const agree = side.old.result === side.new.result;
      const sameShape = JSON.stringify({ ...side.old.check.shape }) === JSON.stringify({ ...side.new.check.shape });
      const rec = { kind: 'case', group: c.group, name: c.name, recruiter: c.recruiter, parentId: c.parentId, expect: c.expect, agree, sameShape, matchExpected: side.new.result === c.expect && side.old.result === c.expect, old: side.old, new: side.new };
      await out(FILE, rec);
      tally.cases += 1;
      if (agree) tally.agree += 1;
      if (rec.matchExpected) tally.matchExpected += 1;
      if (side.old.check.ok && side.new.check.ok && sameShape) tally.rowsOk += 1;
      if (!agree || !rec.matchExpected || !sameShape || !side.old.check.ok || !side.new.check.ok) tally.discrepancies.push({ name: c.name, old: side.old.result, new: side.new.result, oldCheck: side.old.check, newCheck: side.new.check });
      log(`${c.name}: old=${side.old.result} (${side.old.ancestryStmts} anc stmts, lock ${side.old.lockHeldMs} ms) new=${side.new.result} (${side.new.ancestryStmts}, lock ${side.new.lockHeldMs} ms)${agree ? '' : '  <<< DIFFER'}`);
    }
  } finally { await conn.close(); }
  await out(FILE, { kind: 'summary', ...tally });
  console.log(JSON.stringify(tally, null, 1));
}

// ── explain ──────────────────────────────────────────────────────────────────
async function deepAtDepth(db, rid, depthsWanted) {
  const rows = await pgQuery(db, `WITH RECURSIVE d AS (
      SELECT a.id, 1 AS depth FROM affiliates a JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id WHERE a."parentId" IS NULL AND l."recruiterId" = $1
      UNION ALL
      SELECT a.id, d.depth + 1 FROM d JOIN affiliates a ON a."parentId" = d.id)
    SELECT DISTINCT ON (depth) id, depth FROM d WHERE depth = ANY($2::int[]) ORDER BY depth, id`, [rid, depthsWanted], { settings: PLAN_SETTINGS });
  return Object.fromEntries(rows.map((r) => [r.depth, r.id]));
}

async function cmdExplain(db, depth, label) {
  const R = await recruiterIds(db);
  const at = await deepAtDepth(db, R.deep, [depth]);
  const parentId = at[depth];
  const conn = await connect(db, { heap: false, bytes: false, warmConnections: 2 });
  let c;
  try {
    await createOne(conn, 'new', R.deep, parentId); // warm
    c = await createOne(conn, 'new', R.deep, parentId);
  } finally { await conn.close(); }
  const stmt = c.tx.stmts.find((q) => q.text.includes(ANCESTRY_TAG));
  writeFileSync(join(LOGS, `ancestry-stmt-${label}.sql`), `-- binds: ${JSON.stringify(stmt.values)}\n${stmt.text}\n`);
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    const plan = (await pgQuery(db, `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS) ${stmt.text}`, stmt.values)).map((r) => r['QUERY PLAN']).join('\n');
    writeFileSync(join(LOGS, `explain-ancestry-${label}-run${i + 1}.txt`), `${plan}\n`);
    const exec = Number(/Execution Time: ([0-9.]+) ms/.exec(plan)?.[1]);
    const planning = Number(/Planning Time: ([0-9.]+) ms/.exec(plan)?.[1]);
    const jit = /JIT:[\s\S]*?Timing: [^\n]*Total ([0-9.]+) ms/.exec(plan)?.[1] ?? null;
    results.push({
      run: i + 1, executionMs: exec, planningMs: planning, jitTotalMs: jit === null ? null : Number(jit), jitPresent: /JIT:/.test(plan),
      seqScans: (plan.match(/Seq Scan/g) ?? []).length, seqScanAffiliates: (plan.match(/Seq Scan on (public\.)?affiliates/g) ?? []).length,
      idxAffiliatesPkey: (plan.match(/Index (Only )?Scan using affiliates_pkey/g) ?? []).length,
      idxLinksPkey: (plan.match(/Index (Only )?Scan using recruiter_affiliate_links_pkey/g) ?? []).length,
      recursiveUnion: /Recursive Union/.test(plan),
      wtLoops: /WorkTable Scan on up u[^\n]*loops=(\d+)/.exec(plan)?.[1] ?? null,
      sharedHit: plan.match(/Buffers: shared hit=(\d+)/)?.[1] ?? null,
    });
  }
  const rec = { kind: 'explain', label, depth, parentId, serviceResult: c.result, serviceAncestryMs: c.m.ancestryMs, serviceLockHeldMs: c.m.lockHeldMs, stmtText: stmt.text, binds: stmt.values, runs: results };
  await out('explain.jsonl', rec);
  console.log(JSON.stringify({ ...rec, stmtText: undefined }, null, 1));
}

// ── latency ──────────────────────────────────────────────────────────────────
async function resolveParent(db, R, spec) {
  if (spec === 'mixed_d1' || spec === 'mixed_d13') {
    const dep = spec === 'mixed_d1' ? 1 : 13;
    const m = loadManifest(db.includes('10k') ? '10k' : '1k');
    const id = dep === 1 ? m.shapes.mixed.firstNodeAtDepth['1'] : m.shapes.mixed.deepestNode.id;
    return { recruiter: 'mixed', parentId: id, depth: dep === 1 ? 1 : m.shapes.mixed.deepestNode.depth };
  }
  const d = Number(/^deep_d(\d+)$/.exec(spec)[1]);
  const at = await deepAtDepth(db, R.deep, [d]);
  return { recruiter: 'deep', parentId: at[d], depth: d };
}

async function cmdLatency(db, specs, impls, reps, warmup, file) {
  const R = await recruiterIds(db);
  const conn = await connect(db, { heap: false, bytes: false, warmConnections: 2 });
  const summary = [];
  try {
    for (const spec of specs) {
      const p = await resolveParent(db, R, spec);
      const samples = Object.fromEntries(impls.map((k) => [k, []]));
      for (let i = 0; i < warmup + reps; i += 1) {
        for (const impl of impls) {
          const c = await createOne(conn, impl, R[p.recruiter], p.parentId);
          const phase = i < warmup ? 'warmup' : 'measured';
          await out(file, { kind: 'sample', spec, depth: p.depth, impl, phase, rep: i, result: c.result, totalMs: c.totalMs, stmtsTotal: c.stmtsTotal, ...c.m });
          if (phase === 'measured') samples[impl].push(c);
        }
      }
      for (const impl of impls) {
        const xs = samples[impl];
        const s = {
          kind: 'summary', spec, depth: p.depth, impl, results: [...new Set(xs.map((x) => x.result))],
          lockHeldMs: summ(xs.map((x) => x.m?.lockHeldMs)), totalMs: summ(xs.map((x) => x.totalMs)), txWallMs: summ(xs.map((x) => x.m?.txWallMs)),
          ancestryMs: summ(xs.map((x) => x.m?.ancestryMs)), lockStmtMs: summ(xs.map((x) => x.m?.lockStmtMs)),
          stmtsTotal: [...new Set(xs.map((x) => x.stmtsTotal))], stmtsInTx: [...new Set(xs.map((x) => x.m?.stmtsInTx))], ancestryStmts: [...new Set(xs.map((x) => x.m?.ancestryStmts))],
        };
        summary.push(s);
        await out(file, s);
        log(`${spec} ${impl}: ${s.results} lock p50 ${s.lockHeldMs.p50} ms (min ${s.lockHeldMs.min} max ${s.lockHeldMs.max}) total p50 ${s.totalMs.p50} ms stmts ${s.stmtsTotal} anc ${s.ancestryStmts}`);
      }
    }
  } finally { await conn.close(); }
  console.log(JSON.stringify(summary.map((s) => ({ spec: s.spec, impl: s.impl, results: s.results, lockP50: s.lockHeldMs.p50, lockMin: s.lockHeldMs.min, lockMax: s.lockHeldMs.max, lockP95: s.lockHeldMs.p95, totalP50: s.totalMs.p50, totalP95: s.totalMs.p95, ancP50: s.ancestryMs.p50, stmts: s.stmtsTotal, anc: s.ancestryStmts })), null, 1));
}

// ── 10k deep: limit ──────────────────────────────────────────────────────────
async function chainDepthOf(db, id) {
  const [r] = await pgQuery(db, `WITH RECURSIVE up AS (
      SELECT a.id, a."parentId", 1 AS k FROM affiliates a WHERE a.id = $1
      UNION ALL SELECT a.id, a."parentId", up.k + 1 FROM up JOIN affiliates a ON a.id = up."parentId" WHERE up.k < 20000)
    SELECT count(*)::int AS nodes, bool_or(up."parentId" IS NULL) AS reaches_root FROM up`, [id], { settings: PLAN_SETTINGS });
  return r;
}

async function cmdDeep10k(db) {
  const FILE = 'deep-10k.jsonl';
  const R = await recruiterIds(db);
  const at = await deepAtDepth(db, R.deep, [1, 5000, 9999, 10000]);
  const m = loadManifest('10k');
  const cycleId = m.shapes.mixed.unplacedIds[0];
  const conn = await connect(db, { heap: false, bytes: false, warmConnections: 2 });
  const rows = [];
  const rec = async (name, r, extra = {}) => {
    const x = { kind: 'functional', name, result: r.result, totalMs: r.totalMs, stmtsTotal: r.stmtsTotal, ...r.m, createdId: r.res?.row?.id ?? null, ...extra };
    rows.push(x);
    await out(FILE, x);
    log(`${name}: ${x.result} lock ${x.lockHeldMs} ms anc ${x.ancestryMs} ms stmts ${x.stmtsTotal}`);
    return x;
  };
  try {
    const d10000 = await chainDepthOf(db, at[10000]);
    const c1 = await createOne(conn, 'new', R.deep, at[10000]);
    const x1 = await rec('create under depth 10000 (NEW)', c1, { parentDepthVerified: d10000 });
    const ext = x1.createdId;
    const extDepth = ext ? await chainDepthOf(db, ext) : null;
    await out(FILE, { kind: 'extension', id: ext, depth: extDepth, note: 'the node created above extends the chain to 10001 nodes' });
    if (ext) {
      for (let i = 0; i < 3; i += 1) await rec(`create under depth 10001 (NEW) #${i + 1}`, await createOne(conn, 'new', R.deep, ext), { expect: 'PARENT_NOT_IN_NETWORK' });
    }
    for (let i = 0; i < 3; i += 1) await rec(`create under depth 10000 again (NEW) #${i + 1}`, await createOne(conn, 'new', R.deep, at[10000]), { expect: 'created' });
    for (let i = 0; i < 3; i += 1) await rec(`create under mixed 2-cycle member (NEW, walks to the cap) #${i + 1}`, await createOne(conn, 'new', R.mixed, cycleId), { expect: 'PARENT_NOT_IN_NETWORK' });
    const ok = rows.every((x) => !x.expect || x.result === x.expect) && x1.result === 'created' && extDepth?.nodes === 10001;
    await out(FILE, { kind: 'summary', ok, extDepth, parentAt10000: at[10000] });
    console.log(JSON.stringify({ ok, d10000, extDepth, rows: rows.map((x) => ({ name: x.name, result: x.result, lockHeldMs: x.lockHeldMs, ancestryMs: x.ancestryMs, totalMs: x.totalMs, stmtsTotal: x.stmtsTotal, ancestryStmts: x.ancestryStmts })) }, null, 1));
  } finally { await conn.close(); }
}

// ── concurrency ──────────────────────────────────────────────────────────────
async function linkCount(db, rid) {
  return (await pgQuery(db, 'SELECT count(*)::int AS n FROM recruiter_affiliate_links WHERE "recruiterId" = $1', [rid]))[0].n;
}

async function waiters(db) {
  return pgQuery(db, `SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiters, count(*) FILTER (WHERE state = 'active')::int AS active
    FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db]);
}

/** Launch creations (array of { parentId, username }) concurrently; optional admin action after delayMs. */
async function race(conn, recruiterId, items, admin = null) {
  conn.rec.reset();
  CAP.rows = [];
  CAP.on = true;
  const t0 = now();
  const launch = (it, wave = 1) => {
    const input = makeInput(it.parentId, it.username);
    const r = { input, wave, parentId: it.parentId ?? null, res: null, err: null, t0: now(), t1: null };
    r.p = IMPLS.new.recruiterCreateAffiliate(recruiterId, input, { db: conn.db }).then((v) => { r.res = v; r.t1 = now(); }, (e) => { r.err = e; r.t1 = now(); });
    return r;
  };
  const runs = items.map((it) => launch(it));
  let adminRun = null;
  let snapshot = null;
  // Wait for the k-th recruiter-lock acquisition by a creation (bcrypt hashing before the
  // transaction would otherwise decide the order alone), then optionally a further delay.
  const locksAcquired = async (k) => {
    const t = now();
    while (CAP.rows.filter((q) => q.end !== null && CREATE_LOCK_RE.test(q.text)).length < k && now() - t < 20000) await sleep(0.5);
  };
  if (admin) {
    adminRun = { res: null, err: null, tStart: null, tEnd: null };
    adminRun.p = locksAcquired(admin.afterLocks).then(() => sleep(admin.delayMs)).then(async () => {
      adminRun.tStart = now();
      // wave 2: creations started together with the admin call (they reach the lock behind it)
      const wave2 = (admin.wave2 ?? []).map((it) => launch(it, 2));
      runs.push(...wave2);
      try { adminRun.res = await admin.fn(); } catch (e) { adminRun.err = e; }
      adminRun.tEnd = now();
      await Promise.all(wave2.map((r) => r.p));
    });
  }
  const snap = locksAcquired(1).then(() => sleep(admin?.snapshotMs ?? 2)).then(async () => { snapshot = (await waiters(conn.database))[0]; });
  await Promise.all([...runs.map((r) => r.p), adminRun?.p, snap]);
  await settle();
  CAP.on = false;
  const caps = CAP.rows;
  CAP.rows = [];
  conn.rec.reset();
  return { runs, adminRun, caps, txs: transactions(caps), wallMs: now() - t0, snapshot };
}

function serialization(txs) {
  const held = txs.filter((t) => t.createLock && t.end).map((t) => ({ a: t.createLock.end, b: t.end.end })).sort((x, y) => x.a - y.a);
  let minGap = Infinity;
  for (let i = 1; i < held.length; i += 1) minGap = Math.min(minGap, held[i].a - held[i - 1].b);
  return { holders: held.length, minGapMs: held.length > 1 ? r3(minGap) : null, overlapping: held.length > 1 && minGap < -1 };
}

async function cmdRace(db) {
  const FILE = 'race.jsonl';
  const R = await recruiterIds(db);
  const scale = db.includes('10k') ? '10k' : '1k';
  const m = loadManifest(scale);
  const dep = await deepAtDepth(db, R.deep, [1, 2, 1000, scale === '10k' ? 5000 : 500, scale === '10k' ? 10000 : 1000]);
  const deepMax = scale === '10k' ? 10000 : 1000;
  const deepMid = scale === '10k' ? 5000 : 500;
  const { adminSetRecruiterPermissions, adminSetRecruiterActive } = await importService('recruiterService');
  const conn = await connect(db, { heap: false, bytes: false, warmConnections: 10 });
  const report = { a: [], b: [], c: [] };
  try {
    // (a) same recruiter, deep + shallow parents, one duplicated username, one refused parent
    for (let round = 1; round <= 3; round += 1) {
      const before = await linkCount(db, R.deep);
      const dup = nextUsername();
      const items = [
        { parentId: dep[deepMax] }, { parentId: dep[1] }, { parentId: dep[deepMid] }, { parentId: dep[deepMax], username: dup },
        { parentId: dep[2], username: dup }, { parentId: dep[1000] }, { parentId: null }, { parentId: m.shapes.mixed.unplacedIds[0] },
      ];
      const r = await race(conn, R.deep, items);
      const after = await linkCount(db, R.deep);
      const results = r.runs.map((x) => codeOf(x.err));
      const created = r.runs.filter((x) => !x.err);
      const usernames = created.map((x) => x.res.row.username);
      const dupRows = (await pgQuery(db, 'SELECT count(*)::int AS n FROM affiliates WHERE username = $1', [dup]))[0].n;
      const verified = [];
      for (const x of created) verified.push(rowCheck({ result: 'created', input: x.input, res: x.res }, await rowState(db, x.input.username), R.deep).ok);
      const ser = serialization(r.txs);
      const creationTxs = r.txs.filter((t) => t.createLock);
      const expectedResults = ['created', 'created', 'created', 'created|USERNAME_TAKEN', 'created|USERNAME_TAKEN', 'created', 'created', 'PARENT_NOT_IN_NETWORK'];
      const okResults = results.every((x, i) => expectedResults[i].split('|').includes(x)) && results.filter((x) => x === 'USERNAME_TAKEN').length === 1;
      const x = {
        kind: 'race-a', round, results, linkDelta: after - before, created: created.length, dupRows, uniqueUsernames: new Set(usernames).size === usernames.length,
        rowsVerified: verified.every(Boolean), serialization: ser, creationTxs: creationTxs.length, commits: creationTxs.filter((t) => t.endedWith === 'COMMIT').length,
        lockHeldMs: creationTxs.map((t) => r3(t.end.end - t.createLock.start)), lockWaitMs: creationTxs.map((t) => r3(t.createLock.end - t.createLock.start)),
        snapshot: r.snapshot, wallMs: r3(r.wallMs),
        ok: okResults && after - before === created.length && dupRows === 1 && verified.every(Boolean) && !ser.overlapping && creationTxs.length === items.length,
      };
      report.a.push(x);
      await out(FILE, x);
      log(`race-a #${round}: ${results.join(',')} linkDelta ${x.linkDelta} minGap ${ser.minGapMs} ok=${x.ok}`);
    }

    // (b) permission revoked while creations race; (c) recruiter disabled while creations race
    const deepestMixed = m.shapes.mixed.deepestNode.id;
    const firstMixed = m.shapes.mixed.firstNodeAtDepth['1'];
    // [afterLocks, delayMs]: the admin call starts once that many creations hold / held the lock.
    const plan = [[0, 0], [1, 0], [2, 0], [3, 5], [5, 0], [7, 0]];
    const wideRoot = m.shapes.wide.wideRoot.id;
    const configs = [];
    for (const [part, rid] of [['b', R.mixed], ['c', R.wide]]) {
      const parents = part === 'b' ? [deepestMixed, firstMixed, null] : [wideRoot, m.shapes.wide.wideRoot.firstChildId, null];
      for (const [afterLocks, delayMs] of plan) configs.push({ part, rid, afterLocks, delayMs, items: Array.from({ length: 8 }, (_, k) => ({ parentId: parents[k % 3] })), wave2: [] });
    }
    // Long holders (rec_deep, depth 10000 / 5000): 7 creations queue on the lock, the admin call
    // starts after the 1st acquisition, and 1-2 more creations start WITH it (behind it in the queue).
    for (const part of ['b', 'c']) {
      for (const n2 of [1, 2]) {
        configs.push({ part, rid: R.deep, afterLocks: 1, delayMs: 0, items: Array.from({ length: 7 }, (_, k) => ({ parentId: k % 2 ? dep[deepMid] : dep[deepMax] })), wave2: Array.from({ length: n2 }, () => ({ parentId: dep[1] })) });
      }
    }
    for (const [i, cfg] of configs.entries()) {
      const { part, rid, afterLocks, delayMs, items } = cfg;
      {
        const before = await linkCount(db, rid);
        const fn = part === 'b'
          ? () => adminSetRecruiterPermissions(rid, { canCreateAffiliates: false }, { db: conn.db, actorId: 'admin-p5c' })
          : () => adminSetRecruiterActive(rid, false, { db: conn.db, actorId: 'admin-p5c', reason: 'p5c race' });
        const r = await race(conn, rid, items, { afterLocks, delayMs, fn, snapshotMs: 1, wave2: cfg.wave2 });
        const after = await linkCount(db, rid);
        const results = r.runs.map((x) => codeOf(x.err));
        const refusal = part === 'b' ? 'FORBIDDEN' : 'RECRUITER_DISABLED';
        const flag = part === 'b' ? 'canCreateAffiliates' : 'isActive';
        const adminTx = r.txs.find((t) => (part === 'b' ? t.permLock : t.recruiterUpdate)) ?? null;
        const adminAcq = adminTx ? (part === 'b' ? adminTx.permLock.end : adminTx.recruiterUpdate.end) : null;
        const adminCommitEnd = adminTx?.end?.end ?? null;
        const ctxs = r.txs.filter((t) => t.createLock);
        const readFalse = ctxs.filter((t) => t.read?.[flag] === false);
        const violations = [];
        for (const t of ctxs) {
          const readOff = t.read?.[flag] === false;
          if (readOff && (t.endedWith !== 'ROLLBACK' || t.insertsAffiliate)) violations.push({ pid: t.pid, why: 'read off but wrote / committed' });
          if (!readOff && adminCommitEnd !== null && t.createLock.end > adminCommitEnd + 1) violations.push({ pid: t.pid, why: 'acquired after the admin commit but read on' });
          if (!readOff && t.endedWith === 'COMMIT' && adminAcq !== null && t.end.end > adminAcq + 1) violations.push({ pid: t.pid, why: 'committed after the admin acquired the row' });
          if (readOff && adminTx && t.createLock.end < adminTx.begin.start) violations.push({ pid: t.pid, why: 'read off before the admin started' });
        }
        const created = r.runs.filter((x) => !x.err);
        const x = {
          kind: `race-${part}`, round: i + 1, recruiter: rid === R.deep ? 'deep' : part === 'b' ? 'mixed' : 'wide', afterLocks, delayMs, wave2: cfg.wave2.length, wave2Results: r.runs.filter((x) => x.wave === 2).map((x) => codeOf(x.err)), results, admin: { result: r.adminRun.err ? codeOf(r.adminRun.err) : 'ok', changed: r.adminRun.res?.changed ?? null, acquiredAtMs: adminAcq === null ? null : r3(adminAcq - r.txs[0].begin.start), lockWaitMs: adminTx ? r3(adminAcq - (part === 'b' ? adminTx.permLock.start : adminTx.recruiterUpdate.start)) : null },
          refusals: results.filter((x) => x === refusal).length, readOff: readFalse.length, created: created.length, linkDelta: after - before,
          before: ctxs.filter((t) => t.read?.[flag] === true).length, violations,
          // per creation tx, relative to the admin COMMIT end (ms; negative = before it): lock statement issued / granted, read flag, outcome
          timeline: adminCommitEnd === null ? null : ctxs.map((t) => ({ issued: r3(t.createLock.start - adminCommitEnd), granted: r3(t.createLock.end - adminCommitEnd), read: t.read?.[flag], ended: t.endedWith })).sort((p, q) => p.granted - q.granted), snapshot: r.snapshot, serialization: serialization(r.txs),
          otherErrors: results.filter((x) => x !== 'created' && x !== refusal),
        };
        x.ok = violations.length === 0 && x.refusals === x.readOff && x.created + x.refusals === items.length + cfg.wave2.length && x.linkDelta === x.created && !!adminTx && x.admin.result === 'ok';
        report[part].push(x);
        await out(FILE, x);
        log(`race-${part} after ${afterLocks} locks +${delayMs} ms: created ${x.created} ${refusal} ${x.refusals} readOff ${x.readOff} violations ${violations.length} ok=${x.ok}`);
        // restore (real service functions as well)
        if (part === 'b') await adminSetRecruiterPermissions(rid, { canCreateAffiliates: true }, { db: conn.db, actorId: 'admin-p5c' });
        else await adminSetRecruiterActive(rid, true, { db: conn.db, actorId: 'admin-p5c' });
      }
    }
  } finally { await conn.close(); }
  const ok = [...report.a, ...report.b, ...report.c].every((x) => x.ok);
  await out(FILE, { kind: 'summary', ok, a: report.a.map((x) => x.ok), b: report.b.map((x) => x.ok), c: report.c.map((x) => x.ok) });
  console.log(JSON.stringify({ ok, report }, null, 1));
}

// ── main ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i += 1; } else o._.push(argv[i]);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  const db = o.db;
  if (!db || !/^(anc|val)_/.test(db)) throw new Error('--db anc_* | val_* clone required');
  await loadImpls();
  if (cmd === 'equiv') await cmdEquiv(db);
  else if (cmd === 'explain') await cmdExplain(db, Number(o.depth), o.label ?? `d${o.depth}`);
  else if (cmd === 'latency') {
    await cmdLatency(db, o.specs.split(','), (o.impl ?? 'old,new').split(','), Number(o.reps ?? 10), Number(o.warmup ?? 3), o.out ?? 'latency.jsonl');
  } else if (cmd === 'deep10k') await cmdDeep10k(db);
  else if (cmd === 'race') await cmdRace(db);
  else throw new Error(`unknown command ${cmd}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
