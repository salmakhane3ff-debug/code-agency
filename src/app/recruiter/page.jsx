"use client";
/**
 * /recruiter — recruiter dashboard (Phase 2: account information + menu skeleton;
 * Phase 3: "إضافة أفلييت جديد" links to /recruiter/affiliates/new; Phase 4: the network
 * tree /recruiter/network and its statistics / order tracking /recruiter/network/stats).
 * Arabic, RTL. Data comes ONLY from GET /api/recruiter/me (toRecruiterProfileView);
 * 401 / 403 → back to the login page. The other sections arrive in later phases and
 * are shown disabled ("قريباً").
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Home, Users, UserPlus, GitBranch, ShieldCheck, PackageCheck, Gift, History, LogOut, Menu, X, UserCog, BarChart3,
} from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "./errorLabels";

const SECTIONS = [
  { id: "home", label: "الرئيسية والإحصائيات", Icon: Home, active: true },
  { id: "network", label: "شبكة الأفلييت ديالي", Icon: Users, href: "/recruiter/network" },
  { id: "add", label: "إضافة أفلييت جديد", Icon: UserPlus, href: "/recruiter/affiliates/new" },
  { id: "tree", label: "شجرة المستويات", Icon: GitBranch, href: "/recruiter/network" },
  { id: "verification", label: "طلبات التحقق", Icon: ShieldCheck },
  { id: "orders", label: "الطلبات المسلّمة وغير المسلّمة", Icon: PackageCheck, href: "/recruiter/network/stats" },
  { id: "rewards", label: "مكافآتي", Icon: Gift },
  { id: "log", label: "سجل العمليات", Icon: History },
];

const DATE_FMT = new Intl.DateTimeFormat("ar-MA", { timeZone: "Africa/Casablanca", dateStyle: "medium", timeStyle: "short" });
const fmtDate = (iso) => (iso ? DATE_FMT.format(new Date(iso)) : "—");

function Nav({ onNavigate }) {
  return (
    <nav aria-label="القائمة الرئيسية" className="space-y-1">
      {SECTIONS.map(({ id, label, Icon, active, href }) => (
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

export default function RecruiterDashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [notice, setNotice] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/recruiter/me", { credentials: "include", cache: "no-store" });
        if (!alive) return;
        if (res.ok) { const body = await res.json(); if (alive) setMe(body?.recruiter ?? null); return; }
        const { code } = toRecruiterError(await res.json().catch(() => null));
        if (res.status === 403 && code === "RECRUITER_DISABLED") {
          setNotice(recruiterErrorLabel(code));
          setTimeout(() => { if (alive) router.replace("/recruiter/login"); }, 2500);
          return;
        }
        router.replace("/recruiter/login");
      } catch {
        if (alive) setNotice(recruiterErrorLabel(null));
      }
    })();
    return () => { alive = false; };
  }, [router]);

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
          : <p className="text-sm text-slate-500" aria-live="polite">جارٍ التحميل…</p>}
      </main>
    );
  }

  const active = me.status === "ACTIVE";
  return (
    <div className="min-h-screen lg:flex [contain:inline-size]" data-recruiter-dashboard>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-72 shrink-0 bg-white border-l border-slate-200 p-4 gap-4 min-h-screen">
        <div className="flex items-center gap-2 px-1">
          <UserCog className="w-6 h-6 text-emerald-600" aria-hidden="true" />
          <span className="font-bold">مسؤول التوظيف</span>
        </div>
        <Nav />
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
              <Nav onNavigate={() => setMenuOpen(false)} />
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

          {active && (
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
                <span className="block text-base font-bold">الإحصائيات وتتبّع الطلبات</span>
                <span className="block text-sm text-slate-500 mt-0.5">الأفلييت حسب المستوى، التحقق، والطلبات الحقيقية والتجريبية.</span>
              </span>
            </Link>
          </section>

          <section className="bg-white rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600" data-coming-soon>
            باقي الأقسام (طلبات التحقق، المكافآت، السجل) ستكون متاحة قريباً.
          </section>
        </main>
      </div>
    </div>
  );
}
