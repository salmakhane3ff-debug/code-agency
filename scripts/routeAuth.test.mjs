#!/usr/bin/env node
/**
 * scripts/routeAuth.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * SYSTEMIC ROUTE-AUTH GUARD.
 *
 * Every POST/PUT/PATCH/DELETE under src/app/api must be admin-wrapped unless it
 * is explicitly listed below. A new unprotected write fails this suite.
 *
 * WHY THIS EXISTS: `middleware.jsx`'s matcher excludes /api entirely, so a route
 * file's exports are the ONLY gate in front of a write. Auth has now been
 * forgotten three separate times (/api/products, /api/data/[id], /api/gifts/[id])
 * — each time on a route whose sibling or parent WAS protected. No per-route test
 * caught any of them; only enumeration does.
 *
 * CLASSIFICATION RULES (deliberately strict — an unclear method FAILS):
 *   protected  ⟺  `export const M = withXAuth(...)`  — an unconditional wrapper.
 *   Everything else is treated as PUBLIC and must be listed. That includes
 *   `export async function M` handlers that call withAdminAuth *conditionally*
 *   inside the body (e.g. `?admin=true` dual-mode routes): their default path is
 *   public, so calling them "protected" would be a lie.
 *
 * Run:  node scripts/routeAuth.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const ALL_METHODS = ["GET", ...WRITE_METHODS];

// ── 1. INTENTIONALLY_PUBLIC_WRITES ───────────────────────────────────────────
// Public behaviour is fundamental to the application. Exact METHOD + route only —
// no prefixes, no wildcards: a new /api/tracking/* route must be reviewed, not
// silently inherited.
const INTENTIONALLY_PUBLIC_WRITES = new Set([
  // Authentication entry points — cannot require the session they issue.
  "POST /api/login",
  "POST /api/logout",
  "POST /api/affiliate/auth",
  // Recruiter login (rate-limited, sets the HttpOnly recruiter_token cookie) and
  // logout (only clears that cookie; audits when its own token is valid).
  "POST /api/recruiter/auth",
  "DELETE /api/recruiter/auth",

  // Customer checkout & order creation. createOrder() ignores client prices and
  // resolves every financial value from the database.
  "POST /api/order",
  "POST /api/abandoned-carts",
  "PATCH /api/abandoned-carts",
  "POST /api/checkout/upload-receipt",
  "POST /api/checkout/validate-payment",
  "PATCH /api/order/receipt",

  // Payment initiation / verification. `verify` re-reads authoritative state
  // from Stripe rather than trusting the caller.
  "POST /api/payment/stripe",
  "POST /api/payment/stripe/verify",

  // Public analytics / tracking beacons — fired by the browser on public pages.
  "POST /api/track",
  "POST /api/track/click",
  "POST /api/track/conversion",
  "POST /api/tracking/click",
  "POST /api/tracking/conversion",
  "POST /api/tracking/event",
  "POST /api/tracking/landing",
  "POST /api/products/track-click",
  "POST /api/products/track-cta-click",
  "POST /api/products/track-event",
  "POST /api/landing/track-click",
  "POST /api/landing/track-order",
  "POST /api/landing/track-view",
  // Recruitment landing (/tsajlim3ana) CTA beacon — increments no-PII counters.
  "POST /api/tsajlim3ana/track",
  "POST /api/landing-page/[slug]",
  "POST /api/affiliate/track-click",
  "POST /api/facebook/capi",

  // Customer-submitted content (rate-limited; admin moderation is wrapped).
  // feedback POST is dual-mode: ?admin=true applies withAdminAuth internally,
  // the default path is a public customer submission.
  "POST /api/feedback",
  "POST /api/reviews",

  // Public widget actions with no customer session available.
  "POST /api/spin-wheel",
  "POST /api/spin-wheel-spin",
  "PATCH /api/spin-wheel-spin",
]);

// ── 2. TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS ──────────────────────────────────
// NOT accepted public behaviour — known-risky writes that are public only until
// their follow-up fix lands. Each carries a code comment stating why it is
// public, its risk, and the required fix. Kept separate so they stay visible
// instead of blending into the allowlist above.
const TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS = new Map([
  ["POST /api/affiliate/record-order",
    "Unauthenticated financial/commission write — forgeable. Fix: attribute commission server-side in createOrder()."],
  ["POST /api/invoice",
    "Unauthenticated invoice creation — spam/resource abuse. Fix: generate the invoice server-side in createOrder()."],
  ["PATCH /api/spin-wheel",
    "Anonymous state mutation with no customer identity. Fix: require the spin's own sessionId/clickId secret."],
]);

// ── 3. GET expectations ──────────────────────────────────────────────────────
const PUBLIC_GETS = [
  "GET /api/ui-control",     // UIControlProvider is mounted in root providers.tsx
  "GET /api/blog",           // /blog and /blog/[slug]
  "GET /api/pages",          // /pages and /pages/[slug]
  "GET /api/collection",     // storefront collection sections + slider
  "GET /api/order-settings", // customer-facing /track-order page
];
const PROTECTED_GETS = [
  "GET /api/campaigns",
  "GET /api/campaigns/[id]",
  "GET /api/homepage-banner",
];

// ── Analyzer ─────────────────────────────────────────────────────────────────

/**
 * Classify ONE method in ONE file. Per method — never per file: a protected
 * sibling must never make a bare method look protected (the /api/products bug).
 * @returns {"protected"|"public"|"unknown"|null}
 */
