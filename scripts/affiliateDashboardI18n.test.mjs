#!/usr/bin/env node
/**
 * scripts/affiliateDashboardI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliate Dashboard (src/app/affiliate/dashboard/page.jsx) follows the MARKET
 * language — 🇲🇦 → Arabic RTL, 🇫🇷 → French LTR — through
 * useMarketLocale(AFFILIATE_DASHBOARD_TEXT). Proves:
 *   • ar / fr dictionaries have identical key sets and no empty values
 *   • currency follows the site convention (ar « درهم », fr « DH »)
 *   • every t("key") literal (and every *Key: "…" / ["col_…"] table key) used in
 *     the page exists in the dictionary
 *   • the page holds no hard-coded user-visible Arabic or French any more
 *     (static scan; comments ignored; allowlist below, with reasons)
 *   • no forced dir="rtl" island left; dir="ltr" only on codes / numbers / inputs
 *   • the page reads the market hook (not a private language state) and the old
 *     French-only formatting (fr-FR, "MAD") is gone
 * Run: node scripts/affiliateDashboardI18n.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { AFFILIATE_DASHBOARD_TEXT } from "../src/lib/affiliateDashboardI18n.js";
import { makeMarketT } from "../src/lib/marketLocale.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const PAGE_PATH = "../src/app/affiliate/dashboard/page.jsx";
const page = read(PAGE_PATH);
const { ar, fr } = AFFILIATE_DASHBOARD_TEXT;

// Strip comments (block, JSX {/* */} and line comments) — the scan only looks at code.
const stripComments = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const code = stripComments(page);

// ── 1. Dictionary shape ───────────────────────────────────────────────────────
console.log("\n1. Dictionary");
{
  const ka = Object.keys(ar).sort(), kf = Object.keys(fr).sort();
  ok("ar and fr have identical key sets", ka.join() === kf.join(),
    JSON.stringify({ onlyAr: ka.filter((k) => !(k in fr)), onlyFr: kf.filter((k) => !(k in ar)) }));
  ok("dictionary is frozen", Object.isFrozen(AFFILIATE_DASHBOARD_TEXT) && Object.isFrozen(ar) && Object.isFrozen(fr));
  const empty = [...ka.filter((k) => typeof ar[k] !== "string" || !ar[k].trim()), ...kf.filter((k) => typeof fr[k] !== "string" || !fr[k].trim())];
  ok("no empty values", empty.length === 0, empty.join());
  ok("currency: ar « درهم », fr « DH »", ar.currency === "درهم" && fr.currency === "DH");
  const arNoArabic = ka.filter((k) => !/[\u0600-\u06FF]/.test(ar[k]) && !/^(UGC|SWIFT|more_ugc|support_topic_ugc)$/.test(k) && ar[k] !== fr[k]);
  ok("Arabic values are written in Arabic (brand terms like UGC / SWIFT excepted)", arNoArabic.length === 0, arNoArabic.join());
  const frArabic = kf.filter((k) => /[\u0600-\u06FF]/.test(fr[k]));
  ok("French values contain no Arabic", frArabic.length === 0, frArabic.join());
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  const mismatch = ka.filter((k) => placeholders(ar[k]) !== placeholders(fr[k]));
  ok("same {placeholders} in both languages", mismatch.length === 0, mismatch.join());
  const plural = ka.filter((k) => k.endsWith("_one")).filter((k) => !(k.replace(/_one$/, "_other") in ar));
  ok("every _one plural has an _other form", plural.length === 0, plural.join());
  const tAr = makeMarketT(AFFILIATE_DASHBOARD_TEXT, "ar"), tFr = makeMarketT(AFFILIATE_DASHBOARD_TEXT, "fr");
  ok("interpolation works in both languages", tFr("tab_orders", { n: 4 }) === "Commandes (4)" && tAr("tab_orders", { n: 4 }) === "الطلبات (4)");
  // The competition wordings left with the old monthly leaderboard (merge with the Demo Competition, whose own
  // dictionary — src/lib/demoCompetition/i18n.js — now provides the leaderboard texts); the other wordings stay.
  ok("the old French and Arabic wordings are kept (More sheet, referral CTA, navigation)",
    !("leaderboard_title" in fr) && !("competitor_profile" in ar)
    && ar.more_title === "المزيد" && ar.cta_title === "شارك رابط الإحالة ديالك" && ar.nav_home === "الرئيسية");
}

