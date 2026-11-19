/**
 * scripts/lib/uploadAuthUgcSupportAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The EXACT, documented allowance for the combined task "Upload fix + Demo UGC Videos Competition +
 * WhatsApp support button" (branch feature/affiliate-nav-ugc-homepage-count, base d9f188a) in the
 * "unchanged versus <earlier commit>" scope guards of the recruiter / market-locale / activation /
 * demo-competition suites:
 *
 *   A. Affiliate uploads + sessions: authHeaders(json) — FormData uploads never set Content-Type; logout clears
 *      the HttpOnly affiliate_token cookie (DELETE /api/affiliate/auth); a refused cookie no longer hides a
 *      valid Bearer token (each token still fully validated) and is cleared; a handler exception answers 500
 *      instead of a fake "expired session" 401. The two guarded auth files are line-pinned (UAUS_LINE_PINS).
 *      R2: secret-free upload diagnostics (src/lib/r2.js) + names of missing R2 variables (src/lib/cloudinary.js).
 *   B. Demo Competition — UGC Videos (SIMULATION ONLY): 5 new demo_comp_ugc_* models + ONE back-relation line in
 *      DemoCompMember (Prisma needs both sides of the owner relation), ONE additive migration (SHA-256 pinned),
 *      pure engine + service + admin / public routes + admin tab + affiliate dashboard tab. Never touches real
 *      UGC, orders, affiliates, wallets, payouts or rewards.
 *   C. ONE floating WhatsApp support button (affiliate dashboard + recruiter pages; UI Control number), the
 *      Homepage button hidden on /recruiter.
 *
 * Nothing financial changes. The suites drop exactly these files / lines and keep every other assertion.
 * Re-pin ONLY after reviewing a deliberate change:  node scripts/lib/uploadAuthUgcSupportAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Base of this task: the committed Phases 1–4 release candidate. */
export const UAUS_BASE = 'd9f188a6c741644a4380cce92dd29ba2a87c56cb';

export const UGC_MIGRATION_DIR = '20261116_demo_comp_ugc_videos';
export const UGC_MIGRATION = `prisma/migrations/${UGC_MIGRATION_DIR}/migration.sql`;
export const UGC_MIGRATION_SHA = '1bde00f7f1ac5d5b3b214ad4b2c8a0742ac633847235e5dc40a17958bf1c904c';
/** sha256 of the +/- lines of `git diff UAUS_BASE -- prisma/schema.prisma` (all additions: 5 models + 1 back-relation). */
export const UGC_SCHEMA_SHA = 'a41993eb671f4bd775c7697feba476d6ee60369d52685c872d5a409e77513ba5';
export const UGC_MODELS = Object.freeze(['DemoCompUgcVideo', 'DemoCompUgcVideoVersion', 'DemoCompUgcDailyPlan', 'DemoCompUgcEvent', 'DemoCompUgcSettings']);

/** Exact src files of this task (new or edited). */
export const UAUS_SRC_FILES = Object.freeze([
  // A. uploads + affiliate session
  'src/app/affiliate/dashboard/page.jsx',
  'src/components/affiliate/AffiliateNavGate.jsx',
  'src/lib/middleware/withAffiliateAuth.js',
  'src/app/api/affiliate/auth/route.js',
  'src/lib/r2.js',
  'src/lib/cloudinary.js',
  // B. Demo Competition — UGC Videos (backend)
  'src/lib/demoCompUgc.js',
  'src/lib/services/demoCompUgcService.js',
  // B. Demo Competition — UGC Videos (affiliate dashboard tab; the admin tab lives under src/app/admin/demo-competition/,
  //    already covered by scripts/lib/demoCompetitionAllowance.mjs)
  'src/app/affiliate/dashboard/UgcVideosTab.jsx',
  // C. WhatsApp support button
  'src/lib/dashboardSupport.js',
  'src/components/support/DashboardWhatsAppButton.jsx',
  'src/components/support/RecruiterWhatsAppButton.jsx',
  'src/app/affiliate/layout.jsx',
  'src/app/recruiter/layout.jsx',
  'src/components/FloatingWhatsApp.jsx',
]);
/** New route / UI directories of the UGC module. */
export const UAUS_SRC_DIRS = Object.freeze([
  /^src\/app\/api\/admin\/demo-competition\/ugc-videos\//,
  /^src\/app\/api\/demo-competition\/ugc-videos\//,
  // the full UGC Videos leaderboard page ("Voir tout" of the dashboard home's Top 3 section) + its layout
  /^src\/app\/top-ugc-videos\//,
]);

