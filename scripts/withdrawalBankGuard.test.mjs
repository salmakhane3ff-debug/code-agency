#!/usr/bin/env node
/**
 * scripts/withdrawalBankGuard.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Withdrawal requires complete banking info (server-side gate). Tests the pure
 * validateBankInfo rule + that requestPayout rejects incomplete bank info BEFORE
 * touching the balance. Also checks the avatar image type gate. No DB / no network.
 * Run: node scripts/withdrawalBankGuard.test.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { validateBankInfo } from "../src/lib/services/affiliateSystemService.js";
import { isAcceptedAvatarType } from "../src/lib/demoAvatarImage.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  PASS ", n); } else { fail++; console.log("  FAIL ", n); } };

console.log("1) validateBankInfo — trim + required + RIB length 10–34:");
{
  const good = { bankName: "CIH", accountName: "Ahmed B", rib: "1234567890123" };
  ok("complete info → no errors", validateBankInfo(good).length === 0);
  ok("empty bankName rejected", validateBankInfo({ ...good, bankName: "  " }).includes("bankName"));
  ok("empty accountName rejected", validateBankInfo({ ...good, accountName: "" }).includes("accountName"));
  ok("empty rib rejected", validateBankInfo({ ...good, rib: "   " }).includes("rib"));
  ok("RIB too short (<10) rejected", validateBankInfo({ ...good, rib: "123456789" }).includes("ribLength"));
  ok("RIB too long (>34) rejected", validateBankInfo({ ...good, rib: "1".repeat(35) }).includes("ribLength"));
  ok("RIB exactly 10 accepted", validateBankInfo({ ...good, rib: "1234567890" }).length === 0);
  ok("RIB exactly 34 accepted", validateBankInfo({ ...good, rib: "1".repeat(34) }).length === 0);
  ok("values are trimmed before checking", validateBankInfo({ bankName: " CIH ", accountName: " A ", rib: "  1234567890  " }).length === 0);
  ok("missing object → all required flagged", validateBankInfo({}).length >= 3);
}

console.log("2) avatar upload type gate (JPG/PNG/WEBP only):");
{
  ok("jpeg accepted", isAcceptedAvatarType("image/jpeg"));
  ok("png accepted", isAcceptedAvatarType("image/png"));
  ok("webp accepted", isAcceptedAvatarType("image/webp"));
  ok("gif rejected", !isAcceptedAvatarType("image/gif"));
  ok("pdf rejected", !isAcceptedAvatarType("application/pdf"));
  ok("empty rejected", !isAcceptedAvatarType(""));
}

console.log("3) requestPayout rejects incomplete bank info BEFORE touching balance:");
{
  const { requestPayout } = await import("../src/lib/services/affiliateSystemService.js");

  // Fake db: records whether the balance transaction was ever entered.
  const makeDb = (bank) => {
    const s = { txEntered: false, created: null };
    return {
      _s: s,
      affiliate: { findUnique: async () => bank },
      $transaction: async (fn) => {
        s.txEntered = true;
        return fn({
          affiliatePayout: { create: async ({ data }) => { s.created = data; return { id: "p1", ...data }; } },
        });
      },
    };
  };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };

  const incomplete = makeDb({ bankName: "", accountName: "", rib: "" });
  const code = await codeOf(() => requestPayout("aff1", 50, incomplete));
  ok("incomplete bank → throws INCOMPLETE_BANK_INFO", code === "INCOMPLETE_BANK_INFO");
  ok("balance transaction was NEVER entered", incomplete._s.txEntered === false);
  ok("no payout row created", incomplete._s.created === null);

  const badRib = makeDb({ bankName: "CIH", accountName: "A", rib: "123" });
  ok("short RIB also blocks", (await codeOf(() => requestPayout("aff1", 50, badRib))) === "INCOMPLETE_BANK_INFO" && badRib._s.txEntered === false);

  // Complete bank info → proceeds into the (mocked) balance transaction.
  const complete = {
    _s: { txEntered: false, created: null },
  };
  complete.affiliate = { findUnique: async () => ({ bankName: "CIH", accountName: "Ahmed", rib: "1234567890123" }) };
  // Identity must be APPROVED to pass the (later) identity gate before the tx.
  complete.identityVerification = { findUnique: async () => ({ status: "APPROVED" }) };
  complete.$transaction = async (fn) => { complete._s.txEntered = true; return fn(complete); };
  complete.affiliatePayout = { create: async ({ data }) => { complete._s.created = data; return { id: "p1", ...data }; } };
  // getAffiliateBalance uses the injected tx (complete) → needs ugcEarning/affiliateOrder aggregates.
  // Provide the minimal shape the balance providers read so the tx can run.
  complete.affiliateOrder = { findMany: async () => [], aggregate: async () => ({ _sum: {} }) };
  complete.ugcEarning = { aggregate: async () => ({ _sum: { amount: null } }) };
  complete.affiliatePayout.aggregate = async () => ({ _sum: { amount: null } });
  const okCode = await codeOf(() => requestPayout("aff1", 0.01, complete));
  ok("complete bank info passes the bank gate (reaches balance tx)", complete._s.txEntered === true || okCode === "INSUFFICIENT_BALANCE");
}

console.log("4) Phase 4 (bank logo picker) — a catalogue bank with ribRequired = false needs no RIB:");
{
  const { requestPayout } = await import("../src/lib/services/affiliateSystemService.js");
  ok("ribRequired false → holder + bank name enough (no RIB)", validateBankInfo({ bankName: "Cash Plus", accountName: "A", rib: null, ribRequired: false }).length === 0);
  ok("ribRequired false → holder still required", validateBankInfo({ bankName: "Cash Plus", accountName: " ", ribRequired: false }).includes("accountName"));
  ok("ribRequired false → bank name still required", validateBankInfo({ bankName: "", accountName: "A", ribRequired: false }).includes("bankName"));
  ok("ribRequired true / undefined → the original RIB rule", validateBankInfo({ bankName: "CIH", accountName: "A", rib: "", ribRequired: true }).includes("rib")
    && validateBankInfo({ bankName: "CIH", accountName: "A", rib: "123" }).includes("ribLength"));

  const makeDb = (row) => {
    const s = { txEntered: false, idvRead: false, select: null };
    const db = {
      _s: s,
      affiliate: { findUnique: async (args) => { if (!s.select) s.select = args.select; return row; } },
      identityVerification: { findUnique: async () => { s.idvRead = true; return { status: "PENDING" }; } },
      $transaction: async () => { s.txEntered = true; throw new Error("not reached"); },
    };
    return db;
  };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
  const ribless = makeDb({ bankName: "Cash Plus", accountName: "Ahmed", rib: null, bank: { ribRequired: false } });
  ok("rib null + bank { ribRequired:false } passes the bank gate (next gate: identity)", (await codeOf(() => requestPayout("aff1", 10, ribless))) === "IDENTITY_NOT_VERIFIED" && ribless._s.idvRead === true);
  ok("requestPayout reads bank.ribRequired", ribless._s.select?.bank?.select?.ribRequired === true);
  const req = makeDb({ bankName: "CIH Bank", accountName: "Ahmed", rib: null, bank: { ribRequired: true } });
  ok("rib null + bank { ribRequired:true } → INCOMPLETE_BANK_INFO (identity never read)", (await codeOf(() => requestPayout("aff1", 10, req))) === "INCOMPLETE_BANK_INFO" && req._s.idvRead === false);
  const none = makeDb({ bankName: "CIH", accountName: "Ahmed", rib: null, bank: null });
  ok("rib null + no catalogue bank → INCOMPLETE_BANK_INFO", (await codeOf(() => requestPayout("aff1", 10, none))) === "INCOMPLETE_BANK_INFO" && none._s.txEntered === false);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
