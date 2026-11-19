#!/usr/bin/env node
/**
 * scripts/affiliateNavHomepage.test.mjs — Implementation Phase 1:
 *   1. Affiliate mobile bottom nav on /top-members, /top-brands and their profiles (signed-in affiliates
 *      only), dashboard ?tab=, nav kept on the loading / error screens, page padding, safe areas.
 *   2. UGC "Add Video" button above the nav on phones; overlays / sheets stacking + home-indicator padding.
 *   3. Homepage products grid: admin-controlled data.productCount (4 / 6 / 8 / 10, default 4).
 * Pure helpers are executed; components are checked statically (the repo's convention for JSX).
 * Run: node scripts/affiliateNavHomepage.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const N = await import('../src/lib/affiliateNav.js');
const H = await import('../src/lib/homepageProducts.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = `${dir}/${n}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
const SRC = walk(`${ROOT}src`).filter((f) => /\.(jsx?|tsx?|css)$/.test(f)).map((f) => f.slice(ROOT.length));

const NAV = read('src/components/affiliate/MobileBottomNav.jsx');
const GATE = read('src/components/affiliate/AffiliateNavGate.jsx');
const PAGE = read('src/app/affiliate/dashboard/page.jsx');
const CSS = read('src/app/globals.css');

// ── 1a. Pure helpers ───────────────────────────────────────────────────────────
console.log('1a. affiliateNav helpers');
{
  // 12: the SIMULATED Demo Competition "UGC Videos" board is shown on the overview, NOT as a tab (scripts/demoCompUgcDashboard.test.mjs).
  ok('every dashboard tab is whitelisted (12, incl. booster; no ugc-videos tab)', N.DASHBOARD_TABS.length === 12 && N.DASHBOARD_TABS.includes('booster') && N.DASHBOARD_TABS.includes('overview') && !N.DASHBOARD_TABS.includes('ugc-videos'));
  ok('?tab= known tab → that tab', N.DASHBOARD_TABS.every((t) => N.parseDashboardTab(`?tab=${t}`) === t) && N.parseDashboardTab('?x=1&tab=ugc') === 'ugc');
  ok('?tab= unknown / injected / empty → null', ['?tab=admin', '?tab=UGC', '?tab=ugc%3Cscript', '?tab=', '', null, undefined, 42, '?tab=__proto__']
    .every((s) => N.parseDashboardTab(s) === null));
  ok('dashboardTabHref: tab → ?tab=, overview / unknown → plain dashboard',
    N.dashboardTabHref('payout') === '/affiliate/dashboard?tab=payout' && N.dashboardTabHref('overview') === '/affiliate/dashboard'
    && N.dashboardTabHref('evil') === '/affiliate/dashboard' && N.dashboardTabHref(null) === '/affiliate/dashboard');
  const store = (o) => ({ getItem: (k) => o[k] ?? null });
  ok('hasAffiliateSession: token + id required (same test as the dashboard bootstrap)',
    N.hasAffiliateSession(store({ affiliateToken: 't', affiliateId: 'i' })) && !N.hasAffiliateSession(store({ affiliateToken: 't' }))
    && !N.hasAffiliateSession(store({ affiliateId: 'i' })) && !N.hasAffiliateSession(store({})) && !N.hasAffiliateSession(null)
    && !N.hasAffiliateSession({ getItem: () => { throw new Error('blocked'); } }));
  ok('session keys = the 4 written by the affiliate login page', JSON.stringify(N.AFFILIATE_SESSION_KEYS) === JSON.stringify(['affiliateToken', 'affiliateId', 'affiliateUsername', 'affiliateName'])
    && N.AFFILIATE_SESSION_KEYS.every((k) => read('src/app/affiliate/login/page.jsx').includes(`localStorage.setItem("${k}"`)));
  ok('referral link = the dashboard format', N.referralLink('https://x.ma', 'sara') === 'https://x.ma?ref=sara' && N.referralLink('https://x.ma', null) === '');
  const snap = N.serializeNavSnapshot({ unread: 3, rechargeEnabled: false, username: 'sara_1' });
  ok('snapshot round-trip (unread, recharge flag, username)', JSON.stringify(N.parseNavSnapshot(snap)) === JSON.stringify({ unread: 3, rechargeEnabled: false, username: 'sara_1' }));
  ok('snapshot holds no token / secret', !/token|password|jwt/i.test(snap) && Object.keys(JSON.parse(snap)).sort().join() === 'rechargeEnabled,unread,username');
  ok('snapshot defaults: missing / broken → unread 0, recharge ON, no username',
    ['', null, '{bad', '[]', '{"unread":-2,"username":"<x>"}'].every((r) => { const p = N.parseNavSnapshot(r); return p.unread === 0 && p.rechargeEnabled === true && p.username === null; }));
  ok('snapshot: unread capped, recharge OFF only for explicit false', N.parseNavSnapshot('{"unread":5000}').unread === 999 && N.parseNavSnapshot('{"rechargeEnabled":0}').rechargeEnabled === true);
}

// ── 1b. Moved nav is unchanged ────────────────────────────────────────────────
console.log('\n1b. MobileBottomNav moved unchanged');
{
  let before = '';
  try { before = execFileSync('git', ['show', 'beb89622957b436c5b8836f08ff17111a6544fdd:src/app/affiliate/dashboard/page.jsx'], { cwd: ROOT, encoding: 'utf8' }); } catch {}
  const fnOf = (s) => { const i = s.indexOf('function MobileBottomNav('); const j = s.indexOf('\n}\n', i); return i < 0 ? '' : s.slice(i, j + 2); };
  const oldFn = fnOf(before), newFn = fnOf(NAV);
  const STYLE_OLD = 'style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>';
  const STYLE_NEW = 'style={{ paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}>';
  // (The Demo Competition "UGC Videos" board is on the overview — the More sheet has no entry for it.)
  ok('the component is the dashboard\'s, character for character (only the bar gains left/right safe-area padding)',
    oldFn.length > 4000 && newFn === oldFn.replace(STYLE_OLD, STYLE_NEW));
  ok('the dashboard no longer defines it and imports the shared one', !/function MobileBottomNav\(/.test(PAGE) && /import MobileBottomNav from "@\/components\/affiliate\/MobileBottomNav";/.test(PAGE));
  ok('client component with the same hook + dictionary', /^"use client";/.test(NAV) && /useMarketLocale\(AFFILIATE_DASHBOARD_TEXT\)/.test(NAV) && /export default MobileBottomNav;/.test(NAV));
}

// ── 1c. Gate: signed-in affiliates only, Top pages only ───────────────────────
console.log('\n1c. AffiliateNavGate + Top layouts');
{
  const g = strip(GATE);
  ok('client component; renders nothing until a session is found after mount (no server HTML, no visitor nav)',
    /^"use client";/.test(GATE) && /useState\(null\)/.test(g) && /if \(!nav\) return null;/.test(g)
    && /useEffect\(\(\) => \{\s*if \(!hasAffiliateSession\(window\.localStorage\)\) return;/.test(g));
  ok('tabs open /affiliate/dashboard?tab=<id>; logout clears the same keys and goes to the login', /router\.push\(dashboardTabHref\(tab\)\)/.test(g)
    && /AFFILIATE_SESSION_KEYS\.forEach/.test(g) && /router\.push\("\/affiliate\/login"\)/.test(g));
  ok('renders the shared MobileBottomNav with no active tab, in the market direction', /<MobileBottomNav\s+activeTab=\{null\}/.test(g) && /<div dir=\{dir\} lang=\{lang\}/.test(g));
  ok('sets <html data-affiliate-nav> only while shown (removed on unmount)', /root\.setAttribute\(NAV_HTML_ATTR, ""\)/.test(g) && /return \(\) => root\.removeAttribute\(NAV_HTML_ATTR\)/.test(g)
    && /NAV_HTML_ATTR = "data-affiliate-nav"/.test(GATE));
  for (const l of ['src/app/top-members/layout.jsx', 'src/app/top-brands/layout.jsx']) {
    const s = strip(read(l));
    ok(`${l}: renders the page then the gate; viewport-fit=cover`, /\{children\}\s*<AffiliateNavGate \/>/.test(s) && /export const viewport = \{ viewportFit: "cover" \};/.test(s));
  }
  const users = SRC.filter((f) => /<AffiliateNavGate\b/.test(read(f)));
  // + the full UGC Videos leaderboard (/top-ugc-videos — the "Voir tout" of the dashboard home's Top UGC Videos), same layout.
  ok('the gate is mounted ONLY by the three Top layouts (no other storefront page)', JSON.stringify(users.sort()) === JSON.stringify(['src/app/top-brands/layout.jsx', 'src/app/top-members/layout.jsx', 'src/app/top-ugc-videos/layout.jsx']), users.join());
  const navUsers = SRC.filter((f) => /<MobileBottomNav\b/.test(read(f)));
  ok('the nav itself is rendered only by the dashboard and the gate', JSON.stringify(navUsers.sort()) === JSON.stringify(['src/app/affiliate/dashboard/page.jsx', 'src/components/affiliate/AffiliateNavGate.jsx']), navUsers.join());
  const cover = SRC.filter((f) => /viewportFit:\s*"cover"/.test(read(f)));
  ok('viewport-fit=cover only on the affiliate area + the three Top layouts', JSON.stringify(cover.sort()) === JSON.stringify(['src/app/affiliate/layout.jsx', 'src/app/top-brands/layout.jsx', 'src/app/top-members/layout.jsx', 'src/app/top-ugc-videos/layout.jsx']), cover.join());
  ok('the affiliate layout still wraps the area in MarketScope', /<MarketScope>\s*\{children\}[\s\S]*?<\/MarketScope>/.test(read('src/app/affiliate/layout.jsx')) /* (+ the dashboard WhatsApp support button after the children) */);
}

