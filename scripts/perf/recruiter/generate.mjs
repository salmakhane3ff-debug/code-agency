#!/usr/bin/env node
/**
 * scripts/perf/recruiter/generate.mjs — DRIVER of the Phase 6 Part 5a dataset generator.
 *
 *   build     --scale 1k|10k|100k [--force]  CREATE DATABASE p5a_<scale> TEMPLATE p5a_base, run
 *             sql/00…85 (timed per step), compute the manifest, validate every invariant and
 *             cross-check the manifest, finalize (sql/90: drop the helper schema p5a_gen, CREATE
 *             EXTENSION pg_stat_statements, VACUUM (ANALYZE)), check zero drift, then lock the
 *             template (IS_TEMPLATE true, ALLOW_CONNECTIONS false). --force rebuilds a template.
 *   check-build --scale …   read-only manifest + validation of a loaded but NOT finalized template
 *             (an interrupted build: p5a_gen still present). Writes nothing.
 *   validate  --scale …   clone val_<scale>, re-run the SQL validations against the manifest, drop.
 *   reconcile --scale … [--flip]   clone val_<scale>, run the REAL reconcileRecruiterRewards({ db })
 *             (all recruiters) through a PrismaPg client: must award 0 / reverse 0; with --flip it
 *             then approves 3 P_AWARD identities and cancels one real delivered order of 2
 *             P_REVERSE members and must award exactly 3 / reverse exactly 2, then 0 / 0 again.
 *   drift     --db <clone or p5a_base>   prisma migrate diff against prisma/schema.prisma.
 *   selftest  [--db val_1k]   the lib.mjs self-test.
 *
 * SAFETY GUARD: every database access goes through lib.mjs (assertDisposableUrl: only
 * postgresql://postgres@localhost:55510/<db>?host=/tmp/p5a-pg/sock). It only creates / drops
 * p5a_<scale> templates (build) and val_ clones; the Prisma CLI runs from the scratch work dir with
 * DATABASE_URL set to the disposable URL in its own environment and refuses when a .env exists.
 * No repository file is written; outputs go to the scratch results / logs / manifests dirs.
 * Progress lines go to stderr; stdout carries only the command's JSON result.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BASE_DB, LOGS_DIR, MANIFESTS_DIR, PERF_DIR, REPO, SCALES, TEMPLATES, WORK_DIR, appendResult, assertDisposableUrl, cloneDb,
  clusterReady, connect, databaseSize, dbUrl, dropDb, environment, freeDiskBytes, importService, listDatabases, loadManifest, now,
  pgQuery, psqlFile, runSelfTest, scaleKey,
} from './lib.mjs';

const SQL_DIR = join(PERF_DIR, 'sql');
const BUILD_STEPS = ['00_helpers', '10_plan', '20_recruiters', '30_affiliates_links', '31_affiliates_update', '40_identity', '50_orders',
  '60_ledger', '70_payouts', '80_audit', '85_analyze'];
const SHAPES = ['mixed', 'wide', 'deep'];
const UUID4_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const RELEASING = ['rejected', 'cancelled', 'canceled', 'refused']; // PAYOUT_RELEASING_STATUSES
const COUNT_TABLES = ['recruiters', 'recruiter_identity_verifications', 'recruiter_settings_versions', 'affiliates', 'recruiter_affiliate_links',
  'identity_verifications', 'affiliate_orders', 'recruiter_reward_ledger', 'recruiter_audit_log', 'affiliate_payouts',
  'affiliate_activation_codes', 'affiliate_activation_recoveries', 'orders', 'users'];
const EXPECTED_USER_TRIGGERS = 18;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
// progress goes to stderr; stdout carries only the command's JSON result
const log = (...xs) => console.error(new Date().toISOString().slice(11, 19), ...xs);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const round = (x, d = 3) => (x === null || x === undefined ? x : Math.round(x * 10 ** d) / 10 ** d);
const pct = (a, b) => (b ? round((100 * a) / b, 2) : null);

// ── network tree (mirrors loadNetworkTree of recruiterNetworkService.js) ─────
function buildTree(members) {
  const nodes = new Map(members.map((m) => [m.id, { id: m.id, parentId: m.parentId, createdAt: m.createdAt, depth: null, children: [] }]));
  const kids = new Map();
  for (const n of nodes.values()) {
    if (n.parentId && nodes.has(n.parentId)) {
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId).push(n);
    }
  }
  const byCreated = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const roots = [...nodes.values()].filter((n) => !n.parentId || !nodes.has(n.parentId)).sort(byCreated);
  for (const r of roots) r.depth = 1;
  let frontier = roots;
  let maxDepth = roots.length ? 1 : 0;
  while (frontier.length) {
    const next = [];
    for (const n of frontier) {
      for (const c of kids.get(n.id) ?? []) {
        if (c.depth !== null) continue;
        c.depth = n.depth + 1;
        n.children.push(c);
        next.push(c);
      }
    }
    if (next.length) maxDepth = next[0].depth;
    frontier = next;
  }
  for (const n of nodes.values()) n.children.sort(byCreated);
  const placed = [...nodes.values()].filter((n) => n.depth !== null);
  const desc = new Map();
  for (const n of [...placed].sort((a, b) => b.depth - a.depth)) {
    let c = 0;
    for (const ch of n.children) c += 1 + desc.get(ch.id);
    desc.set(n.id, c);
  }
  const unplaced = [...nodes.values()].filter((n) => n.depth === null).sort(byCreated);
  return { nodes, roots, placed, unplaced, desc, maxDepth };
}

const nodeInfo = (t, n) => (n ? { id: n.id, depth: n.depth, childrenCount: n.children.length, descendantsCount: t.desc.get(n.id),
  childPages50: Math.ceil(n.children.length / 50), firstChildId: n.children[0]?.id ?? null } : null);

function treeManifest(shape, t, scale) {
  // first maximum in creation order (t.placed / t.roots follow ORDER BY "createdAt", id) — deterministic
  const byMax = (arr, f) => arr.reduce((best, n) => (best === null || f(n) > f(best) ? n : best), null);
  const atDepth = (d) => t.placed.filter((n) => n.depth === d);
  const mid = Math.max(1, Math.round(t.maxDepth / 2));
  let branch = null;
  for (let delta = 0; delta <= t.maxDepth && !branch; delta += 1) {
    for (const d of [mid + delta, mid - delta]) {
      if (branch || d < 1 || d > t.maxDepth) continue;
      const cands = atDepth(d).filter((n) => n.children.length > 0);
      if (cands.length) branch = byMax(cands, (n) => n.children.length * 1e9 + t.desc.get(n.id));
    }
  }
  const nonRoots = t.placed.filter((n) => n.depth >= 2);
  const out = {
    members: t.nodes.size, placed: t.placed.length, unplaced: t.unplaced.length, unplacedIds: t.unplaced.map((n) => n.id),
    roots: t.roots.length, maxDepth: t.maxDepth,
    pageCursors: { pageDefault: 50, pageMax: 100, rootsCount: t.roots.length, rootPages50: Math.ceil(t.roots.length / 50), rootPages100: Math.ceil(t.roots.length / 100) },
    firstRootId: t.roots[0]?.id ?? null,
    branchNode: { ...nodeInfo(t, branch), note: `node with the most children at the depth nearest to maxDepth/2 (${mid})` },
    largestSubtreeRoot: nodeInfo(t, byMax(t.roots, (n) => t.desc.get(n.id))),
    largestSubtreeNonRoot: nodeInfo(t, byMax(nonRoots, (n) => t.desc.get(n.id))),
    topFanOutNode: nodeInfo(t, byMax(t.placed, (n) => n.children.length)),
    deepestNode: nodeInfo(t, byMax(t.placed, (n) => n.depth)),
  };
  if (shape === 'mixed') {
    const hist = {};
    for (const n of t.placed) hist[n.depth] = (hist[n.depth] ?? 0) + 1;
    out.depthHistogram = hist;
    const firstAt = {};
    for (const n of [...t.placed].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) if (!(n.depth in firstAt)) firstAt[n.depth] = n.id;
    out.firstNodeAtDepth = firstAt;
    const fan = t.placed.map((n) => n.children.length).filter((c) => c > 0).sort((a, b) => a - b);
    out.fanOut = { nodesWithChildren: fan.length, max: fan[fan.length - 1] ?? 0, median: fan[Math.floor(fan.length / 2)] ?? 0 };
  }
  if (shape === 'deep') {
    const byDepth = new Map(t.placed.map((n) => [n.depth, n]));
    const samples = {};
    for (const d of [10, 100, 1000, 10000, scale - 1, scale]) if (byDepth.has(d)) samples[d] = nodeInfo(t, byDepth.get(d));
    out.chainSamples = samples;
    out.chainSamplesNote = 'keys = depth; S-1 has exactly one child, S is the leaf';
  }
  if (shape === 'wide') out.wideRoot = nodeInfo(t, t.roots[0]);
  return out;
}

async function loadMembers(db, recruiterId) {
  const rows = await pgQuery(db, `SELECT a.id, a."parentId", (extract(epoch FROM a."createdAt") * 1000)::bigint AS ms
    FROM recruiter_affiliate_links l JOIN affiliates a ON a.id = l."affiliateId" WHERE l."recruiterId" = $1
    ORDER BY a."createdAt", a.id`, [recruiterId]); // ordered input → every tie below resolves to the earliest-created node
  return rows.map((r) => ({ id: r.id, parentId: r.parentId, createdAt: Number(r.ms) }));
}

/**
 * Session-local planner settings for the validation's RECURSIVE tree queries only: with the default
 * planner the deep chain gets a quadratic merge-join plan (observed: 120 s for the 10k-deep chain),
 * so these checks force nested loops (linear). The cluster configuration is not changed.
 */
