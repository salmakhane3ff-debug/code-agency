"use client";
/**
 * /recruiter/wallet — "أرباحي والسحب" (Affiliate Recruiter System, Phase 5). Arabic, RTL.
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
 * checks are hints only. Only error CODES are read and shown with fixed Arabic texts. No CIN
 * image, file, customer or order detail is ever requested or shown.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Banknote, CheckCircle2, Gift, Landmark, Loader2, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { toRecruiterError, toRecruiterIdentityView, toRecruiterProgressSummaryView, toRecruiterWalletView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel, recruiterFieldErrorLabel } from "../errorLabels";
import { authAction, rewardAmountsDisplay } from "../recruiterUiState";
import { groupRowDetail, rewardRowTitle, walletGrossNet } from "./walletUi";

const EMPTY_BANK = { bankName: "", rib: "", accountName: "" };

const newRequestId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Cents → "1 234,50 درهم" (2 decimals, Latin digits so amounts stay readable). */
function fmtMad(cents) {
  const n = Number.isInteger(cents) ? cents : 0;
  return `${(n / 100).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} درهم`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("ar-MA", { year: "numeric", month: "long", day: "numeric" }) : "—";
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
  PENDING: { label: "قيد المعالجة", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  PAID: { label: "مدفوع", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  REJECTED: { label: "مرفوض", cls: "bg-red-50 text-red-700 border-red-200" },
};

const inputCls = (bad) =>
  `w-full min-w-0 rounded-xl border px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${bad ? "border-red-400 bg-red-50/40" : "border-slate-300"}`;

function Field({ id, label, hint, error, field, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-semibold mb-1">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-700" role="alert" data-bank-error={field}>{error}</p>}
    </div>
  );
}

function TotalCard({ label, value, hook, tone = "slate" }) {
  const tones = {
    slate: "border-slate-200",
    emerald: "border-emerald-200 bg-emerald-50/40",
    amber: "border-amber-200 bg-amber-50/40",
    sky: "border-sky-200 bg-sky-50/40",
  };
  return (
    <div className={`bg-white rounded-2xl border shadow-sm p-4 min-w-0 ${tones[tone]}`}>
      <p className="text-xs text-slate-500 truncate">{label}</p>
      <p className="mt-1 text-lg sm:text-xl font-black break-words" dir="ltr" style={{ textAlign: "right" }} {...{ [hook]: "" }}>{value}</p>
    </div>
  );
}

export default function RecruiterWalletPage() {
  const router = useRouter();
  const [wallet, setWallet] = useState(null);
  const [identity, setIdentity] = useState(null); // KYC view (Phase 6 part 3c)
  const [identityError, setIdentityError] = useState(false); // Stage C: the KYC request failed (status unknown)
  const [identityBusy, setIdentityBusy] = useState(false);
  const [amounts, setAmounts] = useState({ data: null, error: null }); // Stage C: /api/recruiter/progress rewards
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const aliveRef = useRef(true);

  const [bank, setBank] = useState(EMPTY_BANK);
  const [bankErrors, setBankErrors] = useState({});
  const [bankBusy, setBankBusy] = useState(false);
  const [bankMsg, setBankMsg] = useState(null); // { ok, text }

  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState("");
  const [wBusy, setWBusy] = useState(false);
  const [wError, setWError] = useState("");
  const [wSuccess, setWSuccess] = useState("");
  const requestIdRef = useRef(null);

  const toLogin = useCallback((code) => {
    if (code === "RECRUITER_DISABLED") {
      setNotice(recruiterErrorLabel(code));
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
        setLoadError(recruiterErrorLabel(err.code));
        return;
      }
      const w = toRecruiterWalletView(body?.wallet);
      setWallet(w);
      // KYC and reward aggregates load alongside; their failure never hides the wallet.
      loadIdentity();
      loadAmounts();
      if (!keepBank) setBank({ bankName: w.bank.bankName ?? "", rib: w.bank.rib ?? "", accountName: w.bank.accountName ?? "" });
    } catch {
      if (aliveRef.current) setLoadError(recruiterErrorLabel(null));
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
        setBankMsg({ ok: true, text: "تم حفظ معلوماتك البنكية." });
        await load({ keepBank: false });
        return;
      }
      const err = toRecruiterError(body);
      if (authGate(res, err)) return;
      if (err.fields) setBankErrors(err.fields);
      setBankMsg({ ok: false, text: recruiterErrorLabel(err.code) });
    } catch {
      setBankMsg({ ok: false, text: recruiterErrorLabel(null) });
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
    setAmountError("");
    setWError("");
    setWSuccess("");
  };
  async function requestWithdrawal(e) {
    e.preventDefault();
    if (wBusy || !canRequest) return;
    setWError("");
    setWSuccess("");
    const cents = toCents(amount);
    if (!Number.isInteger(cents) || cents < 1) { setAmountError(recruiterFieldErrorLabel("amountMad", "INVALID_AMOUNT")); return; }
    if (cents > available) { setAmountError(recruiterErrorLabel(["INSUFFICIENT", "BALANCE"].join("_"))); return; }
    setAmountError("");
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
        setWSuccess(`تم إرسال طلب السحب (${fmtMad(cents)}). سيتم معالجته من طرف الإدارة.`);
        await load({ keepBank: true });
        return;
      }
      const err = toRecruiterError(body);
      if (authGate(res, err)) return;
      requestIdRef.current = null; // a definitive answer: the next submit is a new attempt
      if (err.fields?.amountMad) setAmountError(recruiterFieldErrorLabel("amountMad", err.fields.amountMad));
      setWError(recruiterErrorLabel(err.code));
      if (err.code === ["INSUFFICIENT", "BALANCE"].join("_") || err.code === "INCOMPLETE_BANK_INFO" || err.code === "RECRUITER_IDENTITY_NOT_APPROVED") await load({ keepBank: true });
    } catch {
      // Network failure: keep the requestId so a retry of THIS attempt cannot create twice.
      setWError(recruiterErrorLabel(null));
    } finally {
      setWBusy(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (notice) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3" data-page-notice>{notice}</p>
      </main>
    );
  }

  const s = wallet?.settings;
  const t = wallet?.totals;
  const rewards = wallet?.rewards ?? [];
  const withdrawals = wallet?.withdrawals ?? [];

  return (
    <div className="min-h-screen [contain:inline-size]" data-recruiter-wallet>
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-3xl mx-auto flex items-center gap-3 px-4 py-3 min-w-0">
          <Link href="/recruiter" className="shrink-0 p-2 -m-2 rounded-lg text-slate-700 hover:bg-slate-100" aria-label="الرجوع للوحة" data-back>
            <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </Link>
          <Wallet className="w-5 h-5 text-emerald-600 shrink-0" aria-hidden="true" />
          <h1 className="text-lg font-bold truncate">أرباحي والسحب</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5 min-w-0">
        {loading && !wallet && (
          <p className="text-sm text-slate-500 flex items-center gap-2" aria-live="polite" data-loading>
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> جارٍ التحميل…
          </p>
        )}

        {loadError && (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center gap-3 justify-between" data-error>
            <span className="min-w-0">{loadError}</span>
            <button type="button" onClick={() => load()} data-retry className="inline-flex items-center gap-1.5 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-50">
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> إعادة المحاولة
            </button>
          </div>
        )}

        {wallet && (
          <>
            {/* Reward rule */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3" data-reward-rule>
              <Gift className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0 text-sm leading-7">
                <h2 className="text-base font-bold mb-1">قاعدة المكافأة</h2>
                {s.rewardsEnabled ? (
                  <p data-reward-rule-text>
                    تحصل على مكافأة <strong dir="ltr">{fmtMad(s.rewardAmountCents)}</strong> عن كل أفلييت في شبكتك (أنشأته أنت أو انضم عبر أحد أفلييتك) عندما يصل إلى{" "}
                    <strong>{s.requiredDeliveredOrders}</strong> طلبية حقيقية مسلّمة وتتم الموافقة على بطاقته الوطنية من طرف الإدارة.
                  </p>
                ) : (
                  <p data-rewards-disabled>المكافآت غير مفعّلة حالياً.</p>
                )}
                <p className="text-xs text-slate-500 mt-1">الطلبات التجريبية لا تُحتسب أبداً. المكافأة تُسجَّل فوراً عند تحقق الشرطين.</p>
              </div>
            </section>

            {/* Stage C: gross awarded vs reversed, apart from the net */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3 min-w-0" aria-labelledby="gn-title" data-gross-net>
              <h2 id="gn-title" className="text-base font-bold">المكافآت: الإجمالي والإلغاءات والصافي</h2>
              {amounts.error ? (
                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex flex-wrap items-center justify-between gap-2" data-gross-error>
                  <span className="min-w-0">تفاصيل الإجمالي والإلغاءات غير متاحة: {recruiterErrorLabel(amounts.error)}</span>
                  <button type="button" onClick={loadAmounts} data-gross-retry
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-red-300 bg-white px-3 py-1 font-semibold hover:bg-red-100">
                    <RefreshCw className="w-4 h-4" aria-hidden="true" /> إعادة المحاولة
                  </button>
                </div>
              ) : !amounts.data ? (
                <p className="text-sm text-slate-500" aria-live="polite" data-gross-loading>جارٍ التحميل…</p>
              ) : (() => {
                const g = walletGrossNet(amounts.data, t.earnedCents);
                return (
                  <>
                    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 px-3 py-2 min-w-0">
                        <dt className="text-xs text-slate-500">إجمالي المكافآت الممنوحة</dt>
                        <dd className="font-black" dir="ltr" style={{ textAlign: "right" }} data-gross-total>{fmtMad(g.grossCents)}</dd>
                        <p className="text-[11px] text-slate-500">فردية: <bdi dir="ltr">{fmtMad(amounts.data.individual.awardedCents)}</bdi> · المجموعة: <bdi dir="ltr">{fmtMad(amounts.data.group.awardedCents)}</bdi></p>
                      </div>
                      <div className="rounded-xl border border-red-200 bg-red-50/40 px-3 py-2 min-w-0">
                        <dt className="text-xs text-slate-500">المكافآت الملغاة</dt>
                        <dd className="font-black text-red-700" dir="ltr" style={{ textAlign: "right" }} data-reversed-total>{fmtMad(-g.reversedCents)}</dd>
                        <p className="text-[11px] text-slate-500">فردية: <bdi dir="ltr">{fmtMad(amounts.data.individual.reversedCents)}</bdi> · المجموعة: <bdi dir="ltr">{fmtMad(amounts.data.group.reversedCents)}</bdi></p>
                      </div>
                      <div className="rounded-xl border border-slate-200 px-3 py-2 min-w-0">
                        <dt className="text-xs text-slate-500">الصافي (إجمالي المكافآت المكتسبة)</dt>
                        <dd className="font-black" dir="ltr" style={{ textAlign: "right" }} data-net-total>{fmtMad(t.earnedCents)}</dd>
                        {g.adjustmentCents !== 0 && (
                          <p className="text-[11px] text-slate-500" data-adjustments>يشمل تعديلات الإدارة: <bdi dir="ltr">{fmtMad(g.adjustmentCents)}</bdi></p>
                        )}
                      </div>
                    </dl>
                  </>
                );
              })()}
            </section>

            {/* Totals */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="المجاميع" data-totals>
              <TotalCard label="إجمالي المكافآت المكتسبة" value={fmtMad(t.earnedCents)} hook="data-total-earned" tone="emerald" />
              <TotalCard label="الرصيد المتاح للسحب" value={fmtMad(t.availableCents)} hook="data-total-available" tone="sky" />
              <TotalCard label="مبلغ قيد المعالجة" value={fmtMad(t.pendingCents)} hook="data-total-pending" tone="amber" />
              <TotalCard label="المبلغ المدفوع" value={fmtMad(t.paidCents)} hook="data-total-paid" />
            </section>

            {/* Withdrawal request */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3" aria-labelledby="w-title">
              <h2 id="w-title" className="text-base font-bold flex items-center gap-2">
                <Banknote className="w-5 h-5 text-emerald-600" aria-hidden="true" /> طلب سحب
              </h2>
              {identityUnknown && (
                <div className="text-sm rounded-xl border border-slate-200 bg-slate-50 text-slate-700 px-3 py-2 flex flex-wrap items-center justify-between gap-2" data-identity-unavailable>
                  <span className="min-w-0">حالة التحقق غير متاحة حالياً. يمكنك المتابعة، والتحقق من هويتك يتم عند معالجة الطلب.</span>
                  <button type="button" onClick={loadIdentity} disabled={identityBusy} data-identity-retry
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1 font-semibold hover:bg-slate-100 disabled:opacity-60">
                    <RefreshCw className="w-4 h-4" aria-hidden="true" /> إعادة المحاولة
                  </button>
                </div>
              )}
              {identity && !identityApproved && (
                <div className="text-sm rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 space-y-1.5" data-identity-required={identity.status}>
                  <p className="font-semibold">
                    {identity.status === "PENDING" ? "التحقق من هويتك قيد المراجعة. يمكنك طلب السحب بعد قبوله."
                      : identity.status === "REJECTED" ? "تم رفض التحقق من هويتك. أرسل صوراً جديدة لبطاقتك الوطنية لتتمكن من طلب السحب."
                      : "يجب التحقق من هويتك (البطاقة الوطنية) قبل طلب أي سحب."}
                  </p>
                  <Link href="/recruiter/verification" data-identity-link
                    className="inline-flex items-center gap-1.5 font-bold text-emerald-700 hover:underline">
                    <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" /> صفحة التحقق من الهوية
                  </Link>
                </div>
              )}
              {!bankComplete && (
                <p className="text-sm rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2" data-bank-required>
                  أضف معلوماتك البنكية قبل طلب السحب.
                </p>
              )}
              {bankComplete && available === 0 && (
                <p className="text-sm rounded-xl border border-slate-200 bg-slate-50 text-slate-700 px-3 py-2" data-nothing-available>
                  لا يوجد رصيد متاح للسحب حالياً.
                </p>
              )}
              {available < 0 && (
                <p className="text-sm rounded-xl border border-red-200 bg-red-50 text-red-800 px-3 py-2" data-negative-balance>
                  رصيدك المتاح سالب لأن مكافآت سُحبت بعد إلغاء أو إرجاع طلبيات. لا يمكن طلب سحب حتى يصبح رصيدك موجباً من جديد.
                  <span className="block mt-1 font-bold">الرصيد الحالي: <bdi dir="ltr">{fmtMad(available)}</bdi></span>
                </p>
              )}
              <form onSubmit={requestWithdrawal} noValidate className="space-y-3" data-withdraw-form>
                <div className="min-w-0">
                  <label htmlFor="w-amount" className="block text-sm font-semibold mb-1">المبلغ (درهم)</label>
                  <input id="w-amount" inputMode="decimal" autoComplete="off" dir="ltr" placeholder="0.00"
                    value={amount} onChange={(e) => editAmount(e.target.value)} disabled={!canRequest || wBusy}
                    className={`${inputCls(!!amountError)} disabled:bg-slate-100`} data-withdraw-amount aria-invalid={!!amountError} />
                  <p className="mt-1 text-xs text-slate-500">الحد الأقصى: <span dir="ltr">{fmtMad(available > 0 ? available : 0)}</span></p>
                  {amountError && <p className="mt-1 text-xs text-red-700" role="alert" data-withdraw-amount-error>{amountError}</p>}
                </div>
                {wError && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-withdraw-error>{wError}</p>}
                {wSuccess && (
                  <p role="status" className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex items-start gap-2" data-withdraw-success>
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" /> <span className="min-w-0">{wSuccess}</span>
                  </p>
                )}
                <button type="submit" disabled={!canRequest || wBusy || !amount.trim()} data-withdraw-submit
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-bold px-5 py-2.5 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed">
                  {wBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {wBusy ? "جارٍ الإرسال…" : "طلب السحب"}
                </button>
              </form>
            </section>

            {/* Bank details */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3" aria-labelledby="bank-title">
              <h2 id="bank-title" className="text-base font-bold flex items-center gap-2">
                <Landmark className="w-5 h-5 text-emerald-600" aria-hidden="true" /> المعلومات البنكية
              </h2>
              <form onSubmit={saveBank} noValidate className="space-y-3" data-bank-form>
                <Field id="b-name" label="اسم البنك" error={bankErrors.bankName ? recruiterFieldErrorLabel("bankName", bankErrors.bankName) : ""} field="bankName">
                  <input id="b-name" value={bank.bankName} onChange={(e) => editBank({ bankName: e.target.value })} maxLength={80}
                    placeholder="CIH, Attijariwafa, BMCE..." autoComplete="off" className={inputCls(!!bankErrors.bankName)} data-bank-input="bankName" />
                </Field>
                <Field id="b-rib" label="RIB" hint="من 10 إلى 34 حرفاً/رقماً." error={bankErrors.rib ? recruiterFieldErrorLabel("rib", bankErrors.rib) : ""} field="rib">
                  <input id="b-rib" value={bank.rib} onChange={(e) => editBank({ rib: e.target.value })} maxLength={48} dir="ltr"
                    placeholder="XXXXXXXXXXXXXXXXXXXXXXXX" autoComplete="off" inputMode="text" className={`${inputCls(!!bankErrors.rib)} font-mono`} data-bank-input="rib" />
                </Field>
                <Field id="b-holder" label="صاحب الحساب" error={bankErrors.accountName ? recruiterFieldErrorLabel("accountName", bankErrors.accountName) : ""} field="accountName">
                  <input id="b-holder" value={bank.accountName} onChange={(e) => editBank({ accountName: e.target.value })} maxLength={80}
                    placeholder="الاسم الكامل" autoComplete="off" className={inputCls(!!bankErrors.accountName)} data-bank-input="accountName" />
                </Field>
                {bankMsg && (
                  <p role={bankMsg.ok ? "status" : "alert"} data-bank-msg={bankMsg.ok ? "ok" : "error"}
                    className={`text-sm rounded-xl px-3 py-2 border ${bankMsg.ok ? "text-emerald-800 bg-emerald-50 border-emerald-200" : "text-red-700 bg-red-50 border-red-200"}`}>
                    {bankMsg.text}
                  </p>
                )}
                <button type="submit" disabled={bankBusy} data-bank-submit
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 font-bold px-5 py-2.5 hover:bg-slate-50 disabled:opacity-60">
                  {bankBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  حفظ المعلومات البنكية
                </button>
              </form>
            </section>

            {/* Reward history */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3" aria-labelledby="r-title">
              <h2 id="r-title" className="text-base font-bold">سجل المكافآت</h2>
              {rewards.length === 0 ? (
                <p className="text-sm text-slate-500" data-empty="rewards">لا توجد مكافآت بعد.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {rewards.map((r, i) => (
                    <li key={`${r.createdAt}-${i}`} className="py-3 flex flex-wrap items-start gap-x-3 gap-y-1 justify-between min-w-0" data-reward-row>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold truncate" data-reward-title={r.type ?? ""}>
                          {rewardRowTitle(r) ?? (r.affiliate ? (r.affiliate.name || r.affiliate.username || "—") : "—")}
                          {r.affiliate?.username && <span className="text-xs text-slate-500 font-normal" dir="ltr"> @{r.affiliate.username}</span>}
                        </p>
                        <p className="text-xs text-slate-600 mt-0.5" data-reward-reason>
                          {r.type === "GROUP_REWARD" || r.type === "GROUP_REVERSAL"
                            ? groupRowDetail(r)
                            : r.reason === "REAL_DELIVERED_AND_CIN_APPROVED"
                            ? `${r.requiredDeliveredOrders ?? "—"} طلبية حقيقية مسلّمة + بطاقة وطنية مقبولة`
                            : r.reason === "REAL_DELIVERED_BELOW_THRESHOLD"
                              ? `سحب المكافأة: الطلبيات الحقيقية المسلّمة أصبحت أقل من ${r.requiredDeliveredOrders ?? "—"} (إلغاء أو إرجاع)`
                              : r.type === "ADMIN_ADJUSTMENT" ? "تعديل من طرف الإدارة" : "—"}
                          {r.type !== "GROUP_REWARD" && r.type !== "GROUP_REVERSAL" && Number.isInteger(r.cycle) && r.cycle > 1 ? ` · الدورة ${r.cycle}` : ""}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">{fmtDate(r.createdAt)}</p>
                      </div>
                      <p className={`shrink-0 font-black ${r.amountCents < 0 ? "text-red-700" : "text-emerald-700"}`} dir="ltr">{fmtMad(r.amountCents)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Withdrawal history */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3" aria-labelledby="h-title">
              <h2 id="h-title" className="text-base font-bold">سجل طلبات السحب</h2>
              {withdrawals.length === 0 ? (
                <p className="text-sm text-slate-500" data-empty="withdrawals">لا توجد طلبات سحب بعد.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {withdrawals.map((w) => {
                    const st = STATUS[w.status] ?? STATUS.PENDING;
                    return (
                      <li key={w.id ?? w.createdAt} className="py-3 flex flex-wrap items-center gap-x-3 gap-y-1 justify-between min-w-0" data-withdrawal-row>
                        <div className="min-w-0">
                          <p className="font-black" dir="ltr" style={{ textAlign: "right" }}>{fmtMad(w.amountCents)}</p>
                          <p className="text-xs text-slate-400">{fmtDate(w.createdAt)}</p>
                        </div>
                        <span className={`shrink-0 text-xs font-bold rounded-full border px-2.5 py-0.5 ${st.cls}`} data-withdrawal-status={w.status}>{st.label}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
