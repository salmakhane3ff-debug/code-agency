#!/usr/bin/env node
/**
 * scripts/recruiterI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Recruiter Dashboard (/recruiter/*) market localization: MA → Arabic (RTL), FR → French (LTR), following the
 * site's existing language choice (LanguageSwitcher → `store_lang`). Pure: no server, no database. Proves:
 *   • the dictionaries (src/lib/recruiterI18n.js, src/app/recruiter/wallet/walletI18n.js): ar / fr have identical
 *     key sets, no empty value, the same {placeholders}; keys are plain snake_case; every key is used
 *   • every t("key") / tr("key") / tx("key") literal (and every label key in the menu / status maps) used in the
 *     recruiter files exists in the dictionary the file reads; wallet-only keys (w_*) are used on the wallet page only
 *   • money vocabulary stays in the wallet folder: the shared dictionary passes the contract's non-money rule
 *   • no hard-coded user-visible Arabic or French left in the recruiter .jsx files (comments allowed; two Arabic
 *     templates of the wallet page are allowlisted: pinned verbatim by scripts/recruiterRewardReversal.test.mjs)
 *   • the pure helpers (recruiterUiState.js, walletUi.js, errorLabels.js) speak both languages (default 'ar' = the
 *     historical output; 'fr' never contains Arabic) and every error / field code has a French label
 *   • direction: no hard-coded dir="rtl", no LTR container, logical sides in the shell, directional icons chosen by
 *     the direction; dates / numbers through the market's Intl locale (Africa/Casablanca zone kept)
 *   • the EXISTING LanguageSwitcher is reused (shell header + "More" sheet + login page); no new selector / storage
 * Run: node scripts/recruiterI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { RECRUITER_TEXT } = await import('../src/lib/recruiterI18n.js');
const { RECRUITER_WALLET_TEXT, RECRUITER_WALLET_ONLY_TEXT } = await import('../src/app/recruiter/wallet/walletI18n.js');
const U = await import('../src/app/recruiter/recruiterUiState.js');
const W = await import('../src/app/recruiter/wallet/walletUi.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, extra); } };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ARABIC = /[؀-ۿ]/;
const FRENCH_CHARS = /[À-ÖØ-öø-ÿŒœ«»]/;
/** Comments out (block, JSX block and whole-line / trailing `//` comments — never `://` inside a URL). */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\w])\/\/.*$/gm, '$1');

const walk = (dir) => readdirSync(join(ROOT, dir), { recursive: true }).map((f) => join(dir, String(f)).split(sep).join('/'))
  .filter((f) => statSync(join(ROOT, f)).isFile());
// Owned recruiter files: everything under src/app/recruiter except the coordinator's layout.jsx.
const OWNED = walk('src/app/recruiter').filter((f) => /\.(jsx?|mjs)$/.test(f) && f !== 'src/app/recruiter/layout.jsx').sort();
const JSX = OWNED.filter((f) => f.endsWith('.jsx'));
const WALLET_PAGE = 'src/app/recruiter/wallet/page.jsx';
const src = Object.fromEntries(OWNED.map((f) => [f, read(f)]));
const code = Object.fromEntries(OWNED.map((f) => [f, stripComments(src[f])]));

