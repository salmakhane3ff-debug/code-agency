#!/usr/bin/env node
/**
 * scripts/brandSnapshotDisplay.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — displaying a SAVED package breakdown (request
 * snapshot). Snapshots are frozen once written, so an older or hand-edited one
 * may lack fields; one such row used to crash the whole affiliate dashboard
 * (b.informational.map) or the whole admin request list (b.vat.percent).
 * Proves:
 *   • displayBreakdown never throws: informational missing / null / object /
 *     string / malformed entries, vat missing / null / wrong type, non-object
 *     breakdowns → numbers or null, vat always an object, only well-formed
 *     informational lines (unique keys)
 *   • a complete breakdown displays exactly as computed (no figure changed)
 *   • the affiliate Breakdown / PackageCosts and the admin request list go
 *     through displayBreakdown; the informational section is omitted when empty
 *   • display only: payment, snapshot writing and pricing maths are untouched
 * Run: node scripts/brandSnapshotDisplay.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { packageBreakdown, displayBreakdown } from "../src/lib/brandPricing.js";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const safe = (fn) => { try { return { v: fn() }; } catch (e) { return { e }; } };

const PKG = { price: 1000, deliveryCost: 40, logisticsCost: 10, vatPercent: 20, productCount: 3,
  percentages: { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 10, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } } };
const FULL = packageBreakdown(PKG);
const LEGACY = { price: 1000, deliveryCost: 40, logisticsCost: 10, subtotal: 1050, vat: { percent: 20, base: "SUBTOTAL", amount: 210 }, total: 1260 };

const wellShaped = (d) => d && ["price", "deliveryCost", "logisticsCost", "subtotal", "total"].every((k) => d[k] === null || Number.isFinite(d[k]))
  && d.vat && typeof d.vat === "object" && (d.vat.percent === null || Number.isFinite(d.vat.percent)) && (d.vat.amount === null || Number.isFinite(d.vat.amount))
  && Array.isArray(d.informational)
  && d.informational.every((x) => typeof x.key === "string" && x.key && Number.isFinite(x.percent) && typeof x.base === "string");

console.log("\n— complete breakdown");
{
  const d = displayBreakdown(FULL);
  ok("figures unchanged", d.price === 1000 && d.deliveryCost === 40 && d.logisticsCost === 10 && d.subtotal === 1050 && d.total === 1260);
  ok("vat unchanged", d.vat.percent === 20 && d.vat.amount === 210);
  ok("three informational lines, same values", d.informational.length === 3
    && d.informational.every((x, i) => x.key === FULL.informational[i].key && x.percent === FULL.informational[i].percent
      && x.base === FULL.informational[i].base && x.baseAmount === FULL.informational[i].baseAmount && x.amount === FULL.informational[i].amount));
  ok("SIMULATED_ORDERS line keeps null amounts", d.informational[0].baseAmount === null && d.informational[0].amount === null);
  ok("input not mutated", JSON.stringify(FULL) === JSON.stringify(packageBreakdown(PKG)));
}

console.log("\n— informational missing or wrongly typed");
for (const [name, value] of [["missing", undefined], ["null", null], ["object", { key: "confirmation", percent: 60 }], ["string", "confirmation"], ["number", 3], ["empty array", []]]) {
  const b = { ...LEGACY }; if (value !== undefined) b.informational = value;
  const r = safe(() => displayBreakdown(b));
  ok(`informational ${name}: no throw, section empty, totals kept`, !r.e && wellShaped(r.v) && r.v.informational.length === 0 && r.v.total === 1260 && r.v.vat.amount === 210, r.e?.message);
}
{
  const b = { ...LEGACY, informational: [null, 7, "x", [], {}, { key: "" , percent: 5 }, { key: "advertising" }, { key: "advertising", percent: "abc" },
    { key: "confirmation", percent: 60, base: "SIMULATED_ORDERS", baseAmount: null, amount: null },
    { key: "confirmation", percent: 99 }, { key: "companyShare", percent: "30", base: 4, baseAmount: "1050", amount: {} }] };
  const r = safe(() => displayBreakdown(b));
  ok("malformed entries dropped, duplicate keys kept once", !r.e && wellShaped(r.v) && r.v.informational.map((x) => x.key).join() === "confirmation,companyShare", r.e?.message);
  const cs = r.v?.informational[1];
  ok("entry fields coerced to number/null and string", cs && cs.percent === 30 && cs.base === "" && cs.baseAmount === 1050 && cs.amount === null);
  ok("first duplicate wins", r.v?.informational[0].percent === 60);
}

console.log("\n— vat and figures missing or wrongly typed");
for (const [name, value] of [["missing", undefined], ["null", null], ["string", "20"], ["array", [20, 210]]]) {
  const b = { ...FULL }; if (value === undefined) delete b.vat; else b.vat = value;
  const r = safe(() => displayBreakdown(b));
  ok(`vat ${name}: no throw, vat figures null`, !r.e && wellShaped(r.v) && r.v.vat.percent === null && r.v.vat.amount === null && r.v.total === 1260, r.e?.message);
}
{
  const r = safe(() => displayBreakdown({ price: "1000", deliveryCost: "", logisticsCost: null, subtotal: NaN, total: Infinity, vat: { percent: "x", amount: true } }));
  ok("figures: numeric string kept, empty/null/NaN/Infinity/boolean → null", !r.e && wellShaped(r.v) && r.v.price === 1000 && r.v.deliveryCost === null
    && r.v.logisticsCost === null && r.v.subtotal === null && r.v.total === null && r.v.vat.percent === null && r.v.vat.amount === null, r.e?.message);
  ok("empty object → all null, still displayable", wellShaped(displayBreakdown({})) && displayBreakdown({}).informational.length === 0);
}
for (const [name, value] of [["undefined", undefined], ["null", null], ["string", "x"], ["number", 0], ["array", [LEGACY]], ["boolean", true]]) {
  const r = safe(() => displayBreakdown(value));
  ok(`breakdown ${name} → null (nothing rendered)`, !r.e && r.v === null, r.e?.message);
}

console.log("\n— components use the safe view");
{
  const tab = readFileSync(new URL("../src/app/affiliate/dashboard/BrandTab.jsx", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../src/app/admin/brand/AccessesTab.jsx", import.meta.url), "utf8");
  const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? "" : src.slice(i, src.indexOf("\n}\n", i)); };
  const bd = fn(tab, "Breakdown"), pc = fn(tab, "PackageCosts");
  ok("BrandTab imports displayBreakdown", /import \{ displayBreakdown \} from "@\/lib\/brandPricing";/.test(tab));
  ok("Breakdown normalizes before rendering", /const b = displayBreakdown\(raw\);\s*\n\s*if \(!b\) return null;/.test(bd));
  ok("Breakdown omits the informational section when empty", bd.includes("{b.informational.length > 0 && <div"));
  ok("Breakdown and PackageCosts show — for a missing figure", [bd, pc].every((s) => s.includes('(n === null ? "—" : fmt(n))') && s.includes('b.vat.percent ?? "—"')));
  ok("PackageCosts normalizes before rendering", /const b = displayBreakdown\(raw\);\s*\n\s*if \(!b\) return null;/.test(pc));
  ok("admin list imports displayBreakdown", /import \{ displayBreakdown \} from "@\/lib\/brandPricing";/.test(admin));
  ok("admin list normalizes each row's snapshot", admin.includes("const b = displayBreakdown(a.packageSnapshot?.breakdown);") && !admin.includes("const b = a.packageSnapshot.breakdown;"));
  ok("admin list shows — for missing VAT figures", admin.includes('TVA {b.vat.percent ?? "—"} % = {m(b.vat.amount)}'));
  const svc = readFileSync(new URL("../src/lib/services/brandAccessService.js", import.meta.url), "utf8");
  ok("payment/snapshot code does not use the display view", !svc.includes("displayBreakdown") && !readFileSync(new URL("../src/lib/services/brandPaymentService.js", import.meta.url), "utf8").includes("displayBreakdown"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
