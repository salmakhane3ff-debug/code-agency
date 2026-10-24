#!/usr/bin/env node
/**
 * scripts/productLock.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Storefront product lock / open (admin-set, applies to EVERYONE). Proves:
 *   1. admin permission — lock endpoints need an ADMIN session (401/403)
 *   2. persistence — lock / open / re-lock write products.isLocked; bad input
 *      → 400 and nothing written; unknown product → 404; default = open
 *   3. lock rules — what a locked product may still show (image/name/price)
 *   4. server enforcement wiring — product API (403 unless admin), product page
 *      (locked view, full product never sent), createOrder (PRODUCT_LOCKED →
 *      422), public list reads trimmed, cart refuses locked products
 *   5. storefront grids — lock overlay + no link (+ no quick add) when locked;
 *      open products keep their original link element
 *   6. scope — no new store page / affiliate feature; Rewards, affiliate
 *      activation and commissions untouched; generic product writes ignore it
 * The real-DB / real-browser checks run separately (disposable PostgreSQL +
 * built app); this file has no dependencies beyond the repo.
 * Run: node scripts/productLock.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { productLockHandlers } from "../src/lib/productLockRouteHandlers.js";
import { withAdminAuth } from "../src/lib/middleware/withAdminAuth.js";
import { signToken } from "../src/lib/services/authService.js";
import { isAdminRequest } from "../src/lib/adminSession.js";
import { isProductLocked, lockedProductView, productLockedError, PRODUCT_LOCKED } from "../src/lib/productLock.js";
import { createFakeOrder } from "../src/lib/services/fakeOrderService.js";

process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

function fakeDb(rows) {
  const T = rows.map((r) => ({ ...r }));
  const writes = [];
  const match = (r, where = {}) => Object.entries(where).every(([k, v]) => (k === "isLocked" ? (r[k] === true) === v : r[k] === v));
  return {
    _rows: T, _writes: writes,
    product: {
      findMany: async ({ where, select } = {}) => T.filter((r) => match(r, where)).map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r })),
      updateMany: async ({ where, data }) => {
        const hit = T.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        writes.push({ where, data, count: hit.length });
        return { count: hit.length };
      },
    },
  };
}
const seed = () => fakeDb([
  { id: "p-open", title: "Montre", status: "Active" },
  { id: "p-locked", title: "Sac", status: "Active", isLocked: true },
  { id: "p-legacy", title: "Ancien", status: "Active" },   // no stored value yet → open
]);
const adminCookie = () => `auth_token=${signToken({ userId: "admin-1", email: "a@x", role: "ADMIN" })}`;
const userCookie  = () => `auth_token=${signToken({ userId: "u-1", email: "u@x", role: "USER" })}`;
const affToken    = () => signToken({ affiliateId: "aff-1", username: "salma", type: "affiliate" });
const req = (url, { method = "GET", headers = {}, body } = {}) => new Request(`http://x${url}`, { method, headers, ...(body !== undefined ? { body } : {}) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const wire = (db) => { const h = productLockHandlers({ db }); return { list: withAdminAuth(h.listLocks), set: withAdminAuth(h.setLock) }; };
const patch = (r, id, body, cookie = adminCookie()) =>
  r.set(req(`/api/admin/products/${id}/lock`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(id));

// ── 1. Admin permission ──────────────────────────────────────────────────────
console.log("\n1. Admin permission");
{
  const db = seed(), r = wire(db);
  ok("GET locks without a session → 401", (await r.list(req("/api/admin/products/locks"))).status === 401);
  ok("GET locks as a customer account → 403", (await r.list(req("/x", { headers: { cookie: userCookie() } }))).status === 403);
  ok("GET locks with an affiliate token → 401", (await r.list(req("/x", { headers: { authorization: `Bearer ${affToken()}` } }))).status === 401);
  ok("PATCH without a session → 401, nothing written", (await patch(r, "p-open", { locked: true }, "")).status === 401 && db._writes.length === 0);
  ok("PATCH as a customer → 403, nothing written", (await patch(r, "p-open", { locked: true }, userCookie())).status === 403 && db._writes.length === 0);
  ok("PATCH with an affiliate token in the cookie slot → 403, nothing written", (await patch(r, "p-open", { locked: true }, `auth_token=${affToken()}`)).status === 403 && db._writes.length === 0);
  ok("PATCH with a forged token → 401", (await patch(r, "p-open", { locked: true }, "auth_token=x.y.z")).status === 401);
  const res = await r.list(req("/x", { headers: { cookie: adminCookie() } }));
  ok("GET locks as admin → 200 { lockedIds }, no-store", res.status === 200 && /no-store/.test(res.headers.get("cache-control")) && JSON.stringify((await res.json()).lockedIds) === '["p-locked"]');
  ok("admin route files are withAdminAuth-wrapped (GET list, PATCH lock only)",
    /export const GET = withAdminAuth\(h\.listLocks\)/.test(read("src/app/api/admin/products/locks/route.js"))
    && /export const PATCH = withAdminAuth\(h\.setLock\)/.test(read("src/app/api/admin/products/[id]/lock/route.js"))
    && !/export const (POST|PUT|DELETE)/.test(read("src/app/api/admin/products/locks/route.js") + read("src/app/api/admin/products/[id]/lock/route.js")));
  ok("isAdminRequest: admin cookie → true; customer / affiliate / none / forged → false",
    isAdminRequest(req("/x", { headers: { cookie: adminCookie() } })) === true
    && isAdminRequest(req("/x", { headers: { cookie: userCookie() } })) === false
    && isAdminRequest(req("/x", { headers: { authorization: `Bearer ${affToken()}` } })) === false
    && isAdminRequest(req("/x")) === false && isAdminRequest(req("/x", { headers: { cookie: "auth_token=bad" } })) === false && isAdminRequest(null) === false);
}

// ── 2. Persistence ───────────────────────────────────────────────────────────
console.log("\n2. Lock / open persistence");
{
  const db = seed(), r = wire(db), row = (id) => db._rows.find((x) => x.id === id);
  let res = await patch(r, "p-open", { locked: true });
  ok("lock → 200 { id, isLocked: true }; row locked", res.status === 200 && (await res.json()).isLocked === true && row("p-open").isLocked === true);
  res = await patch(r, "p-open", { locked: false });
  ok("open → 200 { isLocked: false }; row open", res.status === 200 && (await res.json()).isLocked === false && row("p-open").isLocked === false);
  await patch(r, "p-open", { locked: true });
  ok("changeable at any time (re-lock)", row("p-open").isLocked === true);
  const before = db._writes.length;
  let all400 = true;
  for (const bad of [{ locked: "true" }, { locked: 1 }, { locked: null }, {}, [true], "nope{"]) {
    if ((await patch(r, "p-open", bad)).status !== 400) all400 = false;
  }
  ok("non-boolean / missing / array / malformed body → 400, nothing written", all400 && db._writes.length === before && row("p-open").isLocked === true);
  res = await patch(r, "ghost", { locked: true });
  ok("unknown product → 404 NOT_FOUND", res.status === 404 && (await res.json()).code === "NOT_FOUND");
  ok("only `isLocked` is ever written", db._writes.every((w) => Object.keys(w.data).join() === "isLocked"));
  const listed = await (await r.list(req("/x", { headers: { cookie: adminCookie() } }))).json();
  ok("admin list reflects the saved state", listed.lockedIds.sort().join() === "p-locked,p-open");
  ok("schema: Product.isLocked Boolean @default(false)", /\bisLocked\s+Boolean\s+@default\(false\)/.test(read("prisma/schema.prisma")));
  const mig = read("prisma/migrations/20261020_product_lock/migration.sql");
  ok("migration: additive NOT NULL DEFAULT false (existing products stay open), idempotent, nothing else",
    /ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isLocked" BOOLEAN NOT NULL DEFAULT false;/.test(mig)
    && mig.replace(/^--.*$/gm, "").trim().split(";").filter((x) => x.trim()).length === 1);
  ok("old affiliate-only migration and column are gone", !existsSync(join(ROOT, "prisma/migrations/20261020_product_affiliate_lock")) && !/affiliateLocked/.test(read("prisma/schema.prisma")));
}

// ── 3. Lock rules ────────────────────────────────────────────────────────────
console.log("\n3. Lock rules");
{
  ok("isProductLocked: only an explicit true locks (missing / false / truthy strings → open)",
    isProductLocked({ isLocked: true }) && !isProductLocked({}) && !isProductLocked({ isLocked: false }) && !isProductLocked({ isLocked: "true" }) && !isProductLocked(null));
  const full = { id: "p", _id: "p", title: "Sac", images: ["/a.jpg", "/b.jpg"], regularPrice: 450, salePrice: 399, description: "SECRET", shortDescription: "S2",
    variants: [{ v: 1 }], sections: [{ s: 1 }], bundles: [{ b: 1 }], redirectUrl: "https://x", allowCOD: true, currencySymbol: "MAD", storeCurrency: "MAD", isLocked: true };
  const v = lockedProductView(full);
  ok("lockedProductView keeps image (first only), name, price, currency, lock flag",
    v.title === "Sac" && v.images.join() === "/a.jpg" && v.regularPrice === 450 && v.salePrice === 399 && v.currencySymbol === "MAD" && v.isLocked === true && v._id === "p");
  ok("…and drops everything else (description, variants, sections, bundles, redirect, payment)",
    Object.keys(v).sort().join() === "_id,currencySymbol,id,images,isLocked,regularPrice,salePrice,storeCurrency,title" && !JSON.stringify(v).includes("SECRET"));
  const e = productLockedError("p1");
  ok("productLockedError → code PRODUCT_LOCKED", e.code === PRODUCT_LOCKED && PRODUCT_LOCKED === "PRODUCT_LOCKED");
}

// ── 4. Server enforcement wiring ─────────────────────────────────────────────
console.log("\n4. Server-side enforcement");
{
  const ctl = read("src/lib/controllers/productController.js");
  ok("GET /api/products/[id]: locked → 403 PRODUCT_LOCKED unless the request is an admin session",
    /if \(isProductLocked\(product\) && !isAdminRequest\(req\)\) \{\s*return Response\.json\(\s*\{ error: 'Ce produit est verrouillé', code: PRODUCT_LOCKED \},\s*\{ status: 403/.test(ctl));
  const page = read("src/app/products/[id]/page.jsx");
  ok("product page: locked → LockedProduct with lockedProductView only (full product never rendered/sent)",
    /if \(isProductLocked\(product\)\) return <LockedProduct product=\{lockedProductView\(product\)\} \/>;\s*return <Product data=\{product\} \/>;/.test(page));
  ok("product page metadata: locked → title only + noindex", /if \(isProductLocked\(product\)\) \{\s*return \{ title: product\.title \|\| "Produit", robots: \{ index: false, follow: false \} \};/.test(page));
  const locked = read("src/app/products/[id]/LockedProduct.jsx");
  ok("locked view has no buy / cart / order controls", !/useCart|addToCart|InlineCodForm|\/checkout|api\/order|StickyAddToCart|<button/i.test(locked) && /Lock/.test(locked));
  const order = read("src/lib/services/orderService.js");
  ok("createOrder reads isLocked and refuses a locked paid item (after the existing checks)",
    /select: \{ id: true, salePrice: true, regularPrice: true, isActive: true, isLocked: true \}/.test(order)
    && /if \(isProductLocked\(dbProduct\)\) throw productLockedError\(rawId\);/.test(order)
    && order.indexOf("productLockedError(rawId)") > order.indexOf("PRODUCT_INACTIVE") && order.indexOf("productLockedError(rawId)") < order.indexOf("Canonical server-side price"));
  ok("POST /api/order maps PRODUCT_LOCKED to 422 (clear client error)", /'PRODUCT_INACTIVE', 'PRODUCT_LOCKED',/.test(read("src/lib/controllers/orderController.js")));
  ok("POST /api/order is the only public order-creating route and goes through createOrder",
    /export async function POST\(req\) \{[\s\S]*return createOrderHandler\(req\);/.test(read("src/app/api/order/route.jsx"))
    && /export const PUT    = withAdminAuth\(updateOrderHandler\)/.test(read("src/app/api/order/route.jsx")));
  const svc = read("src/lib/services/productService.js");
  ok("public list reads carry isLocked (Prisma lists ×2 + feed SQL)", (svc.match(/isLocked: true,/g) || []).length === 2 && /bundles, "isLocked", "createdAt"`/.test(svc));
  ok("public list reads trim locked rows; admin reads (status=all…) stay full",
    /isPublicList \? publicListProduct\(p, storeSettings\) : mapProduct\(p, storeSettings\)/.test(svc)
    && /items:      page\.map\(\(p\) => publicListProduct\(p, storeSettings\)\)/.test(svc)
    && (svc.match(/(?<!function )publicListProduct\(p, storeSettings\)/g) || []).length === 3);
  const cart = read("src/hooks/useCart.js");
  ok("cart refuses a locked product (free gifts excepted, as on the server)", /if \(isProductLocked\(product\) && !product\._isGift\) \{\s*reject\(Object\.assign\(new Error\("Product is locked"\), \{ code: PRODUCT_LOCKED \}\)\);/.test(cart));
}

// ── 5. Storefront grids ──────────────────────────────────────────────────────
console.log("\n5. Storefront grids");
{
  const lockUi = read("src/components/Product/ProductLock.jsx");
  ok("LockableLink: locked → plain block (no href, aria-disabled); open → original link element",
    /if \(locked\) \{\s*return \(\s*<div aria-disabled="true"[^>]*className="cursor-not-allowed">/.test(lockUi)
    && /if \(anchor\) return <a href=\{href\} \{\.\.\.rest\}>\{children\}<\/a>;/.test(lockUi) && /return <Link href=\{href\} \{\.\.\.rest\}>\{children\}<\/Link>;/.test(lockUi));
  ok("LockedOverlay shows a lock icon + translated label", /<Lock /.test(lockUi) && /t\("product_locked"\)/.test(lockUi) && /data-locked="true"/.test(lockUi));
  const grids = {
    "ProductCard (/products)":   ["src/components/Product/ProductCard.jsx", /<LockableLink locked=\{locked\} href=\{`\/products\/\$\{product\._id\}`\}>/g, 2],
    "ProductGrid (home)":        ["src/components/Product/ProductGrid.jsx", /<LockableLink anchor locked=\{locked\} href=\{productHref\}/g, 2],
    "HomeCollectionSections":    ["src/components/Colleaction/HomeCollectionSections.jsx", /<LockableLink locked=\{locked\} href=\{href\}>/g, 2],
    "SliderProduct (related)":   ["src/components/Product/SliderProduct.jsx", /<LockableLink locked=\{isProductLocked\(product\)\} href=\{`\/products\/\$\{product\._id\}`\}>/g, 2],
  };
  for (const [name, [file, re, n]] of Object.entries(grids)) {
    const src = read(file);
    ok(`${name}: every product link is lock-aware and shows the overlay`, (src.match(re) || []).length === n && /<LockedOverlay \/>/.test(src) && !/<Link href=\{`\/products\/\$\{product\._id/.test(src) && !/<a href=\{productHref\}/.test(src));
  }
  ok("ProductGrid keeps its plain <a> for open products (behaviour unchanged)", /<LockableLink anchor /.test(read("src/components/Product/ProductGrid.jsx")));
  ok("SliderProduct: no quick 'Add to Cart' on a locked product", /\{!isProductLocked\(product\) && <Button/.test(read("src/components/Product/SliderProduct.jsx")));
  const wl = read("src/app/wishlist/page.jsx");
  ok("wishlist quick add passes the live lock flag to the cart and keeps a refused item in the wishlist",
    /isLocked: productDetails\?\.isLocked === true,/.test(wl) && /if \(err\?\.code === "PRODUCT_LOCKED"\) \{ alert\(t\("product_locked_cart"\)\); return; \}/.test(wl));
  const fr = JSON.parse(read("src/locales/fr.json")), ar = JSON.parse(read("src/locales/ar.json"));
  const keys = ["product_locked", "product_locked_message", "product_locked_back", "product_locked_cart"];
  ok("lock texts exist in French and Arabic", keys.every((k) => typeof fr[k] === "string" && fr[k] && typeof ar[k] === "string" && ar[k] && fr[k] !== ar[k]));
}

// ── 6. Scope ─────────────────────────────────────────────────────────────────
console.log("\n6. Scope");
{
  ok("no new store page or affiliate feature (affiliate-only pieces removed)",
    !existsSync(join(ROOT, "src/app/affiliate/dashboard/StoreTab.jsx")) && !existsSync(join(ROOT, "src/app/affiliate/products"))
    && !existsSync(join(ROOT, "src/app/api/affiliate/products")) && !/StoreTab|tab=store/.test(read("src/app/affiliate/dashboard/page.jsx")));
  ok("generic product create/update ignore isLocked (not in PRODUCT_COLUMNS) — form & duplicate can't change it",
    !/'isLocked'/.test(read("src/lib/services/productService.js").split("const FLOAT_NULLABLE")[0]));
  const untouched = ["src/lib/services/rewardsService.js", "src/lib/services/rewardRedemptionService.js", "src/lib/rewards.js", "src/lib/rewardsHooks.js",
    "src/lib/services/affiliateSystemService.js", "src/lib/services/affiliateService.js"];
  ok("Rewards and affiliate activation/commission code don't reference the lock", untouched.every((f) => !/isLocked|productLock/.test(read(f))));
  const lockCode = read("src/lib/productLock.js") + read("src/lib/services/productLockService.js") + read("src/lib/productLockRouteHandlers.js");
  ok("lock code touches only the products table", !/\.(affiliate\w*|order\w*|reward\w*|commission\w*)\.(find|update|create|delete|count)/.test(lockCode));
}

// ── 7. Free gifts & Fake Orders Engine ───────────────────────────────────────
console.log("\n7. Free gifts & Fake Orders Engine");
{
  // Fake Orders Engine: the product query excludes locked products.
  const products = [
    { id: "lockedP", title: "Sac", images: [], salePrice: 450, regularPrice: 450, isActive: true, isLocked: true },
    { id: "openP", title: "Montre", images: [], salePrice: 199, regularPrice: 199, isActive: true, isLocked: false },
    { id: "legacyP", title: "Lampe", images: [], salePrice: 99, regularPrice: 99, isActive: true },   // column default → open
  ];
  const wheres = [], created = [], recorded = [];
  const db = {
    product: { findMany: async ({ where }) => {
      wheres.push(where);
      return products.filter((p) => p.isActive !== false && (where.isLocked === false ? p.isLocked !== true : true)
        && (where.id?.in ? where.id.in.includes(p.id) : true));
    } },
    order: { create: async ({ data }) => { const o = { id: `o${created.length}`, ...data, items: data.items.create }; created.push(o); return o; } },
  };
  const record = async (a) => { recorded.push(a); return {}; };
  for (let i = 0; i < 60; i++) {
    await createFakeOrder({ affiliateId: "aff", productMode: "all", productIds: [] }, { db, record, rng: () => (i % 10) / 10, now: () => new Date() });
  }
  ok("fake engine asks only for unlocked products (where.isLocked === false)", wheres.length === 60 && wheres.every((w) => w.isLocked === false && w.isActive === true));
  ok("60 fake orders: never the locked product (no fake order, no commission for it)",
    created.length === 60 && created.every((o) => o.items.every((it) => it.productId !== "lockedP")) && recorded.every((r) => r.productTitle !== "Sac"));
  ok("…open and default (never-locked) products are still used", created.some((o) => o.items[0].productId === "openP") && created.some((o) => o.items[0].productId === "legacyP"));
  const before = created.length;
  const only = await createFakeOrder({ affiliateId: "aff", productMode: "selected", productIds: ["lockedP"] }, { db, record, rng: () => 0, now: () => new Date() });
  ok("selected products all locked → NO_PRODUCTS, nothing created or recorded", only.ok === false && only.reason === "NO_PRODUCTS" && created.length === before);

  const order = read("src/lib/services/orderService.js");
  ok("createOrder: free lines (gift / 2+1 / ::cadeau) for a locked product are dropped",
    /const refId = isGift \? giftProductMap\.get\(resolvedGiftId\) : freeLineProductId\(item\);\s*if \(refId && isProductLocked\(productMap\.get\(refId\)\)\) \{[\s\S]*?continue;/.test(order)
    && /const freeLineProductId = \(item\) => String\(item\.productId \|\| item\._id \|\| ''\)\.split\('::'\)\[0\]\.trim\(\) \|\| null;/.test(order)
    && /\.\.\.paidProductIds, \.\.\.giftProductIds, \.\.\.freeLineIds/.test(order));
  ok("createOrder: an order left with no lines after dropping → PRODUCT_LOCKED", /if \(resolvedItems\.length === 0\) throw productLockedError\('order'\);/.test(order));
  // freeLineProductId behaviour (copied from source and evaluated): every crafted shape resolves to the real id
  const fnSrc = order.match(/const freeLineProductId = (\(item\) => [^;]+);/)[1];
  const freeLineProductId = eval(fnSrc);
  ok("free-line product id: <id>::cadeau, ::cadeauX, ::CADEAU, leading space, _id → <id>; plain id unchanged",
    ["locked-1::cadeau", "locked-1::cadeauX", "locked-1::CADEAU", " locked-1::cadeau", "locked-1"].every((v) => freeLineProductId({ productId: v }) === "locked-1")
    && freeLineProductId({ _id: "locked-1::cadeau" }) === "locked-1" && freeLineProductId({}) === null);
  const { lockedIdsAmong } = await import("../src/lib/services/productLockService.js");
  const lockDb = { product: { findMany: async ({ where }) => [{ id: "lockedP", isLocked: true }, { id: "openP" }].filter((p) => where.id.in.includes(p.id) && p.isLocked === where.isLocked).map((p) => ({ id: p.id })) } };
  const set = await lockedIdsAmong(["lockedP", "openP", null, "", "lockedP"], { db: lockDb });
  ok("lockedIdsAmong → only the locked ids (null/empty/duplicates ignored); empty input → no query", set.size === 1 && set.has("lockedP") && (await lockedIdsAmong([], { db: null })).size === 0);
  const spinRoute = read("src/app/api/spin-wheel-spin/route.js");
  ok("spin wheel route: locked product prizes are excluded from the draw; none left → 400",
    /const drawable = config\.segments\.filter\(\(s\) => !\(s\.rewardType === 'product' && lockedPrizes\.has\(s\.productId\)\)\);/.test(spinRoute)
    && /if \(!drawable\.length\) return badRequest\('No segments available'\);/.test(spinRoute) && /const winner = pickWinner\(drawable\);/.test(spinRoute)
    && /index:        config\.segments\.findIndex/.test(spinRoute));
  ok("Gift System never offers a locked product as a gift", /if \(!product \|\| isProductLocked\(product\)\) continue;/.test(read("src/components/GiftSystem/GiftSystemInit.jsx")));
  const spin = read("src/components/SpinWheel/SpinWheelModal.jsx");
  ok("Spin wheel: a locked prize (API 403) is not added to the cart", /if \(r\.status === 403\) setPrizeLocked\(true\)/.test(spin) && /if \(prizeLocked\) \{ alert\(t\("product_locked_cart"\)\); return; \}/.test(spin));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
