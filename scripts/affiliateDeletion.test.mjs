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
 *   • Phase 7 Stage F (recruiter ownership — topmost link): an affiliate that still
 *     has children is refused FIRST (AFFILIATE_HAS_CHILDREN, French message, 409),
 *     before anything else is read or written; the database trigger of migration
 *     20261112 (affiliates_children_delete_guard) is reported the same way; a leaf
 *     (and a parent once its children are gone) is still deleted
 * Run: node scripts/affiliateDeletion.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { makeRewardsFakeDb } from "./lib/rewardsFakeDb.mjs";
import {
  deleteAffiliateSafely, isForeignKeyViolation, AFFILIATE_HAS_HISTORY, AFFILIATE_HAS_HISTORY_MESSAGE,
  AFFILIATE_HAS_CHILDREN, AFFILIATE_HAS_CHILDREN_MESSAGE, isChildrenViolation,
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

console.log("\n1b. Stage F: an affiliate with children is never deleted (app check first; the DB trigger mapped the same way)");
{
  const tree = () => makeRewardsFakeDb({
    affiliate: [
      { id: "TOP", isActive: true, createdAt: new Date() },
      { id: "MID", parentId: "TOP", isActive: true, createdAt: new Date() },
      { id: "LEAF", parentId: "MID", isActive: true, createdAt: new Date() },
    ],
    rewardPointsAccount: [{ affiliateId: "MID", balance: 0, version: 1 }],
  });
  const T = tree();
  const calls0 = { ...T._stats.calls };
  for (const id of ["TOP", "MID"]) {
    const e = await caught(() => deleteAffiliateSafely(T, id));
    ok(`${id} (has a child) → AFFILIATE_HAS_CHILDREN with the French message, affiliate kept`, e?.code === AFFILIATE_HAS_CHILDREN && e.message === AFFILIATE_HAS_CHILDREN_MESSAGE && T._tables.affiliate.some((a) => a.id === id));
  }
  const delta = Object.fromEntries(Object.entries(T._stats.calls).map(([k, v]) => [k, v - (calls0[k] ?? 0)]).filter(([, v]) => v > 0));
  ok("the children check runs FIRST: only affiliate.count was called (no history read, no points-account delete, no affiliate delete)",
    JSON.stringify(Object.keys(delta).sort()) === JSON.stringify(["affiliate.count"]) && delta["affiliate.count"] === 2, JSON.stringify(delta));
  ok("…the empty points account of MID is untouched (nothing written)", T._tables.rewardPointsAccount.some((a) => a.affiliateId === "MID"));
  ok("a leaf is still deleted; then its parent (no child left) too; the top last", (await deleteAffiliateSafely(T, "LEAF")) === true && (await deleteAffiliateSafely(T, "MID")) === true
    && !T._tables.rewardPointsAccount.some((a) => a.affiliateId === "MID") && (await deleteAffiliateSafely(T, "TOP")) === true && T._tables.affiliate.length === 0);
  ok("the message is French, names the reason and tells the admin to deactivate", /affiliés rattachés/.test(AFFILIATE_HAS_CHILDREN_MESSAGE) && /Désactivez-le/.test(AFFILIATE_HAS_CHILDREN_MESSAGE));
  // the database backstop (a child inserted concurrently, after the app check): the trigger's error → the same safe code
  const R = tree();
  R._stats.hooks["affiliate.delete"] = async () => { throw Object.assign(new Error("Raw query failed. Code: `23514`. Message: `AFFILIATE_HAS_CHILDREN: affiliate LEAF has children and cannot be deleted`"), { code: "P2010" }); };
  const silence2 = console.error; console.error = () => {};
  const dbErr = await caught(() => deleteAffiliateSafely(R, "LEAF"));
  console.error = silence2;
  ok("the DB trigger refusal (affiliates_children_delete_guard) → AFFILIATE_HAS_CHILDREN, raw text never exposed, affiliate kept",
    dbErr?.code === AFFILIATE_HAS_CHILDREN && dbErr.message === AFFILIATE_HAS_CHILDREN_MESSAGE && !/23514|Raw query|trigger/i.test(dbErr.message) && R._tables.affiliate.some((a) => a.id === "LEAF"));
  ok("isChildrenViolation: message / meta.message / cause.message carrying the code; nothing else",
    isChildrenViolation({ message: "x AFFILIATE_HAS_CHILDREN y" }) && isChildrenViolation({ meta: { message: "AFFILIATE_HAS_CHILDREN" } }) && isChildrenViolation({ cause: { message: "AFFILIATE_HAS_CHILDREN" } })
    && !isChildrenViolation({ code: "P2003" }) && !isChildrenViolation(null));
  const mig = readFileSync(new URL("../prisma/migrations/20261112_recruiter_group_rewards/migration.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
  ok("migration 20261112: BEFORE DELETE trigger on affiliates (re-runnable), row locked FOR UPDATE, check_violation with AFFILIATE_HAS_CHILDREN; the parentId foreign key is not altered",
    /CREATE OR REPLACE FUNCTION affiliates_children_delete_guard\(\)/.test(mig) && /DROP TRIGGER IF EXISTS "affiliates_children_delete_guard" ON "affiliates";\s*CREATE TRIGGER "affiliates_children_delete_guard" BEFORE DELETE ON "affiliates"/.test(mig)
    && /PERFORM 1 FROM "affiliates" WHERE "id" = OLD\."id" FOR UPDATE;/.test(mig) && /RAISE EXCEPTION 'AFFILIATE_HAS_CHILDREN:/.test(mig) && /ERRCODE = 'check_violation'/.test(mig)
    && !/affiliates_parentId_fkey/.test(mig) && !/ALTER TABLE "affiliates"/.test(mig));
}

console.log("\n2. Routes & pages (static — '@/' route imports need the app runtime)");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const adminRoute = read("../src/app/api/admin/affiliates/route.js");
const legacyCtl = read("../src/lib/controllers/affiliateController.js");
for (const [name, src] of [["/api/admin/affiliates DELETE", adminRoute], ["/api/affiliate DELETE (legacy)", legacyCtl]]) {
  ok(`${name}: AFFILIATE_HAS_HISTORY → 409 with the message`,
    /err\?\.code === AFFILIATE_HAS_HISTORY/.test(src) && /\{ error: err\.message, code: err\.code \}, \{ status: 409 \}/.test(src));
}
ok("admin route DELETE still admin-wrapped", /export const DELETE = withAdminAuth\(deleteHandler\)/.test(adminRoute));
for (const [name, src] of [["/api/admin/affiliates DELETE", adminRoute], ["/api/affiliate DELETE (legacy)", legacyCtl]]) {
  ok(`Stage F: ${name}: AFFILIATE_HAS_CHILDREN → the same 409 with the message`, /err\?\.code === AFFILIATE_HAS_HISTORY \|\| err\?\.code === AFFILIATE_HAS_CHILDREN\) \{\s*return Response\.json\(\{ error: err\.message, code: err\.code \}, \{ status: 409 \}\);/.test(src));
}
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
