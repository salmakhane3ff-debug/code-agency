#!/usr/bin/env node
/**
 * scripts/brandProgram.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * "Create Your Own Brand" — paid TRAINING SIMULATOR: configuration, refund
 * terms, routes, navigation and texts. Drives the real rules, services and
 * route handlers against the brand fake DB (strict: any non-brand table throws).
 * Proves:
 *   • ships DISABLED with no package, price, simulation setting or terms
 *   • packages are training access only (no inventory / real-business fee / 90 %
 *     guarantee fields); simulation settings need every value + a 100 % split
 *   • saves: strict validation, audit row in the same transaction, saved package
 *     never removed, simulation.activeSince stamped by the server only
 *   • refund terms: the draft is never public; publishing = admin approval,
 *     versioned, audited; nothing is pre-written
 *   • both settings rows refused by the generic /api/setting route
 *   • every brand route is auth-wrapped; sidebar + navigation swap unchanged
 *   • catalogue: only store product ids are saved (validated, de-duplicated,
 *     capped); the offer lists eligible products only (published, active, not
 *     locked), in the admin's order, with id/name/safe image — never prices;
 *     the participant must pick 3–4 different ones
 *   • FR/AR texts: same keys, every status / error labelled, no figures, and the
 *     "simulated, no earnings" disclosures are present
 *   • affiliate tab: products → brand name → review flow; brand name + products
 *     shown on the pending and active views; real earnings never read there
 * Run: node scripts/brandProgram.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID, BRAND_LIMITS, SIM_OUTCOMES, SIM_STATUSES,
  validateBrandConfig, normalizeBrandConfig, publicBrandOffer, isSimulationRunnable, removedPackageIds,
  normalizeRefundTerms, validateTermsDraft, publicRefundTerms, normalizeBrandName, isValidClientRequestId,
  normalizeProductSelection, eligibleCatalog, catalogProductView, isEligibleProduct, CATALOG_PRODUCT_SELECT,
} from "../src/lib/brandProgram.js";
import { packageBreakdown, missingPricingFields } from "../src/lib/brandPricing.js";
import { getBrandConfig, saveRefundTermsDraft, publishRefundTerms, getRefundTerms } from "../src/lib/services/brandProgramService.js";
import { adminBrandHandlers, affiliateBrandHandlers } from "../src/lib/brandRouteHandlers.js";
import { BRAND_TEXT } from "../src/lib/brandI18n.js";
import { DASHBOARD_TEXT } from "../src/app/affiliate/dashboard/_brand/dashboardText.js";
import { makeBrandFakeDb } from "./lib/brandFakeDb.mjs";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n, extra); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Test values only — not product defaults. */
const SIM = { enabled: true, startDelayHours: 3, dailyVolumeMin: 4, dailyVolumeMax: 9, confirmationDelayHours: 1, deliveryDelayHours: 30,
  distribution: { delivered: 40, refused: 15, returned: 5, noResponse: 25, cancelled: 15 } };
const PCT = { confirmation: { value: 60, base: "SIMULATED_ORDERS" }, advertising: { value: 12.5, base: "PACKAGE_PRICE" }, companyShare: { value: 30, base: "SUBTOTAL" } };
const pkg = (over = {}) => ({ id: "pack-a", name: "Formation A", price: 321.5, active: true, description: "", features: ["Module 1"],
  productCount: 3, productIds: ["p-1", "p-2", "p-3"], deliveryCost: 35, logisticsCost: 12.25, vatPercent: 20, percentages: PCT, ...over });
