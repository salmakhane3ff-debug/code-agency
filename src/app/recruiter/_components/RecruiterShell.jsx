"use client";
/**
 * src/app/recruiter/_components/RecruiterShell.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The recruiter navigation and layout — simplified to THREE main sections (لوحة التحكم / الأفلييت / المحفظة)
 * plus "المزيد", in the AFFILIATE dashboard's visual language (src/app/affiliate/dashboard/page.jsx):
 *   • phone / tablet (< md): white header, the affiliate bottom bar (rounded-t-[28px], violet active pill, a
 *     centre "+" button — here: create an affiliate, only with canCreateAffiliates) and the affiliate "المزيد"
 *     bottom sheet (3-column tile grid, red logout tile);
 *   • desktop (md+): a light sidebar at the START side (right in RTL / Arabic, left in LTR / French — the affiliate's
 *     gray-900 active pill), the three sections, the create button and the "المزيد" group.
 * Market language: every label comes from RECRUITER_TEXT (useRecruiterLocale); the layout uses logical sides only, so
 * it mirrors with the direction. The site's existing LanguageSwitcher (🇲🇦 / 🇫🇷, `store_lang`) sits in the header (all
 * sizes) and in the "المزيد" sheet — the recruiter area has no store header.
 * Hiding an entry is a convenience: the server enforces every permission on every request. No data is fetched
 * here: RecruiterAppShell passes the recruiter, the permissions and the alerts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  LayoutDashboard, Users, Wallet, Plus, MoreHorizontal, UserRound, ShieldCheck, Lock, KeyRound, BarChart3, CircleHelp,
  LogOut, Bell, Zap, X,
} from "lucide-react";
import { MarketLanguageSwitcher as LanguageSwitcher } from "@/context/useMarketLocale";
import { useRecruiterLocale } from "./ui";

/** The three main sections. */
export const MAIN_SECTIONS = [
  { id: "home", labelKey: "nav_home", shortKey: "nav_home_short", Icon: LayoutDashboard, href: "/recruiter" },
  { id: "affiliates", labelKey: "nav_affiliates", shortKey: "nav_affiliates", Icon: Users, href: "/recruiter/affiliates" },
  { id: "wallet", labelKey: "nav_wallet", shortKey: "nav_wallet", Icon: Wallet, href: "/recruiter/wallet" },
];
/** Secondary entries, grouped under "المزيد" (help and logout are actions, added by the shell). */
export const MORE_SECTIONS = [
  { id: "profile", labelKey: "nav_profile", Icon: UserRound, href: "/recruiter/profile" },
  { id: "verification", labelKey: "nav_verification", Icon: ShieldCheck, href: "/recruiter/verification" },
  { id: "password", labelKey: "nav_password", Icon: Lock, href: "/recruiter/password" },
  { id: "activation", labelKey: "nav_activation", Icon: KeyRound, href: "/recruiter/affiliates/activation" },
  { id: "stats", labelKey: "nav_stats", Icon: BarChart3, href: "/recruiter/network/stats" },
];
const MORE_IDS = new Set(MORE_SECTIONS.map((s) => s.id));
/** Creation needs an explicit canCreateAffiliates === true (the server refuses otherwise anyway). */
export const canCreateFrom = (perms) => perms?.canCreateAffiliates === true;

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour shared by the "المزيد" sheet and the guide dialog: Escape closes, Tab stays inside the panel,
 * the page behind does not scroll, the first control is focused on open and the opener gets the focus back on
 * close. `onClose` must be stable (useCallback).
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

function Brand() {
  const { t } = useRecruiterLocale();
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-violet-600 text-white">
        <Zap className="w-5 h-5" fill="currentColor" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-gray-900 leading-none"><bdi dir="ltr">Ecome Agency</bdi></span>
        <span className="block text-xs text-gray-500 mt-1">{t("shell_role")}</span>
      </span>
    </div>
  );
}

const sideItem = (on) => `flex items-center gap-3 min-h-11 px-3 rounded-xl text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${
  on ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`;

