/**
 * scripts/lib/navHomepageAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * The EXACT, documented allowance for "Implementation Phase 1 — Affiliate Navigation, UGC
 * Button & Homepage Product Count" (branch feature/affiliate-nav-ugc-homepage-count, from
 * beb8962) in the "unchanged versus <earlier commit>" scope guards of the recruiter /
 * market-locale / demo-competition suites:
 *
 *   1. Affiliate mobile bottom navigation: moved unchanged into src/components/affiliate/
 *      MobileBottomNav.jsx; shown on /top-members, /top-brands and their profiles for a
 *      signed-in affiliate only (AffiliateNavGate + the two Top layouts); dashboard ?tab=,
 *      nav kept on the loading / error screens; viewport-fit=cover + safe-area paddings
 *      (affiliate + Top layouts only, globals.css).
 *   2. UGC "Add Video" button above the bottom nav on phones; overlays that sat UNDER the nav
 *      (order details, deposit proof viewer, Live Activity "voir tout" sheet) raised to z-65;
 *      bottom sheets padded for the home indicator.
 *   3. Homepage products grid: admin-controlled count data.productCount (4 / 6 / 8 / 10,
 *      default 4) — pure rule src/lib/homepageProducts.js, builder select, renderer, grid.
 *
 *   Phase 2 (same branch) — /products lists AVAILABLE products before LOCKED ones: the feed
 *      query's ORDER BY + keyset (src/lib/services/productService.js — FEED_SQL and its bound lock
 *      flag only) and the opaque cursor codec (src/lib/productFeed.js — adds the lock flag; old
 *      cursors stay readable). No change to Product Lock rules, filters, COUNT or the homepage.
 *   Phase 3 (same branch) — server-side pagination of the Admin STORE orders list only
 *      (/admin/orders): a NEW admin endpoint GET /api/admin/orders, its pure query rules and a NEW
 *      service module, plus the page. GET /api/order, orderService.js, the other order pages,
 *      affiliate orders (admin + dashboard) and recruiter orders are untouched.
 *
 * Nothing financial, no schema or migration (Phase 2 changes the feed query; Phase 3 adds one admin read route). The suites drop exactly these
 * files and keep every other assertion; LiveActivity.jsx (pinned byte-identical to Task 7 by the
 * Demo Competition suite) may differ ONLY by its two class-attribute lines, SHA-256 pinned below.
 * Re-pin ONLY after reviewing a deliberate change:  node scripts/lib/navHomepageAllowance.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Exact src files of this phase (new or edited). */
export const NAV_HOMEPAGE_SRC_FILES = Object.freeze([
  // 1. bottom navigation
  'src/components/affiliate/MobileBottomNav.jsx',
  'src/components/affiliate/AffiliateNavGate.jsx',
  'src/lib/affiliateNav.js',
  'src/app/top-members/layout.jsx',
  'src/app/top-brands/layout.jsx',
  'src/app/affiliate/layout.jsx',
  'src/app/affiliate/dashboard/page.jsx',
  'src/app/globals.css',
  // 2. UGC button + overlays / sheets
  'src/app/affiliate/dashboard/UgcTab.jsx',
  'src/app/affiliate/dashboard/BoosterTab.jsx',
  'src/app/affiliate/dashboard/DepositTab.jsx',
  'src/components/LiveActivity.jsx',
  // 3. homepage product count
  'src/lib/homepageProducts.js',
  'src/components/Product/ProductGrid.jsx',
  'src/components/HomeBuilder/HomeSectionRenderer.jsx',
  'src/app/admin/homepage-builder/page.jsx',
  'src/app/page.jsx',
  // Phase 2. /products order: available first, then locked (newest first in each group)
  'src/lib/services/productService.js',
  'src/lib/productFeed.js',
  // Phase 3. Admin store orders: server-side pagination
  'src/app/admin/orders/page.jsx',
  'src/app/api/admin/orders/route.js',
  'src/lib/services/adminOrdersListService.js',
  'src/lib/adminOrdersQuery.js',
]);

/** Files another suite pins byte-identical to a ref: allowed to differ ONLY by these exact +/- lines. */
export const NAV_HOMEPAGE_LINE_PINS = Object.freeze({
  // Live Activity "voir tout" sheet: z-50 → z-[65] (it sat under the z-60 bottom nav) + home-indicator padding.
  'src/components/LiveActivity.jsx': Object.freeze({
    ref: '23990d5a4366b89a1ecd9b0e6db1af568e8f00b0',
    sha: '921579f274470d00a558764e82a95ad945339fdc3b7d18080bab4917a243af36',
  }),
});

export const isNavHomepageSrc = (f) => NAV_HOMEPAGE_SRC_FILES.includes(f);
/** Drop this phase's src files from a "changed since <base>" list; files the expected list already names stay. */
export const dropNavHomepageSrc = (files, expected = []) => files.filter((f) => !isNavHomepageSrc(f) || expected.includes(f));

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const changedLines = (ref, file) => git(['diff', ref, '--', file]).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));

export const navHomepageLinesSha = (file) => sha(changedLines(NAV_HOMEPAGE_LINE_PINS[file].ref, file).join('\n'));
/** A pinned file that differs from its ref by exactly its pinned lines. */
export const navHomepageLinePinHolds = (file) => !!NAV_HOMEPAGE_LINE_PINS[file] && navHomepageLinesSha(file) === NAV_HOMEPAGE_LINE_PINS[file].sha;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const f of Object.keys(NAV_HOMEPAGE_LINE_PINS)) console.log(`  '${f}': '${navHomepageLinesSha(f)}',`);
}
