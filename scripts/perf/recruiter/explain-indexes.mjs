#!/usr/bin/env node
/**
 * scripts/perf/recruiter/explain-indexes.mjs — EXPLAIN + INDEX HARNESS of the Phase 6 Part 5a recruiter
 * performance baseline. It measures the CURRENT implementation only: no optimisation, no change to the
 * application, the Prisma schema or a migration, no repository write. Every index experiment exists only
 * on a disposable clone that is dropped at the end; nothing here is (or produces) a migration.
 *
 * WHAT IT DOES — per --scale and --variant, every variant on its OWN clone exp_<scale>_<variant> of the
 * SAME template p5a_<scale> (identical data):
 *   1. CAPTURE (not a measurement). The REAL services are called on the clone (recruiterNetworkService,
 *      recruiterRewardService, recruiterWalletService, recruiterAffiliateService, recruiterIdentityService,
 *      src/lib/recruiterRewardHooks.js) through a PrismaClient built like production src/lib/prisma.js
 *      (new PrismaClient({ adapter: new PrismaPg(pool) }) over a pg.Pool, pg default pool size) wrapped in
 *      lib.instrumentClient (call records). lib's Recorder keeps no bind values, so the pool's Client is a
 *      subclass that records every statement's exact text AND bind values (driver level, BEGIN/COMMIT incl.).
 *      Inputs are chosen so that nothing is written (steady-state reconcile / sync, replays, a refused
 *      withdrawal, a creation refused with USERNAME_TAKEN after the ancestry walk); row counts of every
 *      table a service could write are compared before / after (a difference is reported as a problem).
 *      The capture pool sets statement_timeout (capture only); the deep network tree uses a short one
 *      (--capture-deep-timeout-ms): only its text + values are needed, recorded when the query is SENT.
 *   2. EXPLAIN — each selected statement (KEYS below) is re-sent with its exact text and the exact captured
 *      JS bind values (same pg driver, same extended protocol with an unnamed statement, hence the same
 *      custom plan) as EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON): --warmups discarded runs (stop
 *      early once one exceeds --slow-warmup-ms), --reps measured runs, then one FORMAT TEXT run (its own
 *      sample). Read-only statements only; the selection contains no write. Warm, same session, the OS
 *      page cache is never dropped. A statement_timeout (--statement-timeout-ms) cancels a run: recorded
 *      as a timeout and that key stops; a key whose projected time exceeds --key-budget-s runs fewer reps
 *      (recorded as `adapted`).
 *   3. INVENTORY — every index / constraint / user trigger of the 11 recruiter-related tables (pg_indexes,
 *      pg_index, pg_constraint, sizes, validity), table sizes and visibility map, pg_stat_user_indexes /
 *      pg_stat_user_tables usage per phase (stats flushed with pg_stat_force_next_flush), and the ORIGIN of
 *      each index / constraint: created by a committed migration (prisma/migrations/*, file + line) or only
 *      by schema.prisma (the 3607da3 datamodel base of the disposable DB).
 *   4. VARIANTS (the index DDL is run on the variant's clone only):
 *        V0     baseline as built — every key (phase as_built);
 *        V_mig  drop affiliates(parentId) + affiliate_orders(affiliateId) (a DB built only from committed
 *               migrations has neither) — tree mixed/wide/deep, order groupBys, realDeliveredCount;
 *        V1     + affiliate_orders(affiliateId, status, isFake) — order groupBys, realDeliveredCount;
 *               visibility map reported (pg_visibility) after CREATE INDEX and after an explicit VACUUM,
 *               keys re-run after the VACUUM (index-only scans, Heap Fetches);
 *        V2     + affiliate_orders(orderId) — linked-order hook;
 *        V3     + recruiter_audit_log(recruiterId, action) [alt cols], alternatively the expression index
 *               (recruiterId, action, (details->>'requestId')) [alt expr_text], plus an EXTRA alternative
 *               (recruiterId, action, (details #> '{requestId}')) [alt expr_path] — the expression of the SQL
 *               Prisma actually sends for details: { path: ['requestId'], equals }; alternatives one at a
 *               time on the same clone (each dropped before the next; expression ones followed by ANALYZE of
 *               the table for expression statistics) — idempotency lookups + admin identities audit list;
 *        V4     + recruiter_reward_ledger(createdAt, seq) — admin ledger list, wallet ledger history.
 *      V_mig..V4 run their keys before the DDL too (phase before, same clone; default on for V1..V4, off for
 *      V_mig whose baseline is V0 on its own clone; --before on|off overrides) and after it (phase after).
 *   5. WRITE COST (V1..V4): index size, build time (CREATE INDEX per round + one CREATE INDEX CONCURRENTLY),
 *      and a fixed insert batch (affiliate_orders 50k rows, recruiter_audit_log 20k, recruiter_reward_ledger
 *      20k ADMIN_ADJUSTMENT rows with affiliateId NULL so the cycle guard returns early — 20k reward rows in
 *      one transaction would exceed the lock table; index maintenance per row is the same) prepared in a temp
 *      table, inserted with EXPLAIN (ANALYZE, TIMING OFF, BUFFERS, WAL) inside BEGIN … ROLLBACK, followed by a
 *      VACUUM (INDEX_CLEANUP ON) of the table; 1 discarded round, then --write-reps rounds interleaved without /
 *      with each index (the index is built before and dropped after each of its rounds).
 *
 * SAFETY GUARD
 *   • Refuses to run unless lib.mjs points at /tmp/p5a-pg/sock on port 55510, the process DATABASE_URL passes
 *     lib.assertDisposableUrl, and every connection string is an exp_ clone on that socket and port.
 *   • Uses ONLY its own clones exp_<scale>_<variant> (lib.cloneDb: prefix, <= 2 clones alive, >= 4 GiB of
 *     disk must remain; it waits --clone-wait-s for a free slot) and drops them at the end (--keep-clone
 *     keeps it). Templates are never connected to. Writes on the clone: the variant's index DDL, VACUUM /
 *     ANALYZE of the measured table, CREATE EXTENSION pg_visibility (V1), temp tables and rolled-back inserts.
 *   • Never reads .env, never writes into the repository (results / plans / logs go to SCRATCH).
 *
 * OUTPUT — SCRATCH/results/explain-<scale>.jsonl (environment header first; lines: run-start, clone,
 *   capture-inputs, capture-scenario, capture-key, capture-check, explain-session, sample, summary, ddl,
 *   index-usage, vm, phase-stats, inventory, checklist, write-setup, write-sample, write-summary, run-end) and
 *   SCRATCH/results/plans/<scale>/<runId>/<variant>/: capture.json (exact text + bind values of every key),
 *   <phase>[.<alt>]/<key>.txt (FORMAT TEXT plan, with the SQL) and <key>.json (every JSON plan of the key).
 *   Every record carries runId, run (--run label), scale and variant. A `sample` is one EXPLAIN (warmup |
 *   measured | text) with Execution / Planning Time, wall ms, buffers, JIT, the plan shape (fingerprint hash,
 *   access paths, index-only scans, Heap Fetches) and the load average; a `summary` gives nearest-rank
 *   n / min / p50 (= median for odd n) / p95 / max / mean over the measured JSON runs, spread (max − min and
 *   its ratio to p50), buffer and plan-shape summaries, and raw ratios to the same key in phase `before` of
 *   the same clone (vsBefore) and in the latest V0 as_built summary with the SAME --run label (vsV0); these
 *   are numbers only, no interpretation. run-start / phase-stats / run-end record the load average and the
 *   other client backends / clones on the cluster (concurrent activity is visible, never hidden).
 *
 * USAGE
 *   node scripts/perf/recruiter/explain-indexes.mjs --scale 1k|10k|100k [--variant V0|V_mig|V1|V2|V3|V4|all|a,b]
 *     [--reps N] [--warmups N] [--keys k1,prefix*] [--before auto|on|off] [--no-write] [--write-reps N]
 *     [--statement-timeout-ms N] [--capture-timeout-ms N] [--capture-deep-timeout-ms N] [--key-budget-s N]
 *     [--slow-warmup-ms N] [--clone-wait-s N] [--run LABEL] [--out explain-<name>.jsonl] [--checklist]
 *     [--keep-clone]
 *   node scripts/perf/recruiter/explain-indexes.mjs --list             variants, keys and scenarios (no DB)
 *   node scripts/perf/recruiter/explain-indexes.mjs --scale 1k --cleanup   drop exp_<scale>_* clones and exit
 *   --checklist (V0): runs docs/performance/production-index-checklist.sql with psql on the clone and checks
 *   that it wrote nothing. Long runs (10k deep tree ≈ 3 min per EXPLAIN; 100k) — start detached:
 *     setsid nohup node scripts/perf/recruiter/explain-indexes.mjs --scale 10k --variant V0 > "$SCRATCH/logs/explain-10k-V0.out" 2>&1 &
 *     timeout 540 tail --pid=<pid> -f /dev/null      # repeat until it exits
 *   Exit code 0 when every selected key was captured and EXPLAINed (timeouts are recorded outcomes) and no
 *   check failed; 1 otherwise (see run-end.problems).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, relative, resolve } from 'node:path';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/generated/prisma/index.js';
import {
  LOGS_DIR, PG_BIN, PG_PORT, PG_SOCK, REPO, RESULTS_DIR, TEMPLATES,
  Recorder, appendResult, assertDisposableUrl, cloneDb, dbUrl, dropDb, freeDiskBytes, importService,
  instrumentClient, listClones, loadManifest, now, pgQuery, scaleKey, summarize,
} from './lib.mjs';

// ── constants ────────────────────────────────────────────────────────────────
const HARNESS = 'explain-indexes';
const ADMIN = '/* p5a-exp-admin */'; // tags every harness-side (unmeasured) statement
const PLANS_DIR = join(RESULTS_DIR, 'plans');
const CHECKLIST_FILE = join(REPO, 'docs/performance/production-index-checklist.sql');
const DEFAULTS = Object.freeze({
  reps: 5, warmups: 3, statementTimeoutMs: 600_000, captureTimeoutMs: 600_000, captureDeepTimeoutMs: 10_000,
  keyBudgetS: 1800, slowWarmupMs: 10_000, cloneWaitS: 900, writeReps: 3,
});
const TABLES = Object.freeze(['affiliates', 'affiliate_orders', 'recruiter_affiliate_links', 'identity_verifications', 'recruiter_reward_ledger',
  'recruiter_audit_log', 'recruiter_settings_versions', 'affiliate_payouts', 'recruiters', 'recruiter_identity_verifications', 'affiliate_activation_codes']);
/** Tables a service call could write (compared before / after the capture). */
const WRITABLE = Object.freeze(['affiliates', 'recruiter_affiliate_links', 'recruiter_reward_ledger', 'recruiter_audit_log', 'affiliate_payouts',
  'affiliate_activation_codes', 'identity_verifications', 'recruiter_identity_verifications', 'recruiters', 'recruiter_settings_versions']);
const NEW_REQUEST_IDS = Object.freeze({ affiliate: '5a5a5a5a-e1e1-4000-8000-000000000001', withdrawal: '5a5a5a5a-e1e1-4000-8000-000000000002' });
const USERNAME_RE = /^(?=[a-z0-9._-]*[a-z])[a-z0-9][a-z0-9._-]{2,29}$/; // = recruiterAffiliateService (input validation)
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_WITHDRAWAL_MAD = 1_000_000; // RECRUITER_WITHDRAWAL_LIMITS.MAX_CENTS / 100

