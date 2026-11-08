"use client";
/**
 * /recruiter — the recruiter dashboard, simplified: SIX compact KPI cards in the affiliate dashboard's StatCard
 * style, understandable at a glance (no hero, no chart, no repeated figure):
 *   • the whole network (every level) and the direct affiliates (level 1)    ← GET /api/recruiter/network/stats
 *   • real orders and real delivered orders of the network (test orders are never counted; only with
 *     canViewOrders — otherwise "—", the server returns no order figure)        ← GET /api/recruiter/network/stats
 *   • total earned and the balance available for withdrawal (MAD cents, the ledger is the source of truth; the
 *     wallet read reconciles the recruiter's rewards first, exactly as on the wallet page) ← GET /api/recruiter/wallet
 * plus a one-line hint when the identity (CIN) is not approved yet (the status the app shell already loaded).
 * Arabic, RTL. 401 (and 403 RECRUITER_DISABLED with its notice) → back to the login page; 5xx / 429 / network
 * failures show an error with a retry button. The shell (menu, header, alerts, logout) is mounted once by the
 * recruiter layout (RecruiterAppShell); this page renders its content only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Users, UserPlus, ShoppingCart, PackageCheck, Coins, Wallet, ShieldAlert, ArrowLeft } from "lucide-react";
import { toRecruiterError, toRecruiterNetworkStatsView, toRecruiterWalletView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "./errorLabels";
import { authAction, fmtMadCents, permsFromMe } from "./recruiterUiState";
import { useRecruiterSession } from "./_components/RecruiterAppShell";
import { CenteredNotice, RetryError, StatCard } from "./_components/ui";
import { fmt } from "./network/networkUi";

/** GET a recruiter API → { ok, status, code, body } (never throws; only the error CODE is kept). */
async function getApi(url) {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    const body = await res.json().catch(() => null);
    return res.ok ? { ok: true, status: res.status, code: null, body } : { ok: false, status: res.status, code: toRecruiterError(body).code, body: null };
  } catch {
    return { ok: false, status: 0, code: "SERVER_ERROR", body: null };
  }
}

const num = (n) => (Number.isInteger(n) ? fmt(n) : "—");
const LOADING = "…";

