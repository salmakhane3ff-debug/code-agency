#!/usr/bin/env node
/**
 * scripts/landingI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Landing pages (/offer/[slug], /tsajlim3ana) follow the visitor's market:
 * MA → Arabic / RTL, FR → French / LTR. Proves:
 *   • LANDING_TEXT: ar/fr have identical key sets, no empty values, the same
 *     {placeholders} on both sides, and every key is used by a landing file
 *   • every literal key used by the landing files exists in the dictionary
 *   • the Arabic fallbacks of admin-configurable recruitment copy are
 *     byte-identical to the defaults in src/lib/recruitmentCta.js (so "not
 *     authored by the admin" is detected reliably, and nothing drifts)
 *   • the landing .jsx files contain no hard-coded Arabic / French UI text
 *     outside comments (allowlist below, with reasons) and no forced dir="rtl"
 *   • direction follows the market (root dir/lang from the hook) and the order /
 *     tracking plumbing is still wired (unchanged behaviour)
 * Pure — no DOM / network / DB.
 * Run: node scripts/landingI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { LANDING_TEXT, LANDING_DEFAULT_BENEFIT_COUNT, LANDING_FEED_NEUTRAL_COUNT } from "../src/lib/landingI18n.js";
import { makeMarketT } from "../src/lib/marketLocale.js";
import {
  normalizeRecruitmentConfig, DEFAULT_CONFIRMATION_BENEFITS, LIVE_FEED_NEUTRAL, RECRUITMENT_WA_MESSAGE,
} from "../src/lib/recruitmentCta.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

const FILES = {
  offerClient: "src/app/offer/[slug]/OfferClient.jsx",
  offerPage:   "src/app/offer/[slug]/page.jsx",
  stickyCta:   "src/components/Product/StickyCTA.jsx",
  rlClient:    "src/app/tsajlim3ana/RecruitmentLanding.jsx",
  rlPage:      "src/app/tsajlim3ana/page.jsx",
};
const SRC = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]));

// Strip /* … */ (incl. JSX {/* … */}) and // line comments (not "https://").
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}()])\/\/[^\n]*/g, "$1");

const { ar, fr } = LANDING_TEXT;
const arKeys = Object.keys(ar).sort();
const frKeys = Object.keys(fr).sort();

console.log("1) Dictionary shape:");
{
  ok("ar and fr have identical key sets", JSON.stringify(arKeys) === JSON.stringify(frKeys));
  const missingFr = arKeys.filter((k) => !(k in fr));
  const missingAr = frKeys.filter((k) => !(k in ar));
  if (missingFr.length || missingAr.length) console.log("     missing fr:", missingFr, "missing ar:", missingAr);
  ok("no empty values (ar)", arKeys.every((k) => typeof ar[k] === "string" && ar[k].trim() !== ""));
  ok("no empty values (fr)", frKeys.every((k) => typeof fr[k] === "string" && fr[k].trim() !== ""));
  const vars = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(",");
  const badVars = arKeys.filter((k) => k in fr && vars(ar[k]) !== vars(fr[k]));
  if (badVars.length) console.log("     placeholder mismatch:", badVars);
  ok("same {placeholders} in ar and fr", badVars.length === 0);
  ok("dictionary is frozen", Object.isFrozen(LANDING_TEXT) && Object.isFrozen(ar) && Object.isFrozen(fr));
  ok("French values contain no Arabic script", frKeys.every((k) => !/[؀-ۿ]/.test(fr[k])));
  ok("no figure hard-coded in amount texts (interpolated)", /\{min\}/.test(fr.rl_ugc_commission_range) && /\{max\}/.test(ar.rl_team_range));
  ok("currency kept as the site does (درهم / DH)", ar.rl_ugc_commission_range.includes("درهم") && fr.rl_ugc_commission_range.includes("DH"));
}

console.log("2) Translator over LANDING_TEXT (market switch, interpolation):");
{
  const tAr = makeMarketT(LANDING_TEXT, "ar");
  const tFr = makeMarketT(LANDING_TEXT, "fr");
  ok("ar stock default interpolates count", tAr("offer_stock_default", { count: 3 }) === "فقط 3 قطعة متبقية في المخزون!");
  ok("fr stock default interpolates count", tFr("offer_stock_default", { count: 3 }) === "Plus que 3 pièces en stock !");
  ok("fr popup interpolates name + city", tFr("offer_popup_from", { name: "Sara", city: "Fès" }) === "Sara de Fès");
  ok("fr team range interpolates min/max", tFr("rl_team_range", { min: 5, max: 15 }).includes("5 %") && tFr("rl_team_range", { min: 5, max: 15 }).includes("15 %"));
  ok("unknown site lang falls back to Arabic", makeMarketT(LANDING_TEXT, "en")("offer_order_now") === ar.offer_order_now);
}

