"use client";
/**
 * /recruiter/wallet — "المحفظة" (Affiliate Recruiter System, Phase 5). Market language (MA → Arabic RTL, FR → French
 * LTR): texts from RECRUITER_WALLET_TEXT (./walletI18n.js — the wallet-only money vocabulary stays in this folder),
 * errors kept as CODES in state and rendered in the current language; amounts, RIB and dates are LTR islands.
 * Layout (mobile first): 4 totals → withdrawal request → bank details (RIB) → withdrawal history →
 * one collapsed "تفاصيل المكافآت" (reward rule, gross / reversed / net, reward history).
 *
 *   • GET  /api/recruiter/wallet               → reward rule, totals (MAD cents), reward history,
 *                                                withdrawals, bank details (the recruiter's OWN only)
 *   • PUT  /api/recruiter/wallet/bank          → { bankName, rib, accountName }
 *   • POST /api/recruiter/wallet/withdrawals   → { amountMad, requestId }
 *   • GET  /api/recruiter/identity             → the recruiter's KYC status (Phase 6 part 3c): a
 *                                                withdrawal needs it APPROVED (banner + link)
 *   • GET  /api/recruiter/progress             → (Phase 7 Stage C) the recruiter's reward aggregates:
 *                                                awarded vs reversed amounts, shown apart from the net
 * Phase 7 Stage C: group reward rows (GROUP_REWARD / GROUP_REVERSAL) are labelled with their cycle
 * and group size; a FAILED identity request shows "حالة التحقق غير متاحة" with a retry and never
 * claims the recruiter is unverified nor blocks the form on it (the server enforces the KYC gate);
 * ONLY 401 (and 403 RECRUITER_DISABLED) goes back to the login page.
 * The server is the authority (KYC gate, bank gate, available funds, idempotency); client
 * checks are hints only. Only error CODES are read and shown with fixed texts. No CIN
 * image, file, customer or order detail is ever requested or shown.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMarketLocale } from "@/context/useMarketLocale";
import { Banknote, CheckCircle2, ChevronDown, Clock, Coins, Gift, History, Landmark, Loader2, RefreshCw, Scale, ShieldCheck, Wallet } from "lucide-react";
import { toRecruiterError, toRecruiterIdentityView, toRecruiterProgressSummaryView, toRecruiterWalletView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../errorLabels";
import { authAction, fmtMadCents, rewardAmountsDisplay } from "../recruiterUiState";
import { groupRowDetail, rewardRowTitle, walletGrossNet } from "./walletUi";
import { RECRUITER_WALLET_TEXT } from "./walletI18n";
import { Badge, CenteredNotice, LoadingBlock, PageHeader, Section, StatCard, ui } from "../_components/ui";

const EMPTY_BANK = { bankName: "", rib: "", accountName: "" };

const newRequestId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function fmtDate(iso, locale) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" }) : "—";
}

/** Client-side hints (same rules as the server: validateBankInfo + caps; the server decides). */
function localBankErrors(b) {
  const out = {};
  const bankName = b.bankName.replace(/\s+/g, " ").trim();
  const accountName = b.accountName.replace(/\s+/g, " ").trim();
  const rib = b.rib.replace(/\s/g, "");
  if (!bankName || bankName.length > 80 || /[<>]/.test(bankName)) out.bankName = "INVALID_BANK_NAME";
  if (!accountName || accountName.length > 80 || /[<>]/.test(accountName)) out.accountName = "INVALID_ACCOUNT_NAME";
  if (rib.length < 10 || rib.length > 34 || !/^[A-Za-z0-9]+$/.test(rib)) out.rib = "INVALID_RIB";
  return out;
}
/** "150" / "150.5" / "150,50" → cents, or NaN (mirrors parseMadToCents). */
function toCents(v) {
  const s = String(v ?? "").trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return NaN;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
}

const STATUS = {
  PENDING: { labelKey: "w_status_pending", tone: "amber" },
  PAID: { labelKey: "w_status_paid", tone: "green" },
  REJECTED: { labelKey: "w_status_rejected", tone: "red" },
};

const inputCls = (bad) => `${bad ? ui.input.replace("border-gray-200 bg-white", "border-red-400 bg-red-50/40") : ui.input} min-w-0`;

