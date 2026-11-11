#!/usr/bin/env node
/**
 * scripts/brandFlowReviewFixes.test.mjs — fixes from the "Create Your Own Brand" visual review (UI only; no package,
 * price, permission, API or service change):
 *   B1  pending screen: bank card + upload box labels in the market language (the Deposit tab's texts);
 *   B2  brand name: the client applies the server's rule (normalizeBrandName) and says which rule fails; a server
 *       INVALID_BRAND_NAME sends the affiliate back to the name step;
 *   B3  typed brand name / transfer reference keep their own direction in the Arabic UI;
 *   B4  selected pack card keeps the side gutter on phones;  B5  clamped product titles never leak a 3rd line;
 *   B6/B8 names and Latin titles in the Arabic UI align with the page and are cut at their own end;
 *   B7  expense breakdown without parentheses to mis-pair in RTL;  B9  last chart label inside the chart;
 *   B11 the orders note no longer says "no amounts" above simulated amounts;  B12 dates in Morocco time.
 *
 *   node scripts/brandFlowReviewFixes.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (f) => readFileSync(`${ROOT}${f}`, 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + String(extra).slice(0, 300) : ''}`); } };

const { BRAND_TEXT } = await import(`${ROOT}src/lib/brandI18n.js`);
const { normalizeBrandName } = await import(`${ROOT}src/lib/brandProgram.js`);
const { AFFILIATE_TABS_TEXT } = await import(`${ROOT}src/lib/affiliateTabsI18n.js`);
const tab = read('src/app/affiliate/dashboard/BrandTab.jsx');
const dash = read('src/app/affiliate/dashboard/_brand/BrandDashboard.jsx');
const stats = read('src/components/brand/BrandSimStats.jsx');

console.log('\nB1 — pending screen labels');
{
  ok('bank card gets the market labels (bank, holder, account, copy, copied) + its title',
    /labels=\{\{ \.\.\.bankLabels, title: t\("proof_bank_title"\) \}\}/.test(tab)
    && ['dep_bank_name', 'dep_bank_holder', 'dep_bank_account', 'dep_copy', 'dep_copied'].every((k) => tab.includes(`dt("${k}")`)));
  ok('upload box gets the market labels (click, drag, added, processing)',
    /labels=\{\{ \.\.\.uploadLabels, title: t\("proof_title"\)/.test(tab)
    && ['dep_upload_click', 'dep_upload_drag', 'dep_upload_done', 'dep_upload_processing'].every((k) => tab.includes(`dt("${k}")`)));
  const keys = ['dep_bank_name', 'dep_bank_holder', 'dep_bank_account', 'dep_copy', 'dep_copied', 'dep_upload_click', 'dep_upload_drag', 'dep_upload_done', 'dep_upload_processing'];
  ok('those texts exist in Arabic and French', keys.every((k) => AFFILIATE_TABS_TEXT.ar[k] && AFFILIATE_TABS_TEXT.fr[k]));
  ok('the "added" badge no longer says "uploaded" before sending', AFFILIATE_TABS_TEXT.fr.dep_upload_done === 'Ajouté' && AFFILIATE_TABS_TEXT.ar.dep_upload_done === 'تمت الإضافة');
}

console.log('\nB2 — brand name validation');
{
  ok('client name check = the server rule (normalizeBrandName)', /const nameOk = nameLenOk && normalizeBrandName\(cleanName\) !== null;/.test(tab));
  ok('characters the server refuses are named, not shown as "Nom valide"', /nameBadChars \? t\("brand_name_bad_chars"\)/.test(tab)
    && BRAND_TEXT.fr.brand_name_bad_chars && BRAND_TEXT.ar.brand_name_bad_chars && !/[a-z]{4}/i.test(BRAND_TEXT.ar.brand_name_bad_chars));
  ok('server INVALID_BRAND_NAME → back to the name step (error stays visible there)',
    /if \(r\.data\?\.code === "INVALID_BRAND_NAME"\) setStep\(2\);/.test(tab) && /\{step !== 3 && error && <p role="alert"/.test(tab));
  ok('the rule itself is unchanged: "Atlas@Tech" refused, "Atlas Tech", "Dar L\'Argan" and an Arabic name accepted',
    normalizeBrandName('Atlas@Tech') === null && normalizeBrandName('Atlas Tech') === 'Atlas Tech'
    && normalizeBrandName("Dar L'Argan") === "Dar L'Argan" && normalizeBrandName('دار الأركان') === 'دار الأركان');
}

console.log('\nB3–B9, B11, B12 — layout and wording');
{
  ok('B3 name + reference inputs use unicode-bidi: plaintext', (tab.match(/\[unicode-bidi:plaintext\]/g) || []).length === 2);
  ok('B4 pack carousel keeps a 16 px scroll gutter on phones', /-mx-4 px-4 scroll-px-4 /.test(tab));
  // Approved final design: no product-selection step — only the read-only ProductList renders clamped product titles now (was 2).
  ok('B5 clamped titles: clamp on an inner span, padding on the outer box', (tab.match(/<span dir="auto" className="line-clamp-2">\{p\.title\}<\/span><\/p>/g) || []).length === 1
    && !/py-1\.5 [^"]*line-clamp-2/.test(tab) && !/py-2 [^"`]*line-clamp-2/.test(tab));
  ok('B6/B8 names and order titles isolated and cut at their own end', /const ISO_TRUNC = "inline-block max-w-full truncate align-top";/.test(tab)
    && (tab.match(/<bdi dir="auto" className=\{ISO_TRUNC\}>/g) || []).length === 2
    && (dash.match(/<bdi dir="auto" className="inline-block max-w-full truncate align-top">/g) || []).length === 4
    && !/truncate min-w-0"><bdi>\{o\.product/.test(dash));
  ok('B7 expense breakdown: own line, no parentheses, each item isolated', /data-exp-breakdown/.test(dash) && !/<span className="text-gray-400"> \(\{d\("fin_exp_delivery"\)\}/.test(dash));
  ok('B9 last x-axis label anchored at its end', /textAnchor=\{pts\[i\]\[0\] > W - P\.r - 14 \? "end" : "middle"\}/.test(stats));
  ok('B11 orders note: no "aucun montant" / "ولا مبالغ" above simulated amounts, still says no real customers',
    !/aucun montant/.test(BRAND_TEXT.fr.recent_note) && !/ولا مبالغ/.test(BRAND_TEXT.ar.recent_note)
    && /aucun client réel/.test(BRAND_TEXT.fr.recent_note) && /لا زبائن حقيقيون/.test(BRAND_TEXT.ar.recent_note));
  ok('B12 activation / closure dates in Morocco time like the order times', /timeStyle: "short", timeZone: "Africa\/Casablanca" \}\) : "—"\);/.test(tab));
}

console.log('\nWording consistency');
{
  ok('AR create title says "علامتك التجارية", not the loanword "البراند"', BRAND_TEXT.ar.create_title === 'تفاصيل إنشاء علامتك التجارية' && !JSON.stringify(BRAND_TEXT.ar).includes('البراند'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
