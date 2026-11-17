/**
 * scripts/lib/payoutBanksAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The EXACT, documented allowance for "Phase 4 — Bank Logo Picker & Admin Bank Management"
 * (branch feature/affiliate-nav-ugc-homepage-count, base beb8962) in the "unchanged versus
 * <earlier commit>" scope guards of the recruiter / market-locale / activation suites:
 *
 *   1. Admin bank catalogue (payout_banks): pure rules src/lib/payoutBanks.js, service +
 *      route handlers, admin routes (list / create / edit / logo — no delete), the public
 *      active-catalogue route, the admin page + sidebar link.
 *   2. Visual bank picker (logo + name) for affiliates (dashboard bank tab) and recruiters
 *      (wallet page) — shared BankPicker component, FR / AR texts, field error labels.
 *   3. Conditional RIB: a bank with "RIB required = No" needs only the account holder's full
 *      name. validateBankInfo skips the RIB ONLY when the chosen catalogue bank says
 *      ribRequired === false; the affiliate payout request and the recruiter withdrawal read
 *      that flag. Nothing else in payouts / commissions / balances / withdrawals changes.
 *   4. Security: the affiliate team API no longer returns other members' bank details
 *      (getAffiliateTeam → withoutBankDetails); the old unvalidated "PUT /api/affiliate/me"
 *      bank write is now validated (400 INVALID_INPUT).
 *   5. ONE additive migration (PB_MIGRATION, SHA-256 pinned) + exactly the schema lines below.
 *
 * Financial / guarded files that other suites pin byte-identical may differ from PB_BASE
 * ONLY by their exact +/- lines, SHA-256 pinned in PB_LINE_PINS. The suites drop exactly
 * these files and keep every other assertion unchanged.
 * Re-pin ONLY after reviewing a deliberate change:  node scripts/lib/payoutBanksAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutUgcDiffLines } from './uploadAuthUgcSupportAllowance.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Base of this branch (feature/dashboard-admin-controls head) — every pinned diff is taken against it. */
export const PB_BASE = 'beb89622957b436c5b8836f08ff17111a6544fdd';

export const PB_MIGRATION_DIR = '20261115_payout_banks';
export const PB_MIGRATION = `prisma/migrations/${PB_MIGRATION_DIR}/migration.sql`;
export const PB_MIGRATION_SHA = 'b00ece750602b46c76a02d18eb50455bce8127d7d59ac03ab1165aa223da584c';

/** Exact src files of this phase (new or edited). */
export const PB_SRC_FILES = Object.freeze([
  // 1. catalogue
  'src/lib/payoutBanks.js',
  'src/lib/services/payoutBankService.js',
  'src/app/api/payout-banks/route.js',
  'src/app/api/admin/payout-banks/route.js',
  'src/app/api/admin/payout-banks/[id]/route.js',
  'src/app/api/admin/payout-banks/[id]/logo/route.js',
  'src/app/admin/payout-banks/page.jsx',
  'src/components/admin/SideBar.jsx',
  // 2. picker (affiliate + recruiter)
  'src/components/payout/BankPicker.jsx',
  'src/app/affiliate/dashboard/page.jsx',
  'src/lib/affiliateDashboardI18n.js',
  'src/app/recruiter/wallet/page.jsx',
  'src/app/recruiter/wallet/walletI18n.js',
  'src/app/recruiter/errorLabels.js',
  'src/lib/recruiterVisibility.js',
  'src/lib/serverText/affiliateServerText.js', // Arabic text of the new 400 message
  // 3 + 4. eligibility, validated saves, team API fix (line-pinned below)
  'src/lib/services/affiliateSystemService.js',
  'src/lib/services/recruiterWalletService.js',
  'src/app/api/affiliate/me/route.js',
  'src/app/api/recruiter/wallet/bank/route.js',
]);

/** Files other suites pin byte-identical (or guard as a directory): allowed ONLY with exactly these +/- lines vs PB_BASE. */
export const PB_LINE_PINS = Object.freeze({
  'src/lib/services/affiliateSystemService.js': 'f83b45e91519ca6400a38ed14f600f521b75eae51399e054a9a0eb03cd4888bc',
  'src/lib/services/recruiterWalletService.js': '767c9b0d3fa1e73fc9c8ab6d10bcfb9ab0b9a3e8a8420c7380faac6f3f6b7ebd',
  'src/lib/recruiterVisibility.js': '7ed3bd61dc4b03c013d1f901372ad17925a116c9875445c60e62d3d12618a5f1',
  'src/app/api/affiliate/me/route.js': '1ffc996996c78590ae2ec87d204f0e2dd0c2da14c40719888d0fd364f68653b0',
  'src/app/api/recruiter/wallet/bank/route.js': '66615571720e38844f745be6b44558fe21c61d8dd3bc658544df9dbc72edf3b8',
});