// ── 2. Every key used by the page exists ──────────────────────────────────────
console.log("\n2. Keys used by the page");
{
  const used = new Set();
  for (const m of code.matchAll(/\bt\(\s*["']([a-z0-9_]+)["']/g)) used.add(m[1]);
  // keys picked conditionally: t(cond ? "a" : "b")
  for (const m of code.matchAll(/\bt\(\s*[^()"']*?\?\s*["']([a-z0-9_]+)["']\s*:\s*["']([a-z0-9_]+)["']/g)) { used.add(m[1]); used.add(m[2]); }
  for (const m of code.matchAll(/\blabelKey:\s*["']([a-z0-9_]+)["']/g)) used.add(m[1]);
  for (const m of code.matchAll(/["'](col_[a-z_]+|support_topic_[a-z]+)["']/g)) used.add(m[1]);
  for (const m of code.matchAll(/\bkey:\s*["']([a-z0-9_]+)["']/g)) used.add(m[1]);
  for (const m of code.matchAll(/setError\(\s*["']([a-z0-9_]+)["']\s*\)/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !(k in fr) || !(k in ar));
  ok(`all ${used.size} keys referenced by the page exist in ar and fr`, used.size > 150 && missing.length === 0, missing.join());
  const unused = Object.keys(fr).filter((k) => !used.has(k) && !["currency"].includes(k) && !page.includes(`"${k}"`) && !page.includes(`'${k}'`));
  ok("no orphan dictionary keys", unused.length === 0, unused.join());
}

// ── 3. No hard-coded user-visible Arabic / French left in the page ─────────────
console.log("\n3. Static scan of the page");
{
  const arabic = code.split("\n").filter((l) => /[\u0600-\u06FF]/.test(l));
  ok("no Arabic text in the page code", arabic.length === 0, arabic.slice(0, 5).join(" | "));
  const accented = code.split("\n").filter((l) => /[àâäçéèêëîïôöùûüÿœæÀÂÇÉÈÊËÎÏÔÙÛŒ]/.test(l));
  ok("no accented (French) text in the page code", accented.length === 0, accented.slice(0, 5).join(" | "));

  // JSX text nodes made of words. Allowlist (reason): brand term identical in both languages.
  const TEXT_ALLOW = new Set(["UGC"]);
  const textNodes = [...code.matchAll(/>([^<>{}]*)</g)].map((m) => m[1].trim())
    .filter((s) => /[A-Za-z]{2,}/.test(s) && !/[=;()&|?]/.test(s) && !TEXT_ALLOW.has(s));
  ok("no hard-coded JSX text (only the UGC brand badge allowlisted)", textNodes.length === 0, JSON.stringify(textNodes.slice(0, 8)));

  // Visible string attributes must come from t(). Allowlist (reason): format samples, not language.
  const ATTR_ALLOW = new Set(["0.00", "0612345678", "••••••••", "CIH, Attijariwafa, BMCE...", "XXXXXXXXXXXXXXXXXXXXXXXXXX"]);
  const attrs = [...code.matchAll(/\b(title|placeholder|alt|aria-label|label)="([^"]*)"/g)]
    .filter((m) => /[A-Za-z]/.test(m[2]) || m[2] === "×").filter((m) => !ATTR_ALLOW.has(m[2])).map((m) => m[0]);
  ok("title / placeholder / alt / aria-label / label attributes are translated", attrs.length === 0, attrs.join(" | "));
  const literalLabels = [...code.matchAll(/\blabel:\s*(["'`])([^"'`]*)\1/g)].map((m) => m[0]);
  ok("no literal `label:` strings in menus / stat lists (all via t())", literalLabels.length === 0, literalLabels.join(" | "));
  // Bank names sample: wrapped in isolates (\u2066 … \u2069) so it keeps its LTR order inside an RTL field.
  const BANKS_ALLOW = /placeholder: "(\\u2066CIH, Attijariwafa, BMCE\.\.\.\\u2069|X+)"/;
  const literalPh = [...code.matchAll(/\bplaceholder:\s*"([^"]*)"/g)].filter((m) => !BANKS_ALLOW.test(m[0])).map((m) => m[0]);
  ok("form placeholders translated (bank names / RIB mask allowlisted: not language)", literalPh.length === 0, literalPh.join());
  const alerts = [...code.matchAll(/alert\(\s*["'`]/g)];
  ok("alert() messages come from the dictionary", alerts.length === 0);
  const textMsgs = [...code.matchAll(/\btext:\s*["'`]/g)];
  ok("feedback messages are stored as keys (live language switch), server text only as { text: d.error }", textMsgs.length === 0);
  ok("no `MAD` currency or `fr-FR` formatting left", !/\bMAD\b/.test(code) && !/fr-FR/.test(code));
}

// ── 4. Direction ──────────────────────────────────────────────────────────────
console.log("\n4. Direction");
{
  ok("no forced dir=\"rtl\" island left", !/dir=["']rtl["']/.test(page) && !/dir=\{?["']rtl/.test(page));
  // The element carrying each dir="ltr": inputs (amount / username), the referral link box, the
  // handle chip, RIB / SWIFT values and the ▲/▼ rank-delta badge. Phone + bank inputs are dir="auto" (below).
  const ltrTags = [...page.matchAll(/dir=(?:"ltr"|\{mono \? "ltr" : undefined\})/g)].map((m) => {
    const open = page.lastIndexOf("<", m.index);
    return page.slice(open, m.index).match(/^<(\w+)/)?.[1];
  });
  // Merge with the Demo Competition: the ▲/▼ rank-delta badge left with the old monthly leaderboard (replaced by the
  // shared Demo Competition components, which handle their own direction) → 5 islands remain.
  ok(`dir="ltr" only on codes / numbers / inputs (${ltrTags.length} islands)`,
    ltrTags.length >= 5 && ltrTags.every((tag) => ["input", "span", "div"].includes(tag)), ltrTags.join());
  // Phone + bank inputs: dir="auto" — an empty input aligns its (market-language) placeholder with the
  // market, typed digits / RIB stay LTR. Value handling unchanged.
  ok("bank inputs (bank name / RIB / holder): empty → market direction (placeholder), filled → dir=auto (fieldDir), same value handling",
    /dir=\{fieldDir\(bankForm\[key\]\)\}\s+data-bank-input=\{key\}/.test(page) && /value=\{bankForm\[key\]\}/.test(page) && /setBankForm\(\(f\) => \(\{ \.\.\.f, \[key\]: e\.target\.value \}\)\)/.test(page));
  ok("profile phone inputs (locked + editable) are dir=\"auto\"",
    /<input value=\{affiliate\.phone \?\? ""\} disabled dir="auto"/.test(page) && /placeholder="0612345678" dir="auto" \/>/.test(page) && /<input name="phone" type="tel"/.test(page));
  const physical = code.match(/(?<![\w-])(text-left|text-right|sm:text-right|ml-\d|mr-\d|pl-\d|pr-\d|-?right-\d|-?left-2|right-1\.5|left-2)(?![\w.])/g) || [];
  ok("mirroring classes are logical (text-start/end, ms/me, ps/pe, start/end)", physical.length === 0, physical.join());
  // The old leaderboard row's -rotate-90 chevron left with it (merge with the Demo Competition): every remaining
  // sideways chevron must still flip in RTL.
  ok("chevrons / arrows flip in RTL", (page.match(/rtl:rotate-180/g) || []).length >= 4
    && (page.match(/-rotate-90(?! rtl:rotate-90)/g) || []).length === 0);
  ok("usernames, order ids and @handles are isolated (<bdi>)", (page.match(/<bdi>/g) || []).length >= 8);
  ok("amounts are LTR islands (Unicode isolates in fmtMoney)", /const LRI = "\\u2066"/.test(page) && /function fmtMoney\(n, lang/.test(page));
  ok("the order-refused notice keeps the language direction", /role="alert" dir=\{orderMessageDir\(lang\)\}/.test(page));
}

// ── 5. Wiring ─────────────────────────────────────────────────────────────────
console.log("\n5. Wiring");
{
  ok("imports the market hook + the dictionary (no private language state)",
    /import \{ useMarketLocale \} from "@\/context\/useMarketLocale";/.test(page)
    && /import \{ AFFILIATE_DASHBOARD_TEXT \} from "@\/lib\/affiliateDashboardI18n";/.test(page)
    && !/useLanguage\(/.test(page) && !/localStorage\.(get|set)Item\(["']store_lang/.test(page));
  const hookCalls = (page.match(/useMarketLocale\(AFFILIATE_DASHBOARD_TEXT\)/g) || []).length;
  // 11 since the merge with the Demo Competition: the old CompetitionTab and DemoAffiliateModal (2 calls) were removed;
  // the new leaderboard reads the dashboard language through its `lang` prop.
  ok(`every translated component reads the hook (${hookCalls} calls)`, hookCalls >= 11);
  ok("dates use the market Intl locale", /toLocaleDateString\(marketIntlLocale\(lang\)/.test(page) && /toLocaleDateString\(\s*intlLocale,/.test(page));
  ok("bottom nav + More sheet are translated", /label: t\("more_orders"\)/.test(page) && /label=\{t\("nav_home"\)\}/.test(page) && /\{t\("more_title"\)\}/.test(page));
  ok("menus keep their order (brand where Booster was)", /const moreItems = \[[\s\S]*?tab: "settings" \},\n  \];/.test(page));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