const NESTED_LOOPS = Object.freeze({ enable_mergejoin: 'off', enable_hashjoin: 'off' });
/**
 * …and the opposite for the big aggregate checks that join materialized CTEs: their row estimates
 * are far too low at 100k (e.g. 245 vs 71 925 open rewards), which led to a nested loop over a
 * 215k-row CTE scan (> 5 min); hash joins make them a few seconds.
 */
const HASH_JOINS = Object.freeze({ enable_nestloop: 'off' });

/** The service's own recursive network query (recruiterNetworkService.loadNetworkTree) → { reached, maxDepth, roots }. */
async function serviceTreeStats(db, recruiterId) {
  const [r] = await pgQuery(db, `WITH RECURSIVE tree AS (
      SELECT a."id", a."parentId", 1 AS depth FROM "recruiter_affiliate_links" l JOIN "affiliates" a ON a."id" = l."affiliateId"
      WHERE l."recruiterId" = $1 AND (a."parentId" IS NULL OR NOT EXISTS (
        SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = a."parentId" AND pl."recruiterId" = $1))
      UNION ALL
      SELECT c."id", c."parentId", t.depth + 1 FROM tree t JOIN "affiliates" c ON c."parentId" = t."id"
      JOIN "recruiter_affiliate_links" cl ON cl."affiliateId" = c."id" AND cl."recruiterId" = $1
      WHERE t.depth < $2::int)
    SELECT count(*)::int AS reached, coalesce(max(depth), 0)::int AS max_depth, count(*) FILTER (WHERE depth = 1)::int AS roots FROM tree`,
  [recruiterId, 10000000], { settings: NESTED_LOOPS });
  return { reached: r.reached, maxDepth: r.max_depth, roots: r.roots };
}

