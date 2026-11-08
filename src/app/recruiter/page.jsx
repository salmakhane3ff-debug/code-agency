"use client";
/**
 * /recruiter — recruiter dashboard (Phase 2: account information + menu skeleton;
 * Phase 3: "إضافة أفلييت جديد" links to /recruiter/affiliates/new; Phase 4: the network
 * tree /recruiter/network and its statistics / order tracking /recruiter/network/stats;
 * Phase 5: "مكافآتي" links to the recruiter's rewards page /recruiter/wallet;
 * Phase 6: "تفعيل الحسابات" links to /recruiter/affiliates/activation; part 2: "تغيير كلمة السر"
 * links to /recruiter/password).
 * Arabic, RTL. 401 (and 403 RECRUITER_DISABLED with its notice) → back to the login page; 5xx / 429 /
 * network failures show an error with a retry button. The creation entries need an explicit
 * canCreateAffiliates = true, the order figures an explicit canViewOrders = true (Phase 6 part 4 — the
 * server enforces both on every request; hiding here is only a convenience).
 * Phase 7 Stage C: a progress summary from GET /api/recruiter/progress (network affiliates — Stage E: N(R),
 * directly created, group progress "q / groupSize", rewards awarded / reversed with their amounts, the
 * switches shown "غير مفعّلة" when off) and a KYC card from GET /api/recruiter/identity.
 * Dashboard redesign (UI only): the recruiter layout (RecruiterShell — sidebar, header, alerts, mobile
 * drawer), a hero, KPI cards, the individual / group reward cards, quick actions and two charts from the
 * EXISTING read-only network statistics GET /api/recruiter/network/stats (real orders by status — only
 * when canViewOrders — and affiliates per level). Same endpoints, same contracts, same auth handling;
 * every figure comes from those answers (nothing estimated; empty states when there is no data).
 * Phase 2: the shell (menu, header, alerts, logout, guide) is mounted ONCE by the recruiter layout
 * (RecruiterAppShell) for every authenticated page; this page renders its content only and shares its
 * progress summary with the shell (alerts, "how rewards work" guide) — no extra request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Users, UserPlus, Coins, ShoppingCart, PackageCheck, Layers, EyeOff, Network } from "lucide-react";
import {
  toRecruiterError, toRecruiterIdentityView, toRecruiterNetworkStatsView, toRecruiterProgressSummaryView,
} from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "./errorLabels";
import {
  authAction, fmtMadCents, groupProgressDisplay, individualProgressDisplay, levelSeries, orderStatusSeries,
  permsFromMe, rewardAmountsDisplay,
} from "./recruiterUiState";
import { useRecruiterSession } from "./_components/RecruiterAppShell";
import {
  AccountCard, Card, CardTitle, ComingSoon, EmptyState, GroupRewardCard, HeroBanner, IdentityCard,
  IndividualRewardCard, KpiCard, QuickActions, RetryError, kpiNumber,
} from "./_components/DashboardWidgets";
import { CenteredNotice } from "./_components/ui";
import { FAKE_LABEL, fmt } from "./network/networkUi";

const ChartSkeleton = () => <div className="h-72 rounded-2xl bg-violet-50/60 animate-pulse" aria-hidden="true" />;
const OrdersStatusChart = dynamic(() => import("./_components/DashboardCharts").then((m) => m.OrdersStatusChart), { ssr: false, loading: ChartSkeleton });
const LevelsChart = dynamic(() => import("./_components/DashboardCharts").then((m) => m.LevelsChart), { ssr: false, loading: ChartSkeleton });

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

function Chip({ children, ...rest }) {
  return <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 border border-violet-100 px-2.5 py-1 text-xs font-semibold text-slate-700" {...rest}>{children}</span>;
}

/** KPI cards + the two reward cards (aggregates of GET /api/recruiter/progress; delivered sales from the stats). */
function ProgressSummary({ state, onRetry, stats, canViewOrders }) {
  if (state.error) return <RetryError code={state.error} onRetry={onRetry} hook="progress" />;
  if (!state.data) {
    return (
      <div className="space-y-4" aria-live="polite">
        <p className="sr-only" data-progress-loading>جارٍ تحميل الملخص…</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-40 rounded-3xl bg-white border border-violet-100 animate-pulse" />)}
        </div>
      </div>
    );
  }
  const s = state.data;
  const g = groupProgressDisplay(s);
  const ind = individualProgressDisplay(s);
  const r = rewardAmountsDisplay(s.rewards);
  const realOrders = stats.data?.orders?.real ?? null;
  let delivered = "…";
  let deliveredSub = "طلبات حقيقية مُسلّمة في كل شبكتك";
  if (!canViewOrders) { delivered = "—"; deliveredSub = "عرض الطلبات معطّل لحسابك من طرف الإدارة"; }
  else if (stats.error) { delivered = "—"; deliveredSub = "تعذّر تحميل الطلبات حالياً"; }
  else if (stats.data) {
    delivered = realOrders ? kpiNumber(realOrders.delivered) : "—";
    if (!realOrders) deliveredSub = "عرض الطلبات معطّل لحسابك من طرف الإدارة";
  }
  return (
    <section className="space-y-5 min-w-0" aria-labelledby="sum-title" data-progress-summary>
      <h2 id="sum-title" className="sr-only">ملخص التقدّم</h2>
      {s.downlineAffiliates === 0 ? (
        <p className="rounded-2xl border border-violet-100 bg-white px-4 py-3 text-sm text-slate-600" data-progress-empty>
          لا يوجد أفلييت في شبكتك بعد. سيظهر تقدّمك هنا عند إضافة أول أفلييت.
        </p>
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard Icon={Users} tone="violet" label="كل الأفلييت في شبكتك" value={s.downlineAffiliates} hook="downline"
          sub="مع المدعوين عبر أفلييتك — تُحتسب عنهم جميعاً المكافآت" />
        <KpiCard Icon={UserPlus} tone="sky" label="الأفلييت الذين أنشأتهم" value={s.linkedAffiliates} hook="linked" sub="مرتبطون بحسابك مباشرة" />
        <KpiCard Icon={Coins} tone="amber" label="صافي المكافآت" value={fmtMadCents(r.netCents)} hook="net" valueLtr
          sub={(
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <span>ممنوحة: <bdi dir="ltr" className="font-semibold text-emerald-700" data-gross>{fmtMadCents(r.grossCents)}</bdi></span>
              <span>ملغاة: <bdi dir="ltr" className="font-semibold text-rose-700" data-reversed-total>− {fmtMadCents(r.reversedCents)}</bdi></span>
            </span>
          )} />
        <KpiCard Icon={ShoppingCart} tone="rose" label="المبيعات المُسلّمة" value={delivered} hook="delivered" sub={deliveredSub} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <IndividualRewardCard ind={ind} side={r.individual} />
        <GroupRewardCard g={g} side={r.group} />
      </div>
    </section>
  );
}

/** Real orders by status (whole network) — only with canViewOrders; test orders shown apart, never counted. */
function OrdersCard({ stats, canViewOrders, onRetry }) {
  let body;
  if (!canViewOrders) body = <EmptyState Icon={EyeOff} hook="orders-hidden" text="عرض أرقام الطلبات معطّل لحسابك من طرف الإدارة. باقي معلومات الشبكة تبقى متاحة." />;
  else if (stats.error) body = <RetryError code={stats.error} onRetry={onRetry} hook="stats" />;
  else if (!stats.data) body = <ChartSkeleton />;
  else {
    const series = orderStatusSeries(stats.data.orders);
    const total = series ? series.reduce((n, x) => n + x.value, 0) : 0;
    if (!series) body = <EmptyState Icon={EyeOff} hook="orders-hidden" text="عرض أرقام الطلبات معطّل لحسابك من طرف الإدارة." />;
    else if (total === 0) body = <EmptyState Icon={PackageCheck} hook="orders" text="لا توجد طلبات حقيقية بعد في شبكتك." />;
    else {
      body = (
        <>
          <div className="flex flex-wrap gap-2">
            <Chip data-orders-total>الطلبات الحقيقية: <b>{fmt(total)}</b></Chip>
            <Chip>المُسلّمة: <b>{fmt(series[0].value)}</b></Chip>
            <Chip data-orders-fake>{FAKE_LABEL}: <b>{fmt(stats.data.orders?.fake?.total ?? 0)}</b></Chip>
          </div>
          <OrdersStatusChart series={series} />
        </>
      );
    }
  }
  return (
    <Card className="p-5 sm:p-6 flex flex-col gap-4 xl:col-span-3" aria-labelledby="orders-title" data-orders-card>
      <CardTitle Icon={ShoppingCart} id="orders-title" title="الطلبات الحقيقية حسب الحالة" aside={<span className="text-xs text-slate-400 shrink-0">كل الشبكة</span>} />
      {body}
    </Card>
  );
}

/** Affiliates per absolute level (active / inactive) and the network totals. */
function LevelsCard({ stats, canViewOrders, onRetry }) {
  let body;
  // One retry button per failure: on the orders card when it shows the error, here when the order view is off.
  if (stats.error && !canViewOrders) body = <RetryError code={stats.error} onRetry={onRetry} hook="stats" />;
  else if (stats.error) body = <p className="text-sm text-slate-500" data-levels-unavailable>تعذّر تحميل الإحصائيات حالياً (أعد المحاولة من بطاقة الطلبات أو من صفحة الإحصائيات).</p>;
  else if (!stats.data) body = <ChartSkeleton />;
  else {
    const series = levelSeries(stats.data.levels);
    const t = stats.data.totals;
    body = series.length === 0
      ? <EmptyState Icon={Network} hook="levels" text="لا يوجد أفلييت في شبكتك بعد." />
      : (
        <>
          <div className="flex flex-wrap gap-2">
            <Chip>كل الأفلييت: <b>{fmt(t.affiliates)}</b></Chip>
            <Chip>مفعّلون: <b>{fmt(t.active)}</b></Chip>
            <Chip>غير مفعّلين: <b>{fmt(t.inactive)}</b></Chip>
            <Chip>أعمق مستوى: <b>{fmt(t.maxLevel)}</b></Chip>
          </div>
          <LevelsChart series={series} />
        </>
      );
  }
  return (
    <Card className="p-5 sm:p-6 flex flex-col gap-4 xl:col-span-3" aria-labelledby="levels-title" data-levels-card>
      <CardTitle Icon={Layers} id="levels-title" title="الأفلييت حسب المستوى" aside={<span className="text-xs text-slate-400 shrink-0">كل الشبكة</span>} />
      {body}
    </Card>
  );
}

export default function RecruiterDashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [perms, setPerms] = useState(null); // { canViewOrders, canCreateAffiliates } (Phase 6 part 4)
  const [notice, setNotice] = useState("");
  const [meError, setMeError] = useState(null); // error code of /me (not 401): shown with a retry
  const [progress, setProgress] = useState({ data: null, error: null });
  const [kyc, setKyc] = useState({ data: null, error: null });
  const [stats, setStats] = useState({ data: null, error: null });
  const session = useRecruiterSession();
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

  const loadProgress = useCallback(async () => {
    setProgress({ data: null, error: null });
    const r = await getApi("/api/recruiter/progress");
    if (!aliveRef.current || gate(r)) return;
    setProgress(r.ok ? { data: toRecruiterProgressSummaryView(r.body?.progress), error: null } : { data: null, error: r.code });
  }, [gate]);

  const loadKyc = useCallback(async () => {
    setKyc({ data: null, error: null });
    const r = await getApi("/api/recruiter/identity");
    if (!aliveRef.current || gate(r)) return;
    setKyc(r.ok && r.body?.identity ? { data: toRecruiterIdentityView(r.body.identity), error: null } : { data: null, error: r.code ?? "SERVER_ERROR" });
  }, [gate]);

  // Whole-network statistics (read only; the server omits the order counts without canViewOrders).
  const loadStats = useCallback(async () => {
    setStats({ data: null, error: null });
    const r = await getApi("/api/recruiter/network/stats");
    if (!aliveRef.current || gate(r)) return;
    setStats(r.ok && r.body?.stats ? { data: toRecruiterNetworkStatsView(r.body.stats), error: null } : { data: null, error: r.code ?? "SERVER_ERROR" });
  }, [gate]);

  useEffect(() => {
    aliveRef.current = true;
    loadMe();
    return () => {
      aliveRef.current = false;
      if (noticeTimer.current) { clearTimeout(noticeTimer.current); noticeTimer.current = null; }
    };
  }, [loadMe]);

  // The summary, the KYC card and the statistics load once the session is confirmed.
  const ready = !!me;
  useEffect(() => {
    if (!ready) return;
    loadProgress();
    loadKyc();
    loadStats();
  }, [ready, loadProgress, loadKyc, loadStats]);

  const groupInfo = useMemo(() => (progress.data ? groupProgressDisplay(progress.data) : null), [progress.data]);
  // The shell's alerts and guide reuse the summary this page loaded (no second request).
  const publishSummary = session?.publishSummary;
  useEffect(() => { if (progress.data && publishSummary) publishSummary(progress.data); }, [progress.data, publishSummary]);

  if (!me) {
    return (
      <div data-recruiter-dashboard>
        <h1 className="sr-only">لوحة التحكم</h1>
        {notice
          ? <CenteredNotice hook="data-dashboard-notice">{notice}</CenteredNotice>
          : meError
            ? <div className="max-w-sm mx-auto py-16" data-dashboard-error><RetryError code={meError} onRetry={loadMe} hook="me" /></div>
            : <p className="py-16 text-center text-sm text-slate-500" aria-live="polite">جارٍ التحميل…</p>}
      </div>
    );
  }

  const active = me.status === "ACTIVE";
  const canCreate = perms?.canCreateAffiliates === true;
  const canViewOrders = perms?.canViewOrders === true;
  return (
    <div className="space-y-5 sm:space-y-6" data-recruiter-dashboard>
      <h1 className="sr-only">لوحة التحكم</h1>
      {notice && (
        <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-dashboard-notice>{notice}</p>
      )}
      <HeroBanner summary={progress.data} groupInfo={groupInfo} />

      <ProgressSummary state={progress} onRetry={loadProgress} stats={stats} canViewOrders={canViewOrders} />

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5 items-start">
        <OrdersCard stats={stats} canViewOrders={canViewOrders} onRetry={loadStats} />
        <div className="xl:col-span-2 min-w-0">
          <QuickActions active={active} canCreate={canCreate} canViewOrders={canViewOrders} />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5 items-start">
        <LevelsCard stats={stats} canViewOrders={canViewOrders} onRetry={loadStats} />
        <div className="xl:col-span-2 min-w-0 space-y-5">
          <IdentityCard state={kyc} onRetry={loadKyc} />
          <AccountCard me={me} />
          <ComingSoon />
        </div>
      </div>
    </div>
  );
}