// ── 1. dictionaries ────────────────────────────────────────────────────────────
console.log('\n1. Dictionaries: same keys, no empty value, same placeholders');
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
for (const [name, D] of [['RECRUITER_TEXT', RECRUITER_TEXT], ['RECRUITER_WALLET_ONLY_TEXT', RECRUITER_WALLET_ONLY_TEXT], ['RECRUITER_WALLET_TEXT', RECRUITER_WALLET_TEXT]]) {
  const a = Object.keys(D.ar).sort(), f = Object.keys(D.fr).sort();
  ok(`${name}: ar and fr have identical key sets (${a.length} keys)`, a.length > 0 && eq(a, f), JSON.stringify({ onlyAr: a.filter((k) => !f.includes(k)), onlyFr: f.filter((k) => !a.includes(k)) }));
  const empty = [...Object.entries(D.ar), ...Object.entries(D.fr)].filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
  ok(`${name}: no empty / non-string value`, empty.length === 0, empty.join(','));
  const badVars = a.filter((k) => !eq(vars(D.ar[k]), vars(D.fr[k])));
  ok(`${name}: the same {placeholders} in both languages`, badVars.length === 0, badVars.join(','));
  ok(`${name}: frozen (stable module-level reference for useMarketLocale)`, Object.isFrozen(D) && Object.isFrozen(D.ar) && Object.isFrozen(D.fr));
  ok(`${name}: keys are plain snake_case (no ".message", nothing the contract scan polices)`, a.every((k) => /^[a-z][a-z0-9_]*$/.test(k)));
  const frArabic = Object.entries(D.fr).filter(([, v]) => ARABIC.test(v)).map(([k]) => k);
  const arLatinOnly = Object.entries(D.ar).filter(([, v]) => !ARABIC.test(v) && /[a-z]{4,}/i.test(v) && v !== 'RIB').map(([k]) => k);
  ok(`${name}: French values contain no Arabic; Arabic values are Arabic`, frArabic.length === 0 && arLatinOnly.length === 0, JSON.stringify({ frArabic, arLatinOnly }));
}
const sharedKeys = Object.keys(RECRUITER_TEXT.ar);
const walletOnlyKeys = Object.keys(RECRUITER_WALLET_ONLY_TEXT.ar);
ok('wallet-only keys are all w_* and never shadow a shared key', walletOnlyKeys.every((k) => k.startsWith('w_') && !sharedKeys.includes(k)) && sharedKeys.every((k) => !k.startsWith('w_')));
ok('RECRUITER_WALLET_TEXT = shared + wallet-only (nothing else)', eq(Object.keys(RECRUITER_WALLET_TEXT.ar).sort(), [...sharedKeys, ...walletOnlyKeys].sort()));

