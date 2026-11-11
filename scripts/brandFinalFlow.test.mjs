#!/usr/bin/env node
/**
 * scripts/brandFinalFlow.test.mjs — the approved final "Create Your Own Brand" affiliate flow (UI only; the backend
 * contract — the package defines its contents, POST /api/affiliate/brand/access takes no product — is pinned in the
 * service tests). Static source checks of the client components + FR/AR dictionary parity:
 *   F1  five-step progress indicator (_brand/Stepper): order, labels, current / completed states, shown on steps 1–5;
 *   F2  step 1: hero with chips, ONE pack chosen through radio cards (cover, name, category, price, short description,
 *       services), "details" opens step 2, trust strip with facts only, start button;
 *   F3  step 2: details of the chosen pack — gallery + zoom viewer (_brand/PackGallery), contents with quantities,
 *       specifications, services, price and pieces; back to change the pack / continue;
 *   F4  NO product-selection step anywhere (no state, no toggle, no product sent);
 *   F5  step 3: brand name (same validation) + automatic preview (_brand/BrandPreview), no upload, optional branding;
 *   F6  step 4: review + breakdown + terms + Buy Now (same request minus products; error routing);
 *   F7  step 5: the pending screen with the indicator on its last step;
 *   F8  accessibility / layout / direction;  F9  dictionaries.
 *
 *   node scripts/brandFinalFlow.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (f) => readFileSync(`${ROOT}${f}`, 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' ' + String(extra).slice(0, 300) : ''}`); } };
/** Drop block, JSX and line comments (not `://` in URLs). */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
/** `src` from `from` to `to` (exclusive); '' when a marker is missing, so a moved marker fails loudly instead of matching the rest of the file. */
const slice = (src, from, to) => { const i = src.indexOf(from); const j = to ? src.indexOf(to, i + from.length) : src.length; return i < 0 || j < 0 ? '' : src.slice(i, j); };

const { BRAND_TEXT, brandT } = await import(`${ROOT}src/lib/brandI18n.js`);
const TAB = read('src/app/affiliate/dashboard/BrandTab.jsx');
const STEPPER = read('src/app/affiliate/dashboard/_brand/Stepper.jsx');
const GALLERY = read('src/app/affiliate/dashboard/_brand/PackGallery.jsx');
const PREVIEW = read('src/app/affiliate/dashboard/_brand/BrandPreview.jsx');
const tab = strip(TAB), stepper = strip(STEPPER), gallery = strip(GALLERY), preview = strip(PREVIEW);
const offer = slice(tab, 'function Offer(', 'function BrandHeader(');
const screen1 = slice(offer, 'if (step === 0) {', 'data-flow-step={step + 1}');
const screenB = slice(offer, 'data-flow-step={step + 1}');
const step2 = slice(offer, '{step === 1 && pkg && (', '{step === 2 && (');
const step3 = slice(offer, '{step === 2 && (', '{step === 3 && pkg && (');
const step4 = slice(offer, '{step === 3 && pkg && (', '{step !== 3 && error');
const card = slice(tab, 'function PackCard(', 'const TRUST = [');
const pending = slice(tab, 'function PendingCard(', 'function ActiveDashboard(');

console.log('\nF1 — five-step progress indicator');
{
  const keys = [...stepper.matchAll(/\{ key: "(flow_\w+)", Icon: \w+ \}/g)].map((m) => m[1]);
  ok('Stepper lists the five steps in order', keys.join() === 'flow_pick,flow_details,flow_brand,flow_review,flow_verify', keys.join());
  ok('AR labels are the approved ones', ['اختيار الباقة المناسبة', 'تفاصيل الباقة المختارة', 'إنشاء العلامة التجارية', 'مراجعة الطلب والشراء', 'انتظار التحقق والتفعيل']
    .every((v, i) => BRAND_TEXT.ar[keys[i]] === v));
  ok('numbered circles with an icon; completed = check; current = aria-current="step" + highlight',
    /\{i \+ 1\}/.test(stepper) && /done \? <Check /.test(stepper) && /<Icon className=/.test(stepper)
    && /aria-current=\{active \? "step" : undefined\}/.test(stepper) && /ring-4 ring-violet-100/.test(stepper) && /const done = i < now;/.test(stepper));
  ok('labelled navigation + screen-reader step text ("Étape n sur 5") + done / current states',
    /<nav aria-label=\{t\("flow_aria"\)\}/.test(stepper) && /t\("step_label", \{ n: now \+ 1, total \}\)/.test(stepper) && /t\(done \? "flow_done" : "flow_current"\)/.test(stepper));
  ok('shown on steps 1–4 (Offer) and 5 (pending)', /<Stepper current=\{0\} t=\{t\} \/>/.test(screen1) && /<Stepper current=\{step\} t=\{t\} \/>/.test(screenB)
    && /<Stepper current=\{STEP_VERIFY\} t=\{t\} \/>/.test(pending) && /const STEP_VERIFY = 4;/.test(tab));
  ok('flow steps rendered in order (0 → 3)', ['if (step === 0) {', '{step === 1 && pkg && (', '{step === 2 && (', '{step === 3 && pkg && ('].map((k) => offer.indexOf(k)).every((v, i, a) => v > 0 && (i === 0 || a[i - 1] < v)));
}

