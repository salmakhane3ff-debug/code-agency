/**
 * scripts/perf/recruiter/reconcile-5d.mjs — VERIFICATION HARNESS of Phase 6 Part 5d (batched
 * reconcileRecruiterRewards: one candidate statement per keyset batch, try-lock lease for full-scope
 * runs, one admin batch per request with a cursor). It observes the application code and changes
 * nothing in it: the NEW code is imported from src/, the OLD (HEAD) reconcile from a scratch copy
 * (p5d/old/recruiterRewardService.old.mjs, its prisma import stubbed) and an old wallet handler copy
 * that imports it.
 *
 * Subcommands (one per process; node --expose-gc):
 *   prep-old                                 write the old module copies (scratch only)
 *   equiv     --scale 1k|10k --impl old|admin|wallet   scenario S0..S3 on a fresh clone, dump rows
 *   equiv-compare --scale 1k|10k             compare the three dumps
 *   boundary                                 1k: 999 / 1000 / 1001 scanned (cursor and batchSize)
 *   batching  --scale 10k                    full-scope batches: continuation, retry, restart
 *   concurrency --scale 10k                  lease, wallet + admin, order changes, payments, injected errors
 *   explain   --scale 10k                    EXPLAIN (ANALYZE, BUFFERS) of the captured candidate statement
 *   bench-full --scale 1k|10k [--reps N]     full-scope reconcile OLD vs NEW (steady, with candidates)
 *   bench-wallet --scale 1k|10k [--reps N]   wallet GET OLD vs NEW for rec_mixed / rec_wide / rec_deep
 *   cleanup                                  drop this harness's clones, report advisory locks
 *
 * SAFETY: every connection goes through lib.mjs (disposable cluster /tmp/p5a-pg/sock:55510 only);
 * clones only (prefix rec_5d_), at most 2 alive (lib.cloneDb); templates never connected to.
 * Output only under the p5d scratch directory (results/*.jsonl|json, logs/).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  PG_LOG, REPO, assertDisposableUrl, appendResult, cloneDb, connect, dbUrl, dropDb, gc, listClones, loadManifest, now, pgQuery,
  summarize, TEMPLATES,
} from './lib.mjs';

const P5D = '/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5d';
const RES = join(P5D, 'results');
const LOGS = join(P5D, 'logs');
const OLD = join(P5D, 'old');
for (const d of [RES, LOGS, OLD]) mkdirSync(d, { recursive: true });
const MARK = 'recruiter-reward-candidates';
const LEASE_KEY_SQL = "hashtext('recruiter-reward-reconcile')";
const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = (name, obj) => appendResult(join(RES, name), obj);
const log = (...a) => console.error(new Date().toISOString(), ...a);

// ── module loading ───────────────────────────────────────────────────────────
function prepOld() {
  const svc = readFileSync(join(OLD, 'recruiterRewardService.HEAD.js'), 'utf8')
    .replace("import prisma from '../prisma.js';", 'const prisma = null; // p5d: stubbed (every call passes db)')
    .replace("from '../recruiterSettings.js'", `from '${REPO}/src/lib/recruiterSettings.js'`);
  if (svc.includes("'../prisma.js'") || !svc.includes(`${REPO}/src/lib/recruiterSettings.js`)) throw new Error('old service rewrite failed');
  writeFileSync(join(OLD, 'recruiterRewardService.old.mjs'), svc);
  let w = readFileSync(join(REPO, 'src/lib/recruiterWalletRouteHandlers.js'), 'utf8');
  w = w.replace("import prisma from './prisma.js';", 'const prisma = null; // p5d: stubbed')
    .replace("from './services/recruiterRewardService.js'", "from './recruiterRewardService.old.mjs'")
    .replace(/from '\.\/(services\/)?([A-Za-z]+)\.js'/g, (_m, s, n) => `from '${REPO}/src/lib/${s ?? ''}${n}.js'`);
  if (!w.includes("'./recruiterRewardService.old.mjs'")) throw new Error('old wallet rewrite failed');
  writeFileSync(join(OLD, 'recruiterWalletRouteHandlers.old.mjs'), w);
  return { svc: join(OLD, 'recruiterRewardService.old.mjs'), wallet: join(OLD, 'recruiterWalletRouteHandlers.old.mjs') };
}
async function loadMods() {
  if (!existsSync(join(OLD, 'recruiterRewardService.old.mjs'))) prepOld();
  return {
    oldSvc: await import(join(OLD, 'recruiterRewardService.old.mjs')),
    oldWallet: await import(join(OLD, 'recruiterWalletRouteHandlers.old.mjs')),
    newSvc: await import(join(REPO, 'src/lib/services/recruiterRewardService.js')),
    newWallet: await import(join(REPO, 'src/lib/recruiterWalletRouteHandlers.js')),
    adminH: await import(join(REPO, 'src/lib/recruiterRewardAdminHandlers.js')),
    walletSvc: await import(join(REPO, 'src/lib/services/recruiterWalletService.js')),
    hooks: await import(join(REPO, 'src/lib/recruiterRewardHooks.js')),
  };
}

// ── admin (unmeasured) connection ────────────────────────────────────────────
async function adminClient(db) {
  const url = dbUrl(db);
  assertDisposableUrl(url);
  const c = new pg.Client({ connectionString: url, application_name: 'p5d-admin' });
  await c.connect();
  return { c, pid: c.processID, q: async (s, p = []) => (await c.query(s, p)).rows, end: () => c.end() };
}

// ── tap: candidate statement binds/results, synced ids, ledger writes, error injection ──
function tap(db, t) {
  Object.assign(t, { cand: t.cand ?? [], syncs: t.syncs ?? [], writes: t.writes ?? [], batch: t.batch ?? -1 });
  const wrapDelegate = (d, model) => new Proxy(d, {
    get(tg, p) {
      const f = Reflect.get(tg, p, tg);
      if (model === 'link' && p === 'findUnique') return (a) => { t.syncs.push({ id: a?.where?.affiliateId ?? null, batch: t.batch, t: now() }); return f.call(tg, a); };
      if (model === 'ledger' && p === 'create') {
        return (a) => {
          if (t.injectLedgerCreate) { t.injectLedgerCreate = false; throw Object.assign(new Error('P5D_INJECTED_SYNC_ERROR'), { code: 'P5D_INJECTED' }); }
          t.writes.push({ id: a?.data?.affiliateId ?? null, type: a?.data?.type ?? null, batch: t.batch });
          return f.call(tg, a);
        };
      }
      return typeof f === 'function' ? f.bind(tg) : f;
    },
  });
  const wrapTx = (tx) => new Proxy(tx, {
    get(tg, p) {
      const v = Reflect.get(tg, p, tg);
      if (p === 'recruiterAffiliateLink') return wrapDelegate(v, 'link');
      if (p === 'recruiterRewardLedger') return wrapDelegate(v, 'ledger');
      return typeof v === 'function' ? v.bind(tg) : v;
    },
  });
  return new Proxy(db, {
    get(tg, p) {
      const v = Reflect.get(tg, p, tg);
      if (p === '$queryRaw') {
        return (strings, ...vals) => {
          const isCand = Array.isArray(strings) && strings.join('').includes(MARK);
          if (!isCand) return v(strings, ...vals);
          const k = t.cand.length;
          const rec = { k, vals, start: now(), end: null, scanned: null, last: null, reversals: [], awards: [] };
          t.cand.push(rec);
          if (t.injectCandidateAt === k) return Promise.reject(Object.assign(new Error('P5D_INJECTED_CANDIDATE_ERROR'), { code: 'P5D_INJECTED' }));
          return Promise.resolve(v(strings, ...vals)).then((rows) => {
            rec.end = now();
            for (const r of rows) {
              if (r.kind === 'batch') { rec.scanned = Number(r.n); rec.last = r.id; } else if (r.kind === 'reversal') rec.reversals.push(r.id); else if (r.kind === 'award') rec.awards.push(r.id);
            }
            t.batch = k;
            return rows;
          });
        };
      }
      if (p === '$transaction') return (a, o) => (typeof a === 'function' ? v((tx) => a(wrapTx(tx)), o) : v(a, o));
      return v;
    },
  });
}

// ── state, rows, invariants, stats ───────────────────────────────────────────
async function seqMarks(admin) {
  const [r] = await admin.q('SELECT COALESCE((SELECT max(seq) FROM recruiter_reward_ledger),0)::text AS l, COALESCE((SELECT max(seq) FROM recruiter_audit_log),0)::text AS a');
  return { ledger: r.l, audit: r.a };
}
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => !/(At|time|Time|timestamp)$/.test(k)).map((k) => [k, sortKeys(v[k])])) : v);
async function newRows(admin, marks) {
  const ledger = await admin.q(`SELECT "affiliateId", type, cycle, "amountCents", "settingsVersion", "idempotencyKey", "recruiterId", "actorType", reason
    FROM recruiter_reward_ledger WHERE seq > $1::bigint ORDER BY "idempotencyKey"`, [marks.ledger]);
  const audit = await admin.q(`SELECT action, "entityType", "entityId", "recruiterId", "actorType", "actorId", details
    FROM recruiter_audit_log WHERE seq > $1::bigint`, [marks.audit]);
  return {
    ledger: ledger.map((r) => JSON.stringify(sortKeys(r))).sort(),
    audit: audit.map((r) => JSON.stringify(sortKeys(r))).sort(),
  };
}
async function invariants(admin) {
  const rows = await admin.q(`WITH c AS (
      SELECT "affiliateId" a, cycle,
        count(*) FILTER (WHERE type='RECRUIT_REWARD') nr, count(*) FILTER (WHERE type='REVERSAL') nv,
        sum("amountCents") FILTER (WHERE type='RECRUIT_REWARD') ra, sum("amountCents") FILTER (WHERE type='REVERSAL') va,
        min("settingsVersion") FILTER (WHERE type='RECRUIT_REWARD') rver, min("settingsVersion") FILTER (WHERE type='REVERSAL') vver,
        count(DISTINCT "recruiterId") nrec
      FROM recruiter_reward_ledger WHERE type IN ('RECRUIT_REWARD','REVERSAL') GROUP BY 1,2)
    SELECT count(*)::int AS cycles,
      count(*) FILTER (WHERE nr > 1)::int AS dup_rewards,
      count(*) FILTER (WHERE nv > 1)::int AS dup_reversals,
      count(*) FILTER (WHERE nv >= 1 AND nr = 0)::int AS reversal_without_reward,
      count(*) FILTER (WHERE COALESCE(ra,0) + COALESCE(va,0) < 0)::int AS reversal_exceeds_reward,
      count(*) FILTER (WHERE nv = 1 AND va <> -ra)::int AS reversal_ne_minus_reward,
      count(*) FILTER (WHERE nv = 1 AND vver IS DISTINCT FROM rver)::int AS reversal_version_mismatch,
      count(*) FILTER (WHERE nrec > 1)::int AS cycle_two_recruiters
    FROM c`);
  const [open] = await admin.q(`WITH s AS (SELECT "affiliateId" a,
      max(cycle) FILTER (WHERE type='RECRUIT_REWARD') rc, max(cycle) FILTER (WHERE type='REVERSAL') vc,
      count(*) FILTER (WHERE type='RECRUIT_REWARD') nr, count(*) FILTER (WHERE type='REVERSAL') nv
      FROM recruiter_reward_ledger WHERE type IN ('RECRUIT_REWARD','REVERSAL') GROUP BY 1)
    SELECT count(*) FILTER (WHERE nr - nv > 1 OR nr - nv < 0)::int AS bad_open_count,
           count(*) FILTER (WHERE nr - nv = 1 AND rc <= COALESCE(vc,0))::int AS open_not_latest FROM s`);
  const [dupKeys] = await admin.q('SELECT count(*)::int AS n FROM (SELECT "idempotencyKey" FROM recruiter_reward_ledger GROUP BY 1 HAVING count(*) > 1) x');
  const r = { ...rows[0], ...open, dup_idempotency_keys: dupKeys.n };
  r.ok = Object.entries(r).every(([k, v]) => k === 'cycles' || v === 0);
  return r;
}
async function tableStats(admin) {
  const rows = await admin.q(`SELECT relname, n_tup_ins::bigint::text AS ins, n_tup_upd::bigint::text AS upd, n_tup_del::bigint::text AS del, n_tup_hot_upd::bigint::text AS hot
    FROM pg_stat_user_tables WHERE relname IN ('recruiter_reward_ledger','recruiter_audit_log') ORDER BY 1`);
  return Object.fromEntries(rows.map((r) => [r.relname, { ins: Number(r.ins), upd: Number(r.upd), del: Number(r.del) }]));
}
const statsDelta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, { ins: b[k].ins - a[k].ins, upd: b[k].upd - a[k].upd, del: b[k].del - a[k].del }]));
async function deadlocks(db) {
  const [r] = await pgQuery('postgres', 'SELECT deadlocks::bigint::text AS d, xact_rollback::bigint::text AS rb FROM pg_stat_database WHERE datname = $1', [db]);
  return { deadlocks: Number(r.d), xactRollback: Number(r.rb) };
}
async function advisoryLocks() {
  return pgQuery('postgres', `SELECT l.pid, l.classid::text, l.objid::text, l.objsubid, l.granted, l.mode, a.datname, a.application_name
    FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.pid <> pg_backend_pid()`);
}
function logOffset() {
  const files = readdirSync(PG_LOG).filter((f) => f.endsWith('.log')).sort();
  return Object.fromEntries(files.map((f) => [f, statSync(join(PG_LOG, f)).size]));
}
function logScan(before) {
  const res = { deadlockDetected: 0, lockWaits: 0, errors: 0, lines: [] };
  for (const f of readdirSync(PG_LOG).filter((x) => x.endsWith('.log')).sort()) {
    const start = before[f] ?? 0;
    const size = statSync(join(PG_LOG, f)).size;
    if (size <= start) continue;
    const fd = openSync(join(PG_LOG, f), 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      if (/deadlock detected/i.test(line)) res.deadlockDetected += 1;
      if (/still waiting for|acquired .* after/i.test(line)) res.lockWaits += 1;
      if (/\b(ERROR|FATAL|PANIC):/.test(line)) { res.errors += 1; if (res.lines.length < 40) res.lines.push(line.slice(0, 300)); }
    }
  }
  return res;
}

// ── implementations ─────────────────────────────────────────────────────────
function rec(m, name) { return m.recruiters[name].id; }
async function tokenVersions(admin) {
  return Object.fromEntries((await admin.q('SELECT id, "tokenVersion" AS tv FROM recruiters')).map((r) => [r.id, r.tv]));
}
async function runOld(mods, db) {
  const r = await mods.oldSvc.reconcileRecruiterRewards({ db });
  return { awarded: r.awarded, reversed: r.reversed, unchanged: r.unchanged, checked: r.checked, calls: 1 };
}
async function adminLoop(mods, db, { cursor = null, max = Infinity, onBatch = null } = {}) {
  const h = mods.adminH.recruiterRewardAdminHandlers({ db });
  const tot = { awarded: 0, reversed: 0, unchanged: 0, checked: 0, candidates: 0, calls: 0, batches: [] };
  let c = cursor;
  for (;;) {
    const t0 = now();
    const res = await h.reconcile(new Request('http://localhost/api/admin/recruiter-rewards', { method: 'POST', body: JSON.stringify({ action: 'reconcile', ...(c ? { cursor: c } : {}) }) }));
    const body = await res.json();
    const ms = now() - t0;
    if (res.status !== 200) throw Object.assign(new Error(`admin reconcile ${res.status} ${JSON.stringify(body)}`), { status: res.status, body });
    const r = body.reconcile;
    tot.calls += 1;
    for (const k of ['awarded', 'reversed', 'unchanged', 'checked', 'candidates']) tot[k] += r[k];
    tot.batches.push({ cursorIn: c, cursor: r.cursor, hasMore: r.hasMore, checked: r.checked, awarded: r.awarded, reversed: r.reversed, unchanged: r.unchanged, candidates: r.candidates, ms: r3(ms) });
    if (onBatch) await onBatch(r);
    c = r.cursor;
    if (!r.hasMore || tot.calls >= max) break;
  }
  return tot;
}
async function walletGet(mod, db, recruiterId, tv) {
  const h = mod.recruiterWalletHandlers({ db, rateLimit: () => false });
  const res = await h.wallet(new Request('http://localhost/api/recruiter/wallet', { method: 'GET' }), {}, { type: 'recruiter', recruiterId, tv });
  const buf = await res.arrayBuffer();
  return { status: res.status, bytes: buf.byteLength };
}
async function runWalletAll(mods, db, m, tvs) {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  const st = [];
  try {
    for (const n of ['mixed', 'wide', 'deep', 'empty']) st.push((await walletGet(mods.newWallet, db, rec(m, n), tvs[rec(m, n)])).status);
  } finally { console.error = orig; }
  if (errs.length || st.some((s) => s !== 200)) throw new Error(`wallet path failed: ${JSON.stringify({ st, errs })}`);
  return { statuses: st, calls: 4 };
}

// ── scenario plan (equivalence) ──────────────────────────────────────────────
async function stateRows(admin) {
  return admin.q(`WITH st AS (
     SELECT l."affiliateId" id, l."recruiterId" rid,
       (SELECT max(cycle) FROM recruiter_reward_ledger r WHERE r."affiliateId"=l."affiliateId" AND type='RECRUIT_REWARD') rc,
       (SELECT max(cycle) FROM recruiter_reward_ledger r WHERE r."affiliateId"=l."affiliateId" AND type='REVERSAL') vc,
       (SELECT count(*) FROM affiliate_orders o WHERE o."affiliateId"=l."affiliateId" AND o.status='delivered' AND NOT o."isFake")::int n,
       (SELECT min(o.id) FROM affiliate_orders o WHERE o."affiliateId"=l."affiliateId" AND o.status='delivered' AND NOT o."isFake") first_order,
       (SELECT status FROM identity_verifications i WHERE i."affiliateId"=l."affiliateId") ident
     FROM recruiter_affiliate_links l)
   SELECT st.*, (rc IS NOT NULL AND rc > COALESCE(vc,0)) AS open,
     (SELECT "settingsVersion" FROM recruiter_reward_ledger r WHERE r."affiliateId"=st.id AND type='RECRUIT_REWARD' AND cycle=st.rc) ver
   FROM st ORDER BY id`);
}
function makePlan(m, rows, scale) {
  const K = scale === '1k' ? 40 : 300;
  const M = scale === '1k' ? 20 : 150;
  const L = scale === '1k' ? 10 : 50;
  const pool = new Set([...m.pools.P_AWARD, ...m.pools.P_REVERSE]);
  const free = rows.filter((r) => !pool.has(r.id));
  const take = (f, used = new Set()) => free.filter((r) => f(r) && !used.has(r.id)).slice(0, L);
  const a2a = take((r) => r.open && r.ver === 1 && r.n === 3);
  const a2b = take((r) => r.open && r.ver === 1 && r.n === 4);
  const a2c = take((r) => r.open && r.ver === 2 && r.n === 5 && r.ident === 'APPROVED');
  const natural = free.filter((r) => !r.open && r.ident === 'APPROVED' && r.n === 4);
  const a3a = natural.slice(0, L);
  const a3b = take((r) => r.open && r.ver === 2 && r.n === 5, new Set(a2c.map((r) => r.id)));
  const a3c = take((r) => !r.open && r.ident === 'PENDING' && r.n >= 5);
  const ids = (xs) => xs.map((r) => r.id);
  const orders = (xs) => xs.map((r) => r.first_order);
  return {
    scale, K, M, L,
    s1: { approve: m.pools.P_AWARD.slice(0, K), cancelOrders: m.pools.P_REVERSE.slice(0, M).map((id) => m.pools.P_REVERSE_cancelOrderId[id]), reversals: m.pools.P_REVERSE.slice(0, M) },
    s2: { settings: { enabled: true, rewardAmountMad: '60', minDeliveredSales: 4 }, a2a: ids(a2a), a2b: ids(a2b), a2c: ids(a2c), cancelOrders: orders([...a2a, ...a2b, ...a2c]), naturalAwardCandidates: natural.length },
    s3: { settings: { enabled: false, rewardAmountMad: '60', minDeliveredSales: 4 }, a3a: ids(a3a), a3b: ids(a3b), a3c: ids(a3c),
      cancelOrders: [...orders(a3b)], cancelFirstDeliveredOf: ids(a3a), approve: ids(a3c) },
  };
}
async function cancelOrders(admin, ids) {
  const r = await admin.q("UPDATE affiliate_orders SET status = 'cancelled' WHERE id = ANY($1::text[]) AND status = 'delivered' AND NOT \"isFake\" RETURNING id", [ids]);
  return r.length;
}
async function approveIdentities(admin, affIds) {
  const r = await admin.q(`UPDATE identity_verifications SET status = 'APPROVED', "approvedAt" = (now() AT TIME ZONE 'UTC'), "approvedBy" = 'p5d', "rejectionReason" = NULL,
    "updatedAt" = (now() AT TIME ZONE 'UTC') WHERE "affiliateId" = ANY($1::text[]) AND status <> 'APPROVED' RETURNING "affiliateId"`, [affIds]);
  return r.length;
}
async function cancelFirstDelivered(admin, affIds) {
  const r = await admin.q(`UPDATE affiliate_orders o SET status = 'cancelled' WHERE o.id IN (
      SELECT min(x.id) FROM affiliate_orders x WHERE x."affiliateId" = ANY($1::text[]) AND x.status = 'delivered' AND NOT x."isFake" GROUP BY x."affiliateId") RETURNING id`, [affIds]);
  return r.length;
}
/** Make any linked affiliate a candidate: open reward → cancel its real delivered orders (reversal);
 * otherwise → identity APPROVED (update or insert) + 6 new real delivered orders (award). */
