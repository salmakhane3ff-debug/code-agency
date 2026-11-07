"use client";
/**
 * /recruiter — recruiter dashboard (Phase 2: account information + menu skeleton;
 * Phase 3: "إضافة أفلييت جديد" links to /recruiter/affiliates/new; Phase 4: the network
 * tree /recruiter/network and its statistics / order tracking /recruiter/network/stats;
 * Phase 5: "مكافآتي" links to the recruiter's rewards page /recruiter/wallet;
 * Phase 6: "تفعيل الحسابات" links to /recruiter/affiliates/activation; part 2: "تغيير كلمة السر"
 * links to /recruiter/password).
 * Arabic, RTL. Data comes ONLY from GET /api/recruiter/me (toRecruiterProfileView + the
 * recruiter's own permissions, Phase 6 part 4); 401 / 403 → back to the login page. The other
 * sections arrive in later phases and are shown disabled ("قريباً").
 * Phase 6 part 4: when the admin turned off a permission, its entries are hidden and a short note
 * explains why (canCreateAffiliates → no "add affiliate"; canViewOrders → no order tracking).
 * The server enforces both on every request; hiding here is only a convenience.
 * Phase 7 Stage C: a progress summary from GET /api/recruiter/progress (directly created / network affiliates — Stage E: N(R),
 * the group reward progress "q / groupSize", rewards awarded / reversed with their amounts, the
 * switches shown "غير مفعّلة" when off), a KYC card from GET /api/recruiter/identity and a link to the
 * affiliates list /recruiter/affiliates. ONLY 401 (and 403 RECRUITER_DISABLED with its notice) goes
 * back to the login page: 5xx / 429 / network failures show an error with a retry button. The
 * creation entries need an explicit canCreateAffiliates = true.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Home, Users, UserPlus, GitBranch, ShieldCheck, PackageCheck, Gift, History, LogOut, Menu, X, UserCog, BarChart3,
  Wallet, KeyRound, Lock, ListChecks, RefreshCw, TrendingUp,
} from "lucide-react";
import { toRecruiterError, toRecruiterIdentityView, toRecruiterProgressSummaryView } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "./errorLabels";
import { authAction, fmtMadCents, groupProgressDisplay, permsFromMe, rewardAmountsDisplay } from "./recruiterUiState";

const SECTIONS = [
  { id: "home", label: "الرئيسية والإحصائيات", Icon: Home, active: true },
  { id: "network", label: "شبكة الأفلييت ديالي (الشجرة)", Icon: Users, href: "/recruiter/network" },
  { id: "affiliates", label: "قائمة الأفلييت والتقدّم", Icon: ListChecks, href: "/recruiter/affiliates" },
  { id: "add", label: "إضافة أفلييت جديد", Icon: UserPlus, href: "/recruiter/affiliates/new" },
  { id: "verification", label: "التحقق من الهوية", Icon: ShieldCheck, href: "/recruiter/verification" },
  { id: "orders", label: "الطلبات المسلّمة وغير المسلّمة", Icon: PackageCheck, href: "/recruiter/network/stats" },
  { id: "rewards", label: "مكافآتي", Icon: Gift, href: "/recruiter/wallet" },
  { id: "log", label: "سجل العمليات", Icon: History },
];

const DATE_FMT = new Intl.DateTimeFormat("ar-MA", { timeZone: "Africa/Casablanca", dateStyle: "medium", timeStyle: "short" });
const fmtDate = (iso) => (iso ? DATE_FMT.format(new Date(iso)) : "—");

/** Menu sections the recruiter's permissions allow (creation / orders need an explicit `true`). */
const allowedSections = (perms) => SECTIONS.filter((s) =>
  !(s.id === "add" && perms?.canCreateAffiliates !== true) && !(s.id === "orders" && perms?.canViewOrders !== true));

function Nav({ onNavigate, perms }) {
  return (
    <nav aria-label="القائمة الرئيسية" className="space-y-1">
      {allowedSections(perms).map(({ id, label, Icon, active, href }) => (
        href ? (
          <Link key={id} href={href} onClick={onNavigate} data-section={id}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-emerald-50 hover:text-emerald-700">
            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </Link>
        ) : active ? (
          <button key={id} type="button" aria-current="page" onClick={onNavigate}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold bg-emerald-600 text-white" data-section={id}>
            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </button>
        ) : (
          <div key={id} role="link" aria-disabled="true" tabIndex={-1} data-section={id}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-400 cursor-not-allowed select-none">
            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="truncate flex-1 min-w-0">{label}</span>
            <span className="shrink-0 text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-2 py-0.5">قريباً</span>
          </div>
        )
      ))}
    </nav>
  );
}

