#!/usr/bin/env node
/**
 * scripts/dashboardWhatsApp.test.mjs — the floating "تحدث مع الدعم مباشرة" WhatsApp support button of the Affiliate
 * dashboard and the Recruiter pages (src/components/support/DashboardWhatsAppButton.jsx + src/lib/dashboardSupport.js).
 *   1. supportRoleForPath: affiliate dashboard + internal pages, authenticated recruiter pages; null everywhere else.
 *   2. Messages + wa.me URL: the UI Control number's digits, the encoded role message, < 10 digits → null.
 *   2b. Placement: physical bottom-right in both directions, clear of the UGC button / bottom navs / recruiter sidebar.
 *   3. Static: the component reads useUIControl().floatingWhatsappNumber (no hardcoded number), session gates, exact Arabic label,
 *      mounted once in the affiliate + recruiter layouts only; the Homepage button hides on /recruiter too.
 * Pure helpers are executed; components are checked statically (the repo's convention for JSX).
 * Run: node scripts/dashboardWhatsApp.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const S = await import('../src/lib/dashboardSupport.js');
const { isPublicRecruiterPath, PUBLIC_RECRUITER_PATHS } = await import('../src/app/recruiter/recruiterUiState.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = `${dir}/${n}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
const SRC = walk(`${ROOT}src`).filter((f) => /\.(jsx?|tsx?)$/.test(f)).map((f) => f.slice(ROOT.length));

const COMPONENT_PATH = 'src/components/support/DashboardWhatsAppButton.jsx';
const LIB_PATH = 'src/lib/dashboardSupport.js';
const COMP = read(COMPONENT_PATH);
const LIB = read(LIB_PATH);
const LABEL = 'تحدث مع الدعم مباشرة';

// ── 1. Routes ─────────────────────────────────────────────────────────────────
console.log('1. supportRoleForPath');
{
  const aff = ['/affiliate/dashboard', '/affiliate/dashboard/', '/affiliate/dashboard?tab=ugc', '/affiliate/dashboard#x', '/affiliate/dashboard/orders', '/affiliate/dashboard/brand/pack'];
  ok('affiliate dashboard + its internal pages → affiliate', aff.every((p) => S.supportRoleForPath(p) === 'affiliate'), aff.filter((p) => S.supportRoleForPath(p) !== 'affiliate').join());
  const rec = ['/recruiter', '/recruiter/', '/recruiter/affiliates', '/recruiter/affiliates/new', '/recruiter/affiliates/activation', '/recruiter/network',
    '/recruiter/network/stats', '/recruiter/wallet', '/recruiter/profile', '/recruiter/verification', '/recruiter/password', '/recruiter/wallet?x=1'];
  ok('authenticated recruiter pages → recruiter', rec.every((p) => S.supportRoleForPath(p) === 'recruiter'), rec.filter((p) => S.supportRoleForPath(p) !== 'recruiter').join());
  // Every recruiter page.jsx route on disk is either public (pre-login) or gets the button.
  const recRoutes = SRC.filter((f) => /^src\/app\/recruiter\/.*page\.jsx$/.test(f) || f === 'src/app/recruiter/page.jsx')
    .map((f) => `/${f.replace(/^src\/app\//, '').replace(/\/?page\.jsx$/, '')}`);
  ok('every recruiter route on disk: public → null, otherwise → recruiter',
    recRoutes.length >= 10 && recRoutes.every((r) => S.supportRoleForPath(r) === (isPublicRecruiterPath(r) ? null : 'recruiter')), recRoutes.join());
  ok('the only pre-login recruiter page is /recruiter/login (and it gets no button)',
    JSON.stringify(PUBLIC_RECRUITER_PATHS) === '["/recruiter/login"]' && S.supportRoleForPath('/recruiter/login') === null && S.supportRoleForPath('/recruiter/login/') === null
    && S.supportRoleForPath('/recruiter/login?next=/recruiter') === null);
  const none = ['/', '/products', '/products/abc', '/top-members', '/top-members/123', '/top-brands', '/top-brands/x', '/affiliate', '/affiliate/login',
    '/affiliate/activate', '/affiliate/activate/recovery', '/affiliate/dashboards', '/affiliate/dashboard-old', '/recruiters', '/recruiterx',
    '/admin', '/admin/ui-control', '/admin/affiliates', '/admin/recruiters', '/login', '/checkout', '/cart', '/tsajlim3ana', '/offer/some-offer',
    '/landing/my-offer', '/x/affiliate/dashboard', '/x/recruiter', '', null, undefined, 42, {}];
  ok('null everywhere else (storefront, Top pages, affiliate login / activation, admin, landings, junk)',
    none.every((p) => S.supportRoleForPath(p) === null), none.filter((p) => S.supportRoleForPath(p) !== null).map(String).join());
}

// ── 2. Messages + URL ─────────────────────────────────────────────────────────
console.log('\n2. Messages + wa.me URL');
{
  const a = S.supportMessage('affiliate'), r = S.supportMessage('recruiter');
  ok('affiliate message (Arabic, role only)', a === 'مرحباً، أنا مسوق في Ecome Agency وأحتاج إلى مساعدة.');
  ok('recruiter message (Arabic, role only)', r === 'مرحباً، أنا مُجنِّد في Ecome Agency وأحتاج إلى مساعدة.');
  ok('unknown role → empty message', ['admin', '', null, undefined, '__proto__', 'constructor', 'toString'].every((x) => S.supportMessage(x) === ''));
  ok('messages: no placeholder, id, token, phone or account detail',
    [a, r].every((m) => !/[{}$<>%]|\d|@|token|user(name)?|id\b|phone|email|code/i.test(m)));
  const NUM = '+212 6 12-34-56-78';
  ok('affiliate URL = UI Control digits + encoded affiliate message',
    S.supportWhatsappUrl(NUM, 'affiliate') === `https://wa.me/212612345678?text=${encodeURIComponent(a)}`);
  ok('recruiter URL = UI Control digits + encoded recruiter message',
    S.supportWhatsappUrl(NUM, 'recruiter') === `https://wa.me/212612345678?text=${encodeURIComponent(r)}`);
  ok('decoded ?text= round-trips to the message', decodeURIComponent(new URL(S.supportWhatsappUrl(NUM, 'recruiter')).search.slice(6)) === r
    && new URL(S.supportWhatsappUrl(NUM, 'affiliate')).searchParams.get('text') === a);
  ok('< 10 digits (or empty / missing) → null', ['', null, undefined, '123456789', '+212 6 12', 'abc', '   '].every((n) => S.supportWhatsappUrl(n, 'affiliate') === null));
  ok('exactly 10 digits → a link (same validation as FloatingWhatsApp)', S.supportWhatsappUrl('06-12-34-56-78', 'recruiter')?.startsWith('https://wa.me/0612345678?text='));
  ok('unknown role → null even with a valid number', S.supportWhatsappUrl(NUM, 'admin') === null && S.supportWhatsappUrl(NUM, null) === null);
  ok('a numeric setting value is accepted too', S.supportWhatsappUrl(212612345678, 'affiliate')?.startsWith('https://wa.me/212612345678?'));
  const FW = strip(read('src/components/FloatingWhatsApp.jsx'));
  ok('FloatingWhatsApp uses the same validation (digits only, >= 10)', /replace\(\/\\D\/g, ""\)/.test(FW) && /digits\.length < 10/.test(FW)
    && /\.replace\(\/\\D\/g, ""\)/.test(LIB) && /digits\.length < 10/.test(LIB));
}

// ── 2b. Placement (physical bottom-right, clear of the UGC button / bottom navs / recruiter sidebar) ─────────────────
console.log('\n2b. Placement');
{
  const px = (v) => { const m = /^(?:calc\((\d+)px\+env\(safe-area-inset-bottom\)\)|max\((\d+)px,env\(safe-area-inset-bottom\)\)|(\d+)px)$/.exec(v); return m ? Number(m[1] ?? m[2] ?? m[3]) : NaN; };
  const geo = (cls) => {
    const t = String(cls).split(/\s+/);
    const get = (re) => (t.map((x) => re.exec(x)).find(Boolean) || [])[1];
    return { tokens: t, phone: px(get(/^bottom-\[(.+)\]$/)), md: px(get(/^md:bottom-\[(.+)\]$/)),
      right: get(/^right-\[(.+)\]$/), mdRight: get(/^md:right-\[(.+)\]$/), lgRight: get(/^lg:right-\[(.+)\]$/) };
  };
  const all = [['affiliate', 'rtl'], ['affiliate', 'ltr'], ['recruiter', 'rtl'], ['recruiter', 'ltr']].map(([r, d]) => [r, d, geo(S.supportPlacement(r, d))]);
  ok('always the physical RIGHT (both roles, both directions): right max(16px, safe-area-inset-right); never left / start / end',
    all.every(([, , g]) => g.right === 'max(16px,env(safe-area-inset-right))' && !g.tokens.some((x) => /(^|:)(left|start|end|inset-x|inset)-/.test(x))), JSON.stringify(all.map(([r, d, g]) => [r, d, g.tokens])));
  ok('every placement has a phone and an md+ bottom (bottom corner)', all.every(([, , g]) => g.phone > 0 && g.md > 0));
  // Bottom navs: ~76px + safe area; the pages pad 96px for them (globals.css / recruiter <main>).
  const CSS = read('src/app/globals.css');
  ok('phones: at or above the 96px the pages reserve for the bottom navs (+ safe area)',
    all.every(([, , g]) => g.phone >= 96) && /padding-bottom: calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(CSS)
    && /pb-\[calc\(96px\+env\(safe-area-inset-bottom\)\)\]/.test(read('src/app/recruiter/_components/RecruiterShell.jsx')));
  // UGC "Add video" button, measured from its source.
  const UGC = read('src/app/affiliate/dashboard/UgcTab.jsx');
  const ugcCls = (/className="(fixed bottom-6 end-5 [^"]*)"/.exec(UGC) || [])[1] || '';
  const size = Number((/\bh-(\d+)\b/.exec(ugcCls) || [])[1]) * 4;
  const ugcMd = Number((/(?:^|\s)bottom-(\d+)\b/.exec(ugcCls) || [])[1]) * 4;
  const ugcPhone = Number((/max-md:bottom-\[calc\((\d+)px\+env\(safe-area-inset-bottom\)\)\]/.exec(ugcCls) || [])[1]);
  ok('UGC "Add video" button measured: 64px, end side, md+ bottom 24px, phones 104px + safe area', size === 64 && ugcMd === 24 && ugcPhone === 104 && /\bend-5\b/.test(ugcCls), ugcCls);
  const aLtr = geo(S.supportPlacement('affiliate', 'ltr')), aRtl = geo(S.supportPlacement('affiliate', 'rtl'));
  ok('affiliate French (LTR — UGC `end` = right): stacked above the UGC button with ≥ 12px gap (md+ 100px, phones 180px + safe area)',
    aLtr.md >= ugcMd + size + 12 && aLtr.phone >= ugcPhone + size + 12 && aLtr.md === 100 && aLtr.phone === 180, JSON.stringify(aLtr));
  ok('affiliate Arabic (RTL — UGC `end` = left, no overlap on the right): default corner (phones 96px + safe area, md+ 24px)',
    aRtl.phone === 96 && aRtl.md === 24 && aRtl.mdRight === undefined);
  // Recruiter: sidebar on the start side (RIGHT in Arabic) md+, md:w-60 / lg:w-64; nothing fixed at the bottom-right on desktop.
  const SH = read('src/app/recruiter/_components/RecruiterShell.jsx');
  ok('recruiter shell: sidebar column md:w-60 lg:w-64 on the start side; its other fixed elements are phone-only (md:hidden) or full-screen dialogs',
    /<div className="hidden md:block w-60 lg:w-64 shrink-0/.test(SH)
    && [...SH.matchAll(/className="([^"]*\bfixed\b[^"]*)"/g)].every((m) => /\bmd:hidden\b/.test(m[1]) || /\binset-0\b/.test(m[1])));
  const rRtl = geo(S.supportPlacement('recruiter', 'rtl')), rLtr = geo(S.supportPlacement('recruiter', 'ltr'));
  ok('recruiter Arabic (RTL) md+: still right, clear of the 15rem / 16rem right sidebar (+16px)',
    rRtl.mdRight === 'calc(15rem+16px)' && rRtl.lgRight === 'calc(16rem+16px)' && rRtl.phone === 96 && rRtl.md === 24);
  ok('recruiter French (LTR): sidebar on the left → default corner', rLtr.mdRight === undefined && rLtr.lgRight === undefined && rLtr.phone === 96 && rLtr.md === 24);
  ok('no role → no placement; unknown dir → the default corner', S.supportPlacement(null, 'rtl') === null && S.supportPlacement('admin', 'ltr') === null
    && S.supportPlacement('affiliate', undefined) === S.supportPlacement('affiliate', 'rtl') && S.supportPlacement('recruiter', undefined) === S.supportPlacement('recruiter', 'ltr'));
}

// ── 3. Static checks ──────────────────────────────────────────────────────────
console.log('\n3. Component, mounts, Homepage button');
{
  const c = strip(COMP);
  ok('client component reading usePathname + useUIControl().floatingWhatsappNumber',
    /^"use client";/.test(COMP) && /import \{ usePathname \} from "next\/navigation";/.test(c) && /import \{ useUIControl \} from "@\/hooks\/useUIControl";/.test(c)
    && /const ui = useUIControl\(\);/.test(c) && /supportWhatsappUrl\(ui\.floatingWhatsappNumber, role\)/.test(c));
  ok('renders nothing without a role, a signed-in session or a valid number',
    /if \(!role\) return null;/.test(c) && /if \(!signedIn\) return null;/.test(c) && /if \(!href\) return null;/.test(c));
  ok('affiliate session gate: hasAffiliateSession(localStorage) after mount (as AffiliateNavGate), re-checked on navigation',
    /import \{ hasAffiliateSession \} from "@\/lib\/affiliateNav";/.test(c) && /const \[affiliateSignedIn, setAffiliateSignedIn\] = useState\(false\);/.test(c)
    && /useEffect\(\(\) => \{\s*setAffiliateSignedIn\(role === "affiliate" && hasAffiliateSession\(window\.localStorage\)\);\s*\}, \[role, pathname\]\);/.test(c)
    && /hasAffiliateSession\(window\.localStorage\)/.test(strip(read('src/components/affiliate/AffiliateNavGate.jsx'))));
  const RW = strip(read('src/components/support/RecruiterWhatsAppButton.jsx'));
  ok('recruiter session gate: the shell\'s own session state (useRecruiterSession().me) via the thin RecruiterWhatsAppButton wrapper, no extra request',
    /export default function DashboardWhatsAppButton\(\{ recruiterSignedIn = false \}\)/.test(c)
    && /const signedIn = role === "affiliate" \? affiliateSignedIn : recruiterSignedIn === true;/.test(c) && !/fetch\(|\/api\//.test(c)
    && /import \{ useRecruiterSession \} from "@\/app\/recruiter\/_components\/RecruiterAppShell";/.test(RW) && /const session = useRecruiterSession\(\);/.test(RW)
    && /<DashboardWhatsAppButton recruiterSignedIn=\{!!session\?\.me\} \/>/.test(RW) && !/fetch\(|\/api\//.test(RW));
  ok('the shared button does NOT import the recruiter shell (kept out of the affiliate dashboard bundle)', !/RecruiterAppShell|useRecruiterSession/.test(c));
  {
    const shell = strip(read('src/app/recruiter/_components/RecruiterAppShell.jsx'));
    ok('…and that state exists: the shell provides { me } around its children, me only after GET /api/recruiter/me succeeded',
      /export function useRecruiterSession\(\) \{\s*return useContext\(SessionContext\);/.test(shell) && /<SessionContext\.Provider value=\{value\}>[\s\S]*\{children\}[\s\S]*<\/SessionContext\.Provider>/.test(shell)
      && /useMemo\(\(\) => \(\{ me, /.test(shell) && /if \(!aliveRef\.current \|\| !r\.ok \|\| !r\.body\?\.recruiter\) return;/.test(shell) && /if \(isPublicRecruiterPath\(pathname\)\) return children;/.test(shell));
  }
  ok('no other number source: no affiliate-support setting / whatsappSupport import, no new setting key',
    !/whatsappSupport|affiliate-support|\/api\/|fetch\(/.test(c) && !/whatsappSupport|affiliate-support|fetch\(/.test(strip(LIB)));
  const ownFiles = [COMPONENT_PATH, LIB_PATH, 'src/components/support/RecruiterWhatsAppButton.jsx', 'src/app/affiliate/layout.jsx', 'src/app/recruiter/layout.jsx', 'src/components/FloatingWhatsApp.jsx'];
  const noSvg = (f) => strip(read(f)).replace(/<path d="[^"]*"/g, '');
  ok('no hardcoded phone number (no 9+ digit literal, spaced or not) in the button / lib / layouts / Homepage button',
    ownFiles.every((f) => !/\d{9,}/.test(noSvg(f)) && !/\+?\d(?:[\s-]?\d){8,}/.test(noSvg(f))), ownFiles.filter((f) => /\d{9,}|\+?\d(?:[\s-]?\d){8,}/.test(noSvg(f))).join());
  ok('exact Arabic label, visible and the accessible name; rtl + ar on the link',
    c.includes(`const LABEL = "${LABEL}";`) && /aria-label=\{LABEL\}/.test(c) && /<span[^>]*>\{LABEL\}<\/span>/.test(c) && /dir="rtl"/.test(c) && /lang="ar"/.test(c));
  ok('opens WhatsApp in a new tab safely; data-dashboard-whatsapp={role}',
    /target="_blank"/.test(c) && /rel="noopener noreferrer"/.test(c) && /data-dashboard-whatsapp=\{role\}/.test(c));
  ok('design: WhatsApp green pill, the same WhatsApp glyph as the Homepage button',
    /bg-\[#25D366\]/.test(c) && /rounded-full/.test(c) && read('src/components/FloatingWhatsApp.jsx').match(/<path d="([^"]+)"/)[1] === COMP.match(/<path d="([^"]+)"/)?.[1]);
  ok('fixed, z between content (≤ 40) and modals / navs (≥ 50), classes from supportPlacement(role, dir)',
    /<div className=\{`fixed z-\[45\] \$\{supportPlacement\(role, dir\)\}`\}/.test(c) && /const \{ dir \} = useMarketLocale\(null\);/.test(c));
  ok('no aggressive animation (no animate-* / pulse / bounce / autoplay)', !/animate-|pulse|bounce|autoplay|setInterval/.test(c));

  const mounts = SRC.filter((f) => /<DashboardWhatsAppButton\b/.test(strip(read(f))));
  ok('shared button rendered ONLY by the affiliate layout and the recruiter wrapper', JSON.stringify(mounts.sort()) === JSON.stringify(['src/app/affiliate/layout.jsx', 'src/components/support/RecruiterWhatsAppButton.jsx']), mounts.join());
  ok('recruiter wrapper mounted ONLY by the recruiter layout', JSON.stringify(SRC.filter((f) => /<RecruiterWhatsAppButton\b/.test(strip(read(f))))) === JSON.stringify(['src/app/recruiter/layout.jsx']));
  const AFF = strip(read('src/app/affiliate/layout.jsx')), REC = strip(read('src/app/recruiter/layout.jsx'));
  ok('affiliate layout: exactly one mount, inside MarketScope', (AFF.match(/<DashboardWhatsAppButton \/>/g) || []).length === 1
    && /<MarketScope>\s*\{children\}\s*<DashboardWhatsAppButton \/>\s*<\/MarketScope>/.test(AFF)
    && /import DashboardWhatsAppButton from "@\/components\/support\/DashboardWhatsAppButton";/.test(AFF));
  ok('recruiter layout: exactly one mount, INSIDE the app shell (its session) inside MarketScope', (REC.match(/<RecruiterWhatsAppButton \/>/g) || []).length === 1
    && /<MarketScope[\s\S]*<RecruiterAppShell>\s*\{children\}\s*<RecruiterWhatsAppButton \/>\s*<\/RecruiterAppShell>\s*<\/MarketScope>/.test(REC)
    && /import RecruiterWhatsAppButton from "@\/components\/support\/RecruiterWhatsAppButton";/.test(REC) && !/DashboardWhatsAppButton/.test(REC));
  ok('not in the root layout / providers / admin', !/DashboardWhatsAppButton/.test(read('src/app/layout.jsx')) && !/DashboardWhatsAppButton/.test(read('src/app/providers.tsx'))
    && SRC.filter((f) => f.startsWith('src/app/admin/')).every((f) => !/DashboardWhatsAppButton/.test(read(f))));

  const FW = strip(read('src/components/FloatingWhatsApp.jsx'));
  const hidden = JSON.parse((FW.match(/const HIDDEN_PREFIXES = (\[[^\]]*\]);/) || [])[1] || 'null');
  ok('Homepage button hidden on /recruiter and still on its previous prefixes',
    Array.isArray(hidden) && ['/admin', '/affiliate', '/recruiter', '/login', '/checkout'].every((p) => hidden.includes(p)) && hidden.length === 5, String(hidden));
  ok('Homepage button otherwise unchanged (same setting keys, exact-or-subpath matching)',
    /pathname === p \|\| pathname\.startsWith\(`\$\{p\}\/`\)/.test(FW) && /if \(!ui\.showFloatingWhatsapp\) return null;/.test(FW)
    && /ui\.floatingWhatsappNumber/.test(FW) && /ui\.floatingWhatsappMessage/.test(FW) && /aria-label="Contact us on WhatsApp"/.test(FW));
  ok('Homepage button still mounted once globally in the root layout', (strip(read('src/app/layout.jsx')).match(/<FloatingWhatsApp \/>/g) || []).length === 1);

  const DEF = read('src/lib/ui-defaults.js');
  const keys = [...DEF.matchAll(/^\s+([A-Za-z]+):/gm)].map((m) => m[1]);
  ok('no duplicate / new setting key: ui-defaults has one floatingWhatsappNumber, no dashboard-support key',
    keys.filter((k) => k === 'floatingWhatsappNumber').length === 1 && !keys.some((k) => /dashboard|support/i.test(k)) && new Set(keys).size === keys.length);
  ok('UIControlProvider wraps every page (root providers) and loads GET /api/ui-control',
    /<UIControlProvider>/.test(read('src/app/providers.tsx')) && /<Providers>/.test(read('src/app/layout.jsx'))
    && /fetchCached\("\/api\/ui-control"\)/.test(read('src/context/UIControlContext.jsx')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