async function makeCandidate(admin, affId, tag) {
  const [s] = await admin.q(`SELECT (SELECT max(cycle) FROM recruiter_reward_ledger WHERE "affiliateId"=$1 AND type='RECRUIT_REWARD') rc,
    (SELECT max(cycle) FROM recruiter_reward_ledger WHERE "affiliateId"=$1 AND type='REVERSAL') vc`, [affId]);
  const open = s.rc !== null && s.rc > (s.vc ?? 0);
  if (open) {
    const n = (await admin.q("UPDATE affiliate_orders SET status='cancelled' WHERE \"affiliateId\"=$1 AND status='delivered' AND NOT \"isFake\" RETURNING id", [affId])).length;
    return { id: affId, kind: 'reversal', cancelled: n };
  }
  await admin.q(`INSERT INTO identity_verifications (id, "affiliateId", status, "approvedAt", "approvedBy", "createdAt", "updatedAt")
    VALUES ('p5d-iv-' || $1, $1, 'APPROVED', now() AT TIME ZONE 'UTC', 'p5d', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
    ON CONFLICT ("affiliateId") DO UPDATE SET status='APPROVED', "approvedAt"=EXCLUDED."approvedAt", "approvedBy"='p5d', "rejectionReason"=NULL, "updatedAt"=EXCLUDED."updatedAt"`, [affId]);
  await admin.q(`INSERT INTO affiliate_orders (id, "affiliateId", status, "isFake", total, "createdAt")
    SELECT 'p5d-o-' || $2 || '-' || g || '-' || $1, $1, 'delivered', false, 100, now() AT TIME ZONE 'UTC' FROM generate_series(1,6) g`, [affId, tag]);
  return { id: affId, kind: 'award' };
}

