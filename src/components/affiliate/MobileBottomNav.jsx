"use client";
/**
 * src/components/affiliate/MobileBottomNav.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The affiliate mobile bottom navigation (+ its "More" sheet and copy toast), moved here
 * unchanged from src/app/affiliate/dashboard/page.jsx so the SAME component is rendered:
 *   • by the dashboard (tabs switch in place through `setActiveTab`);
 *   • by AffiliateNavGate on /top-members, /top-brands and their profiles — only for a
 *     signed-in affiliate — where `setActiveTab` opens /affiliate/dashboard?tab=<id>.
 * Appearance, icons, order, translations and behaviour are the dashboard's. Safe areas:
 * bottom (home indicator) + left / right (landscape notch) insets are padded; they are
 * non-zero only where the route enables viewport-fit=cover (affiliate + Top layouts).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Package, Store, Gift, Video, Users, Wallet, Building2, Bell, Settings, X, LogOut,
  Home, TrendingUp, Plus, ShoppingBag, MoreHorizontal,
} from "lucide-react";
import { useMarketLocale } from "@/context/useMarketLocale";
import { AFFILIATE_DASHBOARD_TEXT } from "@/lib/affiliateDashboardI18n";

// ── Mobile bottom navigation (mobile/tablet only, ≤768px) ──────────────────────
// Additive: the existing desktop header + tab bar are untouched. Reuses the same
// tabs/actions and the SAME referral link (center button copies it, no new URL).
function MobileBottomNav({ activeTab, setActiveTab, refLink, onLogout, unread = 0, onOpenNotifications, rechargeEnabled = true }) {
  const router = useRouter();
  const { t } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const [toast, setToast] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const go = (tab) => {
    setActiveTab(tab);
    if (tab === "notifications") onOpenNotifications?.(); // same mark-read as the header bell
    setMoreOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const share = () => {
    if (!refLink) return;
    navigator.clipboard.writeText(refLink).then(() => {
      setToast(true); setTimeout(() => setToast(false), 2000);
    }).catch(() => {});
  };

  const moreItems = [
    { icon: Package,     label: t("more_orders"),        tab: "orders" },
    { icon: Store,       label: t("more_brand"),         tab: "brand" },
    { icon: Gift,        label: t("more_rewards"),       tab: "rewards" },
    { icon: Video,       label: t("more_ugc"),           tab: "ugc" },
    { icon: Users,       label: t("more_team"),          tab: "team" },
    { icon: Wallet,      label: t("more_payout"),        tab: "payout" },
    { icon: Wallet,      label: t("more_deposit"),       tab: "deposit" },
    { icon: Building2,   label: t("more_bank"),          tab: "bank" },
    { icon: Bell,        label: t("more_notifications"), tab: "notifications", badge: unread },
    { icon: Settings,    label: t("more_settings"),      tab: "settings" },
  ];

  const NavItem = ({ icon: Icon, label, active, onClick, dot }) => (
    <button type="button" onClick={onClick} className="relative flex-1 flex flex-col items-center gap-1 py-1.5 focus:outline-none">
      <span className={`relative flex items-center justify-center w-11 h-8 rounded-2xl transition-all ${active ? "bg-violet-100 text-violet-600" : "text-gray-400"}`}>
        <Icon className="w-[22px] h-[22px]" strokeWidth={active ? 2.5 : 2} />
        {dot > 0 && <span className="absolute -top-0.5 end-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{dot > 9 ? "9+" : dot}</span>}
      </span>
      <span className={`text-[10px] font-bold ${active ? "text-violet-600" : "text-gray-400"}`}>{label}</span>
    </button>
  );

  return (
    <>
      {/* Success toast */}
      {toast && (
        <div className="md:hidden fixed left-1/2 -translate-x-1/2 z-[70] bg-gray-900 text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-xl animate-[bnToast_0.25s_ease]"
          style={{ bottom: "calc(104px + env(safe-area-inset-bottom))" }}>
          {t("nav_link_copied")}
        </div>
      )}

      {/* "More" bottom sheet */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-[70]" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()}
            className="absolute bottom-0 inset-x-0 bg-white rounded-t-[28px] shadow-2xl px-5 pt-4 animate-[bnUp_0.3s_ease]"
            style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom))" }}>
            <div className="w-10 h-1 rounded-full bg-gray-200 mx-auto mb-4" />
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-black text-gray-900">{t("more_title")}</h3>
              <button type="button" onClick={() => setMoreOpen(false)} aria-label={t("close")} title={t("close")} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {/* "Recharge de solde" entry only while the admin switch is ON */}
              {moreItems.filter((m) => m.tab !== "deposit" || rechargeEnabled).map(({ icon: Icon, label, tab, badge }) => (
                <button key={tab} type="button" onClick={() => go(tab)}
                  className={`relative flex flex-col items-center justify-center gap-2 rounded-2xl py-4 px-2 transition-colors ${activeTab === tab ? "bg-violet-50 text-violet-600" : "bg-gray-50 text-gray-600 hover:bg-gray-100"}`}>
                  <Icon className="w-6 h-6" />
                  <span className="text-[11px] font-semibold text-center leading-tight">{label}</span>
                  {badge > 0 && <span className="absolute top-2 end-2 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{badge > 9 ? "9+" : badge}</span>}
                </button>
              ))}
              <button type="button" onClick={() => { setMoreOpen(false); onLogout(); }}
                className="flex flex-col items-center justify-center gap-2 rounded-2xl py-4 px-2 bg-red-50 text-red-600 hover:bg-red-100 transition-colors">
                <LogOut className="w-6 h-6" />
                <span className="text-[11px] font-semibold">{t("logout")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom nav bar */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-[60] bg-white border-t border-gray-100 rounded-t-[28px] shadow-[0_-6px_24px_rgba(0,0,0,0.08)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}>
        <div className="flex items-end justify-around px-1.5 pt-2 pb-1">
          <NavItem icon={Home}       label={t("nav_home")}     active={activeTab === "overview"} onClick={() => go("overview")} />
          <NavItem icon={TrendingUp} label={t("nav_earnings")} active={activeTab === "payout"}   onClick={() => go("payout")} />

          {/* Center floating action — copies the referral link */}
          <div className="flex-1 flex flex-col items-center">
            <button type="button" onClick={share} aria-label={t("nav_share_aria")}
              className="-mt-7 w-14 h-14 rounded-full bg-violet-600 hover:bg-violet-700 active:scale-90 text-white shadow-lg shadow-violet-300 flex items-center justify-center transition-all">
              <Plus className="w-7 h-7" strokeWidth={2.5} />
            </button>
            <span className="text-[10px] font-bold text-violet-600 mt-1">{t("nav_share")}</span>
          </div>

          <NavItem icon={ShoppingBag}    label={t("nav_products")} active={false}    onClick={() => router.push("/products")} />
          <NavItem icon={MoreHorizontal} label={t("nav_more")}     active={moreOpen} onClick={() => setMoreOpen(true)} dot={unread} />
        </div>
      </nav>

      <style>{`
        @keyframes bnUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
        @keyframes bnToast{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
      `}</style>
    </>
  );
}

export default MobileBottomNav;
