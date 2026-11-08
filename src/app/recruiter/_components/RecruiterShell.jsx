"use client";
/**
 * src/app/recruiter/_components/RecruiterShell.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Recruiter dashboard redesign (UI only): the recruiter navigation and layout — a deep-indigo sidebar
 * on the right (desktop), a sticky header (avatar, greeting, real alerts, rewards shortcut, logout)
 * and a collapsible drawer on mobile / tablet (Escape, backdrop and close button close it; the page
 * behind does not scroll while it is open).
 *
 * The menu shows only what the recruiter's permissions allow (from GET /api/recruiter/me): creation
 * needs an explicit canCreateAffiliates === true, the orders entry an explicit canViewOrders === true.
 * Hiding is a convenience — the server enforces both on every request. No data is fetched here: the
 * page passes the recruiter, the permissions and the alerts it already loaded.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  LayoutDashboard, Network, ListChecks, UserPlus, ShoppingCart, Gift, ShieldCheck, KeyRound, Settings, History,
  CircleHelp, LogOut, Menu, X, Bell, Zap, Rocket, ArrowLeft, Crown, UserRound, LayoutGrid,
} from "lucide-react";

/** Main menu: one entry per page (the activity log is not available yet → "قريباً"). */
export const SECTIONS = [
  { id: "home", label: "لوحة التحكم", Icon: LayoutDashboard, href: "/recruiter" },
  { id: "network", label: "شبكة الأفلييت", Icon: Network, href: "/recruiter/network" },
  { id: "affiliates", label: "قائمة الأفلييت والتقدّم", Icon: ListChecks, href: "/recruiter/affiliates" },
  { id: "add", label: "إضافة أفلييت جديد", Icon: UserPlus, href: "/recruiter/affiliates/new" },
  { id: "orders", label: "المبيعات والطلبات", Icon: ShoppingCart, href: "/recruiter/network/stats" },
  { id: "rewards", label: "المكافآت والأرباح", Icon: Gift, href: "/recruiter/wallet" },
  { id: "verification", label: "التحقق من الهوية", Icon: ShieldCheck, href: "/recruiter/verification" },
];
/** Account entries, under the main menu. */
export const ACCOUNT_SECTIONS = [
  { id: "activation", label: "تفعيل الحسابات", Icon: KeyRound, href: "/recruiter/affiliates/activation" },
  { id: "password", label: "الإعدادات وكلمة السر", Icon: Settings, href: "/recruiter/password" },
  { id: "log", label: "سجل العمليات", Icon: History },
];

/** Menu sections the recruiter's permissions allow (creation / orders need an explicit `true`). */
export const allowedSections = (perms) => SECTIONS.filter((s) =>
  !(s.id === "add" && perms?.canCreateAffiliates !== true) && !(s.id === "orders" && perms?.canViewOrders !== true));

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour shared by the drawer and the guide dialog: Escape closes, Tab stays inside the panel,
 * the page behind does not scroll, the first control is focused on open and the opener gets the focus
 * back on close. `onClose` must be stable (useCallback).
 */
export function useModal(open, onClose, panelRef) {
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => [...(panelRef.current?.querySelectorAll(FOCUSABLE) ?? [])];
    focusables()[0]?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (!panelRef.current?.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, [open, onClose, panelRef]);
}

