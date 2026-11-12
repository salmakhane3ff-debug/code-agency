#!/usr/bin/env node
/**
 * scripts/neutralWording.test.mjs — TEMPORARY design-review preview (src/lib/neutralWording.js):
 *   • TEXT ONLY: the visible "simulation" words of the active Brand dashboard are replaced by neutral labels (or
 *     not shown when they are a standalone badge / disclaimer); every system stays mounted — no component, API
 *     call or polling is removed; one switch (NEUTRAL_WORDING_PREVIEW) restores every original text;
 *   • Top Members / Top Brands (dashboard block, full pages, profiles) are no longer handled here: their texts are
 *     neutral at the source (src/lib/demoCompetition/i18n.js) and their single simulation disclosure lives in
 *     src/lib/demoCompetition/disclosure.js (scripts/demoCompetitionPublic.test.mjs) — checked below;
 *   • landing pages and the Brand offer keep their texts.
 *
 *   node scripts/neutralWording.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (f) => readFileSync(`${ROOT}${f}`, 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + String(extra).slice(0, 400) : ''}`); } };

const W = await import(`${ROOT}src/lib/neutralWording.js`);
const { demoT } = await import(`${ROOT}src/lib/demoCompetition/i18n.js`);
const { brandT } = await import(`${ROOT}src/lib/brandI18n.js`);
const { dashboardT } = await import(`${ROOT}src/app/affiliate/dashboard/_brand/dashboardText.js`);
const DEMO_WORDS = /d[ée]mo|simul|d[ée]monstration|عرض توضيحي|توضيحي|محاك/i;
const VARS = { n: 3, name: 'X', rank: 1, date: 'D', reason: 'R', ref: 'REF' };

console.log('\n1. neutralize()');
{
  const base = (k, v) => `base:${k}${v ? ':' + JSON.stringify(v) : ''}`;
  const t = W.neutralize(base, { a: 'A {x}', b: '' });
  if (W.NEUTRAL_WORDING_PREVIEW) {
    ok('overridden key → neutral text with {var} interpolation', t('a', { x: 7 }) === 'A 7');
    ok('"" override → empty (the caller does not render it)', t('b') === '');
    ok('other keys fall through to the original translator, vars included', t('c', { y: 1 }) === 'base:c:{"y":1}');
  } else {
    ok('preview OFF → the original translator itself (every original text restored)', t === base);
  }
  ok('no overrides → the original translator itself', W.neutralize(base, undefined) === base);
  ok('the preview switch is a single boolean export', typeof W.NEUTRAL_WORDING_PREVIEW === 'boolean');
}

console.log('\n2. Neutral maps — complete for fr + ar, no demo / simulation word');
// DEMO_COMP_NEUTRAL was removed: the Top Members / Top Brands texts are neutral at the source (§3 checks them as rendered).
for (const [name, map, translator] of [['BRAND_DASH_NEUTRAL', W.BRAND_DASH_NEUTRAL, brandT], ['BRAND_DASH_TEXT_NEUTRAL', W.BRAND_DASH_TEXT_NEUTRAL, dashboardT]]) {
  const fr = Object.keys(map.fr || {}).sort(), ar = Object.keys(map.ar || {}).sort();
  ok(`${name}: same keys in fr and ar`, fr.length > 0 && JSON.stringify(fr) === JSON.stringify(ar));
  const bad = ['fr', 'ar'].flatMap((l) => Object.entries(map[l]).filter(([, v]) => DEMO_WORDS.test(v)).map(([k]) => `${l}.${k}`));
  ok(`${name}: no override contains a demo / simulation word`, bad.length === 0, bad.join(', '));
  const t = { fr: translator('fr'), ar: translator('ar') };
  const unknown = ['fr', 'ar'].flatMap((l) => Object.keys(map[l]).filter((k) => t[l](k) === k).map((k) => `${l}.${k}`));
  ok(`${name}: every overridden key exists in the original texts`, unknown.length === 0, unknown.join(', '));
  const varsKept = ['fr', 'ar'].flatMap((l) => Object.entries(map[l]).filter(([k, v]) => {
    const orig = (t[l](k, Object.fromEntries(Object.keys(VARS).map((x) => [x, `{${x}}`]))).match(/\{\w+\}/g) || []).sort().join();
    return v && orig !== (v.match(/\{\w+\}/g) || []).sort().join();
  }).map(([k]) => `${l}.${k}`));
  ok(`${name}: neutral texts keep the original placeholders`, varsKept.length === 0, varsKept.join(', '));
}

console.log('\n3. In-scope texts, as rendered: no demo / simulation label (the one disclosure is the central SimulationNote)');
{
  const keysOf = (files, fn) => [...new Set(files.flatMap((f) => [...read(f).matchAll(new RegExp(`\\b${fn}\\("([a-zA-Z0-9_]+)"`, 'g'))].map((m) => m[1])))];
  const dcFiles = ['DemoCompetitionBlock', 'HomeSectionFrame', 'HomeTopMembers', 'HomeTopBrands', 'CompactLeaderboard', 'MemberRow', 'LeaderCard', 'Badges']
    .map((c) => `src/components/demoCompetition/${c}.jsx`);
  const dcKeys = [...keysOf(dcFiles, 't'), ...keysOf(['src/app/affiliate/dashboard/page.jsx'], 't'),
    'leaderboard_brands_label', 'empty_brands', 'moved_up', 'moved_down', 'moved_up_24h', 'moved_down_24h'];
  const brandFiles = ['src/app/affiliate/dashboard/_brand/BrandDashboard.jsx', 'src/components/brand/BrandSimStats.jsx'];
  const hits = [];
  for (const l of ['fr', 'ar']) {
    // Top Members / Top Brands: the base texts themselves, whatever the switch (no neutral overrides any more).
    const t = demoT(l);
    for (const k of dcKeys) if (DEMO_WORDS.test(t(k, VARS))) hits.push(`demo ${l}.${k}`);
    const bt = W.neutralize(brandT(l), W.BRAND_DASH_NEUTRAL[l]);
    for (const k of keysOf(brandFiles, 't')) if (DEMO_WORDS.test(bt(k, VARS))) hits.push(`brand ${l}.${k}`);
    const d = W.neutralize(dashboardT(l), W.BRAND_DASH_TEXT_NEUTRAL[l]);
    for (const k of keysOf(brandFiles, 'd')) if (DEMO_WORDS.test(d(k, VARS))) hits.push(`dashboardText ${l}.${k}`);
  }
  const dcHits = hits.filter((h) => h.startsWith('demo '));
  ok('dashboard leaderboard block (Top Members / Top Brands): no demo / simulation label, preview switch or not', dcHits.length === 0, dcHits.join(', '));
  ok(`active Brand dashboard: ${W.NEUTRAL_WORDING_PREVIEW ? 'no visible demo / simulation word' : '(preview off — originals shown)'}`,
    !W.NEUTRAL_WORDING_PREVIEW || hits.length === dcHits.length, hits.join(', '));
}

console.log('\n4. Text only — every system stays mounted, one switch, scope limited');
{
  const hook = read('src/components/demoCompetition/useLivePolling.js');
  // Changed requirement: the Top Members / Top Brands wording is neutral at the source, so the neutral-wording
  // wrapper (useNeutralDemoText + DEMO_COMP_NEUTRAL) is gone and the components read the base texts directly.
  ok('Top Members / Top Brands no longer go through the neutral-wording module (useNeutralDemoText / DEMO_COMP_NEUTRAL removed)',
    !/useNeutralDemoText|neutralWording|DEMO_COMP_NEUTRAL/.test(hook) && W.DEMO_COMP_NEUTRAL === undefined);
  for (const f of ['DemoCompetitionBlock', 'HomeTopMembers', 'HomeTopBrands']) {
    // Optional page language since the move to the Affiliate Dashboard (default: the site language, as before).
    const src = read(`src/components/demoCompetition/${f}.jsx`);
    ok(`dashboard ${f} reads the (neutral) base texts in the page language`, /= useDemoText\(langOverride\);/.test(src) && !/useNeutralDemoText|neutralWording/.test(src));
  }
  const page = read('src/app/affiliate/dashboard/page.jsx');
  // The dashboard shows the homepage components (neutral texts above) in the dashboard language.
  ok('dashboard leaderboard uses the texts in the dashboard language',
    // count = the number of sections the admin shows (Hide / Show), see demoCompetitionIntegration.
    /<DemoCompetitionBlock count=\{count\} lang=\{lang\}>/.test(page) && /<HomeTopMembers lang=\{lang\}/.test(page) && /<HomeTopBrands lang=\{lang\}/.test(page));
  ok('dashboard still mounts Live Activity, the Top Members / Top Brands sections and the Booster widget',
    /<LiveActivity/.test(page) && /<CompetitionTab lang=\{lang\} \/>/.test(page) && /activeBoosters/.test(page));
  ok('no conditional hiding module is left (src/lib/demoContent.js removed)', !/demoContent/.test(page + read('src/components/HomeBuilder/HomeSectionRenderer.jsx')));
  const full = ['TopMembersPage', 'TopBrandsPage', 'MemberProfile', 'BrandProfile', 'ProfileParts'].map((c) => read(`src/components/demoCompetition/${c}.jsx`)).join('\n');
  ok('full pages and profiles keep the original texts (no neutral wording there)', !/useNeutralDemoText|neutralWording/.test(full));
  const dash = read('src/app/affiliate/dashboard/_brand/BrandDashboard.jsx');
  ok('active Brand dashboard wraps both translators', /neutralize\(brandText, BRAND_DASH_NEUTRAL\[brandLang\(lang\)\]\)/.test(dash) && /neutralize\(dashboardT\(lang\), BRAND_DASH_TEXT_NEUTRAL\[brandLang\(lang\)\]\)/.test(dash));
  ok('Brand offer / purchase terms (BrandTab) keep their texts', !/neutralWording|neutralize/.test(read('src/app/affiliate/dashboard/BrandTab.jsx')));
  const badges = read('src/components/demoCompetition/Badges.jsx'), stats = read('src/components/brand/BrandSimStats.jsx');
  // Changed requirement: SimulationBadge / SimulationDisclosure were removed (no labels); the one remaining
  // leaderboard disclosure (SimulationNote) renders nothing when the central disclosure is disabled.
  ok('an empty badge / disclosure renders nothing (no blank pill or box)',
    /export function SimulationNote\(\{[^)]*\}\) \{\s*const text = simulationDisclosure\(lang\);\s*if \(!text\) return null;/.test(badges)
    && !/SimulationBadge|SimulationDisclosure/.test(badges)
    && /SimulatedBadge\(\{ t \}\) \{\s*if \(!t\("dash_badge"\)\) return null;/.test(stats));
  ok('the "training orders" note (recent_note) is not shown, fr + ar, and its paragraphs collapse when empty',
    !W.NEUTRAL_WORDING_PREVIEW || (W.BRAND_DASH_NEUTRAL.fr.recent_note === '' && W.BRAND_DASH_NEUTRAL.ar.recent_note === ''
      && /empty:hidden">\{\[t\("recent_note"\), d\("fin_note"\)\]\.filter\(Boolean\)\.join\(" "\)\}/.test(dash) && /empty:hidden">\{t\("recent_note"\)\}/.test(dash)));
  const ref = 'SIM-Y9PX-261110-0028';
  ok('displayed order reference drops the "SIM-" prefix only while the preview is on',
    W.displayOrderRef(ref) === (W.NEUTRAL_WORDING_PREVIEW ? 'Y9PX-261110-0028' : ref) && W.displayOrderRef('ABC-SIM-1') === 'ABC-SIM-1' && W.displayOrderRef(null) === null);
  ok('the reference value itself is unchanged (React key, data-order, paging); only the visible text / aria-label use displayOrderRef',
    /key=\{o\.ref\}/.test(dash) && /data-order=\{o\.ref\}/.test(dash) && /seen\.has\(o\.ref\)/.test(dash)
    && /<bdi dir="ltr">\{displayOrderRef\(o\.ref\)\}<\/bdi>/.test(dash) && /\{displayOrderRef\(order\.ref\)\}/.test(dash) && /ref: displayOrderRef\(o\.ref\)/.test(dash)
    && !/<bdi dir="ltr">\{o\.ref\}|<span dir="ltr">\{order\.ref\}/.test(dash));
  ok('the lib documents the publication warning and the one-switch revert', /Not for publication/.test(read('src/lib/neutralWording.js')) && /NEUTRAL_WORDING_PREVIEW to false/.test(read('src/lib/neutralWording.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