/** Statement keys: what each EXPLAIN is (all READ-ONLY statements). */
const KEYS = Object.freeze({
  'links.count': 'loadNetworkTree → recruiterAffiliateLink.count({ recruiterId }) — rec_mixed',
  'links.unplaced': "getNetworkNodes(view 'unplaced') → links findMany ORDER BY createdAt, affiliateId — rec_mixed",
  'tree.mixed': 'loadNetworkTree recursive network query (raw) — rec_mixed',
  'tree.wide': 'loadNetworkTree recursive network query (raw) — rec_wide',
  'tree.deep': 'loadNetworkTree recursive network query (raw) — rec_deep (chain of S)',
  'orders.groupBy.network': 'getNetworkStats → orderCounts groupBy(affiliateId,status,isFake) IN first chunk (min(5000, placed) ids) — rec_mixed',
  'orders.groupBy.page': 'getNetworkNodes roots page → orderCounts groupBy IN (page ids) — rec_mixed',
  'identity.findMany.network': 'getNetworkStats → identityStatuses findMany IN first chunk — rec_mixed',
  'affiliates.findMany.pagePath': 'getNetworkNodes(parentId = manifest branchNode) → affiliate.findMany id IN (page + breadcrumb path) — rec_mixed',
  'reconcile.links.findMany': 'reconcileRecruiterRewards → links findMany({ recruiterId }) — rec_mixed',
  'reconcile.ledger.findMany': 'reconcileRecruiterRewards → ledger findMany affiliateId IN first chunk AND type IN — rec_mixed',
  'reconcile.delivered.groupBy': "reconcileRecruiterRewards → realDeliveredCounts groupBy(affiliateId) IN first chunk, status 'delivered', isFake false — rec_mixed",
  'reconcile.identity.findMany': 'reconcileRecruiterRewards → identityStatuses(award candidates) findMany IN — rec_mixed',
  'sync.cycleState': 'syncRecruiterReward → cycleState ledger findMany(affiliateId, type IN) — P_REVERSE[0]',
  'sync.realDeliveredCount': "syncRecruiterReward → realDeliveredCount count(affiliateId, status 'delivered', isFake false) — P_REVERSE[0]",
  'ancestry.link.findUnique': 'recruiterCreateAffiliate → assertAncestryInNetwork link findUnique(affiliateId) — first level (the parent)',
  'ancestry.affiliate.findUnique': 'recruiterCreateAffiliate → assertAncestryInNetwork affiliate findUnique(id) select parentId — first level',
  'hook.linkedOrder': 'onRecruiterLinkedOrderSynced → affiliateOrder.findMany({ orderId, isFake: false }) — an orderId shared by a fake and a real row',
  'idempotency.affiliateCreated.miss': 'recruiterCreateAffiliate idempotency findFirst AFFILIATE_CREATED, NEW requestId (no match) — rec_mixed',
  'idempotency.affiliateCreated.hit': 'recruiterCreateAffiliate idempotency findFirst AFFILIATE_CREATED, requestId of the newest creation (replay) — rec_mixed',
  'idempotency.withdrawal.miss': 'requestRecruiterWithdrawal idempotency findFirst RECRUITER_WITHDRAWAL_REQUESTED, NEW requestId — rec_mixed',
  'idempotency.withdrawal.hit': 'requestRecruiterWithdrawal idempotency findFirst, requestId of the newest withdrawal (replay) — rec_mixed',
  'wallet.totals.ledgerSum': 'walletTotals → ledger aggregate _sum(amountCents) by recruiterId — rec_mixed',
  'wallet.totals.payouts': 'walletTotals → affiliatePayout.findMany({ recruiterId }) — rec_mixed',
  'wallet.ledgerHistory': 'getRecruiterWallet → ledger findMany recruiterId ORDER BY createdAt DESC, seq DESC LIMIT 200 — rec_mixed',
  'wallet.payoutHistory': 'getRecruiterWallet → payouts findMany recruiterId ORDER BY createdAt DESC, id LIMIT 200 — rec_mixed',
  'admin.ledger.list': 'adminListRecruiterLedger → ledger findMany ORDER BY createdAt DESC, seq DESC LIMIT 500',
  'admin.balances.ledgerGroupBy': 'adminRecruiterBalances → ledger groupBy(recruiterId) _sum(amountCents)',
  'admin.balances.payouts': 'adminRecruiterBalances → payouts findMany recruiterId NOT NULL',
  'admin.identities.rows': 'adminListRecruiterIdentities → recruiter_identity_verifications findMany ORDER BY submittedAt DESC, id LIMIT 500',
  'admin.identities.audits': 'adminListRecruiterIdentities → audit findMany recruiterId IN AND action IN ORDER BY createdAt DESC, seq DESC',
});
const ALL_KEYS = Object.freeze(Object.keys(KEYS));
const OPTIONAL_KEYS = new Set(['reconcile.identity.findMany']); // present only when the reconcile has award candidates

