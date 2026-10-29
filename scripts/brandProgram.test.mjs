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
  ok("no inventory, unsold-stock guarantee or unknown field survives", keys === "active,deliveryCost,description,features,id,logisticsCost,name,percentages,price,productCount,productIds,sortOrder,vatPercent", keys);
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
  ok("package = name, description, features, price, product count, products, breakdown", Object.keys(offer.packages[0]).sort().join() === "breakdown,description,features,id,name,price,productCount,products");
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
  ok("offer always shows what is bought; dashboard shows the disclaimer + badges",
    /<WhatYouBuy t=\{t\} \/>/.test(tab) && /t\("dash_disclaimer"\)/.test(tab) && (stats.match(/<SimulatedBadge t=\{t\} \/>/g) || []).length === 2);
  ok("the affiliate page has no hardcoded price or delay", !/\b(8[\s.,]?000|10[\s.,]?000|90\s?%|72\s?h)\b/.test(tab));
  ok("products disclosure present (training only, no real order, no stock)", /simulation/.test(BRAND_TEXT.fr.products_training_note)
    && /aucune vraie commande/.test(BRAND_TEXT.fr.products_training_note) && BRAND_TEXT.ar.products_training_note.length > 10);

  // Affiliate tab flow + separation from real earnings (static: the tab is a client component).
  const stepOrder = ["step === 0", "step === 1", "step === 2", "step === 3"].map((k) => tab.indexOf(k));
  const at = (k) => tab.indexOf(k);
  ok("flow order: package → products → brand name → review + Buy Now", stepOrder.every((i) => i > 0) && stepOrder.every((v, i) => i === 0 || stepOrder[i - 1] < v)
    && at('t("package_title")') < at('t("products_title")') && at('t("products_title")') < at('t("brand_name")') && at('t("brand_name")') < at('t("buy_now")'));
  ok("each package card shows its price breakdown before any choice", /<Breakdown b=\{p\.breakdown\}/.test(tab) && at("<Breakdown b={p.breakdown}") < at('t("package_choose")'));
  ok("review shows the breakdown; pending shows the snapshot breakdown", /<Breakdown b=\{pkg\.breakdown\}/.test(tab) && /<Breakdown b=\{access\.package\.breakdown\}/.test(tab));
  ok("Buy Now never sends an amount", !/amount|price|total/.test(tab.slice(at("body: {"), at("clientRequestId: requestId.current"))));
  ok("Buy Now sends product ids only (no product names or prices)", /productIds: chosen\.map\(\(p\) => p\.id\)/.test(tab) && !/price: p\.|title: p\./.test(tab.slice(tab.indexOf("const buy"), tab.indexOf("const nav"))));
  ok("selection capped in the UI at the package's count, Continue needs exactly that count", /cur\.length >= need \? cur/.test(tab) && /chosen\.length === need/.test(tab) && /nav\(countOk\)/.test(tab));
  ok("pending and active views show the brand name and the selected products",
    (tab.match(/<ProductList products=\{access\.products\} \/>/g) || []).length === 2 && /access\.brandName/.test(tab) && /t\("brand_products_title"\)/.test(tab));
  const apiCalls = [...tab.matchAll(/["`](\/api\/[^"`?$]*)/g)].map((m) => m[1]);
  ok("the tab only calls brand APIs (never earnings, wallet, orders or payouts) + reads the bank details",
    apiCalls.length > 0 && apiCalls.every((u) => u.startsWith("/api/affiliate/brand") || u === "/api/setting")
    && [...tab.matchAll(/["`]\/api\/setting([^"`]*)["`]/g)].map((m) => m[1]).join() === "?type=bank-settings", apiCalls.join());
  ok("the proof is uploaded to the BRAND proof route (never the deposit route)", /\/api\/affiliate\/brand\/access\/\$\{encodeURIComponent\(access\.id\)\}\/proof/.test(tab) && !/\/api\/affiliate\/deposits/.test(tab));
  ok("no wallet / earnings / commission code imported by the tab", !/balance|wallet|commission|payout|earning/i.test(tab.split("\n").filter((l) => l.startsWith("import")).join("\n")));
  ok("no real-profit, refund-guarantee or withdrawal promise in the brand UI", ![tab, stats].map((src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).some((src) => /أرباح حقيقية|ضمان استرجاع|سحب الأرباح|withdraw|retirer vos gains|profits? r[ée]els?/i.test(src))
    && !/(guarantee|garantie|ضمان)/i.test(JSON.stringify(BRAND_TEXT)));
  ok("every simulated block is badged (summary area, chart, donut, recent orders, dashboard disclaimer)",
    (stats.match(/<SimulatedBadge t=\{t\} \/>/g) || []).length === 2 && (tab.match(/<SimulatedBadge t=\{t\} \/>/g) || []).length === 2 && /data-recent/.test(tab));
  ok("package amount card is labelled as the request amount, not earnings", /package_costs_note/.test(tab) && /pas un gain/.test(BRAND_TEXT.fr.package_costs_note) && /رصيدك/.test(BRAND_TEXT.ar.package_costs_note));
  ok("hero uses real catalogue product images (no stock imagery)", /data-hero/.test(tab) && !/https?:\/\//.test(tab.replace(/\/\*[\s\S]*?\*\//g, "")) && /pr\.image/.test(tab));
  ok("included services on the landing come from the package's configured features", /features\?\.slice\(0, 4\)/.test(tab));
  const pageSrc = read("../src/app/affiliate/dashboard/page.jsx");
  ok("dashboard renders BrandTab only on its own tab (no props: no earnings data passed in)", /\{activeTab === "brand" && <BrandTab \/>\}/.test(pageSrc) && (pageSrc.match(/<BrandTab/g) || []).length === 1);
  const pkgTab = read("../src/app/admin/brand/PackagesTab.jsx");
  const empty = (pkgTab.match(/export function emptyPackage\(\) \{([\s\S]*?)\n\}/) || [])[1] || "";
  ok("a new admin package is pre-filled with nothing (no figure, inactive)", empty.length > 0 && !/[1-9]/.test(empty) && /active: false/.test(empty));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
