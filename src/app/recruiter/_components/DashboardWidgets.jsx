"use client";
/**
 * src/app/recruiter/_components/DashboardWidgets.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Recruiter dashboard redesign (UI only): the cards of /recruiter. Every number comes from the
 * page's existing API answers (GET /api/recruiter/me, /progress, /identity, /network/stats) through the
 * pure helpers of recruiterUiState.js — nothing is estimated, no trend is invented; a missing source is
 * shown as an empty state, a failed request as an error with a retry button.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useRef } from "react";
import Link from "next/link";
import {
  UsersRound, UserPlus, Award, Network, BarChart3, Gift, ListChecks, KeyRound,
  Settings, ShieldCheck, Megaphone, Crown, User, Sparkles, ArrowLeft, X, CheckCircle2, History, UserCog,
} from "lucide-react";
import { useModal } from "./RecruiterShell";
import { Card, CardTitle, EmptyState, RetryError } from "./ui";
import { fmtMadCents, groupRemaining } from "../recruiterUiState";
import { fmt } from "../network/networkUi";

export { Card, CardTitle, EmptyState, RetryError };

/** "غير مفعّلة" badge of a reward type switched off by the admin. */
export function Off() {
  return <span className="shrink-0 text-[11px] font-bold rounded-full bg-slate-100 text-slate-500 px-2.5 py-1" data-off>غير مفعّلة</span>;
}

/** Gradient banner — its sentence is built from the CURRENT reward settings (nothing when unknown). */
export function HeroBanner({ summary, groupInfo }) {
  let sub = "تابع شبكتك من الأفلييت، تقدّمهم ومكافآتك في مكان واحد.";
  if (summary) {
    const parts = [];
    if (summary.individualEnabled && summary.individualThreshold) {
      parts.push(`كلما حقق أفلييت في شبكتك ${summary.individualThreshold} مبيعات حقيقية مُسلّمة مع بطاقة وطنية مقبولة، تحصل على مكافأة`);
    }
    if (groupInfo?.enabled && groupInfo.size) parts.push(`وكل ${groupInfo.size} أفلييت مؤهَّلين يمنحونك مكافأة مجموعة`);
    sub = parts.length ? `${parts.join("، ")}.` : "المكافآت غير مفعّلة حالياً، ويمكنك دائماً متابعة شبكتك وتطوّرها.";
  }
  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-l from-[#4c1d95] via-[#6d28d9] to-[#7c3aed] text-white shadow-[0_20px_40px_-18px_rgba(76,29,149,0.6)]" data-hero>
      <span className="absolute -top-16 -left-10 w-56 h-56 rounded-full bg-fuchsia-400/20 blur-2xl" aria-hidden="true" />
      <span className="absolute -bottom-20 right-1/3 w-64 h-64 rounded-full bg-indigo-400/20 blur-3xl" aria-hidden="true" />
      <div className="relative flex items-center justify-between gap-6 p-6 sm:p-8">
        <div className="min-w-0 max-w-2xl">
          <h2 className="text-2xl sm:text-3xl font-extrabold leading-snug">ابنِ شبكتك من الأفلييت<br />واكسب مكافآت حقيقية</h2>
          <p className="mt-3 text-sm sm:text-base text-violet-100/95 leading-relaxed" data-hero-text>{sub}</p>
        </div>
        <div className="hidden md:block relative w-60 h-36 shrink-0" aria-hidden="true">
          <span className="absolute left-0 top-1/2 -translate-y-1/2 grid place-items-center w-24 h-24 rounded-[2rem] bg-gradient-to-br from-amber-300 to-orange-500 shadow-xl shadow-orange-900/30 -rotate-12">
            <Megaphone className="w-12 h-12 text-white" aria-hidden="true" />
          </span>
          <span className="absolute right-16 top-0 grid place-items-center w-14 h-14 rounded-full bg-violet-300/90 ring-4 ring-white/20"><User className="w-7 h-7 text-white" /></span>
          <span className="absolute right-2 top-12 grid place-items-center w-12 h-12 rounded-full bg-violet-300/80 ring-4 ring-white/20"><User className="w-6 h-6 text-white" /></span>
          <span className="absolute right-20 bottom-0 grid place-items-center w-12 h-12 rounded-full bg-violet-300/80 ring-4 ring-white/20"><User className="w-6 h-6 text-white" /></span>
          <span className="absolute right-0 bottom-1 grid place-items-center w-14 h-14 rounded-full bg-amber-400 ring-4 ring-amber-200/40 shadow-lg"><Crown className="w-7 h-7 text-white" fill="currentColor" /></span>
          <Sparkles className="absolute left-28 top-2 w-5 h-5 text-amber-200" />
        </div>
      </div>
    </section>
  );
}