/** Picks: a regex on the NORMALIZED text ("public". removed, whitespace collapsed); nth match (0 = first, e.g. the first chunk). */
const RX = Object.freeze({
  linksCount: /^SELECT COUNT\(\*\) AS "_count\$_all" FROM \(SELECT "recruiter_affiliate_links"\."affiliateId" FROM "recruiter_affiliate_links" WHERE "recruiter_affiliate_links"\."recruiterId" = \$1 OFFSET \$2\) AS "sub"$/,
  tree: /recruiter-network-tree/,
  ordersGroupBy: /FROM "affiliate_orders" WHERE "affiliate_orders"\."affiliateId" IN \(.*\) GROUP BY "affiliate_orders"\."affiliateId", "affiliate_orders"\."status", "affiliate_orders"\."isFake"/,
  identityIn: /^SELECT "identity_verifications"\."id", "identity_verifications"\."affiliateId", "identity_verifications"\."status" FROM "identity_verifications" WHERE "identity_verifications"\."affiliateId" IN \(/,
  affiliatesIn: /^SELECT "affiliates"\."id", "affiliates"\."username", "affiliates"\."name" FROM "affiliates" WHERE "affiliates"\."id" IN \(/,
  linksUnplaced: /FROM "recruiter_affiliate_links" WHERE "recruiter_affiliate_links"\."recruiterId" = \$1 ORDER BY "recruiter_affiliate_links"\."createdAt" ASC, "recruiter_affiliate_links"\."affiliateId" ASC/,
  reconcileLinks: /^SELECT "recruiter_affiliate_links"\."affiliateId", "recruiter_affiliate_links"\."recruiterId" FROM "recruiter_affiliate_links" WHERE "recruiter_affiliate_links"\."recruiterId" = \$1 OFFSET/,
  ledgerIn: /FROM "recruiter_reward_ledger" WHERE \("recruiter_reward_ledger"\."affiliateId" IN \(.*\) AND "recruiter_reward_ledger"\."type" IN \(/,
  deliveredGroupBy: /^SELECT COUNT\(\*\) AS "_count\$_all", "affiliate_orders"\."affiliateId" FROM "affiliate_orders" WHERE \("affiliate_orders"\."affiliateId" IN \(.*\) AND "affiliate_orders"\."status" = \$\d+ AND "affiliate_orders"\."isFake" = \$\d+\) GROUP BY "affiliate_orders"\."affiliateId"/,
  cycleState: /FROM "recruiter_reward_ledger" WHERE \("recruiter_reward_ledger"\."affiliateId" = \$1 AND "recruiter_reward_ledger"\."type" IN \(\$2,\$3\)\)/,
  deliveredCount: /^SELECT COUNT\(\*\) AS "_count\$_all" FROM \(SELECT "affiliate_orders"\."id" FROM "affiliate_orders" WHERE \("affiliate_orders"\."affiliateId" = \$1 AND "affiliate_orders"\."status" = \$2 AND "affiliate_orders"\."isFake" = \$3\)/,
  linkUnique: /^SELECT "recruiter_affiliate_links"\."affiliateId", "recruiter_affiliate_links"\."recruiterId" FROM "recruiter_affiliate_links" WHERE \("recruiter_affiliate_links"\."affiliateId" = \$1 AND 1=1\) LIMIT/,
  affiliateParent: /^SELECT "affiliates"\."id", "affiliates"\."parentId" FROM "affiliates" WHERE \("affiliates"\."id" = \$1 AND 1=1\) LIMIT/,
  linkedOrder: /FROM "affiliate_orders" WHERE \("affiliate_orders"\."orderId" = \$1 AND "affiliate_orders"\."isFake" = \$2\)/,
  idempotency: /FROM "recruiter_audit_log" WHERE \("recruiter_audit_log"\."recruiterId" = \$1 AND "recruiter_audit_log"\."actorType" = \$2 AND "recruiter_audit_log"\."actorId" = \$3 AND "recruiter_audit_log"\."action" = \$4 AND \("recruiter_audit_log"\."details"#>ARRAY\[\$5\]::text\[\]\)::jsonb::jsonb = \$6\) LIMIT/,
  ledgerSum: /^SELECT SUM\("amountCents"\) AS "_sum\$amountCents" FROM \(SELECT "recruiter_reward_ledger"\."amountCents" FROM "recruiter_reward_ledger" WHERE "recruiter_reward_ledger"\."recruiterId" = \$1 OFFSET/,
  payoutsByRecruiter: /^SELECT "affiliate_payouts"\."id", "affiliate_payouts"\."amount", "affiliate_payouts"\."status" FROM "affiliate_payouts" WHERE "affiliate_payouts"\."recruiterId" = \$1 OFFSET/,
  ledgerHistory: /FROM "recruiter_reward_ledger" WHERE "recruiter_reward_ledger"\."recruiterId" = \$1 ORDER BY "recruiter_reward_ledger"\."createdAt" DESC, "recruiter_reward_ledger"\."seq" DESC LIMIT/,
  payoutHistory: /FROM "affiliate_payouts" WHERE "affiliate_payouts"\."recruiterId" = \$1 ORDER BY "affiliate_payouts"\."createdAt" DESC, "affiliate_payouts"\."id" ASC LIMIT/,
  adminLedger: /FROM "recruiter_reward_ledger" WHERE 1=1 ORDER BY "recruiter_reward_ledger"\."createdAt" DESC, "recruiter_reward_ledger"\."seq" DESC LIMIT/,
  balancesGroupBy: /^SELECT SUM\("recruiter_reward_ledger"\."amountCents"\) AS "_sum\$amountCents", "recruiter_reward_ledger"\."recruiterId" FROM "recruiter_reward_ledger" WHERE 1=1 GROUP BY/,
  balancesPayouts: /FROM "affiliate_payouts" WHERE "affiliate_payouts"\."recruiterId" IS NOT NULL/,
  identitiesRows: /FROM "recruiter_identity_verifications" WHERE 1=1 ORDER BY "recruiter_identity_verifications"\."submittedAt" DESC/,
  identitiesAudits: /FROM "recruiter_audit_log" WHERE \("recruiter_audit_log"\."recruiterId" IN \(.*\) AND "recruiter_audit_log"\."action" IN \(.*\)\) ORDER BY "recruiter_audit_log"\."createdAt" DESC, "recruiter_audit_log"\."seq" DESC/,
});

/** Capture scenarios: each calls ONE real service function; `picks` map its statements to keys. */
const SCENARIOS = Object.freeze([
  { label: 'network.stats.mixed', expect: 'stats of the placed members', picks: [['links.count', RX.linksCount], ['tree.mixed', RX.tree], ['orders.groupBy.network', RX.ordersGroupBy], ['identity.findMany.network', RX.identityIn]] },
  { label: 'network.nodes.roots.mixed', expect: 'first roots page', picks: [['orders.groupBy.page', RX.ordersGroupBy]] },
  { label: 'network.nodes.branch.mixed', expect: 'children page of the manifest branchNode + path', picks: [['affiliates.findMany.pagePath', RX.affiliatesIn]] },
  { label: 'network.nodes.unplaced.mixed', expect: 'unplaced view', picks: [['links.unplaced', RX.linksUnplaced]] },
  { label: 'network.tree.wide', expect: 'tree of rec_wide', picks: [['tree.wide', RX.tree]] },
  { label: 'network.tree.deep', expect: 'tree of rec_deep (short capture timeout: only the text + values are needed)', deep: true, picks: [['tree.deep', RX.tree]] },
  { label: 'reward.reconcile.mixed', expect: 'steady state: awarded 0, reversed 0', picks: [['reconcile.links.findMany', RX.reconcileLinks], ['reconcile.ledger.findMany', RX.ledgerIn], ['reconcile.delivered.groupBy', RX.deliveredGroupBy], ['reconcile.identity.findMany', RX.identityIn]] },
  { label: 'reward.sync.reverseCandidate', expect: 'NO_CHANGE (P_REVERSE[0]: open v2 reward, exactly 5 real delivered)', picks: [['sync.cycleState', RX.cycleState], ['sync.realDeliveredCount', RX.deliveredCount]] },
  { label: 'hook.linkedOrder', expect: 'SYNCED, no write (steady state)', picks: [['hook.linkedOrder', RX.linkedOrder]] },
  { label: 'affiliate.create.usernameTaken', expect: 'USERNAME_TAKEN after the ancestry walk (rolled back, nothing written)', picks: [['idempotency.affiliateCreated.miss', RX.idempotency], ['ancestry.link.findUnique', RX.linkUnique], ['ancestry.affiliate.findUnique', RX.affiliateParent]] },
  { label: 'affiliate.create.replay', expect: 'replayed: true (no write)', picks: [['idempotency.affiliateCreated.hit', RX.idempotency]] },
  { label: 'wallet.mixed', expect: 'wallet of rec_mixed', picks: [['wallet.totals.ledgerSum', RX.ledgerSum], ['wallet.totals.payouts', RX.payoutsByRecruiter], ['wallet.ledgerHistory', RX.ledgerHistory], ['wallet.payoutHistory', RX.payoutHistory]] },
  { label: 'withdrawal.replay', expect: 'replayed: true (no write)', picks: [['idempotency.withdrawal.hit', RX.idempotency]] },
  { label: 'withdrawal.insufficient', expect: 'INSUFFICIENT_BALANCE (rolled back, nothing written)', picks: [['idempotency.withdrawal.miss', RX.idempotency]] },
  { label: 'admin.ledger', expect: 'newest 500 ledger rows', picks: [['admin.ledger.list', RX.adminLedger]] },
  { label: 'admin.balances', expect: 'balances of every recruiter', picks: [['admin.balances.ledgerGroupBy', RX.balancesGroupBy], ['admin.balances.payouts', RX.balancesPayouts]] },
  { label: 'admin.identities', expect: 'KYC queue + audit history', picks: [['admin.identities.rows', RX.identitiesRows], ['admin.identities.audits', RX.identitiesAudits]] },
]);

const WRITE_SPECS = Object.freeze({
  affiliate_orders: { rows: 50_000, note: '50k new orders: random existing affiliate (hash of the row number), random uuid orderId, pending/confirmed/shipped/delivered/cancelled, ~10 % fake, createdAt after the newest row' },
  recruiter_audit_log: { rows: 20_000, note: '20k audit rows of the 4 recruiters (AFFILIATE_CREATED / RECRUITER_WITHDRAWAL_REQUESTED / RECRUIT_REWARD_EARNED, details with a requestId), createdAt after the newest row' },
  recruiter_reward_ledger: { rows: 20_000, note: '20k ADMIN_ADJUSTMENT rows (affiliateId NULL: the cycle guard returns early, no per-row advisory lock), createdAt after the newest row, seq from its sequence' },
});

const VARIANTS = Object.freeze({
  V0: { title: 'baseline as built', keys: ALL_KEYS },
  V_mig: {
    title: 'migrations-only risk: DROP INDEX affiliates(parentId) + affiliate_orders(affiliateId) (no committed migration creates them)',
    drop: ['affiliates_parentId_idx', 'affiliate_orders_affiliateId_idx'],
    keys: ['tree.mixed', 'tree.wide', 'tree.deep', 'orders.groupBy.network', 'orders.groupBy.page', 'reconcile.delivered.groupBy', 'sync.realDeliveredCount'],
    beforeDefault: false,
  },
  V1: {
    title: '+ affiliate_orders(affiliateId, status, isFake)', table: 'affiliate_orders', vacuumCheck: true, write: 'affiliate_orders',
    alts: [{ alt: 'composite', name: 'p5a_exp_orders_aff_status_fake_idx', cols: '("affiliateId", "status", "isFake")' }],
    keys: ['orders.groupBy.network', 'orders.groupBy.page', 'reconcile.delivered.groupBy', 'sync.realDeliveredCount'],
  },
  V2: {
    title: '+ affiliate_orders(orderId)', table: 'affiliate_orders', write: 'affiliate_orders',
    alts: [{ alt: 'orderId', name: 'p5a_exp_orders_orderid_idx', cols: '("orderId")' }],
    keys: ['hook.linkedOrder'],
  },
  V3: {
    title: "+ recruiter_audit_log(recruiterId, action) | (recruiterId, action, (details->>'requestId')) | extra (recruiterId, action, (details #> '{requestId}'))",
    table: 'recruiter_audit_log', write: 'recruiter_audit_log',
    alts: [
      { alt: 'cols', name: 'p5a_exp_audit_rec_action_idx', cols: '("recruiterId", "action")' },
      { alt: 'expr_text', name: 'p5a_exp_audit_rec_action_reqtext_idx', cols: `("recruiterId", "action", ("details" ->> 'requestId'))`, analyze: true },
      { alt: 'expr_path', name: 'p5a_exp_audit_rec_action_reqpath_idx', cols: `("recruiterId", "action", ("details" #> '{requestId}'))`, analyze: true, extra: true,
        note: 'EXTRA alternative (not in the brief): Prisma sends ("details"#>ARRAY[$5]::text[])::jsonb::jsonb = $6 for details: { path: [\'requestId\'], equals } — this index has that expression' },
    ],
    keys: ['idempotency.affiliateCreated.miss', 'idempotency.affiliateCreated.hit', 'idempotency.withdrawal.miss', 'idempotency.withdrawal.hit', 'admin.identities.audits'],
  },
  V4: {
    title: '+ recruiter_reward_ledger(createdAt, seq)', table: 'recruiter_reward_ledger', write: 'recruiter_reward_ledger',
    alts: [{ alt: 'createdAt_seq', name: 'p5a_exp_ledger_created_seq_idx', cols: '("createdAt", "seq")' }],
    keys: ['admin.ledger.list', 'wallet.ledgerHistory'],
  },
});
const VARIANT_NAMES = Object.freeze(Object.keys(VARIANTS));

// ── guard ────────────────────────────────────────────────────────────────────
function assertSafeEnvironment() {
  if (PG_SOCK !== '/tmp/p5a-pg/sock' || PG_PORT !== 55510) throw new Error(`${HARNESS}: REFUSED — lib.mjs does not point at /tmp/p5a-pg/sock:55510`);
  assertDisposableUrl(process.env.DATABASE_URL); // lib set or checked it on import
}

/** The clone's URL — refused unless it is an exp_ clone on /tmp/p5a-pg/sock:55510. */
function cloneUrl(clone) {
  if (typeof clone !== 'string' || !/^exp_[a-z0-9_]{1,40}$/.test(clone)) throw new Error(`${HARNESS}: REFUSED — ${clone} is not an exp_ clone`);
  const url = dbUrl(clone);
  assertDisposableUrl(url);
  const u = new URL(url);
  if (u.port !== '55510' || u.searchParams.get('host') !== '/tmp/p5a-pg/sock') throw new Error(`${HARNESS}: REFUSED — not the disposable cluster`);
  return url;
}

const cloneName = (scale, variant) => `exp_${scale}_${variant.toLowerCase()}`;

// ── small utilities ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...xs) => process.stderr.write(`[${HARNESS} ${new Date().toISOString()}] ${xs.join(' ')}\n`);
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const num = (v) => (v === null || v === undefined ? null : Number(v));
const round3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const normSql = (t) => String(t).replace(/"public"\./g, '').replace(/\s+/g, ' ').trim();
const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => {
  if (typeof x === 'bigint') return x.toString();
  if (x && x.type === 'Buffer' && Array.isArray(x.data)) return { buffer: Buffer.from(x.data).toString('base64') };
  return x;
}));
function errorInfo(e) {
  if (!e) return null;
  return { name: e.name ?? null, code: e.code ?? null, message: String(e.message ?? e).split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 800) };
}
/** Compact preview of an SQL text: IN lists collapsed, whitespace collapsed. */
function sqlPreview(text, max = 600) {
  const t = normSql(text).replace(/\$(\d+)(?:,\$\d+){3,},\$(\d+)/g, (_m, a, b) => `$${a},…,$${b}`);
  return t.length > max ? `${t.slice(0, max - 120)} … ${t.slice(-110)}` : t;
}
function valueTypes(values) {
  const types = {};
  for (const v of values) {
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    types[t] = (types[t] ?? 0) + 1;
  }
  return types;
}
function otherActivity(rows, mine) {
  return rows.filter((r) => r.datname && r.datname !== mine).map((r) => ({ db: r.datname, active: Number(r.active), total: Number(r.total) }));
}
async function clusterActivity(mine) {
  const rows = await pgQuery('postgres', `${ADMIN} SELECT datname, count(*) FILTER (WHERE state = 'active')::int AS active, count(*)::int AS total
    FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() GROUP BY datname`);
  return { loadavg: os.loadavg().map(round3), others: otherActivity(rows, mine), clones: await listClones() };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    scale: null, variants: ['V0'], reps: DEFAULTS.reps, warmups: DEFAULTS.warmups, statementTimeoutMs: DEFAULTS.statementTimeoutMs,
    captureTimeoutMs: DEFAULTS.captureTimeoutMs, captureDeepTimeoutMs: DEFAULTS.captureDeepTimeoutMs, keyBudgetS: DEFAULTS.keyBudgetS,
    slowWarmupMs: DEFAULTS.slowWarmupMs, cloneWaitS: DEFAULTS.cloneWaitS, writeReps: DEFAULTS.writeReps, before: 'auto', write: true,
    keys: null, run: 'baseline', out: null, keepClone: false, checklist: false, list: false, cleanup: false,
  };
  const int = (a, v, min) => { const n = Number(v); if (!Number.isInteger(n) || n < min) throw new Error(`${HARNESS}: ${a} must be an integer >= ${min}`); return n; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${HARNESS}: ${a} needs a value`); i += 1; return v; };
    switch (a) {
      case '--scale': o.scale = scaleKey(val()); break;
      case '--variant': o.variants = parseVariants(val()); break;
      case '--reps': o.reps = int(a, val(), 1); break;
      case '--warmups': o.warmups = int(a, val(), 0); break;
      case '--statement-timeout-ms': o.statementTimeoutMs = int(a, val(), 1000); break;
      case '--capture-timeout-ms': o.captureTimeoutMs = int(a, val(), 1000); break;
      case '--capture-deep-timeout-ms': o.captureDeepTimeoutMs = int(a, val(), 100); break;
      case '--key-budget-s': o.keyBudgetS = int(a, val(), 1); break;
      case '--slow-warmup-ms': o.slowWarmupMs = int(a, val(), 1); break;
      case '--clone-wait-s': o.cloneWaitS = int(a, val(), 0); break;
      case '--write-reps': o.writeReps = int(a, val(), 1); break;
      case '--before': { const v = val(); if (!['auto', 'on', 'off'].includes(v)) throw new Error(`${HARNESS}: --before auto|on|off`); o.before = v; break; }
      case '--no-write': o.write = false; break;
      case '--keys': o.keys = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--run': { const v = val(); if (!/^[A-Za-z0-9._-]{1,40}$/.test(v)) throw new Error(`${HARNESS}: --run must match [A-Za-z0-9._-]{1,40}`); o.run = v; break; }
      case '--out': { const v = val(); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.jsonl$/.test(v)) throw new Error(`${HARNESS}: --out must be a plain file name ending in .jsonl`); o.out = v; break; }
      case '--keep-clone': o.keepClone = true; break;
      case '--checklist': o.checklist = true; break;
      case '--list': o.list = true; break;
      case '--cleanup': o.cleanup = true; break;
      default: throw new Error(`${HARNESS}: unknown argument ${a}`);
    }
  }
  if (!o.list && !o.scale) throw new Error(`${HARNESS}: --scale 1k|10k|100k is required`);
  return o;
}

function parseVariants(v) {
  if (v.toLowerCase() === 'all') return [...VARIANT_NAMES];
  const out = [];
  for (const raw of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const name = VARIANT_NAMES.find((n) => n.toLowerCase() === raw.toLowerCase() || n.replace('_', '').toLowerCase() === raw.toLowerCase());
    if (!name) throw new Error(`${HARNESS}: unknown variant ${raw} (${VARIANT_NAMES.join(' | ')} | all)`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function selectKeys(variant, filter) {
  const keys = VARIANTS[variant].keys;
  if (!filter) return [...keys];
  return keys.filter((k) => filter.some((f) => (f.endsWith('*') ? k.startsWith(f.slice(0, -1)) : k === f)));
}

// ── capture (not a measurement) ──────────────────────────────────────────────
/** A PrismaClient built like src/lib/prisma.js over a pg.Pool whose Client records text + bind values. */
async function openCaptureClient(clone, statementTimeoutMs) {
  const url = cloneUrl(clone);
  const statements = [];
  const state = { label: null };
  class CaptureClient extends pg.Client {
    query(config, values, callback) {
      if (config === null || config === undefined || typeof config.submit === 'function') return super.query(config, values, callback);
      const text = typeof config === 'string' ? config : config.text;
      const vals = typeof config === 'object' && Array.isArray(config.values) ? config.values : (Array.isArray(values) ? values : []);
      const s = { i: statements.length, label: state.label, text, values: [...vals], start: now(), ms: null, rows: null, error: null };
      statements.push(s);
      const done = (err, res) => { s.ms = now() - s.start; if (err) s.error = errorInfo(err); else s.rows = res?.rowCount ?? null; };
      let cb = callback;
      let vs = values;
      if (typeof vs === 'function') { cb = vs; vs = undefined; }
      if (typeof cb === 'function') return super.query(config, vs, (err, res) => { done(err, res); cb(err, res); });
      return super.query(config, vs).then((res) => { done(null, res); return res; }, (err) => { done(err); throw err; });
    }
  }
  // Same construction as production (adapter over a pool of pg default size); statement_timeout = capture only.
  const pool = new pg.Pool({ connectionString: url, Client: CaptureClient, statement_timeout: statementTimeoutMs, application_name: 'p5a-exp-capture' });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: ['error'] });
  const t0 = now();
  await prisma.$connect();
  const connectMs = now() - t0;
  const rec = new Recorder({ bytes: false, heap: false, sql: false });
  const db = instrumentClient(prisma, rec);
  return { db, rec, statements, state, connectMs, close: async () => { await prisma.$disconnect(); await pool.end(); } };
}

async function rowCounts(clone) {
  const parts = WRITABLE.map((t) => `(SELECT count(*) FROM "${t}")::bigint AS "${t}"`).join(', ');
  const [r] = await pgQuery(clone, `${ADMIN} SELECT ${parts}`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

/** Inputs of the scenarios (harness-side SQL on the clone, unmeasured). */
async function scenarioInputs(clone, m) {
  const mixed = m.recruiters.mixed.id;
  const q = (sql, params = []) => pgQuery(clone, `${ADMIN} ${sql}`, params);
  const takenRows = await q(`SELECT username FROM "affiliates" ORDER BY "id" LIMIT 200`);
  const taken = takenRows.map((r) => r.username).find((u) => typeof u === 'string' && USERNAME_RE.test(u)) ?? null;
  const createdRows = await q(`SELECT l."details"->>'requestId' AS "requestId", a."username", a."name", a."phone", a."parentId"
    FROM "recruiter_audit_log" l JOIN "affiliates" a ON a."id" = l."entityId"
    WHERE l."recruiterId" = $1 AND l."actorType" = 'RECRUITER' AND l."actorId" = $1 AND l."action" = 'AFFILIATE_CREATED'
    ORDER BY l."createdAt" DESC, l."seq" DESC LIMIT 50`, [mixed]);
  const validReplay = (r) => typeof r.requestId === 'string' && REQUEST_ID_RE.test(r.requestId) && USERNAME_RE.test(r.username ?? '')
    && typeof r.name === 'string' && r.name.length >= 2 && r.name.length <= 80 && !/[<>]/.test(r.name)
    && (r.phone === null || PHONE_RE.test(String(r.phone).replace(/[\s.-]/g, '')));
  const replayAffiliate = createdRows.find(validReplay) ?? null;
  const [replayWithdrawal] = await q(`SELECT "details"->>'requestId' AS "requestId", ("details"->>'amountCents')::bigint AS cents
    FROM "recruiter_audit_log" WHERE "recruiterId" = $1 AND "actorType" = 'RECRUITER' AND "actorId" = $1 AND "action" = 'RECRUITER_WITHDRAWAL_REQUESTED'
    ORDER BY "createdAt" DESC, "seq" DESC LIMIT 1`, [mixed]);
  const [linked] = await q(`SELECT f."orderId" FROM "affiliate_orders" f
    WHERE f."isFake" AND f."orderId" IS NOT NULL AND EXISTS (SELECT 1 FROM "affiliate_orders" r WHERE r."orderId" = f."orderId" AND NOT r."isFake")
    ORDER BY f."orderId" LIMIT 1`);
  const [taken2] = await q(`SELECT count(*)::int AS n FROM "recruiter_audit_log" WHERE "details"->>'requestId' = ANY($1::text[])`, [Object.values(NEW_REQUEST_IDS)]);
  return {
    mixed, wide: m.recruiters.wide.id, deep: m.recruiters.deep.id, branchNodeId: m.shapes.mixed.branchNode.id,
    deepestMixedId: m.shapes.mixed.deepestNode.id, deepestMixedDepth: m.shapes.mixed.deepestNode.depth,
    reverseCandidate: m.pools.P_REVERSE[0], takenUsername: taken, replayAffiliate, linkedOrderId: linked?.orderId ?? null,
    replayWithdrawal: replayWithdrawal ? { requestId: replayWithdrawal.requestId, cents: Number(replayWithdrawal.cents) } : null,
    newRequestIdsAlreadyUsed: taken2.n,
  };
}

/**
 * Runs the scenarios needed for `keys` with the real services → { stmts: Map(key → captured statement), records }.
 * Every scenario, its outcome and its statements are recorded; a key that is not found is a problem.
 */
async function capture(ctx, clone, keys) {
  const { m, problems } = ctx;
  const emit = (obj) => ctx.emit({ ...obj, runId: ctx.runId, run: ctx.opt.run, scale: ctx.scale, variant: ctx.variant });
  const needed = SCENARIOS.filter((s) => s.picks.some(([k]) => keys.includes(k)));
  const inputs = await scenarioInputs(clone, m);
  await emit({ kind: 'capture-inputs', clone, inputs: { ...inputs, replayAffiliate: inputs.replayAffiliate ? { requestId: inputs.replayAffiliate.requestId, username: inputs.replayAffiliate.username } : null } });
  const net = await importService('recruiterNetworkService');
  const rew = await importService('recruiterRewardService');
  const wal = await importService('recruiterWalletService');
  const aff = await importService('recruiterAffiliateService');
  const idn = await importService('recruiterIdentityService');
  const hooks = await import(join(REPO, 'src/lib/recruiterRewardHooks.js'));
  const before = await rowCounts(clone);
  const main = await openCaptureClient(clone, ctx.opt.captureTimeoutMs);
  let deep = null;
  const stmts = new Map();
  let availableCents = null;
  const run = {
    'network.stats.mixed': (db) => net.getNetworkStats(inputs.mixed, { db }),
    'network.nodes.roots.mixed': (db) => net.getNetworkNodes(inputs.mixed, { db }),
    'network.nodes.branch.mixed': (db) => net.getNetworkNodes(inputs.mixed, { db, parentId: inputs.branchNodeId }),
    'network.nodes.unplaced.mixed': (db) => net.getNetworkNodes(inputs.mixed, { db, view: 'unplaced' }),
    'network.tree.wide': (db) => net.loadNetworkTree(inputs.wide, { db }),
    'network.tree.deep': (db) => net.loadNetworkTree(inputs.deep, { db }),
    'reward.reconcile.mixed': (db) => rew.reconcileRecruiterRewards({ db, recruiterId: inputs.mixed }),
    'reward.sync.reverseCandidate': (db) => rew.syncRecruiterReward(inputs.reverseCandidate, { db }),
    'hook.linkedOrder': (db) => {
      if (!inputs.linkedOrderId) throw Object.assign(new Error('no orderId shared by a fake and a real row'), { code: 'NO_INPUT' });
      return hooks.onRecruiterLinkedOrderSynced(inputs.linkedOrderId, { db });
    },
    'affiliate.create.usernameTaken': (db) => {
      if (!inputs.takenUsername) throw Object.assign(new Error('no valid existing username'), { code: 'NO_INPUT' });
      return aff.recruiterCreateAffiliate(inputs.mixed, { username: inputs.takenUsername, name: 'P5a Explain Probe', parentId: inputs.deepestMixedId, requestId: NEW_REQUEST_IDS.affiliate }, { db });
    },
    'affiliate.create.replay': (db) => {
      const r = inputs.replayAffiliate;
      if (!r) throw Object.assign(new Error('no replayable AFFILIATE_CREATED row'), { code: 'NO_INPUT' });
      return aff.recruiterCreateAffiliate(inputs.mixed, { username: r.username, name: r.name, phone: r.phone ?? null, parentId: r.parentId ?? null, requestId: r.requestId }, { db });
    },
    'wallet.mixed': async (db) => { const w = await wal.getRecruiterWallet(inputs.mixed, { db }); availableCents = w?.totals?.availableCents ?? null; return w; },
    'withdrawal.replay': (db) => {
      const r = inputs.replayWithdrawal;
      if (!r) throw Object.assign(new Error('no RECRUITER_WITHDRAWAL_REQUESTED row'), { code: 'NO_INPUT' });
      return wal.requestRecruiterWithdrawal(inputs.mixed, { amountMad: r.cents / 100, requestId: r.requestId }, { db });
    },
    'withdrawal.insufficient': (db) => {
      // Refused unless the amount is certainly above the available balance: the request must not write.
      if (!Number.isFinite(availableCents) || MAX_WITHDRAWAL_MAD * 100 <= availableCents) {
        throw Object.assign(new Error(`not run: available ${availableCents} cents is not below the maximum request — it could write`), { code: 'SKIPPED_WOULD_WRITE' });
      }
      return wal.requestRecruiterWithdrawal(inputs.mixed, { amountMad: MAX_WITHDRAWAL_MAD, requestId: NEW_REQUEST_IDS.withdrawal }, { db });
    },
    'admin.ledger': (db) => wal.adminListRecruiterLedger({ db }),
    'admin.balances': (db) => wal.adminRecruiterBalances({ db }),
    'admin.identities': (db) => idn.adminListRecruiterIdentities({ db }),
  };
  // wallet.mixed must run before withdrawal.insufficient (it provides the available balance)
  const ordered = [...needed];
  if (ordered.some((s) => s.label === 'withdrawal.insufficient') && !ordered.some((s) => s.label === 'wallet.mixed')) ordered.splice(ordered.findIndex((s) => s.label === 'withdrawal.insufficient'), 0, SCENARIOS.find((s) => s.label === 'wallet.mixed'));
  try {
    for (const sc of ordered) {
      let cap = main;
      if (sc.deep) { deep = deep ?? await openCaptureClient(clone, ctx.opt.captureDeepTimeoutMs); cap = deep; }
      cap.state.label = sc.label;
      const mk = cap.rec.mark(sc.label);
      const t0 = now();
      let result = null;
      let error = null;
      try { result = await run[sc.label](cap.db); } catch (e) { error = e; }
      const wallMs = now() - t0;
      const sl = cap.rec.slice(mk);
      cap.state.label = null;
      const own = cap.statements.filter((s) => s.label === sc.label);
      const outcome = describeOutcome(sc.label, result, error);
      const picked = [];
      for (const [key, re] of sc.picks) {
        if (!keys.includes(key)) continue;
        const matches = own.filter((s) => re.test(normSql(s.text)));
        if (!matches.length) {
          if (!OPTIONAL_KEYS.has(key)) problems.push(`capture: ${key} not found in scenario ${sc.label}`);
          picked.push({ key, found: false });
          continue;
        }
        const s = matches[0];
        if (!stmts.has(key)) {
          stmts.set(key, { key, scenario: sc.label, text: s.text, values: s.values, paramCount: s.values.length, textSha1: sha1(s.text),
            valuesSha1: sha1(JSON.stringify(jsonSafe(s.values))), chunk: { index: 0, of: matches.length }, captureMs: s.ms, captureError: s.error });
        }
        picked.push({ key, found: true, statementIndex: s.i, matches: matches.length, paramCount: s.values.length, error: s.error });
      }
      await emit({
        kind: 'capture-scenario', clone, scenario: sc.label, expected: sc.expect, outcome, wallMs, note: 'capture, NOT a measurement (instrumented, capture timeouts)',
        calls: sl.calls.map((c) => ({ op: c.op, model: c.model, txId: c.txId, ms: round3(c.ms), rows: c.rows, error: c.error })),
        statements: own.map((s) => ({ i: s.i, ms: round3(s.ms), rows: s.rows, params: s.values.length, error: s.error, textSha1: sha1(s.text), sql: sqlPreview(s.text, 240) })),
        picked,
      });
      if (!outcome.asExpected) log(`capture ${sc.label}: outcome ${JSON.stringify(outcome)}`);
    }
  } finally {
    await main.close();
    if (deep) await deep.close();
  }
  const after = await rowCounts(clone);
  const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
  if (changed.length) problems.push(`capture wrote rows: ${changed.join(', ')}`);
  const expectedCounts = Object.fromEntries(WRITABLE.map((t) => [t, m.rowCounts?.[t] ?? null]));
  const templateDiff = WRITABLE.filter((t) => expectedCounts[t] !== null && expectedCounts[t] !== before[t]);
  await emit({ kind: 'capture-check', clone, rowCountsBefore: before, rowCountsAfter: after, unchanged: changed.length === 0, changed,
    templateRowCounts: expectedCounts, cloneMatchesTemplate: templateDiff.length === 0, templateDiff });
  for (const key of keys) if (!stmts.has(key) && !OPTIONAL_KEYS.has(key) && !problems.some((p) => p.includes(` ${key} `))) problems.push(`capture: ${key} missing`);
  return stmts;
}

function describeOutcome(label, result, error) {
  const errCode = error ? (error.code ?? error.name ?? 'ERROR') : null;
  const o = { error: errCode ? { code: errCode, message: String(error.message ?? '').slice(0, 300) } : null };
  switch (label) {
    case 'reward.reconcile.mixed': Object.assign(o, { result: result ?? null, asExpected: !error && result?.awarded === 0 && result?.reversed === 0 }); break;
    case 'reward.sync.reverseCandidate': Object.assign(o, { result: result ?? null, asExpected: !error && result?.action === 'NO_CHANGE' }); break;
    case 'hook.linkedOrder': Object.assign(o, { result: result ?? null, asExpected: !error && result?.action === 'SYNCED' }); break;
    case 'affiliate.create.usernameTaken': Object.assign(o, { asExpected: errCode === 'USERNAME_TAKEN' }); break;
    case 'affiliate.create.replay': Object.assign(o, { result: result ? { replayed: result.replayed } : null, asExpected: !error && result?.replayed === true }); break;
    case 'withdrawal.replay': Object.assign(o, { result: result ? { replayed: result.replayed, status: result.withdrawal?.status } : null, asExpected: !error && result?.replayed === true }); break;
    case 'withdrawal.insufficient': Object.assign(o, { asExpected: errCode === 'INSUFFICIENT_BALANCE' }); break;
    case 'network.tree.deep': Object.assign(o, { result: result ? { members: result.members, placed: result.nodes?.size } : null, asExpected: !error || errCode === 'P2028' || /timeout|cancel/i.test(String(error?.message)) || String(error?.message).includes('57014') }); break;
    default: {
      const shape = Array.isArray(result) ? { rows: result.length } : result && typeof result === 'object'
        ? Object.fromEntries(Object.entries(result).filter(([, v]) => typeof v !== 'object' || v === null).slice(0, 8)) : result;
      Object.assign(o, { result: shape ?? null, asExpected: !error });
    }
  }
  return o;
}

// ── EXPLAIN ──────────────────────────────────────────────────────────────────
async function openSession(clone, statementTimeoutMs, appName) {
  const c = new pg.Client({ connectionString: cloneUrl(clone), application_name: appName });
  await c.connect();
  await c.query(`SET statement_timeout = ${Number(statementTimeoutMs)}`);
  return c;
}

async function sessionSettings(session) {
  const r = await session.query(`${ADMIN} SELECT name, setting, unit, source FROM pg_settings WHERE name IN ('statement_timeout','work_mem','shared_buffers',
    'effective_cache_size','random_page_cost','seq_page_cost','jit','jit_above_cost','enable_mergejoin','enable_hashjoin','enable_nestloop','enable_seqscan',
    'enable_indexscan','enable_bitmapscan','enable_indexonlyscan','max_parallel_workers_per_gather','default_statistics_target','track_io_timing',
    'maintenance_work_mem','temp_buffers','lc_collate','server_version') ORDER BY name`);
  return r.rows;
}

/** One EXPLAIN of a captured statement with its exact bind values. */
async function explainOnce(session, stmt, format) {
  const opts = format === 'json' ? 'ANALYZE, BUFFERS, SETTINGS, FORMAT JSON' : 'ANALYZE, BUFFERS, SETTINGS, FORMAT TEXT';
  const t0 = now();
  try {
    const res = await session.query({ text: `EXPLAIN (${opts}) ${stmt.text}`, values: stmt.values });
    const wallMs = now() - t0;
    if (format === 'json') {
      let doc = res.rows[0]?.['QUERY PLAN'];
      if (typeof doc === 'string') doc = JSON.parse(doc);
      return { ok: true, wallMs, doc };
    }
    return { ok: true, wallMs, text: res.rows.map((r) => r['QUERY PLAN']).join('\n') };
  } catch (e) {
    return { ok: false, wallMs: now() - t0, error: errorInfo(e), timeout: e?.code === '57014' };
  }
}

const bufferFields = (n) => (n ? {
  sharedHit: num(n['Shared Hit Blocks']), sharedRead: num(n['Shared Read Blocks']), sharedDirtied: num(n['Shared Dirtied Blocks']),
  sharedWritten: num(n['Shared Written Blocks']), localHit: num(n['Local Hit Blocks']), localRead: num(n['Local Read Blocks']),
  tempRead: num(n['Temp Read Blocks']), tempWritten: num(n['Temp Written Blocks']),
  ioReadMs: num(n['I/O Read Time'] ?? n['Shared I/O Read Time']), ioWriteMs: num(n['I/O Write Time'] ?? n['Shared I/O Write Time']),
} : null);

/** Facts of a FORMAT JSON plan: timings, buffers, the plan shape (fingerprint) and the access paths used. */
function analyzePlan(doc) {
  const root = Array.isArray(doc) ? doc[0] : doc;
  const top = root?.Plan ?? null;
  const nodes = [];
  const walk = (n, depth) => { if (!n) return; nodes.push({ n, depth }); for (const c of n.Plans ?? []) walk(c, depth + 1); };
  walk(top, 0);
  const label = (n) => {
    const type = n['Node Type'];
    const parts = [type];
    if (n.Strategy && n.Strategy !== 'Plain') parts.push(`/${n.Strategy}`);
    if (n['Join Type'] && (type.includes('Join') || type === 'Nested Loop')) parts.push(`/${n['Join Type']}`);
    if (n['Relation Name'] || n['Index Name']) parts.push(`(${n['Relation Name'] ?? ''}${n['Index Name'] ? `:${n['Index Name']}` : ''})`);
    if (n['CTE Name']) parts.push(`[${n['CTE Name']}]`);
    return parts.join('');
  };
  const fingerprint = nodes.map(({ n, depth }) => `${depth}:${label(n)}`).join(' ');
  const seqScans = [];
  const indexes = [];
  const sorts = [];
  const joins = [];
  let heapFetches = 0;
  let indexOnlyScans = 0;
  let workersLaunched = 0;
  let rowsRemovedByFilter = 0;
  for (const { n } of nodes) {
    const type = n['Node Type'];
    if (type === 'Seq Scan') seqScans.push(n['Relation Name']);
    if (n['Index Name']) indexes.push(`${type}:${n['Index Name']}`);
    if (type === 'Index Only Scan') { indexOnlyScans += 1; heapFetches += num(n['Heap Fetches']) ?? 0; }
    if (type === 'Sort' || type === 'Incremental Sort') sorts.push({ type, method: n['Sort Method'] ?? null, space: n['Sort Space Type'] ?? null, kb: num(n['Sort Space Used']) });
    if (type.includes('Join') || type === 'Nested Loop') joins.push(`${type}${n['Join Type'] ? `/${n['Join Type']}` : ''}`);
    workersLaunched += num(n['Workers Launched']) ?? 0;
    rowsRemovedByFilter += (num(n['Rows Removed by Filter']) ?? 0) * (num(n['Actual Loops']) ?? 1);
  }
  return {
    executionMs: num(root?.['Execution Time']), planningMs: num(root?.['Planning Time']),
    buffers: bufferFields(top), planningBuffers: bufferFields(root?.Planning),
    jit: root?.JIT ? { functions: num(root.JIT.Functions), totalMs: num(root.JIT.Timing?.Total) } : null,
    settings: root?.Settings ?? null,
    triggers: Array.isArray(root?.Triggers) ? root.Triggers.map((t) => ({ name: t['Trigger Name'], relation: t.Relation ?? null, ms: num(t.Time), calls: num(t.Calls) })) : null,
    wal: top && top['WAL Records'] !== undefined ? { records: num(top['WAL Records']), fpi: num(top['WAL FPI']), bytes: num(top['WAL Bytes']) } : null,
    plan: {
      shape: sha1(fingerprint).slice(0, 12), fingerprint: fingerprint.length > 1500 ? `${fingerprint.slice(0, 1500)}…` : fingerprint,
      top: top ? label(top) : null, topRows: num(top?.['Actual Rows']), topLoops: num(top?.['Actual Loops']), topPlanRows: num(top?.['Plan Rows']), totalCost: num(top?.['Total Cost']),
      nodes: nodes.length, seqScans: [...new Set(seqScans)], indexes: [...new Set(indexes)], indexOnlyScans, heapFetches, sorts, joins: [...new Set(joins)],
      mergeJoin: joins.some((j) => j.startsWith('Merge Join')), workersLaunched, rowsRemovedByFilter,
    },
  };
}

function pathFor(ctx, variant, phaseDir, file) {
  const dir = join(PLANS_DIR, ctx.scale, ctx.runId, variant, phaseDir);
  mkdirSync(dir, { recursive: true });
  return join(dir, file);
}
const rel = (p) => relative(RESULTS_DIR, p);

/** Warm-ups + measured JSON runs + one TEXT run of one key; every run is a `sample` line. → summary */
async function measureKey(ctx, session, variant, phase, alt, key, stmt) {
  const { opt, emit } = ctx;
  const phaseDir = alt ? `${phase}.${alt}` : phase;
  const base = { runId: ctx.runId, run: opt.run, scale: ctx.scale, variant, clone: ctx.clone, phase, alt: alt ?? null, key };
  const jsonPlans = [];
  const samples = [];
  const adapted = [];
  const started = now();
  let stopped = null;
  const one = async (sampleKind, rep, format) => {
    const r = await explainOnce(session, stmt, format);
    let facts = null;
    if (r.ok && format === 'json') facts = analyzePlan(r.doc);
    if (r.ok && format === 'text') {
      const ex = r.text.match(/Execution Time: ([0-9.]+) ms/);
      const pl = r.text.match(/Planning Time: ([0-9.]+) ms/);
      facts = { executionMs: ex ? Number(ex[1]) : null, planningMs: pl ? Number(pl[1]) : null };
    }
    const s = {
      kind: 'sample', ...base, sampleKind, rep, format, ok: r.ok, timeout: r.timeout ?? false, error: r.error ?? null, wallMs: round3(r.wallMs),
      executionMs: facts?.executionMs ?? null, planningMs: facts?.planningMs ?? null, buffers: facts?.buffers ?? null, planningBuffers: facts?.planningBuffers ?? null,
      jit: facts?.jit ?? null, settings: facts?.settings ?? null, plan: facts?.plan ?? null, loadavg1: round3(os.loadavg()[0]),
    };
    if (r.ok && format === 'json') jsonPlans.push({ sampleKind, rep, executionMs: s.executionMs, plan: r.doc });
    if (r.ok && format === 'text') {
      const file = pathFor(ctx, variant, phaseDir, `${key}.txt`);
      writeFileSync(file, [`-- ${HARNESS} | scale ${ctx.scale} | variant ${variant} | phase ${phaseDir} | key ${key} | run ${ctx.runId}`,
        `-- ${KEYS[key]}`, `-- captured from scenario ${stmt.scenario}; ${stmt.paramCount} bind values (exact values: ${rel(ctx.captureFile)}, key ${key}); text sha1 ${stmt.textSha1}`,
        `-- EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT TEXT) of:`, ...stmt.text.split('\n').map((l) => `--   ${l}`), '', r.text, ''].join('\n'));
      s.planFile = rel(file);
    }
    samples.push(s);
    await emit(s);
    if (!r.ok) stopped = r.timeout ? 'timeout' : 'error';
    return s;
  };
  for (let w = 0; w < opt.warmups && !stopped; w += 1) {
    const s = await one('warmup', w, 'json');
    if (s.ok && s.wallMs > opt.slowWarmupMs && w + 1 < opt.warmups) { adapted.push(`warm-ups stopped after ${w + 1} (one took ${Math.round(s.wallMs)} ms > ${opt.slowWarmupMs} ms)`); break; }
  }
  let reps = opt.reps;
  for (let i = 0; i < reps && !stopped; i += 1) {
    const s = await one('measured', i, 'json');
    if (i === 0 && s.ok) {
      const elapsedS = (now() - started) / 1000;
      const perRunS = s.wallMs / 1000;
      const projected = elapsedS + perRunS * reps; // remaining reps - 1 + the TEXT run
      if (projected > opt.keyBudgetS) {
        const fit = Math.max(1, Math.floor((opt.keyBudgetS - elapsedS) / perRunS) - 1);
        if (fit < reps) { adapted.push(`reps reduced ${reps} → ${fit} (projected ${Math.round(projected)} s > key budget ${opt.keyBudgetS} s)`); reps = fit; }
      }
    }
  }
  if (!stopped) await one('text', 0, 'text');
  let plansFile = null;
  if (jsonPlans.length) {
    plansFile = pathFor(ctx, variant, phaseDir, `${key}.json`);
    writeFileSync(plansFile, JSON.stringify({ harness: HARNESS, scale: ctx.scale, runId: ctx.runId, variant, phase, alt: alt ?? null, key, description: KEYS[key],
      scenario: stmt.scenario, textSha1: stmt.textSha1, valuesSha1: stmt.valuesSha1, paramCount: stmt.paramCount, sql: stmt.text, runs: jsonPlans }));
  }
  return summarizeKey(ctx, base, stmt, samples, adapted, stopped, plansFile);
}

function summarizeKey(ctx, base, stmt, samples, adapted, stopped, plansFile) {
  const measured = samples.filter((s) => s.sampleKind === 'measured' && s.ok);
  const pick = (f) => measured.map(f).filter((x) => typeof x === 'number' && Number.isFinite(x));
  const ex = summarize(pick((s) => s.executionMs));
  const shapes = {};
  for (const s of measured) shapes[s.plan.shape] = (shapes[s.plan.shape] ?? 0) + 1;
  const sorted = [...measured].sort((a, b) => a.executionMs - b.executionMs);
  const median = sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)] : null;
  const text = samples.find((s) => s.sampleKind === 'text' && s.ok) ?? null;
  const spread = ex.n ? { rangeMs: round3(ex.max - ex.min), relRange: ex.p50 ? round3((ex.max - ex.min) / ex.p50) : null } : null;
  return {
    kind: 'summary', ...base, description: KEYS[base.key], scenario: stmt.scenario, paramCount: stmt.paramCount, textSha1: stmt.textSha1, valuesSha1: stmt.valuesSha1,
    n: ex.n, executionMs: ex, spread, planningMs: summarize(pick((s) => s.planningMs)), wallMs: summarize(pick((s) => s.wallMs)),
    sharedHit: summarize(pick((s) => s.buffers?.sharedHit)), sharedRead: summarize(pick((s) => s.buffers?.sharedRead)),
    tempWritten: summarize(pick((s) => s.buffers?.tempWritten)), heapFetches: summarize(pick((s) => s.plan?.heapFetches)),
    jitMs: summarize(pick((s) => s.jit?.totalMs)), planShapes: shapes, stablePlan: Object.keys(shapes).length <= 1,
    medianPlan: median ? { rep: median.rep, shape: median.plan.shape, top: median.plan.top, topRows: median.plan.topRows, topPlanRows: median.plan.topPlanRows,
      seqScans: median.plan.seqScans, indexes: median.plan.indexes, indexOnlyScans: median.plan.indexOnlyScans, heapFetches: median.plan.heapFetches,
      mergeJoin: median.plan.mergeJoin, joins: median.plan.joins, sorts: median.plan.sorts, fingerprint: median.plan.fingerprint } : null,
    warmups: samples.filter((s) => s.sampleKind === 'warmup').length, textRun: text ? { executionMs: text.executionMs, planFile: text.planFile } : null,
    timeouts: samples.filter((s) => s.timeout).length, errors: samples.filter((s) => !s.ok && !s.timeout).map((s) => s.error), stopped,
    adapted, plansFile: plansFile ? rel(plansFile) : null,
  };
}

/** Ratios to a reference summary (same key): p50 time and p50 shared hits (raw numbers, no interpretation). */
function compareTo(ref, cur, label) {
  if (!ref || !cur || !ref.n || !cur.n) return null;
  const ratio = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? round3(a / b) : null);
  return { against: label, refRunId: ref.runId, refPhase: ref.phase, refP50Ms: ref.executionMs.p50, p50Ms: cur.executionMs.p50,
    p50Ratio: ratio(cur.executionMs.p50, ref.executionMs.p50), p50DeltaMs: round3(cur.executionMs.p50 - ref.executionMs.p50),
    sharedHitP50Ratio: ratio(cur.sharedHit.p50, ref.sharedHit.p50), refShape: ref.medianPlan?.shape ?? null, shape: cur.medianPlan?.shape ?? null,
    samePlanShape: (ref.medianPlan?.shape ?? null) === (cur.medianPlan?.shape ?? null) };
}

async function runPhase(ctx, session, variant, phase, alt, keys, stmts, refs) {
  const out = new Map();
  const statBefore = await statSnapshot(ctx.clone);
  log(`${variant} ${phase}${alt ? `.${alt}` : ''}: ${keys.length} keys`);
  for (const key of keys) {
    const stmt = stmts.get(key);
    if (!stmt) continue;
    const t0 = now();
    const sum = await measureKey(ctx, session, variant, phase, alt, key, stmt);
    sum.vsBefore = compareTo(refs.before?.get(key), sum, 'same clone, phase before');
    sum.vsV0 = variant === 'V0' ? null : compareTo(ctx.v0?.get(key), sum, `V0 as_built, latest with run label ${ctx.opt.run} in the results file`);
    await ctx.emit(sum);
    out.set(key, sum);
    if (sum.stopped) ctx.notes.push(`${variant} ${phase}${alt ? `.${alt}` : ''} ${key}: ${sum.stopped}`);
    log(`  ${key}: n=${sum.n} p50=${sum.executionMs.p50 === null ? '-' : `${round3(sum.executionMs.p50)} ms`}${sum.stopped ? ` (${sum.stopped})` : ''} [${Math.round(now() - t0)} ms]`);
  }
  await flushStats(session);
  const statAfter = await statSnapshot(ctx.clone);
  await ctx.emit({ kind: 'phase-stats', runId: ctx.runId, scale: ctx.scale, variant, clone: ctx.clone, phase, alt: alt ?? null, usage: statDelta(statBefore, statAfter),
    activityAtEnd: await clusterActivity(ctx.clone) });
  return out;
}

// ── statistics, inventory, origins ───────────────────────────────────────────
async function flushStats(session) {
  await session.query('SELECT pg_stat_force_next_flush()');
  await sleep(300);
}

async function statSnapshot(clone) {
  const idx = await pgQuery(clone, `${ADMIN} SELECT relname AS "table", indexrelname AS "index", idx_scan::bigint AS idx_scan, idx_tup_read::bigint AS idx_tup_read,
    idx_tup_fetch::bigint AS idx_tup_fetch FROM pg_stat_user_indexes WHERE schemaname = 'public' AND relname = ANY($1::text[])`, [TABLES]);
  const tab = await pgQuery(clone, `${ADMIN} SELECT relname AS "table", seq_scan::bigint AS seq_scan, seq_tup_read::bigint AS seq_tup_read,
    coalesce(idx_scan, 0)::bigint AS idx_scan, coalesce(idx_tup_fetch, 0)::bigint AS idx_tup_fetch FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = ANY($1::text[])`, [TABLES]);
  return { idx, tab };
}

function statDelta(a, b) {
  const key = (r) => `${r.table}.${r.index ?? ''}`;
  const prev = new Map([...a.idx, ...a.tab].map((r) => [key(r), r]));
  const diff = (r, fields) => Object.fromEntries(fields.map((f) => [f, Number(r[f]) - Number(prev.get(key(r))?.[f] ?? 0)]));
  return {
    indexes: b.idx.map((r) => ({ table: r.table, index: r.index, ...diff(r, ['idx_scan', 'idx_tup_read', 'idx_tup_fetch']) })).filter((r) => r.idx_scan || r.idx_tup_read),
    tables: b.tab.map((r) => ({ table: r.table, ...diff(r, ['seq_scan', 'seq_tup_read', 'idx_scan', 'idx_tup_fetch']) })).filter((r) => r.seq_scan || r.idx_scan),
  };
}

let migrationCache = null;
/** Index / constraint / table events of the committed migrations (prisma/migrations/<dir>/migration.sql). */
function migrationCatalog() {
  if (migrationCache) return migrationCache;
  const dir = join(REPO, 'prisma/migrations');
  const events = new Map();
  const tables = new Map();
  const add = (map, name, ev) => { if (!map.has(name)) map.set(name, []); map.get(name).push(ev); };
  const dirs = readdirSync(dir).filter((d) => existsSync(join(dir, d, 'migration.sql'))).sort();
  for (const d of dirs) {
    const lines = readFileSync(join(dir, d, 'migration.sql'), 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const line = raw.replace(/--.*$/, '');
      const ev = (kind) => ({ migration: d, line: i + 1, kind, statement: raw.trim().slice(0, 200) });
      for (const mm of line.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) add(events, mm[1], ev('create-index'));
      for (const mm of line.matchAll(/DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi)) add(events, mm[1], ev('drop-index'));
      for (const mm of line.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi)) add(events, mm[1], ev('drop-constraint'));
      for (const mm of line.matchAll(/(?<!DROP\s)CONSTRAINT\s+"([^"]+)"/gi)) if (!/DROP\s+CONSTRAINT/i.test(line) && !/VALIDATE\s+CONSTRAINT/i.test(line)) add(events, mm[1], ev('constraint'));
      for (const mm of line.matchAll(/RENAME\s+(?:CONSTRAINT\s+"[^"]+"\s+)?TO\s+"([^"]+)"/gi)) add(events, mm[1], ev('rename-to'));
      for (const mm of line.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) add(tables, mm[1], ev('create-table'));
    });
  }
  migrationCache = { migrations: dirs.length, events, tables };
  return migrationCache;
}

function originOf(name) {
  // events are in file order (migration directory, then line): the LAST create / drop decides
  const evs = migrationCatalog().events.get(name) ?? [];
  const lastCreate = evs.findLastIndex((e) => ['create-index', 'constraint', 'rename-to'].includes(e.kind));
  const lastDrop = evs.findLastIndex((e) => e.kind.startsWith('drop'));
  const origin = lastCreate < 0 ? 'schema.prisma-only' : lastDrop > lastCreate ? 'committed-migration-then-dropped' : 'committed-migration';
  return { origin, migrations: evs.map((e) => ({ migration: e.migration, line: e.line, kind: e.kind, statement: e.statement })) };
}

async function inventory(ctx, clone, s0, s1) {
  const q = (sql, params = []) => pgQuery(clone, `${ADMIN} ${sql}`, params);
  const indexes = await q(`SELECT t.relname AS "table", ic.relname AS "index", pi.indexdef, am.amname AS method, ix.indisprimary AS "primary", ix.indisunique AS "unique",
      ix.indisvalid AS valid, ix.indisready AS ready, ix.indnkeyatts AS "keyColumns", ix.indnatts AS columns, pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
      (ix.indexprs IS NOT NULL) AS expression, pg_relation_size(ix.indexrelid)::bigint AS bytes, con.conname AS "constraint", con.contype AS "constraintType",
      coalesce(s.idx_scan, 0)::bigint AS idx_scan, coalesce(s.idx_tup_read, 0)::bigint AS idx_tup_read, coalesce(s.idx_tup_fetch, 0)::bigint AS idx_tup_fetch, s.last_idx_scan
    FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public' JOIN pg_am am ON am.oid = ic.relam
    JOIN pg_indexes pi ON pi.schemaname = n.nspname AND pi.tablename = t.relname AND pi.indexname = ic.relname
    LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x')
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
    WHERE t.relname = ANY($1::text[]) ORDER BY 1, 2`, [TABLES]);
  const constraints = await q(`SELECT t.relname AS "table", c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated,
      CASE WHEN c.conindid <> 0 THEN c.conindid::regclass::text END AS "index"
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    WHERE t.relname = ANY($1::text[]) ORDER BY 1, 2`, [TABLES]);
  const tables = await q(`SELECT t.relname AS "table", t.reltuples::bigint AS reltuples, t.relpages, t.relallvisible, pg_relation_size(t.oid)::bigint AS "heapBytes",
      pg_indexes_size(t.oid)::bigint AS "indexBytes", pg_total_relation_size(t.oid)::bigint AS "totalBytes", s.n_live_tup::bigint AS n_live_tup, s.n_dead_tup::bigint AS n_dead_tup,
      s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze
    FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public' LEFT JOIN pg_stat_user_tables s ON s.relid = t.oid
    WHERE t.relkind = 'r' AND t.relname = ANY($1::text[]) ORDER BY 1`, [TABLES]);
  const triggers = await q(`SELECT tgrelid::regclass::text AS "table", tgname AS name, tgenabled AS enabled FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace) ORDER BY 1, 2`, [TABLES]);
  const cat = migrationCatalog();
  const usage = s0 && s1 ? statDelta(s0, s1) : null;
  return {
    kind: 'inventory', runId: ctx.runId, scale: ctx.scale, variant: ctx.variant, clone,
    note: "origin = 'committed-migration' when a file of prisma/migrations creates the name (CREATE INDEX / CONSTRAINT), else 'schema.prisma-only' (the disposable DB's base is the 3607da3 datamodel = schema.prisma); idx_scan columns are cumulative since the clone was created",
    migrationsScanned: cat.migrations,
    tablesCreatedByMigrations: Object.fromEntries(TABLES.map((t) => [t, (cat.tables.get(t) ?? []).map((e) => `${e.migration}:${e.line}`)])),
    indexes: indexes.map((r) => ({ ...r, bytes: Number(r.bytes), idx_scan: Number(r.idx_scan), idx_tup_read: Number(r.idx_tup_read), idx_tup_fetch: Number(r.idx_tup_fetch), ...originOf(r.index) })),
    constraints: constraints.map((r) => ({ ...r, ...originOf(r.name) })),
    tables: tables.map((r) => ({ ...r, reltuples: Number(r.reltuples), heapBytes: Number(r.heapBytes), indexBytes: Number(r.indexBytes), totalBytes: Number(r.totalBytes),
      n_live_tup: num(r.n_live_tup), n_dead_tup: num(r.n_dead_tup) })),
    triggers, usageSinceCapture: usage,
  };
}

// ── DDL on the clone ─────────────────────────────────────────────────────────
const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;
async function ddl(ctx, session, action, sql, extra = {}) {
  const t0 = now();
  let error = null;
  try { await session.query(sql); } catch (e) { error = errorInfo(e); }
  const ms = now() - t0;
  const rec = { kind: 'ddl', runId: ctx.runId, scale: ctx.scale, variant: ctx.variant, clone: ctx.clone, action, sql, ms: round3(ms), error, ...extra };
  await ctx.emit(rec);
  if (error) throw Object.assign(new Error(`${action} failed: ${error.message}`), { code: error.code });
  return rec;
}

async function indexSize(session, name) {
  const r = await session.query(`${ADMIN} SELECT pg_relation_size(c.oid)::bigint AS bytes, c.relpages, i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`, [name]);
  return r.rows[0] ? { bytes: Number(r.rows[0].bytes), relpages: r.rows[0].relpages, valid: r.rows[0].valid } : null;
}

async function createIndex(ctx, session, table, alt, { purpose, concurrently = false } = {}) {
  if (!IDENT_RE.test(alt.name) || !TABLES.includes(table)) throw new Error(`${HARNESS}: invalid index ${alt.name}`);
  const sql = `CREATE INDEX${concurrently ? ' CONCURRENTLY' : ''} "${alt.name}" ON "${table}" ${alt.cols}`;
  const rec = await ddl(ctx, session, concurrently ? 'create-index-concurrently' : 'create-index', sql, { alt: alt.alt, index: alt.name, table, purpose });
  const size = await indexSize(session, alt.name);
  await ctx.emit({ kind: 'ddl', runId: ctx.runId, scale: ctx.scale, variant: ctx.variant, clone: ctx.clone, action: 'index-size', alt: alt.alt, index: alt.name, table, purpose, ...size });
  return { ms: rec.ms, ...size };
}

async function dropIndex(ctx, session, name, purpose) {
  if (!IDENT_RE.test(name) && !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`${HARNESS}: invalid index ${name}`);
  const size = await indexSize(session, name);
  return ddl(ctx, session, 'drop-index', `DROP INDEX "${name}"`, { index: name, purpose, sizeBeforeDrop: size });
}

async function vmReport(ctx, session, table, stage) {
  let pgVisibility = null;
  try {
    const r = await session.query(`${ADMIN} SELECT all_visible::bigint AS all_visible, all_frozen::bigint AS all_frozen FROM pg_visibility_map_summary($1::regclass)`, [table]);
    pgVisibility = { allVisiblePages: Number(r.rows[0].all_visible), allFrozenPages: Number(r.rows[0].all_frozen) };
  } catch (e) { pgVisibility = { error: errorInfo(e) }; }
  const c = await session.query(`${ADMIN} SELECT relpages, relallvisible, reltuples::bigint AS reltuples,
    (pg_relation_size($1::regclass) / current_setting('block_size')::int)::bigint AS "actualPages" FROM pg_class WHERE oid = $1::regclass`, [table]);
  const row = c.rows[0];
  const rec = { kind: 'vm', runId: ctx.runId, scale: ctx.scale, variant: ctx.variant, clone: ctx.clone, table, stage, relpages: row.relpages, relallvisible: row.relallvisible,
    reltuples: Number(row.reltuples), actualPages: Number(row.actualPages), pgVisibility,
    allVisibleFraction: pgVisibility?.allVisiblePages !== undefined && Number(row.actualPages) ? round3(pgVisibility.allVisiblePages / Number(row.actualPages)) : null };
  await ctx.emit(rec);
  return rec;
}

async function indexUsage(ctx, clone, name) {
  const [r] = await pgQuery(clone, `${ADMIN} SELECT coalesce(idx_scan, 0)::bigint AS idx_scan, coalesce(idx_tup_read, 0)::bigint AS idx_tup_read,
    coalesce(idx_tup_fetch, 0)::bigint AS idx_tup_fetch FROM pg_stat_user_indexes WHERE indexrelname = $1`, [name]);
  return r ? { idx_scan: Number(r.idx_scan), idx_tup_read: Number(r.idx_tup_read), idx_tup_fetch: Number(r.idx_tup_fetch) } : null;
}

// ── write cost ───────────────────────────────────────────────────────────────
const H = (seed) => `((hashtext(${seed})::bigint + 2147483648))`; // 0 .. 2^32-1, deterministic
function writeSql(table, rows) {
  if (!Number.isInteger(rows) || rows < 1) throw new Error('invalid rows');
  if (table === 'affiliate_orders') {
    return {
      setup: `CREATE TEMP TABLE p5a_src_affiliate_orders AS
        WITH a AS MATERIALIZED (SELECT "id", (row_number() OVER (ORDER BY "id"))::int AS n FROM "affiliates"),
             c AS (SELECT count(*)::int AS total FROM a),
             t AS (SELECT coalesce(max("createdAt"), timestamp '2026-01-01') AS base FROM "affiliate_orders")
        SELECT md5('p5a:exp:w:ord:id:' || g)::uuid::text AS "id", a."id" AS "affiliateId", md5('p5a:exp:w:ord:oid:' || g)::uuid::text AS "orderId",
               (ARRAY['pending','confirmed','shipped','delivered','cancelled'])[1 + (${H("'p5a:exp:w:ord:st:' || g")} % 5)::int] AS "status",
               (${H("'p5a:exp:w:ord:fk:' || g")} % 10 = 0) AS "isFake", (100 + ${H("'p5a:exp:w:ord:tot:' || g")} % 900)::float8 AS "total",
               (10 + ${H("'p5a:exp:w:ord:com:' || g")} % 90)::float8 AS "commissionAmount", t.base + make_interval(secs => g) AS "createdAt"
        FROM generate_series(1, ${rows}) g CROSS JOIN c CROSS JOIN t JOIN a ON a.n = 1 + (${H("'p5a:exp:w:ord:aff:' || g")} % c.total)::int`,
      insert: `INSERT INTO "affiliate_orders" ("id", "affiliateId", "orderId", "status", "isFake", "total", "commissionAmount", "createdAt")
        SELECT "id", "affiliateId", "orderId", "status", "isFake", "total", "commissionAmount", "createdAt" FROM pg_temp.p5a_src_affiliate_orders`,
      temp: 'p5a_src_affiliate_orders',
    };
  }
  if (table === 'recruiter_audit_log') {
    return {
      setup: `CREATE TEMP TABLE p5a_src_recruiter_audit_log AS
        WITH r AS MATERIALIZED (SELECT "id", (row_number() OVER (ORDER BY "id"))::int AS n FROM "recruiters"),
             c AS (SELECT count(*)::int AS total FROM r),
             t AS (SELECT coalesce(max("createdAt"), timestamp '2026-01-01') AS base FROM "recruiter_audit_log")
        SELECT md5('p5a:exp:w:aud:id:' || g)::uuid::text AS "id", r."id" AS "recruiterId", 'RECRUITER' AS "actorType", r."id" AS "actorId",
               (ARRAY['AFFILIATE_CREATED','RECRUITER_WITHDRAWAL_REQUESTED','RECRUIT_REWARD_EARNED'])[1 + (${H("'p5a:exp:w:aud:act:' || g")} % 3)::int] AS "action",
               'affiliate' AS "entityType", md5('p5a:exp:w:aud:ent:' || g)::uuid::text AS "entityId",
               jsonb_build_object('requestId', md5('p5a:exp:w:aud:req:' || g)::uuid::text, 'username', 'p5a_w_' || g, 'parentId', NULL, 'activationCodeId', NULL) AS "details",
               t.base + make_interval(secs => g) AS "createdAt"
        FROM generate_series(1, ${rows}) g CROSS JOIN c CROSS JOIN t JOIN r ON r.n = 1 + (g % c.total)`,
      insert: `INSERT INTO "recruiter_audit_log" ("id", "recruiterId", "actorType", "actorId", "action", "entityType", "entityId", "details", "createdAt")
        SELECT "id", "recruiterId", "actorType", "actorId", "action", "entityType", "entityId", "details", "createdAt" FROM pg_temp.p5a_src_recruiter_audit_log`,
      temp: 'p5a_src_recruiter_audit_log',
    };
  }
  if (table === 'recruiter_reward_ledger') {
    return {
      setup: `CREATE TEMP TABLE p5a_src_recruiter_reward_ledger AS
        WITH r AS MATERIALIZED (SELECT "id", (row_number() OVER (ORDER BY "id"))::int AS n FROM "recruiters"),
             c AS (SELECT count(*)::int AS total FROM r),
             t AS (SELECT coalesce(max("createdAt"), timestamp '2026-01-01') AS base FROM "recruiter_reward_ledger")
        SELECT md5('p5a:exp:w:led:id:' || g)::uuid::text AS "id", r."id" AS "recruiterId", NULL::text AS "affiliateId", 'ADMIN_ADJUSTMENT' AS "type",
               (100 * (1 + g % 50))::int AS "amountCents", 'p5a-exp-write:' || md5('p5a:exp:w:led:key:' || g) AS "idempotencyKey",
               'p5a write-cost probe (rolled back)' AS "reason", 'ADMIN' AS "actorType", 'p5a-exp' AS "actorId", NULL::int AS "settingsVersion", 1 AS "cycle",
               t.base + make_interval(secs => g) AS "createdAt"
        FROM generate_series(1, ${rows}) g CROSS JOIN c CROSS JOIN t JOIN r ON r.n = 1 + (g % c.total)`,
      insert: `INSERT INTO "recruiter_reward_ledger" ("id", "recruiterId", "affiliateId", "type", "amountCents", "idempotencyKey", "reason", "actorType", "actorId", "settingsVersion", "cycle", "createdAt")
        SELECT "id", "recruiterId", "affiliateId", "type", "amountCents", "idempotencyKey", "reason", "actorType", "actorId", "settingsVersion", "cycle", "createdAt"
        FROM pg_temp.p5a_src_recruiter_reward_ledger`,
      temp: 'p5a_src_recruiter_reward_ledger',
    };
  }
  throw new Error(`${HARNESS}: no write spec for ${table}`);
}

/**
 * Insert cost of a fixed batch without / with each index of the variant: 1 discarded round, then
 * --write-reps rounds interleaved (none, alt1, alt2, …). Every round: [CREATE INDEX] BEGIN; EXPLAIN
 * (ANALYZE, TIMING OFF, BUFFERS, WAL) INSERT …; ROLLBACK; VACUUM (INDEX_CLEANUP ON) <table>; [DROP INDEX]. Then one CREATE
 * INDEX CONCURRENTLY per index. The table ends as it started (rolled back + vacuumed).
 */
async function writeCost(ctx, v) {
  const table = v.write;
  const spec = WRITE_SPECS[table];
  const sqls = writeSql(table, spec.rows);
  const session = await openSession(ctx.clone, ctx.opt.statementTimeoutMs, 'p5a-exp-write');
  ctx.sessions.add(session);
  const base = { runId: ctx.runId, run: ctx.opt.run, scale: ctx.scale, variant: ctx.variant, clone: ctx.clone, table };
  try {
    for (const alt of v.alts) await ddl(ctx, session, 'drop-index-if-exists', `DROP INDEX IF EXISTS "${alt.name}"`, { index: alt.name, purpose: 'write cost starts without the index' });
    const t0 = now();
    await session.query(sqls.setup);
    const setupMs = now() - t0;
    const n = Number((await session.query(`SELECT count(*)::bigint AS n FROM pg_temp.${sqls.temp}`)).rows[0].n);
    const sizeBefore = Number((await session.query(`SELECT pg_relation_size($1::regclass)::bigint AS b`, [table])).rows[0].b);
    await ctx.emit({ kind: 'write-setup', ...base, rows: n, setupMs: round3(setupMs), note: spec.note, tableBytesBefore: sizeBefore, insertSql: sqls.insert });
    const samples = [];
    const round = async (alt, rep, warmup) => {
      let build = null;
      if (alt) build = await createIndex(ctx, session, table, alt, { purpose: 'write-round' });
      const w0 = now();
      await session.query('BEGIN');
      let facts = null;
      let error = null;
      try {
        const r = await session.query(`EXPLAIN (ANALYZE, TIMING OFF, BUFFERS, WAL, FORMAT JSON) ${sqls.insert}`);
        let doc = r.rows[0]['QUERY PLAN'];
        if (typeof doc === 'string') doc = JSON.parse(doc);
        facts = analyzePlan(doc);
      } catch (e) { error = errorInfo(e); }
      const insertWallMs = now() - w0;
      await session.query('ROLLBACK');
      const v0 = now();
      await session.query(`VACUUM (INDEX_CLEANUP ON) "${table}"`); // never bypass index vacuuming: the table / indexes end as they started
      const vacuumMs = now() - v0;
      if (alt) await dropIndex(ctx, session, alt.name, 'write-round');
      const s = { kind: 'write-sample', ...base, alt: alt ? alt.alt : 'none', index: alt ? alt.name : null, rep, warmup, rows: n, ok: !error, error,
        executionMs: facts?.executionMs ?? null, insertWallMs: round3(insertWallMs), rowsPerSec: facts?.executionMs ? Math.round(n / (facts.executionMs / 1000)) : null,
        wal: facts?.wal ?? null, buffers: facts?.buffers ?? null, triggers: facts?.triggers ?? null, vacuumMs: round3(vacuumMs),
        indexBuildMs: build ? build.ms : null, indexBytes: build ? build.bytes : null, loadavg1: round3(os.loadavg()[0]) };
      samples.push(s);
      await ctx.emit(s);
      log(`  write ${table} ${s.alt} rep ${rep}${warmup ? ' (warm-up)' : ''}: ${s.executionMs === null ? 'error' : `${round3(s.executionMs)} ms`}`);
    };
    await round(null, 0, true);
    for (let r = 1; r <= ctx.opt.writeReps; r += 1) {
      await round(null, r, false);
      for (const alt of v.alts) await round(alt, r, false);
    }
    const cic = {};
    for (const alt of v.alts) {
      cic[alt.alt] = await createIndex(ctx, session, table, alt, { purpose: 'build-concurrently', concurrently: true });
      await dropIndex(ctx, session, alt.name, 'build-concurrently');
    }
    const sizeAfter = Number((await session.query(`SELECT pg_relation_size($1::regclass)::bigint AS b`, [table])).rows[0].b);
    const none = samples.filter((s) => !s.warmup && s.alt === 'none' && s.ok);
    const noneP50 = summarize(none.map((s) => s.executionMs)).p50;
    for (const label of ['none', ...v.alts.map((a) => a.alt)]) {
      const xs = samples.filter((s) => !s.warmup && s.alt === label && s.ok);
      const ex = summarize(xs.map((s) => s.executionMs));
      const alt = v.alts.find((a) => a.alt === label) ?? null;
      await ctx.emit({
        kind: 'write-summary', ...base, alt: label, index: alt?.name ?? null, definition: alt ? `CREATE INDEX "${alt.name}" ON "${table}" ${alt.cols}` : null,
        rows: n, n: ex.n, executionMs: ex, rowsPerSecAtP50: ex.p50 ? Math.round(n / (ex.p50 / 1000)) : null,
        overheadVsNone: alt && ex.p50 && noneP50 ? { p50DeltaMs: round3(ex.p50 - noneP50), p50Ratio: round3(ex.p50 / noneP50) } : null,
        walBytes: summarize(xs.map((s) => s.wal?.bytes)), vacuumMs: summarize(xs.map((s) => s.vacuumMs)),
        indexBuildMs: alt ? summarize(xs.map((s) => s.indexBuildMs)) : null, indexBytes: alt ? (xs.find((s) => s.indexBytes)?.indexBytes ?? null) : null,
        buildConcurrentlyMs: alt ? round3(cic[label]?.ms ?? null) : null, tableBytesBefore: sizeBefore, tableBytesAfter: sizeAfter,
        method: 'EXPLAIN (ANALYZE, TIMING OFF, BUFFERS, WAL) INSERT … SELECT from a temp table, inside BEGIN … ROLLBACK, then VACUUM (INDEX_CLEANUP ON); rounds interleaved none / with index; index built per round (plain CREATE INDEX) and dropped after it',
      });
    }
    await session.query(`DROP TABLE IF EXISTS pg_temp.${sqls.temp}`);
  } finally {
    ctx.sessions.delete(session);
    await session.end().catch(() => {});
  }
}

// ── checklist (read-only SQL file, validated on the clone) ───────────────────
async function dbCounters(clone) {
  const [r] = await pgQuery(clone, `${ADMIN} SELECT tup_inserted::bigint AS ins, tup_updated::bigint AS upd, tup_deleted::bigint AS del FROM pg_stat_database WHERE datname = current_database()`);
  return { inserted: Number(r.ins), updated: Number(r.upd), deleted: Number(r.del) };
}

async function runChecklist(ctx, clone, m) {
  if (!existsSync(CHECKLIST_FILE)) return { kind: 'checklist', ok: false, error: 'file missing' };
  cloneUrl(clone);
  const before = await dbCounters(clone);
  const args = ['-X', '-h', PG_SOCK, '-p', String(PG_PORT), '-U', 'postgres', '-d', clone, '-v', 'ON_ERROR_STOP=1', '-v', `rid=${m.recruiters.mixed.id}`, '-f', CHECKLIST_FILE];
  const t0 = now();
  const r = spawnSync(join(PG_BIN, 'psql'), args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 128 * 1024 * 1024 });
  const ms = now() - t0;
  await sleep(1500); // the psql backend flushes its statistics on exit
  const after = await dbCounters(clone);
  const out = `${r.stdout ?? ''}${r.stderr ? `\n-- stderr --\n${r.stderr}` : ''}`;
  mkdirSync(LOGS_DIR, { recursive: true });
  const file = join(LOGS_DIR, `explain-${ctx.scale}-checklist-${ctx.runId}.txt`);
  writeFileSync(file, out);
  const wrote = after.inserted !== before.inserted || after.updated !== before.updated || after.deleted !== before.deleted;
  return {
    kind: 'checklist', runId: ctx.runId, scale: ctx.scale, variant: ctx.variant, clone, file: CHECKLIST_FILE, outputFile: file, exitCode: r.status, signal: r.signal ?? null,
    ms: round3(ms), ok: r.status === 0 && !wrote, readOnlyShown: /transaction_read_only\s*\n-+\s*\n\s*on/.test(out), rolledBack: /\bROLLBACK\b/.test(out),
    errorLines: out.split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(0, 10), explainCount: (out.match(/QUERY PLAN/g) ?? []).length,
    missingLines: out.split('\n').filter((l) => /\bMISSING\b/.test(l)).map((l) => l.trim()).slice(0, 20), counters: { before, after, wrote },
  };
}

// ── variant runner ───────────────────────────────────────────────────────────
async function acquireClone(ctx, template, clone) {
  const deadline = Date.now() + ctx.opt.cloneWaitS * 1000;
  let waited = 0;
  for (;;) {
    const clones = await listClones();
    if (clones.includes(clone)) {
      const [a] = await pgQuery('postgres', `${ADMIN} SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [clone]);
      if (a.n > 0) throw new Error(`${HARNESS}: ${clone} exists and is in use — refusing to drop it`);
      const d = await dropDb(clone);
      await ctx.emit({ kind: 'event', runId: ctx.runId, scale: ctx.scale, event: 'stale-clone-dropped', clone, ms: round3(d.ms) });
      continue;
    }
    try {
      const info = await cloneDb(template, clone);
      return { ...info, waitedS: waited };
    } catch (e) {
      if (/clones alive/.test(String(e.message)) && Date.now() < deadline) {
        if (waited % 60 === 0) log(`waiting for a clone slot (${String(e.message)})`);
        await sleep(5000);
        waited += 5;
        continue;
      }
      throw e;
    }
  }
}