/** Desktop sidebar: the three sections, the create button, then the "المزيد" group. */
function Sidebar({ current, perms, onShowGuide, onLogout, loggingOut }) {
  const { t } = useRecruiterLocale();
  return (
    <aside className="sticky top-0 h-screen overflow-y-auto flex flex-col gap-5 p-4" data-sidebar>
      <div className="px-1 pt-1"><Brand /></div>
      <nav aria-label={t("nav_main")} className="space-y-1">
        {MAIN_SECTIONS.map(({ id, labelKey, Icon, href }) => (
          <Link key={id} href={href} data-section={id} aria-current={current === id ? "page" : undefined} className={sideItem(current === id)}>
            <Icon className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
            <span className="truncate">{t(labelKey)}</span>
          </Link>
        ))}
      </nav>
      {canCreateFrom(perms) && (
        <Link href="/recruiter/affiliates/new" data-section="add"
          className={`flex items-center justify-center gap-2 min-h-11 rounded-xl text-sm font-bold ${current === "add" ? "bg-violet-700 text-white" : "bg-violet-600 hover:bg-violet-700 text-white"}`}>
          <Plus className="w-4 h-4" aria-hidden="true" /> {t("nav_add_affiliate")}
        </Link>
      )}
      <nav aria-label={t("nav_more")} className="space-y-0.5">
        <p className="px-3 pb-1 text-[11px] font-bold text-gray-400">{t("nav_more")}</p>
        {MORE_SECTIONS.map(({ id, labelKey, Icon, href }) => (
          <Link key={id} href={href} data-section={id} aria-current={current === id ? "page" : undefined} className={`${sideItem(current === id)} font-medium`}>
            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{t(labelKey)}</span>
          </Link>
        ))}
        {onShowGuide && (
          <button type="button" onClick={onShowGuide} data-section="help" className={`${sideItem(false)} w-full font-medium`}>
            <CircleHelp className="w-4 h-4 shrink-0" aria-hidden="true" /> {t("nav_help")}
          </button>
        )}
        <button type="button" onClick={onLogout} disabled={loggingOut} data-section="logout"
          className="w-full flex items-center gap-3 min-h-11 px-3 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60">
          <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" /> {t("nav_logout")}
        </button>
      </nav>
    </aside>
  );
}

/** Which bottom-bar tab a menu id belongs to (the "المزيد" pages light up "المزيد"; creation lights up الأفلييت). */
export const bottomTabOf = (current) => (MORE_IDS.has(current) ? "more" : current === "add" ? "affiliates" : current);

function BottomItem({ id, label, Icon, href, onClick, on, current, expanded }) {
  const inner = (
    <>
      <span className={`relative flex items-center justify-center w-11 h-8 rounded-2xl transition-all ${on ? "bg-violet-100 text-violet-600" : "text-gray-400"}`}>
        <Icon className="w-[22px] h-[22px]" strokeWidth={on ? 2.5 : 2} aria-hidden="true" />
      </span>
      <span className={`text-[10px] font-bold ${on ? "text-violet-600" : "text-gray-400"}`}>{label}</span>
    </>
  );
  const cls = "relative flex-1 min-w-0 min-h-12 flex flex-col items-center gap-1 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 rounded-2xl";
  return href
    ? <Link href={href} className={cls} aria-current={on && current === id ? "page" : undefined} data-bottom-tab={id} data-active={on ? "" : undefined}>{inner}</Link>
    : <button type="button" onClick={onClick} className={cls} aria-expanded={expanded} aria-haspopup="dialog" data-bottom-tab={id} data-active={on ? "" : undefined}>{inner}</button>;
}

/** The affiliate dashboard's bottom bar: 3 sections + centre "+" (creation, when allowed) + "المزيد". */
function BottomNav({ current, perms, onMore, moreOpen }) {
  const { t } = useRecruiterLocale();
  const tab = moreOpen ? "more" : bottomTabOf(current);
  return (
    <nav aria-label={t("nav_quick")} data-bottom-nav
      className="md:hidden fixed bottom-0 inset-x-0 z-[60] bg-white border-t border-gray-100 rounded-t-[28px] shadow-[0_-6px_24px_rgba(0,0,0,0.08)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="flex items-end justify-around px-1.5 pt-2 pb-1 max-w-xl mx-auto">
        <BottomItem id="home" label={t(MAIN_SECTIONS[0].shortKey)} Icon={LayoutDashboard} href="/recruiter" on={tab === "home"} current={current} />
        <BottomItem id="affiliates" label={t(MAIN_SECTIONS[1].shortKey)} Icon={Users} href="/recruiter/affiliates" on={tab === "affiliates"} current={current} />
        {canCreateFrom(perms) && (
          <div className="flex-1 flex flex-col items-center">
            <Link href="/recruiter/affiliates/new" aria-label={t("nav_add_affiliate")} data-bottom-tab="add"
              className="-mt-7 w-14 h-14 rounded-full bg-violet-600 hover:bg-violet-700 active:scale-90 text-white shadow-lg shadow-violet-300 flex items-center justify-center transition-all">
              <Plus className="w-7 h-7" aria-hidden="true" />
            </Link>
            <span className="text-[10px] font-bold text-violet-600 mt-1">{t("nav_add_short")}</span>
          </div>
        )}
        <BottomItem id="wallet" label={t(MAIN_SECTIONS[2].shortKey)} Icon={Wallet} href="/recruiter/wallet" on={tab === "wallet"} current={current} />
        <BottomItem id="more" label={t("nav_more")} Icon={MoreHorizontal} onClick={onMore} on={tab === "more"} current={current} expanded={moreOpen} />
      </div>
    </nav>
  );
}