console.log("3) Every key used in the landing files exists (and every key is used):");
{
  const all = Object.values(SRC).map(stripComments).join("\n");
  const used = new Set();
  const prefixes = new Set();
  for (const m of all.matchAll(/["'`]((?:offer|rl|common)_[A-Za-z0-9_]+)["'`]/g)) {
    if (m[1].endsWith("_")) prefixes.add(m[1]); else used.add(m[1]);
  }
  const unknown = [...used].filter((k) => !(k in ar));
  if (unknown.length) console.log("     unknown keys:", unknown);
  ok(`all ${used.size} literal keys exist in the dictionary`, unknown.length === 0);
  const badPrefix = [...prefixes].filter((p) => !arKeys.some((k) => k.startsWith(p)));
  ok("dynamic key prefixes (rl_benefit_, rl_feed_neutral_) resolve to keys", badPrefix.length === 0 && prefixes.has("rl_benefit_") && prefixes.has("rl_feed_neutral_"));
  const unused = arKeys.filter((k) => !used.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
  if (unused.length) console.log("     unused keys:", unused);
  ok("no unused (dead) keys", unused.length === 0);
  // t("…") literal calls specifically
  const tCalls = [...all.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  ok(`every t("…") literal (${tCalls.length}) exists`, tCalls.length > 50 && tCalls.every((k) => k in ar));
}

console.log("4) Admin-configurable copy: Arabic fallbacks == recruitmentCta defaults (data stays as authored):");
{
  const c = normalizeRecruitmentConfig({});
  ok("hero.title default", ar.rl_default_hero_title === c.hero.title);
  ok("hero.subtitle default", ar.rl_default_hero_subtitle === c.hero.subtitle);
  ok("confirmation.title default", ar.rl_default_confirmation_title === c.confirmation.title);
  ok("ugc.title default", ar.rl_default_ugc_title === c.ugc.title);
  ok("ugc.description default", ar.rl_default_ugc_description === c.ugc.description);
  ok("team.title default", ar.rl_default_team_title === c.team.title);
  ok("team.description default", ar.rl_default_team_description === c.team.description);
  ok("benefit count matches", DEFAULT_CONFIRMATION_BENEFITS.length === LANDING_DEFAULT_BENEFIT_COUNT);
  ok("each default benefit has its ar twin", DEFAULT_CONFIRMATION_BENEFITS.every((b, i) => ar[`rl_benefit_${i}`] === b));
  ok("neutral feed count matches", LIVE_FEED_NEUTRAL.length === LANDING_FEED_NEUTRAL_COUNT);
  ok("each neutral feed message has its ar twin", LIVE_FEED_NEUTRAL.every((m, i) => ar[`rl_feed_neutral_${i}`] === m));
  ok("landing compares authored copy against the ar default (authoredOr)", /value === LANDING_TEXT\.ar\[key\] \? t\(key\) : value/.test(SRC.rlClient));
  ok("hero/team/ugc/confirmation copy routed through authoredOr", ["rl_default_hero_title", "rl_default_team_description", "rl_default_ugc_description", "rl_default_confirmation_title"].every((k) => SRC.rlClient.includes(`"${k}")`)));
  ok("testimonials / video titles rendered as authored", SRC.rlClient.includes("{tm.text}") && SRC.rlClient.includes("{v.title}"));
  ok("WhatsApp business message untouched (Darija, business-facing)", RECRUITMENT_WA_MESSAGE.includes("كأفلييت"));
}

console.log("5) No hard-coded UI text left in the landing files:");
{
  // Allowlist (file → line substrings that may keep Arabic), each with a reason.
  const ARABIC_ALLOW = {
    // SEO metadata is server-generated (no market available) — kept unchanged on purpose.
    rlPage: ['title: "سجلي معانا', 'description: "برنامج الأفلييت'],
  };
  for (const [k, code] of Object.entries(SRC)) {
    const lines = stripComments(code).split("\n");
    const hits = lines.filter((l) => /[؀-ۿ]/.test(l) && !(ARABIC_ALLOW[k] || []).some((a) => l.includes(a)));
    if (hits.length) console.log(`     ${FILES[k]}:`, hits.map((h) => h.trim().slice(0, 80)));
    ok(`${FILES[k]}: no hard-coded Arabic outside comments/allowlist`, hits.length === 0);
  }
  // French: accented letters / guillemets outside comments. "COD AFFILIÉ" is the brand wordmark.
  const FRENCH_ALLOW = ["AFFILIÉ"];
  for (const [k, code] of Object.entries(SRC)) {
    const lines = stripComments(code).split("\n");
    const hits = lines.filter((l) => /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ«»]/.test(l) && !FRENCH_ALLOW.some((a) => l.includes(a)));
    if (hits.length) console.log(`     ${FILES[k]}:`, hits.map((h) => h.trim().slice(0, 80)));
    ok(`${FILES[k]}: no hard-coded French outside comments/allowlist`, hits.length === 0);
  }
  const offer = stripComments(SRC.offerClient);
  ok("former English chrome translated (No image / Background Audio / Tap to play / Loading…)",
    !/No image|Background Audio|Tap to play|"Playing"|>Loading…|aria-label="(Previous|Next)"|`Slide /.test(offer));
}

console.log("6) Direction follows the market:");
{
  for (const [k, code] of Object.entries(SRC)) {
    ok(`${FILES[k]}: no hard-coded dir="rtl"`, !/dir=["']rtl["']/.test(stripComments(code)));
  }
  ok("offer root uses dir/lang from the hook", /<div className="min-h-screen bg-gray-50 pb-28" dir=\{dir\} lang=\{lang\}/.test(SRC.offerClient));
  ok("offer reads the market via useMarketLocale(LANDING_TEXT)", SRC.offerClient.includes("useMarketLocale(LANDING_TEXT)"));
  ok("recruitment root uses dir/lang from the hook", /<div dir=\{dir\} lang=\{lang\} data-market-scope=\{lang\} className="min-h-screen bg-white/.test(SRC.rlClient));
  ok("recruitment reads the market via useMarketLocale(LANDING_TEXT)", SRC.rlClient.includes("useMarketLocale(LANDING_TEXT)"));
  ok("disabled /tsajlim3ana view is the market-aware client component", SRC.rlPage.includes("<RecruitmentUnavailable />") && /export function RecruitmentUnavailable/.test(SRC.rlClient));
  ok("sticky CTA inherits the page direction", !/\bdir=/.test(stripComments(SRC.stickyCta)));
  ok("offer slider arrows use logical sides + mirrored glyphs", /absolute start-2/.test(SRC.offerClient) && /absolute end-2/.test(SRC.offerClient) && /dir === "rtl" \? "›" : "‹"/.test(SRC.offerClient));
  ok("video slider arrows use logical sides + mirrored chevrons", /absolute start-0/.test(SRC.rlClient) && /absolute end-0/.test(SRC.rlClient) && /dir === "rtl" \? <ChevronRight/.test(SRC.rlClient));
  ok("activity popup pinned to the inline end", /fixed bottom-24 end-4/.test(SRC.offerClient));
  ok("prices are LTR islands", (SRC.offerClient.match(/dir="ltr"/g) || []).length >= 5);
  ok("no physical text-right / ml- / mr- left in the clients", !/\btext-right\b|\bm[lr]-\d/.test(stripComments(SRC.offerClient) + stripComments(SRC.rlClient)));
  // Number grouping is kept exactly as before in both markets (the competition counter "en-US", the stats "fr-FR"),
  // inside LTR islands — so the MA (Arabic) display is unchanged.
  ok("numbers keep their original grouping (unchanged display)", SRC.rlClient.includes('display.toLocaleString("en-US")') && SRC.rlClient.includes('v.toLocaleString("fr-FR")'));
  ok("store header language selector not added on /offer (no selector import)", !/LanguageSwitcher/.test(SRC.offerClient + SRC.stickyCta));
}

console.log("7) Behaviour unchanged (order + tracking plumbing still wired):");
{
  const o = SRC.offerClient;
  ok("COD order form still rendered (same props, plus the market texts / direction)",
    o.includes("<LandingCodForm cfg={cfg} product={product} landingPage={landingPage} focusSignal={ctaFocus} />")
    && o.includes('<InlineCodForm {...props} text={text} dir={dir} phoneDir="auto" />'));
  {
    const f = readFileSync("src/components/Product/InlineCodForm.jsx", "utf8");
    ok("the shared COD form keeps its Arabic / RTL defaults (product page unchanged)",
      /dir = "rtl"/.test(f) && f.includes('submit: "اطلب الآن"') && f.includes('phone: "رقم الهاتف *"') && f.includes("cfg.buttonText || tx.submit"));
    ok("the product page still renders the form without overrides", /<InlineCodForm(?![^>]*\btext=)[^>]*>/.test(readFileSync("src/app/products/[id]/product.jsx", "utf8")));
  }
  ok("campaign click tracking", o.includes('fetch("/api/track/click"'));
  ok("aff / ref persistence", o.includes('localStorage.setItem("affiliateId", affId)') && o.includes('localStorage.setItem("affiliateRef", refParam)'));
  ok("landing CTA / scroll / time tracking", (o.match(/\/api\/landing\/track-click/g) || []).length === 3);
  ok("Buy Now → checkout", o.includes('router.push("/checkout/address")') && o.includes('localStorage.setItem("buyNow"'));
  ok("CTA routing helpers", o.includes("resolveCtaAction({ hasOrderForm, buttonUrl })") && o.includes("isCtaDisabled({"));
  ok("admin stock label keeps its {count} replacement", o.includes('cfg.label ? cfg.label.replace("{count}", count)'));
  ok("offer server page untouched in data flow", SRC.offerPage.includes("getLandingPageBySlug(slug)") && SRC.offerPage.includes("<OfferClient"));
  const r = SRC.rlClient;
  ok("recruitment beacons intact", ["header_login_click", "hero_whatsapp_click", "final_whatsapp_click", "competition_section_view", "live_feed_close", "faq_open"].every((e) => r.includes(`"${e}"`)));
  ok("server gate unchanged (enabled check, noindex)", SRC.rlPage.includes("if (!config.enabled)") && SRC.rlPage.includes("index: false"));
}

console.log("8) Currency labels, server live text, first-paint scope:");
{
  const offer = stripComments(SRC.offerClient);
  ok("currency label follows the site rule (ar درهم / fr DH)", ar.offer_currency === "درهم" && fr.offer_currency === "DH");
  ok("offer prices no longer hard-code \"MAD\" as a label", !/\bMAD\b/.test(offer));
  ok("all 4 offer price labels use t(\"offer_currency\")", (offer.match(/t\("offer_currency"\)/g) || []).length === 4);
  ok("price + label stay inside LTR islands", /dir="ltr">\s*\{Number\(price\)\.toFixed\(0\)\}\{" "\}\s*<span[^>]*>\{t\("offer_currency"\)\}<\/span>/.test(offer)
    && /line-through" dir="ltr">\{Number\(originalPrice\)\.toFixed\(0\)\} \{t\("offer_currency"\)\}/.test(offer)
    && /dir="ltr">\s*\{Number\(specialPrice\)\.toFixed\(0\)\} \{t\("offer_currency"\)\}/.test(offer)
    && /dir="ltr">\s*\{Number\(origPrice\)\.toFixed\(0\)\} \{t\("offer_currency"\)\}/.test(offer));
  ok("amounts untouched (same rounding)", (offer.match(/\.toFixed\(0\)/g) || []).length >= 4);
  ok("StickyCTA / recruitment landing show no hard-coded currency label",
    !/\bMAD\b|\bDH\b|درهم/.test(stripComments(SRC.stickyCta)) && !/\bMAD\b|\bDH\b|درهم/.test(stripComments(SRC.rlClient)));
  ok("offer page root carries data-market-scope", /<div className="min-h-screen bg-gray-50 pb-28" dir=\{dir\} lang=\{lang\} data-market-scope=\{lang\}>/.test(SRC.offerClient));
  ok("offer not-found root carries data-market-scope", /justify-center px-4" dir=\{dir\} lang=\{lang\} data-market-scope=\{lang\}>/.test(SRC.offerClient));
  ok("offer loading state still renders nothing (no root to tag)", /if \(loading\) return null;/.test(SRC.offerClient));
  ok("recruitment landing + unavailable roots carry data-market-scope", (SRC.rlClient.match(/dir=\{dir\} lang=\{lang\} data-market-scope=\{lang\}/g) || []).length === 2);
  ok("live-feed sentences localized at display time (server text unchanged for MA)",
    SRC.rlClient.includes('import { localizeLiveFeedText } from "@/lib/serverText/liveText"')
    && SRC.rlClient.includes("localizeLiveFeedText(current.text, current.type, lang)"));
  ok("leaderboard names stay data (masked, never translated)", SRC.rlClient.includes("{maskSurname(m.name)}"));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
