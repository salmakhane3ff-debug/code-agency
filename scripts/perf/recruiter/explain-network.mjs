/**
 * scripts/perf/recruiter/explain-network.mjs — Phase 6 Part 5b QUERY PLANS of the rewritten network
 * service (diagnostic single EXPLAIN ANALYZE runs, not a benchmark).
 *
 *   node scripts/perf/recruiter/explain-network.mjs --scale 1k|10k [--clone exp_5b_1k]
 *
 * 1. Clones the Part 5a template of that scale (lib.cloneDb, exp_5b_* only) and lists the indexes of
 *    affiliates, recruiter_affiliate_links, identity_verifications and affiliate_orders. If an index
 *    the recursive steps rely on is missing, it records missingIndexStop and runs NO plan (an index
 *    is never created).
 * 2. Calls the NEW service through lib.connect() and captures, at the DRIVER level, the exact SQL text
 *    and bind values of every tagged statement (recruiter-network-path / -page / -unplaced / -stats /
 *    -stats-orders) — a wrapper on the pool's Client class, which is lib's recording client.
 * 3. Runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) and EXPLAIN (ANALYZE, BUFFERS) with the same text and
 *    values (lib.pgQuery, plain pg client, bind parameters) and checks every recursive term: a Nested
 *    Loop over the WorkTable Scan, an Index Scan / Index Only Scan on affiliates_parentId_idx
 *    (downward) or affiliates_pkey (upward), recruiter_affiliate_links_pkey for the membership check,
 *    and NO Seq Scan on affiliates inside the recursive term. Where JIT appears, the same EXPLAIN is
 *    repeated with SET jit = off in that session (diagnostic only).
 * Output: SCRATCH_P5B/results/explain-<scale>.jsonl, text plans in SCRATCH_P5B/logs/. The clone is
 * dropped at the end. Never writes under the Part 5a scratch directory.
 */

import { appendResult, cloneDb, connect, dropDb, importService, listClones, listDatabases, pgQuery } from './lib.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const P5B = '/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5b';
const RESULTS = join(P5B, 'results');
const LOGS = join(P5B, 'logs');
const OWN_CLONE_RE = /^exp_5b_[a-z0-9_]{1,40}$/;
const TABLES = Object.freeze(['affiliates', 'recruiter_affiliate_links', 'identity_verifications', 'affiliate_orders']);
const REQUIRED_INDEXES = Object.freeze(['affiliates_pkey', 'affiliates_parentId_idx', 'recruiter_affiliate_links_pkey']);
const tagOf = (text) => (String(text).match(/\/\* (recruiter-network-[a-z-]+) \*\//) ?? [])[1] ?? null;
const round = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(d)) : null);

function inside(base, name) {
  const p = resolve(base, name);
  if (!p.startsWith(`${base}/`) || p.includes('/scratchpad/p5a/')) throw new Error(`p5b: refusing path ${p}`);
  return p;
}

function parseArgs(argv) {
  const a = { scale: null, clone: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scale') a.scale = argv[(i += 1)];
    else if (argv[i] === '--clone') a.clone = argv[(i += 1)];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!['1k', '10k'].includes(a.scale)) throw new Error('--scale 1k|10k (no 100k in Part 5b)');
  a.clone = a.clone ?? `exp_5b_${a.scale}`;
  if (!OWN_CLONE_RE.test(a.clone)) throw new Error('clone must be exp_5b_*');
  return a;
}

/** Driver-level capture of the text + bind values of tagged statements (wraps lib's recording Client class). */
function captureValues(conn) {
  const C = conn.pool.Client;
  const orig = C.prototype.query;
  const captured = [];
  C.prototype.query = function captureQuery(config, values, callback) {
    if (config && typeof config === 'object' && typeof config.submit !== 'function' && typeof config.text === 'string') {
      const tag = tagOf(config.text);
      if (tag) captured.push({ tag, text: config.text, values: [...(Array.isArray(values) ? values : config.values ?? [])] });
    }
    return orig.call(this, config, values, callback);
  };
  return { captured, restore: () => { C.prototype.query = orig; } };
}