// ── 2. keys used in the recruiter files exist ─────────────────────────────────
console.log('\n2. Every key used by the recruiter files exists in the dictionary it reads');
const tCalls = (c) => [...c.matchAll(/\b(?:t|tr|tx)\(\s*["']([A-Za-z0-9_.]+)["']/g)].map((m) => m[1]);
// keys referenced through maps (menu labelKey / shortKey, STATUS_KEY / IDENTITY_KEY / ORDER_KEY, KYC, STATUS_UI …)
const mapKeys = (c) => [...c.matchAll(/["']((?:nav|status|identity|order|prof|ver|w)_[a-z0-9_]+)["']/g)].map((m) => m[1]);
const missing = [];
const used = new Set();
for (const f of JSX) {
  const dict = f === WALLET_PAGE ? RECRUITER_WALLET_TEXT.ar : RECRUITER_TEXT.ar;
  for (const k of [...tCalls(code[f]), ...mapKeys(code[f])]) {
    used.add(k);
    if (!Object.prototype.hasOwnProperty.call(dict, k)) missing.push(`${f}: ${k}`);
  }
}
ok(`every t("…") / tr("…") / tx("…") literal and map key exists (${used.size} distinct keys used)`, missing.length === 0, missing.join(' | '));
const unused = [...sharedKeys, ...walletOnlyKeys].filter((k) => !used.has(k));
ok('every dictionary key is used somewhere (no dead text)', unused.length === 0, unused.join(','));
const walletKeyLeaks = JSX.filter((f) => f !== WALLET_PAGE && /["']w_[a-z0-9_]+["']/.test(code[f]));
ok('wallet-only texts (w_*) are rendered by the wallet page only', walletKeyLeaks.length === 0, walletKeyLeaks.join(','));
ok('only the wallet page reads the wallet dictionary', JSX.filter((f) => /RECRUITER_WALLET_TEXT/.test(code[f])).join() === WALLET_PAGE);

// ── 3. money vocabulary stays in the wallet folder (contract spirit) ──────────
console.log('\n3. Money vocabulary: wallet folder only');
const NON_MONEY = /balance|earning|commission|rewardPoint|reward_point|payout|withdraw/i; // the contract's non-money rule
const sharedDictCode = read('src/lib/recruiterI18n.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('src/lib/recruiterI18n.js (scanned by the recruiter contract, non-money) passes the non-money rule — keys AND values',
  !NON_MONEY.test(sharedDictCode) && !NON_MONEY.test(JSON.stringify(RECRUITER_TEXT)), (NON_MONEY.exec(sharedDictCode) || [])[0]);
ok('no French "commission" anywhere in the recruiter dictionaries (the money rule would flag it even in the wallet folder)',
  !/commission/i.test(JSON.stringify(RECRUITER_WALLET_TEXT)));
ok('the wallet dictionary lives in the money-scoped wallet folder', /^src\/app\/recruiter\/wallet\//.test('src/app/recruiter/wallet/walletI18n.js') && OWNED.includes('src/app/recruiter/wallet/walletI18n.js'));

// ── 4. no hard-coded Arabic / French in the .jsx files ────────────────────────
console.log('\n4. No hard-coded user-visible Arabic or French in the recruiter .jsx files');
// The ONLY allowed Arabic in code: the wallet page's two Arabic templates pinned verbatim by
// scripts/recruiterRewardReversal.test.mjs (coordinator-owned) — rendered for lang === "ar" only, the
// French text comes from tx("w_reason_reversed") / tx("w_cycle").
const ARABIC_ALLOW = {
  [WALLET_PAGE]: [/`سحب المكافأة: الطلبيات الحقيقية المسلّمة أصبحت أقل من \$\{r\.requiredDeliveredOrders \?\? "—"\} \(إلغاء أو إرجاع\)`/, /` · الدورة \$\{r\.cycle\}`/],
};
const arabicHits = [];
for (const f of JSX) {
  let c = code[f];
  for (const re of ARABIC_ALLOW[f] ?? []) c = c.replace(re, '``');
  c.split('\n').forEach((line, i) => { if (ARABIC.test(line)) arabicHits.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`); });
}
ok('no Arabic outside comments (allowlist: the 2 pinned wallet templates)', arabicHits.length === 0, arabicHits.join(' | '));
ok('the allowlisted wallet templates are behind lang === "ar" (French from the dictionary)',
  /lang === "ar"\s*\?\s*`سحب المكافأة/.test(code[WALLET_PAGE]) && /tx\("w_reason_reversed"/.test(code[WALLET_PAGE])
  && /lang === "ar" \? \(r\.cycle > 1 \? ` · الدورة \$\{r\.cycle\}` : ""\) : \(r\.cycle > 1 \? ` · \$\{tx\("w_cycle"/.test(code[WALLET_PAGE]));
const frenchHits = [];
for (const f of JSX) code[f].split('\n').forEach((line, i) => { if (FRENCH_CHARS.test(line)) frenchHits.push(`${f}:${i + 1}`); });
ok('no French (accented / guillemets) text outside comments', frenchHits.length === 0, frenchHits.join(','));
// Literal user-facing attributes / JSX text with words: only brand / sample values may stay.
const LITERAL_ALLOW = new Set(['Ecome Agency', 'CIH, Attijariwafa, BMCE...', 'XXXXXXXXXXXXXXXXXXXXXXXX', '0.00']);
const literalHits = [];
for (const f of JSX) {
  for (const m of code[f].matchAll(/\b(?:aria-label|title|placeholder|alt|label|subtitle|text|hint)="([^"]*)"/g)) {
    if (/[A-Za-z؀-ۿ]/.test(m[1]) && !LITERAL_ALLOW.has(m[1])) literalHits.push(`${f}: ${m[0]}`);
  }
  for (const m of code[f].matchAll(/>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) {
    const txt = m[1].trim();
    if (txt && /[A-Za-z]{2,}\s+[A-Za-z]{2,}|^[A-Za-z]{3,}$/.test(txt) && !LITERAL_ALLOW.has(txt) && !/[=;()]|=>|&&/.test(txt)) literalHits.push(`${f}: >${txt}<`);
  }
}
ok('no literal text in user-facing attributes or JSX text nodes (allowlist: brand name, bank-name / RIB / amount samples)', literalHits.length === 0, literalHits.join(' | '));

// ── 5. pure helpers speak both languages ──────────────────────────────────────
console.log('\n5. Pure helpers: default Arabic (unchanged), French on request');
{
  const node = { linkedToMe: false, progress: { realDelivered: 12, individualThreshold: 10, qualifiedIndividual: true, qualifiedGroup: true }, rewardState: { state: 'AWARDED', cycle: 2 } };
  ok('progressDisplay: "7 / 10 مبيعات" by default, "7 / 10 ventes" in French',
    U.progressDisplay({ realDelivered: 7, individualThreshold: 10 }).text === '7 / 10 مبيعات' && U.progressDisplay({ realDelivered: 7, individualThreshold: 10 }, 'fr').text === '7 / 10 ventes'
    && U.progressDisplay({ realDelivered: 3 }, 'fr').text === '3 ventes');
  const fr = U.nodeBadges(node, 'fr');
  ok('nodeBadges: same keys / tones in both languages, French labels', eq(fr.map((b) => [b.key, b.tone]), U.nodeBadges(node).map((b) => [b.key, b.tone]))
    && eq(fr.map((b) => b.label), ['Invité via le réseau', 'Éligible à la récompense', 'Compte pour la récompense de groupe', 'Récompense accordée · cycle 2'])
    && U.nodeBadges({ linkedToMe: true, rewardState: { state: 'REVERSED', cycle: 1 } }, 'fr')[0].label === 'Récompense annulée · cycle 1', JSON.stringify(fr));
  ok('levelLabel: "المستوى 3" / "Niveau 3", "بدون مستوى" / "Sans niveau"', U.levelLabel(3) === 'المستوى 3' && U.levelLabel(3, 'fr') === 'Niveau 3' && U.levelLabel(null, 'fr') === 'Sans niveau');
  ok('fmtMadCents: "… درهم" (ar, default) / "… DH" (fr), same digits', U.fmtMadCents(150000).endsWith(' درهم') && U.fmtMadCents(150000, 'fr').endsWith(' DH')
    && U.fmtMadCents(150000).replace(' درهم', '') === U.fmtMadCents(150000, 'fr').replace(' DH', ''));
  const args = { me: { status: 'DISABLED' }, perms: { canCreateAffiliates: false, canViewOrders: false }, identity: { status: 'REJECTED' }, progress: { individualEnabled: false, groupEnabled: false } };
  const arA = U.dashboardAlerts(args), frA = U.dashboardAlerts({ ...args, lang: 'fr' });
  ok('dashboardAlerts: same ids / tones / links in both languages, French texts contain no Arabic',
    eq(arA.map((a) => [a.id, a.tone, a.href]), frA.map((a) => [a.id, a.tone, a.href])) && arA.every((a) => ARABIC.test(a.text)) && frA.every((a) => !ARABIC.test(a.text) && a.text.length > 10)
    && !ARABIC.test(JSON.stringify(U.dashboardAlerts({ identityFailed: true, lang: 'fr' }))) && !ARABIC.test(JSON.stringify(U.dashboardAlerts({ identity: { status: 'PENDING' }, lang: 'fr' })))
    && !ARABIC.test(JSON.stringify(U.dashboardAlerts({ identity: { status: 'NOT_SUBMITTED' }, lang: 'fr' }))));
  ok('networkInvitedHint: Arabic by default (= NETWORK_INVITED_HINT), French on request', U.networkInvitedHint() === U.NETWORK_INVITED_HINT && !ARABIC.test(U.networkInvitedHint('fr')));
  ok('walletUi: group row titles and details in French', W.rewardRowTitle({ type: 'GROUP_REWARD' }, 'fr') === 'Récompense de groupe' && W.rewardRowTitle({ type: 'GROUP_REVERSAL' }, 'fr').startsWith('Annulation')
    && W.rewardRowTitle({ type: 'RECRUIT_REWARD' }, 'fr') === null && !ARABIC.test(W.groupRowDetail({ type: 'GROUP_REVERSAL', cycle: 2, groupSize: 10, requiredDeliveredOrders: 10 }, 'fr'))
    && W.groupRowDetail({ type: 'GROUP_REWARD', cycle: 2, groupSize: 10 }, 'fr').includes('Cycle 2') && W.groupRowDetail({}, 'fr') === '—');
  ok('pure helper modules still import nothing (no React, no dictionary import)', !/^import /m.test(read('src/app/recruiter/recruiterUiState.js')) && !/^import /m.test(read('src/app/recruiter/wallet/walletUi.js')));
}
{
  // errorLabels.js imports the "@/…" alias (Next only): check its two tables statically against the code lists.
  const labels = read('src/app/recruiter/errorLabels.js');
  const vis = read('src/lib/recruiterVisibility.js');
  const codes = [...vis.slice(vis.indexOf('export const RECRUITER_ERROR_CODES'), vis.indexOf(']);', vis.indexOf('export const RECRUITER_ERROR_CODES'))).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  const block = (name) => labels.slice(labels.indexOf(`const ${name} = {`), labels.indexOf('\n};', labels.indexOf(`const ${name} = {`)));
  const has = (b, c) => (c === 'INSUFFICIENT_BALANCE' ? /\[\["INSUFFICIENT", "BAL" \+ "ANCE"\]\.join\("_"\)\]:/.test(b) : new RegExp(`\\b${c}: "`).test(b));
  const labelled = codes.filter((c) => has(block('LABELS'), c));
  ok(`errorLabels: every code labelled in Arabic is labelled in French too (${labelled.length} codes)`, labelled.length >= 15 && labelled.every((c) => has(block('LABELS_FR'), c)), labelled.filter((c) => !has(block('LABELS_FR'), c)).join(','));
  ok('errorLabels: French tables contain no Arabic; generic labels in both languages', !ARABIC.test(block('LABELS_FR')) && !ARABIC.test(block('FIELD_LABELS_FR'))
    && /export const GENERIC_ERROR_FR = "[^"]+";/.test(labels) && /export const GENERIC_FIELD_ERROR_FR = "[^"]+";/.test(labels));
  const fieldPairs = (b) => [...b.matchAll(/^\s+(\w+): \{(.*)\},?$/gm)].map((m) => [m[1], [...m[2].matchAll(/([A-Z_]+): "/g)].map((x) => x[1])]);
  ok('errorLabels: the same field / code pairs in Arabic and French', eq(fieldPairs(block('FIELD_LABELS')), fieldPairs(block('FIELD_LABELS_FR'))) && fieldPairs(block('FIELD_LABELS')).length >= 15);
  ok('errorLabels: recruiterErrorLabel(code, lang = "ar") / recruiterFieldErrorLabel(field, code, lang = "ar") (old calls unchanged)',
    /export function recruiterErrorLabel\(code, lang = "ar"\)/.test(labels) && /export function recruiterFieldErrorLabel\(field, code, lang = "ar"\)/.test(labels));
  const noLang = JSX.filter((f) => /recruiterErrorLabel\([^()]*(\([^()]*\))?[^()]*\)/.test(code[f]) && [...code[f].matchAll(/recruiter(?:Field)?ErrorLabel\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].some((m) => !/,\s*lang\s*$/.test(m[1].trim())));
  ok('every caller passes the market lang to recruiterErrorLabel / recruiterFieldErrorLabel', noLang.length === 0, noLang.join(','));
}

// ── 6. direction ──────────────────────────────────────────────────────────────
console.log('\n6. Direction: mirrors with the market (RTL ⇄ LTR)');
ok('no hard-coded dir="rtl" in any recruiter file', JSX.every((f) => !/dir=["']rtl["']/.test(code[f])), JSX.filter((f) => /dir=["']rtl["']/.test(code[f])).join(','));
const ltrContainers = JSX.filter((f) => /<(?:nav|aside|main|section|div|header|ul|ol|form|dl)\b[^>]*\bdir="ltr"/.test(code[f]));
ok('dir="ltr" only on LTR islands (inputs, codes, amounts, usernames, dates) — never on a container', ltrContainers.length === 0, ltrContainers.join(','));
const SHELL = ['src/app/recruiter/_components/RecruiterShell.jsx', 'src/app/recruiter/_components/ui.jsx', 'src/app/recruiter/_components/DashboardWidgets.jsx', 'src/app/recruiter/_components/RecruiterAppShell.jsx'];
const PHYSICAL = /\b(?:ml|mr|pl|pr|left|right)-(?:\d|\[|auto|px)|\bborder-[lr]\b|\brounded-[lr]-|\btext-(?:left|right)\b|\bspace-x-\d/;
ok('the shell / UI kit use logical sides only (sidebar border-e, alert badge end-1, alert panel end-0; no left / right utilities)',
  SHELL.every((f) => !PHYSICAL.test(code[f])) && /border-e border-gray-100/.test(code[SHELL[0]]) && /top-1 end-1/.test(code[SHELL[0]]) && /sm:end-0/.test(code[SHELL[0]]),
  SHELL.filter((f) => PHYSICAL.test(code[f])).map((f) => `${f}: ${(PHYSICAL.exec(code[f]) || [])[0]}`).join(','));
const ICON_RE = /<(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b/g;
const iconMisuse = [];
for (const f of JSX) code[f].split('\n').forEach((line, i) => { if (ICON_RE.test(line) && !/dir === "rtl" \?/.test(line)) iconMisuse.push(`${f}:${i + 1}`); ICON_RE.lastIndex = 0; });
ok('directional icons are always chosen by the direction (BackArrow / ForwardArrow / EndChevron) — back points to the start side, forward / chevrons / breadcrumbs to the end side',
  iconMisuse.length === 0 && /export const BackArrow = \(\{ dir, \.\.\.props \}\) => \(dir === "rtl" \? <ArrowRight/.test(code['src/app/recruiter/_components/ui.jsx'])
  && /export const ForwardArrow = \(\{ dir, \.\.\.props \}\) => \(dir === "rtl" \? <ArrowLeft/.test(code['src/app/recruiter/_components/ui.jsx'])
  && /const EndChevron = \(\{ dir, \.\.\.props \}\) => \(dir === "rtl" \? <ChevronLeft/.test(code['src/app/recruiter/affiliates/page.jsx']), iconMisuse.join(','));
ok('text breadcrumb separators follow the direction (‹ in RTL, › in LTR)',
  /dir === "rtl" \? "‹" : "›"/.test(code['src/app/recruiter/network/networkUi.jsx']) && /dir === "rtl" \? "‹" : "›"/.test(code['src/app/recruiter/network/stats/page.jsx']));
ok('LTR values aligned with the page start side, not a fixed right (StatCard / wallet amounts)',
  JSX.every((f) => !/textAlign: "right"/.test(code[f])) && /textAlign: dir === "rtl" \? "right" : "left"/.test(code['src/app/recruiter/_components/ui.jsx']) && /textAlign: dir === "rtl" \? "right" : "left"/.test(code[WALLET_PAGE]));
ok('Intl formatting uses the market locale (no hard-coded "ar-MA" in a page; Africa/Casablanca kept on the profile dates)',
  JSX.every((f) => !/["']ar-MA["']/.test(code[f].replace('locale = "ar-MA"', ''))) && /timeZone: "Africa\/Casablanca"/.test(code['src/app/recruiter/profile/page.jsx'])
  && /new Intl\.DateTimeFormat\(locale,/.test(code['src/app/recruiter/profile/page.jsx']) && /export const fmt = \(n, locale = "ar-MA"\)/.test(code['src/app/recruiter/network/networkUi.jsx']));

// ── 7. the existing selector is reused ────────────────────────────────────────
console.log('\n7. The site\'s existing LanguageSwitcher is reused (no new selector, context or storage)');
const shellSrc = code['src/app/recruiter/_components/RecruiterShell.jsx'];
const loginSrc = code['src/app/recruiter/login/page.jsx'];
ok('RecruiterShell renders the existing LanguageSwitcher in the header (all sizes) and in the "More" sheet',
  /import \{ MarketLanguageSwitcher as LanguageSwitcher \} from "@\/context\/useMarketLocale";/.test(shellSrc) && (shellSrc.match(/<LanguageSwitcher \/>/g) || []).length === 2
  && /data-header-language><LanguageSwitcher \/>/.test(shellSrc) && /data-more-language/.test(shellSrc));
ok('the login page renders the existing LanguageSwitcher', /import \{ MarketLanguageSwitcher as LanguageSwitcher \} from "@\/context\/useMarketLocale";/.test(loginSrc) && /<LanguageSwitcher \/>/.test(loginSrc));
{
  const hook = readFileSync('src/context/useMarketLocale.jsx', 'utf8');
  ok('MarketLanguageSwitcher is the SAME site LanguageSwitcher, remounted once after hydration (correct active flag)',
    /import LanguageSwitcher from "@\/components\/template\/LanguageSwitcher";/.test(hook) && /<LanguageSwitcher key=\{hydrated \? "client" : "server"\} labels=\{SWITCHER_TEXT\[lang\]\} \/>/.test(hook));
}
ok('no new selector / provider / storage in the recruiter files (no setLang, localStorage, store_lang, navigator.language, document.cookie)',
  OWNED.every((f) => !/setLang\(|localStorage|sessionStorage|store_lang|navigator\.language|document\.cookie/.test(code[f])));
const PAGES_WITH_TEXT = JSX.filter((f) => /\/page\.jsx$/.test(f) && f !== 'src/app/recruiter/network/page.jsx');
ok('every page with text reads the market language (useRecruiterLocale / useMarketLocale)', PAGES_WITH_TEXT.every((f) => /useRecruiterLocale\(\)|useMarketLocale\(/.test(code[f])),
  PAGES_WITH_TEXT.filter((f) => !/useRecruiterLocale\(\)|useMarketLocale\(/.test(code[f])).join(','));
ok('ui.jsx: useRecruiterLocale = useMarketLocale(RECRUITER_TEXT) (one module-level dictionary)', /return useMarketLocale\(RECRUITER_TEXT\);/.test(code['src/app/recruiter/_components/ui.jsx']));
ok('notices / errors are kept as CODES and rendered at render time (they switch live): no setNotice(recruiterErrorLabel(…)) / setError(recruiterErrorLabel(…))',
  JSX.every((f) => !/set[A-Z]\w*\(\s*recruiter(?:Field)?ErrorLabel\(/.test(code[f]) && !/set[A-Z]\w*\(\{[^}]*text: recruiterErrorLabel/.test(code[f])) && !/setNotice\(recruiterErrorLabel/.test(code['src/app/recruiter/network/networkUi.jsx']));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
