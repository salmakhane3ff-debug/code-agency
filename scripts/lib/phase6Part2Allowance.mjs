/**
 * scripts/lib/phase6Part2Allowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The EXACT, documented allowance for Phase 6 part 2 (account & session security,
 * docs/recruiter-system.md §8) in the "unchanged versus <earlier commit>" checks of the
 * recruiter / activation suites.
 *
 * Phase 6 part 2 had to change a few files those checks guard (the per-request session check in
 * withAffiliateAuth, the affiliate login / password / admin edit, the keyed limiter export, and the
 * D5 per-account login throttle in loginAffiliate + the 429 mapping of the affiliate auth route). Every
 * one of them was UNCHANGED between ef79c6b and 003c6f1 (the commit Part 2 started from), so:
 *
 *   • a guarded file in PART2_PINS may differ from the older base ONLY by exactly its Part 2 diff:
 *     diff(base, file) must equal diff(003c6f1, file) line for line AND the SHA-256 of those
 *     changed lines must equal the pin below (any further edit breaks the test);
 *   • every OTHER guarded file must still be byte-identical to the base (no diff, no new file).
 *
 * Phase 7 Stage F (approved clarification — an affiliate with children cannot be deleted): the admin DELETE route
 * and the legacy affiliate controller also map AFFILIATE_HAS_CHILDREN → 409. A guarded file in STAGE_F_PINS may
 * differ from STAGE_F_BASE (7e111e1, where every Part 2 check above last passed unchanged) ONLY by exactly its
 * pinned Stage F lines; the Part 2 rule is then applied to its STAGE_F_BASE version (git diff base..7e111e1). Such
 * a file is reported in `stageF` (not in `allowed`).
 *
 * Refresh a pin ONLY after reviewing a deliberate change:  node scripts/lib/phase6Part2Allowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PART2_BASE = '003c6f12c97c330536c7e6debb95cbd35397760b';

/** sha256 of the +/- lines of `git diff 003c6f1 -- <file>` (headers excluded). */
export const PART2_PINS = Object.freeze({
  'src/app/api/admin/affiliates/route.js': '7bb401e6dc92956f45e713eacfef6492febfe9bcda9c6cd0b30e8c7f2e06ddb4',
  'src/app/api/affiliate/auth/route.js': '68941085a4890621f25c513e748bbaa35332542c42d7a273373f4da7451e2d16',
  'src/app/api/affiliate/me/route.js': '23816123688bf9ff1655d3aa908fb5bc9eb55d62be1e9ba2fa23b4dfa23f8646',
  'src/lib/middleware/withAffiliateAuth.js': '539c7bfc4ea959e92f5210a3d97d662711df7566814f59b886c2a18046e7a4ba',
  'src/lib/rateLimit.js': '3185b0b1e03f07893eda165d8edfae8af610dbd2ae47af4ac04d79f0784fe512',
  'src/lib/services/affiliateSystemService.js': '9eac326be8d587ef11209e1da8b5d9b937ea9f663975a369b8545f449d415062',
});

/** Phase 7 Stage F: sha256 of the +/- lines of `git diff 7e111e1 -- <file>` (the AFFILIATE_HAS_CHILDREN 409 mapping). */
export const STAGE_F_BASE = '7e111e10df7c2413820f34a52fe200aebdefa72e';
export const STAGE_F_PINS = Object.freeze({
  'src/app/api/admin/affiliates/route.js': '23de04c820591e2c29971ed23eadcf7fd4d5cf6e2645c2deece1a11524664b46',
  'src/lib/controllers/affiliateController.js': 'd23c9ea0db5114a6d0c45a2893a9a31fd4983e81e19d3e5c63d6421416f113cc',
});

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** The changed (+/-) lines of `git diff <base> -- <file>` (or `git diff <base> <to> -- <file>`), headers excluded. */
export function changedLines(base, file, to = null) {
  return git(['diff', base, ...(to ? [to] : []), '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
}
export const linesSha = (lines) => createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');

/**
 * Check a set of guarded paths against an older base commit.
 * → { ok, unexpected: [files changed outside the Part 2 allowance], mismatched: [Part 2 files whose diff is not exactly the pinned one], allowed: [...],
 *     stageF: [files that differ by exactly their Phase 7 Stage F pin and otherwise satisfy the rule at STAGE_F_BASE] }
 */
export function checkUnchangedExceptPart2(base, paths) {
  const changed = new Set([
    ...git(['diff', '--name-only', base, '--', ...paths]).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n'),
  ].filter(Boolean));
  const unexpected = [];
  const mismatched = [];
  const allowed = [];
  const stageF = [];
  for (const file of [...changed].sort()) {
    // Phase 7 Stage F: exactly the pinned lines versus 7e111e1; the Part 2 rule then judges the 7e111e1 version
    if (STAGE_F_PINS[file] && linesSha(changedLines(STAGE_F_BASE, file)) === STAGE_F_PINS[file]) {
      const atF = changedLines(base, file, STAGE_F_BASE);
      const pin2 = PART2_PINS[file];
      if (atF.length === 0 || (pin2 && JSON.stringify(atF) === JSON.stringify(changedLines(PART2_BASE, file, STAGE_F_BASE)) && linesSha(atF) === pin2)) { stageF.push(file); continue; }
    }
    const pin = PART2_PINS[file];
    if (!pin) { unexpected.push(file); continue; }
    const sinceBase = changedLines(base, file);
    const part2 = changedLines(PART2_BASE, file);
    if (JSON.stringify(sinceBase) !== JSON.stringify(part2) || linesSha(part2) !== pin) mismatched.push(file);
    else allowed.push(file);
  }
  return { ok: unexpected.length === 0 && mismatched.length === 0, unexpected, mismatched, allowed, stageF };
}

// `node scripts/lib/phase6Part2Allowance.mjs` prints the current pins (for a reviewed refresh).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const f of Object.keys(PART2_PINS)) console.log(`  '${f}': '${linesSha(changedLines(PART2_BASE, f))}',`);
  console.log('  Phase 7 Stage F:');
  for (const f of Object.keys(STAGE_F_PINS)) console.log(`  '${f}': '${linesSha(changedLines(STAGE_F_BASE, f))}',`);
}