export function classifyMethod(src, method) {
  const asConst = src.match(new RegExp("export\\s+const\\s+" + method + "\\s*=\\s*([^;\\n]+)"));
  if (asConst) return /with[A-Za-z]*Auth\s*\(/.test(asConst[1]) ? "protected" : "public";
  // `export function M` and `export async function M` are both inline handlers.
  if (new RegExp("export\\s+(async\\s+)?function\\s+" + method + "\\s*\\(").test(src)) return "public";
  // An export form we do not understand must never be assumed safe.
  if (new RegExp("export\\s*\\{[^}]*\\b" + method + "\\b").test(src)) return "unknown";
  return null;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/^route\.(js|jsx|ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const files = walk("src/app/api");
const routeOf = (f) =>
  f.replace(/\\/g, "/").replace("src/app/api", "/api").replace(/\/route\.(jsx?|tsx?)$/, "") || "/api";

const methods = []; // { key, route, method, status }
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const route = routeOf(f);
  for (const m of ALL_METHODS) {
    const status = classifyMethod(src, m);
    if (status) methods.push({ key: `${m} ${route}`, route, method: m, status });
  }
}

console.log(`enumerated ${files.length} route files, ${methods.length} exported methods\n`);

console.log("1) every write method is protected or explicitly listed:");
{
  const writes = methods.filter((x) => WRITE_METHODS.includes(x.method));
  const unlisted = writes.filter((x) =>
    x.status !== "protected" &&
    !INTENTIONALLY_PUBLIC_WRITES.has(x.key) &&
    !TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS.has(x.key));
  for (const u of unlisted) console.log(`     ↳ UNPROTECTED, UNLISTED: ${u.key}`);
  ok(`no unknown unprotected write methods (${writes.length} writes scanned)`, unlisted.length === 0);

  const unknown = methods.filter((x) => x.status === "unknown");
  for (const u of unknown) console.log(`     ↳ UNRECOGNISED EXPORT FORM: ${u.key}`);
  ok("no unrecognised export forms (unknown must never be assumed safe)", unknown.length === 0);
}

console.log("2) the allowlists are accurate (no stale entries):");
{
  const keys = new Set(methods.map((x) => x.key));
  const staleP = [...INTENTIONALLY_PUBLIC_WRITES].filter((k) => !keys.has(k));
  for (const s of staleP) console.log(`     ↳ stale public entry (route gone): ${s}`);
  ok("every INTENTIONALLY_PUBLIC_WRITES entry still exists", staleP.length === 0);

  const staleT = [...TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS.keys()].filter((k) => !keys.has(k));
  ok("every TEMPORARY exception still exists", staleT.length === 0);

  // If a listed route later gets wrapped, the entry must be removed — otherwise
  // the list rots into a lie about what is public.
  const nowProtected = methods.filter((x) =>
    x.status === "protected" &&
    (INTENTIONALLY_PUBLIC_WRITES.has(x.key) || TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS.has(x.key)));
  for (const n of nowProtected) console.log(`     ↳ listed as public but now protected: ${n.key}`);
  ok("no listed entry is actually protected", nowProtected.length === 0);
}

console.log("3) temporary exceptions are separated and documented:");
{
  ok("exactly 3 temporary exceptions", TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS.size === 3);
  for (const k of ["POST /api/affiliate/record-order", "POST /api/invoice", "PATCH /api/spin-wheel"]) {
    ok(`${k} is a TEMPORARY exception, not normal public behaviour`,
       TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS.has(k) && !INTENTIONALLY_PUBLIC_WRITES.has(k));
  }
  // Each must carry its rationale in the source, not only here.
  const sources = {
    "POST /api/affiliate/record-order": "src/app/api/affiliate/record-order/route.js",
    "POST /api/invoice": "src/app/api/invoice/route.js",
    "PATCH /api/spin-wheel": "src/app/api/spin-wheel/route.js",
  };
  for (const [k, f] of Object.entries(sources)) {
    const src = readFileSync(f, "utf8");
    ok(`${k} documents why/risk/fix in code`,
       /TEMPORARY PUBLIC SECURITY EXCEPTION/.test(src) &&
       /Why it is currently public/.test(src) &&
       /Known risk/.test(src) &&
       /Required follow-up fix/.test(src));
  }
}

console.log("4) selected GET methods remain public:");
for (const key of PUBLIC_GETS) {
  const m = methods.find((x) => x.key === key);
  ok(`${key} is public`, m && m.status === "public");
}

console.log("5) campaigns + homepage-banner GETs are protected:");
for (const key of PROTECTED_GETS) {
  const m = methods.find((x) => x.key === key);
  ok(`${key} is admin-protected`, m && m.status === "protected");
}

console.log("6) Batch #1 methods are protected:");
{
  const batch1 = [
    "POST /api/ui-control", "DELETE /api/delete",
    "POST /api/blog", "PUT /api/blog", "DELETE /api/blog",
    "POST /api/pages", "PUT /api/pages", "DELETE /api/pages",
    "POST /api/collection", "PUT /api/collection", "DELETE /api/collection",
    "GET /api/homepage-banner", "POST /api/homepage-banner", "PUT /api/homepage-banner", "DELETE /api/homepage-banner",
    "POST /api/order-settings", "PUT /api/order-settings",
    "PUT /api/data/[id]", "DELETE /api/data/[id]",
    "PUT /api/gifts/[id]", "DELETE /api/gifts/[id]",
    "GET /api/campaigns", "POST /api/campaigns",
    "GET /api/campaigns/[id]", "PUT /api/campaigns/[id]", "DELETE /api/campaigns/[id]",
  ];
  const missed = batch1.filter((k) => methods.find((x) => x.key === k)?.status !== "protected");
  for (const m of missed) console.log(`     ↳ NOT protected: ${m}`);
  ok(`all ${batch1.length} Batch #1 methods protected`, missed.length === 0);
}

console.log("7) mixed-auth files are evaluated method by method:");
{
  const byRoute = {};
  for (const m of methods) (byRoute[m.route] ||= []).push(m);
  const mixed = Object.entries(byRoute).filter(([, ms]) =>
    ms.some((m) => m.status === "protected") && ms.some((m) => m.status === "public"));
  ok("mixed-auth files exist and are detected as mixed (not collapsed to one verdict)", mixed.length > 0);
  // Real examples: writes wrapped while GET stays public, and vice versa.
  const invoice = byRoute["/api/invoice"] || [];
  ok("/api/invoice: GET protected while POST is public (per-method, not per-file)",
     invoice.find((m) => m.method === "GET")?.status === "protected" &&
     invoice.find((m) => m.method === "POST")?.status === "public");
}

console.log("8) regression: the /api/products-style failure (a protected sibling must not shield a bare method):");
{
  // Synthetic fixture reproducing the exact shape of the original bug: a file
  // whose GET is wrapped while POST is a bare inline export.
  const FIXTURE = `
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
export const GET = withAdminAuth(getThingHandler);
export async function POST(req) { return Response.json({ ok: true }); }
`;
  ok("bare POST beside a wrapped GET → public", classifyMethod(FIXTURE, "POST") === "public");
  ok("wrapped GET in the same file → protected", classifyMethod(FIXTURE, "GET") === "protected");

  // The original /api/products shape: bare const exports next to a wrapped one.
  const PRODUCTS_OLD = `
import { withAdminAuth } from '@/lib/middleware/withAdminAuth';
export const GET    = getProductsHandler;
export const POST   = createProductHandler;
export const PUT    = withAdminAuth(updateProductHandler);
`;
  ok("bare const POST beside a wrapped PUT → public", classifyMethod(PRODUCTS_OLD, "POST") === "public");
  ok("bare const GET → public", classifyMethod(PRODUCTS_OLD, "GET") === "public");
  ok("wrapped PUT → protected", classifyMethod(PRODUCTS_OLD, "PUT") === "protected");

  // A non-async `export function` sibling must not bleed into another method —
  // this exact miss made a public POST look protected during development.
  const NON_ASYNC = `
export async function POST(req) { return createThing(req); }
export function GET(req) {
  if (new URL(req.url).searchParams.get('admin') === 'true') return withAdminAuth(h)(req);
  return h(req);
}
export const PATCH = withAdminAuth(updateHandler);
`;
  ok("bare POST is not shielded by a later GET containing withAdminAuth",
     classifyMethod(NON_ASYNC, "POST") === "public");
  ok("dual-mode inline GET is reported public (its default path is public)",
     classifyMethod(NON_ASYNC, "GET") === "public");
  ok("wrapped PATCH in the same file → protected", classifyMethod(NON_ASYNC, "PATCH") === "protected");

  // A file-level "contains withAdminAuth" check would pass all of the above —
  // prove this analyzer is not that.
  ok("a file merely importing withAdminAuth does not protect anything",
     classifyMethod("import { withAdminAuth } from 'x';\nexport async function DELETE(r) {}", "DELETE") === "public");
  // Unknown export forms must fail loudly rather than be assumed safe.
  ok("re-export form is reported unknown, never protected",
     classifyMethod("async function POST(){}\nexport { POST };", "POST") === "unknown");
}

console.log("9) counts:");
{
  const writes = methods.filter((x) => WRITE_METHODS.includes(x.method));
  const publicWrites = writes.filter((x) => x.status !== "protected");
  console.log(`     writes=${writes.length}  protected=${writes.length - publicWrites.length}  public=${publicWrites.length}`);
  ok("public writes == allowlist + temporary exceptions",
     publicWrites.length === INTENTIONALLY_PUBLIC_WRITES.size + TEMPORARY_PUBLIC_SECURITY_EXCEPTIONS.size);
  ok("intentionally-public list is exactly 35", INTENTIONALLY_PUBLIC_WRITES.size === 35);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