async function runVariant(ctx, variant) {
  const v = VARIANTS[variant];
  const keys = selectKeys(variant, ctx.opt.keys);
  const clone = cloneName(ctx.scale, variant);
  const problemsAtStart = ctx.problems.length;
  Object.assign(ctx, { variant, clone, notes: [] });
  ctx.captureFile = pathFor(ctx, variant, '.', 'capture.json');
  const started = now();
  const before = ctx.opt.before === 'on' || (ctx.opt.before === 'auto' && variant !== 'V0' && v.beforeDefault !== false);
  await ctx.emit({ kind: 'run-start', runId: ctx.runId, run: ctx.opt.run, scale: ctx.scale, variant, title: v.title, clone, keys, before: variant === 'V0' ? null : before,
    options: ctx.opt, activity: await clusterActivity(clone), freeDiskBytes: freeDiskBytes() });
  log(`variant ${variant} (${v.title}) on ${clone}: ${keys.length} keys`);
  if (!keys.length) {
    ctx.problems.push(`${variant}: --keys selects none of its keys (${v.keys.join(', ')})`);
    await ctx.emit({ kind: 'run-end', runId: ctx.runId, run: ctx.opt.run, scale: ctx.scale, variant, clone, ms: 0, dropped: null, keptClone: false, notes: [],
      problems: ctx.problems.slice(problemsAtStart), ok: false, activity: null });
    return;
  }
  let cloneInfo;
  try {
    cloneInfo = await acquireClone(ctx, TEMPLATES[ctx.scale], clone);
  } catch (e) {
    ctx.problems.push(`${variant}: clone ${clone} not created: ${String(e.message).slice(0, 300)}`);
    await ctx.emit({ kind: 'run-end', runId: ctx.runId, run: ctx.opt.run, scale: ctx.scale, variant, clone, ms: round3(now() - started), dropped: null,
      keptClone: false, notes: [], problems: ctx.problems.slice(problemsAtStart), ok: false, activity: await clusterActivity(clone).catch(() => null) });
    return;
  }
  await ctx.emit({ kind: 'clone', runId: ctx.runId, scale: ctx.scale, variant, ...cloneInfo, ms: round3(cloneInfo.ms) });
  let session = null;
  try {
    const stmts = await capture(ctx, clone, keys);
    writeFileSync(ctx.captureFile, JSON.stringify({ harness: HARNESS, scale: ctx.scale, runId: ctx.runId, variant, clone, note: 'exact SQL text + bind values sent by the real services (capture)',
      keys: [...stmts.values()].map((s) => ({ key: s.key, description: KEYS[s.key], scenario: s.scenario, paramCount: s.paramCount, textSha1: s.textSha1, valuesSha1: s.valuesSha1,
        chunk: s.chunk, text: s.text, values: jsonSafe(s.values) })) }));
    for (const s of stmts.values()) {
      await ctx.emit({ kind: 'capture-key', runId: ctx.runId, scale: ctx.scale, variant, clone, key: s.key, scenario: s.scenario, paramCount: s.paramCount,
        valueTypes: valueTypes(s.values), firstValues: jsonSafe(s.values.slice(0, 3)), lastValues: jsonSafe(s.values.slice(-2)), textSha1: s.textSha1, valuesSha1: s.valuesSha1,
        chunk: s.chunk, captureMs: round3(s.captureMs), captureError: s.captureError, sql: sqlPreview(s.text), captureFile: rel(ctx.captureFile) });
    }
    const runKeys = keys.filter((k) => stmts.has(k));
    session = await openSession(clone, ctx.opt.statementTimeoutMs, 'p5a-exp-explain');
    ctx.sessions.add(session);
    await ctx.emit({ kind: 'explain-session', runId: ctx.runId, scale: ctx.scale, variant, clone, settings: await sessionSettings(session),
      protocol: 'pg extended protocol, unnamed statement, the captured JS bind values (custom plan, parameters folded as constants — like the adapter)' });
    const s0 = await statSnapshot(clone);
    if (variant === 'V0') {
      await runPhase(ctx, session, variant, 'as_built', null, runKeys, stmts, {});
    } else {
      const refs = {};
      if (before) refs.before = await runPhase(ctx, session, variant, 'before', null, runKeys, stmts, {});
      if (v.drop) {
        for (const name of v.drop) await dropIndex(ctx, session, name, 'variant');
        await runPhase(ctx, session, variant, 'after', null, runKeys, stmts, refs);
      } else {
        if (v.vacuumCheck) {
          try { await ddl(ctx, session, 'create-extension', 'CREATE EXTENSION IF NOT EXISTS pg_visibility', { purpose: 'visibility-map report (clone only)' }); } catch (e) { ctx.notes.push(`pg_visibility unavailable: ${e.message}`); }
          await vmReport(ctx, session, v.table, 'before-index');
        }
        for (const [i, alt] of v.alts.entries()) {
          const built = await createIndex(ctx, session, v.table, alt, { purpose: 'variant' });
          if (alt.analyze) await ddl(ctx, session, 'analyze', `ANALYZE "${v.table}"`, { alt: alt.alt, purpose: 'statistics of the index expression' });
          if (v.vacuumCheck) await vmReport(ctx, session, v.table, 'after-create-index');
          const u0 = await indexUsage(ctx, clone, alt.name);
          await runPhase(ctx, session, variant, 'after', alt.alt, runKeys, stmts, refs);
          if (v.vacuumCheck) {
            await ddl(ctx, session, 'vacuum', `VACUUM "${v.table}"`, { alt: alt.alt, purpose: 'set the visibility map (index-only scans)' });
            await vmReport(ctx, session, v.table, 'after-vacuum');
            await runPhase(ctx, session, variant, 'after_vacuum', alt.alt, runKeys, stmts, refs);
          }
          await flushStats(session);
          const u1 = await indexUsage(ctx, clone, alt.name);
          await ctx.emit({ kind: 'index-usage', runId: ctx.runId, scale: ctx.scale, variant, clone, alt: alt.alt, index: alt.name, definition: `CREATE INDEX "${alt.name}" ON "${v.table}" ${alt.cols}`,
            extra: alt.extra === true, note: alt.note ?? null, buildMs: built.ms, bytes: built.bytes, usageDuringAfterPhases: u0 && u1 ? { idx_scan: u1.idx_scan - u0.idx_scan, idx_tup_read: u1.idx_tup_read - u0.idx_tup_read } : null });
          if (v.alts.length > 1 && i < v.alts.length - 1) await dropIndex(ctx, session, alt.name, 'next alternative');
        }
      }
    }
    await flushStats(session);
    const s1 = await statSnapshot(clone);
    await ctx.emit(await inventory(ctx, clone, s0, s1));
    if (ctx.opt.checklist && variant === 'V0') await ctx.emit(await runChecklist(ctx, clone, ctx.m));
    ctx.sessions.delete(session);
    await session.end();
    session = null;
    if (v.write && ctx.opt.write) await writeCost(ctx, v);
  } catch (e) {
    ctx.problems.push(`${variant}: ${e.code ?? e.name}: ${String(e.message).slice(0, 300)}`);
    log(`variant ${variant} failed: ${e.stack ?? e}`);
  } finally {
    if (session) { ctx.sessions.delete(session); await session.end().catch(() => {}); }
    let drop = null;
    if (!ctx.opt.keepClone) { try { drop = await dropDb(clone); } catch (e) { ctx.problems.push(`${variant}: drop ${clone} failed: ${e.message}`); } }
    await ctx.emit({ kind: 'run-end', runId: ctx.runId, run: ctx.opt.run, scale: ctx.scale, variant, clone, ms: round3(now() - started), dropped: drop ? { ms: round3(drop.ms) } : null,
      keptClone: ctx.opt.keepClone, notes: ctx.notes, problems: ctx.problems.slice(problemsAtStart), ok: ctx.problems.length === problemsAtStart, activity: await clusterActivity(clone).catch(() => null) });
  }
}