const KPI_TONES = {
  violet: { box: "bg-violet-50/70", icon: "bg-violet-100 text-violet-600" },
  sky: { box: "bg-sky-50/70", icon: "bg-sky-100 text-sky-600" },
  amber: { box: "bg-amber-50/70", icon: "bg-amber-100 text-amber-600" },
  rose: { box: "bg-rose-50/70", icon: "bg-rose-100 text-rose-600" },
};

/** One KPI: icon, label, the value (its test hook on the value only) and a real sub-line. */
export function KpiCard({ Icon, tone = "violet", label, value, hook, sub, valueLtr = false }) {
  const t = KPI_TONES[tone] ?? KPI_TONES.violet;
  return (
    <div className="bg-white rounded-3xl border border-violet-100/80 shadow-[0_10px_30px_-12px_rgba(76,29,149,0.18)] p-2 min-w-0" data-kpi={hook}>
      <div className={`h-full rounded-[1.25rem] ${t.box} p-4 flex flex-col gap-3 min-w-0`}>
        <div className="flex items-center justify-between gap-2 min-w-0">
          <p className="text-sm font-bold text-slate-700 min-w-0">{label}</p>
          <span className={`grid place-items-center w-11 h-11 rounded-2xl shrink-0 ${t.icon}`}><Icon className="w-6 h-6" aria-hidden="true" /></span>
        </div>
        <p className="text-2xl sm:text-3xl font-extrabold text-slate-900 truncate" dir={valueLtr ? "ltr" : undefined} style={valueLtr ? { textAlign: "right" } : undefined}
          {...{ [`data-${hook}`]: "" }}>{value}</p>
        {sub && <div className="text-xs text-slate-500 leading-relaxed min-w-0">{sub}</div>}
      </div>
    </div>
  );
}

/** Awarded / reversed counts and amounts of one reward type (straight from the server aggregates). */
function RewardSide({ side, hook }) {
  return (
    <dl className="grid grid-cols-2 gap-2 text-xs" data-reward-side={hook}>
      <div className="rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2 min-w-0">
        <dt className="text-slate-500">ممنوحة</dt>
        <dd className="font-bold text-emerald-700 break-words" data-awarded>{side.awarded}<span className="font-normal text-slate-400"> · </span><bdi dir="ltr" className="whitespace-nowrap">{fmtMadCents(side.awardedCents)}</bdi></dd>
      </div>
      <div className="rounded-xl bg-rose-50 border border-rose-100 px-3 py-2 min-w-0">
        <dt className="text-slate-500">ملغاة</dt>
        <dd className="font-bold text-rose-700 break-words" data-reversed>{side.reversed}<span className="font-normal text-slate-400"> · </span><bdi dir="ltr" className="whitespace-nowrap">{fmtMadCents(side.reversedCents)}</bdi></dd>
      </div>
    </dl>
  );
}

/** Individual reward: affiliates whose reward is held now, out of the whole network. */
export function IndividualRewardCard({ ind, side }) {
  return (
    <Card className="p-5 sm:p-6 flex flex-col gap-4" aria-labelledby="ind-title" data-individual-card>
      <CardTitle Icon={Award} id="ind-title" title="مكافأة الأفلييت الفردية" aside={!ind.enabled ? <Off /> : null} />
      <p className="text-sm text-slate-500 leading-relaxed">
        {ind.enabled
          ? `مكافأة لكل أفلييت في شبكتك يصل إلى ${ind.threshold ?? "—"} مبيعات حقيقية مُسلّمة مع بطاقة وطنية مقبولة.`
          : "المكافأة الفردية غير مفعّلة حالياً. المكافآت السابقة تبقى ظاهرة أدناه."}
      </p>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-3 rounded-full bg-violet-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(ind.total, ind.held)} aria-valuenow={ind.held}
          aria-label="الأفلييت الحاصلون على المكافأة الفردية">
          <div className="h-full rounded-full bg-gradient-to-l from-violet-500 to-indigo-500" style={{ width: `${ind.pct}%` }} data-individual-bar />
        </div>
        <span className="shrink-0 text-sm font-extrabold text-slate-700 rounded-full bg-slate-100 px-3 py-1" dir="ltr" data-individual-text>{ind.text}</span>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-violet-50/70 border border-violet-100 px-4 py-3 min-w-0">
        <span className="min-w-0">
          <span className="block text-xs text-slate-500">الأفلييت الحاصلون على المكافأة حالياً</span>
          <span className="block text-sm font-extrabold text-slate-900">{ind.held} من {ind.total} أفلييت</span>
        </span>
        <User className="w-7 h-7 text-violet-500 shrink-0" aria-hidden="true" />
      </div>
      <RewardSide side={side} hook="individual" />
      <Link href="/recruiter/affiliates" className="mt-auto self-start inline-flex items-center gap-1.5 min-h-11 rounded-2xl bg-violet-50 border border-violet-100 px-4 text-sm font-bold text-violet-700 hover:bg-violet-100" data-progress-list-link>
        تقدّم كل أفلييت <ArrowLeft className="w-4 h-4" aria-hidden="true" />
      </Link>
    </Card>
  );
}