// ── plan analysis ────────────────────────────────────────────────────────────
function children(n) {
  return Array.isArray(n?.Plans) ? n.Plans : [];
}
function flatten(n, out = []) {
  out.push(n);
  for (const c of children(n)) flatten(c, out);
  return out;
}
const isIndexScan = (n) => ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan', 'Bitmap Heap Scan'].includes(n['Node Type']);

function analyze(json, tag) {
  const top = json[0];
  const root = top.Plan;
  const all = flatten(root);
  const unions = all.filter((n) => n['Node Type'] === 'Recursive Union');
  const upward = tag === 'recruiter-network-path';
  const expectedAffIdx = upward ? 'affiliates_pkey' : 'affiliates_parentId_idx';
  const insideRec = new Set();
  const terms = unions.map((u) => {
    const [, rec] = children(u);
    const nodes = rec ? flatten(rec) : [];
    for (const n of nodes) insideRec.add(n);
    const idx = nodes.filter(isIndexScan).map((n) => ({ type: n['Node Type'], index: n['Index Name'] ?? null, relation: n['Relation Name'] ?? null, cond: n['Index Cond'] ?? null, filter: n.Filter ?? null, loops: n['Actual Loops'] ?? null }));
    const seq = nodes.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name']);
    const nestedOverWorkTable = nodes.some((n) => n['Node Type'] === 'Nested Loop' && flatten(n).some((x) => x['Node Type'] === 'WorkTable Scan'));
    const affiliateLookup = idx.some((i) => i.index === expectedAffIdx);
    const linkLookup = idx.some((i) => i.index === 'recruiter_affiliate_links_pkey');
    const hashOrMerge = nodes.filter((n) => ['Hash Join', 'Merge Join', 'Hash'].includes(n['Node Type'])).map((n) => n['Node Type']);
    return {
      cte: u['CTE Name'] ?? null, recursiveTermNodeTypes: [...new Set(nodes.map((n) => n['Node Type']))], nestedLoopOverWorkTable: nestedOverWorkTable,
      affiliatesIndex: expectedAffIdx, affiliatesIndexUsed: affiliateLookup, linksPkeyUsed: linkLookup, seqScans: seq, seqScanOnAffiliates: seq.includes('affiliates'),
      hashOrMergeInsideRecursion: hashOrMerge, indexScans: idx, unionLoops: u['Actual Loops'] ?? null, unionRows: u['Actual Rows'] ?? null,
      ok: nestedOverWorkTable && affiliateLookup && linkLookup && !seq.includes('affiliates'),
    };
  });
  const indexesUsed = [...new Set(all.filter((n) => n['Index Name']).map((n) => n['Index Name']))].sort();
  const seqOutside = [...new Set(all.filter((n) => n['Node Type'] === 'Seq Scan' && !insideRec.has(n)).map((n) => n['Relation Name']))].sort();
  const jit = top.JIT ?? null;
  const gen = jit?.Timing?.Generation;
  return {
    execMs: round(top['Execution Time']), planningMs: round(top['Planning Time']),
    jit: jit ? { functions: jit.Functions, totalMs: round(jit.Timing?.Total), generationMs: round(typeof gen === 'object' ? gen?.Total : gen), inliningMs: round(jit.Timing?.Inlining), optimizationMs: round(jit.Timing?.Optimization), emissionMs: round(jit.Timing?.Emission), options: jit.Options ?? null } : null,
    buffers: { sharedHit: root['Shared Hit Blocks'] ?? null, sharedRead: root['Shared Read Blocks'] ?? null, tempRead: root['Temp Read Blocks'] ?? null, tempWritten: root['Temp Written Blocks'] ?? null,
      planningHit: top.Planning?.['Shared Hit Blocks'] ?? null, planningRead: top.Planning?.['Shared Read Blocks'] ?? null },
    rows: root['Actual Rows'] ?? null, totalCost: root['Total Cost'] ?? null,
    recursiveTerms: terms, indexesUsed, seqScansOutsideRecursion: seqOutside,
    indexedRecursiveLookups: terms.length > 0 && terms.every((t) => t.ok), seqScanOnAffiliatesInsideRecursion: terms.some((t) => t.seqScanOnAffiliates),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  const file = inside(RESULTS, `explain-${a.scale}.jsonl`);
  const template = a.scale === '1k' ? 'p5a_1k' : 'p5a_10k';
  if ((await listDatabases()).includes(a.clone)) throw new Error(`${a.clone} exists`);
  const cloneInfo = await cloneDb(template, a.clone);
  const summary = { kind: 'explain-summary', scale: a.scale, clone: a.clone, cloneInfo, cases: [], startedAt: new Date().toISOString() };
  let conn = null;
  try {
    const indexes = await pgQuery(a.clone, `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1::text[]) ORDER BY 1, 2`, [TABLES]);
    const present = new Set(indexes.map((r) => r.indexname));
    summary.indexes = indexes;
    summary.missingIndexes = REQUIRED_INDEXES.filter((i) => !present.has(i));
    summary.missingIndexStop = summary.missingIndexes.length > 0;
    summary.createdAtType = (await pgQuery(a.clone, `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'affiliates'::regclass AND attname = 'createdAt'`))[0].t;
    summary.settings = Object.fromEntries((await pgQuery(a.clone, `SELECT name, setting FROM pg_settings WHERE name IN ('jit','jit_above_cost','jit_inline_above_cost','jit_optimize_above_cost','random_page_cost','work_mem','shared_buffers','enable_mergejoin','enable_hashjoin','enable_nestloop','enable_memoize')`)).map((r) => [r.name, r.setting]));
    await appendResult(file, { kind: 'explain-header', scale: a.scale, clone: a.clone, indexes, missingIndexes: summary.missingIndexes, createdAtType: summary.createdAtType, settings: summary.settings });
    if (summary.missingIndexStop) return summary;

    const NEW = await importService('recruiterNetworkService');
    conn = await connect(a.clone, { sqlTrace: true, bytes: false, heap: false });
    const cap = captureValues(conn);
    const recs = Object.fromEntries((await pgQuery(a.clone, `SELECT username, id FROM recruiters`)).map((r) => [r.username, r.id]));
    // sample nodes from plain (non-recursive) SQL
    const deepN = a.scale === '1k' ? 1000 : 10000;
    const deepNode = async (depth) => {
      // walk the deep chain from its root in JS (flat rows; no recursive SQL)
      const rows = await pgQuery(a.clone, `SELECT a.id, a."parentId" FROM recruiter_affiliate_links l JOIN affiliates a ON a.id = l."affiliateId" WHERE l."recruiterId" = $1`, [recs.rec_deep]);
      const ids = new Set(rows.map((r) => r.id));
      const kid = new Map(rows.filter((r) => r.parentId && ids.has(r.parentId)).map((r) => [r.parentId, r.id]));
      let id = rows.find((r) => !r.parentId || !ids.has(r.parentId)).id;
      for (let d = 1; d < depth; d += 1) id = kid.get(id);
      return id;
    };
    const mixedPage = await NEW.getNetworkNodes(recs.rec_mixed, { db: conn.prisma, limit: 100 });
    const mixedStats = await NEW.getNetworkStats(recs.rec_mixed, { db: conn.prisma, includeOrders: false });
    // deepest mixed node and largest non-root subtree: from flat rows
    const mixedRows = await pgQuery(a.clone, `SELECT a.id, a."parentId" FROM recruiter_affiliate_links l JOIN affiliates a ON a.id = l."affiliateId" WHERE l."recruiterId" = $1`, [recs.rec_mixed]);
    const mIds = new Set(mixedRows.map((r) => r.id));
    const mKids = new Map();
    for (const r of mixedRows) if (r.parentId && mIds.has(r.parentId)) { if (!mKids.has(r.parentId)) mKids.set(r.parentId, []); mKids.get(r.parentId).push(r.id); }
    const mDepth = new Map();
    let frontier = mixedRows.filter((r) => !r.parentId || !mIds.has(r.parentId)).map((r) => r.id);
    for (let d = 1; frontier.length; d += 1) { const next = []; for (const id of frontier) { mDepth.set(id, d); next.push(...(mKids.get(id) ?? [])); } frontier = next; }
    const size = new Map();
    const order = [...mDepth.keys()].sort((x, y) => mDepth.get(y) - mDepth.get(x));
    for (const id of order) size.set(id, (mKids.get(id) ?? []).reduce((s, k) => s + 1 + size.get(k), 0));
    const deepestMixed = order[0];
    const subtreeMixed = [...mDepth.keys()].filter((id) => mDepth.get(id) > 1).sort((x, y) => size.get(y) - size.get(x))[0];
    const wideRoot = (await NEW.getNetworkNodes(recs.rec_wide, { db: conn.prisma })).nodes[0].id;
    const deepParent = await deepNode(deepN - 1);
    const cases = [
      { name: 'path:mixed-deepest', tag: 'recruiter-network-path', run: () => NEW.getNetworkNodes(recs.rec_mixed, { db: conn.db, parentId: deepestMixed }), note: `parentId at depth ${mDepth.get(deepestMixed)}` },
      { name: `path:deep-depth-${deepN - 1}`, tag: 'recruiter-network-path', run: () => NEW.getNetworkNodes(recs.rec_deep, { db: conn.db, parentId: deepParent }), note: `upward walk of ${deepN - 1} levels` },
      { name: 'page:mixed-roots', tag: 'recruiter-network-page', run: () => NEW.getNetworkNodes(recs.rec_mixed, { db: conn.db }) },
      { name: 'page:wide-root-children', tag: 'recruiter-network-page', run: () => NEW.getNetworkNodes(recs.rec_wide, { db: conn.db, parentId: wideRoot }) },
      { name: 'page:deep-root', tag: 'recruiter-network-page', run: () => NEW.getNetworkNodes(recs.rec_deep, { db: conn.db }), note: `descendant walk of ${deepN - 1} levels` },
      { name: 'unplaced:mixed', tag: 'recruiter-network-unplaced', run: () => NEW.getNetworkNodes(recs.rec_mixed, { db: conn.db, view: 'unplaced' }) },
    ];
    for (const [rec, label] of [['rec_mixed', 'mixed'], ['rec_wide', 'wide'], ['rec_deep', 'deep']]) {
      cases.push({ name: `stats:${label}-whole`, tag: 'recruiter-network-stats', run: () => NEW.getNetworkStats(recs[rec], { db: conn.db, includeOrders: false }) });
      cases.push({ name: `stats-orders:${label}-whole`, tag: 'recruiter-network-stats-orders', run: () => NEW.getNetworkStats(recs[rec], { db: conn.db, includeOrders: true }) });
    }
    cases.push({ name: 'stats:mixed-subtree', tag: 'recruiter-network-stats', run: () => NEW.getNetworkStats(recs.rec_mixed, { db: conn.db, rootId: subtreeMixed, includeOrders: false }), note: `rootId with ${size.get(subtreeMixed)} descendants` });
    cases.push({ name: 'stats-orders:mixed-subtree', tag: 'recruiter-network-stats-orders', run: () => NEW.getNetworkStats(recs.rec_mixed, { db: conn.db, rootId: subtreeMixed, includeOrders: true }), note: `rootId with ${size.get(subtreeMixed)} descendants` });
    summary.samples = { deepestMixed, deepestMixedDepth: mDepth.get(deepestMixed), subtreeMixed, subtreeMixedSize: size.get(subtreeMixed), wideRoot, deepParent, mixedRoots: mixedPage.total, mixedPlaced: mixedStats.totals.affiliates };
    for (const c of cases) {
      cap.captured.length = 0;
      const t0 = performance.now();
      await c.run();
      const serviceMs = performance.now() - t0;
      const stmt = cap.captured.find((s) => s.tag === c.tag);
      if (!stmt) throw new Error(`no ${c.tag} statement captured for ${c.name}`);
      const sql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${stmt.text}`;
      const json = (await pgQuery(a.clone, sql, stmt.values))[0]['QUERY PLAN'];
      const res = analyze(json, c.tag);
      const textRows = await pgQuery(a.clone, `EXPLAIN (ANALYZE, BUFFERS) ${stmt.text}`, stmt.values);
      const textPlan = textRows.map((r) => r['QUERY PLAN']).join('\n');
      const textExec = Number((textPlan.match(/Execution Time: ([0-9.]+) ms/) ?? [])[1]);
      let jitOff = null;
      if (res.jit) {
        const offJson = (await pgQuery(a.clone, sql, stmt.values, { settings: { jit: 'off' } }))[0]['QUERY PLAN'];
        const off = analyze(offJson, c.tag);
        jitOff = { execMs: off.execMs, planningMs: off.planningMs, jit: off.jit, indexedRecursiveLookups: off.indexedRecursiveLookups };
      }
      const planFile = inside(LOGS, `explain-${a.scale}-${c.name.replace(/[^a-z0-9-]+/gi, '_')}.txt`);
      writeFileSync(planFile, `-- ${c.name} (${c.tag}) scale ${a.scale}, clone ${a.clone}\n-- bind values: ${JSON.stringify(stmt.values)}\n${stmt.text}\n\n${textPlan}\n`);
      const row = {
        kind: 'explain', scale: a.scale, case: c.name, tag: c.tag, note: c.note ?? null, values: stmt.values,
        textSha1: createHash('sha1').update(stmt.text).digest('hex').slice(0, 12), serviceCallMs: round(serviceMs),
        ...res, textRunExecMs: Number.isFinite(textExec) ? textExec : null, jitOff, planFile,
      };
      await appendResult(file, row);
      summary.cases.push({ case: c.name, tag: c.tag, execMs: res.execMs, textRunExecMs: row.textRunExecMs, jitMs: res.jit?.totalMs ?? null, jitOffExecMs: jitOff?.execMs ?? null,
        indexedRecursiveLookups: res.indexedRecursiveLookups, seqScanOnAffiliatesInsideRecursion: res.seqScanOnAffiliatesInsideRecursion,
        indexesUsed: res.indexesUsed, seqScansOutsideRecursion: res.seqScansOutsideRecursion, buffers: res.buffers,
        recursiveTerms: res.recursiveTerms.map((t) => ({ cte: t.cte, ok: t.ok, nestedLoopOverWorkTable: t.nestedLoopOverWorkTable, affiliatesIndexUsed: t.affiliatesIndexUsed, linksPkeyUsed: t.linksPkeyUsed, seqScans: t.seqScans, hashOrMerge: t.hashOrMergeInsideRecursion, unionRows: t.unionRows })) });
      process.stderr.write(`[explain ${a.scale}] ${c.name}: exec ${res.execMs} ms, jit ${res.jit?.totalMs ?? '-'} ms, indexed ${res.indexedRecursiveLookups}\n`);
    }
    cap.restore();
  } finally {
    if (conn) await conn.close();
    summary.drop = await dropDb(a.clone);
    summary.clonesLeft = await listClones();
    summary.finishedAt = new Date().toISOString();
    await appendResult(file, summary);
  }
  return summary;
}

try {
  const s = await main();
  process.stdout.write(`${JSON.stringify({ ...s, indexes: s.indexes?.length }, null, 1)}\n`);
  process.exit(0);
} catch (e) {
  process.stderr.write(`explain-network FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
}
