/**
 * scripts/lib/dashboardAdminControlsAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The EXACT, documented allowance for "Affiliate Dashboard & Admin Controls" (branch
 * feature/dashboard-admin-controls, started from a1cdad3 + the two approved features
 * "Top sections on the dashboard" and "Publier maintenant") in the "unchanged versus
 * <earlier commit>" scope guards of the recruiter / market-locale / activation suites:
 *
 *   1. Payment proofs — display duration captured per proof at publication (admin setting,
 *      72 h default) and "Supprimer" (REMOVE audit event): the pure rules, the publisher,
 *      the proof service, the new settings service + admin route, the admin UI, the reserved
 *      setting type, and ONE additive migration (DAC_MIGRATION, SHA-256 pinned below).
 *   2. Admin switch "Recharge de solde des Affiliés": the new switch service + admin route,
 *      depositService (refuses NEW requests when OFF; balances unchanged), the affiliate
 *      deposits route (DEPOSIT_DISABLED → 403 — its exact added lines are SHA-256 pinned in
 *      DAC_ROUTE_PINS), the dashboard / Booster UI gating, i18n and server texts, admin page.
 *   (3. Top Members / Top Brands wording — covered by scripts/lib/demoCompetitionAllowance.mjs.)
 *
 * Nothing else may change: no commission / points / payout / withdrawal / balance-provider /
 * Create-Your-Own-Brand file is in this list. The suites drop exactly these files from their
 * "changed since <base>" lists and keep every other assertion unchanged.
 * Re-pin ONLY after reviewing a deliberate change:  node scripts/lib/dashboardAdminControlsAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** origin/main when this work started (the deposits route is identical there and at every older guard base). */
export const DAC_BASE = 'a1cdad3b14f31cc7d718138391951b262982da56';

export const DAC_MIGRATION_DIR = '20261114_payment_proof_display_controls';
export const DAC_MIGRATION = `prisma/migrations/${DAC_MIGRATION_DIR}/migration.sql`;
export const DAC_MIGRATION_SHA = 'ba302929c5fc76b9dee47576af63ea94752eaac7843427f8343a8adf5faaca47';

/** Exact src files of this work (new or edited). */
export const DAC_SRC_FILES = Object.freeze([
  // 1. Payment proofs
  'src/lib/paymentProofs.js',
  'src/lib/paymentProofRouteHandlers.js',
  'src/lib/services/paymentProofPublisher.js',
  'src/lib/services/paymentProofService.js',
  'src/lib/services/paymentProofSettingsService.js',
  'src/app/api/admin/payment-proofs/[id]/route.js',
  'src/app/api/admin/payment-proofs/settings/route.js',
  'src/app/admin/payment-proofs/page.jsx',
  'src/app/admin/payment-proofs/ProofsList.jsx',
  'src/app/admin/payment-proofs/ScheduleBuilder.jsx',
  'src/app/admin/payment-proofs/ui.jsx',
  'src/app/admin/payment-proofs/DisplaySettings.jsx',
  // affiliate slider: duration-neutral caption ("Paiements récents") + doc comment — the duration is an admin setting now
  'src/components/affiliate/PaymentProofsSlider.jsx',
  'src/lib/affiliateTabsI18n.js',
  // 1 + 2. Reserved setting types ('payment-proof-display', 'affiliate-recharge')
  'src/lib/controllers/settingsController.js',
  // 2. Recharge switch
  'src/lib/services/rechargeFeatureService.js',
  // admin display names in the audit / history views (read-only users lookup: id / email / name)
  'src/lib/services/adminNameService.js',
  'src/lib/services/depositService.js',
  'src/app/api/admin/affiliate-recharge/route.js',
  'src/app/api/affiliate/deposits/route.js',
  'src/app/admin/deposits/page.jsx',
  'src/app/affiliate/dashboard/page.jsx',
  'src/app/affiliate/dashboard/BoosterTab.jsx',
  'src/lib/affiliateDashboardI18n.js',
  'src/lib/serverText/affiliateServerText.js',
]);

/** Guarded affiliate-API files: allowed ONLY with exactly these added/removed lines versus DAC_BASE (sha256 of the +/- lines). */
export const DAC_ROUTE_PINS = Object.freeze({
  'src/app/api/affiliate/deposits/route.js': '3c7e484d5b14e0a102a83bd6613ffc8698357853394f92d98ffd7e28124f6cd8',
});