function InfoRow({ label, value, dirLtr = false }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-slate-100 last:border-0 min-w-0">
      <dt className="text-sm text-slate-500 shrink-0">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900 truncate min-w-0" dir={dirLtr ? "ltr" : undefined}>{value}</dd>
    </div>
  );
}

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

function RetryError({ code, onRetry, hook = "" }) {
  return (
    <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex flex-wrap items-center justify-between gap-3" data-error={hook}>
      <span className="min-w-0">{recruiterErrorLabel(code)}</span>
      <button type="button" onClick={onRetry} data-retry={hook}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-red-300 bg-white px-3 py-1.5 font-semibold hover:bg-red-100">
        <RefreshCw className="w-4 h-4" aria-hidden="true" /> إعادة المحاولة
      </button>
    </div>
  );
}

function Stat({ label, value, hook, sub }) {
  return (
    <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 min-w-0">
      <dt className="text-[11px] text-slate-500 leading-tight">{label}</dt>
      <dd className="text-lg font-bold text-slate-900" {...{ [hook]: "" }}>{value}</dd>
      {sub && <p className="text-[11px] text-slate-500 leading-tight">{sub}</p>}
    </div>
  );
}

function Off() {
  return <span className="text-[11px] font-bold rounded-full bg-slate-100 text-slate-500 px-2 py-0.5" data-off>غير مفعّلة</span>;
}

/** One reward type: awarded / reversed (counts and amounts) and what stays (awarded − reversed). */
function RewardSide({ title, enabled, side, hook }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 space-y-2 min-w-0" data-reward-side={hook}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        {!enabled && <Off />}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="min-w-0">
          <dt className="text-slate-500">ممنوحة</dt>
          <dd className="font-bold text-emerald-700" data-awarded>{side.awarded} · <bdi dir="ltr">{fmtMadCents(side.awardedCents)}</bdi></dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-500">ملغاة</dt>
          <dd className="font-bold text-red-700" data-reversed>{side.reversed} · <bdi dir="ltr">{fmtMadCents(side.reversedCents)}</bdi></dd>
        </div>
      </dl>
    </div>
  );
}

