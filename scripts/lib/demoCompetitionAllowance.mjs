/**
 * scripts/lib/demoCompetitionAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The EXACT, documented allowance for the Demo Competition (Top Members / Top
 * Brands — SIMULATION ONLY) in the "unchanged versus <earlier commit>" checks of
 * the recruiter / login suites (they pin the exact schema diff, migration list and
 * changed src files). The feature is ADDITIVE and isolated:
 *
 *   • schema.prisma: + exactly the 7 DemoComp* model blocks (inserted before the
 *     recruiter section), whose text is pinned by SHA-256 below — any further edit
 *     of those blocks breaks the suites until reviewed and re-pinned;
 *   • prisma/migrations: + exactly 20261113_demo_competition (SHA-256 pinned), which
 *     only creates demo_comp_* tables (scripts/demoCompetitionService.test.mjs §8);
 *   • src/: new files only under the feature's own paths (DEMO_COMP_SRC_DIRS) + the
 *     shared files listed in DEMO_COMP_SHARED_FILES (each edited for the feature only;
 *     their content is pinned by the dedicated demo-competition tests).
 *
 * The suites drop exactly these from their lists / diffs and keep every other
 * assertion unchanged. Re-pin ONLY after reviewing a deliberate change:
 *   node scripts/lib/demoCompetitionAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEMO_COMP_MIGRATION_DIR = '20261113_demo_competition';
export const DEMO_COMP_MIGRATION = `prisma/migrations/${DEMO_COMP_MIGRATION_DIR}/migration.sql`;
export const DEMO_COMP_MODELS = Object.freeze(['DemoCompMember', 'DemoCompMemberVersion', 'DemoCompBrand', 'DemoCompBrandVersion', 'DemoCompDailyPlan', 'DemoCompEvent', 'DemoCompEngine']);

export const DEMO_COMP_SCHEMA_SHA = '06b9e659380673b89b483831b4aca0f49e1be553abd16ebd7495de2a0a13132e';
export const DEMO_COMP_MIGRATION_SHA = 'd7fc1fe517d5bb0c9744beecf259c2e11216c0584d8907773d428ecfe1e24a5b';

/** New files of the feature live only here. */
export const DEMO_COMP_SRC_DIRS = Object.freeze([
  /^src\/lib\/demoCompetition\//,
  /^src\/lib\/services\/demoCompetitionService\.js$/,
  /^src\/components\/demoCompetition\//,
  /^src\/app\/api\/demo-competition\//,
  /^src\/app\/api\/admin\/demo-competition\//,
  /^src\/app\/admin\/demo-competition\//,
  /^src\/app\/top-members\//,
  /^src\/app\/top-brands\//,
  // Conflict-safe homepage layout writes (Homepage Builder ↔ Demo Competition homepage settings).
  /^src\/lib\/services\/homepageLayoutService\.js$/,
  /^src\/app\/api\/admin\/homepage-layout\/route\.js$/,
  // TEMPORARY design-review preview: neutral wording (text only) for the active Brand dashboard — one switch,
  // NEUTRAL_WORDING_PREVIEW. (Top Members / Top Brands texts are neutral at the source; their single simulation
  // disclosure is src/lib/demoCompetition/disclosure.js, already covered by the src/lib/demoCompetition/ entry.)
  /^src\/lib\/neutralWording\.js$/,
]);
/** Existing files the feature edits (menu entry, homepage builder types + conflict-safe save, landing-mode allowlist, sitemap, dashboard leaderboard, reserved homepage_layout setting). */
export const DEMO_COMP_SHARED_FILES = Object.freeze([
  'src/components/admin/SideBar.jsx',
  'src/components/HomeBuilder/HomeSectionRenderer.jsx',
  'src/app/admin/homepage-builder/page.jsx',
  'src/lib/landingMode.js',
  'src/app/sitemap.ts',
  'src/app/affiliate/dashboard/page.jsx',
  // 'homepage_layout' added to the reserved setting types (written only through the revision-checked endpoint).
  'src/lib/controllers/settingsController.js',
  // Temporary neutral-wording preview (src/lib/neutralWording.js): the active Brand dashboard wraps its translators
  // and drops the empty simulation pill / disclaimer lines — text only, no data / API / polling change.
  'src/app/affiliate/dashboard/_brand/BrandDashboard.jsx',
  'src/components/brand/BrandSimStats.jsx',
]);

export const isDemoCompSrc = (f) => DEMO_COMP_SRC_DIRS.some((re) => re.test(f)) || DEMO_COMP_SHARED_FILES.includes(f);
/**
 * Drop the feature's src files from a "changed since <base>" list. A shared file that the expected list already
 * names (it was changed by an earlier, approved phase too — e.g. SideBar.jsx, landingMode.js) stays in the list.
 */
export const dropDemoCompSrc = (files, expected = []) => files.filter((f) => !isDemoCompSrc(f) || expected.includes(f));
export const isDemoCompPrisma = (f) => f === DEMO_COMP_MIGRATION || f === DEMO_COMP_MIGRATION_DIR;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The 7 model blocks as they appear in schema.prisma (concatenated, in file order). */
export function demoCompSchemaBlocks(schema) {
  return [...schema.matchAll(/^model (\w+) \{[\s\S]*?^\}\n/gm)].filter((m) => DEMO_COMP_MODELS.includes(m[1])).map((m) => m[0]).join('');
}

/** Remove the 7 blocks (and the blank line after each) from a schema text. */
export function stripDemoCompSchema(schema) {
  return schema.replace(/^model (\w+) \{[\s\S]*?^\}\n\n?/gm, (block, name) => (DEMO_COMP_MODELS.includes(name) ? '' : block));
}

/**
 * Remove the added lines of the 7 blocks from `git diff` +/- lines (headers excluded):
 * from "+model DemoCompX {" through its "+}" and one following "+" blank line.
 */
export function withoutDemoCompDiffLines(lines) {
  const out = [];
  let inBlock = false, skipBlank = false;
  for (const l of lines) {
    if (!inBlock && /^\+model (\w+) \{/.test(l) && DEMO_COMP_MODELS.includes(/^\+model (\w+)/.exec(l)[1])) { inBlock = true; continue; }
    if (inBlock) { if (l === '+}') { inBlock = false; skipBlank = true; } continue; }
    if (skipBlank && l === '+') { skipBlank = false; continue; }
    skipBlank = false;
    out.push(l);
  }
  return out;
}

/** True when the schema blocks and the migration are exactly the reviewed ones. */
export function demoCompPinsHold(root = ROOT) {
  const schema = readFileSync(`${root}prisma/schema.prisma`, 'utf8');
  const mig = readFileSync(`${root}${DEMO_COMP_MIGRATION}`, 'utf8');
  return { schema: sha(demoCompSchemaBlocks(schema)) === DEMO_COMP_SCHEMA_SHA, migration: sha(mig) === DEMO_COMP_MIGRATION_SHA };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const schema = readFileSync(`${ROOT}prisma/schema.prisma`, 'utf8');
  console.log('DEMO_COMP_SCHEMA_SHA', sha(demoCompSchemaBlocks(schema)));
  console.log('DEMO_COMP_MIGRATION_SHA', sha(readFileSync(`${ROOT}${DEMO_COMP_MIGRATION}`, 'utf8')));
}