/** Guarded files (Phase 6 part 2 pins / guarded middleware + affiliate API dirs): allowed ONLY with exactly these +/- lines vs UAUS_BASE. */
export const UAUS_LINE_PINS = Object.freeze({
  'src/lib/middleware/withAffiliateAuth.js': 'fc07476d442efb54effcde5d2e64a47b78b265623dd46a15c7a579d52581b89e',
  'src/app/api/affiliate/auth/route.js': '4cffdd91ccb8ad2d29d199272770cfc52aa7593048ebff5830009fd4d7f86a9f',
});

export const isUausSrc = (f) => UAUS_SRC_FILES.includes(f) || UAUS_SRC_DIRS.some((re) => re.test(f));
/** Drop this task's src files from a "changed since <base>" list; files the expected list already names stay. */
export const dropUausSrc = (files, expected = []) => files.filter((f) => !isUausSrc(f) || expected.includes(f));
export const isUgcPrisma = (f) => f === UGC_MIGRATION || f === UGC_MIGRATION_DIR || f === `${UGC_MIGRATION_DIR}/`;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const changedLines = (file) => git(['diff', UAUS_BASE, '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));

export const ugcSchemaSha = () => sha(changedLines('prisma/schema.prisma').join('\n'));
export const ugcSchemaPinHolds = () => ugcSchemaSha() === UGC_SCHEMA_SHA;
export const ugcMigrationSha = () => sha(readFileSync(`${ROOT}${UGC_MIGRATION}`, 'utf8'));
export const ugcMigrationPinHolds = () => ugcMigrationSha() === UGC_MIGRATION_SHA;
export const uausLinesSha = (file) => sha(changedLines(file).join('\n'));
export const uausLinePinHolds = (file) => !!UAUS_LINE_PINS[file] && uausLinesSha(file) === UAUS_LINE_PINS[file];

/** The schema lines this task ADDS (in file order) — only while the pin holds (otherwise nothing is set aside). */
function addedSchemaLines() {
  if (!ugcSchemaPinHolds()) return [];
  return changedLines('prisma/schema.prisma').filter((l) => l[0] === '+').map((l) => l.slice(1));
}
/** schema.prisma text WITHOUT this task's added lines (what the older guards compare). */
export function stripUgcSchema(schema) {
  const added = addedSchemaLines();
  if (!added.length) return schema;
  // Remove the added lines as one ordered subsequence, matched greedily from the top.
  const lines = schema.split('\n');
  const out = [];
  let i = 0;
  for (const l of lines) { if (i < added.length && l === added[i]) { i++; continue; } out.push(l); }
  return i === added.length ? out.join('\n') : schema;
}
const norm = (l) => l[0] + l.slice(1).replace(/\s+/g, ' ').trim();
/** Remove this task's lines from `git diff` +/- lines of schema.prisma, raw or whitespace-normalized (each at most once). */
export function withoutUgcDiffLines(lines) {
  const drop = addedSchemaLines().map((l) => norm(`+${l}`));
  return lines.filter((l) => { const i = drop.indexOf(norm(l)); if (i === -1) return true; drop.splice(i, 1); return false; });
}

// `node scripts/lib/uploadAuthUgcSupportAllowance.mjs` prints the current pins (for a reviewed refresh).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`  UGC_MIGRATION_SHA = '${ugcMigrationSha()}'`);
  console.log(`  UGC_SCHEMA_SHA = '${ugcSchemaSha()}'`);
  for (const f of Object.keys(UAUS_LINE_PINS)) console.log(`  '${f}': '${uausLinesSha(f)}',`);
}