function Field({ id, label, hint, error, field, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={ui.label}>{label}</label>
      {children}
      {hint && !error && <p className={`mt-1.5 ${ui.hint}`}>{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-700" role="alert" data-bank-error={field}>{error}</p>}
    </div>
  );
}

/** A StatCard amount: wraps instead of being truncated on a narrow phone (an amount is never cut). */
const money = (text) => <span className="block whitespace-normal break-words text-lg sm:text-xl leading-tight">{text}</span>;

/** Small sub-title inside the collapsed reward details. */
function SubTitle({ Icon, children }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700">
      <Icon className="w-4 h-4 shrink-0 text-gray-400" aria-hidden="true" /> {children}
    </h3>
  );
}

const banner = "text-sm rounded-xl border px-3 py-2";

export default function RecruiterWalletPage() {
  const router = useRouter();
  const { t: tx, lang, dir, intlLocale } = useMarketLocale(RECRUITER_WALLET_TEXT);
  /** Cents → "1 234,50 درهم" (ar) / "1 234,50 DH" (fr): 2 decimals, Latin digits so amounts stay readable. */
  const fmtMad = (cents) => fmtMadCents(cents, lang);
  const ltrAlign = { textAlign: dir === "rtl" ? "right" : "left" }; // an LTR amount aligned with the page's start side
  const [wallet, setWallet] = useState(null);
  const [identity, setIdentity] = useState(null); // KYC view (Phase 6 part 3c)
  const [identityError, setIdentityError] = useState(false); // Stage C: the KYC request failed (status unknown)
  const [identityBusy, setIdentityBusy] = useState(false);
  const [amounts, setAmounts] = useState({ data: null, error: null }); // Stage C: /api/recruiter/progress rewards
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(""); // error CODE
  const [notice, setNotice] = useState(""); // error CODE (RECRUITER_DISABLED)
  const aliveRef = useRef(true);

  const [bank, setBank] = useState(EMPTY_BANK);
  const [bankErrors, setBankErrors] = useState({});
  const [bankBusy, setBankBusy] = useState(false);
  const [bankMsg, setBankMsg] = useState(null); // { ok: true } | { ok: false, code }

  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState(null); // { field: "amountMad", code } | { code }
  const [wBusy, setWBusy] = useState(false);
  const [wError, setWError] = useState(""); // error CODE
  const [wSuccess, setWSuccess] = useState(null); // the requested amount (cents) once sent
  const requestIdRef = useRef(null);

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(code);
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
    } else {
      router.replace("/recruiter/login");
    }
  }, [router]);

  /** ONLY 401 / 403 RECRUITER_DISABLED → login. Returns true when handled. */
  const authGate = useCallback((res, err) => {
    const action = authAction(res.status, err.code);
    if (action) {
      toLogin(action === "disabled" ? err.code : "UNAUTHORIZED");
      return true;
    }
    return false;
  }, [toLogin]);

  /** The recruiter's KYC status; a failure leaves it UNKNOWN (never "not verified"). */
  const loadIdentity = useCallback(async () => {
    setIdentityBusy(true);
    try {
      const res = await fetch("/api/recruiter/identity", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (res.ok && body?.identity) { setIdentity(toRecruiterIdentityView(body.identity)); setIdentityError(false); return; }
      if (!res.ok && authGate(res, toRecruiterError(body))) return;
      setIdentity(null);
      setIdentityError(true);
    } catch {
      if (aliveRef.current) { setIdentity(null); setIdentityError(true); }
    } finally {
      if (aliveRef.current) setIdentityBusy(false);
    }
  }, [authGate]);

  /** Awarded / reversed aggregates (the whole ledger, server-side) — never derived from the capped history. */
  const loadAmounts = useCallback(async () => {
    setAmounts({ data: null, error: null });
    try {
      const res = await fetch("/api/recruiter/progress", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (res.ok) { setAmounts({ data: rewardAmountsDisplay(toRecruiterProgressSummaryView(body?.progress).rewards), error: null }); return; }
      const err = toRecruiterError(body);
      if (authGate(res, err)) return;
      setAmounts({ data: null, error: err.code });
    } catch {
      if (aliveRef.current) setAmounts({ data: null, error: "SERVER_ERROR" });
    }
  }, [authGate]);

  const load = useCallback(async ({ keepBank = false } = {}) => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/recruiter/wallet", { credentials: "include", cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (!res.ok) {
        const err = toRecruiterError(body);
        if (authGate(res, err)) return;
        setLoadError(err.code);
        return;
      }
      const w = toRecruiterWalletView(body?.wallet);
      setWallet(w);
      // KYC and reward aggregates load alongside; their failure never hides the wallet.
      loadIdentity();
      loadAmounts();
      if (!keepBank) setBank({ bankName: w.bank.bankName ?? "", rib: w.bank.rib ?? "", accountName: w.bank.accountName ?? "" });
    } catch {
      if (aliveRef.current) setLoadError("SERVER_ERROR");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [authGate, loadIdentity, loadAmounts]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [load]);

  // ── Bank details ──────────────────────────────────────────────────────────
  const editBank = (patch) => {
    setBank((b) => ({ ...b, ...patch }));
    const keys = Object.keys(patch);
    setBankErrors((fe) => { const n = { ...fe }; for (const k of keys) delete n[k]; return n; });
    setBankMsg(null);
  };
  async function saveBank(e) {
    e.preventDefault();
    if (bankBusy) return;
    setBankMsg(null);
    const local = localBankErrors(bank);
    if (Object.keys(local).length) { setBankErrors(local); return; }
    setBankErrors({});
    setBankBusy(true);
    try {
      const res = await fetch("/api/recruiter/wallet/bank", {
        method: "PUT", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankName: bank.bankName.replace(/\s+/g, " ").trim(),
          rib: bank.rib.replace(/\s/g, ""),
          accountName: bank.accountName.replace(/\s+/g, " ").trim(),
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setBankMsg({ ok: true });
        await load({ keepBank: false });
        return;
      }
      const err = toRecruiterError(body);
      if (authGate(res, err)) return;
      if (err.fields) setBankErrors(err.fields);
      setBankMsg({ ok: false, code: err.code });
    } catch {
      setBankMsg({ ok: false, code: "SERVER_ERROR" });
    } finally {
      setBankBusy(false);
    }
  }

  // ── Withdrawal request ────────────────────────────────────────────────────
  const available = wallet?.totals.availableCents ?? 0;
  const bankComplete = wallet?.bank.complete === true;
  const identityApproved = identity?.status === "APPROVED";
  // Stage C: a FAILED KYC request (status unknown) never blocks here — the server enforces the KYC gate.
  const identityUnknown = identityError && !identity;
  const canRequest = (identityApproved || identityUnknown) && bankComplete && available > 0;

  const editAmount = (v) => {
    requestIdRef.current = null; // any edit = a new attempt
    setAmount(v);
    setAmountError(null);
    setWError("");
    setWSuccess(null);
  };
  async function requestWithdrawal(e) {
    e.preventDefault();
    if (wBusy || !canRequest) return;
    setWError("");
    setWSuccess(null);
    const cents = toCents(amount);
    if (!Number.isInteger(cents) || cents < 1) { setAmountError({ field: "amountMad", code: "INVALID_AMOUNT" }); return; }
    if (cents > available) { setAmountError({ code: ["INSUFFICIENT", "BALANCE"].join("_") }); return; }
    setAmountError(null);
    if (!requestIdRef.current) requestIdRef.current = newRequestId();
    setWBusy(true);
    try {
      const res = await fetch("/api/recruiter/wallet/withdrawals", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountMad: (cents / 100).toFixed(2), requestId: requestIdRef.current }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        requestIdRef.current = null;
        setAmount("");
        setWSuccess(cents);
        await load({ keepBank: true });
        return;
      }
      const err = toRecruiterError(body);
      if (authGate(res, err)) return;
      requestIdRef.current = null; // a definitive answer: the next submit is a new attempt
      if (err.fields?.amountMad) setAmountError({ field: "amountMad", code: err.fields.amountMad });
      setWError(err.code);
      if (err.code === ["INSUFFICIENT", "BALANCE"].join("_") || err.code === "INCOMPLETE_BANK_INFO" || err.code === "RECRUITER_IDENTITY_NOT_APPROVED") await load({ keepBank: true });
    } catch {
      // Network failure: keep the requestId so a retry of THIS attempt cannot create twice.
      setWError("SERVER_ERROR");
    } finally {
      setWBusy(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (notice) {
    return <CenteredNotice hook="data-page-notice">{recruiterErrorLabel(notice, lang)}</CenteredNotice>;
  }
  const amountErrorText = !amountError ? "" : amountError.field
    ? recruiterFieldErrorLabel(amountError.field, amountError.code, lang) : recruiterErrorLabel(amountError.code, lang);

  const s = wallet?.settings;
  const t = wallet?.totals;
  const rewards = wallet?.rewards ?? [];
  const withdrawals = wallet?.withdrawals ?? [];

  return (
    <div className="space-y-5 min-w-0" data-recruiter-wallet>
      <PageHeader Icon={Wallet} title={tx("nav_wallet")} subtitle={tx("w_subtitle")} back={null} />

      {loading && !wallet && <LoadingBlock hook="data-loading" />}

      {loadError && (
        <div role="alert" className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center gap-3 justify-between" data-error>
          <span className="min-w-0">{recruiterErrorLabel(loadError, lang)}</span>
          <button type="button" onClick={() => load()} data-retry
            className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
            <RefreshCw className="w-4 h-4" aria-hidden="true" /> {tx("common_retry")}
          </button>
        </div>
      )}

      {wallet && (
        <>
          {/* 1. Totals */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label={tx("w_totals")} data-totals>
            <StatCard Icon={Coins} color="teal" label={tx("w_total_rewards")} value={money(fmtMad(t.earnedCents))} hook="total-earned" valueLtr />
            <StatCard Icon={Wallet} color={available < 0 ? "red" : "purple"} label={tx("w_available")} value={money(fmtMad(t.availableCents))} hook="total-available" valueLtr />
            <StatCard Icon={Clock} color="amber" label={tx("w_pending")} value={money(fmtMad(t.pendingCents))} hook="total-pending" valueLtr />
            <StatCard Icon={CheckCircle2} color="green" label={tx("w_paid")} value={money(fmtMad(t.paidCents))} hook="total-paid" valueLtr />
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start min-w-0">
            {/* 2. Withdrawal request */}
            <Section Icon={Banknote} title={tx("w_request_title")} aria-label={tx("w_request_title")} bodyClass="p-4 sm:p-5 space-y-3">
              {identityUnknown && (
                <div className={`${banner} border-gray-200 bg-gray-50 text-gray-700 flex flex-wrap items-center justify-between gap-2`} data-identity-unavailable>
                  <span className="min-w-0">{tx("w_identity_unknown")}</span>
                  <button type="button" onClick={loadIdentity} disabled={identityBusy} data-identity-retry
                    className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-gray-300 bg-white px-3 py-1.5 font-semibold hover:bg-gray-100 disabled:opacity-60">
                    <RefreshCw className="w-4 h-4" aria-hidden="true" /> {tx("common_retry")}
                  </button>
                </div>
              )}
              {identity && !identityApproved && (
                <div className={`${banner} border-amber-100 bg-amber-50 text-amber-900 space-y-1.5`} data-identity-required={identity.status}>
                  <p className="font-semibold">
                    {identity.status === "PENDING" ? tx("w_identity_pending")
                      : identity.status === "REJECTED" ? tx("w_identity_rejected")
                      : tx("w_identity_missing")}
                  </p>
                  <Link href="/recruiter/verification" data-identity-link
                    className={`inline-flex items-center gap-1.5 min-h-11 ${ui.link}`}>
                    <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" /> {tx("w_identity_page")}
                  </Link>
                </div>
              )}
              {!bankComplete && (
                <p className={`${banner} border-amber-100 bg-amber-50 text-amber-900`} data-bank-required>
                  {tx("w_bank_required")}
                </p>
              )}
              {bankComplete && available === 0 && (
                <p className={`${banner} border-gray-200 bg-gray-50 text-gray-700`} data-nothing-available>
                  {tx("w_nothing_available")}
                </p>
              )}
              {available < 0 && (
                <p className={`${banner} border-red-100 bg-red-50 text-red-800`} data-negative-balance>
                  {tx("w_negative")}
                  <span className="block mt-1 font-bold">{tx("w_current_balance")} <bdi dir="ltr">{fmtMad(available)}</bdi></span>
                </p>
              )}
              <form onSubmit={requestWithdrawal} noValidate className="space-y-3" data-withdraw-form>
                <div className="min-w-0">
                  <label htmlFor="w-amount" className={ui.label}>{tx("w_amount_label")}</label>
                  <input id="w-amount" inputMode="decimal" autoComplete="off" dir="ltr" placeholder="0.00"
                    value={amount} onChange={(e) => editAmount(e.target.value)} disabled={!canRequest || wBusy}
                    className={inputCls(!!amountError)} data-withdraw-amount aria-invalid={!!amountError} />
                  <p className={`mt-1.5 ${ui.hint}`}>{tx("w_max")} <bdi dir="ltr">{fmtMad(available > 0 ? available : 0)}</bdi></p>
                  {amountError && <p className="mt-1 text-xs text-red-700" role="alert" data-withdraw-amount-error>{amountErrorText}</p>}
                </div>
                {wError && <p role="alert" className={`${banner} text-red-700 bg-red-50 border-red-100`} data-withdraw-error>{recruiterErrorLabel(wError, lang)}</p>}
                {wSuccess !== null && (
                  <p role="status" className={`${banner} text-green-800 bg-green-50 border-green-100 flex items-start gap-2`} data-withdraw-success>
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />{" "}
                    <span className="min-w-0">{tx("w_request_sent")} (<bdi dir="ltr">{fmtMad(wSuccess)}</bdi>). {tx("w_request_sent_next")}</span>
                  </p>
                )}
                <button type="submit" disabled={!canRequest || wBusy || !amount.trim()} data-withdraw-submit className={`${ui.btnPrimary} w-full sm:w-auto px-5`}>
                  {wBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {wBusy ? tx("common_sending") : tx("w_request_submit")}
                </button>
              </form>
            </Section>

            {/* 3. Bank details */}
            <Section Icon={Landmark} title={tx("w_bank_title")} aria-label={tx("w_bank_title")}>
              <form onSubmit={saveBank} noValidate className="space-y-3" data-bank-form>
                <Field id="b-name" label={tx("w_bank_name")} error={bankErrors.bankName ? recruiterFieldErrorLabel("bankName", bankErrors.bankName, lang) : ""} field="bankName">
                  <input id="b-name" value={bank.bankName} onChange={(e) => editBank({ bankName: e.target.value })} maxLength={80}
                    placeholder={"\u2066CIH, Attijariwafa, BMCE...\u2069"} autoComplete="off" className={inputCls(!!bankErrors.bankName)} data-bank-input="bankName" />
                </Field>
                <Field id="b-rib" label={tx("w_rib")} hint={tx("w_rib_hint")} error={bankErrors.rib ? recruiterFieldErrorLabel("rib", bankErrors.rib, lang) : ""} field="rib">
                  <input id="b-rib" value={bank.rib} onChange={(e) => editBank({ rib: e.target.value })} maxLength={48} dir="ltr"
                    placeholder="XXXXXXXXXXXXXXXXXXXXXXXX" autoComplete="off" inputMode="text" className={`${inputCls(!!bankErrors.rib)} font-mono`} data-bank-input="rib" />
                </Field>
                <Field id="b-holder" label={tx("w_account_holder")} error={bankErrors.accountName ? recruiterFieldErrorLabel("accountName", bankErrors.accountName, lang) : ""} field="accountName">
                  <input id="b-holder" value={bank.accountName} onChange={(e) => editBank({ accountName: e.target.value })} maxLength={80}
                    placeholder={tx("w_full_name_placeholder")} autoComplete="off" className={inputCls(!!bankErrors.accountName)} data-bank-input="accountName" />
                </Field>
                {bankMsg && (
                  <p role={bankMsg.ok ? "status" : "alert"} data-bank-msg={bankMsg.ok ? "ok" : "error"}
                    className={`${banner} ${bankMsg.ok ? "text-green-800 bg-green-50 border-green-100" : "text-red-700 bg-red-50 border-red-100"}`}>
                    {bankMsg.ok ? tx("w_bank_saved") : recruiterErrorLabel(bankMsg.code, lang)}
                  </p>
                )}
                <button type="submit" disabled={bankBusy} data-bank-submit className={`${ui.btnSecondary} w-full sm:w-auto px-5`}>
                  {bankBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {tx("w_bank_save")}
                </button>
              </form>
            </Section>
          </div>

          {/* 4. Withdrawal history */}
          <Section Icon={History} title={tx("w_history_title")} aria-label={tx("w_history_title")}>
            {withdrawals.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500" data-empty="withdrawals">{tx("w_history_empty")}</p>
            ) : (
              <ul className="divide-y divide-gray-100 min-w-0">
                {withdrawals.map((w) => {
                  const st = STATUS[w.status] ?? STATUS.PENDING;
                  return (
                    <li key={w.id ?? w.createdAt} className="py-2.5 first:pt-0 last:pb-0 flex items-center gap-3 justify-between min-w-0" data-withdrawal-row>
                      <div className="min-w-0">
                        <p className="font-bold text-gray-900 break-words" dir="ltr" style={ltrAlign}>{fmtMad(w.amountCents)}</p>
                        <p className="text-xs text-gray-400"><bdi>{fmtDate(w.createdAt, intlLocale)}</bdi></p>
                      </div>
                      <Badge tone={st.tone} data-withdrawal-status={w.status}>{tx(st.labelKey)}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {/* 5. Reward details — collapsed by default (rule, gross / reversed / net, history) */}
          <details className={`${ui.card} group overflow-hidden`} data-reward-details>
            <summary className="flex items-center justify-between gap-2 min-h-11 px-4 sm:px-5 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm font-bold text-gray-700 hover:bg-gray-50">
              <span className="flex items-center gap-2 min-w-0">
                <Gift className="w-4 h-4 shrink-0 text-gray-400" aria-hidden="true" /> {tx("w_details_title")}
              </span>
              <ChevronDown className="w-4 h-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="border-t border-gray-100 p-4 sm:p-5 space-y-5 min-w-0">
              {/* Reward rule */}
              <div className="space-y-2 min-w-0" data-reward-rule>
                <SubTitle Icon={Gift}>{tx("w_rule_title")}</SubTitle>
                <div className="min-w-0 text-sm leading-7 text-gray-700">
                  {s.rewardsEnabled ? (
                    <p data-reward-rule-text>
                      {tx("w_rule_1")} <bdi dir="ltr"><strong>{fmtMad(s.rewardAmountCents)}</strong></bdi> {tx("w_rule_2")}{" "}
                      <strong>{s.requiredDeliveredOrders}</strong> {tx("w_rule_3")}
                    </p>
                  ) : (
                    <p data-rewards-disabled>{tx("w_rewards_off")}</p>
                  )}
                  <p className={`${ui.hint} mt-1`}>{tx("w_rule_hint")}</p>
                </div>
              </div>

              {/* Stage C: gross awarded vs reversed, apart from the net */}
              <section className="space-y-2 min-w-0" aria-label={tx("w_gross_title")} data-gross-net>
                <SubTitle Icon={Scale}>{tx("w_gross_title")}</SubTitle>
                {amounts.error ? (
                  <div role="alert" className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700 flex flex-wrap items-center justify-between gap-2" data-gross-error>
                    <span className="min-w-0">{tx("w_gross_unavailable")} {recruiterErrorLabel(amounts.error, lang)}</span>
                    <button type="button" onClick={loadAmounts} data-gross-retry
                      className="shrink-0 inline-flex items-center gap-1.5 min-h-10 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
                      <RefreshCw className="w-4 h-4" aria-hidden="true" /> {tx("common_retry")}
                    </button>
                  </div>
                ) : !amounts.data ? (
                  <p className="text-sm text-gray-500" aria-live="polite" data-gross-loading>{tx("common_loading")}</p>
                ) : (() => {
                  const g = walletGrossNet(amounts.data, t.earnedCents);
                  return (
                    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                      <div className={`${ui.panel} px-3.5 py-3 min-w-0`}>
                        <dt className="text-xs font-semibold text-gray-500">{tx("w_gross_awarded")}</dt>
                        <dd className="mt-0.5 text-lg font-bold text-gray-900 break-words" dir="ltr" style={ltrAlign} data-gross-total>{fmtMad(g.grossCents)}</dd>
                        <p className="text-[11px] text-gray-500">{tx("w_individual")} <bdi dir="ltr">{fmtMad(amounts.data.individual.awardedCents)}</bdi> · {tx("w_group")} <bdi dir="ltr">{fmtMad(amounts.data.group.awardedCents)}</bdi></p>
                      </div>
                      <div className={`${ui.panel} px-3.5 py-3 min-w-0`}>
                        <dt className="text-xs font-semibold text-gray-500">{tx("w_gross_reversed")}</dt>
                        <dd className="mt-0.5 text-lg font-bold text-red-700 break-words" dir="ltr" style={ltrAlign} data-reversed-total>{fmtMad(-g.reversedCents)}</dd>
                        <p className="text-[11px] text-gray-500">{tx("w_individual")} <bdi dir="ltr">{fmtMad(amounts.data.individual.reversedCents)}</bdi> · {tx("w_group")} <bdi dir="ltr">{fmtMad(amounts.data.group.reversedCents)}</bdi></p>
                      </div>
                      <div className={`${ui.panel} px-3.5 py-3 min-w-0`}>
                        <dt className="text-xs font-semibold text-gray-500">{tx("w_net")}</dt>
                        <dd className="mt-0.5 text-lg font-bold text-gray-900 break-words" dir="ltr" style={ltrAlign} data-net-total>{fmtMad(t.earnedCents)}</dd>
                        {g.adjustmentCents !== 0 && (
                          <p className="text-[11px] text-gray-500" data-adjustments>{tx("w_adjustments")} <bdi dir="ltr">{fmtMad(g.adjustmentCents)}</bdi></p>
                        )}
                      </div>
                    </dl>
                  );
                })()}
              </section>

              {/* Reward history */}
              <section className="space-y-2 min-w-0" aria-label={tx("w_rewards_history")}>
                <SubTitle Icon={History}>{tx("w_rewards_history")}</SubTitle>
                {rewards.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500" data-empty="rewards">{tx("w_rewards_empty")}</p>
                ) : (
                  <ul className="divide-y divide-gray-100 min-w-0">
                    {rewards.map((r, i) => (
                      <li key={`${r.createdAt}-${i}`} className="py-2.5 first:pt-0 last:pb-0 flex flex-wrap items-start gap-x-3 gap-y-1 justify-between min-w-0" data-reward-row>
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-gray-900 break-words" data-reward-title={r.type ?? ""}>
                            {rewardRowTitle(r, lang) ?? (r.affiliate ? (r.affiliate.name || r.affiliate.username || "—") : "—")}
                            {r.affiliate?.username && <>{" "}<bdi className="text-xs text-gray-500 font-normal break-all" dir="ltr">@{r.affiliate.username}</bdi></>}
                          </p>
                          <p className="text-xs text-gray-600 mt-0.5 break-words" data-reward-reason>
                            {/* The two Arabic templates below (reversal reason, cycle suffix) are pinned verbatim by
                                scripts/recruiterRewardReversal.test.mjs; they are the "ar" texts of w_reason_reversed / w_cycle. */}
                            {r.type === "GROUP_REWARD" || r.type === "GROUP_REVERSAL"
                              ? groupRowDetail(r, lang)
                              : r.reason === "REAL_DELIVERED_AND_CIN_APPROVED"
                              ? tx("w_reason_awarded", { n: r.requiredDeliveredOrders ?? "—" })
                              : r.reason === "REAL_DELIVERED_BELOW_THRESHOLD"
                                ? (lang === "ar"
                                  ? `سحب المكافأة: الطلبيات الحقيقية المسلّمة أصبحت أقل من ${r.requiredDeliveredOrders ?? "—"} (إلغاء أو إرجاع)`
                                  : tx("w_reason_reversed", { n: r.requiredDeliveredOrders ?? "—" }))
                                : r.type === "ADMIN_ADJUSTMENT" ? tx("w_reason_admin") : "—"}
                            {r.type !== "GROUP_REWARD" && r.type !== "GROUP_REVERSAL" && Number.isInteger(r.cycle)
                              ? (lang === "ar" ? (r.cycle > 1 ? ` · الدورة ${r.cycle}` : "") : (r.cycle > 1 ? ` · ${tx("w_cycle", { n: r.cycle })}` : ""))
                              : ""}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5"><bdi>{fmtDate(r.createdAt, intlLocale)}</bdi></p>
                        </div>
                        <p className={`shrink-0 font-bold ${r.amountCents < 0 ? "text-red-700" : "text-green-700"}`} dir="ltr">{fmtMad(r.amountCents)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