/**
 * schema.prisma: exactly these lines (PaymentProof gains visibleHours / visibleUntil + an index; the PaymentProofEvent doc
 * comment mentions REMOVE). Pinned by DAC_SCHEMA_SHA (sha256 of the +/- lines of `git diff DAC_BASE -- prisma/schema.prisma`).
 */
export const DAC_SCHEMA_INSERTS = Object.freeze([
  {
    after: '  publishAttempts         Int                 @default(0)\n',
    text: '  /// Display duration captured at the ACTUAL publication (global setting at that moment) and the\n'
      + '  /// resulting end of display (= publishedAt + visibleHours). NULL before publication and for proofs\n'
      + '  /// published before 20261114 (those keep the original 72 h rule). Never changes once published.\n'
      + '  visibleHours            Int?\n'
      + '  visibleUntil            DateTime?\n',
  },
  { after: '  @@index([status, publishedAt])\n', text: '  @@index([status, visibleUntil])\n' },
]);
export const DAC_SCHEMA_DOC = Object.freeze({
  before: '/// Append-only audit history of one payment proof (DB trigger: no UPDATE / DELETE).\n',
  after: '/// Append-only audit history of one payment proof (DB trigger: no UPDATE / DELETE). A REMOVE event\n'
    + '/// ("Supprimer") takes the proof off the slider for good; at most one per proof (partial unique index in SQL).\n',
});
export const DAC_SCHEMA_SHA = 'dba16ebab199225305a0905c265c55519091116d88c799cbd4b7c04ef5dd8f80';

/** The schema text WITHOUT this work's lines (what the older guards compare). */
export function stripDacSchema(schema) {
  let s = schema;
  for (const { after, text } of DAC_SCHEMA_INSERTS) s = s.replace(after + text, after);
  return s.replace(DAC_SCHEMA_DOC.after, DAC_SCHEMA_DOC.before);
}
const norm = (l) => l[0] + l.slice(1).replace(/\s+/g, ' ').trim();
const dacDiffLines = () => {
  const lines = (t) => t.split('\n').filter(Boolean);
  return [
    ...DAC_SCHEMA_INSERTS.flatMap(({ text }) => lines(text).map((l) => norm(`+${l}`))),
    ...lines(DAC_SCHEMA_DOC.after).map((l) => norm(`+${l}`)),
    ...lines(DAC_SCHEMA_DOC.before).map((l) => norm(`-${l}`)),
  ];
};
/** Remove this work's lines from `git diff` +/- lines of schema.prisma, raw or whitespace-normalized (each at most once). */
export function withoutDacDiffLines(lines) {
  const drop = dacDiffLines();
  return lines.filter((l) => { const i = drop.indexOf(norm(l)); if (i === -1) return true; drop.splice(i, 1); return false; });
}
export const dacSchemaSha = () => sha(git(['diff', DAC_BASE, '--', 'prisma/schema.prisma']).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join('\n'));
export const dacSchemaPinHolds = () => dacSchemaSha() === DAC_SCHEMA_SHA;

export const isDacSrc = (f) => DAC_SRC_FILES.includes(f);
/** Drop this work's src files from a "changed since <base>" list; files the expected list already names stay. */
export const dropDacSrc = (files, expected = []) => files.filter((f) => !isDacSrc(f) || expected.includes(f));
export const isDacPrisma = (f) => f === DAC_MIGRATION || f === DAC_MIGRATION_DIR || f === `${DAC_MIGRATION_DIR}/`;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** The changed (+/-) lines of `git diff DAC_BASE -- <file>` (headers excluded). */
export function dacChangedLines(file) {
  return git(['diff', DAC_BASE, '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
}
export const dacLinesSha = (file) => sha(dacChangedLines(file).join('\n'));
export const dacMigrationSha = () => sha(readFileSync(`${ROOT}${DAC_MIGRATION}`, 'utf8'));

/** A guarded route that differs from DAC_BASE by exactly its pinned lines. */
export const dacRoutePinHolds = (file) => !!DAC_ROUTE_PINS[file] && dacLinesSha(file) === DAC_ROUTE_PINS[file];
export const dacMigrationPinHolds = () => dacMigrationSha() === DAC_MIGRATION_SHA;

// `node scripts/lib/dashboardAdminControlsAllowance.mjs` prints the current pins (for a reviewed refresh).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`  DAC_MIGRATION_SHA = '${dacMigrationSha()}'`);
  console.log(`  DAC_SCHEMA_SHA = '${dacSchemaSha()}'`);
  for (const f of Object.keys(DAC_ROUTE_PINS)) console.log(`  '${f}': '${dacLinesSha(f)}',`);
}