// ── validations (app tables only; pools / tree from the manifest) ────────────
async function validate(db, manifest, { plan = false } = {}) {
  const checks = [];
  let tPrev = now();
  const check = (name, ok, detail = null) => {
    const t = now();
    checks.push({ name, ok: !!ok, ms: round(t - tPrev, 1), detail });
    tPrev = t;
    if (!ok) log('  FAIL', name, JSON.stringify(detail).slice(0, 400));
  };
  const q = (sql, params = [], settings = null) => pgQuery(db, sql, params, { settings });
  const S = manifest.scale;
  const U = Math.max(2, S / 1000);
  const rec = manifest.recruiters;

  const counts = {};
  for (const t of COUNT_TABLES) counts[t] = Number((await q(`SELECT count(*)::bigint AS n FROM "${t}"`))[0].n);
  check('row-counts', counts.recruiters === 4 && counts.affiliates === 3 * S + U && counts.recruiter_affiliate_links === 3 * S + U
    && counts.recruiter_settings_versions === 2 && counts.recruiter_identity_verifications === 4, counts);

  const [trg] = await q(`SELECT count(*) FILTER (WHERE NOT tgisinternal)::int AS n, count(*) FILTER (WHERE NOT tgisinternal AND tgenabled <> 'O')::int AS disabled FROM pg_trigger`);
  check('triggers-enabled', trg.n === EXPECTED_USER_TRIGGERS && trg.disabled === 0, trg);

  const recRows = await q(`SELECT r.username, r.id, r."isActive", r."canViewOrders", r."canCreateAffiliates", r."bankName", r.rib, r."accountName",
      v.status, v.submission, v."reviewedBy", v."reviewedAt", v."approvedAt", v."cinFrontFile", v."cinBackFile",
      (SELECT count(*)::int FROM recruiter_affiliate_links l WHERE l."recruiterId" = r.id) AS members
    FROM recruiters r LEFT JOIN recruiter_identity_verifications v ON v."recruiterId" = r.id ORDER BY r."createdAt"`);
  check('recruiters-active-permissions-bank', recRows.every((r) => r.isActive && r.canViewOrders && r.canCreateAffiliates && r.bankName && r.rib?.length >= 10 && r.accountName),
    recRows.map((r) => r.username));
  check('recruiter-kyc-approved', recRows.every((r) => r.status === 'APPROVED' && r.submission === 1 && r.reviewedBy && r.reviewedAt && r.approvedAt
    && /^[0-9a-f-]{36}\.jpg$/.test(r.cinFrontFile) && r.cinFrontFile !== r.cinBackFile), recRows.map((r) => ({ u: r.username, s: r.status })));
  const memberBy = Object.fromEntries(recRows.map((r) => [r.username, r.members]));
  check('members-per-recruiter', memberBy.rec_mixed === S + U && memberBy.rec_wide === S && memberBy.rec_deep === S && memberBy.rec_empty === 0, memberBy);

  const [lg] = await q(`WITH s AS (
      SELECT "affiliateId" a, count(*) FILTER (WHERE type = 'RECRUIT_REWARD') nr, max(cycle) FILTER (WHERE type = 'RECRUIT_REWARD') mr,
             count(*) FILTER (WHERE type = 'REVERSAL') nv, coalesce(max(cycle) FILTER (WHERE type = 'REVERSAL'), 0) mv
      FROM recruiter_reward_ledger WHERE type IN ('RECRUIT_REWARD', 'REVERSAL') GROUP BY 1)
    SELECT count(*)::int AS affiliates, count(*) FILTER (WHERE nr <> mr OR nr IS NULL)::int AS reward_cycle_gaps,
           count(*) FILTER (WHERE nv <> mv)::int AS reversal_cycle_gaps, count(*) FILTER (WHERE mv < mr - 1 OR mv > mr)::int AS alternation_violations,
           count(*) FILTER (WHERE mv = mr - 1)::int AS open_cycles, count(*) FILTER (WHERE mv = mr)::int AS only_closed,
           count(*) FILTER (WHERE mv = mr - 1 AND mv > 0)::int AS closed_then_open, max(mr)::int AS max_cycle FROM s`);
  check('ledger-cycles-consecutive-alternating', lg.reward_cycle_gaps === 0 && lg.reversal_cycle_gaps === 0 && lg.alternation_violations === 0, lg);
  const [pairs] = await q(`SELECT count(*)::int AS bad FROM recruiter_reward_ledger v
    LEFT JOIN recruiter_reward_ledger r ON r."affiliateId" = v."affiliateId" AND r.cycle = v.cycle AND r.type = 'RECRUIT_REWARD'
    WHERE v.type = 'REVERSAL' AND (r.id IS NULL OR r."recruiterId" <> v."recruiterId" OR v."amountCents" <> -r."amountCents"
      OR v."createdAt" <= r."createdAt" OR v."settingsVersion" IS DISTINCT FROM r."settingsVersion")`);
  const [order] = await q(`SELECT count(*)::int AS bad FROM recruiter_reward_ledger r2 JOIN recruiter_reward_ledger v1
      ON v1."affiliateId" = r2."affiliateId" AND v1.cycle = r2.cycle - 1 AND v1.type = 'REVERSAL'
    WHERE r2.type = 'RECRUIT_REWARD' AND r2.cycle > 1 AND r2."createdAt" <= v1."createdAt"`);
  check('ledger-reversal-matches-reward-and-time-order', pairs.bad === 0 && order.bad === 0, { badPairs: pairs.bad, badOrder: order.bad });
  const [lnk] = await q(`SELECT count(*)::int AS bad FROM recruiter_reward_ledger l LEFT JOIN recruiter_affiliate_links k ON k."affiliateId" = l."affiliateId"
    WHERE l."affiliateId" IS NOT NULL AND k."recruiterId" IS DISTINCT FROM l."recruiterId"`);
  check('ledger-link-guard', lnk.bad === 0, lnk);
  const [ver] = await q(`SELECT count(*)::int AS bad FROM recruiter_reward_ledger l JOIN recruiter_settings_versions s ON s.version = l."settingsVersion"
    WHERE l.type = 'RECRUIT_REWARD' AND (l."amountCents" <> s."rewardAmountCents" OR l."createdAt" < s."createdAt"
      OR EXISTS (SELECT 1 FROM recruiter_settings_versions n WHERE n.version > s.version AND n."createdAt" <= l."createdAt"))`);
  check('ledger-reward-uses-version-current-at-its-time', ver.bad === 0, ver);
  const [keys] = await q(`SELECT count(*) FILTER (WHERE "idempotencyKey" !~ ':v[0-9]+$')::int AS legacy, count(*)::int AS total,
      count(*) FILTER (WHERE type = 'RECRUIT_REWARD')::int AS rewards, count(*) FILTER (WHERE type = 'REVERSAL')::int AS reversals,
      count(*) FILTER (WHERE "actorType" <> 'SYSTEM' OR "actorId" IS NOT NULL)::int AS non_system,
      count(*) FILTER (WHERE "idempotencyKey" <> CASE type WHEN 'RECRUIT_REWARD' THEN 'recruit:' ELSE 'reverse:' END || "affiliateId"
                        || CASE WHEN "idempotencyKey" ~ ':v[0-9]+$' THEN ':v' || cycle ELSE '' END)::int AS bad_keys,
      count(*) FILTER (WHERE "idempotencyKey" !~ ':v[0-9]+$' AND cycle <> 1)::int AS legacy_not_cycle1
    FROM recruiter_reward_ledger`);
  check('ledger-keys-per-20261110', keys.bad_keys === 0 && keys.legacy_not_cycle1 === 0 && keys.non_system === 0, keys);
  const [seqOrder] = await q(`SELECT count(*)::int AS inversions FROM (SELECT "createdAt", lag("createdAt") OVER (ORDER BY seq) AS prev FROM recruiter_reward_ledger) x WHERE "createdAt" < prev`);
  check('ledger-seq-follows-time', seqOrder.inversions === 0, seqOrder);

  const [steady] = await q(`WITH cyc AS (
      SELECT "affiliateId" a, max(cycle) FILTER (WHERE type = 'RECRUIT_REWARD') mr, coalesce(max(cycle) FILTER (WHERE type = 'REVERSAL'), 0) mv
      FROM recruiter_reward_ledger WHERE type IN ('RECRUIT_REWARD', 'REVERSAL') GROUP BY 1),
    open AS (SELECT c.a, l."settingsVersion" v FROM cyc c JOIN recruiter_reward_ledger l ON l."affiliateId" = c.a AND l.type = 'RECRUIT_REWARD' AND l.cycle = c.mr WHERE c.mr > c.mv),
    rd AS (SELECT "affiliateId" a, count(*) n FROM affiliate_orders WHERE status = 'delivered' AND NOT "isFake" GROUP BY 1),
    cur AS (SELECT * FROM recruiter_settings_versions ORDER BY version DESC LIMIT 1)
    SELECT (SELECT count(*)::int FROM open o JOIN recruiter_settings_versions s ON s.version = o.v LEFT JOIN rd ON rd.a = o.a
            WHERE coalesce(rd.n, 0) < s."minDeliveredSales") AS pending_reversals,
           (SELECT count(*)::int FROM recruiter_affiliate_links k LEFT JOIN open o ON o.a = k."affiliateId" LEFT JOIN rd ON rd.a = k."affiliateId"
              LEFT JOIN identity_verifications i ON i."affiliateId" = k."affiliateId" CROSS JOIN cur
            WHERE o.a IS NULL AND cur.enabled AND cur."rewardAmountCents" > 0 AND coalesce(rd.n, 0) >= cur."minDeliveredSales" AND i.status = 'APPROVED') AS pending_awards,
           (SELECT count(*)::int FROM open) AS open_rewards,
           (SELECT count(*)::int FROM open WHERE v = 1) AS open_v1, (SELECT count(*)::int FROM open WHERE v = 2) AS open_v2,
           (SELECT count(*)::int FROM open o JOIN rd ON rd.a = o.a WHERE o.v = 1 AND rd.n BETWEEN 3 AND 4) AS open_v1_with_3_or_4_delivered`, [], HASH_JOINS);
  check('steady-state-sql', steady.pending_awards === 0 && steady.pending_reversals === 0, steady);

  const poolRows = async (ids) => q(`WITH ids AS (SELECT unnest($1::text[]) AS id),
      rd AS (SELECT "affiliateId" a, count(*)::int n FROM affiliate_orders WHERE "affiliateId" = ANY($1) AND status = 'delivered' AND NOT "isFake" GROUP BY 1),
      lg AS (SELECT "affiliateId" a, max(cycle) FILTER (WHERE type = 'RECRUIT_REWARD') mr, coalesce(max(cycle) FILTER (WHERE type = 'REVERSAL'), 0) mv
             FROM recruiter_reward_ledger WHERE "affiliateId" = ANY($1) GROUP BY 1),
      op AS (SELECT l."affiliateId" a, l."settingsVersion" v FROM recruiter_reward_ledger l JOIN lg ON lg.a = l."affiliateId" AND l.type = 'RECRUIT_REWARD' AND l.cycle = lg.mr WHERE lg.mr > lg.mv)
    SELECT ids.id, i.status, coalesce(rd.n, 0) AS rd, op.v AS open_version, k."recruiterId" AS recruiter, coalesce(lg.mr, 0) AS reward_cycles
    FROM ids LEFT JOIN identity_verifications i ON i."affiliateId" = ids.id LEFT JOIN rd ON rd.a = ids.id LEFT JOIN op ON op.a = ids.id
      LEFT JOIN lg ON lg.a = ids.id LEFT JOIN recruiter_affiliate_links k ON k."affiliateId" = ids.id`, [ids], HASH_JOINS);
  const award = await poolRows(manifest.pools.P_AWARD);
  const reverse = await poolRows(manifest.pools.P_REVERSE);
  const unplacedMixed = new Set(manifest.shapes.mixed.unplacedIds);
  const wantA = S === 1000 ? 40 : 1100;
  const wantR = S === 1000 ? 20 : 500;
  check('pool-award', award.length === wantA && new Set(manifest.pools.P_AWARD).size === wantA
    && award.every((r) => r.status === 'PENDING' && r.rd === 5 && r.open_version === null && r.recruiter === rec.mixed.id && !unplacedMixed.has(r.id)),
  { size: award.length, withClosedCycles: award.filter((r) => r.reward_cycles > 0).length, bad: award.filter((r) => !(r.status === 'PENDING' && r.rd === 5 && r.open_version === null)).slice(0, 5) });
  check('pool-reverse', reverse.length === wantR && new Set(manifest.pools.P_REVERSE).size === wantR
    && reverse.every((r) => r.status === 'APPROVED' && r.rd === 5 && r.open_version === 2 && r.recruiter === rec.mixed.id && !unplacedMixed.has(r.id)),
  { size: reverse.length, afterClosedCycles: reverse.filter((r) => r.reward_cycles > 1).length, bad: reverse.filter((r) => !(r.status === 'APPROVED' && r.rd === 5 && r.open_version === 2)).slice(0, 5) });
  const overlap = manifest.pools.P_AWARD.filter((id) => manifest.pools.P_REVERSE.includes(id)).length;
  check('pools-disjoint', overlap === 0, { overlap });
  const revOrders = await q(`SELECT o.id, o."affiliateId", o.status, o."isFake" FROM affiliate_orders o WHERE o.id = ANY($1)`, [Object.values(manifest.pools.P_REVERSE_cancelOrderId)]);
  check('pool-reverse-cancel-orders', revOrders.length === wantR && revOrders.every((o) => o.status === 'delivered' && !o.isFake && manifest.pools.P_REVERSE_cancelOrderId[o.affiliateId] === o.id), { found: revOrders.length });

  const wallet = await q(`SELECT r.username, r.id,
      coalesce((SELECT sum("amountCents") FROM recruiter_reward_ledger WHERE "recruiterId" = r.id), 0)::bigint AS earned,
      coalesce((SELECT sum(round((amount * 100)::numeric)) FROM affiliate_payouts WHERE "recruiterId" = r.id AND status <> ALL($1)), 0)::bigint AS reserved,
      coalesce((SELECT sum(round((amount * 100)::numeric)) FROM affiliate_payouts WHERE "recruiterId" = r.id AND status = 'paid'), 0)::bigint AS paid,
      (SELECT count(*) FROM affiliate_payouts WHERE "recruiterId" = r.id)::int AS withdrawals,
      (SELECT count(*) FROM affiliate_payouts WHERE "recruiterId" = r.id AND status = 'pending')::int AS pending
    FROM recruiters r ORDER BY r."createdAt"`, [RELEASING]);
  const W = Math.max(20, S / 50);
  check('wallets-consistent', wallet.every((w) => Number(w.reserved) <= Number(w.earned) && Number(w.paid) <= Number(w.earned))
    && wallet.filter((w) => w.username !== 'rec_empty').every((w) => w.withdrawals === W && Number(w.earned) - Number(w.reserved) > 0)
    && wallet.find((w) => w.username === 'rec_empty').withdrawals === 0, wallet);
  const [pay] = await q(`SELECT count(*) FILTER (WHERE ("affiliateId" IS NULL) = ("recruiterId" IS NULL))::int AS bad_owner,
      count(*) FILTER (WHERE "recruiterId" IS NOT NULL)::int AS recruiter_rows, count(*) FILTER (WHERE "affiliateId" IS NOT NULL)::int AS affiliate_rows,
      count(*) FILTER (WHERE "recruiterId" IS NOT NULL AND abs(amount * 100 - round((amount * 100)::numeric)::float8) >= 0.000001)::int AS bad_cents
    FROM affiliate_payouts`);
  check('payouts-owner-and-cents', pay.bad_owner === 0 && pay.bad_cents === 0 && pay.affiliate_rows > 0, pay);

  const ids = await q(`SELECT coalesce(status, 'NONE') AS s, count(*)::int AS n FROM affiliates a LEFT JOIN identity_verifications i ON i."affiliateId" = a.id GROUP BY 1`);
  const idMap = Object.fromEntries(ids.map((r) => [r.s, pct(r.n, counts.affiliates)]));
  check('identity-distribution', Math.abs(idMap.APPROVED - 40) < 2.5 && Math.abs(idMap.PENDING - 15) < 2.5 && Math.abs(idMap.REJECTED - 10) < 2.5 && Math.abs(idMap.NONE - 35) < 2.5, idMap);
  const [act] = await q(`SELECT count(*) FILTER (WHERE "isActive")::int AS active, count(*)::int AS n, (count(*) - count(DISTINCT "createdAt"))::int AS created_ties,
      (SELECT count(*)::int FROM recruiter_affiliate_links l JOIN affiliates a2 ON a2.id = l."affiliateId" WHERE l."createdAt" <> a2."createdAt") AS link_time_mismatch
    FROM affiliates`);
  check('affiliates-active-and-created-order', Math.abs(pct(act.active, act.n) - 70) < 4 && act.created_ties === 0 && act.link_time_mismatch === 0,
    { activePct: pct(act.active, act.n), createdTies: act.created_ties, linkTimeMismatch: act.link_time_mismatch });
  const [ord] = await q(`SELECT count(*)::bigint AS n, avg(c)::float8 AS avg, min(c)::int AS min, max(c)::int AS max,
      count(*) FILTER (WHERE c = 0)::int AS zero, count(*) FILTER (WHERE c >= 5)::int AS five_plus
    FROM (SELECT a.id, count(o.id) c FROM affiliates a LEFT JOIN affiliate_orders o ON o."affiliateId" = a.id GROUP BY a.id) x`, [], HASH_JOINS);
  const statuses = await q(`SELECT status, "isFake" AS fake, count(*)::int AS n FROM affiliate_orders GROUP BY 1, 2 ORDER BY 1, 2`);
  const totalOrders = statuses.reduce((a, r) => a + r.n, 0);
  const fake = statuses.filter((r) => r.fake).reduce((a, r) => a + r.n, 0);
  const statusSet = new Set(statuses.map((r) => r.status));
  const [shared] = await q(`SELECT count(*)::int AS shared_fake_real, (SELECT count(DISTINCT "orderId")::int FROM affiliate_orders) AS distinct_order_ids
    FROM (SELECT "orderId" FROM affiliate_orders GROUP BY 1 HAVING count(*) > 1 AND bool_or("isFake") AND bool_or(NOT "isFake")) x`);
  check('orders-distribution', ord.avg > 3 && ord.avg < 6.5 && ord.min === 0 && ord.max <= 15 && Math.abs(pct(fake, totalOrders) - 10) < 4
    && ['delivered', 'pending', 'confirmed', 'shipped', 'cancelled', 'canceled', 'returned', 'refused', 'Delivered', 'on_hold'].every((s) => statusSet.has(s))
    && shared.shared_fake_real > 0,
  { perAffiliate: { avg: round(ord.avg, 3), min: ord.min, max: ord.max, zero: ord.zero, fivePlus: ord.five_plus }, total: totalOrders, fakePct: pct(fake, totalOrders),
    statuses: Object.fromEntries(statuses.map((r) => [`${r.status}${r.fake ? ' (fake)' : ''}`, r.n])), ...shared });

  const audit = await q(`SELECT action, count(*)::int AS n FROM recruiter_audit_log GROUP BY 1 ORDER BY 1`);
  const A = Object.fromEntries(audit.map((r) => [r.action, r.n]));
  const [aud] = await q(`SELECT count(*) FILTER (WHERE action = 'AFFILIATE_CREATED' AND (details->>'requestId' !~ $1 OR details->'activationCodeId' <> 'null'::jsonb
        OR NOT details ? 'parentId' OR details->>'username' IS NULL OR "actorType" <> 'RECRUITER' OR "actorId" <> "recruiterId"))::int AS bad_created,
      count(*) FILTER (WHERE action = 'RECRUITER_WITHDRAWAL_REQUESTED' AND details->>'requestId' !~ $1)::int AS bad_withdrawal_request,
      (SELECT count(*)::int FROM (SELECT "createdAt", lag("createdAt") OVER (ORDER BY seq) AS prev FROM recruiter_audit_log) x WHERE "createdAt" < prev) AS seq_inversions
    FROM recruiter_audit_log`, [UUID4_RE]);
  check('audit-log', A.AFFILIATE_CREATED === counts.affiliates && A.RECRUIT_REWARD_EARNED === keys.rewards && (A.RECRUIT_REWARD_REVERSED ?? 0) === keys.reversals
    && A.RECRUITER_WITHDRAWAL_REQUESTED === pay.recruiter_rows && aud.bad_created === 0 && aud.bad_withdrawal_request === 0 && aud.seq_inversions === 0,
  { actions: A, ...aud });

  const tree = {};
  for (const shape of SHAPES) tree[shape] = await serviceTreeStats(db, rec[shape].id);
  check('network-service-query-matches-manifest', SHAPES.every((s) => tree[s].reached === manifest.shapes[s].placed && tree[s].maxDepth === manifest.shapes[s].maxDepth
    && tree[s].roots === manifest.shapes[s].roots), tree);
  const unp = await q(`SELECT a.id, a."parentId", p."parentId" AS grand FROM affiliates a JOIN affiliates p ON p.id = a."parentId" WHERE a.id = ANY($1)`, [manifest.shapes.mixed.unplacedIds]);
  check('unplaced-2-cycles', unp.length === U && unp.every((r) => r.grand === r.id), { count: unp.length });
  const branch = manifest.shapes.mixed.branchNode;
  const [bc] = await q(`SELECT count(*)::int AS n FROM affiliates a JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id AND l."recruiterId" = $2 WHERE a."parentId" = $1`, [branch.id, rec.mixed.id]);
  check('branch-node-has-children', bc.n === branch.childrenCount && bc.n > 0, { id: branch.id, depth: branch.depth, children: bc.n });
  const subtree = async (id, recruiterId) => (await pgQuery(db, `WITH RECURSIVE s AS (SELECT a.id FROM affiliates a JOIN recruiter_affiliate_links l ON l."affiliateId" = a.id AND l."recruiterId" = $2 WHERE a."parentId" = $1
      UNION ALL SELECT c.id FROM s JOIN affiliates c ON c."parentId" = s.id JOIN recruiter_affiliate_links l ON l."affiliateId" = c.id AND l."recruiterId" = $2)
    SELECT count(*)::int AS n FROM s`, [id, recruiterId], { settings: NESTED_LOOPS }))[0].n;
  const sub = {};
  for (const shape of SHAPES) {
    const m = manifest.shapes[shape];
    sub[shape] = { largestRoot: await subtree(m.largestSubtreeRoot.id, rec[shape].id), expected: m.largestSubtreeRoot.descendantsCount };
    if (m.largestSubtreeNonRoot) Object.assign(sub[shape], { largestNonRoot: await subtree(m.largestSubtreeNonRoot.id, rec[shape].id), expectedNonRoot: m.largestSubtreeNonRoot.descendantsCount });
  }
  check('subtree-sizes', SHAPES.every((s) => sub[s].largestRoot === sub[s].expected && (sub[s].largestNonRoot === undefined || sub[s].largestNonRoot === sub[s].expectedNonRoot)), sub);
  const deep = manifest.shapes.deep.chainSamples;
  const deepIds = Object.values(deep).map((x) => x.id);
  const deepRows = await q(`SELECT a.id, (SELECT count(*)::int FROM affiliates c WHERE c."parentId" = a.id) AS children FROM affiliates a WHERE a.id = ANY($1)`, [deepIds]);
  check('deep-chain-samples', deepRows.length === deepIds.length && Object.entries(deep).every(([d, x]) => Number(d) === x.depth
    && deepRows.find((r) => r.id === x.id)?.children === (Number(d) === S ? 0 : 1)), Object.fromEntries(Object.entries(deep).map(([d, x]) => [d, x.id])));

  if (plan) {
    const [pc] = await q(`SELECT
        (SELECT count(*)::int FROM p5a_gen.plan p LEFT JOIN (SELECT "affiliateId", count(*) n FROM affiliate_orders WHERE status = 'delivered' AND NOT "isFake" GROUP BY 1) d
           ON d."affiliateId" = p.id WHERE coalesce(d.n, 0) <> p.rd) AS rd_mismatch,
        (SELECT count(*)::int FROM p5a_gen.plan p LEFT JOIN (SELECT "affiliateId", count(*) n FROM affiliate_orders GROUP BY 1) d
           ON d."affiliateId" = p.id WHERE coalesce(d.n, 0) <> p.n_orders) AS orders_mismatch,
        (SELECT count(*)::int FROM p5a_gen.plan p LEFT JOIN identity_verifications i ON i."affiliateId" = p.id WHERE i.status IS DISTINCT FROM p.identity) AS identity_mismatch,
        (SELECT count(*)::int FROM p5a_gen.plan p JOIN affiliates a ON a.id = p.id WHERE a."createdAt" <> p.created_at OR a."isActive" <> p.is_active
           OR a."parentId" IS DISTINCT FROM p.parent_id) AS affiliate_mismatch,
        (SELECT count(*)::int FROM p5a_gen.ledger_plan) AS ledger_plan_rows`, [], HASH_JOINS);
    check('db-matches-plan', pc.rd_mismatch === 0 && pc.orders_mismatch === 0 && pc.identity_mismatch === 0 && pc.affiliate_mismatch === 0
      && pc.ledger_plan_rows === keys.total, { ...pc, ledgerRows: keys.total });
    const planDepth = await q(`SELECT shape, count(*) FILTER (WHERE depth IS NOT NULL)::int AS placed, max(depth)::int AS max_depth FROM p5a_gen.plan GROUP BY 1`);
    check('plan-depth-matches-tree', planDepth.every((r) => r.placed === manifest.shapes[r.shape].placed && r.max_depth === manifest.shapes[r.shape].maxDepth), planDepth);
  }
  return {
    ok: checks.every((c) => c.ok), checks, counts, steady, ledger: { ...lg, ...keys }, wallet: wallet.map((w) => ({ ...w, earned: Number(w.earned),
      reserved: Number(w.reserved), paid: Number(w.paid), available: Number(w.earned) - Number(w.reserved) })),
    distributions: { identityPct: idMap, activePct: pct(act.active, act.n), orders: checks.find((c) => c.name === 'orders-distribution').detail },
  };
}