/** The affiliate dashboard's "المزيد" bottom sheet: a 3-column tile grid, a red logout tile. */
function MoreSheet({ open, onClose, current, onShowGuide, onLogout, loggingOut }) {
  const { t } = useRecruiterLocale();
  const panelRef = useRef(null);
  useModal(open, onClose, panelRef);
  if (!open) return null;
  const tile = (on) => `flex flex-col items-center justify-center gap-2 min-h-[84px] rounded-2xl p-3 text-xs font-semibold text-center transition-colors ${
    on ? "bg-violet-50 text-violet-600" : "bg-gray-50 text-gray-600 hover:bg-gray-100"}`;
  return (
    <div className="md:hidden fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={t("nav_more")} data-more-sheet>
      <button type="button" className="absolute inset-0 bg-black/40" aria-label={t("common_close")} onClick={onClose} tabIndex={-1} />
      <div ref={panelRef} className="absolute bottom-0 inset-x-0 bg-white rounded-t-[28px] shadow-2xl px-5 pt-4 max-h-[85vh] overflow-y-auto"
        style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom))" }}>
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-gray-200" aria-hidden="true" />
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-bold text-gray-900">{t("nav_more")}</p>
          <button type="button" onClick={onClose} aria-label={t("common_close")} className="grid place-items-center w-10 h-10 rounded-xl text-gray-500 hover:bg-gray-100">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <nav aria-label={t("nav_more")} className="grid grid-cols-3 gap-3">
          {MORE_SECTIONS.map(({ id, labelKey, Icon, href }) => (
            <Link key={id} href={href} onClick={onClose} data-section={id} aria-current={current === id ? "page" : undefined} className={tile(current === id)}>
              <Icon className="w-6 h-6" aria-hidden="true" />
              <span className="leading-tight">{t(labelKey)}</span>
            </Link>
          ))}
          {onShowGuide && (
            <button type="button" onClick={() => { onClose(); onShowGuide(); }} data-section="help" className={tile(false)}>
              <CircleHelp className="w-6 h-6" aria-hidden="true" />
              <span>{t("nav_help")}</span>
            </button>
          )}
          <button type="button" onClick={onLogout} disabled={loggingOut} data-section="logout"
            className="flex flex-col items-center justify-center gap-2 min-h-[84px] rounded-2xl p-3 text-xs font-semibold bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-60">
            <LogOut className="w-6 h-6" aria-hidden="true" />
            <span>{t("nav_logout")}</span>
          </button>
        </nav>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-gray-50 px-4 py-3" data-more-language>
          <span className="text-xs font-semibold text-gray-600">{t("shell_language")}</span>
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  );
}

const TONE_DOT = { red: "bg-red-500", amber: "bg-amber-500", slate: "bg-gray-400" };

