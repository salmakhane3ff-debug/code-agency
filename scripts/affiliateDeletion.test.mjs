#!/usr/bin/env node
/**
 * scripts/affiliateDeletion.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiliates with history must be DEACTIVATED, not hard-deleted. Proves, with
 * the rewards fake DB (real rollback; affiliate FK modelled as RESTRICT):
 *   • points history (ledger / order awards / gift requests) blocks deletion
 *     with AFFILIATE_HAS_HISTORY and leaves everything intact
 *   • any other reference (orders…) → same safe error, raw DB text never exposed
 *   • an empty points account does not block, and is removed with the affiliate
 *   • both admin delete routes answer 409 with the message; both admin pages
 *     show it instead of failing silently / dropping the row
 * Run: node scripts/affiliateDeletion.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { makeRewardsFakeDb } from "./lib/rewardsFakeDb.mjs";
import {
  deleteAffiliateSafely, isForeignKeyViolation, AFFILIATE_HAS_HISTORY, AFFILIATE_HAS_HISTORY_MESSAGE,
} from "../src/lib/affiliateDeletion.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };
async function caught(fn) { try { await fn(); return null; } catch (e) { return e; } }

const affs = () => ["FREE", "EMPTY", "LEDGER", "AWARD", "REDEEM", "ORDERS"].map((id) => ({ id, isActive: true, createdAt: new Date() }));
const db = makeRewardsFakeDb({
  affiliate: affs(),
  rewardPointsAccount: [{ affiliateId: "EMPTY", balance: 0, version: 3 }, { affiliateId: "LEDGER", balance: 25, version: 1 }],
  rewardPointsLedger: [{ id: "l1", affiliateId: "LEDGER", delta: 25, type: "SIGNUP_BONUS", idempotencyKey: "signup:LEDGER", balanceAfter: 25 }],
  rewardOrderAward: [{ id: "w1", affiliateOrderId: "ao-x", orderId: null, affiliateId: "AWARD", points: 0, state: "EXCLUDED", version: 1 }],
  rewardRedemption: [{ id: "r1", reference: "RW-1", affiliateId: "REDEEM", clientRequestId: "req-00000001", status: "CANCELLED", pointsCost: 5 }],
  affiliateOrder: [{ id: "ao-o", affiliateId: "ORDERS", status: "pending" }],
});
const exists = (id) => db._tables.affiliate.some((a) => a.id === id);

console.log("\n1. Service");
ok("unreferenced affiliate is deleted", (await deleteAffiliateSafely(db, "FREE")) === true && !exists("FREE"));
ok("empty points account does not block; it is removed too",
  (await deleteAffiliateSafely(db, "EMPTY")) === true && !exists("EMPTY") && !db._tables.rewardPointsAccount.some((a) => a.affiliateId === "EMPTY"));
for (const id of ["LEDGER", "AWARD", "REDEEM"]) {
  const e = await caught(() => deleteAffiliateSafely(db, id));
  ok(`${id}: points history → AFFILIATE_HAS_HISTORY`, e?.code === AFFILIATE_HAS_HISTORY && e.message === AFFILIATE_HAS_HISTORY_MESSAGE);
  ok(`${id}: affiliate kept`, exists(id));
}
ok("history case rolled back: points account + ledger untouched",
  db._tables.rewardPointsAccount.some((a) => a.affiliateId === "LEDGER" && a.balance === 25) && db._tables.rewardPointsLedger.length === 1);

const silence = console.error; console.error = () => {};
const fk = await caught(() => deleteAffiliateSafely(db, "ORDERS"));
console.error = silence;
ok("other references (orders) → same safe AFFILIATE_HAS_HISTORY", fk?.code === AFFILIATE_HAS_HISTORY && exists("ORDERS"));
ok("raw database text never in the message", !/constraint|foreign|P2003|23503/i.test(fk?.message || ""));
ok("message tells the admin to deactivate", /Désactivez-le/.test(AFFILIATE_HAS_HISTORY_MESSAGE));
ok("unknown id → false (404)", (await deleteAffiliateSafely(db, "NOPE")) === false);

const boom = makeRewardsFakeDb({ affiliate: affs() });
boom._stats.hooks["affiliate.delete"] = async () => { throw Object.assign(new Error("connection lost"), { code: "P1001" }); };
ok("unrelated errors are rethrown (→ 500, logged by the route)", (await caught(() => deleteAffiliateSafely(boom, "FREE")))?.code === "P1001");
ok("FK detection: P2003 / adapter 23503 / meta 23503",
  isForeignKeyViolation({ code: "P2003" }) && isForeignKeyViolation({ cause: { originalCode: "23503" } })
  && isForeignKeyViolation({ meta: { code: "23503" } }) && !isForeignKeyViolation({ code: "P2025" }) && !isForeignKeyViolation(null));

console.log("\n2. Routes & pages (static — '@/' route imports need the app runtime)");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const adminRoute = read("../src/app/api/admin/affiliates/route.js");
const legacyCtl = read("../src/lib/controllers/affiliateController.js");
for (const [name, src] of [["/api/admin/affiliates DELETE", adminRoute], ["/api/affiliate DELETE (legacy)", legacyCtl]]) {
  ok(`${name}: AFFILIATE_HAS_HISTORY → 409 with the message`,
    /err\?\.code === AFFILIATE_HAS_HISTORY/.test(src) && /\{ error: err\.message, code: err\.code \}, \{ status: 409 \}/.test(src));
}
ok("admin route DELETE still admin-wrapped", /export const DELETE = withAdminAuth\(deleteHandler\)/.test(adminRoute));
ok("both services delegate to deleteAffiliateSafely",
  /return deleteAffiliateSafely\(prisma, id\)/.test(read("../src/lib/services/affiliateSystemService.js"))
  && /return deleteAffiliateSafely\(prisma, id\)/.test(read("../src/lib/services/affiliateService.js")));
const page = read("../src/app/admin/affiliates/page.jsx");
ok("/admin/affiliates shows the API error on a failed delete",
  /if \(!res\.ok\) \{\s*const d = await res\.json\(\)\.catch\(\(\) => \(\{\}\)\);\s*setError\(d\.error \|\| "Erreur suppression"\);/.test(page));
const legacy = read("../src/app/admin/affiliate/page.jsx");
ok("/admin/affiliate (legacy) keeps the row and alerts on a failed delete",
  /if \(!res\.ok\) \{[\s\S]*?alert\(d\.error \|\| "Suppression impossible"\);\s*return;\s*\}\s*setAffiliates/.test(legacy));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