// ── drift ────────────────────────────────────────────────────────────────────
function drift(db) {
  for (const f of [join(REPO, '.env'), join(REPO, 'prisma/.env'), join(WORK_DIR, '.env')]) if (existsSync(f)) throw new Error(`refusing: ${f} exists`);
  const url = dbUrl(db);
  assertDisposableUrl(url);
  mkdirSync(WORK_DIR, { recursive: true });
  let out = '';
  let code = 0;
  try {
    out = execFileSync(join(REPO, 'node_modules/.bin/prisma'), ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', join(REPO, 'prisma/schema.prisma'), '--script', '--exit-code'],
      { cwd: WORK_DIR, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status ?? 1; out = String(e.stdout ?? '') + String(e.stderr ?? ''); }
  const text = out.trim();
  return { db, exitCode: code, output: text, empty: code === 0 && /This is an empty migration/.test(text) };
}

// ── build ────────────────────────────────────────────────────────────────────
async function build(scaleArg) {
  const sk = scaleKey(scaleArg);
  const S = SCALES[sk];
  const db = TEMPLATES[sk];
  if (!clusterReady()) throw new Error('cluster not running (pg.sh start)');
  const schema = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'schema.json'), 'utf8'));
  if (!schema.driftEmpty) throw new Error('p5a_base drift check did not pass (schema.sh)');
  const dbs = await listDatabases();
  if (!dbs.includes(BASE_DB)) throw new Error('p5a_base missing (schema.sh)');
  if (dbs.includes(db)) {
    if (!flag('force')) throw new Error(`${db} exists (use --force to rebuild)`);
    await pgQuery('postgres', `ALTER DATABASE "${db}" IS_TEMPLATE false ALLOW_CONNECTIONS true`);
    await pgQuery('postgres', `DROP DATABASE "${db}" WITH (FORCE)`);
  }
  const free = freeDiskBytes();
  if (free < 8 * 1024 ** 3) throw new Error(`only ${free} B free — refusing to build`);
  mkdirSync(LOGS_DIR, { recursive: true });
  const env = await environment();
  const buildId = `${db}@${new Date().toISOString()}`;
  const timings = {};
  const runStep = async (name, fn) => {
    log(`[${sk}] ${name} …`);
    const t0 = now();
    const r = await fn();
    timings[name] = round((now() - t0) / 1000, 3);
    log(`[${sk}] ${name} done in ${timings[name]} s`);
    await appendResult('infra-generate.jsonl', { kind: 'generate-step', buildId, scale: sk, db, step: name, seconds: timings[name] });
    return r;
  };
  await runStep('create_db', () => pgQuery('postgres', `CREATE DATABASE "${db}" TEMPLATE "${BASE_DB}"`));
  for (const step of BUILD_STEPS) {
    await runStep(step, () => psqlFile(db, join(SQL_DIR, `${step}.sql`), { vars: { scale: S }, logFile: join(LOGS_DIR, `generate-${sk}-${step}.log`) }));
  }
  const manifest = await runStep('manifest', () => computeManifest(db, S, sk));
  const validation = await runStep('validate', () => validate(db, manifest, { plan: true }));
  manifest.validation = validation;
  await runStep('90_finalize', () => psqlFile(db, join(SQL_DIR, '90_finalize.sql'), { logFile: join(LOGS_DIR, `generate-${sk}-90_finalize.log`) }));
  manifest.drift = await runStep('drift', () => drift(db));
  const [conns] = await pgQuery('postgres', 'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [db]);
  await runStep('lock_template', () => pgQuery('postgres', `ALTER DATABASE "${db}" IS_TEMPLATE true ALLOW_CONNECTIONS false`));
  manifest.generationSeconds = timings;
  manifest.generationSecondsTotal = round(Object.values(timings).reduce((a, b) => a + b, 0), 3);
  manifest.databaseSizeBytes = await databaseSize(db);
  manifest.connectionsLeftOpenBeforeLock = conns.n;
  manifest.generator = { files: Object.fromEntries(readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => [`sql/${f}`, sha256(join(SQL_DIR, f))])),
    'generate.mjs': sha256(join(PERF_DIR, 'generate.mjs')), 'lib.mjs': sha256(join(PERF_DIR, 'lib.mjs')) };
  manifest.environment = { pgVersion: env.pgVersion, nodeVersion: env.nodeVersion, gitHead: env.gitHead, prismaClient: env.prismaClient, adapterPg: env.adapterPg };
  manifest.builtAt = new Date().toISOString();
  manifest.buildId = buildId;
  manifest.ok = validation.ok && manifest.drift.empty && conns.n === 0;
  writeFileSync(join(MANIFESTS_DIR, `${sk}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  await appendResult('infra-generate.jsonl', { kind: 'generate-summary', buildId, scale: sk, db, ok: manifest.ok, seconds: timings, totalSeconds: manifest.generationSecondsTotal,
    sizeBytes: manifest.databaseSizeBytes, rowCounts: manifest.rowCounts, validationFailed: validation.checks.filter((c) => !c.ok).map((c) => c.name), drift: manifest.drift });
  log(`[${sk}] manifest → ${join(MANIFESTS_DIR, `${sk}.json`)} ok=${manifest.ok} size=${manifest.databaseSizeBytes}`);
  return manifest;
}

async function computeManifest(db, S, sk) {
  const recRows = await pgQuery(db, 'SELECT shape, id, username FROM p5a_gen.rec ORDER BY idx');
  const recruiters = Object.fromEntries(recRows.map((r) => [r.shape, { id: r.id, username: r.username }]));
  const shapes = {};
  for (const shape of SHAPES) shapes[shape] = treeManifest(shape, buildTree(await loadMembers(db, recruiters[shape].id)), S);
  shapes.empty = { members: 0, placed: 0, unplaced: 0, roots: 0, maxDepth: 0 };
  const pool = async (name) => (await pgQuery(db, `SELECT id FROM p5a_gen.plan WHERE pool = $1 ORDER BY md5('p5a:pool:' || id), id`, [name])).map((r) => r.id);
  const P_AWARD = await pool('award');
  const P_REVERSE = await pool('reverse');
  const cancel = await pgQuery(db, `SELECT DISTINCT ON ("affiliateId") "affiliateId", id FROM affiliate_orders
    WHERE "affiliateId" = ANY($1) AND status = 'delivered' AND NOT "isFake" ORDER BY "affiliateId", "createdAt", id`, [P_REVERSE]);
  const rowCounts = {};
  for (const t of COUNT_TABLES) rowCounts[t] = Number((await pgQuery(db, `SELECT count(*)::bigint AS n FROM "${t}"`))[0].n);
  // Order-independent content checksum per table (every column, via the row's text form): equal
  // checksums across two builds = identical data (the determinism check).
  const contentChecksums = {};
  for (const t of COUNT_TABLES) {
    const [r] = await pgQuery(db, `SELECT count(*)::bigint AS n, coalesce(sum(('x' || substr(md5(t::text), 1, 15))::bit(60)::bigint), 0)::numeric::text AS h FROM "${t}" t`);
    contentChecksums[t] = `${r.n}:${r.h}`;
  }
  const histClasses = await pgQuery(db, `SELECT shape, hist, count(*)::int AS n FROM p5a_gen.plan GROUP BY 1, 2 ORDER BY 1, 2`);
  return {
    scale: S, scaleKey: sk, template: db, recruiters, shapes,
    pools: {
      P_AWARD, P_REVERSE,
      P_REVERSE_cancelOrderId: Object.fromEntries(cancel.map((r) => [r.affiliateId, r.id])),
      definition: {
        P_AWARD: 'rec_mixed placed members: identity PENDING, exactly 5 real delivered orders, no open reward — approving the identity creates exactly one pending award each',
        P_REVERSE: 'rec_mixed placed members: identity APPROVED, exactly 5 real delivered orders, open reward of settings v2 (threshold 5) — cancelling ONE real delivered order (P_REVERSE_cancelOrderId) creates exactly one pending reversal each',
        order: "ids are listed in pool order (md5('p5a:pool:' || id)); take a prefix for a smaller scenario",
      },
    },
    settings: { v1: { enabled: true, rewardAmountCents: 5000, minDeliveredSales: 3 }, v2: { enabled: true, rewardAmountCents: 7000, minDeliveredSales: 5, current: true } },
    rowCounts,
    contentChecksums,
    historyClasses: histClasses,
    notes: [
      'rec_empty has an empty network, no earnings and therefore no withdrawal (a request needs a positive balance)',
      'templates are locked (IS_TEMPLATE true, ALLOW_CONNECTIONS false): clone them (lib.cloneDb), never connect to them',
      'all user triggers stayed enabled during the load',
      'affiliates were VACUUM FULL-ed after the post-link update; the whole database was VACUUM (ANALYZE)-d',
    ],
  };
}

// ── reconcile (real service, on a clone) ─────────────────────────────────────
async function reconcile(scaleArg) {
  const sk = scaleKey(scaleArg);
  const manifest = loadManifest(sk);
  const clone = `val_${sk}`;
  const out = { kind: 'steady-state-reconcile', scale: sk, clone, runs: [] };
  if ((await listDatabases()).includes(clone)) await dropDb(clone);
  out.clone = await cloneDb(TEMPLATES[sk], clone);
  const { reconcileRecruiterRewards } = await importService('recruiterRewardService');
  const conn = await connect(clone, { bytes: false });
  out.connect = conn.timings;
  const totalLinks = manifest.rowCounts.recruiter_affiliate_links;
  const runOnce = async (label) => {
    const r = await conn.measure(label, (db) => reconcileRecruiterRewards({ db }));
    const run = { label, result: r.result ?? null, error: r.error, wallMs: round(r.wallMs, 3), calls: r.summary.calls, transactions: r.summary.transactions,
      sqlStatements: r.summary.sqlStatements, sqlMsSum: round(r.summary.sqlMsSum, 3), heapStart: r.summary.heapStart, heapPeak: r.summary.heapPeak, heapEnd: r.summary.heapEnd };
    out.runs.push(run);
    conn.rec.reset();
    await appendResult('infra-reconcile.jsonl', { ...run, kind: 'reconcile-run', scale: sk, clone });
    log(`[${sk}] reconcile ${label}: ${JSON.stringify(run.result ?? run.error)} in ${run.wallMs} ms`);
    return run;
  };
  try {
    const first = await runOnce('steady-state');
    out.steadyOk = !!first.result && first.result.awarded === 0 && first.result.reversed === 0 && first.result.checked === totalLinks;
    if (flag('flip')) {
      const a = manifest.pools.P_AWARD.slice(0, 3);
      const r = manifest.pools.P_REVERSE.slice(0, 2);
      const orderIds = r.map((id) => manifest.pools.P_REVERSE_cancelOrderId[id]);
      const before = await pgQuery(clone, `SELECT "affiliateId", type, cycle FROM recruiter_reward_ledger WHERE "affiliateId" = ANY($1) ORDER BY 1, 3, 2`, [[...a, ...r]]);
      const flipA = await pgQuery(clone, `UPDATE identity_verifications SET status = 'APPROVED', "approvedAt" = now() AT TIME ZONE 'UTC',
          "approvedBy" = 'p5a-flip', "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "affiliateId" = ANY($1) AND status = 'PENDING' RETURNING "affiliateId"`, [a]);
      const flipR = await pgQuery(clone, `UPDATE affiliate_orders SET status = 'cancelled' WHERE id = ANY($1) AND status = 'delivered' AND NOT "isFake"
          RETURNING "affiliateId"`, [orderIds]);
      out.flip = { approvedIdentities: flipA.length, cancelledOrders: flipR.length, award: a, reverse: r, orderIds };
      const second = await runOnce('after-flip');
      const after = await pgQuery(clone, `SELECT "affiliateId", type, cycle, "amountCents", "settingsVersion", "idempotencyKey" FROM recruiter_reward_ledger
          WHERE "affiliateId" = ANY($1) ORDER BY 1, 3, 2`, [[...a, ...r]]);
      const newRows = after.filter((x) => !before.some((b) => b.affiliateId === x.affiliateId && b.type === x.type && b.cycle === x.cycle));
      const audits = await pgQuery(clone, `SELECT action, count(*)::int AS n FROM recruiter_audit_log WHERE "entityId" = ANY($1) AND "createdAt" > now() AT TIME ZONE 'UTC' - interval '1 hour'
          AND action IN ('RECRUIT_REWARD_EARNED', 'RECRUIT_REWARD_REVERSED') GROUP BY 1`, [[...a, ...r]]);
      out.flip.newLedgerRows = newRows;
      out.flip.newAuditRows = audits;
      const third = await runOnce('after-flip-again');
      out.flipOk = flipA.length === 3 && flipR.length === 2 && second.result?.awarded === 3 && second.result?.reversed === 2
        && newRows.filter((x) => x.type === 'RECRUIT_REWARD' && a.includes(x.affiliateId) && x.amountCents === 7000 && x.settingsVersion === 2).length === 3
        && newRows.filter((x) => x.type === 'REVERSAL' && r.includes(x.affiliateId) && x.amountCents === -7000).length === 2
        && newRows.length === 5 && third.result?.awarded === 0 && third.result?.reversed === 0;
    }
  } finally {
    await conn.close();
    out.drop = await dropDb(clone);
  }
  out.ok = out.steadyOk && (!flag('flip') || out.flipOk);
  await appendResult('infra-reconcile.jsonl', { ...out, kind: 'reconcile-summary' });
  log(`[${sk}] reconcile ok=${out.ok}`);
  return out;
}

