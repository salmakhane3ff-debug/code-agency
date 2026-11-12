#!/usr/bin/env node
/**
 * scripts/demoCompetitionIntegration.test.mjs — Phase F of the Demo Competition (SIMULATION ONLY):
 *   • ONLY the affiliate dashboard leaderboard moved to the new members (/api/demo-competition/members);
 *   • /tsajlim3ana and Live Activity still read the old demo system, byte-identical to the base;
 *   • the old demo system (models, service, routes, admin panel, worker) is untouched — nothing deleted;
 *   • the two engines never write each other's data (separate tables, worker names, scripts and locks);
 *   • the retirement plan is documented (docs/demo-competition.md).
 *
 *   node scripts/demoCompetitionIntegration.test.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = 'cefc644';
const read = (f) => readFileSync(`${ROOT}${f}`, 'utf8');
const TASK7 = '23990d5';
const LOCALIZED_BY_TASK7 = ['src/app/tsajlim3ana/RecruitmentLanding.jsx', 'src/components/LiveActivity.jsx'];
const atRef = (ref, f) => { try { return execFileSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }); } catch { return null; } };
const atBase = (f) => { try { return execFileSync('git', ['show', `${BASE}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }); } catch { return null; } };
// Line-based (a block-comment regex would also eat strings such as "image/*"): drop comment-only lines, JSX
// {/* … */} comments on one line and trailing " // …" comments.
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '').replace(/\s\/\/\s.*$/, '')).join('\n');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + String(extra).slice(0, 400) : ''}`); } };

console.log('\n1. Affiliate dashboard leaderboard → Demo Competition members');
{
  const page = read('src/app/affiliate/dashboard/page.jsx');
  const code = stripComments(page);
  const tab = code.slice(code.indexOf('function CompetitionTab('), code.indexOf('function', code.indexOf('function CompetitionTab(') + 10));
  // Approved move: the dashboard shows the Store Homepage design itself — the SAME components (DemoCompetitionBlock +
  // HomeTopMembers + HomeTopBrands), which poll /api/demo-competition/members and /brands through the shared live poller.
  const homeMembers = read('src/components/demoCompetition/HomeTopMembers.jsx');
  const homeBrands = read('src/components/demoCompetition/HomeTopBrands.jsx');
  ok('CompetitionTab renders the homepage components: one DemoCompetitionBlock with the sections the admin shows, each with its admin settings',
    /const members = dashboardSectionData\(layout, "top_members"\);\s*const brands = dashboardSectionData\(layout, "top_brands"\);/.test(tab)
    && /<DemoCompetitionBlock count=\{count\} lang=\{lang\}>\s*\{members\.visible && <HomeTopMembers lang=\{lang\} sectionId="dashboard_top_members" data=\{members\} \/>\}\s*\{brands\.visible && <HomeTopBrands lang=\{lang\} sectionId="dashboard_top_brands" data=\{brands\} \/>\}\s*<\/DemoCompetitionBlock>/.test(tab)
    && !/useLivePolling/.test(tab)
    && /useLivePolling\(`\/api\/demo-competition\/members\?limit=\$\{count\}`\)/.test(homeMembers) && /useLivePolling\(`\/api\/demo-competition\/brands\?limit=\$\{count\}`\)/.test(homeBrands));
  // Admin settings (approved): the dashboard reads the SAME saved sections (Setting homepage_layout) through the existing
  // public settings endpoint — no new API, no new setting — and waits for them (no default-then-admin flicker).
  ok('the admin settings are read from the existing homepage_layout setting (one GET, no new API) before the sections render',
    /fetch\("\/api\/setting\?type=homepage_layout", \{ cache: "no-store" \}\)/.test(tab) && /if \(layout === undefined\) return null;/.test(tab)
    && (tab.match(/fetch\(/g) || []).length === 1);
  {
    const HS = await import('../src/lib/demoCompetition/homepageSections.js');
    const layout = [
      { id: 'a', type: 'hero', data: {} },
      { id: 'b', type: 'top_members', visible: false, data: { title: 'Nos meilleurs affiliés', previewCount: 3, showViewAll: false } },
      { id: 'c', type: 'top_brands', data: { title: '', previewCount: 99, showViewAll: true } },
    ];
    ok('dashboardSectionData: the saved visibility (Afficher / Masquer), title, row count and "Voir tout" of each section',
      JSON.stringify(HS.dashboardSectionData(layout, 'top_members')) === '{"visible":false,"title":"Nos meilleurs affiliés","previewCount":3,"showViewAll":false}'
      && HS.dashboardSectionData(layout, 'top_brands').visible === true);
    ok('dashboardSectionData: row counts clamped to the admin bounds (brands 1..20, members 1..21); empty title kept empty (default title)',
      HS.dashboardSectionData(layout, 'top_brands').previewCount === 20 && HS.dashboardSectionData(layout, 'top_brands').title === ''
      && HS.dashboardSectionData([{ type: 'top_members', data: { previewCount: 0 } }], 'top_members').previewCount === 1
      && HS.dashboardSectionData([{ type: 'top_members', data: { previewCount: 50 } }], 'top_members').previewCount === 21);
    ok('dashboardSectionData: no section saved (or no layout) → the admin form defaults (5 rows, default title, "Voir tout" shown)',
      JSON.stringify(HS.dashboardSectionData([], 'top_brands')) === '{"visible":true,"title":"","previewCount":5,"showViewAll":true}'
      && JSON.stringify(HS.dashboardSectionData(null, 'top_members')) === '{"visible":true,"title":"","previewCount":5,"showViewAll":true}');
    ok('the components apply them: rows = previewCount (API limit), title = saved title or the default in the dashboard language, "Voir tout" only when showViewAll',
      [homeMembers, homeBrands].every((c) => /useLivePolling\(`\/api\/demo-competition\/(members|brands)\?limit=\$\{count\}`\)/.test(c)
        && /const title = \(typeof data\.title === "string" && data\.title\.trim\(\)\) \|\| t\("(members|brands)_title"\);/.test(c)
        && /showViewAll=\{data\.showViewAll !== false\}/.test(c))
      && /<h3 className="[^"]*"><bdi>\{title\}<\/bdi><\/h3>/.test(read('src/components/demoCompetition/HomeSectionFrame.jsx')));
    // Hide / Show per section (independent): the block holds only the shown sections; both hidden → no block.
    const vis = (m, b) => [{ type: 'top_members', visible: m, data: {} }, { type: 'top_brands', visible: b, data: {} }];
    const shown = (l) => ['top_members', 'top_brands'].filter((t) => HS.dashboardSectionData(l, t).visible);
    ok('Hide / Show is independent per section: members only, brands only, both, none',
      JSON.stringify(shown(vis(true, false))) === '["top_members"]' && JSON.stringify(shown(vis(false, true))) === '["top_brands"]'
      && shown(vis(true, true)).length === 2 && shown(vis(false, false)).length === 0
      && /const count = \(members\.visible \? 1 : 0\) \+ \(brands\.visible \? 1 : 0\);\s*if \(!count\) return null;/.test(tab));
    const adminPage = read('src/app/admin/demo-competition/homepage/page.jsx');
    const builder = read('src/app/admin/homepage-builder/page.jsx');
    ok('admin: Afficher / Masquer kept (it now drives the dashboard); no Monter / Descendre, no homepage position / order for these sections',
      /setSectionVisible\(sections, type, !d\.visible\)/.test(adminPage) && /Affichée sur le tableau de bord affilié/.test(adminPage)
      && !/Monter|Descendre|moveSection|Ordre actuel|position \{d\.index/.test(adminPage)
      && /\{!DASHBOARD_SECTION_TYPES\.has\(sec\.type\) && \(/.test(builder) && /const DASHBOARD_SECTION_TYPES = new Set\(\["top_members", "top_brands"\]\);/.test(builder));
    ok('wording: the dashboard sections are described for affiliés (no "visiteurs")', /toujours aux affiliés\./.test(builder) && !/visiteurs/.test(builder));
    ok('both admin forms say where these settings now apply (the Affiliate Dashboard)',
      /data-applies-to-dashboard/.test(read('src/app/admin/homepage-builder/page.jsx')) && /s'appliquent au tableau de bord affilié/.test(read('src/app/admin/demo-competition/homepage/page.jsx')));
  }
  ok('the dashboard no longer calls the old /api/demo/* endpoints', !/["'`]\/api\/demo\//.test(code));
  ok('no monthly cycle: no cycle number, days-left banner or "Compétition du mois" text',
    !/cycleNum|daysLeft \?\?|jours restants|Compétition du mois|Classement du mois/.test(code.slice(code.indexOf('function CompetitionTab('), code.indexOf('// ── Identity Verification card'))));
  ok('rows are the homepage CompactLeaderboard and "Voir tout" → /top-members and /top-brands',
    /<CompactLeaderboard kind="member"/.test(homeMembers) && /<CompactLeaderboard kind="brand"/.test(homeBrands)
    && /viewAllHref="\/top-members"/.test(homeMembers) && /viewAllHref="\/top-brands"/.test(homeBrands)
    && !/MembersLeaderboard|SimulationDisclosure/.test(code));
  const row = read('src/components/demoCompetition/CompactLeaderboard.jsx');
  ok('a row opens /top-members/[id] or /top-brands/[id]', /const href = `\/\$\{isBrand \? "top-brands" : "top-members"\}\/\$\{encodeURIComponent\(item\.id\)\}`;/.test(row));
  // Changed requirement: no "Démo / Simulation" badge per section any more (and no longer a hidden banner): the block
  // shows the ONE discreet central disclosure (<SimulationNote>, src/lib/demoCompetition/disclosure.js) under the sections.
  ok('the simulation disclosure is shown once on the dashboard (central SimulationNote under the block), no per-section badge',
    /\{children\}\s*<\/div>\s*<SimulationNote lang=\{lang\} className="[^"]*" \/>/.test(read('src/components/demoCompetition/DemoCompetitionBlock.jsx'))
    && !/SimulationBadge|sim_badge/.test(read('src/components/demoCompetition/HomeSectionFrame.jsx')));
  ok('the old modal / avatar helpers of the dashboard are gone (no dead code left)', !/DemoAffiliateModal|function DemoAvatar|GROWTH_BADGE|REFRESH_SEC/.test(code));
  ok('the dashboard still renders the leaderboard on the overview, under Live Activity', /<LiveActivity windowSize=\{4\} showViewAll \/>[\s\S]{0,400}<CompetitionTab lang=\{lang\} \/>/.test(page));
  // Approved decision (dashboard language): the leaderboard follows the Affiliate Dashboard language (French on this
  // branch), never a storefront language chosen elsewhere.
  // Since the merge with Task 7 (market localization) the dashboard is AR/FR: the leaderboard receives the dashboard's
  // market language (useMarketLocale) instead of the former fixed "fr" — still never the storefront language.
  // (The components call useDemoText(langOverride) directly: the neutral-wording wrapper was removed, texts are neutral at the source.)
  ok('the dashboard leaderboard uses the dashboard language (market AR/FR), not the storefront language',
    /const \{ lang, t, intlLocale \} = useMarketLocale\(AFFILIATE_DASHBOARD_TEXT\);/.test(page) && !/useLanguage\(/.test(page) && !/DASHBOARD_LANG/.test(page) && ['DemoCompetitionBlock', 'HomeTopMembers', 'HomeTopBrands'].every((c) => /= useDemoText\(langOverride\);/.test(read(`src/components/demoCompetition/${c}.jsx`))) && /export function useDemoText\(langOverride\)[\s\S]{0,200}demoLang\(langOverride \|\| lang\)/.test(read('src/components/demoCompetition/useLivePolling.js')));
  ok('the dashboard has no Demo Competition write and imports no service (client only)',
    !/demoCompetitionService|method:\s*["'](POST|PATCH|PUT|DELETE)["'][^)]*demo-competition/.test(code));
}

{
  // Browser check finding: in Arabic (RTL) a Latin name ending with "." rendered as ".Hajar N" — names are bidi-isolated.
  // Approved design: the rows render the shared LeaderCard (name passed as a prop, isolated there); the brand
  // owner line isolates the owner name too (it rendered as ".Reda Q بواسطة" before).
  const comps = ['LeaderCard', 'BrandRow', 'MemberProfile', 'BrandProfile'].map((c) => read(`src/components/demoCompetition/${c}.jsx`));
  ok('member / brand / owner names are bidi-isolated (<bdi>) in cards and profiles', /<bdi>\{name\}<\/bdi>/.test(comps[0]) && /<bdi>\{owner\.name\}<\/bdi>/.test(comps[1])
    && comps.slice(2).every((src) => /<bdi>\{\w+\.name\}<\/bdi>/.test(src)) && comps.every((src) => !/(?<!<bdi)>\{\w+\.name\}</.test(src) && !/(?<!<bdi)>\{name\}</.test(src)));
}

console.log('\n2. /tsajlim3ana and Live Activity unchanged (still the old demo system)');
for (const f of ['src/app/tsajlim3ana/RecruitmentLanding.jsx', 'src/components/LiveActivity.jsx', 'src/lib/services/liveActivityEngine.js', 'src/app/api/live-activity/route.js']) {
  // RecruitmentLanding.jsx and LiveActivity.jsx changed only through the approved Task 7 localization (23990d5, on the
  // recruiter branch, merged with this one); the Demo Competition itself never touches them.
  const ref = LOCALIZED_BY_TASK7.includes(f) ? TASK7 : BASE;
  const base = atRef(ref, f);
  ok(`${f} is byte-identical to ${ref}`, base !== null && existsSync(`${ROOT}${f}`) && base === read(f));
}
ok('/tsajlim3ana still reads /api/demo/leaderboard', /\/api\/demo\/leaderboard/.test(read('src/app/tsajlim3ana/RecruitmentLanding.jsx')));
ok('Live Activity still uses the old demo identity pool', /getDemoIdentityPool/.test(read('src/lib/services/liveActivityEngine.js')));

console.log('\n3. Old demo system kept (nothing deleted or changed)');
{
  const OLD = [
    'src/lib/services/demoService.js', 'src/app/api/demo/leaderboard/route.js', 'src/app/api/demo/affiliate/[id]/route.js',
    'src/app/api/admin/demo/route.js', 'src/app/api/admin/demo/simulate/route.js', 'src/app/api/admin/demo/reset/route.js',
    'src/app/api/admin/demo/avatars/route.js', 'src/app/api/admin/demo/avatars/[id]/route.js', 'src/app/admin/affiliates/page.jsx',
    'scripts/demo-competition-engine.mjs', 'scripts/demoIsolation.test.mjs',
  ];
  const diff = OLD.filter((f) => atBase(f) === null || !existsSync(`${ROOT}${f}`) || atBase(f) !== read(f));
  ok(`the ${OLD.length} old demo files are present and byte-identical to ${BASE}`, diff.length === 0, diff.join(','));
  const blocks = (s) => new Map([...s.matchAll(/^model (\w+) \{[\s\S]*?^\}/gm)].map((m) => [m[1], m[0]]));
  const now = blocks(read('prisma/schema.prisma')), base = blocks(atBase('prisma/schema.prisma'));
  const OLD_MODELS = ['DemoAffiliate', 'DemoAvatar', 'DemoStats', 'DemoEarningsHistory', 'DemoCompetition', 'DemoSettings'];
  ok('the 6 old demo models are unchanged', OLD_MODELS.every((m) => base.get(m) && base.get(m) === now.get(m)));
  const eco = read('ecosystem.config.js');
  ok('both pm2 apps exist, with different names and scripts (old one kept as is)',
    /name:\s*'demo-competition-engine',\s*\n\s*script:\s*'scripts\/demo-competition-engine\.mjs'/.test(eco)
    && /name:\s*'demo-leaderboard-engine',\s*\n\s*script:\s*'scripts\/demo-leaderboard-engine\.mjs'/.test(eco));
  ok('ecosystem.config.js only gained the demo-leaderboard-engine app (no line removed)',
    (() => { const d = execFileSync('git', ['diff', '--unified=0', BASE, '--', 'ecosystem.config.js'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((l) => /^[-+]/.test(l) && !/^(\+\+\+|---) /.test(l));
      return d.length > 0 && d.every((l) => l.startsWith('+')) && d.some((l) => /demo-leaderboard-engine/.test(l)); })());
}

console.log('\n4. The two engines never write each other\'s data');
{
  const oldSrc = stripComments(read('src/lib/services/demoService.js') + read('scripts/demo-competition-engine.mjs'));
  const newSrc = stripComments(read('src/lib/services/demoCompetitionService.js') + read('scripts/demo-leaderboard-engine.mjs') + read('src/lib/demoCompetition/engine.js'));
  ok('the old engine never references a demoComp* model or demo_comp_* table', !/demoComp[A-Z]|demo_comp_/.test(oldSrc));
  ok('the new engine only uses demoComp* models (no old demo model, no order / commission / payout / wallet / reward model)',
    !/\b(?:db|prisma|tx)\.(demoAffiliate|demoAvatar|demoStats|demoEarningsHistory|demoCompetition|demoSettings|order|affiliateCommission|affiliatePayout|affiliateWallet|reward\w*|recruiter\w*|affiliate)\b/.test(newSrc)
    && /\.demoCompEvent\b/.test(newSrc));
  ok('different advisory locks', /DEMO_SIM_LOCK_KEY/.test(read('scripts/demo-competition-engine.mjs')) && /DEMO_COMP_ENGINE_LOCK_KEY/.test(read('scripts/demo-leaderboard-engine.mjs'))
    && !/DEMO_SIM_LOCK_KEY/.test(read('scripts/demo-leaderboard-engine.mjs')));
}

console.log('\n5. Retirement documented');
{
  const doc = existsSync(`${ROOT}docs/demo-competition.md`) ? read('docs/demo-competition.md') : '';
  ok('docs/demo-competition.md lists the old models, service, routes, worker and remaining consumers, and a retirement order needing approval',
    ['DemoAffiliate', 'demoService.js', '/api/demo/leaderboard', 'demo-competition-engine', '/tsajlim3ana', 'Live Activity', 'separate approval'].every((s) => doc.includes(s)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
