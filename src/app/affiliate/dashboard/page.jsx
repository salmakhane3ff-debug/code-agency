"use client";

import { useState, useEffect, useCallback, Suspense, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Users, ShoppingBag, DollarSign, TrendingUp,
  Bell, LogOut, RefreshCw, Copy, Check, Loader2,
  ChevronDown, AlertCircle, Package, Truck,
  XCircle, CheckCircle, Building2, CreditCard,
  Target, Star, UserPlus, Eye, AlertTriangle, Settings, Video, Wallet,
  ShieldCheck, ShieldAlert, MessageCircle, Upload, Trash2,
  Home, Plus, MoreHorizontal, X, Store, Gift,
} from "lucide-react";
import UgcTab from "./UgcTab";
import DepositTab from "./DepositTab";
import BoosterTab from "./BoosterTab";
import BrandTab from "./BrandTab";
import RewardsTab from "./RewardsTab";
import PaymentProofsSlider from "@/components/affiliate/PaymentProofsSlider";
import LiveActivity from "@/components/LiveActivity";
import { diffNewItems, shouldPlaySaleSound } from "@/lib/liveFeed";
import { createSaleSound } from "./saleSound";
import { resolveSupportLink } from "@/lib/whatsappSupport";
import { useMarketLocale } from "@/context/useMarketLocale";
import { marketIntlLocale } from "@/lib/marketLocale";
import { AFFILIATE_DASHBOARD_TEXT } from "@/lib/affiliateDashboardI18n";
import DemoCompetitionBlock from "@/components/demoCompetition/DemoCompetitionBlock";
import HomeTopMembers from "@/components/demoCompetition/HomeTopMembers";
import HomeTopBrands from "@/components/demoCompetition/HomeTopBrands";
import { dashboardSectionData } from "@/lib/demoCompetition/homepageSections";
import { orderStatusErrorMessage, shouldRefreshOrdersAfter, orderMessageDir } from "@/lib/affiliateOrderMessages";
import { localizeServerError, localizeNotification } from "@/lib/serverText/affiliateServerText";
import { fieldDir } from "@/lib/marketLocale";

// Live feed: the gap BETWEEN background polls (measured after the previous poll
// finishes, so requests can never stack up). ~3s gives near-instant sale
// appearance while keeping load bounded — one poll at a time, paused when the
// tab is hidden. Reuses the interval-polling approach already used elsewhere.
const LIVE_POLL_MS = 3000;

