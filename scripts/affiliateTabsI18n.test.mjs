#!/usr/bin/env node
/**
 * scripts/affiliateTabsI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Market localization (MA → Arabic / RTL, FR → French / LTR) of the affiliate
 * dashboard tabs (UGC, Starter Booster, deposit / top-up), the payment-proofs
 * slider and the affiliate login / activation / activation-recovery pages.
 * Proves (static + pure runtime, no server, no DOM):
 *   • src/lib/affiliateTabsI18n.js: ar / fr have identical keys, no empty value,
 *     the same {placeholders} in both languages, and every key is used
 *   • every t("key") / dictionary-key literal used by the owned files exists
 *   • the owned .jsx files carry no hard-coded Arabic / French UI text outside
 *     the dictionary (comments allowed; allowlist below, with reasons)
 *   • no pinned dir="rtl"; dir="ltr" only as deliberate islands
 *   • the language comes from the market hook (useMarketLocale); directional
 *     icons follow `dir`; the booster timeline and the UGC tab use logical sides
 *   • activation / recovery keep their code / query handling and payloads
 *   • brand tabs (already on brandI18n) stay free of hard-coded Arabic
 * Run: node scripts/affiliateTabsI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { AFFILIATE_TABS_TEXT, fillParts } from "../src/lib/affiliateTabsI18n.js";
import { makeMarketT } from "../src/lib/marketLocale.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS ", name); }
  else { fail++; console.log("  FAIL ", name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ""); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** Drop block comments, JSX comments and line comments (not `video/*` in accept="…", not `://` in URLs). */