// ── equivalence ──────────────────────────────────────────────────────────────
async function equiv() {
  const scale = opt('scale');
  const impl = opt('impl');
  if (!['old', 'admin', 'wallet'].includes(impl)) throw new Error('--impl old|admin|wallet');
  const m = loadManifest(scale);
  const mods = await loadMods();
  const clone = `rec_5d_${scale}_eq_${impl}`;
  await dropDb(clone);
  const cl = await cloneDb(TEMPLATES[scale], clone);
  const admin = await adminClient(clone);
  const conn = await connect(clone, { sqlTrace: false, bytes: false, heap: false });
  const planFile = join(RES, `equiv-plan-${scale}.json`);
  let plan;
  if (existsSync(planFile)) plan = JSON.parse(readFileSync(planFile, 'utf8'));
  else { plan = makePlan(m, await stateRows(admin), scale); writeFileSync(planFile, JSON.stringify(plan, null, 1)); }
  const tvs = await tokenVersions(admin);
  const statsBefore = await tableStats(admin);
  const dl0 = await deadlocks(clone);
  const lo = logOffset();
  const reconcile = async () => {
    if (impl === 'old') return runOld(mods, conn.db);
    if (impl === 'admin') { const r = await adminLoop(mods, conn.db); return { ...r, batches: r.batches.length, batchDetail: r.batches.map((b) => [b.checked, b.awarded, b.reversed, b.unchanged, b.candidates, b.hasMore]) }; }
    return runWalletAll(mods, conn.db, m, tvs);
  };
  const steps = [];
  const step = async (name, mutate) => {
    const marks = await seqMarks(admin);
    const mut = mutate ? await mutate() : null;
    const t0 = now();
    const res = await reconcile();
    const ms = now() - t0;
    const rows = await newRows(admin, marks);
    const ledgerByType = {};
    for (const s of rows.ledger) { const r = JSON.parse(s); ledgerByType[r.type] = (ledgerByType[r.type] ?? 0) + 1; }
    steps.push({ name, mutate: mut, result: res, ms: r3(ms), ledgerNew: rows.ledger.length, auditNew: rows.audit.length, ledgerByType, rows });
    log(impl, scale, name, JSON.stringify({ mut, ledgerByType, audit: rows.audit.length, ms: r3(ms) }));
  };
  const save = (s) => mods.newSvc.adminSaveRecruiterSettings(s, { db: conn.db, actorId: 'p5d-admin' });
  await step('S0-steady');
  await step('S1-flips', async () => ({ approved: await approveIdentities(admin, plan.s1.approve), cancelled: await cancelOrders(admin, plan.s1.cancelOrders) }));
  await step('S1-again');
  await step('S2-v3-threshold4', async () => ({ settings: await save(plan.s2.settings), cancelled: await cancelOrders(admin, plan.s2.cancelOrders) }));
  await step('S2-again');
  await step('S3-disabled', async () => ({ settings: await save(plan.s3.settings), cancelled: await cancelOrders(admin, plan.s3.cancelOrders),
    cancelledA3a: await cancelFirstDelivered(admin, plan.s3.cancelFirstDeliveredOf), approved: await approveIdentities(admin, plan.s3.approve) }));
  await step('S3-again');
  await conn.close();
  const inv = await invariants(admin);
  // per-group checks against the plan (which affiliates got which row type)
  const all = steps.flatMap((s) => s.rows.ledger.map((x) => ({ step: s.name, ...JSON.parse(x) })));
  const rowsOf = (ids, type, stepName) => ids.filter((id) => all.some((r) => r.affiliateId === id && r.type === type && (!stepName || r.step === stepName))).length;
  const groupChecks = {
    s1_awards: rowsOf(plan.s1.approve, 'RECRUIT_REWARD', 'S1-flips'), s1_reversals: rowsOf(plan.s1.reversals, 'REVERSAL', 'S1-flips'),
    a2a_v1n3_reversed: rowsOf(plan.s2.a2a, 'REVERSAL', 'S2-v3-threshold4'), a2b_v1n4_reversed_should_be0: rowsOf(plan.s2.a2b, 'REVERSAL'),
    a2c_v2n5_reversed: rowsOf(plan.s2.a2c, 'REVERSAL', 'S2-v3-threshold4'), a2c_reawarded_v3_second_run: rowsOf(plan.s2.a2c, 'RECRUIT_REWARD', 'S2-again'),
    a3a_awarded_v3: rowsOf(plan.s3.a3a, 'RECRUIT_REWARD', 'S2-v3-threshold4'), a3a_reversed_while_disabled: rowsOf(plan.s3.a3a, 'REVERSAL', 'S3-disabled'),
    a3b_reversed_while_disabled: rowsOf(plan.s3.a3b, 'REVERSAL', 'S3-disabled'), a3c_awarded_while_disabled_should_be0: rowsOf(plan.s3.a3c, 'RECRUIT_REWARD'),
    planSizes: { K: plan.s1.approve.length, M: plan.s1.reversals.length, a2a: plan.s2.a2a.length, a2b: plan.s2.a2b.length, a2c: plan.s2.a2c.length, a3a: plan.s3.a3a.length, a3b: plan.s3.a3b.length, a3c: plan.s3.a3c.length, naturalAwardCandidatesS2: plan.s2.naturalAwardCandidates },
    reversalVersions: {
      a2a: [...new Set(all.filter((r) => plan.s2.a2a.includes(r.affiliateId) && r.type === 'REVERSAL').map((r) => r.settingsVersion))],
      a2c: [...new Set(all.filter((r) => plan.s2.a2c.includes(r.affiliateId) && r.type === 'REVERSAL').map((r) => r.settingsVersion))],
      a3a: [...new Set(all.filter((r) => plan.s3.a3a.includes(r.affiliateId) && r.type === 'REVERSAL').map((r) => r.settingsVersion))],
    },
  };
  await sleep(1200);
  const statsAfter = await tableStats(admin);
  const dl1 = await deadlocks(clone);
  await admin.end();
  const dump = { kind: 'equiv', scale, impl, clone: cl, steps, invariants: inv, groupChecks, statsDelta: statsDelta(statsBefore, statsAfter),
    deadlocksDelta: dl1.deadlocks - dl0.deadlocks, log: logScan(lo), advisoryLocksAfter: await advisoryLocks() };
  writeFileSync(join(RES, `equiv-${scale}-${impl}.json`), JSON.stringify(dump, null, 1));
  await out('equiv.jsonl', { ...dump, steps: steps.map(({ rows: _r, ...s }) => s) });
  await dropDb(clone);
  log('done', JSON.stringify({ inv, groupChecks, statsDelta: dump.statsDelta, deadlocksDelta: dump.deadlocksDelta }));
}
async function equivCompare() {
  const scale = opt('scale');
  const d = Object.fromEntries(['old', 'admin', 'wallet'].map((i) => [i, JSON.parse(readFileSync(join(RES, `equiv-${scale}-${i}.json`), 'utf8'))]));
  const res = { kind: 'equiv-compare', scale, steps: [] };
  const allSame = { admin: true, wallet: true };
  for (let k = 0; k < d.old.steps.length; k += 1) {
    const o = d.old.steps[k];
    const row = { step: o.name, old: { ledger: o.ledgerNew, audit: o.auditNew, byType: o.ledgerByType, result: o.result } };
    for (const i of ['admin', 'wallet']) {
      const s = d[i].steps[k];
      const eqL = JSON.stringify(s.rows.ledger) === JSON.stringify(o.rows.ledger);
      const eqA = JSON.stringify(s.rows.audit) === JSON.stringify(o.rows.audit);
      const onlyOld = o.rows.ledger.filter((x) => !s.rows.ledger.includes(x)).length;
      const onlyNew = s.rows.ledger.filter((x) => !o.rows.ledger.includes(x)).length;
      row[i] = { ledger: s.ledgerNew, audit: s.auditNew, byType: s.ledgerByType, ledgerIdentical: eqL, auditIdentical: eqA, onlyOld, onlyNew,
        result: i === 'admin' ? { awarded: s.result.awarded, reversed: s.result.reversed, unchanged: s.result.unchanged, checked: s.result.checked, candidates: s.result.candidates, batches: s.result.batches } : s.result };
      if (!eqL || !eqA) allSame[i] = false;
    }
    res.steps.push(row);
  }
  res.identical = allSame;
  res.groupChecks = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.groupChecks]));
  res.invariants = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.invariants]));
  res.statsDelta = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.statsDelta]));
  res.deadlocksDelta = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.deadlocksDelta]));
  await out('equiv-compare.jsonl', res);
  console.log(JSON.stringify(res, null, 1));
}