export default function RecruiterDashboardPage() {
  const router = useRouter();
  const session = useRecruiterSession();
  const [me, setMe] = useState(null);
  const [perms, setPerms] = useState(null); // { canViewOrders, canCreateAffiliates } (Phase 6 part 4)
  const [notice, setNotice] = useState("");
  const [meError, setMeError] = useState(null); // error code of /me (not 401): shown with a retry
  const [stats, setStats] = useState({ data: null, error: null });
  const [wallet, setWallet] = useState({ data: null, error: null });
  const aliveRef = useRef(true);
  const noticeTimer = useRef(null); // ONE redirect timer, whichever request reported RECRUITER_DISABLED first

  /** 401 → login; 403 RECRUITER_DISABLED → notice then login. Returns true when handled. */
  const gate = useCallback((r) => {
    const action = authAction(r.status, r.code);
    if (action === "login") { router.replace("/recruiter/login"); return true; }
    if (action === "disabled") {
      setNotice(recruiterErrorLabel(r.code));
      if (!noticeTimer.current) noticeTimer.current = setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
      return true;
    }
    return false;
  }, [router]);

  const loadMe = useCallback(async () => {
    setMeError(null);
    const r = await getApi("/api/recruiter/me");
    if (!aliveRef.current || gate(r)) return;
    if (!r.ok) { setMeError(r.code); return; }
    setPerms(permsFromMe(r.body));
    setMe(r.body?.recruiter ?? null);
    if (!r.body?.recruiter) setMeError("SERVER_ERROR");
  }, [gate]);

  // Whole-network statistics (read only; the server omits the order counts without canViewOrders).
  const loadStats = useCallback(async () => {
    setStats({ data: null, error: null });
    const r = await getApi("/api/recruiter/network/stats");
    if (!aliveRef.current || gate(r)) return;
    setStats(r.ok && r.body?.stats ? { data: toRecruiterNetworkStatsView(r.body.stats), error: null } : { data: null, error: r.code ?? "SERVER_ERROR" });
  }, [gate]);

  // The recruiter's own wallet totals (the same endpoint and figures as the wallet page).
  const loadWallet = useCallback(async () => {
    setWallet({ data: null, error: null });
    const r = await getApi("/api/recruiter/wallet");
    if (!aliveRef.current || gate(r)) return;
    setWallet(r.ok && r.body?.wallet ? { data: toRecruiterWalletView(r.body.wallet), error: null } : { data: null, error: r.code ?? "SERVER_ERROR" });
  }, [gate]);

  useEffect(() => {
    aliveRef.current = true;
    loadMe();
    return () => {
      aliveRef.current = false;
      if (noticeTimer.current) { clearTimeout(noticeTimer.current); noticeTimer.current = null; }
    };
  }, [loadMe]);

  // The figures load once the session is confirmed.
  const ready = !!me;
  useEffect(() => {
    if (!ready) return;
    loadStats();
    loadWallet();
  }, [ready, loadStats, loadWallet]);

  if (!me) {
    return (
      <div data-recruiter-dashboard>
        <h1 className="sr-only">لوحة التحكم</h1>
        {notice
          ? <CenteredNotice hook="data-dashboard-notice">{notice}</CenteredNotice>
          : meError
            ? <div className="max-w-sm mx-auto py-16" data-dashboard-error><RetryError code={meError} onRetry={loadMe} hook="me" /></div>
            : <p className="py-16 text-center text-sm text-gray-500" aria-live="polite">جارٍ التحميل…</p>}
      </div>
    );
  }

  const canViewOrders = perms?.canViewOrders === true;
  const s = stats.data;
  const t = wallet.data?.totals ?? null;
  const real = s?.orders?.real ?? null;
  const orderValue = (k) => (!canViewOrders ? "—" : stats.error ? "—" : !s ? LOADING : real ? num(real[k]) : "—");
  const ordersSub = !canViewOrders || (s && !real) ? "عرض الطلبات معطّل لحسابك" : "طلبات حقيقية فقط";
  const identity = session?.identity ?? null;
  const showKyc = identity && identity.status !== "APPROVED";
  const available = t ? t.availableCents : null;

  return (
    <div className="space-y-5" data-recruiter-dashboard>
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-gray-900">لوحة التحكم</h1>
        <p className="text-xs text-gray-500 mt-0.5">نظرة سريعة على شبكتك وأرباحك.</p>
      </div>

      {notice && <p role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700" data-dashboard-notice>{notice}</p>}

      {showKyc && (
        <Link href="/recruiter/verification" data-kyc-hint
          className="flex items-center gap-3 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800 hover:bg-amber-100 min-h-11">
          <ShieldAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0">
            {identity.status === "PENDING" ? "بطاقتك الوطنية قيد المراجعة." : identity.status === "REJECTED" ? "تم رفض بطاقتك الوطنية: أعد إرسالها." : "أرسل بطاقتك الوطنية: التحقق مطلوب قبل أي طلب سحب."}
          </span>
          <ArrowLeft className="w-4 h-4 shrink-0" aria-hidden="true" />
        </Link>
      )}

      <section aria-label="أهم الأرقام" className="grid grid-cols-2 lg:grid-cols-3 gap-3" data-kpis>
        <StatCard Icon={Users} color="purple" label="كل الأفلييت في شبكتك" value={stats.error ? "—" : s ? num(s.totals.affiliates) : LOADING} hook="network-total" sub="جميع المستويات" />
        <StatCard Icon={UserPlus} color="blue" label="الأفلييت المباشرون" value={stats.error ? "—" : s ? num(s.totals.direct) : LOADING} hook="network-direct" sub="المستوى 1" />
        <StatCard Icon={ShoppingCart} color="amber" label="مجموع الطلبات" value={orderValue("total")} hook="orders-total" sub={ordersSub} />
        <StatCard Icon={PackageCheck} color="green" label="الطلبات المسلّمة" value={orderValue("delivered")} hook="orders-delivered" sub={ordersSub} />
        <StatCard Icon={Coins} color="teal" label="إجمالي الأرباح" value={wallet.error ? "—" : t ? fmtMadCents(t.earnedCents) : LOADING} hook="earned" valueLtr />
        <StatCard Icon={Wallet} color={available !== null && available < 0 ? "red" : "gray"} label="الرصيد المتاح للسحب"
          value={wallet.error ? "—" : t ? fmtMadCents(available) : LOADING} hook="available" valueLtr
          sub={available !== null && available < 0 ? "سالب بعد إلغاء مكافآت" : null} />
      </section>

      {stats.error && <RetryError code={stats.error} onRetry={loadStats} hook="stats" />}
      {wallet.error && <RetryError code={wallet.error} onRetry={loadWallet} hook="wallet" />}
    </div>
  );
}
