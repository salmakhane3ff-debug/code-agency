#!/usr/bin/env node
/**
 * scripts/affiliateOrderOwnership.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression suite for PUT /api/affiliate/orders (Phase 0 security fix).
 *
 * THE BUG: the route ignored the authenticated affiliate and called
 * updateAffiliateOrderStatus(id, status) with any id — so any logged-in
 * affiliate could confirm/cancel ANY affiliate's order, including one an admin
 * had already marked delivered. Proves, without a DB (injected fake):
 *   • an affiliate cannot modify another affiliate's order (and learns nothing
 *     about whether it exists — same ORDER_NOT_FOUND as a missing id)
 *   • delivered / cancelled / unknown-status orders are locked (ORDER_LOCKED)
 *   • the legitimate dashboard actions still work on the caller's own orders
 *     (pending→confirmed, pending/shipped→cancelled, confirmed→cancelled)
 *   • only confirmed/cancelled can be set; affiliateId is mandatory
 *   • the route passes the token's affiliateId and maps codes to 4xx
 * Run: node scripts/affiliateOrderOwnership.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";
import {
  updateAffiliateOrderStatus,
  AFFILIATE_SETTABLE_ORDER_STATUSES,
  AFFILIATE_EDITABLE_ORDER_STATUSES,
} from "../src/lib/services/affiliateSystemService.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

// ── In-memory fake db (only affiliateOrder, the model the function touches) ───
function makeFakeDb(rows) {
  const orders = rows.map((r) => ({ total: 100, commissionAmount: 50, createdAt: new Date(), ...r }));
  const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && Array.isArray(v.in)) return v.in.includes(row[k]);
    return row[k] === v;
  });
  const db = {
    _orders: orders,
    _reads: [],
    affiliateOrder: {
      // Atomic conditional write, like Postgres UPDATE … WHERE.
      updateMany: async ({ where, data }) => {
        const hit = orders.filter((o) => matches(o, where));
        hit.forEach((o) => Object.assign(o, data));
        return { count: hit.length };
      },
      findFirst:  async ({ where }) => { db._reads.push(where); const r = orders.find((o) => matches(o, where)); return r ? { ...r } : null; },
      // Unscoped reads/writes by id alone must never be used.
      findUnique: async () => { throw new Error("unscoped findUnique must not be used"); },
      update: async () => { throw new Error("unconditional update must not be used"); },
    },
  };
  return db;
}

const seed = () => makeFakeDb([
  { id: "a-pending",   affiliateId: "A", status: "pending" },
  { id: "a-confirmed", affiliateId: "A", status: "confirmed" },
  { id: "a-shipped",   affiliateId: "A", status: "shipped" },
  { id: "a-delivered", affiliateId: "A", status: "delivered" },
  { id: "a-cancelled", affiliateId: "A", status: "cancelled" },
  { id: "a-Delivered", affiliateId: "A", status: "Delivered" }, // admin free-text casing
  { id: "b-pending",   affiliateId: "B", status: "pending" },
  { id: "b-delivered", affiliateId: "B", status: "delivered" },
]);

async function code(fn) {
  try { await fn(); return null; } catch (e) { return e.code || e.message; }
}
const statusOf = (db, id) => db._orders.find((o) => o.id === id).status;

// ── 1. Cross-affiliate modification is rejected ──────────────────────────────
console.log("\n1. Ownership");
{
  const db = seed();
  ok("A cannot cancel B's pending order",
    (await code(() => updateAffiliateOrderStatus("b-pending", "cancelled", { affiliateId: "A", db }))) === "ORDER_NOT_FOUND");
  ok("…and B's order is unchanged", statusOf(db, "b-pending") === "pending");
  ok("A cannot confirm B's pending order",
    (await code(() => updateAffiliateOrderStatus("b-pending", "confirmed", { affiliateId: "A", db }))) === "ORDER_NOT_FOUND");
  ok("A cannot cancel B's delivered order",
    (await code(() => updateAffiliateOrderStatus("b-delivered", "cancelled", { affiliateId: "A", db }))) === "ORDER_NOT_FOUND");
  ok("…and B's delivered order stays delivered", statusOf(db, "b-delivered") === "delivered");
  ok("someone else's order is indistinguishable from a missing id",
    (await code(() => updateAffiliateOrderStatus("does-not-exist", "cancelled", { affiliateId: "A", db }))) === "ORDER_NOT_FOUND");
  ok("missing affiliateId is refused (no unscoped writes)",
    (await code(() => updateAffiliateOrderStatus("a-pending", "cancelled", { db }))) === "AFFILIATE_REQUIRED");
  for (const bad of ["", "   ", 123, {}, { in: ["A", "B"] }, ["A"], null, true]) {
    ok(`affiliateId ${JSON.stringify(bad)} is refused`,
      (await code(() => updateAffiliateOrderStatus("a-pending", "cancelled", { affiliateId: bad, db }))) === "AFFILIATE_REQUIRED");
  }
  ok("…and nothing was written", statusOf(db, "a-pending") === "pending");
}

// ── 1b. Final read is scoped to the caller ───────────────────────────────────
console.log("\n1b. Scoped re-read");
{
  const db = seed();
  await updateAffiliateOrderStatus("a-pending", "confirmed", { affiliateId: "A", db });
  const last = db._reads.at(-1);
  ok("re-read filters by order id AND affiliateId", last?.id === "a-pending" && last?.affiliateId === "A");
  ok("every read is scoped to the caller", db._reads.every((w) => w.affiliateId === "A"));

  // Row disappears between the write and the re-read → clean 404, not a crash.
  const db2 = seed();
  const realUpdateMany = db2.affiliateOrder.updateMany;
  db2.affiliateOrder.updateMany = async (args) => {
    const r = await realUpdateMany(args);
    db2._orders.splice(db2._orders.findIndex((o) => o.id === "a-pending"), 1);
    return r;
  };
  ok("vanished order after write → ORDER_NOT_FOUND (no TypeError)",
    (await code(() => updateAffiliateOrderStatus("a-pending", "confirmed", { affiliateId: "A", db: db2 }))) === "ORDER_NOT_FOUND");
}

// ── 2. Delivered / terminal orders are locked ────────────────────────────────
console.log("\n2. Locked statuses");
{
  const db = seed();
  for (const target of ["cancelled", "confirmed"]) {
    ok(`own delivered order cannot become ${target}`,
      (await code(() => updateAffiliateOrderStatus("a-delivered", target, { affiliateId: "A", db }))) === "ORDER_LOCKED");
  }
  ok("own delivered order is still delivered", statusOf(db, "a-delivered") === "delivered");
  ok("own 'Delivered' (admin casing) is locked too",
    (await code(() => updateAffiliateOrderStatus("a-Delivered", "cancelled", { affiliateId: "A", db }))) === "ORDER_LOCKED");
  ok("own cancelled order cannot be re-confirmed",
    (await code(() => updateAffiliateOrderStatus("a-cancelled", "confirmed", { affiliateId: "A", db }))) === "ORDER_LOCKED");
  ok("'delivered' is not an editable source status", !AFFILIATE_EDITABLE_ORDER_STATUSES.includes("delivered"));
}

// ── 3. Only confirmed / cancelled may be set ─────────────────────────────────
console.log("\n3. Target status whitelist");
{
  const db = seed();
  for (const s of ["delivered", "shipped", "pending", "DELIVERED", "", undefined, null, 42]) {
    ok(`setting ${JSON.stringify(s)} is refused`,
      (await code(() => updateAffiliateOrderStatus("a-pending", s, { affiliateId: "A", db }))) === "INVALID_STATUS");
  }
  ok("own pending order untouched by refused targets", statusOf(db, "a-pending") === "pending");
  ok("settable statuses are exactly confirmed|cancelled",
    JSON.stringify(AFFILIATE_SETTABLE_ORDER_STATUSES) === JSON.stringify(["confirmed", "cancelled"]));
  ok("non-string id is refused",
    (await code(() => updateAffiliateOrderStatus({ in: ["b-pending"] }, "cancelled", { affiliateId: "A", db }))) === "INVALID_ID");
}

// ── 4. Legitimate behaviour preserved ────────────────────────────────────────
console.log("\n4. Legitimate dashboard actions");
{
  const db = seed();
  const r1 = await updateAffiliateOrderStatus("a-pending", "confirmed", { affiliateId: "A", db });
  ok("own pending → confirmed", r1.status === "confirmed" && r1.id === "a-pending");
  const r2 = await updateAffiliateOrderStatus("a-shipped", "cancelled", { affiliateId: "A", db });
  ok("own shipped → cancelled", r2.status === "cancelled");
  const r3 = await updateAffiliateOrderStatus("a-confirmed", "cancelled", { affiliateId: "A", db });
  ok("own confirmed → cancelled", r3.status === "cancelled");
  const db2 = seed();
  const r4 = await updateAffiliateOrderStatus("a-pending", "cancelled", { affiliateId: "A", db: db2 });
  ok("own pending → cancelled", r4.status === "cancelled");
  ok("response keeps the mapped shape (_id + affiliateId)", r4._id === "a-pending" && r4.affiliateId === "A");
  ok("B's orders untouched by A's actions", statusOf(db, "b-pending") === "pending" && statusOf(db2, "b-pending") === "pending");
}

// ── 5. Race: admin delivers between page load and affiliate click ────────────
console.log("\n5. Conditional write");
{
  const db = seed();
  db._orders.find((o) => o.id === "a-shipped").status = "delivered"; // admin wins the race
  ok("stale cancel after admin delivery is locked",
    (await code(() => updateAffiliateOrderStatus("a-shipped", "cancelled", { affiliateId: "A", db }))) === "ORDER_LOCKED");
  ok("…delivery is preserved", statusOf(db, "a-shipped") === "delivered");
}

// ── 6. Route wiring (static — the route imports '@/' aliases node can't load) ─
console.log("\n6. Route wiring");
{
  const src = readFileSync(new URL("../src/app/api/affiliate/orders/route.js", import.meta.url), "utf8");
  ok("PUT stays wrapped in withAffiliateAuth", /export const PUT\s*=\s*withAffiliateAuth\(putHandler\)/.test(src));
  ok("putHandler receives the decoded token", /async function putHandler\(req,\s*_ctx,\s*decoded\)/.test(src));
  ok("service is scoped to decoded.affiliateId",
    /updateAffiliateOrderStatus\(id,\s*status,\s*\{\s*affiliateId:\s*decoded\.affiliateId\s*\}\)/.test(src));
  ok("affiliateId is never read from the request body", !/affiliateId[^\n]*=\s*await req\.json|\{[^}]*affiliateId[^}]*\}\s*=\s*await req\.json/.test(src));
  ok("ORDER_NOT_FOUND → 404", /ORDER_NOT_FOUND:\s*404/.test(src));
  ok("ORDER_LOCKED → 409", /ORDER_LOCKED:\s*409/.test(src));
  ok("INVALID_STATUS → 400", /INVALID_STATUS:\s*400/.test(src));
}

// ── 7. Route behaviour (real handler, '@/' resolved to src/) ─────────────────
// Only paths that return BEFORE any database query are exercised here, so no DB
// is needed. JWT_SECRET is a throwaway test value, set only in this process.
console.log("\n7. Route request handling");
{
  register(`data:text/javascript,${encodeURIComponent(`
    const SRC = ${JSON.stringify(new URL("../src/", import.meta.url).href)};
    export async function resolve(spec, ctx, next) {
      if (spec.startsWith("@/")) {
        const base = SRC + spec.slice(2);
        try { return await next(base, ctx); } catch { return next(base + ".js", ctx); }
      }
      return next(spec, ctx);
    }`)}`);
  process.env.JWT_SECRET ||= "test-only-secret-not-used-anywhere-else";
  const { PUT } = await import("../src/app/api/affiliate/orders/route.js");
  const { signToken } = await import("../src/lib/services/authService.js");
  const token = signToken({ affiliateId: "A", username: "a", type: "affiliate" });

  const call = (body, auth = true) => PUT(new Request("http://x/api/affiliate/orders", {
    method: "PUT",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body,
  }), {});
  const silence = console.error; console.error = () => {}; // a 500 path would log; we assert none occur
  try {
    for (const [name, body] of [
      ["malformed JSON", "{not json"], ["empty body", ""], ["JSON null", "null"],
      ["JSON array", '["a-pending","cancelled"]'], ["JSON string", '"a-pending"'], ["JSON number", "7"],
    ]) {
      const res = await call(body);
      ok(`${name} → 400`, res.status === 400);
    }
    ok("missing id → 400", (await call(JSON.stringify({ status: "cancelled" }))).status === 400);
    const inv = await call(JSON.stringify({ id: "a-pending", status: "delivered" }));
    ok("status 'delivered' → 400 with message", inv.status === 400 && (await inv.json()).error === "Statut non autorisé");
    ok("object id → 400", (await call(JSON.stringify({ id: { in: ["x"] }, status: "cancelled" }))).status === 400);
    ok("no token → 401", (await call(JSON.stringify({ id: "a-pending", status: "cancelled" }), false)).status === 401);
  } finally {
    console.error = silence;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