// ── boundary (1k) ────────────────────────────────────────────────────────────
async function boundary() {
  const m = loadManifest('1k');
  const mods = await loadMods();
  const clone = 'rec_5d_1k_boundary';
  await dropDb(clone);
  await cloneDb(TEMPLATES['1k'], clone);
  const admin = await adminClient(clone);
  const conn = await connect(clone, { sqlTrace: false, bytes: false, heap: false });
  const marks0 = await seqMarks(admin);
  const idsOf = async (rid) => (await admin.q('SELECT "affiliateId" id FROM recruiter_affiliate_links WHERE "recruiterId"=$1 ORDER BY "affiliateId"', [rid])).map((r) => r.id);
  const mixed = await idsOf(rec(m, 'mixed'));
  const wide = await idsOf(rec(m, 'wide'));
  const results = [];
  let tagN = 0;
  const caseRun = async (label, { rid, after, batchSize, scope, positions }) => {
    // scope = ordered ids that the run should scan; positions (1-based within scope) made candidates
    const cands = [];
    for (const p of positions) if (scope[p - 1]) cands.push(await makeCandidate(admin, scope[p - 1], `b${tagN += 1}`));
    const marks = await seqMarks(admin);
    const t = {};
    const res = await mods.newSvc.reconcileRecruiterRewards({ db: tap(conn.db, t), recruiterId: rid, after, ...(batchSize ? { batchSize } : {}) });
    const rows = (await newRows(admin, marks)).ledger.map((x) => JSON.parse(x));
    const synced = t.syncs.map((s) => s.id);
    const expectedIds = cands.map((c) => c.id).sort();
    const size = batchSize ?? 1000;
    const expBatches = Math.floor(scope.length / size) + 1;
    const r = {
      label, scopeSize: scope.length, batchSize: size, result: res,
      batchesLog: t.cand.map((c) => ({ k: c.k, afterBind: c.vals[2] ?? null, scanned: c.scanned, last: c.last, reversals: c.reversals.length, awards: c.awards.length })),
      expected: { checked: scope.length, batches: expBatches, lastId: scope[scope.length - 1], candidates: expectedIds.length },
      candidates: cands, syncedPerBatch: t.cand.map((c) => t.syncs.filter((s) => s.batch === c.k).map((s) => s.id)),
      checks: {
        checked: res.checked === scope.length,
        batches: res.batches === expBatches,
        perBatchScanned: t.cand.every((c, k) => c.scanned === Math.min(size, Math.max(0, scope.length - k * size))),
        perBatchLast: t.cand.every((c, k) => c.last === (scope[Math.min(scope.length, (k + 1) * size) - 1] ?? null) || (c.scanned === 0 && c.last === null)),
        hasMoreFalse: res.hasMore === false && res.cursor === null,
        syncedExactlyCandidates: JSON.stringify([...synced].sort()) === JSON.stringify(expectedIds),
        noDuplicateSync: new Set(synced).size === synced.length,
        rowsPerCandidate: expectedIds.every((id) => rows.filter((x) => x.affiliateId === id).length === 1) && rows.length === expectedIds.length,
      },
    };
    r.ok = Object.values(r.checks).every(Boolean);
    results.push(r);
    log('boundary', label, r.ok, JSON.stringify(r.checks), JSON.stringify(res));
    await out('boundary.jsonl', r);
  };
  // recruiter scope rec_mixed (1002 links) cut by the cursor → 1001 / 1000 / 999 remaining, default batch 1000
  for (const remain of [999, 1000, 1001]) {
    const cut = mixed.length - remain; // index of the cursor element (0-based) → after = mixed[cut-1]
    const scope = mixed.slice(cut);
    await caseRun(`mixed-after-cursor-${remain}`, { rid: rec(m, 'mixed'), after: mixed[cut - 1], scope, positions: [1, 999, 1000, 1001] });
  }
  // recruiter scope rec_wide (1000 links), batchSize 999 / 1000 / 1001
  for (const bs of [999, 1000, 1001]) await caseRun(`wide-batchSize-${bs}`, { rid: rec(m, 'wide'), after: null, batchSize: bs, scope: wide, positions: [1, 998, 999, 1000] });
  // wallet path for rec_wide (exactly 1000 = one full batch + an empty one) with 2 candidates at the end
  {
    const cands = [await makeCandidate(admin, wide[998], 'w1'), await makeCandidate(admin, wide[999], 'w2')];
    const marks = await seqMarks(admin);
    const t = {};
    const tvs = await tokenVersions(admin);
    const st = await walletGet(mods.newWallet, tap(conn.db, t), rec(m, 'wide'), tvs[rec(m, 'wide')]);
    const rows = (await newRows(admin, marks)).ledger.map((x) => JSON.parse(x));
    const r = { label: 'wallet-wide-1000', status: st.status, candidates: cands, batchesLog: t.cand.map((c) => ({ scanned: c.scanned, last: c.last, reversals: c.reversals.length, awards: c.awards.length })),
      synced: t.syncs.map((s) => s.id), newRows: rows.length };
    r.ok = st.status === 200 && t.cand.length === 2 && t.cand[0].scanned === 1000 && t.cand[1].scanned === 0 && rows.length === 2;
    results.push(r);
    await out('boundary.jsonl', r);
    log('boundary wallet', r.ok, JSON.stringify(r.batchesLog));
  }
  await conn.close();
  const inv = await invariants(admin);
  const all = await newRows(admin, marks0);
  await admin.end();
  await dropDb(clone);
  const summary = { kind: 'boundary-summary', cases: results.map((r) => ({ label: r.label, ok: r.ok, checked: r.result?.checked, batches: r.result?.batches, scanned: r.batchesLog.map((b) => b.scanned) })), invariants: inv, ledgerRowsTotal: all.ledger.length, auditRowsTotal: all.audit.length };
  await out('boundary.jsonl', summary);
  console.log(JSON.stringify(summary, null, 1));
}