/** Latest V0 as_built summaries of this scale AND run label in the results file (for vsV0). */
function latestV0(file, scale, runLabel) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"kind":"summary"') || !line.includes('"variant":"V0"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.scale === scale && r.run === runLabel && r.phase === 'as_built' && r.n > 0) out.set(r.key, r);
    } catch { /* a partial last line of an interrupted run */ }
  }
  return out;
}

function printList() {
  const lines = ['VARIANTS'];
  for (const [name, v] of Object.entries(VARIANTS)) {
    lines.push(`  ${name.padEnd(6)} ${v.title}`);
    if (v.drop) lines.push(`         drops: ${v.drop.join(', ')}`);
    for (const a of v.alts ?? []) lines.push(`         alt ${a.alt}: CREATE INDEX "${a.name}" ON "${v.table}" ${a.cols}${a.extra ? '  [EXTRA]' : ''}`);
    lines.push(`         keys: ${v.keys.length === ALL_KEYS.length ? 'all' : v.keys.join(', ')}`);
    if (v.write) lines.push(`         write cost: ${v.write} ${WRITE_SPECS[v.write].rows} rows`);
  }
  lines.push('', 'KEYS');
  for (const [k, d] of Object.entries(KEYS)) lines.push(`  ${k.padEnd(36)} ${d}`);
  lines.push('', 'CAPTURE SCENARIOS');
  for (const s of SCENARIOS) lines.push(`  ${s.label.padEnd(32)} → ${s.picks.map(([k]) => k).join(', ')}  (expected: ${s.expect})`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.list) { printList(); return 0; }
  assertSafeEnvironment();
  const scale = opt.scale;
  if (opt.cleanup) {
    const mine = (await listClones()).filter((c) => c.startsWith(`exp_${scale}_`));
    for (const c of mine) process.stdout.write(`${JSON.stringify(await dropDb(c))}\n`);
    process.stdout.write(`${JSON.stringify({ cleanup: scale, dropped: mine })}\n`);
    return 0;
  }
  const file = opt.out ?? `explain-${scale}.jsonl`;
  const filePath = resolve(RESULTS_DIR, file);
  if (!filePath.startsWith(`${RESULTS_DIR}/`)) throw new Error(`${HARNESS}: REFUSED — result file outside ${RESULTS_DIR}`);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const ctx = {
    opt, scale, runId, m: loadManifest(scale), problems: [], notes: [], sessions: new Set(), v0: latestV0(filePath, scale, opt.run),
    emit: (obj) => appendResult(file, obj),
  };
  const shutdown = async (sig) => {
    log(`${sig}: closing sessions${ctx.clone && !opt.keepClone ? ` and dropping ${ctx.clone}` : ''}`);
    for (const s of ctx.sessions) await s.end().catch(() => {});
    if (ctx.clone && !opt.keepClone) await dropDb(ctx.clone).catch(() => {});
    process.exit(130);
  };
  process.once('SIGINT', () => { shutdown('SIGINT'); });
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  log(`run ${runId} scale ${scale} variants ${opt.variants.join(',')} → ${filePath}`);
  for (const variant of opt.variants) {
    await runVariant(ctx, variant);
    if (variant === 'V0') ctx.v0 = latestV0(filePath, scale, opt.run);
  }
  const result = { harness: HARNESS, runId, scale, variants: opt.variants, resultFile: filePath, plansDir: join(PLANS_DIR, scale, runId), problems: ctx.problems, ok: ctx.problems.length === 0 };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { log(`fatal: ${e.stack ?? e}`); process.exit(1); });