/** schema.prisma: exactly these edits (each `to` occurs once; stripping maps it back to `from`). */
const AFF_BANK = '  // Bank chosen from the admin catalogue (Phase 4 — bank logo picker); bankName keeps a copy of its name.\n';
export const PB_SCHEMA_EDITS = Object.freeze([
  {
    from: '  activationRecoveries AffiliateActivationRecovery[]\n\n',
    to: '  activationRecoveries AffiliateActivationRecovery[]\n' + AFF_BANK
      + '  bankId               String?\n'
      + '  bank                 PayoutBank?             @relation(fields: [bankId], references: [id], onDelete: Restrict)\n\n',
  },
  {
    from: '  @@index([referralStatus])\n  @@map("affiliates")\n',
    to: '  @@index([referralStatus])\n  @@index([bankId])\n  @@map("affiliates")\n',
  },
  {
    from: '  identityVerification RecruiterIdentityVerification?\n\n',
    to: '  identityVerification RecruiterIdentityVerification?\n' + AFF_BANK
      + '  bankId              String?\n'
      + '  bank                PayoutBank?                @relation(fields: [bankId], references: [id], onDelete: Restrict)\n\n',
  },
  {
    from: '  @@index([isActive])\n  @@map("recruiters")\n',
    to: '  @@index([isActive])\n  @@index([bankId])\n  @@map("recruiters")\n',
  },
  {
    from: '// ── Affiliate Recruiter System ─',
    to: '// ── Payout banks (Phase 4 — bank logo picker) ──────────────────────────────────\n'
      + '// Admin-managed catalogue of the banks an affiliate / recruiter picks for withdrawals.\n'
      + '// Never deleted (a bank already chosen by a user is only deactivated): both FKs are\n'
      + '// ON DELETE RESTRICT. ribRequired = false → the withdrawal uses the account holder\'s full\n'
      + '// name only (no RIB). Logos are public images stored through saveMedia.\n'
      + 'model PayoutBank {\n'
      + '  id          String      @id @default(uuid())\n'
      + '  name        String\n'
      + '  logoUrl     String?\n'
      + '  isActive    Boolean     @default(true)\n'
      + '  ribRequired Boolean     @default(true)\n'
      + '  sortOrder   Int         @default(0)\n'
      + '  createdAt   DateTime    @default(now())\n'
      + '  updatedAt   DateTime    @updatedAt\n'
      + '  affiliates  Affiliate[]\n'
      + '  recruiters  Recruiter[]\n'
      + '\n'
      + '  @@index([isActive, sortOrder])\n'
      + '  @@map("payout_banks")\n'
      + '}\n'
      + '\n'
      + '// ── Affiliate Recruiter System ─',
  },
]);
export const PB_SCHEMA_SHA = 'fce5627989bf1c776007a1f072c3e0707f5ef83e92668301dcb2801636ddd07a';

/** The schema text WITHOUT this phase's lines (what the older guards compare). */
export function stripPayoutBankSchema(schema) {
  let s = schema;
  for (const { from, to } of PB_SCHEMA_EDITS) if (s.split(to).length === 2) s = s.replace(to, from);
  return s;
}
const norm = (l) => l[0] + l.slice(1).replace(/\s+/g, ' ').trim();
/** The +lines this phase adds to schema.prisma (normalized). */
const pbDiffLines = () => {
  const added = [];
  for (const { from, to } of PB_SCHEMA_EDITS) {
    const f = from.split('\n'), t = to.split('\n');
    const pool = [...f];
    for (const l of t) { const i = pool.indexOf(l); if (i === -1) { if (l.trim() || l === '') added.push(norm(`+${l}`)); } else pool.splice(i, 1); }
  }
  return added;
};
/** Remove this phase's lines from `git diff` +/- lines of schema.prisma, raw or whitespace-normalized (each at most once). */
export function withoutPayoutBankDiffLines(lines) {
  const drop = pbDiffLines();
  return lines.filter((l) => { const i = drop.indexOf(norm(l)); if (i === -1) return true; drop.splice(i, 1); return false; });
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const changedLines = (file) => git(['diff', PB_BASE, '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));

// The later Demo UGC Videos schema lines (scripts/lib/uploadAuthUgcSupportAllowance.mjs — own SHA pin) are set aside.
export const pbSchemaSha = () => sha(withoutUgcDiffLines(changedLines('prisma/schema.prisma')).join('\n'));
export const pbSchemaPinHolds = () => pbSchemaSha() === PB_SCHEMA_SHA;
export const pbMigrationSha = () => sha(readFileSync(`${ROOT}${PB_MIGRATION}`, 'utf8'));
export const pbMigrationPinHolds = () => pbMigrationSha() === PB_MIGRATION_SHA;
export const pbLinesSha = (file) => sha(changedLines(file).join('\n'));
/** A guarded file that differs from PB_BASE by exactly its pinned lines. */
export const pbLinePinHolds = (file) => !!PB_LINE_PINS[file] && pbLinesSha(file) === PB_LINE_PINS[file];

/**
 * For the "byte-identical to <ref>" pins: the file equals its <ref> version, OR it differs from PB_BASE by exactly
 * its pinned Phase 4 lines AND its PB_BASE version equals the <ref> version (so nothing else ever changed).
 */
export function pbIdenticalExceptPinned(ref, file) {
  const at = (r) => { try { return git(['show', `${r}:${file}`]); } catch { return null; } };
  const now = readFileSync(`${ROOT}${file}`, 'utf8');
  const old = at(ref);
  if (old !== null && now === old) return true;
  return pbLinePinHolds(file) && old !== null && at(PB_BASE) === old;
}

export const isPayoutBankSrc = (f) => PB_SRC_FILES.includes(f);
/** Drop this phase's src files from a "changed since <base>" list; files the expected list already names stay. */
export const dropPayoutBankSrc = (files, expected = []) => files.filter((f) => !isPayoutBankSrc(f) || expected.includes(f));
export const isPayoutBankPrisma = (f) => f === PB_MIGRATION || f === PB_MIGRATION_DIR || f === `${PB_MIGRATION_DIR}/`;

// `node scripts/lib/payoutBanksAllowance.mjs` prints the current pins (for a reviewed refresh).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`  PB_MIGRATION_SHA = '${pbMigrationSha()}'`);
  console.log(`  PB_SCHEMA_SHA = '${pbSchemaSha()}'`);
  for (const f of Object.keys(PB_LINE_PINS)) console.log(`  '${f}': '${pbLinesSha(f)}',`);
}