// ── batching (10k full scope) ────────────────────────────────────────────────
async function batching() {
  const scale = opt('scale', '10k');
  const m = loadManifest(scale);
  const mods = await loadMods();
  const clone = `rec_5d_${scale}_batch`;
  await dropDb(clone);
  await cloneDb(TEMPLATES[scale], clone);
  const admin = await adminClient(clone);
  const conn = await connect(clone, { sqlTrace: false, bytes: false, heap: false });
  const allIds = (await admin.q('SELECT "affiliateId" id FROM recruiter_affiliate_links ORDER BY "affiliateId"')).map((r) => r.id);
  const N = allIds.length;
  // candidates: S1-like flips (rec_mixed pools) + makeCandidate at every batch boundary (positions 1, 1000, 1001, 2000, 2001, …, N)
  const K = scale === '1k' ? 40 : 300;
  const M = scale === '1k' ? 20 : 150;
  const approve = m.pools.P_AWARD.slice(0, K);
  const revs = m.pools.P_REVERSE.slice(0, M);
  const pos = new Set([1, N]);
  for (let b = 1000; b < N; b += 1000) { pos.add(b); pos.add(b + 1); }
  const poolSet = new Set([...approve, ...revs]);
  const made = [];
  for (const p of [...pos].sort((a, b) => a - b)) if (!poolSet.has(allIds[p - 1])) made.push(await makeCandidate(admin, allIds[p - 1], `c${p}`));
  const flips = { approved: await approveIdentities(admin, approve), cancelled: await cancelOrders(admin, revs.map((id) => m.pools.P_REVERSE_cancelOrderId[id])) };
  const expectedCand = new Set([...approve, ...revs, ...made.map((c) => c.id)]);
  const marks0 = await seqMarks(admin);
  const stats0 = await tableStats(admin);
  // Phase A: admin batches 1..5 (cursor chained), logging synced ids per batch
  const t = {};
  const db = tap(conn.db, t);
  const batches = [];
  let cursor = null;
  const runBatch = async (label, after) => {
    const k0 = t.cand.length;
    const s0 = t.syncs.length;
    const w0 = t.writes.length;
    const r = await mods.newSvc.reconcileRecruiterRewards({ db, after, maxBatches: 1 });
    const c = t.cand[k0];
    const synced = t.syncs.slice(s0).map((s) => s.id);
    const b = { label, after, cursor: r.cursor, hasMore: r.hasMore, checked: r.checked, awarded: r.awarded, reversed: r.reversed, unchanged: r.unchanged, candidates: r.candidates,
      scanned: c?.scanned, last: c?.last, synced, writes: t.writes.slice(w0).length,
      expectedLast: allIds[Math.min(N, (after ? allIds.indexOf(after) + 1 : 0) + 1000) - 1],
      syncedInRange: synced.every((id) => (after === null || id > after) && id <= r.cursor) };
    batches.push(b);
    return b;
  };
  for (let i = 0; i < 5; i += 1) cursor = (await runBatch(`A${i + 1}`, cursor)).cursor;
  // Phase B: retry batch 3 (same cursor as batch 3's input) twice
  const retry1 = await runBatch('retry-3a', batches[2].after);
  const retry2 = await runBatch('retry-3b', batches[2].after);
  // Phase C: restart from batch 5's cursor in a NEW connection, admin handler loop until hasMore false
  const conn2 = await connect(clone, { sqlTrace: false, bytes: false, heap: false });
  const t2 = {};
  const restartedFrom = cursor;
  const loop = await adminLoop(mods, tap(conn2.db, t2), { cursor });
  await conn2.close();
  // Phase D: full repeat from null (expect zero changes)
  const t3 = {};
  const conn3 = await connect(clone, { sqlTrace: false, bytes: false, heap: false });
  const repeat = await adminLoop(mods, tap(conn3.db, t3));
  await conn3.close();
  await conn.close();
  const rows = (await newRows(admin, marks0)).ledger.map((x) => JSON.parse(x));
  const perAff = new Map();
  for (const r of rows) perAff.set(r.affiliateId, (perAff.get(r.affiliateId) ?? 0) + 1);
  // synced ids across the straight path A1..A5 + restart loop (excluding retries and the repeat)
  const straightSyncs = [...batches.slice(0, 5).flatMap((b) => b.synced), ...t2.syncs.map((s) => s.id)];
  const loopLast = loop.batches.map((b) => b.cursor);
  const straightCursors = [...batches.slice(0, 5).map((b) => b.cursor), ...loopLast];
  await sleep(1200);
  const stats1 = await tableStats(admin);
  const inv = await invariants(admin);
  const res = {
    kind: 'batching', scale, links: N, expectedCandidates: expectedCand.size, made: made.length, flips,
    phaseA: batches.slice(0, 5).map(({ synced, ...b }) => ({ ...b, syncedCount: synced.length, syncedFirst: synced.slice(0, 3) })),
    retries: [retry1, retry2].map(({ synced, ...b }) => ({ ...b, syncedCount: synced.length })),
    restart: { from: restartedFrom, calls: loop.calls, checked: loop.checked, awarded: loop.awarded, reversed: loop.reversed, unchanged: loop.unchanged, perBatch: loop.batches },
    repeat: { calls: repeat.calls, checked: repeat.checked, awarded: repeat.awarded, reversed: repeat.reversed, unchanged: repeat.unchanged, candidates: repeat.candidates },
    checks: {
      phaseA_cursorDeterministic: batches.slice(0, 5).every((b) => b.cursor === b.expectedLast && b.last === b.expectedLast && b.scanned === 1000),
      phaseA_syncedInRange: batches.every((b) => b.syncedInRange),
      retry_sameCursor: retry1.cursor === batches[2].cursor && retry2.cursor === batches[2].cursor,
      retry_noWrites: retry1.writes === 0 && retry2.writes === 0 && retry1.awarded + retry1.reversed + retry2.awarded + retry2.reversed === 0,
      retry_syncedSubsetOfBatch3: [...retry1.synced, ...retry2.synced].every((id) => batches[2].synced.includes(id)),
      straight_checkedTotal: batches.slice(0, 5).reduce((a, b) => a + b.checked, 0) + loop.checked === N,
      straight_cursorsStrictlyIncreasing: straightCursors.filter(Boolean).every((c, i, a) => i === 0 || a[i - 1] < c) && straightCursors[straightCursors.length - 1] === null,
      straight_noDuplicateSync: new Set(straightSyncs).size === straightSyncs.length,
      straight_syncedEqualsExpected: straightSyncs.length === expectedCand.size && straightSyncs.every((id) => expectedCand.has(id)),
      ledger_oneRowPerCandidate: rows.length === expectedCand.size && [...perAff.values()].every((n) => n === 1) && [...expectedCand].every((id) => perAff.get(id) === 1),
      repeat_zero: repeat.awarded === 0 && repeat.reversed === 0 && repeat.checked === N,
      ledgerAudit_noUpdDel: stats1.recruiter_reward_ledger.upd === stats0.recruiter_reward_ledger.upd && stats1.recruiter_reward_ledger.del === stats0.recruiter_reward_ledger.del
        && stats1.recruiter_audit_log.upd === stats0.recruiter_audit_log.upd && stats1.recruiter_audit_log.del === stats0.recruiter_audit_log.del,
      invariants: inv.ok,
    },
    ledgerRows: rows.length, rowsByType: rows.reduce((a, r) => ({ ...a, [r.type]: (a[r.type] ?? 0) + 1 }), {}), statsDelta: statsDelta(stats0, stats1), invariants: inv,
  };
  res.ok = Object.values(res.checks).every(Boolean);
  writeFileSync(join(LOGS, `batching-${scale}-synced.json`), JSON.stringify({ phaseA: batches.map((b) => ({ label: b.label, after: b.after, cursor: b.cursor, synced: b.synced })),
    restart: t2.cand.map((c) => ({ k: c.k, scanned: c.scanned, last: c.last, synced: t2.syncs.filter((s) => s.batch === c.k).map((s) => s.id) })) }, null, 1));
  await out('batching.jsonl', res);
  await admin.end();
  await dropDb(clone);
  console.log(JSON.stringify({ ok: res.ok, checks: res.checks, phaseA: res.phaseA, retries: res.retries, restart: { ...res.restart, perBatch: res.restart.perBatch.length }, repeat: res.repeat, ledgerRows: res.ledgerRows, rowsByType: res.rowsByType, statsDelta: res.statsDelta }, null, 1));
}

