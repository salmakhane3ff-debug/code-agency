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

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** The changed (+/-) lines of `git diff <base> -- <file>`, headers excluded. */
export function changedLines(base, file) {
  return git(['diff', base, '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
}
export const linesSha = (lines) => createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');

/**
 * Check a set of guarded paths against an older base commit.
 * → { ok, unexpected: [files changed outside the Part 2 allowance], mismatched: [Part 2 files whose diff is not exactly the pinned one], allowed: [...] }
 */
export function checkUnchangedExceptPart2(base, paths) {
  const changed = new Set([
    ...git(['diff', '--name-only', base, '--', ...paths]).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n'),
  ].filter(Boolean));
  const unexpected = [];
  const mismatched = [];
  const allowed = [];
  for (const file of [...changed].sort()) {
    const pin = PART2_PINS[file];
    if (!pin) { unexpected.push(file); continue; }
    const sinceBase = changedLines(base, file);
    const part2 = changedLines(PART2_BASE, file);
    if (JSON.stringify(sinceBase) !== JSON.stringify(part2) || linesSha(part2) !== pin) mismatched.push(file);
    else allowed.push(file);
  }
  return { ok: unexpected.length === 0 && mismatched.length === 0, unexpected, mismatched, allowed };
}

// `node scripts/lib/phase6Part2Allowance.mjs` prints the current pins (for a reviewed refresh).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const f of Object.keys(PART2_PINS)) console.log(`  '${f}': '${linesSha(changedLines(PART2_BASE, f))}',`);
}