const cfg = (over = {}) => ({ enabled: true, packages: [pkg()], brandingOptions: [], simulation: { enabled: false }, catalogProductIds: ["p-1", "p-2", "p-3", "p-4"], ...over });
const CAT = ["p-1", "p-2", "p-3", "p-4"].map((id) => ({ id, title: id, image: null }));
const req = (body, method = "PUT") => new Request("http://x/api/admin/brand/config", {
  method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const admin = { userId: "admin-1", role: "ADMIN" };

// ── 1. Defaults ───────────────────────────────────────────────────────────────
console.log("\n1. Ships disabled and empty");
{
  const d = normalizeBrandConfig(null);
  ok("offer disabled, no package, no branding option", d.enabled === false && d.packages.length === 0 && d.brandingOptions.length === 0);
  ok("simulation disabled with every setting empty", d.simulation.enabled === false
    && ["startDelayHours", "dailyVolumeMin", "dailyVolumeMax", "confirmationDelayHours", "deliveryDelayHours"].every((k) => d.simulation[k] === null)
    && SIM_OUTCOMES.every((k) => d.simulation.distribution[k] === null) && d.simulation.activeSince === null);
  ok("affiliate sees only { enabled: false }", JSON.stringify(publicBrandOffer(d)) === JSON.stringify({ enabled: false }));
  ok("no refund terms ship", normalizeRefundTerms(null).published === null && normalizeRefundTerms(null).draft.text === "");
  ok("garbage stored data degrades safely", normalizeBrandConfig("x").enabled === false && normalizeBrandConfig([1]).packages.length === 0);
}

// ── 2. Packages = training access ─────────────────────────────────────────────
console.log("\n2. Package validation");
{
  ok("a complete package is valid", validateBrandConfig(cfg()).ok, JSON.stringify(validateBrandConfig(cfg()).errors));
  const codes = (over) => validateBrandConfig(cfg({ packages: [pkg(over)] })).errors;
  ok("invalid id", codes({ id: "Bad Id" })["packages.0.id"] === "INVALID_ID");
  ok("name required", codes({ name: " " })["packages.0.name"] === "INVALID_NAME");
  ok("price must be > 0", codes({ price: 0 })["packages.0.price"] === "INVALID_PRICE" && codes({ price: "" })["packages.0.price"] === "INVALID_PRICE");
  ok("price accepts numeric strings, rounded to 2 dp", validateBrandConfig(cfg({ packages: [pkg({ price: "99.999" })] })).value.packages[0].price === 100);
  ok("features: cleaned, de-duplicated, capped", JSON.stringify(validateBrandConfig(cfg({ packages: [pkg({ features: [" A ", "a", "", "B"] })] })).value.packages[0].features) === JSON.stringify(["A", "B"])
    && codes({ features: Array.from({ length: BRAND_LIMITS.MAX_FEATURES + 1 }, (_, i) => `f${i}`) })["packages.0.features"] === "TOO_MANY_FEATURES");
  ok("duplicate ids rejected", validateBrandConfig(cfg({ packages: [pkg(), pkg()] })).errors["packages.1.id"] === "DUPLICATE_ID");
  const keys = Object.keys(validateBrandConfig(cfg({ packages: [pkg({ inventoryQuantity: 5, guarantee: { enabled: true }, advertising: {}, tax: {} })] })).value.packages[0]).sort().join();
  ok("no inventory, unsold-stock guarantee or unknown field survives (only the pack's pieces + simulated price are added)", keys === "active,deliveryCost,description,features,id,logisticsCost,name,percentages,price,productCount,productIds,quantity,simulatedSellingPrice,sortOrder,vatPercent", keys);
  {
    const one = (o) => validateBrandConfig(cfg({ packages: [pkg(o)] }));
    const v = (o) => one(o).value.packages[0];
    ok("pack quantity (pieces): optional positive integer, independent of productCount",
      v({ quantity: 50 }).quantity === 50 && v({ quantity: "100" }).quantity === 100 && v({}).quantity === null && v({ quantity: "" }).quantity === null
      && one({ quantity: 0 }).errors["packages.0.quantity"] === "INVALID_QUANTITY" && one({ quantity: 2.5 }).errors["packages.0.quantity"] === "INVALID_QUANTITY"
      && v({ quantity: 50 }).productCount === v({}).productCount);
    ok("simulated selling price: optional, positive, may be below 65 MAD",
      v({ simulatedSellingPrice: 299 }).simulatedSellingPrice === 299 && v({ simulatedSellingPrice: "49.5" }).simulatedSellingPrice === 49.5 && v({}).simulatedSellingPrice === null
      && one({ simulatedSellingPrice: 0 }).errors["packages.0.simulatedSellingPrice"] === "INVALID_PRICE" && one({ simulatedSellingPrice: -5 }).errors["packages.0.simulatedSellingPrice"] === "INVALID_PRICE");
  }
  ok("branding option needs id + label", validateBrandConfig(cfg({ brandingOptions: [{ id: "opt-1", label: "" }] })).errors["brandingOptions.0.label"] === "INVALID_NAME");
  ok("enabled must be a boolean", validateBrandConfig(cfg({ enabled: "yes" })).errors.enabled === "INVALID_BOOLEAN");
}

// ── 3. Simulation settings ────────────────────────────────────────────────────
console.log("\n3. Simulation settings");
{
  const s = (over) => validateBrandConfig(cfg({ simulation: { ...SIM, ...over } }));
  ok("complete settings are valid and runnable", s({}).ok && isSimulationRunnable(s({}).value.simulation));
  ok("enabled requires every value", s({ startDelayHours: null }).errors["simulation.startDelayHours"] === "REQUIRED_WHEN_ENABLED"
    && s({ deliveryDelayHours: "" }).errors["simulation.deliveryDelayHours"] === "REQUIRED_WHEN_ENABLED");
  ok("distribution must total exactly 100 %", s({ distribution: { ...SIM.distribution, delivered: 41 } }).errors["simulation.distribution"] === "DISTRIBUTION_NOT_100");
  ok("…and needs every outcome", s({ distribution: { delivered: 100 } }).errors["simulation.distribution"] === "REQUIRED_WHEN_ENABLED");
  ok("integers only (percent / hours / volume)", s({ distribution: { ...SIM.distribution, delivered: 39.5, refused: 15.5 } }).errors["simulation.distribution.delivered"] === "INVALID_PERCENT"
    && s({ startDelayHours: 1.5 }).errors["simulation.startDelayHours"] === "INVALID_NUMBER");
  ok("volume max ≥ min and ≥ 1", s({ dailyVolumeMin: 10, dailyVolumeMax: 5 }).errors["simulation.dailyVolumeMax"] === "MAX_BELOW_MIN"
    && s({ dailyVolumeMin: 0, dailyVolumeMax: 0 }).errors["simulation.dailyVolumeMax"] === "VOLUME_REQUIRED");
  ok("final status delay ≥ confirmation delay", s({ confirmationDelayHours: 10, deliveryDelayHours: 2 }).errors["simulation.deliveryDelayHours"] === "DELIVERY_BEFORE_CONFIRMATION");
  ok("volume capped", s({ dailyVolumeMax: BRAND_LIMITS.MAX_DAILY_VOLUME + 1 }).errors["simulation.dailyVolumeMax"] === "INVALID_NUMBER");
  ok("disabled settings may stay partial", validateBrandConfig(cfg({ simulation: { enabled: false, startDelayHours: 2 } })).ok);
  ok("activeSince is never read from input", validateBrandConfig(cfg({ simulation: { ...SIM, activeSince: "2020-01-01T00:00:00Z" } })).value.simulation.activeSince === null);
  ok("not runnable while disabled", !isSimulationRunnable({ ...SIM, enabled: false }));
}

// ── 4. Offer projection ───────────────────────────────────────────────────────
console.log("\n4. What an affiliate can see");
{
  const c = normalizeBrandConfig({
    ...validateBrandConfig(cfg({
      packages: [pkg({ id: "b", sortOrder: 2 }), pkg({ id: "a", sortOrder: 1 }), pkg({ id: "off", active: false })],
      brandingOptions: [{ id: "o1", label: "Logo", active: true }, { id: "o2", label: "Caché", active: false }],
      simulation: SIM,
    })).value,
    updatedBy: "admin@x",
  });
  const offer = publicBrandOffer(c, CAT);
  ok("only active packages, in display order", offer.packages.map((p) => p.id).join() === "a,b");
  ok("package = name, description, features, price, product count, pieces, simulated price, products, breakdown",
    Object.keys(offer.packages[0]).sort().join() === "breakdown,description,features,id,name,price,productCount,products,quantity,simulatedSellingPrice");
  {
    const c2 = normalizeBrandConfig(validateBrandConfig(cfg({ packages: [pkg({ id: "q1", quantity: 50, simulatedSellingPrice: 299 }), pkg({ id: "q2", sortOrder: 1 })], simulation: SIM })).value);
    const o2 = publicBrandOffer(c2, CAT);
    ok("each offered pack carries its OWN pieces / simulated price (null when not configured)",
      o2.packages.find((x) => x.id === "q1").quantity === 50 && o2.packages.find((x) => x.id === "q1").simulatedSellingPrice === 299
      && o2.packages.find((x) => x.id === "q2").quantity === null && o2.packages.find((x) => x.id === "q2").simulatedSellingPrice === null);
    const none = publicBrandOffer(normalizeBrandConfig(validateBrandConfig(cfg({ packages: [pkg({ id: "x", active: false })], simulation: SIM })).value), CAT);
    ok("no active pack → empty list (nothing invented)", Array.isArray(none.packages) && none.packages.length === 0);
  }
  ok("no package offered without enough eligible products", publicBrandOffer(c, CAT.slice(0, 2)).packages.length === 0);
  ok("simulation settings and audit stamps never exposed", !("simulation" in offer) && !JSON.stringify(offer).includes("admin@x"));
  ok("inactive branding options hidden", offer.brandingOptions.map((o) => o.id).join() === "o1");
  ok("removedPackageIds", removedPackageIds({ packages: [{ id: "a" }, { id: "b" }] }, { packages: [{ id: "b" }] }).join() === "a");
}

// ── 4b. Catalogue and product selection rules ─────────────────────────────────
console.log("\n4b. Catalogue and product selection rules");
{
  ok("ships with an empty catalogue", normalizeBrandConfig(null).catalogProductIds.length === 0);
  const v = validateBrandConfig(cfg({ packages: [], catalogProductIds: [" p-1 ", "p-2", "p-1"] }));
  ok("catalogue ids trimmed and de-duplicated, order kept", v.ok && v.value.catalogProductIds.join() === "p-1,p-2");
  ok("invalid catalogue id refused", validateBrandConfig(cfg({ catalogProductIds: ["ok", "bad id"] })).errors.catalogProductIds === "INVALID_PRODUCT_ID"
    && validateBrandConfig(cfg({ catalogProductIds: [{ id: "x" }] })).errors.catalogProductIds === "INVALID_PRODUCT_ID");
  ok("catalogue must be a list, capped", validateBrandConfig(cfg({ catalogProductIds: "p-1" })).errors.catalogProductIds === "INVALID_LIST"
    && validateBrandConfig(cfg({ catalogProductIds: Array.from({ length: BRAND_LIMITS.MAX_CATALOG_PRODUCTS + 1 }, (_, i) => `p${i}`) })).errors.catalogProductIds === "TOO_MANY_PRODUCTS");
  ok("selection limits are 3 to 4", BRAND_LIMITS.MIN_SELECTED_PRODUCTS === 3 && BRAND_LIMITS.MAX_SELECTED_PRODUCTS === 4);
  ok("selection: 3 or 4 different ids accepted", normalizeProductSelection(["a", "b", "c"]).length === 3 && normalizeProductSelection(["a", "b", "c", "d"]).length === 4);
  ok("selection: 0, 2, 5, duplicates, non-strings refused", [[], ["a", "b"], ["a", "b", "c", "d", "e"], ["a", "a", "b"], ["a", "b", 3], null, "a,b,c", [{ id: "a" }, "b", "c"]]
    .every((x) => normalizeProductSelection(x) === null));
  const rows = [
    { id: "p-1", title: "Un", images: ["https://cdn/x.jpg"], status: "Active", isActive: true, isLocked: false, regularPrice: 99 },
    { id: "p-2", title: "Deux", images: [], status: "Draft", isActive: true, isLocked: false },
    { id: "p-3", title: "Trois", images: [], status: "Active", isActive: false, isLocked: false },
    { id: "p-4", title: "Quatre", images: [], status: "Active", isActive: true, isLocked: true },
    { id: "p-5", title: "Cinq", images: [{ url: "data:text/html,x" }], status: "Active", isActive: true, isLocked: false },
  ];
  const cat = eligibleCatalog({ catalogProductIds: ["p-5", "p-4", "p-3", "p-2", "p-1", "p-missing"] }, rows);
  ok("eligible = published + active + not locked; admin order; missing ids skipped", cat.map((p) => p.id).join() === "p-5,p-1");
  ok("catalogue view = id, title, image only (no price); unsafe image dropped", cat.every((p) => Object.keys(p).sort().join() === "id,image,title")
    && cat[0].image === null && cat[1].image === "https://cdn/x.jpg");
  ok("product rows are read without price / cost / stock columns", !Object.keys(CATALOG_PRODUCT_SELECT).some((k) => /price|cost|stock|supplier/i.test(k)));
  ok("isEligibleProduct / catalogProductView edge cases", !isEligibleProduct(null) && !isEligibleProduct({ id: "x", status: "Active", isActive: true, title: "  " })
    && catalogProductView({ id: "x", title: "<b>T</b>", images: ["/a.png"] }).image === "/a.png");
  const c = normalizeBrandConfig(validateBrandConfig(cfg()).value);
  ok("disabled offer carries no package", JSON.stringify(publicBrandOffer({ ...c, enabled: false }, CAT)) === JSON.stringify({ enabled: false }));
}

// ── 4c. Package pricing: completeness, validation, breakdown ──────────────────
console.log("\n4c. Package pricing");
{
  const codes = (over) => validateBrandConfig(cfg({ packages: [pkg(over)] })).errors;
  ok("an inactive package may be saved incomplete (draft)", validateBrandConfig(cfg({ packages: [{ id: "draft", name: "Brouillon", price: 10, active: false }] })).ok);
  for (const f of ["deliveryCost", "logisticsCost", "vatPercent", "productCount"]) {
    ok(`active package needs ${f}`, codes({ [f]: "" })[`packages.0.${f}`] === "REQUIRED_WHEN_ACTIVE");
  }
  for (const k of ["confirmation", "advertising", "companyShare"]) {
    ok(`active package needs ${k} % and its calculation base`, codes({ percentages: { ...PCT, [k]: { value: "", base: "" } } })[`packages.0.percentages.${k}.value`] === "REQUIRED_WHEN_ACTIVE"
      && codes({ percentages: { ...PCT, [k]: { value: 5 } } })[`packages.0.percentages.${k}.base`] === "REQUIRED_WHEN_ACTIVE");
  }
  ok("zero costs / zero VAT are valid when entered explicitly", validateBrandConfig(cfg({ packages: [pkg({ deliveryCost: 0, logisticsCost: "0", vatPercent: 0 })] })).ok);
  ok("negative or non-numeric amounts refused", codes({ deliveryCost: -1 })["packages.0.deliveryCost"] === "INVALID_AMOUNT" && codes({ logisticsCost: "abc" })["packages.0.logisticsCost"] === "INVALID_AMOUNT");
  ok("percentages: 0–100, at most 2 decimals", codes({ vatPercent: 101 })["packages.0.vatPercent"] === "INVALID_PERCENT" && codes({ vatPercent: -1 })["packages.0.vatPercent"] === "INVALID_PERCENT"
    && codes({ vatPercent: 20.125 })["packages.0.vatPercent"] === "INVALID_PERCENT" && validateBrandConfig(cfg({ packages: [pkg({ vatPercent: 7.25 })] })).ok);
  ok("unknown calculation base refused", codes({ percentages: { ...PCT, advertising: { value: 5, base: "REVENUE" } } })["packages.0.percentages.advertising.base"] === "INVALID_BASE");
  ok("shares on one money base cannot exceed 100 %", codes({ percentages: { ...PCT, advertising: { value: 80, base: "SUBTOTAL" } } })["packages.0.percentages"] === "PERCENT_SUM_OVER_100"
    && validateBrandConfig(cfg({ packages: [pkg({ percentages: { ...PCT, confirmation: { value: 100, base: "SIMULATED_ORDERS" } } })] })).ok);
  ok("product count must be 3 or 4", codes({ productCount: 2 })["packages.0.productCount"] === "INVALID_PRODUCT_COUNT" && codes({ productCount: 5 })["packages.0.productCount"] === "INVALID_PRODUCT_COUNT"
    && validateBrandConfig(cfg({ packages: [pkg({ productCount: 4, productIds: ["p-1", "p-2", "p-3", "p-4"] })] })).ok);
  ok("an active package lists at least its product count", codes({ productCount: 4 })["packages.0.productIds"] === "NOT_ENOUGH_PRODUCTS");
  ok("package products must come from the catalogue", codes({ productIds: ["p-1", "p-2", "nope"] })["packages.0.productIds"] === "PRODUCT_NOT_IN_CATALOGUE"
    && codes({ productIds: ["p-1", "bad id", "p-2"] })["packages.0.productIds"] === "INVALID_PRODUCT_ID");
  ok("an incomplete stored package is never offered", publicBrandOffer(normalizeBrandConfig({ ...cfg(), packages: [pkg({ vatPercent: null })] }), CAT).packages.length === 0);

  const b = packageBreakdown({ price: 321.5, deliveryCost: 35, logisticsCost: 12.25, vatPercent: 20, productCount: 3, percentages: PCT });
  ok("subtotal = price + delivery + logistics", b.subtotal === 368.75);
  ok("VAT = VAT % × subtotal (rounded to the centime)", b.vat.amount === 73.75 && b.vat.base === "SUBTOTAL" && b.vat.percent === 20);
  ok("total = subtotal + VAT", b.total === 442.5);
  const inf = Object.fromEntries(b.informational.map((x) => [x.key, x]));
  ok("informational % shown with its base amount, never added to the total", inf.advertising.baseAmount === 321.5 && inf.advertising.amount === 40.19
    && inf.companyShare.baseAmount === 368.75 && inf.companyShare.amount === 110.63 && b.informational.every((x) => x.addedToTotal === false) && b.total === 442.5);
  ok("a rate over simulated orders has no money amount", inf.confirmation.baseAmount === null && inf.confirmation.amount === null && inf.confirmation.percent === 60);
  ok("a share of the total uses the VAT-inclusive total as base", packageBreakdown({ ...pkg(), percentages: { ...PCT, advertising: { value: 10, base: "TOTAL_WITH_VAT" } } })
    .informational.find((x) => x.key === "advertising").baseAmount === 442.5);
  ok("centime-exact (no float drift)", packageBreakdown({ ...pkg(), price: 0.1, deliveryCost: 0.2, logisticsCost: 0, vatPercent: 0 }).total === 0.3);
  ok("incomplete package → no breakdown; missing fields listed", packageBreakdown({ ...pkg(), deliveryCost: null }) === null
    && missingPricingFields({ ...pkg(), deliveryCost: null, percentages: {} }).join() === "deliveryCost,percentages.confirmation.value,percentages.confirmation.base,percentages.advertising.value,percentages.advertising.base,percentages.companyShare.value,percentages.companyShare.base");
  ok("no business value hardcoded in the pricing rules", !/\b(20|10|7|14)\s*[,)]/.test(read("../src/lib/brandPricing.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\* 100|\/ 100|10000/g, "")));
}

// ── 5. Refund terms rules + brand name ────────────────────────────────────────
console.log("\n5. Refund terms and brand name rules");
{
  const t = normalizeRefundTerms({ draft: { text: "brouillon" }, published: { version: 2, text: "publiées", publishedAt: "2026-10-28T00:00:00Z" } });
  ok("public view = published version only (never the draft)", JSON.stringify(publicRefundTerms(t)) === JSON.stringify({ version: 2, text: "publiées", publishedAt: "2026-10-28T00:00:00.000Z" }));
  ok("a published entry without text is ignored", normalizeRefundTerms({ published: { version: 1, text: "" } }).published === null);
  ok("draft must be a string, length capped", !validateTermsDraft({ text: 5 }).ok && !validateTermsDraft({ text: "x".repeat(BRAND_LIMITS.TERMS_MAX + 1) }).ok && validateTermsDraft({ text: "" }).ok);
  ok("brand name: trimmed, any script", normalizeBrandName("  Ma   Marque ") === "Ma Marque" && normalizeBrandName("علامتي") === "علامتي");
  ok("brand name: length and characters enforced", normalizeBrandName("a") === null && normalizeBrandName("x".repeat(BRAND_LIMITS.BRAND_NAME_MAX + 1)) === null
    && normalizeBrandName("<script>") === null && normalizeBrandName("Bad/Name") === null);
  ok("client request id format", isValidClientRequestId("3f2b8c1e-aaaa-bbbb-cccc-1234567890ab") && !isValidClientRequestId("x") && !isValidClientRequestId("bad id!!"));
}

// ── 6. Saving the config (service + handlers) ─────────────────────────────────
console.log("\n6. Saving the configuration");
{
  const db = makeBrandFakeDb();
  const T = db._tables;
  let clock = new Date("2026-10-28T10:00:00Z");
  const h = adminBrandHandlers({ db, now: () => clock });

  const r1 = await h.putConfig(req(cfg()), {}, admin);
  ok("valid config → 200", r1.status === 200);
  ok("stored with audit stamps from the session", T.setting[0].data.updatedBy === "admin-1" && T.setting[0].data.updatedAt === "2026-10-28T10:00:00.000Z");
  ok("audit row CONFIG_UPDATE in the same transaction", T.brandAuditLog.length === 1 && T.brandAuditLog[0].action === "CONFIG_UPDATE" && T.brandAuditLog[0].actorId === "admin-1");

  clock = new Date("2026-10-28T11:00:00Z");
  await h.putConfig(req(cfg({ simulation: SIM })), {}, admin);
  ok("switching the simulation on stamps activeSince (server time)", T.setting[0].data.simulation.activeSince === "2026-10-28T11:00:00.000Z");
  clock = new Date("2026-10-28T12:00:00Z");
  await h.putConfig(req(cfg({ simulation: { ...SIM, dailyVolumeMax: 12, activeSince: "1999-01-01T00:00:00Z" } })), {}, admin);
  ok("…kept on later saves, never taken from the body", T.setting[0].data.simulation.activeSince === "2026-10-28T11:00:00.000Z");
  await h.putConfig(req(cfg({ simulation: { ...SIM, enabled: false } })), {}, admin);
  clock = new Date("2026-10-28T15:00:00Z");
  await h.putConfig(req(cfg({ simulation: SIM })), {}, admin);
  ok("re-enabling stamps a new activeSince (paused period never filled in)", T.setting[0].data.simulation.activeSince === "2026-10-28T15:00:00.000Z");

  const audits = T.brandAuditLog.length;
  const before = structuredClone(T.setting[0].data);
  const bad = await h.putConfig(req(cfg({ packages: [pkg(), pkg({ id: "pack-b", price: -5 })] })), {}, admin);
  const badBody = await bad.json();
  ok("invalid config → 400 INVALID_INPUT with per-field codes", bad.status === 400 && badBody.code === "INVALID_INPUT" && badBody.errors["packages.1.price"] === "INVALID_PRICE");
  ok("…nothing written, no audit row", JSON.stringify(T.setting[0].data) === JSON.stringify(before) && T.brandAuditLog.length === audits);

  const removed = await h.putConfig(req(cfg({ packages: [] })), {}, admin);
  ok("removing a saved package → 409 PACKAGE_REMOVED", removed.status === 409 && (await removed.json()).code === "PACKAGE_REMOVED");
  ok("…rolled back: package still stored, no audit row", T.setting[0].data.packages.length === 1 && T.brandAuditLog.length === audits);
  ok("deactivating it is allowed", (await h.putConfig(req(cfg({ packages: [pkg({ active: false })] })), {}, admin)).status === 200);

  ok("malformed JSON → 400", (await h.putConfig(req("{oops"), {}, admin)).status === 400);
  ok("GET returns the stored config", (await (await h.getConfig(new Request("http://x"), {}, admin)).json()).packages[0].id === "pack-a");
  ok("getBrandConfig on an empty DB = disabled defaults", (await getBrandConfig(makeBrandFakeDb())).enabled === false);
  const boom = adminBrandHandlers({ db: { ...makeBrandFakeDb({ strict: false }), $transaction: async () => { throw new Error("db password=secret"); } } });
  const r500 = await boom.putConfig(req(cfg()), {}, admin);
  const b500 = await r500.json();
  ok("unexpected error → generic 500 without internals", r500.status === 500 && b500.code === "SERVER_ERROR" && !JSON.stringify(b500).includes("secret"));
  ok("only brand tables touched", !db._stats.log.some((l) => l.startsWith("FORBIDDEN")));
}

// ── 7. Refund terms workflow ──────────────────────────────────────────────────
console.log("\n7. Refund terms: draft → admin approval → published");
{
  const db = makeBrandFakeDb({ affiliates: [{ id: "a1", username: "a1" }], settings: { [BRAND_SETTING_ID]: cfg() } });
  const T = db._tables;
  const h = adminBrandHandlers({ db, now: () => new Date("2026-10-28T10:00:00Z") });
  const aff = affiliateBrandHandlers({ db });
  const overview = async () => (await aff.overview(new Request("http://x"), {}, { affiliateId: "a1" })).json();

  ok("publishing an empty draft is refused (nothing is pre-written)", (await h.publishTerms(new Request("http://x", { method: "POST" }), {}, admin)).status === 409);
  await h.putTermsDraft(new Request("http://x", { method: "PUT", body: JSON.stringify({ text: "Conditions v1 (test)" }) }), {}, admin);
  ok("a saved draft is NOT visible to affiliates", (await overview()).terms === null);
  const p1 = await (await h.publishTerms(new Request("http://x", { method: "POST" }), {}, admin)).json();
  ok("admin approval publishes version 1", p1.published.version === 1 && p1.published.publishedBy === "admin-1");
  ok("affiliates now see version 1", (await overview()).terms?.version === 1);
  ok("publishing the same text again → 409 TERMS_UNCHANGED", (await (await h.publishTerms(new Request("http://x", { method: "POST" }), {}, admin)).json()).code === "TERMS_UNCHANGED");
  await saveRefundTermsDraft({ text: "Conditions v2 (test)" }, { db, actorId: "admin-1" });
  ok("editing the draft leaves version 1 published", (await getRefundTerms(db)).published.version === 1 && (await overview()).terms.text === "Conditions v1 (test)");
  ok("publishing again → version 2", (await publishRefundTerms({ db, actorId: "admin-2" })).published.version === 2);
  ok("each step audited", T.brandAuditLog.map((a) => a.action).join() === "TERMS_DRAFT_UPDATE,TERMS_PUBLISHED,TERMS_DRAFT_UPDATE,TERMS_PUBLISHED");
  ok("draft text must be a string → 400", (await h.putTermsDraft(new Request("http://x", { method: "PUT", body: JSON.stringify({ text: 3 }) }), {}, admin)).status === 400);
  ok("terms hidden while the offer is disabled", await (async () => {
    const db2 = makeBrandFakeDb({ affiliates: [{ id: "a1", username: "a1" }], settings: { [BRAND_TERMS_SETTING_ID]: { published: { version: 1, text: "x" } } } });
    return (await (await affiliateBrandHandlers({ db: db2 }).overview(new Request("http://x"), {}, { affiliateId: "a1" })).json()).terms === null;
  })());
}

// ── 8. Routes, settings reservation, sidebar ──────────────────────────────────
console.log("\n8. Routes and admin wiring");
{
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n === "route.js" ? [p] : [];
  });
  const check = (dir, wrapper, handlers) => {
    const files = walk(new URL(dir, import.meta.url).pathname);
    let wrapped = 0, total = 0;
    const unknown = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/^export (async )?function (GET|POST|PUT|PATCH|DELETE)/m.test(src)) unknown.push(`unwrapped:${f}`);
      for (const m of src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*(.+);$/gm)) {
        total++;
        const w = m[2].match(new RegExp(`^${wrapper}\\(h\\.(\\w+)\\)$`));
        if (w) { wrapped++; if (!handlers.includes(w[1])) unknown.push(w[1]); }
      }
    }
    return { files: files.length, wrapped, total, unknown };
  };
  const a = check("../src/app/api/admin/brand/", "withAdminAuth", Object.keys(adminBrandHandlers({ db: makeBrandFakeDb() })));
  ok(`admin brand routes all withAdminAuth-wrapped (${a.wrapped}/${a.total} in ${a.files} files)`, a.files === 11 && a.total === 14 && a.wrapped === a.total && a.unknown.length === 0, JSON.stringify(a));
  const f = check("../src/app/api/affiliate/brand/", "withAffiliateAuth", Object.keys(affiliateBrandHandlers({ db: makeBrandFakeDb() })));
  ok(`affiliate brand routes all withAffiliateAuth-wrapped (${f.wrapped}/${f.total} in ${f.files} files)`, f.files === 6 && f.total === 7 && f.wrapped === f.total && f.unknown.length === 0, JSON.stringify(f));

  const { upsertSettingsHandler } = await import("../src/lib/controllers/settingsController.js");
  for (const id of [BRAND_SETTING_ID, BRAND_TERMS_SETTING_ID]) {
    const res = await upsertSettingsHandler(new Request(`http://x/api/setting?type=${id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, published: { version: 9, text: "x" } }),
    }));
    ok(`POST /api/setting?type=${id} → 400 (cannot bypass validation / approval)`, res.status === 400 && /page dédiée/.test((await res.json()).error || ""));
  }
  const sidebar = read("../src/components/admin/SideBar.jsx");
  ok("exactly one sidebar link to /admin/brand", (sidebar.match(/href: "\/admin\/brand"/g) || []).length === 1);
  ok("the old catalogue tab is gone", !existsSync(new URL("../src/app/admin/brand/CatalogTab.jsx", import.meta.url)));
  const productsTab = read("../src/app/admin/brand/ProductsTab.jsx");
  ok("admin catalogue picker reads /api/admin/brand/products and saves ids only via the config",
    /api\("\/api\/admin\/brand\/products"\)/.test(productsTab) && /catalogProductIds/.test(productsTab) && !/method: "(PUT|POST|DELETE)"/.test(productsTab) && !/\/api\/products/.test(productsTab));
}

// ── 9. Navigation: Booster → Create Your Own Brand ────────────────────────────
console.log("\n9. Navigation swap");
{
  const page = read("../src/app/affiliate/dashboard/page.jsx");
  const block = (name) => (page.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n  \\];`)) || [])[1] || "";
  const moreTabs = [...block("moreItems").matchAll(/tab: "([a-z]+)"/g)].map((m) => m[1]);
  const desktopTabs = [...block("tabs").matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
  ok("mobile More sheet: same order, brand where Booster was", moreTabs.join() === "orders,brand,rewards,ugc,team,payout,deposit,bank,notifications,settings", moreTabs.join());
  ok("desktop tab bar: same order, brand where Booster was", desktopTabs.join() === "overview,orders,bank,payout,deposit,brand,rewards,ugc,notifications,team,settings", desktopTabs.join());
  ok("no Booster menu entry left, exactly one brand entry per menu",
    !moreTabs.includes("booster") && !desktopTabs.includes("booster") && (page.match(/tab: "brand"/g) || []).length === 1 && (page.match(/id: "brand"/g) || []).length === 1);
  ok("brand tab renders the new page", /activeTab === "brand" && <BrandTab \/>/.test(page));
  ok("existing boosters stay reachable from the overview widget",
    /activeTab === "booster" && <BoosterTab onRecharge=\{goToDeposit\} \/>/.test(page) && /onClick=\{\(\) => setActiveTab\("booster"\)\}/.test(page));
}