// ── concurrency (10k) ────────────────────────────────────────────────────────
async function concurrency() {
  const scale = opt('scale', '10k');
  const m = loadManifest(scale);
  const mods = await loadMods();
  const clone = `rec_5d_${scale}_conc`;
  await dropDb(clone);
  await cloneDb(TEMPLATES[scale], clone);
  const admin = await adminClient(clone);
  const conns = [];
  for (let i = 0; i < 6; i += 1) conns.push(await connect(clone, { sqlTrace: false, bytes: false, heap: false }));
  const tvs = await tokenVersions(admin);
  const report = { kind: 'concurrency', scale };
  const stats0 = await tableStats(admin);
  const dl0 = await deadlocks(clone);
  const lo = logOffset();
  const marks0 = await seqMarks(admin);
  // lock monitor: samples pg_locks for the lease key
  let monitorOn = true;
  const mon = { samples: 0, maxHolders: 0, waiters: 0 };
  const monClient = await adminClient(clone);
  const monitor = (async () => {
    while (monitorOn) {
      const [r] = await monClient.q(`SELECT count(*) FILTER (WHERE granted)::int g, count(*) FILTER (WHERE NOT granted)::int w FROM pg_locks
        WHERE locktype='advisory' AND classid = (${LEASE_KEY_SQL})::oid AND objid = 0 AND objsubid = 2`);
      mon.samples += 1; mon.maxHolders = Math.max(mon.maxHolders, r.g); mon.waiters += r.w;
      await sleep(2);
    }
  })();
  const overlap = (iv) => { const s = [...iv].sort((a, b) => a[0] - b[0]); for (let i = 1; i < s.length; i += 1) if (s[i][0] < s[i - 1][1]) return true; return false; };
  // C1/C2: N concurrent full-scope admin batches (handler) and N concurrent full service runs, R rounds
  const lease = [];
  for (const n of [2, 4]) {
    for (const mode of ['admin-batch', 'service-full']) {
      const rounds = [];
      const work = [];
      for (let r = 0; r < 8; r += 1) {
        const outs = await Promise.all(conns.slice(0, n).map(async (c) => {
          const t = {};
          const db = tap(c.db, t);
          const t0 = now();
          if (mode === 'admin-batch') {
            const res = await mods.adminH.recruiterRewardAdminHandlers({ db }).reconcile(new Request('http://x/', { method: 'POST', body: JSON.stringify({ action: 'reconcile' }) }));
            const body = await res.json();
            if (t.cand.length) work.push([t.cand[0].start, now()]);
            return { status: res.status, code: body.code ?? null, busy: res.status === 409, ms: r3(now() - t0) };
          }
          const res = await mods.newSvc.reconcileRecruiterRewards({ db });
          if (t.cand.length) work.push([t.cand[0].start, now()]);
          return { status: res.busy ? 'busy' : 'ran', busy: res.busy, batches: res.batches, ms: r3(now() - t0) };
        }));
        rounds.push(outs);
      }
      const ran = rounds.map((o) => o.filter((x) => !x.busy).length);
      const row = { n, mode, rounds: rounds.length, ranPerRound: ran, busyTotal: rounds.flat().filter((x) => x.busy).length,
        busyCodes: [...new Set(rounds.flat().filter((x) => x.busy).map((x) => x.code ?? x.status))], workIntervalsOverlap: overlap(work), exactlyOnePerRound: ran.every((x) => x === 1),
        msRan: summarize(rounds.flat().filter((x) => !x.busy).map((x) => x.ms)), msBusy: summarize(rounds.flat().filter((x) => x.busy).map((x) => x.ms)) };
      lease.push(row);
      log('lease', JSON.stringify(row));
    }
  }
  report.lease = lease;
  // C3: candidates + wallet reconciles of 4 recruiters concurrent with an admin batch loop
  const K = 300; const M = 150;
  const approve = m.pools.P_AWARD.slice(0, K);
  const revs = m.pools.P_REVERSE.slice(0, M);
  const ids = (await admin.q('SELECT "affiliateId" id, "recruiterId" r FROM recruiter_affiliate_links ORDER BY "affiliateId"'));
  const made = [];
  const poolSet = new Set([...approve, ...revs]);
  for (let i = 0; i < ids.length; i += 97) if (!poolSet.has(ids[i].id)) made.push(await makeCandidate(admin, ids[i].id, `cc${i}`));
  await approveIdentities(admin, approve);
  await cancelOrders(admin, revs.map((id) => m.pools.P_REVERSE_cancelOrderId[id]));
  const expected = new Set([...approve, ...revs, ...made.map((c) => c.id)]);
  const marksC3 = await seqMarks(admin);
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  let c3;
  try {
    const t0 = now();
    const [adm, ...wal] = await Promise.all([
      adminLoop(mods, conns[0].db),
      ...['mixed', 'wide', 'deep', 'empty'].map(async (n, i) => {
        const st = [];
        for (let k = 0; k < 3; k += 1) st.push((await walletGet(mods.newWallet, conns[i + 1].db, rec(m, n), tvs[rec(m, n)])).status);
        return { n, st };
      }),
    ]);
    c3 = { ms: r3(now() - t0), admin: { calls: adm.calls, checked: adm.checked, awarded: adm.awarded, reversed: adm.reversed, unchanged: adm.unchanged }, wallet: wal };
  } finally { console.error = origErr; }
  const rowsC3 = (await newRows(admin, marksC3)).ledger.map((x) => JSON.parse(x));
  const perAff = new Map();
  for (const r of rowsC3) perAff.set(r.affiliateId, (perAff.get(r.affiliateId) ?? 0) + 1);
  c3.expected = expected.size;
  c3.ledgerRows = rowsC3.length;
  c3.walletErrors = errs;
  c3.ok = rowsC3.length === expected.size && [...expected].every((id) => perAff.get(id) === 1) && errs.length === 0 && c3.wallet.every((w) => w.st.every((s) => s === 200));
  report.walletPlusAdmin = c3;
  log('C3', JSON.stringify(c3));
  // C4: reconcile loops concurrent with order-status changes (+ hook) and withdrawal payments
  const mixedRid = rec(m, 'mixed');
  const openMixed = await admin.q(`SELECT l."affiliateId" id FROM recruiter_affiliate_links l WHERE l."recruiterId" = $1 AND
      (SELECT max(cycle) FROM recruiter_reward_ledger r WHERE r."affiliateId"=l."affiliateId" AND type='RECRUIT_REWARD') >
      COALESCE((SELECT max(cycle) FROM recruiter_reward_ledger r WHERE r."affiliateId"=l."affiliateId" AND type='REVERSAL'), 0)
      ORDER BY l."affiliateId" LIMIT 200`, [mixedRid]);
  const orderTargets = [];
  for (const r of openMixed) {
    const o = await admin.q('SELECT id FROM affiliate_orders WHERE "affiliateId"=$1 AND status=\'delivered\' AND NOT "isFake" ORDER BY id', [r.id]);
    if (o.length) orderTargets.push({ aff: r.id, orders: o.map((x) => x.id) });
  }
  const pending = await admin.q(`SELECT id, "recruiterId" r, amount FROM affiliate_payouts WHERE "recruiterId" IS NOT NULL AND status='pending' ORDER BY id`);
  const marksC4 = await seqMarks(admin);
  const c4 = { orderChanges: 0, hookResults: {}, payments: {}, reconcileRuns: 0, busy: 0, walletRuns: 0, errors: [] };
  const deadline = now() + 25000;
  const errs4 = [];
  console.error = (...a) => { errs4.push(a.map(String).join(' ')); };
  try {
    await Promise.all([
      (async () => { // full-scope service reconcile loop
        while (now() < deadline) { const r = await mods.newSvc.reconcileRecruiterRewards({ db: conns[0].db }); c4.reconcileRuns += 1; if (r.busy) c4.busy += 1; }
      })(),
      (async () => { // a second full-scope runner (contends for the lease)
        while (now() < deadline) { const r = await mods.newSvc.reconcileRecruiterRewards({ db: conns[5].db }); c4.reconcileRuns += 1; if (r.busy) c4.busy += 1; await sleep(5); }
      })(),
      (async () => { // wallet rec_mixed loop
        while (now() < deadline) { await walletGet(mods.newWallet, conns[1].db, mixedRid, tvs[mixedRid]); c4.walletRuns += 1; }
      })(),
      ...[2, 3].map((ci) => (async () => { // order-status changes: cancel / re-deliver one real order, then the hook
        let k = ci;
        while (now() < deadline) {
          const tg = orderTargets[k % orderTargets.length];
          k += 2;
          const oid = tg.orders[0];
          const [cur] = await conns[ci].prisma.affiliateOrder.findMany({ where: { id: oid }, select: { status: true } });
          await conns[ci].prisma.$transaction(async (tx) => { await tx.affiliateOrder.update({ where: { id: oid }, data: { status: cur.status === 'delivered' ? 'cancelled' : 'delivered' } }); });
          c4.orderChanges += 1;
          const h = await mods.hooks.onRecruiterOrderStatusCommitted(oid, { db: conns[ci].db });
          c4.hookResults[h.action] = (c4.hookResults[h.action] ?? 0) + 1;
        }
      })()),
      (async () => { // withdrawal payments (lockRecruiterMoney) for every pending recruiter payout
        for (const p of pending) {
          if (now() >= deadline) break;
          try { const r = await mods.walletSvc.adminProcessRecruiterPayout(p.id, 'pay', { db: conns[4].db, actorId: 'p5d-admin' }); c4.payments[r.status] = (c4.payments[r.status] ?? 0) + 1; } catch (e) { c4.payments[e.code ?? 'ERROR'] = (c4.payments[e.code ?? 'ERROR'] ?? 0) + 1; }
          await sleep(20);
        }
      })(),
    ]);
  } catch (e) { c4.errors.push(String(e?.message ?? e).slice(0, 300)); } finally { console.error = origErr; }
  c4.consoleErrors = errs4.slice(0, 20);
  c4.consoleErrorCount = errs4.length;
  c4.pendingPayouts = pending.length;
  const rowsC4 = (await newRows(admin, marksC4)).ledger.map((x) => JSON.parse(x));
  c4.ledgerRows = rowsC4.length;
  c4.ledgerByType = rowsC4.reduce((a, r) => ({ ...a, [r.type]: (a[r.type] ?? 0) + 1 }), {});
  const [bal] = await admin.q(`SELECT count(*)::int AS overpaid FROM (
      SELECT r.id, COALESCE((SELECT sum("amountCents") FROM recruiter_reward_ledger l WHERE l."recruiterId"=r.id),0) earned,
             COALESCE((SELECT sum(round(amount*100)) FROM affiliate_payouts p WHERE p."recruiterId"=r.id AND p.status='paid'),0) paid
      FROM recruiters r) x WHERE paid > earned`);
  c4.recruitersPaidAboveNetEarned = bal.overpaid;
  report.ordersPaymentsReconcile = c4;
  log('C4', JSON.stringify(c4));
  // C5: injected errors → lease released
  const inj = [];
  for (const mode of ['candidate-2nd-batch', 'sync-ledger-create']) {
    await makeCandidate(admin, ids[5].id, `inj-${mode}`);
    const t = mode === 'candidate-2nd-batch' ? { injectCandidateAt: 1 } : { injectLedgerCreate: true };
    let err = null;
    try { await mods.newSvc.reconcileRecruiterRewards({ db: tap(conns[0].db, t) }); } catch (e) { err = e.code ?? e.message; }
    const locksRightAfter = (await advisoryLocks()).filter((l) => l.datname === clone);
    const next = await mods.newSvc.reconcileRecruiterRewards({ db: conns[1].db });
    const handler = await mods.adminH.recruiterRewardAdminHandlers({ db: conns[2].db }).reconcile(new Request('http://x/', { method: 'POST', body: JSON.stringify({ action: 'reconcile' }) }));
    inj.push({ mode, injectedError: err, advisoryLocksRightAfter: locksRightAfter.length, nextRunBusy: next.busy, nextRun: { checked: next.checked, awarded: next.awarded, reversed: next.reversed, batches: next.batches }, nextHandlerStatus: handler.status });
  }
  report.injected = inj;
  log('C5', JSON.stringify(inj));
  monitorOn = false;
  await monitor;
  await monClient.end();
  report.leaseMonitor = mon;
  for (const c of conns) await c.close();
  await sleep(1500);
  const stats1 = await tableStats(admin);
  const dl1 = await deadlocks(clone);
  const inv = await invariants(admin);
  const allNew = await newRows(admin, marks0);
  report.totalNewLedgerRows = allNew.ledger.length;
  report.totalNewAuditRows = allNew.audit.length;
  report.statsDelta = statsDelta(stats0, stats1);
  report.deadlocks = { before: dl0, after: dl1, delta: dl1.deadlocks - dl0.deadlocks };
  report.serverLog = logScan(lo);
  report.invariants = inv;
  await admin.end();
  report.advisoryLocksAfter = await advisoryLocks();
  report.checks = {
    leaseExactlyOneWhenConcurrent: lease.every((r) => r.ranPerRound.every((x) => x <= 1) && !r.workIntervalsOverlap),
    leaseMonitorMaxHolders1: mon.maxHolders <= 1 && mon.waiters === 0,
    walletPlusAdmin: c3.ok,
    noDeadlocks: report.deadlocks.delta === 0 && report.serverLog.deadlockDetected === 0,
    noUpdDel: report.statsDelta.recruiter_reward_ledger.upd === 0 && report.statsDelta.recruiter_reward_ledger.del === 0 && report.statsDelta.recruiter_audit_log.upd === 0 && report.statsDelta.recruiter_audit_log.del === 0,
    insertsMatchRows: report.statsDelta.recruiter_reward_ledger.ins === allNew.ledger.length,
    invariants: inv.ok,
    leaseReleasedAfterInjectedError: inj.every((x) => x.injectedError === 'P5D_INJECTED' && x.nextRunBusy === false && x.nextHandlerStatus === 200),
    noAdvisoryLocksAfter: report.advisoryLocksAfter.length === 0,
    noPaidAboveEarned: c4.recruitersPaidAboveNetEarned === 0,
  };
  report.ok = Object.values(report.checks).every(Boolean);
  await out('concurrency.jsonl', report);
  await dropDb(clone);
  console.log(JSON.stringify(report, null, 1));
}