async function validateClone(scaleArg) {
  const sk = scaleKey(scaleArg);
  const manifest = loadManifest(sk);
  const clone = `val_${sk}`;
  if ((await listDatabases()).includes(clone)) await dropDb(clone);
  const c = await cloneDb(TEMPLATES[sk], clone);
  try {
    const t0 = now();
    const v = await validate(clone, manifest);
    const res = { kind: 'validate-clone', scale: sk, clone, cloneMs: c.ms, seconds: round((now() - t0) / 1000, 3), ok: v.ok,
      failed: v.checks.filter((x) => !x.ok).map((x) => x.name), checks: v.checks.length };
    await appendResult('infra-validate.jsonl', { ...res, validation: v });
    log(`[${sk}] validate on clone ok=${v.ok} (${v.checks.length} checks)`);
    return res;
  } finally {
    await dropDb(clone);
  }
}

async function main() {
  if (cmd === 'build') {
    const m = await build(opt('scale'));
    console.log(JSON.stringify({ ok: m.ok, scale: m.scaleKey, seconds: m.generationSeconds, sizeBytes: m.databaseSizeBytes,
      failed: m.validation.checks.filter((c) => !c.ok).map((c) => c.name), drift: m.drift.empty }, null, 2));
    process.exit(m.ok ? 0 : 1);
  } else if (cmd === 'check-build') {
    // Read-only: manifest + validation of a template whose load finished but which was not finalized
    // (helper schema p5a_gen still present, e.g. an interrupted build). Writes nothing.
    const sk = scaleKey(opt('scale'));
    const t0 = now();
    const manifest = await computeManifest(TEMPLATES[sk], SCALES[sk], sk);
    const t1 = now();
    const v = await validate(TEMPLATES[sk], manifest, { plan: true });
    console.log(JSON.stringify({ ok: v.ok, manifestSeconds: round((t1 - t0) / 1000, 3), validateSeconds: round((now() - t1) / 1000, 3),
      checks: v.checks.map((c) => ({ name: c.name, ok: c.ok, ms: c.ms })), failed: v.checks.filter((c) => !c.ok) }, null, 2));
    process.exit(v.ok ? 0 : 1);
  } else if (cmd === 'validate') {
    const r = await validateClone(opt('scale'));
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'reconcile') {
    const r = await reconcile(opt('scale'));
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'drift') {
    const r = drift(opt('db'));
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.empty ? 0 : 1);
  } else if (cmd === 'selftest') {
    const r = await runSelfTest({ db: opt('db', 'val_1k') });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else {
    console.error('usage: node scripts/perf/recruiter/generate.mjs <build|check-build|validate|reconcile|drift|selftest> [--scale 1k|10k|100k] [--force] [--flip] [--db name]');
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