const stripComments = (s) => s.replace(/(^|[^\w"'/])\/\*[\s\S]*?\*\//g, "$1").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const OWNED = {
  ugc: "src/app/affiliate/dashboard/UgcTab.jsx",
  booster: "src/app/affiliate/dashboard/BoosterTab.jsx",
  deposit: "src/app/affiliate/dashboard/DepositTab.jsx",
  slider: "src/components/affiliate/PaymentProofsSlider.jsx",
  login: "src/app/affiliate/login/page.jsx",
  activate: "src/app/affiliate/activate/page.jsx",
  recovery: "src/app/affiliate/activate/recovery/page.jsx",
};
const BRAND = [
  "src/app/affiliate/dashboard/BrandTab.jsx",
  "src/app/affiliate/dashboard/_brand/BrandDashboard.jsx",
  "src/app/affiliate/dashboard/RewardsTab.jsx",
  "src/components/brand/BrandSimStats.jsx",
];
const SRC = Object.fromEntries(Object.entries(OWNED).map(([k, p]) => [k, read(p)]));
const CODE = Object.fromEntries(Object.entries(SRC).map(([k, s]) => [k, stripComments(s)]));

// ── 1. Dictionary ─────────────────────────────────────────────────────────────
console.log("\n1. Dictionary (src/lib/affiliateTabsI18n.js)");
const { ar, fr } = AFFILIATE_TABS_TEXT;
const arKeys = Object.keys(ar).sort(), frKeys = Object.keys(fr).sort();
ok(`ar and fr have identical keys (${frKeys.length})`, JSON.stringify(arKeys) === JSON.stringify(frKeys),
  { onlyFr: frKeys.filter((k) => !(k in ar)), onlyAr: arKeys.filter((k) => !(k in fr)) });
const empty = [...Object.entries(ar), ...Object.entries(fr)].filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => k);
ok("no empty or non-string value", empty.length === 0, empty);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const varMismatch = frKeys.filter((k) => k in ar && vars(fr[k]) !== vars(ar[k]));
ok("every key has the same {placeholders} in ar and fr", varMismatch.length === 0, varMismatch);
ok("dictionary is frozen (stable reference for useMarketLocale)", Object.isFrozen(AFFILIATE_TABS_TEXT) && Object.isFrozen(ar) && Object.isFrozen(fr));
const frArabic = frKeys.filter((k) => /[؀-ۿ]/.test(fr[k]));
ok("French texts contain no Arabic", frArabic.length === 0, frArabic);
const ALLOWED_LATIN_IN_AR = /^(bst_title|bst_soon_title|ugc_size_mb|ugc_size_kb|dep_upload_drag|dep_err_format|login_username_placeholder)$/;
const arNoArabic = arKeys.filter((k) => !/[؀-ۿ]/.test(ar[k]) && !ALLOWED_LATIN_IN_AR.test(k));
ok("Arabic texts are Arabic (except product names / file formats / symbols)", arNoArabic.length === 0, arNoArabic);
ok("currency follows the site rule everywhere: Arabic درهم, French DH",
  ar.bst_currency === "درهم" && fr.bst_currency === "DH" && ar.ugc_currency === "درهم" && fr.ugc_currency === "DH"
  && ar.dep_currency === "درهم" && fr.dep_currency === "DH" && ar.proofs_currency === "درهم" && fr.proofs_currency === "DH"
  && !Object.values(fr).some((v) => /\bMAD\b/.test(v)) && !Object.values(ar).some((v) => /\bMAD\b/.test(v)));

// ── 2. Runtime translator + fillParts ─────────────────────────────────────────
console.log("\n2. Runtime");
const tAr = makeMarketT(AFFILIATE_TABS_TEXT, "ar"), tFr = makeMarketT(AFFILIATE_TABS_TEXT, "fr");
ok("t interpolates in both languages", tFr("ugc_sales_today", { n: 3 }) === "3 ventes aujourd'hui" && tAr("ugc_sales_today", { n: 3 }) === "3 مبيعات اليوم");
ok("unknown market language falls back to Arabic (site default)", makeMarketT(AFFILIATE_TABS_TEXT, "xx")("login_submit") === ar.login_submit);
const node = { type: "strong" };
const parts = fillParts(fr.ugc_how_body, { amount: node });
ok("fillParts keeps the sentence and drops the node in place", parts.length === 3 && parts[1] === node && parts[0] === "Vous gagnez " && parts[2].startsWith(" par vente"));
ok("fillParts leaves unknown placeholders visible", fillParts("a {x} b", {}).join("") === "a {x} b");

// ── 3. Every key used exists, every key is used ──────────────────────────────
console.log("\n3. Keys used by the owned files");
const KEY_RE = /^(ugc|bst|dep|proofs|login|act|rec)_[a-z0-9_]+$/;
const used = new Set();
for (const [name, code] of Object.entries(CODE)) {
  const lits = [...code.matchAll(/["']([a-z]+_[a-z0-9_]+)["']/g)].map((m) => m[1]).filter((k) => KEY_RE.test(k));
  const tCalls = [...code.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const all = [...new Set([...lits, ...tCalls])];
  all.forEach((k) => used.add(k));
  const missing = all.filter((k) => !(k in fr) || !(k in ar));
  ok(`${name}: every t("…") / dictionary key exists (${all.length})`, missing.length === 0, missing);
}
const unused = frKeys.filter((k) => !used.has(k));
ok("every dictionary key is used by an owned file", unused.length === 0, unused);

// ── 4. No hard-coded Arabic / French UI text ─────────────────────────────────
console.log("\n4. No hard-coded user-visible Arabic / French");
// Lines that must keep a French literal, with the reason.
const ALLOW_LINE = [
  /const DEPOSIT_METHOD = "Virement bancaire";/, // data sent to POST /api/affiliate/deposits (stored payment method), displayed translated
];
const offending = (code) => code.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => !ALLOW_LINE.some((re) => re.test(l)));
for (const [name, code] of Object.entries(CODE)) {
  const arabic = offending(code).filter(([, l]) => /[؀-ۿ]/.test(l)).map(([n, l]) => `${n}: ${l.trim()}`);
  ok(`${name}: no Arabic outside comments`, arabic.length === 0, arabic);
  const accented = offending(code).filter(([, l]) => /[À-ÖØ-öø-ÿœŒ’]/.test(l)).map(([n, l]) => `${n}: ${l.trim()}`);
  ok(`${name}: no accented French outside comments`, accented.length === 0, accented);
  // JSX text nodes made of words (e.g. `>Envoyer<`, `/> Suivant`): any 3+ letter word between tags.
  const jsxText = [...code.matchAll(/>\s*([A-Za-z][A-Za-z' ]{2,}?)\s*(?=[<{])/g)]
    .map((m) => m[1].trim()).filter((w) => !/^(return|div|span|null|true|false)$/.test(w) && !/=/.test(w));
  ok(`${name}: no hard-coded words in JSX text`, jsxText.length === 0, jsxText);
  const attrs = [...code.matchAll(/\b(title|aria-label|placeholder|alt|label)="([^"]*[A-Za-z]{3,}[^"]*)"/g)].map((m) => `${m[1]}="${m[2]}"`)
    .filter((a) => a !== 'placeholder="06XXXXXXXX"'); // phone-format example (digits mask), identical in both languages
  ok(`${name}: no hard-coded title / aria-label / placeholder / alt / label`, attrs.length === 0, attrs);
  const french = [...code.matchAll(/["'`]([^"'`]*\b(?:Erreur|Envoyer|Annuler|Fermer|Retour|Suivant|Réessayer|Motif|vidéo|demande|preuve|connexion|mot de passe)\b[^"'`]*)["'`]/gi)]
    .map((m) => m[1]).filter((s) => !ALLOW_LINE.some((re) => re.test(`"${s}"`)) && s !== "Virement bancaire");
  ok(`${name}: no French UI literals`, french.length === 0, french);
}
for (const p of BRAND) {
  const code = stripComments(read(p));
  ok(`${p.split("/").pop()}: no hard-coded Arabic (texts come from its dictionary)`, !/[؀-ۿ]/.test(code));
}

// ── 5. Direction ──────────────────────────────────────────────────────────────
console.log("\n5. Direction");
for (const [name, code] of Object.entries(CODE)) {
  ok(`${name}: no pinned dir="rtl"`, !/dir=["']rtl["']/.test(code) && !/dir=\{["']rtl["']\}/.test(code));
  ok(`${name}: reads the market (useMarketLocale + AFFILIATE_TABS_TEXT)`,
    /import \{ useMarketLocale \} from "@\/context\/useMarketLocale";/.test(code) && /useMarketLocale\(AFFILIATE_TABS_TEXT\)/.test(code));
  ok(`${name}: no second language source (no localStorage store_lang / navigator.language)`, !/store_lang|navigator\.language/.test(code));
}
// Tabs + slider: no physical left/right utilities (logical ones only).
const PHYSICAL = /\b(?:ml|mr|pl|pr|left|right|-left|-right|border-l|border-r|rounded-l|rounded-r)-[\w[\]]|\btext-(?:left|right)\b|space-x-/;
for (const name of ["ugc", "booster", "deposit", "slider"]) {
  const hits = CODE[name].split("\n").filter((l) => PHYSICAL.test(l.replace(/file:me-3/g, ""))).map((l) => l.trim().slice(0, 140));
  ok(`${name}: logical (start / end) utilities only`, hits.length === 0, hits);
}
// Login / activation: the password field is a deliberate LTR island (input + show / hide button).
ok("login / activate: password wrapper is an LTR island (physical pr-10 / right-3 inside it)",
  /<div className="relative" dir="ltr">/.test(CODE.login) && /<div className="relative" dir="ltr">/.test(CODE.activate));
ok("booster timeline rail + dots on the start side", /ps-6/.test(CODE.booster) && /start-\[5px\]/.test(CODE.booster) && /absolute start-0 top-1\.5/.test(CODE.booster) && !/right-\[5px\]/.test(CODE.booster));
ok("booster back icon follows dir", /const BackIcon = dir === "rtl" \? ChevronRight : ChevronLeft;/.test(CODE.booster));
ok("UGC next / back / disclosure chevrons follow dir",
  /const Fwd = dir === "rtl" \? ChevronLeft : ChevronRight;/.test(CODE.ugc) && /const Back = dir === "rtl" \? ChevronRight : ChevronLeft;/.test(CODE.ugc)
  && !/<ChevronRight|<ChevronLeft/.test(CODE.ugc));
ok("UGC floating add button + modal close on the end side", /fixed bottom-6 end-5/.test(CODE.ugc) && /absolute -top-12 end-0/.test(CODE.ugc));
ok("slider: icons, keys and swipe mirror with dir",
  /const rtl = dir === "rtl";/.test(CODE.slider) && /const PrevIcon = rtl \? ChevronRight : ChevronLeft;/.test(CODE.slider)
  && /go\(rtl \? 1 : -1\)/.test(CODE.slider) && /go\(swipedLeft !== rtl \? 1 : -1\)/.test(CODE.slider) && /<section dir=\{dir\}/.test(CODE.slider));
ok("slider: data-* test hooks kept", ["data-payment-proofs", "data-proof-prev", "data-proof-next", "data-proof-open", "data-proof-name", "data-proof-amount", "data-proof-counter", "data-proof-preview"].every((h) => CODE.slider.includes(h)));
ok("numbers / codes are LTR islands (ratios, references, counters)",
  /<span dir="ltr" className="text-sm font-black text-gray-900">\{v\.sales\} \/ \{v\.target\}<\/span>/.test(CODE.booster)
  && /<bdi dir="ltr" className="font-mono">\{d\.transferReference\}<\/bdi>/.test(CODE.deposit)
  && /dir="ltr" data-recovery-counter/.test(CODE.recovery) && /<bdi dir="ltr">\{index \+ 1\} \/ \{shownTotal\}<\/bdi>/.test(CODE.slider)
  && /dir="ltr" data-code-input/.test(CODE.activate) && /dir="ltr" data-recovery-identifier/.test(CODE.recovery));
ok("recovery phone input: empty → market direction (placeholder), filled → dir=auto (digits LTR), same value handling",
  /dir=\{fieldDir\(phone\)\} data-recovery-phone/.test(CODE.recovery) && /value=\{phone\} onChange=\{edit\(setPhone, "contactPhone"\)\} maxLength=\{20\}/.test(CODE.recovery));
ok("UGC amounts: no MAD-named helper / literal left (label = t(\"ugc_currency\"))", !/fmtMAD|\bMAD\b/.test(CODE.ugc) && /const cur = t\("ugc_currency"\);/.test(CODE.ugc));
ok("formatters use the market's Intl locale (no pinned fr-FR / en-US)",
  ["ugc", "booster", "deposit", "slider"].every((n) => !/["'](fr-FR|en-US|ar-MA)["']/.test(CODE[n])) && /intlLocale/.test(CODE.ugc) && /intlLocale/.test(CODE.deposit));

// ── 6. Behaviour kept ─────────────────────────────────────────────────────────
console.log("\n6. Behaviour kept");
ok("activate: code read once from the fragment, then removed from the address bar",
  /\/\(\?:\^#\|&\)code=\(\[\^&\]\+\)\/\.exec\(hash\)/.test(CODE.activate) && /window\.history\.replaceState\(null, "", window\.location\.pathname \+ window\.location\.search\)/.test(CODE.activate));
ok("activate: same POST payload", /JSON\.stringify\(\{ code: code\.trim\(\), password, passwordConfirm: confirm \}\)/.test(CODE.activate) && /"\/api\/affiliate-activation"/.test(CODE.activate));
ok("activate / recovery: only error CODES read, mapped to keys", /ERROR_TEXT\[c\] \?\? GENERIC/.test(CODE.activate) && /ERROR_TEXT\[code\] \|\| GENERIC/.test(CODE.recovery));
ok("recovery: same POST payload + neutral success", /"\/api\/affiliate-activation\/recovery"/.test(CODE.recovery) && /identifier: identifier\.trim\(\)\.toLowerCase\(\)/.test(CODE.recovery) && /t\(NEUTRAL_SUCCESS\)/.test(CODE.recovery));
ok("login: same auth call + stored session keys", /"\/api\/affiliate\/auth"/.test(CODE.login) && ["affiliateToken", "affiliateId", "affiliateUsername", "affiliateName"].every((k) => CODE.login.includes(`"${k}"`)));
ok("deposit: still sends the fixed payment method (data), shows it translated",
  /fd\.append\("paymentMethod", DEPOSIT_METHOD\)/.test(CODE.deposit) && /m === DEPOSIT_METHOD \? t\("dep_method_bank"\) : m/.test(CODE.deposit));
ok("booster: same purchase payload", /JSON\.stringify\(\{ packageId: selected\.id, method \}\)/.test(CODE.booster));
ok("UGC: same endpoints", ["/api/affiliate/ugc/settings", "/api/affiliate/ugc/live", "/api/products?status=Active"].every((u) => CODE.ugc.includes(u)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