// ── explain (10k) ────────────────────────────────────────────────────────────
async function explain() {
  const scale = opt('scale', '10k');
  const m = loadManifest(scale);
  const mods = await loadMods();
  const clone = `rec_5d_${scale}_explain`;
  await dropDb(clone);
  await cloneDb(TEMPLATES[scale], clone);
  const conn = await connect(clone, { sqlTrace: true, bytes: false, heap: false });
  // capture: full-scope (2 batches → first; a middle batch via its cursor) and rec_mixed's first batch
  const t = {};
  conn.rec.reset();
  const full = await mods.newSvc.reconcileRecruiterRewards({ db: tap(conn.db, t) });
  const text = conn.rec.texts.find((x) => x.includes(MARK));
  const mid = Math.floor(t.cand.length / 2);
  const t2 = {};
  await mods.newSvc.reconcileRecruiterRewards({ db: tap(conn.db, t2), recruiterId: rec(m, 'mixed') });
  await conn.close();
  const placeholders = Math.max(...[...text.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])));
  const cases = [
    { label: 'full-first-batch', vals: t.cand[0].vals },
    { label: `full-middle-batch-${mid + 1}-of-${t.cand.length}`, vals: t.cand[mid].vals },
    { label: 'rec_mixed-first-batch', vals: t2.cand[0].vals },
    // extra (not captured from a run: the rec_mixed binds with rec_empty's id) — worst case of the pkey keyset + recruiter filter
    { label: 'rec_empty-first-batch', vals: t2.cand[0].vals.map((v) => (v === rec(m, 'mixed') ? rec(m, 'empty') : v)) },
    // extra: full first batch with enable_seqscan = off (shows the settings pkey is usable; the 2-row table is seq-scanned by choice)
    { label: 'full-first-batch-seqscan-off', vals: t.cand[0].vals, settings: { enable_seqscan: 'off' } },
  ];
  writeFileSync(join(LOGS, 'candidate-statement.sql'), text);
  const res = { kind: 'explain', scale, fullRun: { batches: full.batches, checked: full.checked }, placeholders, binds: cases.map((c) => ({ label: c.label, vals: c.vals })), plans: [] };
  if (placeholders !== cases[0].vals.length) throw new Error(`placeholder count ${placeholders} vs binds ${cases[0].vals.length}`);
  for (const c of cases) {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const rows = await pgQuery(clone, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, c.vals, { settings: c.settings ?? null });
      runs.push(rows[0]['QUERY PLAN'][0]);
    }
    const textPlan = (await pgQuery(clone, `EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${text}`, c.vals, { settings: c.settings ?? null })).map((r) => r['QUERY PLAN']).join('\n');
    writeFileSync(join(LOGS, `explain-${scale}-${c.label}.txt`), textPlan);
    const last = runs[2];
    const nodes = [];
    const walk = (n) => { nodes.push(n); for (const k of n.Plans ?? []) walk(k); };
    walk(last.Plan);
    const scans = nodes.filter((n) => /Scan/.test(n['Node Type'])).map((n) => ({ type: n['Node Type'], rel: n['Relation Name'] ?? null, index: n['Index Name'] ?? null, loops: n['Actual Loops'], rows: n['Actual Rows'], removedByFilter: n['Rows Removed by Filter'] ?? null }));
    const uniq = [...new Map(scans.map((s) => [`${s.type}|${s.rel}|${s.index}`, s])).values()];
    res.plans.push({
      label: c.label, executionMs: runs.map((r) => r['Execution Time']), planningMs: runs.map((r) => r['Planning Time']), jit: last.JIT ?? null,
      sharedHit: last.Plan['Shared Hit Blocks'], sharedRead: last.Plan['Shared Read Blocks'], scans: uniq,
      seqScanOnOrdersOrLedger: scans.some((s) => s.type === 'Seq Scan' && ['affiliate_orders', 'recruiter_reward_ledger'].includes(s.rel)),
      seqScans: scans.filter((s) => s.type === 'Seq Scan').map((s) => s.rel), rowsOut: last.Plan['Actual Rows'],
    });
  }
  await out('explain.jsonl', res);
  await dropDb(clone);
  console.log(JSON.stringify(res, null, 1));
}

