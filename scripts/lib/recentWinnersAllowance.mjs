/**
 * scripts/lib/recentWinnersAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The EXACT, documented allowance for "Recent Winners — Rewards & Points" (the الفائزون مؤخراً
 * slider of the affiliate Rewards / Gifts page; base 7c8e475) in the "unchanged versus <earlier
 * commit>" scope guards of the recruiter / activation / market-locale suites.
 *
 * READ ONLY feature: no schema, no migration, no points / ledger / balance / commission /
 * withdrawal / request change. It adds
 *   • ONE new affiliate route, GET /api/affiliate/rewards/winners (content SHA-256 pinned below —
 *     it is new, so it must not exist at the base, and any edit breaks the guards);
 *   • a pure rules module, a read-only service, the slider component;
 *   • the slider in RewardsTab + its FR / AR texts in rewardsI18n (line pins versus the base).
 * Re-pin ONLY after reviewing a deliberate change:  node scripts/lib/recentWinnersAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const RW_BASE = '7c8e4750c16e3a9398cfa673289be93d8ad4447d';

/** Exact src files of this feature (new or edited). */
export const RW_SRC_FILES = Object.freeze([
  'src/lib/recentWinners.js',
  'src/lib/services/recentWinnersService.js',
  'src/app/api/affiliate/rewards/winners/route.js',
  'src/components/rewards/RecentWinners.jsx',
  'src/app/affiliate/dashboard/RewardsTab.jsx',
  'src/lib/rewardsI18n.js',
]);

/** New guarded route: sha256 of the whole file (it does not exist at RW_BASE). */
export const RW_ROUTE_PINS = Object.freeze({
  'src/app/api/affiliate/rewards/winners/route.js': '20dfbdfb622ae65fe29b7ae78030ddf0865572459c39a64a2686b1387ca8b56e',
});
/** Edited files: sha256 of the +/- lines of `git diff RW_BASE -- <file>`. */
export const RW_LINE_PINS = Object.freeze({
  'src/app/affiliate/dashboard/RewardsTab.jsx': '02d2fbd9d1f6eff6919dd5a280bc6bc712f76a619b0dc3b40566137dcde7e73d',
  'src/lib/rewardsI18n.js': 'dc4e9ccf3f834d797e2a794c7d3b205ecf19c2a78ad420d810a59076abb2099a',
});

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const existsAt = (rev, file) => { try { git(['cat-file', '-e', `${rev}:${file}`]); return true; } catch { return false; } };
const changedLines = (file) => git(['diff', RW_BASE, '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));

export const rwRouteSha = (file) => { try { return sha(readFileSync(`${ROOT}${file}`, 'utf8')); } catch { return null; } };
/** A new route of this feature: absent at RW_BASE and byte-identical to its pin. */
export const rwRoutePinHolds = (file) => !!RW_ROUTE_PINS[file] && !existsAt(RW_BASE, file) && rwRouteSha(file) === RW_ROUTE_PINS[file];
export const rwLinesSha = (file) => sha(changedLines(file).join('\n'));
export const rwLinePinHolds = (file) => !!RW_LINE_PINS[file] && rwLinesSha(file) === RW_LINE_PINS[file];

/** A src file of this feature whose pin (when it has one) holds. */
export const isRwSrc = (f) => RW_SRC_FILES.includes(f)
  && (!RW_ROUTE_PINS[f] || rwRoutePinHolds(f))
  && (!RW_LINE_PINS[f] || rwLinePinHolds(f));
/** Drop this feature's src files from a "changed since <base>" list; files the expected list already names stay. */
export const dropRwSrc = (files, expected = []) => files.filter((f) => !isRwSrc(f) || expected.includes(f));

// `node scripts/lib/recentWinnersAllowance.mjs` prints the current pins (for a reviewed refresh).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const f of Object.keys(RW_ROUTE_PINS)) console.log(`  '${f}': '${rwRouteSha(f)}',`);
  for (const f of Object.keys(RW_LINE_PINS)) console.log(`  '${f}': '${rwLinesSha(f)}',`);
}
