#!/usr/bin/env node
/**
 * scripts/demoCompetitionLayout.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Demo Competition — two LAYOUT fixes found in the browser (static checks):
 *   A. /top-members (3-stat card: earnings · orders · network): on a narrow card (phones, each column
 *      of the desktop two-column list) the money values were cut with "…" (e.g. "104,220 در…" in
 *      Arabic). The 3-stat <dl> carries `dc-stats-3`; demoCompetition.css re-sizes its columns and
 *      sets 15 px values below 28rem, and lets the currency unit wrap under the amount instead of an
 *      ellipsis. 2-stat cards, Money and the number formatting are unchanged.
 *   B. Top-3 profile pages: the `dc-flame` wrapper had no positioning, so the glow pseudo-elements
 *      (position: absolute; inset: -1px) were laid out against the viewport (1 px horizontal overflow,
 *      glow around the page instead of the card). The wrapper is now `relative isolate rounded-2xl`
 *      on both profiles, like the ranking cards (.dc-card); the glow CSS itself is unchanged.
 * Run: node scripts/demoCompetitionLayout.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAmount, formatMoney, currencyUnit, formatCount } from "../src/lib/demoCompetition/i18n.js";
import { flameClass } from "../src/components/demoCompetition/flame.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI = "src/components/demoCompetition";
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
}

const card = read(`${UI}/LeaderCard.jsx`);
const memberRow = read(`${UI}/MemberRow.jsx`);
const brandRow = read(`${UI}/BrandRow.jsx`);
const countUp = read(`${UI}/CountUp.jsx`);
const css = read(`${UI}/demoCompetition.css`);
const memberProfile = read(`${UI}/MemberProfile.jsx`);
const brandProfile = read(`${UI}/BrandProfile.jsx`);

// ── A. 3-stat card: no ellipsis on the money values ───────────────────────────
console.log("\nA. 3-stat card (Top Members): money values never cut with an ellipsis");
ok("LeaderCard: the 3-stat grid carries dc-stats-3, the 2-stat grid stays plain grid-cols-2",
  /const STAT_COLS = \{ 2: "grid-cols-2", 3: "grid-cols-3 dc-stats-3" \};/.test(card));
ok("LeaderCard: the stats <dl> still takes its columns from STAT_COLS[statCount]",
  /<dl className=\{`grid \$\{STAT_COLS\[statCount\] \|\| "grid-cols-2"\} gap-x-3 \$\{L\.stats\}`\}>/.test(card));
ok("CardStat <dd> unchanged (2-stat cards look as before: 17 px / sm 18 px, single line)",
  /<dd className="mt-0\.5 truncate text-\[17px\] font-black leading-tight text-gray-900 sm:text-lg">\{children\}<\/dd>/.test(card));
ok("only /top-members (showNetwork) renders the 3-stat card; brands keep 2 stats",
  /statCount=\{showNetwork \? 3 : 2\}/.test(memberRow) && !/statCount=/.test(brandRow));

const narrow = css.match(/@container \(width < 28rem\) \{([\s\S]*?)\n\}/);
ok("CSS: narrow-card rules scoped to the card's own width (< 28rem, the Tailwind @md container step)", !!narrow);
const nb = narrow ? narrow[1] : "";
ok("CSS (narrow): money columns get more room — minmax(0,1fr) · minmax(min-content,0.75fr) · minmax(0,1.1fr)",
  /\.dc-stats-3 \{ grid-template-columns: minmax\(0, 1fr\) minmax\(min-content, 0\.75fr\) minmax\(0, 1\.1fr\); \}/.test(nb));
ok("CSS (narrow): values 2 px smaller (15 px) only in the 3-stat card", /\.dc-stats-3 dd \{ font-size: 15px; \}/.test(nb));
ok("CSS: last resort — the unit may wrap under the amount (dd and Money's span: white-space normal)",
  /\.dc-stats-3 dd,\s*\n\.dc-stats-3 dd > span \{ white-space: normal; \}/.test(css));
ok("CSS: dc-stats-3 rules never target 2-stat cards / other components (no grid-cols-2, .dc-card or .dc-row selector)",
  [...css.matchAll(/^([^{}\n]*dc-stats-3[^{}]*)\{/gm)].every((m) => !/grid-cols-2|\.dc-card|\.dc-row/.test(m[1])));
ok("CSS: the narrow rules sit before the reduced-motion block (which must stay last)",
  css.indexOf(".dc-stats-3") < css.indexOf("@media (prefers-reduced-motion: reduce)")
  && /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}\s*$/.test(css));

// Money / formatting unchanged
const sp = (s) => s.replace(/[\u202f\u00a0]/g, " ");
ok("Money: LTR number island + unit, still whitespace-nowrap by default (profiles, compact list unchanged)",
  /<span className=\{`whitespace-nowrap \$\{className\}`\}>/.test(countUp) && /<bdi dir="ltr" className="tabular-nums">/.test(countUp)
  && /<span className="text-\[0\.8em\] font-semibold opacity-80">\{currencyUnit\(lang\)\}<\/span>/.test(countUp));
const samples = [
  [10422000, "104 220", "104,220"], [99999900, "999 999", "999,999"], [123456700, "1 234 567", "1,234,567"],
  [107875844, "1 078 758,44", "1,078,758.44"], [9050, "90,50", "90.50"], [0, "0", "0"],
];
for (const [c, fr, ar] of samples) {
  ok(`formatAmount(${c}) unchanged: fr "${fr}" / ar "${ar}"`, sp(formatAmount(c, "fr")) === fr && formatAmount(c, "ar") === ar, [formatAmount(c, "fr"), formatAmount(c, "ar")]);
}
ok("units unchanged: fr \"DH\" / ar \"درهم\"; formatMoney = amount + space + unit",
  currencyUnit("fr") === "DH" && currencyUnit("ar") === "درهم" && formatMoney(123456700, "ar") === "1,234,567 درهم" && sp(formatMoney(123456700, "fr")) === "1 234 567 DH");
ok("formatCount unchanged", formatCount(1111, "ar") === "1,111" && sp(formatCount(1111, "fr")) === "1 111");

// ── B. Profile flame wrapper ──────────────────────────────────────────────────
console.log("\nB. Top-3 profile: the glow is positioned on the profile card (no overflow)");
for (const [name, src, v] of [["MemberProfile", memberProfile, "m"], ["BrandProfile", brandProfile, "b"]]) {
  const re = new RegExp(`<div className=\\{\`relative isolate rounded-2xl \\$\\{flameClass\\(${v}\\.rank\\)\\} \\$\\{${v}\\.rank <= 3 \\? "mt-6" : ""\\}\`\\}>\\s*<div className="dc-flame-inner rounded-2xl `);
  ok(`${name}: flame wrapper is its own positioning + stacking context with the card's corners (relative isolate rounded-2xl)`, re.test(src));
  ok(`${name}: no more "flameClass(...) || \\"rounded-2xl\\"" (rounded corners for every rank)`, !/flameClass\(\w\.rank\) \|\|/.test(src));
}
ok("ranking cards unchanged: .dc-card is position: relative + isolation: isolate, radius 1rem",
  /\.dc-card \{\s*position: relative;\s*isolation: isolate;\s*border-radius: 1rem;/.test(css));
ok("flameClass unchanged (dc-flame dc-flame--N for 1-3 only)", flameClass(1) === "dc-flame dc-flame--1" && flameClass(3) === "dc-flame dc-flame--3" && flameClass(4) === "");

// Glow CSS unchanged (colours, animation, inset)
const rule = (sel) => { const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`)); return m ? m[1].replace(/\s+/g, " ").trim() : null; };
ok(".dc-flame unchanged", rule(".dc-flame") === "border-width: 1.5px;", rule(".dc-flame"));
ok(".dc-flame::before unchanged (absolute, inset -1px, z -1, radius inherit, ring + glow, opacity var)",
  rule(".dc-flame::before") === 'content: ""; position: absolute; inset: -1px; z-index: -1; border-radius: inherit; pointer-events: none; box-shadow: 0 0 0 1px var(--dc-glow-ring, transparent), 0 6px 22px var(--dc-glow, transparent); opacity: var(--dc-glow-opacity, 1);',
  rule(".dc-flame::before"));
ok(".dc-flame::after unchanged (top tint)",
  rule(".dc-flame::after") === 'content: ""; position: absolute; inset: 0 0 auto 0; height: 40%; z-index: -1; border-radius: inherit; pointer-events: none; background: linear-gradient(180deg, var(--dc-tint, transparent), transparent);',
  rule(".dc-flame::after"));
ok(".dc-flame--1 colours unchanged",
  rule(".dc-flame--1") === "border-color: #fbbf24; --dc-glow-ring: rgba(251, 191, 36, 0.35); --dc-glow: rgba(245, 158, 11, 0.38); --dc-tint: rgba(254, 243, 199, 0.55);", rule(".dc-flame--1"));
ok(".dc-flame--2 colours unchanged",
  rule(".dc-flame--2") === "border-color: #dfe3ea; --dc-glow-ring: rgba(148, 163, 184, 0.18); --dc-glow: rgba(100, 116, 139, 0.16); --dc-tint: rgba(241, 245, 249, 0.6);", rule(".dc-flame--2"));
ok(".dc-flame--3 colours unchanged",
  rule(".dc-flame--3") === "border-color: #f6dcc4; --dc-glow-ring: rgba(234, 145, 74, 0.18); --dc-glow: rgba(217, 119, 6, 0.14); --dc-tint: rgba(255, 237, 213, 0.45);", rule(".dc-flame--3"));
ok("#1 breathing animation unchanged", rule(".dc-flame--1::before") === "animation: dc-breathe 3.2s ease-in-out infinite alternate;"
  && /@keyframes dc-breathe \{\s*0%\s+\{ opacity: 0\.7; \}\s*100%\s+\{ opacity: 1; \}\s*\}/.test(css));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