// ── measurements ─────────────────────────────────────────────────────────────
async function pgssDb(db) {
  // run IN the clone (the extension exists only there); its own entries are excluded by the tag
  const rows = await pgQuery(db, `/* p5d-pgss */ SELECT queryid::text q, toplevel, calls::bigint::text calls, rows::bigint::text rows, shared_blks_hit::bigint::text hit, shared_blks_read::bigint::text rd, total_exec_time t
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT LIKE '%p5d-pgss%'`);
  return new Map(rows.map((r) => [`${r.q}|${r.toplevel}`, { calls: Number(r.calls), rows: Number(r.rows), hit: Number(r.hit), rd: Number(r.rd), t: r.t, top: r.toplevel }]));
}
function pgssDiff(a, b) {
  const d = { calls: 0, rows: 0, hit: 0, read: 0, execMs: 0, topCalls: 0, topRows: 0 };
  for (const [k, v] of b) {
    const o = a.get(k) ?? { calls: 0, rows: 0, hit: 0, rd: 0, t: 0 };
    d.calls += v.calls - o.calls; d.rows += v.rows - o.rows; d.hit += v.hit - o.hit; d.read += v.rd - o.rd; d.execMs += v.t - o.t;
    if (v.top) { d.topCalls += v.calls - o.calls; d.topRows += v.rows - o.rows; }
  }
  d.execMs = r3(d.execMs);
  return d;
}
async function measured(conn, db, fn) {
  gc();
  const h0 = process.memoryUsage();
  const p0 = await pgssDb(db);
  const s = await conn.measure('m', fn);
  const h1 = process.memoryUsage();
  const p1 = await pgssDb(db);
  const sum = s.summary;
  const r = { wallMs: r3(s.wallMs), statements: sum.sqlStatements, begin: sum.sqlBegin, commit: sum.sqlCommit, transactions: sum.transactions, calls: sum.calls,
    heapPeakDelta: sum.heapPeak !== null ? sum.heapPeak - h0.heapUsed : null, heapDelta: h1.heapUsed - h0.heapUsed, rssDelta: h1.rss - h0.rss, pgss: pgssDiff(p0, p1), error: s.error, result: s.result };
  conn.rec.reset();
  return r;
}
async function benchFull() {
  const scale = opt('scale');
  const reps = Number(opt('reps', '5'));
  const m = loadManifest(scale);
  const mods = await loadMods();
  const K = scale === '1k' ? 40 : 800;
  const M = scale === '1k' ? 20 : 200;
  const impls = {
    old: (db) => runOld(mods, db),
    newAdmin: async (db) => { const r = await adminLoop(mods, db); return { awarded: r.awarded, reversed: r.reversed, checked: r.checked, calls: r.calls, batchMs: r.batches.map((b) => b.ms) }; },
    newService: async (db) => { const r = await mods.newSvc.reconcileRecruiterRewards({ db }); return { awarded: r.awarded, reversed: r.reversed, checked: r.checked, batches: r.batches, busy: r.busy }; },
  };
  // steady state, warm: one clone, all impls interleaved
  const clone = `rec_5d_${scale}_bench`;
  await dropDb(clone);
  await cloneDb(TEMPLATES[scale], clone);
  await pgQuery(clone, 'SELECT pg_stat_statements_reset()');
  const conn = await connect(clone, { bytes: false });
  const steady = Object.fromEntries(Object.keys(impls).map((k) => [k, []]));
  for (let w = 0; w < 3; w += 1) for (const [, f] of Object.entries(impls)) await f(conn.db);
  conn.rec.reset();
  for (let i = 0; i < reps; i += 1) {
    for (const [k, f] of Object.entries(impls)) {
      const r = await measured(conn, clone, f);
      steady[k].push(r);
      await out(`bench-full-${scale}.jsonl`, { kind: 'sample', scenario: 'steady', impl: k, i, ...r });
    }
  }
  await conn.close();
  await dropDb(clone);
  const summ = (xs) => ({ wallMs: summarize(xs.map((x) => x.wallMs)), statements: summarize(xs.map((x) => x.statements)), transactions: summarize(xs.map((x) => x.transactions)),
    pgssRows: summarize(xs.map((x) => x.pgss.rows)), pgssHitRead: summarize(xs.map((x) => x.pgss.hit + x.pgss.read)), heapPeakDelta: summarize(xs.map((x) => x.heapPeakDelta)), rssDelta: summarize(xs.map((x) => x.rssDelta)),
    result: xs[0]?.result });
  const res = { kind: 'bench-full', scale, reps, steady: Object.fromEntries(Object.entries(steady).map(([k, v]) => [k, summ(v)])), candidates: {} };
  res.steady.newAdmin.perBatchMs = summarize(steady.newAdmin.flatMap((x) => x.result.batchMs));
  res.steady.newAdmin.perBatchMax = Math.max(...steady.newAdmin.flatMap((x) => x.result.batchMs));
  // with candidates: fresh clone per rep (K approvals + M cancellations), warm read path, one measured run
  for (const k of ['old', 'newAdmin']) {
    const xs = [];
    for (let i = 0; i < reps; i += 1) {
      const cl = `rec_5d_${scale}_cand`;
      await dropDb(cl);
      await cloneDb(TEMPLATES[scale], cl);
      await pgQuery(cl, 'SELECT pg_stat_statements_reset()');
      const c = await connect(cl, { bytes: false });
      const admin = await adminClient(cl);
      for (let w = 0; w < 3; w += 1) await impls[k](c.db);
      c.rec.reset();
      const flips = { approved: await approveIdentities(admin, m.pools.P_AWARD.slice(0, K)), cancelled: await cancelOrders(admin, m.pools.P_REVERSE.slice(0, M).map((id) => m.pools.P_REVERSE_cancelOrderId[id])) };
      const r = await measured(c, cl, impls[k]);
      xs.push(r);
      await out(`bench-full-${scale}.jsonl`, { kind: 'sample', scenario: 'candidates', impl: k, i, flips, ...r });
      log('cand', k, i, r.wallMs, JSON.stringify({ a: r.result.awarded, v: r.result.reversed }));
      await c.close();
      await admin.end();
      await dropDb(cl);
    }
    res.candidates[k] = summ(xs);
    res.candidates[k].awardedReversed = xs.map((x) => [x.result.awarded, x.result.reversed]);
    if (k === 'newAdmin') { res.candidates[k].perBatchMs = summarize(xs.flatMap((x) => x.result.batchMs)); res.candidates[k].perBatchMax = Math.max(...xs.flatMap((x) => x.result.batchMs)); }
  }
  res.flips = { K, M };
  await out(`bench-full-${scale}.jsonl`, res);
  console.log(JSON.stringify(res, null, 1));
}
async function benchWallet() {
  const scale = opt('scale');
  const reps = Number(opt('reps', '5'));
  const m = loadManifest(scale);
  const mods = await loadMods();
  const clone = `rec_5d_${scale}_wallet`;
  await dropDb(clone);
  await cloneDb(TEMPLATES[scale], clone);
  await pgQuery(clone, 'SELECT pg_stat_statements_reset()');
  const admin = await adminClient(clone);
  const tvs = await tokenVersions(admin);
  await admin.end();
  const conn = await connect(clone, { bytes: false });
  const res = { kind: 'bench-wallet', scale, reps, rows: {} };
  for (const n of ['mixed', 'wide', 'deep']) {
    const rid = rec(m, n);
    const impls = { old: (db) => walletGet(mods.oldWallet, db, rid, tvs[rid]), new: (db) => walletGet(mods.newWallet, db, rid, tvs[rid]) };
    for (let w = 0; w < 3; w += 1) for (const f of Object.values(impls)) await f(conn.db);
    conn.rec.reset();
    const xs = { old: [], new: [] };
    for (let i = 0; i < reps; i += 1) {
      for (const [k, f] of Object.entries(impls)) {
        const r = await measured(conn, clone, f);
        xs[k].push(r);
        await out(`bench-wallet-${scale}.jsonl`, { kind: 'sample', recruiter: n, impl: k, i, ...r });
      }
    }
    res.rows[n] = Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, {
      wallMs: summarize(v.map((x) => x.wallMs)), statements: summarize(v.map((x) => x.statements)), syncTransactions: summarize(v.map((x) => x.transactions)),
      pgssRows: summarize(v.map((x) => x.pgss.rows)), pgssTopRows: summarize(v.map((x) => x.pgss.topRows)), pgssBlocks: summarize(v.map((x) => x.pgss.hit + x.pgss.read)),
      heapPeakDelta: summarize(v.map((x) => x.heapPeakDelta)), heapDelta: summarize(v.map((x) => x.heapDelta)), rssDelta: summarize(v.map((x) => x.rssDelta)),
      status: [...new Set(v.map((x) => x.result?.status))], bytes: [...new Set(v.map((x) => x.result?.bytes))],
    }]));
    log('wallet', n, JSON.stringify({ old: res.rows[n].old.wallMs.p50, new: res.rows[n].new.wallMs.p50 }));
  }
  await conn.close();
  await dropDb(clone);
  await out(`bench-wallet-${scale}.jsonl`, res);
  console.log(JSON.stringify(res, null, 1));
}

async function cleanup() {
  for (const c of await listClones()) if (c.startsWith('rec_5d_')) await dropDb(c);
  console.log(JSON.stringify({ clones: await listClones(), advisoryLocks: await advisoryLocks() }));
}

const CMDS = { 'prep-old': async () => console.log(JSON.stringify(prepOld())), equiv, 'equiv-compare': equivCompare, boundary, batching, concurrency, explain, 'bench-full': benchFull, 'bench-wallet': benchWallet, cleanup };
if (!CMDS[cmd]) { console.error(`usage: ${Object.keys(CMDS).join(' | ')}`); process.exit(2); }
try { await CMDS[cmd](); process.exit(0); } catch (e) { console.error('FAILED', e?.stack ?? e); process.exit(1); }