console.log('\nF2 — step 1: landing + pack cards');
{
  ok('hero: gradient, title, chips (facts only), packs\' own covers', /data-hero/.test(tab) && /HERO_CHIPS\.map/.test(tab)
    && /\["hero_chip_training", GraduationCap\], \["hero_chip_sim", BarChart3\], \["hero_chip_verified", ShieldCheck\]/.test(tab));
  ok('title "choose the right pack" with an icon', /<Layers className="w-5 h-5" \/>/.test(screen1) && /t\("packages_section"\)/.test(screen1) && BRAND_TEXT.ar.packages_section === 'اختر الباقة المناسبة لك');
  ok('radio group of cards: role="radio" + aria-checked, roving tab stop, arrow keys follow the reading direction',
    /role="radiogroup" aria-labelledby="brand-packs-title"/.test(screen1) && /role="radio" aria-checked=\{on\} tabIndex=\{tabStop \? 0 : -1\}/.test(card)
    && /ArrowRight: dir === "rtl" \? -1 : 1, ArrowLeft: dir === "rtl" \? 1 : -1/.test(offer) && /radios\.current\[next\.id\]\?\.focus\(\)/.test(offer));
  ok('card: own cover, name, category, product count, pieces, price, total, 2-line description, first 3 services',
    /<PackImage src=\{packCover\(p\)\}/.test(card) && /\{p\.name\}/.test(card) && /\{p\.category\}/.test(card) && /p\.productCount/.test(card) && /p\.quantity/.test(card)
    && /\{money\(p\.price\)\}/.test(card) && /money\(p\.breakdown\.total\)/.test(card) && /line-clamp-2" data-pack-description>\{p\.description\}/.test(card)
    && /p\.features\.slice\(0, 3\)\.map/.test(card));
  ok('selected card: violet border + corner check + filled "selected ✓" button; others: outlined "details"',
    /on \? "border-violet-600/.test(card) && /\{on && <span[^>]*data-check/.test(card)
    && /on \? <><Check className="w-4 h-4" aria-hidden="true" \/>\{t\("pack_selected"\)\}/.test(card) && /: t\("package_details_show"\)\}/.test(card)
    && /"border-2 border-violet-600 text-violet-700 bg-white/.test(card));
  ok('"details" chooses the pack and opens step 2; the start button continues with the chosen pack only',
    /onClick=\{\(\) => onDetails\(p\.id\)\}/.test(card) && /onDetails=\{openDetails\}/.test(screen1)
    && /onClick=\{\(\) => \{ setError\(null\); setStep\(1\); \}\} disabled=\{!pkg\} data-start/.test(screen1));
  ok('trust strip: four facts of the offer (no invented promise)', /<TrustStrip t=\{t\} \/>/.test(screen1)
    && /\["trust_training", GraduationCap\], \["trust_payment", Landmark\], \["trust_terms", FileText\], \["trust_activation", BadgeCheck\]/.test(tab)
    && !/ضمان|garantie|guarantee|بدون مخزون|sans stock|90 ?%|الأكثر طلبا/i.test(JSON.stringify(BRAND_TEXT) + tab));
  ok('cover = gallery image (API), products\' images as fallback', /const packCover = \(p\) => p\?\.images\?\.\[0\] \|\| \(p\?\.products \|\| \[\]\)\.find\(\(pr\) => pr\.image\)\?\.image \|\| null;/.test(tab));
}