// ── 1d. Dashboard wiring ──────────────────────────────────────────────────────
console.log('\n1d. Dashboard: ?tab=, URL sync, nav on loading / error, snapshot');
{
  // Raw source: the page contains string literals such as "image/*" that a naive comment stripper would eat.
  const p = PAGE;
  ok('bootstrap opens the whitelisted ?tab= (notifications → mark read once loaded)', /const requested = parseDashboardTab\(window\.location\.search\);\s*if \(requested\) \{\s*setActiveTab\(requested\);/.test(p)
    && /if \(requested === "notifications"\) markReadOnLoadRef\.current = true;/.test(p) && /if \(data && markReadOnLoadRef\.current\) \{ markReadOnLoadRef\.current = false; markNotifsRead\(\); \}/.test(p));
  ok('the URL follows the open tab (replaceState, so Back from a Top page returns to it)',
    /const href = dashboardTabHref\(activeTab\);/.test(p) && /window\.history\.replaceState\(window\.history\.state, "", href\)/.test(p));
  const spinner = p.slice(p.indexOf('if (!affiliateId || loading) {'), p.indexOf('if (error) {'));
  const errorBranch = p.slice(p.indexOf('if (error) {'), p.indexOf('const affiliate  = data?.affiliate;'));
  ok('the bottom nav stays on the loading screen and the error screen (signed-in only)', /\{guardNav\}/.test(spinner) && /\{guardNav\}/.test(errorBranch)
    && /const guardNav = affiliateId \? \(\s*<MobileBottomNav/.test(p));
  ok('the main render still passes every prop (incl. rechargeEnabled)', /<MobileBottomNav\s+activeTab=\{activeTab\}\s+setActiveTab=\{setActiveTab\}\s+refLink=\{refLink\}\s+onLogout=\{handleLogout\}\s+unread=\{unread\}\s+onOpenNotifications=\{markNotifsRead\}\s+rechargeEnabled=\{rechargeEnabled\}\s+\/>/.test(p));
  ok('snapshot written for the Top pages: unread, recharge flag, username only (no token)',
    /sessionStorage\.setItem\(NAV_SNAPSHOT_KEY, serializeNavSnapshot\(\{ unread: navUnread, rechargeEnabled: navRechargeEnabled, username: navUsername \}\)\)/.test(p));
}

// ── 1e. Padding + safe areas ──────────────────────────────────────────────────
console.log('\n1e. Page padding + safe areas');
{
  const c = strip(CSS);
  ok('phones: page end padded above the bar + home indicator while the gate shows the nav',
    /@media \(width < 48rem\) \{\s*html\[data-affiliate-nav\] body \{\s*padding-bottom: calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\);/.test(c));
  ok('landscape notch: body padded by the side insets (0 wherever viewport-fit=cover is not set)',
    /body \{\s*padding-left: env\(safe-area-inset-left, 0px\);\s*padding-right: env\(safe-area-inset-right, 0px\);\s*\}/.test(c));
  ok('nav bar pads bottom / left / right insets; More sheet and toast keep theirs', /paddingBottom: "env\(safe-area-inset-bottom\)", paddingLeft: "env\(safe-area-inset-left\)", paddingRight: "env\(safe-area-inset-right\)"/.test(NAV)
    && /paddingBottom: "calc\(20px \+ env\(safe-area-inset-bottom\)\)"/.test(NAV) && /bottom: "calc\(104px \+ env\(safe-area-inset-bottom\)\)"/.test(NAV));
  ok('dashboard content keeps its bottom room for the bar', /pb-\[calc\(96px\+env\(safe-area-inset-bottom\)\)\] md:pb-5/.test(PAGE));
}

// ── 2. UGC button + stacking ──────────────────────────────────────────────────
console.log('\n2. UGC "Add Video" button + overlays');
{
  const ugc = read('src/app/affiliate/dashboard/UgcTab.jsx');
  ok('phones: the button sits above the bar (104 px + home indicator); desktop keeps bottom-6',
    /fixed bottom-6 end-5 max-md:bottom-\[calc\(104px\+env\(safe-area-inset-bottom\)\)\] z-40 w-16 h-16 rounded-full/.test(ugc));
  ok('same design otherwise (size, colour, shadow, end side)', /w-16 h-16 rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-\[0_8px_28px_rgba\(124,58,237,0\.45\)\]/.test(ugc));
  const z = (re, s) => { const m = re.exec(s); return m ? m[1] : null; };
  ok('nav bar z-60, More sheet z-70 (unchanged)', /md:hidden fixed bottom-0 inset-x-0 z-\[60\]/.test(NAV) && /md:hidden fixed inset-0 z-\[70\]/.test(NAV));
  ok('overlays that sat UNDER the bar now cover it (z-65: above the bar, below the More sheet and other sheets)',
    z(/className="fixed inset-0 bg-black\/50 (z-\S+) flex items-center justify-center p-4"/, PAGE) === 'z-[65]'
    && z(/<div className="fixed inset-0 (z-\S+) bg-black\/70 flex items-center justify-center p-4" onClick=\{closeProof\}>/, read('src/app/affiliate/dashboard/DepositTab.jsx')) === 'z-[65]'
    && z(/<div className="fixed inset-0 (z-\S+) flex items-end sm:items-center justify-center" onClick=\{\(\) => setOpen\(false\)\}>/, read('src/components/LiveActivity.jsx')) === 'z-[65]');
  const noLowOverlay = SRC.filter((f) => /^src\/(app\/affiliate|components\/affiliate)\//.test(f))
    .filter((f) => /fixed inset-0[^"]*\bz-(10|20|30|40|50)\b/.test(read(f)));
  ok('no full-screen overlay in the affiliate area below the bar any more', noLowOverlay.length === 0, noLowOverlay.join());
  ok('bottom sheets padded for the home indicator (UGC confirm + wizard, Booster, Live Activity)',
    /p-6 pb-\[calc\(1\.5rem\+env\(safe-area-inset-bottom\)\)\] sm:pb-6 w-full sm:max-w-sm/.test(ugc) && /max-h-\[92vh\] overflow-y-auto pb-\[env\(safe-area-inset-bottom\)\] sm:pb-0/.test(ugc)
    && /p-6 pb-\[calc\(1\.5rem\+env\(safe-area-inset-bottom\)\)\] sm:pb-6 animate-\[bstUp/.test(read('src/app/affiliate/dashboard/BoosterTab.jsx'))
    && /flex flex-col pb-\[env\(safe-area-inset-bottom\)\] sm:pb-0 animate-\[laUp/.test(read('src/components/LiveActivity.jsx')));
}

// ── 3. Homepage product count ─────────────────────────────────────────────────
console.log('\n3. Homepage products grid count');
{
  ok('exactly 4 / 6 / 8 / 10, default 4', JSON.stringify(H.PRODUCT_COUNT_OPTIONS) === '[4,6,8,10]' && H.DEFAULT_PRODUCT_COUNT === 4);
  ok('normalizeProductCount keeps 4 / 6 / 8 / 10 (numbers and numeric strings)', [4, 6, 8, 10].every((n) => H.normalizeProductCount(n) === n && H.normalizeProductCount(String(n)) === n));
  ok('anything else → 4', [undefined, null, '', 0, 1, 3, 5, 7, 9, 12, 50, -4, 4.5, '4.0', 'ten', NaN, {}, [8], true].every((v) => H.normalizeProductCount(v) === 4));
  ok('a section reads data.productCount only — the old data.limit is ignored',
    H.sectionProductCount({ productCount: 8 }) === 8 && H.sectionProductCount({ limit: 8 }) === 4 && H.sectionProductCount({ limit: 10, productCount: 6 }) === 6
    && H.sectionProductCount(null) === 4 && H.sectionProductCount({}) === 4);
  // The grid shows products.slice(0, limit): exactly the selected count whenever the catalogue has enough.
  const catalogue = Array.from({ length: 25 }, (_, i) => ({ id: i }));
  ok('each choice renders exactly that many products (and the "view more" link when there are more)',
    H.PRODUCT_COUNT_OPTIONS.every((n) => catalogue.slice(0, n).length === n && catalogue.length > n));
  const grid = strip(read('src/components/Product/ProductGrid.jsx'));
  ok('ProductGrid: shows `limit` products, "view more" past it, skeleton = `limit` cards; other callers keep 10',
    /function StyleOne\(\{ limit = 10 \}\)/.test(grid) && /const displayProducts = products\.slice\(0, limit\);/.test(grid)
    && /const hasMoreProducts = products\.length > limit;/.test(grid) && /\{SKELETON_ITEMS\.slice\(0, limit\)\.map\(/.test(grid) && !/slice\(0, 10\)/.test(grid));
  ok('grid classes unchanged (2 / 3 / 4 columns)', (grid.match(/grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4/g) || []).length === 2);
  const r = strip(read('src/components/HomeBuilder/HomeSectionRenderer.jsx'));
  ok('homepage section passes the admin count', /<ProductGrid limit=\{sectionProductCount\(data\)\} \/>/.test(r) && !/data\.limit/.test(r));
  ok('homepage without a saved layout shows the default (4)', /<ProductGrid limit=\{DEFAULT_PRODUCT_COUNT\} \/>/.test(strip(read('src/app/page.jsx'))));
  const b = strip(read('src/app/admin/homepage-builder/page.jsx'));
  ok('builder: a select of exactly the 4 choices, saving data.productCount (no more editing of data.limit)',
    /<select className="field w-28" data-product-count value=\{normalizeProductCount\(data\.productCount\)\}/.test(b)
    && /onChange=\{e => onChange\(\{ \.\.\.data, productCount: normalizeProductCount\(e\.target\.value\) \}\)\}/.test(b)
    && /\{PRODUCT_COUNT_OPTIONS\.map\(\(n\) => <option key=\{n\} value=\{n\}>\{n\} products<\/option>\)\}/.test(b) && !/limit: Number\(e\.target\.value\)/.test(b));
  ok('builder default for a new section: productCount 4', /products:\s+\{ title: "Featured Products", productCount: DEFAULT_PRODUCT_COUNT, collectionFilter: "" \}/.test(b));
  ok('the builder saves through the existing revisioned layout endpoint (unchanged)', /\/api\/admin\/homepage-layout/.test(b));
  ok('product page related grid unchanged (no limit → 10)', /<ProductGrid \/>/.test(read('src/app/products/[id]/product.jsx')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