/** Group reward: "q / groupSize" toward the next group reward (ring), what remains, active group rewards. */
export function GroupRewardCard({ g, side }) {
  const remaining = groupRemaining(g);
  return (
    <Card className="p-5 sm:p-6 flex flex-col gap-4" aria-labelledby="grp-title" data-group-progress={g.text}>
      <CardTitle Icon={UsersRound} id="grp-title" title="مكافآت المجموعة" aside={!g.enabled ? <Off /> : null} />
      {g.enabled ? (
        <>
          <p className="text-sm text-slate-500 leading-relaxed">
            {`كل ${g.size ?? "—"} أفلييت في شبكتك يحققون ${g.threshold ?? "—"} مبيعات حقيقية مُسلّمة مع بطاقة مقبولة يمنحونك مكافأة مجموعة.`}
          </p>
          <div className="flex flex-col items-center gap-3">
            <div className="relative w-40 h-40 sm:w-44 sm:h-44 rounded-full p-3" role="progressbar" aria-valuemin={0} aria-valuemax={g.size ?? 0} aria-valuenow={g.toward}
              aria-label="التقدّم نحو مكافأة المجموعة" data-group-bar
              style={{ background: `conic-gradient(#7c3aed ${g.pct}%, #ede9fe 0)` }}>
              <div className="w-full h-full rounded-full bg-white grid place-items-center text-center">
                <span>
                  <b className="block text-2xl font-extrabold text-slate-900" dir="ltr" data-group-text>{g.text}</b>
                  <span className="block text-xs text-slate-500 mt-0.5">أفلييت مؤهَّلين</span>
                </span>
              </div>
            </div>
            {remaining !== null && (
              <span className="w-full text-center rounded-2xl bg-gradient-to-l from-violet-600 to-indigo-600 text-white text-sm font-bold px-4 py-3 shadow-md shadow-violet-500/30" data-group-remaining>
                {remaining === 0 ? "المجموعة مكتملة" : `${remaining} أفلييت متبقين للمكافأة القادمة`}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 text-center">مجموع المؤهَّلين: {g.qualified} · مكافآت مجموعة سارية: {g.active}</p>
        </>
      ) : (
        <p className="text-sm text-slate-500" data-group-off>مكافأة المجموعة غير مفعّلة حالياً. المكافآت السابقة تبقى ظاهرة أدناه.</p>
      )}
      <RewardSide side={side} hook="group" />
    </Card>
  );
}

const ACTION_TONES = {
  violet: "bg-violet-50 hover:bg-violet-100 text-violet-700 border-violet-100",
  sky: "bg-sky-50 hover:bg-sky-100 text-sky-700 border-sky-100",
  amber: "bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-100",
  emerald: "bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-100",
  rose: "bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-100",
  slate: "bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200",
};

function Action({ href, Icon, label, tone, hook, wrap }) {
  return (
    <div {...{ [`data-${wrap}`]: "" }} className="min-w-0">
      <Link href={href} {...{ [`data-${hook}`]: "" }}
        className={`h-full flex flex-col items-center justify-center gap-2 rounded-2xl border px-3 py-5 text-center text-sm font-bold transition-colors ${ACTION_TONES[tone]}`}>
        <Icon className="w-7 h-7" aria-hidden="true" />
        <span className="text-slate-800 leading-snug">{label}</span>
      </Link>
    </div>
  );
}

/** Quick actions — every existing destination of the dashboard, creation only when allowed. */
export function QuickActions({ active, canCreate, canViewOrders }) {
  return (
    <Card className="p-5 sm:p-6 flex flex-col gap-4" aria-labelledby="qa-title" data-quick-actions>
      <CardTitle Icon={Sparkles} id="qa-title" title="إجراءات سريعة" />
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3 gap-3">
        {active && canCreate && <Action href="/recruiter/affiliates/new" Icon={UserPlus} label="إنشاء أفلييت جديد" tone="violet" hook="add-affiliate-link" wrap="add-cta" />}
        <Action href="/recruiter/network" Icon={Network} label="رؤية شبكة الأفلييت" tone="sky" hook="network-link" wrap="network-cta" />
        <Action href="/recruiter/wallet" Icon={Gift} label="مكافآتي والسحب" tone="amber" hook="wallet-link" wrap="wallet-cta" />
        <Action href="/recruiter/network/stats" Icon={BarChart3} label={canViewOrders ? "تقارير الأداء والطلبات" : "تقارير الأداء"} tone="emerald" hook="stats-link" wrap="stats-cta" />
        <Action href="/recruiter/affiliates" Icon={ListChecks} label="قائمة الأفلييت والتقدّم" tone="violet" hook="affiliates-link" wrap="affiliates-cta" />
        <Action href="/recruiter/affiliates/activation" Icon={KeyRound} label="تفعيل الحسابات" tone="rose" hook="activation-link" wrap="activation-cta" />
      </div>
      {active && !canCreate && (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-create-disabled>
          إنشاء أفلييت جدد وإنشاء رموز تفعيل جديدة معطّلان لحسابك من طرف الإدارة. يمكنك دائماً الاطلاع على شبكتك.
        </p>
      )}
      {!canViewOrders && (
        <p className="text-xs text-slate-500" data-orders-off-note>عرض أرقام الطلبات معطّل لحسابك من طرف الإدارة: التقارير تعرض الأفلييت حسب المستوى والتحقق فقط.</p>
      )}
    </Card>
  );
}

const KYC_UI = {
  NOT_SUBMITTED: { label: "لم تُرسل بعد", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  PENDING: { label: "قيد المراجعة", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  APPROVED: { label: "مقبولة", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  REJECTED: { label: "مرفوضة", cls: "bg-red-50 text-red-700 border-red-200" },
};

/** KYC card: the recruiter's own verification status (unknown — never "not verified" — when the request failed). */
export function IdentityCard({ state, onRetry }) {
  const ui = state.data ? KYC_UI[state.data.status] ?? KYC_UI.NOT_SUBMITTED : null;
  return (
    <Card className="p-5 flex flex-wrap items-start gap-3 justify-between" data-kyc-card={state.data?.status ?? (state.error ? "UNKNOWN" : "LOADING")}>
      <Link href="/recruiter/verification" data-kyc-link className="flex items-start gap-3 min-w-0 flex-1 hover:text-violet-700">
        <span className="grid place-items-center w-11 h-11 rounded-2xl bg-emerald-50 text-emerald-600 shrink-0"><ShieldCheck className="w-6 h-6" aria-hidden="true" /></span>
        <span className="min-w-0">
          <span className="block text-base font-extrabold">التحقق من الهوية</span>
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
      ) : (
        <span className="shrink-0 text-xs text-slate-400" aria-live="polite">جارٍ التحميل…</span>
      )}
    </Card>
  );
}

const DATE_FMT = new Intl.DateTimeFormat("ar-MA", { timeZone: "Africa/Casablanca", dateStyle: "medium", timeStyle: "short" });
const fmtDate = (iso) => (iso ? DATE_FMT.format(new Date(iso)) : "—");

function InfoRow({ label, value, dirLtr = false }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-violet-50 last:border-0 min-w-0">
      <dt className="text-sm text-slate-500 shrink-0">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900 truncate min-w-0" dir={dirLtr ? "ltr" : undefined}>{value}</dd>
    </div>
  );
}

/** The recruiter's own account information (GET /api/recruiter/me). */
export function AccountCard({ me }) {
  const active = me.status === "ACTIVE";
  return (
    <Card className="p-5" aria-labelledby="acc-title" data-account>
      <CardTitle Icon={UserCog} id="acc-title" title="معلومات الحساب" aside={
        <span data-account-status
          className={`shrink-0 text-xs font-bold rounded-full px-2.5 py-1 ${active ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {active ? "مفعّل" : "معطّل"}
        </span>} />
      <dl className="mt-2">
        <InfoRow label="الاسم" value={me.name || "—"} />
        <InfoRow label="اسم المستخدم" value={me.username || "—"} dirLtr />
        <InfoRow label="الهاتف" value={me.phone || "—"} dirLtr />
        <InfoRow label="تاريخ الإنشاء" value={fmtDate(me.createdAt)} />
        <InfoRow label="آخر تسجيل دخول" value={fmtDate(me.lastLoginAt)} />
      </dl>
      <div className="mt-3 flex flex-wrap gap-2" data-password-cta>
        <Link href="/recruiter/password" data-password-link
          className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-bold text-violet-700 hover:bg-violet-100">
          <Settings className="w-4 h-4" aria-hidden="true" /> تغيير كلمة السر
        </Link>
      </div>
    </Card>
  );
}

/** The activity log is not available yet. */
export function ComingSoon() {
  return (
    <Card className="p-5 flex items-center gap-3 border-dashed text-sm text-slate-600" data-coming-soon>
      <History className="w-5 h-5 text-slate-400 shrink-0" aria-hidden="true" />
      <span>سجل العمليات: قريباً.</span>
    </Card>
  );
}

/**
 * "كيف تعمل المكافآت" — the rules of the system, with the CURRENT settings from GET /api/recruiter/progress
 * (thresholds, group size, switches). Escape / backdrop / close button close it.
 */
export function GuideDialog({ open, onClose, summary, groupInfo }) {
  const panelRef = useRef(null);
  useModal(open, onClose, panelRef);
  if (!open) return null;
  const t = summary?.individualThreshold;
  const rules = [
    summary?.individualEnabled
      ? `المكافأة الفردية: تحصل على مكافأة عن كل أفلييت في شبكتك يصل إلى ${t ?? "—"} مبيعات حقيقية مُسلّمة مع بطاقة وطنية مقبولة.`
      : "المكافأة الفردية غير مفعّلة حالياً.",
    groupInfo?.enabled
      ? `مكافأة المجموعة: كل ${groupInfo.size ?? "—"} أفلييت مؤهَّلين (${groupInfo.threshold ?? "—"} مبيعات حقيقية مُسلّمة + بطاقة مقبولة) يمنحونك مكافأة مجموعة.`
      : "مكافأة المجموعة غير مفعّلة حالياً.",
    "تُحتسب فقط الطلبات الحقيقية المُسلّمة؛ الطلبات التجريبية لا تُحتسب أبداً.",
    "إذا نزلت مبيعات أفلييت تحت الحد بعد الإلغاء أو الإرجاع، تُلغى مكافأته وتظهر في سجل مكافآتك.",
    "كل أفلييت في شبكتك يُحتسب لك، سواء أنشأته بنفسك أو انضم عن طريق أحد أفلييتك.",
    "قبل أي طلب سحب يجب أن تكون بطاقتك الوطنية مقبولة ومعلوماتك البنكية كاملة.",
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="guide-title" data-guide>
      <button type="button" className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]" aria-label="إغلاق" onClick={onClose} />
      <div ref={panelRef} className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-3xl bg-white shadow-2xl p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 id="guide-title" className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
            <Crown className="w-6 h-6 text-amber-500" fill="currentColor" aria-hidden="true" /> كيف تعمل المكافآت
          </h2>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="grid place-items-center w-9 h-9 rounded-xl text-slate-500 hover:bg-slate-100">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <ul className="mt-4 space-y-3">
          {rules.map((r) => (
            <li key={r} className="flex items-start gap-2 text-sm text-slate-700 leading-relaxed">
              <CheckCircle2 className="w-5 h-5 text-violet-500 shrink-0 mt-0.5" aria-hidden="true" /><span>{r}</span>
            </li>
          ))}
        </ul>
        <Link href="/recruiter/affiliates" onClick={onClose} className="mt-5 inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700">
          تابع تقدّم كل أفلييت <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

/** KPI values of the network statistics: "…" while loading, "—" when unavailable. */
export const kpiNumber = (n) => (Number.isInteger(n) ? fmt(n) : "—");