console.log('\nF3 — step 2: details of the chosen pack');
{
  // Step 2 refinement (approved): a visual showcase — large image + thumbnails of the pack cover and of the pack's own
  // products (with quantities), zoom; then compact figures (products, pieces, price + total). The long description,
  // specifications, services list, training note and simulated price are no longer repeated on this step (they stay in
  // the admin config / API and are shown on the pack card and the review).
  const items = slice(tab, 'function galleryItems(', 'function packPieces(');
  ok('gallery (large image + thumbnails) of the pack cover + the pack\'s own products, with the pack name', /<PackGallery items=\{galleryItems\(pkg\)\} name=\{pkg\.name\} t=\{t\} dir=\{dir\} \/>/.test(step2)
    && /for \(const p of products\) items\.push\(\{ key: `p-\$\{p\.id\}`, src: p\.image \|\| null, title: p\.title, quantity: p\.quantity \?\? null \}\)/.test(items)
    && /if \(cover && !productImages\.has\(cover\)\)/.test(items)
    && /list\.length > 1 && \(/.test(gallery) && /data-gallery-thumbs/.test(gallery) && /aria-current=\{i === cur \? "true" : undefined\}/.test(gallery)
    && /onClick=\{\(\) => setIndex\(i\)\}/.test(gallery) && /×\{x\.quantity\}/.test(gallery));
  ok('compact figures: product count, pieces (admin total or the sum of the products\' quantities, else hidden), price + total; no invented figure',
    /<DetailStat Icon=\{Package\} value=\{pkg\.productCount\}/.test(step2) && /packPieces\(pkg\) !== null && <DetailStat Icon=\{Boxes\}/.test(step2)
    && /money\(pkg\.price\)/.test(step2) && /money\(pkg\.breakdown\.total\)/.test(step2) && /\{pkg\.category\}/.test(step2)
    // Approved: the only earnings figures here are the ADMIN's own estimates (checked below); nothing is computed on this step.
    && !/simulatedSellingPrice|\* ?30|\/ ?30|ربح|\bgain/i.test(step2));
  // Approved: optional admin-entered estimates (daily / monthly, DH) — each shown only when configured, labelled as an
  // estimate with a short "indicative, no commitment" note; never derived, never sent with a request.
  const chip = slice(tab, 'function EstimateChip(', 'function Offer(');
  ok('estimates: admin values only, each hidden when not configured, labelled as estimates',
    /\{pkg\.estimatedDailyEarnings \? <EstimateChip Icon=\{Sun\} label=\{t\("est_daily"\)\} value=\{money\(pkg\.estimatedDailyEarnings\)\}/.test(step2)
    && /\{pkg\.estimatedMonthlyEarnings \? <EstimateChip Icon=\{CalendarDays\} label=\{t\("est_monthly"\)\} value=\{money\(pkg\.estimatedMonthlyEarnings\)\}/.test(step2)
    && /\(pkg\.estimatedDailyEarnings \|\| pkg\.estimatedMonthlyEarnings\) \?/.test(step2) && /t\("est_note"\)/.test(step2) && /<bdi/.test(chip)
    && /Estimation/.test(BRAND_TEXT.fr.est_daily) && /تقدير/.test(BRAND_TEXT.ar.est_daily) && /sans engagement/.test(BRAND_TEXT.fr.est_note) && /التزام/.test(BRAND_TEXT.ar.est_note)
    && !/estimated(Daily|Monthly)Earnings/.test(slice(tab, 'const buy = async', 'const nav =')));
  ok('the "no earnings" disclosure of the offer is kept', /aucun gain/.test(BRAND_TEXT.fr.what_no_earnings) && BRAND_TEXT.ar.what_no_earnings.length > 10);
  ok('no long text blocks on step 2 (description, specifications, services, training note, simulated price)',
    !/pkg\.description|pkg\.specifications|<ServiceList|products_training_note|simulatedSellingPrice|<ProductList/.test(step2));
  ok('back to change the pack (step 1) / continue (step 3)', /onClick=\{\(\) => \{ setError\(null\); setStep\(0\); \}\} className=\{BTN_GHOST\} data-change-pack>/.test(step2)
    && /t\("details_change"\)/.test(step2) && /onClick=\{\(\) => setStep\(2\)\}/.test(step2));
  ok('another pack keeps nothing from the previous one (consent, retry key)',
    /const pickPackage = \(id\) => \{\s*if \(id === packageId\) return;\s*setPackageId\(id\); setAccepted\(false\); requestId\.current = null;\s*\};/.test(offer));
  const viewer = slice(gallery, 'function Viewer(', 'export default function PackGallery(');
  ok('zoom viewer: dialog + aria-modal + label, rendered in a portal with the page direction', /role="dialog" aria-modal="true" aria-label=\{t\("gallery_dialog", \{ name \}\)\} dir=\{dir\}/.test(viewer) && /createPortal\(/.test(viewer));
  ok('viewer closes on ✕, Escape and a backdrop click (not on the image)', /aria-label=\{t\("gallery_close"\)\}/.test(viewer) && /e\.key === "Escape"/.test(viewer)
    && /onClick=\{\(\) => onClose\(i\)\}/.test(viewer) && /<div onClick=\{stop\}/.test(viewer));
  ok('prev / next only with several images; arrow keys + swipe follow the reading direction; RTL-aware icons',
    /\{n > 1 && \(/.test(viewer) && /e\.key === \(rtl \? "ArrowLeft" : "ArrowRight"\) \? 1 : -1/.test(viewer) && /\(x1 < x0\) !== rtl \? 1 : -1/.test(viewer)
    && /const PrevIcon = rtl \? ChevronRight : ChevronLeft;/.test(viewer) && /absolute start-2/.test(viewer) && /absolute end-2/.test(viewer));
  ok('focus: close button first, Tab kept inside, focus returned to the opener; page scroll locked',
    /closeBtn\.current\?\.focus\(\)/.test(viewer) && /e\.key === "Tab"/.test(viewer) && /opener\.focus\(\)/.test(viewer) && /document\.body\.style\.overflow = "hidden"/.test(viewer));
  ok('images: alt = the product title, else the dictionary text; failing image → package icon', /alt=\{(item|items\[i\])\.title \|\| t\("gallery_alt", \{ name, n: (i|cur) \+ 1 \}\)\}/.test(gallery) && /if \(!src \|\| failed\) return <Package/.test(gallery)
    && /aria-label=\{t\("gallery_open"\)\}/.test(gallery));
}

console.log('\nF4 — no product-selection step');
{
  ok('no selection state, toggle, count check or product step texts', !/setSelected|const toggle|countOk|products_hint|products_count|products_max_reached|t\("products_title"\)|aria-pressed=\{on\} data-product-id/.test(tab));
  ok('Buy Now sends no product', !/productIds/.test(tab) && !/products?:/.test(slice(offer, 'body: {', 'clientRequestId: requestId.current')));
  ok('removed keys are gone from both dictionaries', ['products_title', 'products_hint', 'products_count', 'products_max_reached', 'step_products', 'step_package', 'step_brand', 'step_review']
    .every((k) => !(k in BRAND_TEXT.fr) && !(k in BRAND_TEXT.ar)));
  ok('texts no longer ask to choose products', !/à choisir|للاختيار|sélectionnez ses produits|ثم منتجاتها/.test(JSON.stringify(BRAND_TEXT))
    && BRAND_TEXT.fr.package_products === '{n} produits' && BRAND_TEXT.ar.package_products === '{n} منتجات');
}

console.log('\nF5 — step 3: brand name + automatic preview');
{
  ok('same validation: server rule, bad-chars message, hint, aria-live, plaintext bidi, error cleared on typing',
    /const nameOk = nameLenOk && normalizeBrandName\(cleanName\) !== null;/.test(offer) && /nameBadChars \? t\("brand_name_bad_chars"\)/.test(step3)
    && /aria-live="polite" data-name-status/.test(step3) && /\[unicode-bidi:plaintext\]/.test(step3) && /setBrandName\(e\.target\.value\); if \(error\) setError\(null\);/.test(step3)
    && /t\("brand_name_hint", \{ min: BRAND_LIMITS\.BRAND_NAME_MIN, max: BRAND_LIMITS\.BRAND_NAME_MAX \}\)/.test(step3));
  ok('automatic preview of the typed name + pack', /<BrandPreview name=\{brandName\} packName=\{pkg\?\.name\} t=\{t\} \/>/.test(step3)
    && /Array\.from\(clean\)\[0\]\.toLocaleUpperCase\(\)/.test(preview) && /rounded-full bg-gray-950 ring-2 ring-amber-400\/70/.test(preview)
    && /\{clean \|\| t\("hero_label"\)\}/.test(preview) && /t\("preview_auto"\)/.test(preview));
  ok('no logo / image upload anywhere in the flow', !/type="file"|logo|upload/i.test(offer) && !/type="file"/.test(preview));
  ok('branding service stays optional ("none" first and by default), labelled as a platform service',
    /const \[brandingOptionId, setBrandingOptionId\] = useState\(""\);/.test(offer) && /\[\{ id: "", label: t\("branding_none"\), description: "" \}, \.\.\.data\.brandingOptions\]/.test(step3)
    && /t\("branding_optional_note"\)/.test(step3) && /role="radio" aria-checked=\{on\}/.test(step3) && /nav\(nameOk\)/.test(step3));
}

console.log('\nF6 — step 4: review and purchase');
{
  ok('review: cover, pack, category, brand, optional service, pieces, contents, services, full breakdown',
    /<PackImage src=\{packCover\(pkg\)\} alt=\{pkg\.name\}/.test(step4) && /\{cleanName\}/.test(step4) && /\{option\.label\}/.test(step4) && /\{pkg\.category\}/.test(step4)
    && /<ProductList products=\{pkg\.products\} \/>/.test(step4) && /<ServiceList items=\{pkg\.features\} t=\{t\} \/>/.test(step4) && /<Breakdown b=\{pkg\.breakdown\} t=\{t\} money=\{money\} \/>/.test(step4));
  ok('published terms + consent checkbox + Buy Now', /\{terms\.text\}/.test(step4) && /checked=\{accepted\} onChange=\{\(e\) => setAccepted\(e\.target\.checked\)\}/.test(step4)
    && /onClick=\{buy\} disabled=\{!canBuy\}/.test(step4) && /t\("terms_missing"\)/.test(step4));
  const body = slice(offer, 'body: {', '},');
  ok('request body: package, brand name, option, terms version, consent, idempotency key — nothing else',
    [...body.matchAll(/(\w+):/g)].map((m) => m[1]).join() === 'body,packageId,brandName,brandingOptionId,termsVersion,acceptTerms,clientRequestId', body);
  ok('errors: INVALID_BRAND_NAME → step 3, PACKAGE_NOT_FOUND → reload + step 1, TERMS_CHANGED → reload; no product error left',
    /if \(r\.data\?\.code === "INVALID_BRAND_NAME"\) setStep\(2\);/.test(offer) && /\["PACKAGE_NOT_FOUND", "TERMS_CHANGED"\]\.includes\(r\.data\?\.code\)/.test(offer)
    && /if \(r\.data\.code === "PACKAGE_NOT_FOUND"\) setStep\(0\);/.test(offer) && !/PRODUCT_NOT_AVAILABLE|INVALID_PRODUCT_SELECTION/.test(offer));
  ok('idempotent retry key kept; new terms version un-ticks the consent', /requestId\.current = requestId\.current \|\| newRequestId\(\);/.test(offer)
    && /useEffect\(\(\) => \{ setAccepted\(false\); \}, \[data\.terms\?\.version\]\);/.test(offer));
  ok('vanished pack after a reload → back to step 1', /if \(packageId && !packages\.some\(\(p\) => p\.id === packageId\)\) \{ setPackageId\(null\); setAccepted\(false\); setStep\(0\); \}/.test(offer));
  ok('each step starts at the top and receives the focus', /window\.scrollTo\(\{ top: 0, behavior: "smooth" \}\)/.test(offer) && /stepBox\.current\?\.focus\(\{ preventScroll: true \}\)/.test(offer));
}

console.log('\nF7 — step 5: verification and activation (pending screen)');
{
  ok('pending screen kept: header, summary, contents, saved breakdown, bank details + proof upload, cancel',
    /<BrandHeader access=\{access\}/.test(pending) && /<ProductList products=\{access\.products\} \/>/.test(pending) && /<Breakdown b=\{access\.package\.breakdown\}/.test(pending)
    && /<PaymentProof access=\{access\}/.test(pending) && /t\("cancel_request"\)/.test(pending) && /<NumTitle n=\{STEP_VERIFY \+ 1\}>\{t\("flow_verify"\)\}<\/NumTitle>/.test(pending));
  ok('pending container stays narrow; the choice gets a wider one (three cards per row on desktop)',
    /\$\{pending \? "max-w-3xl" : "max-w-5xl"\} mx-auto/.test(tab) && /sm:grid-cols-2 lg:grid-cols-3/.test(screen1) && /<div ref=\{stepBox\} tabIndex=\{-1\} className="max-w-3xl mx-auto space-y-4/.test(offer));
}

console.log('\nF8 — accessibility, layout, direction');
{
  ok('phone carousel keeps its 16 px gutter; one card at a time ≈ 80 % wide', /-mx-4 px-4 scroll-px-4 /.test(screen1) && /w-\[80%\] max-w-\[300px\]/.test(card));
  ok('tap targets ≥ 40 px (card button, viewer buttons, thumbnails, back button)', /min-h-\[44px\]/.test(card) && (gallery.match(/w-11 h-11/g) || []).length === 3
    && /w-14 h-14/.test(gallery) && /w-10 h-10 rounded-full/.test(screenB));
  ok('focus-visible rings on the new interactive elements', (gallery.match(/focus-visible:ring-2/g) || []).length >= 4 && /focus-visible:ring-2/.test(card));
  const PHYSICAL = /\b(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r)-[\w[\]]|\btext-(?:left|right)\b|space-x-/;
  ok('new components use logical (start / end) utilities only', ![stepper, gallery, preview].some((s) => PHYSICAL.test(s)));
  ok('no hard-coded Arabic in the components (texts from brandI18n)', ![tab, stepper, gallery, preview].some((s) => /[؀-ۿ]/.test(s)));
  ok('no hard-coded aria-label / alt words in the new components', ![stepper, gallery, preview].some((s) => /\b(?:aria-label|alt|title)="[^"]*[A-Za-z]{3,}/.test(s)));
}

console.log('\nF9 — dictionaries');
{
  const fr = Object.keys(BRAND_TEXT.fr).sort(), ar = Object.keys(BRAND_TEXT.ar).sort();
  ok(`FR and AR have identical keys (${fr.length})`, JSON.stringify(fr) === JSON.stringify(ar), JSON.stringify({ onlyFr: fr.filter((k) => !ar.includes(k)), onlyAr: ar.filter((k) => !fr.includes(k)) }));
  const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  ok('same {placeholders} in both languages', fr.every((k) => vars(BRAND_TEXT.fr[k]) === vars(BRAND_TEXT.ar[k])), fr.filter((k) => vars(BRAND_TEXT.fr[k]) !== vars(BRAND_TEXT.ar[k])));
  const used = [...new Set([tab, stepper, gallery, preview].flatMap((s) => [...s.matchAll(/\bt\("([a-z_]+)"/g)].map((m) => m[1])))];
  const missing = used.filter((k) => !BRAND_TEXT.fr[k] || !BRAND_TEXT.ar[k]);
  ok(`every text used by the flow exists in FR and AR (${used.length})`, missing.length === 0, missing);
  const keys = [...stepper.matchAll(/\{ key: "(flow_\w+)"/g)].map((m) => m[1]);
  ok('stepper labels exist in both languages', keys.length === 5 && keys.every((k) => BRAND_TEXT.fr[k] && BRAND_TEXT.ar[k]));
  const NEW = fr.filter((k) => /^(flow_|hero_chip_|trust_|details_|gallery_|preview_)/.test(k) || ['pack_category', 'branding_optional_note'].includes(k));
  ok(`new Arabic texts are Arabic, French texts have no Arabic (${NEW.length})`, NEW.every((k) => /[؀-ۿ]/.test(BRAND_TEXT.ar[k]) && !/[؀-ۿ]/.test(BRAND_TEXT.fr[k])));
  ok('no figure in the texts; no loanword "البراند"', !/\d/.test(JSON.stringify(BRAND_TEXT).replace(/\{\w+\}/g, '')) && !JSON.stringify(BRAND_TEXT.ar).includes('البراند'));
  ok('runtime: interpolation in both languages', brandT('ar')('details_pieces_total', { n: 50 }) === 'المجموع: 50 قطعة' && brandT('fr')('gallery_count', { n: 2, total: 5 }) === '2 sur 5'
    && brandT('ar')('package_details_show') === 'عرض التفاصيل' && brandT('ar')('start_with_pack') === 'ابدأ الآن بهذه الباقة' && brandT('ar')('pack_selected') === 'الباقة المختارة');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