// Identity verification status → label key (AFFILIATE_DASHBOARD_TEXT) + emoji + colour (single source).
const IDENTITY_UI = {
  NOT_SUBMITTED: { emoji: "🪪", labelKey: "identity_not_submitted", color: "#6b7280", bg: "#f3f4f6" },
  PENDING:       { emoji: "🟡", labelKey: "identity_pending",       color: "#b45309", bg: "#fffbeb" },
  APPROVED:      { emoji: "✅", labelKey: "identity_approved",      color: "#047857", bg: "#ecfdf5" },
  REJECTED:      { emoji: "❌", labelKey: "identity_rejected",      color: "#b91c1c", bg: "#fef2f2" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Unicode isolates: keep numbers / signs / fractions / handles in their LTR order
// inside Arabic (RTL) sentences, including in plain-text strings (titles, toasts).
const LRI = "\u2066";
const PDI = "\u2069";
const ltr = (v) => `${LRI}${v}${PDI}`;
const frac = (a, b) => ltr(`${a} / ${b}`);

// Site convention: Arabic « درهم », French « DH » (from the dictionary).
const currencyLabel = (lang) => (lang === "fr" ? AFFILIATE_DASHBOARD_TEXT.fr.currency : AFFILIATE_DASHBOARD_TEXT.ar.currency);

// Amount + currency in the market language. `grouped` adds thousands separators
// (market locale); `sign` prefixes "+" / "−". The figure is an LTR island.
function fmtMoney(n, lang, { sign = "", grouped = false } = {}) {
  if (n == null || isNaN(n)) return "—";
  const num = grouped ? Math.round(Number(n)).toLocaleString(marketIntlLocale(lang)) : Number(n).toFixed(0);
  return `${ltr(`${sign}${num}`)} ${currencyLabel(lang)}`;
}

function fmtDate(iso, lang) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(marketIntlLocale(lang), {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function authHeaders() {
  const token = localStorage.getItem("affiliateToken") || "";
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  pending:   { labelKey: "status_pending",   cls: "bg-yellow-100 text-yellow-700" },
  confirmed: { labelKey: "status_confirmed", cls: "bg-blue-100   text-blue-700"   },
  shipped:   { labelKey: "status_shipped",   cls: "bg-purple-100 text-purple-700" },
  delivered: { labelKey: "status_delivered", cls: "bg-green-100  text-green-700"  },
  cancelled: { labelKey: "status_cancelled", cls: "bg-red-100    text-red-700"    },
};

// Status label in the market language (unknown statuses are shown as sent).
const statusLabel = (status, t) => (STATUS_CONFIG[status] ? t(STATUS_CONFIG[status].labelKey) : status);

function StatusBadge({ status }) {
  const { t } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const cfg = STATUS_CONFIG[status] || { cls: "bg-gray-100 text-gray-600" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.cls}`}>{statusLabel(status, t)}</span>;
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color = "gray" }) {
  const colors = {
    gray:   "bg-gray-100   text-gray-700",
    blue:   "bg-blue-50    text-blue-600",
    green:  "bg-green-50   text-green-600",
    purple: "bg-purple-50  text-purple-600",
    red:    "bg-red-50     text-red-600",
    amber:  "bg-amber-50   text-amber-600",
    teal:   "bg-teal-50    text-teal-600",
  };
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2.5">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${colors[color]}`}>
        <Icon className="w-4.5 h-4.5 w-[18px] h-[18px]" />
      </div>
      <div>
        <p className="text-xl font-bold text-gray-900 leading-none">{value}</p>
        <p className="text-xs text-gray-500 mt-1">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────

function Section({ title, children, icon: Icon }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-50 bg-gray-50/60 flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-gray-500" />}
        <h2 className="text-sm font-bold text-gray-700 leading-tight">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ progress, target, remaining, validReferrals }) {
  const { t } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-gray-700">{t("progress_valid_referrals")}</span>
        <span className="font-bold text-gray-900">{frac(validReferrals, target)}</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r rtl:bg-gradient-to-l from-blue-500 to-blue-600 rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span className="font-medium text-blue-600">{t("progress_complete", { n: progress })}</span>
        {remaining > 0 ? (
          <span>{t(remaining !== 1 ? "progress_remaining_other" : "progress_remaining_one", { n: remaining })}</span>
        ) : (
          <span className="text-green-600 font-semibold">{t("progress_reached")}</span>
        )}
      </div>
    </div>
  );
}

// ── Copy helper ───────────────────────────────────────────────────────────────

function CopyButton({ text, label }) {
  const { t } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl transition-all
        ${copied ? "bg-green-600 text-white" : "bg-gray-900 hover:bg-gray-800 text-white"}`}
    >
      {copied ? <><Check className="w-3 h-3" />{t("copied")}</> : <><Copy className="w-3 h-3" />{label ?? t("copy")}</>}
    </button>
  );
}

// ── Referral CTA (redesign) ────────────────────────────────────────────────────
// UI only — copies the SAME existing referral link; the % is read live from the
// affiliate's referral commission rate (admin setting), never hardcoded.
function ReferralCta({ link, ratePct }) {
  const { t } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <div
      className="max-w-[900px] mx-auto w-full rounded-[24px] bg-[#fdf3e3] border border-amber-100/70 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 px-5 py-5 sm:px-8 sm:py-6"
    >
      <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
        {/* Gift */}
        <div className="w-16 h-16 rounded-2xl bg-white shadow-sm flex items-center justify-center text-3xl shrink-0">🎁</div>
        {/* Center */}
        <div className="flex-1 text-center sm:text-start min-w-0">
          <h3 className="text-base sm:text-lg font-black text-gray-900">{t("cta_title")}</h3>
          <p className="text-sm text-gray-600 mt-0.5">{t("cta_subtitle")}</p>
          <p className="text-xs sm:text-sm text-amber-700 font-bold mt-1.5">
            {t("cta_rate", { pct: ratePct })}
          </p>
        </div>
        {/* Copy button */}
        <button
          type="button"
          onClick={copy}
          disabled={!link}
          className={`w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-2 px-7 py-4 rounded-2xl font-black text-sm shadow-md active:scale-[0.97] transition-all disabled:opacity-60
            ${copied ? "bg-green-500 text-white" : "bg-amber-400 hover:bg-amber-500 text-gray-900"}`}
        >
          {copied ? <>{t("cta_copied")}</> : <><Copy className="w-4 h-4" /> {t("cta_copy")}</>}
        </button>
      </div>
    </div>
  );
}

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
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
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

// ── Product preview (Part 7 — multi-item inline summary) ──────────────────────

function productPreview(order, t) {
  const items = order.orderItems;
  if (!items || items.length === 0) return order.productTitle || '—';
  if (items.length === 1) {
    const { productName, quantity } = items[0];
    return quantity > 1 ? `${productName} ×${quantity}` : (productName || order.productTitle || '—');
  }
  const { productName, quantity } = items[0];
  const rest = items.length - 1;
  return t(rest > 1 ? 'preview_more_other' : 'preview_more_one', { name: productName, qty: quantity, n: rest });
}

// ── Phone formatter (+212XXXXXXXXX) ──────────────────────────────────────────

function formatPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('212')) return '+' + digits;
  if (digits.startsWith('0'))   return '+212' + digits.slice(1);
  return '+212' + digits;
}

// ── Order details modal — call-center style (Parts 2–5) ───────────────────────

function OrderDetailsModal({ order, onClose, onStatusChange, updatingOrder }) {
  const { t, lang } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  if (!order) return null;

  // shippingAddress shape: { name, phone, address: { city, address1 } }
  const shipping  = (order.shippingAddress && typeof order.shippingAddress === 'object')
    ? order.shippingAddress : {};
  const addrObj   = (shipping.address && typeof shipping.address === 'object')
    ? shipping.address : shipping;
  const phone     = formatPhone(order.clientPhone || shipping.phone);
  const waPhone   = phone?.replace('+', '') || null;
  const city      = addrObj.city  || addrObj.state  || null;
  const addrLine  = [addrObj.address1, addrObj.address2].filter(Boolean).join(', ') || null;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="text-sm font-bold text-gray-900">{t("order_details_title")}</h3>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              {order.orderId ? <bdi>{`#${order.orderId.slice(0, 8).toUpperCase()}`}</bdi> : t("order_unlinked")}
            </p>
          </div>
          <button onClick={onClose} aria-label={t("close")} title={t("close")} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
            <XCircle className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1">

          {/* Client info — Parts 2 & 3 */}
          <div className="px-5 py-4 border-b border-gray-100 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-0.5">
                <p className="text-sm font-bold text-gray-900">{order.clientName || '—'}</p>
                {city     && <p className="text-xs text-gray-500">📍 {city}</p>}
                {addrLine && <p className="text-xs text-gray-400">{addrLine}</p>}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <StatusBadge status={order.status} />
                <span className="text-[10px] text-gray-400">{fmtDate(order.createdAt, lang)}</span>
              </div>
            </div>

            {/* Phone + action buttons — Part 3 & 4 */}
            {phone && (
              <div className="flex items-center gap-2 flex-wrap">
                <span dir="ltr" className="text-xs font-mono text-gray-600 bg-gray-100 px-2.5 py-1 rounded-lg">
                  {phone}
                </span>
                <a
                  href={`tel:${phone}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors"
                >
                  {t("call")}
                </a>
                <a
                  href={`https://wa.me/${waPhone}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white text-xs font-semibold rounded-xl transition-colors"
                >
                  {t("whatsapp")}
                </a>
              </div>
            )}
          </div>

          {/* Products list */}
          <div className="px-5 pt-4 pb-2">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
              {t("products_heading")}
            </p>
            <div className="space-y-2">
              {order.orderItems && order.orderItems.length > 0 ? (
                order.orderItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 py-2.5 px-3 bg-gray-50 rounded-xl">
                    {item.productImage ? (
                      <img
                        src={item.productImage}
                        alt={item.productName}
                        className="w-12 h-12 rounded-xl object-cover shrink-0 border border-gray-200"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-xl bg-gray-200 flex items-center justify-center shrink-0">
                        <Package className="w-5 h-5 text-gray-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-800 leading-snug">{item.productName}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{t("item_line", { qty: item.quantity, price: fmtMoney(item.price, lang) })}</p>
                    </div>
                    <p className="text-sm font-bold text-gray-800 whitespace-nowrap shrink-0">
                      {fmtMoney(item.price * item.quantity, lang)}
                    </p>
                  </div>
                ))
              ) : (
                <div className="py-2.5 px-3 bg-gray-50 rounded-xl text-sm text-gray-700">
                  {order.productTitle || '—'}
                </div>
              )}
            </div>
          </div>

          {/* Totals */}
          <div className="px-5 py-4 border-t border-gray-100 mt-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-gray-900">{t("order_total")}</span>
              <span className="text-base font-black text-gray-900">{fmtMoney(order.total, lang)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">{t("affiliate_commission")}</span>
              <span className="text-sm font-bold text-green-700">{fmtMoney(order.commissionAmount, lang)}</span>
            </div>
          </div>
        </div>

        {/* ── Confirm / Cancel actions — Part 5 ── */}
        {onStatusChange && (order.status === 'pending' || order.status === 'shipped') && (
          <div className="px-5 py-4 border-t border-gray-100 flex gap-2 shrink-0">
            {order.status === 'pending' && (
              <button
                onClick={() => { onStatusChange(order.id, 'confirmed'); onClose(); }}
                disabled={updatingOrder === order.id}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
              >
                {updatingOrder === order.id ? '...' : t("confirm_btn")}
              </button>
            )}
            <button
              onClick={() => { onStatusChange(order.id, 'cancelled'); onClose(); }}
              disabled={updatingOrder === order.id}
              className="flex-1 py-2.5 bg-red-50 hover:bg-red-100 text-red-700 text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
            >
              {t("cancel_btn")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Avatar Upload Component ───────────────────────────────────────────────────

function AvatarUpload({ affiliate, authHeaders, onUpdate }) {
  const { t, lang } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const [uploading, setUploading] = useState(false);
  const [preview,   setPreview]   = useState(null);
  const inputRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Local preview
    const reader = new FileReader();
    reader.onload = (ev) => setPreview(ev.target.result);
    reader.readAsDataURL(file);

    // Upload
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res  = await fetch("/api/affiliate/avatar", {
        method:  "POST",
        headers: authHeaders(),
        body:    form,
      });
      const json = await res.json();
      if (!res.ok) { alert(json.error ? localizeServerError(json, lang) : t("upload_error")); setPreview(null); return; }
      onUpdate(json.affiliate);
    } catch { alert(t("network_error")); setPreview(null); }
    finally  { setUploading(false); }
  };

  const current = preview || affiliate?.avatarUrl;

  return (
    <div className="flex items-center gap-5">
      {/* Avatar preview */}
      <div className="relative w-20 h-20 rounded-2xl overflow-hidden bg-gray-100 flex-shrink-0 border border-gray-200">
        {current ? (
          <img src={current} alt={t("profile_photo")} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-900">
            <Users className="w-8 h-8 text-white" />
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-white animate-spin" />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="px-4 py-2 text-sm font-semibold bg-gray-900 text-white rounded-xl hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          {uploading ? t("uploading") : t("change_photo")}
        </button>
        <p className="text-xs text-gray-400">{t("avatar_hint")}</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFile}
        />
      </div>
    </div>
  );
}

// ── Demo Competition: Top Members + Top Brands ────────────────────────────────
// The approved design of the Store Homepage sections, moved here (they are no longer shown on the
// homepage): the SAME components — DemoCompetitionBlock (one banner with the simulation disclaimer;
// stacked on phones, side by side from lg) holding HomeTopMembers + HomeTopBrands (compact rows,
// live polling only while in view, Top-3 flame, a row opens /top-members/[id] or /top-brands/[id],
// "Voir tout" → the full pages). Same APIs (/api/demo-competition/members|brands), same ranking.
// SIMULATION ONLY — rolling 30-day ranking, no monthly cycle; see docs/demo-competition.md.
// The sections follow the DASHBOARD language (the affiliate's market language, AR or FR —
// useMarketLocale), never the storefront language chosen elsewhere.
// Admin settings (shown / hidden, title, number of rows, "Voir tout"): the SAME saved sections the admin edits
// (Setting homepage_layout — Homepage Builder or /admin/demo-competition/homepage), read through the
// existing public settings endpoint; an empty title = the default title in the dashboard language.

function CompetitionTab({ lang }) {
  const [layout, setLayout] = useState(undefined); // undefined = loading; [] = none / unreadable (defaults)
  useEffect(() => {
    let alive = true;
    fetch("/api/setting?type=homepage_layout", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => { if (alive) setLayout(Array.isArray(d?.sections) ? d.sections : []); })
      .catch(() => { if (alive) setLayout([]); });
    return () => { alive = false; };
  }, []);
  if (layout === undefined) return null; // never show default rows / titles first, then the admin's
  const members = dashboardSectionData(layout, "top_members");
  const brands = dashboardSectionData(layout, "top_brands");
  const count = (members.visible ? 1 : 0) + (brands.visible ? 1 : 0);
  if (!count) return null; // both hidden by the admin ("Masquer")
  return (
    <DemoCompetitionBlock count={count} lang={lang}>
      {members.visible && <HomeTopMembers lang={lang} sectionId="dashboard_top_members" data={members} />}
      {brands.visible && <HomeTopBrands lang={lang} sectionId="dashboard_top_brands" data={brands} />}
    </DemoCompetitionBlock>
  );
}

// ── Identity Verification card (Settings) ─────────────────────────────────────
const CIN_ACCEPT = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const CIN_MAX = 5 * 1024 * 1024;

function CinField({ label, side, file, preview, onPick, onClear, disabled }) {
  const { t } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const inputId = `cin-${side}`;
  return (
    <div>
      <p className="text-xs font-semibold text-gray-600 mb-1.5">{label}</p>
      {preview ? (
        <div className="relative border border-gray-200 rounded-xl overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={label} className="w-full h-40 object-contain bg-gray-100" />
          {!disabled && (
            <button type="button" onClick={onClear} aria-label={t("remove_image")} title={t("remove_image")}
              className="absolute top-2 end-2 bg-white/90 hover:bg-white p-1.5 rounded-lg text-red-600 shadow">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ) : (
        <label htmlFor={inputId}
          className={`flex flex-col items-center justify-center h-40 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${disabled ? "opacity-50 pointer-events-none" : "border-gray-200 hover:border-indigo-300 bg-gray-50"}`}>
          <Upload className="w-5 h-5 text-gray-400 mb-1" />
          <span className="text-xs text-gray-500">{t("cin_hint")}</span>
        </label>
      )}
      <input id={inputId} type="file" accept={CIN_ACCEPT.join(",")} className="hidden" disabled={disabled}
        onChange={(e) => onPick(e.target.files?.[0] || null)} />
    </div>
  );
}

function IdentityVerificationCard({ token, status, identity, onDone }) {
  const { t, lang } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const [front, setFront]       = useState(null);
  const [back, setBack]         = useState(null);
  const [frontPrev, setFrontPrev] = useState(null);
  const [backPrev, setBackPrev]   = useState(null);
  const [err, setErr]           = useState(null); // { key } (dictionary) or { text } (server message)
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);

  const locked = status === "APPROVED";
  const ui = IDENTITY_UI[status] || IDENTITY_UI.NOT_SUBMITTED;

  const validate = (f) => {
    if (!f) return null;
    if (!CIN_ACCEPT.includes(f.type)) return { key: "cin_bad_format" };
    if (f.size > CIN_MAX) return { key: "cin_too_big" };
    return null;
  };
  const pick = (which) => (f) => {
    const v = validate(f);
    if (v) { setErr(v); return; }
    setErr(null);
    const prev = f ? URL.createObjectURL(f) : null;
    if (which === "front") { setFront(f); setFrontPrev(prev); }
    else { setBack(f); setBackPrev(prev); }
  };
  const clear = (which) => () => {
    if (which === "front") { setFront(null); setFrontPrev(null); }
    else { setBack(null); setBackPrev(null); }
  };

  const submit = () => {
    if (!front || !back || submitting) return; // require both + prevent double submit
    setSubmitting(true); setErr(null); setProgress(0);
    const fd = new FormData();
    fd.append("front", front);
    fd.append("back", back);
    // XHR for real upload progress (fetch can't report upload progress).
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/affiliate/identity");
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      setSubmitting(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        setFront(null); setBack(null); setFrontPrev(null); setBackPrev(null); setProgress(0);
        onDone?.();
      } else {
        let m = { key: "send_failed" };
        try { const b = JSON.parse(xhr.responseText); if (b?.error) m = { text: b.error, code: b.code }; } catch {}
        setErr(m);
      }
    };
    xhr.onerror = () => { setSubmitting(false); setErr({ key: "network_error" }); };
    xhr.send(fd);
  };

  return (
    <Section title={t("identity_title")} icon={ShieldCheck}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold"
            style={{ color: ui.color, background: ui.bg }}>
            <span>{ui.emoji}</span> {t(ui.labelKey)}
          </span>
        </div>

        <p className="text-xs text-gray-500">
          {t("identity_intro")}
        </p>

        {status === "APPROVED" ? (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3">
            {identity?.approvedAt
              ? t("identity_approved_on", { date: fmtDate(identity.approvedAt, lang) })
              : t("identity_approved_nodate")}
          </div>
        ) : status === "PENDING" ? (
          <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3">
            {t("identity_pending_msg")}
          </div>
        ) : (
          <>
            {status === "REJECTED" && identity?.rejectionReason && (
              <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3">
                {t("identity_rejected_msg", { reason: identity.rejectionReason })}
              </div>
            )}
            {err && <div className="rounded-lg bg-red-50 text-red-700 text-xs px-3 py-2">{err.key ? t(err.key) : localizeServerError(err, lang)}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <CinField label={t("cin_front")} side="front" file={front} preview={frontPrev} onPick={pick("front")} onClear={clear("front")} disabled={locked || submitting} />
              <CinField label={t("cin_back")} side="back" file={back} preview={backPrev} onPick={pick("back")} onClear={clear("back")} disabled={locked || submitting} />
            </div>

            {submitting && (
              <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={!front || !back || submitting}
              className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 hover:bg-black text-white rounded-xl text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {submitting ? t("sending_progress", { n: progress }) : t("send_for_verification")}
            </button>
          </>
        )}
      </div>
    </Section>
  );
}

const SUPPORT_TOPIC_KEYS = [
  "support_topic_orders", "support_topic_commissions", "support_topic_payouts", "support_topic_identity",
  "support_topic_ugc", "support_topic_competition", "support_topic_tech",
];

function WhatsappSupportCard({ link }) {
  const { t } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  return (
    <Section title={t("support_title")} icon={MessageCircle}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">{t("support_intro")}</p>
        <ul className="text-xs text-gray-600 grid grid-cols-2 gap-1.5">
          {SUPPORT_TOPIC_KEYS.map((k) => (
            <li key={k} className="flex items-center gap-1.5"><span className="text-green-500">•</span>{t(k)}</li>
          ))}
        </ul>
        <a href={link} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-semibold">
          <MessageCircle className="w-4 h-4" /> {t("support_contact")}
        </a>
      </div>
    </Section>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function AffiliateDashboard() {
  const router = useRouter();
  // Market language (🇲🇦 → Arabic RTL, 🇫🇷 → French LTR) — the existing site language.
  const { lang, t, intlLocale } = useMarketLocale(AFFILIATE_DASHBOARD_TEXT);
  const money = (n, opts) => fmtMoney(n, lang, opts);
  const date = (iso) => fmtDate(iso, lang);
  // Feedback messages are kept as { key, vars } (dictionary — re-rendered in the
  // current language) or { text, code } (server message, localized at display time:
  // known server templates → market language, anything else as sent).
  const msgText = (m) => {
    if (!m) return null;
    if (!m.key) return localizeServerError(m, lang);
    const vars = m.vars && m.vars.amount != null ? { ...m.vars, amount: money(m.vars.amount) } : m.vars;
    return t(m.key, vars);
  };

  const [affiliateId, setAffiliateId] = useState(null);
  const [token,       setToken]       = useState(null);

  const [data,       setData]       = useState(null);  // { affiliate, stats, gamification, team, bonusConfig }
  // UGC totals come ONLY from the UGC ledger, computed server-side in the configured
  // business timezone (never browser-local) and scoped to the authenticated affiliate.
  const [ugcStats,   setUgcStats]   = useState(null);  // { todayEarnings, todaySales, totalEarnings, totalSales }
  const [orders,     setOrders]     = useState([]);
  const [notifs,     setNotifs]     = useState([]);
  const [claiming,   setClaiming]   = useState(false);
  const [claimMsg,   setClaimMsg]   = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);  // dictionary key

  // WhatsApp support config (read once from platform settings — no polling).
  const [supportCfg, setSupportCfg] = useState(null);

  // ── Live feed (background polling) ─────────────────────────────────────────
  const [liveConnected, setLiveConnected] = useState(true); // false → last poll failed
  const [flashOrderIds, setFlashOrderIds] = useState(() => new Set()); // briefly highlight new rows
  const seenOrderIdsRef = useRef(new Set()); // monotonic — ids we've already surfaced
  const initialLoadedRef = useRef(false);    // first successful load done? (no sound before)
  const saleSoundRef = useRef(null);         // lazy Web Audio chime
  const flashTimerRef = useRef(null);

  const [activeTab,  setActiveTab]  = useState("overview");

  // Bank form state
  const [bankForm,      setBankForm]      = useState({ bankName: "", rib: "", accountName: "" });
  const [bankSaving,    setBankSaving]    = useState(false);
  const [bankSuccess,   setBankSuccess]   = useState(false);
  const [bankError,     setBankError]     = useState(null);

  // Payout state
  const [payoutAmount,  setPayoutAmount]  = useState("");
  const [payoutLoading, setPayoutLoading] = useState(false);
  const [payoutMsg,     setPayoutMsg]     = useState(null);

  // Booster purchases (merged into the existing balance history — no new page)
  // + the active-booster widget shown on the overview. One read, no polling.
  const [boosterPurchases, setBoosterPurchases] = useState([]);
  const [activeBoosters, setActiveBoosters] = useState([]);
  useEffect(() => {
    if (activeTab !== "payout" && activeTab !== "overview") return;
    const tk = localStorage.getItem("affiliateToken") || "";
    fetch("/api/affiliate/boosters", { headers: { Authorization: `Bearer ${tk}` }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setBoosterPurchases(Array.isArray(d?.purchases) ? d.purchases : []);
        setActiveBoosters(Array.isArray(d?.active) ? d.active : []);
      })
      .catch(() => {});
  }, [activeTab]);

  // Order status update
  const [updatingOrder, setUpdatingOrder] = useState(null);
  // Feedback when the server refuses a status change (404 not yours / 409 locked).
  const [orderNotice, setOrderNotice] = useState(null);
  const orderNoticeTimer = useRef(null);
  const showOrderNotice = (message) => {
    clearTimeout(orderNoticeTimer.current);
    setOrderNotice(message);
    orderNoticeTimer.current = setTimeout(() => setOrderNotice(null), 6000);
  };

  // Order details modal
  const [detailsOrder,  setDetailsOrder]  = useState(null);

  // Store bank info (for payout tab)
  const [storeBankInfo, setStoreBankInfo] = useState(null);

  // Team expand / lazy sub-team + orders
  const [expandedMembers,    setExpandedMembers]    = useState(new Set());
  const [expandedTab,        setExpandedTab]        = useState({});     // memberId → 'orders'|'team'
  const [subTeamCache,       setSubTeamCache]       = useState({});     // memberId → member[]
  const [subTeamLoading,     setSubTeamLoading]     = useState(new Set());
  const [memberOrdersCache,  setMemberOrdersCache]  = useState({});     // memberId → order[]
  const [memberOrdersLoading,setMemberOrdersLoading]= useState(new Set());

  // ── Bootstrap ────────────────────────────────────────────────────────────
  useEffect(() => {
    const tok = localStorage.getItem("affiliateToken");
    const id  = localStorage.getItem("affiliateId");
    if (!tok || !id) {
      router.replace("/affiliate/login");
      return;
    }
    setToken(tok);
    setAffiliateId(id);
  }, [router]);

  // ── Fetch all data ────────────────────────────────────────────────────────
  // fetchAll(tok, { silent }) — `silent` is a BACKGROUND poll: no spinner, no
  // error banner (a transient failure just flips the live indicator and retries
  // next cycle), and it never clobbers the in-progress bank form. Wallet /
  // commission / counters / orders / notifications all refresh from the same
  // response, so a status change made in admin shows up automatically.
  const fetchAll = useCallback(async (tok, { silent = false } = {}) => {
    if (!tok) return;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tok}` };
      const [meRes, ordersRes, notifsRes, ugcRes] = await Promise.all([
        fetch("/api/affiliate/me",            { headers }),
        fetch("/api/affiliate/orders",        { headers }),
        fetch("/api/affiliate/notifications", { headers }),
        // UGC totals only — business-timezone day boundary is applied server-side.
        fetch("/api/affiliate/ugc/live",      { headers, cache: "no-store" }),
      ]);

      if (meRes.status === 401) {
        // A newer token was stored meanwhile (e.g. the password change in this tab): use it.
        const stored = localStorage.getItem("affiliateToken");
        if (stored && stored !== tok) { setToken(stored); return; }
        localStorage.removeItem("affiliateToken");
        router.replace("/affiliate/login");
        return;
      }

      const [meData, ordersData, notifsData] = await Promise.all([
        meRes.json(),
        ordersRes.ok ? ordersRes.json() : [],
        notifsRes.ok ? notifsRes.json() : [],
      ]);

      const ordersArr = Array.isArray(ordersData) ? ordersData : [];

      // ── Detect genuinely NEW orders since the last poll ──────────────────
      // Sound + highlight fire ONCE per new order: driven by a monotonic
      // seen-id set (a ref, so re-renders never replay it) and suppressed on
      // the very first load (which would otherwise beep for all history).
      const { newItems, seen } = diffNewItems(seenOrderIdsRef.current, ordersArr);
      const initial = !initialLoadedRef.current;
      seenOrderIdsRef.current = seen;
      if (shouldPlaySaleSound({ initial, newCount: newItems.length })) {
        saleSoundRef.current?.play();
        const ids = new Set(newItems.map((o) => String(o._id ?? o.id)));
        setFlashOrderIds(ids);
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashOrderIds(new Set()), 6000);
      }
      initialLoadedRef.current = true;

      setData(meData);
      setOrders(ordersArr);
      setNotifs(Array.isArray(notifsData) ? notifsData : []);
      setUgcStats(ugcRes.ok ? await ugcRes.json().catch(() => null) : null);
      setLiveConnected(true);

      // Pre-fill bank form ONLY on a foreground load — never overwrite what the
      // affiliate is currently typing during a silent background poll.
      if (!silent && meData?.affiliate) {
        setBankForm({
          bankName:    meData.affiliate.bankName    || "",
          rib:         meData.affiliate.rib         || "",
          accountName: meData.affiliate.accountName || "",
        });
      }
    } catch {
      if (silent) setLiveConnected(false);       // will reconnect on the next tick
      else setError("load_error");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [router]);

  useEffect(() => { if (token) fetchAll(token); }, [token, fetchAll]);

  // ── Live background polling + safe reconnect + audio unlock ────────────────
  // Self-scheduling loop (setTimeout, NOT setInterval): the next poll is armed
  // only AFTER the previous one settles, so requests can never overlap and a
  // slow server naturally backs off. Paused while the tab is hidden; resumes
  // instantly (with an immediate catch-up fetch) when it becomes visible.
  useEffect(() => {
    if (!token) return;

    // Lazy-init the chime + unlock it on the first user gesture (autoplay policy).
    if (!saleSoundRef.current) saleSoundRef.current = createSaleSound();
    const unlock = () => saleSoundRef.current?.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    let stopped = false;
    let inFlight = false;
    let timer = null;
    const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const schedule = () => { timer = setTimeout(runPoll, LIVE_POLL_MS); };

    async function runPoll() {
      if (stopped || inFlight || isHidden()) return; // paused/guarded → visibility handler resumes
      inFlight = true;
      try { await fetchAll(token, { silent: true }); }
      catch { /* fetchAll already flips the live indicator; loop keeps going */ }
      finally { inFlight = false; }
      if (!stopped && !isHidden()) schedule(); // arm the next poll only after this one settles
    }

    schedule(); // first poll after one interval

    const onVisible = () => {
      if (stopped || isHidden()) return;
      clearTimeout(timer);   // avoid a double-scheduled poll
      runPoll();             // immediate catch-up; it re-arms the loop
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      clearTimeout(flashTimerRef.current);
    };
  }, [token, fetchAll]);

  // WhatsApp support config — read ONCE from platform settings (no polling).
  useEffect(() => {
    fetch("/api/setting?type=affiliate-support")
      .then((r) => r.json())
      .then((d) => setSupportCfg(d && typeof d === "object" ? d : null))
      .catch(() => setSupportCfg(null));
  }, []);

  // Fetch store bank settings (public — no auth needed)
  useEffect(() => {
    fetch("/api/setting?type=bank-settings")
      .then((r) => r.json())
      .then((data) => {
        if (data && (data.bankName || data.rib || data.accountName)) {
          setStoreBankInfo(data);
        }
      })
      .catch(() => {});
  }, []);

  // ── Logout ───────────────────────────────────────────────────────────────
  const handleLogout = () => {
    ["affiliateToken","affiliateId","affiliateUsername","affiliateName"].forEach((k) => {
      try { localStorage.removeItem(k); } catch {}
    });
    router.push("/affiliate/login");
  };

  // ── Card expand: toggle + default tab 'orders' + preload orders ──────────
  const handleExpandCard = useCallback(async (memberId) => {
    const willExpand = !expandedMembers.has(memberId);
    setExpandedMembers((prev) => {
      const next = new Set(prev);
      if (willExpand) next.add(memberId); else next.delete(memberId);
      return next;
    });
    if (!willExpand) return;

    // Set default tab on first open
    setExpandedTab((prev) => prev[memberId] ? prev : { ...prev, [memberId]: 'orders' });

    // Preload orders (guard dup requests)
    if (memberOrdersCache[memberId] !== undefined) return;
    let skip = false;
    setMemberOrdersLoading((prev) => {
      if (prev.has(memberId)) { skip = true; return prev; }
      return new Set(prev).add(memberId);
    });
    if (skip) return;
    try {
      const res = await fetch(`/api/affiliate/member-orders/${memberId}`, { headers: authHeaders() });
      const body = await res.json();
      setMemberOrdersCache((prev) => ({ ...prev, [memberId]: Array.isArray(body) ? body : [] }));
    } catch {
      setMemberOrdersCache((prev) => ({ ...prev, [memberId]: [] }));
    } finally {
      setMemberOrdersLoading((prev) => { const n = new Set(prev); n.delete(memberId); return n; });
    }
  }, [expandedMembers, memberOrdersCache]);

  // ── Tab switch: lazy-load whichever data source isn't cached yet ──────────
  const handleSwitchTab = useCallback(async (memberId, tab) => {
    setExpandedTab((prev) => ({ ...prev, [memberId]: tab }));

    if (tab === 'orders' && memberOrdersCache[memberId] === undefined) {
      let skip = false;
      setMemberOrdersLoading((prev) => {
        if (prev.has(memberId)) { skip = true; return prev; }
        return new Set(prev).add(memberId);
      });
      if (!skip) try {
        const res = await fetch(`/api/affiliate/member-orders/${memberId}`, { headers: authHeaders() });
        const body = await res.json();
        setMemberOrdersCache((prev) => ({ ...prev, [memberId]: Array.isArray(body) ? body : [] }));
      } catch {
        setMemberOrdersCache((prev) => ({ ...prev, [memberId]: [] }));
      } finally {
        setMemberOrdersLoading((prev) => { const n = new Set(prev); n.delete(memberId); return n; });
      }
    }

    if (tab === 'team' && subTeamCache[memberId] === undefined) {
      let skip = false;
      setSubTeamLoading((prev) => {
        if (prev.has(memberId)) { skip = true; return prev; }
        return new Set(prev).add(memberId);
      });
      if (!skip) try {
        const res = await fetch(`/api/affiliate/sub-team/${memberId}`, { headers: authHeaders() });
        const body = await res.json();
        setSubTeamCache((prev) => ({ ...prev, [memberId]: Array.isArray(body) ? body : [] }));
      } catch {
        setSubTeamCache((prev) => ({ ...prev, [memberId]: [] }));
      } finally {
        setSubTeamLoading((prev) => { const n = new Set(prev); n.delete(memberId); return n; });
      }
    }
  }, [memberOrdersCache, subTeamCache]);

  // ── Bank save ────────────────────────────────────────────────────────────
  const handleBankSave = async (e) => {
    e.preventDefault();
    setBankSaving(true);
    setBankError(null);
    setBankSuccess(false);
    try {
      const res = await fetch("/api/affiliate/me", {
        method:  "PUT",
        headers: authHeaders(),
        body:    JSON.stringify(bankForm),
      });
      const d = await res.json();
      if (res.ok) {
        setBankSuccess(true);
        setTimeout(() => setBankSuccess(false), 3000);
      } else {
        setBankError(d.error ? { text: d.error, code: d.code } : { key: "error" });
      }
    } catch {
      setBankError({ key: "network_error" });
    } finally {
      setBankSaving(false);
    }
  };

  // ── Payout request ───────────────────────────────────────────────────────
  const handlePayout = async (e) => {
    e.preventDefault();
    if (!payoutAmount || parseFloat(payoutAmount) <= 0) return;
    setPayoutLoading(true);
    setPayoutMsg(null);
    try {
      const res = await fetch("/api/affiliate/payout", {
        method:  "POST",
        headers: authHeaders(),
        body:    JSON.stringify({ amount: parseFloat(payoutAmount) }),
      });
      const d = await res.json();
      if (res.ok) {
        setPayoutMsg({ type: "success", key: "payout_success" });
        setPayoutAmount("");
        fetchAll(token);
      } else {
        setPayoutMsg(d.error ? { type: "error", text: d.error, code: d.code } : { type: "error", key: "error" });
      }
    } catch {
      setPayoutMsg({ type: "error", key: "network_error" });
    } finally {
      setPayoutLoading(false);
    }
  };

  // ── Order status update ──────────────────────────────────────────────────
  const handleOrderStatus = async (orderId, status) => {
    setUpdatingOrder(orderId);
    try {
      const res = await fetch("/api/affiliate/orders", {
        method:  "PUT",
        headers: authHeaders(),
        body:    JSON.stringify({ id: orderId, status }),
      });
      if (res.ok) {
        setOrders((prev) => prev.map((o) => o.id === orderId ? { ...o, status } : o));
        setOrderNotice(null);
      } else {
        showOrderNotice(orderStatusErrorMessage(res.status, lang));
        // The list is stale (order delivered/cancelled meanwhile, or not ours): reload it.
        if (shouldRefreshOrdersAfter(res.status)) fetchAll(token, { silent: true });
      }
    } catch {
      showOrderNotice(orderStatusErrorMessage(0, lang));
    }
    setUpdatingOrder(null);
  };

  // ── Mark notifs read ─────────────────────────────────────────────────────
  const markNotifsRead = async () => {
    try {
      await fetch("/api/affiliate/notifications", {
        method:  "PUT",
        headers: authHeaders(),
      });
      setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {}
  };

  // ── Guard ────────────────────────────────────────────────────────────────
  if (!affiliateId || loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl border border-gray-100 p-8 max-w-sm w-full text-center space-y-4">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto" />
          <p className="text-gray-700 text-sm">{t(error)}</p>
          <button onClick={() => fetchAll(token)} className="px-6 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold">
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  const affiliate  = data?.affiliate;
  const stats      = data?.stats;
  const gami       = data?.gamification;
  const team       = data?.team || [];
  const bonusConfig = data?.bonusConfig ?? { requiredActiveAffiliates: 10, bonusAmount: 2000, commissionTiers: [] };
  const validReferrals = stats?.validReferrals ?? 0;
  const bonusGoal      = bonusConfig.requiredActiveAffiliates ?? 10;
  const bonusAmount    = bonusConfig.bonusAmount ?? 2000;
  const bonusProgress  = Math.min(100, Math.round((validReferrals / bonusGoal) * 100));
  const bonusUnlocked  = validReferrals >= bonusGoal;
  const bonusClaimed   = affiliate?.teamBonusClaimed ?? false;
  const refLink   = typeof window !== "undefined" ? `${window.location.origin}?ref=${affiliate?.username}` : "";
  const unread    = notifs.filter((n) => !n.read).length;
  const balance   = stats?.balance ?? 0;                       // ONE wallet total
  // Two server-side components: earnings (withdrawable) + top-up (spend-only).
  const withdrawable   = stats?.withdrawable ?? balance;
  const topupAvailable = stats?.topupAvailable ?? 0;
  // Reserved by pending/processing payout requests (already excluded from
  // `withdrawable` — shown for transparency, never subtracted twice).
  const pendingPayouts = stats?.pendingPayouts ?? 0;
  // Bank details must be complete before a withdrawal (mirrors the server rule:
  // non-empty bankName/accountName + RIB length 10–34). Server also re-validates.
  const _rib = String(affiliate?.rib ?? "").trim();
  const bankComplete = Boolean(
    String(affiliate?.bankName ?? "").trim() &&
    String(affiliate?.accountName ?? "").trim() &&
    _rib.length >= 10 && _rib.length <= 34
  );

  // Identity verification status (from /me — refreshed by the live poll, so the
  // progression + payout gate update automatically after submit/admin decision).
  const identity         = data?.identity || null;
  const identityStatus   = identity?.status || "NOT_SUBMITTED";
  const identityApproved = identityStatus === "APPROVED";
  const goToIdentity = () => { setActiveTab("settings"); setTimeout(() => {
    if (typeof document !== "undefined") document.getElementById("identity-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 60); };
  const goToUgc = () => setActiveTab("ugc");
  // Security deposit — SEPARATE from Solde disponible (never withdrawable).
  const deposit = data?.deposit || { approvedBalance: 0, pendingTotal: 0 };
  // Admin switch "Recharge de solde des Affiliés" (ON unless the server says false). OFF hides the
  // recharge widget, tab, menu entry and Booster shortcuts; the API refuses new requests anyway.
  // Balances (incl. the already-recharged one) are shown unchanged.
  const rechargeEnabled = deposit.rechargeEnabled !== false;
  const goToDeposit = rechargeEnabled ? () => setActiveTab("deposit") : null;

  // UGC progression (validated = admin-approved). Target from admin config (not
  // hardcoded); refreshed by the live poll like every other progression value.
  const ugcValidated = stats?.ugcValidated ?? 0;
  const ugcGoal      = bonusConfig?.ugcGoal || 5;

  // WhatsApp support link (null when disabled / no number → button hidden).
  const supportLink = resolveSupportLink(supportCfg, {
    username:    affiliate?.username,
    affiliateId: affiliate?.id,
  });

  // Phone-based order count — used to show repeat-client indicator
  const phoneCounts = orders.reduce((acc, o) => {
    if (o.clientPhone) acc[o.clientPhone] = (acc[o.clientPhone] || 0) + 1;
    return acc;
  }, {});

  // Total items across all orders (Part 5: each item quantity = 1 order unit)
  const totalItemsAll = orders.reduce((s, o) => s + (o.totalItems || 0), 0);

  // ── Tabs ─────────────────────────────────────────────────────────────────

  const tabs = [
    { id: "overview",      label: t("tab_overview") },
    { id: "orders",        label: t("tab_orders", { n: orders.length }) },
    { id: "bank",          label: t("tab_bank") },
    { id: "payout",        label: t("tab_payout") },
    { id: "deposit",       label: t("tab_deposit") },
    { id: "brand",         label: t("tab_brand") },
    { id: "rewards",       label: t("tab_rewards") },
    { id: "ugc",           label: t("tab_ugc") },
    { id: "notifications", label: unread > 0 ? t("tab_notifications_count", { n: unread }) : t("tab_notifications") },
    { id: "team",          label: t("tab_team", { n: team.length }) },
    { id: "settings",      label: t("tab_settings") },
  ];

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Top nav ── */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {/* Avatar */}
            <button
              onClick={() => setActiveTab("settings")}
              className="w-8 h-8 rounded-xl overflow-hidden flex-shrink-0 focus:outline-none"
              title={t("settings")}
              aria-label={t("settings")}
            >
              {affiliate?.avatarUrl ? (
                <img src={affiliate.avatarUrl} alt={t("profile_photo")}
                  className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                  <Users className="w-4 h-4 text-white" />
                </div>
              )}
            </button>
            <div className="hidden sm:block">
              <p className="text-sm font-bold text-gray-900 leading-none">{t("dashboard_title")}</p>
              <p className="text-xs text-gray-500"><bdi>@{affiliate?.username}</bdi></p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* WhatsApp quick support — shown only when enabled + configured */}
            {supportLink && (
              <a
                href={supportLink}
                target="_blank"
                rel="noopener noreferrer"
                title={t("support_title")}
                aria-label={t("support_title")}
                className="p-2 rounded-xl transition-colors text-green-600 hover:text-green-700 hover:bg-green-50"
              >
                <MessageCircle className="w-4 h-4" />
              </a>
            )}

            {/* Notifications bell */}
            <button
              onClick={() => { setActiveTab("notifications"); markNotifsRead(); }}
              title={t("notifications")}
              aria-label={t("notifications")}
              className="relative p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-xl transition-colors"
            >
              <Bell className="w-4 h-4" />
              {unread > 0 && (
                <span className="absolute -top-0.5 -end-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>

            {/* Live indicator — green pulse when the background feed is healthy,
                amber when the last poll failed (auto-reconnects next tick). */}
            <span
              title={liveConnected ? t("live_title") : t("reconnecting")}
              className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold"
              style={{ color: liveConnected ? "#059669" : "#b45309", background: liveConnected ? "#ecfdf5" : "#fffbeb" }}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${liveConnected ? "animate-pulse" : ""}`}
                style={{ background: liveConnected ? "#10b981" : "#f59e0b" }}
              />
              {liveConnected ? t("live_badge") : "…"}
            </span>

            {/* Refresh (manual fallback — always available) */}
            <button
              onClick={() => fetchAll(token)}
              title={t("refresh")}
              aria-label={t("refresh")}
              className="p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-xl transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            {/* Settings */}
            <button
              onClick={() => setActiveTab("settings")}
              className={`p-2 rounded-xl transition-colors ${
                activeTab === "settings"
                  ? "bg-gray-900 text-white"
                  : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"
              }`}
              title={t("settings")}
              aria-label={t("settings")}
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* Logout */}
            <button
              onClick={handleLogout}
              aria-label={t("logout")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-xl transition-colors font-semibold"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t("logout")}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5 space-y-5 pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-5">

        {/* ── Tab nav ── */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
          {tabs.filter((tb) => tb.id !== "deposit" || rechargeEnabled).map((tb) => (
            <button
              key={tb.id}
              onClick={() => setActiveTab(tb.id)}
              className={`whitespace-nowrap px-4 py-2 rounded-xl text-xs font-semibold transition-colors
                ${activeTab === tb.id
                  ? "bg-gray-900 text-white"
                  : "bg-white border border-gray-200 text-gray-600 hover:border-gray-400"}`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {/* ══ OVERVIEW ══════════════════════════════════════════════════════ */}
        {activeTab === "overview" && (
          <div className="space-y-5">

            {/* ── Loyalty / Progress Banner ── */}
            {affiliate && (
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl p-4 text-white"
                style={{ background: "linear-gradient(135deg, #0f5f52 0%, #1a7a69 60%, #0d4d43 100%)" }}>

                {/* Start side: greeting + reward */}
                <div className="flex items-center gap-3">
                  <span className="text-4xl select-none">🏆</span>
                  <div>
                    <p className="text-xs opacity-80">{t("greeting", { name: affiliate.name || affiliate.username })}</p>
                    <h3 className="text-sm font-bold md:text-base">
                      {t("earn_rate_headline", { pct: ((affiliate.commissionRate || 0) * 100).toFixed(0) })}
                    </h3>
                  </div>
                </div>

                {/* End side: progress bars */}
                <div className="flex w-full flex-col gap-2 self-start lg:w-auto lg:min-w-72">
                  <div className="flex items-center justify-between text-xs font-medium opacity-80">
                    <span>{t("your_progress")}</span>
                    <svg className="w-4 h-4 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.43 5.93L20.5 12l-6.07 6.07M3.5 12h16.83"/>
                    </svg>
                  </div>

                  {/* Orders progress */}
                  <div>
                    <p className="mb-1.5 text-xs font-bold">
                      {t("valid_referrals_progress", { frac: frac(stats?.validReferrals ?? 0, gami?.target || 5) })}
                    </p>
                    <div className="w-full overflow-hidden rounded-full h-2" style={{ background: "rgba(255,255,255,0.25)" }}>
                      <div className="h-full rounded-full bg-white transition-all duration-700"
                        style={{ width: `${gami?.progress || 0}%` }} />
                    </div>
                  </div>

                  {/* Orders objective — counts delivered orders only (same basis as commissions) */}
                  <div>
                    <p className="mb-1.5 text-xs font-bold">
                      {t("orders_progress", { frac: frac(affiliate?.deliveredOrdersCount ?? 0, affiliate?.goalOrders || 5) })}
                    </p>
                    <div className="w-full overflow-hidden rounded-full h-2" style={{ background: "rgba(255,255,255,0.25)" }}>
                      <div className="h-full rounded-full bg-white transition-all duration-700"
                        style={{ width: `${Math.min(100, ((affiliate?.deliveredOrdersCount ?? 0) / (affiliate?.goalOrders || 5)) * 100)}%` }} />
                    </div>
                  </div>

                  {/* UGC validated videos — click → UGC page. Only admin-approved
                      (APPROVED/RUNNING) videos count; pending/rejected excluded. */}
                  <button onClick={goToUgc} title={t("ugc_progress_title")} className="block w-full text-start">
                    <p className="mb-1.5 text-xs font-bold flex items-center justify-between gap-2">
                      <span>{t("ugc_progress", { frac: frac(ugcValidated, ugcGoal) })}</span>
                      <svg className="w-3.5 h-3.5 opacity-80 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                    </p>
                    <div className="w-full overflow-hidden rounded-full h-2" style={{ background: "rgba(255,255,255,0.25)" }}>
                      <div className="h-full rounded-full bg-white transition-all duration-700"
                        style={{ width: `${Math.min(100, (ugcValidated / Math.max(1, ugcGoal)) * 100)}%` }} />
                    </div>
                  </button>

                  {/* Identity verification condition — click → Paramètres → Vérification */}
                  <button
                    onClick={goToIdentity}
                    title={t("identity_title")}
                    className="mt-1 flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-start transition-colors"
                    style={{ background: "rgba(255,255,255,0.18)" }}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-bold">
                      <span>{IDENTITY_UI[identityStatus].emoji}</span>
                      <span>{t(IDENTITY_UI[identityStatus].labelKey)}</span>
                    </span>
                    <svg className="w-3.5 h-3.5 opacity-80 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                  </button>
                </div>
              </div>
            )}

            {/* ── BOUTIQUE (store / order) earnings — unchanged calculations ── */}
            <div className="flex items-center gap-2 px-0.5">
              <ShoppingBag className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-bold text-gray-700">{t("shop_heading")}</h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <StatCard icon={ShoppingBag} label={t("stat_shop_today")}    value={stats?.todaySales  ?? "—"} color="blue"   />
              <StatCard icon={CheckCircle} label={t("confirmed_plural")}   value={stats?.confirmed   ?? "—"} color="green"  />
              <StatCard icon={XCircle}     label={t("cancelled_plural")}   value={stats?.cancelled   ?? "—"} color="red"    />
              <StatCard icon={Truck}       label={t("status_shipped")}     value={stats?.shipping    ?? "—"} color="purple" />
              <StatCard icon={Package}     label={t("delivered_plural")}   value={stats?.delivered   ?? "—"} color="teal"   />
              <StatCard icon={TrendingUp}  label={t("stat_shop_revenue")}  value={money(stats?.totalRevenue)} color="amber" />
              <StatCard icon={DollarSign}  label={t("stat_shop_earnings")} value={money(stats?.totalCommission)} color="green"
                sub={t("stat_rate", { pct: ((affiliate?.commissionRate || 0) * 100).toFixed(0) })} />
              <StatCard icon={CreditCard}  label={t("stat_balance")}       value={money(balance)}                color="blue"   />
              {/* Tracking stats */}
              <StatCard icon={Eye}         label={t("stat_clicks")}        value={stats?.totalClicks ?? affiliate?.totalClicks ?? "—"} color="blue"   />
              <StatCard icon={ShoppingBag} label={t("stat_shop_sales")}    value={orders.length > 0 ? totalItemsAll : (stats?.totalOrders ?? affiliate?.totalOrders ?? "—")} color="teal" sub={t("stat_items_ordered")} />
              <StatCard icon={TrendingUp}  label={t("stat_conversion")}    value={stats?.conversionRate != null ? `${stats.conversionRate}%` : "—"} color="amber"
                sub={t("stat_conversion_sub")} />
              <StatCard icon={Users}       label={t("stat_team_commission")} value={money(stats?.teamCommission)} color="teal"
                sub={t(team.length !== 1 ? "members_other" : "members_one", { n: team.length })} />
            </div>

            {/* 🚀 Active Booster widget → opens the Booster page */}
            {activeBoosters.map((b) => (
              <button key={b.id} onClick={() => setActiveTab("booster")} className="w-full text-start">
                <div className="rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white p-4 hover:brightness-110 transition-all">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-black">🚀 {b.packageName}</span>
                    <span className="text-[11px] font-bold bg-white/15 rounded-full px-2 py-0.5">
                      {b.daysLeft != null ? t("booster_ends_in", { n: b.daysLeft }) : t("booster_active")}
                    </span>
                  </div>
                  {b.target ? (
                    <>
                      <div className="mt-3 h-2.5 rounded-full bg-white/20 overflow-hidden">
                        <div className="h-full rounded-full bg-white transition-all duration-700" style={{ width: `${b.percent ?? 0}%` }} />
                      </div>
                      <div className="flex items-center justify-between mt-1.5 text-xs font-black">
                        <span>{frac(b.sales, b.target)}</span>
                        <span>{b.percent ?? 0}%</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs opacity-80 mt-2">{t("booster_sales_since", { n: b.sales })}</p>
                  )}
                </div>
              </button>
            ))}

            {/* ── 💰 Dépôt de solde — balance top-up (credited after validation); hidden while the admin switch is OFF ── */}
            {rechargeEnabled && <button onClick={goToDeposit} className="w-full text-start">
              <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 flex items-center justify-between gap-3 hover:bg-indigo-50 transition-colors">
                <div>
                  <div className="flex items-center gap-2 text-indigo-700 text-xs font-semibold">
                    <Wallet className="w-4 h-4" /> {t("deposit_title")}
                  </div>
                  <p className="text-2xl font-black text-gray-900 mt-1">{money(deposit.approvedBalance)}</p>
                  {deposit.pendingTotal > 0 && (
                    <p className="text-[11px] font-semibold text-amber-600 mt-0.5">
                      {t("deposit_pending", { amount: money(deposit.pendingTotal) })}
                    </p>
                  )}
                  <p className="text-[10px] text-gray-400 mt-0.5">{t("deposit_hint")}</p>
                </div>
                <svg className="w-4 h-4 text-indigo-400 shrink-0 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
              </div>
            </button>}

            {/* ── UGC (simulated video sales) — separate source, never mixed ── */}
            <div className="flex items-center gap-2 px-0.5 pt-1">
              <Video className="w-4 h-4 text-violet-500" />
              <h2 className="text-sm font-bold text-gray-700">{t("ugc_heading")}</h2>
              <span className="px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-bold">UGC</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <StatCard icon={Wallet}      label={t("ugc_today_earnings")} value={money(ugcStats?.todayEarnings)} color="purple" sub="UGC" />
              <StatCard icon={Video}       label={t("ugc_today_sales")}    value={ugcStats?.todaySales ?? "—"}    color="purple" sub="UGC" />
              <StatCard icon={DollarSign}  label={t("ugc_total_earnings")} value={money(ugcStats?.totalEarnings)} color="purple" sub="UGC" />
              <StatCard icon={TrendingUp}  label={t("ugc_total_sales")}    value={ugcStats?.totalSales ?? "—"}    color="purple" sub="UGC" />
            </div>

            {/* 🔥 Live activity — same shared server-side Live Activity engine as
                the landing page (GET /api/live-activity). Placed below the stats. */}
            <LiveActivity windowSize={4} showViewAll />

            {/* 🏆 Demo Competition: Top Members + Top Brands (rolling 30 days), in the approved Store
                Homepage design — inline on the overview, where the competition block was. */}
            <CompetitionTab lang={lang} />

            {/* Referral CTA (kept directly below the competition) */}
            <ReferralCta link={refLink} ratePct={((affiliate?.commissionRate || 0) * 100).toFixed(0)} />

            {/* Last 5 orders */}
            {orders.length > 0 && (
              <Section title={t("last_orders")} icon={ShoppingBag}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        {["col_id","col_client","col_items","col_product","col_status","col_total","col_commission","col_date","col_view"].map((h) => (
                          <th key={h} className="text-start text-xs text-gray-500 font-semibold pb-2 pe-4 whitespace-nowrap">{t(h)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {orders.slice(0, 5).map((o) => (
                        <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                          <td className="py-2.5 pe-4 font-mono text-xs text-gray-400 whitespace-nowrap">
                            {o.orderId ? <bdi>{`#${o.orderId.slice(0, 8).toUpperCase()}`}</bdi> : "—"}
                          </td>
                          <td className="py-2.5 pe-4 text-gray-800 font-medium whitespace-nowrap">{o.clientName || "—"}</td>
                          <td className="py-2.5 pe-4 whitespace-nowrap">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
                              {o.totalItems > 0 ? o.totalItems : 1}
                            </span>
                          </td>
                          <td className="py-2.5 pe-4 text-gray-600 max-w-[150px] truncate text-xs">{productPreview(o, t)}</td>
                          <td className="py-2.5 pe-4"><StatusBadge status={o.status} /></td>
                          <td className="py-2.5 pe-4 font-semibold whitespace-nowrap">{money(o.total)}</td>
                          <td className="py-2.5 pe-4 text-green-700 font-semibold whitespace-nowrap">{money(o.commissionAmount)}</td>
                          <td className="py-2.5 pe-4 text-xs text-gray-400 whitespace-nowrap">{date(o.createdAt)}</td>
                          <td className="py-2.5">
                            <button
                              onClick={() => setDetailsOrder(o)}
                              className="px-2.5 py-1 bg-gray-100 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-200 transition-colors whitespace-nowrap"
                            >
                              {t("view")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {orders.length > 5 && (
                  <button onClick={() => setActiveTab("orders")} className="mt-3 text-xs text-blue-600 font-semibold hover:underline">
                    {t("view_all_orders")}
                  </button>
                )}
              </Section>
            )}

            {/* ── Recent payment proofs — the only slider, LAST section of the overview. One global feed
                (same proofs for every active affiliate); each proof stays for the display duration captured
                at its publication (admin setting, 72 h by default), server-side. ── */}
            <PaymentProofsSlider lang={lang} />
          </div>
        )}

        {/* ══ ORDERS ════════════════════════════════════════════════════════ */}
        {activeTab === "orders" && (
          <Section title={t("my_orders")} icon={ShoppingBag}>
            {orders.length === 0 ? (
              <div className="text-center py-10">
                <Package className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">{t("no_orders")}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {["col_id","col_client","col_order_count","col_items","col_product","col_status","col_total","col_commission","col_date","col_action"].map((h) => (
                        <th key={h} className="text-start text-xs text-gray-500 font-semibold pb-2.5 pe-4 whitespace-nowrap">{t(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {orders.map((o) => (
                      <tr
                        key={o.id}
                        className={`transition-colors ${flashOrderIds.has(String(o._id ?? o.id)) ? "bg-emerald-50 animate-pulse" : "hover:bg-gray-50"}`}
                      >
                        <td className="py-3 pe-4 font-mono text-xs text-gray-400 whitespace-nowrap">
                          {o.orderId ? <bdi>{`#${o.orderId.slice(0, 8).toUpperCase()}`}</bdi> : "—"}
                        </td>
                        <td className="py-3 pe-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-gray-800">{o.clientName || "—"}</span>
                            {o.isSuspicious && (
                              <span
                                title={o.suspicionReason || t("suspicious")}
                                className="text-amber-500 cursor-help"
                              >
                                <AlertTriangle className="w-3.5 h-3.5" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pe-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold ${(phoneCounts[o.clientPhone] || 1) > 1 ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                            {phoneCounts[o.clientPhone] || 1}
                          </span>
                        </td>
                        <td className="py-3 pe-4 whitespace-nowrap">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
                            {o.totalItems > 0 ? o.totalItems : 1}
                          </span>
                        </td>
                        <td className="py-3 pe-4 text-gray-600 max-w-[150px] truncate text-xs">{productPreview(o, t)}</td>
                        <td className="py-3 pe-4"><StatusBadge status={o.status} /></td>
                        <td className="py-3 pe-4 font-semibold whitespace-nowrap">{money(o.total)}</td>
                        <td className="py-3 pe-4 text-green-700 font-semibold whitespace-nowrap">{money(o.commissionAmount)}</td>
                        <td className="py-3 pe-4 text-xs text-gray-400 whitespace-nowrap">{date(o.createdAt)}</td>
                        <td className="py-3">
                          <div className="flex gap-1.5 flex-wrap">
                            {/* Voir — always visible (Part 4) */}
                            <button
                              onClick={() => setDetailsOrder(o)}
                              className="px-2.5 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-lg hover:bg-gray-200 transition-colors whitespace-nowrap"
                            >
                              {t("view")}
                            </button>
                            {/* Confirm / Cancel — Part 6: keep unchanged */}
                            {o.status === "pending" && (
                              <button
                                onClick={() => handleOrderStatus(o.id, "confirmed")}
                                disabled={updatingOrder === o.id}
                                className="px-2.5 py-1 bg-blue-50 text-blue-700 text-xs font-semibold rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-50 whitespace-nowrap"
                              >
                                {updatingOrder === o.id ? "..." : t("confirm")}
                              </button>
                            )}
                            {(o.status === "pending" || o.status === "shipped") && (
                              <button
                                onClick={() => handleOrderStatus(o.id, "cancelled")}
                                disabled={updatingOrder === o.id}
                                className="px-2.5 py-1 bg-red-50 text-red-700 text-xs font-semibold rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50 whitespace-nowrap"
                              >
                                {t("cancel")}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {/* ══ BANK ══════════════════════════════════════════════════════════ */}
        {activeTab === "bank" && (
          <Section title={t("bank_title")} icon={Building2}>
            <form onSubmit={handleBankSave} className="space-y-4 max-w-sm">

              {bankSuccess && (
                <div className="flex items-center gap-2 bg-green-50 border border-green-100 rounded-xl px-4 py-3 text-sm text-green-700">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  {t("bank_saved")}
                </div>
              )}
              {bankError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {msgText(bankError)}
                </div>
              )}

              {[
                { key: "bankName",    label: t("bank_name"),      placeholder: "\u2066CIH, Attijariwafa, BMCE...\u2069" }, // isolated: keeps its LTR order in an RTL field
                { key: "rib",         label: t("rib"),            placeholder: "XXXXXXXXXXXXXXXXXXXXXXXXXX" },
                { key: "accountName", label: t("account_holder"), placeholder: t("account_holder_ph") },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">{label}</label>
                  <input
                    type="text"
                    value={bankForm[key]}
                    onChange={(e) => setBankForm((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    dir={fieldDir(bankForm[key])}
                    data-bank-input={key}
                  />
                </div>
              ))}

              <button
                type="submit"
                disabled={bankSaving}
                className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
              >
                {bankSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {bankSaving ? t("saving") : t("save")}
              </button>
            </form>
          </Section>
        )}

        {/* ══ PAYOUT ════════════════════════════════════════════════════════ */}
        {activeTab === "payout" && (
          <div className="space-y-4">
            {/* ONE wallet total + its breakdown (earnings vs recharged) */}
            <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-6 text-white">
              <p className="text-sm font-medium opacity-70 mb-1">{t("total_balance")}</p>
              <p className="text-4xl font-black">{money(balance)}</p>
              {(topupAvailable > 0 || pendingPayouts > 0) ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-4">
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <p className="text-[11px] opacity-70">{t("withdrawable_earnings")}</p>
                    <p className="text-base font-black">{money(withdrawable)}</p>
                  </div>
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <p className="text-[11px] opacity-70">{t("pending_payment_amount")}</p>
                    <p className="text-base font-black">{money(pendingPayouts)}</p>
                    <p className="text-[10px] opacity-50 mt-0.5">{t("already_reserved")}</p>
                  </div>
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <p className="text-[11px] opacity-70">{t("topup_non_withdrawable")}</p>
                    <p className="text-base font-black">{money(topupAvailable)}</p>
                    <p className="text-[10px] opacity-50 mt-0.5">{t("purchases_only")}</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs opacity-50 mt-2">{t("delivered_commissions")}</p>
              )}
            </div>

            {/* Request form */}
            <Section title={t("payout_request_title")} icon={CreditCard}>
              <form onSubmit={handlePayout} className="space-y-4 max-w-sm">
                {payoutMsg && (
                  <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium
                    ${payoutMsg.type === "success"
                      ? "bg-green-50 border border-green-100 text-green-700"
                      : "bg-red-50 border border-red-100 text-red-700"}`}>
                    {payoutMsg.type === "success" ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                    {msgText(payoutMsg)}
                  </div>
                )}
                {!identityApproved && (
                  <div className="rounded-xl px-4 py-3 bg-red-50 border border-red-200 text-red-800 text-sm">
                    <p className="flex items-start gap-2">
                      <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                      {t("identity_required_payout")}
                    </p>
                    <button type="button" onClick={goToIdentity}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg">
                      <ShieldCheck className="w-3.5 h-3.5" /> {t("verify_now")}
                    </button>
                  </div>
                )}
                {!bankComplete && (
                  <div className="rounded-xl px-4 py-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm">
                    <p className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      {t("bank_required_payout")}
                    </p>
                    <button type="button" onClick={() => setActiveTab("bank")}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg">
                      <Building2 className="w-3.5 h-3.5" /> {t("complete_bank")}
                    </button>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                    {t("payout_amount_label")}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={withdrawable}
                    step="0.01"
                    value={payoutAmount}
                    onChange={(e) => setPayoutAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    dir="ltr"
                  />
                  {/* Only EARNINGS are withdrawable — the recharged balance is
                      spend-only (also enforced server-side). */}
                  <p className="text-xs text-gray-400 mt-1">
                    {t("max_withdrawable")} <strong>{money(withdrawable)}</strong>
                  </p>
                  {pendingPayouts > 0 && (
                    <p className="text-[11px] text-gray-500 mt-1">
                      {t("reserved_by_pending", { amount: money(pendingPayouts) })}
                    </p>
                  )}
                  {topupAvailable > 0 && (
                    <p className="text-[11px] text-amber-600 mt-1">
                      {t("topup_not_withdrawable_note", { amount: money(topupAvailable) })}
                    </p>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!identityApproved || !bankComplete || payoutLoading || !payoutAmount || parseFloat(payoutAmount) <= 0 || parseFloat(payoutAmount) > withdrawable}
                  className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 hover:bg-gray-800 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-all"
                >
                  {payoutLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                  {payoutLoading ? t("sending") : t("request_payout")}
                </button>
              </form>
            </Section>

            {/* Balance history — payouts + Starter Booster purchases, one merged
                list (the boosters reuse THIS history; no separate page). */}
            {((stats?.payouts?.length || 0) + boosterPurchases.length) > 0 && (
              <Section title={t("balance_history")} icon={TrendingUp}>
                <div className="space-y-2">
                  {[
                    ...(stats?.payouts || []).map((p) => ({ kind: "payout", ...p })),
                    ...boosterPurchases.map((b) => ({ kind: "booster", ...b })),
                  ]
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .map((x) => x.kind === "payout" ? (
                      <div key={`p-${x.id}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{t("payout_line", { amount: money(x.amount) })}</p>
                          <p className="text-xs text-gray-400">{date(x.createdAt)}</p>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold
                          ${x.status === "paid" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                          {x.status === "paid" ? t("paid") : t("status_pending")}
                        </span>
                      </div>
                    ) : (
                      <div key={`b-${x.id}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-gray-800">🚀 {x.packageName} · {money(x.price, { sign: "−" })}</p>
                          <p className="text-xs text-gray-400">
                            {x.paymentMethod === "BALANCE" ? t("paid_with_balance") : t("paid_by_card")} · {date(x.createdAt)}
                          </p>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold
                          ${x.status === "ACTIVE" ? "bg-green-100 text-green-700" : x.status === "REJECTED" ? "bg-red-100 text-red-600" : "bg-yellow-100 text-yellow-700"}`}>
                          {x.status === "ACTIVE" ? t("active") : x.status === "REJECTED" ? t("rejected") : t("status_pending")}
                        </span>
                      </div>
                    ))}
                </div>
              </Section>
            )}

            {/* Store bank info for payouts */}
            {storeBankInfo && (storeBankInfo.bankName || storeBankInfo.rib) && (
              <Section title={t("payment_bank_info")} icon={Building2}>
                <p className="text-xs text-gray-400 mb-3">
                  {t("payment_bank_note")}
                </p>
                <div className="bg-gray-50 rounded-xl border border-gray-100 divide-y divide-gray-100">
                  {storeBankInfo.bankLogo && (
                    <div className="px-4 py-3 flex items-center gap-3">
                      <img
                        src={storeBankInfo.bankLogo}
                        alt={storeBankInfo.bankName}
                        className="h-8 w-auto object-contain"
                      />
                    </div>
                  )}
                  {[
                    { id: "bank",   label: t("bank_label"),   value: storeBankInfo.bankName    },
                    { id: "holder", label: t("holder_label"), value: storeBankInfo.accountName },
                    { id: "rib",    label: t("rib"),          value: storeBankInfo.rib,    mono: true },
                    { id: "swift",  label: t("swift"),        value: storeBankInfo.swift,  mono: true },
                  ].map(({ id, label, value, mono }) =>
                    value ? (
                      <div key={id} className="flex items-center justify-between px-4 py-2.5">
                        <span className="text-xs text-gray-400 font-medium">{label}</span>
                        <span dir={mono ? "ltr" : undefined} className={`text-sm font-semibold text-gray-800 text-end max-w-[200px] break-all ${mono ? "font-mono text-xs" : ""}`}>
                          {value}
                        </span>
                      </div>
                    ) : null
                  )}
                </div>
              </Section>
            )}
          </div>
        )}

        {/* ══ NOTIFICATIONS ═════════════════════════════════════════════════ */}
        {activeTab === "notifications" && (
          <Section title={t("notifications")} icon={Bell}>
            {notifs.length === 0 ? (
              <div className="text-center py-10">
                <Bell className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">{t("no_notifications")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {notifs.map((n) => (
                  <div
                    key={n.id}
                    className={`flex items-start gap-3 p-3.5 rounded-xl transition-colors
                      ${n.read ? "bg-gray-50" : "bg-blue-50 border border-blue-100"}`}
                  >
                    <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.read ? "bg-gray-300" : "bg-blue-500"}`} />
                    <div className="flex-1 min-w-0">
                      {/* Stored text from the server templates, re-rendered in the market language (unknown text as stored). */}
                      <p className={`text-sm whitespace-pre-line ${n.read ? "text-gray-600" : "text-gray-800 font-medium"}`} data-notification-message>
                        {localizeNotification(n.message, lang)}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{date(n.createdAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {/* ══ TEAM ══════════════════════════════════════════════════════════ */}
        {activeTab === "team" && (() => {
          const handleClaimBonus = async () => {
            setClaiming(true);
            setClaimMsg(null);
            try {
              const res = await fetch("/api/affiliate/claim-bonus", {
                method: "POST",
                headers: authHeaders(),
              });
              const d = await res.json();
              if (res.ok) {
                setClaimMsg({ type: "success", key: "claim_success", vars: { amount: d.bonus } });
                fetchAll(token);
              } else {
                setClaimMsg(d.error ? { type: "error", text: d.error, code: d.code } : { type: "error", key: "error" });
              }
            } catch { setClaimMsg({ type: "error", key: "network_error" }); }
            finally { setClaiming(false); }
          };
          return (
          <div className="space-y-4">

            {/* ── GOLD BONUS SECTION ── */}
            <div className={`relative overflow-hidden rounded-2xl p-5
              ${bonusClaimed
                ? "bg-gradient-to-br from-gray-100 to-gray-200 border border-gray-200"
                : bonusUnlocked
                  ? "bg-gradient-to-br from-amber-400 via-yellow-400 to-amber-500 border border-amber-300 shadow-lg shadow-amber-100"
                  : "bg-gradient-to-br from-amber-900 via-yellow-900 to-amber-800 border border-amber-700"
              }`}>

              {/* Shine overlay */}
              {!bonusClaimed && (
                <div className="absolute inset-0 opacity-10"
                  style={{ background: "linear-gradient(135deg, white 0%, transparent 50%, white 100%)" }} />
              )}

              <div className="relative">
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🏆</span>
                    <div>
                      <p className={`text-sm font-black ${bonusClaimed ? "text-gray-500" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>
                        {t("team_bonus")}
                      </p>
                      <p className={`text-xs font-semibold ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                        {bonusClaimed
                          ? t("bonus_already_claimed")
                          : t("bonus_earn", { amount: money(bonusAmount), n: bonusGoal })}
                      </p>
                    </div>
                  </div>
                  <div className={`text-end px-3 py-1.5 rounded-xl ${bonusClaimed ? "bg-gray-200" : bonusUnlocked ? "bg-amber-900/20" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-gray-500" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>
                      {bonusAmount} <span className="text-sm font-semibold">{t("currency")}</span>
                    </p>
                  </div>
                </div>

                {/* Counters */}
                <div className="flex gap-2 mb-3">
                  <div className={`flex-1 rounded-xl p-2.5 text-center ${bonusClaimed ? "bg-gray-200/60" : bonusUnlocked ? "bg-amber-900/15" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-gray-500" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>{stats?.totalReferrals ?? team.length}</p>
                    <p className={`text-xs ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                      {t("total_referred")}
                    </p>
                  </div>
                  <div className={`flex-1 rounded-xl p-2.5 text-center ${bonusClaimed ? "bg-green-100" : bonusUnlocked ? "bg-amber-900/15" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-green-600" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>{validReferrals}</p>
                    <p className={`text-xs ${bonusClaimed ? "text-green-500" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                      {t("actives")}
                    </p>
                  </div>
                  <div className={`flex-1 rounded-xl p-2.5 text-center ${bonusClaimed ? "bg-gray-200/60" : bonusUnlocked ? "bg-amber-900/15" : "bg-amber-950/40"}`}>
                    <p className={`text-xl font-black ${bonusClaimed ? "text-gray-500" : bonusUnlocked ? "text-amber-900" : "text-amber-100"}`}>{bonusGoal}</p>
                    <p className={`text-xs ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                      {t("goal")}
                    </p>
                  </div>
                </div>

                {/* Progress bar */}
                <div className={`w-full rounded-full h-3 overflow-hidden mb-3 ${bonusClaimed ? "bg-gray-300" : bonusUnlocked ? "bg-amber-900/20" : "bg-amber-950/50"}`}>
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${bonusClaimed ? "bg-gray-400" : bonusUnlocked ? "bg-amber-900" : "bg-gradient-to-r rtl:bg-gradient-to-l from-amber-400 to-yellow-300"}`}
                    style={{ width: `${bonusProgress}%` }}
                  />
                </div>
                <div className={`flex justify-between text-xs mb-4 ${bonusClaimed ? "text-gray-400" : bonusUnlocked ? "text-amber-800" : "text-amber-300"}`}>
                  <span>{t("active_referrals_progress", { frac: frac(validReferrals, bonusGoal) })}</span>
                  <span className="font-semibold">{bonusProgress}%</span>
                </div>

                {/* Claim button / status */}
                {bonusClaimed ? (
                  <div className="flex items-center justify-center gap-2 py-2.5 bg-gray-300 rounded-xl text-gray-500 text-sm font-bold">
                    <CheckCircle className="w-4 h-4" />
                    {t("bonus_claimed")}
                  </div>
                ) : bonusUnlocked ? (
                  <button
                    onClick={handleClaimBonus}
                    disabled={claiming}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-amber-900 hover:bg-amber-950 active:scale-[0.98] text-amber-100 rounded-xl text-sm font-black transition-all shadow-lg disabled:opacity-60"
                  >
                    {claiming ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>🎁</span>}
                    {t("claim_reward")}
                  </button>
                ) : (
                  <div className="flex items-center justify-center gap-2 py-2.5 bg-amber-950/40 rounded-xl text-amber-300 text-xs font-semibold">
                    🔒 {t("referrals_needed", { n: Math.max(0, bonusGoal - validReferrals) })}
                  </div>
                )}

                {claimMsg && (
                  <div className={`mt-2 text-xs text-center font-semibold rounded-xl py-2 ${claimMsg.type === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {msgText(claimMsg)}
                  </div>
                )}
              </div>
            </div>

            {/* ── Commission tiers legend ── */}
            {bonusConfig.commissionTiers?.length > 0 && (
              <Section title={t("commission_scale")} icon={TrendingUp}>
                <div className="space-y-2">
                  {bonusConfig.commissionTiers.map((tier, i) => (
                    <div key={i} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-xl">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center text-xs font-bold text-blue-600">
                          {i + 1}
                        </div>
                        <span className="text-sm text-gray-700">
                          {t("tier_deliveries", {
                            range: ltr(tier.maxDelivered == null
                              ? `${tier.minDelivered}+`
                              : `${tier.minDelivered}–${tier.maxDelivered}`),
                          })}
                        </span>
                      </div>
                      <span className="text-sm font-black text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded-full">
                        {tier.commissionPct}%
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  {t("tier_note")}
                </p>
              </Section>
            )}

            {/* ── Invite link ── */}
            <Section title={t("invite_partner")} icon={UserPlus}>
              <div className="flex gap-2">
                <div dir="ltr" className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs font-mono text-gray-700 truncate">
                  {refLink}
                </div>
                <CopyButton text={refLink} />
              </div>
              <p className="text-xs text-gray-400 mt-2">
                {t("invite_note")}
              </p>
            </Section>

            {/* ── Team list ── */}
            <Section title={t("my_team", { n: team.length })} icon={Users}>
              {team.length === 0 ? (
                <div className="text-center py-10">
                  <Users className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-gray-400 text-sm">
                    {t("team_empty")}
                  </p>
                </div>
              ) : (() => {
                // ── Sort: subReferrals.active DESC → deliveredOrdersCount DESC ──
                const sorted = [...team].sort((a, b) => {
                  const da = (b.subReferrals?.active ?? 0) - (a.subReferrals?.active ?? 0);
                  if (da !== 0) return da;
                  return (b.deliveredOrdersCount ?? 0) - (a.deliveredOrdersCount ?? 0);
                });

                return (
                  <div className="space-y-3">
                    {sorted.map((m, rank) => {
                      const isActive   = m.referralStatus === "active";
                      const commPct    = m.commissionPct ?? 0;
                      const revenue    = m.generatedRevenue ?? 0;
                      const parentEarn = m.parentEarnings ?? 0;
                      const sub        = m.subReferrals ?? { active: 0, pending: 0 };
                      const score      = (sub.active * 10) + ((m.deliveredOrdersCount ?? 0) * 5);

                      // Performance highlight logic
                      const isFireActive  = sub.active > 0;
                      const isPotential   = sub.pending > 3 && sub.active === 0;

                      const isExpanded    = expandedMembers.has(m.id);
                      const isLoadingSub  = subTeamLoading.has(m.id);
                      const subMembers    = subTeamCache[m.id];
                      const hasSubTeam    = (sub.active + sub.pending) > 0;

                      // Card border colour
                      const borderCls = isFireActive
                        ? "border-green-300 shadow-sm shadow-green-100"
                        : isActive
                          ? "border-green-100"
                          : "border-gray-100";

                      return (
                        <div key={m.id} className={`rounded-xl border overflow-hidden transition-shadow ${borderCls}`}>

                          {/* ── Header (always clickable) ── */}
                          <button
                            type="button"
                            onClick={() => handleExpandCard(m.id)}
                            className={`w-full text-start flex items-center justify-between px-3.5 py-2.5 transition-colors cursor-pointer hover:brightness-95
                              ${isFireActive ? "bg-green-50" : isActive ? "bg-green-50/60" : "bg-gray-50"}`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              {/* Avatar + rank */}
                              <div className="relative shrink-0">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black
                                  ${isFireActive ? "bg-green-300 text-green-900" : isActive ? "bg-green-200 text-green-800" : "bg-gray-200 text-gray-500"}`}>
                                  {(m.name || m.username || "?")[0].toUpperCase()}
                                </div>
                                {rank === 0 && score > 0 && (
                                  <span className="absolute -top-1 -end-1 text-[9px] leading-none">🥇</span>
                                )}
                                {rank === 1 && score > 0 && (
                                  <span className="absolute -top-1 -end-1 text-[9px] leading-none">🥈</span>
                                )}
                                {rank === 2 && score > 0 && (
                                  <span className="absolute -top-1 -end-1 text-[9px] leading-none">🥉</span>
                                )}
                              </div>

                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="text-sm font-bold text-gray-800 truncate">{m.name || m.username}</p>
                                  {isFireActive && (
                                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-green-200 text-green-800 whitespace-nowrap">
                                      {t("badge_active_fire")}
                                    </span>
                                  )}
                                  {isPotential && (
                                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 whitespace-nowrap">
                                      {t("badge_potential")}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-gray-400 font-mono"><bdi>@{m.username}</bdi></p>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0 ms-2">
                              {/* Score badge */}
                              {score > 0 && (
                                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 whitespace-nowrap">
                                  {t("score", { n: score })}
                                </span>
                              )}

                              {/* Status badge */}
                              <span className={`text-xs px-2.5 py-1 rounded-full font-bold whitespace-nowrap
                                ${isActive ? "bg-green-200 text-green-800" : "bg-amber-100 text-amber-700"}`}>
                                {isActive
                                  ? t("active")
                                  : t("status_pending")}
                              </span>

                              {/* Expand chevron */}
                              <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform duration-200 shrink-0
                                ${isExpanded ? "rotate-180" : ""}`} />
                            </div>
                          </button>

                          {/* ── Stats grid ── */}
                          <div className="grid grid-cols-4 divide-x divide-gray-100 bg-white">
                            <div className="text-center py-2.5 px-1.5">
                              <p className="text-base font-black text-gray-800">{m.deliveredOrdersCount ?? 0}</p>
                              <p className="text-xs text-gray-400">{t("delivered_plural")}</p>
                            </div>
                            <div className="text-center py-2.5 px-1.5">
                              <p className="text-base font-black text-blue-700">{commPct}%</p>
                              <p className="text-xs text-gray-400">{t("commission")}</p>
                            </div>
                            <div className="text-center py-2.5 px-1.5">
                              <p className="text-base font-black text-amber-700">
                                {revenue.toFixed(0)} <span className="text-[10px] font-semibold">{t("currency")}</span>
                              </p>
                              <p className="text-xs text-gray-400">{t("revenue_generated")}</p>
                            </div>
                            <div className="text-center py-2.5 px-1.5">
                              <p className="text-[11px] font-black leading-tight">
                                <span className="text-green-600">{sub.active}</span>
                                <span className="text-gray-300 mx-0.5">/</span>
                                <span className="text-amber-500">{sub.pending}</span>
                              </p>
                              <p className="text-xs text-gray-400">{t("referrals")}</p>
                            </div>
                          </div>

                          {/* ── Earnings row ── */}
                          {isActive && (
                            <div className="flex items-center justify-between px-3.5 py-2 bg-blue-50 border-t border-blue-100">
                              <span className="text-xs text-blue-700">
                                {t("your_earnings_from_member")}
                              </span>
                              <span className="text-sm font-black text-blue-800">{money(parentEarn, { sign: "+" })}</span>
                            </div>
                          )}

                          {/* ── Expandable panel: tabbed Orders / Team ── */}
                          {isExpanded && (() => {
                            const activeTab       = expandedTab[m.id] || 'orders';
                            const isLoadingOrders = memberOrdersLoading.has(m.id);
                            const memberOrders    = memberOrdersCache[m.id];

                            return (
                              <div className="border-t border-gray-100">

                                {/* Tab bar */}
                                <div className="flex bg-gray-50 border-b border-gray-100">
                                  <button
                                    type="button"
                                    onClick={() => handleSwitchTab(m.id, 'orders')}
                                    className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold transition-colors border-b-2
                                      ${activeTab === 'orders'
                                        ? "border-gray-800 text-gray-900 bg-white"
                                        : "border-transparent text-gray-400 hover:text-gray-700"}`}
                                  >
                                    <Package className="w-3.5 h-3.5 shrink-0" />
                                    {t("orders_word")}
                                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black
                                      ${activeTab === 'orders' ? "bg-gray-900 text-white" : "bg-gray-200 text-gray-500"}`}>
                                      {m.deliveredOrdersCount ?? 0}
                                    </span>
                                  </button>

                                  {hasSubTeam && (
                                    <button
                                      type="button"
                                      onClick={() => handleSwitchTab(m.id, 'team')}
                                      className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold transition-colors border-b-2
                                        ${activeTab === 'team'
                                          ? "border-gray-800 text-gray-900 bg-white"
                                          : "border-transparent text-gray-400 hover:text-gray-700"}`}
                                    >
                                      <Users className="w-3.5 h-3.5 shrink-0" />
                                      {t("team_word")}
                                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black
                                        ${activeTab === 'team' ? "bg-gray-900 text-white" : "bg-gray-200 text-gray-500"}`}>
                                        {sub.active + sub.pending}
                                      </span>
                                    </button>
                                  )}
                                </div>

                                {/* ── Orders tab ── */}
                                {activeTab === 'orders' && (
                                  <div className="bg-gray-50">

                                    {/* Section header */}
                                    <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
                                      <Package className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                                      <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                                        {t("orders_word")}
                                      </span>
                                    </div>

                                    {isLoadingOrders ? (
                                      <div className="flex items-center justify-center gap-2 py-6 bg-white mx-3 mb-3 rounded-xl border border-gray-100">
                                        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                        <span className="text-xs text-gray-400">
                                          {t("loading")}
                                        </span>
                                      </div>
                                    ) : !memberOrders || memberOrders.length === 0 ? (
                                      <div className="flex flex-col items-center py-8 bg-white mx-3 mb-3 rounded-xl border border-dashed border-gray-200">
                                        <Package className="w-8 h-8 text-gray-200 mb-2" />
                                        <p className="text-xs font-semibold text-gray-400">
                                          {t("no_orders")}
                                        </p>
                                      </div>
                                    ) : (() => {
                                      // ── Summary figures ──
                                      const totalOrders   = memberOrders.length;
                                      const totalRevenue  = memberOrders.reduce((s, o) => s + (o.total            ?? 0), 0);
                                      const totalEarnings = memberOrders.reduce((s, o) => s + (o.commissionAmount ?? 0), 0);

                                      return (
                                        <>
                                          {/* ── Summary strip ── */}
                                          <div className="grid grid-cols-3 divide-x divide-gray-200 bg-white mx-3 rounded-xl border border-gray-200 mb-3 overflow-hidden">
                                            <div className="text-center py-2.5 px-2">
                                              <p className="text-sm font-black text-gray-800">{totalOrders}</p>
                                              <p className="text-[10px] text-gray-400">
                                                {t("orders_word")}
                                              </p>
                                            </div>
                                            <div className="text-center py-2.5 px-2">
                                              <p className="text-sm font-black text-amber-700">
                                                {totalRevenue.toFixed(0)}
                                                <span className="text-[9px] font-semibold ms-0.5">{t("currency")}</span>
                                              </p>
                                              <p className="text-[10px] text-gray-400">
                                                {t("total_revenue_short")}
                                              </p>
                                            </div>
                                            <div className="text-center py-2.5 px-2">
                                              <p className="text-sm font-black text-green-700">
                                                <bdi>+{totalEarnings.toFixed(0)}</bdi>
                                                <span className="text-[9px] font-semibold ms-0.5">{t("currency")}</span>
                                              </p>
                                              <p className="text-[10px] text-gray-400">
                                                {t("your_earnings")}
                                              </p>
                                            </div>
                                          </div>

                                          {/* ── Order mini-cards ── */}
                                          <div className="px-3 pb-3 space-y-2 max-h-80 overflow-y-auto">
                                            {memberOrders.map((o) => {
                                              const sCfg    = STATUS_CONFIG[o.status] || { cls: "bg-gray-100 text-gray-600" };
                                              const shortId = o.orderId || o.id.slice(0, 8).toUpperCase();
                                              const dateStr = new Date(o.createdAt).toLocaleDateString(
                                                intlLocale,
                                                { day: "2-digit", month: "2-digit", year: "numeric" }
                                              );
                                              const isDelivered = o.status === "delivered";
                                              return (
                                                <div
                                                  key={o.id}
                                                  className={`rounded-xl border p-3 transition-colors
                                                    ${isDelivered
                                                      ? "bg-green-50/60 border-green-100"
                                                      : "bg-white border-gray-100"}`}
                                                >
                                                  {/* Line 1: product name + status badge */}
                                                  <div className="flex items-start justify-between gap-2 mb-2">
                                                    <p className="text-xs font-bold text-gray-800 leading-tight truncate">
                                                      {o.productTitle || t("product_fallback")}
                                                    </p>
                                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${sCfg.cls}`}>
                                                      {statusLabel(o.status, t)}
                                                    </span>
                                                  </div>

                                                  {/* Line 2: meta (ID · date · client) */}
                                                  <p className="text-[10px] text-gray-400 font-mono mb-2.5 truncate">
                                                    <bdi>#{shortId}</bdi>
                                                    <span className="mx-1 text-gray-300">·</span>
                                                    <bdi>{dateStr}</bdi>
                                                    {o.clientName && (
                                                      <>
                                                        <span className="mx-1 text-gray-300">·</span>
                                                        {o.clientName}
                                                      </>
                                                    )}
                                                  </p>

                                                  {/* Line 3: total (start) + commission (end) */}
                                                  <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                                                    <div className="flex items-center gap-1">
                                                      <span className="text-[10px] text-gray-400">
                                                        {t("total")}
                                                      </span>
                                                      <span className="text-xs font-black text-gray-700">
                                                        {money(o.total)}
                                                      </span>
                                                    </div>
                                                    <span className={`text-xs font-black
                                                      ${isDelivered ? "text-green-700" : "text-gray-500"}`}>
                                                      {money(o.commissionAmount, { sign: isDelivered ? "+" : "" })}
                                                    </span>
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </>
                                      );
                                    })()}
                                  </div>
                                )}

                                {/* ── Team tab ── */}
                                {activeTab === 'team' && (
                                  <div className="bg-gray-50/80">
                                    {isLoadingSub ? (
                                      <div className="flex items-center justify-center gap-2 py-4">
                                        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                        <span className="text-xs text-gray-400">
                                          {t("loading")}
                                        </span>
                                      </div>
                                    ) : !subMembers || subMembers.length === 0 ? (
                                      <div className="flex flex-col items-center py-6">
                                        <Users className="w-7 h-7 text-gray-200 mb-2" />
                                        <p className="text-xs text-gray-400">
                                          {t("no_referrals")}
                                        </p>
                                      </div>
                                    ) : (
                                      <div className="px-3.5 py-2.5 space-y-1.5">
                                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                                          {t("team_of", { user: ltr(`@${m.username}`) })}
                                        </p>
                                        {subMembers.map((s) => {
                                          const sActive = s.referralStatus === "active";
                                          return (
                                            <div key={s.id}
                                              className={`flex items-center justify-between px-3 py-2 rounded-lg border text-xs
                                                ${sActive ? "bg-green-50 border-green-100" : "bg-white border-gray-100"}`}>
                                              <div className="flex items-center gap-2 min-w-0">
                                                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black shrink-0
                                                  ${sActive ? "bg-green-200 text-green-800" : "bg-gray-200 text-gray-500"}`}>
                                                  {(s.name || s.username || "?")[0].toUpperCase()}
                                                </div>
                                                <span className="font-semibold text-gray-700 truncate"><bdi>@{s.username}</bdi></span>
                                                {s.deliveredOrdersCount > 0 && (
                                                  <span className="text-gray-400 shrink-0">
                                                    · {s.deliveredOrdersCount} {t("deliveries_short")}
                                                  </span>
                                                )}
                                              </div>
                                              <span className={`px-2 py-0.5 rounded-full font-bold shrink-0 ms-2
                                                ${sActive ? "bg-green-200 text-green-800" : "bg-amber-100 text-amber-700"}`}>
                                                {sActive
                                                  ? t("active")
                                                  : t("status_pending")}
                                              </span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                )}

                              </div>
                            );
                          })()}

                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <p className="text-xs text-gray-400 mt-3">
                {t("team_sort_hint")}
              </p>
            </Section>
          </div>
          );
        })()}

        {/* ══ COMPETITION ═══════════════════════════════════════════════════ */}
        {activeTab === "deposit" && (rechargeEnabled ? (
          <DepositTab token={token} onChanged={() => fetchAll(token, { silent: true })} />
        ) : (
          // Reached while the admin switch is OFF (e.g. a page opened before): no form, just a notice.
          <Section title={t("deposit_disabled_title")} icon={Wallet}>
            <p className="text-sm text-gray-600" data-recharge-disabled>{t("deposit_disabled_body")}</p>
            <button type="button" onClick={() => setActiveTab("overview")} className="mt-3 text-xs text-blue-600 font-semibold hover:underline">
              {t("tab_overview")}
            </button>
          </Section>
        ))}

        {/* No menu entry any more ("Create Your Own Brand" took its place): still
            opened from the overview widget so existing boosters stay visible. */}
        {activeTab === "booster" && <BoosterTab onRecharge={goToDeposit} />}

        {activeTab === "brand" && <BrandTab />}

        {activeTab === "rewards" && <RewardsTab />}

        {activeTab === "ugc" && <UgcTab />}

        {/* Competition now lives inline on the overview (no standalone tab). */}

        {/* ══ SETTINGS ══════════════════════════════════════════════════════ */}
        {activeTab === "settings" && (
          <div className="space-y-5 max-w-md">

            {/* ── Profile Picture ── */}
            <Section title={t("profile_photo")} icon={Users}>
              <AvatarUpload
                affiliate={affiliate}
                authHeaders={authHeaders}
                onUpdate={(updated) => setData(d => ({ ...d, affiliate: updated }))}
              />
            </Section>

            {/* ── Identity Verification (before profile edit) ── */}
            <div id="identity-card">
              <IdentityVerificationCard
                token={token}
                status={identityStatus}
                identity={identity}
                onDone={() => fetchAll(token, { silent: true })}
              />
            </div>

            {/* ── WhatsApp Support (hidden when disabled/unconfigured) ── */}
            {supportLink && <WhatsappSupportCard link={supportLink} />}

            {/* ── Edit Profile ── */}
            <Section title={t("edit_profile")} icon={Star}>
              <form onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.target);
                const name  = fd.get("name");
                const phone = fd.get("phone");
                try {
                  const res = await fetch("/api/affiliate/me", {
                    method: "PUT",
                    headers: authHeaders(),
                    body: JSON.stringify({ type: "profile", name, phone: phone || undefined }),
                  });
                  const json = await res.json();
                  if (!res.ok) { alert(json.error ? localizeServerError(json, lang) : t("error")); return; }
                  setData(d => ({ ...d, affiliate: json.affiliate }));
                  alert(t("profile_updated"));
                } catch { alert(t("network_error")); }
              }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">{t("full_name")}</label>
                  <input name="name" defaultValue={affiliate?.name || ""}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder={t("your_name")} required />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">{t("username")}</label>
                  <input value={affiliate?.username ?? ""} disabled dir="ltr"
                    className="w-full px-4 py-2.5 text-sm border border-gray-100 rounded-xl bg-gray-100 text-gray-400 cursor-not-allowed" />
                  <p className="text-xs text-gray-400 mt-1">{t("username_locked")}</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">{t("phone_number")}</label>
                  {affiliate?.phone ? (
                    <>
                      <input value={affiliate.phone ?? ""} disabled dir="auto"
                        className="w-full px-4 py-2.5 text-sm border border-gray-100 rounded-xl bg-gray-100 text-gray-400 cursor-not-allowed font-mono" />
                      <p className="text-xs text-gray-400 mt-1">{t("phone_locked")}</p>
                    </>
                  ) : (
                    <>
                      <input name="phone" type="tel"
                        className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 font-mono"
                        placeholder="0612345678" dir="auto" />
                      <p className="text-xs text-amber-500 mt-1">{t("phone_once")}</p>
                    </>
                  )}
                </div>
                <button type="submit"
                  className="w-full py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-xl hover:bg-gray-700 transition-colors">
                  {t("save_profile")}
                </button>
              </form>
            </Section>

            {/* ── Change Password ── */}
            <Section title={t("change_password")} icon={AlertCircle}>
              <form onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.target);
                const currentPassword = fd.get("currentPassword");
                const newPassword     = fd.get("newPassword");
                const confirmPassword = fd.get("confirmPassword");
                if (newPassword !== confirmPassword) { alert(t("pw_mismatch")); return; }
                if (newPassword.length < 6) { alert(t("pw_too_short")); return; }
                try {
                  const res = await fetch("/api/affiliate/me", {
                    method: "PUT",
                    headers: authHeaders(),
                    body: JSON.stringify({ type: "profile", currentPassword, newPassword }),
                  });
                  const json = await res.json();
                  if (!res.ok) { alert(json.error ? localizeServerError(json, lang) : t("error")); return; }
                  // The change revoked every other session; keep THIS one with its fresh token.
                  if (typeof json.token === "string" && json.token) { localStorage.setItem("affiliateToken", json.token); setToken(json.token); }
                  e.target.reset();
                  alert(t("pw_changed"));
                } catch { alert(t("network_error")); }
              }} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">{t("current_password")}</label>
                  <input name="currentPassword" type="password" required
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder="••••••••" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">{t("new_password")}</label>
                  <input name="newPassword" type="password" required minLength={6}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder="••••••••" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">{t("confirm_password")}</label>
                  <input name="confirmPassword" type="password" required minLength={6}
                    className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                    placeholder="••••••••" />
                </div>
                <button type="submit"
                  className="w-full py-2.5 bg-red-600 text-white text-sm font-semibold rounded-xl hover:bg-red-700 transition-colors">
                  {t("change_password")}
                </button>
              </form>
            </Section>

          </div>
        )}

      </main>

      {/* ── Order details modal (Parts 2–5) ── */}
      <OrderDetailsModal
        order={detailsOrder}
        onClose={() => setDetailsOrder(null)}
        onStatusChange={handleOrderStatus}
        updatingOrder={updatingOrder}
      />

      {/* ── Order status refused (404 / 409) — FR/AR feedback ── */}
      {orderNotice && (
        <div role="alert" dir={orderMessageDir(lang)}
          className="fixed left-1/2 -translate-x-1/2 z-[75] w-[calc(100%-32px)] max-w-md bg-gray-900 text-white text-xs font-semibold px-4 py-3 rounded-2xl shadow-xl flex items-start gap-3 bottom-[calc(104px+env(safe-area-inset-bottom))] md:bottom-6">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" />
          <span className="flex-1 leading-snug">{orderNotice}</span>
          <button type="button" onClick={() => setOrderNotice(null)} className="text-white/60 hover:text-white" aria-label={t("close")} title={t("close")}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Mobile bottom navigation (mobile/tablet only) ── */}
      <MobileBottomNav
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        refLink={refLink}
        onLogout={handleLogout}
        unread={unread}
        onOpenNotifications={markNotifsRead}
        rechargeEnabled={rechargeEnabled}
      />

    </div>
  );
}