// ── 10. Texts ─────────────────────────────────────────────────────────────────
console.log("\n10. Texts and labelling");
{
  const fr = Object.keys(BRAND_TEXT.fr).sort(), ar = Object.keys(BRAND_TEXT.ar).sort();
  ok("FR and AR have the same keys", fr.join() === ar.join());
  ok("every simulated status has a label in both languages", SIM_STATUSES.every((s) => BRAND_TEXT.fr[`status_${s}`] && BRAND_TEXT.ar[`status_${s}`]));
  const handlerSrc = read("../src/lib/brandRouteHandlers.js");
  const statusBlock = handlerSrc.match(/const STATUS = \{([\s\S]*?)\};/)[1];
  const affiliateCodes = [...statusBlock.matchAll(/^\s+(\w+):/gm)].map((m) => m[1])
    .filter((c) => ![
      "PAYMENT_REFERENCE_REQUIRED", "REASON_REQUIRED", "INVALID_ACTION", "PACKAGE_REMOVED", "TERMS_EMPTY", "TERMS_UNCHANGED", // admin only
      "AFFILIATE_NOT_FOUND", "AUTHORIZATION_NOT_FOUND", "AUTHORIZATION_EXISTS", "NO_CLOSED_ACCESS", "NOT_REVOCABLE", "NOT_ACTIVE", "NOT_CLOSED", "PROOF_NOT_SUBMITTED",
    ].includes(c));
  ok("every affiliate-facing error code has a label in both languages", affiliateCodes.every((c) => BRAND_TEXT.fr[`code_${c}`] && BRAND_TEXT.ar[`code_${c}`]),
    affiliateCodes.filter((c) => !BRAND_TEXT.fr[`code_${c}`]).join());
  const texts = JSON.stringify(BRAND_TEXT);
  ok("no figure in the texts (prices, delays and sizes are interpolated)", !/\d/.test(texts.replace(/\{\w+\}/g, "")));
  ok("disclosures present: simulated data, no real sales, no earnings, nothing withdrawable",
    /simulés/.test(BRAND_TEXT.fr.what_simulated) && /aucun gain/.test(BRAND_TEXT.fr.what_no_earnings) && /retirable/.test(BRAND_TEXT.fr.what_no_earnings)
    && /simulées/.test(BRAND_TEXT.fr.dash_disclaimer) && BRAND_TEXT.ar.what_no_earnings.length > 10 && BRAND_TEXT.ar.dash_disclaimer.length > 10);
  ok("no unsold-inventory refund promise left in the texts", !/invendu|unsold|غير مُباعة/.test(texts));
  ok("product-count error label interpolates the package's count in both languages", /\{n\}/.test(BRAND_TEXT.fr.code_INVALID_PRODUCT_SELECTION) && /\{n\}/.test(BRAND_TEXT.ar.code_INVALID_PRODUCT_SELECTION));
  const tab = read("../src/app/affiliate/dashboard/BrandTab.jsx");
  const stats = read("../src/components/brand/BrandSimStats.jsx");
  const dashUi = read("../src/app/affiliate/dashboard/_brand/BrandDashboard.jsx");
  ok("offer always shows what is bought; dashboard shows the disclaimer + badges",
    /<WhatYouBuy t=\{t\} \/>/.test(tab) && /t\("dash_disclaimer"\)/.test(dashUi) && (stats.match(/<SimulatedBadge t=\{t\} \/>/g) || []).length === 2);
  ok("the affiliate page has no hardcoded price or delay", !/\b(8[\s.,]?000|10[\s.,]?000|90\s?%|72\s?h)\b/.test(tab));
  ok("products disclosure present (training only, no real order, no stock)", /simulation/.test(BRAND_TEXT.fr.products_training_note)
    && /aucune vraie commande/.test(BRAND_TEXT.fr.products_training_note) && BRAND_TEXT.ar.products_training_note.length > 10);

  // Affiliate tab flow + separation from real earnings (static: the tab is a client component).
  const stepOrder = ["step === 0", "step === 1", "step === 2", "step === 3"].map((k) => tab.indexOf(k));
  const at = (k) => tab.indexOf(k);
  ok("flow order: package → products → brand name → review + Buy Now", stepOrder.every((i) => i > 0) && stepOrder.every((v, i) => i === 0 || stepOrder[i - 1] < v)
    && at('t("package_title")') < at('t("products_title")') && at('t("products_title")') < at('t("brand_name")') && at('t("brand_name")') < at('t("buy_now")'));
  {
    const card = tab.slice(tab.indexOf("function PackCard("), tab.indexOf("function PackDetailsSheet("));
    const screenA = tab.slice(tab.indexOf("if (step === 0) {"), tab.indexOf("// ── Screen B"));
    ok("pack cards: every offered pack shown (no hard-coded pack), each with its own image, name, product count, pieces, price, total, availability, features",
      /\{packages\.map\(\(p\) => \(\s*<PackCard key=\{p\.id\} p=\{p\}/.test(screenA) && ["p.name", "p.productCount", "p.quantity", "p.price", "p.breakdown.total", "p.features", "p.description", 'pack_available'].every((k) => card.includes(k))
      && /\(p\.products \|\| \[\]\)\.find\(\(x\) => x\.image\)\?\.image/.test(card) && !/Pack (Starter|Pro|Business)|2[,.]?500|3[,.]?500|4[,.]?500/.test(tab));
    const sheet = tab.slice(tab.indexOf("function PackDetailsSheet("), tab.indexOf("const STEPS = ["));
    ok("details of THAT pack in a sheet (breakdown, products, pieces, simulated price; closes on ✕ / Escape); the card itself never expands",
      /<Breakdown b=\{p\.breakdown\}/.test(sheet) && /<ProductList products=\{p\.products\} \/>/.test(sheet)
      && /p\.simulatedSellingPrice \? money\(p\.simulatedSellingPrice\) : "—"/.test(sheet) && /p\.quantity \?\? "—"/.test(sheet) && /e\.key === "Escape"/.test(sheet)
      && /\{detailsPack && <PackDetailsSheet p=\{detailsPack\}/.test(screenA) && !/Breakdown|data-pack-details=|\{open &&/.test(card.slice(0, card.indexOf("function PackDetailsSheet("))));
    ok("no pack pre-selected; selecting changes the selection; selected card = purple border + check",
      /const \[packageId, setPackageId\] = useState\(null\);/.test(tab) && !/setPackageId\(packages\[0\]/.test(tab) && /on \? "border-violet-600/.test(card) && /\{on && <span[^>]*data-check/.test(card)
      && /aria-checked=\{on\}/.test(card));
    ok("one start button: disabled until a pack is selected, continues with the selected pack only (server re-validates the pack id)",
      /onClick=\{\(\) => \{ setError\(null\); setStep\(1\); \}\} disabled=\{!pkg\} data-start/.test(screenA) && /packageId: pkg\.id/.test(tab)
      && /pkg \? t\("start_with_pack"\) : t\("select_pack_first"\)/.test(screenA) && /data-no-packs>\{t\("no_packages"\)\}/.test(screenA));
    ok("no invented claims from the reference image (refund %, guarantee, best seller, no stock)",
      !/استرجاع ?٪?%? ?90|90 ?%|ضمان|الأكثر طلبا|bestseller|best seller|garantie|بدون مخزون/i.test(tab + JSON.stringify(BRAND_TEXT)));
  }
  ok("review shows the breakdown; pending shows the snapshot breakdown", /<Breakdown b=\{pkg\.breakdown\}/.test(tab) && /<Breakdown b=\{access\.package\.breakdown\}/.test(tab));
  ok("Buy Now never sends an amount", !/amount|price|total/.test(tab.slice(at("body: {"), at("clientRequestId: requestId.current"))));
  ok("Buy Now sends product ids only (no product names or prices)", /productIds: chosen\.map\(\(p\) => p\.id\)/.test(tab) && !/price: p\.|title: p\./.test(tab.slice(tab.indexOf("const buy"), tab.indexOf("const nav"))));
  ok("selection capped in the UI at the package's count, Continue needs exactly that count", /cur\.length >= need \? cur/.test(tab) && /chosen\.length === need/.test(tab) && /nav\(countOk\)/.test(tab));
  ok("pending and active views show the brand name and the selected products",
    (tab.match(/<ProductList products=\{access\.products\} \/>/g) || []).length === 1 && /access\.brandName/.test(tab)
    && /<MyPack breakdown=\{access\.package\?\.breakdown\} t=\{t\}/.test(dashUi) && /access\.brandName/.test(dashUi)
    && !/data-pack-products|PackThumb/.test(dashUi) && !/function MyProducts|<MyProducts/.test(dashUi));
  {
    const myPack = dashUi.slice(dashUi.indexOf("function MyPack("), dashUi.indexOf("export default function BrandDashboard("));
    const hero = dashUi.slice(dashUi.indexOf("function Hero("), dashUi.indexOf("function SimFinance("));
    ok("hero: selected product image (request snapshot selectedProducts[0]) opens a lightbox; none in the training pack card",
      /<HeroImage src=\{access\.products\?\.\[0\]\?\.image \|\| null\} d=\{d\} \/>/.test(hero) && !/<img|Thumb|image/.test(myPack)
      && /onClick=\{\(\) => setOpen\(true\)\}/.test(dashUi) && /<Lightbox src=\{src\}/.test(dashUi) && /object-contain/.test(dashUi.slice(dashUi.indexOf("function Lightbox("), dashUi.indexOf("function HeroImage(")))
      && /if \(!src \|\| failed\)/.test(dashUi)
      // Escape: the lightbox registers with the shared overlay stack (Escape closes the TOPMOST overlay only)
      && /^  useOverlay\(onClose\);$/m.test(dashUi.slice(dashUi.indexOf("function Lightbox("), dashUi.indexOf("function HeroImage(")))
      && /if \(e\.key !== "Escape" \|\| overlayStack\[overlayStack\.length - 1\] !== id\) return;/.test(dashUi.slice(dashUi.indexOf("function useOverlay("), dashUi.indexOf("function Thumb("))));
    ok("hero: pieces chip from the pack quantity frozen in the request (never productCount, never hard-coded); unknown → —",
      /const qty = access\.package\?\.quantity;/.test(hero) && /d\("hero_quantity", \{ n: qty\.toLocaleString\(locale\) \}\)/.test(hero) && /d\("hero_quantity_unknown"\)/.test(hero)
      && !/\.productCount/.test(hero) && !/hero_no_stock/.test(dashUi) && /d\("hero_training"\)/.test(hero));
    const acc = read("../src/lib/services/brandAccessService.js");
    ok("quantity + simulated price frozen in NEW request snapshots; public view reads the snapshot only (no live pack fallback)",
      /quantity: pkg\.quantity \?\? null, simulatedSellingPrice: pkg\.simulatedSellingPrice \?\? null,/.test(acc)
      && /quantity: Number\.isInteger\(pkg\.quantity\) && pkg\.quantity > 0 \? pkg\.quantity : null,/.test(acc));
  }
  const apiCalls = [...tab.matchAll(/["`](\/api\/[^"`?$]*)/g)].map((m) => m[1]);
  ok("the tab only calls brand APIs + reads the bank details (never real account figures, store products, orders, payouts or wallet)",
    apiCalls.length > 0 && apiCalls.every((u) => u.startsWith("/api/affiliate/brand") || u === "/api/setting")
    && [...tab.matchAll(/["`]\/api\/setting([^"`]*)["`]/g)].map((m) => m[1]).join() === "?type=bank-settings", apiCalls.join());
  ok("no /api/affiliate/me and no /api/products read in the brand tab; 'see all' pages come from the same dashboard API",
    !/\/api\/affiliate\/me|\/api\/products/.test(tab)
    && /call\(`\/api\/affiliate\/brand\/dashboard\?window=\$\{w\}&page=\$\{page\}\$\{asOf \? `&asOf=\$\{encodeURIComponent\(asOf\)\}` : ""\}\$\{listId \? `&list=\$\{listId\}` : ""\}`\)/.test(tab)
    && /const loadPage = useCallback\(async \(page, asOf, win, listId\) =>/.test(tab) && /const w = win \|\| windowKey;/.test(tab)
    && (tab.match(/\/api\/affiliate\/brand\/dashboard/g) || []).length === 2);
  ok("the proof is uploaded to the BRAND proof route (never the deposit route)", /\/api\/affiliate\/brand\/access\/\$\{encodeURIComponent\(access\.id\)\}\/proof/.test(tab) && !/\/api\/affiliate\/deposits/.test(tab));
  ok("no wallet / earnings / commission code imported by the tab", !/balance|wallet|commission|payout|earning/i.test(tab.split("\n").filter((l) => l.startsWith("import")).join("\n")));
  ok("no real-profit, refund-guarantee or withdrawal promise in the brand UI", ![tab, stats, dashUi].map((src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).some((src) => /أرباح حقيقية|ضمان استرجاع|سحب الأرباح|withdraw|retirer vos gains|profits? r[ée]els?/i.test(src))
    && !/(guarantee|garantie|ضمان)/i.test(JSON.stringify(BRAND_TEXT)));
  ok("every simulated block is badged (analytics, latest orders, dashboard disclaimer; each order row tagged)",
    (stats.match(/<SimulatedBadge t=\{t\} \/>/g) || []).length === 2 && (dashUi.match(/<SimulatedBadge t=\{t\} \/>/g) || []).length === 3
    && /data-recent/.test(dashUi) && (dashUi.match(/d\("sim_tag"\)/g) || []).length === 2 && /<BrandDashboard /.test(tab));
  ok("pack summary shows only the pack price, labelled as not earnings", /package_costs_note/.test(dashUi) && /pas un gain/.test(BRAND_TEXT.fr.package_costs_note) && /رصيدك/.test(BRAND_TEXT.ar.package_costs_note)
    && /t\("bd_price"\)/.test(dashUi) && !/bd_total|bd_vat|bd_delivery|bd_logistics|b\.total|b\.vat|deliveryCost|logisticsCost/.test(dashUi));
  {
    const code = dashUi.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ok("dashboard UI calls no API (data comes from BrandTab's brand + dashboard calls)", !/fetch\(|\/api\//.test(code));
    ok("money shown is the API's simulated money only (per order: o.money / order.money; totals: stats.money + finance.balance); no stock / availability",
      !/gain|stock|availab|disponib/i.test(code) && /m=\{o\.money\}/.test(code) && /m=\{order\.money\}/.test(code)
      && /finance \? finance\.balance : null/.test(code) && /finance \? stats\?\.money\?\.profit : null/.test(code) && /finance \? stats\?\.money\?\.revenue : null/.test(code)
      && !/[-+*/]\s*(m|o\.money|stats\?\.money)\b|\.net\s*[-+*/]|\.price\s*[-+*/]/.test(code));
    ok("simulated finance (balance / profit / revenue) sits inside Analytics & Performance, no separate finance cards",
      /<SimFinance stats=\{stats\} finance=\{finance\} d=\{d\} money=\{money\} \/>/.test(code.slice(code.indexOf("function Analyses("), code.indexOf("function OrderMoney(")))
      && !/function Finance\(|<Finance /.test(code) && /finance=\{dash\.finance \|\| null\}/.test(code));
    ok("simulated figures labelled as training: badge + note (never credited / never withdrawable); no price → — and an explanation",
      /d\("fin_note"\)/.test(code) && /d\("fin_no_price"\)/.test(code) && /simul/i.test(DASHBOARD_TEXT.fr.fin_balance) && /التجريبي/.test(DASHBOARD_TEXT.ar.fin_balance)
      && /jamais retirables/.test(DASHBOARD_TEXT.fr.fin_note) && /لا يمكن سحبها/.test(DASHBOARD_TEXT.ar.fin_note));
    ok("order card: product, reference, status, time, simulated price, expenses and net (green when realized, 'expected' otherwise)",
      ["data-order-ref", "data-order-time", "data-order-money", "data-order-net"].every((k) => code.includes(k)) && /<StatusChip status=\{o\.status\}/.test(code)
      && /m\.kind === "realized" \? \{ label: d\("fin_net"\), value: money\(m\.net\), cls: m\.net < 0 \? "text-red-600" : "text-green-600" \}/.test(code)
      && /: \{ label: d\("fin_expected"\), value: money\(m\.net\), cls: "text-amber-600" \}/.test(code) && !/fin_none/.test(code + JSON.stringify(DASHBOARD_TEXT)));
    {
      // W2: refused / returned / no response / cancelled → no price, no expense, no profit at all (display only)
      const om = code.slice(code.indexOf("const NO_AMOUNT_STATUSES"), code.indexOf("function OrderCard("));
      const early = om.slice(om.indexOf("if (NO_AMOUNT_STATUSES.includes(status))"), om.indexOf("const n = (v)"));
      ok("non-qualifying statuses (refused, returned, noResponse, cancelled) show only a 'no amount' note — returned before any price / expense / net is built",
        /const NO_AMOUNT_STATUSES = \["refused", "returned", "noResponse", "cancelled"\];/.test(om)
        && /return <p[^>]*data-order-no-amount>\{d\("fin_no_amount"\)\}<\/p>;/.test(early) && !/money\(|fin_price|fin_exp|fin_net|fin_expected|−/.test(early)
        && /<OrderMoney m=\{o\.money\} status=\{o\.status\}/.test(code) && /<OrderMoney m=\{order\.money\} status=\{order\.status\}/.test(code));
      ok("the 'no amount' note is FR / AR, carries no figure, and keeps the simulation wording",
        /Aucun montant/.test(DASHBOARD_TEXT.fr.fin_no_amount) && /لا يوجد أي مبلغ/.test(DASHBOARD_TEXT.ar.fin_no_amount)
        && /simulée/.test(DASHBOARD_TEXT.fr.fin_no_amount) && /التجريبي/.test(DASHBOARD_TEXT.ar.fin_no_amount) && !/\d/.test(DASHBOARD_TEXT.fr.fin_no_amount + DASHBOARD_TEXT.ar.fin_no_amount));
    }
    ok("see all: full list of the selected period, frozen when opened (same asOf + period on every page), from the same dashboard API",
      /data-see-all/.test(code) && /<AllOrdersSheet first=\{dash\.orders\} loadPage=\{loadPage\}/.test(code)
      && /const \[frozen\] = useState\(\(\) => \(\{ asOf: first\?\.asOf \|\| null, window: first\?\.window \|\| null, listId: first\?\.listId \|\| null, total: first\?\.total \|\| 0 \}\)\);/.test(code)
      && /await loadPage\(page \+ 1, frozen\.asOf, frozen\.window, frozen\.listId\)/.test(code) && /const total = frozen\.total;/.test(code)
      && (code.match(/loadPage\(/g) || []).length === 1 && /if \(!next\?\.items\) \{ setExpired\(true\); return; \}/.test(code)
      && /!seen\.has\(o\.ref\)/.test(code) && /data-all-expired>\{d\("all_expired"\)\}/.test(code));
    ok("every brand image falls back to the package icon (no broken image)", /src && !failed \? <img/.test(code) && (code.match(/onError=\{\(\) => setFailed\(true\)\}/g) || []).length === 2);
    ok("status cards: total + one card per simulated status (they add up to the total), in the requested order",
      ["total", "confirmed", "inDelivery", "delivered", "refused", "noResponse", "cancelled", "returned", "pending"].join()
        === [...code.slice(code.indexOf("const kpis = ["), code.indexOf("];", code.indexOf("const kpis = ["))).matchAll(/\{ key: "(\w+)"/g)].map((m) => m[1]).join()
      && SIM_STATUSES.every((x) => code.includes(`byStatus?.${x}`)));
    ok("periods are the existing 24 h / 7 d / 30 d windows only (no all time)",
      /Object\.entries\(SIM_WINDOWS\)/.test(code) && !/all ?time/i.test(code));
    ok("chart: existing total line + inDelivery and cancelled series, with a legend",
      /<LineChart stats=\{stats\} t=\{t\} locale=\{locale\} series=\{series\} \/>/.test(code) && /key: "inDelivery"[^}]*STATUS_COLOR\.inDelivery\.hex/.test(code)
      && /key: "cancelled"[^}]*STATUS_COLOR\.cancelled\.hex/.test(code) && /data-chart-legend/.test(code)
      && /export function LineChart\(\{ stats, t, locale, series = \[\] \}\)/.test(stats) && /b\.byStatus\?\.\[s\.key\]/.test(stats));
    ok("latest orders: inDelivery has its own badge; every simulated status has a badge style",
      /inDelivery: \{ Icon: Route,\s+cls: "bg-sky-50 text-sky-700" \}/.test(code) && SIM_STATUSES.every((x) => new RegExp(`\\b${x}:\\s+\\{ Icon:`).test(code)));
    ok("every simulated status has a colour in the shared chart/donut component", SIM_STATUSES.every((x) => new RegExp(`\\b${x}:\\s+\\{ hex: "#[0-9a-f]{6}"`).test(stats)));
    // admin view (BrandSimStats default export, used by the admin requests panel only)
    const tilesSrc = stats.slice(stats.indexOf("export function SummaryTiles"), stats.indexOf("export function LineChart"));
    const adminSrc = stats.slice(stats.indexOf("export default function BrandSimStats"));
    ok("admin tiles: total, delivered, refused, no response + separate confirmed, in delivery and cancellation tiles",
      ["stats?.total", "byStatus?.delivered", "byStatus?.refused", "byStatus?.noResponse", "byStatus?.confirmed", "byStatus?.inDelivery", "byStatus?.cancelled"].every((k) => tilesSrc.includes(k))
      && /t\("status_confirmed"\)/.test(tilesSrc) && /t\("sum_inDelivery"\)/.test(tilesSrc) && /t\("sum_cancelled"\)/.test(tilesSrc)
      && (tilesSrc.match(/\{ key: "/g) || []).length === 7);
    ok("admin chart: total line + separate confirmed, inDelivery and cancelled lines, with a legend",
      /<LineChart stats=\{stats\} t=\{t\} locale=\{locale\} series=\{series\} \/>/.test(adminSrc)
      && /key: "confirmed"[^}]*CHART_LINE_COLOR\.confirmed/.test(adminSrc) && /key: "inDelivery"[^}]*CHART_LINE_COLOR\.inDelivery/.test(adminSrc)
      && /key: "cancelled"[^}]*STATUS_COLOR\.cancelled\.hex/.test(adminSrc) && /data-chart-legend/.test(adminSrc));
    {
      // admin chart: confirmed and inDelivery lines in clearly different hues; shared status / donut colours unchanged
      const lineCol = Object.fromEntries([...stats.matchAll(/(confirmed|inDelivery): "(#[0-9a-f]{6})"/g)].map((m) => [m[1], m[2]]));
      const hue = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        if (!d) return 0; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
      const gap = (a, b) => { const x = Math.abs(hue(a) - hue(b)); return Math.min(x, 360 - x); };
      ok("admin chart: confirmed and inDelivery line colours differ clearly (hue gap ≥ 40°, vs 18° for the shared colours)",
        lineCol.confirmed && lineCol.inDelivery && gap(lineCol.confirmed, lineCol.inDelivery) >= 40, JSON.stringify(lineCol));
      ok("shared STATUS_COLOR (donut, affiliate) unchanged: confirmed #3b82f6, inDelivery #0ea5e9",
        /confirmed:\s+\{ hex: "#3b82f6"/.test(stats) && /inDelivery: \{ hex: "#0ea5e9"/.test(stats));
    }
    ok("admin tile labels wrap between words only (no truncation / ellipsis, no mid-word breaking)",
      /text-\[11px\] text-gray-500 leading-tight mt-0\.5">\{label\}/.test(tilesSrc) && !/truncate|break-words|break-all|overflow-wrap|word-break/.test(tilesSrc));
    ok("admin donut keeps every status separate (one row per simulated status, nothing merged)",
      /SIM_STATUSES\.map\(\(s\) => \(\{ s, v: Number\(stats\?\.byStatus\?\.\[s\]/.test(stats) && /\{SIM_STATUSES\.map\(\(s\) => \{/.test(stats));
    const simTab = read("../src/app/admin/brand/SimulationTab.jsx");
    ok("admin outcome distribution: still the five final outcomes (no inDelivery), validated at 100 %",
      /SIM_OUTCOMES\.reduce\(/.test(simTab) && /\{SIM_OUTCOMES\.map\(\(k\) =>/.test(simTab) && /total === 100/.test(simTab) && !/inDelivery|SIM_STATUSES/.test(simTab));
    ok("order details: reference, status, Casablanca time + the three simulated expenses in detail",
      /d\("detail_ref"\)/.test(code) && /d\("detail_status"\)/.test(code) && /d\("detail_time"\)/.test(code) && /timeZone: "Africa\/Casablanca"/.test(code)
      && /<OrderMoney m=\{order\.money\} status=\{order\.status\} d=\{d\} money=\{money\} locale=\{locale\} detailed \/>/.test(code)
      && ["fin_exp_delivery", "fin_exp_notification", "fin_exp_confirmation"].every((k) => code.includes(`d("${k}")`)));
  }
  ok("in delivery / cancellation labels (FR / AR) on the affiliate cards, the badges, the admin tiles and the shared status list",
    DASHBOARD_TEXT.fr.kpi_inDelivery === "En cours de livraison" && DASHBOARD_TEXT.ar.kpi_inDelivery === "قيد التوصيل"
    && DASHBOARD_TEXT.fr.kpi_cancelled === "Annulation" && DASHBOARD_TEXT.ar.kpi_cancelled === "ملغاة"
    && DASHBOARD_TEXT.fr.order_status_inDelivery === "En cours de livraison" && DASHBOARD_TEXT.ar.order_status_inDelivery === "قيد التوصيل"
    && DASHBOARD_TEXT.fr.order_status_cancelled === "Annulation" && DASHBOARD_TEXT.ar.order_status_cancelled === "ملغاة"
    && BRAND_TEXT.fr.status_inDelivery === "En cours de livraison" && BRAND_TEXT.ar.status_inDelivery === "قيد التوصيل"
    && BRAND_TEXT.fr.sum_inDelivery === "En cours de livraison" && BRAND_TEXT.ar.sum_inDelivery === "قيد التوصيل"
    && BRAND_TEXT.fr.sum_cancelled === "Annulation" && BRAND_TEXT.ar.sum_cancelled === "ملغاة"
    && SIM_STATUSES.every((x) => DASHBOARD_TEXT.fr[`order_status_${x}`] && DASHBOARD_TEXT.ar[`order_status_${x}`]));
  ok("dashboard texts: same keys FR/AR, no figure, removed hero chips / days-since not rendered, no earnings wording",
    JSON.stringify(Object.keys(DASHBOARD_TEXT.fr).sort()) === JSON.stringify(Object.keys(DASHBOARD_TEXT.ar).sort())
    && !/\d/.test(JSON.stringify(DASHBOARD_TEXT).replace(/\{\w+\}/g, ""))
    && !/"hero_sim_delivery"|"hero_safe_sim"|since_days/.test(dashUi) && !/s.occupe de la livraison/i.test(JSON.stringify(DASHBOARD_TEXT))
    && !/profit|gain|chiffre|revenu|retir|ربح|أرباح|سحب/i.test(JSON.stringify(["fr", "ar"].map((l) => Object.entries(DASHBOARD_TEXT[l]).filter(([k]) => !/^fin_/.test(k)))))
    && DASHBOARD_TEXT.ar.fin_balance === "الرصيد التجريبي" && DASHBOARD_TEXT.ar.fin_profit === "الأرباح التجريبية" && DASHBOARD_TEXT.ar.fin_revenue === "إجمالي رقم المعاملات التجريبي"
    && DASHBOARD_TEXT.ar.hero_quantity === "{n} قطعة" && DASHBOARD_TEXT.ar.see_all === "عرض الكل" && DASHBOARD_TEXT.ar.fin_expected === "ربح متوقع"
    && !("hero_no_stock" in DASHBOARD_TEXT.fr)
    && !Object.keys(DASHBOARD_TEXT.fr).some((k) => /^stock_/.test(k)));
  ok("hero uses real catalogue product images (no stock imagery)", /data-hero/.test(tab) && !/https?:\/\//.test(tab.replace(/\/\*[\s\S]*?\*\//g, "")) && /pr\.image/.test(tab));
  ok("pack features come from each pack's configuration (shown on its own card)", /p\.features\.slice\(0, 3\)\.map/.test(tab) && /\{p\.features\.map\(\(f\) => <li key=\{f\}/.test(tab));
  const pageSrc = read("../src/app/affiliate/dashboard/page.jsx");
  ok("dashboard renders BrandTab only on its own tab (no props: no earnings data passed in)", /\{activeTab === "brand" && <BrandTab \/>\}/.test(pageSrc) && (pageSrc.match(/<BrandTab/g) || []).length === 1);
  const pkgTab = read("../src/app/admin/brand/PackagesTab.jsx");
  const empty = (pkgTab.match(/export function emptyPackage\(\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  ok("a new admin package is pre-filled with nothing (no figure, inactive)", empty.length > 0 && !/[1-9]/.test(empty) && /active: false/.test(empty));
}

// ── 11. Final hardening: W5 price warning, W9 admin / chart labels, Escape, W3 guard ──
console.log("\n11. Final hardening (W5, W9, Escape, W3)");
{
  const { simulatedSellingPriceIssue } = await import("../src/lib/brandProgram.js");
  const stats = read("../src/components/brand/BrandSimStats.jsx"), dashUi = read("../src/app/affiliate/dashboard/_brand/BrandDashboard.jsx");
  const M = BRAND_LIMITS.MAX_PRICE;
  const CASES = [
    ["valid", null, [299, "299", 49.9, "0.01", M]],
    ["missing", "MISSING", [undefined, null, "", "   "]],
    ["zero / non-positive", "NOT_POSITIVE", [0, "0", 0.004, -0]],
    ["negative", "NOT_POSITIVE", [-5, "-5"]],
    ["malformed", "INVALID", ["abc", "12abc", NaN, Infinity, {}, M + 1]],
  ];
  for (const [label, want, vals] of CASES) {
    const got = vals.map((v) => simulatedSellingPriceIssue(v));
    ok(`W5 simulatedSellingPriceIssue — ${label} → ${want}`, got.every((g) => g === want), JSON.stringify(got));
  }
  // the warning and the save rule agree: no issue ⇔ the save keeps a positive number (never a substitute)
  const saved = (v) => { const r = validateBrandConfig(cfg({ packages: [pkg({ simulatedSellingPrice: v })] }));
    return { err: r.errors?.["packages.0.simulatedSellingPrice"] || null, val: r.value?.packages?.[0]?.simulatedSellingPrice }; };
  const all = CASES.flatMap(([, , vals]) => vals);
  ok("W5 property: issue === null ⇔ the save accepts it as a positive number (same value, never the pack price)",
    all.every((v) => { const s = saved(v); const accepted = !s.err && typeof s.val === "number" && s.val > 0;
      return (simulatedSellingPriceIssue(v) === null) === accepted && (!accepted || (s.val === Number(v) && s.val !== pkg().price)); }));
  ok("W5 property: every NOT_POSITIVE / INVALID value is REFUSED by the save (INVALID_PRICE), so it can never be stored",
    CASES.filter(([, w]) => w === "NOT_POSITIVE" || w === "INVALID").flatMap(([, , v]) => v).every((v) => saved(v).err === "INVALID_PRICE"));
  ok("W5 property: absent / null / empty → saved as null (optional field, no substitute) but flagged MISSING by the warning; whitespace-only is refused by the save",
    [undefined, null, ""].every((v) => saved(v).err === null && saved(v).val === null && simulatedSellingPriceIssue(v) === "MISSING")
    && saved("   ").err === "INVALID_PRICE" && simulatedSellingPriceIssue("   ") === "MISSING");
  const progSrc = read("../src/lib/brandProgram.js");
  ok("W5: the save rule itself is unchanged (optional amount ≥ 0.01, ≤ MAX_PRICE) and the pack purchase price keeps its own rule",
    /const simulatedSellingPrice = optionalAmount\(p\.simulatedSellingPrice, 0\.01, L\.MAX_PRICE\);/.test(progSrc)
    && saved(299).val === 299 && validateBrandConfig(cfg({ packages: [pkg({ simulatedSellingPrice: 299 })] })).value.packages[0].price === pkg().price);

  // W5 admin UI (static; the component is a client component)
  const pt = read("../src/app/admin/brand/PackagesTab.jsx");
  const warn = pt.slice(pt.indexOf("{simIssue && (\n"), pt.indexOf(")}", pt.indexOf("data-sim-price-warning")));
  const objOf = (name) => (pt.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`)) || [])[1] || "";
  ok("W5 admin: issue computed only for ACTIVE packs with the shared helper (same rule as the save)",
    /const simIssue = pkg\.active \? simulatedSellingPriceIssue\(pkg\.simulatedSellingPrice\) : null;/.test(pt) && /import \{[^}]*simulatedSellingPriceIssue[^}]*\} from "@\/lib\/brandProgram";/.test(pt));
  ok("W5 admin: header chip and role=alert warning render only when simIssue is set",
    /\{simIssue && <span[^>]*data-sim-price-chip=\{simIssue\}/.test(pt) && /\{simIssue && \(\s*<div role="alert"[^>]*data-sim-price-warning=\{simIssue\}/.test(pt)
    && (pt.match(/data-sim-price-chip|data-sim-price-warning/g) || []).length === 2);
  ok("W5 admin: FR and AR warning texts for MISSING, INVALID and NOT_POSITIVE; the AR block is RTL",
    ["MISSING", "INVALID", "NOT_POSITIVE"].every((k) => new RegExp(`\\b${k}: "[^"]{10,}"`).test(objOf("SIM_PRICE_WARNING_FR")) && new RegExp(`\\b${k}: "[^"]{10,}"`).test(objOf("SIM_PRICE_WARNING_AR")))
    && /[؀-ۿ]/.test(objOf("SIM_PRICE_WARNING_AR")) && /\{SIM_PRICE_WARNING_FR\[simIssue\]\}/.test(warn) && /dir="rtl" lang="ar"[^>]*>\{SIM_PRICE_WARNING_AR\[simIssue\]\}/.test(warn));
  ok("W5 admin: the warning explains the missing simulated figures and never reads or substitutes another price",
    warn.length > 0 && /chiffre d’affaires ni de profit simulés/.test(warn) && /Aucun autre prix/.test(warn) && /لا يُستعمل أي ثمن آخر/.test(warn)
    && !/pkg\.price|productPrice|regularPrice|salePrice|breakdown/.test(warn));

  // W9: admin tab bar + chart labels
  const page = read("../src/app/admin/brand/page.jsx");
  const bar = (page.match(/<div className="([^"]*)" role="tablist"[^>]*>/) || [])[1];
  ok("W9 admin tab bar: wraps on narrow screens (no horizontal scroller), role=tablist; every tab is a type=button role=tab with aria-selected",
    bar !== undefined && /\bflex-wrap\b/.test(bar) && !/overflow-x-auto/.test(bar) && !/overflow-x-auto[^"]*"[^>]*role="tablist"/.test(page)
    && /<button key=\{t\.id\} type="button" role="tab" aria-selected=\{tab === t\.id\} onClick=\{\(\) => setTab\(t\.id\)\}/.test(page) && /\{TABS\.map\(\(t\) => \(/.test(page));
  const marksSrc = (stats.match(/const BIDI_MARKS = \/(\[[^\]]+\])\/g;/) || [])[1];
  const MARKS = marksSrc ? new RegExp(marksSrc, "g") : null;
  ok("W9 chart labels: BIDI_MARKS covers LRM, RLM, ALM, embeddings/overrides (U+202A–E) and isolates (U+2066–9)",
    MARKS !== null && ["‎", "‏", "؜", "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"].every((c) => c.match(MARKS))
    && !"27/10 14:30".match(MARKS));
  const lineSrc = stats.slice(stats.indexOf("export function LineChart"), stats.indexOf("export default function BrandSimStats") > 0 ? stats.indexOf("export default function BrandSimStats") : undefined);
  ok("W9 chart labels: every axis / tooltip / aria label goes through fmt, which formats in Africa/Casablanca, shows minutes for hours and strips the marks",
    /\.replace\(BIDI_MARKS, ""\)/.test(lineSrc) && (lineSrc.match(/toLocale(Date|Time)String\(/g) || []).length === 2
    && /toLocaleTimeString\(locale, \{ hour: "2-digit", minute: "2-digit", timeZone: SIM_TZ \}\)/.test(lineSrc)
    && /timeZone: SIM_TZ \}\)/.test(lineSrc.slice(lineSrc.indexOf("toLocaleDateString("))) && /const SIM_TZ = "Africa\/Casablanca";/.test(stats)
    && (lineSrc.match(/\{fmt\(b\.start\)\}/g) || []).length === 1 && (lineSrc.match(/fmt\(cur\.start, true\)/g) || []).length === 2);
  {
    // behaviour: the exact formatting options, in Arabic and French, give clean dd/mm and HH:MM in Casablanca time
    const day = (loc, iso) => new Date(iso).toLocaleDateString(loc, { day: "2-digit", month: "2-digit", timeZone: "Africa/Casablanca" }).replace(MARKS, "");
    const hour = (loc, iso) => new Date(iso).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Casablanca" }).replace(MARKS, "");
    const latin = (x) => x.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
    const iso = "2026-10-27T23:30:00Z"; // Casablanca (UTC+1): 28/10 00:30
    ok("W9 chart labels (ar-MA / fr-FR): no bidi mark left, day/month order dd/mm, Casablanca time HH:MM",
      MARKS && ["ar-MA", "fr-FR"].every((l) => !day(l, iso).match(MARKS) && !hour(l, iso).match(MARKS))
      && latin(day("fr-FR", iso)) === "28/10" && /^28\D10$/.test(latin(day("ar-MA", iso)))
      && latin(hour("fr-FR", iso)) === "00:30" && /^00\D30$/.test(latin(hour("ar-MA", iso))),
      JSON.stringify(MARKS ? ["ar-MA", "fr-FR"].map((l) => [day(l, iso), hour(l, iso)]) : null));
  }

  // Escape: one shared overlay stack, topmost only, focus back to the opener
  const ov = dashUi.slice(dashUi.indexOf("function useOverlay("), dashUi.indexOf("function Thumb("));
  ok("Escape: useOverlay closes ONLY the topmost overlay (module stack + id check), preventDefault, latest onClose via ref",
    /^const overlayStack = \[\];$/m.test(dashUi) && /const id = \+\+overlaySeq;/.test(ov) && /overlayStack\.push\(id\);/.test(ov)
    && /if \(e\.key !== "Escape" \|\| overlayStack\[overlayStack\.length - 1\] !== id\) return;/.test(ov) && /e\.preventDefault\(\);\s*close\.current\(\);/.test(ov)
    && /close\.current = onClose;/.test(ov));
  ok("Escape: cleanup removes the listener and this overlay's id from the stack",
    /return \(\) => \{\s*document\.removeEventListener\("keydown", onKey\);/.test(ov) && /const i = overlayStack\.lastIndexOf\(id\);\s*if \(i !== -1\) overlayStack\.splice\(i, 1\);/.test(ov));
  ok("Escape focus: opener read during the FIRST render (before React autoFocuses the ✕), restored only if focus was lost and the opener still exists",
    /const \[opener\] = useState\(\(\) => \(typeof document !== "undefined" \? document\.activeElement : null\)\);/.test(ov)
    && /const lost = !document\.activeElement \|\| document\.activeElement === document\.body;/.test(ov)
    && /if \(lost && opener && opener !== document\.body && typeof opener\.focus === "function" && document\.contains\(opener\)\) opener\.focus\(\);/.test(ov)
    && /\}, \[opener\]\);/.test(ov) && !/document\.activeElement/.test(ov.slice(ov.indexOf("useEffect("), ov.indexOf("return () =>"))));
  const body = (name, next) => dashUi.slice(dashUi.indexOf(`function ${name}(`), dashUi.indexOf(`function ${next}(`));
  ok("Escape: Lightbox, OrderSheet and AllOrdersSheet all register with useOverlay; no other keydown listener in the dashboard",
    /^  useOverlay\(onClose\);$/m.test(body("Lightbox", "HeroImage")) && /^  useOverlay\(onClose\);$/m.test(body("OrderSheet", "AllOrdersSheet"))
    && /^  useOverlay\(onClose\);$/m.test(body("AllOrdersSheet", "LiveOrders")) && (dashUi.match(/^  useOverlay\(onClose\);$/gm) || []).length === 3
    && (dashUi.match(/addEventListener\("keydown"/g) || []).length === 1 && ov.includes('document.addEventListener("keydown", onKey);'));
  ok("Escape / W3: the open list and details are dropped when the period changes (fresh snapshot next time)",
    /const period = dash\.orders\?\.window;\s*useEffect\(\(\) => \{ setAll\(false\); setOpen\(null\); \}, \[period\]\);/.test(body("LiveOrders", "MyPack")));

  // W3 guard: status codes, validation, handler wiring + runtime of the exported helpers
  const hs = read("../src/lib/brandRouteHandlers.js");
  ok("W3: LIST_CHANGED → 409, INVALID_AS_OF → 400 in the STATUS map; both labelled FR + AR",
    /\bLIST_CHANGED: +409,/.test(hs) && /\bINVALID_AS_OF: +400,/.test(hs)
    && ["LIST_CHANGED", "INVALID_AS_OF"].every((c) => BRAND_TEXT.fr[`code_${c}`] && BRAND_TEXT.ar[`code_${c}`] && /[؀-ۿ]/.test(BRAND_TEXT.ar[`code_${c}`])));
  ok("W3: the dashboard handler compares the recomputed listId with &list= and refuses a mismatch; the brand comes from the token only",
    /const LIST_ID_RE = \/\^\[0-9a-f\]\{16\}\$\/;/.test(hs)
    && /if \(expected !== null && dash\.orders\.listId !== expected\) throw Object\.assign\(new Error\('La liste a changé\.'\), \{ code: 'LIST_CHANGED' \}\);/.test(hs)
    && /const clock = now\(\);\s*const dash = await getAffiliateSimulationDashboard\(me, \{ db, now: asOfOf\(req, clock\), clock, window: windowOf\(req\), page: pageOf\(req\) \}\);/.test(hs)
    && !/searchParams\.get\('(access|accessId|brand|affiliateId|id)'\)/.test(hs.slice(hs.indexOf("export function affiliateBrandHandlers(")))
    && /const me = await activeMe\(decoded\);\s*const expected = expectedListOf\(req\);/.test(hs));
  {
    const { asOfOf, expectedListOf } = await import("../src/lib/brandRouteHandlers.js");
    const r = (q) => new Request(`http://x/api/affiliate/brand/dashboard?${q}`);
    const code = (f) => { try { f(); return "OK"; } catch (e) { return e.code; } };
    const now = new Date("2026-10-28T10:20:00.000Z");
    ok("W3 runtime: &list= absent/empty → no guard; 16 lowercase hex → expected; anything else → LIST_CHANGED",
      expectedListOf(r("window=24h")) === null && expectedListOf(r("list=")) === null && expectedListOf(r("list=0123456789abcdef")) === "0123456789abcdef"
      && ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "zz23456789abcdef", "%20123456789abcdef"].every((v) => code(() => expectedListOf(r(`list=${v}`))) === "LIST_CHANGED"));
    ok("W3 runtime: asOf absent → now; valid ISO ≤ 24 h old → used as given; malformed / future / > 24 h old → INVALID_AS_OF",
      asOfOf(r("window=24h"), now) === now && asOfOf(r("asOf=2026-10-28T05:20:00.000Z"), now).toISOString() === "2026-10-28T05:20:00.000Z"
      && asOfOf(r("asOf=2026-10-27T10:20:00.000Z"), now).toISOString() === "2026-10-27T10:20:00.000Z"
      && ["2026-10-28", "1761600000000", "2026-10-28T10:21:00.000Z", "2026-10-27T10:19:59.999Z", "2026-10-28T10:20:00+01:00", "garbage", "2026-13-45T99:99:99Z"]
        .every((v) => code(() => asOfOf(r(`asOf=${encodeURIComponent(v)}`), now)) === "INVALID_AS_OF"));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