function NavItem({ item, current, onNavigate }) {
  const { id, label, Icon, href } = item;
  const isCurrent = current === id;
  if (!href) {
    return (
      <div role="link" aria-disabled="true" tabIndex={-1} data-section={id}
        className="flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm text-indigo-200/50 cursor-not-allowed select-none">
        <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
        <span className="truncate flex-1 min-w-0">{label}</span>
        <span className="shrink-0 text-[10px] font-bold rounded-full bg-white/10 text-indigo-100/70 px-2 py-0.5">قريباً</span>
      </div>
    );
  }
  return (
    <Link href={href} onClick={onNavigate} data-section={id} aria-current={isCurrent ? "page" : undefined}
      className={`group flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${
        isCurrent
          ? "bg-gradient-to-l from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-900/40 ring-1 ring-white/20"
          : "text-indigo-100/85 hover:bg-white/10 hover:text-white"}`}>
      <Icon className={`w-5 h-5 shrink-0 ${isCurrent ? "text-white" : "text-indigo-200/80 group-hover:text-white"}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="grid place-items-center w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-400 to-indigo-600 shadow-lg shadow-violet-900/50">
        <Zap className="w-6 h-6 text-white" fill="currentColor" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-extrabold text-white leading-tight" dir="ltr" style={{ textAlign: "right" }}>Ecome Agency</span>
        <span className="inline-block mt-0.5 text-[11px] font-bold rounded-full bg-violet-500/30 text-violet-100 px-2 py-0.5">مسؤول التوظيف</span>
      </span>
    </div>
  );
}

/** The menu (sidebar and drawer): main entries, then the account entries and help. */
function Nav({ perms, current, onNavigate, onShowGuide }) {
  return (
    <nav aria-label="القائمة الرئيسية" className="space-y-1">
      {allowedSections(perms).map((item) => <NavItem key={item.id} item={item} current={current} onNavigate={onNavigate} />)}
      <div className="my-3 border-t border-white/10" role="separator" />
      {ACCOUNT_SECTIONS.map((item) => <NavItem key={item.id} item={item} current={current} onNavigate={onNavigate} />)}
      {onShowGuide && (
        <button type="button" onClick={() => { onNavigate?.(); onShowGuide(); }} data-section="help"
          className="w-full flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-sm font-semibold text-indigo-100/85 hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
          <CircleHelp className="w-5 h-5 shrink-0 text-indigo-200/80" aria-hidden="true" />
          <span className="truncate">مساعدة: كيف تعمل المكافآت</span>
        </button>
      )}
    </nav>
  );
}

function PromoCard({ onShowGuide }) {
  return (
    <div className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-violet-600/60 to-indigo-900/70 ring-1 ring-white/15 p-5 text-center">
      <Crown className="w-7 h-7 mx-auto text-amber-300" fill="currentColor" aria-hidden="true" />
      <p className="mt-2 text-base font-extrabold text-white leading-snug">طوّر شبكتك<br />واربح مكافآت أكبر</p>
      {onShowGuide && (
        <button type="button" onClick={onShowGuide} data-guide-open
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-bold text-violet-700 shadow hover:bg-violet-50">
          تعرّف على النظام <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
      <div className="relative mt-5 h-20" aria-hidden="true">
        <span className="absolute inset-x-6 bottom-0 h-10 rounded-full bg-violet-400/30 blur-xl" />
        <span className="absolute left-1/2 -translate-x-1/2 bottom-2 grid place-items-center w-16 h-16 rounded-full bg-gradient-to-br from-fuchsia-400 to-violet-600 shadow-xl shadow-violet-950/50">
          <Rocket className="w-8 h-8 text-white -rotate-12" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

const TONE_DOT = { red: "bg-red-500", amber: "bg-amber-500", slate: "bg-slate-400" };

/** Header bell: the recruiter's real alerts (account, identity, permissions, rewards off). */
function AlertsMenu({ alerts }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const n = alerts.length;
  return (
    <div className="sm:relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true" data-alerts-toggle
        aria-label={n ? `التنبيهات (${n})` : "التنبيهات"}
        className="relative grid place-items-center w-11 h-11 rounded-2xl bg-white border border-violet-100 shadow-sm text-slate-700 hover:bg-violet-50 outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
        <Bell className="w-5 h-5" aria-hidden="true" />
        {n > 0 && <span className="absolute top-2 left-2.5 w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-white" data-alerts-dot />}
      </button>
      {open && (
        <div className="absolute inset-x-4 top-full mt-2 z-50 sm:inset-x-auto sm:left-0 sm:w-80 rounded-2xl bg-white border border-violet-100 shadow-xl shadow-violet-900/10 p-2" data-alerts-panel>
          <p className="px-2 pt-1 pb-2 text-sm font-bold text-slate-800">التنبيهات</p>
          {n === 0 ? (
            <p className="px-2 pb-2 text-sm text-slate-500" data-alerts-empty>لا توجد تنبيهات حالياً.</p>
          ) : (
            <ul className="space-y-1">
              {alerts.map((a) => (
                <li key={a.id} data-alert={a.id}>
                  {a.href ? (
                    <Link href={a.href} className="flex items-start gap-2 rounded-xl px-2 py-2 text-sm text-slate-700 hover:bg-violet-50" onClick={() => setOpen(false)}>
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${TONE_DOT[a.tone] ?? TONE_DOT.slate}`} aria-hidden="true" />
                      <span className="min-w-0">{a.text}</span>
                    </Link>
                  ) : (
                    <span className="flex items-start gap-2 rounded-xl px-2 py-2 text-sm text-slate-700">
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${TONE_DOT[a.tone] ?? TONE_DOT.slate}`} aria-hidden="true" />
                      <span className="min-w-0">{a.text}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Bottom tab of a menu id (several pages share one tab; the account pages have none — the "More" drawer). */
const BOTTOM_OF = { home: "home", network: "network", orders: "network", affiliates: "affiliates", add: "affiliates", activation: "affiliates", rewards: "rewards" };

/** Phone / tablet bottom bar: the four most used destinations + "المزيد" (the full drawer menu). */
function BottomNav({ current, onMore, menuOpen }) {
  const tab = BOTTOM_OF[current] ?? null;
  const items = [
    { id: "home", label: "الرئيسية", Icon: LayoutDashboard, href: "/recruiter" },
    { id: "network", label: "الشبكة", Icon: Network, href: "/recruiter/network" },
    { id: "affiliates", label: "الأفلييت", Icon: ListChecks, href: "/recruiter/affiliates" },
    { id: "rewards", label: "المكافآت", Icon: Gift, href: "/recruiter/wallet" },
  ];
  const cls = (on) => `flex-1 min-w-0 flex flex-col items-center justify-center gap-1 min-h-14 rounded-2xl text-[11px] font-bold transition-colors ${
    on ? "text-violet-700 bg-violet-50" : "text-slate-500 hover:text-violet-700"}`;
  return (
    <nav aria-label="التنقل السريع" data-bottom-nav
      className="lg:hidden fixed inset-x-0 bottom-0 z-30 border-t border-violet-100 bg-white/95 backdrop-blur-md shadow-[0_-8px_24px_-12px_rgba(76,29,149,0.25)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="flex items-stretch gap-1 px-2 py-1.5 max-w-xl mx-auto">
        {items.map(({ id, label, Icon, href }) => (
          <Link key={id} href={href} className={cls(tab === id)} aria-current={tab === id && current === id ? "page" : undefined} data-bottom-tab={id}>
            <Icon className="w-5 h-5" aria-hidden="true" />
            <span className="truncate max-w-full">{label}</span>
          </Link>
        ))}
        <button type="button" onClick={onMore} aria-expanded={menuOpen} aria-label="المزيد: القائمة الكاملة" className={cls(!tab)} data-bottom-tab="more">
          <LayoutGrid className="w-5 h-5" aria-hidden="true" />
          <span>المزيد</span>
        </button>
      </div>
    </nav>
  );
}

/**
 * The recruiter layout: sidebar (lg+), header, mobile drawer and bottom bar around `children`.
 * Props: me (recruiter view, null while loading), perms, current (menu id), alerts, onLogout, loggingOut, onShowGuide.
 */
export default function RecruiterShell({ me, perms, current = "home", alerts = [], onLogout, loggingOut = false, onShowGuide, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const panelRef = useRef(null);
  const active = me?.status === "ACTIVE";
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useModal(menuOpen, closeMenu, panelRef);

  // The drawer exists only below lg: close it when the screen grows (rotation, resize) so the page never stays locked.
  useEffect(() => {
    if (!menuOpen || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => { if (mq.matches) setMenuOpen(false); };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [menuOpen]);

  return (
    <div className="min-h-screen bg-[#f5f3ff] lg:flex [contain:inline-size]" style={{ fontFamily: "var(--font-rubik), 'Segoe UI', Tahoma, Arial, sans-serif" }} data-recruiter-app>
      {/* Desktop sidebar (right side in RTL) */}
      <div className="hidden lg:block w-72 shrink-0 bg-gradient-to-b from-[#1e1650] via-[#1a1240] to-[#120c2e]">
        <aside className="sticky top-0 h-screen overflow-y-auto flex flex-col p-5 gap-6" data-sidebar>
          <Brand />
          <Nav perms={perms} current={current} onShowGuide={onShowGuide} />
          <div className="mt-auto"><PromoCard onShowGuide={onShowGuide} /></div>
        </aside>
      </div>

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 bg-[#f5f3ff]/85 backdrop-blur-md border-b border-violet-100/80">
          <div className="flex items-center justify-between gap-3 px-4 sm:px-6 lg:px-8 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <button type="button" className="lg:hidden grid place-items-center w-11 h-11 rounded-2xl bg-white border border-violet-100 shadow-sm text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                aria-label="فتح القائمة" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)} data-menu-open>
                <Menu className="w-5 h-5" aria-hidden="true" />
              </button>
              <span className="hidden sm:grid place-items-center w-12 h-12 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-md shadow-violet-500/30" aria-hidden="true" data-avatar>
                <UserRound className="w-6 h-6" />
              </span>
              <div className="min-w-0">
                <p className="text-base sm:text-xl font-extrabold text-slate-900 truncate" data-greeting>{me?.name ? `مرحباً، ${me.name}` : "مرحباً"}</p>
                <p className="mt-0.5 flex items-center gap-2 min-w-0">
                  <span className="truncate text-[11px] sm:text-xs font-semibold rounded-full bg-violet-100 text-violet-700 px-2.5 py-0.5">حساب مسؤول التوظيف</span>
                  {me && (
                    <span className={`shrink-0 text-[11px] font-bold rounded-full px-2 py-0.5 ${active ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`} data-header-status>
                      {active ? "مفعّل" : "معطّل"}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Link href="/recruiter/wallet" data-header-rewards
                className="hidden md:inline-flex items-center gap-2 h-11 rounded-2xl bg-white border border-violet-100 shadow-sm px-4 text-sm font-bold text-violet-700 hover:bg-violet-50 outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
                <Gift className="w-5 h-5" aria-hidden="true" /> المكافآت
              </Link>
              <AlertsMenu alerts={alerts} />
              <button type="button" onClick={onLogout} disabled={loggingOut} data-logout aria-label="تسجيل الخروج"
                className="inline-flex items-center gap-2 h-11 rounded-2xl bg-white border border-violet-100 shadow-sm px-3 sm:px-4 text-sm font-semibold text-slate-700 hover:bg-violet-50 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
                <LogOut className="w-5 h-5" aria-hidden="true" />
                <span className="hidden sm:inline">تسجيل الخروج</span>
              </button>
            </div>
          </div>
        </header>

        {/* Mobile / tablet drawer */}
        {menuOpen && (
          <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="القائمة الرئيسية" data-drawer>
            <button type="button" className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)} />
            <div ref={panelRef} className="absolute inset-y-0 right-0 w-80 max-w-[86vw] overflow-y-auto bg-gradient-to-b from-[#1e1650] via-[#1a1240] to-[#120c2e] p-5 flex flex-col gap-6 shadow-2xl">
              <div className="flex items-start justify-between gap-2">
                <Brand />
                <button type="button" onClick={closeMenu} aria-label="إغلاق القائمة"
                  className="grid place-items-center w-10 h-10 rounded-xl text-indigo-100 hover:bg-white/10">
                  <X className="w-5 h-5" aria-hidden="true" />
                </button>
              </div>
              <Nav perms={perms} current={current} onNavigate={() => setMenuOpen(false)} onShowGuide={onShowGuide} />
              <div className="mt-auto"><PromoCard onShowGuide={onShowGuide ? () => { setMenuOpen(false); onShowGuide(); } : null} /></div>
            </div>
          </div>
        )}

        <main className="px-4 sm:px-6 lg:px-8 pt-5 sm:pt-6 pb-28 lg:pb-8 max-w-[1280px] mx-auto">{children}</main>
        <BottomNav current={current} menuOpen={menuOpen} onMore={() => setMenuOpen(true)} />
      </div>
    </div>
  );
}