/** Header bell: the recruiter's real alerts (account, identity, permissions, rewards off). */
function AlertsMenu({ alerts }) {
  const { t } = useRecruiterLocale();
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
        aria-label={n ? t("shell_alerts_count", { n }) : t("shell_alerts")}
        className="relative grid place-items-center w-10 h-10 rounded-xl text-gray-500 hover:text-gray-800 hover:bg-gray-100 outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
        <Bell className="w-5 h-5" aria-hidden="true" />
        {n > 0 && <span className="absolute top-1 end-1 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold grid place-items-center" data-alerts-dot>{n}</span>}
      </button>
      {open && (
        <div className="absolute inset-x-4 top-full mt-2 z-50 sm:inset-x-auto sm:end-0 sm:w-80 rounded-2xl bg-white border border-gray-100 shadow-xl p-2" data-alerts-panel>
          <p className="px-2 pt-1 pb-2 text-sm font-bold text-gray-900">{t("shell_alerts")}</p>
          {n === 0 ? (
            <p className="px-2 pb-2 text-sm text-gray-500" data-alerts-empty>{t("shell_alerts_empty")}</p>
          ) : (
            <ul className="space-y-1">
              {alerts.map((a) => (
                <li key={a.id} data-alert={a.id}>
                  {a.href ? (
                    <Link href={a.href} className="flex items-start gap-2 rounded-xl px-2 py-2 text-sm text-gray-700 hover:bg-gray-50" onClick={() => setOpen(false)}>
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${TONE_DOT[a.tone] ?? TONE_DOT.slate}`} aria-hidden="true" />
                      <span className="min-w-0">{a.text}</span>
                    </Link>
                  ) : (
                    <span className="flex items-start gap-2 rounded-xl px-2 py-2 text-sm text-gray-700">
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

/**
 * The recruiter layout around `children`. Props: me (recruiter view, null while loading), perms,
 * current (menu id), alerts, onLogout, loggingOut, onShowGuide.
 */
export default function RecruiterShell({ me, perms, current = "home", alerts = [], onLogout, loggingOut = false, onShowGuide, children }) {
  const { t } = useRecruiterLocale();
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const active = me?.status === "ACTIVE";

  // The sheet exists only below md: close it when the screen grows (rotation, resize) so the page never stays locked.
  useEffect(() => {
    if (!moreOpen || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => { if (mq.matches) setMoreOpen(false); };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [moreOpen]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 md:flex [contain:inline-size]" style={{ fontFamily: "var(--font-rubik), 'Segoe UI', Tahoma, Arial, sans-serif" }} data-recruiter-app>
      {/* Desktop / tablet sidebar (start side: right in RTL, left in LTR; its border on the inner, end side) */}
      <div className="hidden md:block w-60 lg:w-64 shrink-0 bg-white border-e border-gray-100">
        <Sidebar current={current} perms={perms} onShowGuide={onShowGuide} onLogout={onLogout} loggingOut={loggingOut} />
      </div>

      <div className="flex-1 min-w-0">
        <header className="bg-white border-b border-gray-100 sticky top-0 z-20">
          <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-8 h-8 shrink-0 rounded-xl bg-gray-900 text-white grid place-items-center" aria-hidden="true" data-avatar>
                <UserRound className="w-4 h-4" />
              </span>
              <div className="min-w-0">
                {/* The name is its own isolated, truncating run: a Latin name inside the Arabic greeting keeps its own
                    order and is cut at ITS end ("Amine Recr…"), never mid-string from the wrong side. */}
                <p className="flex min-w-0 text-sm font-bold text-gray-900 leading-none" data-greeting>
                  {me?.name ? (() => {
                    const [pre = "", post = ""] = String(t("shell_hello_name")).split("{name}");
                    return (<>
                      {pre && <span className="shrink-0 whitespace-pre">{pre}</span>}
                      <bdi className="min-w-0 truncate" data-greeting-name>{me.name}</bdi>
                      {post && <span className="shrink-0 whitespace-pre">{post}</span>}
                    </>);
                  })() : <span className="truncate">{t("shell_hello")}</span>}
                </p>
                <p className="mt-1 flex items-center gap-1.5 min-w-0 text-xs text-gray-500">
                  {me?.username && <bdi className="truncate" dir="ltr">@{me.username}</bdi>}
                  {me && (
                    <span className={`shrink-0 text-[10px] font-bold rounded-full px-1.5 py-0.5 ${active ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`} data-header-status>
                      {active ? t("status_active") : t("status_disabled")}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <div className="shrink-0 pe-1" data-header-language><LanguageSwitcher /></div>
              <AlertsMenu alerts={alerts} />
              <button type="button" onClick={onLogout} disabled={loggingOut} data-logout aria-label={t("nav_logout")}
                className="inline-flex items-center gap-1.5 min-h-10 px-3 py-1.5 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-xl font-semibold disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-red-200">
                <LogOut className="w-4 h-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t("shell_logout_short")}</span>
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-4 pt-5 pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-8">{children}</main>
      </div>

      <BottomNav current={current} perms={perms} onMore={() => setMoreOpen(true)} moreOpen={moreOpen} />
      <MoreSheet open={moreOpen} onClose={closeMore} current={current} onShowGuide={onShowGuide} onLogout={onLogout} loggingOut={loggingOut} />
    </div>
  );
}