/** Phase 7 Stage C: the recruiter's progress summary (aggregates of GET /api/recruiter/progress). */
function ProgressSummary({ state, onRetry }) {
  if (state.error) return <RetryError code={state.error} onRetry={onRetry} hook="progress" />;
  if (!state.data) return <p className="text-sm text-slate-500" aria-live="polite" data-progress-loading>جارٍ تحميل الملخص…</p>;
  const s = state.data;
  const g = groupProgressDisplay(s);
  const r = rewardAmountsDisplay(s.rewards);
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4 min-w-0" aria-labelledby="sum-title" data-progress-summary>
      <h2 id="sum-title" className="text-base font-bold flex items-center gap-2">
        <TrendingUp className="w-5 h-5 text-emerald-600" aria-hidden="true" /> ملخص التقدّم
      </h2>
      {s.downlineAffiliates === 0 ? (
        <p className="text-sm text-slate-600" data-progress-empty>لا يوجد أفلييت في شبكتك بعد. سيظهر تقدّمك هنا عند إضافة أول أفلييت.</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-2">
        <Stat label="الأفلييت الذين أنشأتهم" value={s.linkedAffiliates} hook="data-linked" sub="مرتبطون بحسابك مباشرة" />
        <Stat label="كل الأفلييت في شبكتك" value={s.downlineAffiliates} hook="data-downline" sub="مع المدعوين عبر أفلييتك — تُحتسب عنهم جميعاً المكافآت" />
      </dl>

      <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3 space-y-2 min-w-0" data-group-progress={g.text}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">مكافأة المجموعة</h3>
          {!g.enabled && <Off />}
        </div>
        {g.enabled ? (
          <>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-600 min-w-0">
                الأفلييت المؤهَّلون نحو المكافأة القادمة{g.threshold ? ` (${g.threshold} مبيعات حقيقية مسلّمة + بطاقة مقبولة)` : ""}
              </span>
              <b className="shrink-0 text-emerald-800" dir="ltr" data-group-text>{g.text}</b>
            </div>
            <div className="h-2 w-full rounded-full bg-white border border-emerald-100 overflow-hidden" role="progressbar"
              aria-valuemin={0} aria-valuemax={g.size ?? 0} aria-valuenow={g.toward} aria-label="التقدّم نحو مكافأة المجموعة">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${g.pct}%` }} data-group-bar />
            </div>
            <p className="text-[11px] text-slate-500">مجموع المؤهَّلين: {g.qualified} · مكافآت مجموعة سارية: {g.active}</p>
          </>
        ) : (
          <p className="text-xs text-slate-600" data-group-off>مكافأة المجموعة غير مفعّلة حالياً.</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <RewardSide title="المكافآت الفردية" enabled={s.individualEnabled} side={r.individual} hook="individual" />
        <RewardSide title="مكافآت المجموعة" enabled={s.groupEnabled} side={r.group} hook="group" />
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 min-w-0">
          <dt className="text-[11px] text-slate-500">إجمالي المكافآت الممنوحة</dt>
          <dd className="font-bold" dir="ltr" style={{ textAlign: "right" }} data-gross>{fmtMadCents(r.grossCents)}</dd>
        </div>
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 min-w-0">
          <dt className="text-[11px] text-slate-500">المكافآت الملغاة</dt>
          <dd className="font-bold text-red-700" dir="ltr" style={{ textAlign: "right" }} data-reversed-total>− {fmtMadCents(r.reversedCents)}</dd>
        </div>
        <div className="rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2 min-w-0">
          <dt className="text-[11px] text-slate-500">الصافي بعد الإلغاء</dt>
          <dd className="font-bold text-emerald-800" dir="ltr" style={{ textAlign: "right" }} data-net>{fmtMadCents(r.netCents)}</dd>
        </div>
      </dl>
      <Link href="/recruiter/affiliates" className="inline-block text-sm font-semibold text-emerald-700 hover:underline" data-progress-list-link>
        تقدّم كل أفلييت ‹
      </Link>
    </section>
  );
}

const KYC_UI = {
  NOT_SUBMITTED: { label: "لم تُرسل بعد", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  PENDING: { label: "قيد المراجعة", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  APPROVED: { label: "مقبولة", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  REJECTED: { label: "مرفوضة", cls: "bg-red-50 text-red-700 border-red-200" },
};

/** KYC card: the recruiter's own verification status (unknown when the request failed). */
function IdentityCard({ state, onRetry }) {
  const ui = state.data ? KYC_UI[state.data.status] ?? KYC_UI.NOT_SUBMITTED : null;
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-wrap items-start gap-3 justify-between min-w-0" data-kyc-card={state.data?.status ?? (state.error ? "UNKNOWN" : "LOADING")}>
      <Link href="/recruiter/verification" data-kyc-link className="flex items-start gap-3 min-w-0 flex-1 hover:text-emerald-700">
        <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-base font-bold">التحقق من الهوية</span>
          <span className="block text-sm text-slate-500 mt-0.5">البطاقة الوطنية مطلوبة قبل أي طلب سحب.</span>
        </span>
      </Link>
      {ui ? (
        <span className={`shrink-0 text-xs font-bold rounded-full border px-2.5 py-1 ${ui.cls}`} data-kyc-status>{ui.label}</span>
      ) : state.error ? (
        <span className="shrink-0 flex items-center gap-2 text-xs text-slate-600" data-kyc-unknown>
          حالة التحقق غير متاحة
          <button type="button" onClick={onRetry} className="rounded-lg border border-slate-300 px-2 py-0.5 font-semibold hover:bg-slate-50" data-retry="kyc">إعادة المحاولة</button>
        </span>
      ) : null}
    </section>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const aliveRef = useRef(true);

  /** 401 → login; 403 RECRUITER_DISABLED → notice then login. Returns true when handled. */
  const gate = useCallback((r) => {
    const action = authAction(r.status, r.code);
    if (action === "login") { router.replace("/recruiter/login"); return true; }
    if (action === "disabled") {
      setNotice(recruiterErrorLabel(r.code));
      setTimeout(() => { if (aliveRef.current) router.replace("/recruiter/login"); }, 2500);
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

  useEffect(() => {
    aliveRef.current = true;
    loadMe();
    return () => { aliveRef.current = false; };
  }, [loadMe]);

  // The summary and the KYC card load once the session is confirmed.
  const ready = !!me;
  useEffect(() => {
    if (!ready) return;
    loadProgress();
    loadKyc();
  }, [ready, loadProgress, loadKyc]);

  async function logout() {
    setLoggingOut(true);
    try { await fetch("/api/recruiter/auth", { method: "DELETE", credentials: "include", cache: "no-store" }); } catch { /* the cookie expires anyway */ }
    router.replace("/recruiter/login");
  }

  if (!me) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        {notice
          ? <p role="alert" className="max-w-sm text-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3" data-dashboard-notice>{notice}</p>
          : meError
            ? <div className="max-w-sm w-full" data-dashboard-error><RetryError code={meError} onRetry={loadMe} hook="me" /></div>
            : <p className="text-sm text-slate-500" aria-live="polite">جارٍ التحميل…</p>}
      </main>
    );
  }

  const active = me.status === "ACTIVE";
  const canCreate = perms?.canCreateAffiliates === true;
  const canViewOrders = perms?.canViewOrders === true;
  return (
    <div className="min-h-screen lg:flex [contain:inline-size]" data-recruiter-dashboard>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-72 shrink-0 bg-white border-l border-slate-200 p-4 gap-4 min-h-screen">
        <div className="flex items-center gap-2 px-1">
          <UserCog className="w-6 h-6 text-emerald-600" aria-hidden="true" />
          <span className="font-bold">مسؤول التوظيف</span>
        </div>
        <Nav perms={perms} />
      </aside>

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2 min-w-0">
              <button type="button" className="lg:hidden p-2 -m-2 rounded-lg text-slate-700" aria-label="فتح القائمة" aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)} data-menu-open>
                <Menu className="w-5 h-5" aria-hidden="true" />
              </button>
              <h1 className="text-base sm:text-lg font-bold truncate">مرحباً، {me.name}</h1>
            </div>
            <button type="button" onClick={logout} disabled={loggingOut} data-logout
              className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60">
              <LogOut className="w-4 h-4" aria-hidden="true" />
              تسجيل الخروج
            </button>
          </div>
        </header>

        {/* Mobile drawer */}
        {menuOpen && (
          <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="القائمة الرئيسية">
            <button type="button" className="absolute inset-0 bg-slate-900/40" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)} />
            <div className="absolute inset-y-0 right-0 w-72 max-w-[85vw] bg-white p-4 space-y-4 overflow-y-auto">
              <div className="flex items-center justify-between">
                <span className="font-bold">القائمة</span>
                <button type="button" onClick={() => setMenuOpen(false)} aria-label="إغلاق القائمة" className="p-2 -m-2 text-slate-600">
                  <X className="w-5 h-5" aria-hidden="true" />
                </button>
              </div>
              <Nav perms={perms} onNavigate={() => setMenuOpen(false)} />
            </div>
          </div>
        )}

        <main className="p-4 sm:p-6 space-y-4 max-w-3xl">
          <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5" aria-labelledby="acc-title" data-account>
            <div className="flex items-center justify-between gap-3 mb-2 min-w-0">
              <h2 id="acc-title" className="text-base font-bold">معلومات الحساب</h2>
              <span data-account-status
                className={`shrink-0 text-xs font-bold rounded-full px-2.5 py-1 ${active ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
                {active ? "مفعّل" : "معطّل"}
              </span>
            </div>
            <dl>
              <InfoRow label="الاسم" value={me.name || "—"} />
              <InfoRow label="اسم المستخدم" value={me.username || "—"} dirLtr />
              <InfoRow label="الهاتف" value={me.phone || "—"} dirLtr />
              <InfoRow label="حالة الحساب" value={active ? "مفعّل" : "معطّل"} />
              <InfoRow label="تاريخ الإنشاء" value={fmtDate(me.createdAt)} />
              <InfoRow label="آخر تسجيل دخول" value={fmtDate(me.lastLoginAt)} />
            </dl>
          </section>

          <ProgressSummary state={progress} onRetry={loadProgress} />

          <IdentityCard state={kyc} onRetry={loadKyc} />

          {active && canCreate && (
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between" data-add-cta>
              <div className="min-w-0">
                <h2 className="text-base font-bold">إضافة أفلييت جديد</h2>
                <p className="text-sm text-slate-500 mt-0.5">أنشئ حساب أفلييت جديد في شبكتك (حساب رئيسي أو تحت أفلييت من شبكتك).</p>
              </div>
              <Link href="/recruiter/affiliates/new" data-add-affiliate-link
                className="shrink-0 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-bold px-4 py-2.5 hover:bg-emerald-700">
                <UserPlus className="w-4 h-4" aria-hidden="true" />
                إنشاء أفلييت
              </Link>
            </section>
          )}

          {active && !canCreate && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-create-disabled>
              إنشاء أفلييت جدد وإنشاء رموز تفعيل جديدة معطّلان لحسابك من طرف الإدارة. يمكنك دائماً الاطلاع على شبكتك.
            </section>
          )}

          <section data-activation-cta>
            <Link href="/recruiter/affiliates/activation" data-activation-link
              className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3 hover:border-emerald-300 min-w-0">
              <KeyRound className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-base font-bold">تفعيل الحسابات</span>
                <span className="block text-sm text-slate-500 mt-0.5">
                  {canCreate ? "الأفلييت الذين لم يختاروا كلمة السر بعد، وإنشاء رمز تفعيل جديد." : "الأفلييت الذين لم يختاروا كلمة السر بعد (إنشاء رمز جديد معطّل)."}
                </span>
              </span>
            </Link>
          </section>

          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4" data-network-cta>
            <Link href="/recruiter/network" data-network-link
              className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3 hover:border-emerald-300 min-w-0">
              <GitBranch className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-base font-bold">شبكتي</span>
                <span className="block text-sm text-slate-500 mt-0.5">شجرة الأفلييت ديالك بجميع المستويات.</span>
              </span>
            </Link>
            <Link href="/recruiter/network/stats" data-stats-link
              className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3 hover:border-emerald-300 min-w-0">
              <BarChart3 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-base font-bold">{canViewOrders ? "الإحصائيات وتتبّع الطلبات" : "الإحصائيات"}</span>
                <span className="block text-sm text-slate-500 mt-0.5">
                  {canViewOrders ? "الأفلييت حسب المستوى، التحقق، والطلبات الحقيقية والتجريبية." : "الأفلييت حسب المستوى والتحقق (عرض الطلبات معطّل من طرف الإدارة)."}
                </span>
              </span>
            </Link>
          </section>

          <section data-affiliates-cta>
            <Link href="/recruiter/affiliates" data-affiliates-link
              className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3 hover:border-emerald-300 min-w-0">
              <ListChecks className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-base font-bold">قائمة الأفلييت والتقدّم</span>
                <span className="block text-sm text-slate-500 mt-0.5">بحث في كل أفلييت شبكتك، مستوى كل واحد، تقدّمه نحو المكافأة وحالة مكافأته.</span>
              </span>
            </Link>
          </section>

          <section data-wallet-cta>
            <Link href="/recruiter/wallet" data-wallet-link
              className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3 hover:border-emerald-300 min-w-0">
              <Wallet className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-base font-bold">أرباحي والسحب</span>
                <span className="block text-sm text-slate-500 mt-0.5">مكافآتك المكتسبة، الرصيد المتاح، معلوماتك البنكية وطلبات السحب.</span>
              </span>
            </Link>
          </section>

          <section data-password-cta>
            <Link href="/recruiter/password" data-password-link
              className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3 hover:border-emerald-300 min-w-0">
              <Lock className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-base font-bold">تغيير كلمة السر</span>
                <span className="block text-sm text-slate-500 mt-0.5">غيّر كلمة السر ديالك وسجّل الخروج من الأجهزة الأخرى.</span>
              </span>
            </Link>
          </section>

          <section className="bg-white rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600" data-coming-soon>
            سجل العمليات: قريباً.
          </section>
        </main>
      </div>
    </div>
  );
}
