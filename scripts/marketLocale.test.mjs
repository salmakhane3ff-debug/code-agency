/**
 * scripts/marketLocale.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Market-based language (Task 7): the market IS the existing site-language choice
 * (LanguageSwitcher → LanguageContext → localStorage `store_lang`):
 *   MA ⇄ 'ar' → Arabic / RTL      FR ⇄ 'fr' → French / LTR
 * in the four market-scoped areas, with route isolation:
 *   - /admin keeps its forced LTR (unchanged),
 *   - every other route keeps its old behaviour,
 *   - only /affiliate changes at the <html dir> level (it used to be pinned LTR).
 *
 * The pre-paint <head> script is EXECUTED here against a fake document and
 * localStorage, and compared with the previous version of the script for every
 * route × stored-preference combination.
 *
 * Run: node scripts/marketLocale.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  MARKETS, MARKET_SCOPED_PREFIXES, ALWAYS_LTR_PREFIXES, isMarketScopedPath, isAlwaysLtrPath,
  marketLang, marketForLang, marketDir, htmlDirFor, makeMarketT, marketIntlLocale, fieldDir,
} from "../src/lib/marketLocale.js";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`); }
}
const read = (p) => readFileSync(p, "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// ── 1. The mapping ─────────────────────────────────────────────────────────────
console.log("\n1. MA → ar/RTL, FR → fr/LTR");
ok("MA is Arabic, right-to-left", MARKETS.MA.lang === "ar" && MARKETS.MA.dir === "rtl");
ok("FR is French, left-to-right", MARKETS.FR.lang === "fr" && MARKETS.FR.dir === "ltr");
ok("'ar' → MA, 'fr' → FR", marketForLang("ar") === MARKETS.MA && marketForLang("fr") === MARKETS.FR);
ok("unknown language → the site fallback (Arabic), never a guess", marketLang(undefined) === "ar" && marketLang("en") === "ar" && marketDir(null) === "rtl");
ok("fieldDir: empty → inherit the market direction, filled → auto", fieldDir("") === undefined && fieldDir(null) === undefined && fieldDir(undefined) === undefined && fieldDir("0612") === "auto" && fieldDir("سارة") === "auto");
ok("Intl locale follows the market", marketIntlLocale("ar") === "ar-MA" && marketIntlLocale("fr") === "fr-MA");
ok("the market table is frozen", Object.isFrozen(MARKETS) && Object.isFrozen(MARKETS.MA) && Object.isFrozen(MARKET_SCOPED_PREFIXES));

// ── 2. Translator ──────────────────────────────────────────────────────────────
console.log("\n2. makeMarketT");
const D = { ar: { hi: "مرحبا {name}", only_ar: "ع" }, fr: { hi: "Bonjour {name}", only_fr: "F" } };
ok("Arabic text for MA", makeMarketT(D, "ar")("hi", { name: "Sara" }) === "مرحبا Sara");
ok("French text for FR", makeMarketT(D, "fr")("hi", { name: "Sara" }) === "Bonjour Sara");
ok("missing key falls back to the other language, then the key", makeMarketT(D, "fr")("only_ar") === "ع" && makeMarketT(D, "ar")("nope") === "nope");
ok("unknown placeholders are kept, null dicts never throw", makeMarketT(D, "fr")("hi", {}) === "Bonjour {name}" && makeMarketT(null, "ar")("x") === "x");

// ── 3. Route isolation of <html dir> ──────────────────────────────────────────
console.log("\n3. Route isolation");
const ROUTES = ["/", "/products", "/products/12", "/cart", "/checkout", "/checkout/success", "/blog", "/pages/about", "/contact",
  "/track-order", "/wishlist", "/login", "/faqs", "/feedback", "/tsajlim3ana", "/offer/promo", "/recruiter", "/recruiter/wallet",
  "/recruiter/login", "/affiliate/dashboard", "/affiliate/login", "/affiliate/activate", "/admin", "/admin/orders", "/admin/language"];
ok("market-scoped prefixes are exactly the four areas' routes", JSON.stringify([...MARKET_SCOPED_PREFIXES]) === JSON.stringify(["/affiliate", "/recruiter", "/offer", "/tsajlim3ana"]));
ok("only /admin is forced LTR", JSON.stringify([...ALWAYS_LTR_PREFIXES]) === JSON.stringify(["/admin"]));
ok("market-scoped detection", isMarketScopedPath("/affiliate/dashboard") && isMarketScopedPath("/recruiter") && isMarketScopedPath("/offer/x") && isMarketScopedPath("/tsajlim3ana")
  && !isMarketScopedPath("/") && !isMarketScopedPath("/admin") && !isMarketScopedPath("/products") && !isMarketScopedPath("/affiliates-promo") && !isMarketScopedPath("/offers"));
for (const r of ROUTES) {
  const admin = r.startsWith("/admin");
  ok(`htmlDirFor ${r}: ar → ${admin ? "ltr" : "rtl"}, fr → ltr`, htmlDirFor(r, "ar") === (admin ? "ltr" : "rtl") && htmlDirFor(r, "fr") === "ltr");
}
ok("/admin matching is the same raw prefix as before", isAlwaysLtrPath("/admin") && isAlwaysLtrPath("/admin/x") && isAlwaysLtrPath("/administrator") && !isAlwaysLtrPath("/"));

// ── 4. Pre-paint <head> script: execute new vs. old ──────────────────────────
console.log("\n4. Pre-paint script (executed)");
const LAYOUT = read("src/app/layout.jsx");
// Evaluate the template literal exactly like the build does (escapes such as \/ collapse to /), so the test runs the
// string the BROWSER receives — not the raw source text.
const scriptOf = (src) => { const m = src.match(/__html: `([^`]*)`/); return m ? new Function("return `" + m[1] + "`;")() : null; };
const NEW_SCRIPT = scriptOf(LAYOUT);
let OLD_SCRIPT = null;
try { OLD_SCRIPT = scriptOf(execFileSync("git", ["show", "cefc644:src/app/layout.jsx"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch {}
ok("the pre-paint script is present", typeof NEW_SCRIPT === "string" && NEW_SCRIPT.includes("store_lang"));
ok("the pre-paint script, as the browser receives it, parses", (() => { try { new Function(NEW_SCRIPT); return true; } catch { return false; } })());
function runPrePaint(script, pathname, stored) {
  const attrs = { lang: "ar", dir: "rtl" };
  const documentElement = { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] ?? null };
  const fakeStorage = { getItem: (k) => (k === "store_lang" ? stored : null) };
  // eslint-disable-next-line no-new-func
  new Function("localStorage", "document", "window", script)(fakeStorage, { documentElement }, { location: { pathname } });
  return attrs;
}
for (const stored of [null, "ar", "fr", "en"]) {
  for (const r of ROUTES) {
    const got = runPrePaint(NEW_SCRIPT, r, stored);
    const admin = r.startsWith("/admin");
    const want = stored === "fr" || stored === "ar"
      ? { lang: stored, dir: !admin && stored === "ar" ? "rtl" : "ltr", "data-lang": stored }
      : { lang: "ar", dir: admin ? "ltr" : "rtl" };
    const okNow = got.lang === want.lang && got.dir === want.dir && (want["data-lang"] ? got["data-lang"] === want["data-lang"] : got["data-lang"] === undefined);
    ok(`pre-paint ${r} stored=${stored}: lang=${want.lang} dir=${want.dir}`, okNow, got);
    // First-paint gate: ONLY market-scoped routes, ONLY when the persisted market is not Arabic (or not chosen yet).
    const wantPending = isMarketScopedPath(r) && stored !== "ar";
    ok(`pre-paint ${r} stored=${stored}: first-paint gate ${wantPending ? "set" : "not set"}`, ("data-market-pending" in got) === wantPending, got);
    if (OLD_SCRIPT && !r.startsWith("/affiliate")) {
      const old = runPrePaint(OLD_SCRIPT, r, stored);
      const { ["data-market-pending"]: _gate, ...gotNoGate } = got;
      ok(`pre-paint ${r} stored=${stored}: identical to the previous behaviour${isMarketScopedPath(r) ? " (apart from the gate)" : ""}`,
        JSON.stringify(old) === JSON.stringify(isMarketScopedPath(r) ? gotNoGate : got), { old, got });
    }
  }
}
ok("the previous script was readable from git (comparison ran)", OLD_SCRIPT !== null);
ok("/affiliate now follows the market: ar → rtl, fr → ltr", runPrePaint(NEW_SCRIPT, "/affiliate/dashboard", "ar").dir === "rtl" && runPrePaint(NEW_SCRIPT, "/affiliate/dashboard", "fr").dir === "ltr");

// ── 5. One language system, reused ────────────────────────────────────────────
console.log("\n5. Reuse of the existing selector / context / persistence");
const CTX = read("src/context/LanguageContext.jsx");
const HOOK = read("src/context/useMarketLocale.jsx");
ok("LanguageContext applies the single htmlDirFor rule", /import \{ htmlDirFor \} from "@\/lib\/marketLocale";/.test(CTX) && /htmlDirFor\(window\.location\.pathname, lang\)/.test(CTX));
ok("LanguageContext no longer pins /affiliate to LTR", !/startsWith\("\/affiliate"\)/.test(stripComments(CTX)));
ok("persistence is still only the explicit choice in setLang → store_lang", /localStorage\.setItem\(STORAGE_KEY, code\)/.test(CTX) && (CTX.match(/localStorage\.setItem/g) || []).length === 1);
ok("the market hook is a view over useLanguage (no own state, storage, cookie or detection)",
  /from "@\/context\/LanguageContext"/.test(HOOK) && /useLanguage\(\)/.test(HOOK)
  && !/useState|localStorage|sessionStorage|document\.cookie|navigator\.language|navigator\.languages|geo|fetch\(/.test(stripComments(HOOK)));
const SWITCHERS = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], { encoding: "utf8" })
  .split("\n").filter((f) => /\.(jsx?|tsx?)$/.test(f) && existsSync(f))
  .filter((f) => /setLang\(/.test(read(f)) && f !== "src/context/LanguageContext.jsx");
ok("setLang is still called only by the existing LanguageSwitcher", JSON.stringify(SWITCHERS) === JSON.stringify(["src/components/template/LanguageSwitcher.jsx"]), SWITCHERS);
// (Pre-existing click tracking reads request headers — only files changed since cefc644 are scanned.)
ok("no browser-language / IP-geolocation detection was introduced in src", ![
  ...execFileSync("git", ["diff", "--name-only", "cefc644", "--", "src"], { encoding: "utf8" }).split("\n"),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"], { encoding: "utf8" }).split("\n"),
].filter((f) => /\.(jsx?|tsx?)$/.test(f) && existsSync(f))
  .some((f) => /navigator\.languages?\b|accept-language|ipapi|geoip|ip-api|x-vercel-ip-country|cf-ipcountry/i.test(read(f))));

// ── 6. Layouts ────────────────────────────────────────────────────────────────
console.log("\n6. Layouts");
const AFF = stripComments(read("src/app/affiliate/layout.jsx"));
const REC = stripComments(read("src/app/recruiter/layout.jsx"));
ok("affiliate layout renders MarketScope (no pinned French/LTR)", /<MarketScope>/.test(AFF) && !/lang="fr"|dir="ltr"/.test(AFF));
ok("recruiter layout renders MarketScope around the app shell (no pinned Arabic/RTL)", /<MarketScope[\s\S]*<RecruiterAppShell>/.test(REC) && !/lang="ar"|dir="rtl"/.test(REC));
ok("MarketScope stamps dir + lang from the market", /dir=\{dir\} lang=\{lang\}/.test(HOOK));
const ADMIN_NOW = read("src/app/admin/layout.jsx");
let ADMIN_BEFORE = null;
try { ADMIN_BEFORE = execFileSync("git", ["show", "cefc644:src/app/admin/layout.jsx"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
ok("admin layout is byte-for-byte unchanged", ADMIN_BEFORE !== null && ADMIN_BEFORE === ADMIN_NOW);
ok("admin still forces <html dir=ltr> with its MutationObserver", /MutationObserver/.test(ADMIN_NOW) && /setAttribute\("dir", "ltr"\)/.test(ADMIN_NOW));

// ── 7. Unrelated files untouched ──────────────────────────────────────────────
console.log("\n7. Unrelated areas untouched");
const changed = execFileSync("git", ["diff", "--name-only", "cefc644", "--", "src"], { encoding: "utf8" }).split("\n").filter(Boolean);
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"], { encoding: "utf8" }).split("\n").filter(Boolean);
const ALLOWED = [
  /^src\/app\/layout\.jsx$/, /^src\/context\/LanguageContext\.jsx$/, /^src\/context\/useMarketLocale\.jsx$/, /^src\/lib\/marketLocale\.js$/,
  /^src\/app\/affiliate\//, /^src\/app\/recruiter\//, /^src\/app\/offer\//, /^src\/app\/tsajlim3ana\//,
  /^src\/components\/affiliate\//, /^src\/components\/brand\//,
  // Shared components rendered only inside the market-scoped areas (StickyCTA: /offer only; LiveActivity: affiliate
  // dashboard + /tsajlim3ana), and the COD form shared with the product page — optional overrides, Arabic defaults kept.
  /^src\/components\/checkout\/BankDetailsCard\.jsx$/, // shared with /checkout/confirm — optional dir props, defaults unchanged
  /^src\/components\/Product\/StickyCTA\.jsx$/, /^src\/components\/LiveActivity\.jsx$/, /^src\/components\/Product\/InlineCodForm\.jsx$/,
  /^src\/lib\/(recruiterI18n|affiliateDashboardI18n|affiliateTabsI18n|landingI18n|brandI18n|affiliateOrderMessages)\.js$/,
  // Display-time localizers for server-produced text (pure; no API / service change).
  /^src\/lib\/serverText\/[A-Za-z]+\.js$/,
  // Store header + selector: changed ONLY for market-scoped routes (pinned below); the first-paint CSS gate.
  /^src\/components\/template\/Header\.jsx$/, /^src\/components\/template\/LanguageSwitcher\.jsx$/, /^src\/app\/globals\.css$/,
];
// Create Your Own Brand — approved final design (after Task 7): each package defines its 3–4 products and their
// quantities (no product-selection step), with category, gallery and specifications managed by the admin. These exact
// brand files change for it (admin package form + labels, the package model, the request taking the package's
// contents); every other admin file, API route, service, schema and migration stays untouched (checked below).
const BRAND_FINAL_DESIGN = [
  "src/app/admin/brand/PackagesTab.jsx", "src/app/admin/brand/ProductsTab.jsx", "src/app/admin/brand/AccessesTab.jsx", "src/app/admin/brand/ui.jsx",
  "src/lib/brandProgram.js", "src/lib/services/brandAccessService.js",
];
const isBrandFinal = (f) => BRAND_FINAL_DESIGN.includes(f);
const outside = [...changed, ...untracked].filter((f) => !ALLOWED.some((re) => re.test(f)) && !isBrandFinal(f));
ok("src changes stay inside the four areas + the shared language plumbing", outside.length === 0, outside);
ok("no admin file changed (except the approved brand package-management files)", ![...changed, ...untracked].some((f) => !isBrandFinal(f) && (/^src\/(app|components)\/admin\//.test(f) || /^src\/app\/api\/admin\//.test(f))));
ok("no API route, service, schema or migration changed (except the approved brand request service)", ![...changed, ...untracked].some((f) => !isBrandFinal(f) && /^src\/app\/api\/|^src\/lib\/services\/|^prisma\//.test(f)));
ok("the store header's route wiring is unchanged (same routes show / hide it)", !changed.includes("src/components/template/MainHeaderWrapper.jsx"));

// ── 8. Store header + selector: market-scoped routes only ─────────────────────
console.log("\n8. Store header and selector (market-scoped routes only)");
const HEADER = read("src/components/template/Header.jsx");
const SWITCH = read("src/components/template/LanguageSwitcher.jsx");
let HEADER_BEFORE = "", SWITCH_BEFORE = "";
try { HEADER_BEFORE = execFileSync("git", ["show", "cefc644:src/components/template/Header.jsx"], { encoding: "utf8" }); SWITCH_BEFORE = execFileSync("git", ["show", "cefc644:src/components/template/LanguageSwitcher.jsx"], { encoding: "utf8" }); } catch {}
ok("the header decides by isMarketScopedPath(usePathname())", /const marketRoute = isMarketScopedPath\(usePathname\(\)\);/.test(HEADER));
ok("off market routes: no remount key, the plain LanguageSwitcher, no new aria-label",
  /const marketKey = marketRoute \? \(hydrated \? "client" : "server"\) : undefined;/.test(HEADER)
  && /const Switcher = marketRoute \? MarketLanguageSwitcher : LanguageSwitcher;/.test(HEADER)
  && /aria-label=\{marketRoute \? mt\("menu"\) : undefined\}/.test(HEADER));
ok("only the three hydration-stale aria-label links get the market key", (HEADER.match(/key=\{marketKey \? `nav_(search|wishlist|cart)-\$\{marketKey\}` : undefined\}/g) || []).length === 3);
ok("LanguageSwitcher: optional labels only, defaults (storefront) unchanged",
  /export default function LanguageSwitcher\(\{ labels = null \}\)/.test(SWITCH) && /aria-label=\{labels\?\.\[code\] \?\? label\}/.test(SWITCH)
  && SWITCH_BEFORE.includes('{ code: "ar", flag: "🇲🇦", label: "Switch to Arabic" }') && SWITCH.includes('{ code: "ar", flag: "🇲🇦", label: "Switch to Arabic" }'));
ok("the header file differs from cefc644 only by the market-route additions",
  (() => { const add = HEADER.split("\n").filter((l) => !HEADER_BEFORE.split("\n").includes(l)); return HEADER_BEFORE.length > 0 && add.every((l) => /market|Market|Switcher|useHydrated|usePathname|HEADER_MARKET_TEXT|key=\{marketKey|aria-label=\{t\("nav_|^\s*\/\/|^\s*$|^\s*const \{ t: mt \}|visitor's market|hydration-stale|every other route|undefined on every/.test(l)); })());

// ── 9. First paint: gated from the persisted market, scoped to market content ──
console.log("\n9. First paint (market routes only)");
const CSS = read("src/app/globals.css");
ok("CSS hides ONLY [data-market-scope] under html[data-market-pending], with a 3 s reveal fallback",
  /html\[data-market-pending\] \[data-market-scope\] \{\s*visibility: hidden;\s*animation: market-reveal 0s linear 3s forwards;\s*\}/.test(CSS) && /@keyframes market-reveal \{\s*to \{ visibility: visible; \}\s*\}/.test(CSS));
ok("the gate is lifted only by market content roots (useMarketPaintGate), never by the header",
  /export function useMarketPaintGate\(\)/.test(HOOK) && /useMarketPaintGate\(\);\s*return \(\s*<div dir=\{dir\} lang=\{lang\}/.test(HOOK) && !/useMarketPaintGate/.test(HEADER));
{
  const offer = read("src/app/offer/[slug]/OfferClient.jsx"), rl = read("src/app/tsajlim3ana/RecruitmentLanding.jsx");
  ok("the landing roots lift the gate too (OfferContent, RecruitmentLanding, RecruitmentUnavailable)",
    (offer.match(/useMarketPaintGate\(\);/g) || []).length === 1 && (rl.match(/useMarketPaintGate\(\);/g) || []).length === 2);
}
ok("the gate is lifted only after hydration AND language resolution", /if \(hydrated && mounted\) document\.documentElement\.removeAttribute\(PENDING_ATTR\);/.test(HOOK));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
